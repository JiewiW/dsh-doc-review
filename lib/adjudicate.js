/**
 * lib/adjudicate.js —— T07 主 Agent 裁决与修改的引导。
 *
 * 职责（纯函数，无 IO）：
 * 1. issue 稳定 ID 修复/编号：规则 `<doc_type缩写>-<维度缩写>-<序号>`（如 TS-F-03）。
 *    已符合规则的 id（含多轮沿用）保留；缺失/不合规的 id 按维度顺序补号。
 * 2. 生成三段返回值的后两段：
 *    - adjudication_template：要求主 Agent 对每条 issue 输出
 *      {id, decision: accept|partial|reject, reason, applied_change}，
 *      reject/partial 必须给理由；每个 id 在模板中恰出现一次（A07 机检口径）。
 *    - next_action：单轮=按裁决修改并在回复中附裁决表；多轮=修改后携带本报告再次调用。
 * 3. deferContext 行动指令文本（T07 强化手段②）：只放指令不放报告全文；
 *    特征句「逐条输出裁决表」「携带 chain_id/prev_round 再次调用 doc_review」供 A07 grep。
 *
 * 边界说明（T07）：插件不校验主 Agent 当轮回复，复核发生在下一轮调用；
 * T10 confirmationRequired 分支的 concludeTurn() 调用点在 tool.js 预留（本卡不实现判定）。
 */

/** doc_type → ID 前缀缩写（任务书示例 TS=tech-spec；其余为本卡约定，REPORT 记录）。 */
export const DOC_TYPE_ID_ABBREV = Object.freeze({
	generic: "GE",
	"tech-spec": "TS",
	"product-doc": "PD"
});

/** dimension → ID 维度缩写（F=fact 出自任务书示例 TS-F-03；其余为本卡约定）。 */
export const DIMENSION_ID_ABBREV = Object.freeze({
	fact: "F",
	completeness: "C",
	necessity: "N",
	format: "FT"
});

/** ID 序号补零位数（示例 TS-F-03 为两位）。 */
const ID_SERIAL_PAD_LENGTH = 2;

/** 合法 issue ID 形态：前缀-维度-两位以上序号。 */
const ISSUE_ID_PATTERN = /^[A-Z]{2,3}-[A-Z]{1,2}-\d{2,}$/;

/** deferContext 行动指令特征句（A07 grep 信号，勿改措辞）。 */
export const DEFER_INSTRUCTION_MARKER =
	"对报告 issues 逐条输出裁决表，按裁决修改文档，修改后携带 chain_id/prev_round 再次调用 doc_review";

/**
 * 构造规范 issue ID。
 * @param {string} docType 闭合枚举 doc_type。
 * @param {string} dimension issue.dimension。
 * @param {number} serial 1 起始序号。
 * @returns {string} 形如 TS-F-03 的稳定 ID。
 */
function buildIssueId(docType, dimension, serial) {
	const docAbbrev = DOC_TYPE_ID_ABBREV[docType] ?? "GE";
	const dimensionAbbrev = DIMENSION_ID_ABBREV[dimension] ?? "X";
	return `${docAbbrev}-${dimensionAbbrev}-${String(serial).padStart(ID_SERIAL_PAD_LENGTH, "0")}`;
}

/**
 * 修复/规范化报告内全部 issue 的稳定 ID（就地生成新数组，不改入参）。
 * 已合规 id 保留（多轮沿用原 id 的前提）；不合规 id 按维度独立计数补号，
 * 计数起点=该维度现存最大序号+1，避免与保留 id 撞号。
 * @param {{issues: readonly object[]}} report 已过 T02a 校验的报告。
 * @param {string} docType 闭合枚举 doc_type。
 * @returns {object[]} 新 issues 数组（id 已规范化）。
 */
export function normalizeIssueIds(report, docType) {
	const serialCounter = new Map();
	for (const issue of report.issues) {
		if (typeof issue.id === "string" && ISSUE_ID_PATTERN.test(issue.id)) {
			const match = issue.id.match(/-(\d{2,})$/);
			const dimensionKey = issue.dimension;
			const seen = serialCounter.get(dimensionKey) ?? 0;
			serialCounter.set(dimensionKey, Math.max(seen, Number.parseInt(match[1], 10)));
		}
	}
	return report.issues.map((issue) => {
		if (typeof issue.id === "string" && ISSUE_ID_PATTERN.test(issue.id)) return { ...issue };
		const dimensionKey = issue.dimension;
		const nextSerial = (serialCounter.get(dimensionKey) ?? 0) + 1;
		serialCounter.set(dimensionKey, nextSerial);
		return { ...issue, id: buildIssueId(docType, dimensionKey, nextSerial) };
	});
}

