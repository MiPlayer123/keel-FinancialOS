# KEEL v3.2 configured plan — read this first

1. Read `CLAUDE.md`.
2. Read `INFRA.md`.
3. Read `PROJECT-SETUP.md`.
4. Rotate the Plaid Sandbox secret before making any Plaid request.
5. Copy the environment templates; never commit filled secret files.
6. Begin with the deterministic backend spine and simulator, then Plaid Sandbox.

This package deliberately contains the public Supabase project configuration but contains no privileged Supabase key, Plaid credential, access token, database password, or AI key.
