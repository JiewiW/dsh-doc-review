/**
 * test/smoke-apply.mjs —— host 入口装配冒烟（不启动实例，任务书 §2.2 布局项）。
 *
 * 验证链路：
 * 1. lib/index.js 可被 import（import 链上任何模块语法/解析错误在此暴露）；
 * 2. apply(mockCtx) 可执行：defineTool 在调用点即编译 parameters/output DSL
 *    （dsh-tools defineTool:838-871），DSL authorError（如 value 节点带 required、
 *    object 缺 additionalProperties）在此暴露，早于 3099 实例加载；
 * 3. inject 清单与导出形态符合 host 插件契约（{name, inject, apply}）；
 * 4. ctx.tools.register 被调用且返回 dispose；apply 返回清理函数可执行。
 *
 * 运行：node test/smoke-apply.mjs（退出码 0 = 通过）。
 */

import assert from "node:assert/strict";
import { apply, inject, name } from "../lib/index.js";

const registeredTools = [];
const warnings = [];

/** 最小 mock ctx：只实现 index.js apply 用到的面。 */
const mockCtx = {
	tools: {
		register(definition) {
			registeredTools.push(definition);
			return () => {};
		}
	},
	subagents: {
		getProvider(providerName) {
			return providerName === "spawn" ? { name: "spawn" } : undefined;
		}
	},
	logger: {
		warn(message) {
			warnings.push(message);
		}
	}
};

assert.equal(name, "dsh-doc-review");
assert.deepEqual(inject, ["tools", "subagents", "sessions", "skills"]);
assert.equal(typeof apply, "function");

const dispose = apply(mockCtx);

assert.equal(registeredTools.length, 1, "apply 必须注册恰一个工具");
const toolDefinition = registeredTools[0];
assert.equal(toolDefinition.name, "doc_review");
assert.equal(typeof toolDefinition.execute, "function");
// defineTool 返回对象形态（dsh-tools 实测）：{name,description,parameters,output:{schema,render},execute,isConcurrencySafe}
assert.equal(typeof toolDefinition.output?.render, "function");
assert.equal(toolDefinition.output?.schema?.type, "object");
assert.equal(typeof toolDefinition.isConcurrencySafe, "function");
assert.equal(typeof dispose, "function", "apply 必须返回清理函数");
dispose();

// spawn provider 缺失时应 warn 但不抛错（运行期降级路径②兜底）
const emptyCtx = {
	tools: { register: () => () => {} },
	subagents: { getProvider: () => undefined },
	logger: { warn: (message) => warnings.push(message) }
};
apply(emptyCtx);
assert.ok(warnings.some((message) => message.includes("spawn")), "provider 缺失必须 warn");

console.log("smoke-apply: PASS（apply 装配 + defineTool DSL 编译 + dispose 链路全通过）");
