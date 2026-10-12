/**
 * lib/tool.js —— T03 doc_review 工具注册与参数校验（M2 完整实现）。
 *
 * 契约要点：
 * - defineTool 必带 output:{schema,render}（schema.d.ts:178-248）；schema=T02b
 *   TOOL_OUTPUT_SPEC（ValueSchemaSpec DSL），execute 返回值必须匹配该 schema。
 * - 内核在 user execute 前自动按 parameters DSL 校验参数（dsh-tools
 *   lib/index.js:838-871：违规 → ToolArgsError）——未知 doc_type/mode 枚举值、
 *   类型错误由此拦截；数值边界（max_rounds≤3）DSL 无法表达，在 execute 内校验。
 * - execute 内语义错误统一 throw ToolArgsError([...])：内核转为结构化错误结果
 *   （isError:true + error.message，lib/index.js:3317-3321/:3623-3635），零子会话。
 * - busy 并发互斥：同一 parent Agent（session.id）仅一个 in-flight；第二个并发
 *   调用返回 degraded:"busy" 的正常结构化返回值（任务书 :120，非 throw）。
 * - exec.agent 缺失：显式转降级路径②（same-session 自审指令包，T05 防御条款，
 *   仿 dsh-tool-subagent/lib/index.js:491-492 的 fail-loud 精神但不 throw）。
 * - references 安全边界：仅内联文本 + 工作区相对路径；绝对路径与 .. 穿越拒绝；
 *   URL 不抓取（作为内联文本原样传递）；文件读取双重防线（resolved 必须仍在
 *   工作区根内）。
 * - deferContext：成功路径注入简短行动指令（T07 强化手段②，只放指令不放报告
 *   全文）。
 * - M4 集成：T10 派子会话前做最坏口径成本预估，超 20000 token 且链未确认 →
 *   confirmationRequired 结构化返回（零子会话）+ concludeTurn()；confirm 绑定
 *   chain_id 链级有效，链累计 > 20000×max_rounds 再次拦截（状态落 chain-cost.json）。
 *   T08 round>1 优先读归档 round-<prev>/document.md 与 review-report.json，皆无 →
 *   「多轮链断裂」结构化错误；子会话后以纯函数复算 changeRatio/issue 对齐/收敛，
 *   newIssueCount 以插件复算为准；mode=sample 等距抽 30% 段落且仅 fact/format。
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { ToolArgsError, defineTool, validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { buildAdjudicationGuidance, buildDeferredInstruction, buildNextAction } from "./adjudicate.js";
import {
	readArchivedDocument,
	readArchivedReport,
	readChainCostState,
	writeChainCostState,
	writeRoundArchive
} from "./archive.js";
import { buildSamplePlan, estimateRound, judgeConfirmation } from "./cost.js";
import { alignIssues, computeChangeRatio, judgeConvergence } from "./convergence.js";
import {
	buildReviewInput,
	extractTextFromBlocks,
	heuristicCleanPlainText
} from "./context-builder.js";
import { logEvent } from "./logger.js";
import { runReviewerSession, SPAWN_PROVIDER_NAME } from "./reviewer.js";
import { DOC_REVIEW_REPORT_SCHEMA, TOOL_OUTPUT_SPEC } from "./schema.js";

/** 工具名（注册名，任务书 T03）。 */
export const TOOL_NAME = "doc_review";

/** doc_type 闭合枚举（legal/medical 预留不启用，P08）。 */
export const DOC_TYPES = Object.freeze(["generic", "tech-spec", "product-doc"]);

/** mode 闭合枚举（sample 的 30% 段落抽样属 T10 集成，B/C 卡；本卡仅做维度掩码）。 */
export const REVIEW_MODES = Object.freeze(["full", "sample", "fact-only"]);

/** max_rounds 默认值与硬上限（任务书 T03/P07）。 */
export const DEFAULT_MAX_ROUNDS = 1;
export const MAX_ROUNDS_HARD_LIMIT = 3;

/** chain_id 合法形态（进入归档路径，必须文件系统安全）。 */
const CHAIN_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** URL scheme 形态（references 中命中即视为 URL：不抓取，按内联文本传递）。 */
const URL_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/** 相对文件路径形态（无空白 + 带扩展名，或含路径分隔符且无空白）。 */
const FILE_PATH_PATTERN = /^(?:[^\\\s/]+[\\/])*[^\\\s/]+\.[A-Za-z0-9]{1,8}$/;

/** web_fact_check=true 时放行给审查员的 web 工具名（dsh-tool-web 实测注册名）。 */
const WEB_TOOL_NAMES = Object.freeze(["web_search", "web_fetch"]);

/** deferContext 消息 source（v4 会话行级准入：plugin:<name> 形态，dsh-cot-anchor 先例）。 */
const PLUGIN_MESSAGE_SOURCE = Object.freeze({
	kind: "plugin:dsh-doc-review",
	plugin: "dsh-doc-review"
});

/** 工具描述（主 Agent 可见；含多轮链契约提示）。 */
const TOOL_DESCRIPTION = [
	"对目标文档做独立子会话审查，返回结构化报告（issues）、裁决表模板与下一步指引。",
	"target_content / target_message_id / target_file 三选一（都缺 → 参数错误）。",
	"target_file 为工作区相对路径（绝对路径与 .. 拒绝），审查工作区文件时优先使用，无需内联全文。",
	"references 仅支持内联文本与工作区相对路径（绝对路径与 .. 拒绝，URL 不抓取）。",
	"多轮：首轮返回 chainId；后续轮必须回传 chain_id、prev_round，并可携带 prev_report/",
	"prev_adjudication/prev_document；每轮结束按裁决表修改文档后再发起下一轮。"
].join("\n");

