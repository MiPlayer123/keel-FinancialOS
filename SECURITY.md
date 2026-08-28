# Security Policy

KEEL handles financial data, so security reports get priority over everything else.

## Reporting a vulnerability

Private vulnerability reporting is not enabled yet. Do not post exploit details,
credentials, financial data, or identifying information in a public issue.
This repository is not ready to accept confidential reports until a maintainer
enables a private channel and updates this policy.

Include what you found, steps to reproduce, and the impact you believe it has.
You will get a response within a few days.

## Scope

- The code in this repository: web app, edge functions, migrations, and packages.
- The hosted instance at keel.mikulsaravanan.com, with limits: only test with
  accounts and data you own, and do not run automated scanners or load tests
  against it.

## What we most want to hear about

- Cross-tenant data access or any row-level-security bypass.
- Authorization bypasses (any path around the authz compiler).
- Secret or token exposure.
- Prompt-injection paths where ingested text (memos, receipts, CSV) reaches a
  tool call, write, or fetch.
- Any way AI output mutates the ledger without an approval.
