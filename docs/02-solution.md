# 方案与取舍

`cli.ts` 验证输入并载入合成数据；`agent.ts` 逐项执行有界循环；`model.ts` 负责 DeepSeek Chat Completions / 兼容接口和离线决策器；`tools.ts` 封装素材、规则、时段和草稿工具；`domain.ts` 实现时间、规则与请求校验；`store.ts` 负责 SQLite 与事务。

真实模式由模型返回工具调用。运行层把调用及对应 `tool_call_id` 的结果放回消息列表，再由模型选择下一步或用 JSON 结束。系统消息建议一轮一个动作，运行层不会因占用自动选替代查询。每项最多 8 个模型回合、10 次工具尝试，默认 35 秒超时。输出以工具证据为准：模型输出的候选必须在查询结果中；成功需要数据库提交回执；模型结束失败不能抹去已提交草稿。

工具参数不接收可覆盖的素材、渠道或用户确认。保存首先核对硬性时段和审核；事务内识别已保存回执，重查时段，再插入并提交。同一渠道和 UTC 时段唯一；请求和素材组合也唯一。请求 ID 绑定规范化内容及会影响候选的本地偏移量，同 ID 更换内容拒绝。批次部分成功后重放只重新处理未保存项。工作流参考 [Cal.com 的查时段接口](https://cal.com/docs/api-reference/v2/slots/get-available-time-slots-for-an-event-type) 和 [Stripe 的参数绑定](https://docs.stripe.com/api/idempotent_requests)，未调用这些服务。

选型：TypeScript CLI 可以直接复现，免 HTTP 服务。Pi Core 本可提供工具和事件循环，但本机 npm 镜像连接受限，因此按方案的降级路径改用 Node 原生 `fetch`、明确的循环和内置 `node:sqlite`。未集成 Pi、LangGraph 或 ADK。使用版本化 JSON 规则比将规则写在 Prompt 或维护 LLM Wiki 更容易验证；SQLite 唯一约束与短事务比 JSON 草稿文件更适合验证冲突和重复写入。Trace 借鉴 [ADK 轨迹评测](https://codelabs.developers.google.com/adk-eval/instructions) 思路，用本地断言检查关键动作，不固定整条轨迹。Trace 的简短依据由工具事实生成，不是模型内部思考。
