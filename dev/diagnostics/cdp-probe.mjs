// CDP probe for the built Papyrus exe (WebView2, port 9223).
const port = 9223;
const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
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

const state = await evalJs(`JSON.stringify({
  lang: document.documentElement.lang,
  dir: document.documentElement.dir,
  bodyText: document.body.innerText.slice(0, 120),
  cards: document.querySelectorAll('h3').length,
  dayOptions: [...document.querySelectorAll('select option')].map(o => o.text + '=' + o.value).slice(0, 18),
  lsKeys: Object.keys(localStorage)
})`);
console.log("STATE:", state);

const ls = await evalJs(
  `JSON.stringify(Object.fromEntries(Object.keys(localStorage).map(k => [k, localStorage.getItem(k).slice(0, 80)])))`,
);
console.log("LS:", ls);

// Switch to Arabic and reload to test the date direction in the real UI.
await evalJs(`localStorage.setItem('papyrus-language', 'ar')`);
await send("Page.reload", {});
await new Promise((r) => setTimeout(r, 9000));
const arState = await evalJs(`JSON.stringify({
  lang: document.documentElement.lang,
  dir: document.documentElement.dir,
  dates: [...document.querySelectorAll('time')].slice(0, 4).map(t => t.textContent),
  dateHasRlm: [...document.querySelectorAll('time')].slice(0, 4).map(t => /\\u200f|\\u200e/.test(t.textContent)),
  dayOptions: [...document.querySelectorAll('select option')].map(o => o.text + '=' + o.value).slice(0, 18),
  cards: document.querySelectorAll('h3').length
})`);
console.log("AR_STATE:", arState);
console.log("CONSOLE_ERRORS:", JSON.stringify(consoleErrors));
ws.close();
