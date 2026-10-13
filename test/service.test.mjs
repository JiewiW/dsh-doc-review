/**
 * lib/service.js 单元测试（v0.2.1 DR3）。
 *
 * 覆盖：
 * - 构造校验（deps.subagents 必注入）；
 * - 入参结构化错误（targetContent 空/非字符串、未知 docType/skill、reviewerModel 空对象、
 *   parentAgent.session.id 缺失）——全部零子会话，抛 DocReviewArgumentError；
 * - DR1 闭合枚举：DOC_TYPES 冻结含 task-prompt；task-prompt 的 SKILL 锚点可提取
 *   （skillMissing=false，输入包含「领域背景」「审查规则」）；
 * - no-agent 信封（exec.agent 缺失，调用方转同会话自审）；
 * - report 成功路径：kind=report、round/chainId 归一、归档三文件落盘、attempts 透传；
 * - busy 互斥（同 parent 并发第二调得 busy 信封，不派子会话；释放后可再进）；
 * - beforeRun 短路（成本门）→ short-circuit 信封，零子会话；
 * - prepareResult 钩子 extras 与 report 覆盖；
 * - archive=false 不写盘；
 * - createDocReviewTool(deps, service) 与直调 service 共享同一 busy 域。
 *
 * 运行（仓库根目录）：node --test（Windows 下勿把 test 目录作位置参数）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDocReviewService, DocReviewArgumentError, DOC_REVIEW_SERVICE_NAME } from "../lib/service.js";
import { DOC_TYPES } from "../lib/schema.js";
import { buildReviewInput } from "../lib/context-builder.js";
import { ARCHIVE_FILE_NAMES } from "../lib/archive.js";
import { createDocReviewTool } from "../lib/tool.js";

/** 稳定原文引句（≥8 连续字符；issue.location 必须真实命中目标文本）。 */
const TARGET_SENTENCE = "这是一个用于service单元测试的稳定原文句子，包含足够长的定位引句。";

/**
 * 构造过 schema + reviewer 业务校验的子会话 structured 报告。
 * @param {object} [overrides] 字段覆盖。
 * @returns {object} 报告对象。
 */
function makeReport(overrides = {}) {
	return {
		summary: "测试报告：发现一处需要主 Agent 裁决处理的问题。",
		issues: [
			{
				id: "TP-C-01",
				dimension: "completeness",
				severity: "high",
				location: TARGET_SENTENCE,
				claim: "[D2] 缺少可运行命令与客观正信号，无法机检验收。",
				evidence: "no-reference",
				suggestion: "为每步补可运行命令与退出码/产物路径级正信号。"
			}
		],
		newIssueCount: 1,
		round: 1,
		chainId: "",
		...overrides
	};
}

/**
 * 构造 subagents stub。
 * @param {object} [options]
 * @param {object} [options.report] 子会话恒返回的 structured 报告（completed）。
 * @param {Function} [options.gate] start 被调时同步触发的钩子（用于制造并发占用）。
 * @param {Function} [options.resultFactory] 按调用次序返回 result（优先于 report）。
 * @returns {{deps: object, calls: object[], starts: number}} 探测集合。
 */
function makeSubagents({ report = makeReport(), gate, resultFactory } = {}) {
	const calls = [];
	const deps = {
		subagents: {
			getProvider: () => ({}),
			start: async (_provider, request) => {
				calls.push(request);
				if (typeof gate === "function") gate();
				const result = typeof resultFactory === "function" ? resultFactory(calls.length) : {
					stopReason: "completed",
					structured: report,
					output: []
				};
				return {
					id: `run-${calls.length}`,
					result: Promise.resolve(result),
					dispose: async () => {}
				};
			}
		}
	};
	return { deps, calls, get starts() { return calls.length; } };
}

/**
 * 构造最小 parentAgent stub。
 * @param {string} cwd 工作区根。
 * @param {string} [sessionId] 父会话 id。
 * @returns {object} agent stub。
 */
function makeParentAgent(cwd, sessionId = "sess-parent") {
	return {
		session: {
			id: sessionId,
			header: { cwd },
			deriveMessages: () => []
		}
	};
}

