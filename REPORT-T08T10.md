# REPORT-T08T10 —— B 卡完成报告（lib/convergence.js + lib/cost.js + 单测）

> 卡片：B 卡（T08 多轮与收敛判断、T10 成本预估与分级模式）
> 日期：2026-10-11 ｜ 依据：`D:\dsh\docs\doc-review-plugin-taskbook.md` v1.2 + B 卡任务 Prompt 写死规格
> 运行环境：node v24.21.0，Windows，ESM（`package.json "type":"module"`），**零第三方依赖**（两模块未 import 任何外部包）

## 0. 产物清单（仅本卡 5 个自产文件，未触碰 A 卡范围文件）

| 文件 | 说明 |
| --- | --- |
| `D:\dsh\dsh-doc-review\lib\convergence.js` | T08：computeChangeRatio / alignIssues / judgeConvergence（515 行） |
| `D:\dsh\dsh-doc-review\lib\cost.js` | T10：estimateRound / judgeConfirmation / buildSamplePlan |
| `D:\dsh\dsh-doc-review\test\convergence.test.mjs` | T08 单测 33 条 |
| `D:\dsh\dsh-doc-review\test\cost.test.mjs` | T10 单测 25 条 |
| `D:\dsh\dsh-doc-review\REPORT-T08T10.md` | 本报告 |

## 1. 单测结果（验收命令与证据）

