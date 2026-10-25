/**
 * test/test-session-salvage.mjs —— 审查 session 结论抢救（salvage）、分片续等与 timeout 信封单测。
 *
 * 覆盖（A–H 全 8 用例）：
 *   A. wait 未 settle 且 session 停滞，但已产出合规 JSON → 返回 report 而非 timeout；
 *   B. 真无结论（inspect 判定 pending）→ 返回 timeout 且信封带 sessionId；
 *   C. inspectReviewSession 在 jobs.kill 之前被调用（salvage 优先于 kill）；
 *   D. timeout 信封 sessionId 从 session-reviewer → service → tool 全链路透传且同值；
 *   E. 正常完成路径（monitor settle）不回归，仍走 report；
 *   F. salvage 命中但 JSON 不合规 → freeform 降级，且 rePromptReviewSession 零调用（红线 4）；
 *   G. F2 分片续等：分片到点 session 仍活跃 → 续等收到结论（编码 2026-10-25 长 CoT 事故）；
 *   H. F2 边界：活跃 session 但总预算耗尽 → kill + timeout。
 *
 * 运行（仓库根目录）：node test/test-session-salvage.mjs
 * 依赖：内核真实校验器 @deepseek-ai/dsh-tools（validateJsonSchemaValue）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";

import { runReviewerSession } from "../lib/session-reviewer.js";
import { createDocReviewService } from "../lib/service.js";
import { createDocReviewTool } from "../lib/tool.js";

/** 审查 session id（gateway mock 恒定返回）。 */
const SESSION_ID = "sess-review-1";

/**
 * 目标文档语料：location 业务规则校验语料（issue.location 必须命中原文 ≥8 连续字符）。
 * 审查输入包 targetText 用同一语料（service 侧 targetContent 传原文）。
 */
const TARGET_TEXT =
	"# 示例文档\n\n这是用于会话审查救回测试的稳定原文长句，包含足够长的定位引句用于 location 校验。\n";

/** issue.location 引句（必须在 TARGET_TEXT 中精确命中）。 */
const LOCATION_QUOTE = "这是用于会话审查救回测试的稳定原文长句";

/**
 * 合法报告对象（严格匹配 DOC_REVIEW_REPORT_SCHEMA）：
 * 顶层必填 summary/issues/newIssueCount/round/chainId，additionalProperties:false；
 * issue 必填 id/dimension/severity/location/claim/evidence/suggestion，
 * severity 枚举 high|medium|low，dimension 枚举 fact|completeness|necessity|format。
 */
const VALID_REPORT = {
	summary: "模拟审查结论",
	issues: [
		{
			id: "GE-F-01",
			dimension: "fact",
			severity: "high",
			location: LOCATION_QUOTE,
			claim: "示例问题",
			evidence: "证据文本",
			suggestion: "修改建议"
		}
	],
	newIssueCount: 1,
	round: 1,
	chainId: ""
};

/** 用例 A/E 的合法报告 JSON 文本（审查员 assistant 消息内容）。 */
const VALID_REPORT_JSON = JSON.stringify(VALID_REPORT);

/**
 * 停滞 session 的 list summary（running 非 true 且 >90s 无活动 → F3 判死）。
 * 用于让 salvage 用例在第一个 wait 分片后立即走 salvage，不必耗完总预算。
 */
const STALLED_SUMMARY = { running: false, updatedAt: Date.now() - 200_000 };

/** 活跃 session 的 list summary（running===true → F3 恒活；G/H 用例用）。 */
const RUNNING_SUMMARY = { running: true };

/**
 * 构造审查 session 事件流（assistant 结论文本 + turn/end completed）。
 * @param {string} freeformText assistant/message 的 text 内容。
 * @param {number} t 事件时间戳（必须 ≥ startedAt；调用方传 promptedAt）。
 * @returns {Array<object>} 事件数组（seq 升序）。
 */
function makeEvents(freeformText, t) {
	return [
		{
			type: "assistant/message",
			seq: 1,
			time: t,
			data: { message: { content: [{ type: "text", text: freeformText }] } }
		},
		{ type: "turn/end", seq: 2, time: t, data: { kind: "completed" } }
	];
}

