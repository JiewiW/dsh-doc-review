/**
 * lib/defaults.js —— SKILL 文件缺失时的内置默认文本（任务书 T04 降级路径）。
 * 两段默认文本均 ≤200 字；SKILL 缺失或锚点提取失败时启用并置 skillMissing=true。
 */

/** 内置默认【领域背景】（≤200字）。 */
export const DEFAULT_DOMAIN_BACKGROUND = [
	"本次审查未提供领域专属背景（SKILL 文件缺失或未配置）。",
	"按通用技术文档标准审查：假定读者具备基础领域知识，",
	"关注事实准确性、内容完整性、表述必要性与格式规范性。"
].join("");

/** 内置默认【审查规则】（≤200字）。 */
export const DEFAULT_REVIEW_RULES = [
	"fact：陈述须有参考资料或公认事实支撑，数字与名称须准确；",
	"completeness：关键概念、前提与步骤不得缺失；",
	"necessity：删除冗余、重复与离题内容；",
	"format：标题层级、列表、代码块与标点须规范一致。"
].join("");
