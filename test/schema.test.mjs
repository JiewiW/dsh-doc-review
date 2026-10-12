/**
 * test/schema.test.mjs —— T02 双 Schema 单测（A02 验收信号）。
 *
 * 覆盖：
 * - T02a：3 组合法 / 2 组非法样例（缺 id、location 空串、dimension 越界）100% 拦截；
 * - T02b：3 组合法 / 2 组非法样例（缺 chainId、degraded 越界枚举）100% 拦截；
 * - location 双分支正反用例（经 reviewer.validateReportBusinessRules 的口径依赖，
 *   此处仅测 Schema 层；双分支正反用例在 context-builder.test.mjs 的 location 段补齐）；
 * - 两套 Schema 用内核真实校验器 validateJsonSchemaValue（依赖注入路径与
 *   reviewer.js 一致）。
 *
 * 运行：node --test test/schema.test.mjs（零外部依赖，直接 import 内核包）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import {
	DOC_REVIEW_REPORT_SCHEMA,
	TOOL_OUTPUT_SPEC,
	validateReport
} from "../lib/schema.js";
import { valueSchemaSpecToJsonSchema } from "@deepseek-ai/dsh-tools";

/** 构造一条合法 issue（可覆盖字段）。 */
function makeIssue(overrides = {}) {
	return {
		id: "GE-F-01",
		dimension: "fact",
		severity: "high",
		location: "## 部署步骤",
		claim: "端口号与参考资料冲突",
		evidence: "no-reference",
		suggestion: "改为 3099",
		...overrides
	};
}

/** 构造一份合法 T02a 报告。 */
function makeReport(overrides = {}) {
	return {
		summary: "文档存在 1 处高危事实错误。",
		issues: [makeIssue()],
		newIssueCount: 1,
		round: 1,
		chainId: "docr-test",
		...overrides
	};
}

/** T02b 顶层合法值构造器。 */
function makeToolResult(overrides = {}) {
	return {
		report: makeReport(),
		adjudication_template: "| id | decision |\n|----|----|\n| GE-F-01 |  |",
		next_action: "按裁决表修改文档。",
		round: 1,
		chainId: "docr-test",
		...overrides
	};
}

// ---------- T02a：3 组合法 ----------

test("T02a 合法样例1：单 issue 完整报告", () => {
	assert.deepEqual(validateReport(makeReport(), validateJsonSchemaValue), []);
});

test("T02a 合法样例2：空 issues + 全枚举值轮换", () => {
	const report = makeReport({
		summary: "未发现问题。",
		issues: [],
		newIssueCount: 0
	});
	assert.deepEqual(validateReport(report, validateJsonSchemaValue), []);
	for (const dimension of ["fact", "completeness", "necessity", "format"]) {
		for (const severity of ["high", "medium", "low"]) {
			const variant = makeReport({ issues: [makeIssue({ dimension, severity })] });
			assert.deepEqual(validateReport(variant, validateJsonSchemaValue), [], `${dimension}/${severity}`);
		}
	}
});

test("T02a 合法样例3：多 issues + 长 summary（恰 200 码点由业务层管）", () => {
	const report = makeReport({
		issues: [makeIssue({ id: "GE-F-01" }), makeIssue({ id: "GE-C-01", dimension: "completeness" })],
		newIssueCount: 2
	});
	assert.deepEqual(validateReport(report, validateJsonSchemaValue), []);
});

// ---------- T02a：2 组非法（任务书 A02 点名的三类全覆盖） ----------

test("T02a 非法样例1：issue 缺 id / location 空串 → 100% 拦截", () => {
	const missingId = makeReport({ issues: [makeIssue()] });
	delete missingId.issues[0].id;
	assert.ok(validateReport(missingId, validateJsonSchemaValue).length > 0, "缺 id 必须拦截");
	const emptyLocation = makeReport({ issues: [makeIssue({ location: "" })] });
	// location 空串在 raw Schema 层是合法 string —— 拦截责任在业务校验层（A02 双分支），
	// 此处断言 Schema 层放行、业务层拦截的分工（业务层用例见 context-builder.test.mjs）。
	assert.deepEqual(validateReport(emptyLocation, validateJsonSchemaValue), []);
	const badDimension = makeReport({ issues: [makeIssue({ dimension: "style" })] });
	assert.ok(validateReport(badDimension, validateJsonSchemaValue).length > 0, "dimension 越界必须拦截");
});

