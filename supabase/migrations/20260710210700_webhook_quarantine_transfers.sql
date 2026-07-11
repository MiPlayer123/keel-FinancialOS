-- Audit-v2 additions (PLAN §3.6): webhook quarantine + transfer-link headroom.

-- Payloads that FAIL Plaid-Verification (or any provider verification) never
-- touch raw_provider_events; they land here for diagnostics only (PLAN §3.6.3).
create table public.webhook_rejections (
  id uuid primary key default gen_random_uuid(),
  provider public.bank_provider not null,
  reason text not null check (length(reason) between 1 and 500),
  -- Rejected bytes, stored verbatim for forensics. DATA-TIER, never promoted.
  body bytea not null,
  headers jsonb not null,
  received_at timestamptz not null default now()
);

create trigger webhook_rejections_immutable
  before update or delete on public.webhook_rejections
  for each row execute function public.keel_forbid_mutation();

-- No client access at all; server-side surface only.
revoke all on public.webhook_rejections from anon, authenticated;
grant select, insert on public.webhook_rejections to keel_api, keel_worker;
alter table public.webhook_rejections enable row level security;
create policy webhook_rejections_definer_all on public.webhook_rejections
  for all to keel_api, keel_worker using (true) with check (true);

-- Transfer links: schema headroom now (BC-v2.1 §3), confirm-flow + exclusion
-- property tests arrive in Stage 1D with reports (PLAN §3.6.9, D-012).
create type public.transfer_link_status as enum ('suggested', 'confirmed', 'rejected');

create table public.transfer_links (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id),
  txn_out uuid not null references public.canonical_transactions (id),
  txn_in uuid not null references public.canonical_transactions (id),
  status public.transfer_link_status not null,
  decided_by uuid references auth.users (id),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  check (txn_out <> txn_in),
  check (
    (status = 'suggested' and decided_by is null and decided_at is null)
    or (status in ('confirmed', 'rejected') and decided_by is not null and decided_at is not null)
  ),
  unique (txn_out, txn_in)
);

revoke all on public.transfer_links from anon, authenticated;
grant select on public.transfer_links to authenticated;
grant select, insert, update on public.transfer_links to keel_api, keel_worker;
alter table public.transfer_links enable row level security;
create policy transfer_links_member_read on public.transfer_links
  for select to authenticated using (public.keel_is_household_member(household_id));
create policy transfer_links_definer_all on public.transfer_links
  for all to keel_api, keel_worker using (true) with check (true);

-- Quarantine inserts come from the webhook function's admin client directly
-- (rejected payloads never reach a proc by design, D-013).
grant insert on public.webhook_rejections to service_role;
-- These two tables are created after 210500's catch-all service_role SELECT
-- grant; re-grant here so the admin client (and integration assertions) can
-- read them.
grant select on public.webhook_rejections, public.transfer_links to service_role;