/**
 * 构造 gateway/jobs 全 mock（驱动 runReviewerSession 全流程）。
 * gateway 走真实 inspectReviewSession 逻辑（session/list + follow 帧 + turn/end 判定）；
 * jobs.wait 按调用次序返回可控 view（模拟 300s 分片点未 settle、稍后 settle 或正常 settle）。
 * v0.3.3：F2 分片续等后 wait 会被多次调用（每 WAIT_CHUNK_MS 一次），故 wait 脚本为序列；
 * F3 存活度判据取自 session/list summary（running/updatedAt），由 listSummary 控制。
 * @param {object} [options]
 * @param {object} [options.waitView] 单次 view（等价于长度为 1 的 waitSequence）。
 * @param {Array<object>} [options.waitSequence] 按 wait 调用次序的 view 序列（末项重复）。
 * @param {string|null} [options.readResult] jobs.read 的 result（正常完成路径用）。
 * @param {Array<object>|Function} [options.records] follow opening 帧 records；函数签名 (promptedAt)=>events。
 * @param {{running?: boolean, updatedAt?: number}} [options.listSummary] session/list summary 存活度字段
 *   （缺省 {running:false, updatedAt:Date.now()} = 近期有活动判活；传 promptedAt-200_000 模拟停滞判死）。
 * @param {number} [options.waitSleepMs] jobs.wait 的模拟等待（默认 5ms，防瞬返空转）。
 * @returns {object} {deps, log, promptedAt}。
 */
function makeHarness({
	waitView,
	waitSequence,
	readResult = null,
	records = [],
	listSummary = null,
	waitSleepMs = 5
} = {}) {
	const log = [];
	const promptedAt = Date.now();
	// 真源 JobRegistry 契约：start 同步返回字符串 jobId；read 同步；wait/get 异步。
	const waitScript = waitSequence ?? [waitView ?? { status: "running" }];
	const summaryOf = () => listSummary === null
		? { running: false, updatedAt: Date.now() }
		: { ...listSummary };
	let waitCall = 0;
	const gateway = {
		invoke: async ({ namespace, method }) => {
			log.push({ op: "invoke:" + method });
			if (namespace !== "session") throw new Error("unexpected namespace " + namespace);
			switch (method) {
				case "create": return { sessionId: SESSION_ID, promptedAt };
				case "rename": return {};
				case "prompt": return {};
				case "list": return { items: [{ sessionId: SESSION_ID, ...summaryOf() }] };
				case "page": return { records: [], hasMore: false };
				default: throw new Error("unexpected session method " + method);
			}
		},
		stream: async () => {
			log.push({ op: "stream:follow" });
			const eventRecords = typeof records === "function" ? records(promptedAt) : records;
			const snapshot = { type: "snapshot", cursor: 100, records: eventRecords, hasMore: false };
			return {
				[Symbol.asyncIterator]() {
					let first = true;
					return {
						next: async () => {
							if (first) { first = false; return { value: snapshot, done: false }; }
							return { value: undefined, done: true };
						},
						return: async () => ({ value: undefined, done: true })
					};
				}
			};
		}
	};
	const jobs = {
		start: () => { log.push({ op: "start" }); return "job-1"; },
		wait: async () => {
			log.push({ op: "wait" });
			waitCall += 1;
			if (waitSleepMs > 0) await new Promise((resolve) => { setTimeout(resolve, waitSleepMs); });
			return waitScript[Math.min(waitCall, waitScript.length) - 1];
		},
		read: () => {
			log.push({ op: "read" });
			// 真源 jobs.read 为同步契约（session-reviewer 无 await）。
			return readResult === null ? { result: "", chunks: [] } : { result: readResult, chunks: [] };
		},
		kill: async (_jobId, _owner, reason) => { log.push({ op: "kill", reason }); },
		get: async () => waitScript[waitScript.length - 1]
	};
	return { deps: { gateway, jobs, validateJsonSchemaValue }, log, promptedAt };
}

/**
 * 构造 runReviewerSession 最小参数。
 * @param {object} [overrides] 字段覆盖。
 * @returns {object} params。
 */
function makeParams(overrides = {}) {
	return {
		parentAgent: { session: { id: "sess-parent" } },
		outerSignal: { aborted: false, addEventListener() {}, removeEventListener() {} },
		inputText: "【目标文档】\n" + TARGET_TEXT,
		targetText: TARGET_TEXT,
		timeoutMs: 60_000,
		...overrides
	};
}

/* ========================================================================= */
/* 用例 A：salvage 命中 · 结论已产出且合规                                     */
/* ========================================================================= */

