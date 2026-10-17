/**
 * lib/cost.js 单元测试。
 * 运行命令（仓库根目录）：node --test test/
 * 覆盖：
 * - 最坏口径 >20k 断言 confirmationRequired=true
 * - chainConfirmed=true 断言放行
 * - 链累计超限断言再次拦截
 * - sample 抽样断言段落数 ≈30%（±1 段）且维度=[fact,format]
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  estimateRound,
  judgeConfirmation,
  buildSamplePlan,
  normalizeMode,
  normalizeMaxRounds,
  CHARS_PER_TOKEN_CONSERVATIVE,
  EXPECTED_OUTPUT_TOKENS,
  RETRY_LIMIT,
  CONFIRM_TOKEN_THRESHOLD,
  DEFAULT_MAX_ROUNDS,
  MAX_ROUNDS_HARD_LIMIT,
  SAMPLE_PARAGRAPH_RATIO,
  ALL_DIMENSIONS,
  SAMPLE_DIMENSIONS,
  FACT_ONLY_DIMENSIONS,
} from '../lib/cost.js';

/* ---------- estimateRound ---------- */

test('estimateRound：12000 字符 → 单轮 11600、最坏 34800', () => {
  const result = estimateRound({ inputPackageChars: 12000, mode: 'full' });
  assert.strictEqual(result.singleRoundTokens, 11600); // 12000/1.2 + 1600
  assert.strictEqual(result.worstCaseTokens, 34800); // 11600 × (1+2)
  assert.strictEqual(result.mode, 'full');
  assert.strictEqual(result.inputPackageChars, 12000);
  assert.deepStrictEqual(result.assumption, {
    charsPerToken: CHARS_PER_TOKEN_CONSERVATIVE,
    expectedOutputTokens: EXPECTED_OUTPUT_TOKENS,
    retryLimit: RETRY_LIMIT,
  });
});

test('estimateRound：0 字符 → 单轮 1600（仅预期输出）、最坏 4800', () => {
  const result = estimateRound({ inputPackageChars: 0, mode: 'sample' });
  assert.strictEqual(result.singleRoundTokens, 1600);
  assert.strictEqual(result.worstCaseTokens, 4800);
  assert.strictEqual(result.mode, 'sample');
});

test('estimateRound：非法入参回退（chars→0、mode→full）', () => {
  const result = estimateRound({ inputPackageChars: 'abc', mode: 'no-such-mode' });
  assert.strictEqual(result.inputPackageChars, 0);
  assert.strictEqual(result.singleRoundTokens, 1600);
  assert.strictEqual(result.mode, 'full');
  const empty = estimateRound({});
  assert.strictEqual(empty.worstCaseTokens, 4800);
});

test('estimateRound：mode 不改变估算公式（三种 mode 同 chars 同结果）', () => {
  const byMode = ['full', 'sample', 'fact-only'].map((mode) =>
    estimateRound({ inputPackageChars: 6000, mode }).worstCaseTokens);
  // 6000/1.2 + 1600 = 6600；6600 × 3 = 19800
  assert.deepStrictEqual(byMode, [19800, 19800, 19800]);
});

/* ---------- judgeConfirmation ---------- */

test('A10-1 最坏口径 >20000 且链未确认 → confirmationRequired=true', () => {
  const result = judgeConfirmation({
    worstCaseTokens: 34800,
    chainConfirmed: false,
    chainCumulativeTokens: 0,
    maxRounds: 3,
  });
  assert.strictEqual(result.confirmationRequired, true);
  assert.strictEqual(result.reason, 'worst-case-over-threshold');
  assert.strictEqual(result.estimateDetail.singleRoundTokens, 11600); // 由 worst/3 反推
  assert.strictEqual(result.estimateDetail.worstCaseTokens, 34800);
  assert.strictEqual(result.estimateDetail.chainCumulativeTokens, 34800); // 0 + 本轮最坏
  assert.strictEqual(result.estimateDetail.chainBudgetTokens, 60000);
  assert.strictEqual(result.estimateDetail.thresholdTokens, 20000);
});

test('A10-2 chainConfirmed=true → 放行（链级 confirm 绑定 chain_id 有效）', () => {
  const result = judgeConfirmation({
    worstCaseTokens: 34800,
    chainConfirmed: true,
    chainCumulativeTokens: 0,
    maxRounds: 3,
  });
  assert.strictEqual(result.confirmationRequired, false);
  assert.strictEqual(result.reason, null);
});

