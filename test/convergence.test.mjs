/**
 * lib/convergence.js 单元测试。
 * 运行命令（仓库根目录）：node --test test/
 * 覆盖：
 * - 3 组固定文本对（无修改/微调/大改）比率断言 0%、<3%、≥3%
 * - 边界 4 项：分母 0 空文档、\r\n 行尾、代理对字符（emoji）、reject-disputed 对齐
 * - issue 对齐新增/解决计数与人工标注样例一致
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeChangeRatio,
  alignIssues,
  judgeConvergence,
  normalizeLocationText,
  CONVERGENCE_CHANGE_RATIO_THRESHOLD_PERCENT,
  MAX_ROUNDS_HARD_LIMIT,
  EMPTY_PREV_CHANGE_RATIO_PERCENT,
  LCS_LINE_COUNT_SOFT_LIMIT,
} from '../lib/convergence.js';

/* ---------- computeChangeRatio：三组固定文本对 ---------- */

test('A08-1 无修改文本对：比率为 0%', () => {
  const document = '# 总体设计\n\n系统由三个子系统组成。\n\n接口协议见附录 A。\n';
  assert.strictEqual(computeChangeRatio(document, document), 0);
});

test('A08-2 微调文本对：比率 <3%（精确 1.0%）', () => {
  // 分母 = 9（标题）+186（X）+5（"版本 1.0" 非空白）= 200 个非空白码点
  const prevDocument = `系统总体设计说明书\n${'X'.repeat(186)}\n版本 1.0`;
  const currentDocument = `系统总体设计说明书\n${'X'.repeat(186)}\n版本 1.1`;
  const ratio = computeChangeRatio(prevDocument, currentDocument);
  assert.strictEqual(ratio, 1.0); // 分子 = 删"0"+插"1" = 2 → 2/200 = 1.0%
  assert.ok(ratio > 0, '微调不应为 0');
  assert.ok(ratio < CONVERGENCE_CHANGE_RATIO_THRESHOLD_PERCENT, '微调应低于 3% 收敛阈值');
});

test('A08-3 大改文本对：比率 ≥3%（整篇替换为 200%）', () => {
  const prevDocument = 'aaaa\nbbbb\ncccc\ndddd';
  const currentDocument = 'xxxx\nyyyy\nzzzz\nwwww';
  const ratio = computeChangeRatio(prevDocument, currentDocument);
  // 分子 = 删 16 + 插 16 = 32，分母 = 16 → 200%
  assert.strictEqual(ratio, 200);
  assert.ok(ratio >= CONVERGENCE_CHANGE_RATIO_THRESHOLD_PERCENT);
});

/* ---------- computeChangeRatio：边界用例 ---------- */

test('A08-4a 分母 0（prev 空字符串）：返回 100%', () => {
  assert.strictEqual(computeChangeRatio('', '任意新内容'), EMPTY_PREV_CHANGE_RATIO_PERCENT);
  assert.strictEqual(EMPTY_PREV_CHANGE_RATIO_PERCENT, 100);
});

test('A08-4b 分母 0（prev 纯空白/换行）：返回 100%', () => {
  assert.strictEqual(computeChangeRatio('   \n\t\n  ', '新内容'), 100);
});

test('A08-4c 分母 0 的 100% 占比在 judgeConvergence 判不收敛', () => {
  const result = judgeConvergence({
    changeRatio: computeChangeRatio('', '新文档内容'),
    currentIssues: [{ severity: 'high' }],
    recomputedNewCount: 2,
    prevRound: 0,
    maxRounds: 3,
  });
  assert.strictEqual(result.converged, false);
  assert.strictEqual(result.reason, null);
});

test('A08-5a \\r\\n 行尾：先剥 \\r 再按 \\n 切，比率 33.3%', () => {
  const prevDocument = '第一行\r\n第二行';
  const currentDocument = '第一行\r\n第三行';
  // 分子 = 删"二"+插"三" = 2，分母 = 6 → 33.333…% → 33.3%
  assert.strictEqual(computeChangeRatio(prevDocument, currentDocument), 33.3);
});

test('A08-5b \\r\\n 与 \\n 混排但内容相同：比率 0', () => {
  assert.strictEqual(computeChangeRatio('a\r\nb', 'a\nb'), 0);
});

