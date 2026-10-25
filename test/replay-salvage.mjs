/**
 * 真实语料回放：把取证阶段 dump 出的「白失败」子会话正文灌进 parseFreeformReport，
 * 验证改造后能否当场救回（不再重开子会话）。
 *
 * 语料不入库：把子会话 dump 放在任意本地目录，用环境变量指向它后运行：
 *   DOC_REVIEW_REPLAY_DIR=<dump目录> node test/replay-salvage.mjs
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import { parseFreeformReport } from "../lib/reviewer.js";

const session_ids = [
	"86fe594b-b455-4252-acdf-29571c22bce9",
	"ffac8df3-06f7-46e8-9ba0-0f092288a6a8",
	"a37944b2-b90a-4eb3-9054-c309f88d8f56",
	"50258ceb-4932-42e9-8609-f67c445adcdf"
];

// 语料缺失（未提供 dump 目录）时整体跳过：本脚本是取证回放工具，不是回归用例，
// 语料不入库（见头注），node --test 全量跑不应因缺文件而红。
const corpus_dir = process.env.DOC_REVIEW_REPLAY_DIR ?? ".";
const missing_ids = session_ids.filter((id) => !existsSync(join(corpus_dir, `${id}.jsonl`)));
if (missing_ids.length > 0) {
	console.log(
		`replay-salvage: SKIP（语料缺失 ${missing_ids.length}/${session_ids.length}；` +
			"设 DOC_REVIEW_REPLAY_DIR 指向 dump 目录后运行）"
	);
	process.exit(0);
}

/** 读取子会话 dump 的全部事件（已解码）。 */
function readEvents(id) {
	return readFileSync(join(corpus_dir, `${id}.jsonl`), "utf8")
		.split(/\r?\n/)
		.filter((l) => l.trim())
		.map((l) => {
			try {
				return JSON.parse(l);
			} catch {
				return null;
			}
		})
		.filter((e) => e !== null);
}

/** 从子会话 dump 里取最后一个 assistant text 块。 */
function lastAssistantText(id) {
	const texts = [];
	for (const event of readEvents(id)) {
		if (event.type === "assistant/message") {
			for (const block of event.data?.message?.content ?? []) {
				if (block?.type === "text" && (block.text ?? "").trim()) texts.push(block.text);
			}
		}
	}
	return texts.at(-1) ?? "";
}

/**
 * location 校验语料：子会话收到的用户文本（含【目标文档】全文，已解码）。
 * 回放必须与生产一致——生产传的是目标文档纯文本，不是 dump 的 JSON 原文。
 */
function targetCorpus(id) {
	const parts = [];
	for (const event of readEvents(id)) {
		if (event.type !== "user/message") continue;
		for (const block of event.data?.content ?? []) {
			if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
		}
	}
	return parts.join("\n");
}

let saved = 0;
for (const id of session_ids) {
	const text = lastAssistantText(id);
	// location 校验语料必须与生产一致：目标文档纯文本（子会话收到的用户文本）
	const salvaged = parseFreeformReport(text, {
		deps: { validateJsonSchemaValue },
		params: { targetText: targetCorpus(id) }
	});
	const short = id.slice(0, 8);
	if (salvaged === null) {
		console.log(`${short}  未救回（正文 ${text.length} 字符，无合规 JSON）`);
		continue;
	}
	saved += 1;
	console.log(`${short}  救回成功：issues=${salvaged.report.issues.length}  摘要=${salvaged.report.summary.slice(0, 30)}…`);
}
console.log(`\n合计救回 ${saved}/${session_ids.length} 个原本被判失败并重开子会话的产出`);
