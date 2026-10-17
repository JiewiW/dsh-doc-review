/**
 * test/command.test.mjs —— /doc-review 指令激活语义单测（S3-9，0.2.0 新增；0.2.2 扩）。
 *
 * 覆盖 lib/command.js createDocReviewCommand 的全部分支与 disposer 契约，
 * 全部用轻量假 ctx / 假 agent，禁止依赖真实网络与真实子进程。
 * 运行：node --test test/（本文件被 node:test 自动发现）。
 *
 * 断言清单：
 * - 定义形态：name="doc-review"、definitionId 品牌串、description 非空、
 *   input.hint 非空（0.2.2：菜单回车填入占位的开关）、handler 为函数；
 * - 首次激活：恰一次 scoped register（落在 agent.ctx.tools，不是全局）+ 恰一次
 *   followup（source.kind="user"、文本含 doc_review 与激活提示），返回 kind:"success"；
 * - 幂等：同一 agent 重复激活不重复注册、不重复 followup，返回"已处于激活状态"；
 * - 不同 agent 互不影响（会话隔离的单元证据）；
 * - 带参激活（0.2.2）：首次/已激活两种态下，followup 均转发用户请求原文；
 *   已激活态不重复注册、不重复发送工具说明；
 * - 带参转发框架（0.2.3）：followup 加显式请求框架（“立即调用 doc_review”），
 *   不再含“不要在没有用户审阅请求…自行发起审查”禁令句；裸命令激活保留禁令句；
 * - rawInput 仅空白时等同裸命令，不转发空请求；
 * - error 分支：agent/ctx/tools/register 面缺失 → kind:"error" 含
 *   doc_review_activate_failed，绝不抛出；register 抛错同理；
 * - error 分支不得留下激活态：error 后同一 agent 再走正常路径仍成功激活。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { ACTIVATE_FAILED_MARKER, COMMAND_INPUT_HINT, COMMAND_NAME, createDocReviewCommand } from "../lib/command.js";

/**
 * 构造假 agent（带 scoped tools 面）与注册/followup 记录器。
 * @param {object} [overrides] 覆盖 agent 的局部面（如 register 抛错、缺 ctx）。
 * @returns {{agent: object, scopedRegisters: object[], followups: object[], disposers: Function[]}} 探测集。
 */
function makeFakeAgent(overrides = {}) {
	const scopedRegisters = [];
	const followups = [];
	const disposers = [];
	const agent = {
		ctx: {
			tools: {
				register(definition) {
					scopedRegisters.push(definition);
					const disposer = () => {
						disposers.push("unwound");
					};
					return disposer;
				}
			}
		},
		followup(message) {
			followups.push(message);
		},
		...overrides
	};
	// overrides 显式传 ctx:null / tools 缺失时按传入值生效
	if ("ctx" in overrides) agent.ctx = overrides.ctx;
	return { agent, scopedRegisters, followups, disposers };
}

/**
 * 组装 command 工厂与记录器。
 * @param {object} [options] registerToolForAgent 行为选项。
 * @returns {{command: object, handler: Function, registerCalls: object[], disposers: unknown[]}} 探测集。
 */
function makeHarness(options = {}) {
	const registerCalls = [];
	const disposers = [];
	const command = createDocReviewCommand({
		registerToolForAgent: (agent) => {
			if (options.throwOnRegister) throw new Error(options.throwMessage ?? "scoped boom");
			registerCalls.push(agent);
			const disposer = typeof options.disposer === "function" ? options.disposer : () => {};
			disposers.push(disposer);
			return disposer;
		}
	});
	return { command, handler: command.handler, registerCalls, disposers };
}

/**
 * 构造 CommandInvocation 替身。
 * @param {object} agent 假 agent。
 * @param {string} [rawInput] 命令名之后的原文（含分隔空白），默认空串。
 * @returns {object} CommandInvocation 替身。
 */
function invocationOf(agent, rawInput = "") {
	return { commandId: "cmd-1", agent, rawInput, attachments: [], signal: new AbortController().signal };
}

/** 拼接 followup 消息全部文本块。 */
function followupText(message) {
	return message.content.map((block) => block.text).join("");
}

