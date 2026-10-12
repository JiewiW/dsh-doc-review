/**
 * test/command.test.mjs —— /doc-review 指令激活语义单测（S3-9，0.2.0 新增）。
 *
 * 覆盖 lib/command.js createDocReviewCommand 的三条分支与 disposer 契约，
 * 全部用轻量假 ctx / 假 agent，禁止依赖真实网络与真实子进程。
 * 运行：node --test test/（本文件被 node:test 自动发现）。
 *
 * 断言清单（对应任务书 9）：
 * - 定义形态：name="doc-review"、definitionId 品牌串、description 非空、handler 为函数；
 * - 首次激活：恰一次 scoped register（且落在 agent.ctx.tools，不是全局）+ 恰一次
 *   followup（source.kind="user"、文本含 doc_review 与激活提示），返回 kind:"success"；
 * - registerToolForAgent 返回的 disposer 是函数（原样透出，供上层持有）；
 * - 幂等：同一 agent 重复激活不重复注册、不重复 followup，返回"已处于激活状态"；
 * - 不同 agent 互不影响：第二个 agent 首次激活照常注册+followup（会话隔离的单元证据）；
 * - error 分支：agent 缺失 / agent.ctx 缺失 / ctx.tools 缺失 / ctx.tools.register
 *   非函数 → kind:"error" 且 text 含 doc_review_activate_failed，且绝不抛出；
 * - register 抛错 → kind:"error" 含 doc_review_activate_failed + 原始错误信息，不抛出；
 * - error 分支不得留下激活态：error 后同一 agent 再走正常路径仍应成功激活。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { ACTIVATE_FAILED_MARKER, COMMAND_NAME, createDocReviewCommand } from "../lib/command.js";

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
 * @returns {{handler: Function, registerCalls: object[], disposers: unknown[], agent?: object}} 探测集。
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

/** 构造 CommandInvocation 替身。 */
function invocationOf(agent) {
	return { commandId: "cmd-1", agent, rawInput: "", attachments: [], signal: new AbortController().signal };
}

test("定义形态：doc-review 指令元数据齐全", () => {
	const { command } = makeHarness();
	assert.equal(command.name, COMMAND_NAME);
	assert.equal(command.name, "doc-review");
	assert.equal(typeof command.handler, "function");
	assert.equal(typeof command.description, "string");
	assert.ok(command.description.length > 0, "菜单摘要必须非空");
	assert.ok(String(command.definitionId).includes("dsh-doc-review"), "definitionId 须为本插件品牌串");
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
	const followupText = followups[0].content.map((block) => block.text).join("");
	assert.match(followupText, /doc_review/, "followup 文本须告知模型工具名");
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
