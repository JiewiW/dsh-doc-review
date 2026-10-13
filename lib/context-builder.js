/**
 * lib/context-builder.js —— T04 上下文预处理（按 block 类型过滤，非文本截断）。
 *
 * 职责：
 * 1. ContentBlock[] → 纯文本（仅保留 text 类；其余丢弃计数入 droppedBlocks）。
 *    内核 ContentBlockMap 键清单（dsh-llm types.d.ts:114-126 实测）：
 *    text/reasoning/image/file/tool-call/tool-addition/tool-removal——**无 document 类型**，
 *    故保留清单写死为 ["text"]；file/image 等与 reasoning 同等丢弃计数。
 * 2. 按 doc_type 直读 skills/<name>/SKILL.md，以「## 领域背景」「## 审查规则」
 *    两锚点机械提取段落；缺失降级 lib/defaults.js 并置 skillMissing=true。
 * 3. 组装输入包四段（多轮加第五段【上一轮报告】），不含主会话其他消息/生成过程/
 *    上一版文档全文（任务书 T04 第 4 点）。
 * 4. 纯文本导出兜底：关键词启发式清洗并置 heuristicClean=true（T04 兜底条款）。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_DOMAIN_BACKGROUND, DEFAULT_REVIEW_RULES } from "./defaults.js";
import { ISSUE_DIMENSIONS } from "./schema.js";

/** 保留的 ContentBlock type 白名单（内核无 document 类型，实测写死）。 */
const KEEP_BLOCK_TYPES = Object.freeze(["text"]);

/** SKILL 结构契约锚点（T11：不得改动；导出供单测与外部核对）。 */
export const ANCHOR_DOMAIN_BACKGROUND = "## 领域背景";
export const ANCHOR_REVIEW_RULES = "## 审查规则";

/** doc_type → SKILL 目录名映射（闭合枚举四键；legal/medical 预留不启用）。 */
const SKILL_DIR_BY_DOC_TYPE = Object.freeze({
	generic: "doc-review-generic",
	"tech-spec": "doc-review-tech-spec",
	"product-doc": "doc-review-product-doc",
	"task-prompt": "doc-review-task-prompt"
});

/** 维度中文名（审查规则维度清单渲染用）。 */
const DIMENSION_LABELS = Object.freeze({
	fact: "事实准确性（fact）",
	completeness: "内容完整性（completeness）",
	necessity: "表述必要性（necessity）",
	format: "格式规范性（format）"
});

/** 启发式清洗特征词（仅纯文本导出兜底路径使用）。 */
const HEURISTIC_NOISE_PATTERNS = Object.freeze([
	/我认为[，,：:]?/g,
	/接下来写[，,：:]?/g,
	/我觉得[，,：:]?/g,
	/下面开始[，,：:]?/g
]);

/** 插件根目录（import.meta.url 定位自身，SKILL 直读主手段）。 */
const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * 从 ContentBlock[] 提取纯文本并统计丢弃块。
 * @param {readonly {type: string, text?: string}[]} blocks 原始内容块。
 * @returns {{text: string, droppedBlocks: number}} 文本与丢弃计数。
 */
export function extractTextFromBlocks(blocks) {
	const keptParts = [];
	let droppedBlocks = 0;
	for (const block of blocks ?? []) {
		if (block && KEEP_BLOCK_TYPES.includes(block.type) && typeof block.text === "string") {
			keptParts.push(block.text);
		} else {
			droppedBlocks += 1;
		}
	}
	return { text: keptParts.join("\n"), droppedBlocks };
}

/**
 * 关键词启发式清洗（仅无法区分 block 类型的纯文本导出时调用）。
 * @param {string} rawText 原始纯文本。
 * @returns {{text: string, heuristicClean: boolean}} 清洗结果；无命中时 heuristicClean=false。
 */
export function heuristicCleanPlainText(rawText) {
	let cleaned = rawText;
	let hitCount = 0;
	for (const pattern of HEURISTIC_NOISE_PATTERNS) {
		const matches = cleaned.match(pattern);
		if (matches) hitCount += matches.length;
		cleaned = cleaned.replace(pattern, "");
	}
	return { text: cleaned, heuristicClean: hitCount > 0 };
}

/**
 * 从 SKILL.md 全文按锚点机械提取一个「## 」段落。
 * @param {string} skillText SKILL.md 全文。
 * @param {string} anchor 锚点行（如「## 领域背景」）。
 * @returns {string | null} 段落正文（去首尾空白）；锚点缺失返回 null。
 */
