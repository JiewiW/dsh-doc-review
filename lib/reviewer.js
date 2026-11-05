/**
 * lib/reviewer.js —— v0.3.0：审查员 prompt 装配 + 格式重试与失败降级（纯函数层）。
 *
 * v0.3.0 起派发机制迁至 lib/session-reviewer.js（开新 session + 后台 job 监视 + 收集结论，
 * 放弃 subagent）；本文件只保留与 subagent 无关的纯函数：
 *   - prompt 装配（persona / BASE_OUTPUT_INSTRUCTION / buildAttemptPrompt / 重试指令）
 *   - 自由文本 JSON 兜底解析（extractJsonObject / parseFreeformReport / extractFreeformText）
 *   - 业务规则校验与 location 双分支（validateReportBusinessRules / locationMatchesQuote/Heading）
 *   - 重试记录与 stopReason 归一（describeRetryRecord / describeStopReason）
 *
 * 判别联合语义（tool.js 据此映射 degraded）：
 * - {kind:'report', report, attempts, retries}        成功（JSON 校验通过，source:"session-freeform-salvage"）
 * - {kind:'freeform', freeformText, attempts, retries} 连续失败 → 降级路径①（degraded:"freeform-parse"）
 * - {kind:'aborted', attempts, retries}                用户取消 → 不重试（degraded:"aborted"）
 * - {kind:'timeout', attempts, retries}                总超时 → abort（degraded:"timeout"）
 * - {kind:'start-error', error, attempts, retries}     session 创建/重试 prompt 抛错 → 降级路径②
 *
 * retries：每次尝试失败（不合规/超限/错误）时产生一条记录，供工具层向主 Agent
 * 窗口暴露「不合规原因 + 重试提示」。字段形态见 describeRetryRecord。
 * 重试上报通道 params.onRetry（同步回调，审查循环内调用，供工具层实时收集）。
 *
 * 总超时默认 900s（自有 AbortController，超时主动 abort；可用 timeout_ms 覆盖，
 * 工具层边界 60_000..1_800_000）；重试上限：总尝试 MAX_TOTAL_ATTEMPTS=3
 * （1 初始 + 2 重试，任务书 T06）。
 *
 * 抗「弱模型」改造（针对模型把 JSON 吐在正文的实测失败）：
 * - parseFreeformReport：对自由文本做 JSON 切割 + 双重校验，通过即视为报告
 *   （source:"session-freeform-salvage"），避免白白重开一轮。
 * - buildAttemptPrompt 重试分支：默认只发「修格式」指令 + 上一版输出 + 违规原因，
 *   不再重灌输入包全文；仅 location 引句类违规或非正常结束时回退重灌。
 */

import {
	validateReport,
	ISSUE_FIELDS,
	ISSUE_FIELD_HINTS,
	REPORT_FIELDS
} from "./schema.js";

/** 审查者 persona（T05：独立找茬者，不引用主会话信息）。 */
export const REVIEWER_PERSONA =
	"独立的文档审查员（找茬者角色）：只对文档与事实负责，默认质疑文档中的每一个断言；" +
	"不迎合作者立场，不使用审查输入包之外的任何信息，发现不了问题时如实说明而不是编造。";

/** 总尝试次数上限：1 初始 + 2 重试（T06「最多 2 次」）。 */
export const MAX_TOTAL_ATTEMPTS = 3;

/**
 * 总超时默认值：900 秒（T05）。
 * 2026-10-25 由 600s 上调：实测长 CoT 审查（reasoning 9.2 万字符）需 605s 才产出
 * 结论，600s 默认必判 timeout；配合 session-reviewer 的分片续等，预算内不再误杀。
 */
export const DEFAULT_TIMEOUT_MS = 900_000;

/** summary 码点上限（T02a「≤200 字」，Array.from 口径防代理对拆半）。 */
export const SUMMARY_MAX_CODEPOINTS = 200;

/** location 引句分支的最小连续字符数（T02 二次校验口径 a）。 */
export const LOCATION_QUOTE_MIN_LENGTH = 8;

