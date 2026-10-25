/**
 * test/test-chain-resume.mjs —— v0.3.3 链级 session 续取（F5）与配套断言。
 *
 * 覆盖：
 *   R-1 事故流（session-68727f69，2026-10-25）：长 CoT 审查超时判 timeout 但结论
 *       未交付 → 同链同轮同文档重调自动续取原 session 收结论，不新开 session、
 *       不重发 prompt（token 不再白烧一轮）；
 *   R-2 结论已交付（delivered=true）→ 同参重调也新开 session（防复用已交付会话）；
 *   R-3 轮次变化 / 文档变化 → 不续取（hash/round 双闸，防串结论）；
 *   R-4 账本 session 已不存在（被删/不在 list）→ 回退新开，不孤儿化；
 *   F6  审查 session 标题带链后 8 位（doc-review-xxxxxxxx，会话列表可检索）；
 *   F4  timeout_ms 边界（60_000..1_800_000）：越界/非整数拒绝且零派发，边界值放行；
 *   T-R1 工具级：预置未交付账本 → 重调续取 + renderToolResult 渲染 session id（F1）。
 *
 * 运行（仓库根目录）：node --test test/test-chain-resume.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDocReviewService, hashReviewText } from "../lib/service.js";
import { createDocReviewTool } from "../lib/tool.js";
import { CHAIN_SESSION_FILE_NAME, writeChainSessionState } from "../lib/archive.js";
import { makeReviewHarness } from "./gateway-harness.mjs";

/** 稳定原文引句（≥8 连续字符；issue.location 必须真实命中目标文本）。 */
const TARGET_SENTENCE = "这是一个用于链级续取测试的稳定原文句子，包含足够长的定位引句。";
const TARGET_TEXT = `# 续取测试文档\n\n${TARGET_SENTENCE}\n`;

/** 合规审查报告 JSON（审查员 assistant 纯文本输出，parseFreeformReport 可解析）。 */
const VALID_REPORT_JSON = JSON.stringify({
	summary: "测试报告：发现一处需要主 Agent 裁决处理的问题。",
	issues: [
		{
			id: "CR-F-01",
			dimension: "fact",
			severity: "high",
			location: TARGET_SENTENCE,
			claim: "该处事实性表述与参考依据不一致，需要核对。",
			evidence: "no-reference",
			suggestion: "按权威来源修正该表述。"
		}
	],
	newIssueCount: 1,
	round: 1,
	chainId: ""
});

/** 停滞 session 的 list summary（running 非 true 且 >90s 无活动 → F3 判死，快速走 salvage）。 */
const STALLED_SUMMARY = { running: false, updatedAt: Date.now() - 200_000 };

/** 构造最小 parentAgent stub。 */
function makeParentAgent(cwd, sessionId = "sess-parent") {
	return {
		session: {
			id: sessionId,
			header: { cwd },
			deriveMessages: () => []
		}
	};
}

/** 构造一个临时工作区并返回路径。 */
function makeTempWorkspace() {
	return mkdtempSync(join(tmpdir(), "dsh-doc-review-resume-"));
}

/** 读取链级 session 账本（chain-session.json）。 */
function readLedger(cwd, chainId) {
	return JSON.parse(readFileSync(join(cwd, ".doc-review", chainId, CHAIN_SESSION_FILE_NAME), "utf8"));
}

/* ========================================================================= */
/* R-1：事故流——timeout 未交付 → 同链同轮同文档重调续取收结论                  */
/* ========================================================================= */

