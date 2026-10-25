/**
 * lib/session-reviewer.js —— v0.3.0：doc_review 审查派发机制重构（subagent → 独立新 session + 后台 job 监视）。
 *
 * 用户硬性要求（2026-10-24）：审查时**禁止**再以 subagent 形式发起独立审核；
 * 必须开一个新的 DSH session 做独立审核，后台挂 job 监视该 session 进度，最后收集结论。
 *
 * 实现（wire 契约照抄 @linxin666/dsh-client-ui-task-board src/host-runner.ts 已验证的调用形态）：
 *   1. launchReviewSession：typertGateway session/create（返回 {sessionId}）→ session/rename
 *      → 可选 session/selectModel（reviewer_model 覆盖）→ session/prompt（mode:"queue"，排入审查任务）；
 *      返回 {sessionId, promptedAt}（promptedAt 为 prompt 发出前时间戳，作监视起点）。
 *   2. spawnReviewMonitorJob：ctx.jobs.start({kind:'doc-review', owner: 父 session.id, run}) 注册后台 job；
 *      job 循环调用 session/list + session/follow（maxMessages:1 拿 opening 帧）+ session/page 翻历史，
 *      找 startedAt 之后的首个 turn/end；从 assistant/message 收集审查员结论文本；
 *      settle 时 done({status, detail, result})——result 即审查员纯文本输出（JSON 报告或自由文本）。
 *   3. runReviewerSession：主入口。开 session（或续取账本既有 session）→ 挂 job →
 *      jobs.wait 分片续等（WAIT_CHUNK_MS，F2）→ 收集结论 → parseFreeformReport 校验
 *      → 不合规则同一 session 内再 prompt（修正指令，不重灌全文；总尝试 ≤3=1+2，T06）
 *      → 降级联合。分片到点未 settle 时先判 session 存活度（summary running/updatedAt，
 *      F3）：活则继续续等，停滞/消失才 salvage——inspectReviewSession 读审查 session
 *      既有结论，命中（freeform 非空且解析合规）走 report，命中但 JSON 不合规降级
 *      freeform 不重试，仅当确无结论（pending/空文本）才 kill monitor 并判 timeout
 *      （信封附 sessionId 供链级续取）。
 *
 * v0.3.3 修复（对照长 CoT 误判事故 session-68727f69，2026-10-25）：
 *   F2 旧实现 jobs.wait 单次压到 300s 即 kill+timeout，把 605s 才产出结论的活审查
 *      当失败丢弃、主会话重开一轮；改为同 job 分片续等，预算内不误杀。
 *   F3 存活度判据从「事件时间新近度」改为 session summary 的 running/updatedAt
 *      （心跳取证：产出期日志静默、heartbeat 全在完成之后，事件时间判活不成立）。
 *   F5 params.resume 链级续取：不新开 session、不重发 prompt，startedAt 取账本
 *      记录值，直接收既有结论（超时后重调的零浪费路径）。
 *
 * 与旧 subagent 版的关键差异：
 *   - 审查员是真实独立 session（持久化、可人工查看），不再是进程内子 agent；
 *   - 无 structured_output 工具（delegation runtime 动态注册，普通 session 没有）→ 审查员以纯文本
 *     JSON 输出，复用 parseFreeformReport 兜底解析（session-freeform-salvage 路径）；
 *   - 总超时与重试语义（T05/T06）保持：DEFAULT_TIMEOUT_MS=900s、MAX_TOTAL_ATTEMPTS=3。
 */

import { logEvent } from "./logger.js";
import {
	buildAttemptPrompt,
	describeRetryRecord,
	parseFreeformReport,
	validateReportBusinessRules,
	REVIEWER_PERSONA,
	MAX_TOTAL_ATTEMPTS,
	DEFAULT_TIMEOUT_MS
} from "./reviewer.js";

/** 监视轮询间隔（毫秒；task-board SESSION_POLL_MS=5000 同源）。 */
export const POLL_INTERVAL_MS = 5_000;

/**
 * jobs.wait 单次续等分片（毫秒；v0.3.3 F2）。
 * 旧实现把单次 wait 压到 300s 即判「monitor 未 settle」→ kill+timeout：实测长 CoT
 * 审查（605s 才产出结论）正是在 300s 分片点被误杀，结论已产出却被丢弃。
 * 改为同一 job 分片续等，分片到点只做存活度判定，不提前收钱。
 */
