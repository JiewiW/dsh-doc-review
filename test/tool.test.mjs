/**
 * lib/tool.js 集成测试（端到端，不经真实子会话，subagents 全 stub）。
 * 运行命令（仓库根目录）：node --test test/
 *
 * 覆盖：
 * - 最坏口径 >20k 首调零子会话 + confirmationRequired；confirm_token_budget 同链放行；
 *   同链后续轮不重复 worst 确认；链累计 >20k×max_rounds 拦截 + pendingCumulativeAck 登记，
 *   再次带 confirm 且投影一致放行。
 * - A08：round>1 优先读归档 document.md/review-report.json，插件复算 changeRatio/对齐/收敛，
 *   newIssueCount 以复算为准；归档缺失且无 prev_document → 「多轮链断裂」零子会话。
 * - T10 分级：mode=sample 仅 fact/format 且等距抽样文本喂子会话（输入包短于 full）。
 * - 所有结构化返回值过 T02b 编译后 output schema（additionalProperties:false 双向约束）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";

import { createDocReviewTool } from "../lib/tool.js";
import { buildReviewInput } from "../lib/context-builder.js";
import { buildSamplePlan, estimateRound } from "../lib/cost.js";
import { readChainCostState } from "../lib/archive.js";

const mkdtempAsync = promisify(mkdtemp);

/** 稳定原文引句（≥8 连续字符；各测试文档均包含，过 reviewer location 业务校验）。 */
const MOD_SENTENCE = "这是一个用于token预算确认集成测试的中等长度稳定原文句子。";
const BIG_SENTENCE = "这是一个用于链累计超预算拦截与再次确认集成测试的稳定原文句子。";
const A08_SENTENCE = "这是一个用于多轮审查复算测试的稳定原文句子，包含足够长的定位引句。";

/**
 * 构造一份过 T02a + reviewer 业务校验的子会话 structured 报告。
 * @param {string} location 必须真实出现在目标文档中的原文引句。
 * @param {object} [overrides] 字段覆盖。
 * @returns {object} 报告对象。
 */
function makeReport(location, overrides = {}) {
	return {
		summary: "测试报告：发现一处需要主 Agent 裁决处理的问题。",
		issues: [
			{
				id: "GE-F-01",
				dimension: "fact",
				severity: "high",
				location,
				claim: "该处事实性表述与参考依据不一致，需要核对。",
				evidence: "no-reference",
				suggestion: "按权威来源修正该表述。"
			}
		],
		newIssueCount: 1,
		round: 1,
		chainId: "",
		...overrides
	};
}

/**
 * 构造 subagents stub：记录 start 调用次数与每次 prompt，子会话恒返回指定 structured 报告。
 * @param {object} report 子会话 structured 输出。
 * @returns {{deps: object, calls: object[], concludeTurnCalls: object[]}} 探测集合。
 */
function makeHarness(report) {
	const calls = [];
	const concludeTurnCalls = [];
	const deps = {
		subagents: {
			getProvider: () => ({}),
			start: async (_provider, request) => {
				calls.push(request);
				return {
					id: `run-${calls.length}`,
					result: Promise.resolve({ stopReason: "completed", structured: report, output: [] }),
					dispose: async () => {}
				};
			}
		}
	};
	return { deps, calls, concludeTurnCalls };
}

/**
 * 构造 ToolRunContext stub（cwd 指向临时目录，归档落此处）。
 * @param {string} cwd 临时工作区根。
 * @param {object[]} concludeTurnCalls concludeTurn 调用记录数组。
 * @returns {object} exec stub。
 */
function makeExec(cwd, concludeTurnCalls) {
	return {
		agent: {
			session: {
				id: "sess-parent",
				header: { cwd },
				deriveMessages: () => []
			}
		},
		signal: { aborted: false, addEventListener() {}, removeEventListener() {} },
		deferContext() {},
		concludeTurn(payload) {
			concludeTurnCalls.push(payload ?? {});
		}
	};
}

/**
 * 断言工具返回值零违规通过编译后 T02b output schema。
 * @param {object} tool createDocReviewTool 产物。
 * @param {object} result execute 返回值。
 */
function assertMatchesOutputSchema(tool, result) {
	const violations = validateJsonSchemaValue(tool.output.schema, result, "value");
	assert.deepEqual(violations, [], `返回值违反 T02b output schema：${violations.join("；")}`);
}

