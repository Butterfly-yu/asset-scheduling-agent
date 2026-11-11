# 评估记录

31 项自动测试均通过。[实际测试日志](../examples/test-results.txt)

## 评测设计

先固定请求、规则、素材、模型和候选窗口，然后分别在空闲与占用的独立数据库中运行。此处只改变原始时段的占用。轨迹评测要求模型在观察后的另一个回合发起对应动作，保存路径的参数必须是原始时段，冲突路径查询的候选需要包含期望时段。业务评测再独立检查最终状态、确认要求和实际数据库行，分别记录 `decisionPass` 与 `businessPass`。 [评测实现](../scripts/trajectory-metrics.ts)

| 证据 | 验证的问题 |
| --- | --- |
| 真实调用 Trace | 模型何时观察到空闲或占用，下一轮选择了哪个工具，传了什么参数。 |
| CLI 输出和数据库快照 | 审核与确认结果是否正确，草稿数量及 ID 是否与 SQLite 一致。 |
| 可执行回归测试 | 固定输入或注入故障，检查权限、事务、重放和预算边界。 |

原始 Trace 的 `mode` 标注模型运行方式。Mock 运行使用预设动作验证业务流程。真实模式中的保存失败和查询失败通过应用层注入，验证的是工具报错及其后的决策和输出。

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

M01 原始请求固定为 18:00。空闲场景第 3 轮查到 `AVAILABLE`，第 4 轮调用 `save_draft`，实际写入一条对应草稿。冲突场景第 3 轮查到 `OCCUPIED`，第 4 轮以 `scope=alternatives` 查询备选。最终输出仍保留 18:00，建议 19:00 待确认，草稿数为零。人工确认场景使用同一提案 ID 和数据库，确认后生成 19:00 的草稿。 [待确认提案](../examples/live/conflict.proposals.json) · [确认后的提案快照](../examples/live/confirmation.proposals.json)

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

## 失败及其处置

- **查询失败。** 注入 `--fail-query requested` 后，结果返回 `SLOT_QUERY_FAILED` 和失败的查询范围，没有把查询失败当成空闲。数据库草稿数为零。 [输出](../examples/live/query-failure.output.json)
- **保存失败。** 注入点位于插入草稿之后、事务提交之前。最终返回 `WRITE_FAILED`，没有草稿 ID，数据库中也没有残留草稿。 [输出](../examples/live/write-failure.output.json) · [快照](../examples/live/write-failure.db.json)
- **模型给出无效的最终答复。** 早期真实运行曾在正确查询备选后返回无法通过结构检查的答复。现有评测分别记录动作和业务结果，格式错误可使业务判定失败。 [对应评测回归](../tests/trajectory-eval.test.ts)
- **授权时的观察已过期。** 确认前写入 19:00 的占用后，确认返回 `SLOT_TAKEN`，草稿数为零。另有回归测试覆盖授权变化以及确认事务回滚。 [输出](../examples/mock/stale-confirmation.output.json) · [确认回归](../tests/improvements.test.ts)

## 复现与限制

在项目根目录执行。演示生成的新证据写入 `.local/demo/`，也可以用 `--out DIR` 指定位置。

```powershell
npm test
npm run demo
npm run demo -- --mode live
npm run eval:trajectory -- --mode live --repeats 1
```

`npm test` 覆盖 31 项回归。离线演示覆盖 11 个场景，仓库保留 3 组补充边界记录。真实模式演示覆盖 8 个验收场景，其中 6 个调用模型，其余验证程序的重放和人工确认。最后一条命令用于单独复现空闲与占用的配对评测，需要模型凭据。

真实轨迹来自少量合成场景，尚未测量真实运营数据上的成功率、高并发性能或跨日区间调度。评估证明的是仓库示例中的决策链路、授权边界和实际持久化结果。