export const WAIT_CHUNK_MS = 30_000;

/**
 * 审查 session 停滞判定阈值（毫秒；v0.3.3 F3）。
 * session summary 的 running===true 恒判活；running 非 true 时看 updatedAt
 * （max(summary.updatedAt, lastPromptAt)）：超过该阈值没有任何活动才判停滞。
 * 心跳取证结论（2026-10-25）：37 次 heartbeat 全部发生在会话完成之后，生成期日志
 * 静默——基于「事件时间新近度」的 liveness 不成立，必须以 summary 字段为准。
 */
export const SESSION_STALL_MS = 90_000;

/** 一次 inspect 最多翻多少页历史（审查 session 事件量小，50 页足够）。 */
const HISTORY_PAGE_LIMIT = 50;

/** gateway 错误归一为一句话（task-board failureText 同源）。 */
function failureText(error) {
	return error instanceof Error ? error.message : String(error);
}

function delay(ms) {
	return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function sessionAddress(sessionId) {
	return { kind: "session", sessionId };
}

/** session 命名空间方法的 wire 参数布局（task-board invokeWireArgs 同源）。 */
function invokeWireArgs(namespace, method, request) {
	if (namespace === "session" && method === "list") return { _request: request };
	return { request };
}

/**
 * 经 typertGateway 调一个 session 命名空间方法（unary）。
 * @param {object} gateway TypertGateway（ctx.typertGateway）。
 * @param {string} method session 方法名（create/rename/selectModel/prompt/page/list）。
 * @param {object} request 业务参数。
 * @param {AbortSignal} [signal] 取消信号。
 * @returns {Promise<unknown>} gateway 业务结果。
 */
async function invokeSession(gateway, method, request, signal) {
	return gateway.invoke({
		namespace: "session",
		method,
		args: invokeWireArgs("session", method, request),
		...(signal === undefined ? {} : { signal })
	});
}

/**
 * 开启审查 session 并排入审查任务（launch：create → rename → 可选 selectModel → prompt）。
 * @param {object} gateway TypertGateway（ctx.typertGateway）。
 * @param {object} params 启动参数。
 * @param {string} params.promptText 完整审查 prompt（persona + 输入包 + 输出指令）。
 * @param {string} [params.title] 审查 session 标题（缺省 "doc-review"）。
 * @param {string} [params.workspaceId] 目标工作区 id（缺省交给 Host 决定）。
 * @param {{provider?: string, model?: string, reasoningEffort?: string}} [params.reviewerModel] 审查员模型覆盖（selectModel）。
 * @returns {Promise<{sessionId: string, promptedAt: number}>} 审查 session id 与 prompt 发出前时间戳。
 */
export async function launchReviewSession(gateway, params) {
	const created = await invokeSession(gateway, "create", {
		...(params.workspaceId === undefined ? {} : { workspaceId: params.workspaceId })
	});
	const sessionId = created?.sessionId;
	if (typeof sessionId !== "string" || sessionId.length === 0) {
		throw new Error("session/create 未返回 sessionId");
	}
	await invokeSession(gateway, "rename", {
		sessionId,
		title: params.title ?? "doc-review"
	});
	if (params.reviewerModel && (params.reviewerModel.provider !== undefined || params.reviewerModel.model !== undefined)) {
		try {
			await invokeSession(gateway, "selectModel", {
				sessionId,
				...(params.reviewerModel.provider === undefined ? {} : { provider: params.reviewerModel.provider }),
				model: params.reviewerModel.model,
				// reasoningEffort 等能力档位透传（v0.3.3 修复：此前到 selectModel 被丢弃）。
				...(params.reviewerModel.reasoningEffort === undefined || params.reviewerModel.reasoningEffort === null
					? {}
					: { reasoningEffort: params.reviewerModel.reasoningEffort })
			});
		} catch (modelError) {
			// 模型选择失败不阻断审查：回退到 session 默认模型。
			logEvent("doc_review_select_model_failed", { sessionId, error: failureText(modelError) });
		}
	}
	const promptedAt = Date.now();
	await invokeSession(gateway, "prompt", {
		sessionId,
		requestId: "doc-review-" + crypto.randomUUID(),
		mode: "queue",
		content: [{ type: "text", text: params.promptText }]
	});
	return { sessionId, promptedAt };
}

/**
 * 同一审查 session 内追加一轮 prompt（T06 重试：修正指令，不重灌全文）。
 * @param {object} gateway TypertGateway。
 * @param {string} sessionId 审查 session id。
 * @param {string} promptText 本轮 prompt 文本。
 * @returns {Promise<number>} 本轮 prompt 发出前时间戳（监视起点）。
 */
export async function rePromptReviewSession(gateway, sessionId, promptText) {
	const promptedAt = Date.now();
	await invokeSession(gateway, "prompt", {
		sessionId,
		requestId: "doc-review-retry-" + crypto.randomUUID(),
		mode: "queue",
		content: [{ type: "text", text: promptText }]
	});
	return promptedAt;
}

/**
 * 从 session 事件流收集审查员 assistant 文本结论（最后一个 assistant/message 的 text 块拼接）。
 * @param {Array<{type: string, seq: number, time: number, data: unknown}>} events 事件数组（已按 seq 升序）。
 * @returns {string} 文本结论；无 assistant/message 时为空串。
 */
export function collectAssistantText(events) {
	const blocks = [];
	for (const event of events) {
		if (event?.type !== "assistant/message") continue;
		const content = event.data?.message?.content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (block?.type === "text" && typeof block.text === "string") blocks.push(block.text);
		}
	}
	return blocks.join("\n");
}

