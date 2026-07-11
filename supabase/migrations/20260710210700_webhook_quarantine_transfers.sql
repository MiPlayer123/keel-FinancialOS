-- Audit-v2 additions (PLAN §3.6): webhook quarantine + transfer-link headroom.

-- Payloads that FAIL Plaid-Verification (or any provider verification) never
-- touch raw_provider_events; they land here for diagnostics only (PLAN §3.6.3).
create table webhook_rejections (
  id uuid primary key default gen_random_uuid(),
  provider bank_provider not null,
  reason text not null check (length(reason) between 1 and 500),
  -- Rejected bytes, stored verbatim for forensics. DATA-TIER, never promoted.
  body bytea not null,
  headers jsonb not null,
  received_at timestamptz not null default now()
);

create trigger webhook_rejections_immutable
  before update or delete on webhook_rejections
  for each row execute function keel_forbid_mutation();

-- No client access at all; server-side surface only.
revoke all on webhook_rejections from anon, authenticated;
grant select, insert on webhook_rejections to keel_api, keel_worker;
alter table webhook_rejections enable row level security;
create policy webhook_rejections_definer_all on webhook_rejections
  for all to keel_api, keel_worker using (true) with check (true);

-- Transfer links: schema headroom now (BC-v2.1 §3), confirm-flow + exclusion
-- property tests arrive in Stage 1D with reports (PLAN §3.6.9, D-012).
create type transfer_link_status as enum ('suggested', 'confirmed', 'rejected');

create table transfer_links (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id),
  txn_out uuid not null references canonical_transactions (id),
  txn_in uuid not null references canonical_transactions (id),
  status transfer_link_status not null,
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

revoke all on transfer_links from anon, authenticated;
grant select on transfer_links to authenticated;
grant select, insert, update on transfer_links to keel_api, keel_worker;
alter table transfer_links enable row level security;
create policy transfer_links_member_read on transfer_links
  for select to authenticated using (keel_is_household_member(household_id));
create policy transfer_links_definer_all on transfer_links
  for all to keel_api, keel_worker using (true) with check (true);