/**
 * 记录参数错误并抛 ToolArgsError（内核转结构化错误结果；A03 零子会话信号）。
 * @param {string} message 违规描述。
 * @returns {never}
 */
function failArgs(message) {
	logEvent("doc_review_arg_error", { reason: message });
	throw new ToolArgsError([message]);
}

/**
 * 校验多轮链参数并计算本轮 round/chainId。
 * @param {object} args 工具入参。
 * @returns {{round: number, chainId: string, maxRounds: number}}
 */
function resolveRoundAndChain(args) {
	const prevRound = args.prev_round ?? 0;
	if (!Number.isInteger(prevRound) || prevRound < 0) failArgs(`prev_round 必须为 ≥0 的整数（收到 ${prevRound}）`);
	const maxRounds = args.max_rounds ?? DEFAULT_MAX_ROUNDS;
	if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > MAX_ROUNDS_HARD_LIMIT) {
		failArgs(`max_rounds 必须为 1..${MAX_ROUNDS_HARD_LIMIT} 的整数（收到 ${maxRounds}）`);
	}
	const round = prevRound + 1;
	if (round > maxRounds) failArgs(`轮次预算耗尽：round=${round} 超过 max_rounds=${maxRounds}`);
	let chainId = args.chain_id;
	if (chainId === undefined) {
		if (prevRound > 0) failArgs("多轮调用必须回传 chain_id（首轮返回值中的 chainId）");
		chainId = `docr-${randomUUID()}`;
	}
	if (!CHAIN_ID_PATTERN.test(chainId)) failArgs(`chain_id 非法：仅允许字母/数字/_/-（收到 ${chainId}）`);
	return { round, chainId, maxRounds };
}

/**
 * 解析 target（三选一）为目标纯文本。
 * target_content → 纯文本导出兜底路径（启发式清洗，命中时 heuristicClean=true）；
 * target_message_id → 本会话消息 ContentBlock[]（类型化路径，按 type 过滤）；
 * target_file → 工作区相对路径直读（审查工作区文件的主路径，避免大文档内联进工具参数撑爆输出预算）。
 * @param {object} args 工具入参。
 * @param {object | undefined} agent exec.agent（可能缺失）。
 * @param {string} workspaceRoot 工作区根绝对路径（target_file 解析锚点）。
 * @returns {{targetText: string, heuristicClean: boolean, droppedBlocks: number}}
 */
function resolveTargetText(args, agent, workspaceRoot) {
	const hasContent = typeof args.target_content === "string" && args.target_content.trim().length > 0;
	const hasMessageId = typeof args.target_message_id === "string" && args.target_message_id.length > 0;
	const hasFile = typeof args.target_file === "string" && args.target_file.trim().length > 0;
	if (!hasContent && !hasMessageId && !hasFile) {
		failArgs("target_content / target_message_id / target_file 至少传一个（都缺）");
	}
	if (hasContent) {
		const cleaned = heuristicCleanPlainText(args.target_content);
		return { targetText: cleaned.text, heuristicClean: cleaned.heuristicClean, droppedBlocks: 0 };
	}
	if (hasFile) {
		// 与 references 同一套边界：拒绝绝对路径与 .. 穿越，resolve 后必须仍在工作区根内。
		const relativePath = args.target_file;
		if (isAbsolute(relativePath) || /^[A-Za-z]:[\\/]/.test(relativePath) || relativePath.startsWith("\\\\")) {
			failArgs(`target_file 拒绝绝对路径：${relativePath}`);
		}
		if (relativePath.split(/[\\/]+/).some((segment) => segment === "..")) {
			failArgs(`target_file 拒绝 .. 穿越：${relativePath}`);
		}
		const absolutePath = resolve(workspaceRoot, relativePath);
		const insideWorkspace = absolutePath === workspaceRoot || absolutePath.startsWith(workspaceRoot + sep);
		if (!insideWorkspace) failArgs(`target_file 路径逃逸工作区：${relativePath}`);
		if (!existsSync(absolutePath)) failArgs(`target_file 文件不存在：${relativePath}`);
		let fileText;
		try {
			fileText = readFileSync(absolutePath, "utf8");
		} catch (error) {
			failArgs(`target_file 文件不可读：${relativePath}（${String(error?.message ?? error)}）`);
		}
		return { targetText: fileText, heuristicClean: false, droppedBlocks: 0 };
	}
	if (!agent) failArgs("无调用 Agent（exec.agent 缺失），无法解析 target_message_id；请改用 target_content 或 target_file");
	const message = agent.session.deriveMessages().find((entry) => entry.id === args.target_message_id);
	if (!message) failArgs(`target_message_id 不存在于本会话：${args.target_message_id}`);
	const extracted = extractTextFromBlocks(message.content);
	if (extracted.text.trim().length === 0) failArgs(`target_message_id 指向的消息无可提取文本块：${args.target_message_id}`);
	return { targetText: extracted.text, heuristicClean: false, droppedBlocks: extracted.droppedBlocks };
}

/**
 * 判定单条 reference 的类别并做安全边界校验。
 * @param {string} entry 原始条目。
 * @returns {{kind: "inline" | "file", relativePath?: string, text?: string}} 分类结果。
 */