/**
 * turn/end 事件 → 归一 stopReason（kind==='completed' 时为 undefined=成功）。
 * @param {unknown} data turn/end 事件 data。
 * @returns {string|undefined} 非 completed 的 kind；completed 或未知 → undefined。
 */
export function nonCompletedTurnEnd(data) {
	if (typeof data !== "object" || data === null) return undefined;
	const kind = data.kind;
	if (typeof kind !== "string") return undefined;
	return kind === "completed" ? undefined : kind;
}

/**
 * 依据 turn/end 与事件集生成监视判定（含结论文本收集）。
 * @param {object} turnEnd 命中的 turn/end 事件。
 * @param {Array<{type: string, seq: number, time: number, data: unknown}>} events 事件数组。
 * @returns {{outcome: 'succeeded', freeform: string} | {outcome: 'failed', error: string, stopReason: string, freeform: string}}
 */
function verdictFromTurnEnd(turnEnd, events) {
	const reason = nonCompletedTurnEnd(turnEnd.data);
	const before = events.filter((event) => event.seq <= turnEnd.seq);
	const freeform = collectAssistantText(before);
	if (reason === undefined) {
		return { outcome: "succeeded", freeform };
	}
	return {
		outcome: "failed",
		error: "agent turn ended without completing: " + reason,
		stopReason: reason,
		freeform
	};
}

/** 归一 history record 为事件对象（record 携带 .event，兜底兼容裸事件形状）。 */
function toEvent(record) {
	return record?.event ?? record;
}

/**
 * 判定审查 session 是否仍可能产出结论（v0.3.3 F3：分片续等的提前收尾依据）。
 * 判据取自 session/list summary，而非事件时间新近度（心跳取证：审查员产出期
 * 日志完全静默， heartbeat 全在完成之后，事件时间判活会误杀正在长 CoT 的会话）：
 *   - summary.running === true                        → 活；
 *   - running 非 true 且 now-updatedAt ≤ 90s          → 活（刚结束/即将开始，等 monitor 追上）；
 *   - running 非 true 且 updatedAt 停滞 > 90s         → 停滞（判死，提前 salvage）；
 *   - summary 缺失 / 无 updatedAt 字段 / list 调用失败 → 未知，保守判活（由外层 deadline 兜底）。
 * @param {object} gateway TypertGateway。
 * @param {string} sessionId 审查 session id。
 * @returns {Promise<{alive: boolean, reason: string}>} 存活度判定。
 */
export async function checkReviewSessionLiveness(gateway, sessionId) {
	let items;
	try {
		const response = await invokeSession(gateway, "list", {});
		items = response?.items ?? [];
	} catch (error) {
		return { alive: true, reason: "session/list failed: " + failureText(error) };
	}
	const summary = items.find((item) => item?.sessionId === sessionId);
	if (summary === undefined) return { alive: false, reason: "审查 session 已不存在" };
	if (summary.running === true) return { alive: true, reason: "running" };
	const updatedAt = Number(summary.updatedAt);
	if (!Number.isFinite(updatedAt)) {
		// 无 updatedAt 字段（旧内核/降级形态）：未知不判死，保守续等。
		return { alive: true, reason: "updatedAt unavailable" };
	}
	const idleMs = Date.now() - updatedAt;
	if (idleMs <= SESSION_STALL_MS) return { alive: true, reason: `recent activity ${idleMs}ms ago` };
	return { alive: false, reason: `stalled: not running, last activity ${idleMs}ms ago` };
}

