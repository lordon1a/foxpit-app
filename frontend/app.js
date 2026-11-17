// Foxpit interface. Renders from FOXPIT_DATA; every text goes in through
// textContent, never as HTML.
(() => {
  "use strict";
  // a Mac: ⌘ for shortcuts (⌃ for M and W, which the Mac's own menu keeps
  // for minimise and close window), native window buttons
  const MAC = /Mac/i.test(navigator.platform || navigator.userAgent || "");
  if (MAC) document.documentElement.classList.add("mac");
  const mod = (e) => e.ctrlKey || (MAC && e.metaKey);
  const kb = (t) => !MAC ? t : String(t)
    .replace(/Ctrl\+Shift\+/g, "⌘⇧").replace(/Ctrl[+ ]([MW])\b/g, "⌃$1").replace(/Ctrl[+ ]/g, "⌘");
  const D = window.FOXPIT_DATA;
  // The chat area holds one or more panes, each its own chat. `cur` is the
  // pane being drawn or acted on (the active one, but while a loop draws
  // every pane); a pane's controls are found inside it by data-id.
  const panes = [{ chatId: D.chats[0].id, shownChat: null, shownCount: 0 }];
  let cur = 0, active = 0;
  const PANE_IDS = new Set(["chatTitle", "chatState", "acctChip", "modelChip", "msgs", "col", "composer", "input", "attach",
    "modelChip2", "effortChip", "modeChip", "wtChip", "paneSplit", "paneClose", "micBtn", "voiceBtn", "ctxChip"]);
  const paneEls = () => [...document.querySelectorAll("#panes > .pane")];
  const $ = (s) => {
    const m = /^#(\w+)(.*)$/.exec(s);
    if (m && PANE_IDS.has(m[1])) {
      const el = paneEls()[cur]?.querySelector('[data-id="' + m[1] + '"]');
      return m[2] ? el && el.querySelector(m[2].trim()) : el;
    }
    return document.querySelector(s);
  };
  const PN = () => panes[cur];
  // run fn with pane i as the current one
  function inPane(i, fn) { const was = cur; cur = i; try { return fn(); } finally { cur = was; } }
  // run fn in every pane showing chat c
  function withChat(c, fn) { panes.forEach((p, i) => { if (p.chatId === c.id) inPane(i, fn); }); }
  const state = { tab: "session", menu: null, menuQuery: "", menuIndex: 0 };
  Object.defineProperty(state, "chatId", { get: () => panes[cur].chatId, set: (v) => { panes[cur].chatId = v; } });

  // ---------- small DOM helpers ----------
  function h(tag, cls, ...kids) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    for (const k of kids) if (k != null && k !== false) e.append(k instanceof Node ? k : String(k));
    return e;
  }
  function icon(id, cls) {
    const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    if (cls) s.setAttribute("class", cls);
    const u = document.createElementNS("http://www.w3.org/2000/svg", "use");
    u.setAttribute("href", "#i-" + id);
    s.append(u);
    return s;
  }
  const MARK = { claude: "C", codex: "◎", oc: "O", gemini: "G", auto: "A" };
  function pv(provider, size) { return h("span", "pv " + provider + (size ? " " + size : ""), MARK[provider] || "?"); }
  // bars fill from where they last were (or from empty), so a change of
  // account or chat reads as the meter moving, not as a redraw
  const lastBar = new Map();
  function bar(pct, key) {
    const b = h("div", "bar"), i = h("i", pct == null ? "" : pct >= 85 ? "bad" : pct >= 60 ? "warn" : "ok");
    const to = (pct == null ? 0 : pct) + "%";
    i.style.width = key && lastBar.has(key) ? lastBar.get(key) : "0%";
    if (key) lastBar.set(key, to);
    requestAnimationFrame(() => requestAnimationFrame(() => { i.style.width = to; }));
    b.append(i);
    return b;
  }

  // ---------- lookups ----------
  // a chat saved on an account the gateway does not list (yet) still draws
  const acct = (id) => D.accounts.find((a) => a.id === id) || {
    id, provider: PROVIDER_OF(id), name: id || "No account", plan: "", who: "not connected", fiveHour: null, week: null, models: [],
  };
  function PROVIDER_OF(id) { return /^claude/.test(id) ? "claude" : /^codex/.test(id) ? "codex" : /^gemini/.test(id) ? "gemini" : id === "auto" ? "auto" : "oc"; }
  const modelOf = (accountId, modelId) => (acct(accountId)?.models || []).find((m) => m.id === modelId);
  const chat = () => D.chats.find((c) => c.id === state.chatId);
  const modelName = (accountId, modelId) => modelOf(accountId, modelId)?.name || modelId;

  // ---------- left rail ----------
  // The rail lists chats two ways: by project (each folder its own section)
  // or all of them by when they were last opened. Search filters either.
  const railPref = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch {} return null; };
  let railView = railPref("foxpit.railView") || "projects";
  let railQuery = "";
  const foldedProjects = new Set(JSON.parse(railPref("foxpit.railFolded") || "[]"));
  const seenAt = (c) => c.opened || c.updated || 0;
  function chatButton(c, showProject) {
    const b = h("button", "item" + (c.id === state.chatId ? " sel" : ""),
      c.state === "running" ? h("span", "spin") : h("span", "dot" + (c.state === "done" ? " ok" : "")),
      h("span", "t", c.title, showProject && c.cwd ? h("small", "", base(c.cwd)) : null), pv(acct(c.account).provider));
    b.type = "button";
    b.title = c.title + (c.cwd ? "\n" + c.cwd : "");
    b.onclick = () => openChat(c);
    b.dataset.chat = c.id;
    b.oncontextmenu = (e) => openChatMenu(c, e);
    if (c.pinned) b.classList.add("pinned");
    b.draggable = true;
    b.ondragstart = (e) => { e.dataTransfer.setData("text/foxpit-chat", c.id); e.dataTransfer.effectAllowed = "move"; document.body.classList.add("dragging-chat"); };
    b.ondragend = () => { document.body.classList.remove("dragging-chat"); clearDrop(); };
    if (panes.length > 1 && c.id !== state.chatId && panes.some((p) => p.chatId === c.id)) b.classList.add("open-else");
    return b;
  }
  // open a chat in the active pane, moving to its project when it has one
  function openChat(c) {
    closeMenu();
    document.querySelector(".app.compact")?.classList.remove("rail-on");
    c.opened = Date.now();
    const there = panes.findIndex((p) => p.chatId === c.id);
    if (there >= 0) { focusPane(there); renderChats(); save(); return; }
    if (SAVES && c.cwd && c.cwd !== D.projectPath) {
      if (!D.projects.some((p) => p.path === c.cwd)) D.projects.push({ path: c.cwd, name: base(c.cwd) });
      setProject(c.cwd);
    }
    state.chatId = c.id;
    render();
    save();
  }
  const matches = (c) => {
    if (!railQuery) return true;
    const q = railQuery.toLowerCase();
    if (c.title.toLowerCase().includes(q)) return true;
    return c.messages.some((m) => ((m.text || "") + (m.parts || []).map((p) => p.text || "").join(" ")).toLowerCase().includes(q));
  };
  // a chat shows once something was said in it, or while a pane has it
  const hangs = (c) => c.sub || (c.parentChat && D.chats.some((x) => x.id === c.parentChat));
  const listed = (c) => !hangs(c) && !c.archived && (c.messages.length || panes.some((p) => p.chatId === c.id)) && matches(c);
  function renderChats() {
    paneEls().forEach((el, k) => el.classList.toggle("focus", k === cur));
    const list = $("#chatList");
    list.replaceChildren();
    regroup();
    for (const b of document.querySelectorAll("#railView button")) b.classList.toggle("on", b.dataset.view === railView);
    const ink = $("#railView .rv-ink"), on = $("#railView button.on");
    if (ink && on) { ink.style.width = on.offsetWidth + "px"; ink.style.transform = "translateX(" + on.offsetLeft + "px)"; }
    if (!SAVES) {
      // the sample chats: one project, by day
      const groups = [];
      for (const c of D.chats.filter(matches)) {
        let g = groups.find((x) => x.name === c.group);
        if (!g) groups.push((g = { name: c.group, items: [] }));
        g.items.push(c);
      }
      for (const g of groups) { list.append(h("div", "sec", h("span", "", g.name))); for (const c of g.items) list.append(chatButton(c, false)); }
      return;
    }
    if (railView === "recent") {
      const all = D.chats.filter(listed).sort((x, y) => (runs.has(y.id) - runs.has(x.id)) || (!!y.pinned - !!x.pinned) || seenAt(y) - seenAt(x));
      const today = new Date().toDateString(), yest = new Date(Date.now() - 864e5).toDateString();
      let last = "";
      for (const c of all) {
        const d = new Date(seenAt(c)).toDateString();
        const g = runs.has(c.id) ? "Running" : d === today ? "Today" : d === yest ? "Yesterday" : "Earlier";
        if (g !== last) { list.append(h("div", "sec", h("span", "", g))); last = g; }
        list.append(chatButton(c, true));
        const sr = subRows(c); if (sr) list.append(sr);
      }
      if (!all.length) list.append(h("div", "rail-empty", railQuery ? "No chat matches." : "No chats yet."));
      archivedFoot(list);
      return;
    }
    // by project: the open one first, then the others as last used
    const projs = [...D.projects].sort((x, y) => (y.path === D.projectPath) - (x.path === D.projectPath));
    let any = false;
    for (const p of projs) {
      const mine = D.chats.filter((c) => (c.cwd || "") === p.path && listed(c)).sort((x, y) => (runs.has(y.id) - runs.has(x.id)) || (!!y.pinned - !!x.pinned) || seenAt(y) - seenAt(x));
      if (railQuery && !mine.length) continue;
      any = true;
      const curP = p.path === D.projectPath;
      const folded = foldedProjects.has(p.path) && !railQuery;
      const add = h("button", "ph-add", icon("plus"));
      add.type = "button"; add.title = "New chat in " + p.name;
      add.onclick = (e) => { e.stopPropagation(); if (!curP) setProject(p.path); state.chatId = latestChatEmpty().id; render(); save(); $("#input")?.focus(); };
      const head = h("button", "ph" + (curP ? " cur" : "") + (folded ? " folded" : ""), icon("chev", "ph-chev"), icon("folder", "ph-f"),
        h("span", "ph-n", p.name), h("span", "ph-c", mine.filter((c) => c.messages.length).length || ""), add);
      head.type = "button";
      head.title = p.path;
      head.onclick = () => {
        foldedProjects.has(p.path) ? foldedProjects.delete(p.path) : foldedProjects.add(p.path);
        railPref("foxpit.railFolded", JSON.stringify([...foldedProjects]));
        renderChats();
      };
      list.append(head);
      if (folded) continue;
      const box = h("div", "pg");
      for (const c of mine) { box.append(chatButton(c, false)); const sr = subRows(c); if (sr) box.append(sr); }
      if (!mine.length) box.append(h("div", "rail-empty", "No chats yet"));
      list.append(box);
    }
    if (!any) list.append(h("div", "rail-empty", railQuery ? "No chat matches." : "Open a folder to start."));
    archivedFoot(list);
  }
  // an empty chat in the current project (reused if there is one)
  function latestChatEmpty() {
    const e = D.chats.find((c) => !c.sub && inProject(c) && !c.messages.length && !panes.some((p, i) => i !== cur && p.chatId === c.id));
    if (e) return e;
    const n = freshChat(chat());
    n.cwd = D.projectPath;
    D.chats.unshift(n);
    return n;
  }

  // the rail's foot: agents, account, a new chat, and a row of tools
  function renderAccountCard() {
    const c = chat(), a = acct(c.account);
    const running = D.chats.filter((x) => runs.has(x.id)).length;
    $("#agentsCount").textContent = running ? running + " running" : "none running";
    $("#agentsBtn").classList.toggle("live", running > 0);
    $("#setBtn").classList.toggle("on", !!setv.open);
    const n = alerts.filter((x) => !x.seen).length;
    $("#alertCount").hidden = !n;
    $("#alertCount").textContent = n;
    for (const b of document.querySelectorAll("#dock .ib")) {
      const k = b.dataset.dock;
      b.classList.toggle("on", (k === "terminal" && state.tab === "terminal" && !app.classList.contains("side-off")) ||
        (k === "changes" && state.tab === "changes" && !app.classList.contains("side-off")) ||
        (k === "panel" && !app.classList.contains("side-off")) || (k === "magpie" && mpv.open) || (k === "alerts" && state.menu === "alerts") || (k === "projects" && state.menu === "project"));
    }
  }

  // ---------- notifications: runs that finished while you looked away ----------
  const alerts = [];
  function notify(c, m) {
    const seen = document.hasFocus() && panes.some((p) => p.chatId === c.id);
    alerts.unshift({ id: c.id, title: c.title, ok: !m.error && !m.stopped, why: m.error ? "failed" : m.stopped ? "stopped" : "finished", at: Date.now(), seen });
    alerts.length = Math.min(alerts.length, 30);
    if (S().sound && !m.stopped && (!S().bgOnly || !document.hasFocus())) chime(!m.error);
    renderAccountCard();
  }
  function renderAlertsMenu() {
    const m = $("#menu"), list = h("div", "list");
    m.replaceChildren(h("div", "mh", icon("bell"), h("span", "mh-t", "Notifications"), h("kbd", "", String(alerts.length))), list);
    if (!alerts.length) list.append(h("div", "empty", "Nothing yet. Finished and failed runs show here."));
    for (const x of alerts) {
      const c = D.chats.find((y) => y.id === x.id);
      const b = h("button", "opt tall" + (x.seen ? "" : " unseen"), x.ok ? icon("check", "pi ok-i") : icon("x", "pi bad-i"),
        h("span", "two", h("span", "n", x.title), h("span", "sub-l", x.why + " · " + clock.call(null, x.at) + (c && c.cwd ? " · " + base(c.cwd) : ""))), h("span", "note", ""), h("span", "end", ""));
      b.type = "button";
      b.onclick = () => { closeMenu(); if (c) openChat(c); };
      list.append(b);
    }
    for (const x of alerts) x.seen = true;
    setTimeout(renderAccountCard, 0);
  }

  // ---------- chat ----------
  function renderHeader() {
    const c = chat(), a = acct(c.account);
    renderCtxChip();
    renderCrumb();
    $("#chatTitle").textContent = c.title;
    const st = $("#chatState");
    st.className = "badge" + (c.state === "running" ? " ok" : "");
    st.textContent = c.state === "running" ? "● running" : c.state === "done" ? "done" : "idle";
    $("#acctChip").replaceChildren(pv(a.provider, "sm"), a.name, icon("chev", "chev"));
    $("#modelChip").replaceChildren(modelName(c.account, c.model), h("span", "dim", "· " + c.effort), icon("chev", "chev"));
    $("#modelChip2").replaceChildren(pv(a.provider, "sm"), modelName(c.account, c.model), icon("chev", "chev"));
    $("#effortChip").replaceChildren(icon("bolt"), c.effort);
    const md = modeOf(c), mc = $("#modeChip");
    mc.replaceChildren(icon("shield"), md.name);
    mc.className = "chip mode-" + md.id;
    mc.title = "Permissions: " + md.note;
    const wt = $("#wtChip");
    wt.className = "chip chip-quiet wt";
    wt.title = D.projectPath || "";
    wt.replaceChildren(icon("folder"), D.projectPath ? D.project : "No folder");
    wt.parentElement.querySelector(".copy-chip")?.remove();
    const cp = SAVES ? copyChip(c) : null;
    if (cp) wt.after(cp);
  }

  function msgNode(m) {
    if (m.role === "user") {
      if (editing === m) return editNode(m);
      const vids = m.videos || [];
      const bubble = (!m.images || !m.images.length) && !vids.length ? h("div", "u", m.text)
        : h("div", "u has-img", vids.length ? h("div", "imgs u-imgs", ...vids.map(clipNode)) : null,
          m.images && m.images.length ? imgGrid(m.images, "imgs u-imgs", m.full) : null, m.text ? h("div", "", m.text) : null);
      const c = D.chats.find((x) => x.messages.includes(m));
      const acts = h("div", "m-acts");
      if (c && !runs.has(c.id) && canRewind(c, c.messages.indexOf(m))) acts.append(actBtn("edit", "Edit and send again", () => { editing = m; withChat(c, renderMessages); }));
      if (m.text) acts.append(actBtn("copy", "Copy", (b) => copyText(m.text).then(() => copied(b))));
      return h("div", "u-wrap", bubble, acts);
    }
    if (m.role === "note") return h("div", "divider note", h("span", "pill", icon("check"), m.text));
    if (m.role === "switch") {
      const a = acct(m.account);
      const why = m.reason === "limit" ? " — previous account hit its limit" : "";
      return h("div", "divider", h("span", "pill", icon("swap"), "Switched to ", h("b", "", modelName(m.account, m.model)),
        " · " + a.name + why + " · context carried" + (m.tokens ? ", " + m.tokens + " tokens" : "")));
    }
    if (m.role === "typing") {
      const a = acct(m.account);
      return h("div", "as", pv(a.provider, "lg"), h("div", "txt",
        h("div", "meta", h("b", "", modelName(m.account, m.model)), h("span", "", a.name)),
        h("span", "typing", h("i"), h("i"), h("i"))));
    }
    const a = acct(m.account);
    if (m.parts) return liveNode(m, a);
    const txt = h("div", "txt", h("div", "meta", h("b", "", modelName(m.account, m.model)), h("span", "", a.name), m.when ? h("span", "", "· " + m.when) : null), m.text);
    if (m.tool) {
      const t = m.tool;
      const diff = h("div", "diffl");
      for (const l of t.lines) diff.append(h("div", l.startsWith("+") ? "p" : l.startsWith("-") ? "m" : "", l));
      txt.append(h("div", "tool",
        h("div", "h", icon("term"), h("b", "", t.name), h("span", "mono", t.path),
          h("span", "r", h("span", "p", "+" + t.add), " ", h("span", "m", "−" + t.del))), diff));
    }
    return h("div", "as", pv(a.provider, "lg"), txt);
  }

  // ---------- a real answer: text and tool calls in the order they came ----------
  // light markdown: ``` blocks, `code` and **bold**; everything as text nodes
  // ---------- replies as markdown: headings, lists, tables, quotes, code ----------
  function mdLink(text, href) {
    const a = h("a", "md-a", text);
    a.href = href;
    a.title = href;
    a.onclick = (e) => { e.preventDefault(); e.stopPropagation(); if (/^https?:\/\//i.test(href)) post("/api/open", { url: href }); else copyText(href).then(() => flash("Copied: " + href)); };
    return a;
  }
  const INLINE_RE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|!\[[^\]\n]*\]\([^)\s]+\)|\[[^\]\n]+\]\([^)\s]+\)|https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]|\*[^*\n]+\*|(?<![\w])_[^_\n]+_(?![\w]))/;
  function inline(text, pics) {
    const out = [];
    for (const bit of String(text).split(INLINE_RE)) {
      if (!bit) continue;
      let m;
      if ((m = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(bit))) {
        const src = imageSrc(m[2]);
        if (src && pics) { pics.push([src, m[1], VIDEO_RE.test(m[2].split("?")[0])]); continue; }
        out.push(bit);
      } else if (bit.length > 2 && bit[0] === "`" && bit.endsWith("`")) out.push(h("code", "ic", bit.slice(1, -1)));
      else if (bit.length > 4 && (bit.startsWith("**") && bit.endsWith("**") || bit.startsWith("__") && bit.endsWith("__"))) out.push(h("b", "", ...inline(bit.slice(2, -2))));
      else if (bit.length > 4 && bit.startsWith("~~") && bit.endsWith("~~")) out.push(h("s", "", ...inline(bit.slice(2, -2))));
      else if ((m = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(bit))) out.push(mdLink(m[1], m[2]));
      else if (/^https?:\/\//.test(bit)) out.push(mdLink(bit, bit));
      else if (bit.length > 2 && (bit[0] === "*" && bit.endsWith("*") || bit[0] === "_" && bit.endsWith("_"))) out.push(h("i", "", ...inline(bit.slice(1, -1))));
      else out.push(bit);
    }
    return out;
  }
  function codeBlock(lang, body) {
    const copy = h("button", "cp", icon("copy"));
    copy.type = "button";
    copy.title = "Copy";
    copy.onclick = (e) => { e.stopPropagation(); copyText(body).then(() => { copy.classList.add("done"); copy.replaceChildren(icon("check")); setTimeout(() => { copy.classList.remove("done"); copy.replaceChildren(icon("copy")); }, 1300); }); };
    return h("div", "code-w", h("div", "code-h", h("span", "lang", lang || "text"), copy), h("pre", "code", h("code", "", body)));
  }
  const LIST_RE = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
  function listNode(items, at) {
    // items: [{ind, ord, text}] from at, one level; deeper ones nest
    const base = items[at].ind, ordered = /\d/.test(items[at].ord);
    const list = h(ordered ? "ol" : "ul", "md-l");
    if (ordered) { const n = parseInt(items[at].ord, 10); if (n > 1) list.start = n; }
    let i = at;
    while (i < items.length && items[i].ind >= base) {
      if (items[i].ind > base) { const [sub, next] = listNode(items, i); list.lastChild ? list.lastChild.append(sub) : list.append(sub); i = next; continue; }
      if (/\d/.test(items[i].ord) !== ordered) break;
      let t = items[i].text, box = null;
      const task = /^\[([ xX])\]\s+(.*)$/.exec(t);
      if (task) { box = h("span", "md-task" + (task[1] !== " " ? " on" : ""), task[1] !== " " ? icon("check") : null); t = task[2]; }
      const li = h("li", task ? "has-task" : "", box, ...inline(t));
      list.append(li);
      i++;
    }
    return [list, i];
  }
  function tableNode(rows) {
    const cells = (l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    const head = cells(rows[0]), align = cells(rows[1]).map((c) => (/^:-+:$/.test(c) ? "center" : /-+:$/.test(c) ? "right" : ""));
    const t = h("table", "md-t");
    const tr = h("tr", "");
    head.forEach((c, i) => { const th = h("th", "", ...inline(c)); if (align[i]) th.style.textAlign = align[i]; tr.append(th); });
    t.append(h("thead", "", tr));
    const tb = h("tbody", "");
    for (const r of rows.slice(2)) {
      const row = h("tr", "");
      cells(r).forEach((c, i) => { const td = h("td", "", ...inline(c)); if (align[i]) td.style.textAlign = align[i]; row.append(td); });
      tb.append(row);
    }
    t.append(tb);
    return h("div", "md-tw", t);
  }
  function richText(s) {
    const box = h("div", "rich");
    const lines = String(s || "").replace(/\r\n?/g, "\n").split("\n");
    let para = [];
    const flush = () => {
      const text = para.join("\n").replace(/\s+$/, "");
      para = [];
      if (!text.trim()) return;
      const pics = [], p = h("p", "", ...inline(text, pics));
      if (p.childNodes.length) box.append(p);
      for (const [src, alt, vid] of pics) {
        if (vid) { const v = h("video", "md-vid"); v.controls = true; v.preload = "metadata"; v.src = src; v.title = alt; box.append(v); continue; }
        const g = imgGrid([src], "imgs md-img"); g.firstChild.alt = alt; box.append(g);
      }
    };
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      let m;
      if ((m = /^\s*(```+|~~~+)\s*([\w+#.-]{0,20})\s*$/.exec(l))) {
        flush();
        const fence = m[1], body = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(fence)) body.push(lines[i++]);
        box.append(codeBlock(m[2], body.join("\n")));
        continue;
      }
      if (!l.trim()) { flush(); continue; }
      if ((m = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l))) { flush(); box.append(h("div", "md-h md-h" + m[1].length, ...inline(m[2]))); continue; }
      if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(l)) { flush(); box.append(h("hr", "md-hr")); continue; }
      if (l.includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
        flush();
        const rows = [l, lines[i + 1]];
        i += 2;
        while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(lines[i++]);
        i--;
        box.append(tableNode(rows));
        continue;
      }
      if (/^\s{0,3}>/.test(l)) {
        flush();
        const q = [];
        while (i < lines.length && /^\s{0,3}>/.test(lines[i])) q.push(lines[i++].replace(/^\s{0,3}>\s?/, ""));
        i--;
        const bq = h("blockquote", "md-q");
        bq.append(...richText(q.join("\n")).childNodes);
        box.append(bq);
        continue;
      }
      if (LIST_RE.test(l) && !(para.length && /^\s*\d/.test(l) && !LIST_RE.test(para[para.length - 1]) && false)) {
        flush();
        const items = [];
        while (i < lines.length) {
          const x = LIST_RE.exec(lines[i]);
          if (x) { items.push({ ind: x[1].replace(/\t/g, "  ").length, ord: x[2], text: x[3] }); i++; continue; }
          // a wrapped line belongs to the item above
          if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) { items[items.length - 1].text += " " + lines[i].trim(); i++; continue; }
          break;
        }
        i--;
        let at = 0;
        while (at < items.length) { const [node, next] = listNode(items, at); box.append(node); at = next > at ? next : at + 1; }
        continue;
      }
      para.push(l);
    }
    flush();
    return box;
  }
  const base = (p) => String(p || "").replace(/^.*[\\/]/, "");
  function toolSummary(t) {
    const i = t.input || {};
    switch (t.name) {
      case "Bash": case "PowerShell": return [i.description || "", i.command || ""];
      case "Read": case "Write": case "Edit": case "MultiEdit": case "NotebookEdit": return [base(i.file_path || i.notebook_path), i.file_path || ""];
      case "Grep": return ["“" + (i.pattern || "") + "”", i.path || i.glob || ""];
      case "Glob": return [i.pattern || "", i.path || ""];
      case "WebFetch": return [i.url || "", ""];
      case "WebSearch": return [i.query || "", ""];
      case "TodoWrite": return [((i.todos || []).length) + " tasks", ""];
      case "Task": case "Agent": return [i.description || "", ""];
      default: return [Object.values(i).find((v) => typeof v === "string" && v.length < 120) || "", ""];
    }
  }
  function toolDiff(t) {
    const i = t.input || {};
    const lines = [];
    const add = (s, sign) => { for (const l of String(s).split("\n")) lines.push(sign + l); };
    if (t.name === "Edit") { add(i.old_string || "", "-"); add(i.new_string || "", "+"); }
    else if (t.name === "MultiEdit") for (const e of i.edits || []) { add(e.old_string || "", "-"); add(e.new_string || "", "+"); }
    else if (t.name === "Write") add(i.content || "", "+");
    return lines;
  }
  const openTools = new Set();
  const shutTools = new Set();
  // Foxpit's browser tools read as what they did
  const BR_VERB = { navigate: "Go to", snapshot: "Read the page", click: "Click", type: "Type", press: "Press", scroll: "Scroll",
    screenshot: "Look at the page", console: "Read the console", eval: "Run in the page", resize: "Show at" };
  function brToolWhat(t) {
    const k = t.name.slice("mcp__foxpit__browser_".length), i = t.input || {};
    const arg = k === "click" ? (i.text ? "“" + i.text + "”" : i.ref ? "[" + i.ref + "]" : "") : k === "type" ? "“" + (i.text || "") + "”" + (i.submit ? " ⏎" : "")
      : k === "navigate" ? i.url || "" : k === "press" ? i.key || "" : k === "scroll" ? (i.dy > 0 ? "down " : "up ") + Math.abs(i.dy || 0) + "px"
      : k === "resize" ? i.device || (i.width ? i.width + "×" + i.height : "") : k === "eval" ? String(i.expression || "").slice(0, 60) : "";
    return ((BR_VERB[k] || k) + " " + arg).trim();
  }
  function toolCard(t) {
    if (t.name && t.name.startsWith("mcp__foxpit__browser_")) t = Object.assign({}, t, { name: "Browser", input: Object.assign({}, t.input, { description: brToolWhat(t) }), _br: true });
    const [what, detail] = t._br ? [t.input.description, ""] : toolSummary(t);
    const diff = toolDiff(t);
    const st = t.ok == null ? h("span", "spin sm") : t.ok ? icon("check", "ok-i") : icon("x", "bad-i");
    const plus = diff.filter((l) => l[0] === "+").length, minus = diff.filter((l) => l[0] === "-").length;
    const head = h("button", "h", st, h("b", "", t.name), h("span", "what", what),
      diff.length ? h("span", "r", h("span", "p", "+" + plus), " ", h("span", "m", "−" + minus)) : null, icon("chev", "chev"));
    head.type = "button";
    const isOpen = openTools.has(t.id) || (S().expandTools && !shutTools.has(t.id));
    const card = h("div", "tool live" + (isOpen ? " open" : "") + (t.ok === false ? " failed" : "") + (t.kids && t.kids.length ? " has-kids" : ""), head);
    if (t.kids && t.kids.length) {
      const shown = isOpen ? t.kids : t.kids.slice(-3);
      const kl = h("div", "kids");
      if (shown.length < t.kids.length) kl.append(h("div", "kid more", (t.kids.length - shown.length) + " earlier steps"));
      for (const k of shown) {
        const [kw] = toolSummary(k);
        kl.append(h("div", "kid" + (k.ok === false ? " bad" : ""), k.ok == null ? h("span", "spin sm") : icon(k.ok ? "check" : "x"), h("b", "", k.name), h("span", "kw", kw || "")));
      }
      card.append(kl);
    }
    const body = h("div", "tb");
    if (detail && detail !== what) body.append(h("div", "cmd mono", detail));
    if (diff.length) {
      const d = h("div", "diffl");
      for (const l of diff.slice(0, 80)) d.append(h("div", l[0] === "+" ? "p" : l[0] === "-" ? "m" : "", l));
      if (diff.length > 80) d.append(h("div", "dim", "… " + (diff.length - 80) + " more lines"));
      body.append(d);
    }
    if (t.out) body.append(h("pre", "out", t.out));
    if (t.images && t.images.length) card.append(imgGrid(t.images, "imgs t-imgs", t.full));
    card.append(body);
    head.onclick = () => {
      card.classList.toggle("open");
      if (card.classList.contains("open")) { openTools.add(t.id); shutTools.delete(t.id); } else { openTools.delete(t.id); shutTools.add(t.id); }
    };
    return card;
  }
  // ---------- sub-agents: a Task/Agent call as its own card, live ----------
  const isAgentTool = (p) => p && p.k === "tool" && (p.name === "Task" || p.name === "Agent");
  const openKids = new Set();
  function agentKind(t) {
    const ty = (t.agent && t.agent.agentType) || (t.input || {}).subagent_type || "";
    if (!ty || ty === "general-purpose") return "Agent";
    return ty.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }
  function prettyModel(id) {
    const m = String(id || "").match(/(opus|sonnet|haiku|fable)-(\d+)-(\d+)/i);
    if (m) return m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() + " " + m[2] + "." + m[3];
    return id ? String(id).split("/").pop() : "";
  }
  function took(ms) {
    if (!ms || ms < 0) return "0s";
    const s = Math.round(ms / 1000);
    return s < 60 ? s + "s" : Math.floor(s / 60) + "m " + String(s % 60).padStart(2, "0") + "s";
  }
  function agentHue(t) {
    const k = agentKind(t);
    let n = 0;
    for (const ch of k) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
    return [24, 210, 152, 268, 330, 44, 188][n % 7];
  }
  function kidRow(k, open) {
    const fresh = k.at && Date.now() - k.at < 350 ? " fresh" : "";
    if (k.k === "say") return h("div", "ak note" + fresh, h("span", "dot"), h("span", "kw", k.text));
    const [kw, detail] = toolSummary(k);
    const st = k.ok == null ? h("span", "spin sm") : icon(k.ok ? "check" : "x", k.ok ? "ok-i" : "bad-i");
    const row = h("button", "ak" + fresh + (k.ok === false ? " bad" : "") + (k.ok == null ? " now" : ""), st, h("b", "", k.name), h("span", "kw", kw || ""));
    row.type = "button";
    if (!open) { row.tabIndex = -1; return row; }
    const wrap = h("div", "ak-w" + (openKids.has(k.id) ? " open" : ""), row);
    if (openKids.has(k.id)) {
      const body = h("div", "ak-b");
      if (detail && detail !== kw) body.append(h("div", "cmd mono", detail));
      body.append(h("pre", "out", k.ok == null ? "Running…" : (k.out || "No output")));
      wrap.append(body);
    }
    row.onclick = (e) => { e.stopPropagation(); if (openKids.has(k.id)) openKids.delete(k.id); else openKids.add(k.id); wrap.replaceWith(kidRow(k, true)); };
    return wrap;
  }
  function agentCard(t) {
    const i = t.input || {};
    const running = t.ok == null;
    const kids = t.kids || [];
    const steps = kids.filter((k) => k.k !== "say").length;
    const ms = (t.agent && t.agent.totalDurationMs) || (t.t0 ? (t.t1 || Date.now()) - t.t0 : 0);
    const isOpen = openTools.has(t.id);
    const bg = t.agent && t.agent.status && t.agent.status !== "completed" && /async|background/i.test(t.agent.status);
    const state = running ? "Running" : t.ok === false ? "Failed" : bg ? "In the background" : "Done";
    const mark = h("span", "ag-mark" + (running ? " live" : ""), icon("spark"));
    mark.style.setProperty("--hue", agentHue(t));
    const sub = [state, steps ? steps + (steps === 1 ? " step" : " steps") : null, t.t0 || (t.agent && t.agent.totalDurationMs) ? took(ms) : null].filter(Boolean).join(" · ");
    const openIt = h("span", "ag-open", "Open", icon("chev", "r"));
    openIt.title = "Open this sub-agent as its own chat";
    openIt.onclick = (e) => {
      e.stopPropagation();
      const pc = D.chats.find((x) => x.messages.some((mm) => (mm.parts || []).includes(t)));
      if (pc) { const sc = ensureSub(pc, t); renderChats(); openChat(sc); }
    };
    const head = h("button", "ag-h", mark, h("div", "ag-t", h("div", "l1", h("b", "", agentKind(t)), h("span", "what", i.description || "")), h("div", "l2", h("span", "st " + state.split(" ")[0].toLowerCase(), sub))), openIt, icon("chev", "chev"));
    head.type = "button";
    const card = h("div", "subag" + (isOpen ? " open" : "") + (running ? " running" : "") + (t.ok === false ? " failed" : ""), head);
    if (!isOpen) {
      // closed: the last few steps while it works; its report's first line once done
      if (running && kids.length) {
        const kl = h("div", "ag-steps peek");
        if (kids.length > 3) kl.append(h("div", "ak more", (kids.length - 3) + " earlier"));
        for (const k of kids.slice(-3)) kl.append(kidRow(k, false));
        card.append(kl);
      } else if (running) card.append(h("div", "ag-steps peek", h("div", "ak note", h("span", "dot"), h("span", "kw", "Getting started…"))));
      else if (t.out) {
        const first = String(t.out).replace(/[#*`>_]/g, "").split("\n").map((x) => x.trim()).find(Boolean) || "";
        if (first) card.append(h("div", "ag-sum", first));
      }
    } else {
      const body = h("div", "ag-b");
      if (i.prompt) {
        const pr = h("div", "ag-sec", h("div", "ag-lbl", "Task it was given"));
        const txt = h("div", "ag-prompt" + (t.promptOpen ? " full" : ""), String(i.prompt));
        pr.append(txt);
        if (String(i.prompt).length > 280 || String(i.prompt).split("\n").length > 4) {
          const more = h("button", "ag-more", t.promptOpen ? "Show less" : "Show all");
          more.type = "button";
          more.onclick = (e) => { e.stopPropagation(); t.promptOpen = !t.promptOpen; card.replaceWith(agentCard(t)); };
          pr.append(more);
        }
        body.append(pr);
      }
      if (kids.length) {
        const kl = h("div", "ag-steps");
        for (const k of kids) kl.append(kidRow(k, true));
        body.append(h("div", "ag-sec", h("div", "ag-lbl", "Steps · " + steps), kl));
      }
      if (t.out && !running) {
        const cp = actBtn("copy", "Copy the report", (b) => copyText(String(t.out)).then(() => copied(b)));
        body.append(h("div", "ag-sec", h("div", "ag-lbl", t.ok === false ? "What went wrong" : "Report", cp), h("div", "ag-rep", richText(String(t.out)))));
      }
      const a = t.agent || {};
      const facts = [prettyModel(a.resolvedModel), a.totalTokens ? fmtTok(a.totalTokens) + " tokens" : "", a.totalToolUseCount ? a.totalToolUseCount + " tool uses" : "", ms ? took(ms) : ""].filter(Boolean);
      if (facts.length && !running) body.append(h("div", "ag-foot", facts.join(" · ")));
      card.append(body);
    }
    head.onclick = () => {
      if (openTools.has(t.id)) openTools.delete(t.id); else openTools.add(t.id);
      card.replaceWith(agentCard(t));
    };
    return card;
  }
  // several sub-agents sent out together read as one group
  function agentGroup(list) {
    const run = list.filter((t) => t.ok == null).length;
    const g = h("div", "ag-group", h("div", "ag-gh", h("span", "n", String(list.length)), h("span", "", "agents" + (run ? " · " + run + " working" : " · all done"))));
    for (const t of list) g.append(agentCard(t));
    return g;
  }
  // ---------- sub-agents as chats of their own ----------
  // A sub-agent (Task/Agent call) is listed under its chat in the rail and
  // opens in a pane like any chat. Its messages are drawn from the parent's
  // record of it, live: nothing is stored twice.
  const subId = (t) => "sub-" + t.id;
  function parentOf(sc) {
    const p = D.chats.find((x) => x.id === sc.sub.of);
    if (!p) return {};
    for (const m of p.messages) for (const part of m.parts || []) if (part.k === "tool" && part.id === sc.sub.tool) return { chat: p, m, t: part };
    return { chat: p };
  }
  function subMessages(sc) {
    const { chat: p, m, t } = parentOf(sc);
    if (!t) return [{ role: "assistant", account: sc.account, model: sc.model, when: "", parts: [{ k: "text", text: p ? "This sub-agent's record is gone from its chat." : "Its chat was deleted." }] }];
    const i = t.input || {};
    const parts = [];
    for (const k of t.kids || []) {
      if (k.k === "say") { const last = parts[parts.length - 1]; if (last && last.k === "text") last.text += "\n\n" + k.text; else parts.push({ k: "text", text: k.text }); }
      else parts.push({ k: "tool", id: k.id, name: k.name, input: k.input || {}, ok: k.ok, out: k.out });
    }
    const running = t.ok == null && runs.has(p.id);
    if (t.out && t.ok != null) parts.push({ k: "text", text: String(t.out) });
    const a = t.agent || {};
    return [
      { role: "user", text: i.prompt || i.description || "" },
      { role: "assistant", account: p.account, model: a.resolvedModel ? "claude/" + a.resolvedModel : (m && m.model) || p.model, who: agentKind(t), when: m && m.when, parts, running,
        ms: a.totalDurationMs || (t.t0 && t.t1 ? t.t1 - t.t0 : 0), error: t.ok === false && !t.out ? "The sub-agent failed." : undefined, wait: running ? "Working…" : "" },
    ];
  }
  function ensureSub(c, t) {
    let sc = D.chats.find((x) => x.id === subId(t));
    if (!sc) {
      sc = { id: subId(t), title: (t.input && t.input.description) || agentKind(t), state: "running", sub: { of: c.id, tool: t.id },
        account: c.account, model: c.model, effort: c.effort, cwd: c.cwd, messages: [], updated: Date.now() };
      D.chats.push(sc);
      subDirty.add("rail");
    }
    return sc;
  }
  const subDirty = new Set();
  // after a parent's event: its sub-agents follow, drawn once a frame
  function syncSubs(c, m) {
    for (const t of m.parts) {
      if (!isAgentTool(t)) continue;
      const sc = ensureSub(c, t);
      const st = t.ok == null && runs.has(c.id) ? "running" : "done";
      if (sc.state !== st) { sc.state = st; subDirty.add("rail"); }
      sc.updated = Date.now();
      subDirty.add(sc.id);
    }
    if (subDirty.size && !subDirty.has("frame")) {
      subDirty.add("frame");
      requestAnimationFrame(() => {
        const rail = subDirty.has("rail");
        for (const id of subDirty) {
          const sc = D.chats.find((x) => x.id === id);
          if (sc && panes.some((p) => p.chatId === id)) withChat(sc, () => { renderHeader(); renderMessages(); });
        }
        subDirty.clear();
        if (rail) renderChats();
      });
    }
  }
  function subRows(c) {
    const kids = D.chats.filter((x) => (x.sub && x.sub.of === c.id) || x.parentChat === c.id);
    if (!kids.length) return null;
    const box = h("div", "subs");
    const shown = kids.slice(-8);
    if (kids.length > shown.length) box.append(h("div", "sub-more", "+" + (kids.length - shown.length) + " earlier sub-agents"));
    for (const sc of shown) {
      const b = h("button", "item sub" + (sc.id === state.chatId ? " sel" : ""), h("span", "tree"),
        sc.state === "running" ? h("span", "spin") : h("span", "dot ok"), h("span", "t", sc.title));
      b.type = "button";
      b.title = sc.title + (sc.parentChat ? "\nA chat “" + c.title + "” started" : "\nA sub-agent of “" + c.title + "”");
      b.onclick = () => openChat(sc);
      b.dataset.chat = sc.id;
      b.oncontextmenu = (e) => openChatMenu(sc, e);
      if (panes.length > 1 && sc.id !== state.chatId && panes.some((p) => p.chatId === sc.id)) b.classList.add("open-else");
      box.append(b);
    }
    return box;
  }
  // the bar a sub-agent's pane shows where the composer was
  function subBar(sc) {
    const { chat: p } = parentOf(sc);
    const back = h("button", "mp-btn", icon("chev", "l"), p ? "Back to “" + p.title + "”" : "Back");
    back.type = "button";
    back.onclick = (e) => { e.stopPropagation(); if (p) openChat(p); };
    return h("div", "sub-bar", h("span", "ag-mark sm" + (sc.state === "running" ? " live" : ""), icon("spark")),
      h("span", "dim", sc.state === "running" ? "A sub-agent at work. Its chat steers it: write there." : "A sub-agent's run. Write in its chat to go on."), back);
  }
  // ---------- a chat's own menu (right click in the rail) ----------
  // Rename, pin, copy, archive, delete. Archived chats leave the list and wait
  // under "Archived" at its foot; deleting one takes its sub-agents with it.
  let chatMenuEl = null;
  function closeChatMenu() { if (chatMenuEl) { chatMenuEl.remove(); chatMenuEl = null; } }
  document.addEventListener("pointerdown", (e) => { if (chatMenuEl && !chatMenuEl.contains(e.target)) closeChatMenu(); }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && chatMenuEl) { e.stopPropagation(); closeChatMenu(); } }, true);
  window.addEventListener("blur", closeChatMenu);
  window.addEventListener("resize", closeChatMenu);
  // the page's own menu everywhere but where text is typed or picked
  document.addEventListener("contextmenu", (e) => {
    const t = e.target;
    if (t.closest && t.closest("input, textarea, [contenteditable=true], .xterm")) return;
    if (String(window.getSelection() || "").trim()) return;
    e.preventDefault();
  });
  function ctxItem(ic, label, fn, cls) {
    const b = h("button", "cx-i" + (cls ? " " + cls : ""), icon(ic), h("span", "", label));
    b.type = "button";
    b.onclick = (e) => { e.stopPropagation(); fn(b); };
    return b;
  }
  function openChatMenu(c, e) {
    e.preventDefault();
    closeChatMenu(); closeMenu();
    const running = runs.has(c.id);
    const items = [];
    items.push(ctxItem("edit", "Rename", () => { closeChatMenu(); renameInRail(c); }));
    if (!c.archived) items.push(ctxItem("bolt", c.pinned ? "Unpin" : "Pin to top", () => { c.pinned = !c.pinned; closeChatMenu(); renderChats(); save(); }));
    items.push(ctxItem("split", "Open beside", () => { closeChatMenu(); openBeside(c); }));
    items.push(ctxItem("copy", "Copy as Markdown", () => { closeChatMenu(); copyText(chatMarkdown(c)).then((ok) => flash(ok ? "Chat copied as Markdown" : "Could not copy")); }));
    items.push(h("div", "cx-sep"));
    if (c.archived) items.push(ctxItem("retry", "Unarchive", () => { c.archived = false; c.updated = Date.now(); closeChatMenu(); renderChats(); save(); }));
    else items.push(ctxItem("layers", running ? "Archive (stop it first)" : "Archive", () => { if (running) return; closeChatMenu(); archiveChat(c); }, running ? "off" : ""));
    items.push(ctxItem("trash", "Delete", (b) => {
      if (running) { flash("Stop the reply first, then delete the chat."); return; }
      if (b.dataset.sure) { closeChatMenu(); deleteChat(c); return; }
      b.dataset.sure = "1"; b.classList.add("sure");
      b.querySelector("span").textContent = "Click again to delete for good";
    }, "danger"));
    chatMenuEl = h("div", "cx-menu", h("div", "cx-h", c.title), ...items);
    document.body.append(chatMenuEl);
    const W = chatMenuEl.offsetWidth, H = chatMenuEl.offsetHeight;
    chatMenuEl.style.left = Math.max(6, Math.min(e.clientX, innerWidth - W - 6)) + "px";
    chatMenuEl.style.top = Math.max(6, Math.min(e.clientY, innerHeight - H - 6)) + "px";
  }
  function renameInRail(c) {
    const row = document.querySelector('#chatList [data-chat="' + CSS.escape(c.id) + '"]');
    const t = row && row.querySelector(".t");
    if (!t) { const v = prompt("Rename chat", c.title); if (v && v.trim()) { c.title = v.trim().slice(0, 80); renderChats(); withChat(c, renderHeader); save(); } return; }
    const inp = h("input", "rn-in");
    inp.value = c.title;
    t.replaceChildren(inp);
    inp.focus(); inp.select();
    let done = false;
    const finish = (ok) => {
      if (done) return; done = true;
      if (ok && inp.value.trim()) c.title = inp.value.trim().slice(0, 80);
      renderChats(); withChat(c, renderHeader); save();
    };
    inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); };
    inp.onclick = (e) => e.stopPropagation();
    inp.onblur = () => finish(true);
  }
  // a pane that showed a chat which is gone: closed, or given an empty chat
  function letGo(id) {
    for (let i = panes.length - 1; i >= 0; i--) {
      if (panes[i].chatId !== id) continue;
      if (panes.length > 1) closePane(i);
      else { state.chatId = latestChatEmpty().id; }
    }
  }
  function archiveChat(c) {
    c.archived = true; c.pinned = false;
    letGo(c.id);
    render(); save();
    flash("Archived · find it at the foot of the list");
  }
  function deleteChat(c) {
    const gone = new Set([c.id, ...D.chats.filter((x) => x.sub && x.sub.of === c.id).map((x) => x.id)]);
    for (const id of gone) letGo(id);
    D.chats = D.chats.filter((x) => !gone.has(x.id));
    for (const x of D.chats) if (x.parentChat === c.id) x.parentChat = ""; // chats it started stay, on their own
    if (!D.chats.some((x) => x.id === state.chatId)) state.chatId = latestChatEmpty().id;
    render(); save();
    flash("Chat deleted");
  }
  function openBeside(c) {
    if (panes.some((p) => p.chatId === c.id)) { openChat(c); return; }
    splitPane();
    state.chatId = c.id;
    render(); save();
  }
  let showArchived = false;
  function archivedFoot(list) {
    const arch = D.chats.filter((c) => c.archived && !c.sub && (c.messages.length) && matches(c));
    if (!arch.length) return;
    const head = h("button", "arch-h" + (showArchived ? " open" : ""), icon("chev", "ph-chev"), h("span", "", "Archived"), h("span", "ph-c", String(arch.length)));
    head.type = "button";
    head.onclick = () => { showArchived = !showArchived; renderChats(); };
    list.append(head);
    if (!showArchived) return;
    const box = h("div", "pg arch");
    for (const c of arch.sort((x, y) => seenAt(y) - seenAt(x))) box.append(chatButton(c, true));
    list.append(box);
  }

  // ---------- a chat's own copy of the project (git worktree), PRs, GitHub ----------
  // A new chat can work in its own copy on its own branch, so chats side by
  // side never write over each other. A bar over its composer says where it
  // stands and merges it back, opens a pull request from it, or throws it away.
  const runDir = (c) => (c && c.wt && !c.wt.closed ? c.wt.path : (c && c.cwd) || D.projectPath);
  const gitDir = () => runDir(chat());
  async function api(path, body) {
    try {
      const r = await fetch(path, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) });
      if (r.status === 204) return {};
      const t = await r.text();
      try { return JSON.parse(t); } catch { return { error: t.trim() || "HTTP " + r.status }; }
    } catch { return { error: "Could not reach Foxpit's backend." }; }
  }
  const openUrl = (u) => api("/api/project/openurl", { url: u });
  // before a chat's first message: make the copy it asked for
  async function ensureWorktree(c, text) {
    if (!c.wantWt || c.wt) return true;
    const title = c.title && c.title !== "New chat" ? c.title : String(text || "").slice(0, 40);
    const r = await api("/api/project/worktree", { cwd: c.cwd || D.projectPath, title });
    if (r.error) { flash(r.error); return false; }
    c.wt = r; c.wantWt = false; save();
    return true;
  }
  function copyChip(c) {
    const b = h("button", "chip chip-quiet copy-chip");
    b.type = "button";
    if (c.wt && !c.wt.closed) {
      b.classList.add("on");
      b.replaceChildren(icon("branch"), c.wt.branch.replace(/^foxpit\//, ""));
      b.title = "This chat works in its own copy on branch " + c.wt.branch + "\n" + c.wt.path;
      b.onclick = (e) => { e.stopPropagation(); refreshWt(c, true); };
      return b;
    }
    if (c.messages.length || !gitInfo || !gitInfo.repo) return null;
    b.classList.toggle("on", !!c.wantWt);
    b.replaceChildren(icon("branch"), c.wantWt ? "Own copy" : "Same folder");
    b.title = c.wantWt ? "This chat gets its own copy of the project on a new branch. Click to work in the folder itself."
      : "This chat works in the project folder itself. Click to give it its own copy on a new branch, so it can't clash with other chats.";
    b.onclick = (e) => { e.stopPropagation(); c.wantWt = !c.wantWt; withChat(c, renderHeader); save(); };
    return b;
  }
  async function refreshWt(c, now) {
    const w = c.wt;
    if (!w || w.closed || w.busy) return;
    if (!now && Date.now() - (w.at || 0) < 10000) return;
    w.at = Date.now();
    const r = await api("/api/project/worktree/state", w);
    if (r.gone) { w.closed = "gone"; save(); }
    else if (!r.error) { w.ahead = +r.ahead || 0; w.files = r.files || 0; if (r.pr) w.pr = r.pr; }
    if (panes.some((p) => p.chatId === c.id)) withChat(c, renderMessages);
  }
  function wtBar(c) {
    const w = c.wt;
    refreshWt(c);
    const what = [w.ahead ? w.ahead + (w.ahead === 1 ? " commit" : " commits") : "", w.files ? w.files + (w.files === 1 ? " file changed" : " files changed") : ""].filter(Boolean).join(" · ") || "no changes yet";
    const busy = runs.has(c.id) || !!w.busy;
    const btn = (label, cls, fn) => { const b = h("button", "mp-btn " + cls, label); b.type = "button"; b.disabled = busy; b.onclick = (e) => { e.stopPropagation(); fn(b); }; return b; };
    const merge = btn("Merge into " + w.base, "acc", async () => {
      w.busy = "Merging…"; withChat(c, renderMessages);
      const r = await api("/api/project/worktree/merge", { ...w, message: c.title });
      w.busy = "";
      if (r.error) { flash(r.error); withChat(c, renderMessages); return; }
      w.closed = "merged";
      c.messages.push({ role: "note", text: "Merged " + w.branch + " into " + w.base + " · the copy is removed" });
      gitCh.at = 0; refreshGit(); render(); save();
    });
    const pr = w.pr ? btn("View pull request", "", () => openUrl(w.pr)) : btn("Open pull request", "", async () => {
      w.busy = "Pushing and opening the pull request…"; withChat(c, renderMessages);
      const body = prBody(c);
      const r = await api("/api/project/pr", { dir: w.path, base: w.base, title: c.title, body });
      w.busy = "";
      if (r.error) { flash(r.error.split("\n")[0]); withChat(c, renderMessages); return; }
      w.pr = r.url;
      c.messages.push({ role: "note", text: (r.existing ? "Pushed to the pull request · " : "Opened a pull request · ") + r.url });
      if (r.url) openUrl(r.url);
      withChat(c, renderMessages); save();
    });
    const drop = btn("Discard", "ghost", (b) => confirmIn(b, "Throw away " + (w.ahead || w.files ? "its work" : "the copy") + "?", async () => {
      const r = await api("/api/project/worktree/discard", w);
      if (r.error) { flash(r.error); return; }
      w.closed = "discarded";
      c.messages.push({ role: "note", text: "Discarded the copy on " + w.branch });
      render(); save();
    }));
    return h("div", "wt-bar", icon("branch"), h("div", "wt-t", h("b", "", w.branch), h("span", "dim", w.busy || (" · " + what + " · from " + w.base))),
      h("div", "wt-a", pr, merge, drop));
  }
  // a pull request's text: the chat's ask and its last answer
  function prBody(c) {
    const ask = (c.messages.find((m) => m.role === "user") || {}).text || "";
    const last = [...c.messages].reverse().find((m) => m.role === "assistant");
    const said = last ? (last.parts || []).filter((p) => p.k === "text").map((p) => p.text).join("\n\n").trim() : "";
    return [ask ? "**Asked:** " + ask.slice(0, 1500) : "", said ? said.slice(0, 6000) : ""].filter(Boolean).join("\n\n") + "\n\n_Opened from Foxpit._";
  }

  // ---------- the GitHub tab: the repo's issues and pull requests ----------
  const GH = { kind: "issue", dir: "", items: null, repo: "", err: "", busy: false, at: 0, open: null, detail: null, q: "" };
  async function ghLoad(force) {
    const dir = D.projectPath;
    if (!SAVES || !dir || GH.busy) return;
    if (!force && GH.dir === dir + GH.kind && Date.now() - GH.at < 60000) return;
    GH.busy = true;
    const r = await api("/api/project/gh/list?dir=" + encodeURIComponent(dir) + "&kind=" + GH.kind + (GH.q ? "&q=" + encodeURIComponent(GH.q) : ""));
    GH.busy = false;
    GH.dir = dir + GH.kind; GH.at = Date.now();
    GH.items = r.error ? [] : r.items || []; GH.repo = r.repo || ""; GH.err = r.error || "";
    if (state.tab === "github") renderSide();
  }
  async function ghOpen(it) {
    GH.open = it.number; GH.detail = null; renderSide();
    const r = await api("/api/project/gh/issue?dir=" + encodeURIComponent(D.projectPath) + "&kind=" + GH.kind + "&n=" + it.number);
    if (GH.open !== it.number) return;
    GH.detail = r; renderSide();
  }
  function fixIssue(d) {
    const c = latestChatEmpty();
    c.wantWt = !!(gitInfo && gitInfo.repo);
    c.title = ("Fix #" + d.number + ": " + d.title).slice(0, 80);
    state.chatId = c.id;
    render();
    const talk = (d.comments || []).slice(-6).map((x) => "- " + ((x.author && x.author.login) || "someone") + ": " + String(x.body || "").slice(0, 800)).join("\n");
    const text = "Fix GitHub issue #" + d.number + " (" + d.url + "): " + d.title + "\n\n" + String(d.body || "(no description)").slice(0, 6000) +
      (talk ? "\n\nComments:\n" + talk : "") +
      "\n\nFind the cause, fix it, run the tests that cover it, and commit with a message that says \"Fixes #" + d.number + "\". Then tell me in a few lines what was wrong and what you changed.";
    send(text, c);
  }
  function githubTab() {
    ghLoad();
    const wrap = h("div", "gh-tab");
    const seg = h("div", "seg");
    for (const [k, t] of [["issue", "Issues"], ["pr", "Pull requests"]]) {
      const b = h("button", GH.kind === k ? "on" : "", t);
      b.type = "button";
      b.onclick = (e) => { e.stopPropagation(); if (GH.kind === k) return; GH.kind = k; GH.items = null; GH.open = null; ghLoad(true); renderSide(); };
      seg.append(b);
    }
    const re = h("button", "w-btn", icon("retry"));
    re.type = "button"; re.title = "Read again";
    re.onclick = (e) => { e.stopPropagation(); ghLoad(true); };
    const cb = h("div", "cb gh-list");
    if (!D.projectPath) cb.append(h("div", "dim", "Open a project folder first."));
    else if (GH.err) cb.append(h("div", "warn-t", GH.err.split("\n")[0]));
    else if (!GH.items) cb.append(h("div", "dim", "Asking GitHub…"));
    else if (!GH.items.length) cb.append(h("div", "dim", GH.kind === "pr" ? "No open pull requests." : "No open issues."));
    else for (const it of GH.items) {
      const labels = (it.labels || []).slice(0, 3).map((l) => { const s = h("span", "gh-lb", l.name); if (l.color) s.style.setProperty("--lc", "#" + l.color); return s; });
      const meta = ["#" + it.number, it.author && it.author.login, ago(it.updatedAt) + " ago", it.isDraft ? "draft" : "", it.reviewDecision ? it.reviewDecision.toLowerCase().replace(/_/g, " ") : "",
        it.comments && it.comments.length ? it.comments.length + " comments" : ""].filter(Boolean).join(" · ");
      const row = h("button", "gh-r" + (GH.open === it.number ? " sel" : ""), h("div", "gh-t", it.title), h("div", "gh-m", h("span", "dim", meta), ...labels));
      row.type = "button";
      row.onclick = (e) => { e.stopPropagation(); GH.open === it.number ? (GH.open = null, renderSide()) : ghOpen(it); };
      cb.append(row);
      if (GH.open === it.number) cb.append(ghDetail(it));
    }
    wrap.append(h("div", "card", h("div", "ch", "GitHub", h("span", "muted", GH.repo || ""), h("div", "r", re)), h("div", "cb", seg), cb));
    return wrap;
  }
  function ghDetail(it) {
    const d = GH.detail;
    const box = h("div", "gh-d");
    if (!d) { box.append(h("div", "dim", "Reading…")); return box; }
    if (d.error) { box.append(h("div", "warn-t", d.error)); return box; }
    const body = h("div", "gh-body");
    body.append(richText(String(d.body || "").trim() || "_No description._"));
    const acts = h("div", "gh-acts");
    const web = h("button", "mp-btn", "Open on GitHub");
    web.type = "button"; web.onclick = (e) => { e.stopPropagation(); openUrl(d.url); };
    if (GH.kind === "issue") {
      const fix = h("button", "mp-btn acc", icon("spark"), "Fix in a new chat");
      fix.type = "button"; fix.title = "A new chat in its own copy of the project works on this issue; then you open a pull request from it.";
      fix.onclick = (e) => { e.stopPropagation(); fixIssue(d); };
      acts.append(fix);
    }
    acts.append(web);
    box.append(body, acts);
    return box;
  }

  // ---------- chats a chat starts (Foxpit's new_chat tool) ----------
  // The model asks for a chat; it opens under its chat in the rail, runs on
  // its own, and what it says at the end goes back for wait_chats.
  function pickModel(want, parent) {
    const w = String(want || "").toLowerCase().trim();
    if (w && w !== "same") {
      for (const a of D.accounts || []) for (const m of a.models || []) if (String(m.id).toLowerCase() === w) return { account: a.id, model: m.id };
      for (const a of D.accounts || []) for (const m of a.models || []) if ((m.id + " " + (m.name || "")).toLowerCase().includes(w)) return { account: a.id, model: m.id };
    }
    return { account: parent.account, model: parent.model };
  }
  function spawnChat(parent, ev) {
    if (D.chats.some((x) => x.id === ev.id)) return;
    const pick = pickModel((ev.input || {}).model, parent);
    const n = freshChat(parent);
    Object.assign(n, { id: ev.id, title: ev.name || "New chat", cwd: parent.cwd || D.projectPath, account: pick.account, model: pick.model,
      effort: parent.effort, mode: parent.mode, allow: [...(parent.allow || [])], parentChat: parent.id, spawn: { id: ev.id, of: parent.id }, updated: Date.now() });
    fitEffort(n);
    D.chats.push(n);
    renderChats();
    save();
    send(ev.text || "", n);
  }
  // a started chat's first run is over: its answer goes back to the chat that started it
  function reportSpawn(c) {
    if (!c.spawn || c.spawn.told) return;
    c.spawn.told = true;
    const m = [...c.messages].reverse().find((x) => x.role === "assistant");
    const text = m ? m.parts.filter((p) => p.k === "text").map((p) => p.text).join("\n\n").trim() || m.error || "" : "";
    const ok = !!m && !m.error && !m.stopped;
    fetch("/api/project/spawned", { method: "POST", body: JSON.stringify({ parent: c.spawn.of, id: c.spawn.id, text: text || (ok ? "(It finished without a written answer.)" : "(It stopped before answering.)"), ok }) }).catch(() => {});
    save();
  }
  const spawnOf = (t) => {
    const id = /Started chat (k[0-9a-f]+)/.exec(String(t.out || ""));
    return id ? D.chats.find((x) => x.id === id[1]) : null;
  };
  function spawnCard(t) {
    const i = t.input || {};
    const sc = spawnOf(t);
    const running = sc ? sc.state === "running" : t.ok == null;
    const mark = h("span", "ag-mark" + (running ? " live" : ""), icon("spark"));
    mark.style.setProperty("--hue", 210);
    const sub = !sc ? (t.ok === false ? "Could not start" : "Starting…") : (sc.state === "running" ? "Working" : "Done") + " · " + modelName(sc.account, sc.model);
    const open = h("span", "ag-open", "Open", icon("chev", "r"));
    open.style.opacity = sc ? "1" : "0";
    open.onclick = (e) => { e.stopPropagation(); if (sc) openChat(sc); };
    const head = h("button", "ag-h", mark, h("div", "ag-t", h("div", "l1", h("b", "", "New chat"), h("span", "what", i.title || "")),
      h("div", "l2", h("span", "st " + (running ? "running" : t.ok === false ? "failed" : "done"), sub))), open);
    head.type = "button";
    head.onclick = () => { if (sc) openChat(sc); };
    return h("div", "subag spawn" + (running ? " running" : "") + (t.ok === false ? " failed" : ""), head);
  }
  function waitCard(t) {
    const running = t.ok == null;
    const isOpen = openTools.has(t.id);
    const ids = (t.input && t.input.ids) || [];
    const n = running ? (ids.length || D.chats.filter((x) => x.spawn && x.state === "running").length) : (String(t.out || "").match(/^## /gm) || []).length;
    const mark = h("span", "ag-mark" + (running ? " live" : ""), icon(running ? "retry" : "check"));
    mark.style.setProperty("--hue", 152);
    const head = h("button", "ag-h", mark, h("div", "ag-t", h("div", "l1", h("b", "", running ? "Waiting for chats" : "Answers are in"),
      h("span", "what", n ? n + (n === 1 ? " chat" : " chats") : "")), h("div", "l2", h("span", "st " + (running ? "running" : "done"), running ? "Each sends its answer when it's done" : "Click to read them"))), icon("chev", "chev"));
    head.type = "button";
    const card = h("div", "subag" + (isOpen ? " open" : "") + (running ? " running" : ""), head);
    if (isOpen && t.out) card.append(h("div", "ag-b", h("div", "ag-rep", richText(String(t.out)))));
    head.onclick = () => { if (openTools.has(t.id)) openTools.delete(t.id); else openTools.add(t.id); card.replaceWith(waitCard(t)); };
    return card;
  }
  // an account ran out mid-reply and the next one took over
  function hopNode(p) {
    return h("div", "hop", icon("swap"), h("span", "", "Limit reached on ", h("b", "", (p.from || "").split("@")[0]), ", continuing on ", h("b", "", (p.to || "").split("@")[0])));
  }
  // ---------- edit, retry, branch ----------
  // A chat is one Claude Code session; going back resumes it only up to an
  // earlier reply (its message id) as a new copy, so the old line stays whole.
  let editing = null;
  function actBtn(ic, title, fn) {
    const b = h("button", "say act", icon(ic));
    b.type = "button";
    b.title = title;
    b.onclick = (e) => { e.stopPropagation(); fn(b); };
    return b;
  }
  function copied(b) { b.classList.add("done"); b.title = "Copied"; setTimeout(() => b.classList.remove("done"), 1200); }
  function hasMedia(m) { return !!((m.images && m.images.length) || (m.videos && m.videos.length)); }
  // where the session has to be cut to send the user message at i again
  function cutFor(c, i) {
    for (let j = i - 1; j >= 0; j--) {
      const x = c.messages[j];
      if (x.role === "user") return null; // two user messages in a row: no reply to cut at
      if (x.role === "assistant" && x.parts) return x.mid && c.session ? { session: c.session, at: x.mid } : null;
    }
    return c.importCtx || c.messages.some((x) => x.role === "note" && /^Imported/.test(x.text || "")) ? null : { session: "", at: "" };
  }
  function canRewind(c, i) { return i >= 0 && c.messages[i] && c.messages[i].role === "user" && !hasMedia(c.messages[i]) && !!cutFor(c, i); }
  function rewind(c, i, text) {
    if (runs.has(c.id)) return flash("Wait for the reply to finish, or stop it first.");
    const cut = cutFor(c, i);
    if (!cut) return flash("This message can't be sent again: its earlier reply came from before Foxpit kept the place.");
    editing = null;
    c.messages = c.messages.slice(0, i);
    c.session = cut.session;
    c.cutAt = cut.at;
    const here = panes.findIndex((p) => p.chatId === c.id);
    if (here < 0) return;
    inPane(here, () => { renderMessages(); send(text); });
  }
  function editNode(m) {
    const c = D.chats.find((x) => x.messages.includes(m));
    const ta = h("textarea", "", m.text);
    ta.rows = 1;
    const grow = () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 260) + "px"; };
    const cancel = () => { editing = null; if (c) withChat(c, renderMessages); };
    const go = () => { const t = ta.value.trim(); if (t && c) rewind(c, c.messages.indexOf(m), t); };
    ta.oninput = grow;
    ta.onkeydown = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancel(); }
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); go(); }
    };
    const no = h("button", "btn", "Cancel"), yes = h("button", "btn pri", "Send");
    no.type = yes.type = "button";
    no.onclick = cancel;
    yes.onclick = go;
    const node = h("div", "u-edit", ta, h("div", "ue-f", h("span", "dim", "Replies after this message are replaced. The earlier chat stays as it was."), no, yes));
    requestAnimationFrame(() => { grow(); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); });
    return node;
  }
  function retry(c, m) {
    let i = c.messages.indexOf(m) - 1;
    while (i >= 0 && c.messages[i].role !== "user") i--;
    if (i < 0) return;
    if (!canRewind(c, i)) return flash(hasMedia(c.messages[i]) ? "That message had images or video. Attach them again and send." : "This reply can't be made again from here.");
    rewind(c, i, c.messages[i].text);
  }
  // a new chat that carries on from this reply; this one stays as it is
  function branch(c, m) {
    const i = c.messages.indexOf(m);
    if (!m.mid || !c.session) return flash("This reply came from before Foxpit kept the place; branch from a newer one.");
    const nc = Object.assign(freshChat(c), {
      title: (c.title.replace(/ · branch( \d+)?$/, "") + " · branch").slice(0, 60), account: c.account, model: c.model, effort: c.effort, mode: c.mode, cwd: c.cwd,
      session: c.session, cutAt: m.mid, allow: [...(c.allow || [])], state: "done",
      messages: JSON.parse(JSON.stringify(c.messages.slice(0, i + 1))).map((x) => ({ ...x, running: false })),
    });
    nc.messages.push({ role: "note", text: "Branched from “" + c.title + "”" });
    D.chats.unshift(nc);
    save();
    renderChats();
    openChat(nc);
  }

  // ---------- messages sent while a reply runs ----------
  const queues = new Map(); // chat id → [{ text, att }], with a paused flag after Stop
  function queueOf(c) { let q = queues.get(c.id); if (!q) { q = []; queues.set(c.id, q); } return q; }
  function enqueue(c, text, att) {
    const q = queueOf(c);
    q.push({ text, att });
    q.paused = false;
    drawQueue();
  }
  function drawQueue() {
    const comp = $("#composer"), c = chat();
    if (!comp || !c) return;
    const q = queues.get(c.id) || [];
    let row = comp.querySelector(".q-row");
    if (!q.length) { row?.remove(); return; }
    if (!row) { row = h("div", "q-row"); comp.prepend(row); }
    const here = cur;
    const head = h("div", "q-h", icon("send"), h("span", "", q.paused ? "Queued, paused after Stop" : runs.has(c.id) ? "Sends when this reply finishes" : "Queued"));
    if (q.paused || !runs.has(c.id)) {
      const now = h("button", "q-now", "Send now");
      now.type = "button";
      now.onclick = (e) => { e.stopPropagation(); q.paused = false; nextQueued(c); };
      head.append(now);
    }
    row.replaceChildren(head);
    q.forEach((it, i) => {
      const t = h("button", "q-t", it.text || "(attachments)", it.att.length ? h("span", "q-n", "+" + it.att.length) : null);
      t.type = "button";
      t.title = "Move back to the box to change it";
      t.onclick = (e) => {
        e.stopPropagation();
        q.splice(i, 1);
        inPane(here, () => {
          const inp = $("#input");
          inp.value = it.text + (inp.value ? "\n" + inp.value : "");
          inp.dispatchEvent(new Event("input", { bubbles: true }));
          if (it.att.length) { PN().att = [...(PN().att || []), ...it.att]; drawAttachments(); }
          drawQueue();
          inp.focus();
        });
      };
      const x = h("button", "att-x q-x", icon("x"));
      x.type = "button";
      x.title = "Remove";
      x.onclick = (e) => { e.stopPropagation(); q.splice(i, 1); inPane(here, drawQueue); };
      row.append(h("div", "q-i", h("span", "q-k", String(i + 1)), t, x));
    });
  }
  function nextQueued(c) {
    const q = queues.get(c.id);
    if (!q || !q.length || q.paused || runs.has(c.id)) return;
    const here = panes.findIndex((p) => p.chatId === c.id);
    if (here < 0) return; // sent when the chat is opened again
    const it = q.shift();
    inPane(here, () => {
      const keep = PN().att || [];
      PN().att = it.att;
      send(it.text);
      PN().att = keep;
      drawAttachments();
      drawQueue();
    });
  }

  // ---------- context: how full the chat is, and with what ----------
  const ctxRuns = new Map(); // chat id → a quiet /context run
  const CTX_COLORS = { "Messages": "#4c8dff", "System tools": "#ff7a1a", "MCP tools": "#22c3a6", "Memory files": "#b48cff", "System prompt": "#8a8f98",
    "Skills": "#e6c35c", "Custom agents": "#ff5d8f", "Autocompact buffer": "repeating-linear-gradient(135deg,var(--line2) 0 3px,var(--hover) 3px 6px)", "Free space": "var(--hover)" };
  const ctxColor = (n) => CTX_COLORS[n] || (/deferred/i.test(n) ? "transparent" : "#6b7079");
  function fmtTok(n) { return n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + "k" : String(Math.round(n)); }
  function tokNum(t) {
    const m = /([\d.,]+)\s*([kKmM]?)/.exec(String(t || ""));
    if (!m) return 0;
    const v = parseFloat(m[1].replace(/,/g, ""));
    return m[2].toLowerCase() === "m" ? v * 1e6 : m[2].toLowerCase() === "k" ? v * 1e3 : v;
  }
  // Claude Code's /context, read into parts
  function parseContext(md) {
    const out = { model: "", used: 0, window: 0, pct: 0, cats: [], sections: {} };
    const mm = /\*\*Model:\*\*\s*([^\n]+)/.exec(md);
    if (mm) out.model = mm[1].trim();
    const tk = /\*\*Tokens:\*\*\s*([\d.,]+\s*[kKmM]?)\s*\/\s*([\d.,]+\s*[kKmM]?)\s*\((\d+(?:\.\d+)?)%\)/.exec(md);
    if (tk) { out.used = tokNum(tk[1]); out.window = tokNum(tk[2]); out.pct = parseFloat(tk[3]); }
    for (const part of md.split(/^###\s+/m).slice(1)) {
      const title = part.split("\n")[0].trim();
      const rows = part.split("\n").filter((l) => /^\s*\|/.test(l)).slice(2)
        .map((l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((x) => x.trim()));
      if (/usage by category/i.test(title)) out.cats = rows.map((r) => ({ name: r[0], tokens: tokNum(r[1]), pct: parseFloat(r[2]) || 0 }));
      else out.sections[title] = rows;
    }
    return out;
  }
  async function readContext(c) {
    if (!c.session) return { error: "Send a message first: the context fills as the chat goes." };
    if (runs.has(c.id)) return { error: "Details come when this reply finishes." };
    if (ctxRuns.has(c.id)) return ctxRuns.get(c.id);
    const job = (async () => {
      const b = await fetch("/api/backend").then((r) => r.json());
      return await new Promise((res) => {
        const ws = new WebSocket(b.url.replace(/^http/, "ws") + "/chat?key=" + encodeURIComponent(b.key));
        let text = "", err = "";
        ws.onopen = () => ws.send(JSON.stringify({ prompt: "/context", model: c.model, effort: c.effort, session: c.session, cwd: runDir(c), mode: modeOf(c).id,
          account: D.claudeUser || "", auto: false, allow: c.allow || [], chat: c.id, via: !!S().viaMagpie }));
        ws.onmessage = (e) => { try { const ev = JSON.parse(e.data); if (ev.t === "done") text = ev.text || text; if (ev.t === "text" || ev.t === "delta") text += ev.text || ""; if (ev.t === "error") err = ev.text || "Claude Code didn't answer."; } catch {} };
        ws.onclose = () => res(text && /Tokens/.test(text) ? { detail: parseContext(text) } : { error: err || "Claude Code didn't give the context." });
      });
    })().catch(() => ({ error: "Context is read in the Foxpit app." })).finally(() => ctxRuns.delete(c.id));
    ctxRuns.set(c.id, job);
    return job;
  }
  // Claude Code takes a while to start (its hooks, its MCP servers): the
  // chat's process starts while the message is being typed, so sending
  // finds it running. Nothing is sent to a model.
  const warmed = new Map();
  async function warmChat(c) {
    if (!SAVES || !c || runs.has(c.id) || ctxRuns.has(c.id) || c.cutAt || !(c.cwd || D.projectPath)) return;
    if (Date.now() - (warmed.get(c.id) || 0) < 60000) return;
    warmed.set(c.id, Date.now());
    try {
      const b = await fetch("/api/backend").then((r) => r.json());
      const ws = new WebSocket(b.url.replace(/^http/, "ws") + "/chat?key=" + encodeURIComponent(b.key));
      ws.onopen = () => ws.send(JSON.stringify({ warm: true, prompt: "", model: c.model, effort: c.effort, session: c.session || "", cwd: runDir(c), mode: modeOf(c).id,
        account: D.claudeUser || "", auto: D.autoSwitch !== false, allow: c.allow || [], at: "", chat: c.id, via: !!S().viaMagpie }));
      ws.onmessage = () => ws.close();
    } catch { warmed.delete(c.id); }
  }
  document.addEventListener("input", (e) => { if (e.target && e.target.matches && e.target.matches('[data-id="input"]')) warmChat(chat()); }, true);
  document.addEventListener("focusin", (e) => { if (e.target && e.target.matches && e.target.matches('[data-id="input"]')) warmChat(chat()); }, true);
  function renderCtxChip() {
    const b = $("#ctxChip"), c = chat();
    if (!b) return;
    const x = c.ctxDetail ? { used: c.ctxDetail.used, window: c.ctxDetail.window } : c.ctx;
    const pct = x && x.window ? Math.min(100, Math.round((x.used / x.window) * 100)) : null;
    const ring = h("span", "ctx-ring");
    ring.style.setProperty("--p", (pct || 0) + "%");
    ring.style.setProperty("--c", pct == null ? "var(--dim)" : pct < 60 ? "#4c8dff" : pct < 85 ? "#ffb84d" : "#ff5d5d");
    b.replaceChildren(...[ring, pct != null ? h("span", "ctx-n", pct + "%") : null].filter(Boolean));
    b.title = pct == null ? "Context: fills as the chat goes" : "Context: " + fmtTok(x.used) + " of " + fmtTok(x.window) + " used";
    b.classList.toggle("hot", pct != null && pct >= 85);
  }
  const ctxv = { c: null };
  function closeCtx() { $("#ctxPop")?.remove(); document.querySelectorAll(".ctx-chip.open").forEach((e) => e.classList.remove("open")); ctxv.c = null; }
  async function openCtx() {
    if ($("#ctxPop")) return closeCtx();
    const c = chat(), chip = $("#ctxChip"), here = cur;
    closeMenu();
    const pop = h("div", "mp-pop ctx-pop");
    pop.id = "ctxPop";
    pop.onclick = (e) => e.stopPropagation();
    document.body.append(pop);
    const r = chip.getBoundingClientRect();
    const pw = Math.min(360, window.innerWidth - 16);
    pop.style.width = pw + "px";
    pop.style.left = Math.max(8, Math.min(r.right - pw, window.innerWidth - pw - 8)) + "px";
    pop.style.bottom = window.innerHeight - r.top + 8 + "px";
    chip.classList.add("open");
    ctxv.c = c;
    drawCtx(c, here, true);
    const v = await readContext(c);
    if (ctxv.c !== c) return;
    if (v.detail) { c.ctxDetail = v.detail; c.ctx = { used: v.detail.used, window: v.detail.window, at: Date.now() }; save(); withChat(c, renderCtxChip); }
    drawCtx(c, here, false, v.error);
  }
  function drawCtx(c, here, loading, error) {
    const pop = $("#ctxPop");
    if (!pop) return;
    const d = c.ctxDetail, x = d || c.ctx;
    const pct = x && x.window ? Math.min(100, (x.used / x.window) * 100) : 0;
    const head = h("div", "cx-h", h("b", "", "Context"), d && d.model ? h("span", "cx-m", d.model) : null);
    const again = h("button", "cx-r", icon("retry"));
    again.type = "button";
    again.title = "Read again";
    again.onclick = async () => { drawCtx(c, here, true); const v = await readContext(c); if (v.detail) { c.ctxDetail = v.detail; save(); withChat(c, renderCtxChip); } drawCtx(c, here, false, v.error); };
    head.append(again);
    const body = h("div", "cx-b");
    if (x) {
      body.append(h("div", "cx-top", h("b", "", Math.round(pct) + "% used"), h("span", "", fmtTok(x.used) + " / " + fmtTok(x.window))));
      const bar = h("div", "cx-bar");
      if (d && d.cats.length) {
        for (const k of d.cats.filter((k) => !/deferred/i.test(k.name) && k.name !== "Free space")) {
          const seg = h("i", "");
          seg.style.width = Math.max(0.4, k.pct) + "%";
          seg.style.background = ctxColor(k.name);
          seg.title = k.name + " · " + fmtTok(k.tokens);
          bar.append(seg);
        }
      } else { const seg = h("i", ""); seg.style.width = pct + "%"; seg.style.background = "#4c8dff"; bar.append(seg); }
      body.append(bar);
    }
    if (d && d.cats.length) {
      const live = d.cats.filter((k) => !/deferred/i.test(k.name)), later = d.cats.filter((k) => /deferred/i.test(k.name));
      const list = h("div", "cx-l");
      for (const k of live) {
        const sw = h("span", "cx-sw");
        sw.style.background = ctxColor(k.name);
        list.append(h("div", "cx-row" + (k.name === "Free space" ? " free" : ""), sw, h("span", "cx-n", k.name), h("span", "cx-t", fmtTok(k.tokens)), h("span", "cx-p", k.pct.toFixed(1) + "%")));
      }
      if (later.length) {
        list.append(h("div", "cx-sep"));
        for (const k of later) list.append(h("div", "cx-row dim", h("span", "cx-sw ghost"), h("span", "cx-n", k.name), h("span", "cx-t", fmtTok(k.tokens)), h("span", "cx-p", "—")));
      }
      body.append(list);
      for (const [title, rows] of Object.entries(d.sections)) {
        if (!rows.length) continue;
        const sec = h("div", "cx-sec");
        const sh = h("button", "cx-sh", icon("chev", "chev"), h("span", "", title), h("span", "cx-c", String(rows.length)));
        sh.type = "button";
        sh.onclick = () => sec.classList.toggle("open");
        const items = h("div", "cx-items");
        for (const rw of rows.slice(0, 200)) items.append(h("div", "cx-it", h("span", "cx-in", rw[0].replace(/^mcp__/, "")), rw.length > 2 ? h("span", "cx-is", rw[1].length > 40 ? "…" + rw[1].slice(-38) : rw[1]) : null, h("span", "cx-t", rw[rw.length - 1])));
        sec.append(sh, items);
        body.append(sec);
      }
    }
    if (loading) body.append(h("div", "cx-load", h("span", "spin sm"), h("span", "", c.ctxDetail ? "Reading again…" : "Reading the context from Claude Code…")));
    else if (error) body.append(h("div", "cx-note", error));
    else if (!x) body.append(h("div", "cx-note", "Send a message first: the context fills as the chat goes."));
    const buf = d && d.cats.find((k) => /autocompact/i.test(k.name));
    const foot = h("div", "cx-f", h("span", "dim", buf && x ? "Compacts by itself near " + fmtTok(x.window - buf.tokens) : "Compacting keeps a summary and frees room."));
    const comp = h("button", "mp-btn", "Compact now");
    comp.type = "button";
    comp.disabled = !c.session || runs.has(c.id);
    comp.onclick = () => { closeCtx(); const i = panes.findIndex((p) => p.chatId === c.id); if (i >= 0) inPane(i, () => send("/compact")); };
    foot.append(comp);
    pop.replaceChildren(head, body, foot);
  }
  document.addEventListener("click", () => { if ($("#ctxPop")) closeCtx(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $("#ctxPop")) { e.stopPropagation(); closeCtx(); } }, true);

  // ---------- back to the latest, and find in this chat ----------
  function paneOf(el) { return el && el.closest(".pane"); }
  function syncDown() {
    const box = $("#msgs");
    if (!box) return;
    const pane = paneOf(box);
    let b = pane.querySelector(".to-end");
    if (!b) {
      b = h("button", "to-end", icon("chev"), h("span", "te-n", "New"));
      b.type = "button";
      b.title = "Back to the latest";
      b.onclick = (e) => { e.stopPropagation(); box.scrollTo({ top: box.scrollHeight, behavior: "smooth" }); b.classList.remove("fresh"); };
      pane.append(b);
      box.addEventListener("scroll", () => {
        const far = box.scrollHeight - box.scrollTop - box.clientHeight > 260;
        b.classList.toggle("on", far);
        if (!far) b.classList.remove("fresh");
      }, { passive: true });
    }
    const comp = pane.querySelector('[data-id="composer"]');
    if (comp) b.style.bottom = comp.offsetHeight + 30 + "px";
  }
  // a reply growing out of sight marks the button
  function markFresh(c) {
    withChat(c, () => {
      const box = $("#msgs"), b = paneOf(box)?.querySelector(".to-end");
      if (b && box.scrollHeight - box.scrollTop - box.clientHeight > 260) b.classList.add("fresh");
    });
  }
  const find = { q: "", hits: [], at: 0, pane: null };
  function openFind() {
    const box = $("#msgs"), pane = paneOf(box);
    if (!pane) return;
    let bar = pane.querySelector(".find-bar");
    if (!bar) {
      const inp = h("input", "fb-in");
      inp.placeholder = "Find in this chat";
      const n = h("span", "fb-n", "");
      const btn = (ic, t, fn, cls) => { const b = h("button", "fb-b" + (cls ? " " + cls : ""), icon(ic)); b.type = "button"; b.title = t; b.onclick = (e) => { e.stopPropagation(); fn(); }; return b; };
      bar = h("div", "find-bar", icon("search"), inp, n, btn("chev", "Previous (Shift+Enter)", () => stepFind(-1), "up"), btn("chev", "Next (Enter)", () => stepFind(1)), btn("x", "Close (Esc)", closeFind));
      bar.onclick = (e) => e.stopPropagation();
      inp.oninput = () => runFind(inp.value);
      inp.onkeydown = (e) => {
        if (e.key === "Enter") { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1); }
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeFind(); }
      };
      pane.append(bar);
    }
    find.pane = pane;
    bar.classList.add("on");
    const inp = bar.querySelector(".fb-in");
    inp.focus();
    inp.select();
    if (inp.value) runFind(inp.value);
  }
  function closeFind() {
    if (find.pane) find.pane.querySelector(".find-bar")?.classList.remove("on");
    try { CSS.highlights.delete("fx-find"); CSS.highlights.delete("fx-find-now"); } catch {}
    find.hits = [];
    find.pane = null;
  }
  function runFind(q) {
    find.q = q.trim().toLowerCase();
    find.hits = [];
    find.at = 0;
    const pane = find.pane, col = pane && pane.querySelector('[data-id="col"]');
    if (col && find.q) {
      const walk = document.createTreeWalker(col, NodeFilter.SHOW_TEXT, { acceptNode: (t) => (t.parentElement.closest(".gone,.say,.m-acts,button") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
      for (let t = walk.nextNode(); t && find.hits.length < 2000; t = walk.nextNode()) {
        const low = t.data.toLowerCase();
        for (let i = low.indexOf(find.q); i >= 0 && find.hits.length < 2000; i = low.indexOf(find.q, i + find.q.length)) {
          const r = new Range();
          r.setStart(t, i);
          r.setEnd(t, i + find.q.length);
          find.hits.push(r);
        }
      }
      // the newest first: a search looks back from the end
      find.at = find.hits.length - 1;
    }
    paintFind();
  }
  function stepFind(d) {
    if (!find.hits.length) return;
    find.at = (find.at + d + find.hits.length) % find.hits.length;
    paintFind();
  }
  function paintFind() {
    const bar = find.pane && find.pane.querySelector(".find-bar");
    if (!bar) return;
    const n = find.hits.length;
    bar.querySelector(".fb-n").textContent = find.q ? (n ? find.at + 1 + " of " + n + (n >= 2000 ? "+" : "") : "No matches") : "";
    bar.classList.toggle("none", !!find.q && !n);
    try {
      CSS.highlights.set("fx-find", new Highlight(...find.hits));
      CSS.highlights.set("fx-find-now", n ? new Highlight(find.hits[find.at]) : new Highlight());
    } catch {}
    if (n) {
      const r = find.hits[find.at].getBoundingClientRect(), box = find.pane.querySelector('[data-id="msgs"]'), b = box.getBoundingClientRect();
      if (r.top < b.top + 60 || r.bottom > b.bottom - 60) box.scrollTo({ top: box.scrollTop + r.top - b.top - b.height / 3, behavior: "smooth" });
    }
  }
  document.addEventListener("keydown", (e) => {
    if (mod(e) && !e.shiftKey && (e.key === "f" || e.key === "F")) {
      if (setv.open || impv.open || mpv.open) return;
      e.preventDefault();
      const fp = document.activeElement && paneOf(document.activeElement);
      const i = fp ? paneEls().indexOf(fp) : -1;
      i >= 0 ? inPane(i, openFind) : openFind();
    }
  }, true);

  // what the model thought before answering: streams open, then folds away
  const openThinks = new Set();
  function thinkNode(p, m) {
    const live = m.running && !p.secs;
    const secs = p.secs || 0;
    const key = p.t0 || p.text.slice(0, 40);
    const open = live || openThinks.has(key);
    const head = h("button", "th-h", icon("spark"), h("span", "", live ? "Thinking" : secs ? "Thought for " + secs + "s" : "Thought"),
      live ? h("span", "typing sm", h("i"), h("i"), h("i")) : icon("chev", "chev"));
    head.type = "button";
    const body = h("div", "th-b", p.text.trim());
    const node = h("div", "think" + (open ? " open" : "") + (live ? " live" : ""), head, body);
    if (live) requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; });
    head.onclick = () => {
      if (live) return;
      node.classList.toggle("open");
      node.classList.contains("open") ? openThinks.add(key) : openThinks.delete(key);
    };
    return node;
  }
  // Claude Code asks before running what the chat's mode doesn't allow
  function askLabel(p) {
    const k = p.key || p.name;
    return "Always allow " + (k.includes(":") ? k.split(":")[1] : p.name);
  }
  // the answer to a card goes back on the chat's socket
  function sendAnswer(c, m, p, ans) {
    const ws = c && runs.get(c.id);
    if (!ws || ws.readyState !== 1) { p.state = "expired"; if (c) patchLast(c); return false; }
    ws.send(JSON.stringify({ t: "answer", id: p.id, ...ans }));
    p.state = ans.allow ? "allowed" : "denied";
    m.wait = ans.allow ? "Working…" : "";
    patchLast(c);
    save();
    return true;
  }
  // the plan Claude made in plan mode, to approve or send back
  function planCard(p, m) {
    const c = D.chats.find((x) => x.messages.includes(m));
    const plan = String((p.input || {}).plan || "");
    if (p.state && p.state !== "waiting") {
      const ok = p.state === "allowed";
      const node = h("div", "plan-card done" + (ok ? "" : " no"),
        h("div", "pc-h", icon(ok ? "check" : "edit"), h("span", "", ok ? "Plan approved" : p.state === "expired" ? "Plan not answered" : "Kept planning"),
          p.note ? h("span", "pc-note", "“" + p.note + "”") : null, icon("chev", "chev")),
        h("div", "pc-b", richText(plan)));
      node.querySelector(".pc-h").onclick = () => node.classList.toggle("open");
      return node;
    }
    const note = h("textarea", "pc-in");
    note.rows = 1;
    note.placeholder = "Anything to change? Write it and press Keep planning.";
    note.oninput = () => { note.style.height = "auto"; note.style.height = Math.min(note.scrollHeight, 160) + "px"; };
    const go = h("button", "btn pri", icon("check"), "Approve and start");
    const back = h("button", "btn", "Keep planning");
    go.type = back.type = "button";
    go.onclick = (e) => {
      e.stopPropagation();
      if (!sendAnswer(c, m, p, { allow: true })) return;
      // the run leaves plan mode; so does the chat
      if (c.mode === "plan") { delete c.mode; withChat(c, renderHeader); save(); }
    };
    back.onclick = (e) => {
      e.stopPropagation();
      const t = note.value.trim();
      p.note = t;
      sendAnswer(c, m, p, { allow: false, message: t ? "The person wants changes to the plan before you start: " + t + "\nRevise the plan and present it again." : "The person isn't ready to start. Keep planning: ask what they want changed." });
    };
    note.onkeydown = (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); back.click(); } };
    return h("div", "plan-card",
      h("div", "pc-h", icon("prompt"), h("span", "", "Plan ready"), h("span", "pc-t", "Plan mode")),
      h("div", "pc-b", richText(plan)),
      note,
      h("div", "ak-b", go, back));
  }
  // questions Claude asks with choices
  function questionCard(p, m) {
    const c = D.chats.find((x) => x.messages.includes(m));
    const qs = Array.isArray((p.input || {}).questions) ? p.input.questions : [];
    if (p.state && p.state !== "waiting") {
      const rows = qs.map((q) => {
        const a = (p.answers || {})[q.question];
        return h("div", "qa-done", h("span", "qd-q", q.header || q.question), h("span", "qd-a", a == null ? "—" : Array.isArray(a) ? a.join(", ") : a));
      });
      return h("div", "ask done q-done" + (p.state === "allowed" ? "" : " no"), icon(p.state === "allowed" ? "check" : "x"),
        h("div", "qd", ...(p.state === "allowed" ? rows : [h("span", "", p.state === "expired" ? "Not answered" : "Skipped")])));
    }
    p.pick = p.pick || {};
    const card = h("div", "ask q-card");
    const send = h("button", "btn pri", "Send answers");
    send.type = "button";
    const ready = () => qs.every((q) => { const v = p.pick[q.question]; return Array.isArray(v) ? v.length : v && String(v).trim(); });
    const sync = () => { send.disabled = !ready(); };
    card.append(h("div", "ak-h", icon("prompt"), h("span", "", qs.length > 1 ? modelName(m.account, m.model) + " has " + qs.length + " questions" : modelName(m.account, m.model) + " asks"), h("span", "ak-t", "Question")));
    for (const q of qs) {
      const multi = !!q.multiSelect;
      const box = h("div", "q-q", q.header ? h("span", "q-hd", q.header) : null, h("div", "q-tx", q.question || ""));
      const opts = h("div", "q-opts");
      const other = h("input", "q-other");
      other.placeholder = "Something else…";
      const mark = () => {
        const v = p.pick[q.question];
        opts.querySelectorAll(".q-o").forEach((b) => b.classList.toggle("on", multi ? (v || []).includes(b._label) : v === b._label));
      };
      for (const o of q.options || []) {
        const b = h("button", "q-o", h("span", "q-box"), h("span", "q-l", o.label || ""), o.description ? h("span", "q-d", o.description) : null);
        b.type = "button";
        b._label = o.label;
        b.classList.toggle("multi", multi);
        b.onclick = (e) => {
          e.stopPropagation();
          if (multi) {
            const v = new Set(Array.isArray(p.pick[q.question]) ? p.pick[q.question] : []);
            v.has(o.label) ? v.delete(o.label) : v.add(o.label);
            p.pick[q.question] = [...v];
          } else { p.pick[q.question] = o.label; other.value = ""; }
          mark(); sync();
        };
        opts.append(b);
      }
      other.oninput = () => {
        const t = other.value.trim();
        if (multi) {
          const v = (Array.isArray(p.pick[q.question]) ? p.pick[q.question] : []).filter((x) => (q.options || []).some((o) => o.label === x));
          p.pick[q.question] = t ? [...v, t] : v;
        } else p.pick[q.question] = t || undefined;
        mark(); sync();
      };
      other.onkeydown = (e) => { if (e.key === "Enter" && !send.disabled) { e.preventDefault(); send.click(); } };
      box.append(opts, other);
      card.append(box);
      requestAnimationFrame(mark);
    }
    const skip = h("button", "btn", "Skip");
    skip.type = "button";
    skip.onclick = (e) => { e.stopPropagation(); sendAnswer(c, m, p, { allow: false, message: "The person skipped these questions. Go on with your best judgment, and say what you assumed." }); };
    send.onclick = (e) => {
      e.stopPropagation();
      if (!ready()) return;
      p.answers = { ...p.pick };
      sendAnswer(c, m, p, { allow: true, input: { ...p.input, answers: p.answers } });
    };
    card.append(h("div", "ak-b", send, h("span", "grow"), skip));
    sync();
    return card;
  }
  function askCard(p, m) {
    if (p.name === "ExitPlanMode") return planCard(p, m);
    if (p.name === "AskUserQuestion") return questionCard(p, m);
    const [what, detail] = toolSummary(p);
    const c = D.chats.find((x) => x.messages.includes(m));
    const verb = { Bash: "run a command", PowerShell: "run a command", Write: "write a file", Edit: "edit a file", MultiEdit: "edit a file",
      WebFetch: "open a web page", WebSearch: "search the web", NotebookEdit: "edit a notebook" }[p.name] || "use " + p.name;
    if (p.state && p.state !== "waiting") {
      const ok = p.state === "allowed";
      return h("div", "ask done" + (ok ? "" : " no"), icon(ok ? "check" : "x"),
        h("span", "", ok ? (p.always ? "Allowed for this chat" : "Allowed") : p.state === "expired" ? "Not answered" : "Denied"),
        h("span", "mono", detail || what || p.name));
    }
    const answer = (allow, always) => {
      const ws = c && runs.get(c.id);
      if (!ws || ws.readyState !== 1) { p.state = "expired"; if (c) patchLast(c); return; }
      ws.send(JSON.stringify({ t: "answer", id: p.id, allow, always }));
      p.state = allow ? "allowed" : "denied";
      p.always = always;
      if (allow && always) c.allow = [...new Set([...(c.allow || []), p.key || p.name])];
      m.wait = allow ? "Running…" : "";
      patchLast(c);
      save();
    };
    const btn = (t, cls, fn) => { const b = h("button", "btn" + (cls ? " " + cls : ""), t); b.type = "button"; b.onclick = (e) => { e.stopPropagation(); fn(); }; return b; };
    const shown = detail || (what ? "" : JSON.stringify(p.input || {}).slice(0, 400));
    const card = h("div", "ask",
      h("div", "ak-h", icon("shield"), h("span", "", modelName(m.account, m.model) + " wants to " + verb), h("span", "ak-t", p.name)),
      what && what !== detail ? h("div", "ak-w", what) : null,
      shown ? h("div", "ak-c mono", shown) : null);
    const diff = toolDiff(p);
    if (diff.length) {
      const d = h("div", "diffl");
      for (const l of diff.slice(0, 40)) d.append(h("div", l[0] === "+" ? "p" : l[0] === "-" ? "m" : "", l));
      if (diff.length > 40) d.append(h("div", "dim", "… " + (diff.length - 40) + " more lines"));
      card.append(d);
    }
    card.append(h("div", "ak-b", btn("Allow", "pri", () => answer(true, false)), btn(askLabel(p), "", () => answer(true, true)),
      h("span", "grow"), btn("Deny", "deny", () => answer(false, false))));
    return card;
  }
  // ---------- Claude's task list ----------
  const TODO_MARK = { completed: "check", in_progress: null, pending: null };
  function todoList(todos, cls) {
    const ul = h("div", cls || "todo-l");
    for (const t of todos) {
      const st = t.status || "pending";
      const mark = st === "completed" ? icon("check") : st === "in_progress" ? h("span", "spin sm") : h("span", "td-o");
      ul.append(h("div", "td " + st, h("span", "td-m", mark), h("span", "td-t", st === "in_progress" && t.activeForm ? t.activeForm : t.content || "")));
    }
    return ul;
  }
  function todoCard(p, m) {
    // only the newest list in a reply is shown; it replaces the ones before
    const lists = m.parts.filter((x) => x.k === "tool" && x.name === "TodoWrite");
    if (lists[lists.length - 1] !== p) return h("span", "gone");
    const todos = (p.input && p.input.todos) || [];
    const done = todos.filter((t) => t.status === "completed").length;
    return h("div", "todo-card", h("div", "tdc-h", icon("prompt"), h("span", "", "Tasks"), h("span", "tdc-n", done + " of " + todos.length + " done"),
      h("span", "tdc-bar", h("i", "", null))), todoList(todos));
  }
  // the running reply's list, kept in sight above the box
  function drawTodos() {
    const comp = $("#composer"), c = chat();
    if (!comp || !c) return;
    let row = comp.querySelector(".todo-row");
    const m = [...c.messages].reverse().find((x) => x.role === "assistant" && x.parts);
    const lists = m ? m.parts.filter((x) => x.k === "tool" && x.name === "TodoWrite") : [];
    const todos = lists.length ? (lists[lists.length - 1].input || {}).todos || [] : [];
    const show = m && m.running && todos.length && todos.some((t) => t.status !== "completed");
    if (!show) { row?.remove(); return; }
    if (!row) { row = h("div", "todo-row"); comp.prepend(row); row.onclick = (e) => { e.stopPropagation(); row.classList.toggle("open"); }; }
    const done = todos.filter((t) => t.status === "completed").length;
    const now = todos.find((t) => t.status === "in_progress");
    row.replaceChildren(h("div", "tr-h", h("span", "spin sm"), h("span", "tr-t", now ? now.activeForm || now.content : "Working through the list"),
      h("span", "tr-n", done + "/" + todos.length), icon("chev", "chev")), todoList(todos, "todo-l tr-l"));
  }
  function partNode(p, m) {
    if (p.k === "tool" && p.name === "TodoWrite") return todoCard(p, m);
    // a question or a plan shows as its card, not also as a tool call
    if (p.k === "tool" && (p.name === "AskUserQuestion" || p.name === "ExitPlanMode") && m.parts.some((x) => x.k === "ask" && x.name === p.name)) return h("span", "gone");
    if (isAgentTool(p)) return agentCard(p);
    if (p.k === "tool" && p.name === "mcp__foxpit__browser_open") return browserCard(p);
    if (p.k === "tool" && p.name === "mcp__foxpit__new_chat") return spawnCard(p);
    if (p.k === "tool" && p.name === "mcp__foxpit__wait_chats") return waitCard(p);
    if (p.k === "ask") {
      // the card slides in once, not each time the reply is drawn again
      const n = askCard(p, m);
      if (!p.drawn && n && n.classList) { p.drawn = true; n.classList.add("ask-in"); }
      return n;
    }
    return p.k === "tool" ? toolCard(p) : p.k === "hop" ? hopNode(p) : p.k === "think" ? thinkNode(p, m) : p.k === "said" ? saidNode(p) : richText(p.text);
  }
  function liveNode(m, a) {
    const secs = m.ms ? (m.ms < 60000 ? Math.round(m.ms / 1000) + "s" : Math.floor(m.ms / 60000) + "m " + Math.round((m.ms % 60000) / 1000) + "s") : "";
    const say = m.running ? null : h("button", "say" + (voice.speaking === m ? " on" : ""), icon("speaker"));
    if (say) { say.type = "button"; say.title = "Read aloud"; say._m = m; say.onclick = (e) => { e.stopPropagation(); voice.speaking === m ? stopSpeaking() : speak(m); }; }
    const acts = [];
    const c0 = !m.running && D.chats.find((x) => x.messages.includes(m));
    if (c0) {
      const body = m.parts.filter((p) => p.k === "text").map((p) => p.text).join("\n\n").trim();
      if (body) acts.push(actBtn("copy", "Copy", (b) => copyText(body).then(() => copied(b))));
      if (!runs.has(c0.id)) {
        acts.push(actBtn("retry", "Answer again", () => retry(c0, m)));
        if (m.mid) acts.push(actBtn("branch", "Branch from here: a new chat that carries on from this reply", () => branch(c0, m)));
      }
    }
    const txt = h("div", "txt", h("div", "meta", h("b", "", modelName(m.account, m.model)), h("span", "", m.who ? m.who.split("@")[0] : a.name),
      m.when ? h("span", "", "· " + m.when) : null, secs ? h("span", "", "· " + secs) : null, say, ...acts));
    for (let i = 0; i < m.parts.length; i++) {
      const p = m.parts[i];
      if (isAgentTool(p) && isAgentTool(m.parts[i + 1])) {
        const list = [];
        while (isAgentTool(m.parts[i])) list.push(m.parts[i++]);
        i--;
        txt.append(agentGroup(list));
        continue;
      }
      txt.append(partNode(p, m));
    }
    const lastP = m.parts[m.parts.length - 1];
    if (lastP && lastP.k === "ask" && lastP.state === "waiting" && (lastP.name === "AskUserQuestion" || lastP.name === "ExitPlanMode")) m.wait = "Waiting for your answer";
    if (m.running && (!m.parts.length || lastP.k === "tool" && lastP.ok != null || lastP.k === "ask" && lastP.state !== "waiting"))
      txt.append(h("div", "", h("span", "typing", h("i"), h("i"), h("i")),
        m.wait || m.secs > 3 ? h("span", "status", (m.wait || "Working…") + (m.secs > 3 ? " · " + m.secs + "s" : "")) : null));
    if (m.error) txt.append(h("div", "errbox", m.error));
    if (m.denied && m.denied.length && !m.running) {
      const c = D.chats.find((x) => x.messages.includes(m));
      const allow = h("button", "btn pri", icon("shield"), "Allow full access and retry");
      allow.type = "button";
      allow.onclick = () => c && allowAndRetry(c, m);
      const keep = h("button", "btn", "Keep as is");
      keep.type = "button";
      keep.onclick = () => { m.denied = null; if (c) { withChat(c, renderMessages); save(); } };
      const lines = h("div", "dn-l");
      for (const d of m.denied.slice(0, 4)) lines.append(h("div", "mono", deniedLine(d)));
      txt.append(h("div", "denied", h("div", "dn-h", icon("shield"), "Claude Code was not allowed to run " + (m.denied.length === 1 ? "this" : "these " + m.denied.length)), lines, h("div", "dn-b", allow, keep)));
    }
    if (m.stopped) txt.append(h("div", "dim small", "Stopped."));
    return h("div", "as", pv(a.provider, "lg"), txt);
  }

  // A chat opened fresh plays its messages in one after another; within a
  // chat only what is new animates in.
  function renderMessages() {
    const cc = chat();
    if (cc.sub) cc.messages = subMessages(cc);
    const pane = paneOf($("#col"));
    if (pane) {
      pane.classList.toggle("is-sub", !!cc.sub);
      pane.querySelector(".sub-bar")?.remove();
      if (cc.sub) pane.querySelector('[data-id="composer"]')?.before(subBar(cc));
      pane.querySelector(".wt-bar")?.remove();
      if (cc.wt && !cc.wt.closed) pane.querySelector('[data-id="composer"]')?.before(wtBar(cc));
    }
    const col = $("#col"), msgs = cc.messages, fresh = PN().shownChat !== state.chatId;
    if (SAVES && !D.projectPath) { PN().shownChat = null; PN().shownCount = 0; return col.replaceChildren(noProject()); }
    if (!msgs.length) { PN().shownChat = state.chatId; PN().shownCount = 0; return col.replaceChildren(emptyChat()); }
    const nodes = msgs.map(msgNode);
    nodes.forEach((n, i) => {
      if (fresh) { n.classList.add("enter"); n.style.animationDelay = Math.min(i * 35, 280) + "ms"; }
      else if (i >= PN().shownCount) n.classList.add("enter");
    });
    col.replaceChildren(...nodes);
    drawQueue();
    drawTodos();
    syncDown();
    if (find.pane && find.pane === paneOf(col)) { if (fresh) closeFind(); else runFind(find.q); }
    PN().shownChat = state.chatId;
    PN().shownCount = msgs.length;
    const box = $("#msgs");
    requestAnimationFrame(() => { const m = box; m.scrollTo({ top: m.scrollHeight, behavior: fresh ? "auto" : "smooth" }); });
  }

  // ---------- right side ----------
  // the tab underlay slides to the chosen tab
  function moveTabInk() {
    const on = document.querySelector("#tabs button.on"), ink = $("#tabInk");
    if (!on || !ink) return;
    ink.style.width = on.offsetWidth + "px";
    ink.style.transform = "translateX(" + on.offsetLeft + "px)";
  }
  let shownTab = null;
  function renderSide() {
    if (widgetDrag) return;
    for (const b of document.querySelectorAll("#tabs button")) b.classList.toggle("on", b.dataset.tab === state.tab);
    moveTabInk();
    const body = $("#sideBody"), c = chat();
    body.replaceChildren();
    if (shownTab !== state.tab) { body.classList.remove("enter"); void body.offsetWidth; body.classList.add("enter"); shownTab = state.tab; }
    const usageCard = () => {
      const tog = h("button", "tog" + (D.autoSwitch ? "" : " off"));
      tog.type = "button";
      tog.title = "Auto-switch on limit";
      tog.onclick = (e) => { e.stopPropagation(); setAuto(!D.autoSwitch); };
      const cb = h("div", "cb");
      // only real accounts: before Magpie answers there is nothing to show
      if (!D.live) {
        cb.append(h("div", "dim", "Magpie isn't connected yet. Your subscriptions show here once it is."));
        return h("div", "card", h("div", "ch", "Accounts"), cb);
      }
      const rows = [];
      for (const a of D.accounts) {
        if (a.members) {
          for (const m of a.members) {
            if (m.error) { rows.push({ p: a.provider, label: a.name, note: "needs attention", pct: null, key: m.key, err: m.error }); continue; }
            const tight = m.week != null && (m.fiveHour == null || m.week > m.fiveHour);
            const pct = tight ? m.week : m.fiveHour;
            rows.push({ p: a.provider, label: m.label + (tight ? " · week" : " · 5h"), pct,
              note: pct == null ? "no reading" : pct + "%" + (m.reset ? " · resets " + m.reset : "") + (m.on ? "" : " · off"), key: m.key });
          }
        } else if (a.fiveHour != null) {
          const wk = a.provider === "codex";
          rows.push({ p: a.provider, label: wk ? "Codex · week" : a.name.replace(/^Claude · /, "") + " · 5h", pct: wk ? a.week : a.fiveHour,
            note: (wk ? a.week : a.fiveHour) + "%" + (a.id === c.account ? " · resets " + a.resetIn : ""), key: "side-" + a.id });
        }
      }
      for (const r of rows) {
        const line = h("div", "uline", h("span", "l", pv(r.p, "sm"), r.label), h("span", r.err ? "warn-t" : "muted", r.note));
        if (r.err) line.title = r.err;
        if (r.pct != null) line.append(bar(r.pct, r.key));
        cb.append(line);
      }
      cb.append(h("div", "uline", h("span", "l", "Auto-switch on limit"), tog));
      return h("div", "card", h("div", "ch", "Accounts", h("span", "badge" + (D.autoSwitch ? " acc" : ""), D.autoSwitch ? "auto-switch on" : "auto-switch off")), cb);
    };
    const changesCard = () => changesWidget();
    // the live terminal (term.js) moves into whichever tab shows it
    const term = () => {
      const t = h("div", "term live");
      if (window.FoxTerm) { window.FoxTerm.mount(t, D.projectPath); window.FoxTerm.setDir(D.projectPath); }
      else t.append(h("div", "dim", "Starting terminal…"));
      return t;
    };
    const agents = () => {
      const cb = h("div", "cb");
      for (const x of D.chats.filter((x) => x.state === "running")) {
        const a = acct(x.account);
        cb.append(h("div", "agent", h("span", "spin"), h("div", "n", x.title, h("small", "", modelName(x.account, x.model) + " · " + a.name))));
      }
      return h("div", "card", h("div", "ch", "Running agents", h("span", "muted", cb.children.length)), cb);
    };
    if (state.tab === "session") {
      const make = {
        usage: usageCard,
        changes: changesCard,
        terminal: () => h("div", "card wterm", h("div", "ch", "Terminal", h("span", "muted", D.project || "")), term()),
        agents,
        stats: usageStatsCard,
        requests: requestsCard,
      };
      const lay = widgetLayout();
      for (const id of lay.order) {
        if (lay.hidden.includes(id) || !make[id]) continue;
        body.append(widget(id, make[id](), lay.folded.includes(id)));
      }
      const gone = WIDGET_IDS.filter((id) => lay.hidden.includes(id));
      if (gone.length) {
        const add = h("div", "w-add");
        for (const id of gone) {
          const b = h("button", "", icon("plus"), WIDGET_NAMES[id]);
          b.type = "button";
          b.onclick = () => { setLayout((l) => { l.hidden = l.hidden.filter((x) => x !== id); }); renderSide(); };
          add.append(b);
        }
        body.append(add);
      }
    }
    if (state.tab === "changes") body.append(changesTab());
    if (state.tab === "terminal") { const t = term(); t.classList.add("fill"); body.append(t); setTimeout(() => window.FoxTerm?.focus(), 30); }
    if (state.tab === "agents") body.append(agents());
    if (state.tab === "github") body.append(githubTab());
  }

  // ---------- Magpie usage and recent calls (side widgets) ----------
  const mp = { usage: {}, requests: null, at: {}, busy: {} };
  let mpPeriod = (() => { try { return localStorage.getItem("foxpit.usagePeriod") || "today"; } catch { return "today"; } })();
  const fmtN = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + "B" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e4 ? Math.round(n / 1e3) + "k" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(Math.round(n || 0)));
  const ago = (t) => {
    const s = Math.max(0, (Date.now() - new Date(t)) / 1000);
    return s < 60 ? Math.round(s) + "s" : s < 3600 ? Math.round(s / 60) + "m" : s < 86400 ? Math.round(s / 3600) + "h" : Math.round(s / 86400) + "d";
  };
  // fetch what a widget shows when it is older than 30s, then redraw
  async function mpLoad(key, url) {
    if (!SAVES || mp.busy[key] || Date.now() - (mp.at[key] || 0) < 30000) return;
    mp.busy[key] = true;
    try {
      const v = await fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(r)));
      if (key === "requests") mp.requests = v.rows || []; else mp.usage[key.slice(2)] = v;
      mp.at[key] = Date.now();
      if (state.tab === "session") renderSide();
    } catch {} finally { mp.busy[key] = false; }
  }
  function mpStale() { mp.at = {}; }
  function usageStatsCard() {
    const u = mp.usage[mpPeriod];
    mpLoad("u:" + mpPeriod, "/api/magpie/usage?period=" + mpPeriod);
    const seg = h("div", "seg");
    for (const [k, label] of [["today", "Today"], ["7d", "7 days"], ["30d", "30 days"]]) {
      const b = h("button", k === mpPeriod ? "on" : "", label);
      b.type = "button";
      b.onclick = (e) => { e.stopPropagation(); mpPeriod = k; try { localStorage.setItem("foxpit.usagePeriod", k); } catch {} renderSide(); };
      seg.append(b);
    }
    const cb = h("div", "cb", seg);
    if (!u) cb.append(h("div", "dim", SAVES ? "Reading Magpie…" : "Usage shows in the Foxpit app."));
    else {
      const tokens = (u.input || 0) + (u.output || 0) + (u.cache_read || 0) + (u.cache_write || 0);
      cb.append(h("div", "stats",
        h("div", "st", h("b", "", fmtN(u.calls || 0)), h("span", "", "requests"), u.errors ? h("em", "", u.errors + " failed") : null),
        h("div", "st", h("b", "", fmtN(tokens)), h("span", "", "tokens"), h("em", "dim", fmtN(u.output || 0) + " out")),
        h("div", "st", h("b", "", "$" + (u.cost || 0).toFixed((u.cost || 0) < 10 ? 2 : 0)), h("span", "", "at API prices"))));
      const series = (u.series || []).slice(-30), top = Math.max(1, ...series.map((x) => x.calls || 0));
      const spark = h("div", "spark");
      for (const x of series) {
        const b = h("i", x.errors ? "err" : "");
        b.style.height = Math.max(2, Math.round(((x.calls || 0) / top) * 100)) + "%";
        b.title = x.label + " · " + (x.calls || 0) + " requests · $" + (x.cost || 0).toFixed(2);
        spark.append(b);
      }
      cb.append(spark);
    }
    return h("div", "card", h("div", "ch", "Usage", h("span", "muted", "through Magpie")), cb);
  }
  const openReq = new Set();
  function requestsCard() {
    mpLoad("requests", "/api/magpie/requests?limit=8");
    const cb = h("div", "cb rq");
    const rows = mp.requests;
    if (!rows) cb.append(h("div", "dim", SAVES ? "Reading Magpie…" : "Recent calls show in the Foxpit app."));
    else if (!rows.length) cb.append(h("div", "dim", "No calls yet."));
    else for (const x of rows.slice(0, 8)) {
      const bad = x.status >= 400 && !x.canceled, cut = x.canceled;
      const key = String(x.route_id || x.t);
      const row = h("button", "rq-r" + (openReq.has(key) ? " open" : ""),
        h("span", "rq-s " + (bad ? "bad" : cut ? "cut" : "ok")),
        h("span", "rq-m", x.served || x.model || x.req || "?"),
        h("span", "rq-a", (x.providerAccount || "").split("@")[0]),
        h("span", "rq-t", x.ms ? (x.ms < 10000 ? (x.ms / 1000).toFixed(1) : Math.round(x.ms / 1000)) + "s" : ""),
        h("span", "rq-w", ago(x.t)));
      row.type = "button";
      row.title = (x.agentName || x.agent || "") + " · " + (x.host || "");
      const more = h("div", "rq-d",
        h("div", "", (x.agentName || x.agent || "") + (x.effort ? " · " + x.effort : "") + " · " + fmtN((x.in || 0) + (x.cache_read || 0)) + " in · " + fmtN(x.out || 0) + " out" + (x.cost ? " · $" + x.cost.toFixed(3) : "")),
        x.err ? h("div", bad ? "warn-t" : "dim", x.err) : null);
      row.onclick = (e) => { e.stopPropagation(); openReq.has(key) ? openReq.delete(key) : openReq.add(key); renderSide(); };
      cb.append(row);
      if (openReq.has(key)) cb.append(more);
    }
    return h("div", "card", h("div", "ch", "Requests", h("span", "muted", "latest")), cb);
  }

  // ---------- Changes: git status, a file's diff, commit ----------
  const gitCh = { dir: "", repo: null, files: [], at: 0, busy: false, err: "", sel: "", diff: null, diffFor: "" };
  async function loadChanges(force) {
    if (!SAVES || !gitDir() || gitCh.busy) return;
    if (!force && gitCh.dir === gitDir() && Date.now() - gitCh.at < 8000) return;
    gitCh.busy = true;
    const dir = gitDir();
    try {
      const r = await fetch("/api/project/changes?dir=" + encodeURIComponent(dir)).then((x) => x.json());
      if (dir !== gitDir()) return;
      const before = JSON.stringify([gitCh.dir, gitCh.files, gitCh.repo]);
      if (gitCh.dir !== dir) { gitCh.sel = ""; gitCh.diff = null; }
      Object.assign(gitCh, { dir, repo: r.repo, files: r.files || [], err: r.error || "", at: Date.now() });
      if (gitCh.sel && !gitCh.files.some((f) => f.path === gitCh.sel)) { gitCh.sel = ""; gitCh.diff = null; }
      if (JSON.stringify([gitCh.dir, gitCh.files, gitCh.repo]) !== before && (state.tab === "changes" || state.tab === "session")) renderSide();
    } catch {} finally { gitCh.busy = false; }
  }
  async function loadDiff(path) {
    gitCh.sel = path; gitCh.diff = null; gitCh.diffFor = path;
    renderSide();
    try {
      const r = await fetch("/api/project/diff?dir=" + encodeURIComponent(gitDir()) + "&path=" + encodeURIComponent(path)).then((x) => x.json());
      if (gitCh.diffFor !== path) return;
      gitCh.diff = r.error ? { error: r.error } : { text: r.diff || "" };
    } catch { gitCh.diff = { error: "Could not read the diff." }; }
    if (state.tab === "changes") renderSide();
  }
  const ST = { M: ["M", "mod", "Modified"], A: ["A", "add", "Added"], "?": ["U", "add", "New, not tracked yet"], D: ["D", "del", "Deleted"], R: ["R", "ren", "Renamed"], C: ["C", "ren", "Copied"], U: ["!", "del", "Conflict"] };
  function fileRow(f, onPick) {
    const st = ST[f.Status || f.status] || [f.status, "mod", f.status];
    const slash = f.path.lastIndexOf("/");
    const b = h("button", "cf" + (gitCh.sel === f.path ? " sel" : ""), h("span", "cf-s " + st[1], st[0]),
      h("span", "cf-p", slash >= 0 ? h("span", "dim", f.path.slice(0, slash + 1)) : null, f.path.slice(slash + 1)),
      f.add || f.del ? h("span", "cf-n", f.add ? h("span", "p", "+" + f.add) : null, f.del ? h("span", "m", " −" + f.del) : null) : null);
    b.type = "button";
    b.title = st[2] + " · " + f.path;
    b.onclick = (e) => { e.stopPropagation(); onPick(f); };
    return b;
  }
  function changesHead(extra) {
    const n = gitCh.files.length, add = gitCh.files.reduce((x, f) => x + (f.add || 0), 0), del = gitCh.files.reduce((x, f) => x + (f.del || 0), 0);
    const re = h("button", "w-btn ch-re", icon("swap"));
    re.type = "button"; re.title = "Refresh";
    re.onclick = (e) => { e.stopPropagation(); re.classList.add("spin1"); loadChanges(true); };
    return h("div", "ch", "Changes", h("span", "muted", n ? n + (n === 1 ? " file" : " files") + (add || del ? " · " : "") : gitCh.repo === false ? "" : "clean", add ? h("span", "p", "+" + add) : null, del ? h("span", "m", " −" + del) : null), re, extra || null);
  }
  function changesEmpty(cb) {
    if (!SAVES) cb.append(h("div", "dim", "Changes show in the Foxpit app."));
    else if (!D.projectPath) cb.append(h("div", "dim", "Open a project folder first."));
    else if (gitCh.repo === null || gitCh.dir !== gitDir()) cb.append(h("div", "dim", "Reading git…"));
    else if (gitCh.repo === false) cb.append(h("div", "dim", "This folder is not a git repository."));
    else if (gitCh.err) cb.append(h("div", "warn-t", gitCh.err));
    else if (!gitCh.files.length) cb.append(h("div", "dim", "Nothing changed since the last commit."));
    else return false;
    return true;
  }
  // the Session tab's card: the list, a file opens the Changes tab
  function changesWidget() {
    loadChanges();
    const cb = h("div", "cb cfl");
    if (!changesEmpty(cb)) {
      for (const f of gitCh.files.slice(0, 7)) cb.append(fileRow(f, (x) => { state.tab = "changes"; loadDiff(x.path); }));
      const more = gitCh.files.length - 7;
      const rev = h("button", "btn", more > 0 ? "Review all " + gitCh.files.length + " files" : "Review and commit");
      rev.type = "button";
      rev.onclick = (e) => { e.stopPropagation(); state.tab = "changes"; renderSide(); };
      cb.append(h("div", "cf-foot", rev));
    }
    return h("div", "card", changesHead(), cb);
  }
  // the Changes tab: list, the picked file's diff, a commit box
  let commitDraft = "";
  function changesTab() {
    loadChanges();
    const wrap = h("div", "chtab");
    const cb = h("div", "cb cfl");
    const empty = changesEmpty(cb);
    if (!empty) for (const f of gitCh.files) cb.append(fileRow(f, (x) => loadDiff(x.path)));
    wrap.append(h("div", "card", changesHead(), cb));
    if (!empty && gitCh.sel) {
      const dv = h("div", "diffv");
      if (!gitCh.diff) dv.append(h("div", "dim", "Reading the diff…"));
      else if (gitCh.diff.error) dv.append(h("div", "warn-t", gitCh.diff.error));
      else {
        let ol = 0, nl = 0;
        for (const l of gitCh.diff.text.split("\n")) {
          if (/^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(l)) continue;
          const hm = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(l);
          if (hm) { ol = +hm[1]; nl = +hm[2]; dv.append(h("div", "dl hunk", h("span", "ln", ""), h("span", "ln", ""), h("span", "tx", l.replace(/^@@[^@]*@@\s?/, "") || "…"))); continue; }
          if (l.startsWith("@@")) continue;
          const k = l[0], body = l.slice(1);
          if (k === "+") dv.append(h("div", "dl add", h("span", "ln", ""), h("span", "ln", nl++), h("span", "tx", body)));
          else if (k === "-") dv.append(h("div", "dl del", h("span", "ln", ol++), h("span", "ln", ""), h("span", "tx", body)));
          else if (k === " ") dv.append(h("div", "dl", h("span", "ln", ol++), h("span", "ln", nl++), h("span", "tx", body)));
          else if (l === "Binary file" || l.startsWith("Binary")) dv.append(h("div", "dim", "Binary file"));
        }
        if (!dv.children.length) dv.append(h("div", "dim", "No line changes."));
      }
      const close = h("button", "w-btn", icon("x"));
      close.type = "button"; close.title = "Close the diff";
      close.onclick = (e) => { e.stopPropagation(); gitCh.sel = ""; gitCh.diff = null; renderSide(); };
      wrap.append(h("div", "card diffcard", h("div", "ch", h("span", "mono dpath", gitCh.sel), close), dv));
    }
    if (!empty) {
      const ta = h("textarea", "cmsg");
      ta.rows = 2; ta.placeholder = "Commit message"; ta.value = commitDraft;
      ta.oninput = () => { commitDraft = ta.value; go.disabled = !ta.value.trim(); };
      ta.onkeydown = (e) => { if (e.key === "Enter" && mod(e)) { e.preventDefault(); go.click(); } };
      const go = h("button", "btn pri", "Commit " + gitCh.files.length + (gitCh.files.length === 1 ? " file" : " files"));
      go.type = "button"; go.disabled = !commitDraft.trim();
      go.onclick = async () => {
        const msg = ta.value.trim();
        if (!msg) return;
        go.disabled = true; go.textContent = "Committing…";
        let r;
        try { r = await fetch("/api/project/commit", { method: "POST", body: JSON.stringify({ dir: gitDir(), message: msg }) }).then((x) => x.json()); }
        catch { r = { error: "Could not reach Foxpit's backend." }; }
        if (r.error) { flash(r.error.split("\n")[0]); go.disabled = false; go.textContent = "Commit"; return; }
        commitDraft = ""; gitCh.sel = ""; gitCh.diff = null;
        flash("Committed: " + (r.ok || msg).split("\n")[0]);
        await loadChanges(true); refreshGit(); renderSide();
      };
      wrap.append(h("div", "card commitbox", h("div", "cb", ta, h("div", "cm-row", h("span", "dim", "All changes in " + D.project + " · " + kb("Ctrl+Enter")), go))));
    }
    return wrap;
  }

  // ---------- images: pasted or dropped into a composer, shown in the chat ----------
  // A picture goes to Claude Code as an image (stream-json input), at most
  // 2000px and under the API's 5MB; the chat keeps a small copy to show.
  const MAX_SIDE = 2000;
  function loadImage(src) {
    return new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = src; });
  }
  function readAsDataURL(blob) {
    return new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = no; r.readAsDataURL(blob); });
  }
  async function scaled(src, side, type, q) {
    const img = await loadImage(src);
    const k = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
    const cv = document.createElement("canvas");
    cv.width = Math.max(1, Math.round(img.naturalWidth * k)); cv.height = Math.max(1, Math.round(img.naturalHeight * k));
    cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
    return { url: cv.toDataURL(type, q), w: img.naturalWidth, h: img.naturalHeight };
  }
  const thumbOf = async (src) => (await scaled(src, 480, "image/jpeg", 0.82)).url;
  async function attachImage(file) {
    if (!file || !/^image\/(png|jpe?g|gif|webp)$/.test(file.type)) { flash("Only PNG, JPEG, GIF or WebP images."); return; }
    const here = cur, src = await readAsDataURL(file);
    let media = file.type, data = src.split(",")[1];
    const big = await loadImage(src);
    if (file.size > 3.5e6 || Math.max(big.naturalWidth, big.naturalHeight) > MAX_SIDE) {
      const s = await scaled(src, MAX_SIDE, "image/jpeg", 0.88);
      media = "image/jpeg"; data = s.url.split(",")[1];
    }
    const thumb = await thumbOf(src);
    const p = panes[here];
    if (!p) return;
    (p.att = p.att || []).push({ media, data, thumb, name: file.name || "image", orig: src });
    inPane(here, drawAttachments);
  }
  function drawAttachments() {
    const comp = $("#composer"), att = PN().att || [];
    let row = comp.querySelector(".att-row");
    if (!att.length) { row?.remove(); return; }
    if (!row) { row = h("div", "att-row"); comp.prepend(row); }
    row.replaceChildren();
    att.forEach((a, i) => {
      const x = h("button", "att-x", icon("x"));
      x.type = "button"; x.title = "Remove";
      const here = cur;
      x.onclick = (e) => { e.stopPropagation(); panes[here].att.splice(i, 1); inPane(here, drawAttachments); };
      if (a.kind === "video") {
        const tile = h("div", "att att-vid" + (a.loading ? " loading" : ""));
        if (a.loading) tile.append(h("span", "att-spin"), h("span", "att-lbl", "Reading video…"));
        else {
          const img = h("img"); img.src = a.poster; img.alt = a.name;
          img.onclick = () => videoLightbox(clips.get(a.id), a.poster);
          tile.append(img, h("span", "clip-play", icon("play")), h("span", "clip-dur", fmtDur(a.dur) + " · " + a.frames.length + " frames"));
        }
        tile.title = a.name;
        tile.append(x);
        row.append(tile);
        return;
      }
      const img = h("img"); img.src = a.thumb; img.alt = a.name;
      img.onclick = () => lightbox(a.thumb, ["data:" + a.media + ";base64," + a.data]);
      row.append(h("div", "att", img, x));
    });
  }
  // a picture full size, Esc or a click closes it
  function lightbox(src, full) {
    const big = h("img"); big.src = (full && full[0]) || src;
    const box = h("div", "lightbox", big);
    const close = () => { box.classList.add("out"); setTimeout(() => box.remove(), 160); document.removeEventListener("keydown", esc, true); };
    const esc = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    box.onclick = close;
    document.addEventListener("keydown", esc, true);
    document.body.append(box);
  }
  // the small preview shows in the chat; a click opens the picture at full size
  function saidNode(p) {
    return h("div", "said" + (p.sent ? "" : " sending"), h("div", "u" + (p.images && p.images.length ? " has-img" : ""),
      p.images && p.images.length ? imgGrid(p.images, "imgs u-imgs", p.full) : null, p.text ? h("div", "", p.text) : null));
  }
  function imgGrid(list, cls, full) {
    const g = h("div", cls || "imgs");
    list.forEach((src, k) => {
      const i = h("img"); i.src = src; i.loading = "lazy";
      const big = full && full[k];
      i.onclick = (e) => { e.stopPropagation(); lightbox(src, big ? [big] : null); };
      g.append(i);
    });
    return g;
  }
  // a picture kept at full size in Foxpit's cache: its address, or "" (the preview stays)
  async function keepFull(src, media) {
    try {
      let data = src;
      if (/^data:/.test(src)) { media = src.slice(5, src.indexOf(";")); data = src.split(",")[1]; }
      if (!SAVES || !data) return "";
      const r = await fetch("/api/project/media", { method: "POST", body: JSON.stringify({ media, data }) });
      return r.ok ? (await r.json()).url || "" : "";
    } catch { return ""; }
  }
  // a picture a reply points at: a web address, or a file in the project
  function imageSrc(u) {
    if (/^(https?:|data:image\/)/i.test(u)) return u;
    if (!SAVES || !D.projectPath) return "";
    return "/api/project/file?dir=" + encodeURIComponent(D.projectPath) + "&path=" + encodeURIComponent(u.replace(/^file:\/\/\/?/i, ""));
  }

  // ---------- voice: Windows voice typing in, the system's voices out ----------
  // The page can't hear by itself here (WebView2 has no speech recognition),
  // so the mic opens Windows voice typing (Win+H) into the focused box.
  // Voice chat goes round: you talk, a pause sends, the reply is read out,
  // then the mic opens again.
  const voice = { on: false, pane: -1, chatId: "", watch: 0, last: 0, val: "", speaking: null, lastMic: 0 };
  async function dictate() {
    const input = $("#input");
    input.focus();
    voice.lastMic = Date.now();
    try {
      const r = await fetch("/api/voice/dictate", { method: "POST" });
      if (!r.ok) flash(r.status === 501 ? "Voice typing is a Windows feature." : "Could not start voice typing.");
    } catch { flash("Voice typing works in the Foxpit app."); }
  }
  // what the voices read: no code, no markup
  function speakable(m) {
    const t = (m.parts || []).filter((p) => p.k === "text").map((p) => p.text).join("\n\n") || m.text || "";
    return t.replace(/```[\s\S]*?```/g, " (code) ").replace(/`([^`]+)`/g, "$1").replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[*_#>|]/g, "").replace(/https?:\/\/\S+/g, "link").replace(/\n{2,}/g, ". ").trim();
  }
  function pickVoice(text) {
    const vs = speechSynthesis.getVoices();
    if (S().voice) { const own = vs.find((v) => v.name === S().voice); if (own) return own; }
    const tr = /[çğıöşüÇĞİÖŞÜ]/.test(text) || /\b(ve|bir|bu|için|ile|değil|evet)\b/i.test(text);
    const want = tr ? "tr" : "en";
    return vs.find((v) => v.lang.toLowerCase().startsWith(want) && /natural|online/i.test(v.name)) || vs.find((v) => v.lang.toLowerCase().startsWith(want)) || null;
  }
  function speak(m) {
    return new Promise((done) => {
      speechSynthesis.cancel();
      const text = speakable(m);
      if (!text) return done();
      const u = new SpeechSynthesisUtterance(text.slice(0, 6000));
      const v = pickVoice(text);
      if (v) { u.voice = v; u.lang = v.lang; }
      u.rate = S().rate || 1.04;
      voice.speaking = m;
      const end = () => { if (voice.speaking === m) voice.speaking = null; refreshSpeakers(); done(); };
      u.onend = end; u.onerror = end;
      speechSynthesis.speak(u);
      refreshSpeakers();
    });
  }
  function stopSpeaking() { voice.speaking = null; speechSynthesis.cancel(); refreshSpeakers(); }
  function refreshSpeakers() {
    document.querySelectorAll(".say").forEach((b) => b.classList.toggle("on", !!voice.speaking && b._m === voice.speaking));
  }
  function setVoice(on) {
    voice.on = on;
    clearInterval(voice.watch);
    if (!on) { stopSpeaking(); voice.pane = -1; document.querySelectorAll(".composer").forEach((c) => c.classList.remove("voice-on")); return; }
    voice.pane = cur;
    voice.chatId = state.chatId;
    $("#composer").classList.add("voice-on");
    listen();
    // a pause after speaking sends what was said
    voice.watch = setInterval(() => {
      if (!voice.on) return;
      const p = panes[voice.pane];
      if (!p || p.chatId !== voice.chatId) return setVoice(false);
      inPane(voice.pane, () => {
        const input = $("#input"), v = input.value.trim();
        if (v !== voice.val) { voice.val = v; voice.last = Date.now(); return; }
        if (v && Date.now() - voice.last > (S().pause || 2000) && !runs.has(voice.chatId) && !voice.speaking) { voice.val = ""; $("#composer").requestSubmit(); }
      });
    }, 300);
  }
  function listen() { if (voice.on) inPane(voice.pane, dictate); }
  // a reply that finished in the voice chat is read, then the mic opens again
  function voiceReply(c, m) {
    if (!voice.on || c.id !== voice.chatId || m.error || m.stopped) return;
    speak(m).then(() => { if (voice.on && Date.now() - voice.lastMic > 1500) listen(); });
  }

  // ---------- videos: Claude sees frames, the chat plays the clip ----------
  // Claude Code takes pictures, not video, so a clip goes in as evenly spaced
  // frames (at most 8, 1280px) with a line saying where each one is.
  const VIDEO_RE = /\.(mp4|m4v|webm|mov|ogv)$/i, IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;
  const isVideoFile = (f) => /^video\//.test(f.type) || VIDEO_RE.test(f.name || "");
  const isImageFile = (f) => /^image\//.test(f.type) || IMAGE_RE.test(f.name || "");
  const clips = new Map(); // id -> playable url, for this run of the app
  const fmtDur = (s) => (s >= 60 ? Math.floor(s / 60) + ":" + String(Math.round(s % 60)).padStart(2, "0") : s.toFixed(s < 10 ? 1 : 0) + "s");
  function seekTo(v, t) {
    return new Promise((ok) => { const done = () => { v.removeEventListener("seeked", done); ok(); }; v.addEventListener("seeked", done); v.currentTime = t; });
  }
  async function videoFrames(src) {
    const v = document.createElement("video");
    v.muted = true; v.preload = "auto"; v.playsInline = true; v.crossOrigin = "anonymous";
    v.src = src;
    await new Promise((ok, no) => { v.onloadeddata = ok; v.onerror = () => no(new Error("format")); setTimeout(() => no(new Error("timeout")), 15000); });
    let d = v.duration;
    if (!isFinite(d) || d <= 0) { await seekTo(v, 1e7); d = v.currentTime || 1; }
    const n = Math.max(1, Math.min(8, Math.round(d / 1.5)));
    const k = Math.min(1, 1280 / Math.max(v.videoWidth, v.videoHeight));
    const cv = document.createElement("canvas");
    cv.width = Math.max(1, Math.round(v.videoWidth * k)); cv.height = Math.max(1, Math.round(v.videoHeight * k));
    const g = cv.getContext("2d"), frames = [];
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? Math.min(d / 2, 0.5) : (d * (i + 0.5)) / n;
      await seekTo(v, t);
      g.drawImage(v, 0, 0, cv.width, cv.height);
      frames.push({ media: "image/jpeg", data: cv.toDataURL("image/jpeg", 0.8).split(",")[1], t });
    }
    const poster = await thumbOf("data:image/jpeg;base64," + frames[0].data);
    const w = v.videoWidth, hh = v.videoHeight;
    v.removeAttribute("src"); v.load();
    return { frames, dur: d, w, h: hh, poster };
  }
  async function attachVideo(src, name) {
    const here = cur;
    const id = "v" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const p0 = panes[here];
    if (!p0) return;
    const slot = { kind: "video", id, name, loading: true };
    (p0.att = p0.att || []).push(slot);
    inPane(here, drawAttachments);
    try {
      const f = await videoFrames(src);
      Object.assign(slot, f, { loading: false });
      clips.set(id, src);
    } catch (e) {
      p0.att.splice(p0.att.indexOf(slot), 1);
      flash(e.message === "format" ? "Can't read this video. MP4 (H.264) or WebM works." : "The video took too long to open.");
    }
    if (panes[here] === p0) inPane(here, drawAttachments);
  }
  // any file the user hands over: pictures and videos are read here, the rest go in as @paths
  function attachFile(file) {
    if (isVideoFile(file)) return attachVideo(URL.createObjectURL(file), file.name || "video");
    if (isImageFile(file)) return attachImage(file);
    return null;
  }
  function addPaths(here, files) {
    if (!files.length) return;
    const rel = (f) => {
      const root = (D.projectPath || "").replace(/[\\/]+$/, "");
      const inside = root && f.toLowerCase().startsWith(root.toLowerCase() + "\\");
      const p = inside ? f.slice(root.length + 1) : f;
      return "@" + (/\s/.test(p) ? '"' + p + '"' : p);
    };
    const add = files.map(rel).join(" ");
    inPane(here, () => {
      const input = $("#input");
      input.value = (input.value && !/\s$/.test(input.value) ? input.value + " " : input.value) + add + " ";
      input.dispatchEvent(new Event("input"));
      input.focus();
    });
  }
  // a file dropped on the window: its path comes from the native side
  let dropSeq = -1;
  const peekDrops = () => fetch("/api/project/dropped").then((r) => r.json()).then((r) => { dropSeq = r.seq; }).catch(() => {});
  peekDrops();
  async function droppedPaths(names) {
    try {
      const r = await fetch("/api/project/dropped?after=" + dropSeq).then((x) => x.json());
      dropSeq = r.seq;
      const want = new Set(names.map((n) => n.toLowerCase()));
      return (r.files || []).filter((f) => want.has(f.split(/[\\/]/).pop().toLowerCase()));
    } catch { return []; }
  }
  function videoLightbox(src, poster) {
    const v = h("video");
    v.controls = true; v.autoplay = true; v.src = src; if (poster) v.poster = poster;
    v.onclick = (e) => e.stopPropagation();
    const box = h("div", "lightbox", v);
    const close = () => { v.pause(); box.classList.add("out"); setTimeout(() => box.remove(), 160); document.removeEventListener("keydown", esc, true); };
    const esc = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    box.onclick = close;
    document.addEventListener("keydown", esc, true);
    document.body.append(box);
  }
  // a clip in a message: plays while the app has it, else its frames
  function clipNode(c) {
    const src = c.src || clips.get(c.id);
    const tile = h("button", "clip" + (src ? "" : " gone"));
    tile.type = "button";
    const img = h("img"); img.src = c.poster; img.alt = c.name;
    tile.append(img, h("span", "clip-play", icon("play")), h("span", "clip-dur", fmtDur(c.dur || 0)));
    tile.title = c.name + (src ? "" : " (frames only: the clip was from an earlier session)");
    tile.onclick = (e) => { e.stopPropagation(); src ? videoLightbox(src, c.poster) : c.thumbs && c.thumbs.length ? lightbox(c.thumbs[0], c.thumbs) : lightbox(c.poster); };
    const wrap = h("div", "clip-wrap", tile);
    if (c.thumbs && c.thumbs.length > 1) {
      const strip = h("div", "clip-strip");
      for (const t of c.thumbs) { const i = h("img"); i.src = t; i.onclick = (e) => { e.stopPropagation(); lightbox(t); }; strip.append(i); }
      wrap.append(strip);
    }
    return wrap;
  }

  // ---------- Magpie: the accounts, models, usage and settings behind every chat ----------
  // Claude chats run in one of Magpie's Claude account folders, picked here
  // (Claude Code's own sign-in on this computer is left alone). ChatGPT goes
  // through Magpie, so picking one switches Magpie's ChatGPT account.
  const MPA = { list: null, err: "", busy: false, pending: 0 };
  const mpv = { open: false, tab: "accounts", views: null, update: false, settingsOpen: false, status: null, autostart: null, editing: "", frame: null, frameState: "" };
  const AG = { claude: ["Claude", "#d97757", "C"], codex: ["ChatGPT", "#10a37f", "G"], gemini: ["Gemini", "#4285f4", "G"],
    antigravity: ["Antigravity", "#4285f4", "A"], "commandcode-plan": ["Command Code", "#8b5cf6", "⌘"], copilot: ["Copilot", "#6e7681", "C"] };
  const AG_ORDER = ["claude", "codex", "gemini", "antigravity"];
  const SIGNS = new Set(["claude", "codex", "gemini", "antigravity", "copilot"]);
  const agName = (a) => (AG[a] || [a])[0];
  function avatar(agent, big) {
    const g = AG[agent] || [agent, "#5b6270", (agent[0] || "?").toUpperCase()];
    const s = h("span", "mp-av" + (big ? " big" : ""), g[2]);
    s.style.background = g[1];
    return s;
  }
  const label = (a) => a.alias || a.user;
  // how much room is left: full and green, running out and red
  function leftBar(rem) {
    const b = h("div", "lbar"), i = h("i");
    const r = Math.max(0, Math.min(100, rem));
    i.style.width = r + "%";
    i.style.background = r > 40 ? "#3ecf8e" : r > 15 ? "#ffb84d" : "#ff5d5d";
    b.append(i);
    return b;
  }
  function tight(a) { let t = null; for (const w of a.windows || []) if (!t || w.remaining < t.remaining) t = w; return t; }
  const isFull = (a) => (a.windows || []).some((w) => w.remaining <= 0.5);
  function fmtReset(iso) {
    if (!iso) return "";
    const d = new Date(iso), now = new Date();
    if (isNaN(d)) return "";
    const day = d.toDateString() === now.toDateString() ? "today" : d - now < 6 * 864e5 ? d.toLocaleDateString("en-US", { weekday: "short" }) : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    return day + " " + d.toTimeString().slice(0, 5);
  }
  // what stops an account, and the one thing that fixes it
  function problem(a) {
    if (a.agent === "gemini" && /antigravity/i.test(a.error || ""))
      return { why: "Google closed Gemini CLI sign-in for personal accounts. Connect the same Google account through Antigravity.", fix: "Connect", act: () => signIn("antigravity"), main: true };
    if (a.lapsed) return SIGNS.has(a.agent) ? { why: a.lapsed.replace(/;? ?sign in again in magpie/i, "."), fix: "Sign in again", act: () => signIn(a.agent) }
      : { why: a.lapsed, fix: "Open Magpie", act: openMagpie };
    if (a.error) return { why: a.error.replace(/^not read yet: /, ""), fix: "Open Magpie", act: openMagpie };
    if (!a.on) return { why: "Switched off in Magpie.", fix: "Open Magpie", act: openMagpie };
    return null;
  }
  function claudeInUse() {
    const ok = (MPA.list || []).filter((a) => a.agent === "claude" && a.here && !problem(a));
    const want = ok.find((a) => a.user === D.claudeUser);
    if (want && (!isFull(want) || D.autoSwitch === false)) return want;
    return ok.slice().sort((x, y) => isFull(x) - isFull(y) || (tight(x)?.used || 0) - (tight(y)?.used || 0))[0] || null;
  }
  function inUse(a) {
    if (a.agent === "claude") { const c = claudeInUse(); return !!c && c.user === a.user; }
    return a.active && !problem(a);
  }
  async function loadAccounts(fresh) {
    if (!SAVES || MPA.busy) return;
    MPA.busy = true;
    try {
      const r = await fetch("/api/magpie/accounts" + (fresh ? "?fresh=1" : "")).then((x) => x.json());
      if (r.error) MPA.err = r.error; else { MPA.list = r.accounts || []; MPA.err = ""; }
    } catch { MPA.err = "Magpie did not answer."; }
    MPA.busy = false;
    renderAcctPill();
    if ($("#acctPop")) drawAcctPop();
    if (mpv.open) renderMp();
  }
  async function post(url, body) {
    try {
      const r = await fetch(url, { method: "POST", body: body ? JSON.stringify(body) : undefined });
      const v = await r.json().catch(() => ({}));
      if (!r.ok || v.error) { flash((v.error || "Magpie did not answer.").trim().split("\n")[0]); return null; }
      return v;
    } catch { flash("Magpie is in the Foxpit app."); return null; }
  }
  async function signIn(agent) {
    if (await post("/api/magpie/accounts/add?agent=" + agent)) {
      MPA.pending = Date.now();
      flash("Magpie's sign-in opened in its own window. Finish it in the browser; Foxpit updates when you come back.");
    }
  }
  async function openMagpie() { if (await post("/api/magpie/open")) flash("Opening Magpie…"); }
  async function useAccount(a) {
    if (a.agent === "claude") {
      D.claudeUser = a.user;
      save();
      flash("Claude chats in Foxpit now run on " + label(a) + ".");
      renderAcctPill();
      if ($("#acctPop")) drawAcctPop();
      if (mpv.open) renderMp();
      return;
    }
    if (a.agent === "codex") {
      flash("Switching ChatGPT to " + label(a) + "…");
      if (await post("/api/magpie/accounts/switch", { agent: "codex", user: a.user })) { flash("ChatGPT now runs on " + label(a) + "."); loadAccounts(true); }
    }
  }
  function setAuto(on) {
    D.autoSwitch = on;
    save();
    renderSide();
    renderAcctPill();
    if ($("#acctPop")) drawAcctPop();
    if (mpv.open) renderMp();
  }
  function autoToggle() {
    const t = h("button", "tog" + (D.autoSwitch !== false ? "" : " off"));
    t.type = "button";
    t.title = "When an account has no room left, the next chat runs on another one";
    t.onclick = (e) => { e.stopPropagation(); setAuto(D.autoSwitch === false); };
    return t;
  }
  // the account the current chat's model runs on
  function pillAccount() {
    const list = MPA.list || [];
    const prov = (acct(chat().account) || {}).provider;
    if (prov === "codex" || prov === "gemini") return list.find((a) => a.agent === prov && a.active) || list.find((a) => a.agent === prov) || null;
    return claudeInUse() || list.find((a) => a.agent === "claude") || null;
  }
  function renderAcctPill() {
    const b = $("#acctPill");
    if (!b) return;
    const list = MPA.list;
    const a = list && pillAccount();
    const issues = (list || []).filter((x) => problem(x) && AG_ORDER.includes(x.agent)).length;
    b.replaceChildren();
    if (!a) { b.append(icon("user"), h("span", "nm", list ? "Accounts" : SAVES ? "Accounts…" : "Accounts")); }
    else {
      const t = tight(a), left = t ? Math.round(t.remaining) : null;
      const ring = h("span", "ring");
      ring.style.setProperty("--p", (left == null ? 0 : left) + "%");
      ring.style.setProperty("--c", left == null ? "var(--dim)" : left > 40 ? "#3ecf8e" : left > 15 ? "#ffb84d" : "#ff5d5d");
      b.append(avatar(a.agent), h("span", "nm", label(a).split("@")[0]), ring, left != null ? h("span", "pc", left + "%") : null);
    }
    if (issues) { const d = h("span", "dot", String(issues)); d.title = issues + (issues === 1 ? " account needs" : " accounts need") + " attention"; b.append(d); }
    b.append(icon("chev", "chv"));
    b.title = a ? agName(a.agent) + " · " + label(a) + (a.plan ? " · " + a.plan : "") + "\nClick to switch accounts" : "Accounts";
  }
  function acctRow(a) {
    const pr = problem(a), use = !pr && inUse(a), t = tight(a);
    const sub = h("div", "sub");
    if (a.plan) sub.append(h("span", "", a.plan[0].toUpperCase() + a.plan.slice(1)));
    if (t && !pr) sub.append(h("span", "", t.name + ": " + Math.round(t.remaining) + "% left"), t.resetsAt ? h("span", "", "resets " + fmtReset(t.resetsAt)) : null);
    const mid = h("div", "mid", h("div", "em", label(a)), sub);
    if (t && !pr) mid.append(leftBar(t.remaining));
    if (pr) mid.append(h("div", "why", pr.why));
    let right;
    if (pr) { right = h("button", "mp-btn " + (pr.main ? "acc" : "warn"), pr.fix); right.onclick = (e) => { e.stopPropagation(); pr.act(); }; }
    else if (use) right = h("span", "mp-tag", "in use");
    else if (a.agent === "claude" || a.agent === "codex") { right = h("button", "mp-btn", "Use"); right.onclick = (e) => { e.stopPropagation(); useAccount(a); }; }
    else right = h("span", "");
    if (right.tagName === "BUTTON") right.type = "button";
    return h("div", "mp-a" + (use ? " cur" : "") + (pr ? " bad" : ""), avatar(a.agent), mid, right);
  }
  function groups(list) {
    const by = new Map();
    for (const a of list) { if (!by.has(a.agent)) by.set(a.agent, []); by.get(a.agent).push(a); }
    return [...by.entries()].sort((x, y) => (AG_ORDER.indexOf(x[0]) + 1 || 99) - (AG_ORDER.indexOf(y[0]) + 1 || 99));
  }
  function addMenu(cls) {
    const row = h("div", cls || "mp-add");
    for (const [ag, t] of [["claude", "Claude"], ["codex", "ChatGPT"], ["antigravity", "Google (Gemini)"]]) {
      const b = h("button", "mp-btn", avatar(ag), t);
      b.type = "button";
      b.onclick = (e) => { e.stopPropagation(); signIn(ag); };
      row.append(b);
    }
    return row;
  }
  function drawAcctPop() {
    const pop = $("#acctPop");
    if (!pop) return;
    const body = h("div", "mp-pb");
    if (!MPA.list) body.append(h("div", "dim pad", MPA.err || (SAVES ? "Reading Magpie…" : "Accounts show in the Foxpit app.")));
    else for (const [ag, rows] of groups(MPA.list)) body.append(h("div", "mp-gt", agName(ag)), ...rows.map(acctRow));
    const add = h("button", "mp-btn", icon("plus"), "Add account");
    add.type = "button";
    const more = h("button", "mp-btn", "Magpie", icon("chev", "r"));
    more.type = "button";
    more.onclick = (e) => { e.stopPropagation(); closeAcctPop(); openMp("accounts"); };
    let adding = null;
    add.onclick = (e) => { e.stopPropagation(); if (adding) { adding.remove(); adding = null; } else { adding = addMenu(); foot.before(adding); } };
    const foot = h("div", "mp-pf", h("label", "auto", autoToggle(), "Auto-switch at limit"), h("div", "r", add, more));
    pop.replaceChildren(h("div", "mp-ph", h("b", "", "Accounts"), h("span", "dim", "through Magpie")), body, foot);
  }
  function closeAcctPop() {
    const p = $("#acctPop");
    if (!p) return;
    p.classList.add("out");
    $("#acctPill").classList.remove("open");
    setTimeout(() => p.remove(), 140);
  }
  function openAcctPop() {
    if ($("#acctPop")) { closeAcctPop(); return; }
    closeMenu();
    const pop = h("div", "mp-pop");
    pop.id = "acctPop";
    pop.onclick = (e) => e.stopPropagation();
    document.body.append(pop);
    const r = $("#acctPill").getBoundingClientRect();
    pop.style.top = r.bottom + 6 + "px";
    const pw = Math.min(390, window.innerWidth - 16);
    pop.style.right = Math.max(8, Math.min(window.innerWidth - r.right, window.innerWidth - pw - 8)) + "px";
    $("#acctPill").classList.add("open");
    drawAcctPop();
    loadAccounts(true);
  }
  document.addEventListener("click", () => closeAcctPop());
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $("#acctPop")) { e.stopPropagation(); closeAcctPop(); } }, true);
  window.addEventListener("focus", () => { if (MPA.pending && Date.now() - MPA.pending < 10 * 60e3) loadAccounts(true); });

  // the Magpie screen, over the chat
  function openMp(tab) {
    if (tab) mpv.tab = tab;
    mpv.open = true;
    $(".app").classList.remove("rail-on");
    if (setv.open) closeSettings();
    if (impv.open) closeImport();
    let v = $("#mpView");
    if (!v) {
      v = h("div", "mp-view", h("div", "mp-head"), h("div", "mp-scroll"), h("div", "mp-frame"));
      v.id = "mpView";
      $(".main").append(v);
    }
    v.hidden = false;
    requestAnimationFrame(() => v.classList.add("in"));
    renderMp();
    loadAccounts();
    renderAccountCard();
  }
  function closeMp() {
    mpv.open = false;
    const v = $("#mpView");
    if (v) { v.classList.remove("in"); setTimeout(() => { if (!mpv.open) v.hidden = true; }, 200); }
    renderAccountCard();
  }
  // Magpie's own app, framed: loaded once, kept while Foxpit runs
  async function loadFrame(host) {
    if (mpv.frameState === "loading" || mpv.frameState === "ready") return;
    mpv.frameState = "loading";
    drawFrameState(host);
    let r;
    try { r = await fetch("/api/magpie/web").then((x) => x.json()); } catch { r = { error: "Magpie is in the Foxpit app." }; }
    if (r.error || !r.url) { mpv.frameState = "error"; mpv.frameErr = r.error || "Magpie did not open."; drawFrameState(host); return; }
    const f = h("iframe", "mp-if");
    f.title = "Magpie";
    f.setAttribute("allow", "clipboard-read; clipboard-write");
    f.onload = () => {
      mpv.frameState = "ready";
      drawFrameState(host);
      mpPost({ type: "hello" });
      mpPost({ type: "theme", theme: themeNow() });
      if (mpv.tab.startsWith("mp:")) mpPost({ type: "view", view: mpv.tab.slice(3) });
    };
    f.src = r.url;
    mpv.frame = f;
    host.append(f);
  }
  function drawFrameState(host) {
    host.querySelector(".mp-fs")?.remove();
    if (mpv.frameState === "ready") return;
    const box = h("div", "mp-fs");
    if (mpv.frameState === "error") {
      const b = h("button", "mp-btn acc", "Try again");
      b.type = "button";
      b.onclick = (e) => { e.stopPropagation(); mpv.frameState = ""; mpv.frame?.remove(); mpv.frame = null; loadFrame(host); };
      box.append(h("div", "why", mpv.frameErr), b);
    } else box.append(h("span", "att-spin"), h("span", "dim", "Opening Magpie…"));
    host.append(box);
  }
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && mpv.open && !$("#acctPop") && !document.querySelector(".lightbox")) { e.stopPropagation(); closeMp(); } }, true);
  function mpCard(a) {
    const pr = problem(a), use = !pr && inUse(a);
    const name = h("div", "em", label(a));
    if (mpv.editing === a.agent + a.user) {
      const inp = h("input", "mp-in");
      inp.value = a.alias || "";
      inp.placeholder = a.user;
      const done = async (keep) => {
        mpv.editing = "";
        if (keep && inp.value.trim() !== (a.alias || "") && (await post("/api/magpie/accounts/alias", { agent: a.agent, user: a.user, name: inp.value.trim() }))) await loadAccounts(true);
        else renderMp();
      };
      inp.onkeydown = (e) => { if (e.key === "Enter") done(true); if (e.key === "Escape") { e.stopPropagation(); done(false); } };
      inp.onblur = () => done(true);
      setTimeout(() => inp.focus(), 0);
      name.replaceChildren(inp);
    }
    const bits = [agName(a.agent), a.plan ? a.plan[0].toUpperCase() + a.plan.slice(1) : "", a.alias ? a.user : "",
      a.resets && a.resets.count ? a.resets.count + " reset credit" + (a.resets.count > 1 ? "s" : "") : ""].filter(Boolean);
    const card = h("div", "mp-card" + (use ? " cur" : "") + (pr ? " bad" : ""), h("div", "mp-ch", avatar(a.agent, true), h("div", "who", name, h("div", "sub", bits.join(" · "))), use ? h("span", "mp-tag", "in use") : null));
    for (const w of a.windows || []) {
      card.append(h("div", "mp-w", h("span", "n", w.name), leftBar(w.remaining),
        h("span", "v", Math.round(w.remaining) + "% left" + (w.resetsAt ? " · " + fmtReset(w.resetsAt) : ""))));
    }
    if (pr) card.append(h("div", "why", pr.why));
    const row = h("div", "mp-row");
    const btn = (t, cls, fn) => { const b = h("button", "mp-btn" + (cls ? " " + cls : ""), t); b.type = "button"; b.onclick = (e) => { e.stopPropagation(); fn(); }; return b; };
    if (SIGNS.has(a.agent) && !pr) row.append(btn("Rename", "", () => { mpv.editing = a.agent + a.user; renderMp(); }));
    if (pr) row.append(btn(pr.fix, pr.main ? "acc" : "warn", pr.act));
    else if (!use && (a.agent === "claude" || a.agent === "codex")) row.append(btn("Use", "acc", () => useAccount(a)));
    if (a.agent === "claude" && !pr && !a.here) card.append(h("div", "why", "Magpie has this account but Foxpit can't run chats on it yet: sign in again once."));
    card.append(row);
    return card;
  }
  function mpAccountsTab() {
    const wrap = h("div", "mp-body");
    if (!MPA.list) { wrap.append(h("div", "dim", MPA.err || "Reading Magpie…")); return wrap; }
    const grid = h("div", "mp-grid");
    for (const [, rows] of groups(MPA.list)) for (const a of rows) grid.append(mpCard(a));
    wrap.append(h("div", "mp-sec", "Subscriptions"), grid);
    // where each kind of model goes
    const list = MPA.list;
    const ok = (ag) => list.filter((a) => a.agent === ag && !problem(a));
    const cl = claudeInUse(), cx = list.find((a) => a.agent === "codex" && a.active && !problem(a));
    const gem = ok("gemini")[0] || ok("antigravity")[0];
    const rt = h("div", "mp-rt");
    const line = (models, to, warnTo, fix) => {
      const r = h("div", "mp-rr", h("span", "mdl", models), h("span", "dim", "→"), h("span", warnTo ? "warn-t" : "", to));
      if (fix) { const b = h("button", "mp-btn acc", fix[0]); b.type = "button"; b.onclick = (e) => { e.stopPropagation(); fix[1](); }; r.append(b); } else r.append(h("span", ""));
      rt.append(r);
    };
    line("Claude models", cl ? label(cl) + (D.claudeUser && cl.user === D.claudeUser ? " (your pick)" : " (most room)") + (D.autoSwitch !== false ? ", then the next with room" : "") : "no Claude account Foxpit can use", !cl, cl ? null : ["Sign in", () => signIn("claude")]);
    line("GPT and Codex models", cx ? "ChatGPT " + label(cx) : "no working ChatGPT account", !cx, cx ? null : ["Sign in", () => signIn("codex")]);
    line("Gemini models", gem ? agName(gem.agent) + " " + label(gem) : "no working Google account", !gem, gem ? null : ["Connect", () => signIn("antigravity")]);
    line("Auto", "Magpie picks a model for each request", false);
    wrap.append(h("div", "mp-sec", "Which model goes where"), rt);
    const set = h("div", "mp-rt");
    set.append(h("div", "mp-set", h("div", "", h("div", "t", "Switch accounts automatically"),
      h("div", "sub", "When a Claude account runs out, even in the middle of a reply, the next one with room takes over and carries on where it stopped.")), autoToggle()));
    wrap.append(set);
    return wrap;
  }
  // ---------- usage: what the gateway served, read from Magpie's own log ----------
  const USE = { days: 7, data: null, err: "", busy: false, at: 0 };
  const money = (v) => v >= 100 ? "$" + Math.round(v) : v >= 1 ? "$" + v.toFixed(2) : v > 0 ? "$" + v.toFixed(3) : "$0";
  const secs = (ms) => ms ? (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + " s" : "—";
  async function loadUsage(force) {
    if (USE.busy || (!force && USE.data && USE.data.range === USE.days && Date.now() - USE.at < 15000)) return;
    USE.busy = true;
    const days = USE.days;
    try {
      const r = await fetch("/api/magpie/spend?days=" + days).then((x) => x.json());
      if (r.error) USE.err = r.error; else { USE.data = Object.assign(r, { range: days }); USE.err = ""; USE.at = Date.now(); }
    } catch { USE.err = SAVES ? "Magpie did not answer." : "Usage shows in the Foxpit app."; }
    USE.busy = false;
    if (mpv.open && mpv.tab === "usage") renderMp();
  }
  function chatOfSession(id) { return id ? D.chats.find((c) => c.session === id) : null; }
  function agentLabel(a) { return { claude: "Claude Code", "claude-desktop": "Claude Desktop", codex: "Codex", opencode: "OpenCode", gemini: "Gemini CLI" }[a] || a; }
  function mpUsageTab() {
    const wrap = h("div", "mp-body fx-use");
    const seg = h("div", "fx-seg");
    for (const [d, t] of [[1, "Today"], [7, "7 days"], [30, "30 days"]]) {
      const b = h("button", USE.days === d ? "on" : "", t);
      b.type = "button";
      b.onclick = (e) => { e.stopPropagation(); USE.days = d; loadUsage(true); renderMp(); };
      seg.append(b);
    }
    const again = h("button", "icon-btn", icon("retry"));
    again.type = "button";
    again.title = "Read again";
    again.onclick = (e) => { e.stopPropagation(); loadUsage(true); };
    wrap.append(h("div", "fx-use-top", seg, h("span", "dim", "Requests that went through Magpie: GPT, Gemini and Auto chats, and anything else you connected to it."), again));
    const u = USE.data && USE.data.range === USE.days ? USE.data : null;
    if (!u) {
      wrap.append(h("div", "dim pad", USE.err || "Reading what Magpie served…"));
      loadUsage();
      return wrap;
    }
    if (Date.now() - USE.at > 15000) loadUsage();
    const t = u.total;
    if (!t.calls) {
      wrap.append(h("div", "fx-use-empty", h("b", "", "Nothing yet"), h("span", "dim", USE.days === 1 ? "No requests went through Magpie today." : "No requests went through Magpie in these days.")));
      return wrap;
    }
    const tile = (k, v, sub, cls) => h("div", "fx-tile" + (cls ? " " + cls : ""), h("span", "k", k), h("b", "", v), h("span", "sub", sub));
    wrap.append(h("div", "fx-tiles",
      tile("API value", money(t.cost), "what these would cost paid by the token", "acc"),
      tile("Requests", String(t.calls), u.errors ? u.errors + " failed" : "none failed", u.errors ? "warn" : ""),
      tile("Tokens", fmtTok(t.tokens), fmtTok(u.cacheRead) + " more read from cache"),
      tile("First word after", secs(t.ttft), "on average, from sending")));
    if (u.days.length > 1) {
      const max = Math.max(...u.days.map((d) => d.cost), 0.0001);
      const bars = h("div", "fx-bars" + (u.days.length > 14 ? " many" : ""));
      for (const d of u.days) {
        const day = new Date(d.name + "T12:00:00");
        const bar = h("div", "bar");
        bar.style.height = (d.calls ? Math.max(3, Math.round((d.cost / max) * 100)) : 0) + "%";
        const col = h("div", "col" + (d.calls ? "" : " none"), bar, h("span", "lbl", u.days.length > 14 ? String(day.getDate()) : day.toLocaleDateString("en", { weekday: "short" })));
        col.title = day.toLocaleDateString("en", { day: "numeric", month: "long" }) + "\n" + (d.calls ? money(d.cost) + " · " + d.calls + " requests · " + fmtTok(d.tokens) + " tokens" : "nothing");
        bars.append(col);
      }
      wrap.append(h("div", "mp-sec", "By day"), h("div", "mp-rt fx-chart", bars));
    }
    const share = (part) => { const i = h("i", ""); i.style.width = Math.max(2, Math.round((part / (t.cost || 1)) * 100)) + "%"; return h("span", "fx-share", i); };
    const sumRow = (lead, x, onClick) => {
      const r = h(onClick ? "button" : "div", "fx-ur", h("span", "nm", lead), share(x.cost), h("span", "n", String(x.calls)),
        h("span", "n", fmtTok(x.tokens)), h("span", "n", x.ttft ? secs(x.ttft) : "—"), h("b", "c", money(x.cost)));
      if (onClick) { r.type = "button"; r.onclick = (e) => { e.stopPropagation(); onClick(); }; }
      return r;
    };
    const provOf = (m) => { const p = String(m).split("/")[0]; return /gpt|codex/.test(m) ? "codex" : /gemini/.test(m) ? "gemini" : /claude/.test(m) ? "claude" : p === "auto" || p === "group" ? "auto" : p; };
    const mdlName = (m) => {
      const id = String(m).split("/").pop();
      for (const a of D.accounts || []) for (const x of a.models || []) if (x.id === m || String(x.id).split("/").pop() === id) return x.name;
      return id;
    };
    const head = (first) => h("div", "fx-ur hd", h("span", "nm", first), h("span", "", "share"), h("span", "n", "requests"), h("span", "n", "tokens"), h("span", "n", "first word"), h("span", "c", "value"));
    const models = h("div", "mp-rt", head("Model"));
    for (const x of u.models) models.append(sumRow(h("span", "mdl", pv(provOf(x.name), "sm"), h("span", "", mdlName(x.name)), h("code", "dim", x.name)), x));
    wrap.append(h("div", "mp-sec", "By model"), models);
    const accts = h("div", "mp-rt", head("Account"));
    for (const x of u.accounts) accts.append(sumRow(h("span", "", x.name === "—" ? "No account (API key or free model)" : x.name), x));
    wrap.append(h("div", "mp-sec", "By account"), accts);
    if (u.sessions.length) {
      const chats = h("div", "mp-rt", head("Chat"));
      for (const x of u.sessions.slice(0, 12)) {
        const c = chatOfSession(x.name);
        chats.append(c ? sumRow(h("span", "", c.title || "Untitled chat"), x, () => { closeMp(); openChat(c); })
          : sumRow(h("span", "dim", (x.sub ? agentLabel(x.sub) + " · " : "") + x.name.slice(0, 8)), x));
      }
      wrap.append(h("div", "mp-sec", "By chat"), chats);
    }
    const rec = h("div", "mp-rt fx-recent");
    for (const r of u.recent.slice(0, 25)) {
      const at = new Date(r.at);
      const bad = !!r.failed;
      const c = chatOfSession(r.session);
      const row = h("div", "fx-rq" + (bad ? " bad" : ""), h("span", "tm", at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })),
        h("span", "mdl", pv(provOf(r.model), "sm"), h("span", "", mdlName(r.model)), c ? h("span", "dim", "· " + (c.title || "chat")) : null),
        h("span", "n", fmtTok(r.in + r.out) + " tok"), h("span", "n", r.ttft ? secs(r.ttft) + " to start" : ""), h("span", "n", secs(r.ms)), h("b", "c" + (r.stopped ? " dim" : ""), bad ? "failed" : r.stopped ? "stopped" : money(r.cost)));
      if (r.error) row.title = r.error;
      rec.append(row);
    }
    wrap.append(h("div", "mp-sec", "Latest requests"), rec);
    wrap.append(h("div", "dim fx-note", "API value is what the same tokens would cost bought from the provider by the token. On a subscription you pay the plan, not this."));
    return wrap;
  }
  // ---------- library: skills, through Magpie's own library (/api/mplib → its /api/library) ----------
  const LIB = { data: null, err: "", busy: false, at: 0, probe: null, mq: "", market: null, mErr: "", mBusy: false, shown: 24, working: new Set() };
  async function libApi(path, body) {
    const r = await fetch("/api/mplib/" + path, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const text = await r.text();
    let v = null;
    try { v = text ? JSON.parse(text) : null; } catch { throw new Error(text.trim().split("\n")[0] || "Magpie did not answer."); }
    if (!r.ok || (v && v.error && !v.skills)) throw new Error((v && v.error) || r.status + "");
    return v;
  }
  async function libLoad(force) {
    if (LIB.busy || (!force && LIB.data && Date.now() - LIB.at < 20000)) return;
    LIB.busy = true;
    try { LIB.data = await libApi(""); LIB.err = ""; LIB.at = Date.now(); }
    catch (e) { LIB.err = SAVES ? e.message : "The library shows in the Foxpit app."; }
    LIB.busy = false;
    if (mpv.open && mpv.tab === "library") renderMp();
  }
  // a change: Magpie answers with the whole library again
  async function libDo(path, body, done, key) {
    if (key) { if (LIB.working.has(key)) return false; LIB.working.add(key); renderMp(); }
    try {
      const v = await libApi(path, body);
      if (v && Array.isArray(v.skills)) { LIB.data = v; LIB.at = Date.now(); }
      else await libLoad(true);
      const bad = v && v.result && (v.result.unimported || v.result.unremoved || []);
      if (bad && bad.length) flash(bad[0].what.replace(/^skill:/, "") + ": " + bad[0].error);
      else if (done) flash(done);
      return true;
    } catch (e) { flash(e.message); return false; }
    finally { if (key) LIB.working.delete(key); if (mpv.open && mpv.tab === "library") renderMp(); }
  }
  async function libMarket(q) {
    LIB.mBusy = true;
    const ask = q;
    try {
      const r = await libApi("market/skills?q=" + encodeURIComponent(q.trim()));
      if (ask !== LIB.mq) return;
      LIB.market = r.items || []; LIB.mErr = r.error && !(r.items || []).length ? r.error : ""; LIB.shown = 24;
    } catch (e) { if (ask === LIB.mq) { LIB.market = []; LIB.mErr = e.message; } }
    if (ask === LIB.mq) LIB.mBusy = false;
    if (mpv.open && mpv.tab === "library") drawMarketGrid();
  }
  const libAgentName = (id) => ((LIB.data && LIB.data.agents) || []).find((a) => a.id === id)?.name || id;
  function agentChips(ids) {
    const box = h("span", "fx-chips");
    const list = ids || [];
    if (!list.length) { box.append(h("span", "fx-chip off", "no agent")); return box; }
    for (const id of list.slice(0, 3)) box.append(h("span", "fx-chip" + (id === "claude" ? " fx" : ""), libAgentName(id)));
    if (list.length > 3) { const m = h("span", "fx-chip", "+" + (list.length - 3)); m.title = list.slice(3).map(libAgentName).join(", "); box.append(m); }
    return box;
  }
  function skillSheet(s) {
    $("#fxSheet")?.remove();
    const body = h("div", "fx-sheet-body", h("div", "dim pad", "Reading SKILL.md…"));
    const x = h("button", "icon-btn", icon("x"));
    x.type = "button";
    const sheet = h("div", "fx-sheet-ov", h("div", "fx-sheet", h("div", "fx-sheet-h", h("b", "", s.name), h("span", "dim", s.source || "SKILL.md"), x), body));
    sheet.id = "fxSheet";
    const close = () => { sheet.remove(); document.removeEventListener("keydown", esc, true); };
    const esc = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    document.addEventListener("keydown", esc, true);
    x.onclick = close;
    sheet.onclick = (e) => { if (e.target === sheet) close(); };
    document.body.append(sheet);
    libApi("skill?name=" + encodeURIComponent(s.name)).then((v) => body.replaceChildren(richText(String((v && v.text) || "").replace(/^---[\s\S]*?\n---\n?/, "")))).catch((e) => body.replaceChildren(h("div", "why", e.message)));
  }
  function confirmIn(btn, label, fn) {
    if (btn.dataset.sure) { fn(); return; }
    btn.dataset.sure = "1";
    const was = btn.innerHTML;
    btn.classList.add("sure");
    btn.textContent = label;
    setTimeout(() => { if (btn.isConnected) { delete btn.dataset.sure; btn.classList.remove("sure"); btn.innerHTML = was; } }, 3000);
  }
  // skills.sh lists names only: the descriptions come after, sixty at a time
  const libAsked = new Set();
  async function describeMarket() {
    const ids = (LIB.market || []).slice(0, LIB.shown).filter((x) => !x.description && !libAsked.has(x.id)).map((x) => x.id).slice(0, 60);
    if (!ids.length) return;
    ids.forEach((id) => libAsked.add(id));
    try {
      const about = await libApi("market/about", { ids });
      for (const x of LIB.market || []) if (about && about[x.id]) x.description = about[x.id];
    } catch {}
    if (mpv.open && mpv.tab === "library") drawMarketGrid();
  }
  function drawMarketGrid() {
    const grid = $("#fxMk");
    if (!grid) return;
    grid.classList.toggle("loading", LIB.mBusy);
    if (!LIB.market) { grid.replaceChildren(...Array.from({ length: 6 }, () => h("div", "fx-mk sk"))); return; }
    const items = LIB.market;
    if (!items.length) { grid.replaceChildren(h("div", "dim pad", LIB.mErr || (LIB.mq ? "Nothing matches “" + LIB.mq + "”." : "Nothing to show."))); return; }
    const cards = items.slice(0, LIB.shown).map((x) => {
      const add = h("button", "mp-btn" + (x.have ? "" : " acc"), x.have ? "In library" : LIB.working.has("mk:" + x.id) ? "Adding…" : "Add");
      add.type = "button";
      add.disabled = !!x.have || LIB.working.has("mk:" + x.id);
      add.onclick = async (e) => {
        e.stopPropagation();
        LIB.working.add("mk:" + x.id); drawMarketGrid();
        try {
          const v = await libApi("market/skill", { source: x.source, id: x.skillId });
          if (v && Array.isArray(v.skills)) { LIB.data = v; LIB.at = Date.now(); }
          x.have = x.name;
          flash(x.name + " is in your library, given to your agents.");
        } catch (er) { flash(er.message); }
        LIB.working.delete("mk:" + x.id);
        if (mpv.open && mpv.tab === "library") renderMp();
      };
      const img = h("img", "fx-mk-ic"); img.alt = ""; img.loading = "lazy"; if (x.icon) img.src = x.icon; img.onerror = () => img.replaceWith(h("span", "fx-mk-ic none", (x.name || "?")[0].toUpperCase()));
      const top = h("div", "fx-mk-top", x.icon ? img : h("span", "fx-mk-ic none", (x.name || "?")[0].toUpperCase()),
        h("div", "who", h("b", "", x.name, x.official ? h("span", "fx-off", "✓") : null), h("span", "dim", x.source)));
      const d = h("p", x.description || libAsked.has(x.id) ? "" : "wait", x.description || "");
      const foot = h("div", "fx-mk-foot", x.installs ? h("span", "dim", fmtTok(x.installs) + " installs") : h("span", ""), add);
      const c = h("div", "fx-mk" + (x.have ? " have" : ""), top, d, foot);
      c.title = x.description || x.name;
      return c;
    });
    if (items.length > LIB.shown) {
      const more = h("button", "mp-btn fx-more", "Show more (" + (items.length - LIB.shown) + " left)");
      more.type = "button";
      more.onclick = (e) => { e.stopPropagation(); LIB.shown += 24; drawMarketGrid(); };
      cards.push(more);
    }
    grid.replaceChildren(...cards);
    describeMarket();
  }
  function mpLibTab() {
    const wrap = h("div", "mp-body fx-lib");
    const L = LIB.data;
    if (!L) {
      wrap.append(h("div", "dim pad", LIB.err || "Reading your skills…"));
      libLoad();
      return wrap;
    }
    if (Date.now() - LIB.at > 20000) libLoad();
    wrap.append(h("div", "fx-lib-intro", h("b", "", "Skills"), h("span", "dim", "A skill is a folder with a SKILL.md the agent reads when a task needs it. The library keeps each one once and gives it to the agents you pick, Foxpit's Claude chats too.")));
    // add from anywhere: a repo, a link, a folder
    const inp = h("input", "fx-lib-in");
    inp.placeholder = "owner/repo, a GitHub or git link, or a folder on this computer";
    inp.value = LIB.probe ? LIB.probe.source : "";
    const find = h("button", "mp-btn acc", LIB.probe && LIB.probe.busy ? "Looking…" : "Find skills");
    find.type = "button";
    const go = async () => {
      const src = inp.value.trim();
      if (!src) { inp.focus(); return; }
      LIB.probe = { source: src, busy: true };
      renderMp();
      try {
        const p = await libApi("skills/probe", { source: src });
        const fresh = (p.candidates || []).filter((c) => !c.have);
        LIB.probe = { source: src, found: p.candidates || [], pick: new Set((fresh.length <= 3 ? fresh : []).map((c) => c.path)) };
        if (!LIB.probe.found.length) LIB.probe.error = "No SKILL.md there.";
      } catch (e) { LIB.probe = { source: src, error: e.message }; }
      renderMp();
    };
    find.onclick = (e) => { e.stopPropagation(); go(); };
    inp.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); go(); } };
    const addBox = h("div", "mp-rt fx-lib-add", h("div", "fx-lib-row", icon("plus"), inp, find));
    const P = LIB.probe;
    if (P && P.error) addBox.append(h("div", "why pad", P.error));
    if (P && P.found && P.found.length) {
      const list = h("div", "fx-probe");
      for (const c of P.found) {
        const cb = h("input"); cb.type = "checkbox"; cb.checked = P.pick.has(c.path); cb.disabled = !!c.have;
        cb.onchange = () => { if (cb.checked) P.pick.add(c.path); else P.pick.delete(c.path); renderMp(); };
        list.append(h("label", "fx-pr" + (c.have ? " have" : ""), cb, h("div", "t", h("b", "", c.name || c.path), h("span", "dim", c.have ? "already in your library" : (c.description || c.path)))));
      }
      const n = P.pick.size;
      const inst = h("button", "mp-btn acc", P.installing ? "Installing…" : n ? "Install " + n + (n === 1 ? " skill" : " skills") : "Pick skills");
      inst.type = "button";
      inst.disabled = !n || P.installing;
      inst.onclick = async (e) => {
        e.stopPropagation();
        P.installing = true; renderMp();
        const agents = (L.agents || []).map((a) => a.id);
        if (await libDo("skills/install", { source: P.source, paths: [...P.pick], agents }, n === 1 ? "1 skill installed" : n + " skills installed")) LIB.probe = null;
        else P.installing = false;
        renderMp();
      };
      const cancel = h("button", "mp-btn", "Cancel"); cancel.type = "button"; cancel.onclick = (e) => { e.stopPropagation(); LIB.probe = null; renderMp(); };
      addBox.append(list, h("div", "fx-lib-bar", h("span", "dim", P.found.length + " found in " + P.source), cancel, inst));
    }
    wrap.append(addBox);
    // the library
    const skills = L.skills || [];
    const mine = h("div", "mp-rt");
    if (!skills.length) mine.append(h("div", "fx-lib-empty dim", "Nothing in the library yet. Bring in the skills your agents already have, or add one from below."));
    for (const s of skills) {
      const has = (s.agents || []).includes("claude");
      const tog = h("button", "tog" + (has ? "" : " off"));
      tog.type = "button";
      tog.title = has ? "Foxpit's Claude chats can use it: click to take it away" : "Give it to Claude Code, which Foxpit's chats run on";
      tog.onclick = (e) => { e.stopPropagation(); const next = has ? (s.agents || []).filter((a) => a !== "claude") : [...(s.agents || []), "claude"]; libDo("skills/agents", { name: s.name, agents: next }, null, "ag:" + s.name); };
      const rm = h("button", "icon-btn danger", icon("trash"));
      rm.type = "button";
      rm.title = "Remove from the library and from every agent (kept in Magpie's backups)";
      rm.onclick = (e) => { e.stopPropagation(); confirmIn(rm, "Remove?", () => libDo("skills/remove", { name: s.name }, s.name + " removed", "rm:" + s.name)); };
      const row = h("button", "fx-sk", h("span", "ic", icon("file")), h("div", "t", h("b", "", s.name), h("span", "dim", s.description || "")), agentChips(s.agents), h("label", "fx-sk-tog", tog, h("span", "dim", "Claude")), rm);
      row.type = "button";
      row.title = "Read " + s.name + "'s SKILL.md";
      row.onclick = () => skillSheet(s);
      mine.append(row);
    }
    wrap.append(h("div", "mp-sec", "In your library" + (skills.length ? " · " + skills.length : "")), mine);
    // in the agents, not in the library yet
    const found = (L.foundSkills || []).filter((f) => !skills.some((s) => s.name === f.name));
    if (found.length) {
      const all = h("button", "mp-btn", "Bring in all");
      all.type = "button";
      all.onclick = (e) => { e.stopPropagation(); libDo("skills/import-all", { names: found.map((f) => f.name) }, found.length + " skills are in the library now", "all"); };
      const box = h("div", "mp-rt");
      for (const f of found) {
        const holders = [...new Set([...(f.agents || []), ...(f.copies || [])])];
        const b = h("button", "mp-btn acc", LIB.working.has("in:" + f.name) ? "Bringing…" : "Bring in");
        b.type = "button";
        b.title = "Into the library, so you can give it to any agent";
        b.onclick = (e) => { e.stopPropagation(); libDo("skills/import", { name: f.name }, f.name + " is in the library now", "in:" + f.name); };
        box.append(h("div", "fx-sk static", h("span", "ic", icon("file")), h("div", "t", h("b", "", f.name), h("span", "dim", f.description || "")), agentChips(holders), b));
      }
      wrap.append(h("div", "fx-sec-row", h("div", "mp-sec", "In your agents, not in the library · " + found.length), all), box);
    }
    // discover
    const q = h("input", "fx-lib-in");
    q.placeholder = "Search skills.sh: react, pdf, testing…";
    q.value = LIB.mq;
    let tm = 0;
    q.oninput = () => { clearTimeout(tm); tm = setTimeout(() => { LIB.mq = q.value; LIB.mBusy = true; drawMarketGrid(); libMarket(LIB.mq); }, 300); };
    const grid = h("div", "fx-mk-grid");
    grid.id = "fxMk";
    wrap.append(h("div", "mp-sec", "Discover"), h("div", "mp-rt fx-lib-add", h("div", "fx-lib-row", icon("search"), q)), grid);
    if (!LIB.market && !LIB.mBusy) libMarket(LIB.mq);
    requestAnimationFrame(drawMarketGrid);
    const more = h("button", "mp-btn", "MCP servers, hooks and shared instructions", icon("chev", "r"));
    more.type = "button";
    more.onclick = (e) => { e.stopPropagation(); mpv.tab = "mp:library"; mpv.settingsOpen = false; renderMp(); };
    wrap.append(h("div", "fx-lib-more", h("span", "dim", "The rest of the library is in Magpie's page."), more));
    return wrap;
  }
  function mpModelsTab() {
    const wrap = h("div", "mp-body");
    const models = (D.accounts || []).filter((a) => a.models && a.models.length);
    const c = chat();
    const works = (ag) => (MPA.list || []).some((x) => x.agent === ag && !problem(x));
    for (const a of models) {
      const box = h("div", "mp-rt");
      const dead = MPA.list && a.provider === "gemini" && !works("gemini") && !works("antigravity");
      for (const m of a.models) {
        const cur = c.account === a.id && c.model === m.id;
        if (dead) {
          const b = h("button", "mp-btn warn", "Connect");
          b.type = "button";
          b.onclick = (e) => { e.stopPropagation(); signIn("antigravity"); };
          box.append(h("div", "mp-rr mm off", h("span", "mdl", pv(a.provider, "sm"), m.name), h("code", "dim", m.id), h("span", ""), b));
          continue;
        }
        const b = h("button", "mp-btn" + (cur ? "" : " acc"), cur ? "In this chat" : "Use in this chat");
        b.type = "button";
        b.disabled = cur;
        b.onclick = (e) => { e.stopPropagation(); choose(a.id, m.id); renderMp(); flash(m.name + " in this chat."); };
        box.append(h("div", "mp-rr mm", h("span", "mdl", pv(a.provider, "sm"), m.name), h("code", "dim", m.id), h("span", ""), b));
      }
      wrap.append(h("div", "mp-sec", a.provider === "auto" ? "Auto · Magpie picks the account" : a.name + (a.plan && !dead ? " · " + a.plan : "")));
      if (dead) wrap.append(h("div", "why", "No working Google account: Google closed Gemini CLI sign-in for personal accounts. Connect the same account through Antigravity and these work again."));
      wrap.append(box);
    }
    if (!models.length) wrap.append(h("div", "dim", "No models yet."));
    return wrap;
  }
  // Magpie's pages as Foxpit's own tabs: its code draws them (framed, in
  // Foxpit's colours, its header hidden: frontend/mpskin), Foxpit picks them
  const MP_VIEWS = [["agents", "Agents", "Work"], ["sessions", "Sessions", "Work"], ["library", "Library", "Work"], ["providers", "Providers", "Models"],
    ["routing", "Routing", "Models"], ["groups", "Routing groups", "Models"], ["gateway", "Gateway", "Models"], ["usage", "Usage", "Insights"],
    ["masking", "Masking", "Insights"], ["plugins", "Plugins", "Extend"]].map(([view, label, group]) => ({ view, label, group }));
  function mpPost(o) { if (o.type === "view") mpv.asked = { view: o.view, at: Date.now() }; try { mpv.frame?.contentWindow?.postMessage(Object.assign({ foxpit: "magpie" }, o), "*"); } catch {} }
  window.addEventListener("message", (e) => {
    if (!mpv.frame || e.source !== mpv.frame.contentWindow) return;
    const d = e.data || {};
    if (d.foxpit !== "magpie" || d.type !== "views" || !Array.isArray(d.views)) return;
    mpv.views = d.views.length ? d.views : null;
    mpv.update = !!d.update;
    const on = d.views.find((x) => x.on);
    // a link inside Magpie moved it to another page: the tab follows (not
    // while a page Foxpit asked for is still opening)
    const asked = mpv.asked && Date.now() - mpv.asked.at < 2500 ? mpv.asked.view : "";
    if (on && on.view !== mpv.lastOn && mpv.lastOn && on.view !== asked && mpv.tab.startsWith("mp:") && !mpv.settingsOpen) mpv.tab = "mp:" + on.view;
    if (on) mpv.lastOn = on.view;
    if (mpv.open) renderMp();
  });
  function renderMp() {
    const v = $("#mpView");
    if (!v) return;
    if (mpv.tab === "magpie") mpv.tab = "mp:agents";
    if (mpv.tab === "mp:usage") mpv.tab = "usage";
    const pick = (tab) => {
      mpv.tab = tab;
      mpv.settingsOpen = false;
      if (tab.startsWith("mp:")) mpPost({ type: "view", view: tab.slice(3) });
      renderMp();
    };
    const tabs = h("div", "mp-tabs fx-tabs");
    const tab = (key, label, title) => {
      const b = h("button", key === mpv.tab || (key === "library" && mpv.tab === "mp:library") ? "on" : "", label);
      b.type = "button";
      if (title) b.title = title;
      b.onclick = (e) => { e.stopPropagation(); pick(key); };
      return b;
    };
    tabs.append(tab("accounts", "Accounts", "Your subscriptions and where each model goes"), tab("models", "Models", "Every model, and which one this chat uses"),
      tab("usage", "Usage", "What each model, account and chat used"), tab("library", "Library", "Skills your agents read, kept once and given to the agents you pick"));
    let group = "";
    for (const x of mpv.views || MP_VIEWS) {
      if (x.view === "usage" || x.view === "library") continue; // Foxpit's own tabs stand in
      if (x.group !== group) { group = x.group; tabs.append(h("span", "fx-sep", "")); }
      tabs.append(tab("mp:" + x.view, x.label));
    }
    const issues = (MPA.list || []).filter((a) => problem(a) && AG_ORDER.includes(a.agent)).length;
    const add = h("button", "mp-btn", icon("plus"), "Add account");
    add.type = "button";
    add.onclick = (e) => { e.stopPropagation(); const m = v.querySelector(".mp-addbar"); if (m) m.remove(); else head.after(addMenu("mp-add mp-addbar")); };
    const keepAdd = v.querySelector(".mp-addbar");
    if (keepAdd) keepAdd.remove();
    const iconBtn = (ic, title, fn, cls) => { const b = h("button", "icon-btn" + (cls ? " " + cls : ""), icon(ic)); b.type = "button"; b.title = title; b.onclick = (e) => { e.stopPropagation(); fn(); }; return b; };
    const x = iconBtn("x", "Close (Esc)", closeMp);
    const framed = mpv.tab.startsWith("mp:");
    const extra = h("div", "fx-acts");
    if (framed || mpv.settingsOpen) {
      extra.append(iconBtn("retry", "Look for agents on this computer again", () => mpPost({ type: "act", act: "sync" })),
        iconBtn("gear", "Magpie settings", () => { mpv.tab = mpv.tab.startsWith("mp:") ? mpv.tab : "mp:agents"; mpv.settingsOpen = true; renderMp(); mpPost({ type: "act", act: "prefs" }); }, mpv.settingsOpen ? "on" : ""));
    }
    if (mpv.update) { const u = h("button", "mp-btn acc", "Update Magpie"); u.type = "button"; u.onclick = (e) => { e.stopPropagation(); mpPost({ type: "act", act: "update" }); }; extra.append(u); }
    const tag = issues ? h("button", "mp-tag off", issues + " need" + (issues > 1 ? "" : "s") + " you") : null;
    if (tag) { tag.type = "button"; tag.title = "Show them"; tag.onclick = (e) => { e.stopPropagation(); pick("accounts"); }; }
    const head = h("div", "mp-vh fx-vh", h("div", "fx-top", h("b", "", "Accounts & models"), tag, h("div", "r", extra, add, x)), tabs);
    v.querySelector(".mp-head").replaceChildren(head);
    requestAnimationFrame(() => tabs.querySelector(".on")?.scrollIntoView({ block: "nearest", inline: "nearest" }));
    const sc = v.querySelector(".mp-scroll"), fr = v.querySelector(".mp-frame");
    sc.hidden = framed;
    fr.hidden = !framed;
    if (framed) {
      if (mpv.frameState === "ready") { if (!mpv.settingsOpen) mpPost({ type: "view", view: mpv.tab.slice(3) }); }
      else loadFrame(fr);
      return;
    }
    const top = sc.scrollTop;
    sc.replaceChildren(mpv.tab === "models" ? mpModelsTab() : mpv.tab === "usage" ? mpUsageTab() : mpv.tab === "library" ? mpLibTab() : mpAccountsTab());
    sc.scrollTop = top;
  }
  setTimeout(() => { renderAcctPill(); loadAccounts(); setInterval(() => loadAccounts(), 60e3); }, 0);
  $("#acctPill").onclick = (e) => { e.stopPropagation(); openAcctPop(); };

  // ---------- settings ----------
  // Every row here changes something real: what a new chat starts with, how
  // Enter behaves, the voice, the sound, the text size. Saved with the chats.
  const SDEF = { account: "", model: "", effort: "high", mode: "edits", send: "enter", sound: false, bgOnly: true,
    voice: "", rate: 1.04, pause: 2000, text: "m", theme: "system", autoUpdate: true, calm: false, expandTools: false, viaMagpie: false };
  const S = () => (D.settings = Object.assign({}, SDEF, D.settings || {}));
  function setS(k, v) { S()[k] = v; applySettings(); save(); if (setv.open) renderSettings(); }
  function applySettings() {
    const s = S();
    document.body.classList.remove("text-s", "text-m", "text-l", "text-xl");
    document.body.classList.add("text-" + s.text);
    document.body.classList.toggle("calm", !!s.calm);
    applyTheme();
  }
  // Theme: System follows Windows' app mode; the choice is also kept in the
  // browser's storage so the next start paints in it before the chats load.
  const darkMq = window.matchMedia("(prefers-color-scheme: dark)");
  function themeNow() { const t = S().theme; return t === "light" || t === "dark" ? t : darkMq.matches ? "dark" : "light"; }
  function applyTheme() {
    const t = themeNow();
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem("fx-theme", t); } catch {}
    if (typeof mpPost === "function") mpPost({ type: "theme", theme: t });
  }
  darkMq.addEventListener("change", () => { if (S().theme === "system") applyTheme(); });
  // a short soft chime when a reply is done
  let chimeCtx = null;
  function chime(ok) {
    try {
      chimeCtx = chimeCtx || new AudioContext();
      const t = chimeCtx.currentTime;
      for (const [i, f] of (ok ? [660, 990] : [440, 330]).entries()) {
        const o = chimeCtx.createOscillator(), g = chimeCtx.createGain();
        o.type = "sine"; o.frequency.value = f;
        g.gain.setValueAtTime(0, t + i * 0.12);
        g.gain.linearRampToValueAtTime(0.12, t + i * 0.12 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.12 + 0.35);
        o.connect(g).connect(chimeCtx.destination);
        o.start(t + i * 0.12); o.stop(t + i * 0.12 + 0.4);
      }
    } catch {}
  }
  const setv = { open: false, sec: "chats" };
  function openSettings(sec) {
    if (sec) setv.sec = sec;
    setv.open = true;
    closeMenu(); closeAcctPop();
    $(".app").classList.remove("rail-on");
    if (mpv.open) closeMp();
    if (impv.open) closeImport();
    let v = $("#setView");
    if (!v) { v = h("div", "mp-view set-view"); v.id = "setView"; $(".main").append(v); }
    v.hidden = false;
    requestAnimationFrame(() => v.classList.add("in"));
    renderSettings();
    renderAccountCard();
  }
  function closeSettings() {
    setv.open = false;
    const v = $("#setView");
    if (v) { v.classList.remove("in"); setTimeout(() => { if (!setv.open) v.hidden = true; }, 200); }
    renderAccountCard();
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && setv.open && !document.querySelector(".mp-pop,.lightbox")) { e.stopPropagation(); closeSettings(); }
  }, true);
  // controls
  function segOpts(key, opts) {
    const g = h("div", "opts");
    for (const [v, t] of opts) {
      const b = h("button", S()[key] === v ? "on" : "", t);
      b.type = "button";
      b.onclick = (e) => { e.stopPropagation(); setS(key, v); };
      g.append(b);
    }
    return g;
  }
  function togS(key) {
    const t = h("button", "tog" + (S()[key] ? "" : " off"));
    t.type = "button";
    t.onclick = (e) => { e.stopPropagation(); setS(key, !S()[key]); };
    return t;
  }
  function selS(value, opts, onPick) {
    const sel = h("select", "sel");
    for (const [v, t] of opts) { const o = h("option", "", t); o.value = v; if (v === value) o.selected = true; sel.append(o); }
    sel.onchange = () => onPick(sel.value);
    return sel;
  }
  function row(box, t, sub, ctl) { box.append(h("div", "mp-set", h("div", "", h("div", "t", t), sub ? h("div", "sub", sub) : null), ...(ctl ? [ctl] : []))); }
  function secChats(w) {
    const s = S();
    const box = h("div", "mp-rt");
    const models = [];
    for (const a of D.accounts || []) for (const m of a.models || []) models.push([a.id + "|" + m.id, a.name.replace(/^Claude · /, "") + " · " + m.name]);
    const curModel = s.account && s.model ? s.account + "|" + s.model : "";
    row(box, "Model for new chats", "A new chat starts on this; any chat can change it from the composer.",
      selS(curModel, [["", "Same as the chat I'm in"], ...models], (v) => { const [a, m] = v ? v.split("|") : ["", ""]; S().account = a; setS("model", m); }));
    const levels = ["low", "medium", "high", "xhigh", "max"];
    row(box, "Effort for new chats", "How long the model thinks before it answers. Models without a level use the nearest one.",
      segOpts("effort", levels.map((l) => [l, l])));
    row(box, "Permissions for new chats", MODES.find((m) => m.id === s.mode)?.note || "", segOpts("mode", MODES.map((m) => [m.id, m.name])));
    row(box, "Send with", s.send === "enter" ? "Enter sends, Shift+Enter adds a line." : kb("Ctrl+Enter") + " sends, Enter adds a line.",
      segOpts("send", [["enter", "Enter"], ["ctrl", kb("Ctrl+Enter")]]));
    row(box, "Open tool steps", "Show what each tool did (reads, edits, commands) unfolded in replies.", togS("expandTools"));
    w.append(h("div", "mp-sec", "Chats"), box);
  }
  function secAccounts(w) {
    const box = h("div", "mp-rt");
    const here = (MPA.list || []).filter((a) => a.agent === "claude" && a.here && !problem(a));
    row(box, "Claude account for chats", "Which of Magpie's Claude accounts Foxpit's Claude chats run on.",
      selS(D.claudeUser || "", [["", "The one with the most room"], ...here.map((a) => [a.user, label(a)])], (v) => { D.claudeUser = v; save(); renderAcctPill(); renderSettings(); }));
    row(box, "Switch accounts automatically", "When one runs out, even mid-reply, the next with room carries on where it stopped.", autoToggle());
    row(box, "Save plan usage", S().viaMagpie
      ? "On: Claude chats go through Magpie, which asks Claude in its interactive mode. A request there counts about half against your plan. Magpie picks the account."
      : "Run Claude chats through Magpie: it asks Claude in its interactive mode, which counts about half against your plan. Off: Foxpit runs Claude Code directly.", togS("viaMagpie"));
    const b = h("button", "mp-btn", "Open Magpie");
    b.type = "button";
    b.onclick = (e) => { e.stopPropagation(); closeSettings(); openMp("magpie"); };
    row(box, "Magpie", "Accounts, providers, routing, usage and plugins.", b);
    const ib = h("button", "mp-btn", "Import chats");
    ib.type = "button";
    ib.onclick = (e) => { e.stopPropagation(); closeSettings(); openImport(); };
    row(box, "Chats from other tools", "Bring in Claude Code and Codex chats and carry on in Foxpit.", ib);
    const sb = h("button", "mp-btn", "Run setup");
    sb.type = "button";
    sb.onclick = (e) => { e.stopPropagation(); closeSettings(); openSetup(); };
    row(box, "Setup", "Check Claude Code, Magpie, your subscriptions and a project folder.", sb);
    w.append(h("div", "mp-sec", "Accounts"), box);
  }
  function secVoice(w) {
    const s = S();
    const box = h("div", "mp-rt");
    const vs = (window.speechSynthesis ? speechSynthesis.getVoices() : []).filter((v) => /^(tr|en)/i.test(v.lang));
    row(box, "Reading voice", "Used for the speaker button and voice chat.",
      selS(s.voice, [["", "Automatic (Turkish for Turkish, English for English)"], ...vs.map((v) => [v.name, v.name.replace(/^Microsoft /, "") + " · " + v.lang])], (v) => setS("voice", v)));
    row(box, "Reading speed", "", segOpts("rate", [[0.9, "Slow"], [1.04, "Normal"], [1.2, "Fast"], [1.4, "Faster"]]));
    row(box, "Voice chat sends after", "How long a pause in your speech ends the message.", segOpts("pause", [[1500, "1.5 s"], [2000, "2 s"], [3000, "3 s"], [4000, "4 s"]]));
    const t = h("button", "mp-btn", icon("speaker"), "Try it");
    t.type = "button";
    t.onclick = (e) => { e.stopPropagation(); speak({ text: "Merhaba, ben Foxpit. Cevapların böyle okunacak." }); };
    row(box, "Test", "", t);
    w.append(h("div", "mp-sec", "Voice"), box);
  }
  function secLook(w) {
    const box = h("div", "mp-rt");
    row(box, "Theme", "System follows Windows: dark or light apps.", segOpts("theme", [["system", "System"], ["dark", "Dark"], ["light", "Light"]]));
    row(box, "Chat text size", "", segOpts("text", [["s", "Small"], ["m", "Normal"], ["l", "Large"], ["xl", "Larger"]]));
    row(box, "Reduce motion", "Panels and menus appear without moving.", togS("calm"));
    w.append(h("div", "mp-sec", "Appearance"), box);
  }
  function secAlerts(w) {
    const box = h("div", "mp-rt");
    row(box, "Sound when a reply is done", "A short chime; a lower one when a run fails.", togS("sound"));
    row(box, "Only when I'm away", "No sound while you're looking at Foxpit.", togS("bgOnly"));
    const t = h("button", "mp-btn", "Play");
    t.type = "button";
    t.onclick = (e) => { e.stopPropagation(); chime(true); };
    row(box, "Test", "", t);
    w.append(h("div", "mp-sec", "Notifications"), box);
  }
  function secKeys(w) {
    const box = h("div", "mp-rt");
    const keys = [["Send", S().send === "ctrl" ? kb("Ctrl+Enter") : "Enter"], ["New line", S().send === "ctrl" ? "Enter" : "Shift+Enter"],
      ["Stop the reply", "Esc"], ["New agent", kb("Ctrl+N")], ["Pick a model", kb("Ctrl+M")], ["Split the chat", kb("Ctrl+\\")], ["Close a pane", kb("Ctrl+W")],
      ["Side panel", kb("Ctrl+B")], ["Search chats", kb("Ctrl+K")], ["Settings", kb("Ctrl+,")], ["Commands", "/"]];
    for (const [t, k] of keys) box.append(h("div", "mp-set key", h("div", "t", t), h("kbd", "", k)));
    w.append(h("div", "mp-sec", "Shortcuts"), box);
  }
  const SECS = [["chats", "Chats", secChats], ["accounts", "Accounts", secAccounts], ["voice", "Voice", secVoice],
    ["look", "Appearance", secLook], ["alerts", "Notifications", secAlerts], ["keys", "Shortcuts", secKeys], ["about", "About", secAbout]];
  function renderSettings() {
    const v = $("#setView");
    if (!v) return;
    const nav = h("nav", "set-nav");
    for (const [k, t] of SECS) {
      const b = h("button", k === setv.sec ? "on" : "", t);
      b.type = "button";
      b.onclick = (e) => { e.stopPropagation(); setv.sec = k; renderSettings(); };
      nav.append(b);
    }
    const x = h("button", "icon-btn", icon("x"));
    x.type = "button"; x.title = "Close (Esc)";
    x.onclick = (e) => { e.stopPropagation(); closeSettings(); };
    const old = v.querySelector(".mp-scroll");
    const top = old && old.dataset.sec === setv.sec ? old.scrollTop : 0;
    const body = h("div", "mp-body set-body");
    SECS.find((s) => s[0] === setv.sec)[2](body);
    const sc = h("div", "mp-scroll", body);
    sc.dataset.sec = setv.sec;
    v.replaceChildren(h("div", "mp-vh", h("b", "", "Settings"), h("div", "r", x)), h("div", "set-wrap", nav, sc));
    sc.scrollTop = top;
  }
  if (window.speechSynthesis) speechSynthesis.onvoiceschanged = () => { if (setv.open && setv.sec === "voice") renderSettings(); };

  // ---------- updates: the installed Foxpit looks for a newer one ----------
  // The backend downloads a newer release in the background, checks it and
  // puts it in place at once (the next start runs it); the title bar then
  // offers a restart now, and Settings › About says where it stands.
  const UPD = { s: null, timer: 0 };
  async function updFetch(path, post) {
    try {
      const r = await fetch("/api/update" + (path || ""), post ? { method: "POST" } : {});
      if (r.ok) UPD.s = await r.json();
    } catch {}
    drawUpdate();
    clearTimeout(UPD.timer);
    if (UPD.s && (UPD.s.state === "checking" || UPD.s.state === "downloading" || UPD.s.state === "installing")) UPD.timer = setTimeout(() => updFetch(), 1000);
    return UPD.s;
  }
  function updCheck() { if (S().autoUpdate !== false && UPD.s && UPD.s.installed) updFetch("/check", true); }
  setTimeout(updCheck, 12000);
  setInterval(updCheck, 30 * 60 * 1000);
  setTimeout(() => updFetch(), 0);
  function updInstall(btn) {
    const go = async () => {
      try {
        const r = await fetch("/api/update/install", { method: "POST" });
        if (!r.ok) { flash((await r.text()) || "The update did not start."); return; }
        flash("Restarting into Foxpit " + UPD.s.latest + "…");
      } catch { flash("The update did not start."); }
    };
    if (runs.size) confirmIn(btn, runs.size === 1 ? "A chat is running · restart anyway" : runs.size + " chats running · restart anyway", go);
    else go();
  }
  function drawUpdate() {
    const s = UPD.s;
    let pill = $("#updPill");
    const show = !!(s && s.state === "ready");
    if (show && !pill) {
      pill = h("button", "upd-pill", icon("spark"), h("span", "", "Update ready"));
      pill.id = "updPill"; pill.type = "button";
      pill.onclick = (e) => { e.stopPropagation(); updInstall(pill); };
      $("#acctPill").before(pill);
    }
    if (pill) {
      pill.hidden = !show;
      if (show) pill.title = "Foxpit " + s.latest + " is installed. Restart to use it now, or it opens the next time you start Foxpit." + (s.notes ? "\n\n" + s.notes : "");
    }
    if (setv.open && setv.sec === "about") renderSettings();
  }
  const updAgo = (ms) => { const m = Math.round((Date.now() - ms) / 60000); return m < 1 ? "just now" : m < 60 ? m + " min ago" : Math.round(m / 60) + " h ago"; };
  function secAbout(w) {
    const s = UPD.s || { current: "", state: "idle" };
    const box = h("div", "mp-rt");
    row(box, "Version", "Foxpit " + (s.current || "dev") + (s.current === "dev" ? " · a development build" : ""), null);
    if (!s.installed) {
      row(box, "Updates", (/Mac/i.test(navigator.platform || "") ? "This copy doesn't run from Foxpit.app in a folder it may change (Applications), so it doesn't update itself." : "This copy runs from outside the install folder, so it doesn't update itself. Install Foxpit with FoxpitSetup to get updates."), null);
    } else {
      row(box, "Update automatically", "Look for a new Foxpit every half hour, download it in the background and put it in. The next start runs it; your chats stay.", togS("autoUpdate"));
      let sub = "";
      const ctl = [];
      if (s.state === "checking") sub = "Looking for a newer Foxpit…";
      else if (s.state === "downloading") sub = "Downloading Foxpit " + s.latest + (s.size ? " · " + Math.round((s.got / s.size) * 100) + "%" : "") + "…";
      else if (s.state === "installing") sub = "Putting Foxpit " + s.latest + " in…";
      else if (s.state === "ready") {
        sub = "Foxpit " + s.latest + " is installed. Restart to use it now, or it opens the next time you start Foxpit.";
        const b = h("button", "mp-btn acc", "Restart to update");
        b.type = "button";
        b.onclick = (e) => { e.stopPropagation(); updInstall(b); };
        ctl.push(b);
      } else if (s.state === "error") sub = "The last check failed: " + s.error;
      else sub = s.checked ? "You have the newest Foxpit · checked " + updAgo(s.checked) + "." : "Not checked yet.";
      if (s.state !== "ready") {
        const b = h("button", "mp-btn", "Check now");
        b.type = "button";
        b.disabled = s.state === "checking" || s.state === "downloading" || s.state === "installing";
        b.onclick = (e) => { e.stopPropagation(); updFetch("/check", true); };
        ctl.push(b);
      }
      row(box, "Updates", sub, h("div", "upd-ctl", ...ctl));
      if (s.state === "ready" && s.notes) box.append(h("div", "mp-set upd-notes", h("div", "", h("div", "t", "What's new in " + s.latest), h("div", "sub", s.notes))));
    }
    w.append(h("div", "mp-sec", "About"), box);
  }

  // ---------- import: chats from Claude Code and Codex ----------
  // A Claude Code chat comes in on its own session and goes on from there.
  // A Codex chat can't be resumed by Claude Code, so its first new message
  // carries the conversation so far.
  const impv = { open: false, list: null, err: "", agent: "all", q: "", busy: "", syncing: false };
  const AGENT_NAME = { claude: "Claude Code", codex: "Codex" };
  function since(t) {
    const s = (Date.now() - new Date(t)) / 1000;
    if (s < 60) return "now";
    if (s < 3600) return Math.floor(s / 60) + "m";
    if (s < 86400) return Math.floor(s / 3600) + "h";
    if (s < 86400 * 30) return Math.floor(s / 86400) + "d";
    return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
  const fmtSize = (n) => (n > 1e6 ? (n / 1e6).toFixed(n > 1e7 ? 0 : 1) + " MB" : Math.max(1, Math.round(n / 1e3)) + " KB");
  const importedChat = (s) => D.chats.find((c) => (c.imported && c.imported.agent === s.agent && c.imported.id === s.id) || (s.agent === "claude" && c.session === s.id));
  async function loadImports() {
    impv.err = "";
    try {
      const r = await fetch("/api/project/import/list").then((x) => x.json());
      impv.list = r.sessions || [];
    } catch { impv.err = "Import works in the Foxpit app."; impv.list = []; }
    if (impv.open) renderImport();
  }
  function openImport() {
    impv.open = true;
    closeMenu(); closeAcctPop();
    $(".app").classList.remove("rail-on");
    if (mpv.open) closeMp();
    if (setv.open) closeSettings();
    let v = $("#impView");
    if (!v) { v = h("div", "mp-view imp-view"); v.id = "impView"; $(".main").append(v); }
    v.hidden = false;
    requestAnimationFrame(() => v.classList.add("in"));
    renderImport();
    loadImports();
  }
  function closeImport() {
    impv.open = false;
    const v = $("#impView");
    if (v) { v.classList.remove("in"); setTimeout(() => { if (!impv.open) v.hidden = true; }, 200); }
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && impv.open && !document.querySelector(".mp-pop,.lightbox")) { e.stopPropagation(); closeImport(); }
  }, true);
  // a session's model, as one of Foxpit's
  function importModel(agent, model) {
    const prov = agent === "claude" ? "claude" : "codex";
    const a = (D.accounts || []).find((x) => x.provider === prov && x.models && x.models.length) || D.accounts[0];
    const m = (model && a.models.find((x) => x.id.endsWith("/" + model) || x.id === model)) || a.models[0];
    return [a.id, m.id];
  }
  // an imported chat keeps up with its original: while nothing was said to it
  // in Foxpit, a newer original (the same chat gone on in Claude Code or
  // Codex) is read again in its place
  const srcTime = (s) => Date.parse(s.updated) || 0;
  const staleImport = (c, s) => !!(c && c.imported && !c.imported.local && !runs.has(c.id) &&
    (srcTime(s) > (c.imported.at || 0) || (c.imported.size && s.size !== c.imported.size)));
  async function readImport(s) {
    let r;
    try { r = await fetch("/api/project/import/read?file=" + encodeURIComponent(s.file)).then((x) => x.json()); }
    catch { r = { error: "Foxpit's backend did not answer." }; }
    if (r.error) return { error: r.error };
    const [account, model] = importModel(s.agent, (r.info && r.info.model) || s.model);
    let msgs = r.messages || [];
    const cut = Math.max(0, msgs.length - 400);
    msgs = msgs.slice(cut);
    const messages = [{ role: "note", text: "Imported from " + AGENT_NAME[s.agent] + " · " + new Date(s.updated).toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
      (cut ? " · " + cut + " earlier messages left out" : "") }];
    for (const x of msgs) {
      if (x.role === "user") { messages.push({ role: "user", text: x.text || "" }); continue; }
      const parts = (x.parts || []).map((p) => p.k === "tool"
        ? { k: "tool", id: p.id || "t" + Math.random().toString(36).slice(2, 8), name: p.name || "tool", input: p.input || {}, ok: p.ok == null ? true : p.ok, out: (p.out || "").slice(0, 1500) }
        : { k: "text", text: p.text || "" });
      if (parts.length) messages.push({ role: "assistant", account, model, when: x.when || "", parts });
    }
    return { account, model, messages };
  }
  // a new chat from an original; returns it, or an error string
  async function importOne(s) {
    const r = await readImport(s);
    if (r.error) return r.error;
    const cwd = s.cwd || D.projectPath;
    if (cwd && !D.projects.some((p) => p.path === cwd)) D.projects.push({ path: cwd, name: base(cwd) });
    const c = Object.assign(freshChat(), {
      title: (s.title || "Imported chat").slice(0, 48), account: r.account, model: r.model, cwd, messages: r.messages, state: "done",
      session: s.agent === "claude" ? s.id : "", imported: { agent: s.agent, id: s.id, at: srcTime(s), size: s.size }, importCtx: s.agent !== "claude", updated: srcTime(s) || Date.now(),
    });
    fitEffort(c);
    D.chats.unshift(c);
    return c;
  }
  // the original went on: read it again into the same chat
  async function refreshImport(c, s) {
    const r = await readImport(s);
    if (r.error || !staleImport(c, s)) return false;
    // nothing said here may be lost: every message written to this chat must
    // be in the original too (an older import gone on in Foxpit has no
    // "local" mark yet)
    const said = (list) => list.filter((m) => m.role === "user").map((m) => String(m.text || "").trim().slice(0, 200));
    const now = said(r.messages);
    let at = 0;
    for (const t of said(c.messages)) {
      const i = now.indexOf(t, at);
      if (i < 0) { c.imported.local = true; return false; }
      at = i + 1;
    }
    c.messages = r.messages;
    c.imported.at = srcTime(s);
    c.imported.size = s.size;
    c.updated = Math.max(c.updated || 0, srcTime(s));
    return true;
  }
  async function bringIn(s) {
    const have = importedChat(s);
    if (have) {
      if (staleImport(have, s)) { impv.busy = s.file; renderImport(); await refreshImport(have, s); impv.busy = ""; save(); }
      closeImport(); openChat(have); return;
    }
    impv.busy = s.file;
    renderImport();
    const c = await importOne(s);
    impv.busy = "";
    if (typeof c === "string") { flash(c); renderImport(); return; }
    save();
    closeImport();
    openChat(c);
    flash(s.agent === "claude" ? "Imported. Your next message goes on in the same Claude Code session." : "Imported. Your next message carries this conversation to the model.");
  }
  // every chat of the last days: new ones come in, imported ones catch up
  async function syncImports(days, quiet) {
    if (impv.syncing) return;
    if (!impv.list) await loadImports();
    const since = Date.now() - days * 864e5;
    // a chat in a temporary folder is a tool's throwaway run, not the person's
    const scratch = (p) => /[\\/](Temp|tmp)[\\/]|^\/var\/folders\/|^\/private\/var\//i.test(p || "");
    const todo = (impv.list || []).filter((s) => srcTime(s) >= since && !scratch(s.cwd));
    impv.syncing = true;
    let added = 0, caught = 0, failed = 0, n = 0;
    for (const s of todo.slice().reverse()) { // oldest first: the newest ends on top
      n++;
      if (!quiet) { impv.busy = "sync:" + n + "/" + todo.length; if (impv.open) renderImport(); }
      const have = importedChat(s);
      if (have) { if (staleImport(have, s) && (await refreshImport(have, s))) caught++; continue; }
      if (quiet) continue;
      const c = await importOne(s);
      if (typeof c === "string") failed++; else added++;
    }
    impv.syncing = false;
    impv.busy = "";
    if (added || caught) { save(); render(); }
    if (impv.open) renderImport();
    if (!quiet) flash(added || caught ? [added ? added + " brought in" : "", caught ? caught + " caught up" : "", failed ? failed + " could not be read" : ""].filter(Boolean).join(" · ") : "Everything is already here and up to date.");
  }
  // imported chats catch up by themselves now and then
  setTimeout(() => { if (SAVES) syncImports(30, true); }, 15000);
  setInterval(() => { if (SAVES && !document.hidden) { impv.list = null; syncImports(30, true); } }, 3 * 60e3);
  // what a Codex chat said so far, for the model that takes it over
  function importContext(c) {
    const lines = [];
    // called before this turn's message joins the chat: all of it is history
    for (const m of c.messages) {
      if (m.role === "user") lines.push("User: " + m.text);
      else if (m.role === "assistant") { const t = (m.parts || []).filter((p) => p.k === "text").map((p) => p.text).join("\n"); if (t) lines.push("Assistant: " + t); }
    }
    let out = "";
    for (let i = lines.length - 1; i >= 0 && out.length < 16000; i--) out = lines[i].slice(0, 4000) + "\n\n" + out;
    return "[This conversation was started in " + AGENT_NAME[(c.imported || {}).agent] + " and brought into Foxpit. What was said so far:]\n\n" + out.trim() + "\n\n[Continue from here.]";
  }
  function renderImport() {
    const v = $("#impView");
    if (!v) return;
    const x = h("button", "icon-btn", icon("x"));
    x.type = "button"; x.title = "Close (Esc)";
    x.onclick = (e) => { e.stopPropagation(); closeImport(); };
    const seg = h("div", "opts");
    const all = impv.list || [];
    for (const [k, t] of [["all", "All"], ["claude", "Claude Code"], ["codex", "Codex"]]) {
      const n = k === "all" ? all.length : all.filter((s) => s.agent === k).length;
      const b = h("button", impv.agent === k ? "on" : "", t + (impv.list ? " " + n : ""));
      b.type = "button";
      b.onclick = (e) => { e.stopPropagation(); impv.agent = k; renderImport(); };
      seg.append(b);
    }
    let q = v.querySelector(".imp-q");
    const hadFocus = q && document.activeElement === q;
    q = h("input", "imp-q");
    q.placeholder = "Search titles and folders";
    q.value = impv.q;
    q.oninput = () => { impv.q = q.value; drawRows(); };
    const head = h("div", "mp-vh", h("b", "", "Import chats"), seg, h("div", "r", h("label", "search imp-s", icon("search"), q), x));
    const listBox = h("div", "mp-body imp-body");
    const sc = h("div", "mp-scroll", listBox);
    v.replaceChildren(head, sc);
    if (hadFocus) q.focus();
    function drawRows() {
      listBox.replaceChildren();
      if (!impv.list) { listBox.append(h("div", "mp-fs-in", h("span", "att-spin"), h("span", "dim", "Reading Claude Code and Codex sessions…"))); return; }
      if (impv.err) { listBox.append(h("div", "why", impv.err)); return; }
      const words = impv.q.toLowerCase().split(/\s+/).filter(Boolean);
      const rows = all.filter((s) => (impv.agent === "all" || s.agent === impv.agent) && words.every((w) => (s.title + " " + s.cwd + " " + (s.model || "")).toLowerCase().includes(w)));
      const all30 = h("button", "mp-btn acc", impv.busy.startsWith("sync:") ? "Bringing in " + impv.busy.slice(5) + "…" : "Bring in the last 30 days");
      all30.type = "button";
      all30.disabled = !!impv.busy;
      all30.title = "Every chat of the last 30 days comes in; ones already here catch up with what was said since.";
      all30.onclick = (e) => { e.stopPropagation(); syncImports(30); };
      listBox.append(h("div", "imp-top", h("div", "dim imp-note", "Chats from Claude Code (this computer's and every Magpie account's) and Codex, newest first. Bringing one in leaves the original as it is, and an imported chat keeps up with it until you write to it here."), all30));
      if (!rows.length) { listBox.append(h("div", "dim", all.length ? "Nothing matches." : "No chats found.")); return; }
      const box = h("div", "mp-rt");
      for (const s of rows.slice(0, 250)) {
        const have = importedChat(s);
        const b = h("button", "mp-btn" + (have ? "" : " acc"), impv.busy === s.file ? "Bringing in…" : have ? (staleImport(have, s) ? "Update" : "Open") : "Import");
        b.type = "button";
        b.disabled = !!impv.busy;
        b.onclick = (e) => { e.stopPropagation(); bringIn(s); };
        const badge = h("span", "imp-b " + s.agent, s.agent === "claude" ? "C" : "◎");
        badge.title = AGENT_NAME[s.agent];
        const meta = [base(s.cwd || "") || "no folder", s.model || "", fmtSize(s.size)].filter(Boolean).join(" · ");
        const row = h("div", "imp-r", badge, h("div", "mid", h("div", "t", s.title), h("div", "sub", meta)), h("span", "dim when", since(s.updated)), b);
        row.title = (s.cwd || "") + "\n" + s.file;
        box.append(row);
      }
      listBox.append(box);
      if (rows.length > 250) listBox.append(h("div", "dim", rows.length - 250 + " more: search to find them."));
    }
    drawRows();
  }

  // ---------- first start: what Foxpit needs, one step at a time ----------
  const setup = { open: false, st: null, busy: false };
  async function checkSetup() {
    if (!SAVES || setup.busy) return setup.st;
    setup.busy = true;
    try { setup.st = await fetch("/api/magpie/setup").then((r) => r.json()); } catch { setup.st = null; }
    setup.busy = false;
    if (setup.open) drawSetup();
    return setup.st;
  }
  function setupSteps() {
    const st = setup.st || {};
    const acc = st.accounts || {};
    const names = { claude: "Claude", codex: "ChatGPT", gemini: "Gemini", antigravity: "Google" };
    const have = Object.entries(acc).filter(([k, n]) => n > 0 && names[k]).map(([k, n]) => names[k] + (n > 1 ? " ×" + n : ""));
    return [
      { id: "claude", title: "Claude Code", ok: !!st.claude, okText: st.claudeVersion || "Installed",
        need: "Foxpit runs your chats with Claude Code. Install it once, in a terminal:", cmd: "npm i -g @anthropic-ai/claude-code" },
      { id: "magpie", title: "Magpie", ok: !!st.magpie && st.gateway !== false, okText: "Running: accounts, models and usage",
        need: st.magpie ? "Magpie is installed but its gateway didn't start." : "Magpie keeps your subscriptions and routes every model. Get it, install it, then come back." },
      { id: "account", title: "A subscription", ok: have.length > 0, okText: have.join(", "),
        need: "Sign in to Claude, ChatGPT or Google. The sign-in opens in Magpie's window and your browser." },
      { id: "project", title: "A project folder", ok: (D.projects || []).length > 0, okText: (D.projects || []).map((x) => x.name).slice(0, 3).join(", "),
        need: "Pick the folder your agents work in. You can add more later." },
    ];
  }
  function drawSetup() {
    let ov = $("#setupOv");
    if (!ov) { ov = h("div", "setup-ov"); ov.id = "setupOv"; document.body.append(ov); requestAnimationFrame(() => ov.classList.add("in")); }
    const steps = setupSteps();
    const done = steps.filter((x) => x.ok).length;
    const list = h("div", "su-steps");
    const btn = (t, cls, fn) => { const b = h("button", "mp-btn" + (cls ? " " + cls : ""), t); b.type = "button"; b.onclick = (e) => { e.stopPropagation(); fn(b); }; return b; };
    let firstOpen = true;
    steps.forEach((x, i) => {
      const open = !x.ok && firstOpen;
      if (!x.ok) firstOpen = false;
      const mark = h("span", "su-mark" + (x.ok ? " ok" : open ? " cur" : ""), x.ok ? icon("check") : String(i + 1));
      const body = h("div", "su-b", h("div", "su-t", x.title), h("div", "su-s", x.ok ? x.okText : x.need));
      if (!x.ok && open) {
        const acts = h("div", "su-acts");
        if (x.id === "claude") {
          const code = h("code", "su-cmd", x.cmd);
          acts.append(code, btn("Copy", "", (b) => { copyText(x.cmd); b.textContent = "Copied"; }), btn("Check again", "acc", () => checkSetup()));
        }
        if (x.id === "magpie") {
          if (!setup.st || !setup.st.magpie) acts.append(btn("Get Magpie", "acc", () => post("/api/magpie/get").then((v) => v && flash("Magpie's download page opened in your browser."))),
            btn("I installed it", "", async () => { await post("/api/magpie/rescan"); checkSetup(); }));
          else acts.append(btn("Try again", "acc", () => checkSetup()), btn("Open Magpie", "", openMagpie));
        }
        if (x.id === "account") for (const [ag, t] of [["claude", "Claude"], ["codex", "ChatGPT"], ["antigravity", "Google"]]) acts.append(btn(t, ag === "claude" ? "acc" : "", () => signIn(ag)));
        if (x.id === "project") acts.append(btn("Open a folder", "acc", async () => { await openFolder(); drawSetup(); }));
        body.append(acts);
      }
      list.append(h("div", "su-step" + (x.ok ? " ok" : open ? " cur" : ""), mark, body));
    });
    const all = done === steps.length;
    const finish = btn(all ? "Start" : "Skip for now", all ? "acc big" : "big", () => closeSetup());
    const card = h("div", "su-card",
      h("div", "su-h", h("img", "su-logo"), h("div", "", h("b", "", all ? "You're set" : "Set up Foxpit"), h("div", "su-sub", all ? "Everything Foxpit needs is here." : done + " of " + steps.length + " ready. Each step checks itself."))),
      list, h("div", "su-f", h("span", "dim", "Settings › Accounts runs this again."), finish));
    card.querySelector(".su-logo").src = "icon.svg";
    card.onclick = (e) => e.stopPropagation();
    ov.replaceChildren(card);
  }
  async function openSetup() {
    setup.open = true;
    drawSetup();
    await checkSetup();
  }
  function closeSetup() {
    setup.open = false;
    S().setupDone = true;
    save();
    const ov = $("#setupOv");
    if (ov) { ov.classList.remove("in"); setTimeout(() => ov.remove(), 220); }
  }
  window.addEventListener("focus", () => { if (setup.open) checkSetup(); });
  // shown by itself once, when something is missing
  async function maybeSetup() {
    if (!SAVES || S().setupDone) return;
    const st = await checkSetup();
    if (!st) return;
    if (setupSteps().some((x) => !x.ok)) openSetup();
    else { S().setupDone = true; save(); }
  }

  // ---------- side widgets: drag by the header to reorder, fold, hide ----------
  const WIDGET_IDS = ["usage", "stats", "requests", "changes", "terminal", "agents"];
  const WIDGET_NAMES = { usage: "Accounts", stats: "Usage", requests: "Requests", changes: "Changes", terminal: "Terminal", agents: "Running agents" };
  let widgetDrag = null;
  function widgetLayout() {
    let l = null;
    try { l = JSON.parse(localStorage.getItem("foxpit.widgets") || "null"); } catch {}
    l = l && Array.isArray(l.order) ? l : { order: ["usage", "stats", "requests", "changes", "terminal", "agents"], folded: [], hidden: ["agents"] };
    for (const id of WIDGET_IDS) if (!l.order.includes(id)) l.order.push(id);
    l.folded = l.folded || []; l.hidden = l.hidden || [];
    return l;
  }
  function setLayout(fn) {
    const l = widgetLayout();
    fn(l);
    try { localStorage.setItem("foxpit.widgets", JSON.stringify(l)); } catch {}
  }
  function widget(id, card, folded) {
    card.classList.add("widget");
    card.classList.toggle("folded", folded);
    card.dataset.w = id;
    const head = card.querySelector(".ch");
    head.prepend(h("span", "grip", h("i"), h("i"), h("i"), h("i"), h("i"), h("i")));
    const fold = h("button", "w-btn", icon("chev"));
    fold.type = "button"; fold.title = "Fold or expand";
    fold.onclick = (e) => {
      e.stopPropagation();
      const now = card.classList.toggle("folded");
      setLayout((l) => { l.folded = now ? [...l.folded, id] : l.folded.filter((x) => x !== id); });
      if (id === "terminal") setTimeout(() => window.dispatchEvent(new Event("resize")), 220);
    };
    const hide = h("button", "w-btn", icon("x"));
    hide.type = "button"; hide.title = "Hide " + WIDGET_NAMES[id];
    hide.onclick = (e) => { e.stopPropagation(); setLayout((l) => { l.hidden.push(id); }); renderSide(); };
    head.append(h("span", "w-tools", fold, hide));
    head.addEventListener("pointerdown", (e) => startWidgetDrag(e, card));
    return card;
  }
  // the card follows the pointer; the others slide aside around a gap
  function startWidgetDrag(e, card) {
    if (e.button !== 0 || e.target.closest("button")) return;
    const body = $("#sideBody"), x0 = e.clientX, y0 = e.clientY;
    let started = false, gap = null;
    const r0 = card.getBoundingClientRect();
    const move = (ev) => {
      if (!started) {
        if (Math.abs(ev.clientY - y0) < 4 && Math.abs(ev.clientX - x0) < 4) return;
        started = true;
        widgetDrag = card;
        gap = h("div", "w-gap");
        gap.style.height = r0.height + "px";
        card.after(gap);
        card.classList.add("lifted");
        card.style.width = r0.width + "px";
        card.style.left = r0.left + "px";
        card.style.top = r0.top + "px";
        document.body.append(card);
        document.body.classList.add("w-dragging");
      }
      const dy = ev.clientY - y0;
      card.style.transform = "translateY(" + dy + "px)";
      const mid = r0.top + r0.height / 2 + dy;
      const others = [...body.querySelectorAll(".widget")];
      let before = null;
      for (const o of others) { const r = o.getBoundingClientRect(); if (mid < r.top + r.height / 2) { before = o; break; } }
      const want = before || body.querySelector(".w-add");
      const there = want ? gap.nextElementSibling === want : gap === body.lastElementChild;
      if (!there) {
        const first = new Map(others.map((o) => [o, o.getBoundingClientRect().top]));
        if (want) body.insertBefore(gap, want); else body.append(gap);
        for (const o of others) {
          const d = first.get(o) - o.getBoundingClientRect().top;
          if (!d) continue;
          o.style.transition = "none"; o.style.transform = "translateY(" + d + "px)";
          requestAnimationFrame(() => { o.style.transition = "transform .18s var(--out)"; o.style.transform = ""; });
        }
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      if (!started) return;
      const g = gap.getBoundingClientRect();
      card.style.transition = "transform .18s var(--out), box-shadow .18s ease";
      card.style.transform = "translateY(" + (g.top - r0.top) + "px)";
      setTimeout(() => {
        card.classList.remove("lifted");
        card.removeAttribute("style");
        gap.replaceWith(card);
        document.body.classList.remove("w-dragging");
        widgetDrag = null;
        const order = [...body.querySelectorAll(".widget")].map((w) => w.dataset.w);
        setLayout((l) => { l.order = [...order, ...l.order.filter((x) => !order.includes(x))]; });
        window.dispatchEvent(new Event("resize"));
      }, 190);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  }

  // ---------- permission mode: what Claude Code may do without asking ----------
  // A headless run can't stop to ask, so the chat says it up front.
  const MODES = [
    { id: "edits", name: "Edit files", note: "Reads and edits files; terminal commands are refused" },
    { id: "full", name: "Full access", note: "Also runs terminal commands, without asking" },
    { id: "plan", name: "Plan only", note: "Reads and plans; changes nothing" },
  ];
  // a chat that never picked one (new, imported) follows the last one picked
  const modeOf = (c) => MODES.find((m) => m.id === (c.mode || S().mode || "edits")) || MODES[0];
  function renderModeMenu() {
    const m = $("#menu"), c = chat(), list = h("div", "list");
    m.classList.remove("narrow");
    m.replaceChildren(h("div", "mh", icon("shield"), h("span", "mh-t", "Permissions"), h("kbd", "", "↑↓")), list,
      h("div", "mf", icon("swap"), "Used from your next message."));
    if (state.menuIndex < 0) state.menuIndex = Math.max(0, MODES.findIndex((x) => x.id === modeOf(c).id));
    MODES.forEach((x, i) => {
      const curM = x.id === modeOf(c).id;
      const b = h("button", "opt tall" + (curM ? " cur" : "") + (i === state.menuIndex ? " hl" : "") + (x.id === "full" ? " risky" : ""),
        icon("shield", "pi"), h("span", "two", h("span", "n", x.name), h("span", "sub-l", x.note)), h("span", "note", ""), h("span", "end", curM ? icon("check") : ""));
      b.type = "button";
      b.dataset.idx = i;
      b.onmousemove = () => { if (state.menuIndex !== i) { state.menuIndex = i; mark(); } };
      b.onclick = () => pickMode(x.id);
      list.append(b);
    });
    function mark() { for (const o of list.querySelectorAll(".opt")) o.classList.toggle("hl", +o.dataset.idx === state.menuIndex); }
    m.onkeydown = (e) => {
      if (e.key === "ArrowDown") { state.menuIndex = Math.min(MODES.length - 1, state.menuIndex + 1); mark(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { state.menuIndex = Math.max(0, state.menuIndex - 1); mark(); e.preventDefault(); }
      else if (e.key === "Enter") { pickMode(MODES[state.menuIndex].id); e.preventDefault(); }
    };
  }
  function pickMode(id) {
    const c = chat();
    closeMenu();
    c.mode = id;
    // the choice carries to new chats too, as in Claude's app (Plan stays a one-off)
    if (id !== "plan") S().mode = id;
    withChat(c, renderHeader);
    const chip = $("#modeChip");
    chip?.classList.remove("bump"); void chip?.offsetWidth; chip?.classList.add("bump");
    save();
  }
  // what a refused call wanted, in a line
  function deniedLine(d) {
    const i = d.input || {};
    return d.tool + (i.command ? ": " + i.command : i.file_path ? ": " + base(i.file_path) : i.url ? ": " + i.url : "");
  }
  // allow full access, then ask Claude Code to go on with what it was refused
  function allowAndRetry(c, m) {
    c.mode = "full";
    m.denied = null;
    const here = panes.findIndex((p) => p.chatId === c.id);
    if (here >= 0) inPane(here, () => { renderHeader(); send("You now have full access, including terminal commands. Go on with what was refused."); });
  }

  // ---------- model / account menu ----------
  function menuRows() {
    const c = chat(), q = state.menuQuery.trim().toLowerCase(), rows = [];
    for (const a of D.accounts) {
      const models = a.models.filter((m) => !q || (m.name + " " + a.name).toLowerCase().includes(q));
      if (!models.length) continue;
      rows.push({ group: a, models });
    }
    return rows;
  }
  const EDGE = 12, GAP = 8;
  let menuAnchor = null;
  function openMenu(kind, anchor) {
    const m = $("#menu");
    clearTimeout(closeMenu.t);
    m.classList.remove("closing");
    state.menu = kind;
    state.menuQuery = "";
    state.menuIndex = -1;
    menuAnchor = anchor;
    for (const c of document.querySelectorAll(".chip.open, .tb-crumb.open")) c.classList.remove("open");
    anchor.classList.add("open");
    m.classList.toggle("narrow", kind === "effort");
    m.hidden = false;
    renderMenu();
    placeMenu();
    // restart the open animation on every open
    m.style.animation = "none"; void m.offsetWidth; m.style.animation = "";
    (m.querySelector("input") || m).focus({ preventScroll: true });
  }
  // Pin the menu to the control that opened it: above a composer control,
  // below a header control, its matching edge lined up with the control,
  // and never closer than EDGE to the window.
  function placeMenu() {
    const m = $("#menu"), host = $(".main").getBoundingClientRect(), r = menuAnchor.getBoundingClientRect();
    // the composer's and the account card's controls sit low: open upwards
    const above = menuAnchor.closest(".composer, .acct") != null;
    const fromRail = menuAnchor.closest(".rail") != null;
    const W = m.offsetWidth;
    // from the composer it opens over the whole box, not over its text
    const box = menuAnchor.closest(".composer");
    const vr = box ? box.getBoundingClientRect() : r;
    const room = above ? vr.top - host.top - GAP - EDGE : host.bottom - r.bottom - GAP - EDGE;
    m.style.maxHeight = Math.max(220, Math.min(560, room)) + "px";
    let left = fromRail ? 6 : above || menuAnchor.id === "crumb" ? r.left - host.left : r.right - host.left - W;
    if (!fromRail) left = Math.max(EDGE, Math.min(left, host.width - W - EDGE));
    m.style.left = left + "px";
    m.style.right = "auto";
    if (above) { m.style.top = "auto"; m.style.bottom = (host.bottom - vr.top + GAP) + "px"; }
    else { m.style.bottom = "auto"; m.style.top = (r.bottom - host.top + GAP) + "px"; }
    const ox = Math.max(0, Math.min(W, r.left + r.width / 2 - host.left - left));
    m.style.setProperty("--ox", ox + "px");
    m.style.setProperty("--oy", above ? "100%" : "0%");
    m.style.setProperty("--dy", above ? "4px" : "-4px");
  }
  function closeMenu() {
    if (!state.menu) return;
    state.menu = null;
    const m = $("#menu");
    for (const c of document.querySelectorAll(".chip.open, .tb-crumb.open")) c.classList.remove("open");
    m.classList.add("closing");
    closeMenu.t = setTimeout(() => { m.hidden = true; m.classList.remove("closing"); }, 120);
  }
  // ---------- effort menu ----------
  const EFFORT_NOTE = { minimal: "fastest", low: "quick", medium: "balanced", high: "careful", xhigh: "thorough", max: "deepest", ultra: "longest thinking" };
  function effortsFor(c) {
    const md = modelOf(c.account, c.model);
    return md && md.efforts && md.efforts.length ? md.efforts : ["low", "medium", "high", "xhigh", "max"];
  }
  function renderEffortMenu() {
    const m = $("#menu"), c = chat(), list = h("div", "list"), levels = effortsFor(c);
    if (state.menuIndex < 0) state.menuIndex = Math.max(0, levels.indexOf(c.effort));
    m.replaceChildren(h("div", "mh", icon("bolt"), h("span", "mh-t", "Reasoning effort"), h("kbd", "", "↑↓")), list,
      h("div", "mf", icon("swap"), "Used from your next message."));
    levels.forEach((lv, i) => {
      const cur = lv === c.effort;
      const b = h("button", "opt" + (cur ? " cur" : "") + (i === state.menuIndex ? " hl" : ""),
        h("span", "lvl", h("i", "", ""), h("i", "", ""), h("i", "", "")), h("span", "n", lv), h("span", "note", EFFORT_NOTE[lv] || ""),
        h("span", "end", cur ? icon("check") : h("kbd", "", "↵")));
      // three bars fill with the level's rank
      const rank = Math.round(((i + 1) / levels.length) * 3);
      [...b.querySelector(".lvl").children].forEach((x, k) => x.classList.toggle("on", k < rank));
      b.type = "button";
      b.dataset.idx = i;
      b.onclick = () => pickEffort(lv);
      b.onmousemove = () => { if (state.menuIndex !== i) { state.menuIndex = i; mark(); } };
      list.append(b);
    });
    function mark() { for (const o of list.querySelectorAll(".opt")) o.classList.toggle("hl", +o.dataset.idx === state.menuIndex); }
    m._mark = mark;
    m._rerender = renderEffortMenu;
    m.tabIndex = -1;
    m.onkeydown = (e) => {
      if (e.key === "ArrowDown") { state.menuIndex = Math.min(levels.length - 1, state.menuIndex + 1); mark(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { state.menuIndex = Math.max(0, state.menuIndex - 1); mark(); e.preventDefault(); }
      else if (e.key === "Enter") { pickEffort(levels[state.menuIndex]); e.preventDefault(); }
      else if (e.key === "Escape") closeMenu();
    };
  }
  function pickEffort(lv) {
    const c = chat();
    closeMenu();
    if (!lv || c.effort === lv) return;
    c.effort = lv;
    renderHeader();
    const chip = $("#effortChip");
    chip.classList.remove("bump"); void chip.offsetWidth; chip.classList.add("bump");
  }
  // keep the effort one the chosen model offers: the same, else the nearest below
  function fitEffort(c) {
    const levels = effortsFor(c);
    if (levels.includes(c.effort)) return;
    const order = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
    const want = order.indexOf(c.effort);
    c.effort = [...levels].reverse().find((l) => order.indexOf(l) <= want) || levels[0];
  }

  function renderMenu() {
    const m = $("#menu"), c = chat();
    m.onkeydown = null;
    if (state.menu === "effort") return renderEffortMenu();
    if (state.menu === "project") return renderProjectMenu();
    if (state.menu === "alerts") return renderAlertsMenu();
    if (state.menu === "mode") return renderModeMenu();
    const input = h("input");
    input.placeholder = "Switch model or account…";
    input.value = state.menuQuery;
    input.oninput = () => { state.menuQuery = input.value; state.menuIndex = input.value.trim() ? 0 : -1; renderMenuBody(); };
    input.onkeydown = menuKeys;
    const list = h("div", "list");
    m.replaceChildren(h("div", "mh", icon("search"), input, h("kbd", "", kb("Ctrl M"))), list,
      h("div", "mf", icon("swap"), "Switching keeps this conversation and its context."));
    renderMenuBody();
    function renderMenuBody() {
      list.replaceChildren();
      let i = 0;
      const rows = menuRows();
      const q = state.menuQuery.trim(), cm = q ? customModel(q) : null;
      const exact = cm && rows.some((r) => r.models.some((md) => md.id === cm.id));
      if (!rows.length && !cm) list.append(h("div", "empty", "No model matches"));
      for (const { group: a, models } of rows) {
        // the tighter of the two windows is the one that matters
        const used = a.fiveHour == null && a.week == null ? a.who
          : (a.week ?? -1) > (a.fiveHour ?? -1) ? "week " + a.week + "%" : "5h " + a.fiveHour + "%";
        list.append(h("div", "grp", h("span", "", a.name), h("span", "", used)));
        for (const md of models) {
          const cur = a.id === c.account && md.id === c.model;
          const same = a.id !== c.account && a.id !== "auto" && md.name === modelName(c.account, c.model);
          const note = cur ? c.effort : same ? "fresh quota" : md.note;
          const end = h("span", "end", cur ? icon("check") : h("kbd", "", "↵"));
          const b = h("button", "opt" + (cur ? " cur" : "") + (i === state.menuIndex ? " hl" : ""),
            pv(a.provider), h("span", "n", md.name), h("span", "note", note || ""), end);
          b.type = "button";
          b.dataset.idx = i;
          b.onclick = () => choose(a.id, md.id);
          b.onmousemove = () => { if (state.menuIndex !== +b.dataset.idx) { state.menuIndex = +b.dataset.idx; mark(); } };
          list.append(b);
          i++;
        }
      }
      if (cm && !exact) {
        const b = h("button", "opt custom" + (i === state.menuIndex ? " hl" : ""), icon("plus"), h("span", "n", "Use “" + cm.name + "” as a model"),
          h("span", "note", PNAME[cm.pid] || cm.pid), h("span", "end", h("kbd", "", "↵")));
        b.type = "button";
        b.dataset.idx = i;
        b.onclick = () => useCustom(q);
        b.onmousemove = () => { if (state.menuIndex !== +b.dataset.idx) { state.menuIndex = +b.dataset.idx; mark(); } };
        list.append(b);
      } else if (!q) list.append(h("div", "menu-tip", "Type any model name to use one that isn't listed, like claude-opus-4-7 or codex/gpt-5.5."));
      mark();
    }
    function mark() {
      for (const o of list.querySelectorAll(".opt")) o.classList.toggle("hl", +o.dataset.idx === state.menuIndex);
      list.querySelector(".opt.hl")?.scrollIntoView({ block: "nearest" });
    }
    m._rerender = renderMenuBody;
    m._mark = mark;
  }
  function menuKeys(e) {
    const flat = menuRows().flatMap((r) => r.models.map((md) => [r.group.id, md.id]));
    const extra = state.menuQuery.trim() && !flat.some((f) => f[1] === (customModel(state.menuQuery) || {}).id) ? 1 : 0;
    if (e.key === "ArrowDown") { state.menuIndex = Math.min(flat.length - 1 + extra, state.menuIndex + 1); $("#menu")._mark(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { state.menuIndex = Math.max(0, state.menuIndex - 1); $("#menu")._mark(); e.preventDefault(); }
    else if (e.key === "Enter") {
      const p = flat[state.menuIndex];
      if (p) choose(p[0], p[1]); else if (state.menuQuery.trim()) useCustom(state.menuQuery);
      e.preventDefault();
    }
    else if (e.key === "Escape") { closeMenu(); }
  }
  function choose(accountId, modelId) {
    const c = chat();
    closeMenu();
    if (c.account === accountId && c.model === modelId) return;
    const said = (m) => (m.text || "") + (m.parts || []).map((p) => (p.k === "think" ? "" : p.text || "")).join(" ");
    const words = c.messages.reduce((n, m) => n + said(m).split(/\s+/).filter(Boolean).length, 0);
    c.account = accountId;
    c.model = modelId;
    fitEffort(c);
    if (c.messages.length) c.messages.push({ role: "switch", account: accountId, model: modelId, tokens: Math.max(0.1, Math.round(words * 1.4 / 100) / 10) + "k" });
    render();
    save();
  }

  // ---------- projects (the folders chats work in) ----------
  const inProject = (c) => !SAVES || (c.cwd || "") === D.projectPath;
  let gitInfo = null, projectError = "";
  function setProject(path) {
    D.projectPath = path;
    D.project = path ? base(path) || path : "";
    gitInfo = null;
    if (path) refreshGit();
  }
  async function refreshGit() {
    if (!SAVES || !D.projectPath) return;
    const at = D.projectPath;
    try { const g = await fetch("/api/project/git?dir=" + encodeURIComponent(at)).then((r) => r.json()); if (at === D.projectPath) { const was = !!(gitInfo && gitInfo.repo); gitInfo = g; if (was !== !!g.repo) panes.forEach((_, i) => inPane(i, renderHeader)); } } catch {}
    renderCrumb();
  }
  function renderCrumb() {
    $("#proj").textContent = D.projectPath ? D.project : "Open a folder";
    const g = SAVES ? gitInfo : { repo: true, branch: D.worktree };
    const br = g && g.repo ? g.branch : "";
    $("#brSep").hidden = !br;
    $("#wtName").textContent = br;
    const bits = [];
    if (!SAVES) bits.push(D.branch);
    else if (g && g.repo) { if (g.ahead) bits.push("↑" + g.ahead); if (g.behind) bits.push("↓" + g.behind); if (g.dirty) bits.push(g.dirty + " changed"); }
    $("#branchBadge").textContent = bits.join(" ");
    $("#crumb").title = D.projectPath || "Open a project folder";
  }
  function latestChat() {
    const mine = D.chats.filter(inProject).sort((x, y) => (y.updated || 0) - (x.updated || 0));
    if (mine.length) return mine[0];
    const n = freshChat(D.chats.find((c) => c.id === state.chatId) || null);
    D.chats.unshift(n);
    return n;
  }
  // make a folder the current project (adding it the first time)
  async function openProject(path, opt = {}) {
    let r;
    try { r = await fetch("/api/project/open", { method: "POST", body: JSON.stringify({ path }) }).then((x) => x.json()); }
    catch { r = { error: "Foxpit could not reach its backend." }; }
    return useProject(r, opt);
  }
  async function openFolder() {
    closeMenu();
    let r;
    try { r = await fetch("/api/project/pick", { method: "POST" }).then((x) => x.json()); }
    catch { r = { error: "Foxpit could not reach its backend." }; }
    if (r.canceled) return false;
    return useProject(r, {});
  }
  function useProject(r, opt) {
    if (r.error) { projectError = r.error; if (!opt.quiet) openMenu("project", $("#crumb")); return false; }
    projectError = "";
    D.projects = D.projects.filter((p) => p.path !== r.path);
    D.projects.unshift({ path: r.path, name: r.name, trusted: !r.trustError, used: Date.now() });
    if (opt.quiet && r.path === D.projectPath) { save(); return true; }
    setProject(r.path);
    gitInfo = r.git || null;
    closeMenu();
    state.chatId = latestChat().id;
    render();
    save();
    if (!opt.quiet) $("#input").focus();
    return true;
  }
  function renderProjectMenu() {
    const m = $("#menu"), list = h("div", "list");
    m.replaceChildren(h("div", "mh", icon("folder"), h("span", "mh-t", "Projects"), h("kbd", "", String(D.projects.length))), list);
    if (projectError) list.append(h("div", "err", projectError));
    for (const p of D.projects) {
      const cur = p.path === D.projectPath;
      const count = D.chats.filter((c) => !c.sub && c.cwd === p.path && c.messages.length).length;
      const b = h("button", "opt tall" + (cur ? " cur" : ""), icon("folder", "pi"),
        h("span", "two", h("span", "n", p.name), h("span", "proj-path", p.path)),
        h("span", "note", count ? count + (count === 1 ? " chat" : " chats") : ""), h("span", "end", cur ? icon("check") : ""));
      b.type = "button";
      b.onclick = () => (cur ? closeMenu() : openProject(p.path));
      list.append(b);
    }
    const add = h("button", "opt add tall", icon("plus", "pi"),
      h("span", "two", h("span", "n", "Open folder…"), h("span", "proj-path", "A repo, C:\\CLLL, any folder")), h("span", "note", ""), h("span", "end", ""));
    add.type = "button";
    add.onclick = () => openFolder();
    list.append(add);
  }
  function noProject() {
    const open = h("button", "btn pri", icon("folder"), "Open a folder");
    open.type = "button";
    open.onclick = (e) => { e.stopPropagation(); openFolder(); };
    return h("div", "empty-state", icon("folder", "big"), h("h3", "", "Pick a folder to work in"),
      h("p", "", "Chats run Claude Code inside a project folder, as if you opened it there in a terminal. Each folder keeps its own chats."), open);
  }
  function emptyChat() {
    return h("div", "empty-state", icon("fox", "big"), h("h3", "", D.project || "New chat"),
      h("p", "", "Ask anything. Claude Code works in " + (D.projectPath || "this folder") + " and can read and edit its files."));
  }

  // ---------- composer ----------
  // One turn is one Claude Code run in the project folder, through Magpie.
  // The chat keeps Claude Code's session id, so the next turn (on whatever
  // model is picked by then) carries the whole conversation.
  const runs = new Map(); // chat id → its open socket
  const clock = (t) => new Date(t || Date.now()).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  // while text streams, only the answer being written is redrawn
  const patchQueued = new Set();
  function patchLast(c) {
    if (patchQueued.has(c.id)) return;
    patchQueued.add(c.id);
    requestAnimationFrame(() => {
      patchQueued.delete(c.id);
      withChat(c, () => {
        const col = $("#col"), last = col.lastElementChild, m = c.messages[c.messages.length - 1];
        if (!last || !m || PN().shownCount !== c.messages.length) return renderMessages();
        const box = $("#msgs"), stick = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
        col.replaceChild(msgNode(m), last);
        drawTodos();
        if (stick) box.scrollTop = box.scrollHeight;
        else markFresh(c);
      });
    });
  }
  function setRunning(c, on) {
    c.state = on ? "running" : "done";
    if (!on) { const lm = c.messages[c.messages.length - 1]; if (lm && lm.parts) syncSubs(c, lm); reportSpawn(c); if (c.wt) setTimeout(() => refreshWt(c, true), 600); }
    renderChats();
    withChat(c, () => { renderHeader(); syncSend(); });
    if (state.tab === "agents" || state.tab === "session") renderSide();
    renderAccountCard();
  }
  // Claude Code's guess at the next message, shown greyed in the empty box
  // as in Claude's own app; Tab takes it
  var suggestions = new Map();
  var BOX_HINT = "Reply, or type / for commands…";
  function showSuggest() {
    const input = $("#input");
    if (!input) return;
    const s = !runs.has(state.chatId) && suggestions.get(state.chatId);
    input.placeholder = s ? s + "    Tab ⇥" : BOX_HINT;
    input.classList.toggle("suggest", !!s);
  }
  function fetchSuggest(c) {
    const waits = [1500, 2500, 4000, 7000];
    let i = 0;
    const next = () => {
      if (i >= waits.length) return;
      setTimeout(async () => {
        if (runs.has(c.id)) return;
        try {
          const j = await fetch("/api/project/suggest?chat=" + encodeURIComponent(c.id)).then((r) => r.json());
          if (j.text) { suggestions.set(c.id, j.text); withChat(c, showSuggest); return; }
        } catch {}
        i++;
        next();
      }, waits[i]);
    };
    next();
  }
  function syncSend() {
    showSuggest();
    const b = $("#composer .send"), typed = !!($("#input")?.value.trim() || (PN().att || []).length);
    const on = runs.has(state.chatId) && !typed;
    b.classList.toggle("stop", on);
    b.title = on ? "Stop (Esc)" : runs.has(state.chatId) ? "Send now: Claude takes it in while it works" : "Send";
    b.firstElementChild.firstElementChild.setAttribute("href", on ? "#i-stop" : "#i-send");
  }
  async function send(text, target) {
    const c = target || chat();
    if (c.sub) { const pp = parentOf(c).chat; if (pp) openChat(pp); return; }
    if (runs.has(c.id)) return;
    suggestions.delete(c.id);
    if (ctxRuns.has(c.id)) { const here = cur; await ctxRuns.get(c.id).catch(() => {}); cur = here; }
    if (SAVES && !D.projectPath) { openFolder(); return; }
    if (SAVES && !(D.projects.find((p) => p.path === D.projectPath) || {}).trusted) await openProject(D.projectPath, { quiet: true });
    if (!c.cwd) c.cwd = D.projectPath;
    if (c.imported) c.imported.local = true; // from now on this chat goes on here
    if (!(await ensureWorktree(c, text))) return;
    const att = target ? [] : PN().att || [];
    if (!target) {
      PN().att = [];
      drawAttachments();
      if (att.some((a) => a.loading)) { PN().att = att; drawAttachments(); flash("The video is still being read."); return; }
    }
    const pics = att.filter((a) => a.kind !== "video"), vids = att.filter((a) => a.kind === "video");
    const images = [];
    const notes = [];
    for (const a of att) {
      if (a.kind === "video") {
        notes.push("[Video \"" + a.name + "\", " + fmtDur(a.dur) + ", " + a.w + "x" + a.h + ": the next " + a.frames.length +
          " images are frames from it, in order, at " + a.frames.map((f) => f.t.toFixed(1) + "s").join(", ") + ".]");
        for (const f of a.frames) images.push({ media: f.media, data: f.data });
      } else images.push({ media: a.media, data: a.data });
    }
    if (!text && att.length) text = vids.length ? (vids.length === 1 && !pics.length ? "Look at this video." : "Look at these.") : pics.length === 1 ? "Look at this image." : "Look at these images.";
    const shown = text;
    if (notes.length) text = notes.join("\n") + "\n\n" + text;
    if (c.importCtx && !c.session) text = importContext(c) + "\n\n" + text;
    const um = { role: "user", text: shown };
    if (pics.length) {
      um.images = pics.map((a) => a.thumb);
      Promise.all(pics.map((a) => keepFull(a.orig || a.data, a.media))).then((f) => { um.full = f; save(); }).catch(() => {});
    }
    if (vids.length) um.videos = await Promise.all(vids.map(async (a) => ({ id: a.id, name: a.name, dur: a.dur, poster: a.poster,
      src: /^\/api\//.test(clips.get(a.id) || "") ? clips.get(a.id) : "", thumbs: await Promise.all(a.frames.map((f) => scaled("data:image/jpeg;base64," + f.data, 160, "image/jpeg", 0.7).then((s) => s.url))) })));
    c.messages.push(um);
    const m = { role: "assistant", account: c.account, model: c.model, when: clock(), parts: [], running: true };
    c.messages.push(m);
    c.updated = Date.now();
    withChat(c, renderMessages);
    const fail = (why) => { m.running = false; m.error = why; runs.delete(c.id); setRunning(c, false); patchLast(c); save(); };
    let b;
    try { b = await fetch("/api/backend").then((r) => (r.ok ? r.json() : Promise.reject(r))); }
    catch { return fail("Chat runs inside the Foxpit app."); }
    const ws = new WebSocket(b.url.replace(/^http/, "ws") + "/chat?key=" + encodeURIComponent(b.key));
    runs.set(c.id, ws);
    setRunning(c, true);
    let ended = false;
    ws.onopen = () => ws.send(JSON.stringify({ prompt: text, model: c.model, effort: c.effort, session: c.session || "", cwd: runDir(c), mode: modeOf(c).id, images,
      account: D.claudeUser || "", auto: D.autoSwitch !== false, allow: c.allow || [], at: c.cutAt || "", chat: c.id, via: !!S().viaMagpie }));
    const t0 = Date.now();
    m.wait = "Starting Claude Code…";
    // the seconds count on its own: drawing the whole reply again each second
    // replayed the approval card's entrance and made the chat jump
    const tick = setInterval(() => {
      if (!m.running) return clearInterval(tick);
      m.secs = Math.round((Date.now() - t0) / 1000);
      withChat(c, () => {
        const last = $("#col") && $("#col").lastElementChild, st = last && last.querySelector(".typing + .status");
        if (st) st.textContent = (m.wait || "Working…") + (m.secs > 3 ? " · " + m.secs + "s" : "");
        else if (m.secs === 4 && last && last.querySelector(".typing")) patchLast(c);
      });
    }, 1000);
    ws.onmessage = (e) => {
      let ev;
      try { ev = JSON.parse(e.data); } catch { return; }
      // a message typed while the reply runs waits at the bottom until the
      // turn Claude takes it in starts; the reply's text goes above it
      const waitingSaid = (x) => x && x.k === "said" && !x.answered;
      const lastText = () => {
        let i = m.parts.length - 1;
        while (i >= 0 && waitingSaid(m.parts[i])) i--;
        const p = m.parts[i];
        if (p && p.k === "text") return p;
        const n = { k: "text", text: "" };
        m.parts.splice(i + 1, 0, n);
        return n;
      };
      const saidToEnd = () => {
        const w = m.parts.filter(waitingSaid);
        if (!w.length || m.parts.slice(-w.length).every(waitingSaid)) return;
        m.parts = m.parts.filter((x) => !waitingSaid(x)).concat(w);
      };
      if (ev.t === "turn") {
        // Claude starts on what was typed: that message settles here, and
        // its answer is written below it, apart from the one before
        const w = (ev.id && m.parts.find((x) => waitingSaid(x) && x.id === ev.id)) || (!ev.id && m.parts.find(waitingSaid));
        if (w) { w.answered = true; m.parts = m.parts.filter((x) => x !== w); m.parts.push(w); }
        return patchLast(c);
      }
      if (ev.t === "account") { m.who = ev.text; return patchLast(c); }
      if (ev.t === "said") {
        const p = m.parts.find((x) => x.k === "said" && x.id === ev.id);
        if (p && ev.text) { // not taken: it goes after this reply instead
          m.parts.splice(m.parts.indexOf(p), 1);
          enqueue(c, p.text, []);
        } else if (p) p.sent = true;
        return patchLast(c);
      }
      if (ev.t === "switch") {
        m.parts.push({ k: "hop", from: ev.name, to: ev.text });
        m.who = ev.text;
        m.wait = "Continuing on " + ev.text.split("@")[0] + "…";
        if (ev.session) c.session = ev.session;
        loadAccounts(true);
        return patchLast(c);
      }
      if (ev.t === "status") m.wait = ev.text;
      else if (ev.t === "session") {
        c.session = ev.session; c.importCtx = false; c.cutAt = ""; m.wait = "Waiting for the model…";
        if (ev.commands && ev.commands.length) {
          const had = new Set(S().ccSeen || []);
          const add = ev.commands.map((n) => String(n).replace(/^\//, "")).filter((n) => n && !had.has(n));
          if (add.length) S().ccSeen = [...had, ...add].slice(-400);
        }
        save();
      }
      else m.wait = "";
      // a thought ends when anything else arrives
      const lp = m.parts[m.parts.length - 1];
      if (lp && lp.k === "think" && !lp.secs && ev.t !== "think" && ev.t !== "session" && ev.t !== "status") lp.secs = Math.max(1, Math.round((Date.now() - lp.t0) / 1000));
      // its sub-agents follow once this event is in
      if (ev.parent || ev.t === "tool" || ev.t === "tool_result" || ev.t === "done" || ev.t === "error") queueMicrotask(() => syncSubs(c, m));
      if (ev.t === "spawn") { spawnChat(c, ev); return; }
      if (ev.t === "session" || ev.t === "status") {}
      else if (ev.t === "think") {
        if (lp && lp.k === "think" && !lp.secs) lp.text += ev.text;
        else m.parts.push({ k: "think", text: ev.text, t0: Date.now() });
      }
      else if (ev.t === "ask") {
        m.parts.push({ k: "ask", id: ev.id, name: ev.name, input: ev.input || {}, key: ev.text, state: "waiting" });
        m.wait = "Waiting for your answer";
        if (S().sound && !document.hasFocus()) chime(true);
      }
      else if (ev.parent && (ev.t === "tool" || ev.t === "tool_result" || ev.t === "sub_text")) {
        // a step of a sub-agent; one a sub-agent's own sub-agent took goes under the top card
        const t = m.parts.find((p) => p.k === "tool" && (p.id === ev.parent || (p.kids || []).some((k) => k.id === ev.parent)));
        if (t) {
          t.kids = t.kids || [];
          if (ev.t === "tool") t.kids.push({ id: ev.id, name: ev.name, input: ev.input || {}, at: Date.now() });
          else if (ev.t === "sub_text") t.kids.push({ k: "say", text: ev.text, at: Date.now() });
          else { const k = t.kids.find((x) => x.id === ev.id); if (k) { k.ok = ev.ok !== false; k.out = (ev.text || "").slice(0, 600); } }
          if (t.kids.length > 300) t.kids.splice(0, t.kids.length - 300);
        }
      }
      else if (ev.t === "delta" || ev.t === "text") lastText().text += ev.text;
      else if (ev.t === "tool") m.parts.push({ k: "tool", id: ev.id, name: ev.name, input: ev.input || {}, t0: Date.now() });
      else if (ev.t === "tool_result") {
        const t = m.parts.find((p) => p.k === "tool" && p.id === ev.id);
        if (t) {
          t.ok = ev.ok !== false; t.out = ev.text || ""; t.t1 = Date.now();
          if (ev.agent) t.agent = ev.agent;
          if (ev.images && ev.images.length) {
            Promise.all(ev.images.slice(0, 4).map(thumbOf)).then((th) => { t.images = th; patchLast(c); save(); }).catch(() => {});
            Promise.all(ev.images.slice(0, 4).map((u) => keepFull(u))).then((f) => { t.full = f; save(); }).catch(() => {});
          }
        }
      }
      else if (ev.t === "done" || ev.t === "error") {
        ended = true;
        if (ev.session) c.session = ev.session;
        m.ms = ev.ms || 0;
        m.cost = ev.cost || 0;
        if (ev.denied && ev.denied.length) m.denied = ev.denied;
        if (ev.msg) m.mid = ev.msg;
        if (ev.used) { c.ctx = { used: ev.used, window: ev.window || (c.ctx && c.ctx.window) || 200000, at: Date.now() }; c.ctxDetail = null; }
        if (ev.t === "done" && ev.text && !m.parts.some((p) => p.k === "text" && p.text.trim())) m.parts.push({ k: "text", text: ev.text });
        if (ev.t === "error") m.error = ev.text || "The run failed.";
      }
      if (ev.t === "done" || ev.t === "error") for (const x of m.parts) if (x.k === "said") x.answered = true;
      saidToEnd();
      patchLast(c);
      // a reply in progress is saved every few seconds, so a window closed
      // mid-reply keeps what was already written and done
      if (Date.now() - (m.savedAt || 0) > 3000) { m.savedAt = Date.now(); save(); }
    };
    ws.onclose = () => {
      if (runs.get(c.id) === ws) runs.delete(c.id);
      m.running = false;
      if (!ended && !m.error) m.stopped = true;
      for (const p of m.parts) {
        if (p.k === "tool" && p.ok == null) p.ok = false;
        if (p.k === "ask" && p.state === "waiting") p.state = "expired";
        if (p.k === "think" && !p.secs) p.secs = Math.max(1, Math.round((Date.now() - (p.t0 || Date.now())) / 1000));
      }
      c.updated = Date.now();
      setRunning(c, false);
      patchLast(c);
      notify(c, m);
      voiceReply(c, m);
      mpStale();
      gitCh.at = 0;
      refreshGit();
      if (state.tab === "session") setTimeout(renderSide, 1500);
      save();
      withChat(c, renderCtxChip);
      const q = queues.get(c.id);
      if (q && q.length) { if (m.stopped) q.paused = true; withChat(c, drawQueue); setTimeout(() => nextQueued(c), 350); }
      else if (ended && !m.error && !m.stopped) fetchSuggest(c);
      withChat(c, renderMessages);
    };
  }
  function stop(id) { const ws = runs.get(id); if (ws) ws.close(); }
  // a message typed while the reply runs goes to Claude Code at once, as in
  // Claude's own app: it shows in the reply where it was sent. A video, or
  // a reply that can't take it, waits in the queue instead.
  function sayNow(c, text, att) {
    const ws = runs.get(c.id);
    if (!ws || ws.readyState !== 1 || att.some((a) => a.kind === "video")) return false;
    const m = [...c.messages].reverse().find((x) => x.role === "assistant" && x.running);
    if (!m) return false;
    if (c.imported) c.imported.local = true;
    const pics = att.filter((a) => a.kind !== "video");
    const id = "s" + Date.now().toString(36);
    const part = { k: "said", id, text: text || "", images: pics.map((a) => a.thumb) };
    m.parts.push(part);
    if (pics.length) Promise.all(pics.map((a) => keepFull(a.orig || a.data, a.media))).then((f) => { part.full = f; save(); }).catch(() => {});
    ws.send(JSON.stringify({ t: "say", id, prompt: text || (pics.length === 1 ? "Look at this image." : "Look at these images."),
      images: pics.map((a) => ({ media: a.media, data: a.data })) }));
    patchLast(c);
    save();
    return true;
  }

  // ---------- saved chats ----------
  // file:// preview keeps the sample chats; the app saves its own
  const SAVES = location.protocol !== "file:" && !new URLSearchParams(location.search).has("sample");
  let saveTimer = 0;
  // a saved state that could not be read must never be written over: the
  // chats in it would be gone (17.11: a failed load saved an empty list)
  let stateLoaded = false;
  function save() {
    if (!SAVES || !stateLoaded) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const chats = D.chats.filter((c) => !c.sub || D.chats.some((x) => x.id === c.sub.of)).map((c) => c.sub ? { ...c, messages: [], state: "done" } : ({ ...c, state: c.state === "running" ? "done" : c.state,
        messages: c.messages.filter((m) => m.role !== "typing").map((m) => (m.running ? { ...m, running: false, stopped: true } : m)) }));
      fetch("/api/state", { method: "PUT", body: JSON.stringify({ v: 1, chatId: state.chatId, chats, projects: D.projects, project: D.projectPath, panes: panes.map((p) => p.chatId), active,
        claudeUser: D.claudeUser || "", autoSwitch: D.autoSwitch !== false, settings: S() }) }).catch(() => {});
    }, 300);
  }
  function freshChat(from) {
    const s = S(), pick = s.model && modelOf(s.account, s.model) ? s : null;
    const c = { id: "c" + Date.now().toString(36), title: "New chat", state: "idle",
      account: pick ? pick.account : from ? from.account : D.accounts[0].id,
      model: pick ? pick.model : from ? from.model : D.accounts[0].models[0].id,
      effort: s.effort || (from ? from.effort : "high"), cwd: D.projectPath, changes: [], messages: [], updated: Date.now() };
    fitEffort(c);
    return c;
  }
  // the rail's groups follow the chats: running ones, today's, the rest
  function regroup() {
    const today = new Date().toDateString();
    for (const c of D.chats) {
      if (!c.updated) continue;
      c.group = runs.has(c.id) ? "Running" : new Date(c.updated).toDateString() === today ? "Today" : "Earlier";
    }
    const rank = { Running: 0, Today: 1, Earlier: 2 };
    D.chats.sort((x, y) => (rank[x.group] ?? 3) - (rank[y.group] ?? 3) || (y.updated || 0) - (x.updated || 0));
  }
  async function loadSaved() {
    if (!SAVES) return;
    let s = null;
    for (let i = 0; i < 4; i++) {
      try {
        const r = await fetch("/api/state");
        if (r.status === 404) { stateLoaded = true; break; } // a first start: nothing saved yet
        if (r.ok) { s = await r.json(); stateLoaded = true; break; }
      } catch {}
      await new Promise((ok) => setTimeout(ok, 700 * (i + 1)));
    }
    if (!stateLoaded) setTimeout(() => flash("Your saved chats could not be read, so nothing is saved until Foxpit is restarted. Nothing was lost."), 1500);
    D.projects = s && Array.isArray(s.projects) ? s.projects : [];
    D.claudeUser = (s && s.claudeUser) || "";
    D.autoSwitch = !s || s.autoSwitch !== false;
    D.settings = (s && s.settings) || {};
    applySettings();
    setTimeout(maybeSetup, 600);
    for (const cm of D.settings.customModels || []) {
      const g = (D.accounts || []).find((x) => x.id === cm.provider);
      if (g && !g.models.some((m) => m.id === cm.id)) g.models.push({ id: cm.id, name: cm.name, efforts: [], note: "custom", custom: true });
    }
    // "Edit files" used to be written into every new chat; a chat that
    // never picked a mode now follows the last one picked
    if (!D.settings.modeFollows) {
      for (const c of (s && s.chats) || []) if (c.mode === "edits") delete c.mode;
      D.settings.modeFollows = true;
    }
    // chats saved before projects existed bring their folder in
    for (const c of (s && s.chats) || []) if (c.cwd && !D.projects.some((p) => p.path === c.cwd)) D.projects.push({ path: c.cwd, name: base(c.cwd) });
    D.chats = s && Array.isArray(s.chats) ? s.chats.filter((c) => c.sub || (c.messages && c.messages.length)) : []; // a sub-agent keeps no messages: they come from its chat
    for (const c of D.chats) { if (c.state === "running") c.state = "done"; }
    setProject(s && D.projects.some((p) => p.path === s.project) ? s.project : (D.projects[0] || {}).path || "");
    const keep = D.chats.find((c) => c.id === (s && s.chatId) && inProject(c));
    state.chatId = keep ? keep.id : latestChat().id;
    // the panes as they were
    const more = ((s && s.panes) || []).filter((id) => id !== state.chatId && D.chats.some((c) => c.id === id)).slice(0, MAX_PANES - 1);
    for (const id of more) addPane(id, { quiet: true });
    cur = active = 0;
  }

  // ---------- support: Foxpit is free; a coffee keeps it going ----------
  const SUPPORT_URL = "";
  if (SUPPORT_URL) {
    const sb = $("#supportBtn");
    sb.hidden = false;
    sb.onclick = () => post("/api/open", { url: SUPPORT_URL });
  }
  // ---------- the browser beside the chats ----------
  // A tab of Foxpit's own browser (browser.go), shown live: the page is a
  // picture streamed from a Chromium with no window, and the mouse and keys
  // go back to it. The agents use the same tab through their browser tools.
  const DEVICES = [["iPhone SE", 375, 667], ["iPhone 12 Pro", 390, 844], ["iPhone 15", 393, 852], ["iPhone 14 Pro Max", 430, 932],
    ["Pixel 7", 412, 915], ["Samsung Galaxy S20 Ultra", 412, 915], ["Galaxy Z Fold 5", 344, 882],
    ["iPad Mini", 768, 1024], ["iPad Air", 820, 1180], ["iPad Pro", 1024, 1366], ["Surface Pro 7", 912, 1368]]; // Traycer's list (MIT)
  const BR = { el: null, ws: null, tab: null, st: {}, logs: [], frame: null, fw: 0, fh: 0, device: null, w: null, mark: null, consoleOpen: false };
  function brEl() {
    if (BR.el) return BR.el;
    const el = h("div", "bpane");
    el.innerHTML = `<div class="bp-div" title="Drag to resize"></div>
      <div class="bp-h"><svg class="bp-gl"><use href="#i-globe"/></svg><span class="bp-t">Browser</span><span class="bp-agent" hidden><i></i>agent's tab</span>
        <span class="bp-sp"></span>
        <button class="icon-btn" data-b="tabs" title="Tabs"><svg><use href="#i-layers"/></svg></button>
        <button class="icon-btn" data-b="newtab" title="New tab"><svg><use href="#i-plus"/></svg></button>
        <button class="icon-btn" data-b="close" title="Close the browser"><svg><use href="#i-x"/></svg></button></div>
      <div class="bp-bar">
        <button class="icon-btn" data-b="back" title="Back"><svg><use href="#i-arrow-l"/></svg></button>
        <button class="icon-btn" data-b="forward" title="Forward"><svg><use href="#i-arrow-r"/></svg></button>
        <button class="icon-btn" data-b="reload" title="Reload"><svg><use href="#i-retry"/></svg></button>
        <form class="bp-url"><input spellcheck="false" placeholder="Search or type an address — localhost:5173"></form>
        <button class="icon-btn" data-b="device" title="Device size"><svg><use href="#i-phone"/></svg></button>
        <button class="icon-btn" data-b="mark" title="Mark what's wrong and send it to the chat"><svg><use href="#i-pen"/></svg></button>
        <button class="icon-btn" data-b="devtools" title="Open DevTools"><svg><use href="#i-code"/></svg></button>
      </div>
      <div class="bp-dev" hidden>
        <select class="bp-sel"></select>
        <input class="bp-n" data-n="w" inputmode="numeric"><span class="bp-x">×</span><input class="bp-n" data-n="h" inputmode="numeric">
        <button class="icon-btn" data-b="rotate" title="Rotate"><svg><use href="#i-swap"/></svg></button>
      </div>
      <div class="bp-view" tabindex="0"><div class="bp-frame"><img class="bp-img" draggable="false" alt=""></div>
        <div class="bp-empty"><svg><use href="#i-globe"/></svg><b>Foxpit's browser</b><span>Type an address above, or ask the agent to open your app here.</span></div></div>
      <div class="bp-con" hidden><div class="bp-con-h"><b>Console</b><span class="bp-sp"></span><button data-b="clearlogs">Clear</button></div><div class="bp-con-l"></div></div>
      <div class="bp-foot"><button class="bp-cnt" data-b="console"></button><span class="bp-last"></span></div>`;
    BR.el = el;
    const sel = el.querySelector(".bp-sel");
    sel.append(new Option("Fit to pane", ""));
    for (const [n, w, hh] of DEVICES) sel.append(new Option(n + "  " + w + "×" + hh, n));
    sel.append(new Option("Custom size", "custom"));
    sel.onchange = () => {
      const d = DEVICES.find((x) => x[0] === sel.value);
      if (d) BR.device = { name: d[0], w: d[1], h: d[2], mobile: true };
      else if (sel.value === "custom") BR.device = { name: "Custom", w: +el.querySelector('[data-n="w"]').value || 800, h: +el.querySelector('[data-n="h"]').value || 600, mobile: false };
      else BR.device = null;
      brSize(true);
    };
    for (const n of el.querySelectorAll(".bp-n")) n.onchange = () => {
      const w = Math.max(200, Math.min(3000, +el.querySelector('[data-n="w"]').value || 0)), hh = Math.max(200, Math.min(3000, +el.querySelector('[data-n="h"]').value || 0));
      BR.device = { name: "Custom", w, h: hh, mobile: w < 800 };
      sel.value = "custom";
      brSize(true);
    };
    el.querySelector(".bp-url").onsubmit = (e) => {
      e.preventDefault();
      const v = e.target.querySelector("input").value.trim();
      if (!v) return;
      if (BR.ws && BR.ws.readyState === 1) BR.ws.send(JSON.stringify({ t: "nav", url: v }));
      else brOpen(null, v);
      el.querySelector(".bp-view").focus();
    };
    el.addEventListener("click", (e) => {
      const b = e.target.closest("[data-b]");
      if (!b) return;
      const k = b.dataset.b, send = (m) => BR.ws && BR.ws.readyState === 1 && BR.ws.send(JSON.stringify(m));
      if (k === "close") brClose();
      else if (k === "back" || k === "forward") send({ t: k });
      else if (k === "reload") send({ t: BR.st.loading ? "stop" : "reload" });
      else if (k === "device") { const d = el.querySelector(".bp-dev"); d.hidden = !d.hidden; b.classList.toggle("on", !d.hidden); if (d.hidden && BR.device) { BR.device = null; el.querySelector(".bp-sel").value = ""; brSize(true); } }
      else if (k === "rotate" && BR.device) { BR.device = { ...BR.device, w: BR.device.h, h: BR.device.w }; brSize(true); }
      else if (k === "mark") brMark(!BR.mark);
      else if (k === "devtools") { if (BR.tab) api("/api/project/browser/devtools", { id: BR.tab }).catch(() => flash("DevTools could not open.")); }
      else if (k === "console") { BR.consoleOpen = !BR.consoleOpen; brConsole(); }
      else if (k === "clearlogs") { send({ t: "clearlogs" }); BR.logs = []; brConsole(); brFoot(); }
      else if (k === "newtab") brOpen(null, "about:blank");
      else if (k === "tabs") brTabsMenu(b);
    });
    brInput(el.querySelector(".bp-view"));
    // the divider: drag to give the browser more or less room
    el.querySelector(".bp-div").onpointerdown = (e) => {
      e.preventDefault();
      const x0 = e.clientX, w0 = el.getBoundingClientRect().width, max = $("#panes").getBoundingClientRect().width - 360;
      e.currentTarget.setPointerCapture(e.pointerId);
      $("#panes").classList.add("resizing");
      const mv = (ev) => { BR.w = Math.max(360, Math.min(max, w0 - (ev.clientX - x0))); el.style.flex = "0 0 " + BR.w + "px"; };
      e.currentTarget.addEventListener("pointermove", mv);
      e.currentTarget.addEventListener("pointerup", (ev) => { ev.currentTarget.removeEventListener("pointermove", mv); $("#panes").classList.remove("resizing"); brSize(); }, { once: true });
    };
    new ResizeObserver(() => brSize()).observe(el.querySelector(".bp-view"));
    return el;
  }
  async function api(path, body) {
    const r = await fetch(path, { method: "POST", body: JSON.stringify(body || {}) });
    if (!r.ok) { let m = ""; try { m = (await r.json()).error; } catch {} throw new Error(m || r.statusText); }
    return r.status === 204 ? {} : r.json();
  }
  // open the browser beside the chats: a tab by id, or a new one at url
  async function brOpen(tab, url) {
    BR.want = url && url !== "about:blank" ? url : "";
    const el = brEl();
    if (!el.isConnected) {
      $("#panes").append(el);
      const total = $("#panes").getBoundingClientRect().width;
      el.style.flex = "0 0 " + (BR.w || Math.max(420, Math.round(total * 0.48))) + "px";
      el.classList.add("enter");
      setTimeout(() => el.classList.remove("enter"), 260);
    }
    if (!tab) {
      try { tab = (await api("/api/project/browser/open", { url: url || "about:blank" })).id; }
      catch (e) { flash(String(e.message || e)); return; }
    }
    brConnect(tab);
  }
  function brClose() {
    if (BR.ws) { BR.ws.onclose = null; BR.ws.close(); }
    BR.last = BR.tab || BR.last;
    BR.ws = null; BR.tab = null;
    brMark(false);
    BR.el?.remove();
  }
  async function brConnect(tab) {
    if (BR.ws) { BR.ws.onclose = null; BR.ws.close(); }
    BR.tab = tab; BR.logs = []; BR.st = {}; BR.frame = null;
    const el = brEl();
    el.querySelector(".bp-img").removeAttribute("src");
    el.classList.remove("has-frame");
    const b = await fetch("/api/backend").then((r) => r.json());
    const ws = new WebSocket(b.url.replace(/^http/, "ws") + "/browser?key=" + encodeURIComponent(b.key) + "&tab=" + encodeURIComponent(tab));
    ws.binaryType = "arraybuffer";
    BR.ws = ws;
    let opened = false;
    ws.onopen = () => { opened = true; brSize(true); };
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") {
        const dv = new DataView(e.data);
        BR.fw = dv.getUint32(0); BR.fh = dv.getUint32(4);
        const url = URL.createObjectURL(new Blob([new Uint8Array(e.data, 8)], { type: "image/jpeg" }));
        const img = el.querySelector(".bp-img"), old = BR.frame;
        img.onload = () => { if (old) URL.revokeObjectURL(old); };
        img.src = url; BR.frame = url;
        el.classList.add("has-frame");
        brPlace();
        return;
      }
      const m = JSON.parse(e.data);
      if (m.t === "state") { BR.st = m; brHead(); brFoot(); }
      else if (m.t === "logs") { BR.logs = m.logs || []; brFoot(); brConsole(); }
      else if (m.t === "log") { BR.logs.push(m.log); if (BR.logs.length > 300) BR.logs.shift(); brFoot(); if (BR.consoleOpen) brConsole(); }
      else if (m.t === "closed") { flash("The browser tab closed."); brClose(); }
    };
    ws.onclose = () => {
      if (BR.ws !== ws) return;
      BR.ws = null;
      // a tab that is gone (Foxpit restarted, the browser closed it): a new one
      if (!opened) { if (BR.el?.isConnected) { BR.tab = null; brOpen(null, BR.want || "about:blank"); } return; }
      setTimeout(() => { if (BR.tab === tab && BR.el?.isConnected) brConnect(tab); }, 1500);
    };
  }
  function brHead() {
    const el = BR.el, s = BR.st;
    el.querySelector(".bp-t").textContent = s.title || (s.url && s.url !== "about:blank" ? s.url : "Browser");
    el.querySelector(".bp-agent").hidden = !s.agent;
    const inp = el.querySelector(".bp-url input");
    if (document.activeElement !== inp) inp.value = s.url && s.url !== "about:blank" ? s.url : "";
    el.querySelector('[data-b="back"]').disabled = !s.back;
    el.querySelector('[data-b="forward"]').disabled = !s.forward;
    el.querySelector('[data-b="reload"]').classList.toggle("loading", !!s.loading);
    el.classList.toggle("blank", !s.url || s.url === "about:blank");
  }
  function brFoot() {
    const el = BR.el;
    const errs = BR.logs.filter((l) => l.level === "error").length, warns = BR.logs.filter((l) => l.level !== "error" && l.level !== "log").length;
    const c = el.querySelector(".bp-cnt");
    c.replaceChildren(h("span", errs ? "er" : "", "● " + errs + " error" + (errs === 1 ? "" : "s")), h("span", warns ? "wr" : "", "● " + warns + " warning" + (warns === 1 ? "" : "s")), icon("chev", "chev"));
    c.classList.toggle("open", BR.consoleOpen);
    const last = BR.logs[BR.logs.length - 1];
    el.querySelector(".bp-last").textContent = last ? last.text.slice(0, 140) : "";
  }
  function brConsole() {
    const box = BR.el.querySelector(".bp-con");
    box.hidden = !BR.consoleOpen;
    if (!BR.consoleOpen) return;
    const l = box.querySelector(".bp-con-l");
    l.replaceChildren(...(BR.logs.length ? BR.logs.slice(-150).map((x) => h("div", "bl " + x.level, h("span", "lv", x.level), h("span", "", x.text))) : [h("div", "bl empty", "Nothing yet: errors, warnings and failed requests show here.")]));
    l.scrollTop = l.scrollHeight;
    brFoot();
  }
  async function brTabsMenu(btn) {
    const r = await fetch("/api/project/browser/tabs").then((x) => x.json()).catch(() => ({ tabs: [] }));
    const m = $("#menu");
    m.replaceChildren(h("div", "mh", icon("globe"), h("span", "mh-t", "Browser tabs")));
    const list = h("div", "list");
    for (const t of r.tabs || []) {
      const b = h("button", "opt" + (t.id === BR.tab ? " cur" : ""), icon("globe", "pi"), h("span", "two", h("span", "n", t.title || t.url || "New tab"), h("span", "sub-l", (t.agent ? "agent · " : "") + (t.url || ""))));
      b.onclick = () => { closeMenu(); brConnect(t.id); };
      list.append(b);
    }
    if (!(r.tabs || []).length) list.append(h("div", "opt", "No tabs"));
    m.append(list);
    state.menu = "brtabs";
    m.classList.add("open");
    const rr = btn.getBoundingClientRect(), pr = $("#panes").getBoundingClientRect();
    m.style.left = Math.max(8, rr.right - pr.left - 300) + "px"; m.style.top = (rr.bottom - pr.top + 6) + "px"; m.style.bottom = "auto"; m.style.width = "300px";
  }
  // the size the page is shown at: a device's, or the room the pane has
  let brSizeT = 0;
  function brSize(now) {
    if (!BR.el || !BR.el.isConnected) return;
    clearTimeout(brSizeT);
    brSizeT = setTimeout(() => {
      const v = BR.el.querySelector(".bp-view").getBoundingClientRect();
      const el = BR.el, d = BR.device;
      el.classList.toggle("device", !!d);
      el.querySelector('[data-n="w"]').value = d ? d.w : Math.round(v.width);
      el.querySelector('[data-n="h"]').value = d ? d.h : Math.round(v.height);
      const view = d ? { w: d.w, h: d.h, mobile: !!d.mobile, scale: 2, device: d.name }
        : { w: Math.max(200, Math.round(v.width)), h: Math.max(200, Math.round(v.height)), mobile: false, scale: Math.min(2, window.devicePixelRatio || 1), device: "" };
      if (BR.ws && BR.ws.readyState === 1) BR.ws.send(JSON.stringify({ t: "view", view }));
      brPlace();
    }, now ? 0 : 120);
  }
  // the picture at its size inside the pane: a phone scaled to fit
  function brPlace() {
    const el = BR.el;
    if (!el || !BR.fw) return;
    const v = el.querySelector(".bp-view").getBoundingClientRect(), fr = el.querySelector(".bp-frame");
    if (!BR.device) { fr.style.width = v.width + "px"; fr.style.height = v.height + "px"; fr.style.transform = ""; return; }
    const pad = 28, sc = Math.min(1, (v.width - pad) / (BR.fw + 16), (v.height - pad) / (BR.fh + 16));
    fr.style.width = BR.fw + "px"; fr.style.height = BR.fh + "px";
    fr.style.transform = "scale(" + sc.toFixed(4) + ")";
  }
  // where on the page the mouse is, in the page's own pixels
  function brAt(e) {
    const img = BR.el.querySelector(".bp-img"), r = img.getBoundingClientRect();
    if (!r.width || !BR.fw) return null;
    return { x: (e.clientX - r.left) * BR.fw / r.width, y: (e.clientY - r.top) * BR.fh / r.height, inside: e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom };
  }
  const brMods = (e) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
  const brBtn = (b) => ["left", "middle", "right", "back", "forward"][b] || "none";
  function brInput(view) {
    const send = (m) => BR.ws && BR.ws.readyState === 1 && BR.ws.send(JSON.stringify(m));
    let lastMove = 0;
    view.addEventListener("pointerdown", (e) => {
      if (BR.mark || !BR.frame) return;
      const p = brAt(e); if (!p || !p.inside) return;
      view.focus(); try { view.setPointerCapture(e.pointerId); } catch {}
      send({ t: "mouse", type: "mousePressed", x: p.x, y: p.y, button: brBtn(e.button), buttons: e.buttons, clicks: e.detail || 1, mods: brMods(e) });
      e.preventDefault();
    });
    view.addEventListener("pointerup", (e) => {
      if (BR.mark || !BR.frame) return;
      const p = brAt(e); if (!p) return;
      send({ t: "mouse", type: "mouseReleased", x: p.x, y: p.y, button: brBtn(e.button), buttons: e.buttons, clicks: e.detail || 1, mods: brMods(e) });
    });
    view.addEventListener("pointermove", (e) => {
      if (BR.mark || !BR.frame) return;
      const now = performance.now(); if (now - lastMove < 30) return; lastMove = now;
      const p = brAt(e); if (!p || !p.inside) return;
      send({ t: "mouse", type: "mouseMoved", x: p.x, y: p.y, button: e.buttons & 1 ? "left" : "none", buttons: e.buttons, mods: brMods(e) });
    });
    view.addEventListener("wheel", (e) => {
      if (BR.mark || !BR.frame) return;
      const p = brAt(e); if (!p || !p.inside) return;
      e.preventDefault();
      const k = e.deltaMode === 1 ? 40 : 1;
      send({ t: "mouse", type: "mouseWheel", x: p.x, y: p.y, dx: e.deltaX * k, dy: e.deltaY * k, mods: brMods(e) });
    }, { passive: false });
    view.addEventListener("contextmenu", (e) => e.preventDefault());
    view.addEventListener("keydown", async (e) => {
      if (BR.mark) { if (e.key === "Escape") brMark(false); return; }
      if (!BR.frame) return;
      // paste goes in as text: the page has no clipboard of its own here
      if (mod(e) && e.key.toLowerCase() === "v") {
        e.preventDefault();
        try { const t = await navigator.clipboard.readText(); if (t) send({ t: "text", text: t }); } catch {}
        return;
      }
      e.preventDefault();
      const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey;
      send({ t: "key", type: printable ? "keyDown" : "rawKeyDown", key: e.key, code: e.code, text: printable ? e.key : e.key === "Enter" ? "\r" : "", keyCode: e.keyCode, mods: brMods(e) });
    });
    view.addEventListener("keyup", (e) => {
      if (BR.mark || !BR.frame) return;
      e.preventDefault();
      send({ t: "key", type: "keyUp", key: e.key, code: e.code, keyCode: e.keyCode, mods: brMods(e) });
    });
  }
  // ---------- mark what's wrong, send it to the chat ----------
  function brMark(on) {
    const el = BR.el;
    if (!el) return;
    el.querySelector('[data-b="mark"]').classList.toggle("on", !!on);
    el.querySelector(".bp-mk")?.remove();
    BR.mark = null;
    if (!on || !BR.frame) { if (on) flash("Open a page first."); return; }
    const view = el.querySelector(".bp-view"), img = el.querySelector(".bp-img");
    const layer = h("div", "bp-mk", h("div", "bp-mk-tip", "Draw a box around what's wrong · Esc to stop"));
    view.append(layer);
    BR.mark = { boxes: [] };
    let start = null, box = null;
    layer.onpointerdown = (e) => {
      if (e.target.closest(".bp-note")) return;
      layer.querySelector(".bp-note")?.remove();
      const r = img.getBoundingClientRect();
      start = { x: Math.max(r.left, Math.min(r.right, e.clientX)), y: Math.max(r.top, Math.min(r.bottom, e.clientY)) };
      box?.remove();
      box = h("div", "bp-box");
      layer.append(box);
      try { layer.setPointerCapture(e.pointerId); } catch {}
    };
    layer.onpointermove = (e) => {
      if (!start) return;
      const r = img.getBoundingClientRect(), lr = layer.getBoundingClientRect();
      const x = Math.max(r.left, Math.min(r.right, e.clientX)), y = Math.max(r.top, Math.min(r.bottom, e.clientY));
      Object.assign(box.style, { left: Math.min(x, start.x) - lr.left + "px", top: Math.min(y, start.y) - lr.top + "px", width: Math.abs(x - start.x) + "px", height: Math.abs(y - start.y) + "px" });
    };
    layer.onpointerup = (e) => {
      if (!start) return;
      const r = img.getBoundingClientRect(), b = box.getBoundingClientRect(), lr = layer.getBoundingClientRect();
      start = null;
      if (b.width < 6 || b.height < 6) { box.remove(); box = null; return; }
      // the box in the page's own pixels
      BR.mark.rect = { x: (b.left - r.left) * BR.fw / r.width, y: (b.top - r.top) * BR.fh / r.height, w: b.width * BR.fw / r.width, h: b.height * BR.fh / r.height };
      const errs = BR.logs.filter((l) => l.level === "error");
      const ta = h("textarea", "", null);
      ta.placeholder = "What's wrong here?";
      ta.rows = 3;
      const send = h("button", "btn p", "Send to chat"), cancel = h("button", "btn", "Cancel");
      const note = h("div", "bp-note", ta, h("div", "rw", h("small", "", "Picture + address" + (errs.length ? " + " + errs.length + " console error" + (errs.length === 1 ? "" : "s") : "") + " go along"), cancel, send));
      layer.append(note);
      const top = b.bottom - lr.top + 10, fits = top + 150 < lr.height;
      Object.assign(note.style, { left: Math.max(8, Math.min(lr.width - 308, b.left - lr.left)) + "px", top: (fits ? top : Math.max(8, b.top - lr.top - 160)) + "px" });
      setTimeout(() => ta.focus(), 0);
      cancel.onclick = () => { note.remove(); box.remove(); box = null; };
      send.onclick = () => brSendMark(ta.value.trim());
      ta.onkeydown = (ev) => { if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); brSendMark(ta.value.trim()); } if (ev.key === "Escape") brMark(false); ev.stopPropagation(); };
    };
  }
  async function brSendMark(text) {
    const rect = BR.mark && BR.mark.rect;
    if (!rect || !BR.frame) return;
    const img = await loadImage(BR.frame);
    const k = img.naturalWidth / BR.fw;
    const cv = document.createElement("canvas");
    cv.width = img.naturalWidth; cv.height = img.naturalHeight;
    const g = cv.getContext("2d");
    g.drawImage(img, 0, 0);
    g.strokeStyle = "#ff7a1a"; g.lineWidth = Math.max(3, 3 * k);
    g.strokeRect(rect.x * k, rect.y * k, rect.w * k, rect.h * k);
    const blob = await new Promise((ok) => cv.toBlob(ok, "image/png"));
    const s = BR.st, where = BR.device ? BR.device.name + " (" + BR.device.w + "×" + BR.device.h + ")" : "desktop (" + BR.fw + "×" + BR.fh + ")";
    const errs = BR.logs.filter((l) => l.level === "error").slice(-5).map((l) => "- " + l.text.slice(0, 300));
    const lines = ["In the browser, at " + (s.url || "the page") + " on " + where + ", I marked this (orange box in the picture, at x " + Math.round(rect.x) + ", y " + Math.round(rect.y) + ", " + Math.round(rect.w) + "×" + Math.round(rect.h) + " px):",
      text || "(no note)"];
    if (errs.length) lines.push("", "Console errors:", ...errs);
    brMark(false);
    const i = active;
    inPane(i, () => {
      const input = $("#input");
      input.value = (input.value ? input.value.replace(/\s+$/, "") + "\n\n" : "") + lines.join("\n");
      input.style.height = "auto"; input.style.height = Math.min(180, input.scrollHeight) + "px";
      syncSend();
    });
    await inPane(i, () => attachImage(new File([blob], "marked.png", { type: "image/png" })));
    inPane(i, () => $("#input").focus());
    flash("Added to the chat: send it when ready.");
  }
  // the agent's tab, from its browser_open call
  function brTabOf(t) { const m = String(t.out || "").match(/\[foxpit-tab:([A-Za-z0-9]+)\]/); return m ? m[1] : ""; }
  function browserCard(t) {
    const tab = brTabOf(t), url = (t.input || {}).url || "";
    const b = h("button", "op", "Open browser", icon("arrow-r"));
    b.type = "button";
    b.disabled = t.ok == null && !tab;
    b.onclick = () => brOpen(tab || null, url);
    const st = t.ok == null ? h("span", "spin sm") : null;
    return h("div", "brcard", h("span", "ic", icon("globe")), h("span", "t", h("b", "", "Browser"), h("span", "", url)), st, b);
  }
  on("paneBrowser", "click", (e) => { e.stopPropagation(); if (BR.el && BR.el.isConnected) brClose(); else brOpen(BR.last || null, "about:blank"); });

  // ---------- panes: split, close, resize, drop a chat in ----------
  const MAX_PANES = 3;
  const PANE_HTML = paneEls()[0].innerHTML;
  function focusPane(i) {
    if (i < 0 || i >= panes.length) return;
    cur = i;
    if (active === i) return;
    active = i;
    paneEls().forEach((el, k) => { el.classList.toggle("active", k === i && panes.length > 1); el.classList.toggle("focus", k === i); });
    renderChats(); renderAccountCard(); renderSide();
  }
  function addPane(chatId, opt = {}) {
    if (panes.length >= MAX_PANES) { flash("Up to " + MAX_PANES + " chats side by side."); return -1; }
    const at = opt.at == null ? panes.length : opt.at;
    const el = document.createElement("div");
    el.className = "pane enter";
    el.innerHTML = PANE_HTML;
    const host = $("#panes"), list = paneEls();
    if (at >= list.length) host.insertBefore(el, host.querySelector(":scope > .bpane")); else host.insertBefore(el, list[at]);
    panes.splice(at, 0, { chatId, shownChat: null, shownCount: 0, w: null });
    for (const p of panes) p.w = null;
    layoutPanes();
    if (!opt.quiet) { cur = active = at; render(); save(); setTimeout(() => $("#input")?.focus(), 30); }
    return at;
  }
  // a new pane beside the active one, with a fresh chat in this project
  function splitPane() {
    const n = freshChat(chat());
    D.chats.unshift(n);
    addPane(n.id, { at: active + 1 });
  }
  function closePane(i) {
    if (panes.length < 2) return;
    const el = paneEls()[i];
    panes.splice(i, 1);
    for (const p of panes) p.w = null;
    el.remove();
    layoutPanes();
    cur = active = Math.min(active > i ? active - 1 : active, panes.length - 1);
    render();
    save();
  }
  // widths: each pane's flex share, kept while the user drags a divider
  function layoutPanes() {
    const host = $("#panes");
    host.querySelectorAll(".pane-div").forEach((d) => d.remove());
    paneEls().forEach((el, i) => {
      el.style.flex = panes[i] && panes[i].w ? "0 0 " + panes[i].w + "px" : "1 1 0";
      if (i > 0) {
        const d = document.createElement("div");
        d.className = "pane-div";
        d.title = "Drag to resize";
        d.onpointerdown = (e) => dragDivider(e, i);
        d.ondblclick = () => { for (const p of panes) p.w = null; layoutPanes(); };
        host.insertBefore(d, el);
      }
    });
  }
  function dragDivider(e, i) {
    e.preventDefault();
    const els = paneEls(), a = els[i - 1], b = els[i];
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect(), x0 = e.clientX, total = ra.width + rb.width;
    // freeze every pane at its width, then move the two beside the divider
    els.forEach((el, k) => { panes[k].w = el.getBoundingClientRect().width; el.style.flex = "0 0 " + panes[k].w + "px"; });
    const d = e.currentTarget;
    d.setPointerCapture(e.pointerId);
    $("#panes").classList.add("resizing");
    const move = (ev) => {
      const wa = Math.max(340, Math.min(total - 340, ra.width + ev.clientX - x0));
      panes[i - 1].w = wa; panes[i].w = total - wa;
      a.style.flex = "0 0 " + wa + "px"; b.style.flex = "0 0 " + (total - wa) + "px";
    };
    d.addEventListener("pointermove", move);
    d.addEventListener("pointerup", () => {
      d.removeEventListener("pointermove", move);
      $("#panes").classList.remove("resizing");
      // back to shares, so the window resizing keeps the proportions
      const sum = panes.reduce((n, p) => n + p.w, 0);
      paneEls().forEach((el, k) => { el.style.flex = (panes[k].w / sum).toFixed(4) + " 1 0"; });
      for (const p of panes) p.w = null;
      if (state.menu) placeMenu();
    }, { once: true });
  }
  on("paneSplit", "click", (e) => { e.stopPropagation(); splitPane(); });
  on("paneClose", "click", (e) => { e.stopPropagation(); closePane(active); });
  $("#panes").addEventListener("pointerdown", (e) => {
    const p = e.target.closest(".pane");
    if (p) focusPane(paneEls().indexOf(p));
  }, true);
  $("#panes").addEventListener("focusin", (e) => {
    const p = e.target.closest(".pane");
    if (p) focusPane(paneEls().indexOf(p));
  });
  // drop a chat from the rail: on a pane opens it there, on a pane's edge
  // opens it in a new pane beside
  function dropZone(e) {
    const p = e.target.closest(".pane");
    if (!p) return null;
    const r = p.getBoundingClientRect(), x = e.clientX - r.left;
    const i = paneEls().indexOf(p);
    const edge = Math.min(140, r.width * 0.28);
    if (panes.length < MAX_PANES && x > r.width - edge) return { i, side: "right" };
    if (panes.length < MAX_PANES && x < edge) return { i, side: "left" };
    return { i, side: "here" };
  }
  function clearDrop() { $("#panes").classList.remove("file-over"); paneEls().forEach((el) => el.classList.remove("drop-here", "drop-left", "drop-right")); }
  $("#panes").addEventListener("dragover", (e) => {
    if (e.dataTransfer.types.includes("Files") && !e.dataTransfer.types.includes("text/foxpit-chat")) {
      if (!$("#panes").classList.contains("file-over")) { $("#panes").classList.add("file-over"); peekDrops(); }
      const p = e.target.closest(".pane");
      if (!p) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      clearDrop();
      p.classList.add("drop-here");
      p.querySelector(".drop-hint span").textContent = "Attach";
      return;
    }
    if (!e.dataTransfer.types.includes("text/foxpit-chat")) return;
    const z = dropZone(e);
    if (!z) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    clearDrop();
    const el = paneEls()[z.i];
    el.classList.add("drop-" + z.side);
    el.querySelector(".drop-hint span").textContent = z.side === "here" ? "Open here" : "Open beside";
  });
  $("#panes").addEventListener("dragleave", (e) => { if (!e.relatedTarget || !$("#panes").contains(e.relatedTarget)) clearDrop(); });
  $("#panes").addEventListener("drop", (e) => {
    if (e.dataTransfer.files && e.dataTransfer.files.length && !e.dataTransfer.types.includes("text/foxpit-chat")) {
      e.preventDefault();
      clearDrop();
      const p = e.target.closest(".pane");
      if (!p) return;
      const at = paneEls().indexOf(p);
      focusPane(at);
      const all = [...e.dataTransfer.files];
      const media = all.filter((f) => isVideoFile(f) || isImageFile(f)).slice(0, 6);
      const rest = all.filter((f) => !media.includes(f));
      media.forEach(attachFile);
      if (rest.length) droppedPaths(rest.map((f) => f.name)).then((paths) => {
        if (paths.length) addPaths(at, paths);
        else flash("Drop pictures or videos here; other files go in with the + button.");
      });
      return;
    }
    const id = e.dataTransfer.getData("text/foxpit-chat");
    const z = dropZone(e);
    clearDrop();
    document.body.classList.remove("dragging-chat");
    if (!id || !z) return;
    e.preventDefault();
    const there = panes.findIndex((p) => p.chatId === id);
    if (z.side === "here") {
      if (there >= 0 && there !== z.i) { panes[there].chatId = panes[z.i].chatId; }
      cur = active = z.i;
      state.chatId = id;
      render(); save();
      return;
    }
    if (there >= 0 && panes.length > 1) { focusPane(there); return; }
    addPane(id, { at: z.side === "right" ? z.i + 1 : z.i });
  });

  // ---------- rail foot ----------
  $("#agentsBtn").onclick = () => { setSide(true); state.tab = "agents"; renderSide(); renderAccountCard(); };
  $("#setBtn").onclick = (e) => { e.stopPropagation(); setv.open ? closeSettings() : openSettings(); };
  $("#importBtn").onclick = (e) => { e.stopPropagation(); impv.open ? closeImport() : openImport(); };
  $("#dock").onclick = (e) => {
    const b = e.target.closest("button[data-dock]");
    if (!b) return;
    e.stopPropagation();
    const k = b.dataset.dock, off = app.classList.contains("side-off");
    const tab = (t) => { if (!off && state.tab === t) setSide(false); else { setSide(true); state.tab = t; renderSide(); } };
    if (k === "terminal") tab("terminal");
    if (k === "changes") tab("changes");
    if (k === "panel") setSide(off);
    if (k === "split") splitPane();
    if (k === "alerts") state.menu === "alerts" ? closeMenu() : openMenu("alerts", b);
    if (k === "projects") state.menu === "project" ? closeMenu() : openMenu("project", b);
    if (k === "magpie") mpv.open ? closeMp() : openMp();
    setTimeout(renderAccountCard, 0);
  };

  // ---------- rail: view switch and search ----------
  $("#railView").onclick = (e) => {
    const b = e.target.closest("button[data-view]");
    if (!b) return;
    railView = b.dataset.view;
    railPref("foxpit.railView", railView);
    renderChats();
  };
  $("#chatSearch").addEventListener("input", (e) => { railQuery = e.target.value.trim(); renderChats(); });
  $("#chatSearch").addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.target.value = ""; railQuery = ""; renderChats(); e.target.blur(); e.stopPropagation(); }
    if (e.key === "Enter") { const first = $("#chatList .item"); if (first) first.click(); }
  });

  // ---------- slash commands: "/" opens the list above the composer ----------
  // Foxpit's own act here; Claude Code's (the project's and ~/.claude's
  // commands and skills) go to Claude Code as the message.
  const BUILTIN = [
    { name: "model", desc: "Pick the model for this chat", run: () => openMenu("model", $("#modelChip2")) },
    { name: "effort", desc: "Pick the reasoning effort", run: () => openMenu("effort", $("#effortChip")) },
    { name: "account", desc: "Switch accounts (Claude, ChatGPT, Gemini)", run: () => setTimeout(openAcctPop, 0) },
    { name: "magpie", desc: "Accounts, models, usage and Magpie settings", run: () => openMp() },
    { name: "settings", desc: "Foxpit settings: defaults, voice, sound, text size", run: () => openSettings() },
    { name: "import", desc: "Bring in chats from Claude Code and Codex", run: () => openImport() },
    { name: "setup", desc: "Check what Foxpit needs: Claude Code, Magpie, an account, a folder", run: () => openSetup() },
    { name: "new", desc: kb("Start a new chat (Ctrl+N)"), run: () => $("#newChat").click() },
    { name: "permissions", desc: "What Claude Code may do: edit files, full access, plan only", run: () => openMenu("mode", $("#modeChip")) },
    { name: "clear", desc: "Forget this chat's context; the next message starts fresh", run: () => {
      const c = chat();
      if (!c.messages.length) return;
      c.session = "";
      c.messages.push({ role: "note", text: "Context cleared · the next message starts a new session" });
      withChat(c, renderMessages); save();
    } },
    { name: "rename", desc: "Rename this chat: /rename <title>", arg: true, run: (t) => {
      const c = chat();
      if (!t) return flash("Type a title after /rename");
      c.title = t.slice(0, 80);
      renderChats(); withChat(c, renderHeader); save();
    } },
    { name: "stop", desc: "Stop the running reply (Esc)", run: () => stop(state.chatId) },
    { name: "voice", desc: "Voice chat: talk, pause to send, hear the reply", run: () => setVoice(!voice.on) },
    { name: "dictate", desc: "Type by voice (Windows voice typing)", run: () => dictate() },
    { name: "split", desc: kb("Open another chat beside this one (Ctrl+\\)"), run: () => splitPane() },
    { name: "terminal", desc: "Show the terminal", run: () => { setSide(true); state.tab = "terminal"; renderSide(); } },
    { name: "project", desc: "Switch project or open a folder", run: () => openMenu("project", $("#crumb")) },
    { name: "export", desc: "Copy this chat as Markdown", run: () => copyText(chatMarkdown(chat())).then((ok) => flash(ok ? "Chat copied as Markdown" : "Could not copy")) },
    { name: "cost", desc: "Time and cost of this chat so far", run: () => {
      const c = chat(), turns = c.messages.filter((m) => m.role === "assistant");
      const ms = turns.reduce((n, m) => n + (m.ms || 0), 0), usd = turns.reduce((n, m) => n + (m.cost || 0), 0);
      c.messages.push({ role: "note", text: turns.length + (turns.length === 1 ? " reply" : " replies") + " · " + Math.round(ms / 1000) + "s of work" + (usd ? " · about $" + usd.toFixed(usd < 1 ? 3 : 2) + " at API prices (your plan pays this)" : "") });
      withChat(c, renderMessages); save();
    } },
    { name: "help", desc: "Shortcuts and commands", run: () => {
      const c = chat();
      c.messages.push({ role: "note", text: kb("Enter sends · Shift+Enter new line · Esc stops · Ctrl+M model · Ctrl+N new · Ctrl+\\ split · Ctrl+W close pane · Ctrl+B side panel · Ctrl+K search · type / for commands") });
      withChat(c, renderMessages);
    } },
  ];
  const ccCache = new Map(); // project path → Claude Code's commands
  async function claudeCommands() {
    const dir = D.projectPath || "";
    if (!SAVES) return [];
    if (ccCache.has(dir)) return ccCache.get(dir);
    let list = [];
    try { list = (await fetch("/api/project/commands?dir=" + encodeURIComponent(dir)).then((r) => r.json())).commands || []; } catch {}
    ccCache.set(dir, list);
    return list;
  }
  const slash = { open: false, items: [], index: 0, pane: -1, el: null };
  // Claude Code's own commands that answer in a chat run (claude -p); the
  // rest of what a session knows is added from its first run (init list)
  const CC_BUILTIN = [
    ["advisor", "Let Claude consult a stronger model at key moments", "<model>|off"],
    ["compact", "Free up context by summarizing the conversation so far", "[what to keep]"],
    ["context", "Show how full the context is", ""],
    ["usage", "Session cost, plan usage and activity", ""],
    ["init", "Write a CLAUDE.md that explains this project", ""],
    ["review", "Review a pull request", "[PR number]"],
    ["security-review", "Security review of the pending changes on this branch", ""],
    ["pr-comments", "Show the comments on a pull request", "[PR number]"],
    ["recap", "A one-line recap of this session", ""],
    ["goal", "Set a goal Claude checks before it stops", "<goal>"],
    ["insights", "A report on your Claude Code sessions", ""],
    ["add-dir", "Let Claude work in another folder too", "<folder>"],
    ["mcp", "List and manage MCP servers", ""],
    ["output-style", "List output styles or switch to one", "[style]"],
    ["memory", "CLAUDE.md files and memory settings", ""],
    ["status", "Version, model, account and connections", ""],
    ["release-notes", "What's new in Claude Code", ""],
    ["team-onboarding", "A guide for teammates from your usage", ""],
    ["btw", "A quick side question that doesn't derail the work", "<question>"],
  ].map(([name, desc, hint]) => ({ name, desc, hint, kind: "cc" }));
  function slashQuery() {
    const v = $("#input").value;
    const m = /^\/([^\s]*)$/.exec(v);
    return m ? m[1].toLowerCase() : null;
  }
  // "@name" before the cursor: a project file to point at
  function mentionQuery() {
    const inp = $("#input");
    if (!inp) return null;
    const v = inp.value.slice(0, inp.selectionStart ?? inp.value.length);
    const m = /(^|\s)@([^\s@]{0,80})$/.exec(v);
    return m ? { q: m[2], start: v.length - m[2].length - 1 } : null;
  }
  let mentionAsk = 0;
  async function updateMention(mq) {
    const here = cur, c = chat(), ask = ++mentionAsk;
    const dir = c.cwd || D.projectPath;
    if (!dir) return closeSlash();
    let v;
    try { v = await fetch("/api/project/files?dir=" + encodeURIComponent(dir) + "&q=" + encodeURIComponent(mq.q)).then((r) => r.json()); } catch { return; }
    if (ask !== mentionAsk || !inPane(here, mentionQuery)) return;
    slash.items = (v.files || []).map((f) => ({ name: f, kind: "file", group: mq.q ? "Files" : "Files in " + base(dir), start: mq.start }));
    slash.files = true;
    if (slash.index >= slash.items.length) slash.index = 0;
    slash.open = true;
    slash.pane = here;
    inPane(here, drawSlash);
  }
  async function updateSlash() {
    const q = slashQuery();
    if (q == null) { const mq = mentionQuery(); if (mq) return updateMention(mq); return closeSlash(); }
    slash.files = false;
    const here = cur;
    const cc = await claudeCommands();
    if (inPane(here, slashQuery) == null) return;
    const score = (n) => (n.startsWith(q) ? 0 : n.includes(q) ? 1 : 2);
    const pick = (arr) => arr.filter((x) => !q || x.name.toLowerCase().includes(q) || (x.desc || "").toLowerCase().includes(q))
      .sort((a, b) => score(a.name.toLowerCase()) - score(b.name.toLowerCase()));
    const own = pick(BUILTIN).map((x) => ({ ...x, group: "Foxpit" }));
    const taken = new Set([...BUILTIN.map((x) => x.name), ...cc.map((x) => x.name)]);
    const seen = (S().ccSeen || []).filter((n) => !taken.has(n) && !CC_BUILTIN.some((x) => x.name === n))
      .map((name) => ({ name, desc: "Claude Code", kind: "cc" }));
    const builtins = pick([...CC_BUILTIN.filter((x) => !taken.has(x.name)), ...seen]).map((x) => ({ ...x, group: "Claude Code" }));
    const theirs = pick(cc).map((x) => ({ ...x, group: x.kind === "skill" ? "Skills" : "Your commands" }));
    slash.items = [...own, ...theirs, ...builtins].slice(0, 120);
    if (slash.index >= slash.items.length) slash.index = 0;
    slash.open = true;
    slash.pane = here;
    inPane(here, drawSlash);
  }
  function drawSlash() {
    if (!slash.el) { slash.el = h("div", "slash"); slash.el.onmousedown = (e) => e.preventDefault(); }
    const box = slash.el, comp = $("#composer");
    if (box.parentNode !== comp) comp.append(box);
    box.replaceChildren();
    if (!slash.items.length) { box.append(h("div", "sl-empty", slash.files ? "No file matches" : "No command matches")); return; }
    let group = "";
    slash.items.forEach((x, i) => {
      if (x.group !== group) { group = x.group; box.append(h("div", "sl-g", group)); }
      const isFile = x.kind === "file", cut = isFile ? x.name.lastIndexOf("/") : -1;
      const b = isFile
        ? h("button", "sl-i file" + (i === slash.index ? " hl" : ""), icon("file"), h("span", "sl-n", x.name.slice(cut + 1)), h("span", "sl-d", cut > 0 ? x.name.slice(0, cut) : ""))
        : h("button", "sl-i" + (i === slash.index ? " hl" : ""), h("span", "sl-n", "/" + x.name),
          h("span", "sl-d", x.desc || (x.kind === "skill" ? "Skill" : "Command")), x.source ? h("span", "sl-s", x.source) : x.hint ? h("span", "sl-s", x.hint) : null);
      b.type = "button";
      b.onmousemove = () => { if (slash.index !== i) { slash.index = i; mark(); } };
      b.onclick = () => chooseSlash(i);
      box.append(b);
    });
    function mark() { box.querySelectorAll(".sl-i").forEach((el, k) => el.classList.toggle("hl", k === slash.index)); }
    box._mark = mark;
    const hl = box.querySelector(".sl-i.hl");
    if (hl) hl.scrollIntoView({ block: "nearest" });
  }
  function closeSlash() {
    if (!slash.open) return;
    slash.open = false;
    if (slash.el) slash.el.remove();
  }
  function chooseSlash(i) {
    const x = slash.items[i];
    if (!x) return;
    const input = $("#input");
    closeSlash();
    if (x.kind === "file") {
      const end = input.selectionStart ?? input.value.length;
      const ins = "@" + (/\s/.test(x.name) ? '"' + x.name + '"' : x.name) + " ";
      input.value = input.value.slice(0, x.start) + ins + input.value.slice(end);
      const at = x.start + ins.length;
      input.focus();
      input.setSelectionRange(at, at);
      input.dispatchEvent(new Event("input"));
      return;
    }
    if (x.run && !x.arg) { input.value = ""; input.dispatchEvent(new Event("input")); x.run(); return; }
    input.value = "/" + x.name + " ";
    input.dispatchEvent(new Event("input"));
    input.focus();
  }
  // a typed builtin ("/rename Foo") runs here instead of going to Claude Code
  function runBuiltin(text) {
    const m = /^\/(\S+)\s*([\s\S]*)$/.exec(text);
    if (!m) return false;
    const b = BUILTIN.find((x) => x.name === m[1].toLowerCase());
    if (!b) return false;
    b.run(m[2].trim());
    return true;
  }
  function chatMarkdown(c) {
    const out = ["# " + c.title, ""];
    for (const m of c.messages) {
      if (m.role === "user") out.push("**You:** " + m.text, "");
      else if (m.role === "assistant") {
        out.push("**" + modelName(m.account, m.model) + ":**");
        for (const p of m.parts || []) if (p.k === "tool") out.push("> " + p.name + " " + (toolSummary(p)[0] || "")); else if (p.k === "text") out.push(p.text);
        if (m.text) out.push(m.text);
        out.push("");
      } else if (m.role === "switch") out.push("_Switched to " + modelName(m.account, m.model) + "_", "");
      else if (m.role === "note") out.push("_" + m.text + "_", "");
    }
    return out.join("\n");
  }
  async function copyText(t) {
    try { await navigator.clipboard.writeText(t); return true; } catch {}
    const a = h("textarea", "", t);
    a.style.position = "fixed"; a.style.opacity = "0";
    document.body.append(a); a.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch {}
    a.remove();
    return ok;
  }

  // ---------- wiring ----------
  function render() {
    cur = active;
    panes.forEach((_, i) => inPane(i, () => { renderHeader(); renderMessages(); syncSend(); }));
    paneEls().forEach((el, i) => el.classList.toggle("active", i === active && panes.length > 1));
    $("#panes").classList.toggle("multi", panes.length > 1);
    renderChats(); renderAccountCard(); renderSide();
  }

  const toggleFrom = (kind) => (e) => {
    e.stopPropagation();
    if (state.menu && menuAnchor === e.currentTarget) closeMenu();
    else openMenu(kind, e.currentTarget);
  };
  // a control in a pane: found by data-id, its pane made the active one
  function on(id, type, fn) {
    $("#panes").addEventListener(type, (e) => {
      const el = e.target.closest('[data-id="' + id + '"]');
      if (!el) return;
      focusPane(paneEls().indexOf(el.closest(".pane")));
      fn({ currentTarget: el, target: e.target, key: e.key, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, raw: e,
        stopPropagation: () => e.stopPropagation(), preventDefault: () => e.preventDefault() });
    });
  }
  on("modelChip", "click", toggleFrom("model"));
  on("modelChip2", "click", toggleFrom("model"));
  on("acctChip", "click", toggleFrom("account"));
  on("effortChip", "click", toggleFrom("effort"));
  on("modeChip", "click", toggleFrom("mode"));
  window.addEventListener("resize", () => { if (state.menu) placeMenu(); moveTabInk(); });
  $("#menu").onclick = (e) => e.stopPropagation();
  document.addEventListener("click", () => state.menu && closeMenu());
  $("#tabs").onclick = (e) => { const b = e.target.closest("button[data-tab]"); if (b) { state.tab = b.dataset.tab; renderSide(); } };

  // ---------- the side panel: drag its edge to resize, hide and bring back ----------
  const app = $(".app");
  const pref = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch {} return null; };
  const SIDE_MIN = 260, SIDE_MAX = 640;
  const sideW = +pref("foxpit.sideW") || 330;
  app.style.setProperty("--side-w", Math.max(SIDE_MIN, Math.min(SIDE_MAX, sideW)) + "px");
  function setSide(open) {
    app.classList.toggle("side-off", !open);
    $("#sideToggle").setAttribute("aria-label", open ? "Hide panel" : "Show panel");
    if (!app.classList.contains("narrow")) pref("foxpit.sideOff", open ? "0" : "1");
    else if (open) app.classList.remove("rail-on");
    renderAccountCard();
    setTimeout(() => { moveTabInk(); if (open) window.dispatchEvent(new Event("resize")); }, 280);
  }
  if (pref("foxpit.sideOff") === "1") setSide(false);
  // ---------- any window size ----------
  // Under 1180px the side panel slides over the chat instead of squeezing it;
  // under 860px the chat list does too (the titlebar button opens it) and a
  // split shows the focused chat only. A click on the dim area closes them.
  const scrim = h("div", "scrim");
  app.append(scrim);
  let wasNarrow = null;
  function markFocus() { paneEls().forEach((el, k) => el.classList.toggle("focus", k === cur)); }
  function setRail(on) { app.classList.toggle("rail-on", on); $("#railBtn").classList.toggle("on", on); }
  function fit() {
    const w = window.innerWidth;
    const narrow = w < 1180, compact = w < 860;
    app.classList.toggle("narrow", narrow);
    app.classList.toggle("compact", compact);
    document.body.classList.toggle("tiny", w < 560);
    if (!compact) setRail(false);
    if (narrow !== wasNarrow) {
      // the panel's saved choice holds on a wide window; a narrow one starts with it closed
      const off = narrow || pref("foxpit.sideOff") === "1";
      app.classList.toggle("side-off", off);
      $("#sideToggle").setAttribute("aria-label", off ? "Show panel" : "Hide panel");
      wasNarrow = narrow;
    }
    syncRailBtn?.();
    markFocus();
  }
  scrim.onclick = () => { setRail(false); if (app.classList.contains("narrow")) app.classList.add("side-off"); };
  // the chat list: an overlay on a small window, a column that folds away on a wide one
  function toggleRail() {
    if (app.classList.contains("compact")) return setRail(!app.classList.contains("rail-on"));
    const off = !app.classList.contains("rail-off");
    app.classList.toggle("rail-off", off);
    pref("foxpit.railOff", off ? "1" : "0");
    syncRailBtn();
  }
  function syncRailBtn() {
    const b = $("#railBtn"), compact = app.classList.contains("compact");
    const shown = compact ? app.classList.contains("rail-on") : !app.classList.contains("rail-off");
    b.classList.toggle("on", compact && shown);
    b.title = (shown ? "Hide chats" : "Show chats") + kb(" (Ctrl+Shift+B)");
  }
  if (pref("foxpit.railOff") === "1") app.classList.add("rail-off");
  $("#railBtn").onclick = (e) => { e.stopPropagation(); toggleRail(); };
  document.addEventListener("keydown", (e) => { if (mod(e) && e.shiftKey && (e.key === "B" || e.key === "b")) { e.preventDefault(); toggleRail(); } }, true);
  window.addEventListener("resize", fit);
  fit();

  $("#sideClose").onclick = () => setSide(false);
  $("#sideHandle").addEventListener("pointerdown", (e) => {
    if (app.classList.contains("side-off")) { setSide(true); return; }
    if (e.target.closest("#sideToggle")) return;
    e.preventDefault();
    const h0 = e.currentTarget, x0 = e.clientX, w0 = $(".side").getBoundingClientRect().width;
    h0.setPointerCapture(e.pointerId);
    app.classList.add("dragging");
    const move = (ev) => { const w = Math.max(SIDE_MIN, Math.min(SIDE_MAX, w0 + x0 - ev.clientX)); app.style.setProperty("--side-w", w + "px"); };
    const up = () => {
      app.classList.remove("dragging");
      h0.removeEventListener("pointermove", move);
      pref("foxpit.sideW", parseInt(app.style.getPropertyValue("--side-w")));
      moveTabInk();
      window.dispatchEvent(new Event("resize"));
    };
    h0.addEventListener("pointermove", move);
    h0.addEventListener("pointerup", up, { once: true });
  });
  $("#sideToggle").onclick = (e) => { e.stopPropagation(); setSide(app.classList.contains("side-off")); };
  $("#sideHandle").ondblclick = () => { app.style.setProperty("--side-w", "330px"); pref("foxpit.sideW", 330); moveTabInk(); };

  // ---------- attach: pick files, they go in as @paths Claude Code reads ----------
  on("attach", "click", async (e) => {
    e.stopPropagation();
    const here = cur;
    let r;
    try { r = await fetch("/api/project/attach?dir=" + encodeURIComponent(D.projectPath || ""), { method: "POST" }).then((x) => x.json()); }
    catch { r = { error: "Attach works in the Foxpit app." }; }
    if (r.error) { flash(r.error); return; }
    const files = r.files || [];
    if (!files.length) return;
    const local = (f) => "/api/project/local?path=" + encodeURIComponent(f);
    const name = (f) => f.split(/[\\/]/).pop();
    const media = files.filter((f) => VIDEO_RE.test(f) || IMAGE_RE.test(f)).slice(0, 6);
    for (const f of media) {
      if (VIDEO_RE.test(f)) inPane(here, () => attachVideo(local(f), name(f)));
      else {
        const blob = await fetch(local(f)).then((x) => (x.ok ? x.blob() : null)).catch(() => null);
        if (blob) inPane(here, () => attachImage(new File([blob], name(f), { type: blob.type })));
      }
    }
    addPaths(here, files.filter((f) => !media.includes(f)));
  });
  function flash(text) {
    const t = h("div", "toast", text);
    document.body.append(t);
    setTimeout(() => t.classList.add("out"), 2600);
    setTimeout(() => t.remove(), 3000);
  }
  $("#newChat").onclick = () => {
    const c = chat();
    // an empty chat is already a new one
    if (c && !c.messages.length && inProject(c)) { $("#input").focus(); return; }
    const n = freshChat(c);
    D.chats.unshift(n);
    state.chatId = n.id;
    render();
    save();
    $("#input").focus();
  };
  on("ctxChip", "click", (e) => { e.stopPropagation(); openCtx(); });
  on("input", "input", () => { const input = $("#input"); input.style.height = "auto"; input.style.height = Math.min(180, input.scrollHeight) + "px"; });
  on("input", "keydown", (e) => {
    if (slash.open && slash.pane === cur) {
      const n = slash.items.length;
      if (e.key === "ArrowDown" && n) { e.preventDefault(); slash.index = (slash.index + 1) % n; slash.el._mark?.(); slash.el.querySelector(".sl-i.hl")?.scrollIntoView({ block: "nearest" }); return; }
      if (e.key === "ArrowUp" && n) { e.preventDefault(); slash.index = (slash.index - 1 + n) % n; slash.el._mark?.(); slash.el.querySelector(".sl-i.hl")?.scrollIntoView({ block: "nearest" }); return; }
      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") { if (n) { e.preventDefault(); chooseSlash(slash.index); return; } }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeSlash(); return; }
    }
    const sug = e.key === "Tab" && !e.shiftKey && !$("#input").value && !runs.has(state.chatId) && suggestions.get(state.chatId);
    if (sug) {
      e.preventDefault();
      const input = $("#input");
      input.value = sug;
      suggestions.delete(state.chatId);
      showSuggest();
      input.style.height = "auto"; input.style.height = Math.min(180, input.scrollHeight) + "px";
      input.setSelectionRange(sug.length, sug.length);
      return;
    }
    const ctrlSends = S().send === "ctrl";
    if (e.key === "Enter" && (ctrlSends ? mod(e) : !e.shiftKey && !mod(e))) { e.preventDefault(); $("#composer").requestSubmit(); }
  });
  on("input", "input", () => { if (runs.has(state.chatId)) syncSend(); slash.index = slashQuery() === slash.lastQ ? slash.index : 0; slash.lastQ = slashQuery(); updateSlash(); });
  on("input", "focusout", () => setTimeout(() => { if (!document.activeElement || !document.activeElement.closest?.(".composer")) closeSlash(); }, 120));
  on("composer", "submit", (e) => {
    e.preventDefault();
    const input = $("#input");
    const t = input.value.trim();
    if (runs.has(state.chatId)) {
      if (!t && !(PN().att || []).length) return stop(state.chatId);
      if (t.startsWith("/") && runBuiltin(t)) { input.value = ""; input.style.height = "auto"; return; }
      if ((PN().att || []).some((a) => a.loading)) return flash("The video is still being read.");
      if (sayNow(chat(), t, PN().att || [])) {
        PN().att = [];
        drawAttachments();
        input.value = "";
        input.style.height = "auto";
        closeSlash();
        syncSend();
        return;
      }
      enqueue(chat(), t, PN().att || []);
      PN().att = [];
      drawAttachments();
      input.value = "";
      input.style.height = "auto";
      closeSlash();
      syncSend();
      return;
    }
    closeSlash();
    if (t.startsWith("/") && runBuiltin(t)) { input.value = ""; input.style.height = "auto"; return; }
    if (!t && !(PN().att || []).length) return;
    const c = chat();
    if (c.title === "New chat") { c.title = (t || "Image").slice(0, 48); renderChats(); renderHeader(); }
    input.value = "";
    input.style.height = "auto";
    send(t);
  });
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && (e.key === "m" || e.key === "M")) { e.preventDefault(); state.menu ? closeMenu() : openMenu("model", $("#modelChip2")); }
    if (mod(e) && (e.key === "n" || e.key === "N")) { e.preventDefault(); $("#newChat").click(); }
    if (mod(e) && (e.key === "k" || e.key === "K")) { e.preventDefault(); $("#chatSearch").focus(); $("#chatSearch").select(); }
    if (mod(e) && !e.shiftKey && (e.key === "b" || e.key === "B")) { e.preventDefault(); setSide(app.classList.contains("side-off")); }
    if (mod(e) && e.key === "\\") { e.preventDefault(); splitPane(); }
    if (mod(e) && e.key === ",") { e.preventDefault(); setv.open ? closeSettings() : openSettings(); }
    if (e.ctrlKey && (e.key === "w" || e.key === "W") && panes.length > 1) { e.preventDefault(); closePane(active); }
    if (e.key === "Escape" && state.menu) closeMenu();
    else if (e.key === "Escape" && slash.open) closeSlash();
    else if (e.key === "Escape" && voice.on) setVoice(false);
    else if (e.key === "Escape" && voice.speaking) stopSpeaking();
    else if (e.key === "Escape" && runs.has(state.chatId)) stop(state.chatId);
  });

  if (MAC) for (const el of document.querySelectorAll("[title*='Ctrl'], kbd")) {
    if (el.title) el.title = kb(el.title);
    if (el.tagName === "KBD") el.textContent = kb(el.textContent);
  }
  // ---------- window caption (frameless window; a Mac keeps its own buttons) ----------
  const win = import("/wails/runtime.js").then((r) => r.Window).catch(() => null);
  const maxBtn = document.querySelector('#wincap [data-cap="max"]');
  async function syncMax() {
    const w = await win;
    const m = w ? await w.IsMaximised().catch(() => false) : false;
    maxBtn.textContent = m ? "" : "";
    maxBtn.title = m ? "Restore Down" : "Maximize";
  }
  $("#wincap").onclick = async (e) => {
    const b = e.target.closest("button[data-cap]");
    const w = await win;
    if (!b || !w) return;
    if (b.dataset.cap === "min") w.Minimise();
    if (b.dataset.cap === "max") { await w.ToggleMaximise(); setTimeout(syncMax, 60); }
    if (b.dataset.cap === "close") w.Close();
  };
  $("#titlebar").addEventListener("dblclick", async (e) => {
    if (e.target.closest("button")) return;
    const w = await win;
    if (w) { await w.ToggleMaximise(); setTimeout(syncMax, 60); }
  });
  window.addEventListener("resize", () => { clearTimeout(syncMax.t); syncMax.t = setTimeout(syncMax, 120); });
  window.addEventListener("blur", () => document.body.classList.add("blurred"));
  window.addEventListener("focus", () => document.body.classList.remove("blurred"));

  // ---------- Magpie (live accounts, quotas and models) ----------
  // The gateway knows accounts per provider and moves between a provider's
  // accounts by itself, so the interface groups by provider: its models,
  // and the usage of the account in use (or the one with the most room).
  const PROVIDER = { claude: "claude", codex: "codex", gemini: "gemini", auto: "auto" };
  const PNAME = { claude: "Claude Code", codex: "Codex", gemini: "Gemini CLI", auto: "Routing groups" };
  function resetText(iso) {
    if (!iso) return "";
    const ms = new Date(iso) - Date.now();
    if (!(ms > 0)) return "now";
    const m = Math.round(ms / 60000), hh = Math.floor(m / 60);
    if (hh >= 24) return new Date(iso).toLocaleDateString("en-US", { weekday: "short" });
    return hh ? hh + "h " + (m % 60) + "m" : m + "m";
  }
  const CLAUDE_MODELS = [["claude/claude-fable-5-2", "Claude Fable 5.2"], ["claude/claude-opus-5-5", "Claude Opus 5.5"],
    ["claude/claude-sonnet-5-5", "Claude Sonnet 5.5"], ["claude/claude-haiku-5-5", "Claude Haiku 5.5"]];
  // a model typed in the menu: which provider runs it
  function customModel(q) {
    let id = q.trim().replace(/\s+/g, "");
    if (!id) return null;
    let pid = id.includes("/") ? id.split("/")[0] : /^(claude|opus|sonnet|haiku|fable)/i.test(id) ? "claude" : /^(gpt|o\d|codex|chatgpt)/i.test(id) ? "codex" : /^gemini/i.test(id) ? "gemini" : "claude";
    if (!id.includes("/")) id = pid + "/" + id;
    const group = (D.accounts || []).find((a) => a.id === pid);
    return { id, pid, group, name: id.split("/").slice(1).join("/") };
  }
  function useCustom(q) {
    const cm = customModel(q);
    if (!cm) return;
    if (!cm.group) { flash("No " + (PNAME[cm.pid] || cm.pid) + " account is set up for that model."); return; }
    if (!cm.group.models.some((m) => m.id === cm.id)) cm.group.models.push({ id: cm.id, name: cm.name, efforts: [], note: "custom", custom: true });
    const list = (S().customModels = (S().customModels || []).filter((x) => x.id !== cm.id));
    list.push({ id: cm.id, name: cm.name, provider: cm.pid });
    state.menuQuery = "";
    choose(cm.pid, cm.id);
    flash(cm.name + " in this chat. If the provider doesn't run it, the reply says so.");
  }
  function winOf(windows, re) { return (windows || []).find((w) => re.test(w.name) && !w.lane); }
  function buildLive(quotas, models) {
    const byProv = new Map();
    const prov = (id) => {
      if (!byProv.has(id)) byProv.set(id, { id, provider: PROVIDER[id] || "oc", name: PNAME[id] || id, plan: "", who: "", fiveHour: null, week: null, resetIn: "", models: [], members: [] });
      return byProv.get(id);
    };
    for (const m of models) {
      const [pid] = m.id.split("/");
      const p = prov(pid);
      const efforts = (Array.isArray(m.reasoning_levels) ? m.reasoning_levels : (m.supported_reasoning_levels || []).map((x) => x && x.effort))
        .filter((x) => typeof x === "string");
      p.models.push({ id: m.id, name: m.display_name || m.id.split("/")[1], efforts,
        note: pid === "auto" ? "routed" : efforts.length ? "up to " + efforts[efforts.length - 1] : "" });
    }
    // Claude chats run on Claude Code itself, which takes every Claude model,
    // not only the ones Magpie routes
    if (byProv.has("claude") || quotas.some((q) => q.provider === "claude")) {
      const p = prov("claude");
      const base = p.models.find((m) => m.efforts && m.efforts.length);
      const efforts = base ? base.efforts : ["low", "medium", "high", "xhigh", "max"];
      for (const [id, name] of CLAUDE_MODELS) {
        if (!p.models.some((m) => m.id === id)) p.models.push({ id, name, efforts, note: "up to " + efforts[efforts.length - 1] });
      }
      const order = (m) => { const i = CLAUDE_MODELS.findIndex((x) => x[0] === m.id); return i < 0 ? 99 : i; };
      p.models.sort((a, b) => order(a) - order(b));
    }
    for (const cm of (D.settings && D.settings.customModels) || []) {
      const p = byProv.get(cm.provider);
      if (p && !p.models.some((m) => m.id === cm.id)) p.models.push({ id: cm.id, name: cm.name, efforts: [], note: "custom", custom: true });
    }
    for (const q of quotas) {
      const p = prov(q.provider);
      const five = winOf(q.windows, /^5 hours?$/i), week = winOf(q.windows, /^7 days$/i);
      const user = q.user ? q.user.split("@")[0] : q.name;
      p.members.push({
        key: "q-" + q.provider + "-" + (q.user || p.members.length), label: user, plan: q.plan || "", on: q.on !== false,
        error: q.error || "", fiveHour: five ? five.used : null, week: week ? week.used : null,
        reset: resetText((week && week.used >= (five ? five.used : 0) ? week : five || week)?.resetsAt), last: !!q.last,
      });
    }
    for (const p of byProv.values()) {
      const ok = p.members.filter((m) => !m.error && m.on && (m.fiveHour != null || m.week != null));
      // the account Magpie served last, else the one with the most room
      const pick = ok.find((m) => m.last) || ok.sort((x, y) => Math.max(x.fiveHour || 0, x.week || 0) - Math.max(y.fiveHour || 0, y.week || 0))[0];
      if (pick) { p.fiveHour = pick.fiveHour; p.week = pick.week; p.resetIn = pick.reset; p.plan = pick.plan ? pick.plan[0].toUpperCase() + pick.plan.slice(1) : ""; }
      const n = p.members.length;
      p.who = p.id === "auto" ? "Magpie picks" : n ? n + (n === 1 ? " account" : " accounts") : "no account";
      if (!p.plan) p.plan = p.id === "auto" ? "Routing" : "Signed in";
      if (pick == null && p.members.length) p.who = "needs attention";
    }
    // routing groups first, then providers with models
    return [...byProv.values()].filter((p) => p.models.length).sort((a, b) => (a.id === "auto" ? -1 : b.id === "auto" ? 1 : 0));
  }
  function adoptChats(accounts) {
    const has = (id) => accounts.find((a) => a.id === id);
    const fallback = accounts.find((a) => a.id !== "auto") || accounts[0];
    const remap = (accountId) => {
      const fam = /^claude/.test(accountId) ? "claude" : /^codex/.test(accountId) ? "codex" : accountId;
      return has(fam) || fallback;
    };
    const fixModel = (a, modelId) => {
      if (a.models.some((m) => m.id === modelId)) return modelId;
      const want = String(modelId).replace(/^.*\//, "").replace(/[-.]/g, "").toLowerCase();
      return (a.models.find((m) => m.id.replace(/^.*\//, "").replace(/[-.]/g, "").toLowerCase().includes(want.replace(/\d+$/, ""))) || a.models[0]).id;
    };
    for (const c of D.chats) {
      const a = remap(c.account); c.account = a.id; c.model = fixModel(a, c.model);
      for (const m of c.messages) if (m.account) { const ma = remap(m.account); m.account = ma.id; m.model = fixModel(ma, m.model); }
    }
  }
  function setGw(cls, text, title) {
    const g = $("#gw");
    if (!g) return;
    g.className = "gw " + cls;
    g.lastElementChild.textContent = text;
    g.title = title || "";
  }
  let live = false;
  async function loadLive() {
    if (!live) setGw("wait", "Magpie", "Connecting to the Magpie gateway…");
    try {
      const [q, m] = await Promise.all([fetch("/api/magpie/quotas").then((r) => r.ok ? r.json() : Promise.reject(r)), fetch("/api/magpie/models").then((r) => r.ok ? r.json() : Promise.reject(r))]);
      const accounts = buildLive(q.data || [], m.data || []);
      if (!accounts.length) throw new Error("no models");
      D.accounts = accounts;
      D.live = true;
      if (!live) adoptChats(accounts);
      live = true;
      setGw("on", "Magpie", "Connected to the Magpie gateway on 127.0.0.1:3425");
      render();
      if (state.menu) { renderMenu(); placeMenu(); }
    } catch (e) {
      let why = "";
      try { why = (await e.json()).error; } catch { why = e && e.message; }
      setGw("off", live ? "Magpie" : "Magpie offline", why || "The Magpie gateway did not answer");
    }
  }

  window.addEventListener("foxterm-ready", () => renderSide());
  // the app shows its own chats, never the samples, even for a moment
  if (SAVES) { D.projects = []; setProject(""); D.chats = [freshChat(null)]; state.chatId = D.chats[0].id; }
  else D.projects = [{ path: D.projectPath, name: D.project, trusted: true }];
  const toggleProjects = (e) => { e.stopPropagation(); state.menu === "project" ? closeMenu() : openMenu("project", $("#crumb")); };
  $("#crumb").onclick = toggleProjects;
  on("wtChip", "click", toggleProjects);
  on("micBtn", "click", (e) => { e.stopPropagation(); dictate(); });
  on("voiceBtn", "click", (e) => { e.stopPropagation(); setVoice(!(voice.on && voice.pane === cur)); });
  on("input", "paste", (e) => {
    const items = [...(e.raw.clipboardData?.items || [])].filter((x) => x.kind === "file" && /^(image|video)\//.test(x.type));
    if (!items.length) return;
    e.preventDefault();
    for (const it of items.slice(0, 6)) attachFile(it.getAsFile());
  });
  render();
  syncMax();
  (async () => {
    if (SAVES) { await loadSaved(); render(); }
    if (location.protocol !== "file:") { await loadLive(); setInterval(loadLive, 60000); }
    startDemo();
  })();
  // checks without touching the screen: ?demo=alt / ?demo=ust opens the menu
  function startDemo() {
  const demo = new URLSearchParams(location.search).get("demo");
  if (demo === "chat") {
    setTimeout(() => { $("#input").value = "Say hello and read README.md"; $("#composer").requestSubmit(); }, 300);
    setTimeout(() => { choose(chat().account, chat().model === D.accounts[0].models[0].id && D.accounts[0].models[1] ? D.accounts[0].models[1].id : chat().model); $("#input").value = "Now in one word"; $("#composer").requestSubmit(); }, 2500);
  }
  if (demo === "term") {
    state.tab = "terminal"; renderSide();
    setTimeout(() => window.FoxTerm?.send("Write-Output ('FOX' + 'PIT-OK'); (Get-Location).Path; git branch --show-current\r"), 3500);
  } else if (demo === "efor") setTimeout(() => openMenu("effort", $("#effortChip")), 50);
  else if (demo === "efor2") setTimeout(() => { openMenu("effort", $("#effortChip")); setTimeout(() => pickEffort("max"), 200); }, 50);
  else if (demo && demo !== "chat") setTimeout(() => openMenu("model", demo === "ust" ? $("#modelChip") : $("#modelChip2")), 50);
  // ?demo=kapat opens the menu, then clicks outside it
  if (demo === "kapat") setTimeout(() => $("#msgs").click(), 400);
  }
})();
