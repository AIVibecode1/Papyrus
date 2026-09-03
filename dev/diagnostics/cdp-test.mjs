// Full live test of the built Papyrus exe (v1.0.3): load state, Arabic
// dates, day picker, PDF render + resize re-fit, console errors.
const list = await (await fetch("http://127.0.0.1:9223/json")).json();
const page = list.find((t) => t.type === "page");
if (!page) {
  console.log("NO_PAGE_TARGET");
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const consoleErrors = [];
function send(method, params) {
  return new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
}
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id).res(m.result);
    pending.delete(m.id);
  } else if (m.method === "Runtime.exceptionThrown") {
    consoleErrors.push(m.params.exceptionDetails.text);
  } else if (m.method === "Log.entryAdded" && m.params.entry.level === "error") {
    consoleErrors.push(m.params.entry.text);
  }
};
await new Promise((r) => (ws.onopen = r));
await send("Runtime.enable");
await send("Log.enable");

const evalJs = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true });
  return r.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. Home state
console.log(
  "HOME:",
  await evalJs(`JSON.stringify({
  lang: document.documentElement.lang,
  dir: document.documentElement.dir,
  cards: document.querySelectorAll('h3').length,
  dates: [...document.querySelectorAll('time')].slice(0, 3).map(t => t.textContent),
  dateRlm: [...document.querySelectorAll('time')].slice(0, 3).some(t => /\\u200f|\\u200e/.test(t.textContent)),
})`),
);

// 2. Open the first paper (reader)
await evalJs(
  `document.querySelector('h3')?.closest('button, a, [role="button"]')?.click() ?? document.querySelector('h3')?.parentElement?.parentElement?.click()`,
);
await sleep(6000);
console.log(
  "READER:",
  await evalJs(`JSON.stringify({
  opened: !!document.querySelector('canvas'),
  canvases: document.querySelectorAll('canvas').length,
  canvasBlank: [...document.querySelectorAll('canvas')].slice(0, 3).map(c => {
    try { const d = c.getContext('2d').getImageData(0, 0, Math.min(c.width, 50), Math.min(c.height, 50)).data;
      return d.some(v => v > 0); } catch { return 'n/a'; }
  }),
  header: document.querySelector('h1')?.textContent?.slice(0, 60),
})`),
);

// 3. Resize the PDF container -> ResizeObserver must re-fit + re-render
const before = await evalJs(
  `JSON.stringify([...document.querySelectorAll('div')].find(d => d.className && String(d.className).includes('overflow-y-auto'))?.querySelector('.pdfViewer')?.getBoundingClientRect().width ?? null)`,
);
await evalJs(`(() => {
  const scroller = [...document.querySelectorAll('div')].find(d => d.className && String(d.className).includes('overflow-y-auto'));
  if (scroller) scroller.style.width = '60%';
})()`);
await sleep(1200);
const after = await evalJs(
  `JSON.stringify([...document.querySelectorAll('div')].find(d => d.className && String(d.className).includes('overflow-y-auto'))?.querySelector('.pdfViewer')?.getBoundingClientRect().width ?? null)`,
);
console.log("RESIZE:", JSON.stringify({ before, after }));

// 4. Restore + check the Settings page shows 1.0.3
await evalJs(`(() => {
  const scroller = [...document.querySelectorAll('div')].find(d => d.className && String(d.className).includes('overflow-y-auto'));
  if (scroller) scroller.style.width = '';
  [...document.querySelectorAll('button, a')].find(b => b.textContent.trim() === 'الإعدادات' || b.textContent.trim() === 'Settings')?.click();
})()`);
await sleep(2500);
console.log(
  "SETTINGS:",
  await evalJs(`JSON.stringify({
  versionShown: document.body.innerText.includes('1.0.3'),
  hasProviders: document.body.innerText.includes('deepseek-v4-flash'),
})`),
);

console.log("CONSOLE_ERRORS:", JSON.stringify(consoleErrors));
ws.close();
