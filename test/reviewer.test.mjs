/**
 * test/reviewer.test.mjs —— 子会话弱模型容错单测。
 *
 * 覆盖两条改造（针对「JSON 吐在正文里被判失败」+「重试重灌全文」的实测失败）：
 * - parseFreeformReport：正文含合规 JSON 时兜底回收；正文非法时不回收。
 * - buildAttemptPrompt：重试默认不再重灌输入包全文；location 引句类违规才回退重灌。
 * - runReviewerSession：structured 缺失但正文合规时，一次尝试即出 report，不重试。
 *
 * 运行：node --test test/reviewer.test.mjs（依赖内核真实校验器 dsh-tools）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import {
	parseFreeformReport,
	extractJsonObject,
	buildAttemptPrompt,
	runReviewerSession,
	BASE_OUTPUT_INSTRUCTION
} from "../lib/reviewer.js";

/** 目标文档语料：含一个标题行，供 location 双分支判定命中。 */
const TARGET_TEXT = "# 部署手册\n\n## 部署步骤\n\n执行 dsh web --port 3080 启动服务。\n";

/** 构造一份通过 T02a + location 校验的报告对象。 */
function makeReport(overrides = {}) {
	return {
		summary: "文档存在一处事实错误。",
		issues: [
			{
				id: "GE-F-01",
				dimension: "fact",
				severity: "high",
				location: "## 部署步骤",
				claim: "端口与规范冲突",
				evidence: "no-reference",
				suggestion: "改为 3099"
			}
		],
		newIssueCount: 1,
		round: 0,
		chainId: "",
		...overrides
	};
}

/** 构造 parseFreeformReport 的校验上下文。 */
function makeContext() {
	return {
		deps: { validateJsonSchemaValue },
		params: { targetText: TARGET_TEXT }
	};
}

test("extractJsonObject：裸 JSON 与围栏 JSON 均可切出", () => {
	const bare = extractJsonObject("前置说明\n" + JSON.stringify(makeReport()) + "\n后置说明");
	assert.ok(bare.startsWith("{"));
	assert.equal(JSON.parse(bare).summary, "文档存在一处事实错误。");
	const fenced = extractJsonObject("```json\n" + JSON.stringify(makeReport()) + "\n```");
	assert.equal(JSON.parse(fenced).issues.length, 1);
});

test("extractJsonObject：无 JSON 对象时返回 null", () => {
	assert.equal(extractJsonObject(""), null);
	assert.equal(extractJsonObject("这里没有任何 JSON。"), null);
	assert.equal(extractJsonObject("{ 缺少收尾括号"), null);
});

test("parseFreeformReport：正文含合规 JSON 时兜底回收", () => {
	const text = "我的审查结果如下：\n" + JSON.stringify(makeReport()) + "\n以上。";
	const salvaged = parseFreeformReport(text, makeContext());
	assert.notEqual(salvaged, null);
	assert.equal(salvaged.report.issues.length, 1);
});

test("parseFreeformReport：正文 JSON 不合规时不回收（缺顶层字段/引句未命中）", () => {
	const missingTop = JSON.stringify({ summary: "x", issues: [] });
	assert.equal(parseFreeformReport(missingTop, makeContext()), null);
	const badLocation = JSON.stringify(makeReport({ issues: [makeReport().issues[0]] }));
	const withBadLocation = JSON.parse(badLocation);
	withBadLocation.issues[0].location = "文档中根本不存在的引句";
	assert.equal(parseFreeformReport(JSON.stringify(withBadLocation), makeContext()), null);
});

test("parseFreeformReport：非对象 JSON（数组/null）不回收", () => {
	assert.equal(parseFreeformReport("[1,2,3]", makeContext()), null);
	assert.equal(parseFreeformReport("null", makeContext()), null);
});

test("BASE_OUTPUT_INSTRUCTION 要求调用 structured_output 工具而非输出纯文本", () => {
	assert.match(BASE_OUTPUT_INSTRUCTION, /structured_output/);
	assert.match(BASE_OUTPUT_INSTRUCTION, /工具调用/);
});

