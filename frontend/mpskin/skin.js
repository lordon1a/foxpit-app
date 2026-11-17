// Magpie's pages inside Foxpit: Foxpit's tabs pick the page, and Magpie says
// which pages it has (some come and go with its features) and which is open.
(() => {
  if (window.parent === window) return;
  const tell = (o) => window.parent.postMessage(Object.assign({ foxpit: "magpie" }, o), "*");
  const nav = () => document.getElementById("nav");
  function views() {
    const out = [];
    let group = "";
    for (const el of nav() ? nav().children : []) {
      if (el.classList.contains("nav-gl")) { group = el.textContent.trim(); continue; }
      if (el.tagName !== "BUTTON" || !el.dataset || !el.dataset.view) continue;
      const shown = !el.hidden && getComputedStyle(el).display !== "none";
      if (!shown) continue;
      out.push({ view: el.dataset.view, label: el.textContent.trim(), group, on: el.classList.contains("on") });
    }
    return out;
  }
  let last = "";
  function report() {
    const v = views();
    const upd = document.getElementById("update");
    const s = JSON.stringify([v, upd && !upd.hidden]);
    if (s === last) return;
    last = s;
    tell({ type: "views", views: v, update: !!(upd && !upd.hidden) });
  }
  let timer = 0;
  const soon = () => { clearTimeout(timer); timer = setTimeout(report, 60); };
  window.addEventListener("message", (e) => {
    if (e.source !== window.parent) return;
    const d = e.data || {};
    if (d.foxpit !== "magpie") return;
    if (d.type === "view") {
      const b = nav() && nav().querySelector('button[data-view="' + CSS.escape(String(d.view)) + '"]');
      if (b && !b.classList.contains("on")) b.click();
      soon();
    }
    // the header's buttons, still Magpie's own code
    if (d.type === "act" && ["prefs", "sync", "update"].includes(d.act)) document.getElementById(d.act)?.click();
    if (d.type === "hello") { last = ""; report(); }
    if (d.type === "theme") document.documentElement.dataset.fx = d.theme === "light" ? "light" : "dark";
  });
  function watch() {
    if (!nav()) return setTimeout(watch, 100);
    new MutationObserver(soon).observe(nav(), { attributes: true, subtree: true, childList: true, attributeFilter: ["class", "hidden", "style"] });
    const upd = document.getElementById("update");
    if (upd) new MutationObserver(soon).observe(upd, { attributes: true, attributeFilter: ["hidden"] });
    report();
  }
  watch();
})();
