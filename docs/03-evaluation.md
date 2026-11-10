# 评估记录

在 Node.js v26.13.0 下执行了 24 项自动测试和 11 个离线演示场景，均通过。见 [自动测试日志](../examples/test-results.txt)、[离线汇总](../examples/mock/summary.json)。脚本为每个场景留存 `*.output.json`、`*.trace.jsonl` 和 `*.db.json`。离线记录来自实际执行，不能证明真实模型决策。

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