function classifyReference(entry) {
	if (typeof entry !== "string" || entry.trim().length === 0) failArgs("references 条目必须为非空字符串");
	if (isAbsolute(entry) || /^[A-Za-z]:[\\/]/.test(entry) || entry.startsWith("\\\\")) {
		failArgs(`references 拒绝绝对路径：${entry}`);
	}
	const segments = entry.split(/[\\/]+/);
	if (segments.some((segment) => segment === "..")) failArgs(`references 拒绝 .. 穿越：${entry}`);
	if (URL_SCHEME_PATTERN.test(entry)) return { kind: "inline", text: entry };
	if (!/\s/.test(entry) && FILE_PATH_PATTERN.test(entry)) return { kind: "file", relativePath: entry };
	return { kind: "inline", text: entry };
}

/**
 * 解析 references 参数为 [{label, text}]（label 形如 inline|file:<相对路径>）。
 * 文件条目：resolve 后必须仍在工作区根内（双重防线），存在且可读，否则参数错误。
 * @param {readonly string[] | undefined} references 原始参数。
 * @param {string} workspaceRoot 工作区根绝对路径。
 * @returns {{label: string, text: string}[]} 供 T04【参考资料】段使用。
 */
function resolveReferences(references, workspaceRoot) {
	const resolved = [];
	for (const entry of references ?? []) {
		const classified = classifyReference(entry);
		if (classified.kind === "inline") {
			resolved.push({ label: "inline", text: classified.text });
			continue;
		}
		const absolutePath = resolve(workspaceRoot, classified.relativePath);
		const insideWorkspace = absolutePath === workspaceRoot || absolutePath.startsWith(workspaceRoot + sep);
		if (!insideWorkspace) failArgs(`references 路径逃逸工作区：${entry}`);
		if (!existsSync(absolutePath)) failArgs(`references 相对路径不存在：${entry}`);
		let fileText;
		try {
			fileText = readFileSync(absolutePath, "utf8");
		} catch (error) {
			failArgs(`references 文件不可读：${entry}（${String(error?.message ?? error)}）`);
		}
		resolved.push({ label: `file:${classified.relativePath}`, text: fileText });
	}
	return resolved;
}

/**
 * 解析 dimensions 开关（缺省全 true；显式 false 才关闭）并按 mode 施加维度掩码。
 * @param {object} args 工具入参。
 * @returns {Record<string, boolean>} 四维度开关。
 */
function resolveDimensions(args) {
	const dimensions = {
		fact: args.dimensions?.fact !== false,
		completeness: args.dimensions?.completeness !== false,
		necessity: args.dimensions?.necessity !== false,
		format: args.dimensions?.format !== false
	};
	if (args.mode === "fact-only") {
		dimensions.completeness = false;
		dimensions.necessity = false;
		dimensions.format = false;
	}
	if (args.mode === "sample") {
		dimensions.completeness = false;
		dimensions.necessity = false;
	}
	return dimensions;
}

/**
 * 校验 prev_report（如提供必须过 T02a Schema）。
 * @param {unknown} prevReport 入参。
 * @returns {object | null} 合法报告或 null。
 */
function resolvePrevReport(prevReport) {
	if (prevReport === undefined || prevReport === null) return null;
	const violations = validateJsonSchemaValue(DOC_REVIEW_REPORT_SCHEMA, prevReport);
	if (violations.length > 0) failArgs(`prev_report 不符合 T02a Schema：${violations.slice(0, 3).join("；")}`);
	return prevReport;
}

/**
 * 组装 subagent 派生参数：toolFilter/agentOptions（P09 默认继承主 Agent）。
 * @param {object} args 工具入参。
 * @returns {{toolFilter: {allow: string[]}, agentOptions: object | null}}
 */
function resolveReviewerOptions(args) {
	const toolFilter = { allow: args.web_fact_check === true ? [...WEB_TOOL_NAMES] : [] };
	let agentOptions = null;
	if (args.reviewer_model !== undefined && args.reviewer_model !== null) {
		const provider = args.reviewer_model.provider;
		const model = args.reviewer_model.model;
		if (provider === undefined && model === undefined) failArgs("reviewer_model 至少提供 provider/model 之一");
		agentOptions = {};
		if (provider !== undefined) agentOptions.provider = provider;
		if (model !== undefined) agentOptions.model = model;
	}
	return { toolFilter, agentOptions };
}

/**
 * 构造降级占位报告（summary ≤200 字，符合 T02b report 子形态）。
 * @param {string} reason degraded 枚举值。
 * @param {string} note 简短说明。
 * @param {number} round 本轮轮次。
 * @param {string} chainId 链 ID。
 * @returns {object} 占位报告。
 */
function degradedPlaceholderReport(reason, note, round, chainId) {
	return {
		summary: `degraded:${reason}。${note}`.slice(0, 180),
		issues: [],
		newIssueCount: 0,
		round,
		chainId
	};
}

/**
 * 组装最终工具返回值（只含有值键，匹配 TOOL_OUTPUT_SPEC additionalProperties:false）。
 * @param {object} parts 字段集合。
 * @returns {object} 工具返回值。
 */
