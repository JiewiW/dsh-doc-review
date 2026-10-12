/**
 * T08 多轮与收敛判断 —— 纯函数模块（B 卡）。
 *
 * 口径来源（写死，不得擅改）：插件设计规格 v1.2 §T08、P03/P04/P07。
 * 歧义处的执行口径记录于仓库内 REPORT 文档。
 *
 * 本模块零第三方依赖（仅 node 内置能力，实际未 import 任何模块）。
 * 多轮链断裂判定不在本模块（属工具层）；computeChangeRatio 的 prevDocument
 * 由调用方传入（调用方负责：归档读回 → prev_document 兜底 → 皆无报错）。
 *
 * 复杂度上限：行级 LCS 与字符级 LCS 均为 O(n*m) DP（Uint32Array）。
 * 单测样例控制在 2000 行内（任务 Prompt 兜底条款）；超大文档由调用方预检。
 */

/** 分母（上一轮非空白字符数）为 0 时的占比记法（%），且判不收敛。任务书 T08 口径边界。 */
const EMPTY_PREV_CHANGE_RATIO_PERCENT = 100;
/** 收敛阈值：修改占比 < 3.0% 即收敛。任务书 T08。 */
const CONVERGENCE_CHANGE_RATIO_THRESHOLD_PERCENT = 3.0;
/** max_rounds 硬上限。任务书 P07/T03。 */
const MAX_ROUNDS_HARD_LIMIT = 3;
/** issue 备选键中 location 归一化文本的截断长度（前 80 字符，按码点）。任务书 T08。 */
const LOCATION_NORMALIZE_MAX_CODE_POINTS = 80;
/** 占比四舍五入精度：0.1%。任务书 T08。 */
const RATIO_ROUND_DECIMALS = 1;
/** 占比计算输入文档的行数软上限（超出打警告，不阻断）。任务 Prompt 兜底条款。 */
const LCS_LINE_COUNT_SOFT_LIMIT = 2000;

/**
 * 行切分：先剥所有 \r，再按 \n 切。任务书 T08 口径边界。
 * @param {string} text
 * @returns {string[]}
 */
function splitLines(text) {
  return String(text).replace(/\r/g, '').split('\n');
}

/**
 * 按 Unicode 码点切分（Array.from，防代理对被拆半）。任务书 T08 口径边界。
 * @param {string} text
 * @returns {string[]}
 */
function toCodePoints(text) {
  return Array.from(String(text));
}

/**
 * 统计非空白字符数（码点粒度）：中文按字符、标点计入、纯空白/换行不计。
 * @param {string[]} codePoints
 * @returns {number}
 */
function countNonWhitespaceCodePoints(codePoints) {
  let total = 0;
  for (const codePoint of codePoints) {
    if (!/\s/.test(codePoint)) total += 1;
  }
  return total;
}

/**
 * 计算修改占比（%）。
 *
 * 算法（任务书 T08 写死口径）：
 * 1. 行级 LCS（O(n*m) DP，公共前后缀裁剪不减损结果）得到编辑脚本；
 * 2. 编辑脚本分段：连续 delete 行合并为删除块，连续 insert 行合并为插入块；
 *    删除块与紧随其后的插入块按序 1:1 配对；
 * 3. 配对块：两侧各自 join('\n') 后做字符级（码点级）LCS，
 *    分子计入「删除的非空白码点数 + 插入的非空白码点数」；
 * 4. 未配对块：全额计入（块内全部非空白码点数）；
 * 5. 分母 = 上一轮文档非空白码点数；分母为 0 → 返回 100（判不收敛由
 *    judgeConvergence 依 changeRatio>=阈值 自然得出，见 REPORT 说明）；
 * 6. 结果四舍五入到 0.1%。不做 Unicode 归一化、不做全半角折叠。
 *
 * @param {string} prevDocument 上一轮目标文档（调用方负责取回次序）
 * @param {string} currentDocument 本轮目标文档
 * @returns {number} 修改占比百分数，如 12.3 表示 12.3%
 */
