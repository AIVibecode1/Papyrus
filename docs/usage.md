# Usage

## Setup

1. **Install the app.** Use the Windows installer (MSI or setup EXE) or
   the macOS app bundle from the release page.
2. **Add an AI provider.** Open Settings, press "Add provider", choose a
   preset (OpenAI, OpenRouter, DeepSeek, Groq, Ollama) or type a custom
   base URL and model. Paste your API key. Press "Test" to check the
   connection. Ollama on your own machine works without a key.
3. **Browse papers.** Pick a field from the sidebar. The 20 newest papers
   appear, newest first. Use the search box to look for any topic. Press
   the refresh button to check for new uploads.

## Reading and explaining

4. **Read a paper.** Press "Read" to open the paper's PDF inside the app:
   flip pages, zoom, and search inside the PDF. The PDF button next to it
   still opens the paper on arXiv in your browser. The bookmark button
   saves it to your favorites, and the "Saved" toggle shows only saved
   papers.
5. **Explain a paper.** Press "Explain". The explanation streams in,
   written in the current interface language in plain terms (every
   technical term explained). Use "Stop" to cancel or "Regenerate" to ask
   again. You can switch providers from inside the explanation panel.
6. **Walk through a whole paper.** Inside the reader, press "Explain the
   whole paper". The mentor explains the paper section by section; press
   "Continue" when you are ready for the next section, and it finishes
   with a final summary of the whole paper.
7. **Ask questions about a paper.** Open the "Ask" tab inside the reader
   and type any question. The answer is grounded in the paper's text.
   Select a passage in the PDF first and the question is answered with
   that passage as context. Your chat history is kept per paper.
8. **Switch language and theme.** Use the toggles in the top bar: the
   language group flips the whole interface to Arabic with full RTL (and
   explanations are then written in Arabic), and the theme button cycles
   Light (soft, low contrast), Sepia (warm paper) and Dark. The same
   choice lives in Settings under Appearance. Your choices are remembered.

## Paper coverage and history

Today's view is the latest 20 papers for the field you are looking at,
newest first. You can refresh as often as you like. arXiv has no daily
quota; it only asks for politeness (about one request every 3 seconds),
and the app enforces that for you automatically.

Every time you open a field, the app collects that field's papers day
by day: on the first launch it backfills the last 14 days (up to 50
papers per day), and it keeps 30 days of history per field. The day
picker next to the paper list shows every collected day with its paper
count ("Jul 30 (23)"). Click a day to browse it, or use the arrows to
step through any past day, even ones older than the collected history
(those are fetched live from arXiv).

So there is no fixed "papers per day" number. You get up to 20 papers
per view in the latest view, up to 50 per day in the history, and you
can browse any past day at any time.

## Explanations

When you press Explain, the backend reads your key from the OS keychain,
sends the paper's title and abstract to your provider with a system prompt
that turns the model into a research mentor, not a summarizer. The
mentor is asked to:

1. Explain what the paper is about and how it works in plain terms
2. Explain every technical term the first time it appears
3. Use analogies and simple, natural language
4. Point out the paper's assumptions and weaknesses
5. Never invent details that are not in the paper

The answer is 200 to 300 words, in short paragraphs, in the language of
the interface (English or Arabic), and it renders as real markdown:
headings, lists, tables, math equations and even diagrams. The text
appears progressively as the provider generates it. You can stop or
regenerate at any time.

Whole-paper walkthroughs work the same way, except the mentor receives
the actual text of the paper, section by section. The reader extracts the
text from the PDF, splits it into sections, and the mentor explains each
section using a full teaching structure before you press Continue. At the
end it produces a final synthesis: the five most important ideas, the
three biggest limitations, how the paper differs from earlier work, what
to learn next, and five questions to check understanding.

The Ask tab is a grounded chat: your question (plus any passage you
selected in the PDF) is sent together with the relevant section of the
paper, and the mentor answers only from that context, honestly saying
when the answer is not in the paper.

The explanation uses your provider and your model, so the cost (if any) is
exactly what your provider charges for the tokens used, typically a small
fraction of a cent for a 300-word answer. With a local Ollama model it is
free.