/** 构造一个临时工作区并返回路径。 */
function makeTempWorkspace() {
	return mkdtempSync(join(tmpdir(), "dsh-doc-review-svc-"));
}

/**
 * 外部可控 deferred（规避在 Promise executor 内给 const 自身赋值的 TDZ 问题）。
 * @returns {{promise: Promise, resolve: Function, reject: Function}} deferred。
 */
function makeDeferred() {
	const deferred = {};
	deferred.promise = new Promise((resolve, reject) => {
		deferred.resolve = resolve;
		deferred.reject = reject;
	});
	return deferred;
}

/* ========================================================================= */
/* SVC-1：构造校验                                                            */
/* ========================================================================= */

test("SVC-1 createDocReviewService：deps/subagents 缺失抛 TypeError", () => {
	assert.throws(() => createDocReviewService(), TypeError);
	assert.throws(() => createDocReviewService({}), TypeError);
	assert.throws(() => createDocReviewService({ subagents: null }), TypeError);
	const service = createDocReviewService(makeSubagents().deps);
	assert.equal(typeof service.reviewPrompt, "function");
	assert.equal(typeof service.dispose, "function");
	assert.equal(service.SERVICE_NAME, DOC_REVIEW_SERVICE_NAME);
});

/* ========================================================================= */
/* SVC-2：入参结构化错误（零子会话）                                          */
/* ========================================================================= */

test("SVC-2 reviewPrompt：非法入参抛 DocReviewArgumentError 且零子会话", async () => {
	const harness = makeSubagents();
	const service = createDocReviewService(harness.deps);
	const agent = makeParentAgent(makeTempWorkspace());

	await assert.rejects(
		() => service.reviewPrompt({ targetContent: "", parentAgent: agent }),
		(err) => err instanceof DocReviewArgumentError && err.code === "DOC_REVIEW_INVALID_ARGUMENT"
	);
	await assert.rejects(
		() => service.reviewPrompt({ targetContent: 123, parentAgent: agent }),
		DocReviewArgumentError
	);
	await assert.rejects(
		() => service.reviewPrompt({ targetContent: null, parentAgent: agent }),
		DocReviewArgumentError
	);
	// 未知 docType / 未知 skill：闭合枚举，不允许 generic 之外的未登记值绕过。
	await assert.rejects(
		() => service.reviewPrompt({ targetContent: TARGET_SENTENCE, docType: "legal", parentAgent: agent }),
		DocReviewArgumentError
	);
	await assert.rejects(
		() => service.reviewPrompt({ targetContent: TARGET_SENTENCE, skill: "unknown-doc", parentAgent: agent }),
		DocReviewArgumentError
	);
	// reviewerModel 存在但 provider/model 都缺。
	await assert.rejects(
		() => service.reviewPrompt({ targetContent: TARGET_SENTENCE, reviewerModel: {}, parentAgent: agent }),
		DocReviewArgumentError
	);
	// parentAgent 存在但 session.id 缺失。
	await assert.rejects(
		() => service.reviewPrompt({ targetContent: TARGET_SENTENCE, parentAgent: { session: {} } }),
		DocReviewArgumentError
	);
	assert.equal(harness.starts, 0, "任何参数错误都不得派发子会话");
});

/* ========================================================================= */
/* SVC-3：DR1 闭合枚举 + task-prompt SKILL 锚点可提取                         */
/* ========================================================================= */

test("SVC-3 DOC_TYPES 冻结且含 task-prompt；task-prompt 输入包含两锚点", () => {
	assert.ok(Object.isFrozen(DOC_TYPES), "DOC_TYPES 必须冻结");
	assert.deepEqual([...DOC_TYPES], ["generic", "tech-spec", "product-doc", "task-prompt"]);
	const built = buildReviewInput({
		targetText: TARGET_SENTENCE,
		docType: "task-prompt",
		dimensions: { fact: true, completeness: true, necessity: true, format: true }
	});
	assert.equal(built.skillMissing, false, "task-prompt SKILL.md 必须存在且锚点提取成功");
	assert.match(built.inputText, /领域背景/);
	assert.match(built.inputText, /审查规则/);
	// D1–D11 规则编号必须随 SKILL 进入输入包（审查子会话据此出 claim 编号）。
	for (const ruleNo of ["D1", "D2", "D7", "D10", "D11"]) {
		assert.match(built.inputText, new RegExp(ruleNo), `输入包必须含规则编号 ${ruleNo}`);
	}
});