function buildToolResult(parts) {
	const result = {
		next_action: parts.nextAction,
		round: parts.round,
		chainId: parts.chainId
	};
	// report/adjudication_template 在 T10 confirmationRequired 分支缺省（未派子会话）。
	if (parts.report !== undefined) result.report = parts.report;
	if (parts.adjudicationTemplate !== undefined) result.adjudication_template = parts.adjudicationTemplate;
	if (parts.degraded !== undefined) result.degraded = parts.degraded;
	if (parts.skillMissing !== undefined) result.skillMissing = parts.skillMissing;
	if (parts.heuristicClean !== undefined) result.heuristicClean = parts.heuristicClean;
	if (parts.archivePath !== undefined) result.archivePath = parts.archivePath;
	if (parts.confirmationRequired !== undefined) result.confirmationRequired = parts.confirmationRequired;
	if (parts.costEstimate !== undefined) result.costEstimate = parts.costEstimate;
	if (parts.changeRatio !== undefined) result.changeRatio = parts.changeRatio;
	if (parts.converged !== undefined) result.converged = parts.converged;
	if (parts.convergenceReason !== undefined) result.convergenceReason = parts.convergenceReason;
	if (parts.resolvedIssueCount !== undefined) result.resolvedIssueCount = parts.resolvedIssueCount;
	return result;
}

/**
 * 把成本预估与确认判定组装为 TOOL_OUTPUT_SPEC.costEstimate 子对象。
 * @param {object} estimate cost.estimateRound 结果。
 * @param {object} detail cost.judgeConfirmation().estimateDetail。
 * @param {string|null} reason 拦截原因（放行时 null）。
 * @returns {object} costEstimate 字段值。
 */
function buildCostEstimate(estimate, detail, reason) {
	return {
		singleRoundTokens: estimate.singleRoundTokens,
		worstCaseTokens: estimate.worstCaseTokens,
		inputPackageChars: estimate.inputPackageChars,
		mode: estimate.mode,
		chainCumulativeTokens: detail.chainCumulativeTokens,
		chainBudgetTokens: detail.chainBudgetTokens,
		thresholdTokens: detail.thresholdTokens,
		maxRounds: detail.maxRounds,
		chainConfirmed: detail.chainConfirmed,
		...(reason !== null ? { reason } : {})
	};
}

/**
 * T10 成本拦截分支返回值（零子会话；配合 exec.concludeTurn()）。
 * @param {object} params 参数。
 * @returns {object} 工具返回值（confirmationRequired=true，无 report）。
 */
function buildConfirmationRequiredResult({ round, chainId, estimate, judgment }) {
	const detail = judgment.estimateDetail;
	const recallHint =
		round > 1
			? `请回传 chain_id="${chainId}"、prev_round=${round - 1} 并附 prev_report/prev_document`
			: "首轮无需 chain_id/prev_round";
	const reasonNote =
		judgment.reason === "chain-cumulative-over-budget"
			? `链累计最坏口径 ${Math.ceil(detail.chainCumulativeTokens)} token 已超过链预算 ${detail.chainBudgetTokens} token` +
				"（max_rounds 次确认总量上限，confirm_token_budget 不能豁免）；请缩减文档、改用 mode=sample/fact-only 或调小 max_rounds"
			: `本轮最坏口径 ${Math.ceil(estimate.worstCaseTokens)} token 超过单次确认阈值 ${detail.thresholdTokens} token` +
				`；如确认支出，请携带 confirm_token_budget=true 重新调用（${recallHint}）`;
	return buildToolResult({
		nextAction: `[T10 成本确认] ${reasonNote}。本次未派发审查子会话。`,
		round,
		chainId,
		confirmationRequired: true,
		costEstimate: buildCostEstimate(estimate, detail, judgment.reason)
	});
}

/**
 * 降级路径统一出口：占位报告 + 降级说明 next_action（不派/已终止子会话）。
 * @param {object} params 降级参数。
 * @returns {object} 工具返回值。
 */
function degradedResult({ reason, note, nextAction, round, chainId, skillMissing, heuristicClean }) {
	return buildToolResult({
		report: degradedPlaceholderReport(reason, note, round, chainId),
		adjudicationTemplate: "本轮为降级结果，无结构化 issues，无需裁决表。",
		nextAction,
		round,
		chainId,
		degraded: reason,
		skillMissing: skillMissing === true ? true : undefined,
		heuristicClean: heuristicClean === true ? true : undefined
	});
}

/**
 * same-session 降级（路径②）：不派子会话，返回同会话自审指令包。
 * @param {string} inputText T04 输入包全文（自审材料）。
 * @param {string} reasonNote 触发原因说明。
 * @returns {string} next_action 自审指令包文本。
 */
function buildSameSessionInstruction(inputText, reasonNote) {
	return [
		`doc_review 降级为同会话自审（原因：${reasonNote}）。`,
		"请你（主 Agent）立即切换为独立找茬者角色，仅依据下方审查输入包对目标文档执行审查，",
		"按 report 结构（summary/issues[id,dimension,severity,location,claim,evidence,suggestion]/",
		"newIssueCount）在回复中输出审查结论，随后对每条 issue 输出裁决表并按裁决修改文档。",
		"―――― 审查输入包 ――――",
		inputText
	].join("\n");
}

/**
 * 渲染工具返回值为 ContentBlock[]（output.render）。
 * 裁决表原文渲染（每个 issue id 在模板中恰出现一次，A07 机检口径）；
 * issues 明细行带 id 供主 Agent 对号裁决。
 * @param {object} value execute 返回值。
 * @returns {{type: "text", text: string}[]} 文本块数组。
 */
