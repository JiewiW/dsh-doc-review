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
 * v0.3.0 审查派发重构：放弃 subagent，改为「开独立审查 session + 后台 job 监视 +
 * 收集结论文本」。inject 清单：["tools","commands","typertGateway","jobs","sessions","skills"]——
 * - "typertGateway"（@deepseek-ai/dsh-api-gateway 的 TypertGateway 服务）：session
 *   create/rename/selectModel/prompt/page/list/follow 全走它（task-board 同源）；
 * - "jobs"（@deepseek-ai/dsh-jobs 的 JobRegistry）：注册 doc-review 监视 job，
 *   后台轮询审查 session 进度，settle 时交付结论文本；
 * - "tools" 仍保留（scoped 注册走 agent.ctx.tools，宿主 ToolRuntime 服务需在场；
 *   且 createDocReviewTool 的 defineTool 依赖 @deepseek-ai/dsh-tools 包本身）。
 * apply 内以 ctx.commands.register 注册指令（代码注册，无 dsh-plugin.json——
 * 0.2.0-rc.2 内核无解析器）。
 *
 * A01 证据：apply 时核验 ctx.typertGateway / ctx.jobs 非空并落日志行
 * （doc_review_plugin_applied）；指令注册成功落 doc_review_command_registered
 * （隔离 profile 冒烟机检信号，配合无 Cannot find module 即通过）。
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
 * typertGateway=TypertGateway、jobs=JobRegistry、sessions=SessionStore、skills=SkillRegistry）。 */
const inject = ["tools", "commands", "typertGateway", "jobs", "sessions", "skills"];

/**
 * 插件装配入口（cordis apply 约定：export { apply }）。
 * @param {object} ctx cordis 上下文（含 inject 声明的服务）。
 * @returns {Function} dispose 清理函数（注销指令）。
 */
function apply(ctx) {
	const gateway = ctx.typertGateway;
	const jobs = ctx.jobs;
	const gatewayPresent = typeof gateway?.invoke === "function";
	const jobsPresent = typeof jobs?.start === "function";
	logEvent("doc_review_plugin_applied", {
		gatewayPresent,
		jobsPresent,
		globalToolRegistered: false
	});
	if (!gatewayPresent || !jobsPresent) {
		// fail loud（不静默）：gateway/jobs 缺失时 doc_review 仍可激活，
		// 运行期 invoke/start 抛错会走降级路径（start-error/same-session），
		// 但冒烟必须能看到本行。
		ctx.logger?.warn?.(
			`dsh-doc-review: gateway/jobs 服务缺失（gateway=${gatewayPresent}, jobs=${jobsPresent}）; ` +
			"doc_review 将降级（start-error/same-session）"
		);
	}
	// v0.2.1：审查主干抽为 ctx service（工作名 docReview）。service 构造延到首次
	// 取用（A01：cordis 不保证 apply 时 typertGateway/jobs 已就绪——缺服务时 apply
	// 只 warn 不抛错，降级（start-error/same-session）发生在运行期 invoke/start）。
	let reviewService = null;
	const ensureReviewService = () => {
		if (reviewService === null) {
			reviewService = createDocReviewService({ gateway, jobs });
		}
		return reviewService;
	};
	// 暴露给融合插件等第三方调用方：ctx.docReview.reviewPrompt(...)。
	// 分叉版 cordis 无上游 ctx.service()，服务注册走 reflect.provide；返回的
	// disposer 同时被 fiber 注销自动调用，手动调幂等（disposing 标志位）。
	// facade 用 getter 惰性落地真实 service，避免 apply 期强构造。
	const reviewServiceFacade = {
		get reviewPrompt() { return ensureReviewService().reviewPrompt; },
		get dispose() { return ensureReviewService().dispose; },
		SERVICE_NAME: DOC_REVIEW_SERVICE_NAME
	};
	// 工具定义惰性单例：首次激活时 defineTool 编译 DSL，之后各 agent scope 复用同一
	// definition（同名工具在不同 agent scope 注册互不影响；busy 表在 service 实例
	// 上按 parent session.id 键控，跨会话并发语义不受共享 definition 影响）。
	let toolDefinition = null;
	const registerToolForAgent = (agent) => {
		toolDefinition ??= createDocReviewTool({ gateway, jobs }, ensureReviewService());
		return agent.ctx.tools.register(toolDefinition);
	};
	const disposeCommand = ctx.commands.register(createDocReviewCommand({ registerToolForAgent }));
	logEvent("doc_review_command_registered", { command: "doc-review" });
	const stopProvide = ctx.reflect.provide(DOC_REVIEW_SERVICE_NAME, reviewServiceFacade);
	logEvent("doc_review_service_provided", { service: DOC_REVIEW_SERVICE_NAME });
	// cordis dispose 约定：apply 返回清理函数（插件卸载/重组时调用）。
	return () => {
		if (typeof stopProvide === "function") stopProvide();
		if (reviewService !== null) reviewService.dispose();
		disposeCommand();
		logEvent("doc_review_command_disposed", { command: "doc-review" });
	};
}

export { name, inject, apply };
