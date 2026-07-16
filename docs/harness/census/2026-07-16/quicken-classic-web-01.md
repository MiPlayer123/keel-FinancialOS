# Census — quicken-classic-web-01

## Evidence
- `design/references/quicken-classic/web-01.png` → Retail/e-commerce product box render for "Quicken Classic Business & Personal | Windows" (1-year subscription). Not an application screenshot — no software UI is visible.
- `design/references/quicken-classic/web-02.png` → Retail/e-commerce product box render for "Quicken Classic Premier | Windows & Mac" (1-year subscription). Not an application screenshot — no software UI is visible.

## Information architecture
Not observable. Both files are packaging/marketing artwork (a 3D-rendered product box, front and spine), not a captured application surface. There is no navigation, no page, no in-app surface to place in an IA. Nothing in these two images shows where any feature "lives" inside the product or what is grouped with what on screen.

## Layout & content
Both images share an identical box-render template with only the banner tier label, headline, bullet list, and spine text swapped:

**web-01 (Business & Personal / Windows):**
- Top-left kicker, two-weight text: "Best-Selling" (bold) + "Personal Finance Software" (regular), stacked two lines.
- Large wordmark: "Quicken" in red script-style logotype with registered-trademark mark, "Classic" beneath it in a thinner red serif/sans.
- Horizontal pill-shaped banner in dark navy/indigo, white text: "BUSINESS & PERSONAL" (bold, all-caps) separated by a vertical bar "|" from "Windows" (regular weight).
- Red gradient body panel with bold white headline (two lines): "Business, rental & personal finances".
- Four bullet rows, each a white checkmark icon (circular/rounded check glyph) followed by white text:
  1. "See business, rental & personal finances together & separately"
  2. "Get built-in Schedule C & E tax reports, P&L, cash flow & more"
  3. "Manage your rental properties"
  4. "Plus get our best-in-class personal finance tools"
- Bottom white footer strip, black text, small caps/regular: "1-year subscription" separated by a vertical bar "|" from "Includes automatic connection to latest, up-to-date version".
- Left spine (visible in perspective): vertical repeated wordmark "Quicken" (small, red) near top, and rotated banner-tier text "BUSINESS & PERSONAL / Windows" running down the spine.
- No money figures, no numeric data, no account balances, no dashboards are present anywhere in this image — it is packaging copy only.

**web-02 (Premier / Windows & Mac):**
- Identical top-left kicker: "Best-Selling Personal Finance Software".
- Identical wordmark: "Quicken" / "Classic".
- Banner pill (lighter purple/periwinkle rather than navy): "PREMIER | Windows & Mac".
- Red gradient panel headline: "Optimize investments & future plans".
- Four bullet rows with the same white checkmark icon:
  1. "Track & grow your investments"
  2. "Plan ahead for retirement"
  3. "Maximize tax benefits & ease prep with built-in reports"
  4. "Track & pay your bills"
- Same footer strip: "1-year subscription | Includes automatic connection to latest, up-to-date version".
- Spine: "PREMIER / Windows & Mac" rotated text plus small "Quicken" wordmark.
- No money figures, numbers, or data density of any kind — pure marketing packaging.

Density: N/A (no rows/list/table content — this is packaging artwork, four bullets per box).
Alignment/number formatting: N/A — no numbers appear in either image.

## Controls inventory
None. No interactive controls are depicted — these are static product-box renders (e-commerce/retail listing imagery), not a UI with buttons, menus, filters, or toggles.

## Flow steps
N/A — single static packaging image per file, not a multi-screen sequence.

## States
None visible. No empty/loading/error/success application states are shown; this is packaging artwork only.

## Business rules implied
None directly evidenced from application behavior, since no software UI appears. The only content that could be read as product-tier/feature scoping (marketing claims, not verified UI rules) is:
- The "Business & Personal" tier box (web-01) claims the product can "See business, rental & personal finances together & separately" and provides "built-in Schedule C & E tax reports, P&L, cash flow" and rental property management — implying tier-gated feature segmentation between business/rental and personal contexts. (image: web-01.png)
- The "Premier" tier box (web-02) claims investment tracking/growth, retirement planning, tax-benefit optimization with "built-in reports," and bill tracking/payment. (image: web-02.png)
- Both boxes advertise "1-year subscription | Includes automatic connection to latest, up-to-date version," implying a subscription licensing model with auto-update. (images: web-01.png, web-02.png)
These are marketing claims about tier differentiation, not evidence of actual on-screen behavior, and should not be treated as confirmed UI/business rules.

## Standout details
- Consistent checkmark bullet iconography used identically across both tier boxes — a simple, recognizable "feature confirmed" glyph pattern in white against the red panel.
- Two-weight kicker line ("Best-Selling" bold + "Personal Finance Software" regular) is a small typographic device to make the trust claim pop without shouting the whole line.
- Vertical-bar "|" separator used consistently in two places (tier/platform banner, and subscription/footer line) as a lightweight inline delimiter instead of punctuation or icons.
- Tier-color-coding on the banner pill: navy/indigo for "Business & Personal," lighter purple for "Premier" — suggests a color-coded tier system across the product line (not confirmed beyond these two samples).
- Spine text is rotated 90° and mirrors the front banner label, so tier identity is legible even when boxes are shelved/thumbnailed edge-on — a physical/e-commerce merchandising affordance, not a software pattern.

## Open questions
- Neither image shows any actual Quicken Classic application UI (no register, no dashboard, no reports screen) — this unit's manifest label "web-01/web-02" is packaging/box art, not a captured web or desktop product surface. Any downstream synthesis that expects in-app evidence from this unit will find none.
- Whether "Windows" vs. "Windows & Mac" platform labeling reflects actual cross-platform feature parity, or is purely a licensing/SKU distinction, is not settled by this evidence.
- Whether the "Schedule C & E tax reports," "P&L," "cash flow," and "reports" mentioned in bullets correspond 1:1 to actual report names/screens in the product cannot be confirmed here — these are marketing bullet phrases only.
- Resolution/rendering quality of both images is high and text is fully legible; there is no illegibility issue, only a total absence of in-app content to observe.