test('A08-6a 代理对字符（emoji）：按 Unicode 码点计数', () => {
  // 😀=U+1F600(D83D DE00)，😁=U+1F601(D83D DE01)：高代理项相同。
  // 码点口径：分子 = 删😀+插😁 = 2，分母 = 2 → 100%；
  // 若误按 UTF-16 单元计数会得 66.7%（公共 D83D 被 LCS 匹配）。
  assert.strictEqual(computeChangeRatio('a😀', 'a😁'), 100);
});

test('A08-6b emoji 删除：比率 20%', () => {
  // 分母 = 😀😀end = 5 码点；分子 = 删 1 个😀 → 1/5 = 20%
  assert.strictEqual(computeChangeRatio('😀😀\nend', '😀\nend'), 20);
});

test('纯空白改动不计入分子：比率 0', () => {
  assert.strictEqual(computeChangeRatio('hello world', 'hello    world'), 0);
});

test('未配对插入块全额计入：比率 33.3%', () => {
  // prev "a\nb\nc"（分母 3），current 插入一行 "x" → 1/3 = 33.3%
  assert.strictEqual(computeChangeRatio('a\nb\nc', 'a\nx\nb\nc'), 33.3);
});

test('未配对删除块全额计入：比率 25%', () => {
  // prev "a\nx\nb\nc"（分母 4），current 删除 "x" → 1/4 = 25%
  assert.strictEqual(computeChangeRatio('a\nx\nb\nc', 'a\nb\nc'), 25);
});

test('convergence 常量导出正确', () => {
  assert.strictEqual(CONVERGENCE_CHANGE_RATIO_THRESHOLD_PERCENT, 3.0);
  assert.strictEqual(MAX_ROUNDS_HARD_LIMIT, 3);
  assert.strictEqual(EMPTY_PREV_CHANGE_RATIO_PERCENT, 100);
  assert.strictEqual(LCS_LINE_COUNT_SOFT_LIMIT, 2000);
});

/* ---------- alignIssues ---------- */

test('A08-7 id 匹配人工标注样例：new=1 resolved=2 matched=1', () => {
  const prevIssues = [
    { id: 'TS-F-01', dimension: 'fact', location: '第1章 引言', severity: 'high' },
    { id: 'TS-C-02', dimension: 'completeness', location: '第2章 需求', severity: 'medium' },
    { id: 'TS-N-03', dimension: 'necessity', location: '第3章 设计', severity: 'low' },
  ];
  const currentIssues = [
    { id: 'TS-F-01', dimension: 'fact', location: '第1章 引言', severity: 'high' },
    { id: 'TS-X-04', dimension: 'format', location: '第4章 附录', severity: 'medium' },
  ];
  // 人工标注：TS-F-01 匹配；TS-C-02/TS-N-03 解决；TS-X-04 新增
  const result = alignIssues(prevIssues, currentIssues);
  assert.strictEqual(result.newIssueCount, 1);
  assert.strictEqual(result.resolvedIssueCount, 2);
  assert.strictEqual(result.matchedCount, 1);
  assert.deepStrictEqual(result.resolvedIds, ['TS-C-02', 'TS-N-03']);
  assert.deepStrictEqual(result.newIssueIds, ['TS-X-04']);
  assert.deepStrictEqual(result.disputedResolvedIds, []);
});

test('A08-8a id 缺失时按 dimension+归一化 location 匹配', () => {
  const prevIssues = [{ dimension: 'fact', location: '  第2章  总体设计 ' }];
  const currentIssues = [{ dimension: 'fact', location: '第2章 总体设计' }];
  const result = alignIssues(prevIssues, currentIssues);
  assert.strictEqual(result.matchedCount, 1);
  assert.strictEqual(result.newIssueCount, 0);
  assert.strictEqual(result.resolvedIssueCount, 0);
});

test('A08-8b 归一化英文小写+连续空白折单空格后匹配成功', () => {
  const prevIssues = [{ dimension: 'format', location: 'Chapter TWO  Overview' }];
  const currentIssues = [{ dimension: 'format', location: 'chapter  two  overview' }];
  assert.strictEqual(alignIssues(prevIssues, currentIssues).matchedCount, 1);
});

