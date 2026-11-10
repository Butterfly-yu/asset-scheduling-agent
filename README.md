# 素材审核与发布排期 Agent · 第 1 题

内容团队提交素材、渠道与硬性时间。Agent 核对授权、检查已有排期并保存本地草稿；发生冲突时，可查找替代时段并请求确认。没有发布入口。

**验收状态：离线六场景已运行；真实 DeepSeek 两条轨迹待配置并执行。** 现有 `examples/mock/` 是真实执行的离线 Mock 记录，不能证明真实模型决策。协议适配测试也不访问模型。

## 快速运行

需要 Node.js 24+；交付验证用 Node.js v26.13.0。无第三方依赖，无需运行安装命令；若评审习惯安装，可执行 `npm ci --offline`。从仓库根目录运行：

```powershell
npm test
npm run demo
node src/cli.ts run --input examples/paired.input.json --scenario available
node src/cli.ts run --input examples/paired.input.json --scenario occupied
```

两个单次命令默认用各自独立的内存数据库，只有占用场景不同。第二条运行输出硬性时段 18:00 和候选 19:00，状态为 `pending_confirmation`。使用文件库验证重放：

```powershell
node src/cli.ts run --input examples/paired.input.json --db .local/replay.sqlite
node src/cli.ts run --input examples/paired.input.json --db .local/replay.sqlite
node src/cli.ts inspect --db .local/replay.sqlite
```

第二次返回相同 ID 和 `saveStatus: replayed`；数据库只有一份草稿。要重新演示，用新的数据库文件路径。`--scenario` 负责将占用种子加入数据库，不会删除旧占用。指定 `--trace .local/run.trace.jsonl` 可将 Trace 单独写出，否则 Trace 内联。指定 `--fail-save` 模拟插入后、提交前的写入故障。

## DeepSeek / 兼容模型

首次配置时复制样例；如果已有 `.env`，直接编辑即可。密钥仅留在本机，`.env` 已被 Git 忽略：

```powershell
Copy-Item .env.example .env
notepad .env
```

将 `AGENT_API_KEY` 填入本机文件；`AGENT_MODEL` 填账号可用且支持工具调用的模型。DeepSeek 官方[工具调用示例](https://api-docs.deepseek.com/guides/tool_calls/)使用 `deepseek-flash`，如你的账号可用可以从该模型开始。兼容服务请设 `AGENT_PROVIDER=compatible`，填写服务商的 HTTPS 基础地址（包含所需的路径前缀，例如 `/v1`，但不含 `/chat/completions`），并使用对应模型 ID。真实模式出错会明确报告，不自动切换 Mock。

```powershell
npm run demo -- --mode live
```

命令会用同一输入、两个全新数据库运行空闲和占用场景，并在 `examples/live/` 输出实际结果、Trace、数据库快照和断言报告。先确认 `summary.json` 两项通过，再审阅并提交这组证据。测试模式仅使用仓库内的合成数据。

## 评审入口

| 检查项 | 文件 |
|---|---|
| 六项验收和 Mock 轨迹 | [评估文档](docs/03-evaluation.md) · [离线场景汇总](examples/mock/summary.json) |
| 自动测试 | [测试用例](tests/agent.test.ts) · [实际执行记录](examples/test-results.txt) |
| 业务范围和结构 | [需求](docs/01-requirements.md) · [设计](docs/02-solution.md) |
| AI 辅助和下一步 | [AI 使用](docs/04-ai-usage.md) · [复盘](docs/05-retrospective.md) |

业务未完成通过 JSON 状态表达；CLI 参数或配置错误退出码为 1。评测脚本在断言失败时退出 1。
