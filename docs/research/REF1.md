> **ARCHIVED (2026-08-02)** — early design-phase research notes. Decisions
> have since settled: see AGENTS.md. Some content here (Python sidecar,
> alternative names, provider lists) is outdated and must not be followed.

**Yes**, there are several solid free APIs that give you the latest research papers in AI, Tech, and Computer Science.

Here are the best ones (ranked by usefulness for _latest_ AI/CS papers):

### 1. arXiv API (Best for absolute latest papers)

- Completely free, **no API key** required.
- The main source for cutting-edge AI/ML/CS preprints (most new work appears here first).
- You can sort by submission date to get the newest papers.

**Endpoint example:**

```bash
https://export.arxiv.org/api/query?search_query=cat:cs.AI+OR+cat:cs.LG+OR+cat:cs.CL&sortBy=submittedDate&sortOrder=descending&max_results=20
```

- Categories useful for AI/Tech: `cs.AI`, `cs.LG`, `cs.CL`, `cs.CV`, `cs.NE`, `stat.ML`, etc.
- Rate limit: Be polite (~1 request every 3 seconds).
- Docs: [info.arxiv.org/help/api](https://info.arxiv.org/help/api/basics.html)

### 2. Semantic Scholar API (Very strong overall)

- Free (works without a key, but a free key is recommended for better rate limits).
- Indexes 200M+ papers with good AI/CS coverage.
- Extra features: TLDR summaries, recommendations, influential citations, and semantic search.

**Search example:**

```
https://api.semanticscholar.org/graph/v1/paper/search?query=large+language+models&fields=title,abstract,year,citationCount,tldr&limit=10
```

- Request a free API key here: [semanticscholar.org/product/api](https://www.semanticscholar.org/product/api)

### 3. OpenAlex API

- Free (API key required now, but getting one takes ~30 seconds).
- Covers 250M+ works.
- Excellent filtering and sorting by publication date.
- Good daily free quota ($1/day of usage, which is quite generous).

Example for latest papers:

```
https://api.openalex.org/works?search=transformer&sort=publication_date:desc&per_page=20
```

### 4. DBLP API (Best pure Computer Science focus)

- Completely free, no key needed.
- Specializes in Computer Science (conferences + journals). Excellent coverage of NeurIPS, ICML, CVPR, ACL, etc.

```bash
https://dblp.org/search/publ/api?q=attention+is+all+you+need&format=json&h=10
```

### 5. Others worth knowing

| API                     | Best for              | Key needed? | Notes                          |
| ----------------------- | --------------------- | ----------- | ------------------------------ |
| **CORE**                | Open-access full text | Free key    | Aggregates many repositories   |
| **Crossref**            | DOI + metadata        | No          | Very reliable metadata         |
| **Hugging Face Papers** | Daily AI papers       | Optional    | Nice for trending arXiv papers |

### Recommendation

- For **latest AI research** → Start with **arXiv API** (sort by `submittedDate`).
- For richer search + citations + summaries → Use **Semantic Scholar**.
- For pure CS conference papers → **DBLP**.