/** 由 T02a Schema 字段清单派生的字段契约说明（输出指令与重试提示共用，避免契约漂移）。 */
export const OUTPUT_FIELD_INSTRUCTION = [
	`顶层 ${REPORT_FIELDS.length} 个字段：${REPORT_FIELDS.join("、")}（缺一不可，且不得出现清单之外的任何顶层字段；summary ≤200 字）；`,
	`issues 每条 ${ISSUE_FIELDS.length} 个字段：${ISSUE_FIELDS.map((field) => `${field}（${ISSUE_FIELD_HINTS[field]}）`).join("、")}；`,
	"字段名必须逐字一致：不得用 title/description 等自造名称替代 id/dimension/claim，也不得增删字段。",
	"无参考资料时 evidence 填 no-reference；round 填 0，chainId 填空字符串（由插件回收后覆盖）。",
	"易错点：除顶层字段外全部字段都属于 issues 数组每条元素内部，绝不能写到顶层。"
].join("\n");

/** 固定输出指令（v0.3.0：普通 session 无 structured_output 工具 → 纯文本 ```json 围栏输出）。 */
export const BASE_OUTPUT_INSTRUCTION = [
	"【输出指令】",
	"得到最终结论后，必须把完整报告写成一段 ```json 围栏内的纯文本 JSON，作为你回复的最后一段内容；",
	"不要调用任何工具，不要以其他格式结尾——只有 ```json 围栏里的 JSON 才是你的结果。",
	"JSON 必须严格匹配以下字段（插件按同一份清单校验，字段名与个数不得改写）：",
	OUTPUT_FIELD_INSTRUCTION
].join("\n");

/** 重试追加指令：输出不合规（T06）。 */
export const RETRY_INSTRUCTION_INVALID =
	"上次输出不合规：严格按【输出指令】的字段名与字段个数逐字修正 JSON，不得自行猜测或改写字段名；只修结构，不改动审查结论。";

/**
 * 重试任务头（不再重灌输入包）：告诉模型本次是「修格式」而不是「重审文档」，
 * 避免模型看到长文档后重新走一遍完整审查、把格式要求冲散。
 */
export const CORRECTION_TASK_HEADER = [
	"【本次任务：只修格式，不重新审查】",
	"上一轮已经完成审查，结论在下面给出，只是输出结构未通过校验。",
	"本次不要重新阅读或重新审查文档，直接基于上一版结论修正结构后上报。",
	`字段名、字段个数一律以【输出指令】的清单为准（顶层 ${REPORT_FIELDS.length} 个、issues 每条 ${ISSUE_FIELDS.length} 个），` +
	"禁止使用清单之外的字段名，也禁止删减字段。"
].join("\n");

/** 上一版输出的包裹头（与 CORRECTION_TASK_HEADER 配套）。 */
export const CORRECTION_PRIOR_OUTPUT_HEADER = "上一版输出（待修正）：";

/** location 类违规关键字：命中说明模型需要回看目标文档原文才能修正引句。 */
const LOCATION_VIOLATION_PATTERN = /issues\[\d+\]\.location|location 为空/;

/**
 * 自由文本 JSON 兜底的最大扫描字符数（防止超长文本上做无谓扫描）。
 */
export const FREEFORM_SCAN_MAX_CHARS = 200_000;

/** 重试追加指令：max-tokens 截断（T06）。 */
export const RETRY_INSTRUCTION_MAX_TOKENS = "压缩 issues 数量，仅保留 high/medium。";

/**
 * 把一次失败的 stopReason 归一为主 Agent 可读的中文原因标签。
 * @param {string} stopReason 子会话 stopReason（或 "error" 占位）。
 * @returns {string} 人类可读原因。
 */
