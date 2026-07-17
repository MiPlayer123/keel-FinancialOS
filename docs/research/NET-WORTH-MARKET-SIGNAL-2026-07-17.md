# Market signal — HNW/UHNW net-worth dashboards (2026-07-17)

Source: a Long Angle (HNW peer community) forum thread the founder shared —
72 replies from people with $10M–$50M+ net worth, private-fund LP positions,
real estate, and multi-currency exposure, asking "what do you use as a net
worth dashboard (incl. investment growth/decline + annual expenses)?" Logged
as competitive/positioning intel; NOT an immediate build directive.

## Why it matters to KEEL
The thread is a near-perfect statement of KEEL's own thesis and its whitespace.
The single loudest unmet need is **aggregating alts (private funds, capital
calls/distributions), real estate, and multi-currency into one net-worth view
without AUM fees or someone managing your money** — which is exactly KEEL's
multi-entity / own-your-data / deterministic-spine positioning.

## What people actually use (frequency, verbatim signal)
- **Spreadsheets (Excel / Google Sheets) — the plurality.** Monthly manual
  update valued for history, customization, and data ownership. Many now pair
  it with an LLM (Codex/Claude) that writes the scraping/App-Script and even
  manages rules. GOOGLEFINANCE + IMPORTXML for quotes.
- **Monarch** — most-named commercial tool, esp. for expenses + macro NW; just
  added **multi-business tracking** (account- AND transaction-level) "perfect
  for Real Estate, Consulting, and the random LLCs one ends up with." Has an
  MCP (was down "for admin reasons"; Plaid-vs-AI-access tension noted).
- **Empower** (free, simple; some distrust re: 401k fees), **Kubera** (whole-NW,
  parses screenshots/statements, multi-currency debated), **Quicken Classic
  Premier** (old-school NW/portfolio), **Copilot** (deliberately NOT live —
  "daily price changes unnecessarily impact my mood").
- **Alts-focused:** **Vyzer** (uploads PPM/subscription agreements → tracks
  expected distributions; LP/real-estate community favorite), **Range**,
  **Compound Planning** (AUM), **Arta** (sells alts), **Annise.io**, **Mezzi**,
  **Origin**, **Snowball** (dividends), **ProjectionLab**/**Boldin** (modeling),
  **PortfolioPerformance** (local, alts).
- **DIY "family-office wiki" pattern (recurring, and the most KEEL-adjacent):**
  Claude/ChatGPT project + markdown wiki + Monarch MCP + read-only email →
  daily rule-tidying, local spreadsheet + wiki updates, then a **weekly
  state-of-the-union report** (macro research, NW, cash flow). One member:
  "deadly good." Another: monthly folder of statements + GP updates → "direct
  Claude to read that and give me an analysis and personal financial report."

## Distilled needs (ranked) → mapped to KEEL
1. **Alts / private-fund LP tracking** (capital calls, distributions, IRR/MOIC,
   sponsor concentration %). → *KEEL gap today; strong differentiator. Maps to
   a future "investments/holdings + alts" domain (FEATURE-GAP #17) extended for
   LP structures. Vyzer's "upload the PPM → auto-extract terms" is the UX bar,
   and it rhymes with our receipts POC (doc extraction → typed record).* 
2. **Real estate + manual/illiquid assets** with periodic manual marks. → *Maps
   to manual accounts (W1.11) + a "manual asset with valuation history" type.*
3. **Multi-currency net worth** (real FX, not convert-and-forget). → *KEEL is
   already currency-safe (Law 4, never sums across currencies); the differentiator
   is an as-of FX rate + formula version (Law 9) for a consolidated view — the
   exact thing Kubera/Capitally reportedly punt on.*
4. **Expense-vs-market-move attribution** ("how big are my expenses vs the
   market moving my NW?"). → *Directly serviceable by our cash-flow + net-worth
   read models once net-worth trend ships (teardown DASHBOARD-3, FEATURE-GAP #14).*
5. **Own-your-data / no lock-in / no AUM.** → *KEEL Law 6 (full export always
   works) is a first-class selling point to this exact audience; several cited
   data lock-in (Vyzer called out) as a dealbreaker.*
6. **Optional non-live / monthly cadence** (avoid mood-driven daily checking).
   → *A "quiet mode" / monthly snapshot framing is a cheap, differentiated
   product stance.*
7. **AI chat over your own data + periodic report** (weekly/quarterly SOTU). →
   *Exactly our AI-chat POC (docs/research/AI-CHAT-2026-07-16.md) + a scheduled
   "report" generator; KEEL's provenance/evidence-drawer answers "why is this
   number X," which none of these tools do.*

## Positioning takeaways
- KEEL's multi-entity + own-your-data + deterministic-spine + AI-with-provenance
  is aimed squarely at the segment this thread represents; Monarch's new
  multi-business feature confirms the direction and is the closest mainstream
  competitor for the "LLCs + real estate" persona.
- The clearest greenfield vs. Monarch/Copilot/Empower is **alts/LP + real
  estate + multi-currency consolidation with export and AI provenance** — a
  natural Wave 3+ theme (after the daily-driver spine and the two POCs).
- The DIY "wiki + MCP + weekly report" pattern is a strong hint that a
  **scheduled AI "state of the union" report** (built on our read models +
  chat) would resonate — cheap to prototype once AI-chat lands.

## Disposition
Parked as strategy intel; folded into the roadmap as **Wave 3 theme: "alts +
real estate + multi-currency net worth, with export & AI provenance"** and a
**"scheduled SOTU report"** idea attached to the AI-chat POC. No change to the
current Wave 0/1 build order.