test('A08-8c dimension 不同则不匹配：resolved=1 new=1', () => {
  const prevIssues = [{ dimension: 'fact', location: 'L1' }];
  const currentIssues = [{ dimension: 'format', location: 'L1' }];
  const result = alignIssues(prevIssues, currentIssues);
  assert.strictEqual(result.resolvedIssueCount, 1);
  assert.strictEqual(result.newIssueCount, 1);
  assert.strictEqual(result.matchedCount, 0);
});

test('A08-8d location 归一化截前 80 码点：前 80 相同即匹配', () => {
  const longTailA = `${'x'.repeat(80)}AAA`;
  const longTailB = `${'x'.repeat(80)}BBB`;
  assert.strictEqual(normalizeLocationText(longTailA), 'x'.repeat(80));
  const result = alignIssues(
    [{ dimension: 'fact', location: longTailA }],
    [{ dimension: 'fact', location: longTailB }],
  );
  assert.strictEqual(result.matchedCount, 1);
});

test('A08-9a 裁决 reject 且未再出现：计 resolved 并标 disputed', () => {
  const prevIssues = [
    { id: 'TS-F-01', dimension: 'fact', location: 'L1' },
    { id: 'TS-F-02', dimension: 'fact', location: 'L2' },
  ];
  const currentIssues = [{ id: 'TS-F-02', dimension: 'fact', location: 'L2' }];
  const adjudication = [
    { id: 'TS-F-01', decision: 'reject', reason: '审查员误判', applied_change: '无' },
  ];
  const result = alignIssues(prevIssues, currentIssues, adjudication);
  assert.strictEqual(result.resolvedIssueCount, 1);
  assert.deepStrictEqual(result.resolvedIds, ['TS-F-01']);
  assert.deepStrictEqual(result.disputedResolvedIds, ['TS-F-01']);
  assert.strictEqual(result.newIssueCount, 0);
});

test('A08-9b reject 但又再出现：不计 resolved、不标 disputed', () => {
  const prevIssues = [{ id: 'A', dimension: 'fact', location: 'L1' }];
  const currentIssues = [{ id: 'A', dimension: 'fact', location: 'L1' }];
  const result = alignIssues(prevIssues, currentIssues, [{ id: 'A', decision: 'reject' }]);
  assert.strictEqual(result.resolvedIssueCount, 0);
  assert.deepStrictEqual(result.disputedResolvedIds, []);
  assert.strictEqual(result.matchedCount, 1);
});

test('A08-9c 裁决表对象映射两种形态兼容', () => {
  const prevIssues = [{ id: 'A', dimension: 'fact', location: 'L1' }];
  const currentIssues = [];
  const withStringDecision = alignIssues(prevIssues, currentIssues, { A: 'reject' });
  assert.deepStrictEqual(withStringDecision.disputedResolvedIds, ['A']);
  const withObjectDecision = alignIssues(prevIssues, currentIssues, { A: { decision: 'reject' } });
  assert.deepStrictEqual(withObjectDecision.disputedResolvedIds, ['A']);
});

test('A08-9d accept 裁决：计 resolved 但不标 disputed', () => {
  const prevIssues = [{ id: 'A', dimension: 'fact', location: 'L1' }];
  const result = alignIssues(prevIssues, [], [{ id: 'A', decision: 'accept' }]);
  assert.strictEqual(result.resolvedIssueCount, 1);
  assert.deepStrictEqual(result.disputedResolvedIds, []);
});

test('alignIssues 空/非法输入安全：全零', () => {
  for (const [prevIssues, currentIssues] of [[undefined, undefined], [[], []], ['not-array', null]]) {
    const result = alignIssues(prevIssues, currentIssues);
    assert.strictEqual(result.newIssueCount, 0);
    assert.strictEqual(result.resolvedIssueCount, 0);
    assert.strictEqual(result.matchedCount, 0);
  }
});

test('normalizeLocationText：trim+折空白+小写+截 80 码点（emoji 不拆半）', () => {
  assert.strictEqual(normalizeLocationText('  A  B  '), 'a b');
  assert.strictEqual(normalizeLocationText(undefined), '');
  assert.strictEqual(Array.from(normalizeLocationText('😀'.repeat(81))).length, 80);
});

