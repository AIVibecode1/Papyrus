# Papyrus: AI-PDF-Reading Research Report

Target stack: Tauri 2 + React 19 + TS. pdf.js rendering already works (canvas + text layer, find, selection, virtualization, whole-paper extraction). Backend is Rust; user supplies one OpenAI-compatible chat key from the OS keychain.

**Headline findings, in order of expected value:**

1. Papyrus already fetches from arXiv — and arXiv serves the paper's **LaTeX source** and a **LaTeXML HTML rendering**. Both give exact section structure for free. Every heuristic section detector in this report becomes a fallback, not the primary path. (Effort M, but it collapses item 4 and half of item 1.)
2. pdf.js gives you everything needed for geometric reading order, but **no ordering option exists** — `getTextContent` only exposes `includeMarkedContent` and `disableNormalization`. Ordering must be computed by you from `transform`/`width`/`height`/`fontName`/`hasEOL`. (M)
3. The two "optional" pdf.js flags actively hurt you: `disableNormalization` breaks ligature expansion, and whitespace normalization is now unconditional, so `hasEOL` + trailing-hyphen is your only dehyphenation signal. (S)
4. **BM25-only, section-grain, SQLite FTS5.** Measured evidence shows hybrid/dense fusion _regresses_ at section grain. (S)
5. For long-paper explanation, streaming sequential section-by-section beats map-reduce for coherence; map-reduce is for _summarization_, not explanation. Prompt caching makes the paper a one-time cost. (M)
6. Page-anchored chunk IDs + an explicit citation grammar in the prompt. Not prose citations. (S)

---

## 1. PDF text extraction quality

### 1.1 What pdf.js actually gives you (verified against v6.3.289)

`PDFPageProxy.getTextContent(params?)` accepts exactly two options: `includeMarkedContent` (default `false`) and `disableNormalization` (default `false`).[1][26] Each `TextItem` is `{ str, dir, transform, width, height, fontName, hasEOL }`; `styles` is a map keyed by `fontName` giving `{ ascent, descent, vertical, fontFamily }`.[26]

**There is no reading-order option.** `getTextContent` returns items in the PDF's internal content-stream order, which is the generator's emission order, not human reading order — pdf.js respects it exactly. Joining `item.str` produces text where a page footer is often the _first_ element, and where a span at the top of the page can be adjacent in the array to a span at the bottom.[22] That is upstream behavior; issue #17191 requesting built-in reordering is unresolved.

`getOutline()` gives you a native bookmark tree with `{ title, bold, italic, color, dest, count, items }`[26] — use it as the first attempt at structure. `getStructTree()` returns the tagged-PDF structure tree or `null`[26] — LaTeX output is usually untagged, so expect `null`; it's cheap to check.

**There is no better JS library than raw pdf.js for reading order.** The alternatives all wrap pdf.js; `unpdf`, `pdf-parse`, and `pdfjs-dist` differ only in API ergonomics, and none adds ordering — `pdf-parse`'s default is literally `items.map(i => i.str).join(" ")`.[18] Every serious ordering implementation is hand-rolled. The reference browser-side implementations are `pdf-mcp`'s column-aware pass and `oaustegard`'s `pdf-text-extractor`, both of which rebuild order geometrically from item positions.[3][23]

### 1.2 Two-column reading order — the highest-value fix

PDFs store positioned fragments with no reading order. The naive fix (sort by y then x) is correct single-column and catastrophic two-column: it reads left-column line 1, right-column line 1, left-column line 2, stitching half of two unrelated sentences. Once order is wrong, chunking produces spans that never existed in the source, embeddings encode mixed concepts, and nothing downstream reports the corruption.[2]