/**
 * 读取链根 chain-cost.json（经插件导出函数，缺省返回默认态）。
 * @param {string} cwd 工作区根。
 * @param {string} chainId 链 ID。
 * @returns {object} 链成本态。
 */
function readCost(cwd, chainId) {
	return readChainCostState(cwd, chainId);
}

/* ========================================================================= */
/* A10-1：最坏口径 >20k，首调未确认 → 零子会话 + confirmationRequired 拦截      */
/* ========================================================================= */

test("A10-1 大输入首调未确认：零子会话、confirmationRequired、concludeTurn", async () => {
	const cwd = await mkdtempAsync(join(tmpdir(), "docrev-a101-"));
	const bigDocument = `# 大文档\n\n${BIG_SENTENCE.repeat(900)}`;
	const harness = makeHarness(makeReport(BIG_SENTENCE));
	const tool = createDocReviewTool(harness.deps);

	const result = await tool.execute(
		{ target_content: bigDocument, max_rounds: 3 },
		makeExec(cwd, harness.concludeTurnCalls)
	);

	assert.strictEqual(result.confirmationRequired, true);
	assert.strictEqual(result.report, undefined);
	assert.strictEqual(result.costEstimate.reason, "worst-case-over-threshold");
	assert.ok(result.costEstimate.worstCaseTokens > 20000, "前置条件：最坏口径须 >20k");
	assert.strictEqual(harness.calls.length, 0, "拦截分支不得派发子会话");
	assert.strictEqual(harness.concludeTurnCalls.length, 1, "拦截分支须调 concludeTurn");
	assert.strictEqual(harness.concludeTurnCalls[0].confirmationRequired, true);
	assertMatchesOutputSchema(tool, result);
});

/* ========================================================================= */
/* A10-2/3：confirm 同链放行；同链后续轮不重复 worst 确认（累计仍在预算内）     */
/* ========================================================================= */

test("A10-2/3 同链 confirm 放行后，后续轮（累计未超预算）不再要求 worst 确认", async () => {
	const cwd = await mkdtempAsync(join(tmpdir(), "docrev-a1023-"));
	// 单轮最坏 >20k 但两轮累计 < 20k×3=60k 的中等文档（自校验前置条件）。
	const document = `# 中等文档\n\n${MOD_SENTENCE.repeat(80)}`;
	const harness = makeHarness(makeReport(MOD_SENTENCE));
	const tool = createDocReviewTool(harness.deps);
	const exec = makeExec(cwd, harness.concludeTurnCalls);

	// 首次未确认：worst 拦截（建立基线，证明该文档确属需确认体量）。
	const blocked = await tool.execute({ target_content: document, max_rounds: 3 }, exec);
	assert.strictEqual(blocked.confirmationRequired, true);
	assert.strictEqual(blocked.costEstimate.reason, "worst-case-over-threshold");
	assert.strictEqual(harness.calls.length, 0);

	// 带 confirm_token_budget=true 重调首轮：放行，落链 confirmed。
	const round1 = await tool.execute(
		{ target_content: document, max_rounds: 3, confirm_token_budget: true },
		exec
	);
	assert.strictEqual(round1.confirmationRequired, undefined);
	assert.ok(round1.report, "放行后须产出 report");
	assert.strictEqual(round1.round, 1);
	assert.strictEqual(harness.calls.length, 1, "首轮放行派发 1 个子会话");
	assertMatchesOutputSchema(tool, round1);
	const chainId = round1.chainId;
	const worstOne = round1.costEstimate.worstCaseTokens;
	assert.ok(worstOne > 20000, "前置：单轮最坏 >20k");
	assert.ok(worstOne * 2 <= round1.costEstimate.chainBudgetTokens, "前置：两轮累计不超链预算");
	const stateAfterR1 = readCost(cwd, chainId);
	assert.strictEqual(stateAfterR1.confirmed, true);
	assert.strictEqual(stateAfterR1.rounds.length, 1);

	// 第二轮：不带 confirm（链已 confirmed），经归档读回上轮；累计投影仍 <预算 → 直接放行。
	const round2 = await tool.execute(
		{ target_content: document, chain_id: chainId, prev_round: 1, max_rounds: 3 },
		exec
	);
	assert.strictEqual(round2.confirmationRequired, undefined, "同链后续轮不得重复 worst 确认");
	assert.strictEqual(round2.round, 2);
	assert.ok(round2.report);
	assert.strictEqual(harness.calls.length, 2, "第二轮直接派发，无子会话拦截");
	assertMatchesOutputSchema(tool, round2);
	const stateAfterR2 = readCost(cwd, chainId);
	assert.strictEqual(stateAfterR2.rounds.length, 2);
});

