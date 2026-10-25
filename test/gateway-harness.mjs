/**
 * test/gateway-harness.mjs —— v0.3.0 session 架构的 gateway/jobs mock。
 *
 * 供 service/tool 集成测试复用（替代 v0.3.0 前的 subagents stub：deps.subagents
 * 已被 typertGateway + JobRegistry 取代，旧 mock 全部撞
 * 「createDocReviewService: deps.gateway 为必注入服务」）。
 *
 * 审查流程在 mock 下的对应关系：
 *   launchReviewSession  → invoke:create → invoke:rename → [invoke:selectModel] → invoke:prompt
 *   rePromptReviewSession→ invoke:prompt（重试，不重灌全文）
 *   spawnReviewMonitorJob→ jobs.start
 *   runReviewerSession   → jobs.wait(jobId, chunkMs) → jobs.read(jobId)（结论文本）
 *   inspectReviewSession → invoke:list + stream:follow + invoke:page（salvage 路径）
 *
 * attempts 按 job 序号（第 N 个 jobs.start）取第 N 项（末项不足时重复末项）：
 *   {wait: view|Promise, waitPending: deferred, result: string}
 *   - wait 缺省 {status:"running"}（非终态，驱动 salvage/liveness 路径）；
 *   - waitPending 供 busy 互斥用例把第一次调用挂在 wait 上；
 *   - result 为 jobs.read 的结论文本（审查员 assistant 纯文本，JSON 或自由文本）。
 */
import { validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";

/** 解析 jobId 中的序号（job-1 → 1）。 */
function jobIndex(jobId) {
	const match = /(\d+)$/.exec(String(jobId ?? ""));
	return match === null ? 1 : Number(match[1]);
}

/**
 * 构造 gateway/jobs 全 mock。
 * @param {object} [options] 配置。
 * @param {Array<{wait?: object|Promise, waitPending?: {promise: Promise}, result?: string}>} [options.attempts]
 *   按 job 次序的 attempt 脚本（默认单项 completed/空结论）。
 * @param {Array<object>} [options.records] salvage 用事件流（follow opening records；默认空 → pending）。
 * @param {string[]} [options.existingSessions] 预置已存在的 session id（list 可见，不占 create 序号）。
 * @param {{running?: boolean, updatedAt?: number}|null} [options.listSummary] list summary 存活度字段
 *   （缺省 {running:false, updatedAt:Date.now()} = 近期有活动判活）。
 * @param {number} [options.waitSleepMs] jobs.wait 的模拟等待（默认 5ms，防瞬返空转）。
 * @returns {object} {deps, log, prompts, renames, selectModelCalls, createdSessions, count}。
 */
export function makeReviewHarness(options = {}) {
	const {
		attempts = [{ wait: { status: "completed" }, result: "" }],
		records = [],
		existingSessions = [],
		listSummary = null,
		waitSleepMs = 5
	} = options;
	const log = [];
	const prompts = [];
	const renames = [];
	const selectModelCalls = [];
	const createdSessions = [];
	let jobSeq = 0;

	const attemptAt = (index) => attempts[Math.min(Math.max(index, 1), attempts.length) - 1] ?? {};
	const summaryOf = (sessionId) => {
		const base = { sessionId };
		if (listSummary === null) return { ...base, running: false, updatedAt: Date.now() };
		return { ...base, ...listSummary };
	};

	const gateway = {
		invoke: async ({ namespace, method, args }) => {
			log.push({ op: "invoke:" + method });
			if (namespace !== "session") throw new Error("unexpected namespace " + namespace);
			const request = args?.request ?? args ?? {};
			switch (method) {
				case "create": {
					const sessionId = `sess-review-${createdSessions.length + 1}`;
					createdSessions.push(sessionId);
					return { sessionId };
				}
				case "rename":
					renames.push(request);
					return {};
				case "selectModel":
					selectModelCalls.push(request);
					return {};
				case "prompt":
					prompts.push(request?.content?.[0]?.text ?? "");
					return {};
				case "list":
					return {
						items: [...existingSessions, ...createdSessions].map((sessionId) => summaryOf(sessionId))
					};
				case "page":
					return { records: [], hasMore: false };
				default:
					throw new Error("unexpected session method " + method);
			}
		},
		stream: async () => {
			log.push({ op: "stream:follow" });
			const snapshot = { type: "snapshot", cursor: 100, records, hasMore: false };
			return {
				[Symbol.asyncIterator]() {
					let first = true;
					return {
						next: async () => {
							if (first) {
								first = false;
								return { value: snapshot, done: false };
							}
							return { value: undefined, done: true };
						},
						return: async () => ({ value: undefined, done: true })
					};
				}
			};
		}
	};

	const jobs = {
		// 真源 JobRegistry 契约：start 同步返回字符串 jobId（wait/read/get/kill 均以其为键），
		// 故 mock 亦必须同步返回字符串——写成 async 会让 spawnReviewMonitorJob 的
		// `return jobs.start(...)` 把 Promise 当 jobId 传给 wait/read，attempt 序号全丢。
		start: () => {
			log.push({ op: "start" });
			jobSeq += 1;
			return `job-${jobSeq}`;
		},
		wait: async (jobId) => {
			log.push({ op: "wait", jobId });
			const attempt = attemptAt(jobIndex(jobId));
			if (waitSleepMs > 0) await new Promise((resolve) => { setTimeout(resolve, waitSleepMs); });
			if (attempt.waitPending !== undefined) return attempt.waitPending.promise;
			return attempt.wait ?? { status: "running" };
		},
		read: (jobId) => {
			log.push({ op: "read", jobId });
			const attempt = attemptAt(jobIndex(jobId));
			return { result: attempt.result ?? "", chunks: [] };
		},
		kill: async (jobId, owner, reason) => {
			log.push({ op: "kill", jobId, reason });
		},
		get: async (jobId) => {
			const attempt = attemptAt(jobIndex(jobId));
			return attempt.wait ?? { status: "running" };
		}
	};

	return {
		deps: { gateway, jobs, validateJsonSchemaValue },
		log,
		prompts,
		renames,
		selectModelCalls,
		createdSessions,
		/** 统计某类 gateway/job 操作次数（如 invoke:create / invoke:prompt）。 */
		count: (op) => log.filter((entry) => entry.op === op).length
	};
}
