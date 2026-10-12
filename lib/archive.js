/**
 * lib/archive.js —— T09 归档。
 *
 * 目录契约：工作区 `.doc-review/<chain_id>/round-<n>/`（n=prev_round+1），三文件：
 * - document.md        本轮目标文档全文
 * - review-report.json 本轮审查报告（JSON，可解析）
 * - change-log.md      本轮裁决表（来源=prev_adjudication 参数；无则如实标注，不得编造）
 *
 * 敏感边界（T09）：只写目标文档、审查报告、裁决表；不写入除目标文档外的任何
 * 主会话消息、不写入子会话原始日志。
 * 读回契约（T08/T09 A09）：readArchivedDocument(workspaceRoot, chainId, round)
 * 供下一轮读回 round-<n>/document.md；读回失败由调用方降级 prev_document 参数。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logEvent } from "./logger.js";

/** 归档根目录名（工作区下固定）。 */
export const ARCHIVE_ROOT_DIRNAME = ".doc-review";

/** 三文件名常量。 */
export const ARCHIVE_FILE_NAMES = Object.freeze({
	document: "document.md",
	report: "review-report.json",
	changeLog: "change-log.md"
});

/** 链级成本确认状态文件名（T10；位于 .doc-review/<chain_id>/ 根，跨轮持久化）。 */
export const CHAIN_COST_FILE_NAME = "chain-cost.json";

/** 无裁决表时 change-log 的固定标注（T09 备注，不得编造）。 */
export const CHANGE_LOG_MISSING_NOTE = "主 Agent 未回传裁决表";

/**
 * 计算某一轮的归档目录绝对路径。
 * @param {string} workspaceRoot 工作区根（exec.agent.session.header.cwd）。
 * @param {string} chainId 审查链 ID。
 * @param {number} round 轮次（prev_round+1）。
 * @returns {string} 归档目录绝对路径。
 */
export function roundDirectory(workspaceRoot, chainId, round) {
	return join(workspaceRoot, ARCHIVE_ROOT_DIRNAME, chainId, `round-${round}`);
}

/**
 * 渲染 change-log.md 内容（有裁决表则格式化，无则固定标注）。
 * @param {unknown} prevAdjudication 上一轮裁决表（调用方透传，形态不做强校验）。
 * @param {number} round 当前轮次。
 * @returns {string} change-log.md 全文。
 */
function renderChangeLog(prevAdjudication, round) {
	const header = `# change-log（round-${round} 收到的上一轮裁决表）\n\n`;
	if (prevAdjudication === undefined || prevAdjudication === null || prevAdjudication === "") {
		return `${header}${CHANGE_LOG_MISSING_NOTE}\n`;
	}
	const body =
		typeof prevAdjudication === "string"
			? prevAdjudication
			: "```json\n" + JSON.stringify(prevAdjudication, null, 2) + "\n```";
	return `${header}${body}\n`;
}

/**
 * 写入本轮归档三文件（T09 主入口；工具返回前调用）。
 * @param {object} params 归档参数。
 * @param {string} params.workspaceRoot 工作区根绝对路径。
 * @param {string} params.chainId 审查链 ID。
 * @param {number} params.round 当前轮次（prev_round+1）。
 * @param {string} params.documentText 本轮目标文档全文。
 * @param {object} params.report 本轮审查报告（含插件复算/覆盖后的字段）。
 * @param {unknown} [params.prevAdjudication] 上一轮裁决表（可选）。
 * @returns {string} 归档目录绝对路径（写入成功后）。
 */
export function writeRoundArchive({ workspaceRoot, chainId, round, documentText, report, prevAdjudication }) {
	const directory = roundDirectory(workspaceRoot, chainId, round);
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, ARCHIVE_FILE_NAMES.document), documentText, "utf8");
	writeFileSync(join(directory, ARCHIVE_FILE_NAMES.report), JSON.stringify(report, null, 2), "utf8");
	writeFileSync(join(directory, ARCHIVE_FILE_NAMES.changeLog), renderChangeLog(prevAdjudication, round), "utf8");
	logEvent("doc_review_archive_written", { directory, round, chainId });
	return directory;
}

/**
 * 读回某轮归档的 document.md（T08 读回契约；A09 读回单测入口）。
 * @param {string} workspaceRoot 工作区根绝对路径。
 * @param {string} chainId 审查链 ID。
 * @param {number} round 目标轮次。
 * @returns {string | null} 文档全文；文件不存在或读取失败返回 null（调用方降级 prev_document）。
 */