function renderToolResult(value) {
	const lines = [
		`【doc_review】round=${value.round} chainId=${value.chainId}` +
			(value.degraded ? ` degraded=${value.degraded}` : "") +
			(value.skillMissing ? " skillMissing=true" : "") +
			(value.heuristicClean ? " heuristicClean=true" : "") +
			(value.confirmationRequired ? " confirmationRequired=true" : "") +
			(value.converged ? " converged=true" : "")
	];
	// T10 confirmationRequired 分支无 report/adjudication_template，仅渲染成本明细。
	if (value.costEstimate) {
		const cost = value.costEstimate;
		lines.push(
			`成本预估（mode=${cost.mode}，输入包 ${cost.inputPackageChars} 字符）：单轮≈${Math.ceil(cost.singleRoundTokens)}` +
			` token，最坏口径 ${Math.ceil(cost.worstCaseTokens)} token（阈值 ${cost.thresholdTokens}）；` +
			`链累计投影 ${Math.ceil(cost.chainCumulativeTokens ?? 0)}/${cost.chainBudgetTokens ?? "-"}` +
			`（maxRounds=${cost.maxRounds}，chainConfirmed=${cost.chainConfirmed}）`
		);
	}
	const report = value.report;
	if (report) {
		lines.push(`摘要：${report.summary}`);
		lines.push(`新增问题数：${report.newIssueCount}；issues 共 ${report.issues.length} 条`);
		if (value.changeRatio !== undefined) {
			lines.push(`T08 复算：changeRatio=${value.changeRatio}%，resolved=${value.resolvedIssueCount ?? 0}` +
				(value.convergenceReason ? `，收敛原因=${value.convergenceReason}` : ""));
		}
		for (const issue of report.issues) {
			lines.push(
				`- [${issue.id}] ${issue.dimension}/${issue.severity} @ ${issue.location} :: ${issue.claim}` +
					`（证据：${issue.evidence}；建议：${issue.suggestion}）`
			);
		}
		if (value.archivePath) lines.push(`归档：${value.archivePath}`);
		if (value.adjudication_template) lines.push("", value.adjudication_template);
	}
	lines.push("", `下一步：${value.next_action}`);
	return [{ type: "text", text: lines.join("\n") }];
}

/**
 * 成功路径：报告覆盖 + 三段引导 + T08 多轮复算 + 归档 + T10 链成本态落盘 + deferContext。
 * @param {object} params 组装参数。
 * @returns {object} 工具返回值。
 */
function buildSuccessResult(params) {
	const {
		report: rawReport, args, exec, round, chainId, maxRounds,
		skillMissing, heuristicClean, targetText,
		prevDocument, prevReport, estimate, judgment
	} = params;
	const docType = args.doc_type ?? "generic";
	// T02a：round/chainId 以插件为准。newIssueCount 初值：首轮=全部 issues；
	// 多轮先占位，下方 T08 复算后以插件对齐结果覆盖。
	const baseReport = {
		...rawReport,
		round,
		chainId,
		newIssueCount: round === 1 ? rawReport.issues.length : rawReport.newIssueCount
	};
	const guidance = buildAdjudicationGuidance(baseReport, { docType, round, maxRounds, chainId });

	// T08 多轮复算（仅 round>1 且上轮报告可用）：changeRatio + issue 对齐 + 收敛判定。
	let convergence = null;
	let nextAction = guidance.next_action;
	if (round > 1 && prevReport) {
		const changeRatio = computeChangeRatio(prevDocument, targetText);
		const alignment = alignIssues(prevReport.issues ?? [], guidance.issues, args.prev_adjudication);
		const verdict = judgeConvergence({
			changeRatio,
			currentIssues: guidance.issues,
			recomputedNewCount: alignment.newIssueCount,
			prevRound: round - 1,
			maxRounds,
			resolvedIssues: alignment.resolvedIssueCount
		});
		convergence = {
			changeRatio,
			newIssueCount: alignment.newIssueCount,
			resolvedIssueCount: alignment.resolvedIssueCount,
			converged: verdict.converged,
			reason: verdict.reason
		};
		nextAction = buildNextAction({
			round, maxRounds, chainId,
			converged: verdict.converged,
			convergenceReason: verdict.reason
		});
		logEvent("doc_review_convergence", {
			chainId, round, changeRatio,
			newIssueCount: alignment.newIssueCount,
			resolvedIssueCount: alignment.resolvedIssueCount,
			converged: verdict.converged,
			reason: verdict.reason
		});
	}

	const finalReport = {
		...baseReport,
		issues: guidance.issues,
		newIssueCount: convergence ? convergence.newIssueCount : baseReport.newIssueCount
	};
	const workspaceRoot = resolveWorkspaceRoot(exec);
	const archivePath = writeRoundArchive({
		workspaceRoot,
		chainId,
		round,
		documentText: targetText,
		report: finalReport,
		prevAdjudication: args.prev_adjudication
	});

	// T10：成功审查后落链级成本态（同轮重跑幂等：按 round 去重替换），confirm 随成功调用持久化。
	let costEstimate;
	if (estimate && judgment) {
		const state = readChainCostState(workspaceRoot, chainId);
		const roundRecord = {
			round,
			worstCaseTokens: estimate.worstCaseTokens,
			singleRoundTokens: estimate.singleRoundTokens,
			inputPackageChars: estimate.inputPackageChars,
			mode: estimate.mode
		};
		const otherRounds = state.rounds.filter((entry) => Number(entry?.round) !== round);
		const rounds = [...otherRounds, roundRecord].sort(
			(left, right) => Number(left.round) - Number(right.round)
		);
		const cumulativeWorstCaseTokens = rounds.reduce(
			(sum, entry) => sum + (Number.isFinite(Number(entry.worstCaseTokens)) ? Number(entry.worstCaseTokens) : 0),
			0
		);
		writeChainCostState(workspaceRoot, chainId, {
			confirmed: state.confirmed === true || args.confirm_token_budget === true,
			cumulativeWorstCaseTokens,
			rounds,
			pendingCumulativeAck: null
		});
		costEstimate = buildCostEstimate(estimate, judgment.estimateDetail, judgment.reason);
	}

	// T07 强化手段②：tool/result 之后向主 Agent 追加简短行动指令（不放报告全文）。
	if (typeof exec.deferContext === "function") {
		exec.deferContext(
			createUserMessage({
				content: [{ type: "text", text: buildDeferredInstruction() }],
				source: { ...PLUGIN_MESSAGE_SOURCE }
			})
		);
	}
	return buildToolResult({
		report: finalReport,
		adjudicationTemplate: guidance.adjudication_template,
		nextAction,
		round,
		chainId,
		skillMissing: skillMissing === true ? true : undefined,
		heuristicClean: heuristicClean === true ? true : undefined,
		archivePath,
		costEstimate,
		changeRatio: convergence ? convergence.changeRatio : undefined,
		converged: convergence ? convergence.converged : undefined,
		convergenceReason: convergence?.reason ?? undefined,
		resolvedIssueCount: convergence ? convergence.resolvedIssueCount : undefined
	});
}