test("R-1 事故流：timeout 未交付 → 同参重调续取原 session 结论（不新开/不重发）", async () => {
	const cwd = makeTempWorkspace();
	const chain = { chainId: "docr-resume-r1", round: 1 };
	const harness = makeReviewHarness({
		attempts: [
			// 第一调：monitor 不 settle（长 CoT 进行中），分片到点 session 已停滞。
			{ wait: { status: "running" }, result: "" },
			// 续取：结论其实早已就位（事故现场即如此），一次 settle 交付。
			{ wait: { status: "completed" }, result: VALID_REPORT_JSON }
		],
		listSummary: STALLED_SUMMARY
	});
	const service = createDocReviewService(harness.deps);
	const agent = makeParentAgent(cwd);

	// 第一调：salvage 无结论 → timeout 信封（结论未交付，sessionId 回传）。
	const first = await service.reviewPrompt({
		targetContent: TARGET_TEXT,
		parentAgent: agent,
		workspaceRoot: cwd,
		chain,
		timeoutMs: 60_000
	});
	assert.equal(first.kind, "timeout");
	assert.equal(first.sessionId, "sess-review-1", "timeout 信封必须回传 sessionId（F1）");
	assert.equal(first.attempts, 1);

	// 账本落盘：delivered=false 才允许续取；targetHash 绑定送审文本。
	const ledgerPath = join(cwd, ".doc-review", chain.chainId, CHAIN_SESSION_FILE_NAME);
	assert.ok(existsSync(ledgerPath), "产出过 session 必须写链账本");
	const ledger = readLedger(cwd, chain.chainId);
	assert.equal(ledger.sessionId, "sess-review-1");
	assert.equal(ledger.round, 1);
	assert.equal(ledger.delivered, false);
	assert.equal(ledger.targetHash, hashReviewText(TARGET_TEXT));

	// 第二调：同链 + 同轮 + 同文档 → 续取（不新开 session、不重发 prompt）。
	const second = await service.reviewPrompt({
		targetContent: TARGET_TEXT,
		parentAgent: agent,
		workspaceRoot: cwd,
		chain
	});
	assert.equal(second.kind, "report", "续取必须收到结论而非重开审查");
	assert.equal(second.sessionId, "sess-review-1", "续取必须回原 session");
	assert.equal(second.attempts, 1, "续取 attempts=1（不重烧一轮审查 token）");
	assert.equal(second.report.issues.length, 1);
	assert.equal(harness.count("invoke:create"), 1, "续调不得新开审查 session");
	assert.equal(harness.count("invoke:prompt"), 1, "续调不得重发 prompt");

	// 交付后账本翻面 delivered=true（后续同参重调将新开，见 R-2）。
	assert.equal(readLedger(cwd, chain.chainId).delivered, true);
});

/* ========================================================================= */
/* R-2：结论已交付 → 不续取                                                    */
/* ========================================================================= */

test("R-2 结论已交付（delivered=true）→ 同参重调也新开 session", async () => {
	const cwd = makeTempWorkspace();
	const chain = { chainId: "docr-resume-r2", round: 1 };
	const harness = makeReviewHarness({
		attempts: [
			{ wait: { status: "completed" }, result: VALID_REPORT_JSON },
			{ wait: { status: "completed" }, result: VALID_REPORT_JSON }
		]
	});
	const service = createDocReviewService(harness.deps);
	const agent = makeParentAgent(cwd);

	const first = await service.reviewPrompt({
		targetContent: TARGET_TEXT, parentAgent: agent, workspaceRoot: cwd, chain
	});
	assert.equal(first.kind, "report");

	const second = await service.reviewPrompt({
		targetContent: TARGET_TEXT, parentAgent: agent, workspaceRoot: cwd, chain
	});
	assert.equal(second.kind, "report");
	assert.equal(harness.count("invoke:create"), 2, "已交付会话不得续取，必须新开");
	assert.equal(harness.count("invoke:prompt"), 2);
	assert.equal(second.sessionId, "sess-review-2");

	const ledger = readLedger(cwd, chain.chainId);
	assert.equal(ledger.sessionId, "sess-review-2", "账本必须翻面到新 session");
	assert.equal(ledger.delivered, true);
});

/* ========================================================================= */
/* R-3：轮次变化 / 文档变化 → 不续取（双闸防串结论）                            */
/* ========================================================================= */

