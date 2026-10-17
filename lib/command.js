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
 * 输入框占位语义（0.2.2 起）：
 * - 定义声明 input.hint 后，支持 leadingInput 的客户端（Web GUI）在斜杠菜单
 *   回车时只把 `/doc-review ` 占位填入输入框（claim），不立即执行；用户继续
 *   输入文档路径/审阅需求后再次回车，整行作为一次 command.execute 提交。
 * - 裸命令（rawInput 去空白后为空）：仅激活，行为同 0.2.0/0.2.1；
 * - 带参命令：激活（或命中幂等）后把用户原文经 followup 当轮转发，模型本轮
 *   即可看到 doc_review 工具并直接发起审查，无需用户再发第二条消息。
 * - 带参转发框架（0.2.3 起）：2026-10-16 生产实测发现 0.2.2 的缺陷——带参
 *   followup 仍前置含「不要在没有用户审阅请求的情况下自行发起审查」的工具
 *   说明，用户只粘贴纯文件路径时，模型判读为“无明确审阅请求”而拒绝调用
 *   工具。0.2.3 起带参路径不再发送该禁令句，改用显式请求框架包装用户原文。
 *
 * followup 运行语义（S1-4 内核实测结论，dsh-agent runtime-types `followup`
 * 注释原文 "Queue an ordinary follow-up turn and wake the driver"）：
 * followup 会唤醒 driver 并自动开一个模型 turn（不同于 inject 的"不唤醒"）。
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

/**
 * 输入框占位提示（CommandInputDescriptor.hint）。
 * 声明后客户端在菜单回车时走 leading claim：只填入 `/doc-review ` 占位，
 * 不立即执行；与 /goal 的 input.hint 机制相同。
 */
export const COMMAND_INPUT_HINT = "[<文档路径或审阅需求>]";

/** 激活后注入模型的 followup 用户消息文本（仅首次激活且无随附请求时单独发送）。 */
const FOLLOWUP_TEXT = [
	"文档审阅工具 doc_review 已在本会话激活（仅当前会话可见）。",
	"当用户提出审阅请求时，调用 doc_review 工具执行审查：审查工作区文件时用",
	"target_file 传工作区相对路径（绝对路径与 .. 会被拒绝）；不要在没有用户",
	"审阅请求的情况下自行发起审查。"
].join("");

/**
 * 带参激活时的工具简述（0.2.3）。
 * 与 FOLLOWUP_TEXT 的差异：不含“不要自行发起审查”禁令——请求已随命令提交，
 * 禁令会让模型把随后的用户原文误判为“非审阅请求”（2026-10-16 生产实测缺陷）。
 */
const FOLLOWUP_TOOL_BRIEF_WITH_REQUEST =
	"文档审阅工具 doc_review 已在本会话激活（仅当前会话可见）。";

/**
 * 审阅请求转发框架（0.2.3）：显式声明这是随命令提交的审阅请求，
 * 指示模型当轮调用 doc_review；纯路径默认完整审阅；绝对路径先换算为
 * 工作区相对路径（doc_review 的 target_file 拒绝绝对路径与 ..）。
 */
const REQUEST_FRAME = [
	"用户已通过 /doc-review 命令提交审阅请求，请本轮立即调用 doc_review 工具执行审查",
	"（若请求原文只有文件路径，即默认对该文档执行完整审阅；target_file 必须传工作区",
	"相对路径，绝对路径与 .. 会被拒绝，用户给绝对路径时先换算）。请求原文如下："
].join("");

/** handler 返回文本：首次激活、无随附请求（target_file 为工作区相对路径）。 */
const SUCCESS_FIRST = [
	"doc-review 已激活（仅本会话）：doc_review 工具现在只在本会话对模型可见。",
	"请发送审阅请求开始，例如「审阅 docs/spec.md」（工作区相对路径）。",
	"会话关闭后激活失效，需在新会话重新执行 /doc-review。"
].join("");

/** handler 返回文本：首次激活且命令后随附审阅请求。 */
const SUCCESS_FIRST_WITH_REQUEST = [
	"doc-review 已激活（仅本会话），审阅请求已随命令提交，模型将在本轮调用",
	"doc_review 开始审查。"
].join("");

/** handler 返回文本：重复激活（幂等）、无随附请求。 */
const SUCCESS_ALREADY_ACTIVE = "doc-review 在本会话已处于激活状态（无需重复执行）。";

