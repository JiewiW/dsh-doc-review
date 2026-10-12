/**
 * T10 成本预估与分级模式 —— 纯函数模块（B 卡）。
 *
 * 口径来源（写死，不得擅改）：插件设计规格 v1.2 §T10、P06、T03。
 * 阈值与换算常量见本文件顶部具名常量。
 *
 * 本模块零第三方依赖（未 import 任何模块）。
 * concludeTurn / 归档计数属工具层（C 卡），本模块只提供判定纯函数。
 */

/** token 粗估系数：输入包字符数 / 1.2（中文保守系数）。任务书 P06。 */
const CHARS_PER_TOKEN_CONSERVATIVE = 1.2;
/** 单轮预期输出 token 数（固定值）。任务书 P06。 */
const EXPECTED_OUTPUT_TOKENS = 1600;
/** 单轮重试上限。任务书 P06（最坏口径 = 单轮 ×(1+重试上限)）。 */
const RETRY_LIMIT = 2;
/** 单轮最坏口径确认阈值（token）。任务书 P06/T10。 */
const CONFIRM_TOKEN_THRESHOLD = 20000;
/** max_rounds 默认值。任务书 T03。 */
const DEFAULT_MAX_ROUNDS = 1;
/** max_rounds 硬上限。任务书 T03/P07。 */
const MAX_ROUNDS_HARD_LIMIT = 3;
/** 分级抽样段落比例（等距抽取 30%）。任务书 T10。 */
const SAMPLE_PARAGRAPH_RATIO = 0.3;
/** 全部审查维度（T02a dimension 枚举，顺序即枚举顺序）。 */
const ALL_DIMENSIONS = Object.freeze(['fact', 'completeness', 'necessity', 'format']);
/** mode=sample 时保留的维度。任务书 T10。 */
const SAMPLE_DIMENSIONS = Object.freeze(['fact', 'format']);
/** mode=fact-only 时保留的维度。任务书 T10。 */
const FACT_ONLY_DIMENSIONS = Object.freeze(['fact']);
/** 合法的 mode 取值集合。任务书 T03。 */
const VALID_MODES = Object.freeze(['full', 'sample', 'fact-only']);

/**
 * mode 归一化：合法值原样返回；缺省/非法一律退回 'full'（最保守：不抽样、全维度）。
 * @param {string|undefined|null} mode
 * @returns {'full'|'sample'|'fact-only'}
 */
function normalizeMode(mode) {
  if (typeof mode === 'string' && VALID_MODES.includes(mode)) return mode;
  if (mode !== undefined && mode !== null) {
    console.warn(`[cost] 非法 mode=${JSON.stringify(mode)}，按最保守口径退回 full`);
  }
  return 'full';
}

/**
 * maxRounds 归一化：夹紧到 [1, MAX_ROUNDS_HARD_LIMIT]；缺省取 T03 默认 1。
 * 夹紧上界同时压低链级预算（20000×maxRounds），属保守取向。
 * @param {number|undefined|null} maxRounds
 * @returns {number}
 */
function normalizeMaxRounds(maxRounds) {
  if (maxRounds === undefined || maxRounds === null) return DEFAULT_MAX_ROUNDS;
  const numeric = Number(maxRounds);
  if (!Number.isFinite(numeric)) {
    console.warn(`[cost] 非法 maxRounds=${JSON.stringify(maxRounds)}，按默认 ${DEFAULT_MAX_ROUNDS} 处理`);
    return DEFAULT_MAX_ROUNDS;
  }
  return Math.min(Math.max(Math.round(numeric), 1), MAX_ROUNDS_HARD_LIMIT);
}

/**
 * 单轮 token 预估（任务书 T10 / P06）。
 *
 * 公式（写死）：
 * - 单轮估算 = inputPackageChars / 1.2 + 1600（预期输出）
 * - 最坏口径 = 单轮估算 × (1 + 重试上限 2) = 单轮估算 × 3
 *
 * 口径说明：mode 不改变估算公式（任务书与 Prompt 均未给出分模式系数），
 * 仅原样回传供上层追踪；分模式的降本由 buildSamplePlan 缩小输入包字符数实现。
 * 返回值不做取整（忠于公式），比较时用容差。
 *
 * @param {Object} input
 * @param {number} input.inputPackageChars 本轮输入包（上下文包）字符数
 * @param {string} [input.mode] 'full'|'sample'|'fact-only'，缺省 'full'
 * @returns {{
 *   singleRoundTokens: number,
 *   worstCaseTokens: number,
 *   mode: string,
 *   inputPackageChars: number,
 *   assumption: {charsPerToken: number, expectedOutputTokens: number, retryLimit: number}
 * }}
 *
 * @example
 * estimateRound({ inputPackageChars: 12000, mode: 'full' });
 * // => { singleRoundTokens: 11600, worstCaseTokens: 34800, mode: 'full', … }
 */
