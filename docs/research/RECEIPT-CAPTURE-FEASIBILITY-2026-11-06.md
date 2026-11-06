# Receipt + paystub capture: feasibility and high-level plan (2026-11-06)

Status: **proposal, not built.** Independently reviewed 2026-11-06 (code spot-checks + design critique); corrections folded in. Builds on `docs/research/RECEIPTS-2026-07-16.md` (matcher, schema, precision harness) and the deferred list at the end of its slice spec.

## TL;DR

- **Feasible, and close to free.** At ~100 receipts + 4 paystubs a month the running cost is about **$0.05–$0.10/month** in AI calls (Claude Haiku 5.5 pricing) and $0 in infrastructure. At 1,000 receipts/month it is still about **$1/month** of AI, but stored originals would outgrow Supabase Free storage (~1 GB) within a year.
- **Most of the pipeline already exists**: upload → storage → background extraction → deterministic matcher → suggest/approve → attach, with immutable versions, soft delete, and audit. What's missing is turning it on for real, fixing a few bugs, the "hold / re-match / create cash transaction" lifecycle, more ways in (email, phone share sheet), paystubs, and a much better receipts screen.
- **Recommended channels:** (1) a rebuilt in-app upload with camera + drag-drop, (2) **email forwarding** to a private address (free), (3) **"text it" via the phone share sheet** (iOS Shortcut + Android share target, free). Real SMS is possible but costs ~$20 setup + ~$3/month + carrier paperwork; defer it.
- **AI stays small and at the edges:** a cheap model reads the document into fields; the ledger matcher (plain code) picks the transaction; you approve. No model does arithmetic (Law 1); every write stays suggest → approve (Law 10, class B) unless you turn on an explicit auto-attach policy.

## 1. What exists today (code map, 2026-11-06)

| Area | Exists | Gap |
|---|---|---|
| Storage | Private `receipts` / `statements` buckets, signed upload URLs, 10 MB cap, jpeg/png/webp/pdf | sha256 only stops re-versioning *within one document* (`unique (document_id, content_sha256)`, `20260717234500:47`); no household-level dedupe for receipts, so the same file uploaded twice (or by email and upload) becomes two documents. No email `.eml` originals |
| Records | `documents`, immutable `document_versions`, soft-detach `document_attachments` (`20260717234500`) | — |
| Extraction | `document_extractions` (merchant, amount, currency, date, confidence); worker job `receipt_extract`; `CloudVisionReceiptExtractor` (OpenAI-compatible, `packages/ai/src/receipt-provider.ts`) | **Production uses the test fixture** (`RecordedReceiptExtractor`) unless `AI_PROVIDER=cloud` + `OPENAI_API_KEY`; one `AI_PROVIDER` value is read by three features with conflicting expectations (chat `api/index.ts:485`, receipts, statements `statement-extract.ts:99`); **PDFs fail on the cloud path** (sent as an `image_url` data URI, `receipt-provider.ts:131`); no subtotal/tax/tip/last-4/line items; provenance wrong (label says `claude:` while calling OpenAI; failure rows store `MATCHER_VERSION` as extractor version, `receipt-extract.ts:146`) |
| Matching | Pure matcher `packages/documents/src/matcher.ts`: date −1/+5 d, tip band ≤25%, exact/fuzzy merchant, single suggestion at ≥75 with 15-pt lead; precision test ≥0.9 on ~18 fixtures | Multi-candidate results are discarded; no re-match when new transactions sync; candidate filter only excludes *confirmed matches* (`20260718170000:308`), not plain attachments; **ignores direction** (absolute amounts, `matcher.ts:113`), so a purchase receipt can match a refund; no "hold", no "create cash transaction" |
| Decisions | `keel_cmd_receipts_decide_match` / `_detach_match`; MCP `review_list`, `review_decide`, `receipts_attach` | Receipts are missing from the web Review page; `approval_policies` not consulted |
| UI | `/dashboard/receipts`: picker, Suggested / Unmatched / Attached lists; `attachments-section.tsx` in the transaction, paycheck, reimbursement, statement dialogs | Uploads always go to the first entity (no personal/business choice); no live refresh while reading; unmatched cards have no actions; USD hard-coded; no camera, drag-drop, search, or filters |
| Paystubs | `document_kind` has `paystub` (`20260831180000`); paychecks, components, templates, `paycheck_split_suggestions` tables; manual template editor | Contracts enum rejects `paystub`; the API bucket check (`api/index.ts:2749`) would send it to `statements` while `canonicalBucketFor` says `receipts`; extraction is only queued for `kind==='receipt'`; the paycheck dialog passes `kind="receipt"` (`paychecks/page.tsx:979`); nothing inserts `paycheck_split_suggestions`; no paystub parser |
| Business/personal | Entities + entity-bound tags (`20260831120000`), split legs | Not offered at capture time |

