# 评估记录

实际结果见 [Mock 汇总](../examples/mock/summary.json) 和 [自动测试日志](../examples/test-results.txt)。演示脚本对每个场景留存三类证据：`*.output.json`、`*.trace.jsonl`、`*.db.json`。这些 Mock 轨迹来自实际运行，但不证明真实模型决策。

| 场景 | 输入 | 实际输出 | Trace |
|---|---|---|---|
| 正常 | [同一排期请求](../examples/paired.input.json) | [保存草稿](../examples/mock/available.output.json) | [available](../examples/mock/available.trace.jsonl) |
| 冲突 | 同一排期请求；仅变更占用种子 | [候选 19:00，待确认](../examples/mock/conflict.output.json) | [conflict](../examples/mock/conflict.trace.jsonl) |
| 缺资料 | [缺授权字段](../examples/missing.input.json) | [请求补充](../examples/mock/missing.output.json) | [missing](../examples/mock/missing.trace.jsonl) |
| 规则风险 | [无使用授权](../examples/risk.input.json) | [明确阻断](../examples/mock/risk.output.json) | [risk](../examples/mock/risk.trace.jsonl) |
| 重复提交 | 同一排期请求和同一库 | [复用原 ID](../examples/mock/replay.output.json) | [replay](../examples/mock/replay.trace.jsonl) |
| 保存失败 | 同一排期请求；插入后、提交前注入错误 | [未完成且无回执](../examples/mock/write-failure.output.json) | [write-failure](../examples/mock/write-failure.trace.jsonl) |

自动测试另覆盖：授权绕过、过期的时段查询、伪造候选或回执、预算耗尽、模型断开时保存结果保留、部分成功、时区规范化和工具协议。协议测试使用注入的 HTTP 响应，未向远端发送请求。

2026-11-10 使用 DeepSeek 官方 API（`deepseek-flash`，关闭深度思考），在 Node.js v26.13.0 下执行 `npm run demo -- --mode live`。两条场景均通过脚本断言，见[实际汇总](../examples/live/summary.json)。两次使用相同请求和各自全新的 SQLite 库，只改变 18:00 的占用。

| 场景 | 实际模型行为 | 数据库证据 |
|---|---|---|
| 空闲 | 第 3 轮看到 18:00 可用，第 4 轮调用保存，结果为已保存。[Trace](../examples/live/available.trace.jsonl) · [输出](../examples/live/available.output.json) | [一条草稿](../examples/live/available.db.json) |
| 冲突 | 第 3 轮看到 18:00 被占用，第 4 轮查替代时段。第 5 轮尝试保存 19:00，被工具以 `CONFIRMATION_REQUIRED` 拒绝；最终建议 19:00 并等待确认，原始要求仍为 18:00。[Trace](../examples/live/conflict.trace.jsonl) · [输出](../examples/live/conflict.output.json) | [零条草稿](../examples/live/conflict.db.json) |

冲突用例通过是因为模型确实根据新观察补查，且业务约束阻止了未授权写入。模型发出了本可避免的保存调用，这仍是决策质量上的不足；`saveStatus: not_attempted` 表示没有进入数据库写入，不代表模型没有请求保存。样本量为每个场景一次，不能据此推断长期稳定性。
