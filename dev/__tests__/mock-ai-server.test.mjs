// Tests for the dev mock AI server: the SSE streaming contract that every
// browser E2E and manual preview depends on. Run: pnpm exec node --test dev/
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";

import { buildReply, createMockServer } from "../mock-ai-server.mjs";

let server;
let base;

before(async () => {
  server = createMockServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  base = `http://127.0.0.1:${port}`;
});

after(() => {
  server.close();
});

function post(path, body, { stream = true } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${base}${path}`,
      { method: "POST", headers: { "content-type": "application/json" } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify({ ...body, stream }));
  });
}

describe("buildReply", () => {
  it("returns the English reply for an English system prompt", () => {
    const { arabic, text } = buildReply({
      messages: [{ role: "system", content: "You write in English." }],
    });
    assert.equal(arabic, false);
    assert.match(text, /# Mock explanation/);
  });

  it("returns the Arabic reply when the system prompt asks for Arabic", () => {
    const { arabic, text } = buildReply({
      messages: [{ role: "system", content: "اكتب باللغة العربية" }],
    });
    assert.equal(arabic, true);
    assert.match(text, /# شرح تجريبي/);
  });

  it("tolerates a malformed body", () => {
    const { text } = buildReply(null);
    assert.match(text, /# Mock explanation/);
  });
});

describe("createMockServer", () => {
  it("answers /v1/models", async () => {
    const res = await fetch(`${base}/v1/models`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.deepEqual(
      json.data.map((m) => m.id),
      ["mock-model"],
    );
  });

  it("streams SSE chunks and ends with [DONE]", async () => {
    const res = await post("/v1/chat/completions", {
      messages: [{ role: "system", content: "English" }],
    });
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /text\/event-stream/);

    const dataLines = res.body
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim());
    assert.equal(dataLines.at(-1), "[DONE]");
    // The streamed content reassembles the full English reply.
    const text = dataLines
      .slice(0, -1)
      .map((l) => JSON.parse(l).choices[0].delta.content)
      .join("");
    assert.match(text, /# Mock explanation/);
    assert.match(text, /librarian/);
  });

  it("streams in Arabic when the system prompt asks for it", async () => {
    const res = await post("/v1/chat/completions", {
      messages: [{ role: "system", content: "اللغة العربية" }],
    });
    const text = res.body
      .split("\n")
      .filter((l) => l.startsWith("data:") && !l.includes("[DONE]"))
      .map((l) => JSON.parse(l.slice(5).trim()).choices[0].delta.content)
      .join("");
    assert.match(text, /شرح تجريبي/);
  });

  it("answers non-streaming requests with a plain JSON body", async () => {
    const res = await post("/v1/chat/completions", { messages: [] }, { stream: false });
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /application\/json/);
    const json = JSON.parse(res.body);
    assert.match(json.choices[0].message.content, /# Mock explanation/);
  });

  it("answers unknown routes with 404", async () => {
    const res = await post("/v1/nope", { messages: [] });
    assert.equal(res.status, 404);
  });
});