test('A10-3 链累计预估超限 → 再次拦截（chainConfirmed 不豁免）', () => {
  const result = judgeConfirmation({
    worstCaseTokens: 34800,
    chainConfirmed: true,
    chainCumulativeTokens: 50000,
    maxRounds: 3,
  });
  // 链累计预估 = 50000 + 34800 = 84800 > 20000×3 = 60000
  assert.strictEqual(result.confirmationRequired, true);
  assert.strictEqual(result.reason, 'chain-cumulative-over-budget');
  assert.strictEqual(result.estimateDetail.chainCumulativeTokens, 84800);
  assert.strictEqual(result.estimateDetail.chainBudgetTokens, 60000);
});

test('judgeConfirmation：最坏恰为 20000 不触发（严格大于）', () => {
  const result = judgeConfirmation({
    worstCaseTokens: 20000,
    chainConfirmed: false,
    chainCumulativeTokens: 0,
    maxRounds: 3,
  });
  assert.strictEqual(result.confirmationRequired, false);
});

test('judgeConfirmation：未确认且链累计超限 → 单轮阈值条件优先', () => {
  const result = judgeConfirmation({
    worstCaseTokens: 34800,
    chainConfirmed: false,
    chainCumulativeTokens: 50000,
    maxRounds: 3,
  });
  assert.strictEqual(result.reason, 'worst-case-over-threshold');
});

test('judgeConfirmation：maxRounds 缺省 1（预算=20000）、夹紧 [1,3]', () => {
  const defaultRounds = judgeConfirmation({ worstCaseTokens: 10000, chainCumulativeTokens: 20000 });
  assert.strictEqual(defaultRounds.estimateDetail.maxRounds, DEFAULT_MAX_ROUNDS);
  assert.strictEqual(defaultRounds.estimateDetail.chainBudgetTokens, 20000);
  // 累计预估 30000 > 20000 → 拦截
  assert.strictEqual(defaultRounds.confirmationRequired, true);
  assert.strictEqual(defaultRounds.reason, 'chain-cumulative-over-budget');

  const clamped = judgeConfirmation({ worstCaseTokens: 1000, maxRounds: 99 });
  assert.strictEqual(clamped.estimateDetail.maxRounds, MAX_ROUNDS_HARD_LIMIT);
  assert.strictEqual(clamped.estimateDetail.chainBudgetTokens, 60000);
});

test('judgeConfirmation：chainCumulativeIncludesCurrentRound=true 不重复加本轮', () => {
  const result = judgeConfirmation({
    worstCaseTokens: 10000,
    chainCumulativeTokens: 25000, // 已含本轮
    chainCumulativeIncludesCurrentRound: true,
    maxRounds: 1, // 预算 20000；25000 > 20000 → 拦截
  });
  assert.strictEqual(result.estimateDetail.chainCumulativeTokens, 25000);
  assert.strictEqual(result.confirmationRequired, true);
  const safe = judgeConfirmation({
    worstCaseTokens: 10000,
    chainCumulativeTokens: 15000,
    chainCumulativeIncludesCurrentRound: true,
    maxRounds: 1,
  });
  assert.strictEqual(safe.estimateDetail.chainCumulativeTokens, 15000);
  assert.strictEqual(safe.confirmationRequired, false);
});

test('judgeConfirmation：singleRoundTokens 显式传入时原样回传', () => {
  const result = judgeConfirmation({
    worstCaseTokens: 34800,
    singleRoundTokens: 11600,
    chainConfirmed: true,
    maxRounds: 3,
  });
  assert.strictEqual(result.estimateDetail.singleRoundTokens, 11600);
});

test('端到端：estimateRound → judgeConfirmation（12000 字符 full 模式被拦截，confirm 后放行）', () => {
  const estimate = estimateRound({ inputPackageChars: 12000, mode: 'full' });
  const blocked = judgeConfirmation({
    worstCaseTokens: estimate.worstCaseTokens,
    chainConfirmed: false,
    chainCumulativeTokens: 0,
    maxRounds: 3,
  });
  assert.strictEqual(blocked.confirmationRequired, true);
  const allowed = judgeConfirmation({
    worstCaseTokens: estimate.worstCaseTokens,
    singleRoundTokens: estimate.singleRoundTokens,
    chainConfirmed: true,
    chainCumulativeTokens: 0,
    maxRounds: 3,
  });
  assert.strictEqual(allowed.confirmationRequired, false);
});