test("R-3 轮次变化或文档变化 → 不续取，新开 session", async () => {
	// 场景 a：轮次变化（round 1 → 2，round 闸不匹配）。
	const cwdA = makeTempWorkspace();
	const chainA = { chainId: "docr-resume-r3a", round: 1 };
	const harnessA = makeReviewHarness({
		attempts: [
			{ wait: { status: "running" }, result: "" },
			{ wait: { status: "completed" }, result: VALID_REPORT_JSON }
		],
		listSummary: STALLED_SUMMARY
	});
	const serviceA = createDocReviewService(harnessA.deps);
	const firstA = await serviceA.reviewPrompt({
		targetContent: TARGET_TEXT, parentAgent: makeParentAgent(cwdA), workspaceRoot: cwdA,
		chain: chainA, timeoutMs: 60_000
	});
	assert.equal(firstA.kind, "timeout");

	const secondA = await serviceA.reviewPrompt({
		targetContent: TARGET_TEXT, parentAgent: makeParentAgent(cwdA), workspaceRoot: cwdA,
		chain: { chainId: chainA.chainId, round: 2 }
	});
	assert.equal(secondA.kind, "report");
	assert.equal(harnessA.count("invoke:create"), 2, "轮次变化不得续取旧 session");

	// 场景 b：文档变化（同轮，targetHash 闸不匹配——防把 A 文档的结论发给 B 文档）。
	const cwdB = makeTempWorkspace();
	const chainB = { chainId: "docr-resume-r3b", round: 1 };
	const harnessB = makeReviewHarness({
		attempts: [
			{ wait: { status: "running" }, result: "" },
			{ wait: { status: "completed" }, result: VALID_REPORT_JSON }
		],
		listSummary: STALLED_SUMMARY
	});
	const serviceB = createDocReviewService(harnessB.deps);
	const firstB = await serviceB.reviewPrompt({
		targetContent: TARGET_TEXT, parentAgent: makeParentAgent(cwdB), workspaceRoot: cwdB,
		chain: chainB, timeoutMs: 60_000
	});
	assert.equal(firstB.kind, "timeout");

	const secondB = await serviceB.reviewPrompt({
		targetContent: `${TARGET_TEXT}\n改动后的新增段落，文档内容已变化。`,
		parentAgent: makeParentAgent(cwdB), workspaceRoot: cwdB, chain: chainB
	});
	assert.equal(secondB.kind, "report");
	assert.equal(harnessB.count("invoke:create"), 2, "文档变化不得续取（防串结论）");
});

/* ========================================================================= */
/* R-4：账本 session 不存在 → 回退新开                                         */
/* ========================================================================= */

test("R-4 账本 session 已不存在 → 回退新开（不孤儿化）", async () => {
	const cwd = makeTempWorkspace();
	const chainId = "docr-resume-r4";
	// 预置账本：round/hash/delivered 三闸全匹配，但 session 不在 session/list 里
	// （被删或从未存在）。harness 默认 list 只含 createdSessions，故必判不存在。
	writeChainSessionState(cwd, chainId, {
		sessionId: "sess-vanished",
		round: 1,
		promptedAt: Date.now() - 60_000,
		targetHash: hashReviewText(TARGET_TEXT),
		delivered: false,
		updatedAt: Date.now() - 60_000
	});
	const harness = makeReviewHarness({
		attempts: [{ wait: { status: "completed" }, result: VALID_REPORT_JSON }]
	});
	const service = createDocReviewService(harness.deps);

	const envelope = await service.reviewPrompt({
		targetContent: TARGET_TEXT, parentAgent: makeParentAgent(cwd), workspaceRoot: cwd,
		chain: { chainId, round: 1 }
	});
	assert.equal(envelope.kind, "report");
	assert.equal(envelope.sessionId, "sess-review-1", "回退必须新开 session");
	assert.equal(harness.count("invoke:create"), 1);
	assert.equal(harness.count("invoke:prompt"), 1);

	const ledger = readLedger(cwd, chainId);
	assert.equal(ledger.sessionId, "sess-review-1", "账本必须翻面到新 session");
	assert.equal(ledger.delivered, true);
});

/* ========================================================================= */
/* F6：标题带链                                                               */
/* ========================================================================= */