function computeChangeRatio(prevDocument, currentDocument) {
  const prevLines = splitLines(prevDocument);
  const currentLines = splitLines(currentDocument);
  if (prevLines.length > LCS_LINE_COUNT_SOFT_LIMIT
    || currentLines.length > LCS_LINE_COUNT_SOFT_LIMIT) {
    console.warn(`[convergence] LCS 输入超过 ${LCS_LINE_COUNT_SOFT_LIMIT} 行软上限，O(n*m) DP 可能较慢`);
  }

  const prevNonWhitespaceTotal = countNonWhitespaceCodePoints(toCodePoints(String(prevDocument)));
  if (prevNonWhitespaceTotal === 0) {
    return EMPTY_PREV_CHANGE_RATIO_PERCENT;
  }

  const editScript = lcsEditScript(prevLines, currentLines);
  const changeBlocks = groupEditScriptIntoBlocks(editScript);
  const changedNonWhitespaceTotal = sumPairedAndUnpairedBlockChanges(changeBlocks);

  const rawRatioPercent = (changedNonWhitespaceTotal / prevNonWhitespaceTotal) * 100;
  return roundToDecimals(rawRatioPercent, RATIO_ROUND_DECIMALS);
}

/**
 * 四舍五入到指定小数位。
 * @param {number} value
 * @param {number} decimals
 * @returns {number}
 */
function roundToDecimals(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * 行级 LCS 编辑脚本：O(n*m) DP + 回溯。
 * 返回操作序列，delete 携带 prev 行文本，insert 携带 current 行文本，equal 跳过。
 * 先裁剪公共前后缀缩小 DP 表（不改变 LCS 结果）。
 *
 * @param {string[]} prevLines
 * @param {string[]} currentLines
 * @returns {Array<{type: 'delete'|'insert', text: string}>}
 */
function lcsEditScript(prevLines, currentLines) {
  let start = 0;
  while (start < prevLines.length && start < currentLines.length
    && prevLines[start] === currentLines[start]) {
    start += 1;
  }
  let prevEnd = prevLines.length;
  let currentEnd = currentLines.length;
  while (prevEnd > start && currentEnd > start
    && prevLines[prevEnd - 1] === currentLines[currentEnd - 1]) {
    prevEnd -= 1;
    currentEnd -= 1;
  }

  const middlePrev = prevLines.slice(start, prevEnd);
  const middleCurrent = currentLines.slice(start, currentEnd);
  const rowCount = middlePrev.length;
  const columnCount = middleCurrent.length;
  if (rowCount === 0 && columnCount === 0) return [];

  const stride = columnCount + 1;
  const dp = new Uint32Array((rowCount + 1) * stride);
  for (let i = rowCount - 1; i >= 0; i -= 1) {
    for (let j = columnCount - 1; j >= 0; j -= 1) {
      if (middlePrev[i] === middleCurrent[j]) {
        dp[i * stride + j] = dp[(i + 1) * stride + j + 1] + 1;
      } else {
        dp[i * stride + j] = Math.max(dp[(i + 1) * stride + j], dp[i * stride + j + 1]);
      }
    }
  }

  const script = [];
  let i = 0;
  let j = 0;
  while (i < rowCount && j < columnCount) {
    if (middlePrev[i] === middleCurrent[j]) {
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * stride + j] >= dp[i * stride + j + 1]) {
      script.push({ type: 'delete', text: middlePrev[i] });
      i += 1;
    } else {
      script.push({ type: 'insert', text: middleCurrent[j] });
      j += 1;
    }
  }
  while (i < rowCount) {
    script.push({ type: 'delete', text: middlePrev[i] });
    i += 1;
  }
  while (j < columnCount) {
    script.push({ type: 'insert', text: middleCurrent[j] });
    j += 1;
  }
  return script;
}

/**
 * 把编辑脚本按操作类型分段成块：连续 delete → deleteBlock，连续 insert → insertBlock。
 * 回溯 walk 天然保证「删除块先于紧随其后的插入块」的顺序语义。
 *
 * @param {Array<{type: string, text: string}>} editScript
 * @returns {Array<{kind: 'delete'|'insert', lines: string[]}>}
 */
function groupEditScriptIntoBlocks(editScript) {
  const blocks = [];
  let currentBlock = null;
  for (const operation of editScript) {
    if (!currentBlock || currentBlock.kind !== operation.type) {
      currentBlock = { kind: operation.type, lines: [] };
      blocks.push(currentBlock);
    }
    currentBlock.lines.push(operation.text);
  }
  return blocks;
}

/**
 * 变动块配对并累计非空白变动码点数。
 * 规则（任务书 T08）：deleteBlock 与紧随其后的 insertBlock 按序 1:1 配对做字符级 LCS；
 * 未配对的块全额计入（块内全部非空白码点数）。
 *
 * @param {Array<{kind: string, lines: string[]}>} changeBlocks
 * @returns {number} 分子：增删的非空白码点总数
 */