test("用例 A：wait 超时但 session 已产出合规 JSON → report 而非 timeout", async () => {
	const h = makeHarness({
		waitView: { status: "running" },
		records: (t) => makeEvents(VALID_REPORT_JSON, t + 1),
		listSummary: STALLED_SUMMARY
	});
	const outcome = await runReviewerSession(h.deps, makeParams());
	assert.notEqual(outcome.kind, "timeout", "salvage 命中不得判 timeout");
	assert.equal(outcome.kind, "report");
	assert.equal(outcome.report.issues.length, 1, "report 必须含 1 条 issue");
	assert.equal(outcome.report.summary, "模拟审查结论");
	assert.equal(outcome.attempts, 1);
});

/* ========================================================================= */
/* 用例 B：salvage 未命中 · 真无结论                                          */
/* ========================================================================= */

test("用例 B：确无结论（pending）→ timeout 且信封带 sessionId", async () => {
	const h = makeHarness({
		waitView: { status: "running" },
		records: () => [{ type: "user/message", seq: 1, time: Date.now(), data: {} }],
		listSummary: STALLED_SUMMARY
	});
	const outcome = await runReviewerSession(h.deps, makeParams());
	assert.equal(outcome.kind, "timeout");
	assert.equal(outcome.sessionId, SESSION_ID, "timeout 信封必须带 sessionId");
	assert.ok(h.log.some((entry) => entry.op === "kill"), "确无结论必须 kill monitor");
});

/* ========================================================================= */
/* 用例 C：kill 前已 salvage（调用序）                                        */
/* ========================================================================= */

test("用例 C：inspectReviewSession 在 jobs.kill 之前被调用，timeout 信封带 sessionId", async () => {
	const h = makeHarness({
		waitView: { status: "running" },
		records: () => [{ type: "user/message", seq: 1, time: Date.now(), data: {} }],
		listSummary: STALLED_SUMMARY
	});
	const outcome = await runReviewerSession(h.deps, makeParams());
	const listIndex = h.log.findIndex((entry) => entry.op === "invoke:list");
	const killIndex = h.log.findIndex((entry) => entry.op === "kill");
	assert.ok(listIndex >= 0, "inspectReviewSession 必须先调 session/list");
	assert.ok(killIndex >= 0, "确无结论必须 kill");
	assert.ok(listIndex < killIndex, "inspect（list）必须在 kill 之前");
	assert.equal(outcome.kind, "timeout");
	assert.equal(outcome.sessionId, SESSION_ID);
});

/* ========================================================================= */
/* 用例 D：sessionId 全链路透传（reviewer → service → tool）                  */
/* ========================================================================= */

test("用例 D：timeout 信封 sessionId 三处同值（session-reviewer → service → tool）", async () => {
	const h = makeHarness({
		waitView: { status: "running" },
		records: () => [{ type: "user/message", seq: 1, time: Date.now(), data: {} }],
		listSummary: STALLED_SUMMARY
	});

	// ① session-reviewer 直出信封。
	const reviewerOutcome = await runReviewerSession(h.deps, makeParams());
	assert.equal(reviewerOutcome.kind, "timeout");
	assert.equal(reviewerOutcome.sessionId, SESSION_ID);

	// ② service.reviewPrompt 透传信封。
	const service = createDocReviewService({ gateway: h.deps.gateway, jobs: h.deps.jobs });
	const serviceEnvelope = await service.reviewPrompt({
		targetContent: TARGET_TEXT,
		parentAgent: { session: { id: "sess-parent", header: { cwd: process.cwd() } } },
		workspaceRoot: mkdtempSync(join(tmpdir(), "docrev-sv-d-")),
		archive: false,
		timeoutMs: 60_000,
		signal: { aborted: false, addEventListener() {}, removeEventListener() {} },
		chain: { chainId: "docr-chain-d", round: 1 }
	});
	assert.equal(serviceEnvelope.kind, "timeout");
	assert.equal(serviceEnvelope.sessionId, SESSION_ID, "service 信封必须透传 sessionId");

	// ③ tool.execute 降级返回（TOOL_OUTPUT_SPEC 兼容附加）。
	const cwd = mkdtempSync(join(tmpdir(), "docrev-tool-d-"));
	const exec = {
		agent: {
			session: { id: "sess-parent", header: { cwd }, deriveMessages: () => [] }
		},
		signal: { aborted: false, addEventListener() {}, removeEventListener() {} },
		deferContext() {},
		concludeTurn() {}
	};
	const tool = createDocReviewTool({ gateway: h.deps.gateway, jobs: h.deps.jobs }, service);
	const result = await tool.execute({ target_content: TARGET_TEXT, chain_id: "docr-chain-d" }, exec);
	assert.equal(result.degraded, "timeout");
	assert.equal(result.sessionId, SESSION_ID, "tool 降级返回必须带同一 sessionId");
	assert.ok(result.next_action.includes("优先续取"), "nextAction 必须含链级续取指引");
});

