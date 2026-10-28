# LLM 棋手

Chessin 可以让大语言模型（Claude、GPT、DeepSeek、通义千问、Kimi、本地 Ollama 等）下国际象棋：LLM 对 LLM，或者你执一方对 LLM。

## 禁止使用引擎

LLM 棋手每走一步只是一次普通的对话请求：发过去的是局面（着法记录、FEN、文字棋盘，可选的合法着法列表），收回来的是一段文字，最后一行是 `MOVE: <着法>`。

- 请求里不带任何工具、函数调用、代码执行、联网搜索或 MCP（`src/shared/llm/client.ts` 里的 `assertNoToolAccess` 会拒绝这类字段），所以模型无法调用 Stockfish 或任何程序，只能靠自己的推理。
- 「Claude 订阅」是调用本机的 Claude Code 命令行，每一步都带上 `--tools ""`（关闭全部内置工具，包括终端、读写文件、联网）、`--strict-mcp-config`（不加载 MCP）和 `--setting-sources ""`（不加载设置、钩子和插件），并在空的临时目录里运行。返回后还会检查：模型只回答了一轮，没有任何联网请求，否则这一步作废。
- 提示词里也不包含引擎评估。对局进行中，引擎面板和引擎分析会关闭，对局结束后才能用引擎复盘。

## 在界面里使用

1. 点「新局」，选「LLM 对弈」。
2. 在「管理 LLM 棋手」里添加棋手：
   - **Claude 订阅**：不用 API 密钥，直接用你的 Claude Pro/Max 订阅。前提是本机装了 Claude Code 并登录过（终端里运行一次 `claude`）。模型可填 `claude-opus-5-5`、`claude-sonnet-5-5`，或简写 `opus`、`sonnet`。仅桌面版和命令行可用。
   - **Anthropic (Claude)**：填 API 密钥，模型默认 `claude-opus-5-5`，可调思考强度。
   - **OpenAI 兼容**：选预设（OpenAI、DeepSeek、通义千问、Kimi、智谱、OpenRouter、Ollama）或自己填接口地址，再填模型名和密钥。
   - 可以点「测试」检查连接。密钥只保存在本机。
3. 白方、黑方各选「人类」或某个 LLM 棋手，开始对局。

规则：

- 模型走出非法或看不懂的着法时会被告知原因并重试（默认 2 次），仍然失败判负。
- 接口出错（网络、密钥、额度）不判负，对局暂停，修好后点「继续」。
- 将死、逼和、三次重复、50 回合、子力不足自动判定；超过 300 个半回合判和。
- 每一步的完整回复（模型的思路）都能在对局面板里展开查看。PGN 可以复制或保存，带棋手信息和结果。

网页版和安卓版直接从浏览器请求接口，所以 OpenAI 兼容接口需要允许跨域（Ollama 设置 `OLLAMA_ORIGINS=*`）。桌面版通过主进程请求，没有这个限制。

## 命令行批量对局

```
cp scripts/arena.example.json arena.json   # 改成你要的棋手
ANTHROPIC_API_KEY=... OPENAI_API_KEY=... npm run arena -- arena.json
```

颜色每局轮换，PGN 追加到 `out` 指定的文件。

`npm run test:llm` 用本地假模型服务器跑几盘完整对局，检查着法解析、重试、胜负判定，以及每个请求都没有带工具。