/* ========================================================================= */
/* SVC-4：no-agent 信封（转同会话自审，不派子会话）                           */
/* ========================================================================= */

test("SVC-4 reviewPrompt：parentAgent 缺失 → no-agent 信封且零子会话", async () => {
	const harness = makeSubagents();
	const service = createDocReviewService(harness.deps);
	const envelope = await service.reviewPrompt({ targetContent: TARGET_SENTENCE, docType: "task-prompt" });
	assert.equal(envelope.kind, "no-agent");
	assert.equal(envelope.docType, "task-prompt");
	assert.equal(typeof envelope.inputText, "string");
	assert.ok(envelope.inputText.length > 0);
	assert.equal(harness.starts, 0);
});

/* ========================================================================= */
/* SVC-5：report 成功路径 + 归档                                              */
/* ========================================================================= */

test("SVC-5 reviewPrompt：task-prompt 成功 → report 信封且归档三文件", async () => {
	const cwd = makeTempWorkspace();
	const harness = makeSubagents();
	const service = createDocReviewService(harness.deps);
	const envelope = await service.reviewPrompt({
		targetContent: TARGET_SENTENCE,
		docType: "task-prompt",
		parentAgent: makeParentAgent(cwd),
		workspaceRoot: cwd
	});
	assert.equal(envelope.kind, "report");
	assert.equal(envelope.docType, "task-prompt");
	assert.equal(envelope.attempts, 1, "首次合法报告即采纳，attempts=1");
	assert.equal(envelope.report.round, 1);
	assert.equal(envelope.report.chainId, "");
	assert.equal(envelope.report.issues[0].id, "TP-C-01");
	// 归档：round-1 目录三文件齐全，report JSON 可解析且含 task-prompt 审查产物。
	assert.ok(envelope.archivePath, "必须返回归档目录");
	const reportPath = join(envelope.archivePath, ARCHIVE_FILE_NAMES.report);
	const documentPath = join(envelope.archivePath, ARCHIVE_FILE_NAMES.document);
	const changeLogPath = join(envelope.archivePath, ARCHIVE_FILE_NAMES.changeLog);
	assert.ok(existsSync(reportPath) && existsSync(documentPath) && existsSync(changeLogPath), "归档三文件必须落盘");
	const archived = JSON.parse(readFileSync(reportPath, "utf8"));
	assert.equal(archived.issues[0].id, "TP-C-01");
	assert.equal(readFileSync(documentPath, "utf8"), TARGET_SENTENCE);
	assert.equal(harness.starts, 1);
});

/* ========================================================================= */
/* SVC-6：busy 互斥                                                           */
/* ========================================================================= */

test("SVC-6 reviewPrompt：同 parent 并发第二调得 busy 信封，释放后可再进", async () => {
	const cwd = makeTempWorkspace();
	// 外部可控 deferred：start 被调即放行 gate，但 result 等到测试显式 resolve 才有结果，
	// 保证第一调在 busy 窗口内（inflight 已置位、子会话在途）。
	let resolveStart;
	const gatePassed = new Promise((resolve) => {
		resolveStart = resolve;
	});
	const pendingResult = makeDeferred();
	const harness = makeSubagents();
	harness.deps.subagents.start = async (_provider, request) => {
		harness.calls.push(request);
		resolveStart();
		return {
			id: `run-${harness.calls.length}`,
			result: pendingResult.promise.then(() => ({ stopReason: "completed", structured: makeReport(), output: [] })),
			dispose: async () => {}
		};
	};
	const service = createDocReviewService(harness.deps);
	const agent = makeParentAgent(cwd, "sess-busy");

	const firstPromise = service.reviewPrompt({ targetContent: TARGET_SENTENCE, parentAgent: agent, workspaceRoot: cwd });
	await gatePassed; // 第一调已进入 inflight（start 已发、result 未回）。

	const busyEnvelope = await service.reviewPrompt({
		targetContent: TARGET_SENTENCE,
		parentAgent: makeParentAgent(cwd, "sess-busy"),
		workspaceRoot: cwd
	});
	assert.equal(busyEnvelope.kind, "busy");
	assert.equal(busyEnvelope.docType, "generic", "缺省 docType=generic");
	assert.equal(harness.starts, 1, "busy 命中不得派发第二次子会话");

	pendingResult.resolve();
	const firstEnvelope = await firstPromise;
	assert.equal(firstEnvelope.kind, "report");

	const againEnvelope = await service.reviewPrompt({
		targetContent: TARGET_SENTENCE,
		parentAgent: makeParentAgent(cwd, "sess-busy"),
		workspaceRoot: cwd
	});
	assert.equal(againEnvelope.kind, "report", "释放后 busy 表必须清除，可再次进入");
});