/**
 * 定位工作区根（归档根；exec.agent.session.header.cwd，缺失回退 process.cwd）。
 * @param {object} exec ToolRunContext。
 * @returns {string} 工作区根绝对路径。
 */
function resolveWorkspaceRoot(exec) {
	const cwd = exec.agent?.session?.header?.cwd;
	return typeof cwd === "string" && cwd.length > 0 ? cwd : process.cwd();
}

/**
 * 按审查结局（reviewer.js 判别联合）映射工具返回值。
 * @param {object} outcome runReviewerSession 返回。
 * @param {object} context 上下文（args/exec/round/chainId/inputText/…）。
 * @returns {object} 工具返回值。
 */
function mapReviewerOutcome(outcome, context) {
	const {
		args, exec, round, chainId, maxRounds, skillMissing,
		heuristicClean, targetText, inputText,
		prevDocument, prevReport, estimate, judgment
	} = context;
	if (outcome.kind === "report") {
		return buildSuccessResult({
			report: outcome.report, args, exec, round, chainId, maxRounds,
			skillMissing, heuristicClean, targetText,
			prevDocument, prevReport, estimate, judgment
		});
	}
	if (outcome.kind === "freeform") {
		return degradedResult({
			reason: "freeform-parse",
			note: `子会话连续 ${outcome.attempts} 次未产出合规 structured 报告`,
			nextAction:
				"审查员输出未结构化（重试已用尽）。以下为审查员自由文本输出，请自行解析出 issues 清单，" +
				`随后逐条输出裁决表（id 按 ${args.doc_type ?? "generic"} 缩写-维度缩写-序号 规则自编）并按裁决修改文档：\n` +
				(outcome.freeformText.length > 0 ? outcome.freeformText : "（审查员无文本输出）"),
			round, chainId, skillMissing, heuristicClean
		});
	}
	if (outcome.kind === "aborted") {
		return degradedResult({
			reason: "aborted",
			note: "审查被取消（用户 abort），未重试",
			nextAction: "本次审查已被取消，未产出报告；如仍需审查请重新调用 doc_review。",
			round, chainId, skillMissing, heuristicClean
		});
	}
	if (outcome.kind === "timeout") {
		return degradedResult({
			reason: "timeout",
			note: "审查子会话总超时（默认 600s），已主动 abort",
			nextAction:
				"审查超时未产出报告；可拆分文档、改用 mode=sample 或 mode=fact-only 后重新调用 doc_review" +
				`（回传 chain_id="${chainId}"、prev_round=${round - 1}）。`,
			round, chainId, skillMissing, heuristicClean
		});
	}
	// kind === "start-error"：基础设施拒绝（如 provider 不支持 outputSchema）→ 降级路径②。
	return degradedResult({
		reason: "same-session",
		note: `子会话派发失败：${outcome.error}`,
		nextAction: buildSameSessionInstruction(inputText, `start() 抛错：${outcome.error}`),
		round, chainId, skillMissing, heuristicClean
	});
}

/**
 * 工具主执行体（execute）。
 * @param {object} deps createDocReviewTool 注入的内核服务。
 * @param {Map<string, number>} inflightByParent busy 互斥表（parent session.id → 进入时间戳）。
 * @param {object} args 工具入参（内核已按 parameters DSL 预校验）。
 * @param {object} exec ToolRunContext。
 * @returns {Promise<object>} 匹配 TOOL_OUTPUT_SPEC 的返回值。
 */