export function extractSkillSection(skillText, anchor) {
	const lines = skillText.split(/\r?\n/);
	const startIndex = lines.findIndex((line) => line.trim() === anchor);
	if (startIndex < 0) return null;
	const sectionLines = [];
	for (const line of lines.slice(startIndex + 1)) {
		if (line.trimStart().startsWith("## ")) break;
		sectionLines.push(line);
	}
	const sectionText = sectionLines.join("\n").trim();
	return sectionText.length > 0 ? sectionText : null;
}

/**
 * 读取 doc_type 对应 SKILL 的领域背景与审查规则（直读文件，缺失降级）。
 * @param {string} docType 闭合枚举 doc_type。
 * @returns {{domainBackground: string, reviewRules: string, skillMissing: boolean}}
 *   两段文本与缺失标记；缺失时文本=内置默认（≤200字）。
 */
export function readSkillSections(docType) {
	const skillDir = SKILL_DIR_BY_DOC_TYPE[docType];
	const skillPath = skillDir ? join(PLUGIN_ROOT, "skills", skillDir, "SKILL.md") : null;
	let skillText = null;
	if (skillPath) {
		try {
			skillText = readFileSync(skillPath, "utf8");
		} catch {
			skillText = null;
		}
	}
	const domainBackground = skillText ? extractSkillSection(skillText, ANCHOR_DOMAIN_BACKGROUND) : null;
	const reviewRules = skillText ? extractSkillSection(skillText, ANCHOR_REVIEW_RULES) : null;
	const skillMissing = domainBackground === null || reviewRules === null;
	return {
		domainBackground: domainBackground ?? DEFAULT_DOMAIN_BACKGROUND,
		reviewRules: reviewRules ?? DEFAULT_REVIEW_RULES,
		skillMissing
	};
}

/**
 * 渲染启用的维度清单（dimensions 开关 → 有序中文清单）。
 * @param {Record<string, boolean>} dimensions 四维度开关。
 * @returns {string} 每行一条「- 维度名」；全关时返回固定提示行。
 */
export function renderDimensionList(dimensions) {
	const enabledLines = ISSUE_DIMENSIONS
		.filter((dimension) => dimensions[dimension] !== false)
		.map((dimension) => `- ${DIMENSION_LABELS[dimension]}`);
	if (enabledLines.length === 0) return "- （所有维度均被关闭，仅输出格式检查意见）";
	return enabledLines.join("\n");
}

/**
 * 渲染多轮第五段【上一轮报告】（id/dimension/severity/location/claim 摘要）。
 * @param {{issues?: readonly object[]}} prevReport 上一轮报告（已过 T02a 校验）。
 * @returns {string} 段落文本（含沿用原 id 指令）；无 issues 时返回空串。
 */
export function renderPreviousRoundSection(prevReport) {
	const issues = Array.isArray(prevReport?.issues) ? prevReport.issues : [];
	if (issues.length === 0) return "";
	const issueLines = issues.map((issue) =>
		`- [${issue.id}] ${issue.dimension}/${issue.severity} @ ${issue.location} :: ${issue.claim}`
	);
	return [
		"【上一轮报告】",
		...issueLines,
		"要求：上一轮仍存在的问题沿用原 id，仅新问题分配新序号。"
	].join("\n");
}

/**
 * 组装审查输入包（T04 主入口）。
 * @param {object} options 组装参数。
 * @param {string} options.targetText 目标文档纯文本（已过 block 过滤或启发式清洗）。
 * @param {readonly {label: string, text: string}[]} options.references 参考资料
 *   （label 形如 inline|file:<相对路径>，调用方已完成安全边界校验）。
 * @param {string} options.docType 闭合枚举 doc_type。
 * @param {Record<string, boolean>} options.dimensions 四维度开关。
 * @param {{issues?: readonly object[]} | null} [options.prevReport] 上一轮报告（多轮）。
 * @returns {{inputText: string, skillMissing: boolean}} 输入包全文与 SKILL 缺失标记。
 */
export function buildReviewInput({ targetText, references, docType, dimensions, prevReport = null }) {
	const skill = readSkillSections(docType);
	const referenceLines = (references ?? []).map(
		(reference, index) => `[参考${index + 1}]（来源 ${reference.label}）\n${reference.text}`
	);
	const sections = [
		"【目标文档】",
		targetText,
		"",
		"【参考资料】",
		referenceLines.length > 0 ? referenceLines.join("\n\n") : "（无参考资料；证据字段填 no-reference）",
		"",
		"【领域背景】",
		skill.domainBackground,
		"",
		"【审查规则】",
		skill.reviewRules,
		"",
		"本轮启用维度：",
		renderDimensionList(dimensions)
	];
	const previousRoundSection = prevReport ? renderPreviousRoundSection(prevReport) : "";
	if (previousRoundSection.length > 0) sections.push("", previousRoundSection);
	return { inputText: sections.join("\n"), skillMissing: skill.skillMissing };
}