/* ========================================================================= */
/* SVC-7：beforeRun 短路（成本门）                                            */
/* ========================================================================= */

test("SVC-7 reviewPrompt：beforeRun 返回非 null → short-circuit 且零子会话", async () => {
	const cwd = makeTempWorkspace();
	const harness = makeSubagents();
	const service = createDocReviewService(harness.deps);
	const gateValue = { confirmationRequired: true, costEstimate: { worstCaseTokens: 21000 } };
	const seenBeforeRun = [];
	const envelope = await service.reviewPrompt({
		targetContent: TARGET_SENTENCE,
		docType: "task-prompt",
		parentAgent: makeParentAgent(cwd),
		workspaceRoot: cwd,
		beforeRun: (context) => {
			seenBeforeRun.push(context);
			return gateValue;
		}
	});
	assert.equal(envelope.kind, "short-circuit");
	assert.equal(envelope.value, gateValue);
	assert.equal(seenBeforeRun.length, 1);
	assert.equal(seenBeforeRun[0].docType, "task-prompt");
	assert.equal(typeof seenBeforeRun[0].inputText, "string");
	assert.equal(harness.starts, 0, "短路不得派发子会话");
});

/* ========================================================================= */
/* SVC-8：prepareResult 钩子 extras 与 round/chainId 覆盖                     */
/* ========================================================================= */

test("SVC-8 reviewPrompt：prepareResult 返回 extras 且 round/chainId 归一", async () => {
	const cwd = makeTempWorkspace();
	const harness = makeSubagents();
	const service = createDocReviewService(harness.deps);
	const envelope = await service.reviewPrompt({
		targetContent: TARGET_SENTENCE,
		parentAgent: makeParentAgent(cwd),
		workspaceRoot: cwd,
		chain: { chainId: "docr-chain-x", round: 2 },
		prepareResult: ({ report }) => ({
			report: { ...report, newIssueCount: 0 },
			extras: { converged: true, changeRatio: 0.1 }
		})
	});
	assert.equal(envelope.kind, "report");
	assert.equal(envelope.report.chainId, "docr-chain-x", "chainId 必须由 service 覆盖到报告");
	assert.equal(envelope.report.round, 2);
	assert.equal(envelope.extras.converged, true);
	assert.equal(envelope.extras.changeRatio, 0.1);
});

/* ========================================================================= */
/* SVC-9：archive=false 不写盘                                                */
/* ========================================================================= */

test("SVC-9 reviewPrompt：archive=false → archivePath 为 null 且不写盘", async () => {
	const cwd = makeTempWorkspace();
	const harness = makeSubagents();
	const service = createDocReviewService(harness.deps);
	const envelope = await service.reviewPrompt({
		targetContent: TARGET_SENTENCE,
		parentAgent: makeParentAgent(cwd),
		workspaceRoot: cwd,
		archive: false
	});
	assert.equal(envelope.kind, "report");
	assert.equal(envelope.archivePath, null);
	assert.ok(!existsSync(join(cwd, ".doc-review")), "archive=false 不得创建归档目录");
});

