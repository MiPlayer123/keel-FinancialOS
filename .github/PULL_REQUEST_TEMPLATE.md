## What changed

<!-- Describe the user-visible or contract change. -->

## Why

<!-- Link the issue, stage/gate, and governing spec section. -->

## Verification

<!-- List the exact checks run and any evidence captured. -->

## Safety checklist

- [ ] No secrets, real financial data, identifying screenshots, or real merchant/employer fixtures
- [ ] Money uses integer minor units; no financial arithmetic was added to an LLM path
- [ ] Mutations are authorized, audited, reversible, and idempotent
- [ ] Multi-currency values are not combined without an explicit conversion policy
- [ ] Web changes pass `cd apps/web && pnpm build`
- [ ] Database changes include tenant-isolation and replay tests