**Likely broken today (confirmed in repo, verify on live):** `keel_documents_confirm_upload` always inserts an attachment row (`20260717234500:234-243`), but receipts-page uploads send no target (`api/index.ts:2909`), which violates the "exactly one target" check (`:73-78`). No later migration redefines either. `docs/BACKEND-SURFACING-AUDIT.md:41` reports 0 live receipt rows. Uploads from inside a transaction dialog (which do have a target) are unaffected. Phase 0 item 1.

## 2. Cost

Unit prices gathered 2026-11-06 from vendor pricing pages (see Sources). Assumes a receipt photo is downscaled to ~1.2 MP before sending.

| Item | 100 receipts + 4 paystubs / mo | 1,000 receipts / mo |
|---|---|---|
| Email intake (Resend free or Cloudflare) | $0 | $0 (Resend free cap is 3,000/mo, 100/day) |
| Phone share sheet / iOS Shortcut / Telegram bot | $0 | $0 |
| AI extraction, Claude Haiku 5.5 ($0.10 / $0.50 per M tokens, checked on the pricing page; ~2–3k input + ~500 output tokens ≈ $0.0005–0.001 per receipt; text-only email receipts less) | ~$0.05–0.10 | ~$0.50–1 |
| Supabase storage | $0: ~0.4 GB/yr of originals, plus raw `.eml` copies (+33% base64) and statements sharing the same 1 GB | ~4–5 GB/yr → Supabase Pro ($25/mo) or Cloudflare R2 (10 GB free) |
| Optional real SMS (Twilio sole-prop 10DLC) | +~$21.50 once, +~$3/mo, +~$0.027/photo ≈ $6/mo | ≈ $30/mo |

Older or larger models change this a lot: Haiku 4.5 is 10× the price ($1 / $5), still only ~$0.50/month at 100 receipts.

**Supabase Free pauses a project after 7 idle days.** Inbound email to a paused project fails. Daily use keeps it awake; otherwise persist the raw message before acknowledging the webhook and rely on the provider's retry, or add a keep-alive.

**Free AI tiers:** Gemini's free tier is $0 but Google states free-tier data *is used to improve its products*. Not acceptable for paystubs or real receipts (Law 12 spirit, `ALLOW_REAL_PII`). Use a paid key with a hard monthly cap — the paid cost is pennies.

**Specialized OCR APIs** (Veryfi, Mindee, Taggun, Textract, Azure, Google Document AI) are 10–100× the per-document cost of a small vision LLM and mostly lack paystub models. Not needed.

**Fully free option:** in-browser OCR (tesseract.js) to pre-fill the upload form, plus manual review. Works for clean receipts, weak on crumpled thermal paper, and doesn't help email/share-sheet intake. Keep it as an "AI off" fallback, not the main path.

## 3. Capture channels

Ranked by value / cost for a single owner.