test("定义形态：doc-review 指令元数据齐全且声明 input.hint", () => {
	const { command } = makeHarness();
	assert.equal(command.name, COMMAND_NAME);
	assert.equal(command.name, "doc-review");
	assert.equal(typeof command.handler, "function");
	assert.equal(typeof command.description, "string");
	assert.ok(command.description.length > 0, "菜单摘要必须非空");
	assert.ok(String(command.definitionId).includes("dsh-doc-review"), "definitionId 须为本插件品牌串");
	assert.equal(typeof command.input, "object", "必须声明 input 描述符以启用菜单回车填入占位");
	assert.ok(command.input !== null);
	assert.equal(typeof command.input.hint, "string");
	assert.ok(command.input.hint.length > 0, "input.hint 必须非空");
	assert.equal(command.input.hint, COMMAND_INPUT_HINT);
});

test("首次激活：一次 scoped register + 一次 followup + success", () => {
	const { agent, followups } = makeFakeAgent();
	const { handler, registerCalls, disposers } = makeHarness();
	const result = handler(invocationOf(agent));
	assert.equal(result.kind, "success");
	assert.match(result.text, /已激活/);
	assert.equal(registerCalls.length, 1, "首次激活必须注册恰一次");
	assert.equal(registerCalls[0], agent, "必须把 invocation.agent 传给 registerToolForAgent");
	assert.equal(followups.length, 1, "首次激活必须 followup 恰一次");
	assert.equal(followups[0].source.kind, "user", "followup 消息 source 必须为 user");
	assert.match(followupText(followups[0]), /doc_review/, "followup 文本须告知模型工具名");
	assert.equal(typeof disposers[0], "function", "registerToolForAgent 必须返回 disposer");
});

test("幂等：重复激活不重复注册、不重复 followup", () => {
	const { agent } = makeFakeAgent();
	const { handler, registerCalls } = makeHarness();
	const first = handler(invocationOf(agent));
	const second = handler(invocationOf(agent));
	const third = handler(invocationOf(agent));
	assert.equal(first.kind, "success");
	assert.equal(second.kind, "success");
	assert.equal(third.kind, "success");
	assert.match(third.text, /已处于激活状态/);
	assert.equal(registerCalls.length, 1, "重复激活不得再次注册");
});

test("会话隔离：不同 agent 各自首次激活均生效", () => {
	const first = makeFakeAgent();
	const second = makeFakeAgent();
	const { handler, registerCalls } = makeHarness();
	assert.equal(handler(invocationOf(first.agent)).kind, "success");
	assert.equal(handler(invocationOf(first.agent)).text.includes("已处于激活状态"), true);
	assert.equal(handler(invocationOf(second.agent)).kind, "success");
	assert.equal(registerCalls.length, 2, "两个 agent 各注册一次");
	assert.equal(second.followups.length, 1, "第二个 agent 应收到自己的 followup");
});

test("首次激活带审阅请求：转发含请求框架与用户原文，禁令句不出现", () => {
	const { agent, followups } = makeFakeAgent();
	const { handler, registerCalls } = makeHarness();
	const requestText = "审阅 docs/spec.md，重点看完整性";
	const result = handler(invocationOf(agent, ` ${requestText} `));
	assert.equal(result.kind, "success");
	assert.match(result.text, /审阅请求已随命令提交/);
	assert.equal(registerCalls.length, 1, "带参首次激活仍只注册一次");
	assert.equal(followups.length, 1, "只产生一次 followup");
	assert.equal(followups[0].source.kind, "user");
	const blocks = followups[0].content;
	const fullText = followupText(followups[0]);
	assert.match(fullText, /doc_review/, "followup 须含 doc_review 工具名");
	assert.match(fullText, /立即调用 doc_review/, "转发必须带显式请求框架（指示当轮调用工具）");
	assert.ok(!fullText.includes("不要在没有用户"), "带参转发不得含禁令句，否则模型会误判无审阅请求");
	assert.ok(fullText.includes(requestText), "followup 必须原样携带用户审阅请求");
	assert.equal(blocks.at(-1).text, requestText, "用户请求原文须为最后一个文本块（去首尾空白后）");
});

