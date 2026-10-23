/**
 * lib/service.js —— v0.3.0：doc_review 审查主干 ctx service。
 *
 * 从 tool.js 抽出的与 ToolRunContext 无关的审查主干：
 *   组装审查输入包（buildReviewInput，含 SKILL 锚点机械提取）
 *   → busy 互斥（按 parent session.id）
 *   → 开独立审查 session + 后台 job 监视（runReviewerSession：新 session + job 轮询 +
 *     收集结论文本，总尝试 ≤3=1+2 重试；v0.3.0 起放弃 subagent）
 *   → 结构化报告归一化与轮次归档（writeRoundArchive）
 *   → 降级标记（freeform-parse/same-session/timeout/aborted/busy）
 *
 * 注册形态：index.js apply 内 createDocReviewService({gateway, jobs}) 构造单例，
 * 经 ctx.provide("docReview", service) 暴露（cordis 分叉 fiber 作用域服务，
 * unload 自动注销）；融合插件以 inject:["docReview"] 取用，或 file: 依赖直接
 * import { createDocReviewService } from "dsh-doc-review/service.js" 自行构造。
 *
 * 刻意留在工具层（与 DSL/exec 紧耦合，service 不感知）：
 *   参数 DSL 校验、target 三选一解析、references 文件读取、sample 抽样、
 *   T10 成本门（beforeRun 钩子）、T08 多轮复算与裁决表（prepareResult 钩子）、
 *   deferContext、TOOL_OUTPUT_SPEC 渲染。
 */
import { validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";

import { writeRoundArchive } from "./archive.js";
import { buildReviewInput } from "./context-builder.js";
import { logEvent } from "./logger.js";
import { runReviewerSession } from "./session-reviewer.js";
import { DOC_TYPES } from "./schema.js";

/** ctx.provide 服务名（融合插件 inject:["docReview"]；ctx.docReview.reviewPrompt）。 */
export const DOC_REVIEW_SERVICE_NAME = "docReview";

/** reviewPrompt 入参 skill/docType 别名 → DOC_TYPES 归一（当前同名，保留别名语义）。 */
const SKILL_ALIAS = Object.freeze({
	generic: "generic",
	"tech-spec": "tech-spec",
	"product-doc": "product-doc",
	"task-prompt": "task-prompt"
});

/**
 * service 入参结构化错误（未知 doc_type/skill、缺 targetContent 等；零子会话）。
 * 工具路径下内核 DSL enum 已先拦截，不会走到这里；直调 service 的调用方靠 code 分支。
 */
export class DocReviewArgumentError extends Error {
	/**
	 * @param {string} message 违规描述。
	 */
	constructor(message) {
		super(message);
		this.name = "DocReviewArgumentError";
		this.code = "DOC_REVIEW_INVALID_ARGUMENT";
	}
}

/**
 * 把 reviewer_model 覆盖归一为 selectModel 入参（provider/model 至少一项）。
 * @param {{provider?: string, model?: string, reasoningEffort?: string}|null|undefined} reviewerModel 模型覆盖。
 * @returns {object|undefined} selectModel 入参。
 */
function resolveAgentOptions(reviewerModel) {
	if (reviewerModel === undefined || reviewerModel === null) return undefined;
	const provider = reviewerModel.provider;
	const model = reviewerModel.model;
	if (provider === undefined && model === undefined) {
		throw new DocReviewArgumentError("reviewerModel 至少提供 provider/model 之一");
	}
	const agentOptions = {};
	if (provider !== undefined) agentOptions.provider = provider;
	if (model !== undefined) agentOptions.model = model;
	// reasoningEffort 等模型能力档位透传：qoder 渠道缺该字段时结构化扩展装配可能拿到 undefined 能力对象。
	const reasoningEffort = reviewerModel.reasoningEffort;
	if (reasoningEffort !== undefined && reasoningEffort !== null) {
		agentOptions.reasoningEffort = reasoningEffort;
	}
	return agentOptions;
}

/**
 * 创建 doc_review 审查 service（单例；apply 内构造一次，工具与融合调用方共用）。
 * @param {{gateway: {invoke: Function, stream?: Function}, jobs: {start: Function, wait: Function, read: Function, kill: Function}}} deps
 *   内核 typertGateway 与 jobs 服务。
 * @returns {{reviewPrompt: Function, dispose: Function}} service 实例。
 */
export function createDocReviewService(deps) {
	if (!deps || typeof deps.gateway !== "object" || deps.gateway === null) {
		throw new TypeError("createDocReviewService: deps.gateway 为必注入服务");
	}
	if (!deps || typeof deps.jobs !== "object" || deps.jobs === null) {
		throw new TypeError("createDocReviewService: deps.jobs 为必注入服务");
	}
	/** busy 互斥表：parent session.id → 进入时间戳（service 单例级共享）。 */
	const inflightByParent = new Map();

	/**
	 * 对一份已解析为纯文本的目标内容发起独立子会话审查。
	 *
	 * @param {object} params 入参。
	 * @param {string} params.targetContent 目标文本（调用方已完成三选一解析与抽样）。
	 * @param {string} [params.skill] 技能名（"task-prompt" 等；与 docType 二选一，优先 skill）。
	 * @param {string} [params.docType] doc_type 闭合枚举值（默认 generic）。
	 * @param {Record<string, boolean>} [params.dimensions] 四维度开关，缺省全 true。
	 * @param {string[]} [params.references] 已解析为内联文本的参考资料。
	 * @param {object|null} [params.prevReport] 多轮上一轮报告（进输入包）。
	 * @param {{provider?: string, model?: string}} [params.reviewerModel] 审查员模型覆盖。
	 * @param {AbortSignal} [params.signal] 外部取消信号。
	 * @param {object} [params.parentAgent] 父 Agent 句柄（session.id/header.cwd）；缺失显式降级。
	 * @param {string} [params.workspaceRoot] 归档根；缺省取 parentAgent 会话 cwd，再退 process.cwd()。
	 * @param {string} [params.archiveDocumentText] 归档保存的完整原文（抽样时区别于送审文本）。
	 * @param {object} [params.chain] 多轮链上下文 {chainId, round, prevAdjudication?}。
	 * @param {boolean} [params.archive=true] 是否写轮次归档。
	 * @param {number} [params.timeoutMs] 子会话总超时（默认见 reviewer.js 600s）。
	 * @param {Function} [params.beforeRun] 派发前钩子（如 T10 成本门）：返回非 null 信封则短路，不派子会话。
	 * @param {Function} [params.prepareResult] 报告落盘前钩子（裁决引导/T08 复算/链成本态）：
	 *   ({report, skillMissing, inputText}) => ({report, extras?})。
	 * @param {(record: {attempt: number, stopReason: string, reason: string,
	 *   violations: string[], willRetry: boolean}) => void} [params.onRetry]
	 *   审查员每次尝试失败时的同步回调（工具层用于向主 Agent 窗口暴露重试提示）。
	 * @returns {Promise<object>} 判别联合信封（kind: report/freeform/aborted/timeout/
	 *   start-error/busy/no-agent/short-circuit）。
	 */
	async function reviewPrompt(params) {
		if (params === null || typeof params !== "object") {
			throw new DocReviewArgumentError("reviewPrompt: 参数必须是对象");
		}
		const targetContent = params.targetContent;
		if (typeof targetContent !== "string" || targetContent.length === 0) {
			throw new DocReviewArgumentError("reviewPrompt: targetContent 必须是非空字符串");
		}
		// 注意：不能用 SKILL_ALIAS[x] ?? "generic"——未知键查表得 undefined 会被
		// ?? 吞成 generic，导致闭合枚举被绕过。必须区分「未传」与「传了未知值」。
		let docType;
		if (params.skill !== undefined) docType = SKILL_ALIAS[params.skill];
		else if (params.docType !== undefined) docType = SKILL_ALIAS[params.docType];
		else docType = "generic";
		if (docType === undefined || !DOC_TYPES.includes(docType)) {
			logEvent("doc_review_arg_error", { reason: `unknown doc_type/skill: ${params.skill ?? params.docType}` });
			throw new DocReviewArgumentError(
				`未知 doc_type/skill：${params.skill ?? params.docType}（合法值：${DOC_TYPES.join("、")}）`
			);
		}
		const dimensions = params.dimensions ?? {
			fact: true, completeness: true, necessity: true, format: true
		};
		const references = Array.isArray(params.references) ? params.references : [];
		const chain = params.chain ?? {};
		const round = Number.isInteger(chain.round) ? chain.round : 1;
		const chainId = typeof chain.chainId === "string" ? chain.chainId : "";
		const shouldArchive = params.archive !== false;

		const buildInput = () => buildReviewInput({
			targetText: targetContent,
			references,
			docType,
			dimensions,
			prevReport: params.prevReport ?? null
		});

		// exec.agent 缺失：显式降级路径②（组装输入包后交回调用方转同会话自审；零审查 session）。
		const parentAgent = params.parentAgent;
		if (parentAgent === undefined || parentAgent === null) {
			const { inputText, skillMissing } = buildInput();
			logEvent("doc_review_degraded", { reason: "same-session", detail: "parentAgent undefined" });
			return {
				kind: "no-agent",
				docType,
				inputText,
				skillMissing,
				inputChars: inputText.length
			};
		}

		const parentKey = String(parentAgent?.session?.id ?? "");
		if (!parentKey) {
			// 有句柄但拿不到 session.id：无法做 busy 键控，显式报错而非静默放行。
			throw new DocReviewArgumentError("reviewPrompt: parentAgent.session.id 不可用，无法建立 busy 互斥");
		}
		if (inflightByParent.has(parentKey)) {
			logEvent("doc_review_degraded", { reason: "busy", parentKey });
			return { kind: "busy", docType };
		}
		inflightByParent.set(parentKey, Date.now());
		try {
			const { inputText, skillMissing } = buildInput();
			logEvent("doc_review_context_built", {
				docType,
				skillMissing,
				inputChars: inputText.length
			});

			// 派发前钩子（工具层 T10 成本门）：返回非 null 信封则短路，不派子会话。
			if (typeof params.beforeRun === "function") {
				const shortCircuit = await params.beforeRun({ inputText, skillMissing, docType });
				if (shortCircuit !== null && shortCircuit !== undefined) {
					return { kind: "short-circuit", value: shortCircuit };
				}
			}

			const outcome = await runReviewerSession(
				{ gateway: deps.gateway, jobs: deps.jobs, validateJsonSchemaValue },
				{
					parentAgent,
					outerSignal: params.signal,
					inputText,
					targetText: targetContent,
					agentOptions: resolveAgentOptions(params.reviewerModel),
					timeoutMs: params.timeoutMs,
					onRetry: typeof params.onRetry === "function" ? params.onRetry : undefined
				}
			);
			logEvent("doc_review_outcome", { kind: outcome.kind, attempts: outcome.attempts, round, chainId });

			if (outcome.kind !== "report") {
				return {
					kind: outcome.kind,
					docType,
					skillMissing,
					inputChars: inputText.length,
					attempts: outcome.attempts,
					retries: outcome.retries ?? [],
					...(outcome.kind === "freeform" ? { freeformText: outcome.freeformText, inputText } : {}),
					...(outcome.kind === "start-error" ? { error: outcome.error, inputText } : {})
				};
			}

			// 结构化报告：先过调用方钩子（裁决引导/T08 复算/链成本态/deferContext），再归档。
			const prepared = typeof params.prepareResult === "function"
				? await params.prepareResult({ report: outcome.report, skillMissing, inputText })
				: { report: outcome.report };
			const finalReport = {
				...prepared.report,
				round,
				chainId,
				newIssueCount: round === 1
					? (prepared.report.issues?.length ?? 0)
					: prepared.report.newIssueCount
			};
			let archivePath = null;
			if (shouldArchive) {
				const workspaceRoot = params.workspaceRoot ??
					parentAgent?.session?.header?.cwd ??
					process.cwd();
				archivePath = writeRoundArchive({
					workspaceRoot,
					chainId,
					round,
					documentText: params.archiveDocumentText ?? targetContent,
					report: finalReport,
					prevAdjudication: chain.prevAdjudication ?? null
				});
			}
			return {
				kind: "report",
				docType,
				report: finalReport,
				archivePath,
				skillMissing,
				inputChars: inputText.length,
				attempts: outcome.attempts,
				retries: outcome.retries ?? [],
				extras: prepared.extras ?? {}
			};
		} finally {
			inflightByParent.delete(parentKey);
		}
	}

	/** 释放 service（清空 busy 表；ctx.provide 的 fiber 注销由 cordis 自动处理）。 */
	function dispose() {
		inflightByParent.clear();
		logEvent("doc_review_service_disposed", {});
	}

	return { reviewPrompt, dispose, SERVICE_NAME: DOC_REVIEW_SERVICE_NAME };
}