/* ========================================================================= */
/* SVC-10：工具与共享 service 同一 busy 域                                    */
/* ========================================================================= */

test("SVC-10 createDocReviewTool(deps, service)：工具与直调共享 busy 表", async () => {
	const cwd = makeTempWorkspace();
	let releaseGate;
	const gatePassed = new Promise((resolve) => {
		releaseGate = resolve;
	});
	const harness = makeSubagents();
	const pending = makeDeferred();
	harness.deps.subagents.start = async (_provider, request) => {
		harness.calls.push(request);
		releaseGate();
		return {
			id: `run-${harness.calls.length}`,
			result: pending.promise.then(() => ({ stopReason: "completed", structured: makeReport(), output: [] })),
			dispose: async () => {}
		};
	};
	const service = createDocReviewService(harness.deps);
	const agent = makeParentAgent(cwd, "sess-shared");

	// 直调 service 占住 busy。
	const occupied = service.reviewPrompt({ targetContent: TARGET_SENTENCE, parentAgent: agent, workspaceRoot: cwd });
	await gatePassed;

	// 工具走同一 service（第二参数注入），同 parent 必须命中 busy 降级而非另派子会话。
	const tool = createDocReviewTool(harness.deps, service);
	const exec = {
		agent,
		signal: { aborted: false, addEventListener() {}, removeEventListener() {} },
		deferContext() {},
		concludeTurn() {}
	};
	const result = await tool.execute(
		{ doc_type: "generic", target_content: TARGET_SENTENCE },
		exec
	);
	assert.equal(result.degraded, "busy", "工具必须命中 busy 降级信封");
	assert.equal(harness.starts, 1, "共享 busy 域：工具不得再派一个子会话");

	pending.resolve();
	const envelope = await occupied;
	assert.equal(envelope.kind, "report");
});

/* ========================================================================= */
/* SVC-11：dispose 清空 busy 表                                               */
/* ========================================================================= */

test("SVC-11 dispose：清空后新调用可进入（busy 表已清）", async () => {
	const cwd = makeTempWorkspace();
	const harness = makeSubagents();
	const service = createDocReviewService(harness.deps);
	service.dispose();
	const envelope = await service.reviewPrompt({
		targetContent: TARGET_SENTENCE,
		parentAgent: makeParentAgent(cwd),
		workspaceRoot: cwd
	});
	assert.equal(envelope.kind, "report");
	assert.equal(harness.starts, 1);
});

/* ========================================================================= */
/* SVC-12：reviewerModel.reasoningEffort 透传到 spawn agentOptions            */
/* ========================================================================= */

test("SVC-12 reviewerModel：reasoningEffort 随 provider/model 透传给子会话请求", async () => {
	const cwd = makeTempWorkspace();
	const harness = makeSubagents();
	const service = createDocReviewService(harness.deps);
	const envelope = await service.reviewPrompt({
		targetContent: TARGET_SENTENCE,
		parentAgent: makeParentAgent(cwd),
		workspaceRoot: cwd,
		archive: false,
		reviewerModel: { provider: "qoder", model: "qfmodel", reasoningEffort: "xhigh" }
	});
	assert.equal(envelope.kind, "report");
	assert.equal(harness.starts, 1);
	assert.deepEqual(harness.calls[0].agentOptions, {
		provider: "qoder",
		model: "qfmodel",
		reasoningEffort: "xhigh"
	});
});

test("SVC-12b reviewerModel 未带 reasoningEffort：agentOptions 不挂该键", async () => {
	const cwd = makeTempWorkspace();
	const harness = makeSubagents();
	const service = createDocReviewService(harness.deps);
	const envelope = await service.reviewPrompt({
		targetContent: TARGET_SENTENCE,
		parentAgent: makeParentAgent(cwd),
		workspaceRoot: cwd,
		archive: false,
		reviewerModel: { model: "some-model" }
	});
	assert.equal(envelope.kind, "report");
	assert.deepEqual(harness.calls[0].agentOptions, { model: "some-model" });
	assert.equal("reasoningEffort" in harness.calls[0].agentOptions, false);
});
