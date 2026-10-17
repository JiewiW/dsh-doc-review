// 一次性验证脚本：复现 session-d3898ba2 turn7-9 的成本门决策流，
// 验证「全新链首轮显式确认豁免」修复（tool.js freshChainFirstRoundAck）。
// 直接复用 lib/cost.js 的规格纯函数，判定逻辑与 tool.js beforeRun 保持一致。
import { estimateRound, judgeConfirmation } from "./lib/cost.js";

const CONFIRM_THRESHOLD = 20000;

/** 复刻 tool.js beforeRun 的拦截判定（修复后版本）。 */
function gateDecision({ inputPackageChars, mode, maxRounds, round, confirmRequested, chainState }) {
	const estimate = estimateRound({ inputPackageChars, mode });
	const chainConfirmed = chainState.confirmed === true || confirmRequested;
	const projectedCumulative = chainState.cumulativeWorstCaseTokens + estimate.worstCaseTokens;
	const cumulativeAckMatched =
		confirmRequested
		&& chainState.pendingCumulativeAck !== null
		&& chainState.pendingCumulativeAck === projectedCumulative;
	const freshChainFirstRoundAck =
		confirmRequested
		&& round === 1
		&& chainState.rounds.length === 0
		&& chainState.cumulativeWorstCaseTokens === 0;
	const judgment = judgeConfirmation({
		worstCaseTokens: estimate.worstCaseTokens,
		chainConfirmed,
		chainCumulativeTokens: chainState.cumulativeWorstCaseTokens,
		singleRoundTokens: estimate.singleRoundTokens,
		maxRounds
	});
	const intercepted = judgment.confirmationRequired && !(
		judgment.reason === "chain-cumulative-over-budget" && (cumulativeAckMatched || freshChainFirstRoundAck)
	);
	return { intercepted, reason: judgment.reason, worstCase: Math.ceil(estimate.worstCaseTokens) };
}

const freshState = { confirmed: false, cumulativeWorstCaseTokens: 0, rounds: [], pendingCumulativeAck: null };
const cases = [
	{
		name: "turn9 复现：全新链 round=1 + confirm=true（原死循环场景）→ 应放行",
		input: { inputPackageChars: 17352, mode: "full", maxRounds: 1, round: 1, confirmRequested: true, chainState: freshState },
		expectIntercepted: false
	},
	{
		name: "全新链 round=1 无 confirm → 仍应拦截（门1 worst-case-over-threshold）",
		input: { inputPackageChars: 17352, mode: "full", maxRounds: 1, round: 1, confirmRequested: false, chainState: freshState },
		expectIntercepted: true
	},
	{
		name: "小文档全新链 无 confirm → 不拦截（阈值内）",
		input: { inputPackageChars: 3000, mode: "full", maxRounds: 1, round: 1, confirmRequested: false, chainState: freshState },
		expectIntercepted: false
	},
	{
		name: "round=2 链上有已完成轮 + confirm=true 但无 pendingAck → 仍应拦截（豁免不越权）",
		input: {
			inputPackageChars: 17352, mode: "full", maxRounds: 3, round: 2, confirmRequested: true,
			chainState: { confirmed: true, cumulativeWorstCaseTokens: 48180, rounds: [{ round: 1 }], pendingCumulativeAck: null }
		},
		expectIntercepted: true
	},
	{
		name: "round=2 链上有轮 + confirm=true 且 pendingAck 匹配 → 放行（原有语义不变）",
		input: {
			inputPackageChars: 17352, mode: "full", maxRounds: 3, round: 2, confirmRequested: true,
			chainState: { confirmed: true, cumulativeWorstCaseTokens: 48180, rounds: [{ round: 1 }], pendingCumulativeAck: 96360 }
		},
		expectIntercepted: false
	}
];

let failed = 0;
for (const testCase of cases) {
	const result = gateDecision(testCase.input);
	const pass = result.intercepted === testCase.expectIntercepted;
	if (!pass) failed += 1;
	console.log(`${pass ? "PASS" : "FAIL"} | ${testCase.name} | intercepted=${result.intercepted} reason=${result.reason ?? "-"} worstCase=${result.worstCase}`);
}
console.log(failed === 0 ? "ALL PASS" : `${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