test("buildAttemptPrompt：首次尝试包含输入包全文", () => {
	const prompt = buildAttemptPrompt("【目标文档】全文内容", null);
	assert.match(prompt, /【目标文档】全文内容/);
	assert.match(prompt, /structured_output/);
});

test("buildAttemptPrompt：普通违规重试不再重灌输入包全文", () => {
	const failure = {
		stopReason: "completed",
		violations: ["issues[0].claim 类型错误"],
		priorPayload: JSON.stringify(makeReport())
	};
	const prompt = buildAttemptPrompt("【目标文档】全文内容不应出现", failure);
	assert.doesNotMatch(prompt, /【目标文档】全文内容不应出现/);
	assert.match(prompt, /只修格式/);
	assert.match(prompt, /上一版输出/);
	assert.match(prompt, /structured_output/);
});

test("buildAttemptPrompt：location 引句类违规回退重灌输入包", () => {
	const failure = {
		stopReason: "completed",
		violations: ["issues[0].location 双分支均未命中"],
		priorPayload: JSON.stringify(makeReport())
	};
	const prompt = buildAttemptPrompt("【目标文档】需要回看原文", failure);
	assert.match(prompt, /【目标文档】需要回看原文/);
});

test("buildAttemptPrompt：stopReason=error 回退重灌输入包", () => {
	const failure = { stopReason: "error", violations: [], priorPayload: "" };
	const prompt = buildAttemptPrompt("【目标文档】异常结束需重来", failure);
	assert.match(prompt, /【目标文档】异常结束需重来/);
});

/** 构造一个最小 subagents.start 替身：按脚本依次返回给定结果。 */
function makeFakeSubagents(script) {
	const calls = [];
	let index = 0;
	return {
		calls,
		start: async (_provider, request) => {
			const entry = script[Math.min(index, script.length - 1)];
			index += 1;
			calls.push(request.prompt[0].text);
			if (entry.throws) throw new Error(entry.throws);
			return {
				id: `run-${index}`,
				result: Promise.resolve(entry.result),
				dispose: async () => {}
			};
		}
	};
}

test("runReviewerSession：正文合规 JSON 一次即成功，不发起重试", async () => {
	const subagents = makeFakeSubagents([
		{
			result: {
				stopReason: "completed",
				output: [{ type: "text", text: JSON.stringify(makeReport()) }]
			}
		}
	]);
	const outcome = await runReviewerSession(
		{ subagents, validateJsonSchemaValue },
		{
			inputText: "【目标文档】全文",
			targetText: TARGET_TEXT,
			timeoutMs: 5_000
		}
	);
	assert.equal(outcome.kind, "report");
	assert.equal(outcome.attempts, 1);
	assert.equal(outcome.retries.length, 0);
	assert.equal(subagents.calls.length, 1);
});

test("runReviewerSession：第二次尝试不再携带输入包全文", async () => {
	const brokenReport = makeReport();
	delete brokenReport.chainId;
	const subagents = makeFakeSubagents([
		{
			result: {
				stopReason: "completed",
				structured: brokenReport,
				output: [{ type: "text", text: JSON.stringify(brokenReport) }]
			}
		},
		{
			result: {
				stopReason: "completed",
				output: [{ type: "text", text: JSON.stringify(makeReport()) }]
			}
		}
	]);
	const outcome = await runReviewerSession(
		{ subagents, validateJsonSchemaValue },
		{
			inputText: "【目标文档】标记不重复",
			targetText: TARGET_TEXT,
			timeoutMs: 5_000
		}
	);
	assert.equal(outcome.kind, "report");
	assert.equal(subagents.calls.length, 2);
	assert.match(subagents.calls[0], /【目标文档】标记不重复/);
	assert.doesNotMatch(subagents.calls[1], /【目标文档】标记不重复/);
});