/* ---------- buildSamplePlan ---------- */

/**
 * 构造 n 章 × 5 段的 markdown 文档（每章一个标题行 + 5 个段落）。
 * @param {number} sectionCount
 * @returns {string}
 */
function buildSectionedDocument(sectionCount) {
  const parts = [];
  for (let sectionIndex = 1; sectionIndex <= sectionCount; sectionIndex += 1) {
    const paragraphs = [];
    for (let paragraphIndex = 1; paragraphIndex <= 5; paragraphIndex += 1) {
      paragraphs.push(`第${sectionIndex}章的第${paragraphIndex}个段落。`);
    }
    parts.push(`# 第${sectionIndex}章\n\n${paragraphs.join('\n\n')}`);
  }
  return parts.join('\n\n');
}

test('buildSamplePlan full：文本原样、全四维度', () => {
  const document = buildSectionedDocument(2);
  const result = buildSamplePlan(document, 'full');
  assert.strictEqual(result.sampledText, document);
  assert.deepStrictEqual(result.activeDimensions, ['fact', 'completeness', 'necessity', 'format']);
  assert.deepStrictEqual(result.activeDimensions, [...ALL_DIMENSIONS]);
  assert.strictEqual(result.mode, 'full');
  assert.strictEqual(result.samplingDetail.sampled, false);
  assert.strictEqual(result.samplingDetail.originalParagraphCount, 10);
});

test('buildSamplePlan 缺省 mode → full', () => {
  const result = buildSamplePlan('只有一段。');
  assert.strictEqual(result.mode, 'full');
  assert.deepStrictEqual(result.activeDimensions, [...ALL_DIMENSIONS]);
});

test('buildSamplePlan fact-only：文本原样、仅 fact 维度', () => {
  const document = buildSectionedDocument(2);
  const result = buildSamplePlan(document, 'fact-only');
  assert.strictEqual(result.sampledText, document);
  assert.deepStrictEqual(result.activeDimensions, ['fact']);
  assert.deepStrictEqual(result.activeDimensions, [...FACT_ONLY_DIMENSIONS]);
  assert.strictEqual(result.samplingDetail.sampled, false);
});