test("F6 审查 session 标题带链后 8 位（doc-review-xxxxxxxx）", async () => {
	const cwd = makeTempWorkspace();
	const chainId = "docr-title-abcdef123456";
	const harness = makeReviewHarness();
	const service = createDocReviewService(harness.deps);

	await service.reviewPrompt({
		targetContent: TARGET_TEXT, parentAgent: makeParentAgent(cwd), workspaceRoot: cwd,
		chain: { chainId, round: 1 },
		archive: false
	});
	assert.equal(harness.renames.length, 1, "launch 必须 rename 一次");
	assert.equal(harness.renames[0].sessionId, "sess-review-1");
	assert.equal(harness.renames[0].title, "doc-review-" + chainId.slice(-8));
});

/* ========================================================================= */
/* F4：timeout_ms 边界                                                        */
/* ========================================================================= */

test("F4 timeout_ms 边界：越界/非整数拒绝且零派发，边界值放行", async () => {
	const cwd = makeTempWorkspace();
	const harness = makeReviewHarness();
	const tool = createDocReviewTool(harness.deps);
	const exec = {
		agent: makeParentAgent(cwd),
		signal: { aborted: false, addEventListener() {}, removeEventListener() {} },
		deferContext() {},
		concludeTurn() {}
	};

	// 越界与非整数：必须零派发拒绝。
	for (const bad of [59_999, 1_800_001, 0, -1, 90_000.5, "900000"]) {
		await assert.rejects(
			() => tool.execute({ target_content: TARGET_TEXT, timeout_ms: bad, max_rounds: 1 }, exec),
			/timeout_ms/,
			`timeout_ms=${String(bad)} 必须被拒绝`
		);
	}
	assert.equal(harness.count("invoke:create"), 0, "边界校验必须先于派发");

	// 边界值放行（下限 60_000 / 上限 1_800_000）。
	for (const ok of [60_000, 1_800_000]) {
		const result = await tool.execute(
			{ target_content: TARGET_TEXT, timeout_ms: ok, max_rounds: 1 },
			exec
		);
		assert.ok(result.report, `timeout_ms=${ok} 应放行并产出 report`);
	}
});

/* ========================================================================= */
/* T-R1：工具级续取 + F1 渲染                                                  */
/* ========================================================================= */

test("T-R1 工具级：预置未交付账本 → 重调续取原 session 且渲染 session id", async () => {
	const cwd = makeTempWorkspace();
	const chainId = "docr-tool-resume-01";
	// 预置账本（模拟上一轮 timeout 未交付）：session 在 session/list 中可见。
	writeChainSessionState(cwd, chainId, {
		sessionId: "sess-prior",
		round: 1,
		promptedAt: Date.now() - 60_000,
		targetHash: hashReviewText(TARGET_TEXT),
		delivered: false,
		updatedAt: Date.now() - 60_000
	});
	const harness = makeReviewHarness({
		attempts: [{ wait: { status: "completed" }, result: VALID_REPORT_JSON }],
		existingSessions: ["sess-prior"]
	});
	const tool = createDocReviewTool(harness.deps);
	const exec = {
		agent: makeParentAgent(cwd),
		signal: { aborted: false, addEventListener() {}, removeEventListener() {} },
		deferContext() {},
		concludeTurn() {}
	};

	const result = await tool.execute(
		{ target_content: TARGET_TEXT, chain_id: chainId, max_rounds: 1 },
		exec
	);
	assert.ok(result.report, "续取应直接收到结论");
	assert.equal(result.sessionId, "sess-prior", "必须回原 session id");
	assert.equal(harness.count("invoke:create"), 0, "续取不得新开 session");
	assert.equal(harness.count("invoke:prompt"), 0, "续取不得重发 prompt");

	// F1：renderToolResult 必须渲染 session id 与可检索标题。
	const blocks = tool.output.render(null, result);
	const text = blocks.map((block) => block.text).join("\n");
	assert.match(text, /审查 session：sess-prior/, "渲染必须含审查 session id");
	assert.match(text, new RegExp("doc-review-" + chainId.slice(-8)), "渲染必须含链标题");

	// 交付后账本翻面。
	assert.equal(readLedger(cwd, chainId).delivered, true);
});