/* ---------- judgeConvergence ---------- */

test('占比 <3.0 命中 change-ratio-below-threshold（优先于其他条件）', () => {
  const result = judgeConvergence({
    changeRatio: 2.9,
    currentIssues: [{ severity: 'high' }],
    recomputedNewCount: 5,
    prevRound: 3,
    maxRounds: 3,
  });
  assert.strictEqual(result.converged, true);
  assert.strictEqual(result.reason, 'change-ratio-below-threshold');
});

test('占比恰为 3.0 不命中阈值条件（严格小于）', () => {
  const result = judgeConvergence({
    changeRatio: 3.0,
    currentIssues: [{ severity: 'high' }],
    recomputedNewCount: 1,
    prevRound: 0,
    maxRounds: 3,
  });
  assert.strictEqual(result.converged, false);
  assert.strictEqual(result.reason, null);
});

test('无 high 且复算新增=0 命中 no-high-severity-and-no-new-issues', () => {
  const result = judgeConvergence({
    changeRatio: 50,
    currentIssues: [{ severity: 'medium' }, { severity: 'low' }],
    recomputedNewCount: 0,
    prevRound: 1,
    maxRounds: 3,
  });
  assert.strictEqual(result.converged, true);
  assert.strictEqual(result.reason, 'no-high-severity-and-no-new-issues');
});

test('prevRound≥maxRounds 命中 max-rounds-reached', () => {
  const result = judgeConvergence({
    changeRatio: 50,
    currentIssues: [{ severity: 'high' }],
    recomputedNewCount: 2,
    prevRound: 3,
    maxRounds: 3,
  });
  assert.strictEqual(result.converged, true);
  assert.strictEqual(result.reason, 'max-rounds-reached');
});

test('maxRounds 超硬上限被夹紧到 3', () => {
  const result = judgeConvergence({
    changeRatio: 50,
    currentIssues: [{ severity: 'high' }],
    recomputedNewCount: 1,
    prevRound: 3,
    maxRounds: 10,
  });
  assert.strictEqual(result.converged, true);
  assert.strictEqual(result.reason, 'max-rounds-reached');
});

test('maxRounds 缺省为 3、下界夹紧为 1', () => {
  const defaultMax = judgeConvergence({
    changeRatio: 50,
    currentIssues: [{ severity: 'high' }],
    recomputedNewCount: 1,
    prevRound: 3,
  });
  assert.strictEqual(defaultMax.reason, 'max-rounds-reached');
  const clampedLow = judgeConvergence({
    changeRatio: 50,
    currentIssues: [{ severity: 'high' }],
    recomputedNewCount: 1,
    prevRound: 1,
    maxRounds: 0,
  });
  assert.strictEqual(clampedLow.converged, true);
  assert.strictEqual(clampedLow.reason, 'max-rounds-reached');
});

test('三条均不满足：converged=false reason=null', () => {
  const result = judgeConvergence({
    changeRatio: 8.8,
    currentIssues: [{ severity: 'high' }],
    recomputedNewCount: 2,
    prevRound: 1,
    maxRounds: 3,
  });
  assert.strictEqual(result.converged, false);
  assert.strictEqual(result.reason, null);
});

test('judgeConvergence 返回形状：五字段，newIssues=复算值、resolvedIssues 透传', () => {
  const result = judgeConvergence({
    changeRatio: 1.2,
    currentIssues: [],
    recomputedNewCount: 0,
    prevRound: 1,
    maxRounds: 3,
    resolvedIssues: 4,
  });
  assert.deepStrictEqual(Object.keys(result).sort(), [
    'changeRatio', 'converged', 'newIssues', 'reason', 'resolvedIssues',
  ]);
  assert.strictEqual(result.changeRatio, 1.2);
  assert.strictEqual(result.newIssues, 0);
  assert.strictEqual(result.resolvedIssues, 4);
  const defaultResolved = judgeConvergence({
    changeRatio: 1.2, currentIssues: [], recomputedNewCount: 0, prevRound: 1,
  });
  assert.strictEqual(defaultResolved.resolvedIssues, 0);
});
