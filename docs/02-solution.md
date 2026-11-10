# 方案与取舍

`cli.ts` 校验请求和素材、规则、占用文件。`agent.ts` 逐项执行有界循环。`model.ts` 处理 DeepSeek Chat Completions 与离线 Mock。`tools.ts` 定义四种工具和可见条件。`domain.ts` 处理时间、规则和数据校验。`store.ts` 负责 SQLite。`confirmation.ts` 是人触发的后续流程。

真实模式由模型返回工具调用，程序把调用及对应 `tool_call_id` 的结果放回消息列表。模型根据事实选择查询、保存或结束。工具授权随可信状态收紧：素材读取后才可审核、审核通过才可查时段、原时段查到空闲后才提供草稿保存。每轮开始时固定可用工具集合，越过集合的调用不会执行；就算模型伪造保存参数，保存入口仍核验原始时段和审核，并在事务内重查占用。每项最多 8 个模型回合、10 次工具调用尝试，默认 35 秒。Trace 中的依据来自工具事实，不是模型内部推理。

在保存阶段，以 SQLite 提交回执作为成功证据；查询失败给出具体作用域，写入失败不被后续模型格式错误覆盖。候选只接受实际查到的时段，无候选和查询失败分别报告。首次查到空闲不是预留。SQLite 对渠道及 UTC 时段、请求及素材分别设唯一约束；同请求 ID 绑定规范化内容以及影响本地候选的时区偏移。

模型选出候选后，应用层创建持久化提案，记录原时间、候选时间、请求、素材和渠道；提案不占用时段。人工 CLI 确认只接受提案 ID，不接受任意新时间，也不会调用模型。确认事务内重查素材和占用，同时提交草稿和确认回执。若确认前候选被占用，可重跑原请求生成新提案；确认同一提案两次，只会有一份草稿。

选型：TypeScript CLI 便于复现；Node 原生工具循环是在 npm 镜像受限后采用的零第三方依赖方案，未集成 Pi、LangGraph 或 ADK。规则用版本化 JSON、占用和草稿用 SQLite，比仅靠 Prompt 或 JSON 草稿文件更容易验证。排期读写分离参考 [Cal.com](https://cal.com/docs/api-reference/v2/slots/get-available-time-slots-for-an-event-type)，幂等参数绑定参考 [Stripe](https://docs.stripe.com/api/idempotent_requests)，轨迹断言参考 [ADK 评测](https://codelabs.developers.google.com/adk-eval/instructions)；项目未接入这些服务。