/* ========================================================================= */
/* A10-4：链累计超预算 → cumulative 拦截 + pendingAck；再确认投影一致放行        */
/* ========================================================================= */

test("A10-4 链累计超预算拦截登记 pendingCumulativeAck，带 confirm 投影一致后放行", async () => {
	const cwd = await mkdtempAsync(join(tmpdir(), "docrev-a104-"));
	// 非对称两轮：round1 中等（20k<W1<60k，confirm 后累计不超限可放行）；
	// round2 更大，使 W1+W2>60k 触发链累计拦截（两轮各自 location 不同，用两个 stub）。
	const docRound1 = `# 第一轮中等文档\n\n${MOD_SENTENCE.repeat(100)}`;
	const docRound2 = `# 第二轮较大文档\n\n${BIG_SENTENCE.repeat(300)}`;
	const harness1 = makeHarness(makeReport(MOD_SENTENCE));
	const harness2 = makeHarness(makeReport(BIG_SENTENCE));
	const tool1 = createDocReviewTool(harness1.deps);
	const tool2 = createDocReviewTool(harness2.deps);
	const exec1 = makeExec(cwd, harness1.concludeTurnCalls);
	const exec2 = makeExec(cwd, harness2.concludeTurnCalls);

	// 首轮带 confirm：worst>20k 被链确认放行，累计投影 W1<60k 不触发累计守卫。
	const round1 = await tool1.execute(
		{ target_content: docRound1, max_rounds: 3, confirm_token_budget: true },
		exec1
	);
	assert.strictEqual(round1.confirmationRequired, undefined);
	assert.strictEqual(harness1.calls.length, 1);
	const chainId = round1.chainId;
	const worstOne = round1.costEstimate.worstCaseTokens;
	assert.ok(worstOne > 20000, "前置：round1 单轮最坏 >20k");
	assert.ok(worstOne <= 20000 * 3, "前置：round1 单轮最坏不超链预算 60k");

	// 第二轮不带 confirm：worst 被链 confirmed 放行，但累计投影 W1+W2>60k → cumulative 拦截。
	const blocked = await tool2.execute(
		{ target_content: docRound2, chain_id: chainId, prev_round: 1, max_rounds: 3 },
		exec2
	);
	assert.strictEqual(blocked.confirmationRequired, true);
	assert.strictEqual(blocked.costEstimate.reason, "chain-cumulative-over-budget");
	const worstTwo = blocked.costEstimate.worstCaseTokens;
	assert.ok(worstOne + worstTwo > 20000 * 3, "前置：两轮累计投影超链预算");
	assert.strictEqual(harness2.calls.length, 0, "累计拦截不得派发子会话");
	assert.strictEqual(harness2.concludeTurnCalls.length, 1, "拦截轮须调 concludeTurn 1 次");
	const stateBlocked = readCost(cwd, chainId);
	assert.strictEqual(stateBlocked.pendingCumulativeAck, worstOne + worstTwo, "须登记待确认投影值");
	assert.strictEqual(stateBlocked.rounds.length, 1, "拦截轮不写入 rounds");
	assert.strictEqual(stateBlocked.cumulativeWorstCaseTokens, worstOne, "拦截轮累计保持为 round1 值");
	assertMatchesOutputSchema(tool2, blocked);

	// 第二轮带 confirm 且投影一致 → 视为「再次确认」放行；rounds 增到 2、pending 清空。
	const round2 = await tool2.execute(
		{
			target_content: docRound2,
			chain_id: chainId,
			prev_round: 1,
			max_rounds: 3,
			confirm_token_budget: true
		},
		exec2
	);
	assert.strictEqual(round2.confirmationRequired, undefined, "投影一致的再次确认须放行");
	assert.strictEqual(round2.round, 2);
	assert.ok(round2.report);
	assert.strictEqual(harness2.calls.length, 1, "重调放行后派发 1 个子会话");
	assertMatchesOutputSchema(tool2, round2);
	const statePassed = readCost(cwd, chainId);
	assert.strictEqual(statePassed.pendingCumulativeAck, null);
	assert.strictEqual(statePassed.rounds.length, 2);
});