1. **In-app upload, rebuilt.** Camera capture (`<input capture>`), multi-file drag-drop, resize to ~1.2 MP in the browser before upload (canvas), HEIC handled by iOS Safari's automatic JPEG conversion (lazy-load a converter only for desktop drag-drop), entity picker (Personal / Business) defaulting to the last used, optional note. Live status while reading.
2. **Email forwarding** to a private address per household (and optionally per entity), e.g. `r-<token>@in.<domain>`. Covers Amazon/Uber/airline receipts, emailed paystub PDFs, and Gmail filters that auto-forward (`from:(amazon OR uber) subject:receipt` → forward). No Gmail API, no Google security review.
   - **Domain note:** `mikulsaravanan.com` DNS is on **Vercel**, not Cloudflare. Options:
     - **Resend inbound (recommended to start):** add an MX record for `in.mikulsaravanan.com` in Vercel DNS; Resend posts a signed webhook; the function fetches body/attachments via the Resend API. Free tier 3,000/mo (received mail counts). ⚑ account + DNS.
     - **Cloudflare Email Routing + Email Worker:** free and generous, but the zone must be on Cloudflare — move DNS, or register a separate ~$10/yr receipts domain on Cloudflare.
     - Postmark inbound needs the $16.50/mo plan; SendGrid's free plan is gone; Mailgun free allows 1 route at 100/day (viable backup).
   - **Trust:** accept mail if the address token is valid **and** DKIM/DMARC passes for the `From` domain **and** either (a) `From` is one of the user's verified addresses (manual forward), or (b) there is Gmail forwarding evidence for a verified address (`X-Forwarded-To` / ARC sealed by google.com — auto-forwarded mail keeps the *merchant's* `From`, so a plain "From must be the user" rule would reject the main use case). Everything else goes to a **quarantine list**, never silently dropped. First confirm Resend exposes raw headers (Authentication-Results, ARC). Treat everything as data-tier (Law 5): store the raw `.eml` as the immutable original, never follow links, never act on instructions in the body.
   - Gmail's forwarding setup sends a confirmation email from `forwarding-noreply@google.com`; KEEL surfaces it so the user can click it themselves. KEEL never follows the link.
   - One address per household. Entity is chosen on approval, not by address (per-entity addresses deferred).
3. **"Text it" without SMS:**
   - **iOS Shortcut** ("Share → Send to KEEL"): resizes/converts the image, then POSTs it to a **Supabase function** (not a Vercel route: Hobby caps request bodies at 4.5 MB) with a personal capture token. $0, works today.
   - **Android:** PWA `share_target` handled by a **service worker** that uploads through a signed URL. (iOS Safari does not support `share_target`, hence the Shortcut.)
   - Telegram bot: deferred. It adds another webhook and a third-party copy of every receipt.
4. **Real SMS/MMS (defer).** Twilio/Telnyx work technically, but 10DLC registration, opt-in paperwork, toll-free verification asking for a business number, and MMS compression (hurts OCR) make it poor value at this scale. Revisit only if the share sheet isn't enough.

### 3a. Idempotency (the same receipt by email and by upload is one receipt)

