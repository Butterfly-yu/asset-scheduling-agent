# 素材审核与发布排期 Agent · 第 1 题

内容运营提交素材、渠道和硬性时段。Agent 核对审核规则、查时段、保存草稿；遇到冲突时提出可确认的备选。**待确认提案不占用时段；人工确认后才可能保存草稿。** 项目没有发布入口。

## 快速运行

需要 Node.js 24+，验证环境为 Node.js v26.13.0。无第三方依赖。以下命令在仓库根目录执行，默认不需要密钥：

```powershell
npm test
npm run demo
node src/cli.ts run --input examples/paired.input.json --scenario available
node src/cli.ts run --input examples/paired.input.json --scenario occupied
```

两条单次命令用独立的内存数据库。只改变 18:00 的占用状态，就能看到一条直接保存、一条建议 19:00 并待确认。要跨命令确认，使用 SQLite 文件：

```powershell
$run = node src/cli.ts run --input examples/paired.input.json --scenario occupied --db .local/review.sqlite | ConvertFrom-Json
$run.items | Format-List
# 检查提案是否符合要求；同意其中的具体时段后执行下面两条。
$proposal = $run.items[0].proposalId
node src/cli.ts confirm --db .local/review.sqlite --proposal $proposal
node src/cli.ts inspect --db .local/review.sqlite
```

确认保留原始 18:00 要求，只对提案绑定的 19:00 写草稿。第二次确认返回同一草稿 ID。若 19:00 在确认前被占用，结果为 `SLOT_TAKEN`；重跑原始请求可生成新的候选。想复现这个拒绝分支，请在一个新库中生成提案，在第一次确认命令中追加 `--schedule data/occupied-next.json`。

`--schedule` 可载入已有排期；`--assets` 和 `--rules` 可载入审核资料。格式见 `data/`。同一个持久数据库会保留先前的草稿和占用，载入种子只添加记录。指定 `--trace .local/run.trace.jsonl` 可单独保存 Trace。用 `--fail-query requested` 或 `--fail-save` 演示查询和提交前故障。

## 真实 DeepSeek / 兼容模型

首次配置时复制 `.env.example` 到 `.env`，设置 `AGENT_API_KEY` 和 `AGENT_MODEL`；已有 `.env` 不要覆盖。DeepSeek 官方示例使用 `deepseek-flash`，兼容接口可设置 `AGENT_PROVIDER=compatible`，并指定提供商的 HTTPS 基础地址。密钥仅保存在 Git 忽略的 `.env`。[DeepSeek 工具调用文档](https://api-docs.deepseek.com/guides/tool_calls/)

```powershell
npm run demo -- --mode live
```

脚本会保存真实模型输出、Trace、草稿快照和评测汇总；其中重放和人工确认步骤由确定性程序执行。真实模式不会在远端失败时回退到 Mock。

## 评审入口

| 检查项 | 文件 |
|---|---|
| 所有验收及两种真实轨迹 | [评估](docs/03-evaluation.md) · [真实模式汇总](examples/live/summary.json) · [离线汇总](examples/mock/summary.json) |
| 自动测试 | [基础用例](tests/agent.test.ts) · [确认和故障用例](tests/improvements.test.ts) · [实际日志](examples/test-results.txt) |
| 业务与方案 | [需求](docs/01-requirements.md) · [方案](docs/02-solution.md) |
| AI 使用与复盘 | [AI 使用](docs/04-ai-usage.md) · [复盘](docs/05-retrospective.md) |

业务未完成以 JSON 状态和原因表达；CLI 输入或配置错误退出码为 1，评测断言失败也退出 1。
