// Dev-only mock OpenAI-compatible server for testing the explain flow
// without a real API key. Run: pnpm mock-ai
// It speaks SSE streaming and replies in the language of the system prompt
// (English or Arabic) so the full EN/AR pipeline can be exercised.
import http from "node:http";

const PORT = Number(process.env.PORT ?? 8765);

// This reply is a demo of how the app renders mentor explanations: short
// paragraphs, plain words, an analogy, a table and a diagram. A real
// provider produces the same shape through the mentor prompts.
const EXPLANATION_EN =
  "# Mock explanation\n\n" +
  "This demo answer comes from the local test server. It shows how the app renders headings, tables, equations and diagrams.\n\n" +
  "## 1) What the paper is about\n\n" +
  "The paper tackles a simple problem: results get worse as the input grows, and the fix must not cost more compute. Think of a librarian who reads the whole catalog once and then answers every question from memory, instead of searching the shelves again each time.\n\n" +
  "## 2) How it works\n\n" +
  "The method has three stages:\n\n" +
  "| Stage | What happens |\n" +
  "| --- | --- |\n" +
  "| 1 | Normalize the inputs so no value dominates |\n" +
  "| 2 | Run the core model with the new loss |\n" +
  "| 3 | Decode and rank the outputs |\n\n" +
  "The key trick is that stage 1 is cheap and reusable, so the expensive part runs only once.\n\n" +
  "## 3) Architecture\n\n" +
  "```mermaid\n" +
  "graph TD;\n" +
  "  A[Inputs] --> B[Encoder];\n" +
  "  B --> C[Core model];\n" +
  "  C --> D[Decoder];\n" +
  "  D --> E[Ranked results];\n" +
  "```\n\n" +
  "## 4) Why it matters\n\n" +
  "The trade-off is simple: a small extra step at the start, and the model stays accurate on much longer inputs. To see this with a real model, add a provider (OpenAI, OpenRouter, DeepSeek or Ollama) in Settings.";

const EXPLANATION_AR =
  "# شرح تجريبي\n\n" +
  "هذا الجواب التجريبي من خادم الاختبار المحلي. يوضح كيف يعرض التطبيق العناوين والجداول والمعادلات والرسوم البيانية.\n\n" +
  "## ١) ما موضوع الورقة\n\n" +
  "تعالج الورقة مشكلة بسيطة: النتائج تسوء كلما كبر المُدخل، والحل يجب ألا يكلّف حوسبة إضافية. تخيّل أمين مكتبة يقرأ الفهرس كاملًا مرة واحدة ثم يجيب عن كل سؤال من ذاكرته، بدل البحث في الرفوف من جديد في كل مرة.\n\n" +
  "## ٢) كيف تعمل\n\n" +
  "تمر الطريقة بثلاث مراحل:\n\n" +
  "| المرحلة | ماذا يحدث |\n" +
  "| --- | --- |\n" +
  "| ١ | تطبيع المدخلات حتى لا يهيمن أي رقم على البقية |\n" +
  "| ٢ | تشغيل النموذج الأساسي بدالة الخسارة الجديدة |\n" +
  "| ٣ | فك الترميز وترتيب المخرجات |\n\n" +
  "الحيلة الأساسية أن المرحلة الأولى رخيصة وقابلة لإعادة الاستخدام، فيُشغَّل الجزء المكلف مرة واحدة فقط.\n\n" +
  "## ٣) البنية\n\n" +
  "```mermaid\n" +
  "graph TD;\n" +
  "  A[المدخلات] --> B[المرمّز];\n" +
  "  B --> C[النموذج الأساسي];\n" +
  "  C --> D[فك الترميز];\n" +
  "  D --> E[النتائج المرتبة];\n" +
  "```\n\n" +
  "## ٤) لماذا هي مهمة\n\n" +
  "المقايضة بسيطة: خطوة صغيرة إضافية في البداية، ويبقى النموذج دقيقًا على مدخلات أطول بكثير. لتجربة ذلك بنموذج حقيقي، أضف مزوّدًا (OpenAI أو OpenRouter أو DeepSeek أو Ollama) في الإعدادات.";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "Content-Type, Authorization",
  "access-control-max-age": "600",
};

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    // CORS preflight (browser clients).
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json", ...CORS_HEADERS });
      res.end(JSON.stringify({ data: [{ id: "mock-model" }] }));
      return;
    }

    if (req.method === "POST" && url.pathname.endsWith("/chat/completions")) {
      let parsed = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        /* malformed body — respond anyway */
      }
      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      const systemPrompt = messages.find((m) => m.role === "system")?.content ?? "";
      const arabic = systemPrompt.includes("اللغة العربية");
      const text = arabic ? EXPLANATION_AR : EXPLANATION_EN;
      const stream = parsed.stream !== false;

      if (!stream) {
        res.writeHead(200, { "content-type": "application/json", ...CORS_HEADERS });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: text } }] }));
        return;
      }

      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        ...CORS_HEADERS,
      });

      const words = text.split(" ");
      let i = 0;
      const timer = setInterval(() => {
        if (i >= words.length) {
          res.write("data: [DONE]\n\n");
          res.end();
          clearInterval(timer);
          return;
        }
        const payload = JSON.stringify({
          choices: [{ delta: { content: words[i] + " " } }],
        });
        res.write(`data: ${payload}\n\n`);
        i += 1;
      }, 35);
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
});

server.listen(PORT, () => {
  console.log(`Mock AI server listening on http://localhost:${PORT}/v1`);
  console.log("Configure it in Papyrus Settings as a provider:");
  console.log(`  Base URL: http://localhost:${PORT}/v1`);
  console.log("  Model:    mock-model");
  console.log("  API key:  anything (or empty)");
});
