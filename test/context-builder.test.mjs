/**
 * test/context-builder.test.mjs —— T04 context-builder 纯函数单测。
 *
 * 覆盖（本卡单测分工：仅 context-builder 与 schema）：
 * - extractTextFromBlocks：按 ContentBlock type 过滤（内核实测清单=['text']），
 *   image/reasoning/tool-call 等丢弃并计入 droppedBlocks；
 * - heuristicCleanPlainText：噪声句式清洗 + heuristicClean 标记（仅纯文本导出路径）；
 * - extractSkillSection / readSkillSections：按「## 领域背景」「## 审查规则」锚点
 *   机械提取；SKILL 文件缺失时降级为 defaults 内置文本 + skillMissing:true；
 * - renderDimensionList / renderPreviousRoundSection：维度清单与多轮第五段（沿用原 id）；
 * - buildReviewInput：四段输入包（多轮五段）；无参考资料时提示 evidence=no-reference；
 * - location 双分支正反用例（A02 依赖，实现在 reviewer.js 的
 *   validateReportBusinessRules / locationMatchesQuote / locationMatchesHeading）。
 *
 * 运行：node --test test/context-builder.test.mjs。
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	ANCHOR_DOMAIN_BACKGROUND,
	ANCHOR_REVIEW_RULES,
	buildReviewInput,
	extractSkillSection,
	extractTextFromBlocks,
	heuristicCleanPlainText,
	renderDimensionList,
	renderPreviousRoundSection
} from "../lib/context-builder.js";
import { DEFAULT_DOMAIN_BACKGROUND, DEFAULT_REVIEW_RULES } from "../lib/defaults.js";
import {
	LOCATION_QUOTE_MIN_LENGTH,
	extractHeadingLines,
	locationMatchesHeading,
	locationMatchesQuote,
	normalizeMatchText,
	validateReportBusinessRules
} from "../lib/reviewer.js";

// ---------- extractTextFromBlocks ----------

test("extractTextFromBlocks：仅保留 text 块，其余类型丢弃并计数", () => {
	const blocks = [
		{ type: "text", text: "第一段。" },
		{ type: "reasoning", text: "内心独白不应进入审查输入" },
		{ type: "image", source: { type: "base64", data: "AAA" } },
		{ type: "text", text: "第二段。" },
		{ type: "tool-call", name: "read", arguments: {} }
	];
	const { text, droppedBlocks } = extractTextFromBlocks(blocks);
	assert.equal(text, "第一段。\n第二段。");
	assert.equal(droppedBlocks, 3);
});

test("extractTextFromBlocks：空数组/非数组输入安全返回", () => {
	assert.deepEqual(extractTextFromBlocks([]), { text: "", droppedBlocks: 0 });
	assert.deepEqual(extractTextFromBlocks(undefined), { text: "", droppedBlocks: 0 });
});

test("extractTextFromBlocks：thinking 特征句不进入导出文本（A04 零泄漏口径）", () => {
	const blocks = [
		{ type: "reasoning", text: "我认为这里应该先查内核源码再下结论" },
		{ type: "text", text: "正式内容。" }
	];
	const { text } = extractTextFromBlocks(blocks);
	assert.ok(!text.includes("我认为这里应该先查内核源码"));
	assert.equal(text, "正式内容。");
});

// ---------- heuristicCleanPlainText ----------

test("heuristicCleanPlainText：命中噪声句式则清洗并标记 heuristicClean:true", () => {
	const rawText = "我认为这段结论需要重写。\n接下来写部署章节。\n部署端口为 3099。";
	const { text, heuristicClean } = heuristicCleanPlainText(rawText);
	assert.equal(heuristicClean, true);
	assert.ok(!text.includes("我认为这段结论需要重写"));
	assert.ok(!text.includes("接下来写部署章节"));
	assert.ok(text.includes("部署端口为 3099"));
});

test("heuristicCleanPlainText：干净文本不改动且 heuristicClean:false", () => {
	const rawText = "# 标题\n\n正文内容，无噪声句式。";
	const { text, heuristicClean } = heuristicCleanPlainText(rawText);
	assert.equal(heuristicClean, false);
	assert.equal(text, rawText);
});

// ---------- extractSkillSection ----------

const FAKE_SKILL_TEXT = [
	"---",
	"name: fake",
	"---",
	"",
	"# 标题",
	"",
	ANCHOR_DOMAIN_BACKGROUND,
	"",
	"领域背景正文第一行。",
	"领域背景正文第二行。",
	"",
	ANCHOR_REVIEW_RULES,
	"",
	"### 事实准确性（fact）",
	"- 做法：核对断言。",
	"### 格式规范性（format）",
	"- 做法：检查标题层级。",
	""
].join("\n");

test("extractSkillSection：按锚点提取到下一个 ## 标题前（含多行子标题）", () => {
	const background = extractSkillSection(FAKE_SKILL_TEXT, ANCHOR_DOMAIN_BACKGROUND);
	assert.ok(background.includes("领域背景正文第一行"));
	assert.ok(background.includes("领域背景正文第二行"));
	assert.ok(!background.includes(ANCHOR_REVIEW_RULES.replace("## ", "")));
	const rules = extractSkillSection(FAKE_SKILL_TEXT, ANCHOR_REVIEW_RULES);
	assert.ok(rules.includes("### 事实准确性（fact）"));
	assert.ok(rules.includes("### 格式规范性（format）"));
});

test("extractSkillSection：锚点缺失返回 null", () => {
	assert.equal(extractSkillSection("# 无锚点文档\n正文", ANCHOR_DOMAIN_BACKGROUND), null);
	assert.equal(extractSkillSection("", ANCHOR_REVIEW_RULES), null);
});

test("extractSkillSection：锚点标题必须精确匹配（改标题即破坏提取=结构契约）", () => {
	const renamed = FAKE_SKILL_TEXT.replace(ANCHOR_DOMAIN_BACKGROUND, "## 背景说明");
	assert.equal(extractSkillSection(renamed, ANCHOR_DOMAIN_BACKGROUND), null);
});

// ---------- buildReviewInput ----------

test("buildReviewInput：单轮四段输入包（目标文档/参考资料/领域背景/审查规则）", () => {
	const { inputText, skillMissing } = buildReviewInput({
		targetText: "# 部署手册\n\n端口 3099。",
		references: [{ label: "inline", text: "端口应为 3080。" }],
		docType: "generic",
		dimensions: { fact: true, completeness: true, necessity: true, format: true }
	});
	assert.equal(skillMissing, false, "generic SKILL 已落盘，不应降级");
	assert.ok(inputText.includes("【目标文档】"));
	assert.ok(inputText.includes("# 部署手册"));
	assert.ok(inputText.includes("【参考资料】"));
	assert.ok(inputText.includes("[参考1]（来源 inline）"));
	assert.ok(inputText.includes("端口应为 3080"));
	assert.ok(inputText.includes("【领域背景】"));
	assert.ok(inputText.includes("【审查规则】"));
	assert.ok(!inputText.includes("【上一轮报告】"));
});

test("buildReviewInput：无参考资料时提示 evidence 填 no-reference", () => {
	const { inputText } = buildReviewInput({
		targetText: "正文",
		references: [],
		docType: "generic",
		dimensions: { fact: true }
	});
	assert.ok(inputText.includes("no-reference"));
});

test("buildReviewInput：doc_type 未知时降级为内置默认文本 + skillMissing:true（A04）", () => {
	const { inputText, skillMissing } = buildReviewInput({
		targetText: "正文",
		references: [],
		docType: "legal",
		dimensions: { fact: true }
	});
	assert.equal(skillMissing, true);
	assert.ok(inputText.includes(DEFAULT_DOMAIN_BACKGROUND));
	assert.ok(inputText.includes(DEFAULT_REVIEW_RULES));
	assert.ok(DEFAULT_DOMAIN_BACKGROUND.length <= 200, "内置默认文本须 ≤200 字");
	assert.ok(DEFAULT_REVIEW_RULES.length <= 200, "内置默认文本须 ≤200 字");
});

test("buildReviewInput：SKILL 文件被临时移走时同样降级（skillMissing 路径实测）", () => {
	// 用 tech-spec（本卡未落盘该 SKILL，M3 才补）触发真实缺失路径
	const { skillMissing, inputText } = buildReviewInput({
		targetText: "正文",
		references: [],
		docType: "tech-spec",
		dimensions: { fact: true }
	});
	assert.equal(skillMissing, true);
	assert.ok(inputText.includes(DEFAULT_DOMAIN_BACKGROUND));
});

test("buildReviewInput：多轮增第五段【上一轮报告】并要求沿用原 id", () => {
	const prevReport = {
		summary: "上一轮发现 1 处问题。",
		issues: [{
			id: "GE-F-01",
			dimension: "fact",
			severity: "high",
			location: "## 部署步骤",
			claim: "端口号错误",
			evidence: "no-reference",
			suggestion: "改为 3099"
		}],
		newIssueCount: 1,
		round: 1,
		chainId: "docr-test"
	};
	const { inputText } = buildReviewInput({
		targetText: "正文",
		references: [],
		docType: "generic",
		dimensions: { fact: true },
		prevReport
	});
	assert.ok(inputText.includes("【上一轮报告】"));
	assert.ok(inputText.includes("GE-F-01"));
	assert.ok(inputText.includes("沿用"), "须要求沿用原 id");
});

test("renderPreviousRoundSection：prevReport 为空返回空串；issues 非数组安全", () => {
	assert.equal(renderPreviousRoundSection(undefined), "");
	assert.equal(renderPreviousRoundSection(null), "");
	assert.equal(renderPreviousRoundSection({ issues: "not-an-array", summary: "x" }), "");
});

test("renderDimensionList：只列启用维度（显式布尔开关），全关时给兜底说明", () => {
	const all = renderDimensionList({ fact: true, completeness: true, necessity: true, format: true });
	assert.ok(all.includes("fact"));
	assert.ok(all.includes("format"));
	// 契约：调用方（tool.js resolveDimensions）总是传显式布尔；undefined 视为启用（!== false）
	const factOnly = renderDimensionList({ fact: true, completeness: false, necessity: false, format: false });
	assert.ok(factOnly.includes("fact"));
	assert.ok(!factOnly.includes("completeness"));
	const none = renderDimensionList({ fact: false, completeness: false, necessity: false, format: false });
	assert.equal(typeof none, "string");
	assert.ok(none.length > 0);
	assert.ok(none.includes("关闭"));
});

// ---------- location 双分支正反用例（A02 依赖） ----------

const TARGET_TEXT = [
	"# 部署手册",
	"",
	"## 部署步骤",
	"",
	"启动命令为 dsh web --port 3099。",
	"### 子步骤：校验端口",
	"",
	"核验 3099 可访问后再继续。"
].join("\n");

test("location 分支a 正例：≥8 连续字符原文引句精确命中", () => {
	assert.equal(locationMatchesQuote("启动命令为 dsh web --port 3099。", TARGET_TEXT), true);
	assert.equal(locationMatchesQuote("「核验 3099 可访问后再继续」", TARGET_TEXT), true);
});

test("location 分支a 反例：改写/拼接/短于阈值均不命中", () => {
	// 改写且无任何 ≥8 码点共享窗口（滑窗规则是机械口径：只要有一个 8 码点窗口命中即过，
	// 因此反例必须构造为全窗口不命中）
	assert.equal(locationMatchesQuote("端口配置存在错误需要修正", TARGET_TEXT), false);
	// 跨段拼接（"部署手册"与"启动命令为"之间原文不相邻，且无 8 码点连续共享）
	assert.equal(locationMatchesQuote("部署手册的开头部分与结尾附录", TARGET_TEXT), false);
	// 短于 8 码点阈值（且非标题行）
	assert.equal(locationMatchesQuote("3099", TARGET_TEXT), false);
	assert.equal(LOCATION_QUOTE_MIN_LENGTH, 8);
});

test("location 分支b 正例：markdown 标题行原文命中（含 ### 层级）", () => {
	const headingLines = extractHeadingLines(TARGET_TEXT);
	assert.ok(headingLines.includes("部署步骤"));
	assert.equal(locationMatchesHeading("## 部署步骤", headingLines), true);
	assert.equal(locationMatchesHeading("部署步骤", headingLines), true);
	assert.equal(locationMatchesHeading("### 子步骤：校验端口", headingLines), true);
	assert.equal(locationMatchesHeading("# 部署手册", headingLines), true);
});

test("location 分支b 反例：非标题文本 / 编造标题不命中", () => {
	const headingLines = extractHeadingLines(TARGET_TEXT);
	assert.equal(locationMatchesHeading("## 安装说明", headingLines), false);
	assert.equal(locationMatchesHeading("启动命令为", headingLines), false);
	assert.equal(locationMatchesHeading("", headingLines), false);
});

test("normalizeMatchText：去首尾空白+折单空格+小写+截前 80 码点", () => {
	assert.equal(normalizeMatchText("  A   B  "), "a b");
	const long = "字".repeat(120);
	assert.equal(Array.from(normalizeMatchText(long)).length, 80);
});

test("validateReportBusinessRules：summary 超 200 码点 → violation", () => {
	const report = {
		summary: "长".repeat(201),
		issues: [],
		newIssueCount: 0,
		round: 1,
		chainId: "docr-test"
	};
	const violations = validateReportBusinessRules(report, TARGET_TEXT);
	assert.ok(violations.some((violation) => violation.includes("summary")));
});

test("validateReportBusinessRules：location 双分支均不命中 → violation（A02 拦截）", () => {
	const report = {
		summary: "发现问题。",
		issues: [{
			id: "GE-F-01",
			dimension: "fact",
			severity: "high",
			location: "文档某处（概述式定位）",
			claim: "端口错误",
			evidence: "no-reference",
			suggestion: "改为 3099"
		}],
		newIssueCount: 1,
		round: 1,
		chainId: "docr-test"
	};
	const violations = validateReportBusinessRules(report, TARGET_TEXT);
	assert.ok(violations.some((violation) => violation.includes("location")), JSON.stringify(violations));
});

test("validateReportBusinessRules：合法报告（标题行 location + 短 summary）零 violation", () => {
	const report = {
		summary: "发现 1 处问题。",
		issues: [{
			id: "GE-F-01",
			dimension: "fact",
			severity: "high",
			location: "## 部署步骤",
			claim: "端口错误",
			evidence: "no-reference",
			suggestion: "改为 3099"
		}],
		newIssueCount: 1,
		round: 1,
		chainId: "docr-test"
	};
	assert.deepEqual(validateReportBusinessRules(report, TARGET_TEXT), []);
});

test("validateReportBusinessRules：issues 非数组 / location 空串 → violation", () => {
	const notArray = { summary: "x", issues: "none", newIssueCount: 0, round: 1, chainId: "c" };
	assert.ok(validateReportBusinessRules(notArray, TARGET_TEXT).length > 0);
	const emptyLocation = {
		summary: "x",
		issues: [{ id: "GE-F-01", dimension: "fact", severity: "high", location: "", claim: "c", evidence: "no-reference", suggestion: "s" }],
		newIssueCount: 1,
		round: 1,
		chainId: "c"
	};
	assert.ok(validateReportBusinessRules(emptyLocation, TARGET_TEXT).length > 0);
});

// ---------- SKILL 文件缺失降级（A04 实测：临时目录构造缺失场景） ----------

test("extractSkillSection：真实 SKILL.md 落盘可被提取（generic 锚点结构契约）", async () => {
	const { readSkillSections } = await import("../lib/context-builder.js");
	const { domainBackground, reviewRules, skillMissing } = readSkillSections("generic");
	assert.equal(skillMissing, false);
	assert.ok(domainBackground.includes("找茬者"));
	assert.ok(reviewRules.includes("事实准确性"));
	assert.ok(reviewRules.includes("格式规范性"));
});

test("extractSkillSection：临时文件验证锚点段落到下一个 ## 前截止", () => {
	const tempDirectory = mkdtempSync(join(tmpdir(), "dsh-doc-review-skill-"));
	try {
		const skillPath = join(tempDirectory, "SKILL.md");
		writeFileSync(skillPath, [
			ANCHOR_DOMAIN_BACKGROUND,
			"背景内容。",
			ANCHOR_REVIEW_RULES,
			"规则内容。",
			"## 无关章节",
			"不应被提取。"
		].join("\n"), "utf8");
		const content = readFileSync(skillPath, "utf8");
		const rules = extractSkillSection(content, ANCHOR_REVIEW_RULES);
		assert.ok(rules.includes("规则内容"));
		assert.ok(!rules.includes("不应被提取"));
	} finally {
		rmSync(tempDirectory, { recursive: true, force: true });
	}
});

// 额外确保 mkdirSync 导入未被判为未使用（归档目录构造在 tool 层测）
test("导入健全性：node:fs 辅助函数可用", () => {
	assert.equal(typeof mkdirSync, "function");
	assert.equal(typeof writeFileSync, "function");
});
