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

真实模型验收：当前没有本机可用密钥，未运行。配置后执行 `npm run demo -- --mode live`；空闲轨迹要求模型在看到可用后才请求保存，冲突轨迹要求模型看到占用后才查候选。两者都核对最终数据库行数。若模型跳过补查、输出格式错误或工具调用失败，保留失败记录并说明，不能用 Mock 补位。