/**
 * 生成裁决表模板（每个 issue id 恰出现一次；A07 机检口径）。
 * @param {readonly {id: string, claim: string}[]} issues 规范化后的 issues。
 * @returns {string} markdown 表格模板 + 填写要求。
 */
export function buildAdjudicationTemplate(issues) {
	const headerLines = [
		"请对下列每条 issue 填写裁决表（decision 只能取 accept/partial/reject；",
		"decision=reject 或 partial 时 reason 必填，applied_change 写实际改动摘要，未改动写 none）：",
		"",
		"| id | decision | reason | applied_change |",
		"|----|----------|--------|----------------|"
	];
	const rowLines = issues.map((issue) => `| ${issue.id} |  |  |  |`);
	if (issues.length === 0) {
		return "本轮报告无 issues，无需裁决；如需留痕可回复「无问题」裁决表。";
	}
	return [...headerLines, ...rowLines].join("\n");
}

/**
 * 生成 next_action 指引（T07 第 3 段）。
 * @param {object} params 轮次参数。
 * @param {number} params.round 当前轮次（prev_round+1）。
 * @param {number} params.maxRounds 轮次上限。
 * @param {string} params.chainId 审查链 ID（多轮回传凭据）。
 * @param {boolean} [params.converged] 多轮复算是否已收敛（仅 round>1 有意义）。
 * @param {string} [params.convergenceReason] 收敛原因。
 * @returns {string} 收敛/单轮/多轮三种模式的行动指引。
 */
export function buildNextAction({ round, maxRounds, chainId, converged = false, convergenceReason }) {
	if (converged) {
		const reasonNote =
			convergenceReason === "change-ratio-below-threshold"
				? "文档相对上一轮的变更比例已低于 3.0%"
				: convergenceReason === "no-high-severity-and-no-new-issues"
					? "本轮无 high 严重度问题且插件复算新增问题为 0"
					: convergenceReason === "max-rounds-reached"
						? "已达 max_rounds 硬上限"
						: "已满足收敛条件";
		return "审查链已收敛（" + reasonNote + "）。按裁决表逐条修改文档，修改后无需再次调用 doc_review，审查链结束。";
	}
	const isFinalRound = round >= maxRounds;
	if (isFinalRound) {
		return "按裁决表逐条修改文档，并在回复中附上完整裁决表（单轮/末轮模式：本轮为最后一轮，修改后无需再次调用 doc_review）。";
	}
	return (
		`按裁决表逐条修改文档；修改后携带本报告再次调用 doc_review（多轮模式：回传 chain_id="${chainId}"、` +
		`prev_round=${round}、prev_report=本报告、prev_adjudication=你的裁决表、prev_document=修改后文档全文）。`
	);
}

/**
 * 构造 deferContext 注入的行动指令（T07 强化手段②：只放指令不放报告全文）。
 * @returns {string} 指令文本（含 DEFER_INSTRUCTION_MARKER 特征句）。
 */
export function buildDeferredInstruction() {
	return `[doc-review 行动指令] ${DEFER_INSTRUCTION_MARKER}。裁决表模板见 doc_review 工具返回值的 adjudication_template 字段。`;
}

/**
 * T07 主入口：报告 → 三段返回值的 issues/adjudication_template/next_action。
 * @param {object} report 已过 T02a 校验的审查报告。
 * @param {object} params 上下文参数。
 * @param {string} params.docType 闭合枚举 doc_type。
 * @param {number} params.round 当前轮次（prev_round+1）。
 * @param {number} params.maxRounds 轮次上限。
 * @param {string} params.chainId 审查链 ID。
 * @param {boolean} [params.converged] 多轮复算是否已收敛。
 * @param {string} [params.convergenceReason] 收敛原因。
 * @returns {{issues: object[], adjudication_template: string, next_action: string}} 三段值。
 */
export function buildAdjudicationGuidance(report, { docType, round, maxRounds, chainId, converged, convergenceReason }) {
	const issues = normalizeIssueIds(report, docType);
	return {
		issues,
		adjudication_template: buildAdjudicationTemplate(issues),
		next_action: buildNextAction({ round, maxRounds, chainId, converged, convergenceReason })
	};
}