export function describeStopReason(stopReason) {
	switch (stopReason) {
		case "max-tokens":
			return "输出被 max-tokens 截断（未完整产出结构化报告）";
		case "error":
			return "子会话运行出错（result 被 reject）";
		case "invalid":
			return "输出已解析为 JSON，但字段/业务校验未通过";
		case "completed":
			return "已结束但 structured 报告未通过校验";
		case "aborted":
			return "审查被取消";
		case "timeout":
			return "审查超时";
		default:
			return `审查 turn 以 stopReason="${stopReason}" 结束，未产出合规 JSON 报告`;
	}
}

/**
 * 构造一条重试记录（主 Agent 窗口可见的最小信息集）。
 * @param {number} attempt 失败发生在第几次尝试（1 起）。
 * @param {{stopReason?: string, violations?: string[]}} failure 判出的失败信息。
 * @param {boolean} willRetry 是否还会发起下一次尝试。
 * @returns {{attempt: number, stopReason: string, reason: string, violations: string[], willRetry: boolean}} 记录。
 */
export function describeRetryRecord(attempt, failure, willRetry) {
	const stopReason = failure?.stopReason ?? "unknown";
	const violations = Array.isArray(failure?.violations) ? failure.violations.slice(0, 5) : [];
	return {
		attempt,
		stopReason,
		reason: describeStopReason(stopReason),
		violations,
		willRetry
	};
}

/**
 * 归一化文本用于标题匹配（与 T08 口径一致：去首尾空白+连续空白折单空格+英文小写+截前80码点）。
 * @param {string} text 原始文本。
 * @returns {string} 归一化结果。
 */
export function normalizeMatchText(text) {
	return Array.from(text.trim().replace(/\s+/g, " ").toLowerCase()).slice(0, 80).join("");
}

/**
 * 提取目标文档全部 markdown 标题行（归一化后）。
 * @param {string} targetText 目标文档纯文本。
 * @returns {string[]} 归一化标题行数组。
 */
export function extractHeadingLines(targetText) {
	const headings = [];
	for (const match of targetText.matchAll(/^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*$/gm)) {
		const normalized = normalizeMatchText(match[1]);
		if (normalized.length > 0) headings.push(normalized);
	}
	return headings;
}

/**
 * location 双分支之 a：含 ≥8 连续字符原文引句且目标文档精确命中。
 * @param {string} location issue.location 原文。
 * @param {string} targetText 目标文档纯文本。
 * @returns {boolean} 任一 8 码点滑窗命中即 true。
 */
export function locationMatchesQuote(location, targetText) {
	const codepoints = Array.from(location);
	if (codepoints.length < LOCATION_QUOTE_MIN_LENGTH) return false;
	for (let offset = 0; offset + LOCATION_QUOTE_MIN_LENGTH <= codepoints.length; offset += 1) {
		const window = codepoints.slice(offset, offset + LOCATION_QUOTE_MIN_LENGTH).join("");
		if (targetText.includes(window)) return true;
	}
	return false;
}

/**
 * location 双分支之 b：与目标文档某 markdown 标题行匹配（相等或互为包含）。
 * @param {string} location issue.location 原文。
 * @param {string[]} headingLines extractHeadingLines 的输出。
 * @returns {boolean} 命中任一标题行即 true。
 */
export function locationMatchesHeading(location, headingLines) {
	const normalizedLocation = normalizeMatchText(location);
	if (normalizedLocation.length === 0) return false;
	return headingLines.some((heading) =>
		heading === normalizedLocation || heading.includes(normalizedLocation) || normalizedLocation.includes(heading)
	);
}

/**
 * 报告业务规则二次校验（JSON Schema 表达不了的约束，T02 二次校验口径）。
 * @param {unknown} report 子会话 structured 输出。
 * @param {string} targetText 目标文档纯文本（location 命中判定的语料）。
 * @returns {string[]} 违规列表；空数组=通过。
 */
