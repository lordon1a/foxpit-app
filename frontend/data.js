// Sample data while the Magpie gateway is not wired in yet. The shape is what
// the interface reads; the gateway adapter will fill the same shape.
window.FOXPIT_DATA = {
  project: "my-app",
  projectPath: "C:\\Users\\you\\code\\my-app",
  worktree: "tauri-gecis",
  branch: "main ↑2",
  autoSwitch: true,
  accounts: [
    { id: "claude-work", provider: "claude", name: "Claude · Work", plan: "Max 20×", who: "work account",
      fiveHour: 68, week: 41, resetIn: "2h 10m", models: [
        { id: "opus-5.5", name: "Opus 5.5", note: "high effort" },
        { id: "sonnet-5.5", name: "Sonnet 5.5", note: "fast" } ] },
    { id: "claude-personal", provider: "claude", name: "Claude · Personal", plan: "Max 5×", who: "personal account",
      fiveHour: 12, week: 30, resetIn: "4h 05m", models: [
        { id: "opus-5.5", name: "Opus 5.5", note: "same model, fresh quota" },
        { id: "sonnet-5.5", name: "Sonnet 5.5", note: "" } ] },
    { id: "codex-personal", provider: "codex", name: "Codex · Personal", plan: "Plus", who: "ChatGPT plan",
      fiveHour: 6, week: 22, resetIn: "Mon", models: [
        { id: "sol-6.1", name: "Sol 6.1", note: "" },
        { id: "luna-6.1", name: "Luna 6.1", note: "" } ] },
    { id: "opencode-go", provider: "oc", name: "OpenCode Go", plan: "Go", who: "no hourly limit",
      fiveHour: null, week: null, resetIn: "", models: [
        { id: "deepseek-v4.1-flash", name: "deepseek-v4.1-flash", note: "" },
        { id: "mimo-v2.6-flash", name: "mimo-v2.6-flash", note: "" } ] }
  ],
  chats: [
    { id: "c1", title: "Port tray panel to Tauri", state: "running", group: "Running",
      account: "claude-work", model: "opus-5.5", effort: "high",
      changes: [["src-tauri/src/tray.rs", 48, 0], ["src/tray/Panel.tsx", 112, 9], ["src-tauri/tauri.conf.json", 14, 0]],
      messages: [
        { role: "user", text: "Move the tray panel out of Electron. Keep Team / Usage / Accounts, but it has to open instantly from the system tray." },
        { role: "assistant", account: "claude-work", model: "opus-5.5", when: "2m",
          text: "The tray becomes a second window with no decorations, positioned above the tray icon and hidden on blur. Usage comes from the same gateway the main window uses, so both stay in sync.",
          tool: { name: "Edit", path: "src-tauri/src/tray.rs", add: 48, del: 0,
            lines: ["+ let tray = TrayIconBuilder::new().icon(app.default_window_icon())", "+     .on_tray_icon_event(|t, e| toggle_panel(t.app_handle(), e))"] } }
      ] },
    { id: "c2", title: "Account store in Rust", state: "running", group: "Running",
      account: "codex-personal", model: "sol-6.1", effort: "medium", changes: [["src/accounts.rs", 87, 3]],
      messages: [
        { role: "user", text: "Store each account's sign-in in the system keyring, never in a JSON file." },
        { role: "assistant", account: "codex-personal", model: "sol-6.1", when: "3m",
          text: "Using the keyring crate: one entry per account id. Profiles keep only the id and display name, so nothing secret touches disk." }
      ] },
    { id: "c3", title: "Fix quota reset = 0 bug", state: "done", group: "Today",
      account: "claude-personal", model: "opus-5.5", effort: "high", changes: [["app/hesap_secici.js", 21, 6]],
      messages: [
        { role: "user", text: "The usage bar reads empty when the reset time is missing." },
        { role: "assistant", account: "claude-work", model: "opus-5.5", when: "1h",
          text: "Number(null) is 0, so a missing reset looked like a fresh window. Missing now means unknown, in the panel and in account picking." },
        { role: "switch", account: "claude-personal", model: "opus-5.5", reason: "limit", tokens: "18k" },
        { role: "assistant", account: "claude-personal", model: "opus-5.5", when: "58m",
          text: "Continuing on the personal account. Added five tests for the unknown-quota cases; all pass." }
      ] },
    { id: "c4", title: "xterm.js resize flicker", state: "idle", group: "Today",
      account: "opencode-go", model: "deepseek-v4.1-flash", effort: "medium", changes: [],
      messages: [
        { role: "user", text: "The terminal flickers when the window is restored." },
        { role: "assistant", account: "opencode-go", model: "deepseek-v4.1-flash", when: "2h",
          text: "The fit addon runs twice on restore. Debouncing it to one frame removes the flicker." }
      ] },
    { id: "c5", title: "Release notes 0.2.0", state: "idle", group: "Today",
      account: "codex-personal", model: "luna-6.1", effort: "low", changes: [], messages: [
        { role: "user", text: "Draft release notes for 0.2.0." },
        { role: "assistant", account: "codex-personal", model: "luna-6.1", when: "5h",
          text: "New desktop shell, tray panel, one-click account switching, and a much smaller install." } ] },
    { id: "c6", title: "Worktree cleanup on exit", state: "idle", group: "Yesterday",
      account: "claude-work", model: "sonnet-5.5", effort: "medium", changes: [], messages: [
        { role: "user", text: "Remove agent worktrees that have no changes when Foxpit quits." } ] },
    { id: "c7", title: "Polar webhook retries", state: "idle", group: "Yesterday",
      account: "claude-work", model: "opus-5.5", effort: "high", changes: [], messages: [
        { role: "user", text: "Polar retries the webhook three times; make the handler idempotent." } ] }
  ],
  terminal: [
    ["g", "❯ "], ["", "cargo build\n"],
    ["dim", "   Compiling foxpit v0.2.0\n    Finished dev in 6.42s\n"],
    ["y", "tray "], ["", " panel shown in 41 ms\n"],
    ["g", "✓ "], ["", "gateway ready on 127.0.0.1:3425\n"]
  ]
};