async function executeDocReview(deps, inflightByParent, args, exec) {
	// A01 运行期信号：cordis 不保证插件 apply 先后（本卡 apply 时 getProvider("spawn")
	// 可能未注册，属时序假阴性）；start() 运行期按名解析，故以 execute 时刻为准。
	const spawnProvider =
		typeof deps.subagents.getProvider === "function" ? deps.subagents.getProvider(SPAWN_PROVIDER_NAME) : undefined;
	logEvent("doc_review_start", {
		docType: args.doc_type ?? "generic",
		mode: args.mode ?? "full",
		prevRound: args.prev_round ?? 0,
		hasTargetContent: typeof args.target_content === "string",
		hasTargetMessageId: typeof args.target_message_id === "string",
		hasTargetFile: typeof args.target_file === "string",
		referenceCount: Array.isArray(args.references) ? args.references.length : 0,
		spawnProviderPresent: spawnProvider !== undefined && spawnProvider !== null
	});
	const { round, chainId, maxRounds } = resolveRoundAndChain(args);
	const agent = exec.agent;
	const workspaceRoot = resolveWorkspaceRoot(exec);
	const target = resolveTargetText(args, agent, workspaceRoot);
	const references = resolveReferences(args.references, workspaceRoot);

	// T08 多轮数据源（round>1）：上轮文档/报告优先读归档，读回失败再降级入参。
	// 上一轮文档绝不进审查子会话输入包（仅用于 changeRatio），故这里只解析、不喂 buildReviewInput。
	let prevDocument = null;
	let prevReport = null;
	if (round > 1) {
		prevDocument = readArchivedDocument(workspaceRoot, chainId, round - 1);
		if (prevDocument === null && typeof args.prev_document === "string" && args.prev_document.length > 0) {
			prevDocument = args.prev_document;
		}
		if (prevDocument === null) {
			failArgs(
				`多轮链断裂：chain_id="${chainId}" 的 round-${round - 1} 归档文档读回失败，且未提供 prev_document；` +
				"本次不派发审查子会话"
			);
		}
		prevReport = readArchivedReport(workspaceRoot, chainId, round - 1) ?? resolvePrevReport(args.prev_report);
	}

	// T10/T03 分级：sample 等距抽 30% 段落（仅 fact/format），fact-only 仅 fact；full 原样全维度。
	// 抽样文本喂审查输入包与成本字符统计；完整 targetText 仅用于归档与 T08 changeRatio。
	const samplePlan = buildSamplePlan(target.targetText, args.mode);
	const userDimensions = resolveDimensions(args);
	const dimensions = {
		fact: userDimensions.fact && samplePlan.activeDimensions.includes("fact"),
		completeness: userDimensions.completeness && samplePlan.activeDimensions.includes("completeness"),
		necessity: userDimensions.necessity && samplePlan.activeDimensions.includes("necessity"),
		format: userDimensions.format && samplePlan.activeDimensions.includes("format")
	};
	const reviewTargetText = samplePlan.sampledText;

	// exec.agent 缺失：显式转降级路径②（T05 防御条款；target 解析已保证此分支只可能是 target_content）。
	if (!agent) {
		logEvent("doc_review_degraded", { reason: "same-session", detail: "exec.agent undefined" });
		const { inputText, skillMissing } = buildReviewInput({
			targetText: reviewTargetText, references,
			docType: args.doc_type ?? "generic",
			dimensions,
			prevReport
		});
		return degradedResult({
			reason: "same-session",
			note: "exec.agent 缺失（无调用 Agent），无法派发子会话",
			nextAction: buildSameSessionInstruction(inputText, "exec.agent 缺失"),
			round, chainId, skillMissing,
			heuristicClean: target.heuristicClean
		});
	}
	// busy 并发互斥：同一 parent Agent 仅一个 in-flight；第二个直接返回 degraded:"busy"（零子会话）。
	const parentKey = String(agent.session.id);
	if (inflightByParent.has(parentKey)) {
		logEvent("doc_review_degraded", { reason: "busy", parentKey });
		return degradedResult({
			reason: "busy",
			note: "同一 Agent 已有 in-flight doc_review 子会话",
			nextAction: "并发互斥：请等待当前 doc_review 审查完成后再发起下一次调用。",
			round, chainId,
			heuristicClean: target.heuristicClean
		});
	}
	inflightByParent.set(parentKey, Date.now());
	try {
		const { inputText, skillMissing } = buildReviewInput({
			targetText: reviewTargetText, references,
			docType: args.doc_type ?? "generic",
			dimensions, prevReport
		});
		logEvent("doc_review_context_built", {
			droppedBlocks: target.droppedBlocks,
			skillMissing,
			heuristicClean: target.heuristicClean,
			inputChars: inputText.length,
			mode: samplePlan.mode,
			sampled: samplePlan.samplingDetail.sampled
		});

		// T10 派子会话前成本预估：最坏口径 >20k 且链未确认 → 拦截（零子会话）+ concludeTurn。
		const estimate = estimateRound({ inputPackageChars: inputText.length, mode: samplePlan.mode });
		const chainCostState = readChainCostState(workspaceRoot, chainId);
		const confirmRequested = args.confirm_token_budget === true;
		const chainConfirmed = chainCostState.confirmed === true || confirmRequested;
		const projectedCumulative =
			chainCostState.cumulativeWorstCaseTokens + estimate.worstCaseTokens;
		// 链累计预算「再次确认」：上次因 chain-cumulative-over-budget 被拦时登记了投影值，
		// 本次带 confirm_token_budget=true 且投影一致 → 视为已再次确认，放行该条。
		const cumulativeAckMatched =
			confirmRequested
			&& chainCostState.pendingCumulativeAck !== null
			&& chainCostState.pendingCumulativeAck === projectedCumulative;
		const judgment = judgeConfirmation({
			worstCaseTokens: estimate.worstCaseTokens,
			chainConfirmed,
			chainCumulativeTokens: chainCostState.cumulativeWorstCaseTokens,
			singleRoundTokens: estimate.singleRoundTokens,
			maxRounds
		});
		if (judgment.confirmationRequired && !(
			judgment.reason === "chain-cumulative-over-budget" && cumulativeAckMatched
		)) {
			logEvent("doc_review_cost_confirm_required", {
				chainId, round, reason: judgment.reason,
				worstCaseTokens: estimate.worstCaseTokens,
				chainCumulativeTokens: judgment.estimateDetail.chainCumulativeTokens
			});
			// 任何拦截都登记待确认投影（本轮未执行，rounds/confirmed/累计保持不变）。
			// 关键：首次 worst-case 拦截时也须登记，否则用户首次 confirm 放行 worst 后
			// 会改撞 cumulative 门却无投影可匹配，被迫确认两次（违背 A10 一次确认预期）。
			writeChainCostState(workspaceRoot, chainId, {
				confirmed: chainCostState.confirmed === true,
				cumulativeWorstCaseTokens: chainCostState.cumulativeWorstCaseTokens,
				rounds: chainCostState.rounds,
				pendingCumulativeAck: projectedCumulative
			});
			if (typeof exec.concludeTurn === "function") {
				exec.concludeTurn({ confirmationRequired: true, costEstimate: judgment.estimateDetail });
			}
			return buildConfirmationRequiredResult({ round, chainId, estimate, judgment });
		}

		const reviewerOptions = resolveReviewerOptions(args);
		const outcome = await runReviewerSession(
			{ subagents: deps.subagents, validateJsonSchemaValue },
			{
				parentAgent: agent,
				outerSignal: exec.signal,
				inputText,
				targetText: reviewTargetText,
				outputSchema: DOC_REVIEW_REPORT_SCHEMA,
				toolFilter: reviewerOptions.toolFilter,
				agentOptions: reviewerOptions.agentOptions ?? undefined
			}
		);
		logEvent("doc_review_outcome", { kind: outcome.kind, attempts: outcome.attempts, round, chainId });
		return mapReviewerOutcome(outcome, {
			args, exec, round, chainId, maxRounds, skillMissing,
			heuristicClean: target.heuristicClean,
			targetText: target.targetText,
			prevDocument, prevReport, estimate, judgment,
			inputText
		});
	} finally {
		inflightByParent.delete(parentKey);
	}
}