export function validateReportBusinessRules(report, targetText) {
	const violations = [];
	const summary = report?.summary;
	if (typeof summary !== "string" || summary.trim().length === 0) {
		violations.push("summary 缺失或为空");
	} else if (Array.from(summary).length > SUMMARY_MAX_CODEPOINTS) {
		violations.push(`summary 超过 ${SUMMARY_MAX_CODEPOINTS} 字（实测 ${Array.from(summary).length}）`);
	}
	const issues = report?.issues;
	if (!Array.isArray(issues)) {
		violations.push("issues 不是数组");
		return violations;
	}
	const headingLines = extractHeadingLines(targetText);
	issues.forEach((issue, index) => {
		const location = typeof issue?.location === "string" ? issue.location : "";
		if (location.trim().length === 0) {
			violations.push(`issues[${index}].location 为空`);
			return;
		}
		const quoteHit = locationMatchesQuote(location, targetText);
		const headingHit = locationMatchesHeading(location, headingLines);
		if (!quoteHit && !headingHit) {
			violations.push(`issues[${index}].location 双分支均未命中：${JSON.stringify(location.slice(0, 40))}`);
		}
	});
	return violations;
}

/** 结构类失败：无需重灌目标文档全文，只需按违规明细修格式。 */
const FORMAT_ONLY_STOP_REASONS = Object.freeze(["completed", "max-tokens", "invalid"]);

/**
 * 判断本次重试是否必须回看目标文档原文。
 * @param {{stopReason?: string, violations?: string[]} | null} lastFailure 上次失败信息。
 * @returns {boolean} 需要重灌输入包时为 true。
 */
function needsFullInputOnRetry(lastFailure) {
	const stopReason = lastFailure?.stopReason;
	if (!FORMAT_ONLY_STOP_REASONS.includes(stopReason)) return true;
	return (lastFailure?.violations ?? []).some((violation) => LOCATION_VIOLATION_PATTERN.test(violation));
}

/**
 * 把真实校验违规渲染为重试提示（前 5 条 + 总数，提示同类错误须修正全部 issues）。
 * @param {readonly string[] | undefined} violations 违规明细。
 * @returns {string | null} 无可展示违规时 null。
 */
function renderViolationHint(violations) {
	if (!Array.isArray(violations) || violations.length === 0) return null;
	return `上次校验失败原因（共 ${violations.length} 条，同类错误须修正全部 issues）：` +
		violations.slice(0, 5).join("；");
}

/**
 * 拼接子会话 prompt 文本。
 *
 * 首次尝试：输入包全文 + 输出指令。
 * 重试：默认只发「修格式」指令 + 上一版输出 + 违规原因，**不再重灌输入包全文**
 *   —— 重灌全文会把模型的注意力从「修 JSON」拉回「重新审查整篇文档」，
 *   实测表现为连续重试仍产不出合规 JSON（见 doc_review 子会话取证）。
 *   仅当违规涉及 location 引句（必须对照原文）或上次非正常结束时，才回退到重灌全文。
 * @param {string} inputText T04 输入包全文。
 * @param {{stopReason?: string, violations?: string[], freeformText?: string} | null} lastFailure 上次失败信息。
 * @returns {string} 完整 prompt。
 */
export function buildAttemptPrompt(inputText, lastFailure) {
	if (!lastFailure) return [inputText, "", BASE_OUTPUT_INSTRUCTION].join("\n");
	const violationHint = renderViolationHint(lastFailure.violations);
	if (needsFullInputOnRetry(lastFailure)) {
		const parts = [inputText, "", BASE_OUTPUT_INSTRUCTION, "", RETRY_INSTRUCTION_INVALID];
		if (lastFailure.stopReason === "max-tokens") parts.push(RETRY_INSTRUCTION_MAX_TOKENS);
		if (violationHint !== null) parts.push(violationHint);
		return parts.join("\n");
	}
	const parts = [CORRECTION_TASK_HEADER, "", CORRECTION_PRIOR_OUTPUT_HEADER];
	const priorOutput = (lastFailure.priorPayload ?? lastFailure.freeformText ?? "").trim();
	parts.push(priorOutput.length > 0 ? priorOutput : "（上一版无可用输出，请重新给出结论）");
	parts.push("", BASE_OUTPUT_INSTRUCTION, "", RETRY_INSTRUCTION_INVALID);
	if (lastFailure.stopReason === "max-tokens") parts.push(RETRY_INSTRUCTION_MAX_TOKENS);
	if (violationHint !== null) parts.push(violationHint);
	return parts.join("\n");
}

