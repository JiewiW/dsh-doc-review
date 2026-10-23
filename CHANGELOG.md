# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 约定，版本号遵循语义化版本。

## [0.2.4] - 2026-10-23

### 变更

- **弱模型子会话的 JSON 输出容错（修复「必炸 + 重灌」循环失败）**：生产取证显示，
  7 次 doc-reviewer 子会话中仅 3 次真正调用 `structured_output` 工具，其余 4 次把
  完整合规的 JSON 直接输出在正文里；插件原先只在 `structured !== undefined` 时判
  成功，导致这 4 次一律被判失败并重开子会话，而重开时 `buildAttemptPrompt` 又把
  目标文档全文重新灌一遍——模型注意力被长文档拉回「重新审查」，连续多轮仍产不出
  合规 JSON。0.2.4 起三处改造：
  - **输出指令消歧**：原指令字面写作「只输出一个符合 outputSchema 的 JSON 对象」，
    与内核「必须调用 `structured_output` 工具」的要求相互矛盾，等于主动诱导模型吐
    纯文本。改为明确要求调用工具，声明正文里的 JSON 不会被采纳，并显式列出两条实测
    易错点（`evidence`/`suggestion` 属 `issues` 元素内部字段，不得写到顶层；五个顶层
    字段缺一不可且不得多出）。
  - **正文 JSON 兜底**：新增 `extractJsonObject`（围栏优先 + 括号深度与转义状态机
    切割，超长文本截断到 200000 字符）与 `parseFreeformReport`（JSON.parse 后依次经
    schema 校验与业务规则校验）。结构化结果缺失但正文可解析且校验全通过时，直接采纳
    为报告并打 `source: "freeform-salvage"` 日志，不再重开子会话。真实语料回放
    4 个「白失败」子会话救回 3 个（第四个本身零正文，无内容可救）。
  - **重试不再重灌全文**：`buildAttemptPrompt` 拆为两路。默认走精简路，只发「本次任务：
    只修格式，不重新审查」＋上一版输出＋校验违规原因，不含目标文档；仅当违规涉及
    `location` 引句（必须对照原文修正）或上次非正常结束（`stopReason` 非 completed /
    max-tokens）时，才由 `needsFullInputOnRetry` 回退到重灌全文。

### 测试

- 新增 `test/reviewer.test.mjs`（12 条）：覆盖 `extractJsonObject` 的裸 JSON / 围栏 /
  无 JSON / 括号不闭合四种输入；`parseFreeformReport` 的合规回收、缺顶层字段不回收、
  `location` 未命中不回收、数组与 null 不回收；输出指令含 `structured_output` 与
  「工具调用」字样；`buildAttemptPrompt` 首次含全文、普通违规重试不含全文且含「只修
  格式」与「上一版输出」、`location` 违规与 `stopReason=error` 回退重灌；
  `runReviewerSession` 在正文合规 JSON 时一次成功（`attempts=1`、`retries=0`、
  `start()` 仅调用 1 次）；第二次 prompt 不含输入包标记。
- 全量回归 144/144 pass。

### 兼容性

- 输出协议与报告 schema 不变；兜底只在原先判失败的分支上新增一条成功通路，不影响
  正常调用 `structured_output` 的路径（该路径日志补 `source: "structured_output"`）。
- 依赖内核注入的 `structured_output` 工具与指令，未修改内核，亦未新增依赖。

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