/**
 * 续取前存在性校验（v0.3.3 F5）：账本记录的 session 是否还在 session/list 里。
 * 与 liveness 的区别：停滞（stalled）不等于不存在——已跑完的审查 session 结论
 * 仍在，必须允许续取；只有真的被删/不在列表才回退新开。
 * list 调用失败时保守返回 false（不续取，走新开，绝不孤儿化一个可能的活会话）。
 * @param {object} gateway TypertGateway。
 * @param {string} sessionId 候选审查 session id。
 * @returns {Promise<boolean>} 存在为 true。
 */
async function reviewSessionExists(gateway, sessionId) {
	try {
		const response = await invokeSession(gateway, "list", {});
		const items = response?.items ?? [];
		return items.some((item) => item?.sessionId === sessionId);
	} catch (error) {
		logEvent("doc_review_session_resume_check_failed", { sessionId, error: failureText(error) });
		return false;
	}
}

/**
 * 单次 inspect：读审查 session 事件流（follow opening + page 翻到 startedAt 边界），
 * 判定是否已产出本轮 turn/end；已产出时同时收集审查员结论文本。
 * @param {object} gateway TypertGateway。
 * @param {string} sessionId 审查 session id。
 * @param {number} startedAt 本轮 prompt 发出前时间戳（早于此的事件不算本轮）。
 * @returns {Promise<object>} {outcome:'pending'|'succeeded'|'failed'|'cancelled', ...}。
 */
export async function inspectReviewSession(gateway, sessionId, startedAt) {
	let items;
	try {
		const response = await invokeSession(gateway, "list", {});
		items = response?.items ?? [];
	} catch (error) {
		return { outcome: "pending", unreadable: true, reason: "session/list failed: " + failureText(error) };
	}
	const summary = items.find((item) => item?.sessionId === sessionId);
	if (summary === undefined) {
		return { outcome: "cancelled", error: "审查 session 已不存在" };
	}

	let opening;
	try {
		if (typeof gateway.stream !== "function") {
			return { outcome: "pending", unreadable: true, reason: "gateway stream is unavailable" };
		}
		const stream = await gateway.stream({
			namespace: "session",
			method: "follow",
			args: { request: { address: sessionAddress(sessionId), maxMessages: 1 } }
		});
		const iterator = stream[Symbol.asyncIterator]();
		const next = await iterator.next();
		if (typeof iterator.return === "function") await iterator.return();
		const follow = next.done === true ? undefined : next.value;
		if (
			follow === undefined || follow.type !== "snapshot" ||
			typeof follow.cursor !== "number" ||
			!Array.isArray(follow.records) ||
			typeof follow.hasMore !== "boolean"
		) {
			return { outcome: "pending", unreadable: true, reason: "session/follow 未返回 opening 帧" };
		}
		opening = follow;
	} catch (error) {
		return { outcome: "pending", unreadable: true, reason: "session/follow failed: " + failureText(error) };
	}

	const events = opening.records.map(toEvent);
	let beforeSeq;
	let reachedBoundary = !opening.hasMore;
	for (let page = 0; page < HISTORY_PAGE_LIMIT && !reachedBoundary; page += 1) {
		let history;
		try {
			history = await invokeSession(gateway, "page", {
				address: sessionAddress(sessionId),
				throughSeq: opening.cursor,
				maxMessages: 100,
				...(beforeSeq === undefined ? {} : { beforeSeq })
			});
		} catch (error) {
			return { outcome: "pending", unreadable: true, reason: "session/page failed: " + failureText(error) };
		}
		const pageEntries = (history?.records ?? []).map(toEvent);
		events.push(...pageEntries);
		const oldestTime = pageEntries.reduce((oldest, entry) =>
			oldest === undefined ? entry.time : Math.min(oldest, entry.time), undefined);
		if (!history?.hasMore || (oldestTime !== undefined && oldestTime <= startedAt)) {
			reachedBoundary = true;
			break;
		}
		const oldestSeq = pageEntries.reduce((oldest, entry) =>
			oldest === undefined ? entry.seq : Math.min(oldest, entry.seq), undefined);
		if (oldestSeq === undefined || oldestSeq === beforeSeq) break;
		beforeSeq = oldestSeq;
	}
	if (!reachedBoundary) {
		return { outcome: "pending", unreadable: true, reason: "history scan did not reach the review start within " + HISTORY_PAGE_LIMIT + " pages" };
	}

	const turnEnd = events
		.filter((event) => event?.type === "turn/end" && (startedAt <= 0 || event.time >= startedAt))
		.sort((a, b) => a.seq - b.seq)[0];
	if (turnEnd === undefined) return { outcome: "pending" };
	return verdictFromTurnEnd(turnEnd, events);
}