export function readArchivedDocument(workspaceRoot, chainId, round) {
	const filePath = join(roundDirectory(workspaceRoot, chainId, round), ARCHIVE_FILE_NAMES.document);
	try {
		return readFileSync(filePath, "utf8");
	} catch {
		return null;
	}
}

/**
 * 读回某轮归档的 review-report.json（T08 多轮 issue 对齐数据源）。
 * @param {string} workspaceRoot 工作区根绝对路径。
 * @param {string} chainId 审查链 ID。
 * @param {number} round 目标轮次。
 * @returns {object | null} 已解析的报告对象；文件不存在/读取/JSON 解析失败均返回 null
 *   （调用方降级 prev_report 参数）。
 */
export function readArchivedReport(workspaceRoot, chainId, round) {
	const filePath = join(roundDirectory(workspaceRoot, chainId, round), ARCHIVE_FILE_NAMES.report);
	try {
		return JSON.parse(readFileSync(filePath, "utf8"));
	} catch {
		return null;
	}
}

/**
 * 计算链根目录绝对路径（.doc-review/<chain_id>/）。
 * @param {string} workspaceRoot 工作区根绝对路径。
 * @param {string} chainId 审查链 ID。
 * @returns {string} 链根目录绝对路径。
 */
export function chainDirectory(workspaceRoot, chainId) {
	return join(workspaceRoot, ARCHIVE_ROOT_DIRNAME, chainId);
}

/** 链级成本态缺省值（首次审查/状态文件缺失时）。 */
export function emptyChainCostState() {
	return { confirmed: false, cumulativeWorstCaseTokens: 0, rounds: [], pendingCumulativeAck: null };
}

/**
 * 读回链级成本确认状态（T10）。文件缺失或损坏一律回退缺省态（fail-open 不阻断审查）。
 * @param {string} workspaceRoot 工作区根绝对路径。
 * @param {string} chainId 审查链 ID。
 * @returns {{confirmed: boolean, cumulativeWorstCaseTokens: number, rounds: Array<object>,
 *   pendingCumulativeAck: number|null}}
 *   pendingCumulativeAck：chain-cumulative-over-budget 拦截时登记的待确认投影 token；
 *   下一次带 confirm_token_budget=true 且投影一致即视为「再次确认」放行。
 */
export function readChainCostState(workspaceRoot, chainId) {
	const filePath = join(chainDirectory(workspaceRoot, chainId), CHAIN_COST_FILE_NAME);
	try {
		const parsed = JSON.parse(readFileSync(filePath, "utf8"));
		// 显式 null 表示无待确认投影；注意 Number(null)===0，必须先判 null 再做数值化，
		// 否则成功轮落盘的 pendingCumulativeAck:null 会被误读成 0。
		const rawPending = parsed?.pendingCumulativeAck;
		const pendingNumber = Number(rawPending);
		const pendingCumulativeAck =
			rawPending === null || rawPending === undefined || !Number.isFinite(pendingNumber)
				? null
				: pendingNumber;
		return {
			confirmed: parsed?.confirmed === true,
			cumulativeWorstCaseTokens:
				Number.isFinite(Number(parsed?.cumulativeWorstCaseTokens))
					? Number(parsed.cumulativeWorstCaseTokens)
					: 0,
			rounds: Array.isArray(parsed?.rounds) ? parsed.rounds : [],
			pendingCumulativeAck
		};
	} catch {
		return emptyChainCostState();
	}
}

/**
 * 持久化链级成本确认状态（T10；每轮成功归档后，或链累计预算拦截登记待确认时调用）。
 * @param {string} workspaceRoot 工作区根绝对路径。
 * @param {string} chainId 审查链 ID。
 * @param {{confirmed: boolean, cumulativeWorstCaseTokens: number, rounds: Array<object>,
 *   pendingCumulativeAck?: number|null}} state 链成本态。
 * @returns {string} chain-cost.json 绝对路径。
 */
export function writeChainCostState(workspaceRoot, chainId, state) {
	const directory = chainDirectory(workspaceRoot, chainId);
	mkdirSync(directory, { recursive: true });
	const filePath = join(directory, CHAIN_COST_FILE_NAME);
	writeFileSync(filePath, JSON.stringify(state, null, 2), "utf8");
	return filePath;
}