/**
 * 提取 result.output 中的自由文本（降级路径①语料；v0.3.0 起主要供 session-reviewer
 * 的历史事件文本收集复用，语义不变）。
 * @param {readonly {type: string, text?: string}[]} output 消息块数组。
 * @returns {string} text 块拼接结果。
 */
export function extractFreeformText(output) {
	return (output ?? [])
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

/**
 * 从一段文本中切出第一个完整 JSON 对象（裸 JSON 或 ```json 围栏内）。
 * 用于兜底：能力较弱的模型常把合规 JSON 直接吐在正文里而不调用
 * structured_output 工具，此时内核不产出 structured，但内容本身可用。
 * @param {string} raw 原始文本。
 * @returns {string | null} 切出的 JSON 片段；无完整对象时 null。
 */
export function extractJsonObject(raw) {
	const text = (raw ?? "").trim();
	if (text.length === 0) return null;
	const scanText = text.length > FREEFORM_SCAN_MAX_CHARS ? text.slice(0, FREEFORM_SCAN_MAX_CHARS) : text;
	const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(scanText);
	const candidate = (fenced ? fenced[1] : scanText).trim();
	const start = candidate.indexOf("{");
	if (start < 0) return null;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = start; index < candidate.length; index += 1) {
		const char = candidate[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (char === '"') {
			inString = !inString;
			continue;
		}
		if (inString) continue;
		if (char === "{") depth += 1;
		else if (char === "}") {
			depth -= 1;
			if (depth === 0) return candidate.slice(start, index + 1);
		}
	}
	return null;
}

/**
 * 诊断一段自由文本输出：是否切出完整 JSON 对象、是否合规、具体违规明细。
 * 供 session-reviewer 的失败归因与重试提示使用（不再把真实违规吞成 null）。
 * @param {string} freeformText 审查员文本结论（assistant 消息拼接或降级语料）。
 * @param {object} context 校验上下文（deps/targetText）。
 * @returns {{report: object|null, payloadText: string|null,
 *   hasCompleteJsonObject: boolean, violations: string[]}} 诊断结果。
 */
export function inspectFreeformReport(freeformText, { deps, params }) {
	const payloadText = extractJsonObject(freeformText);
	if (payloadText === null) {
		return { report: null, payloadText: null, hasCompleteJsonObject: false, violations: [] };
	}
	let candidate;
	try {
		candidate = JSON.parse(payloadText);
	} catch {
		return { report: null, payloadText, hasCompleteJsonObject: true, violations: ["JSON 语法错误"] };
	}
	if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
		return { report: null, payloadText, hasCompleteJsonObject: true, violations: ["JSON 根节点不是对象"] };
	}
	const violations = [
		...validateReport(candidate, deps.validateJsonSchemaValue),
		...validateReportBusinessRules(candidate, params.targetText)
	];
	if (violations.length > 0) {
		return { report: null, payloadText, hasCompleteJsonObject: true, violations };
	}
	return { report: candidate, payloadText, hasCompleteJsonObject: true, violations: [] };
}

/**
 * 尝试把子会话的自由文本解析为合规报告（text 块 JSON 兜底）。
 * 解析结果必须同时通过 T02a Schema 与业务规则校验才认。
 * 需要违规明细的调用方改用 inspectFreeformReport。
 * @param {string} freeformText 审查员文本结论（assistant 消息拼接或降级语料）。
 * @param {object} context 校验上下文（deps/targetText）。
 * @returns {{report: object, payloadText: string} | null} 通过则为报告，否则 null。
 */
export function parseFreeformReport(freeformText, context) {
	const { report, payloadText } = inspectFreeformReport(freeformText, context);
	return report === null ? null : { report, payloadText };
}
