// Diagnose the ResizeObserver re-fit in the built app.
const list = await (await fetch("http://127.0.0.1:9223/json")).json();
const page = list.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id).res(m.result);
    pending.delete(m.id);
  }
};
await new Promise((r) => (ws.onopen = r));
const send = (method, params) =>
  new Promise((res) => {
    const i = ++id;
    pending.set(i, { res });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const evalJs = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true });
  return r.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Open the reader: click the first paper card
await evalJs(
  `[...document.querySelectorAll('h3')][0]?.closest('article')?.querySelector('button')?.click() ?? [...document.querySelectorAll('h3')][0]?.parentElement?.click()`,
);
await sleep(12000); // let the PDF load + render

const info = await evalJs(`JSON.stringify({
  pct: [...document.querySelectorAll('span')].map(s => s.textContent).filter(t => t && t.includes('%')).slice(0, 2),
  zoomAria: [...document.querySelectorAll('button')].map(b => b.getAttribute('aria-label')).filter(Boolean).slice(0, 10),
  scroller: (() => { const s = [...document.querySelectorAll('div')].find(d => String(d.className||'').includes('overflow-y-auto') && d.querySelector('.pdfViewer')); return s?.clientWidth ?? null; })(),
  pdf: (() => { const s = [...document.querySelectorAll('div')].find(d => String(d.className||'').includes('overflow-y-auto') && d.querySelector('.pdfViewer')); return s?.querySelector('.pdfViewer')?.clientWidth ?? null; })(),
  canvas: document.querySelector('canvas')?.width ?? null,
})`);
console.log("INFO:", info);

// Zoom-out via aria-label, then check the pipeline
const zoom = await evalJs(`(() => {
  const b = [...document.querySelectorAll('button')].find(b => {
    const a = (b.getAttribute('aria-label') || '').toLowerCase();
    return a.includes('zoom') && a.includes('out');
  });
  if (b) { b.click(); return b.getAttribute('aria-label'); }
  return null;
})()`);
console.log("ZOOM:", zoom);
await sleep(2500);
const after = await evalJs(`(() => {
  const s = [...document.querySelectorAll('div')].find(d => String(d.className||'').includes('overflow-y-auto') && d.querySelector('.pdfViewer'));
  return { pdf: s?.querySelector('.pdfViewer')?.clientWidth ?? null, canvas: document.querySelector('canvas')?.width ?? null };
})()`);
console.log("AFTER_ZOOM:", JSON.stringify(after));

// Now shrink the split wrapper and watch for a re-fit
await evalJs(`(() => {
  const s = [...document.querySelectorAll('div')].find(d => String(d.className||'').includes('overflow-y-auto') && d.querySelector('.pdfViewer'));
  s.parentElement.parentElement.style.flex = '0 0 30%';
})()`);
await sleep(2500);
const afterResize = await evalJs(`(() => {
  const s = [...document.querySelectorAll('div')].find(d => String(d.className||'').includes('overflow-y-auto') && d.querySelector('.pdfViewer'));
  return { scroller: s?.clientWidth ?? null, pdf: s?.querySelector('.pdfViewer')?.clientWidth ?? null, canvas: document.querySelector('canvas')?.width ?? null };
})()`);
console.log("AFTER_RESIZE:", JSON.stringify(afterResize));
ws.close();
