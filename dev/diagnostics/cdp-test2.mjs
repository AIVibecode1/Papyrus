// Focused follow-up: canvas render completion, real split resize, settings nav.
const list = await (await fetch("http://127.0.0.1:9223/json")).json();
const page = list.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
function send(method, params) {
  return new Promise((res) => {
    const i = ++id;
    pending.set(i, { res });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
}
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id).res(m.result);
    pending.delete(m.id);
  }
};
await new Promise((r) => (ws.onopen = r));
const evalJs = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true });
  return r.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. Poll until the first canvas has real pixels (render queue finishes).
let painted = false;
for (let i = 0; i < 20; i++) {
  painted =
    (await evalJs(`(() => {
    const c = document.querySelector('canvas');
    if (!c) return false;
    try {
      const ctx = c.getContext('2d');
      const data = ctx.getImageData(Math.floor(c.width/2), Math.floor(c.height/2), 20, 20).data;
      return data.some(v => v > 0);
    } catch { return false; }
  })()`)) === true;
  if (painted) break;
  await sleep(1500);
}
console.log("CANVAS_PAINTED:", painted);

// 2. Real split drag simulation: find the split pane (flex item whose
// width follows the split) and change its basis, then verify the
// pdfViewer re-fits (canvas width changes) -> ResizeObserver works.
const before = await evalJs(`(() => {
  const scroller = [...document.querySelectorAll('div')].find(d => String(d.className||'').includes('overflow-y-auto') && d.querySelector('.pdfViewer'));
  return scroller ? scroller.clientWidth : null;
})()`);
const paneInfo = await evalJs(`(() => {
  const scroller = [...document.querySelectorAll('div')].find(d => String(d.className||'').includes('overflow-y-auto') && d.querySelector('.pdfViewer'));
  let p = scroller?.parentElement, chain = [];
  while (p && chain.length < 4) { chain.push({ cls: String(p.className||'').slice(0,60), w: p.clientWidth }); p = p.parentElement; }
  return chain;
})()`);
console.log("CHAIN:", JSON.stringify(paneInfo));
await evalJs(`(() => {
  const scroller = [...document.querySelectorAll('div')].find(d => String(d.className||'').includes('overflow-y-auto') && d.querySelector('.pdfViewer'));
  const pane = scroller?.parentElement;
  if (pane) pane.style.flex = '0 0 45%';
  return 'set';
})()`);
await sleep(1500);
const afterFit = await evalJs(`(() => {
  const scroller = [...document.querySelectorAll('div')].find(d => String(d.className||'').includes('overflow-y-auto') && d.querySelector('.pdfViewer'));
  return { scrollerW: scroller?.clientWidth ?? null, pdfW: scroller?.querySelector('.pdfViewer')?.clientWidth ?? null };
})()`);
console.log("RESIZE:", JSON.stringify({ before, afterFit }));

// 3. Canvas still painted after the re-fit?
const stillPainted = await evalJs(`(() => {
  const c = document.querySelector('canvas');
  if (!c) return false;
  try { const data = c.getContext('2d').getImageData(Math.floor(c.width/2), Math.floor(c.height/2), 20, 20).data; return data.some(v => v > 0); } catch { return false; }
})()`);
console.log("CANVAS_AFTER_REFIT:", stillPainted);

// 4. Settings nav: list clickable nav items, click the one with 'settings'
const nav = await evalJs(
  `JSON.stringify([...document.querySelectorAll('button, a, [role="tab"]')].map(b => b.textContent.trim()).filter(t => t && t.length < 30).slice(0, 20))`,
);
console.log("NAV:", nav);
await evalJs(`(() => {
  const el = [...document.querySelectorAll('button, a')].find(b => /(الإعدادات|Settings)/.test(b.textContent.trim()));
  el?.click();
  return !!el;
})()`);
await sleep(2500);
console.log(
  "SETTINGS:",
  await evalJs(`JSON.stringify({ versionShown: document.body.innerText.includes('1.0.3') })`),
);
ws.close();
