/**
 * test/reviewer-contract.test.mjs —— 「子会话格式化输出反复失效」事故回归。
 *
 * 事故根因（2026-11-05 取证）：BASE_OUTPUT_INSTRUCTION 要求 title/description 等
 * 6 字段，DOC_REVIEW_REPORT_SCHEMA 要求 id/dimension/claim 等 7 字段且
 * additionalProperties:false；失败原因又被吞成 null，随后以 endsWith("}") 把
 * 「前言 + ```json 围栏」误判为 max-tokens 截断，重试只发「压缩 issues 数量」，
 * 模型三次都修错方向，最终降级 freeform-parse。
 *
 * 运行：node --test test/reviewer-contract.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import {
	BASE_OUTPUT_INSTRUCTION,
	buildAttemptPrompt,
	describeRetryRecord,
	inspectFreeformReport,
	parseFreeformReport
} from "../lib/reviewer.js";
import {
	DOC_REVIEW_REPORT_SCHEMA,
	ISSUE_FIELDS,
	REPORT_FIELDS
} from "../lib/schema.js";
import { judgeFreeformOutcome } from "../lib/session-reviewer.js";

/** 目标文档语料：location 引句须在原文逐字命中（标题行分支）。 */
const TARGET_TEXT = "# 部署手册\n\n## 部署步骤\n\n执行 dsh web --port 3080 启动服务。\n";
const LOCATION = "## 部署步骤";

/** 按 T02a Schema 构造的合规报告（7 字段）。 */
function makeValidReport() {
	return {
		summary: "文档存在一处事实错误。",
		issues: [{
			id: "GE-F-01",
			dimension: "fact",
			severity: "high",
			location: LOCATION,
			claim: "端口与规范冲突",
			evidence: "no-reference",
			suggestion: "改为 3099"
		}],
		newIssueCount: 1,
		round: 0,
		chainId: ""
	};
}

/** 事故现场的旧版输出：issues 每条 6 字段（title/description）。 */
function makeLegacyReport() {
	return {
		summary: "文档存在一处事实错误。",
		issues: [{
			title: "端口与规范冲突",
			severity: "high",
			location: LOCATION,
			description: "端口写错",
			evidence: "no-reference",
			suggestion: "改为 3099"
		}],
		newIssueCount: 1,
		round: 0,
		chainId: ""
	};
}

/** 审查员实际输出形态：自然语言前言 + ```json 围栏（以 ``` 结尾，非 }）。 */
function fenced(report) {
	return `已完成审查，完整报告如下：\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\``;
}

/** inspectFreeformReport / judgeFreeformOutcome 共用的校验上下文。 */
function makeContext() {
	return {
		deps: { validateJsonSchemaValue },
		params: { targetText: TARGET_TEXT },
		attempts: 1,
		timedOut: false
	};
}

test("输出指令字段清单与 T02a Schema 同源（顶层 5 / issues 每条 7）", () => {
	assert.deepEqual(DOC_REVIEW_REPORT_SCHEMA.required, [...REPORT_FIELDS]);
	assert.deepEqual(
		Object.keys(DOC_REVIEW_REPORT_SCHEMA.properties.issues.items.properties),
		[...ISSUE_FIELDS]
	);
	for (const field of [...REPORT_FIELDS, ...ISSUE_FIELDS]) {
		assert.ok(BASE_OUTPUT_INSTRUCTION.includes(field), `输出指令缺少字段 ${field}`);
	}
	assert.doesNotMatch(BASE_OUTPUT_INSTRUCTION, /title（字符串）|description（字符串）/);
	assert.match(BASE_OUTPUT_INSTRUCTION, /顶层 5 个字段/);
	assert.match(BASE_OUTPUT_INSTRUCTION, /issues 每条 7 个字段/);
	assert.match(BASE_OUTPUT_INSTRUCTION, /```json/);
});

test("按指令输出的 7 字段围栏报告可被回收（前言 + 围栏合法）", () => {
	const text = fenced(makeValidReport());
	const salvaged = parseFreeformReport(text, makeContext());
	assert.notEqual(salvaged, null);
	assert.equal(salvaged.report.issues.length, 1);
	assert.equal(judgeFreeformOutcome(text, makeContext()).kind, "report");
});

test("6 字段旧格式：诊断出真实字段违规，且不再误判为截断", () => {
	const text = fenced(makeLegacyReport());
	assert.equal(parseFreeformReport(text, makeContext()), null, "兜底解析行为保持不兼容即拒收");
	const diagnosis = inspectFreeformReport(text, makeContext());
	assert.equal(diagnosis.hasCompleteJsonObject, true);
	assert.equal(diagnosis.report, null);
	assert.ok(diagnosis.violations.some((v) => v.includes("issues[0].id")));
	assert.ok(diagnosis.violations.some((v) => v.includes("issues[0].dimension")));
	assert.ok(diagnosis.violations.some((v) => v.includes("issues[0].claim")));
	assert.ok(diagnosis.violations.some((v) => v.includes("additionalProperties")));

	const verdict = judgeFreeformOutcome(text, makeContext());
	assert.equal(verdict.kind, "retry");
	assert.equal(verdict.failure.stopReason, "invalid", "完整围栏 JSON 不得判 max-tokens");
	assert.ok(verdict.failure.violations.some((v) => v.includes("issues[0].id")));
	assert.equal(verdict.failure.violations.includes("输出被截断，未闭合 JSON"), false);
	assert.match(describeRetryRecord(1, verdict.failure, true).reason, /字段\/业务校验未通过/);
});

test("重试提示带真实违规、走「只修格式」路径，不再发压缩指令", () => {
	const verdict = judgeFreeformOutcome(fenced(makeLegacyReport()), makeContext());
	const prompt = buildAttemptPrompt("【目标文档】绝不应重灌", verdict.failure);
	assert.doesNotMatch(prompt, /【目标文档】绝不应重灌/);
	assert.match(prompt, /只修格式/);
	assert.match(prompt, /issues 每条 7 个字段/);
	assert.match(prompt, /missing required property/);
	assert.match(prompt, /共 \d+ 条/);
	assert.match(prompt, /上一版输出/);
	assert.doesNotMatch(prompt, /压缩 issues 数量/);
	assert.doesNotMatch(prompt, /输出被截断/);
});

test("真被截断的输出仍判 max-tokens 并保留压缩指令", () => {
	const truncated = '{"summary":"审查结论","issues":[{"id":"GE-F-01"';
	const verdict = judgeFreeformOutcome(truncated, makeContext());
	assert.equal(verdict.kind, "retry");
	assert.equal(verdict.failure.stopReason, "max-tokens");
	assert.ok(verdict.failure.violations.some((v) => v.includes("输出被截断")));
	assert.match(buildAttemptPrompt("【目标文档】", verdict.failure), /压缩 issues 数量/);
});

test("location 引句类违规仍回退重灌输入包全文", () => {
	const failure = {
		stopReason: "invalid",
		violations: ['issues[0].location 双分支均未命中："不存在的引句"'],
		freeformText: "上一版输出"
	};
	assert.match(buildAttemptPrompt("【目标文档】需回看原文", failure), /【目标文档】需回看原文/);
});