**Measured effect:** on 22 two-column arXiv papers scored against READoc ground truth[25] with `difflib.SequenceMatcher` on normalized token streams, column detection took fidelity 0.564 → 0.816, against a 0.860 practical ceiling (the score of PyMuPDF4LLM's full markdown conversion, the strongest comparator). One-column pages moved 0.821 → 0.836 — the fix correctly did not touch pages it wasn't meant to change.[2] `SequenceMatcher.ratio()` on normalized tokens is ~30 lines of Python; port it to Rust as your extraction-version regression test.

**Algorithm to implement (1):**

1. Group items into lines. Use `hasEOL` plus a y-clustering tolerance derived from median item `height`; don't assume one item per line.
2. Compute the vertical whitespace histogram of the page. Find full-height gutter gaps: gaps in the x-projection of line-start x-positions that persist across ≥60% of the page's y-range.
3. If ≥2 such gutters → two-column. Split lines by x. Read column 1 top-to-bottom, then column 2. Concatenate.
4. Else → single-column, plain y-then-x sort.

Concrete threshold from the field: cluster line-start x0 values with a gap threshold of 80 PDF points (~2.8 cm), the typical gutter width in a NeurIPS-style two-column paper; anything narrower is a paragraph indent, not a column break.[8]

**The trap that will bite you — the tall-box gate.** Treating any page with multiple boxes as multi-column breaks the title page. Author grids (three names across, affiliations below) look exactly like columns; a column-major read put Niki Parmar ahead of Ashish Vaswani in a reimplementation of the Transformer paper.[2] The fix: only take the column path when **at least two boxes are tall** — each ≥25% of the tallest box's height. Real columns run most of the page; author cells and figure captions sit well below a quarter. Pages that fail fall back to positional sort, which is correct for a title page anyway.[2]

Don't skip this. It's the single highest-leverage correctness fix in the whole pipeline, and it produces a visible, embarrassing failure if you get it wrong.

### 1.3 Hyphenation, ligatures, and what the flags do to you

**Ligatures: leave normalization ON.** pdf.js's `normalizeUnicode()` (applied in the worker unless you pass `disableNormalization: true`) runs NFKC over a specific class whose members "contain some ligatures" — `U+FB00–FB04` (ﬁ ﬂ ﬃ ﬄ ﬅ), `U+FB20–FB36` (Armenian/Hebrew presentation forms), `U+FBBE–FBFF`, plus `U+2126` (Ω sign) and various spacing characters — with a special map for `ﬅ → ſt`.[27] LaTeX papers are full of `ﬁ`/`ﬂ`. Passing `disableNormalization: true` to "get the raw bytes" **removes ligature expansion and gives you worse text**. Do not pass it.

**Whitespace normalization is no longer optional.** The old `normalizeWhitespace` option is gone: normalization moved into `PartialEvaluator.getTextContent` and is now applied unconditionally; the maintainer concluded re-instating `normalizeWhitespace = false` "would be quite difficult and would likely hurt readability" and suggested removing the option entirely.[17] That was a good change for you — dehyphenation needs _consistent_ spacing to reason about, which you now get for free.

**Dehyphenation: use `hasEOL`, not a hyphen regex.** For each line-ending run where `hasEOL === true` and the run's text ends in `-` (or U+2010), join to the next line's first run with no space. Only rejoin when the joined result is a plausible word — a cheap guard is "lowercase letter + lowercase letter," which rejects `pre-` + `trained` in cases where the author meant a real hyphen, and rejects line-final hyphens in table headers. A LaTeX export is exactly the "document processor" class where hyphenation across lines is the documented quirk: "hyphenation breaks words across lines, math is rendered as vector paths or images (not extractable text), references and citations have unusual spacing."[8]

Ligature aside, do **not** try to detect hyphenation points with a TeX pattern library (`hyphen`, `hypher`, `@react-pdf/hyphenate`). Those _insert_ hyphens from patterns; you need to _remove_ ones the PDF already placed, and `hasEOL` + trailing-hyphen is the complete signal.

### 1.4 Footnotes, headers/footers, and math

**Body vs. non-body text.** The reference approach is to compute the font-size frequency histogram over character counts, take the mode as `BASE_FS`, and drop everything outside `(BASE_FS - Δ, BASE_FS + Δ)` with Δ ≈ 3pt, plus anything with a rotated transform matrix.[21] On a random arXiv corpus that pipeline reached F1 0.99 on sentence extraction, 0.96 on paragraph extraction, and 0.96 on removing text on tables/figures/charts.[21] That same BASE_FS histogram is exactly what you need to spot footnotes: footnote text is a _second_ mode below BASE_FS and confined to the bottom band of the page. Reject the "median body size" framing from the second-layer article — _mode of character counts_ is the more robust estimator, since a long References section can drag a median.

**Running heads and page numbers** are the easiest win: a line matching `^\d{1,3}$` or identical text on ≥60% of pages, positioned in the top 8% or bottom 8% of the page box. Strip them.

**Math is largely unrecoverable from text and you should accept that.** LaTeX renders math as vector paths or images, not extractable text.[8] pdf.js will return nothing, or garbage glyphs for the subset in embedded Type3 fonts. Three options, in order of cost:

- **Cheapest and best for a desktop app:** when a line or block is detected as math, insert a literal marker — `[equation]` — and let the model know equations come out as images. Crucially, **send the page image for that region** to a vision-capable model. pdf.js already renders pages to canvas; you have the pixels.
- **Free for arXiv:** the LaTeX source has the real math in `$...$`/`\[...\]` (see §1.6).
- Don't build a LaTeX→PDF→text reverse path. That's a research project (MathSeer, Im2LaTeX, Nougat-class models), not a feature.

**Math detection heuristic:** a line whose extracted text is <25% alphanumeric characters but contains ≥2 of `{ } ^ _ = + < >` or glyphs outside Latin-1, OR a line whose horizontal extent changes sharply mid-line (large gap between item groups). Flag rather than remove — a false "equation" is cheap, a false removal is not.

### 1.5 References section detection

Detect on a heading candidate, not on body text. `References` / `Bibliography` / `Literature Cited` as a short line matching a heading signal (§4.3), followed by a high density of year-patterns `(19|20)\d{2}` and author-initials patterns, is reliable. Once found, **cut the document there for Q&A context** — the References block is typically 15–25% of a paper's tokens, is dense with the exact technical terms users type into search, and produces confidently-wrong answers ("the paper cites X as supporting this" when the citation is just a bibliography entry). Keep it in the extraction for the UI (users do want to look at it) and exclude it from the retrieval index and from walkthrough context. This is a cheap, high-value exclusion most RAG pipelines miss.

### 1.6 The arXiv shortcut — do this first

Papyrus already fetches from arXiv, so both of these are one HTTP GET away. Both were verified live against arXiv:1706.03762v7 during this research.

**LaTeX source:** `https://arxiv.org/src/<id>v<n>` 301-redirects from `/e-print/`, and returns either a gzipped tarball (multi-file) or a single gzipped `.tex`. Verified: 25 files, 1.1 MB gzipped, decompressing to ~2.4 MB. Files are flat — extract into a per-paper subdirectory.[34] Verified extraction from `ms.tex` yields exactly `Introduction, Background, Model Architecture, Why Self-Attention, Training, Results, Conclusion`, plus `\begin{abstract}`, 9 `\input{}` includes, and `\begin{thebibliography}`. That is a _perfect_ outline with zero heuristics, and section bodies come from the `.tex` files directly — clean paragraphs, inline math intact, no hyphenation, no column merging, no ligature damage.

**LaTeXML HTML:** `https://arxiv.org/html/<id>v<n>` returned HTTP 200. It carries LaTeXML's semantic markup: 7 numbered `<h2>` headings with `ltx_tag_section` spans, 29 `<section>` elements, a `ltx_abstract` block, and **142 `<math>` elements each carrying an `alttext` attribute containing the original LaTeX** (verified: `mathml` count and `alttext` count both 142). This is strictly better than the tarball when it exists — you get rendered prose _and_ exact math in LaTeX _and_ a free outline, with no tar extraction, no `\input` following, and no macro expansion. arXiv's own docs confirm LaTeXML is the converter and acknowledge a long tail of unsupported packages that produce partial or failed HTML.[35][36]

**Recommended order per paper:** try `/html/` first (best output, smallest code, covers the growing HTML-enabled corpus) → fall back to `/src/` tarball (best coverage, needs `\input` following + macro stripping) → fall back to pdf.js geometric extraction (§1.2) for everything else, including Semantic Scholar-sourced PDFs that never touched arXiv. Budget the fallback path properly; it is not an edge case if Semantic Scholar remains a source.

**Pitfall:** arXiv's rate limits and terms. arXiv explicitly asks for a delay between bulk requests and use of the `export.arxiv.org` subdomain; a desktop app fetching one paper at a time on user action is well within bounds, but don't prefetch aggressively. Also: the version suffix matters — `arxiv.org/html/1706.03762` without `v<n>` resolves to the latest version, which can change under the user between sessions. Pin the version you fetched, and store it with the extraction cache entry.

---

## 2. Long-document context (20–40 page papers)

### 2.1 The governing constraint: context is finite and rots

LLMs have an "attention budget"; as context length grows, recall degrades non-uniformly, and it degrades _faster_ for needles that require semantic rather than lexical matching. Across 18 models (GPT-4.1, Claude 4, Gemini 2.5, Qwen3), performance degraded consistently with input length, and the degradation was worse for lower needle-question similarity.[6] Haystack _structure_ also matters — preserving the natural flow of ideas beat randomly shuffled sentences of the same topic.[6] Distractors hit non-uniformly and get worse as length grows.[6]

Anthropic's framing: "find the smallest set of high-signal tokens that maximize the likelihood of some desired outcome," with context treated as a resource with diminishing marginal returns.[4] Their cookbook adds the important caveat that a 1M-token window doesn't change the math: "the working set on a 1M model fills with stale tool results just as fast as on a 200K model; the difference is where the hard limit sits, not how quickly context accumulates. Context rot and prefill latency scale with how much is in the window, not with the window's limit."[5]

**Concrete design rule for Papyrus:** a 30-page paper's full clean text is roughly 30–50k tokens. That _fits_ in any current long-context model. So the question is never "how do I fit it" — it's "how do I avoid paying 50k tokens of degraded attention per question." Retrieval with page anchors is the answer, and the whole paper becomes a cached prefix only for the global-summary path.

### 2.2 Chunking strategy: section-aware, not fixed-window

**Use section boundaries as chunk boundaries.** The evidence is unusually direct. Benchmarking section- vs page-granularity search on three real arXiv PDFs, page-mode search cost **5.79 extra page-read calls per query** on the GPT-3 paper, 4.71 on a 144-page LLM survey, 2.23 on a GNN review — and **11 of 24 GPT-3 sections never reached 95% token coverage inside a 10-call budget.** The agent never reports this; it just answers from whatever the first matched page held.[12] Section mode delivered all three in zero extra calls. Content recall delta: +65% on GPT-3, +24% on LLM survey, +7.3% on GNN — the gain scales with how much sections span pages.[12]

Fixed-size token windows are the weakest option. A systematic evaluation of chunking methods across classical, semantic, clustering, graph, and LLM-based approaches found many methods fail in practice (timeouts, memory, poor scalability), only a subset (Recursive Semantic, Fixed-size, Sequential HAC, Max-min) consistently completes across datasets, and more computationally expensive methods "do not yield meaningful effectiveness improvements while introducing substantially higher computational overhead."[33] Semantic chunking specifically has been shown to cost more than it returns.[33]

**So:** chunk = one section, subdivided into paragraph-level records if the section is long. Sub-chunks inherit the section's title, number, and page range as metadata. That inheritance is what makes citations readable and BM25 ranking work (§3).

**Map-reduce vs. streaming — use both, for different things:**

- **Section walkthrough (your existing feature): streaming sequential.** Process sections in document order, threading a running "narrative so far" summary forward. This preserves the paper's own argumentative arc and is what lets the explanation say "the Results section now tests exactly the claim made in §3." Map-reduce (independent per-section summaries, reduced at the end) destroys that ordering, and section order is itself signal — Methods before Results is not arbitrary.
- **"Summarize this paper" / whole-paper questions: map-reduce.** Independent per-section 150–250 token summaries → a single reduce step over the ordered list. This is the one case where parallel fan-out wins, because each section can be summarized without the others and the reduce step only needs short inputs.
- **Whole-paper as a cached prefix:** for "what's the main claim / what are the limitations," put the _entire clean paper text_ in the prompt as a stable prefix and let prompt caching make it nearly free after the first call. This is a legitimate use of long context, because it's a one-shot task with no follow-up perturbation.

### 2.3 Prompt caching — put the paper first, always

**OpenAI:** the cached-input rate is discounted up to 90%; cache writes cost 1.25× standard input for GPT-5.6+ and reads cost 0.1×, so writing once and fully reading once is 1.35× ordinary cost vs. 2× uncached — and the ratio improves with each additional read (ten requests: 2.15× vs 10× uncached). Minimum cacheable prefix is **1,024 tokens** for GPT-5.6+; OpenAI-provided hidden system tokens don't count toward the minimum.[7]

**The ordering rule that matters most:** the _static_ content must come first and the _dynamic_ content last. The documented failure mode: "Consider a static developer message followed by a dynamic user message in each request. This request writes through the dynamic content. Changing that content in the next request does not match the longer cached prefix, and there is no separate breakpoint after the static content." The fix is an explicit cache breakpoint placed after the static content in **both** requests.[7] For Papyrus: `[system instructions] [paper text] [retrieved excerpts] [current question]` — the paper is static across a chat session, the retrieved excerpts and question are not.

Two more gotchas worth knowing: prefix matching is backward from breakpoints, so a prefix that ends mid-message (you appended to a user message) won't reuse the earlier endpoint without an explicit breakpoint at that boundary; and switching from implicit to explicit caching mode mid-session won't reuse an implicit prefix unless an explicit breakpoint lands on the same content-block boundary.[7] Also, cached input tokens still count toward tokens-per-minute rate limits.[7]

**OpenAI-compatible providers vary.** Prefix caching is broadly implemented (Anthropic, OpenAI, Gemini, DeepSeek, Mistral, Groq) but thresholds, minimums, TTLs, and explicit-breakpoint syntax are provider-specific. For Anthropic: `cache_control: { type: "ephemeral" }` on the document block, and citation blocks can't be cached but the _source documents they reference_ can.[19] Ollama's OpenAI-compatible layer, for instance, supports `/v1/chat/completions`, `/v1/responses` and `/v1/embeddings` (accepting `model`, `input`, `encoding_format`, `dimensions`), which is why a local endpoint can serve both chat and embeddings under the single key a user already entered.[14] For a BYO-key desktop app, implement caching as: stable-prefix-first ordering always (free and correct everywhere), plus feature-detect `prompt_cache_breakpoint` / `cache_control` and degrade gracefully. **Never let a cache-unsupported provider break the request.**

### 2.4 Keeping a coherent global narrative

- **Structure the system prompt, don't bloat it.** Anthropic recommends organizing into distinct sections with XML tags or Markdown headers, and calibrating to the "Goldilocks zone" — not brittle hardcoded logic, not vague guidance. Notably, "the exact formatting of prompts is likely becoming less important as models become more capable."[4]
- **Thread a rolling summary.** After each section explanation, append a ≤120-token "established so far" note. Feed the _latest_ rolling note forward, never the full history. This is structured note-taking / compaction applied to a fixed document, and it's the technique Anthropic describes for maintaining coherence across summarization steps.[4]
- **Retrieval results get their own system-prompt block, not inlined into the user turn.** Anthropic's "just in time" pattern: maintain lightweight identifiers and load content at runtime, so identifiers in a structured context carry metadata signals (naming conventions, hierarchy) that reduce how much context you need.[4]
- **Stream, and stream progressively.** Anthropic's multi-agent research pattern has each sub-agent explore tens of thousands of tokens and return 1,000–2,000 condensed tokens. The general rule applies: do the deep work in an isolated context, return the distillation.[4] Your walkthrough already does this — keep the per-section context scoped to that section plus the rolling note, never the whole paper.

---

## 3. Retrieval-augmented QA over a single paper

### 3.1 The decisive constraint: one document, no server, possibly no embeddings API

A single 30-page paper yields 20–60 section/paragraph records. That is tiny. Two consequences:

**A vector DB is unnecessary.** A brute-force cosine scan over ~60 × 384-dim float32 vectors is ~23k multiply-adds — sub-millisecond. Do not build an ANN index; it adds failure modes and buys nothing. Store vectors as a `BLOB` in SQLite, scan in Rust. (`tantivy` 0.26.2 and `fastembed` 7.1.0 are both current and viable if you want them, but neither is required at this scale.)[29][28]

**Lexical search is the workhorse, not a fallback.** The strongest available evidence, on exactly this problem: adding dense fusion at section grain caused a **33% lexical regression** (MRR 0.93 → 0.63) on a 45-query benchmark across three arXiv PDFs. BM25-only section-grain was the strongest cell overall (0.53 mean MRR vs 0.36 for hybrid). The mechanism: "Section titles _are_ the lexical signal." BM25 puts the right section at rank 1 with high score; the dense ranker has no correspondingly sharp signal and spreads probability mass across the section's neighborhood; RRF then averages rank 1 with rank 5–10 and lands at rank 3. "The regression is one sentence wide: rank 1 became rank 3 because the second engine had nothing useful to add."[24]

Independent literature support: on BEIR SciFact — the closest published analog to single-paper section retrieval — RRF fusion over BM25 measured 0.730 nDCG@100 vs BM25's 0.698, a ~4.6% relative gain on scientific papers.[24] That's the ceiling for hybrid on this domain, and it's small. The same source notes PaperQA2, SOTA on the RAG-QA Arena science benchmark, uses dense embeddings + LLM reranking rather than BM25/dense fusion.[24]

**Recommendation: SQLite FTS5, BM25, section-grain, with the section title as a boosted column.** FTS5 ships `bm25()` as a built-in auxiliary function, supports `ORDER BY rank` for relevance ordering, and handles Unicode case equivalence and separator recognition by default.[30] Schema sketch:

```sql
CREATE VIRTUAL TABLE section_fts USING fts5(
  title,        -- section number + title, heavily weighted
  body,         -- the section's cleaned text
  paper_id UNINDEXED,
  page_start UNINDEXED,
  page_end   UNINDEXED,
  section_id UNINDEXED
);
-- query: SELECT ..., bm25(section_fts, 10.0, 1.0) AS score
--         FROM section_fts WHERE section_fts MATCH ? ORDER BY score;
```

FTS5 does not support weights at CREATE time — the `bm25()` column-weight argument order is positional and you pass weights at query time.[30] Also note FTS5 is an "external content"-friendly design: you can index content stored in a normal table rather than duplicating it.[30]

Use `tauri-plugin-rusqlite2`[31] rather than hand-rolling SQLite lifecycle. Verify FTS5 is compiled into the bundled SQLite — assert it at startup with a `CREATE VIRTUAL TABLE ... USING fts5` smoke test against a temp DB and fail loudly rather than at first user query.

**Store the version in the index.** When you change the extraction or chunking logic, every cached document holds text from the old pipeline. Bump a `PRAGMA user_version` marker and drop the poisoned text, embeddings, and index together — "Fixing the code is half the job; invalidating the poisoned cache is the other half. Otherwise retrieval keeps serving chunks and embeddings built from the old reading order, and the bug looks unfixed even after the new code ships."[2] This applies to every item in this report.

### 3.2 Local embeddings: worth it, but as a _conditional_ second signal

If you want semantic recall for paraphrase queries, do it locally — no second API key required.

**`fastembed` (Rust crate 7.1.0) is the right tool for a Tauri backend.** Local ONNX inference, synchronous, no Tokio dependency. Default `TextEmbedding` model is **BGE small en v1.5**; it also provides SPLADE sparse embeddings, BGE-M3 joint dense+sparse+ColBERT, image embeddings, and `TextRerank` cross-encoder reranking. Models download once to `./.fastembed_cache` (override with `FASTEMBED_CACHE_DIR` or `TextInitOptions::with_cache_dir`; `HF_HOME` takes precedence) and then run offline — "Models download once and run offline thereafter."[32] It has a `directml` feature for Windows GPU, and automatically disables memory-pattern optimization when DirectML is detected, as that provider requires.[15]

**Use the `query:` / `passage:` prefixes** — fastembed documents them as recommended, and BGE models are trained with them.[32] Omitting them degrades quality.

**But follow the evidence on when to fire it.** Given the 33% regression result, the correct design is: **BM25 always; dense only when BM25's top score falls below a threshold** (i.e., BM25 found no confident lexical match — the paraphrase case). Not RRF fusion. Not always-on. Threshold-triggered fallback, so dense can only add results BM25 missed and can never demote a correct BM25 rank-1 hit. That is a different architecture from fusion and it does not have the regression.

Also consider `TextRerank` as a second-stage reranker over the top ~20 BM25 hits — a cross-encoder is a precision win without the fusion problem, because it reranks rather than reorders the candidate set.[32] That's a better use of a local model than dense retrieval for this corpus size.

**Browser-side alternative rejected:** `@huggingface/transformers` with `Xenova/all-MiniLM-L6-v2` (384-dim, mean pooling + normalize) works in the webview[9], but your architecture puts work in Rust, and you already have a local Rust ONNX path. Don't duplicate the model in two runtimes.

### 3.3 Caching the paper, not the questions

Store per paper: sections with page ranges, the cleaned concatenated text, the FTS index, and (optionally) embeddings. The whole index for a 30-page paper is tens of KB. Build once at fetch time, reuse across sessions. The `pdf-mcp` architecture — lazy index, populated on first search, warm cache thereafter, SQLite-backed so it survives restarts — is the reference.[23]

---

## 4. Structured paper parsing

### 4.1 Is it worth it? Yes — it's the input to everything else

Section structure is not a nice-to-have; it is the chunk unit (§2.2), the retrieval unit with the best measured behavior (§3.1), the citation anchor (§5), and the walkthrough's iteration unit. Do it.

### 4.2 Cascade, in cost order

1. **arXiv LaTeX source or LaTeXML HTML** — free, exact. See §1.6.
2. **`pdf.getOutline()`** — native PDF bookmarks. Free. Often absent on LaTeX output, but check. For the Attention paper, PyMuPDF's `get_toc()` on the arXiv LaTeX export returned 22 entries across 3 levels with breadcrumbs and computed `end_page`.[8] Some arXiv PDFs _do_ ship an outline.
3. **Weighted multi-signal heading detector** — the fallback.

### 4.3 The heading detector: 7 signals, threshold 4

Regex alone fails badly. On an LLM survey full of unnumbered titles like "Background for LLMs" and "Resources of LLMs", a regex detector (`^\d+(\.\d+)*\s+[A-Z]` plus Chapter/Section/Part) scored **F1 0.324, recall 0.22** — it caught 17 of 67 gold boundaries. Widening the regex to add "Abstract", "References", "Appendix [A-Z]" did not help: "The missing titles are not regex-shaped."[12]

The weighted detector that replaced it:

| Signal               | Weight | Catches                                           |
| -------------------- | ------ | ------------------------------------------------- |
| `regex_match`        | 3      | Numbered headings, keyword headings               |
| `face_delta`         | 2      | Different font face from body majority            |
| `bold_marker`        | 2      | Bold flag **OR** font name contains a bold marker |
| `whitespace_above`   | 1      | Vertical gap ≥ 1.5× line height                   |
| `top_of_page`        | 1      | Within top 15% of page height                     |
| `title_case_or_caps` | 1      | Title Case or ALL CAPS                            |
| `short_line`         | 1      | ≤ 80 characters                                   |

Heading iff score ≥ 4. Result: **F1 0.936 / 0.800 / 0.796** across the three PDFs, with **recall 1.000 on all three**. Precision drops to ~0.67 because the detector fires on bold figure captions and table headers; downstream BM25 absorbs most of those false positives because section bodies are long enough that a misplaced heading doesn't change the top-ranked match.[12]

**The font-face surprise — read this before implementing `face_delta`.** The signal is _not_ font size. On the LLM survey: body is `URWPalladioL-Roma` 9.5pt regular, heading is `NimbusSanL-Bold` 9.5pt regular-with-bold-flag. Same size. On the GNN review it's worse: body `AdvTTe692faf0` 8.0pt regular, heading `AdvTTc9617e0c.B` 7.97pt with the bold flag **not set** — bold is encoded in the font name's `.B` suffix. The heading is _slightly smaller than the body_.[12] So the detector needs both `font_face != body_face` AND `(is_bold flag OR name contains .B / -Bold / Bold)`.

**pdf.js caveat:** `TextItem.fontName` is a key into `styles`, and `TextStyle` exposes only `{ ascent, descent, vertical, fontFamily }` — **no original font name and no bold flag.**[26] So you cannot do `.B`-suffix detection from `getTextContent` alone. Your proxies are: (a) `styles[fontName].fontFamily` as the face identity, (b) `height` on the item (≈ font size) as the size signal, (c) `getOperatorList()` if you need true font names. This is a real gap vs. PyMuPDF and argues again for putting source-based extraction first (§1.6). For the PDF fallback, use `fontFamily` clustering: compute the dominant `fontFamily` by character count (same BASE_FS methodology), treat any other family as `face_delta`, and use a _modest_ `height`-above-median weight. Accept lower precision than the PyMuPDF numbers above; they are not directly portable.

### 4.4 Post-pass merge and validation

- **Merge split headings.** LaTeX frequently emits the number and the title as separate lines (`"1"` then `"Introduction"`). Merge a bare-number line with the following line before scoring.[11]
- **Optional LLM validation pass.** The strongest variant is "rules propose, LLM validates": deterministic signals surface candidates, then one bounded LLM call (max 3 passes, converge when a pass changes nothing) keeps the real ones and can add missed ones, since it also sees a slice of surrounding lines. On the Attention paper, deterministic-only at threshold 3.5 found 24 candidates = 21 real headings + 3 false positives (BLEU scores from a results table that happened to be bold and short); recall 91%, precision 88%, level accuracy from numeric prefix 100%. Adding the LLM validation pass dropped the 3 false positives, yielding a 24-entry outline.[11] This is cheap — one call per paper, at fetch time, cached forever. You already have the key.
- **Extend partial outlines.** If `getOutline()` gives you level ≤2 but the body has `3.2.1`, run the detector and add any candidate whose title+page pair isn't already in the native outline, tagging each row with its `source` so the UI can show which entries are declared vs. inferred.[11]

---

## 5. Citation and grounding

### 5.1 Never ask the model for page numbers in prose

Two independent reasons.

**Accuracy:** an automated framework evaluating 7 commercial LLMs on 800 questions and 58,000 statement-source pairs found **between 50% and 90% of responses are not fully supported — sometimes contradicted — by the sources they cite.** Even GPT-4o with Web Search had ~30% of individual statements unsupported and nearly half its responses not fully supported. The automated evaluator agreed with a panel of three US-licensed physicians 88.7% of the time, better than inter-physician agreement (86.1%).[10] Self-reported citations are not a verification mechanism.

**Unverifiability:** if the model writes "see page 7," nothing checks whether the supporting text is actually on page 7. The user has to go look — which is the manual verification loop you're trying to eliminate.

### 5.2 The pattern that works: stable chunk IDs + explicit grammar

Both major providers converged on the same design, which is strong evidence it's correct.

**OpenAI's documented injected-context pattern:** each citable unit is identified by the value of its `id` attribute; the model emits citations as `{CITATION_START}cite{CITATION_DELIMITER}block5{CITATION_STOP}` (U+E200 / U+E202 / U+E201 private-use codepoints), with optional line-range locators. The documented prompt rules: place citations at the end of the supported sentence, or inline if the sentence is long and has multiple supported clauses; citations must be placed **after punctuation**; cite only blocks present in the provided context; **never invent new block IDs**; never cite outside the provided context; if multiple blocks materially support a proposition, cite all of them; if provided blocks conflict, **cite the conflicting blocks and describe the conflict accurately.** OpenAI ships a copy-pasteable `extractCitations()` parser (TS, Python, and Rust variants shown in their docs) that resolves source IDs and preserves character offsets.[20]

That Rust parser variant is directly usable in your Tauri backend — parse on the Rust side, strip raw markers, emit structured citation objects to the webview.

**Anthropic's native Citations API** does the same thing server-side and confirms the architecture: documents are chunked to define citation granularity, and the response splits into text blocks where each block carries a claim plus its citations. For PDFs, citations carry **1-indexed page number ranges** (`start_page_number` / `end_page_number`, exclusive end); for plain text, character index ranges; for custom content, block index ranges. Each citation includes `cited_text` — the exact quoted text — which is provided for convenience and doesn't count toward output or subsequent input tokens.[19]

**Papyrus implementation (M, and this is the highest-value item in §5):**

- Chunk ID format: `S3.2@p7` (section number + page) or a flat integer — stable, derived from position, never a hash of the text (so it survives re-extraction and stays meaningful).
- Injected context block carries the ID, the section number/title, the page range, and the text. Format: `--- source: S3.2 | §3.2 Method | pages 7-9 ---`.
- Use OpenAI's U+E200/E202/E201 grammar verbatim, with your ID regex swapped in — it survives streaming and needs no model-side training.
- **Parse and render citations as clickable chips that jump the PDF viewer to the page.** This is the payoff: `S3.2` → scroll to page 7, highlight the section. The app already has find-in-page and a text layer, so this is UI glue, not new infrastructure.
- **Verify, don't trust.** Post-process each emitted citation: confirm the ID exists in the injected set (drop and flag unknown IDs — that alone catches hallucinated references), and confirm the cited text actually appears in that chunk. Cheap string containment. VeriCite's ablation showed removing the verification step causes "a severe deterioration in citation quality" — NLI-verifier citation F1 80.05, Llama3-8B verifier 73.01, DeepSeek-R1 verifier 79.22, and the paper concludes the NLI model's cost-effectiveness beats a large LLM verifier for the same role.[16] You don't need an NLI model — ID validation + substring containment captures most of the value for free.
- **Allow "not in the paper."** Add an explicit instruction that if the paper doesn't support an answer, the model must say so without citing. VeriCite's design is built around eliminating unsupported content before citation; the prompt is the cheap version of that.

### 5.3 Prompt shape for the grounded answer

```
## Citations
Supporting context is provided in the prompt as citable units. Each unit has a
stable `id` shown in its header line.

Cite a single source as:  <E200>cite<E202>S3.2<E201>
Cite multiple sources by emitting one marker per source.
Line-range locators:      <E200>cite<E202>S3.2<E202>L12-L30<E201>

- Place citations at the end of the supported sentence, or inline if the
  sentence is long and contains multiple supported clauses.
- Citations must be placed after punctuation.
- Cite only units present in the provided context.
- Never invent new IDs.
- Never cite outside the provided context.
- If multiple units materially support a proposition, cite all of them.
- If the provided units conflict, cite the conflicting units and describe the
  conflict accurately.
- If the paper does not support an answer, say so. Do not cite.
```

### 5.4 Also useful

- **Pass the current selection with its page number** as a first-class, explicitly-labeled input — when the user has a selection, it's a high-precision retrieval signal that costs nothing.
- **Don't cite the References section** for substantive claims (§1.5).
- **Prompt-cache the paper** and keep it ahead of the dynamic question (§2.3). Anthropic notes citation blocks themselves can't be cached, but the source documents they reference can.[19]
- **Consider page images for equations.** Anthropic's PDF pipeline sends each page as both text and image, which is what lets it answer questions about charts and diagrams; it costs roughly 1,500–3,000 tokens per page in text plus the image cost.[37] Reserve it for pages containing math or figures you flagged, not the whole paper.
- **Don't build a full attribution evaluator.** VeriCite's NLI-based verification is a research contribution; for a single-document desktop reader, ID validation + substring containment is the 80% that matters.

---

## Prioritized build order

| #   | Item                                                                                           | Effort | Why now                                                                                       |
| --- | ---------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------- |
| 1   | Chunk-ID + citation grammar, page-anchored, clickable                                          | **M**  | Turns "trust the AI" into "verify the AI." Biggest perceived-quality delta.                   |
| 2   | arXiv `/html/` → `/src/` → PDF cascade for structure + text                                    | **M**  | Free exact structure + math. Retires the whole heading-detector path for your primary corpus. |
| 3   | Geometric two-column reading order with tall-box gate                                          | **M**  | Measured 0.564 → 0.816. Everything downstream inherits the corruption otherwise.              |
| 4   | Section-grain chunking + SQLite FTS5 BM25 with boosted title                                   | **S**  | 0 extra calls vs. page-walk. Best measured cell. Smallest code.                               |
| 5   | Prompt-cache-friendly prompt layout (static paper first, dynamic question last)                | **S**  | 1.35× vs 2× on two calls, 2.15× vs 10× on ten.[7] Nearly free win.                            |
| 6   | Dehyphenation via `hasEOL`; keep normalization ON; strip headers/footers/footnotes via BASE_FS | **S**  | Text quality compounding through every other layer.                                           |
| 7   | Extraction-version `PRAGMA user_version` cache invalidation                                    | **S**  | Prevents a class of bug that looks like "the fix didn't work."[2]                             |
| 8   | References-section detection + exclusion from retrieval                                        | **S**  | ~20% token reduction and removes confidently-wrong answers.                                   |
| 9   | Heading detector (7-signal) for the PDF fallback path                                          | **M**  | Needed for Semantic Scholar PDFs. Do after #2.                                                |
| 10  | Threshold-triggered dense fallback + optional `TextRerank` via `fastembed`                     | **M**  | Only fires when BM25 is unconfident. Do after measuring whether you need it.                  |
| 11  | Math-region flagging + page-image send for flagged regions                                     | **M**  | Only matters for math-heavy papers. Last.                                                     |

**Do not build:** a vector database (60 records × 384 dims scans in microseconds), RRF hybrid fusion (measured 33% regression at this grain), a reading-order feature inside pdf.js (unresolved upstream; compute it yourself), a LaTeX→text reverse path for math, or an NLI-based attribution evaluator.

Sources:

[1] https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html — pdf.js API — getTextContent, TextItem, getOutline
[2] https://blog.jztan.com/multi-column-pdf-reading-order — Why Multi-Column PDFs Scramble Reading Order in RAG
[3] https://github.com/oaustegard/oaustegard.github.io/blob/main/web-utilities/pdf-text-extractor_README.md — pdf-text-extractor — column-aware reading order (auto/1/2/3/pdf)
[4] https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents — Anthropic — Effective context engineering for AI agents
[5] https://platform.claude.com/cookbook/tool-use-context-engineering-context-engineering-tools — Anthropic Cookbook — context engineering: memory, compaction, tool clearing
[6] https://research.trychroma.com/context-rot — Chroma — Context Rot: How Increasing Input Tokens Impacts LLM Performance
[7] https://developers.openai.com/api/docs/guides/prompt-caching — OpenAI — Prompt caching
[8] https://towardsdatascience.com/beyond-extract_text-the-two-layers-of-a-pdf-that-drive-rag-quality — Beyond extract_text: The Two Layers of a PDF That Drive RAG Quality
[9] https://huggingface.co/Xenova/all-MiniLM-L6-v2 — Xenova/all-MiniLM-L6-v2 — Transformers.js embedding model
[10] https://www.nature.com/articles/s41467-025-58551-6 — SourceCheckup — Nature Communications 16:3615 (2025)
[11] https://towardsdatascience.com/building-document-structure-with-loop-engineering-recovering-a-pdfs-outline-from-body-typography-for-rag — Building Document Structure with Loop Engineering
[12] https://blog.jztan.com/section-chunking-vs-page-chunking-ai-agents — Section Chunking vs Page Chunking for AI Agents
[14] https://docs.ollama.com/api/openai-compatibility — Ollama — OpenAI compatibility (/v1/chat/completions, /v1/responses, /v1/embeddings)
[15] https://github.com/anush008/fastembed-rs — fastembed-rs — local ONNX embeddings and reranking in Rust
[16] https://arxiv.org/html/2510.11394v1 — VeriCite: Towards Reliable Citations in RAG via Rigorous Verification
[17] https://github.com/mozilla/pdf.js/issues/14519 — pdf.js #14519 — normalizeWhitespace now unconditional
[18] https://www.pkgpulse.com/guides/unpdf-vs-pdf-parse-vs-pdfjs-dist-pdf-2026 — unpdf vs pdf-parse vs pdfjs-dist (2026)
[19] https://platform.claude.com/docs/en/build-with-claude/citations — Anthropic — Citations API
[20] https://developers.openai.com/api/docs/guides/citation-formatting — OpenAI — Citation Formatting
[21] https://arxiv.org/html/2010.12647v1 — PDFBoT — Extracting Body Text from Academic PDF Documents
[22] https://github.com/mozilla/pdf.js/issues/17191 — pdf.js #17191 — (Re)ordering of the PDF textcontent elements
[23] https://github.com/jztan/pdf-mcp — pdf-mcp — MCP server for large-PDF search and reading
[24] https://blog.jztan.com/bm25-vs-hybrid-search-section-rag — Section-Level RAG: Why BM25 Beat Hybrid Search in My Benchmark
[25] https://arxiv.org/html/2409.05137v1 — READoc — A Unified Benchmark for Realistic Document Structured Extraction
[26] https://unpkg.com/pdfjs-dist@6.3.289/types/src/display/api.d.ts — pdfjs-dist 6.3.289 type definitions (verified against the installed version)
[27] https://raw.githubusercontent.com/mozilla/pdf.js/master/src/shared/util.js — pdf.js src/shared/util.js — normalizeUnicode (verified locally against master)
[28] https://crates.io/crates/fastembed — fastembed — crates.io
[29] https://crates.io/crates/tantivy — tantivy — Rust full-text search crate
[30] https://sqlite.org/fts5.html — SQLite FTS5 Extension
[31] https://crates.io/crates/tauri-plugin-rusqlite2 — tauri-plugin-rusqlite2 — crates.io
[32] https://docs.rs/fastembed/latest/fastembed — fastembed — Rust crate docs (BGE small en v1.5 default, model cache)
[33] https://arxiv.org/html/2606.00881v1 — Chunking Methods on RAG — effectiveness vs. computational cost
[34] https://info.arxiv.org/help/unpack.html — arXiv — Unpacking Retrieved Papers (e-print / src tarball formats)
[35] https://info.arxiv.org/about/accessibility_html_error_messages.html — arXiv — HTML paper error messages (LaTeXML coverage)
[36] https://arxiv.org/html/2402.08954v1 — HTML papers on arXiv: why it's important, and how we got there
[37] https://platform.claude.com/docs/en/build-with-claude/pdf-support — Anthropic — PDF support (page text + image pipeline, token costs)
