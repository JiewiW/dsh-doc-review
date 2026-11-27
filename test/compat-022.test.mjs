/**
 * test/compat-022.test.mjs —— DSH 0.2.2-rc.5 内核兼容性回归门禁。
 *
 * 背景：0.3.6 及以前插件把 5 个 @deepseek-ai 子包钉死在 0.2.0-rc.2，
 * 内核 0.2.2-rc.5 的版本栅栏会禁用 profile 的 tools / typert-gateway
 * 插件行（"Plugin ... is incompatible with dsh 0.2.2-rc.5"），doc-review
 * 的 inject 服务因此缺失。本测试锁死升级后的依赖声明与关键运行时导出，
 * 防止依赖回退或子包结构变化再次静默破坏兼容性。
 *
 * 运行：node --test test/compat-022.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pluginPackage = require("../package.json");

const EXPECTED_DEPENDENCIES = {
	"@deepseek-ai/dsh-commands": "0.2.2-rc.5",
	"@deepseek-ai/dsh-tools": "0.2.2-rc.5",
	"@deepseek-ai/dsh-api-gateway": "0.2.2-rc.5",
	"@deepseek-ai/dsh-jobs": "0.2.2-rc.5",
	"@deepseek-ai/dsh-llm": "0.2.2-rc.5",
	"@deepseek-ai/schemastery": "~3.19.0"
};

test("依赖声明精确匹配 0.2.2-rc.5 内核子包", () => {
	for (const [name, version] of Object.entries(EXPECTED_DEPENDENCIES)) {
		assert.equal(pluginPackage.dependencies[name], version, `${name} 版本必须对齐 0.2.2-rc.5`);
	}
	assert.equal(
		pluginPackage.peerDependencies["@deepseek-ai/dsh"],
		">=0.2.2-rc.5 <0.3.0-0",
		"peer 范围必须显式接纳 0.2.2-rc.5"
	);
});

test("0.2.2-rc.5 子包仍导出插件使用的运行时 API", async () => {
	const tools = await import("@deepseek-ai/dsh-tools");
	assert.equal(typeof tools.defineTool, "function");
	assert.equal(typeof tools.validateJsonSchemaValue, "function");
	assert.equal(typeof tools.ToolArgsError, "function");

	const llm = await import("@deepseek-ai/dsh-llm");
	assert.equal(typeof llm.createUserMessage, "function");

	const commandsBrand = await import("@deepseek-ai/dsh-commands/brand");
	assert.equal(typeof commandsBrand.CommandDefinitionId, "function");
});