- Webhook: verify the Svix signature, reject timestamps outside 5 minutes, dedupe on the event id.
- Message: dedupe on the provider message id / `Message-ID`.
- File: content sha256 **per household** (today it is only per document).
- Meaning: after extraction, a duplicate key (normalized merchant, total, date, card last 4 or order #) suppresses the second copy as class A with undo (Law 10: dedupe suppression is auto + undo).

### 3b. Who did it (audit actor) and capture tokens

- `confirm_upload` hard-codes actor kind `user`. Add a **channel actor** (`email:<message-id>`, `capture_token:<id>`) to uploads and `audit_log`, bound to the household.
- Capture tokens: upload-only scope, stored hashed, shown once, rate-limited and byte-capped, revocable in Settings. Assume the token leaks (it sits in the Shortcut and in iCloud): the worst it can do is add documents to a review queue.

All channels land in the same place: a `documents` row + immutable version + a queued extraction job. One pipeline, many front doors.

## 4. Extraction

Cascade, cheapest first, all in the worker (never in the browser with a key). **No image or PDF processing inside Edge Functions** (2 s CPU on Free): resize happens on the client or in the Shortcut, PDFs go to the model natively (Claude accepts PDF document blocks, which also fixes today's PDF failure), and one vision call per worker run keeps each run inside the 150 s wall clock.

1. **Text already present** (email HTML body, PDF with a text layer — most emailed receipts and portal paystubs): strip to text → small model, text only.
2. **Image or scanned PDF:** downscale to ~1.2 MP → small vision model, temperature 0, structured JSON output, **no tools** (ingested text can never trigger actions).
3. **Low confidence or failure:** mark `needs_review`; the user fills the fields (form pre-filled with whatever was read). No retry loops that burn money.

Extraction never sets entity or category, and a cash transaction created from a receipt uses amounts the user confirmed field by field. A receipt with injected text can still lie about its total; the approval step is what catches that.

Fields to add beyond today's merchant/total/date/currency: subtotal, tax, tip, payment method + card last 4 (strong match signal), receipt/order number (dedupe Amazon order vs. shipment emails), and **line items** (description, quantity, amount) for split suggestions. Paystubs get their own schema (below).

**Checks done in code, not by the model:** line items + tax + tip must sum to the total; if they don't, keep the total and drop the split suggestion. Amounts are parsed into integer cents by code.

**Cost controls (new — none exist today):** a monthly call counter with a hard stop, a spend cap set at the provider, and an env kill switch. The fixture extractor stays the default in tests and CI. Fix the `AI_PROVIDER` conflict with separate settings per feature (e.g. `RECEIPT_EXTRACTOR=anthropic|openai|fixture`).

## 5. Matching lifecycle (the Ramp/Brex behaviour, under KEEL law)

```
received ─▶ extracted ─▶ suggested ──approve──▶ attached
                │            └─reject─▶ waiting
                ├─ no candidate ─▶ waiting ──(new txn synced: re-match)──▶ suggested
                │                     └─ hold window ends ─▶ proposed cash / out-of-pocket ──approve──▶ new txn + attached
                └─ unreadable ─▶ needs_review (user fills fields) ─▶ extracted
```

- **Re-match on sync:** when Plaid sync or a manual entry adds transactions, run the matcher for receipts in `waiting` (cheap, deterministic, no AI). Pending card transactions can match; the attachment follows the transaction when it posts.
- **Hold window:** default 7 days (card posting lag + Expensify's 7-day precedent), configurable. After it, propose one of: *create a cash transaction* (Cash account), *out-of-pocket → reimbursement claim* (uses existing reimbursements), or *keep as unmatched evidence*. All class B.
- **Multi-candidate:** show the top 3 instead of discarding them; one tap to pick.
- **Candidates:** outflows only (unless the receipt is a refund), and skip transactions that already have an active attachment.
- **Pending → posted:** the attachment must follow the transaction when a pending charge posts. Add a test; today this is assumed, not tested.
- **Rules from industry:** Ramp matches dates within ±1 day; Brex needs 2 of 3 (date, amount, merchant); Expensify allows ≤5% FX difference. Keep KEEL's matcher and add card last-4 as a signal. FX bands and category-specific tip bands are deferred until real data shows a need.
- **Optional auto-attach policy** (needs an explicit autonomy grant, Law 2): attach without asking when amount is exact, date ±1 day, merchant matches, and there's exactly one candidate. It needs a **new per-action policy** (`receipts.attach`): today `approval_policies` is one row per risk class (`20260710210100:104`), and flipping class B to auto would also auto-apply categories, transfers, splits and rules. Auto-attach never reassigns an entity and never creates a transaction; each one is logged with a policy actor and shown in an undo feed. Off by default; decision for the owner.
- Keep the ≥90% precision gate (`packages/documents/test/precision.test.ts`), grow the fixture set to ~60 cases including email receipts, tips, FX, Amazon order-vs-shipment, and duplicates; add the M6 "one real month of receipts" human check ⚑.

## 6. Personal / business tagging and splits

- **At capture:** entity picker in the upload UI and a Shortcut option; email uses one address, and the entity comes from the matched transaction or is chosen on approval.
- **On match:** if the receipt's entity differs from the transaction's, suggest reassigning the transaction (class B), never silently.
- **Mixed receipts** (e.g. warehouse-club run): line items → **split suggestion** with category and entity per leg (class B). The model groups items; code sums them and checks against the total (per `docs/BUSINESS-EXPENSE-RESEARCH.md`, split legs carry their own tags).

## 7. Finding receipts later

- **Receipts library:** search by merchant, amount, date range, entity, category, status (attached / waiting / needs review), and full text read from the document (docs/14 "receipt OCR text search" — a `tsvector` over extracted text, no AI).
- **From a transaction:** the existing attachments section, plus "find a receipt for this" which runs the matcher in reverse.
- **Export:** per entity + tax year, a zip of originals + CSV index (extends `admin.export_all`, Law 6).
- **MCP:** add read tools `receipts_list` / `receipts_search` (and later `receipts_upload` from an agent, capped and data-tier) so Claude can answer "find the receipt for the $84 hardware store charge".

## 8. Paystubs

1. Add `paystub` to `DOCUMENT_KINDS` in contracts **and** fix the API bucket check (`api/index.ts:2749`: paystub → `receipts`, matching `canonicalBucketFor`), enqueue a `paystub_extract` job, and stop passing `kind="receipt"` from the paycheck dialog. Contracts alone would turn every paystub upload into a 400.
2. Paystub extraction: employer, pay date, period, gross, net, and component lines (taxes, 401k, benefits) mapped to the existing 17 component kinds. Code checks gross − deductions = net to the cent; if it fails, show the read values for manual correction.
3. Match to the deposit using existing `paycheck_transaction_matches`.
4. Write the never-built `paycheck_split_suggestions` detector: suggest a template from the first paystub; later paystubs suggest applying it (class C preview → class B apply, per `paycheck_series_settings`).
5. Paystubs are high-sensitivity: paid AI key only, no free tiers, no logging of extracted values.

## 9. Receipts screen: UX audit

Must fix: entity picker; drag-drop + camera; live "Reading…" → result without reload; actions on every unmatched card (pick transaction, create cash transaction, mark as reimbursable, dismiss); show what was read with confidence next to each field; currency from the record (not USD); receipts in the Review page alongside other suggestions; empty state that explains the email address and Shortcut.

Nice to have (later): bulk approve for high-score matches, a "missing receipt" filter on the ledger for business transactions over a threshold. Deferred: thumbnail grid, keyboard triage.

## 10. Phased plan

Each phase is a slice with frozen tests first (harness pipeline), then UI + Playwright at desktop and 390 px.

| Phase | Scope | Gate | AI cost |
|---|---|---|---|
| **0. Make it real** | Fix the null-target upload bug; split `AI_PROVIDER` per feature; real extractor (PDF-capable) behind a counter + kill switch; fix provenance labels; keep multi-candidate results; candidate filter: direction + existing attachments; household-level sha256 dedupe; `paystub` kind end to end | Upload → read → suggestion works on live with a fictional receipt; precision test still ≥0.9 | pennies |
| **1. Lifecycle + UX** | `waiting` state, re-match on sync, hold window → propose cash/reimbursement; rebuilt receipts page (§9); receipts in Review | Playwright: upload → suggested → approve; unmatched → cash proposal → approve; undo each | — |
| **2. Email in** | Resend inbound on `in.<domain>`, trust rule + quarantine (§3), channel actor, webhook/message idempotency (§3a), raw `.eml` persisted before ack, HTML-text extraction path | Red-team fixtures: injected instructions in email body do nothing (Law 5); spoofed sender rejected | ⚑ DNS + Resend account |
| **3. Phone** | Capture tokens (§3b), iOS Shortcut recipe → Supabase function, Android `share_target` via service worker + signed URL | Token revoke takes effect immediately; rate limit per token | — |
| **4. Paystubs** | §8 | Gross − deductions = net checked in code on fixtures; manual-correct path | pennies |
| **5. Library, then splits** | Search, export bundle, MCP `receipts_list/search` first; line items + split suggestions with entity per leg only after Phases 0–4 are in daily use | Splits conserve the total (property test); export round-trips | pennies |

**Human checkpoints (⚑):** AI provider key + spend cap; DNS record + inbound email account; real-receipts month sign-off (M6); security review before accepting real paystubs.

## 11. Decisions for the owner

1. **Email domain:** subdomain of `mikulsaravanan.com` via Resend (no DNS move), or a separate cheap domain on Cloudflare (more free headroom, cleaner product name)?
2. **Extraction model:** Claude Haiku (one vendor with the rest of the stack's Anthropic usage) or keep the existing OpenAI-compatible path (`gpt-4o-mini` / `gpt-5-nano`)? Both are fractions of a cent per receipt.
3. **Auto-attach policy:** keep everything suggest → approve, or allow exact single matches to attach automatically (undoable)?
4. **Hold window:** 7 days default OK?
5. **SMS:** confirm deferring real SMS in favour of email + the phone share sheet.

## Sources

Repo: code map of `supabase/migrations/20260717234500_documents_attach_only.sql`, `20260718170000_receipt_extraction_matching.sql`, `20260831180000_document_kind_paystub.sql`, `20260712130000_paychecks.sql`, `20260721180000_paycheck_split_templates.sql`, `supabase/functions/api/index.ts` (documents routes), `supabase/functions/worker/receipt-extract.ts`, `packages/ai/src/receipt-provider.ts`, `packages/documents/src/matcher.ts`, `apps/web/src/app/dashboard/receipts/page.tsx`, `docs/BC-v2.1.md` §documents, docs 09/10/13/14, `docs/research/RECEIPTS-2026-07-16.md`, `docs/BUSINESS-EXPENSE-RESEARCH.md`.

Web (checked 2026-11-06): Cloudflare Email Routing [limits](https://developers.cloudflare.com/email-routing/limits/) and [runtime API](https://developers.cloudflare.com/email-routing/email-workers/runtime-api/); [Postmark pricing](https://postmarkapp.com/pricing); [SendGrid free plan retirement](https://static1.twilio.com/en-us/changelog/sendgrid-free-plan); [Mailgun pricing](https://www.mailgun.com/pricing/); [Resend pricing](https://resend.com/pricing) and [receiving docs](https://resend.com/docs/dashboard/receiving/introduction); [AWS SES pricing](https://aws.amazon.com/ses/pricing/); [Twilio US SMS pricing](https://www.twilio.com/en-us/sms/pricing/us); [Telnyx messaging pricing](https://telnyx.com/pricing/messaging); [Telegram Bot API](https://core.telegram.org/bots/api); [MDN share_target](https://developer.mozilla.org/en-US/docs/Web/Manifest/share_target); [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing); [Gemini pricing](https://aistudio.google.com/docs/pricing); [OpenAI pricing](https://developers.openai.com/api/docs/pricing); [AWS Textract pricing](https://aws.amazon.com/textract/pricing/); [Veryfi pricing](https://www.veryfi.com/pricing/); [Ramp receipt matching](https://support.ramp.com/troubleshooting-transaction-receipt-matching); [Brex receipts](https://www.brex.com/support/how-do-i-attach-receipts-to-brex-transactions/); [Expensify duplicate/merge rules](https://help.expensify.com/articles/expensify-classic/expenses/How-to-prevent-duplicate-expenses); [Google unverified apps](https://support.google.com/cloud/answer/7454865); [Supabase function limits](https://supabase.com/docs/guides/functions/limits).

Not verified first-hand: Twilio 10DLC fee page (403; figures from Twilio support summaries), Gemini free-tier rate limits, Supabase/R2 storage quotas.
