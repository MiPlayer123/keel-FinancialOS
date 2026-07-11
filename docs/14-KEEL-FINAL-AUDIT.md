# KEEL — Final Zero-Based Audit (v1.2 sign-off)
*Method: assume the plan is wrong; re-justify every pillar from zero. Verdict at end.*

## 1. Zero-based challenges & rulings

**Q: Should this exist at all vs "just use Quicken B&P cloud"?**
Ruling: Yes. Quicken cloud B&P caps the exact axes this user grows on (no rental module, no lot engine, thin reports, no AI, no MCP, no receipts pipeline). Classic has the depth but is desktop-locked with broken cloud story. The seam is real (doc 08 §implications). Stands.

**Q: Is double-entry + entities over-engineering for v1?**
Ruling: No — it's the moat and the migration path in one. Retrofitting entities later is the Monarch trap; the presentation layer hides the machinery (A1). Stands.

**Q: Is the tier ordering right?** Re-derived from scratch: connectivity → ledger truth → daily habit → planning → wedge → agent → expansion. Only change made in v1.1 already (M6 split, M7.5 planning brain). Stands.

**Q: Is anything still missing after the v1.1 gap closure?** Final sweep found three small holes, now patched into scope:
- **Search as a product** (Copilot ⌘F standard): full-text + structured search across transactions/merchants/notes/receipt OCR text — explicitly in T0.4; receipt-text search lands with T2.2.
- **Onboarding excellence**: guided first-run (connect → categorize sample → set safe-to-spend), Era-style progressive question packs already in T3.4 — pull question packs' *first pack* forward to M5 onboarding.
- **Undo everywhere**: every mutation reversible from audit log (single-action undo + session undo). Add to T0.16 acceptance tests.

**Q: Cost model honest?** Re-checked: heaviest-user COGS ~$5–10/mo vs Plus $8.25/mo is tight; Pro carries margin. Free tier 2-connection cap is the load-bearing wall — keep it. Stands with eyes open.

**Q: Trust plan sufficient for a solo builder?** Read-mostly launch, audit log, export guarantee, SOC2 path, founder-as-first-user. Adequate for design partners; institutional trust is earned later. Stands.

## 2. AI-FIRST — elevated from feature tier to product pillar (new §)
The audit's biggest structural finding: v1.0/1.1 treated AI as tier T3. That's how incumbents think. KEEL is **AI-first** — meaning AI is present at every layer from day one, always deterministic-spine-governed:

| Layer | AI-first expression (from M0, not M7) |
|---|---|
| Ingest | LLM categorization + merchant canonicalization from first sync (Enrich prior); receipt/paystub extraction is LLM-native; CSV/QIF import mapping proposed by agent |
| Ledger | Every fuzzy decision (category, transfer pair, refund match, dedupe) = model proposal + confidence + one-tap approve; corrections feed per-user memory immediately |
| UX | ⌘K is a **command bar that takes natural language** ("show wagoo software spend this quarter", "split this 60/40 with rent") → compiles to deterministic queries/actions with preview-before-apply. This is the AI-first UI signature. |
| Insights | Briefings, anomaly narration, monthly/year review — deterministic detectors, LLM voice (personality setting, Copilot pattern) |
| Planning | Scenario Studio & tax/retirement engines accept natural-language setup ("what if I move to Austin at $3k rent") → parameter extraction → deterministic math, always showing the math |
| Protocol | MCP server ships at M7 but the **internal service layer is MCP-shaped from M0** (same contracts), so external agents get the whole product, not a bolt-on |
| Governance | Autonomy policies per action class, approval tokens, immutable audit, red-team CI — unchanged laws |

Milestone impact: categorization/extraction/NL-command-bar move into M2–M5 acceptance criteria. Net agent-days ~+1 (mostly re-sequencing, not new scope).

## 3. UI/UX — Copilot-derived decision set (canonized for M8)
Adopted explicitly from Copilot's playbook, adapted: (1) the Review loop as the retention engine — unreviewed-dot everywhere, bulk review, swipe on mobile; (2) per-user ML that visibly improves — show "learned from you" moments; (3) speed as design — 60fps virtualized lists, optimistic writes, keyboard-everything on desktop; (4) restrained delight — one signature (Entity Spine + red-ink numerals), quiet everywhere else; (5) proactive assistant that suggests and never acts unapproved, with selectable voice; (6) direct-integration magic moments (Amazon itemization class) reserved as tier-4 wow, not v1 scope creep. Anti-adoptions logged: no iOS-only lock-in (desktop-first web), no export scarcity, no app-locked AI.

## 4. Verdict
With §2's AI-first re-sequencing and §1's three patches, the plan is judged **build-ready**: complete against every researched competitor feature (doc 12), internally consistent (schema ↔ state machines ↔ tiers ↔ milestones), adversarially tested (doc 09 §3 + this audit), economically honest (§8/doc 10), and executable by agents with human gates in the right places. Residual risks are the two that no plan removes: aggregation reliability and solo-builder trust — both mitigated, neither eliminated. Ship the runbook.
