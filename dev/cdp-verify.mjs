// v1.0.4 live verification: (1) resize re-fit now works, (2) the split
// stays fixed while the walkthrough streams.
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

const measure = () =>
  evalJs(`(() => {
    const s = [...document.querySelectorAll('div')].find(d => String(d.className||'').includes('overflow-y-auto') && d.querySelector('.pdfViewer'));
    if (!s) return null;
    const row = s.parentElement.parentElement.parentElement;
    const aside = row.querySelector('aside');
    return { scroller: s.clientWidth, pdf: s.querySelector('.pdfViewer').clientWidth, aside: aside?.clientWidth ?? null, row: row?.clientWidth ?? null };
  })()`);

// Open the first paper and wait for the PDF to render
await evalJs(
  `[...document.querySelectorAll('h3')][0]?.closest('article')?.querySelector('button')?.click() ?? [...document.querySelectorAll('h3')][0]?.parentElement?.click()`,
);
await sleep(14000);
console.log("LOADED:", JSON.stringify(await measure()));

// (1) Resize re-fit: shrink the split wrapper -> the PDF must follow
await evalJs(`(() => {
  const s = [...document.querySelectorAll('div')].find(d => String(d.className||'').includes('overflow-y-auto') && d.querySelector('.pdfViewer'));
  s.parentElement.parentElement.style.flex = '0 0 40%';
})()`);
await sleep(2500);
console.log("AFTER_REFIT:", JSON.stringify(await measure()));

// (2) Start the walkthrough (real provider) and watch the panes while streaming
await evalJs(`(() => {
  const s = [...document.querySelectorAll('div')].find(d => String(d.className||'').includes('overflow-y-auto') && d.querySelector('.pdfViewer'));
  s.parentElement.parentElement.style.flex = '';
  const startBtn = [...document.querySelectorAll('button')].find(b => /(ابدأ الشرح|Start walkthrough|الشرح الموجّه)/.test(b.textContent.trim()));
  return startBtn ? (startBtn.click(), startBtn.textContent.trim()) : 'NO_BTN';
})()`);
await sleep(2000);
console.log("WALKTHROUGH_START:", JSON.stringify(await measure()));
for (let i = 0; i < 6; i++) {
  await sleep(1500);
  console.log(`STREAM_${i}:`, JSON.stringify(await measure()));
}
ws.close();
