# dsh-doc-review

> **⚠️ v0.2.0 破坏性变更（从 0.1.x 升级必读）**
>
> `doc_review` **不再全局常驻**。0.1.x 安装后工具即对所有会话可见、模型可自动调用；自 **v0.2.0 起，必须先在会话中手动执行斜杠指令 `/doc-review`**，工具才会在**当前这一个会话**内注册并对模型可见，未激活的会话零暴露（工具 schema 不下发、斜杠菜单之外不可见）。会话关闭后激活失效，新会话需重新执行。详见下文[激活方式](#激活方式doc-review)。

[DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek)（DSH）的**文档审查插件**。插件挂载后注册一个 `/doc-review` 斜杠指令：用户在会话中手动执行该指令后，插件向**当前会话**注册 `doc_review` 工具；当主 Agent 需要审查一篇文档时，插件会**派生一个隔离的子 Agent 会话**，让它按固定判据对文档做结构化审查，返回机器可校验的问题清单（issues）、裁决表模板与下一步指引，并把每一轮的文档与报告落盘归档。

审查在独立子会话中进行，不污染主会话上下文；主 Agent 只消费结构化结论，可据此逐轮修订文档，形成「审查 → 修订 → 复审」的多轮收敛链。

- **运行时**：Node.js ≥ 20，DSH `@deepseek-ai/dsh` `>=0.2.0-rc.1 <0.3.0`
- **依赖宿主服务**：`commands` / `tools` / `subagents` / `sessions` / `skills`（需要可用的 spawn 子会话 provider）
- **许可证**：MIT

---

## 目录

- [特性](#特性)
- [工作机制](#工作机制)
- [安装与挂载](#安装与挂载)
- [激活方式（/doc-review）](#激活方式doc-review)
- [`doc_review` 工具](#doc_review-工具)
- [多轮收敛与成本闸门](#多轮收敛与成本闸门)
- [归档结构](#归档结构)
- [审查判据（SKILL）](#审查判据skill)
- [运行测试](#运行测试)
- [仓库结构](#仓库结构)
- [已知边界](#已知边界)

---

## 特性

- **隔离审查**：每次审查 spawn 独立子会话，输出经 JSON Schema 强校验；无法解析的自由文本走降级路径，不把脏数据抛给主 Agent。
- **四个审查维度**：`fact`（事实）、`completeness`（完整性）、`necessity`（必要性）、`format`（格式），可逐维开关。
- **三种文档输入**：`target_content`（内联全文）、`target_message_id`（指向主会话某条消息）、`target_file`（工作区相对路径，**审查大文件时推荐**，无需把全文塞进工具参数）。
- **多轮收敛链**：以 `chain_id` 串联，自动读回上一轮归档文档做变更比对（行级 + 字符级 LCS）、跨轮对齐 issue、复算新增/解决数并判定是否收敛。
- **token 成本闸门**：派子会话前先做保守 token 预估，超阈值返回 `confirmationRequired` 并结束本回合（**不派子会话**），由主 Agent 显式确认后才放行；确认按链生效。
- **分级审查模式**：`full`（四维全文）/ `sample`（等距抽样约 30% 段落，仅 fact+format）/ `fact-only`（仅事实维），用于低成本粗筛。
- **全程归档**：每轮落盘 `document.md` / `review-report.json` / `change-log.md`，链根维护 `chain-cost.json`。

## 工作机制

```
用户在会话中执行 /doc-review（每会话一次，幂等）
  ▼
dsh-doc-review（指令层）在当前 agent 作用域注册 doc_review 工具
  │
主 Agent（收到用户的审阅请求后）
  │  调用 doc_review(target_file / target_content / target_message_id, …)
  ▼
dsh-doc-review（工具层）
  │  1. 参数与多轮链校验（round / chain_id / max_rounds）
  │  2. 多轮时读回上一轮归档文档（失败回退 prev_document，皆无 → 结构化错误，不派子会话）
  │  3. 组装审查输入包（目标文档 + 参考资料 + 审查规则 + 维度清单 + 可选上轮报告）
  │  4. token 成本预估 → 超阈值则返回 confirmationRequired 并 concludeTurn()
  │  5. spawn 独立审查子会话（默认零外部工具，输出受 JSON Schema 约束）
  │  6. 回收结构化报告；多轮时复算变更率 / 对齐 issue / 判定收敛
  │  7. 写归档，返回 report + adjudication_template + next_action
  ▼
主 Agent 按裁决表修订文档 → 带 chain_id / prev_round 发起下一轮
```

审查子会话默认**不授予外部工具**（`web_fact_check: true` 才开放 `web_search` / `web_fetch`），以保证结论只来自文档本身与给定参考资料。

## 安装与挂载

本插件是一个 **bundle patch 插件**：`package.json` 的 `dsh.bundle.patch` 指向 [`cordis.patch.yml`](./cordis.patch.yml)，后者声明向宿主插入一条插件行（`id=dsh-external/dsh-doc-review`，`main=./lib/index.js`）。

### 方式 A：overlay 挂载（推荐，免安装、可随时移除）

克隆仓库后，用 `--patch` 在一个独立端口的 DSH Web 实例上叠加加载，不写入任何 profile：

```bash
git clone https://github.com/JiewiW/dsh-doc-review.git
dsh web --port <自定义端口> --patch "$PWD/dsh-doc-review/cordis.patch.yml"
```

Windows PowerShell：

```powershell
dsh web --port <自定义端口> --patch (Resolve-Path <插件目录>\cordis.patch.yml).Path
```

加载成功时，宿主日志会出现 `doc_review_plugin_applied` 与 `doc_review_command_registered`；此时斜杠指令 `/doc-review` 已可用，但 **`doc_review` 工具尚未注册**——需按[下一节](#激活方式doc-review)在会话中手动激活。

> spawn provider 缺失时插件仍会注册，但运行期会降级为 same-session（日志有 warn）。要获得真正的隔离审查，请确认宿主的 subagents spawn 服务可用。

### 方式 B：作为插件长期安装

若你的 DSH 版本支持从 git 安装第三方插件，可直接：

```bash
dsh plugin add https://github.com/JiewiW/dsh-doc-review.git
```

不同 0.2.0 预览版的插件安装命令可能有差异，以当前 DSH 版本的 `dsh --help` / 插件文档为准；方式 A 的 `--patch` overlay 是与具体版本耦合最小、最稳妥的挂载方式。

## 激活方式（/doc-review）

自 v0.2.0 起，`doc_review` 工具采用**会话级手动激活**：

1. 在任意会话的输入框输入 `/` 打开斜杠菜单，选择 **doc-review**（或直接输入完整 `/doc-review`）并发送；
2. 插件在**当前会话（当前 agent 作用域）**注册 `doc_review` 工具，随后向模型投递一条仅本会话可见的说明（工具名、`target_file` 工作区相对路径用法），模型随即可以应你的审阅请求调用工具；
3. 激活成功的指令回执为：`doc-review 已激活（仅本会话）……`。

激活语义要点：

- **未激活零暴露**：没有执行过 `/doc-review` 的会话，模型的工具列表中不存在 `doc_review`，也不会收到任何相关 schema 或提示；
- **仅当前会话可见**：注册挂在当前 agent 的作用域上，不影响其他会话；不同会话之间激活状态互不共享；
- **幂等**：同一会话重复执行 `/doc-review` 不会重复注册，回执为 `doc-review 在本会话已处于激活状态（无需重复执行）。`；
- **随会话失效**：会话关闭（agent 作用域销毁）后注册自动撤销，新会话需重新执行 `/doc-review`；
- **失败显式可见**：若当前 agent 作用域不具备 scoped 工具注册能力，指令返回 `doc_review_activate_failed` 错误回执（而非静默成功）。

## `doc_review` 工具

> 前置条件：当前会话已执行 `/doc-review` 激活。未激活时模型无法看到本工具。

### 入参

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `target_content` | string | 目标文档全文。与 `target_message_id` / `target_file` **三选一**。 |
| `target_message_id` | string | 主会话内某条消息的 ID，取其内容作为目标文档；消息不存在或不属本会话 → 结构化错误。 |
| `target_file` | string | 目标文档的**工作区相对路径**。绝对路径、盘符、`..` 穿越一律拒绝。**审查工作区文件时优先使用。** |
| `references` | string[] | 参考资料：内联文本或工作区相对路径；绝对路径 / `..` 拒绝，**URL 不抓取**。 |
| `doc_type` | string | 闭合枚举 `generic` / `tech-spec` / `product-doc`，默认 `generic`。决定 issue ID 前缀与部分规则。 |
| `dimensions` | object | `{fact, completeness, necessity, format}` 布尔开关，缺省四维全开；创意类文档可关 `necessity`。 |
| `mode` | string | `full`（默认）/ `sample` / `fact-only`。 |
| `max_rounds` | integer | 多轮上限，默认 1，硬上限 3。 |
| `reviewer_model` | object | `{provider, model}` 覆盖审查员模型；缺省继承主 Agent。 |
| `web_fact_check` | boolean | `true` 时给审查员开放联网检索，默认 `false`。 |
| `chain_id` | string | 审查链 ID：首轮由插件生成并返回，后续轮必须原样回传。 |
| `prev_round` | integer | 上一轮轮次，首轮留默认 0。 |
| `prev_report` | json | 上一轮报告（兜底；正常情况下插件优先读归档）。 |
| `prev_adjudication` | json | 上一轮裁决表（可选；归档 change-log 来源）。 |
| `prev_document` | string | 上一轮文档兜底（归档读回失败时使用）。 |
| `confirm_token_budget` | boolean | token 预算确认放行标记，链级有效。 |

### 返回（成功）

- `report`：结构化审查报告（符合 T02a JSON Schema），含 `summary`、`issues[]`、`newIssueCount`、`round`、`chainId`。
- `adjudication_template`：裁决表模板，供主 Agent 对每条 issue 标注 accept/reject。
- `next_action`：下一步指引（继续下一轮 / 已达末轮 / 审查链已收敛）。
- `round` / `chainId`：轮次与链 ID。
- 多轮时另含 `changeRatio`、`converged`、`convergenceReason`、`resolvedIssueCount`。
- `costEstimate`：本轮成本预估明细。
- `archivePath`：本轮归档目录。

### 返回（需确认）

当成本预估超阈值时，**不派子会话**，直接返回：

- `confirmationRequired: true`
- `costEstimate`：`singleRoundTokens` / `worstCaseTokens` / `chainCumulativeTokens` / `thresholdTokens` / `chainBudgetTokens` / `reason` 等
- `next_action`：提示带 `confirm_token_budget: true`（多轮时连同 `chain_id`）重新调用。

每条 issue 含 7 个字段：`id`、`dimension`、`severity`（high/medium/low）、`location`（必须是文档中 ≥8 个连续字符的原文引句或 Markdown 标题行）、`claim`、`evidence`、`suggestion`。

## 多轮收敛与成本闸门

**变更率（changeRatio）**：对上一轮文档与本轮文档做行级 LCS，再对变动块配对做字符级 LCS。

- 分子 = 新增/删除的**非空白码点**数（标点计入，纯空白/换行不计）；
- 分母 = 上一轮非空白码点数；
- 行切分先剥 `\r` 再按 `\n`，按 Unicode 码点计数（`Array.from`，正确处理代理对），结果四舍五入到 0.1%。

**issue 跨轮对齐**：先按稳定 `id` 精确匹配，再按 `dimension + 归一化 location`（去首尾空白、连续空白折单、英文小写、截前 80 码点）一对一匹配。未匹配的旧 issue 记为 resolved（裁决 reject 且未再现另记 disputed），未匹配的新 issue 记为新增；`newIssueCount` 以插件复算为准，不采信审查员自报。

**收敛条件**（满足任一即终止，按序取首个）：

1. `changeRatio < 3.0%`；
2. 本轮无 `high` 且复算新增 issue 数为 0；
3. 上一轮轮次已达 `max_rounds`（硬上限 3）。

**成本闸门（保守口径）**：

- 单轮 token ≈ 输入包字符数 / 1.2 + 1600（预期输出）；最坏口径 = 单轮 × (1 + 2 次重试)。
- 最坏口径 > 20000 token 且本链未确认 → 拦截并要求确认；
- 链累计投影 > 20000 × `max_rounds` → 再次拦截（链级确认不豁免累计预算）；
- 一次确认在同一 `chain_id` 内持续有效；拦截时登记待确认投影，下一轮带确认标记且投影一致即放行，避免同轮重复确认。

## 归档结构

写入工作区下的 `.doc-review/`：

```
.doc-review/
└── <chain_id>/
    ├── chain-cost.json              # 链级成本/确认状态
    ├── round-1/
    │   ├── document.md              # 本轮目标文档
    │   ├── review-report.json       # 结构化报告
    │   └── change-log.md            # 裁决记录（无裁决表时标注主 Agent 未回传）
    └── round-2/ …
```

## 审查判据（SKILL）

审查子会话的判据来自 [`skills/doc-review-generic/SKILL.md`](./skills/doc-review-generic/SKILL.md)，覆盖通用纪律与四个维度共 19 条判据，附「症状反查表」与输出前自查清单。该文件缺失时插件用内置默认文本降级（返回中带 `skillMissing: true`）。

## 运行测试

测试使用 Node 内置测试运行器，**零 LLM 调用、零网络**：

```bash
# 在仓库根目录（自动发现 test/ 下用例）
node --test
```

> Windows 下请用自动发现形式（`node --test`），不要把目录路径作为位置参数传入。

测试覆盖：Schema 合法性、上下文组装、成本判定、收敛/对齐算法、工具层端到端（subagents 全 stub，含成本闸门、多轮归档读回、链断裂、`target_file` 路径防护、sample 抽样）以及 host 入口装配冒烟。

## 仓库结构

```
dsh-doc-review/
├── cordis.patch.yml          # bundle patch：向宿主插入插件行
├── package.json
├── skills/
│   └── doc-review-generic/
│       └── SKILL.md          # 审查判据
├── lib/
│   ├── index.js              # host 入口 {name, inject, apply}：注册 /doc-review 指令
│   ├── command.js            # /doc-review 斜杠指令：会话级 scoped 工具注册 + 幂等
│   ├── tool.js               # doc_review 工具定义与主流程
│   ├── reviewer.js           # 子会话审查与回收/降级
│   ├── context-builder.js    # 审查输入包组装
│   ├── schema.js             # 报告/输出 JSON Schema
│   ├── convergence.js        # 变更率 + issue 对齐 + 收敛判定（纯函数）
│   ├── cost.js               # token 预估 + 确认判定 + 抽样计划（纯函数）
│   ├── archive.js            # 轮次归档与链成本状态读写
│   ├── adjudicate.js         # 裁决表模板与下一步指引
│   ├── defaults.js           # SKILL 缺失降级文本
│   └── logger.js             # 可选 JSONL 诊断日志
└── test/                     # node:test 用例 + fixtures
```

## 已知边界

- **激活是会话级的**：`/doc-review` 只在执行它的那一个会话内生效；新开会话或会话关闭后必须重新激活，这是 v0.2.0 的预期行为而非缺陷。
- 依赖宿主提供 subagents **spawn provider**；缺失时降级为 same-session，审查不再与会话隔离。
- `references` 不抓取 URL，只接受内联文本与工作区内文件。
- 多轮链要求上一轮文档可从归档读回，或显式提供 `prev_document`；两者皆无会返回结构化错误且不派子会话。
- 大文档建议用 `target_file`：把整篇全文内联进单个工具调用参数会显著增大单次请求体。
- 本插件随 0.2.0 预览版 DSH 开发，宿主内核 API（服务名、工具注册约定）在稳定版前可能变动。
