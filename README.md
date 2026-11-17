# Foxpit

All your coding agents, one window. Free and open source.

Foxpit is a desktop app for Claude Code, Codex and the other coding agents you already use. It runs them on your own subscriptions, side by side, and shows what each one is doing.

- **Chats side by side.** Split the window, drag a chat in, run several agents at once.
- **Your accounts, switched for you.** Several Claude (or ChatGPT) accounts in one place, through [Magpie](https://github.com/yetone/magpie). When one hits its limit, the chat carries on on the next one.
- **Talk while it works.** A message typed mid-reply goes to the agent at once, the way Claude's own app does it.
- **A browser beside the chat.** The agent opens your app in Foxpit's browser, clicks, types and reads the console; you watch it live, switch to a phone size, open DevTools, or draw a box round what's wrong and send it to the chat.
- **Sub-agents you can see.** Agents can start other Foxpit chats for parts of a task and wait for their answers.
- **Git where you work.** Each chat can get its own copy (worktree), with commit, push and pull request from the window. GitHub issues and PRs in a side tab.
- **Everything else you'd expect.** Full-size images, voice typing, usage per account, the agent's next-message suggestion, your old Claude Code chats imported and kept up to date, self-updates.

Everything runs on your computer. Foxpit talks to the agents and to Magpie on 127.0.0.1; there is no Foxpit server and no telemetry.

## Download

Windows and macOS (Apple Silicon and Intel) builds are on the [releases page](https://github.com/lordon1a/foxpit-app/releases). Foxpit updates itself after that.

The builds are not code-signed yet, so Windows SmartScreen and macOS Gatekeeper ask once before the first start.

## Build from source

You need Go 1.27+ and, on Windows, PowerShell.

```powershell
# Windows: dist\foxpit.exe, and with -Setup the installer (it fetches Magpie)
.\build.ps1
.\build.ps1 -Setup
```

```bash
# macOS / Linux: needs Xcode command line tools on a Mac
go build -o foxpit .
./foxpit
```

`go run . --dev-http 127.0.0.1:3500` serves the same page in a browser with no window, which is how the interface is tested.

## How it fits together

- `main.go`: the Wails v3 window and the local API.
- `chat.go`, `worker.go`: one Claude Code process per chat, fed as stream-json, kept warm between turns.
- `magpie*.go`, `claude_account.go`: accounts, limits and switching through Magpie.
- `approve.go`, `spawn.go`, `browser_tools.go`: Foxpit's own tool server for the agents (questions, sub-agent chats, the browser).
- `browser.go`: the browser, a Chromium already on the computer, run with no window over the DevTools protocol and streamed to the page.
- `frontend/`: the interface, plain JavaScript and CSS.

## Support

Foxpit is free. If it saves you time, you can [buy me a coffee](SUPPORT_LINK).

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE) for the parts that come from other projects.