/**
 * 注册后台监视 job：轮询审查 session 直到本轮 turn/end、超时或取消；settle 时交付结论文本。
 * @param {object} gateway TypertGateway（ctx.typertGateway）。
 * @param {object} jobs ctx.jobs（JobRegistry）。
 * @param {object} options 监视参数。
 * @param {string} options.owner 父 session id（job owner，访问栅栏与 teardown 取消）。
 * @param {string} options.sessionId 审查 session id。
 * @param {number} options.startedAt 本轮 prompt 发出前时间戳。
 * @param {number} options.timeoutMs 本轮监视超时预算（毫秒）。
 * @param {AbortSignal} [options.signal] 外部取消信号。
 * @param {string} [options.label] job 标签（缺省 "doc-review monitor"）。
 * @returns {object} ctx.jobs.start 的返回值（JobId）。
 */
export function spawnReviewMonitorJob(gateway, jobs, options) {
	const { owner, sessionId, startedAt, timeoutMs, signal, label } = options;
	return jobs.start({
		kind: "doc-review",
		label: label ?? "doc-review monitor",
		owner,
		run(job) {
			let cancelled = false;
			let settled = false;
			const cancel = (reason) => {
				cancelled = true;
				job.append("doc-review monitor cancelled" + (reason ? ": " + reason : "") + "\n", { channel: "log" });
			};
			const done = (async () => {
				let poll = 0;
				const deadlineAt = Date.now() + timeoutMs;
				while (!cancelled && !settled && Date.now() < deadlineAt) {
					if (signal?.aborted) { cancelled = true; break; }
					poll += 1;
					job.updateProgress("poll #" + poll);
					let verdict;
					try {
						verdict = await inspectReviewSession(gateway, sessionId, startedAt);
					} catch (error) {
						job.append("inspect failed: " + failureText(error) + "\n", { channel: "log" });
						await delay(Math.min(POLL_INTERVAL_MS, Math.max(0, deadlineAt - Date.now())));
						continue;
					}
					if (verdict.outcome === "pending") {
						job.append("poll #" + poll + ": " + (verdict.reason ?? "pending") + "\n", { channel: "log" });
						await delay(Math.min(POLL_INTERVAL_MS, Math.max(0, deadlineAt - Date.now())));
						continue;
					}
					settled = true;
					if (verdict.outcome === "succeeded") {
						return {
							status: "completed",
							detail: "review turn ended",
							result: verdict.freeform ?? ""
						};
					}
					if (verdict.outcome === "cancelled") {
						return {
							status: "failed",
							detail: verdict.error ?? "审查 session 已不存在",
							result: verdict.freeform ?? ""
						};
					}
					return {
						status: "failed",
						detail: verdict.error ?? "review turn failed",
						result: verdict.freeform ?? ""
					};
				}
				return {
					status: cancelled || signal?.aborted ? "killed" : "failed",
					detail: cancelled || signal?.aborted ? "cancelled" : "review monitor deadline",
					result: ""
				};
			})();
			return { cancel, done };
		}
	});
}

/**
 * 判定一次 freeform 结果：成功（解析为合规报告）/ 可重试失败。
 * @param {string} freeformText 审查员纯文本输出。
 * @param {object} context 判定上下文（params/deps/attempts/timedOut）。
 * @returns {object} {kind:'report'|'retry', ...}。
 */