function sumPairedAndUnpairedBlockChanges(changeBlocks) {
  let total = 0;
  let pendingDeleteBlock = null;
  for (const block of changeBlocks) {
    if (block.kind === 'delete') {
      if (pendingDeleteBlock) {
        total += countBlockNonWhitespace(pendingDeleteBlock);
      }
      pendingDeleteBlock = block;
    } else if (block.kind === 'insert') {
      if (pendingDeleteBlock) {
        total += countPairedCharacterDiff(pendingDeleteBlock, block);
        pendingDeleteBlock = null;
      } else {
        total += countBlockNonWhitespace(block);
      }
    }
  }
  if (pendingDeleteBlock) {
    total += countBlockNonWhitespace(pendingDeleteBlock);
  }
  return total;
}

/**
 * 未配对块全额计入：块内全部行的非空白码点数（行间 \n 属空白，不计）。
 * @param {{kind: string, lines: string[]}} block
 * @returns {number}
 */
function countBlockNonWhitespace(block) {
  let total = 0;
  for (const line of block.lines) {
    total += countNonWhitespaceCodePoints(toCodePoints(line));
  }
  return total;
}

/**
 * 配对块字符级差异：两侧各自 join('\n') 后按码点做 LCS，
 * 返回「被删除的非空白码点数 + 被插入的非空白码点数」。
 *
 * @param {{kind: string, lines: string[]}} deleteBlock
 * @param {{kind: string, lines: string[]}} insertBlock
 * @returns {number}
 */
function countPairedCharacterDiff(deleteBlock, insertBlock) {
  const prevCodePoints = toCodePoints(deleteBlock.lines.join('\n'));
  const currentCodePoints = toCodePoints(insertBlock.lines.join('\n'));

  const rowCount = prevCodePoints.length;
  const columnCount = currentCodePoints.length;
  const stride = columnCount + 1;
  const dp = new Uint32Array((rowCount + 1) * stride);
  for (let i = rowCount - 1; i >= 0; i -= 1) {
    for (let j = columnCount - 1; j >= 0; j -= 1) {
      if (prevCodePoints[i] === currentCodePoints[j]) {
        dp[i * stride + j] = dp[(i + 1) * stride + j + 1] + 1;
      } else {
        dp[i * stride + j] = Math.max(dp[(i + 1) * stride + j], dp[i * stride + j + 1]);
      }
    }
  }

  let deletedNonWhitespace = 0;
  let insertedNonWhitespace = 0;
  let i = 0;
  let j = 0;
  while (i < rowCount && j < columnCount) {
    if (prevCodePoints[i] === currentCodePoints[j]) {
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * stride + j] >= dp[i * stride + j + 1]) {
      if (!/\s/.test(prevCodePoints[i])) deletedNonWhitespace += 1;
      i += 1;
    } else {
      if (!/\s/.test(currentCodePoints[j])) insertedNonWhitespace += 1;
      j += 1;
    }
  }
  while (i < rowCount) {
    if (!/\s/.test(prevCodePoints[i])) deletedNonWhitespace += 1;
    i += 1;
  }
  while (j < columnCount) {
    if (!/\s/.test(currentCodePoints[j])) insertedNonWhitespace += 1;
    j += 1;
  }
  return deletedNonWhitespace + insertedNonWhitespace;
}

/**
 * issue 备选匹配键的 location 归一化：
 * 去首尾空白 + 连续空白折单空格 + 英文小写 + 截前 80 字符（按码点）。
 *
 * @param {string} location
 * @returns {string}
 */