function estimateRound(input) {
  const rawChars = Number(input?.inputPackageChars);
  let inputPackageChars = Number.isFinite(rawChars) ? Math.max(rawChars, 0) : 0;
  if (!Number.isFinite(rawChars)) {
    console.warn(`[cost] 非法 inputPackageChars=${JSON.stringify(input?.inputPackageChars)}，按 0 处理`);
  }
  const mode = normalizeMode(input?.mode);

  const singleRoundTokens = inputPackageChars / CHARS_PER_TOKEN_CONSERVATIVE + EXPECTED_OUTPUT_TOKENS;
  const worstCaseTokens = singleRoundTokens * (1 + RETRY_LIMIT);

  return {
    singleRoundTokens,
    worstCaseTokens,
    mode,
    inputPackageChars,
    assumption: {
      charsPerToken: CHARS_PER_TOKEN_CONSERVATIVE,
      expectedOutputTokens: EXPECTED_OUTPUT_TOKENS,
      retryLimit: RETRY_LIMIT,
    },
  };
}

/**
 * 确认拦截判定（任务书 T10 / P06）。
 *
 * 规则（写死）：
 * 1. 最坏口径 > 20000 且链未确认 → confirmationRequired=true，
 *    reason='worst-case-over-threshold'；chainConfirmed=true 时该条放行
 *    （confirm 绑定 chain_id，链级有效）；
 * 2. 链累计预估 > 20000 × maxRounds → confirmationRequired=true，
 *    reason='chain-cumulative-over-budget'；此为「再次拦截」，
 *    **chainConfirmed 不豁免本条**（Prompt 用词「再次 confirmationRequired」）。
 *
 * 链累计预估口径：chainCumulativeTokens（已发生各轮最坏口径之和）+ 本轮 worstCaseTokens。
 * 若调用方传入的 chainCumulativeTokens 已包含本轮，置 chainCumulativeIncludesCurrentRound=true。
 *
 * @param {Object} input
 * @param {number} input.worstCaseTokens 本轮最坏口径 token（estimateRound 结果）
 * @param {boolean} [input.chainConfirmed] 该 chain_id 是否已获链级确认（缺省 false）
 * @param {number} [input.chainCumulativeTokens] 链上已累计预估 token（缺省 0）
 * @param {number} [input.maxRounds] 链上限（缺省 1；夹紧 [1,3]）
 * @param {number} [input.singleRoundTokens] 本轮单轮估算（缺省由 worstCaseTokens/(1+重试上限) 反推）
 * @param {boolean} [input.chainCumulativeIncludesCurrentRound] 累计值是否已含本轮（缺省 false）
 * @returns {{
 *   confirmationRequired: boolean,
 *   reason: string|null,
 *   estimateDetail: {
 *     singleRoundTokens: number,
 *     worstCaseTokens: number,
 *     chainCumulativeTokens: number,
 *     chainBudgetTokens: number,
 *     thresholdTokens: number,
 *     maxRounds: number,
 *     chainConfirmed: boolean
 *   }
 * }}
 *
 * @example
 * judgeConfirmation({ worstCaseTokens: 34800, chainConfirmed: false, chainCumulativeTokens: 0, maxRounds: 3 });
 * // => { confirmationRequired: true, reason: 'worst-case-over-threshold', … }
 */