function judgeFreeformOutcome(freeformText, context) {
	const { params, deps, attempts } = context;
	if (typeof freeformText !== "string" || freeformText.trim().length === 0) {
		return {
			kind: "retry",
			failure: { stopReason: "empty", violations: ["审查 session 未产出任何文本结论"], freeformText: "" }
		};
	}
	const salvaged = parseFreeformReport(freeformText, { deps, params });
	if (salvaged !== null) {
		logEvent("doc_review_structured_report", {
			attempt: attempts,
			issueCount: Array.isArray(salvaged.report.issues) ? salvaged.report.issues.length : 0,
			source: "session-freeform-salvage"
		});
		return { kind: "report", report: salvaged.report };
	}
	const trimmed = freeformText.trim();
	// 弱模型常把 JSON 吐在正文但被 max-tokens 截断：有 summary/issues 骨架但未闭合 } → 按截断处理。
	const looksTruncated = trimmed.includes('"summary"') && !trimmed.endsWith("}");
	return {
		kind: "retry",
		failure: {
			stopReason: looksTruncated ? "max-tokens" : "invalid",
			violations: [looksTruncated ? "输出被截断，未闭合 JSON" : "输出无法解析为合规 JSON"],
			freeformText
		}
	};
}

/**
 * T05/T06 主入口：开新审查 session（或续取既有 session）→ 挂后台 job 监视 →
 * 收集结论 → 校验/重试/降级。
 *
 * v0.3.3 关键修复（对照 2026-10-25 长 CoT 误判事故 session-68727f69）：
 * - F2 分片续等：旧实现 jobs.wait 单次压到 300s 即判「monitor 未 settle」→ kill+
 *   timeout。实测审查员生成 605s 才产出结论，300s 分片点 monitor 仍存活（心跳
 *   37 次可证），结论却在 305s 后被丢弃、主会话重开一轮白烧 token。现改为同一
 *   job 以 WAIT_CHUNK_MS 分片续等，分片到点只判 session 存活度，不提前收钱。
 * - F3 存活度判据：session summary 的 running/updatedAt（非事件时间新近度）。
 * - F5 链级续取：params.resume 非空且 session 仍在 → 不新开 session、不重发
 *   prompt，直接监视既有 session 收结论（promptedAt 取账本记录值）。
 *
 * @param {object} deps 内核服务（注入以便替换）。
 * @param {object} deps.gateway TypertGateway（ctx.typertGateway）。
 * @param {object} deps.jobs ctx.jobs（JobRegistry）。
 * @param {Function} deps.validateJsonSchemaValue JSON Schema 校验函数。
 * @param {object} params 运行参数。
 * @param {object} params.parentAgent exec.agent（session.id 用于 job owner/busy）。
 * @param {AbortSignal} [params.outerSignal] exec.signal（用户取消传播）。
 * @param {string} params.inputText T04 输入包全文。
 * @param {string} params.targetText 目标文档纯文本（location 校验语料）。
 * @param {{provider?: string, model?: string}} [params.agentOptions] 审查员模型覆盖（selectModel）。
 * @param {string} [params.sessionTitle] 审查 session 标题。
 * @param {string} [params.workspaceId] 审查 session 工作区。
 * @param {number} [params.timeoutMs] 总超时（默认 900s）。
 * @param {{sessionId: string, promptedAt?: number}|null} [params.resume] 链级续取目标
 *   （service 依 chain-session.json 账本构造；null/缺省=新开 session）。
 * @param {Function} [params.onRetry] 每次尝试失败的同步回调。
 * @returns {Promise<object>} 判别联合（report/freeform/aborted/timeout/start-error）；
 *   产出过 session 的信封一律带 sessionId 与 promptedAt（供账本落盘与续取）。
 */