function normalizeLocationText(location) {
  const collapsed = String(location ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  return toCodePoints(collapsed).slice(0, LOCATION_NORMALIZE_MAX_CODE_POINTS).join('');
}

/**
 * issue 备选匹配键：dimension + 归一化 location（id 缺失/匹配不上时使用）。
 * @param {{dimension?: string, location?: string}} issue
 * @returns {string}
 */
function buildFallbackKey(issue) {
  return `${issue?.dimension ?? ''}\u0000${normalizeLocationText(issue?.location)}`;
}

/**
 * issue 是否携带可用 id（非空字符串）。
 * @param {{id?: unknown}} issue
 * @returns {boolean}
 */
function hasUsableIssueId(issue) {
  return Boolean(issue && typeof issue.id === 'string' && issue.id !== '');
}

/**
 * 把裁决表归一化为 Map<id, decision>。
 * 接受两种形态（REPORT 记录该兼容口径）：
 * - 数组：[{ id, decision, reason?, applied_change? }, …]（T07 裁决表模板形态）
 * - 对象映射：{ <id>: decision 字符串 } 或 { <id>: { decision } }
 *
 * @param {Array|Object|undefined|null} adjudication
 * @returns {Map<string, string>}
 */
function normalizeAdjudicationToDecisionMap(adjudication) {
  const decisionMap = new Map();
  if (!adjudication) return decisionMap;
  if (Array.isArray(adjudication)) {
    for (const entry of adjudication) {
      if (entry && typeof entry.id === 'string' && typeof entry.decision === 'string') {
        decisionMap.set(entry.id, entry.decision);
      }
    }
    return decisionMap;
  }
  if (typeof adjudication === 'object') {
    for (const [id, value] of Object.entries(adjudication)) {
      if (typeof value === 'string') decisionMap.set(id, value);
      else if (value && typeof value.decision === 'string') decisionMap.set(id, value.decision);
    }
  }
  return decisionMap;
}

/**
 * issue 跨轮对齐（任务书 T08 / P04）。
 *
 * 匹配规则（一对一贪心，两遍）：
 * 1. 第一遍按 id 匹配（双方 id 均为非空字符串且相等）；
 * 2. 第二遍对剩余项按备选键 dimension + 归一化 location 匹配（一对一，先到先得）。
 * 匹配不上的旧 issue 计 resolved；有裁决表且 decision=reject 且未再出现（即未匹配）
 * 者计 resolved 并标 disputed=true。匹配不上的新 issue 计新增。
 * newIssueCount 以本函数复算为准（审查员初判仅作参考，不读取）。
 *
 * @param {Array<{id?: string, dimension?: string, location?: string}>} prevIssues 上一轮 issues
 * @param {Array<{id?: string, dimension?: string, location?: string}>} currentIssues 本轮 issues
 * @param {Array|Object} [adjudication] 上一轮裁决表（可选；形态见 normalizeAdjudicationToDecisionMap）
 * @returns {{
 *   newIssueCount: number,
 *   resolvedIssueCount: number,
 *   matchedCount: number,
 *   resolvedIds: Array<string|undefined>,
 *   newIssueIds: Array<string|undefined>,
 *   disputedResolvedIds: Array<string|undefined>
 * }}
 */
function alignIssues(prevIssues, currentIssues, adjudication) {
  const prevList = Array.isArray(prevIssues) ? prevIssues : [];
  const currentList = Array.isArray(currentIssues) ? currentIssues : [];
  const decisionMap = normalizeAdjudicationToDecisionMap(adjudication);

  const matchedCurrentIndexes = new Set();
  const matchedPrevIndexes = new Set();

  for (let prevIndex = 0; prevIndex < prevList.length; prevIndex += 1) {
    const prevIssue = prevList[prevIndex];
    if (!hasUsableIssueId(prevIssue)) continue;
    const prevId = prevIssue.id;
    for (let currentIndex = 0; currentIndex < currentList.length; currentIndex += 1) {
      if (matchedCurrentIndexes.has(currentIndex)) continue;
      const currentIssue = currentList[currentIndex];
      if (currentIssue && currentIssue.id === prevId) {
        matchedPrevIndexes.add(prevIndex);
        matchedCurrentIndexes.add(currentIndex);
        break;
      }
    }
  }

  const prevFallbackKeyMap = new Map();
  for (let prevIndex = 0; prevIndex < prevList.length; prevIndex += 1) {
    if (matchedPrevIndexes.has(prevIndex)) continue;
    const key = buildFallbackKey(prevList[prevIndex]);
    if (!prevFallbackKeyMap.has(key)) prevFallbackKeyMap.set(key, []);
    prevFallbackKeyMap.get(key).push(prevIndex);
  }
  for (let currentIndex = 0; currentIndex < currentList.length; currentIndex += 1) {
    if (matchedCurrentIndexes.has(currentIndex)) continue;
    const key = buildFallbackKey(currentList[currentIndex]);
    const candidates = prevFallbackKeyMap.get(key);
    if (!candidates || candidates.length === 0) continue;
    const prevIndex = candidates.shift();
    matchedPrevIndexes.add(prevIndex);
    matchedCurrentIndexes.add(currentIndex);
  }

  const resolvedIds = [];
  const disputedResolvedIds = [];
  for (let prevIndex = 0; prevIndex < prevList.length; prevIndex += 1) {
    if (matchedPrevIndexes.has(prevIndex)) continue;
    const prevIssue = prevList[prevIndex];
    const prevId = hasUsableIssueId(prevIssue) ? prevIssue.id : undefined;
    resolvedIds.push(prevId);
    const decision = prevId !== undefined ? decisionMap.get(prevId) : undefined;
    if (decision === 'reject') {
      disputedResolvedIds.push(prevId);
    }
  }

  const newIssueIds = [];
  for (let currentIndex = 0; currentIndex < currentList.length; currentIndex += 1) {
    if (matchedCurrentIndexes.has(currentIndex)) continue;
    const currentIssue = currentList[currentIndex];
    newIssueIds.push(hasUsableIssueId(currentIssue) ? currentIssue.id : undefined);
  }

  return {
    newIssueCount: newIssueIds.length,
    resolvedIssueCount: resolvedIds.length,
    matchedCount: matchedPrevIndexes.size,
    resolvedIds,
    newIssueIds,
    disputedResolvedIds,
  };
}

/**
 * 收敛终止判定（任务书 T08，满足任一即 converged=true，按序返回首个命中条件名）：
 * 1. 'change-ratio-below-threshold'：changeRatio < 3.0；
 * 2. 'no-high-severity-and-no-new-issues'：本轮 issues 无 severity=high 且复算新增数=0；
 * 3. 'max-rounds-reached'：prevRound >= maxRounds（maxRounds 夹紧到 [1, 3] 硬上限）。
 *
 * 说明：resolvedIssues 为回传便利字段（Prompt 签名未列）；调用方应把
 * alignIssues 结果的 resolvedIssueCount 一并传入，缺省为 0。
 *
 * @param {Object} input
 * @param {number} input.changeRatio computeChangeRatio 结果（百分数）
 * @param {Array<{severity?: string}>} input.currentIssues 本轮 issues
 * @param {number} input.recomputedNewCount alignIssues 复算的新增数（不信任审查员初判）
 * @param {number} input.prevRound 上一轮轮次（默认 0）
 * @param {number} [input.maxRounds] 链上限（默认 3；>3 按硬上限 3 夹紧，P07）
 * @param {number} [input.resolvedIssues] 便利回传字段（默认 0）
 * @returns {{
 *   changeRatio: number,
 *   newIssues: number,
 *   resolvedIssues: number,
 *   converged: boolean,
 *   reason: string|null
 * }}
 */
function judgeConvergence(input) {
  const changeRatio = Number(input?.changeRatio ?? 0);
  const currentIssues = Array.isArray(input?.currentIssues) ? input.currentIssues : [];
  const recomputedNewCount = Number(input?.recomputedNewCount ?? 0);
  const prevRound = Number(input?.prevRound ?? 0);
  const rawMaxRounds = input?.maxRounds === undefined ? MAX_ROUNDS_HARD_LIMIT : Number(input.maxRounds);
  const effectiveMaxRounds = Math.min(
    Math.max(Number.isFinite(rawMaxRounds) ? rawMaxRounds : MAX_ROUNDS_HARD_LIMIT, 1),
    MAX_ROUNDS_HARD_LIMIT,
  );
  const resolvedIssues = Number(input?.resolvedIssues ?? 0);

  const hasHighSeverityIssue = currentIssues.some((issue) => issue && issue.severity === 'high');

  let converged = false;
  let reason = null;
  if (changeRatio < CONVERGENCE_CHANGE_RATIO_THRESHOLD_PERCENT) {
    converged = true;
    reason = 'change-ratio-below-threshold';
  } else if (!hasHighSeverityIssue && recomputedNewCount === 0) {
    converged = true;
    reason = 'no-high-severity-and-no-new-issues';
  } else if (prevRound >= effectiveMaxRounds) {
    converged = true;
    reason = 'max-rounds-reached';
  }

  return {
    changeRatio,
    newIssues: recomputedNewCount,
    resolvedIssues,
    converged,
    reason,
  };
}

export {
  computeChangeRatio,
  alignIssues,
  judgeConvergence,
  normalizeLocationText,
  CONVERGENCE_CHANGE_RATIO_THRESHOLD_PERCENT,
  MAX_ROUNDS_HARD_LIMIT,
  EMPTY_PREV_CHANGE_RATIO_PERCENT,
  LCS_LINE_COUNT_SOFT_LIMIT,
};