/**
 * 创建 doc_review 工具定义（index.js apply 时调用并注册）。
 * @param {{subagents: {start: Function, getProvider?: Function}}} deps 内核服务。
 * @returns {object} defineTool 产物（ToolDefinition）。
 */
export function createDocReviewTool(deps) {
	const inflightByParent = new Map();
	return defineTool({
		name: TOOL_NAME,
		description: TOOL_DESCRIPTION,
		isConcurrencySafe: () => true,
		parameters: {
			target_content: {
				type: "string",
				description: "目标文档全文（与 target_message_id 二选一，至少传一个）"
			},
			target_message_id: {
				type: "string",
				description: "主会话内消息 ID（与 target_content 二选一；不存在或非本会话 → 结构化错误）"
			},
			target_file: {
				type: "string",
				description: "目标文档的工作区相对路径（与 target_content/target_message_id 三选一；审查工作区文件时优先使用，绝对路径与 .. 拒绝）"
			},
			references: {
				type: "array",
				items: { type: "string" },
				description: "参考资料：内联文本或工作区相对路径；绝对路径与 .. 拒绝；URL 不抓取"
			},
			doc_type: {
				type: "string",
				enum: [...DOC_TYPES],
				default: "generic",
				description: "文档类型（闭合枚举；legal/medical 预留未启用）"
			},
			dimensions: {
				type: "object",
				properties: {
					fact: { type: "boolean" },
					completeness: { type: "boolean" },
					necessity: { type: "boolean" },
					format: { type: "boolean" }
				},
				additionalProperties: false,
				description: "四维度开关，缺省全 true；创意类文档建议 necessity=false"
			},
			max_rounds: {
				type: "integer",
				default: DEFAULT_MAX_ROUNDS,
				description: `多轮上限，默认 1，硬上限 ${MAX_ROUNDS_HARD_LIMIT}`
			},
			reviewer_model: {
				type: "object",
				properties: {
					provider: { type: "string" },
					model: { type: "string" }
				},
				additionalProperties: false,
				description: "审查员模型覆盖；缺省继承主 Agent（P09）"
			},
			web_fact_check: {
				type: "boolean",
				default: false,
				description: "true 时给审查员开放 web_search/web_fetch；默认零外部工具"
			},
			mode: {
				type: "string",
				enum: [...REVIEW_MODES],
				default: "full",
				description: "分级模式；fact-only 仅事实维度，sample 抽样属 T10 集成"
			},
			chain_id: {
				type: "string",
				description: "审查链 ID：首轮由插件生成返回，多轮必须回传"
			},
			prev_round: {
				type: "integer",
				default: 0,
				description: "上一轮轮次，默认 0（首轮）"
			},
			prev_report: {
				type: "json",
				description: "上一轮审查报告（须符合 T02a Schema）"
			},
			prev_adjudication: {
				type: "json",
				description: "上一轮裁决表（可选；归档 change-log 来源）"
			},
			prev_document: {
				type: "string",
				description: "上一轮目标文档兜底（归档读回失败时用，T08 契约）"
			},
			confirm_token_budget: {
				type: "boolean",
				default: false,
				description: "T10 token 预算确认放行（链级有效；链累计超 20k×max_rounds 时需再次带此标记确认）"
			}
		},
		output: {
			schema: TOOL_OUTPUT_SPEC,
			render: (_args, value) => renderToolResult(value)
		},
		execute: (args, exec) => executeDocReview(deps, inflightByParent, args, exec)
	});
}