test("T02a 非法样例2：缺 summary / additionalProperties 违规 / newIssueCount 非整数", () => {
	const noSummary = makeReport();
	delete noSummary.summary;
	assert.ok(validateReport(noSummary, validateJsonSchemaValue).length > 0);
	const extraKey = makeReport({ unexpected: 1 });
	assert.ok(validateReport(extraKey, validateJsonSchemaValue).length > 0);
	const floatCount = makeReport({ newIssueCount: 1.5 });
	assert.ok(validateReport(floatCount, validateJsonSchemaValue).length > 0);
});

// ---------- T02b：3 组合法 ----------

/** T02b 用编译后的 raw JSON Schema 校验（与内核 defineTool 出口一致）。 */
const compiledToolSchema = valueSchemaSpecToJsonSchema(TOOL_OUTPUT_SPEC);

test("T02b 合法样例1：最小必填集（report/模板/next_action/round/chainId）", () => {
	assert.deepEqual(validateJsonSchemaValue(compiledToolSchema, makeToolResult()), []);
});

test("T02b 合法样例2：全部可选字段齐上", () => {
	const full = makeToolResult({
		degraded: "freeform-parse",
		skillMissing: true,
		heuristicClean: true,
		changeRatio: 0.025,
		converged: false,
		confirmationRequired: true,
		archivePath: ".doc-review/docr-test/round-1"
	});
	assert.deepEqual(validateJsonSchemaValue(compiledToolSchema, full), []);
});

test("T02b 合法样例3：degraded 五枚举逐一通过", () => {
	for (const degraded of ["freeform-parse", "same-session", "timeout", "aborted", "busy"]) {
		assert.deepEqual(
			validateJsonSchemaValue(compiledToolSchema, makeToolResult({ degraded })),
			[],
			degraded
		);
	}
});

// ---------- T02b：2 组非法 ----------

test("T02b 非法样例1：缺 chainId → 拦截", () => {
	const noChain = makeToolResult();
	delete noChain.chainId;
	assert.ok(validateJsonSchemaValue(compiledToolSchema, noChain).length > 0);
	const noRound = makeToolResult();
	delete noRound.round;
	assert.ok(validateJsonSchemaValue(compiledToolSchema, noRound).length > 0);
});

test("T02b 合法样例4（M4 T10）：成本拦截分支无 report/模板，仅 confirmationRequired+costEstimate", () => {
	// report 自 M4 起改为可选：唯一无 report 的分支是 T10 成本拦截（execute 逻辑保证
	// 无 report 时 confirmationRequired 必为 true，该联动在 tool.test.mjs A10 用例覆盖）。
	const blocked = makeToolResult({
		confirmationRequired: true,
		costEstimate: {
			singleRoundTokens: 11600,
			worstCaseTokens: 34800,
			inputPackageChars: 12000,
			mode: "full",
			reason: "worst-case-over-threshold"
		}
	});
	delete blocked.report;
	delete blocked.adjudication_template;
	assert.deepEqual(validateJsonSchemaValue(compiledToolSchema, blocked), []);
});

test("T02b 非法样例2：degraded 越界枚举 / report 内 issue 缺字段 / 多余顶层键", () => {
	assert.ok(validateJsonSchemaValue(compiledToolSchema, makeToolResult({ degraded: "crashed" })).length > 0);
	const badIssueReport = makeReport({ issues: [makeIssue()] });
	delete badIssueReport.issues[0].severity;
	assert.ok(validateJsonSchemaValue(compiledToolSchema, makeToolResult({ report: badIssueReport })).length > 0);
	assert.ok(validateJsonSchemaValue(compiledToolSchema, makeToolResult({ extraTop: 1 })).length > 0);
});

// ---------- 双 Schema 不得合并（形态断言） ----------

test("T02a/T02b 形态不同：raw Schema 无 required:true 属性级标注，DSL 有", () => {
	// T02a 是 raw JSON Schema：required 为字符串数组
	assert.ok(Array.isArray(DOC_REVIEW_REPORT_SCHEMA.required));
	// T02b 是 ValueSchemaSpec DSL：属性节点带 required:true 标注
	assert.equal(TOOL_OUTPUT_SPEC.properties.chainId.required, true);
	// 编译产物互不兼容：T02a 顶层键集合 ≠ T02b 编译后顶层键集合
	const compiledKeys = Object.keys(compiledToolSchema.properties).sort();
	const reportKeys = Object.keys(DOC_REVIEW_REPORT_SCHEMA.properties).sort();
	assert.notDeepEqual(compiledKeys, reportKeys);
});