- **结果：tests 58，pass 58，fail 0，退出码 0。**
- 证据日志：`D:\dsh\logs\b-card-test-r1.log`（显式文件清单方式全绿）；`D:\dsh\logs\b-card-node-test-run3.log`（修复前 56/58，含 2 处失败详情）。
- ⚠️ **验收命令字面形式在 node v24.21.0 上不可用**：`node --test D:\dsh\dsh-doc-review\test\`（目录裸参数）报 `Error: Cannot find module 'D:\dsh\dsh-doc-review\test'`——node 24 把位置参数按文件/glob 解析，**目录裸参数会被当模块加载**（run1/run2 日志在 `D:\dsh\logs\b-card-node-test-run*.log`）。等效全绿命令（三选一，均已实测退出码 0、58/58）：
  1. `cd D:\dsh\dsh-doc-review` 后 `node --test`（默认发现 test/ 下 *.test.mjs）；
  2. `node --test test\convergence.test.mjs test\cost.test.mjs`；
  3. `node --test "test/*.test.mjs"`（glob 形式）。
  建议 A/C 卡与 CI 采用形式 1 或 3。

### 1.1 通过清单 —— test/convergence.test.mjs（33 条）

**computeChangeRatio（14 条）**：A08-1 无修改=0%；A08-2 微调=1.0%（<3%，人工精算分子 2/分母 200）；A08-3 大改=200%（≥3%）；A08-4a prev 空串→100；A08-4b prev 纯空白→100；A08-4c 分母 0 的 100% 在 judgeConvergence 判不收敛；A08-5a `\r\n` 行尾=33.3%；A08-5b `\r\n` vs `\n` 同内容=0；A08-6a emoji 替换（代理对按码点）=100（UTF-16 误计会得 66.7）；A08-6b emoji 删除=20%；纯空白改动=0；未配对插入块全额=33.3%；未配对删除块全额=25%；常量导出核对（3.0/3/100/2000）。

**alignIssues（10 条）**：A08-7 id 匹配人工标注样例（prev 3 条、current 2 条 → matched=1、resolved=2〔TS-C-02,TS-N-03〕、new=1〔TS-X-04〕）；A08-8a id 缺失按 dimension+归一化 location 匹配（含首尾/连续空白差异）；A08-8b 英文小写+折空白归一化匹配；A08-8c dimension 不同不匹配（resolved=1 new=1）；A08-8d location 截前 80 码点（前 80 相同即匹配）；A08-9a reject 且未再出现→resolved+disputed；A08-9b reject 但又再出现→不 resolved 不 disputed；A08-9c 裁决表数组形态与对象映射形态（字符串值/`{decision}` 值）兼容；A08-9d accept→resolved 不 disputed；空/非法输入安全全零。

**normalizeLocationText（1 条）**：trim+连续空白折单空格+英文小写+按码点截 80（emoji 不拆半）。

**judgeConvergence（8 条）**：占比<3.0 命中 `change-ratio-below-threshold`（优先于其他条件）；占比恰 3.0 不命中（严格小于）；无 high 且复算新增=0 命中 `no-high-severity-and-no-new-issues`；prevRound≥maxRounds 命中 `max-rounds-reached`；maxRounds=10 夹紧 3；maxRounds 缺省 3、下界夹紧 1；三条均不满足→converged=false reason=null；返回形状恰为五字段 `{changeRatio,newIssues,resolvedIssues,converged,reason}` 且 newIssues=复算值、resolvedIssues 透传（缺省 0）。

### 1.2 通过清单 —— test/cost.test.mjs（25 条）

**estimateRound（4 条）**：12000 字符→单轮 11600/最坏 34800（assumption 三系数核对）；0 字符→1600/4800；非法入参回退（chars→0、mode→full）；三种 mode 同 chars 同结果（6000→最坏 19800，证明 mode 不改公式）。

**judgeConfirmation（8 条）**：A10-1 最坏 34800>20000 且未确认→true/`worst-case-over-threshold`（estimateDetail 六字段核对，含链累计预估 34800、预算 60000）；A10-2 chainConfirmed=true→放行 false/null；A10-3 链累计 50000+34800=84800>60000→**chainConfirmed 不豁免**，true/`chain-cumulative-over-budget`；最坏恰 20000 不触发（严格大于）；双条件同时成立时单轮阈值 reason 优先；maxRounds 缺省 1（预算 20000）、超界夹紧 3；`chainCumulativeIncludesCurrentRound=true` 不重复加本轮（正反两例）；singleRoundTokens 显式传入原样回传；**端到端**：estimateRound(12000,full)→judgeConfirmation 拦截→confirm 后放行。

**buildSamplePlan（11 条）**：full 原样+四维度（2 章×5 段文档段落数=10，标题不计）；缺省 mode→full；fact-only 原样+仅 fact；A10-4 sample 20 段抽 6 段（=round(20×0.3)，±1 断言过）、维度=[fact,format]、抽中段落均为原文子串、体量收缩、章节标题保留；A10-5 sample 10 段抽 3 段（±1 断言过）；单段落至少抽 1；空文档安全；无标题前言章节参与抽样；等距索引可预期（20 抽 6→idx 0,3,6,10,13,16，跨 4 章均匀，未抽中段落不出现）；非法 mode 退回 full。

**辅助与常量（2 条）**：normalizeMode/normalizeMaxRounds 行为；7 个常量值核对。

## 2. 导出函数签名契约（供 A 卡 T02b 字段与 C 卡集成直接引用）

均为 **named export**；`test/*.mjs` 导入方式：`import { … } from '../lib/convergence.js'`。

### 2.1 lib/convergence.js

```js
// ① 修改占比（%），四舍五入到 0.1%
computeChangeRatio(prevDocument: string, currentDocument: string): number
// 示例：computeChangeRatio('a\nb\nc', 'a\nx\nb\nc') === 33.3
// 语义：分母=prev 非空白码点数；分母 0 → 返回 100（EMPTY_PREV_CHANGE_RATIO_PERCENT）；
//       分子=行级 LCS 变动块的增删非空白码点数（delete 块与紧随 insert 块 1:1 配对做码点级 LCS，
//       配对块计入「删除+插入」两侧，未配对块全额计入）；
//       行切分先剥 \r 再按 \n；码点=Array.from（代理对不拆半）；不做 Unicode 归一化/全半角折叠。

// ② issue 跨轮对齐（复算新增数，审查员初判 newIssueCount 仅参考）
alignIssues(
  prevIssues: Issue[],            // {id?, dimension?, location?, severity?, …}（T02a 字段）
  currentIssues: Issue[],
  adjudication?: AdjudicationEntry[] | Record<string, 'accept'|'partial'|'reject' | {decision: string}>
): {
  newIssueCount: number,          // 复算新增数 → 传给 judgeConvergence.recomputedNewCount
  resolvedIssueCount: number,     // → 传给 judgeConvergence.resolvedIssues
  matchedCount: number,
  resolvedIds: Array<string|undefined>,
  newIssueIds: Array<string|undefined>,
  disputedResolvedIds: Array<string>   // reject 裁决且未再出现（disputed:true 语义）
}
// 匹配：①id 相等（非空字符串）优先；②备选键 dimension+'\u0000'+normalizeLocationText(location)，
// 贪心一对一先到先得。adjudication 数组形态即 T07 模板 [{id, decision, reason, applied_change}]。

// ③ 收敛终止判定（满足任一即 converged，reason=首个命中条件名）
judgeConvergence({
  changeRatio: number,            // computeChangeRatio 结果（百分数）
  currentIssues: Array<{severity?: string}>,
  recomputedNewCount: number,     // alignIssues().newIssueCount（勿传审查员初判）
  prevRound: number,
  maxRounds?: number,             // 缺省 3；夹紧 [1,3]（MAX_ROUNDS_HARD_LIMIT，任务书 P07）
  resolvedIssues?: number         // 便利回传字段，缺省 0（见偏差 D1）
}): {
  changeRatio: number, newIssues: number, resolvedIssues: number,
  converged: boolean,
  reason: 'change-ratio-below-threshold' | 'no-high-severity-and-no-new-issues' | 'max-rounds-reached' | null
}
// 判定顺序：changeRatio<3.0 → 无 severity==='high' 且 recomputedNewCount===0 → prevRound>=maxRounds。
// 示例：judgeConvergence({changeRatio:2.9, currentIssues:[{severity:'high'}], recomputedNewCount:5,
//         prevRound:3, maxRounds:3}) → {converged:true, reason:'change-ratio-below-threshold', …}

// ④ location 归一化（对齐用，导出供测试/上层复用）
normalizeLocationText(location: unknown): string
// trim → 连续空白折单空格 → toLowerCase → 按码点截前 80（LOCATION_NORMALIZE_MAX_CODE_POINTS）。

// 常量：CONVERGENCE_CHANGE_RATIO_THRESHOLD_PERCENT=3.0，MAX_ROUNDS_HARD_LIMIT=3，
//       EMPTY_PREV_CHANGE_RATIO_PERCENT=100，LCS_LINE_COUNT_SOFT_LIMIT=2000。
```

**C 卡集成注意**：多轮链断裂判定不在本模块（任务书 T08 数据源次序=归档 `.doc-review/<chain_id>/round-<prev_round>/document.md` 读回 → `prev_document` 参数兜底 → 皆无返回结构化错误「多轮链断裂」不派子会话，全部由调用方实现；`computeChangeRatio` 只接收调用方已取回的 prevDocument）。

### 2.2 lib/cost.js

```js
// ① 单轮 token 预估（任务书 P06：字符/1.2 + 输出 1600；最坏 = 单轮 ×(1+重试 2)）
estimateRound({
  inputPackageChars: number,      // 本轮输入包字符数（非法→0+warn）
  mode?: 'full'|'sample'|'fact-only'   // 缺省/非法→'full'；不影响公式（见偏差 D2）
}): {
  singleRoundTokens: number,      // = chars/1.2 + 1600（浮点不取整）
  worstCaseTokens: number,        // = single × 3
  mode: string, inputPackageChars: number,
  assumption: {charsPerToken: 1.2, expectedOutputTokens: 1600, retryLimit: 2}
}
// 示例：estimateRound({inputPackageChars:12000, mode:'full'})
//   → {singleRoundTokens:11600, worstCaseTokens:34800, …}

// ② 确认拦截判定
judgeConfirmation({
  worstCaseTokens: number,        // estimateRound().worstCaseTokens
  chainConfirmed?: boolean,       // 该 chain_id 已获链级 confirm（缺省 false）
  chainCumulativeTokens?: number, // 链上已累计预估（缺省 0；调用方负责链级持久化累计）
  maxRounds?: number,             // 缺省 1（DEFAULT_MAX_ROUNDS，任务书 T03）；夹紧 [1,3]
  singleRoundTokens?: number,     // 缺省由 worstCaseTokens/3 反推
  chainCumulativeIncludesCurrentRound?: boolean  // 累计已含本轮时置 true，缺省 false
}): {
  confirmationRequired: boolean,
  reason: 'worst-case-over-threshold' | 'chain-cumulative-over-budget' | null,
  estimateDetail: {
    singleRoundTokens: number, worstCaseTokens: number,
    chainCumulativeTokens: number,  // 链累计预估（= 传入累计 + 本轮最坏，或已含本轮）
    chainBudgetTokens: number,      // = 20000 × maxRounds
    thresholdTokens: 20000, maxRounds: number, chainConfirmed: boolean
  }
}
// 规则：最坏>20000 且 !chainConfirmed → 拦截；否则链累计预估>20000×maxRounds → 再次拦截
//（chainConfirmed 不豁免链级预算，见偏差 D5）；两者皆否 → 放行。

// ③ 分级抽样计划
buildSamplePlan(documentText: string, mode?: string): {
  sampledText: string,            // full/fact-only=原样；sample=抽样重组文本
  activeDimensions: string[],     // full=['fact','completeness','necessity','format']；
                                  // fact-only=['fact']；sample=['fact','format']
  mode: string,                   // 归一化后的 mode（非法→'full'）
  samplingDetail: {
    originalParagraphCount: number, sampledParagraphCount: number,
    sectionCount: number, sampledSectionCount: number, sampled: boolean
  }
}
// sample 口径：章节=/^#{1,6}\s+\S/ 标题行切分（首个标题前内容为无标题前言章节）；
// 段落=章节正文按空行切分的非空文本块（标题行不计段落）；
// 对全文段落序列等距抽 round(N×0.3)（至少 1）段（索引 floor(i×N/target)，去重升序）；
// 被抽中段落所属章节标题保留，章节间/标题-段落间以 '\n\n' 连接。
// 示例：buildSamplePlan('# A\n\np1\n\np2\n\n# B\n\np3\n', 'sample')
//   → 4 段抽 1 段（round(4×0.3)=1，idx 0=p1），sampledText='# A\n\np1'，activeDimensions=['fact','format']

// 辅助：normalizeMode(mode)→'full'|'sample'|'fact-only'；normalizeMaxRounds(n)→[1,3] 夹紧（缺省 1）。
// 常量：CHARS_PER_TOKEN_CONSERVATIVE=1.2，EXPECTED_OUTPUT_TOKENS=1600，RETRY_LIMIT=2，
//       CONFIRM_TOKEN_THRESHOLD=20000，DEFAULT_MAX_ROUNDS=1，MAX_ROUNDS_HARD_LIMIT=3，
//       SAMPLE_PARAGRAPH_RATIO=0.3，ALL_DIMENSIONS / SAMPLE_DIMENSIONS / FACT_ONLY_DIMENSIONS（Object.freeze）。
```

**C 卡集成注意**：concludeTurn、链累计 token 的持久化、confirm_token_budget（T03 默认 false）、事后核对均属工具层；本模块只提供纯判定函数。`buildSamplePlan` 的 `sampledText` 用于缩小输入包后再调 `estimateRound`（降本路径）。

## 3. 口径偏差与歧义记录（按 Prompt「分支与兜底」要求逐条留痕）

- **D1｜judgeConvergence 增可选入参 `resolvedIssues`**：Prompt 返回值含 `resolvedIssues` 但入参签名未列出其来源；实现为可选透传字段（调用方传 `alignIssues().resolvedIssueCount`，缺省 0）。不改判定逻辑。
- **D2｜estimateRound 的 mode 不影响公式**：任务书与 Prompt 均未给出分模式 token 系数；实现按统一公式，mode 仅归一化后回传。分模式降本由 `buildSamplePlan` 缩小 `inputPackageChars` 实现（单测「三种 mode 同结果」锁定该口径）。
- **D3｜验收命令字面形式失效**：`node --test <目录>` 在 node v24.21.0 报 `Cannot find module`（目录裸参数按模块加载）；等效命令见 §1，全绿证据一致。属环境事实，非实现偏差。
- **D4｜buildSamplePlan「按章节等距抽取 30% 段落」的具体化**：实现为**全文段落序列**（跨章节展开，含无标题前言）等距抽样——保证总体恰为 round(N×0.3) 且跨章节近似均匀（20 段抽 6 分布在 4 章：2/2/1/1）；被抽中段落的章节标题保留以维持上下文。标题行不计段落。若按「每章各自抽 30%」实现，小章节会因取整漂移总量，故取更可控口径。
- **D5｜chainConfirmed 与链级预算的关系**：Prompt 明确「链累计预估>20000×maxRounds→**再次** confirmationRequired」，实现为 chainConfirmed=true **不豁免**链级预算超限（保守口径）；单轮阈值条件则被 chainConfirmed 放行。两条件同时成立时 reason 报 `worst-case-over-threshold`（顺序判定）。
- **D6｜maxRounds 缺省值两模块不同**：judgeConfirmation 缺省 1（T03 任务参数默认值，预算保守）；judgeConvergence 缺省 3（收敛判定的硬上限，任务书 P07 语义）。两处均夹紧 [1,3]。
- **D7｜分母 0「判不收敛」的实现方式**：computeChangeRatio 返回 100（不自行携带收敛结论）；judgeConvergence 中 100≥3.0 使条件①必然不命中——若同时满足条件②（无 high 且新增 0）或③（轮次用尽）仍可能 converged=true，这是「满足任一即收敛」总规则的忠实结果（单测 A08-4c 验证了典型不收敛路径：100% + high + 新增>0 → false/null）。
- **D8｜adjudication 形态兼容**：Prompt 未写死裁决表形态；实现同时接受 T07 数组模板与对象映射（`{id:'reject'}` / `{id:{decision:'reject'}}`），降低 C 卡集成耦合。
- **D9｜命名风格**：camelCase（JS 语言惯例，AGENTS.md §2.2.2 允许语言规范强制时例外；与 A 卡已有文件一致）。
- **D10｜estimateRound 返回浮点不取整**：忠于公式；上层比较阈值时建议用容差或直接比较（20000 恰等不触发，单测锁定「严格大于」）。

## 4. 复杂度上限（按 Prompt 要求注明）

- 行级 LCS：O(n×m) DP（`Uint32Array` 单行滚动）+ 公共前后缀裁剪（不减损结果）；n、m 为两侧行数。
- 配对块内码点级 LCS：O(p×q)；p、q 为配对块码点数。
- 软上限 `LCS_LINE_COUNT_SOFT_LIMIT=2000` 行：超过仅 `console.warn` 不阻断（本卡单测样例全部 ≤20 行）。
- alignIssues：O(P×C) 贪心两遍；buildSamplePlan：O(总行数+段落数)。

## 5. 修复记录（单测驱动发现并修复的实现缺陷）

1. `lib/cost.js` sample 模式 `sampledParagraphCount` 原按抽样文本重新数块，会把保留的标题行误计为段落（虚增计数）→ 改为直接取等距索引去重数 `pickedIndexes.size`。
2. `lib/cost.js` `countDocumentParagraphs`（full/fact-only 模式对照统计用）原把标题行计为一个文本块（2 章×5 段文档得 12）→ 改为与 sample 同口径（标题不计，得 10）。
3. 单测自身期望值修正 1 处：6000 字符最坏口径=19800（原误写 16500）。

—— B 卡（T08/T10）完，等待 C 卡集成。
