/**
 * lib/index.js —— dsh-doc-review 插件 host 入口（ESM，导出 {name, inject, apply}）。
 *
 * 挂载形态：bundle 包（package.json dsh.bundle.patch → cordis.patch.yml 插件行
 * id=dsh-external/dsh-doc-review，main=./lib/index.js；--patch overlay 加载时
 * 相对 main 被锚定为本目录 file:// URL，dsh-app-boot anchorInsertedPluginNames）。
 *
 * inject 清单（任务书 §2.3）：["tools","subagents","sessions","skills"]——
 * 用到的宿主服务必须全部声明；"llm"/"webServer" 本版本不需要（无型号路由预检、
 * 无报告查询 API），不追加。apply 内以 ctx.tools.register 注册 doc_review 工具
 * （代码注册，无 dsh.plugin.json——0.2.0-rc.2 内核无解析器）。
 *
 * apply 时核验 ctx.subagents.getProvider("spawn") 非空并落日志行
 * （doc_review_plugin_applied）；加载失败会在宿主 stdout 抛错（无 Cannot find
 * module 即通过）。
 */

import { logEvent } from "./logger.js";
import { createDocReviewTool } from "./tool.js";

/** 插件名（cordis.patch.yml 插件行 id=dsh-external/dsh-doc-review 的短名侧）。 */
const name = "dsh-doc-review";

/** 宿主服务依赖清单（任务书 §2.3；对照内核 .d.ts 核验：tools=ToolRuntime、
 * subagents=SubagentRuntime、sessions=SessionStore、skills=SkillRegistry）。 */
const inject = ["tools", "subagents", "sessions", "skills"];

/**
 * 插件装配入口（cordis apply 约定：export { apply }）。
 * @param {object} ctx cordis 上下文（含 inject 声明的服务）。
 * @returns {void}
 */
function apply(ctx) {
	const subagents = ctx.subagents;
	const spawnProvider = typeof subagents?.getProvider === "function" ? subagents.getProvider("spawn") : undefined;
	logEvent("doc_review_plugin_applied", {
		spawnProviderPresent: spawnProvider !== undefined && spawnProvider !== null
	});
	if (spawnProvider === undefined || spawnProvider === null) {
		// fail loud（不静默）：spawn provider 缺失时 doc_review 仍可注册，
		// 运行期 start() 抛错会走降级路径②（same-session），但冒烟必须能看到本行。
		ctx.logger?.warn?.("dsh-doc-review: subagents.getProvider('spawn') is empty; doc_review will degrade to same-session");
	}
	const disposeTool = ctx.tools.register(createDocReviewTool({ subagents }));
	logEvent("doc_review_tool_registered", { tool: "doc_review" });
	// cordis dispose 约定：apply 返回清理函数（插件卸载/重组时调用）。
	return () => {
		disposeTool();
		logEvent("doc_review_tool_disposed", { tool: "doc_review" });
	};
}

export { name, inject, apply };