/** handler 返回文本：已激活且命令后随附新的审阅请求。 */
const SUCCESS_ALREADY_ACTIVE_WITH_REQUEST = "doc-review 在本会话已激活，审阅请求已提交，模型将在本轮调用 doc_review 开始审查。";

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
 * 从 invocation 提取用户随附的审阅请求原文（去首尾空白）。
 * @param {object | undefined} invocation CommandInvocation。
 * @returns {string} 去空白后的 rawInput；缺失或全空白时为空串。
 */
function extractRequest(invocation) {
	const rawInput = invocation?.rawInput;
	return typeof rawInput === "string" ? rawInput.trim() : "";
}

/**
 * 创建 /doc-review 指令定义（apply 时交给 ctx.commands.register）。
 * @param {{registerToolForAgent: (agent: object) => unknown}} deps
 *   registerToolForAgent(agent) 在 agent scope 注册 doc_review 工具定义，
 *   返回 disposer；由 lib/index.js 提供（闭包持有 subagents 服务与工具定义单例）。
 * @returns {object} CommandDefinition（definitionId/name/description/input/handler）。
 */
export function createDocReviewCommand({ registerToolForAgent }) {
	/** 已激活 agent 集合（WeakSet：见模块头注释的选型理由）。 */
	const activeAgents = new WeakSet();
	return {
		definitionId: COMMAND_DEFINITION_ID,
		name: COMMAND_NAME,
		description: "在本会话激活文档审阅工具 doc_review；可直接在命令后附文档路径或审阅需求（仅当前会话可见）",
		input: { hint: COMMAND_INPUT_HINT },
		handler: (invocation) => {
			const agent = invocation?.agent;
			const tools = scopedTools(agent);
			if (agent === null || agent === undefined || tools === null) {
				const reason = "invocation.agent.ctx.tools 不可得（非 agent-scoped 调用面）";
				logEvent("doc_review_activate_failed", { reason, command: COMMAND_NAME });
				return { kind: "error", text: `${ACTIVATE_FAILED_MARKER}：${reason}` };
			}
			const request = extractRequest(invocation);
			const alreadyActive = activeAgents.has(agent);
			if (!alreadyActive) {
				try {
					// 注册顺序：先工具后 followup ⇒ followup 唤醒的模型 turn 已能看到 doc_review。
					registerToolForAgent(agent);
					activeAgents.add(agent);
				} catch (error) {
					const reason = `scoped register 抛错：${String(error?.message ?? error)}`;
					logEvent("doc_review_activate_failed", { reason, command: COMMAND_NAME });
					return { kind: "error", text: `${ACTIVATE_FAILED_MARKER}：${reason}` };
				}
			} else {
				logEvent("doc_review_activate_skipped", { reason: "already-active", command: COMMAND_NAME });
			}
			// followup 内容（0.2.3 语义）：
			// - 带参：工具简述（仅首次，无禁令）＋显式请求框架＋用户原文独立块——框架
			//   明确声明“这是审阅请求、当轮须调用 doc_review”，避免 0.2.2 的
			//   “禁令＋纯路径”组合被模型误判为无请求；
			// - 裸命令首次激活：只发 FOLLOWUP_TEXT（含禁令，约束后续自由对话）；
			// - 裸命令重复激活：不发 followup。
			const content = [];
			if (request !== "") {
				if (!alreadyActive) {
					content.push({ type: "text", text: FOLLOWUP_TOOL_BRIEF_WITH_REQUEST });
				}
				content.push({ type: "text", text: REQUEST_FRAME });
				content.push({ type: "text", text: request });
			} else if (!alreadyActive) {
				content.push({ type: "text", text: FOLLOWUP_TEXT });
			}
			if (content.length > 0) {
				agent.followup(createUserMessage({ content, source: { kind: "user" } }));
			}
			logEvent("doc_review_activated", {
				command: COMMAND_NAME,
				scoped: true,
				alreadyActive,
				hasRequest: request !== ""
			});
			if (request !== "") {
				return {
					kind: "success",
					text: alreadyActive ? SUCCESS_ALREADY_ACTIVE_WITH_REQUEST : SUCCESS_FIRST_WITH_REQUEST
				};
			}
			return { kind: "success", text: alreadyActive ? SUCCESS_ALREADY_ACTIVE : SUCCESS_FIRST };
		}
	};
}
