/**
 * lib/logger.js —— 插件运行日志（JSON Lines，append-only）。
 *
 * 日志文件路径来自环境变量 DSH_DOC_REVIEW_SMOKE_LOG（可选，冒烟/诊断时指向
 * 一个可写日志文件）；未设置时静默不落盘。
 * 关键事件行（A03/A13 机检信号）：
 * - doc_review_start：工具 execute 被调用（A03 要求参数错误时 start 计数可核）
 * - doc_review_arg_error：参数校验失败（结构化错误，零子会话）
 * - doc_review_subagent_created：子会话创建成功（run.id 落盘）
 * - doc_review_structured_report：structured 报告回收
 * - doc_review_archive_written：归档三文件写入
 * 写日志失败绝不影响主流程（try/catch 吞掉）。
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** 环境变量名：冒烟日志文件绝对路径。 */
export const SMOKE_LOG_ENV = "DSH_DOC_REVIEW_SMOKE_LOG";

/**
 * 追加一条事件日志（JSON Lines）。
 * @param {string} event 事件名（见模块头注释清单）。
 * @param {Record<string, unknown>} [fields] 附加字段（禁止放文档内容/凭据）。
 * @returns {void}
 */
export function logEvent(event, fields = {}) {
	const logFile = process.env[SMOKE_LOG_ENV];
	if (!logFile) return;
	const line = JSON.stringify({
		time: new Date().toISOString(),
		pid: process.pid,
		event,
		...fields
	});
	try {
		mkdirSync(dirname(logFile), { recursive: true });
		appendFileSync(logFile, line + "\n", "utf8");
	} catch {
		/* 日志失败不影响主流程 */
	}
}

/**
 * 读取当前日志文件路径（未配置返回 null）。
 * @returns {string | null} 日志文件绝对路径。
 */
export function currentLogFile() {
	return process.env[SMOKE_LOG_ENV] ?? null;
}