test('A10-4 sample：4 章 ×5 段=20 段 → 抽 6 段（≈30% ±1）、维度=[fact,format]', () => {
  const document = buildSectionedDocument(4);
  const result = buildSamplePlan(document, 'sample');
  assert.deepStrictEqual(result.activeDimensions, ['fact', 'format']);
  assert.deepStrictEqual(result.activeDimensions, [...SAMPLE_DIMENSIONS]);
  assert.strictEqual(result.mode, 'sample');
  assert.strictEqual(result.samplingDetail.sampled, true);
  assert.strictEqual(result.samplingDetail.originalParagraphCount, 20);

  const expectedCount = Math.round(20 * SAMPLE_PARAGRAPH_RATIO); // 6
  assert.strictEqual(result.samplingDetail.sampledParagraphCount, expectedCount);
  // 验收断言：段落数 ≈30%（±1 段）
  assert.ok(Math.abs(result.samplingDetail.sampledParagraphCount - 20 * 0.3) <= 1);

  // 抽样文本中实际非标题文本块数 = 6（±1 容差内），且确为原文段落、体量收缩
  const sampledParagraphBlocks = result.sampledText
    .split('\n\n')
    .filter((block) => block.trim() !== '' && !/^#{1,6}\s+\S/.test(block));
  assert.ok(Math.abs(sampledParagraphBlocks.length - 20 * 0.3) <= 1);
  assert.ok(result.sampledText.length < document.length);
  for (const block of sampledParagraphBlocks) {
    assert.ok(document.includes(block), '抽样段落必须是原文子串');
  }
  // 被抽中章节的标题保留
  assert.ok(/^# 第\d章$/m.test(result.sampledText));
});

test('A10-5 sample：2 章 ×5 段=10 段 → 抽 3 段（±1 断言通过）', () => {
  const result = buildSamplePlan(buildSectionedDocument(2), 'sample');
  assert.strictEqual(result.samplingDetail.originalParagraphCount, 10);
  assert.strictEqual(result.samplingDetail.sampledParagraphCount, 3); // round(10×0.3)=3
  assert.ok(Math.abs(3 - 10 * 0.3) <= 1);
  assert.deepStrictEqual(result.activeDimensions, ['fact', 'format']);
});

test('sample：单段落文档至少抽 1 段', () => {
  const result = buildSamplePlan('# 唯一章\n\n仅有一段内容。', 'sample');
  assert.strictEqual(result.samplingDetail.originalParagraphCount, 1);
  assert.strictEqual(result.samplingDetail.sampledParagraphCount, 1);
  assert.ok(result.sampledText.includes('仅有一段内容。'));
});

test('sample：空文档安全返回', () => {
  const result = buildSamplePlan('', 'sample');
  assert.strictEqual(result.sampledText, '');
  assert.strictEqual(result.samplingDetail.originalParagraphCount, 0);
  assert.strictEqual(result.samplingDetail.sampledParagraphCount, 0);
  assert.deepStrictEqual(result.activeDimensions, ['fact', 'format']);
});

test('sample：无标题前言章节也参与抽样', () => {
  const document = '前言段落一。\n\n前言段落二。\n\n# 第一章\n\n正文段落一。';
  const result = buildSamplePlan(document, 'sample');
  // 3 段 → round(0.9)=1 段
  assert.strictEqual(result.samplingDetail.originalParagraphCount, 3);
  assert.strictEqual(result.samplingDetail.sampledParagraphCount, 1);
});

test('sample：等距抽样跨章节均匀（索引 floor(i×N/target)）', () => {
  // 20 段抽 6 段：索引 floor(i×20/6)=0,3,6,10,13,16 → 章1 两段、章2 两段、章3 一段、章4 一段
  const result = buildSamplePlan(buildSectionedDocument(4), 'sample');
  assert.ok(result.sampledText.includes('第1章的第1个段落。')); // idx 0
  assert.ok(result.sampledText.includes('第1章的第4个段落。')); // idx 3
  assert.ok(result.sampledText.includes('第2章的第2个段落。')); // idx 6
  assert.ok(!result.sampledText.includes('第1章的第2个段落。')); // idx 1 未抽中
  assert.strictEqual(result.samplingDetail.sampledSectionCount, 4);
});

test('非法 mode 退回 full（最保守：原样文本+全维度）', () => {
  const document = buildSectionedDocument(1);
  const result = buildSamplePlan(document, 'quick-scan');
  assert.strictEqual(result.mode, 'full');
  assert.strictEqual(result.sampledText, document);
  assert.deepStrictEqual(result.activeDimensions, [...ALL_DIMENSIONS]);
  assert.strictEqual(normalizeMode('quick-scan'), 'full');
});

test('normalizeMode / normalizeMaxRounds 辅助导出', () => {
  assert.strictEqual(normalizeMode('sample'), 'sample');
  assert.strictEqual(normalizeMode('fact-only'), 'fact-only');
  assert.strictEqual(normalizeMode(undefined), 'full');
  assert.strictEqual(normalizeMaxRounds(undefined), DEFAULT_MAX_ROUNDS);
  assert.strictEqual(normalizeMaxRounds(2), 2);
  assert.strictEqual(normalizeMaxRounds(99), MAX_ROUNDS_HARD_LIMIT);
  assert.strictEqual(normalizeMaxRounds(0), 1);
  assert.strictEqual(normalizeMaxRounds('bad'), DEFAULT_MAX_ROUNDS);
});

test('cost 常量导出正确', () => {
  assert.strictEqual(CHARS_PER_TOKEN_CONSERVATIVE, 1.2);
  assert.strictEqual(EXPECTED_OUTPUT_TOKENS, 1600);
  assert.strictEqual(RETRY_LIMIT, 2);
  assert.strictEqual(CONFIRM_TOKEN_THRESHOLD, 20000);
  assert.strictEqual(DEFAULT_MAX_ROUNDS, 1);
  assert.strictEqual(MAX_ROUNDS_HARD_LIMIT, 3);
  assert.strictEqual(SAMPLE_PARAGRAPH_RATIO, 0.3);
});