test("已激活带审阅请求：不重复注册，但 followup 转发请求且 success", () => {
	const { agent, followups } = makeFakeAgent();
	const { handler, registerCalls } = makeHarness();
	const first = handler(invocationOf(agent));
	assert.equal(first.kind, "success");
	followups.length = 0;
	const requestText = "审阅 README.md 的事实准确性";
	const second = handler(invocationOf(agent, requestText));
	assert.equal(second.kind, "success");
	assert.match(second.text, /已激活，审阅请求已提交/);
	assert.equal(registerCalls.length, 1, "幂等激活不得再次注册");
	assert.equal(followups.length, 1, "带参重复激活必须转发一次请求");
	const fullText = followupText(followups[0]);
	assert.ok(fullText.includes(requestText), "转发内容必须是用户请求原文");
	assert.match(fullText, /立即调用 doc_review/, "转发必须带显式请求框架");
	assert.ok(!fullText.includes("不要在没有用户"), "带参转发不得含禁令句");
	assert.ok(!fullText.includes("已在本会话激活"), "已激活会话不再重复发送工具说明");
});

test("rawInput 仅含分隔空白时等同裸命令：不转发空请求", () => {
	const { agent, followups } = makeFakeAgent();
	const { handler, registerCalls } = makeHarness();
	const result = handler(invocationOf(agent, "     "));
	assert.equal(result.kind, "success");
	assert.match(result.text, /请发送审阅请求开始/);
	assert.equal(registerCalls.length, 1);
	assert.equal(followups.length, 1);
	assert.match(followupText(followups[0]), /doc_review/);
});

test("error 分支：agent 缺失返回 error 且不抛出", () => {
	const { handler, registerCalls } = makeHarness();
	let result;
	assert.doesNotThrow(() => {
		result = handler(invocationOf(undefined));
	}, "handler 禁止抛未捕获异常");
	assert.equal(result.kind, "error");
	assert.match(result.text, new RegExp(ACTIVATE_FAILED_MARKER));
	assert.equal(registerCalls.length, 0);
});

test("error 分支：agent.ctx / ctx.tools / tools.register 不可得各自返回 error", () => {
	const brokenAgents = [
		{ agent: {} },
		{ agent: { ctx: null } },
		{ agent: { ctx: {} } },
		{ agent: { ctx: { tools: {} } } },
		{ agent: { ctx: { tools: { register: "not-a-function" } } } }
	];
	for (const { agent } of brokenAgents) {
		const { handler, registerCalls } = makeHarness();
		let result;
		assert.doesNotThrow(() => {
			result = handler(invocationOf(agent));
		}, `scoped 面缺失不得抛出（${JSON.stringify(Object.keys(agent.ctx ?? agent))}）`);
		assert.equal(result.kind, "error");
		assert.match(result.text, new RegExp(ACTIVATE_FAILED_MARKER));
		assert.equal(registerCalls.length, 0);
	}
});

test("error 分支：scoped register 抛错被吞为 error，保留原始原因", () => {
	const { agent } = makeFakeAgent();
	const { handler } = makeHarness({ throwOnRegister: true, throwMessage: "already registered in this scope" });
	let result;
	assert.doesNotThrow(() => {
		result = handler(invocationOf(agent));
	}, "注册抛错不得外溢");
	assert.equal(result.kind, "error");
	assert.match(result.text, new RegExp(ACTIVATE_FAILED_MARKER));
	assert.match(result.text, /already registered in this scope/, "error 文本须含具体原因");
});

test("error 后不留激活态：失败→成功序列仍会注册并 followup", () => {
	const broken = { agent: { ctx: {} } };
	const working = makeFakeAgent();
	const { handler, registerCalls } = makeHarness();
	assert.equal(handler(invocationOf(broken.agent)).kind, "error");
	const ok = handler(invocationOf(working.agent));
	assert.equal(ok.kind, "success");
	assert.equal(registerCalls.length, 1);
	assert.equal(working.followups.length, 1);
});
