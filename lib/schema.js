/**
 * lib/schema.js —— T02 双 Schema（dsh-doc-review）。
 *
 * 两套 Schema 形态本质不同、不得合并（任务书 T02）：
 * - DOC_REVIEW_REPORT_SCHEMA（T02a）：raw JSON Schema（ObjectJsonSchema 受限子集），
 *   供 SubagentStartRequest.outputSchema 约束子会话 structured 输出，
 *   也用于回收后的二次校验（validateJsonSchemaValue）。
 * - TOOL_OUTPUT_SPEC（T02b）：dsh-tools ValueSchemaSpec 作者 DSL，
 *   供 defineTool 的 output.schema 声明工具返回值形态。
 *
 * 受限子集仅 type/properties/required/additionalProperties/items/enum/const/oneOf
 * （json-schema.d.ts:24-53），description 为注解字段。
 * 本文件为纯声明模块：不 import 内核包，单测可零依赖运行。
 */

/** issue.dimension 闭合枚举（任务书 T02a）。 */
export const ISSUE_DIMENSIONS = Object.freeze(["fact", "completeness", "necessity", "format"]);

/** issue.severity 闭合枚举（任务书 T02a）。 */
export const ISSUE_SEVERITIES = Object.freeze(["high", "medium", "low"]);

/** T02b degraded 可选枚举（任务书 T02b）。 */
export const DEGRADED_REASONS = Object.freeze([
	"freeform-parse",
	"same-session",
	"timeout",
	"aborted",
	"busy"
]);

/** issue 七字段名（顺序即模板顺序）。 */
export const ISSUE_FIELDS = Object.freeze([
	"id",
	"dimension",
	"severity",
	"location",
	"claim",
	"evidence",
	"suggestion"
]);

/**
 * T02a 审查报告 Schema（raw JSON Schema，对象根）。
 * 字段：summary:string(≤200字,代码侧校验)、issues:array[{id,dimension,severity,
 * location(≥1字符,必填),claim,evidence(无参考填"no-reference"),suggestion}]、
 * newIssueCount:integer(以插件复算为准)、round:integer、chainId:string(插件回收后覆盖)。
 */
export const DOC_REVIEW_REPORT_SCHEMA = Object.freeze({
	type: "object",
	properties: {
		summary: { type: "string", description: "总体结论摘要，不超过200字" },
		issues: {
			type: "array",
			description: "问题清单；每条 issue 的 location 必填且至少1个字符",
			items: {
				type: "object",
				properties: {
					id: { type: "string", description: "稳定ID：<doc_type缩写>-<维度缩写>-<序号>，如 TS-F-03" },
					dimension: { type: "string", enum: [...ISSUE_DIMENSIONS] },
					severity: { type: "string", enum: [...ISSUE_SEVERITIES] },
					location: { type: "string", description: "原文引句(≥8连续字符)或 markdown 标题行" },
					claim: { type: "string", description: "问题陈述" },
					evidence: { type: "string", description: "证据；无参考资料时填 no-reference" },
					suggestion: { type: "string", description: "修改建议" }
				},
				required: [...ISSUE_FIELDS],
				additionalProperties: false
			}
		},
		newIssueCount: { type: "integer", description: "本轮新增问题数；以插件复算为准" },
		round: { type: "integer", description: "当前轮次，从1开始" },
		chainId: { type: "string", description: "审查链ID；插件回收后覆盖" }
	},
	required: ["summary", "issues", "newIssueCount", "round", "chainId"],
	additionalProperties: false
});

/**
 * T02b 工具结果 Schema（ValueSchemaSpec DSL，供 defineTool output.schema）。
 * DSL 无 min/max/minLength 节点（schema.d.ts 实测），数值边界在 execute 内校验；
 * optional 字段以 description 注明，additionalProperties 为 DSL 必填键。
 */
export const TOOL_OUTPUT_SPEC = Object.freeze({
	type: "object",
	properties: {
		report: {
			type: "object",
			description: "审查报告（结构同 T02a）",
			properties: {
				summary: { type: "string", required: true },
				issues: {
					type: "array",
					required: true,
					items: {
						type: "object",
						properties: {
							id: { type: "string", required: true },
							dimension: { type: "string", enum: [...ISSUE_DIMENSIONS], required: true },
							severity: { type: "string", enum: [...ISSUE_SEVERITIES], required: true },
							location: { type: "string", required: true },
							claim: { type: "string", required: true },
							evidence: { type: "string", required: true },
							suggestion: { type: "string", required: true }
						},
						additionalProperties: false
					}
				},
				newIssueCount: { type: "integer", required: true },
				round: { type: "integer", required: true },
				chainId: { type: "string", required: true }
			},
			additionalProperties: false
		},
		adjudication_template: { type: "string", description: "裁决表模板：每个 issue id 恰出现一次（成本拦截分支缺省）" },
		next_action: { type: "string", description: "主 Agent 下一步行动指引", required: true },
		degraded: { type: "string", enum: [...DEGRADED_REASONS], description: "可选：降级原因" },
		skillMissing: { type: "boolean", description: "可选：SKILL 文件缺失" },
		heuristicClean: { type: "boolean", description: "可选：纯文本导出启发式清洗已执行" },
		changeRatio: { type: "number", description: "可选（多轮）：T08 变更比例百分数，四舍五入 0.1" },
		converged: { type: "boolean", description: "可选（多轮）：T08 收敛判定结果" },
		convergenceReason: {
			type: "string",
			description: "可选（多轮）：收敛原因 change-ratio-below-threshold/no-high-severity-and-no-new-issues/max-rounds-reached，未收敛时缺省"
		},
		resolvedIssueCount: { type: "integer", description: "可选（多轮）：T08 插件复算的已解决 issue 数" },
		confirmationRequired: { type: "boolean", description: "可选：T10 成本预估超阈值，需人工确认（为 true 时不派子会话、无 report）" },
		costEstimate: {
			type: "object",
			description: "可选：T10 成本预估明细（每次调用均回传，便于主 Agent 追踪）",
			properties: {
				singleRoundTokens: { type: "number", required: true },
				worstCaseTokens: { type: "number", required: true },
				inputPackageChars: { type: "integer", required: true },
				mode: { type: "string", required: true },
				chainCumulativeTokens: { type: "number", description: "可选：含本轮投影后的链累计最坏口径 token" },
				chainBudgetTokens: { type: "number", description: "可选：链预算 20000×maxRounds" },
				thresholdTokens: { type: "number", description: "可选：单轮确认阈值 20000" },
				maxRounds: { type: "integer", description: "可选：链上限轮次" },
				chainConfirmed: { type: "boolean", description: "可选：该链是否已获链级确认" },
				reason: { type: "string", description: "可选：拦截原因 worst-case-over-threshold/chain-cumulative-over-budget" }
			},
			additionalProperties: false
		},
		round: { type: "integer", required: true },
		chainId: { type: "string", required: true },
		archivePath: { type: "string", description: "可选：归档目录绝对路径" }
	},
	additionalProperties: false
});

/**
 * 校验一份审查报告是否符合 T02a Schema。
 * @param {unknown} report 待校验值。
 * @param {(schema: object, value: unknown, path?: string) => string[]} validateJsonSchemaValue
 *   dsh-tools 导出的校验函数（依赖注入以便单测替身）。
 * @returns {string[]} 违规信息列表；空数组表示合法。
 */
export function validateReport(report, validateJsonSchemaValue) {
	return validateJsonSchemaValue(DOC_REVIEW_REPORT_SCHEMA, report);
}