/* ========================================================================= */
/* A10-5：单轮 worst 与链累计（maxRounds=1）同时超预算 → 一次 confirm 同时过两门 */
/* 复现 headless 真实事故（tfbig：6732 字 / worst=21630 / 预算=20000）：       */
/* 首次未确认 worst 拦截也须登记 pending 投影，否则首次 confirm 放行 worst 后  */
/* 改撞 cumulative 门无投影可匹配，被迫确认两次（违背 A10 一次确认预期）。     */
/* ========================================================================= */

test("A10-5 worst 与 cumulative 同时超预算：首次拦截登记投影，一次 confirm 放行", async () => {
	const cwd = await mkdtempAsync(join(tmpdir(), "docrev-a105-"));
	// max_rounds=1 → 链预算=20000；大文档单轮 worst>20000，故投影累计 0+worst 也必超预算。
	const bigDocument = `# 大文档\n\n${BIG_SENTENCE.repeat(900)}`;
	const harness = makeHarness(makeReport(BIG_SENTENCE));
	const tool = createDocReviewTool(harness.deps);
	const exec = makeExec(cwd, harness.concludeTurnCalls);

	// 首次未确认：worst 拦截（此时 worst 与 cumulative 两门都超，但 worst 判定优先）。
	const blocked = await tool.execute(
		{ target_content: bigDocument, max_rounds: 1 },
		exec
	);
	assert.strictEqual(blocked.confirmationRequired, true);
	assert.strictEqual(blocked.costEstimate.reason, "worst-case-over-threshold");
	assert.strictEqual(harness.calls.length, 0);
	const worstOne = blocked.costEstimate.worstCaseTokens;
	assert.ok(worstOne > 20000, "前置：单轮最坏 >20k");
	assert.strictEqual(blocked.costEstimate.chainBudgetTokens, 20000, "前置：maxRounds=1 链预算=20k");
	// 修复点：worst 拦截也须登记待确认投影（=本轮 worst，因链累计起点为 0）。
	const chainId = blocked.chainId;
	const stateBlocked = readCost(cwd, chainId);
	assert.strictEqual(stateBlocked.pendingCumulativeAck, worstOne, "worst 拦截也须登记投影");
	assert.strictEqual(stateBlocked.rounds.length, 0, "拦截轮不写入 rounds");
	assert.strictEqual(stateBlocked.confirmed, false);

	// 一次 confirm（回传首轮 chain_id）：worst 被 chainConfirmed 放行，cumulative 门凭已登记投影匹配豁免 → 直接派发。
	const round1 = await tool.execute(
		{ target_content: bigDocument, max_rounds: 1, confirm_token_budget: true, chain_id: chainId },
		exec
	);
	assert.strictEqual(round1.confirmationRequired, undefined, "一次 confirm 须同时过 worst+cumulative 两门");
	assert.strictEqual(round1.round, 1);
	assert.ok(round1.report, "放行后须产出 report");
	assert.strictEqual(harness.calls.length, 1, "一次确认后即派发 1 个子会话，不得要求第二次确认");
	assertMatchesOutputSchema(tool, round1);
	const statePassed = readCost(cwd, chainId);
	assert.strictEqual(statePassed.confirmed, true);
	assert.strictEqual(statePassed.pendingCumulativeAck, null, "成功后轮 pending 清空");
	assert.strictEqual(statePassed.rounds.length, 1);
});

/* ========================================================================= */
/* A08-1：两轮真实归档读回 + 复算 changeRatio/对齐/收敛（小改动，旧 issue 仍在）  */
/* ========================================================================= */