function judgeConfirmation(input) {
  const worstCaseTokens = toFiniteNumber(input?.worstCaseTokens, 0);
  const chainConfirmed = input?.chainConfirmed === true;
  const chainCumulativeTokens = toFiniteNumber(input?.chainCumulativeTokens, 0);
  const maxRounds = normalizeMaxRounds(input?.maxRounds);
  const includesCurrentRound = input?.chainCumulativeIncludesCurrentRound === true;

  const singleRoundTokens = input?.singleRoundTokens === undefined
    ? worstCaseTokens / (1 + RETRY_LIMIT)
    : toFiniteNumber(input.singleRoundTokens, 0);

  const projectedChainCumulativeTokens = includesCurrentRound
    ? chainCumulativeTokens
    : chainCumulativeTokens + worstCaseTokens;
  const chainBudgetTokens = CONFIRM_TOKEN_THRESHOLD * maxRounds;

  const worstCaseExceedsThreshold = worstCaseTokens > CONFIRM_TOKEN_THRESHOLD;
  const chainCumulativeExceedsBudget = projectedChainCumulativeTokens > chainBudgetTokens;

  let confirmationRequired = false;
  let reason = null;
  if (worstCaseExceedsThreshold && !chainConfirmed) {
    confirmationRequired = true;
    reason = 'worst-case-over-threshold';
  } else if (chainCumulativeExceedsBudget) {
    confirmationRequired = true;
    reason = 'chain-cumulative-over-budget';
  }

  return {
    confirmationRequired,
    reason,
    estimateDetail: {
      singleRoundTokens,
      worstCaseTokens,
      chainCumulativeTokens: projectedChainCumulativeTokens,
      chainBudgetTokens,
      thresholdTokens: CONFIRM_TOKEN_THRESHOLD,
      maxRounds,
      chainConfirmed,
    },
  };
}

/**
 * 数值归一：非有限数退回 fallback 并告警（避免 NaN 静默穿透比较）。
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function toFiniteNumber(value, fallback) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  if (value !== undefined && value !== null) {
    console.warn(`[cost] 非法数值入参 ${JSON.stringify(value)}，按 ${fallback} 处理`);
  }
  return fallback;
}

/**
 * 按 markdown 标题把文档切成章节。
 * 标题行（#…######）开启新章节；首个标题之前的内容归入无标题前言章节（headingLines 为空）。
 *
 * @param {string[]} lines 已按行切分（剥 \r、按 \n）的文档行
 * @returns {Array<{headingLines: string[], bodyLines: string[]}>}
 */
function splitIntoSectionsByHeading(lines) {
  const sections = [{ headingLines: [], bodyLines: [] }];
  for (const line of lines) {
    const isHeadingLine = /^#{1,6}\s+\S/.test(line);
    if (isHeadingLine) {
      sections.push({ headingLines: [line], bodyLines: [] });
      continue;
    }
    sections[sections.length - 1].bodyLines.push(line);
  }
  return sections;
}

/**
 * 把章节正文行按空行切成段落（保留原文行，段内换行原样）。
 * @param {string[]} bodyLines
 * @returns {string[]} 段落文本数组（不含首尾空白段）
 */
function splitBodyLinesIntoParagraphs(bodyLines) {
  const paragraphs = [];
  let buffer = [];
  for (const line of bodyLines) {
    if (line.trim() === '') {
      if (buffer.length > 0) {
        paragraphs.push(buffer.join('\n'));
        buffer = [];
      }
      continue;
    }
    buffer.push(line);
  }
  if (buffer.length > 0) paragraphs.push(buffer.join('\n'));
  return paragraphs;
}

/**
 * 等距抽样索引：从 totalCount 个位置等距取 sampleCount 个（含首、近似含尾），去重升序。
 * @param {number} totalCount
 * @param {number} sampleCount
 * @returns {number[]}
 */
function pickEquidistantIndexes(totalCount, sampleCount) {
  if (totalCount <= 0 || sampleCount <= 0) return [];
  if (sampleCount >= totalCount) {
    return Array.from({ length: totalCount }, (_, index) => index);
  }
  const indexes = new Set();
  for (let slot = 0; slot < sampleCount; slot += 1) {
    const index = Math.floor((slot * totalCount) / sampleCount);
    indexes.add(Math.min(index, totalCount - 1));
  }
  return [...indexes].sort((left, right) => left - right);
}

