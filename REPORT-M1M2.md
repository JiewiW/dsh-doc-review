# A卡 M1+M2 验收报告：骨架可加载 + 单轮审查闭环

- 日期：2026-10-12
- 任务书：`D:\dsh\docs\doc-review-plugin-taskbook.md` v1.2
- 插件目录：`D:\dsh\dsh-doc-review\`
- 冒烟实例：3099（独立端口），宿主 3080（PID 66232）全程未参与、未重启
- 前序事故：旧会话 session-9991f0e7 耗时 688 分钟未收敛，根因见 §3

## 1. 结论

**M1+M2 达成。** 插件在 3099 独立实例可加载；`doc_review` 工具经真实 spawn 子会话完成两轮独立审查链 + 一次单轮冒烟，结构化报告与归档三文件全部落盘且可机检；96/96 单测通过、apply 装配冒烟通过。

一项任务书假设被实测推翻（A13 的「--patch overlay 不触碰任何 profile」），见 §4：不影响插件功能与 3080 运行，但严格 mtime 判据未满足，已如实记录。

## 2. 实测证据

### 2.1 自动化测试（本机 D:\dsh checkout 内核，node 直跑）

| 项 | 命令 | 结果 |
|---|---|---|
| 四个 node:test 套件 | `node --test test/schema.test.mjs test/context-builder.test.mjs test/convergence.test.mjs test/cost.test.mjs` | **tests 96 / pass 96 / fail 0** |
| host 入口装配冒烟 | `node test/smoke-apply.mjs` | **PASS**（import 链、defineTool DSL 编译、register/dispose、spawn 缺失 warn 降级） |

注：`node --test test/` 会把非 node:test 格式的 smoke-apply.mjs 误计为失败，须显式列出 4 个测试文件。

### 2.2 真实 E2E（3099 实例，模型 Doubao-Seed-2.1-Pro，人工 UI 发起）

| 链 | 形态 | 轮次 | issues | 实测耗时 | 归档 |
|---|---|---|---|---|---|
| docr-1e773231-60c9-46d3-9bf6-b9ecd539298d | 多轮 | round-1 | 6 | 约 4 分钟（UI 总耗时 5m50s 含第二轮） | 三文件齐 |
| 同上 | | round-2 | 8（newIssueCount=8） | | 三文件齐，change-log 736B（含主 Agent 裁决表） |
| docr-624b08b9-7d15-474d-a17b-4838a34faf9b | 单轮 max_rounds=1 | round-1 | 7 | **子会话 78.1 秒**（08:48:39.385Z→08:49:57.506Z） | 三文件齐 |

审查质量人工核对：7~8 条 issue 全部命中预埋缺陷——沸点 90°C 事实错误（正文+备注）、高原因果倒置、光速 30 公里/秒差约一万倍、重复句、H1→H3 跳级/H3 先于 H2；每条带 ≥8 字原文 location 与 dimension/severity，无参考资料时 evidence=no-reference，符合 generic SKILL 契约。第二轮主 Agent 裁决 accept/partial/reject 三态均被使用（reject 1 条，理由=测试标记系文档用途）。

### 2.3 冒烟日志三关键行（A13）

证据文件：`evidence/A13/smoke-event-log.jsonl`（环境变量 `DSH_DOC_REVIEW_SMOKE_LOG` 开启后由插件 logger 追加）：

```
doc_review_subagent_created   runId=53435c70-... attempt=1
doc_review_structured_report  attempt=1 issueCount=7
doc_review_archive_written    directory=D:\dsh\.doc-review\docr-624b08b9-...\round-1
```

附加信号：`doc_review_plugin_applied spawnProviderPresent:false`（apply 时刻）→ `doc_review_start spawnProviderPresent:true`（execute 时刻），实证 A01 设计的 cordis apply 时序假阴性与运行期按名解析兜底；`skillMissing:false inputChars:1231 droppedBlocks:0` 证明走的是真实 SKILL 注入路径而非默认文本降级。

### 2.4 归档机检（A09）

证据文件：`evidence/A13/archive-manifest.txt`。两条链共 9 个文件，三份 review-report.json 全部 `ConvertFrom-Json` 可解析，round/chainId/issues/newIssueCount 字段齐全且 chainId 与目录名一致。round-2 归档存在于同一 chain，change-log.md 含上一轮裁决表（无裁决表的固定标注「主 Agent 未回传裁决表」未被编造）。

## 3. 旧会话事故根因（prepare 错误）

旧会话在 3099 上调任何工具（含内建 pwsh）均报 `Cannot read properties of undefined (reading 'prepare')`，与本插件无关。对照实验与哈希比对锁定根因：

- 3080 正常进程：`node D:\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js web --port 3080`（**checkout 内核，含源码级本地补丁**）。
- 旧 3099 故障进程：`node C:\Users\Administrator\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js web --patch ...`（**全局 npm 包，pristine 0.2.0-rc.2**）。
- 哈希差异：dsh-agent-loop checkout 89118B/5535a03d vs global 72994B/00c4814d（差 16KB）；dsh-tools 158333B/63fef714 vs 157954B/47709337（差 379B）。prepare 调用行与 scheduler 赋值行两边都在（非缺行），差异是 checkout 本地补丁改变了派发行为。
- 对照实验：同一 3099 端口改用 checkout bin 启动后，内建 pwsh 12 秒返回 `E2E-CONTROL-OK`，doc_review E2E 随之全程成功。

教训：开发期冒烟实例必须显式用 checkout 的 bin.js 启动，不能让 PATH 上的全局 `dsh.cmd` 解析到 pristine 发布包；本机全局包落后于 checkout 补丁状态。

## 4. A13 偏差：--patch overlay 会重写共享 web profile 元数据

任务书 §5（第 54 行）与 T13（第 212 行）假设「--patch overlay 不触碰任何 profile / 不依赖任何 profile，无需新建 profile」。实测：

| 信号 | 冒烟前（13:40 baseline） | 冒烟后 | 判定 |
|---|---|---|---|
| 3080 PID / 启动时间 | 66232 / 12:49:05 | 66232 / 12:49:05，仍监听 | **未变** |
| profiles/web/package.json | mtime 02:16:48，2512B | mtime 15:50:23，**2512B**，无 doc-review 依赖 | 长度/内容无插件污染，mtime 被重写 |
| profiles/web/node_modules/.modules.yaml | mtime 02:16:48，30134B | mtime 15:50:23，**30134B** | 同上 |
| profiles/web/cordis.patch.yml | mtime 13:03:09，32994B | mtime 16:56:43，**32969B**，无 doc-review 插件行 | mtime 与长度均变（-25B），无插件污染 |

证据：`evidence/A13/3080-baseline-before.txt`、`evidence/A13/3080-after-final.txt`。

结论：
1. **插件未被安装进 profile**（package.json dependencies 与 cordis.patch.yml 均无 doc-review 条目），overlay 的插件加载本身是内存态；3080 运行中实例全程不受影响（本会话即运行于该 3080）。
2. 但 `dsh web` 不带 `--profile` 时默认使用 profiles/web，启动期 profile 依赖调和/patchReload(live) 会**重写共享 profile 的元数据文件**，严格的「三项 mtime 未变」判据**不满足**。任务书该假设需修正。
3. 彻底隔离方式：冒烟实例改用独立 profile（`dsh --profile <name> web ...`，`--profile` 为 launcher 旗标须置于应用旗标之前），本次未重跑独立 profile 对照，列为后续项。

## 5. 验收清单状态（M1+M2 范围）

| 验收 | 状态 | 依据 / 缺口 |
|---|---|---|
| A01 可加载 + spawn provider | ✅ | smoke-apply PASS；冒烟日志 apply→execute provider false→true |
| A02 双 Schema 非法样例 100% 拦截 | ✅ | schema.test.mjs 在 96 内（T02a raw / T02b DSL 双套件） |
| A03 参数错误/未知枚举/busy 零子会话 | ⚠️ 代码已实现，缺直接单测 | 无 tool.test.mjs；busy/arg-error 分支未在本轮被直接执行，建议补工具层单测 |
| A04 thinking 零泄漏 + 兜底标记 | ✅（M2 路径） | context-builder 单测通过；E2E 日志 droppedBlocks=0 heuristicClean=false（内联文本路径） |
| A05 子会话不含主会话历史 | ✅ 机制+信号 | spawn runId 落盘；隔离为内核 spawn 语义保证 |
| A06 重试 ≤2 + 降级显式 | ⚠️ 代码已实现，未触发 | 两次 E2E 均 attempt=1 一次成功，重试/降级路径无实测样本 |
| A07 issue id 可机检 | ✅ | 三份 JSON 的 id/dimension/severity/location 全字段可解析 |
| A08 收敛/对齐/边界 4 项 | ✅ | convergence.test.mjs 在 96 内；详见既有 REPORT-T08T10.md |
| A09 归档三文件 + round 读回 | ✅（文件侧）/⚠️ | 9 文件齐、JSON 全可解析、同链 round-2 存在；archive.js 注释声明的「A09 读回单测入口」无 archive.test.mjs，readArchivedDocument 未直接单测 |
| A11 SKILL 重启后命中 | ✅（generic） | 重启后 E2E skillMissing:false；tech-spec/product-doc 两个 SKILL 属后续里程碑，不在 M2 |
| A13 三关键行 + 3080 机检 | ⚠️ 部分 | 三关键行齐全、3080 存活；严格 mtime 判据失败，见 §4 |
| A14 挂载进 3080 | ⏸ 未执行 | T14，须用户同意后按 bundle 两处登记走，不在本次范围 |

## 6. 产物清单

- 代码：`lib/{index,tool,reviewer,schema,context-builder,defaults,logger,adjudicate,archive,convergence,cost}.js`（11 模块，node --check 通过）
- 技能：`skills/doc-review-generic/SKILL.md`（领域背景/审查规则双锚点）
- 测试：`test/{schema,context-builder,convergence,cost}.test.mjs`（96 用例）+ `test/smoke-apply.mjs` + `test/fixtures/e2e-target.md`
- 证据：`evidence/A13/{3080-baseline-before.txt,3080-after-final.txt,smoke-event-log.jsonl,archive-manifest.txt}`
- 真实归档：`D:\dsh\.doc-review\` 下两条 chain（round-1/round-2 三文件）
- 冒烟实例：3099，PID 71444，checkout bin 启动，命令行为
  `node D:\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js web --patch D:\dsh\dsh-doc-review\cordis.patch.yml --port 3099 --no-open`

## 7. 后续建议

1. 补 `test/tool.test.mjs`：arg 校验、未知 doc_type、busy 互斥、references 路径穿越四组零子会话用例（A03/A06 收口）。
2. 补 `test/archive.test.mjs`：writeRoundArchive 三文件 + readArchivedDocument 成功/缺失降级（A09 收口）。
3. 任务书 §5/T13 修订：overlay 不安装插件但会重写共享 profile 元数据；冒烟 SOP 改为独立 `--profile` 或接受 mtime 漂移改判「内容无插件污染 + 3080 进程不变」。
4. T14 挂载 3080 前先处理全局 npm 包与 checkout 补丁不一致问题（或统一只用 checkout bin）。
