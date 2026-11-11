# 评估记录

31 项自动测试均通过。[实际测试日志](../examples/test-results.txt)

## 业务验收

以下 8 个场景保留同一批真实模式验收记录。6 个场景调用 DeepSeek Flash，重放和显式确认由程序独立执行。每个场景都有实际输出、Trace 和草稿快照。[运行汇总](../examples/live/summary.json)

| 场景 | 输入与执行条件 | 实际输出 | 验证记录 |
|---|---|---|---|
| 正常排期 | [原始请求](../examples/paired.input.json)，18:00 空闲 | [保存一条草稿](../examples/live/available.output.json) | [Trace](../examples/live/available.trace.jsonl) · [数据库快照](../examples/live/available.db.json) |
| 时段冲突 | [原始请求](../examples/paired.input.json)，`--scenario occupied` | [建议 19:00，等待确认](../examples/live/conflict.output.json) | [Trace](../examples/live/conflict.trace.jsonl) · [数据库快照](../examples/live/conflict.db.json) |
| 素材信息缺失 | [缺字段请求](../examples/missing.input.json) | [列出缺失字段](../examples/live/missing.output.json) | [Trace](../examples/live/missing.trace.jsonl) · [数据库快照](../examples/live/missing.db.json) |
| 规则风险 | [未授权素材请求](../examples/risk.input.json) | [明确阻断](../examples/live/risk.output.json) | [Trace](../examples/live/risk.trace.jsonl) · [数据库快照](../examples/live/risk.db.json) |
| 重复提交 | 原始请求与同一 `--db` 连续执行两次 | [复用同一草稿 ID](../examples/live/replay.output.json) | [Trace](../examples/live/replay.trace.jsonl) · [数据库快照](../examples/live/replay.db.json) |
| 保存失败 | 原始请求加 `--fail-save` | [WRITE_FAILED，草稿为零](../examples/live/write-failure.output.json) | [Trace](../examples/live/write-failure.trace.jsonl) · [数据库快照](../examples/live/write-failure.db.json) |
| 时段查询失败 | 原始请求加 `--fail-query requested` | [SLOT_QUERY_FAILED，草稿为零](../examples/live/query-failure.output.json) | [Trace](../examples/live/query-failure.trace.jsonl) · [数据库快照](../examples/live/query-failure.db.json) |
| 人工确认 | 使用冲突运行生成的提案 ID，在同一数据库中确认 | [重新检查并保存 19:00](../examples/live/confirmation.output.json) | [Trace](../examples/live/confirmation.trace.jsonl) · [数据库快照](../examples/live/confirmation.db.json) |

正常和冲突使用同一输入，仅改变 18:00 的占用。模型在看到可用后请求保存，在看到占用后的另一个回合补查备选。冲突输出保留原始 18:00，并给出 19:00 待确认，数据库草稿数为零。

## 补充边界

以下 3 组离线记录验证不同占用条件和确认时的竞态。Mock 记录只验证流程。[边界场景汇总](../examples/mock/summary.json)

| 场景 | 输入与执行条件 | 实际输出 | 验证记录 |
|---|---|---|---|
| 备选也被占用 | 原始请求加 `--schedule data/occupied-next.json` | [建议 20:00](../examples/mock/occupied-alternative.output.json) | [Trace](../examples/mock/occupied-alternative.trace.jsonl) · [数据库快照](../examples/mock/occupied-alternative.db.json) |
| 无可用备选 | 原始请求加 `--schedule data/occupied-all.json` | [NO_ALTERNATIVE_SLOT](../examples/mock/no-alternative.output.json) | [Trace](../examples/mock/no-alternative.trace.jsonl) · [数据库快照](../examples/mock/no-alternative.db.json) |
| 确认前被抢占 | 生成提案后追加已有占用，再确认 | [SLOT_TAKEN，草稿为零](../examples/mock/stale-confirmation.output.json) | [Trace](../examples/mock/stale-confirmation.trace.jsonl) · [数据库快照](../examples/mock/stale-confirmation.db.json) |

## Harness 与预算

每次工具调用同时核对本轮最初开放的权限和执行前仍有效的权限。首次保存成功或失败后，同一回复中的第二次保存被拒绝，测试确认存储层只执行一次。真实模型的两条路径中保留了治理字段。[治理运行汇总](../examples/harness-smoke/summary.json) · [真实调用记录](../examples/harness-smoke/runs.jsonl)

预算测试覆盖模型回合和工具调用上限。预算耗尽时，运行状态为 `incomplete`，停止原因为 `BUDGET_EXHAUSTED`。已提交的草稿保留保存状态和草稿 ID。写入失败时保留 `WRITE_FAILED`。重复提交会复用已保存草稿。

其他自动测试覆盖素材规则变化、确认写入回滚、伪造调用、批次部分成功、时区校验和模型断开时保留回执。协议适配测试使用注入响应。

## 复现与限制

`npm test` 运行自动测试。`npm run demo` 运行全部 11 个离线场景，新记录默认写入 `.local/demo/mock/`。`npm run demo -- --mode live` 运行 8 个真实模式场景，新记录写入 `.local/demo/live/`。使用 `--out DIR` 可显式指定留存位置。

轨迹评测检查动作是否发生在相应观察之后，业务评测核对输出与 SQLite 行。样例覆盖的是离散时段和合成规则，备选范围为同日向后 1–3 小时。真实模型记录的场景和重复次数有限。
