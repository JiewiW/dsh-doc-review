/**
 * lib/command.js —— /doc-review 斜杠指令（0.2.0 起的唯一激活入口）。
 *
 * 可见性语义（取代 0.1.x 的全局常驻注册）：
 * - apply 阶段不再向 ctx.tools 全局注册 doc_review ⇒ 未激活时工具 schema 完全
 *   不下发给模型（零 token 成本，零调用面）；
 * - 用户执行 /doc-review 后，handler 在 invocation.agent 的 **agent scope**
 *   （invocation.agent.ctx.tools.register）注册工具，仅该会话可见；
 * - 作用域注册由 agent ctx 生命周期在 dispose 时自动 unwind（dsh-agent
 *   runtime-types：agent-local contributions "unwind on disposal"），因此插件
 *   无需自持 disposer 遍历；激活集合用 WeakSet<Agent> 而非 Map：
 *   ①无需迭代卸载（上面已说明），②不阻止 Agent 对象回收，无内存残留；
 *   Map 方案需要额外订阅 agent dispose 才能防泄漏，收益相同而复杂度更高。
 *
 * followup 运行语义（S1-4 内核实测结论，dsh-agent runtime-types `followup`
 * 注释原文 "Queue an ordinary follow-up turn and wake the driver"）：
 * followup 会唤醒 driver 并自动开一个模型 turn（不同于 inject 的"不唤醒"）。
 * ⇒ 激活后模型立即看到本条用户消息并回应一次；但模型尚不知道要审哪份文档，
 *   故 handler 返回文本仍显式提示用户随后发送「审阅 <绝对路径>」。
 *
 * 错误纪律：任何失败（scoped ctx 不可得 / 注册抛错）一律返回
 * { kind:"error", text 含 doc_review_activate_failed + 具体原因 }，
 * 禁止向上抛未捕获异常（command 生命周期会把抛错记为 error，但不如自带
 * 可 grep 错误词清晰）。
 */

import { CommandDefinitionId } from "@deepseek-ai/dsh-commands/brand";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { logEvent } from "./logger.js";

/** 指令名（菜单与 `/doc-review` 输入匹配用，小写无斜杠）。 */
export const COMMAND_NAME = "doc-review";

/** 指令定义 ID（品牌化字符串，内核用它做定义归属；命名对照 goal/compact 先例）。 */
export const COMMAND_DEFINITION_ID = CommandDefinitionId("dsh-doc-review");

/** 可 grep 的失败错误词（任务书 6d）。 */
export const ACTIVATE_FAILED_MARKER = "doc_review_activate_failed";

/** 激活后注入模型的 followup 用户消息文本。 */
const FOLLOWUP_TEXT = [
	"文档审阅工具 doc_review 已在本会话激活（仅当前会话可见）。",
	"当用户提出审阅请求时，调用 doc_review 工具执行审查：审查工作区文件时用",
	"target_file 传工作区相对路径（绝对路径与 .. 会被拒绝）；不要在没有用户",
	"审阅请求的情况下自行发起审查。"
].join("");

/** handler 返回文本：首次激活（target_file 为工作区相对路径，示例用占位符）。 */
const SUCCESS_FIRST = [
	"doc-review 已激活（仅本会话）：doc_review 工具现在只在本会话对模型可见。",
	"请发送审阅请求开始，例如「审阅 docs/spec.md」（工作区相对路径）。",
	"会话关闭后激活失效，需在新会话重新执行 /doc-review。"
].join("");

/** handler 返回文本：重复激活（幂等）。 */
const SUCCESS_ALREADY_ACTIVE = "doc-review 在本会话已处于激活状态（无需重复执行）。";

/**
 * 取该 agent 的 scoped tools 注册面。
 * @param {object | undefined} agent CommandInvocation.agent。
 * @returns {{register: Function} | null} scoped ToolRuntime，不可得时 null。
 */
function scopedTools(agent) {
	const tools = agent?.ctx?.tools;
	if (tools === null || typeof tools !== "object") return null;
	if (typeof tools.register !== "function") return null;
	return tools;
}

/**
 * 创建 /doc-review 指令定义（apply 时交给 ctx.commands.register）。
 * @param {{registerToolForAgent: (agent: object) => unknown}} deps
 *   registerToolForAgent(agent) 在 agent scope 注册 doc_review 工具定义，
 *   返回 disposer；由 lib/index.js 提供（闭包持有 subagents 服务与工具定义单例）。
 * @returns {object} CommandDefinition（definitionId/name/description/handler）。
 */
export function createDocReviewCommand({ registerToolForAgent }) {
	/** 已激活 agent 集合（WeakSet：见模块头注释的选型理由）。 */
	const activeAgents = new WeakSet();
	return {
		definitionId: COMMAND_DEFINITION_ID,
		name: COMMAND_NAME,
		description: "在本会话激活文档审阅工具 doc_review（无参数，仅当前会话可见）",
		handler: (invocation) => {
			const agent = invocation?.agent;
			const tools = scopedTools(agent);
			if (agent === null || agent === undefined || tools === null) {
				const reason = "invocation.agent.ctx.tools 不可得（非 agent-scoped 调用面）";
				logEvent("doc_review_activate_failed", { reason, command: COMMAND_NAME });
				return { kind: "error", text: `${ACTIVATE_FAILED_MARKER}：${reason}` };
			}
			if (activeAgents.has(agent)) {
				logEvent("doc_review_activate_skipped", { reason: "already-active", command: COMMAND_NAME });
				return { kind: "success", text: SUCCESS_ALREADY_ACTIVE };
			}
			try {
				// 注册顺序：先工具后 followup ⇒ followup 唤醒的模型 turn 已能看到 doc_review。
				registerToolForAgent(agent);
				activeAgents.add(agent);
			} catch (error) {
				const reason = `scoped register 抛错：${String(error?.message ?? error)}`;
				logEvent("doc_review_activate_failed", { reason, command: COMMAND_NAME });
				return { kind: "error", text: `${ACTIVATE_FAILED_MARKER}：${reason}` };
			}
			agent.followup(createUserMessage({
				content: [{ type: "text", text: FOLLOWUP_TEXT }],
				source: { kind: "user" }
			}));
			logEvent("doc_review_activated", { command: COMMAND_NAME, scoped: true });
			return { kind: "success", text: SUCCESS_FIRST };
		}
	};
}
