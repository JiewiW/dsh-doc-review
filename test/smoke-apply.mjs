/**
 * test/smoke-apply.mjs —— host 入口装配冒烟（不启动实例，任务书 §2.2 布局项）。
 *
 * 验证链路（0.2.0 可见性改造后）：
 * 1. lib/index.js 可被 import（import 链上任何模块语法/解析错误在此暴露）；
 * 2. apply(mockCtx) 可执行：**不再**全局注册工具，改为 ctx.commands.register
 *    注册 /doc-review 指令；defineTool 的 DSL 编译发生在激活路径（本冒烟通过
 *    假 agent 触发一次激活来覆盖，dsh-tools defineTool:838-871），
 *    authorError（如 value 节点带 required、object 缺 additionalProperties）在此暴露；
 * 3. inject 清单与导出形态符合 host 插件契约（{name, inject, apply}），且含 "commands"；
 * 4. ctx.commands.register 被调用且返回 dispose；apply 返回清理函数可执行；
 * 5. 未激活时 ctx.tools.register 零调用（A02 零全局暴露的静态面证据）。
 *
 * 运行：node test/smoke-apply.mjs（退出码 0 = 通过）。
 */

import assert from "node:assert/strict";
import { apply, inject, name } from "../lib/index.js";

const registeredCommands = [];
const scopedRegisteredTools = [];
const providedServices = [];
const warnings = [];

/** 最小 mock ctx：只实现 index.js apply 用到的面。 */
function makeMockCtx() {
	return {
		tools: {
			// apply 阶段不应被调用；被调用即全局常驻回归（0.1.x 行为）。
			register(definition) {
				scopedRegisteredTools.push({ scope: "global", definition });
				return () => {};
			}
		},
		commands: {
			register(definition) {
				registeredCommands.push(definition);
				return () => {};
			}
		},
		subagents: {
			getProvider(providerName) {
				return providerName === "spawn" ? { name: "spawn" } : undefined;
			}
		},
		// v0.2.1：分叉版 cordis 服务注册走 ctx.reflect.provide(name, value)，
		// 返回 disposer（真实实现见 @deepseek-ai/cordis ReflectService.provide）。
		reflect: {
			provide(serviceName, serviceValue) {
				providedServices.push({ name: serviceName, value: serviceValue });
				return () => {};
			}
		},
		logger: {
			warn(message) {
				warnings.push(message);
			}
		}
	};
}

assert.equal(name, "dsh-doc-review");
assert.deepEqual(inject, ["tools", "commands", "subagents", "sessions", "skills"]);
assert.equal(typeof apply, "function");

const mockCtx = makeMockCtx();
const dispose = apply(mockCtx);

// —— 1) apply 只注册指令，不全局注册工具 ——
assert.equal(registeredCommands.length, 1, "apply 必须注册恰一个指令");
assert.equal(registeredCommands[0].name, "doc-review");
assert.equal(typeof registeredCommands[0].handler, "function");
assert.equal(scopedRegisteredTools.length, 0, "未激活时不得有任何工具注册（含全局）");
assert.equal(typeof dispose, "function", "apply 必须返回清理函数");

// —— 1b) v0.2.1：docReview service 经 reflect.provide 暴露，reviewPrompt 可调用 ——
assert.equal(providedServices.length, 1, "apply 必须恰提供一个 ctx service");
assert.equal(providedServices[0].name, "docReview");
assert.equal(typeof providedServices[0].value?.reviewPrompt, "function", "service 必须暴露 reviewPrompt");
assert.equal(typeof providedServices[0].value?.dispose, "function", "service 必须暴露 dispose");

// —— 2) 激活路径：假 agent 触发 handler，DSL 在 scoped 注册点编译 ——
const followups = [];
const fakeAgent = {
	ctx: {
		tools: {
			register(definition) {
				scopedRegisteredTools.push({ scope: "agent", definition });
				return () => {};
			}
		}
	},
	followup(message) {
		followups.push(message);
	}
};
const firstResult = registeredCommands[0].handler({ agent: fakeAgent, rawInput: "", attachments: [], signal: undefined });
assert.equal(firstResult.kind, "success", "首次激活必须 success");
assert.equal(scopedRegisteredTools.length, 1, "激活必须发生一次 agent-scoped 注册");
assert.equal(scopedRegisteredTools[0].scope, "agent", "注册必须落在 agent scope 而非全局");
assert.equal(scopedRegisteredTools[0].definition.name, "doc_review");
assert.equal(typeof scopedRegisteredTools[0].definition.execute, "function");
assert.equal(typeof scopedRegisteredTools[0].definition.output?.render, "function");
assert.equal(scopedRegisteredTools[0].definition.output?.schema?.type, "object");
assert.equal(typeof scopedRegisteredTools[0].definition.isConcurrencySafe, "function");
assert.equal(followups.length, 1, "首次激活必须恰一次 followup");
assert.equal(followups[0].source?.kind, "user");

// —— 3) 幂等 ——
const secondResult = registeredCommands[0].handler({ agent: fakeAgent, rawInput: "", attachments: [], signal: undefined });
assert.equal(secondResult.kind, "success");
assert.equal(scopedRegisteredTools.length, 1, "重复激活不得重复注册");
assert.equal(followups.length, 1, "重复激活不得重复 followup");

// —— 4) 错误分支：scoped ctx 不可得 ——
const errorResult = registeredCommands[0].handler({ agent: {}, rawInput: "", attachments: [], signal: undefined });
assert.equal(errorResult.kind, "error", "scoped ctx 不可得必须 error");
assert.match(errorResult.text, /doc_review_activate_failed/);

dispose();

// —— 5) spawn provider 缺失时应 warn 但不抛错（运行期降级路径②兜底）——
const emptyCtx = makeMockCtx();
emptyCtx.subagents.getProvider = () => undefined;
apply(emptyCtx);
assert.ok(warnings.some((message) => message.includes("spawn")), "provider 缺失必须 warn");

console.log("smoke-apply: PASS（apply 装配 + 未激活零工具注册 + 激活路径 DSL 编译 + 幂等 + error 分支全通过）");
