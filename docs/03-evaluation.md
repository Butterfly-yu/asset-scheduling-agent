# 评估记录

在 Node.js v26.13.0 下执行了 29 项自动测试和 11 个离线演示场景，均通过。见 [自动测试日志](../examples/test-results.txt)、[离线汇总](../examples/mock/summary.json)。脚本为每个场景留存 `*.output.json`、`*.trace.jsonl` 和 `*.db.json`。离线记录来自实际执行，不能证明真实模型决策。

| 场景 | 输入或条件 | 离线结果 |
|---|---|---|
| 正常 | [原始请求](../examples/paired.input.json)，18:00 空闲 | [一条草稿](../examples/mock/available.output.json) |
| 时段冲突 | 同一请求，仅切换 [已有占用](../data/occupied.json) | [19:00 待确认，草稿为零](../examples/mock/conflict.output.json) |
| 缺资料 | [缺授权字段](../examples/missing.input.json) | [列出待补项](../examples/mock/missing.output.json) |
| 规则风险 | [无使用授权](../examples/risk.input.json) | [明确阻断](../examples/mock/risk.output.json) |
| 重复提交 | 同一请求、同一个库 | [复用原 ID](../examples/mock/replay.output.json) |
| 保存失败 | 插入后、提交前注入失败 | [WRITE_FAILED，无草稿](../examples/mock/write-failure.output.json) |
| 时段查询失败 | 注入原时段查询失败 | [SLOT_QUERY_FAILED，注明作用域](../examples/mock/query-failure.output.json) |
| 备选时段变化 | [18:00 和 19:00 均占用](../data/occupied-next.json) | [改建议 20:00](../examples/mock/occupied-alternative.output.json) |
| 无备选 | [搜索窗口已占满](../data/occupied-all.json) | [NO_ALTERNATIVE_SLOT](../examples/mock/no-alternative.output.json) |
| 确认与重放 | 同一个库中人工确认同一提案两次 | [19:00 已存，保留 18:00 原要求](../examples/mock/confirmation.output.json) |
| 确认时被抢占 | 生成提案后再写入 [19:00 占用](../data/occupied-next.json) | [SLOT_TAKEN，草稿为零](../examples/mock/stale-confirmation.output.json) |

额外单测覆盖：确认前素材授权变化、确认写入回滚、伪造调用、同一回合夹带后续动作、执行预算耗尽、模型断开时保留已提交结果、批次部分成功和时区校验。协议适配测试使用注入响应，不调用远端。

2026-11-10 使用 DeepSeek 官方 API（`deepseek-flash`、关闭深度思考）运行最终版。见 [真实模式汇总](../examples/live/summary.json)。8 个场景通过：6 个实际调用模型，重放和显式确认由程序独立执行。

| 关键真实路径 | 观察与下一步 | 数据库结果 |
|---|---|---|
| 18:00 空闲 | 模型看到可用后才调用保存。[Trace](../examples/live/available.trace.jsonl) | [一条草稿](../examples/live/available.db.json) |
| 18:00 占用 | 模型看到占用后另起一轮查备选，选出 19:00 并结束，没有调用保存。[Trace](../examples/live/conflict.trace.jsonl) | [零条草稿](../examples/live/conflict.db.json)，[提案已记录](../examples/live/conflict.proposals.json) |
| 查询失败 | 明确输出查询错误，随后未发起查询或保存。[Trace](../examples/live/query-failure.trace.jsonl) · [输出](../examples/live/query-failure.output.json) | [零条草稿](../examples/live/query-failure.db.json) |
| 人工确认 | 用户动作由 CLI 执行；确认时重新审核和查询后保存，原 18:00 保留。[Trace](../examples/live/confirmation.trace.jsonl) | [19:00 一条草稿](../examples/live/confirmation.db.json) |

历史对照：初版真实轨迹保留在 Git 提交 `3f6ef9477ece437a898d0043a28ab31e62d12449`。初版模型尝试保存备选，被 `CONFIRMATION_REQUIRED` 拒绝；最终版没有这一步。迭代中间版曾在查询失败后尝试备选查询，收紧查询权限后由最终版的评测断言检查是否还会发生。这些是小样本回归，不能推断模型长期稳定性。

## 双版本重复对照

2026-11-10，用同一 DeepSeek Flash 配置对初版（`3f6ef947`）和增强版分别执行 5 组。每组运行两次：相同的请求、素材、规则与模型，仅切换 18:00 的占用；每次运行使用全新的 SQLite 文件。比较脚本核对两版使用的合成材料，并记录运行代码的摘要。共 20 次真实场景运行，见[汇总](../examples/trajectory-eval/summary.json)和[逐次原始证据](../examples/trajectory-eval/runs.jsonl)。

| 指标 | 初版 | 增强版 |
|---|---:|---:|
| 两条路径都完成的组数 | 4 / 5 | 5 / 5 |
| 空闲：正确动作 / 业务成功 | 5 / 5；5 / 5 | 5 / 5；5 / 5 |
| 冲突：正确补查 / 业务成功 | 5 / 5；4 / 5 | 5 / 5；5 / 5 |
| 冲突中的保存调用次数 | 0 | 0 |
| 最终输出格式失败次数 | 1 | 0 |

初版第 2 组冲突运行在看到占用后正确补查，也查到了候选，但最后未通过结构化输出检查（`INVALID_FINAL_RESPONSE`），没有生成可用建议或草稿。因此动作得分通过，业务验收失败。增强版这批运行均返回有效结果。历史上[初版曾尝试保存备选](../examples/trajectory-eval/baseline-original-conflict.trace.jsonl)，本轮重复对照中两版都没有出现该行为；不能把那次历史样本与本轮混算，也不能据此断言工具调用减少。两版同时存在工具权限和提示词等差异，少量同场景样本不能证明某个单独改动导致通过率变化。

动作断言要求模型在收到占用结果后的另一个回合发起备选查询；业务断言核对输出中的时段、确认状态、草稿 ID 与 SQLite 实际行。仅计算模型发起的工具调用，不把应用层生成提案计入，也不把一次被拒绝的保存等同于一次实际写入。

## 工具权限治理验证

同一回复包含两次保存的回归测试覆盖首次成功、首次写入失败两种情况。两种情况下都只调用一次存储层。第二次调用的 Trace 保留本轮最初开放的保存工具，并记录执行前权限已撤销。真实 DeepSeek 的空闲和冲突场景均通过，逐步证据包含治理字段。[运行汇总](../examples/harness-smoke/summary.json) · [真实轨迹](../examples/harness-smoke/runs.jsonl)
