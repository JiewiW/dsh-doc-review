# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 约定，版本号遵循语义化版本。

## [0.2.1] - 2026-10-14

### 新增

- **任务执行 prompt 审查（DR1–DR3，本地版，未公开发布）**：新增闭合枚举值
  `doc_type: "task-prompt"`，经独立子会话对任务卡/派活指令做结构化审查。
  - DR1：`DOC_TYPES` 单一来源迁至 `lib/schema.js` 并新增 `"task-prompt"`；
    `lib/context-builder.js` 的 `SKILL_DIR_BY_DOC_TYPE` 增加
    `"task-prompt" -> "doc-review-task-prompt"` 映射。未知 `doc_type`/`skill`
    值在 service 层结构化报错（`DocReviewArgumentError`，
    `code=DOC_REVIEW_INVALID_ARGUMENT`），不派发任何子会话。
  - DR2：新增 `skills/doc-review-task-prompt/SKILL.md`，含 context-builder
    机械提取的锚点标题「## 领域背景」「## 审查规则」；规则 D1–D11 每条按
    「做法 + 触发条件 + 后果」编写并标注 severity（high/medium/low），
    附与 TB-C5 十一项逐项对照的自查清单（锚点 C5-1～C5-11）。
    dimension 维持四枚举（fact/completeness/necessity/format）不破坏，
    D1–D11 规则编号写入 issue 的 `claim`/`location`。
  - DR3：新增 `lib/service.js`，把「组装输入包 → spawn 审查 → 重试/降级 →
    结构化报告」主干抽为 ctx service：
    `docReview.reviewPrompt({targetContent, skill, docType, dimensions, references,
    prevReport, reviewerModel, toolFilter, signal, parentAgent, workspaceRoot,
    archiveDocumentText, chain, archive, timeoutMs, beforeRun, prepareResult})`，
    保留归档、按父会话 id 的 busy 互斥、stopReason 五态、重试 ≤2、降级标记与
    `dispose()`。插件 apply 时经 `ctx.reflect.provide("docReview", service)`
    暴露给融合插件（分叉版 cordis 无上游 `ctx.service()`）；`/doc-review`
    工具改为调用同一 service 单例，保留成本门、confirm、T08 复算、裁决与
    渲染等工具层行为；`exec.agent` 缺失时返回 `no-agent` 信封，由工具层
    转同会话自审。
  - `reviewerModel` 支持透传 `reasoningEffort`。

### 测试

- 新增 `test/service.test.mjs`（SVC-1～SVC-12b，共 13 个用例）：构造校验、
  参数错误零子会话、DOC_TYPES 冻结枚举与 task-prompt 组装、no-agent/busy/
  short-circuit/prepareResult/archive 开关/dispose、工具与 service 共享
  busy 域、reasoningEffort 透传正/反例。
- `test/smoke-apply.mjs` 增加 service 注册断言（`docReview` 服务恰注册一次，
  含 `reviewPrompt`/`dispose`）。
- 全量 `node --test`：**128 通过 / 0 失败**（基线 115，新增 13）。

### 兼容性

- 0.2.0 的 `/doc-review` 行为全部保留：未激活零暴露、agent-scoped 注册、
  WeakSet 幂等、followup 唤醒、成本门与多轮收敛。
- `peerDependencies` 维持 `@deepseek-ai/dsh >=0.2.0-rc.1 <0.3.0-0`。
- `legal`/`medical` 仍为预留枚举，不随本次开放。

## [0.2.0] - 2026-10-12

- 改造为 `/doc-review` 斜杠指令手动激活：未激活时不注册任何工具（零暴露），
  激活后按 agent 注册 `doc_review` 工具并 followup 唤醒当前会话。
- 多维度（fact/completeness/necessity/format）、多轮（≤3）结构化审查、
  成本预估与确认门、抽样/仅事实模式、链归档与收敛裁决。
