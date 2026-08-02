> **ARCHIVED (2026-08-02)** — early design-phase research notes. Decisions
> have since settled: see AGENTS.md. Some content here (Python sidecar,
> alternative names, provider lists) is outdated and must not be followed.

**Yes, this is a very doable and useful open-source project.**  
Here's a clear, practical guide to design and build it from zero.

### 1. Recommended Tech Stack (Best balance for you)

| Layer           | Technology                                    | Why it fits you                                                                |
| --------------- | --------------------------------------------- | ------------------------------------------------------------------------------ |
| Desktop shell   | **Tauri 2**                                   | Small size (5–15 MB), native, Windows + Mac                                    |
| Frontend        | React + TypeScript + Tailwind + **shadcn/ui** | Modern, clean UI, excellent RTL support in 2026                                |
| Paper fetching  | Rust (reqwest + XML parsing)                  | No extra runtime, one toolchain                                                |
| AI explanations | OpenAI-compatible client                      | Works with OpenRouter, DeepSeek, OpenCode, Grok, Claude, Ollama, local models… |
| Storage         | Tauri secure storage / keychain               | Safe storage of API keys                                                       |
| i18n + RTL      | `react-i18next` + logical CSS                 | Perfect Arabic (RTL) + English support                                         |

This stack is lightweight, private-first, and open-source friendly.

### 2. Core Features (Keep it simple)

**Must-have (MVP):**

- Choose field/category (cs.AI, cs.LG, cs.CL, cs.CV, custom keywords…)
- Show latest papers (title, authors, date, short abstract, PDF link)
- "Explain this paper" button → uses the user's own API key
- Settings page: add/manage API keys (OpenRouter, OpenAI, DeepSeek, custom base URL, Ollama…)
- Language switch: English ↔ Arabic (full RTL)
- Dark / Light mode

**Nice-to-have later:**

- Save favorite papers
- Daily digest / notifications
- Multiple AI providers with fallback
- Local model support via Ollama

### 3. High-Level Architecture

```
┌─────────────────────────────┐
│   Tauri Frontend (React)    │  ← UI + i18n + RTL
│  - Paper list               │
│  - Settings (API keys)      │
│  - Explanation panel        │
└────────────┬────────────────┘
             │ IPC
┌────────────▼────────────────┐
│   Tauri Backend (Rust)      │  ← Commands + secure storage
└────────────┬────────────────┘
             │
┌────────────▼────────────────┐
│   External APIs             │  ← arXiv (papers) + AI providers
└─────────────────────────────┘
```

### 4. Step-by-Step Development Plan

**Phase 1 – Skeleton (1–3 days)**

1. Create Tauri 2 + React + TypeScript project.
2. Add Tailwind + shadcn/ui.
3. Build basic layout: sidebar (categories) + main list + settings.
4. Make language switch work (EN / AR) with proper `dir="rtl"`.

**Phase 2 – Papers (2–4 days)**

- Integrate arXiv API (direct HTTP from Rust).
- Show latest papers sorted by submission date.
- Categories: `cs.AI`, `cs.LG`, `cs.CL`, `cs.CV`, `cs.NE`, `stat.ML` + free search.

**Phase 3 – AI Explanation (3–5 days)**

- Settings page → user pastes API key + chooses provider (OpenRouter recommended because it supports many free & paid models).
- When user clicks "Explain":
  - Send title + abstract (and optionally PDF text later) to the model.
  - Prompt example:
    "Explain this research paper in simple clear language. Focus on the main idea, method, and results. Respond in the same language the user is using (English or Arabic)."
- Support streaming response for better UX.

**Phase 4 – Polish & Open Source**

- Good empty states, loading skeletons, error handling.
- Secure key storage (Tauri keychain / OS credential store).
- README with screenshots in both languages.
- MIT or Apache-2.0 license.
- GitHub Actions for Windows + Mac builds.

### 5. UI/UX Principles (Keep it simple)

- Clean, minimal, modern (think Linear + Notion style).
- Big readable cards for papers.
- One-click "Explain with AI".
- Clear language toggle in the top bar.
- Arabic should feel native (good Arabic font + proper RTL spacing).

Suggested name ideas:

- **PaperLens**
- **ArxivMind**
- **ScholarFlow**
- **Q4Papers** (ties to your brand)
- **Al-Waraq** (الورق)

### 6. How to Start Today

1. Install prerequisites: Rust, Node.js, Python.
2. Run:
   ```bash
   npm create tauri-app@latest
   ```
   Choose React + TypeScript + Tailwind.
3. Add shadcn/ui and set up RTL from day one.
4. Create a simple Rust script that fetches the latest 20 papers from `cs.AI` and prints them.

I can give you:

- Ready project structure
- Exact Tauri + React starter commands
- Rust code for arXiv + OpenAI-compatible client
- Good system prompt for explanations (EN + AR)
- UI component examples with proper RTL