test("A08-1 round2 读归档复算：小改动→changeRatio<3 收敛，沿用旧 issue→新增0", async () => {
	const cwd = await mkdtempAsync(join(tmpdir(), "docrev-a081-"));
	const docRound1 = `# 多轮测试文档\n\n${A08_SENTENCE.repeat(6)}`;
	// 仅在首段句尾追加一个字符（1 个非空白码点增），变更比例远低于 3%。
	const docRound2 = docRound1.replace(A08_SENTENCE, `${A08_SENTENCE}X`);
	const harness = makeHarness(makeReport(A08_SENTENCE));
	const tool = createDocReviewTool(harness.deps);
	const exec = makeExec(cwd, harness.concludeTurnCalls);

	const round1 = await tool.execute(
		{ target_content: docRound1, max_rounds: 3 },
		exec
	);
	assert.strictEqual(round1.round, 1);
	assert.strictEqual(round1.report.newIssueCount, 1, "首轮 newIssueCount=issues 数");
	const chainId = round1.chainId;
	// round1 归档三件套 + 链成本态落盘。
	const round1Dir = join(cwd, ".doc-review", chainId, "round-1");
	for (const fileName of ["document.md", "review-report.json", "change-log.md"]) {
		assert.ok(existsSync(join(round1Dir, fileName)), `round-1 缺少 ${fileName}`);
	}
	assert.ok(existsSync(join(cwd, ".doc-review", chainId, "chain-cost.json")));

	// round2 不传 prev_document/prev_report：强制走归档读回路径。
	const round2 = await tool.execute(
		{ target_content: docRound2, chain_id: chainId, prev_round: 1, max_rounds: 3 },
		exec
	);
	assert.strictEqual(round2.round, 2);
	assert.ok(round2.changeRatio !== undefined && round2.changeRatio < 3.0, "小改动 changeRatio 须 <3%");
	assert.strictEqual(round2.converged, true);
	assert.strictEqual(round2.convergenceReason, "change-ratio-below-threshold");
	assert.strictEqual(round2.report.newIssueCount, 0, "旧 issue 沿用匹配→插件复算新增为 0");
	assert.strictEqual(round2.resolvedIssueCount, 0);
	assert.match(round2.next_action, /审查链已收敛/);
	const round2Dir = join(cwd, ".doc-review", chainId, "round-2");
	assert.ok(existsSync(join(round2Dir, "document.md")), "round-2 须归档 document.md");
	assert.ok(existsSync(join(round2Dir, "review-report.json")), "round-2 须归档 review-report.json");
	assertMatchesOutputSchema(tool, round2);
});

/* ========================================================================= */
/* A08-2：多轮链断裂（无归档、无 prev_document）→ 结构化错误，零子会话           */
/* ========================================================================= */

test("A08-2 归档读回失败且无 prev_document：抛多轮链断裂错误，零子会话", async () => {
	const cwd = await mkdtempAsync(join(tmpdir(), "docrev-a082-"));
	const harness = makeHarness(makeReport(A08_SENTENCE));
	const tool = createDocReviewTool(harness.deps);

	await assert.rejects(
		() => tool.execute(
			{
				target_content: `# 无链文档\n\n${A08_SENTENCE}`,
				chain_id: "docr-orphan-chain",
				prev_round: 1,
				max_rounds: 3
			},
			makeExec(cwd, harness.concludeTurnCalls)
		),
		/多轮链断裂/
	);
	assert.strictEqual(harness.calls.length, 0, "链断裂不得派发子会话");
});

/* ========================================================================= */
/* T10 分级：mode=sample 仅 fact/format，等距抽样文本喂子会话（输入包短于 full） */
/* ========================================================================= */

