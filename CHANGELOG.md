# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 约定，版本号遵循语义化版本。

## [0.2.3] - 2026-10-16

### 变更

- **带参转发改用显式审阅请求框架（修复 0.2.2 生产实测缺陷）**：2026-10-16
  生产实测发现，`/doc-review <文档路径>` 提交后模型未调用 `doc_review` 工具——
  0.2.2 的带参 followup 仍前置含“不要在没有用户审阅请求的情况下自行发起审查”
  禁令句的工具说明，用户只粘贴纯文件路径时，模型判读为“无明确审阅请求”而
  拒绝发起审查。0.2.3 起：
  - 带参命令的 followup 不再发送含禁令句的 FOLLOWUP_TEXT，改为：工具简述
    （仅首次激活时附带，不含禁令）＋显式请求框架（声明“用户已通过 /doc-review
    命令提交审阅请求，请本轮立即调用 doc_review 工具执行审查；请求原文只有
    文件路径时默认对该文档执行完整审阅；绝对路径先换算为工作区相对路径”）＋
    用户请求原文独立文本块；
  - 裸命令（无参数）行为不变：首次激活仍发送原 FOLLOWUP_TEXT（含禁令，约束
    后续自由对话中的自行审查行为）；重复激活不发 followup。

### 测试

- `test/command.test.mjs` 更新 3 处断言：
  - “首次激活带审阅请求”与“已激活带审阅请求”用例：断言转发文本含
    “立即调用 doc_review”请求框架、不含“不要在没有用户”禁令句；
  - “rawInput 仅空白等同裸命令”用例：断言裸命令激活的 followup 仍保留禁令句。

### 兼容性

- 裸 `/doc-review` 行为与 0.2.2 完全一致；带参命令的注册、幂等、
  WeakSet 会话隔离逻辑不变，仅 followup 内容构造调整。

## [0.2.2] - 2026-10-15

### 变更

- **`/doc-review` 斜杠菜单回车改为填入输入框占位（leadingInput，对齐 `/goal`）**：
  指令定义新增 `input: { hint: "[<文档路径或审阅需求>]" }`。支持 leadingInput 的
  客户端（Web GUI）在斜杠下拉菜单中选中 `/doc-review` 回车时，不再立即把命令
  当已发送消息执行，而是把 `/doc-review ` 占位填入输入框，用户可继续输入文档
  路径与审阅需求，再次回车才整行提交。
- **命令后随附审阅请求时当轮转发**：handler 读取 `invocation.rawInput`（命令名
  之后原文，去首尾空白）。
  - 裸命令（无参数）：行为与 0.2.0/0.2.1 完全一致——仅激活并 followup 工具
    使用说明，返回文本提示用户随后发送审阅请求；
  - 带参命令：激活（或命中已激活幂等）后把用户请求原文经同一条 followup
    用户消息追加转发，模型本轮即可看到 `doc_review` 工具并直接发起审查，无需
    用户再发第二条消息；已激活会话带参不重复注册、不重复发送工具说明。
  - `rawInput` 仅含分隔空白时等同裸命令，不转发空请求。
- 菜单 description 去掉“无参数”措辞，改为说明可在命令后直接附文档路径或需求。

### 测试

- `test/command.test.mjs` 新增/更新 4 处断言：
  - 定义形态断言 `input.hint` 为非空字符串且等于导出常量 `COMMAND_INPUT_HINT`；
  - 新增“首次激活带审阅请求”用例：注册一次、followup 同时含工具说明与用户
    请求原文（请求原文为最后一个文本块）、返回“审阅请求已随命令提交”；
  - 新增“已激活带审阅请求”用例：不重复注册、followup 仅转发请求且不含工具
    说明、返回 success；
  - 新增“rawInput 仅空白等同裸命令”用例；
  - `invocationOf` 支持第二参数 `rawInput`。

### 兼容性

- 裸 `/doc-review` 的 0.2.0/0.2.1 行为（未激活零暴露、agent-scoped 注册、
  WeakSet 幂等、followup 唤醒、成本门与多轮收敛）全部保留。
- 不声明 `input.attachments`：`doc_review` 不随命令接收附件。
- `peerDependencies` 维持 `@deepseek-ai/dsh >=0.2.0-rc.1 <0.3.0-0`。
- host 侧改动需重启 DSH 实例后生效。

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