/**
 * 分级抽样计划（任务书 T10）。
 *
 * - mode='sample'：按章节（markdown 标题切分）等距抽取 30% 段落，
 *   维度只保留 ['fact','format']；抽样以「全文段落序列」为单位等距取样
 *   （跨章节均匀分布），被抽中段落的章节标题一并保留以维持上下文；
 * - mode='fact-only'：文本原样，仅保留 ['fact'] 维度；
 * - mode='full'（含非法/缺省 mode）：文本原样，全部四个维度。
 *
 * 段落计数口径：按空行切分的非空文本块；标题行不计入段落（REPORT 记录）。
 *
 * @param {string} documentText 目标文档全文
 * @param {string} [mode] 'full'|'sample'|'fact-only'
 * @returns {{
 *   sampledText: string,
 *   activeDimensions: string[],
 *   mode: string,
 *   samplingDetail: {
 *     originalParagraphCount: number,
 *     sampledParagraphCount: number,
 *     sectionCount: number,
 *     sampledSectionCount: number,
 *     sampled: boolean
 *   }
 * }}
 *
 * @example
 * buildSamplePlan('# A\n\np1\n\np2\n\n# B\n\np3\n', 'sample');
 * // => { sampledText: '# A\n\np1\n\n# B\n\np3', activeDimensions: ['fact','format'], … }
 */
function buildSamplePlan(documentText, mode) {
  const effectiveMode = normalizeMode(mode);
  const text = String(documentText ?? '');

  if (effectiveMode !== 'sample') {
    const activeDimensions = effectiveMode === 'fact-only' ? FACT_ONLY_DIMENSIONS : ALL_DIMENSIONS;
    const paragraphCount = countDocumentParagraphs(text);
    const sectionCount = splitIntoSectionsByHeading(splitDocumentLines(text)).length;
    return {
      sampledText: text,
      activeDimensions: [...activeDimensions],
      mode: effectiveMode,
      samplingDetail: {
        originalParagraphCount: paragraphCount,
        sampledParagraphCount: paragraphCount,
        sectionCount,
        sampledSectionCount: sectionCount,
        sampled: false,
      },
    };
  }

  const sections = splitIntoSectionsByHeading(splitDocumentLines(text));
  const flatParagraphs = [];
  sections.forEach((section, sectionIndex) => {
    splitBodyLinesIntoParagraphs(section.bodyLines).forEach((paragraph) => {
      flatParagraphs.push({ sectionIndex, text: paragraph });
    });
  });

  const targetCount = computeSampleTargetCount(flatParagraphs.length);
  const pickedIndexes = new Set(pickEquidistantIndexes(flatParagraphs.length, targetCount));

  const sampledSections = [];
  sections.forEach((section, sectionIndex) => {
    const keptParagraphs = flatParagraphs
      .map((paragraph, flatIndex) => ({ paragraph, flatIndex }))
      .filter((entry) => entry.paragraph.sectionIndex === sectionIndex && pickedIndexes.has(entry.flatIndex))
      .map((entry) => entry.paragraph.text);
    if (keptParagraphs.length > 0) {
      sampledSections.push([...section.headingLines, ...keptParagraphs].join('\n\n'));
    }
  });

  const sampledText = sampledSections.join('\n\n');
  // 抽中段落数 = 等距索引去重后的数量（标题行不计段落；不用重算文本块，避免标题被误计）。
  const sampledParagraphCount = pickedIndexes.size;

  return {
    sampledText,
    activeDimensions: [...SAMPLE_DIMENSIONS],
    mode: effectiveMode,
    samplingDetail: {
      originalParagraphCount: flatParagraphs.length,
      sampledParagraphCount,
      sectionCount: sections.length,
      sampledSectionCount: sampledSections.length,
      sampled: true,
    },
  };
}

/**
 * 行切分：先剥所有 \r，再按 \n 切（与 T08 同口径）。
 * @param {string} text
 * @returns {string[]}
 */
function splitDocumentLines(text) {
  return String(text ?? '').replace(/\r/g, '').split('\n');
}

/**
 * 统计文档段落数（按空行切分的非空文本块；标题行不计段落——与 sample 模式口径一致）。
 * @param {string} text
 * @returns {number}
 */
function countDocumentParagraphs(text) {
  const sections = splitIntoSectionsByHeading(splitDocumentLines(text));
  return sections.reduce(
    (total, section) => total + splitBodyLinesIntoParagraphs(section.bodyLines).length,
    0,
  );
}

/**
 * 抽样目标段落数：round(总数 × 0.3)，总数 >0 时至少 1 段。
 * @param {number} originalParagraphCount
 * @returns {number}
 */
function computeSampleTargetCount(originalParagraphCount) {
  if (originalParagraphCount <= 0) return 0;
  const target = Math.round(originalParagraphCount * SAMPLE_PARAGRAPH_RATIO);
  return Math.max(target, 1);
}

export {
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
};
