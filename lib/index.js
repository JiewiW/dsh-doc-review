/**
 * lib/index.js —— dsh-doc-review 插件 host 入口（ESM，导出 {name, inject, apply}）。
 *
 * 挂载形态：bundle 包（package.json dsh.bundle.patch → cordis.patch.yml 插件行
 * id=dsh-external/dsh-doc-review，main=./lib/index.js；--patch overlay 加载时
 * 相对 main 被锚定为本目录 file:// URL，dsh-app-boot anchorInsertedPluginNames）。
 *
 * 0.2.0 可见性改造（破坏性变更）：apply 阶段 **不再** 全局注册 doc_review。
 * 改为注册 host 斜杠指令 /doc-review（@deepseek-ai/dsh-commands 服务名
 * "commands"，前端 / 菜单自动并入，无需 client 半边）；用户执行 /doc-review 后，
 * lib/command.js 的 handler 在该 agent 的 scoped ctx（agent.ctx.tools）注册
 * doc_review ⇒ 未激活时零工具 schema 下发（不耗 token、不可被模型调用）。
 *
 * inject 清单：["tools","commands","subagents","sessions","skills"]——
 * "tools" 仍保留（scoped 注册走 agent.ctx.tools，宿主 ToolRuntime 服务需在场；
 * 且 createDocReviewTool 的 defineTool 依赖 @deepseek-ai/dsh-tools 包本身）。
 * apply 内以 ctx.commands.register 注册指令（代码注册，无 dsh-plugin.json——
 * 0.2.0-rc.2 内核无解析器）。
 *
 * A01 证据：apply 时核验 ctx.subagents.getProvider("spawn") 非空并落日志行
 * （doc_review_plugin_applied）；指令注册成功落 doc_review_command_registered
 * （3099 冒烟 S4-11 的机检信号，配合无 Cannot find module 即通过）。
 * 注销：apply 返回清理函数（cordis dispose 约定），注销指令定义；scoped 工具
 * 注册由各 agent.ctx 生命周期在 dispose 时自动 unwind（见 lib/command.js 头注）。
 */

import { createDocReviewCommand } from "./command.js";
import { logEvent } from "./logger.js";
import { createDocReviewService, DOC_REVIEW_SERVICE_NAME } from "./service.js";
import { createDocReviewTool } from "./tool.js";

/** 插件名（cordis.patch.yml 插件行 id=dsh-external/dsh-doc-review 的短名侧）。 */
const name = "dsh-doc-review";

/** 宿主服务依赖清单（对照内核 .d.ts 核验：tools=ToolRuntime、commands=CommandRuntime、
 * subagents=SubagentRuntime、sessions=SessionStore、skills=SkillRegistry）。 */
const inject = ["tools", "commands", "subagents", "sessions", "skills"];

/**
 * 插件装配入口（cordis apply 约定：export { apply }）。
 * @param {object} ctx cordis 上下文（含 inject 声明的服务）。
 * @returns {Function} dispose 清理函数（注销指令）。
 */
function apply(ctx) {
	const subagents = ctx.subagents;
	const spawnProvider = typeof subagents?.getProvider === "function" ? subagents.getProvider("spawn") : undefined;
	logEvent("doc_review_plugin_applied", {
		spawnProviderPresent: spawnProvider !== undefined && spawnProvider !== null,
		globalToolRegistered: false
	});
	if (spawnProvider === undefined || spawnProvider === null) {
		// fail loud（不静默）：spawn provider 缺失时 doc_review 仍可激活，
		// 运行期 start() 抛错会走降级路径②（same-session），但冒烟必须能看到本行。
		ctx.logger?.warn?.("dsh-doc-review: subagents.getProvider('spawn') is empty; doc_review will degrade to same-session");
	}
	// v0.2.1：审查主干抽为 ctx service（工作名 docReview）。apply 阶段构造一个
	// 共享 service 实例（busy 表唯一、归档/重试/降级/dispose 集中），/doc-review
	// 工具与融合插件（inject:["docReview"] 或 file: 依赖自行构造）都调它。
	const reviewService = createDocReviewService({ subagents });
	// 工具定义惰性单例：首次激活时 defineTool 编译 DSL，之后各 agent scope 复用同一
	// definition（同名工具在不同 agent scope 注册互不影响；busy 表在 service 实例
	// 上按 parent session.id 键控，跨会话并发语义不受共享 definition 影响）。
	let toolDefinition = null;
	const registerToolForAgent = (agent) => {
		toolDefinition ??= createDocReviewTool({ subagents }, reviewService);
		return agent.ctx.tools.register(toolDefinition);
	};
	const disposeCommand = ctx.commands.register(createDocReviewCommand({ registerToolForAgent }));
	logEvent("doc_review_command_registered", { command: "doc-review" });
	// 暴露给融合插件等第三方调用方：ctx.docReview.reviewPrompt(...)。
	// 分叉版 cordis 无上游 ctx.service()，服务注册走 reflect.provide；返回的
	// disposer 同时被 fiber 注销自动调用，手动调幂等（disposing 标志位）。
	const stopProvide = ctx.reflect.provide(DOC_REVIEW_SERVICE_NAME, reviewService);
	logEvent("doc_review_service_provided", { service: DOC_REVIEW_SERVICE_NAME });
	// cordis dispose 约定：apply 返回清理函数（插件卸载/重组时调用）。
	return () => {
		if (typeof stopProvide === "function") stopProvide();
		reviewService.dispose();
		disposeCommand();
		logEvent("doc_review_command_disposed", { command: "doc-review" });
	};
}

export { name, inject, apply };