/* ========================================================================= */
/* 用例 E：正常完成路径不回归                                                  */
/* ========================================================================= */

test("用例 E：monitor 正常 settle → 仍走 report 路径（不受 salvage 影响）", async () => {
	const h = makeHarness({
		waitView: { status: "completed" },
		readResult: VALID_REPORT_JSON
	});
	const outcome = await runReviewerSession(h.deps, makeParams());
	assert.equal(outcome.kind, "report");
	assert.equal(outcome.report.issues.length, 1);
	assert.equal(outcome.report.summary, "模拟审查结论");
	assert.ok(h.log.some((entry) => entry.op === "read"), "正常完成路径必须读 job 结论");
	assert.ok(!h.log.some((entry) => entry.op === "kill"), "正常完成路径不得 kill");
});

/* ========================================================================= */
/* 用例 F：salvage 命中但 JSON 不合规 → freeform，且零重试（红线 4）            */
/* ========================================================================= */

test("用例 F：salvage 命中但 JSON 不合规 → freeform 且 rePromptReviewSession 零调用", async () => {
	const h = makeHarness({
		waitView: { status: "running" },
		records: (t) => makeEvents("这不是合法 JSON", t + 1),
		listSummary: STALLED_SUMMARY
	});
	const outcome = await runReviewerSession(h.deps, makeParams());
	assert.equal(outcome.kind, "freeform");
	assert.equal(outcome.freeformText, "这不是合法 JSON", "freeform 降级必须回传原始文本");
	const promptCalls = h.log.filter((entry) => entry.op === "invoke:prompt").length;
	assert.equal(promptCalls, 1, "仅 launch 时 1 次 prompt；rePromptReviewSession 必须零调用（红线 4）");
	assert.ok(!h.log.some((entry) => entry.op === "kill"), "salvage 命中不 kill");
});

/* ========================================================================= */
/* 用例 G：F2 分片续等（2026-10-25 长 CoT 事故编码）                            */
/* 事故现场：审查员 605s 才产出结论，旧实现 300s 分片点 kill monitor 判 timeout， */
/* 结论已产出却被丢弃、主会话重开一轮白烧 token。                               */
/* 新语义：分片到点未 settle 但 session 仍活跃（running=true）→ 继续等，不 kill。  */
/* ========================================================================= */

test("用例 G：分片到点 session 仍活跃 → 续等后收到结论（report，不误杀）", async () => {
	const h = makeHarness({
		// 第 1 个分片（≈300s 旧判定点）monitor 未 settle；第 2 个分片结论就位。
		waitSequence: [{ status: "running" }, { status: "completed" }],
		readResult: VALID_REPORT_JSON,
		listSummary: RUNNING_SUMMARY,
		waitSleepMs: 5
	});
	const outcome = await runReviewerSession(h.deps, makeParams({ timeoutMs: 60_000 }));
	assert.equal(outcome.kind, "report", "活跃 session 分片后续等必须收到结论而非 timeout");
	assert.equal(outcome.report.issues.length, 1);
	assert.equal(outcome.attempts, 1);
	assert.ok(h.log.filter((entry) => entry.op === "wait").length >= 2, "必须发生分片续等（≥2 次 wait）");
	assert.ok(h.log.some((entry) => entry.op === "invoke:list"), "分片到点必须查 session 存活度（F3）");
	assert.ok(!h.log.some((entry) => entry.op === "kill"), "活跃 session 不得提前 kill");
});

/* ========================================================================= */
/* 用例 H：分片续等的边界——session 活跃但总预算耗尽                            */
/* 语义：续等不是无限等；deadline 到了仍未 settle 才 kill + timeout。            */
/* ========================================================================= */

test("用例 H：活跃 session 但总预算耗尽 → kill + timeout 信封带 sessionId", async () => {
	const h = makeHarness({
		waitView: { status: "running" },
		listSummary: RUNNING_SUMMARY,
		waitSleepMs: 5
	});
	const outcome = await runReviewerSession(h.deps, makeParams({ timeoutMs: 300 }));
	assert.equal(outcome.kind, "timeout", "预算耗尽必须判 timeout");
	assert.equal(outcome.sessionId, SESSION_ID, "timeout 信封必须带 sessionId（供链级续取）");
	assert.ok(h.log.some((entry) => entry.op === "kill"), "预算耗尽必须 kill monitor");
	assert.ok(h.log.some((entry) => entry.op === "invoke:list"), "续等期间必须持续查存活度");
});