test("T10 分级 mode=sample：抽样文本喂子会话、仅 fact/format、成本按抽样口径", async () => {
	const cwd = await mkdtempAsync(join(tmpdir(), "docrev-sample-"));
	// 足够多的不同段落，使等距 30% 抽样明显短于全文。
	const paragraphs = Array.from({ length: 20 }, (_unused, index) =>
		`这是第 ${index + 1} 段用于抽样测试的正文，${A08_SENTENCE}`
	);
	const fullDocument = `# 抽样测试文档\n\n${paragraphs.join("\n\n")}`;
	// 每段都含 A08_SENTENCE，故抽样后 location 仍可在 sampledText 中命中。
	const harness = makeHarness(makeReport(A08_SENTENCE));
	const tool = createDocReviewTool(harness.deps);

	const result = await tool.execute(
		{ target_content: fullDocument, mode: "sample", max_rounds: 1 },
		makeExec(cwd, harness.concludeTurnCalls)
	);

	assert.ok(result.report, "sample 模式体量小，应直接成功");
	assert.strictEqual(result.costEstimate.mode, "sample");
	assert.strictEqual(harness.calls.length, 1);

	// 抽样计划与实际喂给子会话的 prompt 一致。
	const plan = buildSamplePlan(fullDocument, "sample");
	assert.deepEqual(plan.activeDimensions, ["fact", "format"]);
	assert.ok(plan.samplingDetail.sampled === true);
	const promptText = harness.calls[0].prompt[0].text;
	assert.ok(promptText.includes(plan.sampledText.slice(0, 24)), "子会话 prompt 须含抽样文本");

	// 成本字符口径 = 抽样文本 + 仅 fact/format 维度的输入包（不含子会话输出指令段）。
	const sampledPackage = buildReviewInput({
		targetText: plan.sampledText,
		references: [],
		docType: "generic",
		dimensions: { fact: true, completeness: false, necessity: false, format: true },
		prevReport: null
	}).inputText;
	assert.strictEqual(result.costEstimate.inputPackageChars, sampledPackage.length);
	const expected = estimateRound({ inputPackageChars: sampledPackage.length, mode: "sample" });
	assert.strictEqual(result.costEstimate.worstCaseTokens, expected.worstCaseTokens);

	// 同样文档 full 模式的输入包应明显更长（sample 只抽 30% 段落且关两维）。
	const fullPackage = buildReviewInput({
		targetText: fullDocument,
		references: [],
		docType: "generic",
		dimensions: { fact: true, completeness: true, necessity: true, format: true },
		prevReport: null
	}).inputText;
	assert.ok(sampledPackage.length < fullPackage.length, "sample 输入包须短于 full 输入包");
	assertMatchesOutputSchema(tool, result);
});

/* ========================================================================= */
/* target_file：工作区相对路径直读（大文档免内联通道）                        */
/* ========================================================================= */

test("target_file 读取工作区文件成功：正文进审查与归档，无需内联 target_content", async () => {
	const cwd = await mkdtempAsync(join(tmpdir(), "docrev-tfile-"));
	const document = `# 文件目标文档\n\n第一段正文，${A08_SENTENCE}\n`;
	writeFileSync(join(cwd, "original.md"), document, "utf8");
	const harness = makeHarness(makeReport(A08_SENTENCE));
	const tool = createDocReviewTool(harness.deps);

	const result = await tool.execute(
		{ target_file: "original.md", max_rounds: 1 },
		makeExec(cwd, harness.concludeTurnCalls)
	);

	assert.ok(result.report, "target_file 路径应正常出报告");
	assert.strictEqual(harness.calls.length, 1, "应派发一次子会话");
	const promptText = harness.calls[0].prompt[0].text;
	assert.ok(promptText.includes(A08_SENTENCE), "子会话 prompt 须含文件正文");
	// 归档 document.md 与源文件一致（完整正文，非抽样）。
	const archived = readFileSync(
		join(cwd, ".doc-review", result.chainId, "round-1", "document.md"),
		"utf8"
	);
	assert.strictEqual(archived, document);
	assertMatchesOutputSchema(tool, result);
});

test("target_file 边界：绝对路径与 .. 穿越、不存在文件 → 结构化参数错误，零子会话", async () => {
	const cwd = await mkdtempAsync(join(tmpdir(), "docrev-tfile-neg-"));
	const harness = makeHarness(makeReport(A08_SENTENCE));
	const tool = createDocReviewTool(harness.deps);
	const exec = makeExec(cwd, harness.concludeTurnCalls);

	await assert.rejects(
		tool.execute({ target_file: join(cwd, "original.md") }, exec),
		/拒绝绝对路径/,
		"绝对路径必须拒绝"
	);
	await assert.rejects(
		tool.execute({ target_file: "../escape.md" }, exec),
		/\.\. 穿越|逃逸工作区/,
		".. 穿越必须拒绝"
	);
	await assert.rejects(
		tool.execute({ target_file: "missing.md" }, exec),
		/文件不存在/,
		"不存在文件必须报错"
	);
	assert.strictEqual(harness.calls.length, 0, "全部参数错误路径均不得派发子会话");
});
