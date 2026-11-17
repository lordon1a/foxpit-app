// The real terminal: one xterm.js instance, kept alive across tab switches
// and moved between the Session card and the Terminal tab.
import { Terminal } from "./vendor/xterm/xterm.mjs";
import { FitAddon } from "./vendor/xterm/addon-fit.mjs";

const host = document.createElement("div");
host.className = "xterm-host";

const term = new Terminal({
  fontFamily: '"JetBrains Mono","Cascadia Code",Consolas,monospace',
  fontSize: 12,
  lineHeight: 1.25,
  cursorBlink: true,
  cursorStyle: "bar",
  allowProposedApi: true,
  scrollback: 5000,
  theme: {
    background: "#08090a", foreground: "#c9cbd1", cursor: "#ff7a1a", cursorAccent: "#08090a",
    selectionBackground: "rgba(255,122,26,.28)",
    black: "#1c1d21", red: "#f2555a", green: "#3ecf8e", yellow: "#f5b13d", blue: "#6b8cff", magenta: "#c792ea", cyan: "#5fd3e0", white: "#d6d7db",
    brightBlack: "#5f626a", brightRed: "#ff7b7f", brightGreen: "#6fe0aa", brightYellow: "#ffc966", brightBlue: "#8fa6ff", brightMagenta: "#dcaaf5", brightCyan: "#8be6ef", brightWhite: "#ffffff",
  },
});
const fit = new FitAddon();
term.loadAddon(fit);
let opened = false, ws = null, alive = false, cwd = "";

function refit() {
  if (!opened || !host.isConnected || host.clientWidth < 20 || host.clientHeight < 20) return;
  try { fit.fit(); } catch { return; }
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: "resize", c: term.cols, r: term.rows }));
}
new ResizeObserver(() => requestAnimationFrame(refit)).observe(host);

async function connect() {
  let b;
  try {
    b = await fetch("/api/backend").then((r) => (r.ok ? r.json() : Promise.reject(r)));
  } catch {
    term.write("\x1b[33mThe terminal runs inside the Foxpit app.\x1b[0m\r\n");
    return;
  }
  const q = new URLSearchParams({ key: b.key, cwd, cols: term.cols, rows: term.rows });
  ws = new WebSocket(b.url.replace(/^http/, "ws") + "/term?" + q);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => { alive = true; refit(); };
  ws.onmessage = (e) => term.write(typeof e.data === "string" ? e.data : new Uint8Array(e.data));
  ws.onclose = (e) => {
    if (e.reason && e.code !== 1000) term.write("\r\n\x1b[31m" + e.reason + "\x1b[0m");
    if (alive) term.write("\r\n\x1b[90m[shell ended — press Enter to start a new one]\x1b[0m\r\n");
    alive = false;
    ws = null;
  };
}

term.onData((d) => {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: "in", d }));
  else if (!ws && d === "\r") { term.clear(); connect(); }
});

window.FoxTerm = {
  // put the terminal into parent (moving it out of wherever it was)
  mount(parent, dir) {
    if (dir && !cwd) cwd = dir;
    parent.append(host);
    if (!opened) { term.open(host); opened = true; requestAnimationFrame(() => { refit(); connect(); }); }
    else requestAnimationFrame(refit);
  },
  focus() { term.focus(); },
  // a new shell in another folder (the project changed)
  setDir(dir) {
    if (!dir || dir === cwd) return;
    cwd = dir;
    if (!opened) return;
    if (ws) { ws.onclose = null; ws.close(); ws = null; alive = false; }
    term.reset();
    connect();
  },
  // type into the shell as if from the keyboard
  send(text) { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: "in", d: text })); },
};
window.dispatchEvent(new Event("foxterm-ready"));