export async function runReviewerSession(deps, params) {
	const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const onRetry = typeof params.onRetry === "function" ? params.onRetry : null;
	const notifyRetry = (failure, attempt, willRetry) => {
		if (onRetry === null) return;
		try {
			onRetry(describeRetryRecord(attempt, failure, willRetry));
		} catch {
			/* 观察者异常不得中断审查主流程 */
		}
	};
	const retries = [];
	if (params.outerSignal?.aborted) return { kind: "aborted", attempts: 0, retries };
	const controller = new AbortController();
	const forwardAbort = () => controller.abort();
	params.outerSignal?.addEventListener("abort", forwardAbort, { once: true });
	let timedOut = false;
	const deadlineAt = Date.now() + timeoutMs;
	const deadlineTimer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	if (typeof deadlineTimer.unref === "function") deadlineTimer.unref();
	let attempts = 0;
	let lastFailure = null;
	let sessionId = null;
	let promptedAt = null;
	const owner = params.parentAgent?.session?.id;
	try {
		// F5：链级续取优先——同链同轮同文档的重调（如长 CoT 超时后重试）不新开
		// session、不重发 prompt，直接监视账本记录的既有 session 收结论。
		const resume = params.resume;
		if (resume !== undefined && resume !== null && typeof resume.sessionId === "string" && resume.sessionId.length > 0) {
			if (await reviewSessionExists(deps.gateway, resume.sessionId)) {
				sessionId = resume.sessionId;
				// startedAt 取账本记录值：要找的是原 prompt 之后的那个 turn/end，
				// 而不是「现在之后」——结论可能早已产出（事故现场即如此）。
				promptedAt = Number.isFinite(resume.promptedAt) ? resume.promptedAt : 0;
				attempts = 1;
				logEvent("doc_review_session_resumed", { sessionId, promptedAt });
			} else {
				// 账本 session 已不存在：回退新开（记录里的结论无可救）。
				logEvent("doc_review_session_resume_missing", { sessionId: resume.sessionId });
			}
		}
		if (sessionId === null) {
			// 第一次尝试：开新审查 session（persona 并入 prompt 开头）。
			attempts += 1;
			const firstPrompt = buildAttemptPrompt(params.inputText, null);
			try {
				const launched = await launchReviewSession(deps.gateway, {
					promptText: [REVIEWER_PERSONA, firstPrompt].join("\n\n"),
					title: params.sessionTitle ?? "doc-review",
					workspaceId: params.workspaceId,
					reviewerModel: params.agentOptions
				});
				sessionId = launched.sessionId;
				promptedAt = launched.promptedAt;
			} catch (error) {
				return { kind: "start-error", error: String(error?.message ?? error), attempts, retries };
			}
			logEvent("doc_review_session_created", { sessionId, attempt: attempts });
		}

		while (attempts <= MAX_TOTAL_ATTEMPTS) {
			if (timedOut) return { kind: "timeout", sessionId, promptedAt, attempts, retries };
			if (params.outerSignal?.aborted) return { kind: "aborted", sessionId, promptedAt, attempts, retries };
			const remainingMs = deadlineAt - Date.now();
			if (remainingMs <= 0) return { kind: "timeout", sessionId, promptedAt, attempts, retries };

			const startedAt = promptedAt ?? Date.now();
			const jobId = spawnReviewMonitorJob(deps.gateway, deps.jobs, {
				owner,
				sessionId,
				startedAt,
				timeoutMs: remainingMs,
				signal: controller.signal,
				label: "doc-review monitor (attempt " + attempts + ")"
			});
			logEvent("doc_review_job_registered", { jobId, sessionId, attempt: attempts });

			// F2：同一 job 分片续等。monitor 由 gateway 独立驱动，分片到点未 settle
			// 不代表审查没在跑；只有 session 停滞/消失或总预算耗尽才提前收尾。
			let view = null;
			while (true) {
				if (timedOut || params.outerSignal?.aborted) break;
				const chunkRemainingMs = deadlineAt - Date.now();
				if (chunkRemainingMs <= 0) break;
				try {
					view = await deps.jobs.wait(jobId, Math.min(WAIT_CHUNK_MS, chunkRemainingMs), owner, controller.signal);
				} catch {
					try {
						view = await deps.jobs.get(jobId, owner);
					} catch {
						view = null;
					}
				}
				if (view !== null && (view.status === "completed" || view.status === "failed" || view.status === "killed")) break;
				if (timedOut || params.outerSignal?.aborted) break;
				const liveness = await checkReviewSessionLiveness(deps.gateway, sessionId);
				logEvent("doc_review_monitor_chunk", {
					sessionId, attempt: attempts, alive: liveness.alive, reason: liveness.reason
				});
				if (!liveness.alive) break;
			}
			const terminal = view !== null && (view.status === "completed" || view.status === "failed" || view.status === "killed");
			if (!terminal) {
				// wait 分片耗尽/session 停滞：kill 前先 salvage —— 审查 session 由 gateway 独立驱动，
				// monitor 未 settle 不代表 session 没跑完；直接读既有结论，避免把已产出的审查结果当 timeout 丢弃。
				let verdict = null;
				try {
					verdict = await inspectReviewSession(deps.gateway, sessionId, startedAt);
				} catch {
					verdict = null;
				}
				const freeform = verdict?.freeform;
				if (typeof freeform === "string" && freeform.trim().length > 0) {
					// salvage 命中：以既有结论文本为准（无论 outcome 是 succeeded/failed/cancelled）。
					const judged = judgeFreeformOutcome(freeform, { params, deps, attempts, timedOut });
					if (judged.kind === "report") {
						logEvent("doc_review_session_salvaged", { sessionId, attempt: attempts });
						return { kind: "report", report: judged.report, sessionId, promptedAt, attempts, retries };
					}
					// salvage 命中但 JSON 不合规/截断：禁止重试（不调 rePromptReviewSession），
					// 降级 freeform 信封，由主 Agent 自行解析（与正常 freeform 降级同语义）。
					logEvent("doc_review_session_salvaged_freeform", { sessionId, attempt: attempts });
					return { kind: "freeform", freeformText: freeform, sessionId, promptedAt, attempts, retries };
				}
				// 确无结论（outcome==='pending' 或 freeform 为空）→ kill monitor 并判 timeout。
				try {
					deps.jobs.kill(jobId, owner, "doc-review monitor deadline");
				} catch {
					/* kill 失败不升级 */
				}
				if (timedOut) return { kind: "timeout", sessionId, promptedAt, attempts, retries };
				if (params.outerSignal?.aborted) return { kind: "aborted", sessionId, promptedAt, attempts, retries };
				return { kind: "timeout", sessionId, promptedAt, attempts, retries };
			}

			// 收集 job 结论（result 优先，其次输出环 chunks 拼接）。
			let freeformText = "";
			try {
				const read = deps.jobs.read(jobId, owner);
				freeformText = typeof read?.result === "string" ? read.result : "";
				if (freeformText.length === 0) {
					freeformText = (read?.chunks ?? []).map((chunk) => chunk.text ?? "").join("");
				}
			} catch {
				freeformText = "";
			}
			if (view.status === "killed") {
				if (timedOut) return { kind: "timeout", sessionId, promptedAt, attempts, retries };
				if (params.outerSignal?.aborted) return { kind: "aborted", sessionId, promptedAt, attempts, retries };
				return { kind: "timeout", sessionId, promptedAt, attempts, retries };
			}

			const verdict = judgeFreeformOutcome(freeformText, { params, deps, attempts, timedOut });
			if (verdict.kind !== "retry") return { ...verdict, sessionId, promptedAt, attempts, retries };
			const willRetry = attempts < MAX_TOTAL_ATTEMPTS;
			const record = describeRetryRecord(attempts, verdict.failure, willRetry);
			retries.push(record);
			notifyRetry(verdict.failure, attempts, willRetry);
			lastFailure = verdict.failure;
			attempts += 1;
			if (attempts > MAX_TOTAL_ATTEMPTS) break;
			// 超时/取消/预算耗尽后不得再向审查 session 发 prompt：发了也不会被监视，
			// 纯白烧 token（旧实现在 monitor deadline 后会多打一次 prompt 才返回 timeout）。
			if (timedOut || params.outerSignal?.aborted || Date.now() >= deadlineAt) {
				return {
					kind: timedOut || Date.now() >= deadlineAt ? "timeout" : "aborted",
					sessionId, promptedAt, attempts, retries
				};
			}

			// 重试：同一审查 session 内追加一轮 prompt（修正指令，不重灌全文）。
			const retryPrompt = buildAttemptPrompt(params.inputText, lastFailure);
			try {
				promptedAt = await rePromptReviewSession(deps.gateway, sessionId, retryPrompt);
			} catch (error) {
				return { kind: "start-error", error: String(error?.message ?? error), sessionId, promptedAt, attempts, retries };
			}
			logEvent("doc_review_session_reprompted", { sessionId, attempt: attempts });
		}
	} finally {
		clearTimeout(deadlineTimer);
		params.outerSignal?.removeEventListener("abort", forwardAbort);
	}
	return { kind: "freeform", freeformText: lastFailure?.freeformText ?? "", sessionId, promptedAt, attempts, retries };
}
