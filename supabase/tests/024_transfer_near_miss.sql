-- FEEDBACK.md F-011: near-miss transfer suggestions (second detection tier).
-- keel_detect_transfers now runs a fuzzy pass AFTER the exact-match pass:
-- opposite-sign magnitudes differing by 0 < delta <= least(100, floor(1% of the
-- larger leg)) minor units, same currency, different accounts, <=4-day gap.
-- Exact matches still run first and consume their transactions. Privileged
-- direct inserts here are pgTAP-only scaffolding (this layer runs as the
-- migration role by design); the runtime surface goes through the proc.
begin;select no_plan();

-- Structure guard: the detector still exists with the same signature/grants.
select has_function('public','keel_detect_transfers', array['uuid'],
  'transfer detector exists (uuid signature preserved)');
select ok(has_function_privilege('authenticated', 'public.keel_detect_transfers(uuid)', 'execute'),
  'authenticated may run the detector');
select ok(has_function_privilege('service_role', 'public.keel_detect_transfers(uuid)', 'execute'),
  'service_role (worker cron) may run the detector');
select ok(not has_function_privilege('anon', 'public.keel_detect_transfers(uuid)', 'execute'),
  'anon may NOT run the detector');

-- ---------------------------------------------------------------------------
-- Fixtures. Alpha seed: household a001, entity a101, two real accounts —
-- a401 (checking, ledger a301) and a402 (card, ledger a302). Cash legs post to
-- a301 (all outflows) and a302 (all inflows); offsets go to a317 Uncategorized
-- Expense / a318 Uncategorized Income (is_category=true, never picked as cash).
-- Amounts/dates are spread so no cross-scenario pair falls within the 100-minor
-- near-miss tolerance AND the date window at once.
--
-- Every txn:  txn id 't0..', batch id 'b0..', cash leg on a301/a302, balanced
-- offset on a317/a318 (Σ postings = 0 per batch).
-- ---------------------------------------------------------------------------

-- S1 exact match (tier 1, unchanged): -$200.00 out / +$200.00 in, same day.
insert into public.canonical_transactions
  (id, household_id, entity_id, account_id, status, source, description,
   effective_date, economic_event_key)
values
  ('d4000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', '00000000-0000-4000-8000-00000000a401',
   'posted', 'sync', 'Move to card (exact out)', '2026-07-01', 'pgtap:nm:s1out'),
  ('d4000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', '00000000-0000-4000-8000-00000000a402',
   'posted', 'sync', 'Move to card (exact in)', '2026-07-01', 'pgtap:nm:s1in'),
-- S2 large near-miss OVER cap: -$500.00 out / +$498.50 in, 2 days. diff 150,
-- tol=least(100, floor(50000/100)=500)=100 -> 150 > 100 -> NOT suggested.
  ('d4000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', '00000000-0000-4000-8000-00000000a401',
   'posted', 'sync', 'Big wire out', '2026-07-03', 'pgtap:nm:s2out'),
  ('d4000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', '00000000-0000-4000-8000-00000000a402',
   'posted', 'sync', 'Big wire in (net fee)', '2026-07-05', 'pgtap:nm:s2in'),
-- S3 small pair, 1% cap wins: -$30.00 out / +$29.50 in, 1 day. diff 50,
-- tol=least(100, floor(3000/100)=30)=30 -> 50 > 30 -> NOT suggested.
  ('d4000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', '00000000-0000-4000-8000-00000000a401',
   'posted', 'sync', 'Small move out', '2026-07-07', 'pgtap:nm:s3out'),
  ('d4000000-0000-4000-8000-000000000006', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', '00000000-0000-4000-8000-00000000a402',
   'posted', 'sync', 'Small move in', '2026-07-08', 'pgtap:nm:s3in'),
-- S4 qualifying near-miss: -$80.00 out / +$79.50 in, 1 day. diff 50,
-- tol=least(100, floor(8000/100)=80)=80 -> 50 <= 80 -> SUGGESTED.
  ('d4000000-0000-4000-8000-000000000007', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', '00000000-0000-4000-8000-00000000a401',
   'posted', 'sync', 'Transfer out (fee)', '2026-07-10', 'pgtap:nm:s4out'),
  ('d4000000-0000-4000-8000-000000000008', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', '00000000-0000-4000-8000-00000000a402',
   'posted', 'sync', 'Transfer in (net fee)', '2026-07-11', 'pgtap:nm:s4in'),
-- S5 exact-beats-near-miss: -$60.00 out (07-14) could pair EXACTLY with
-- +$60.00 in (07-14) OR near-miss with +$59.50 in (07-15, diff 50, tol=
-- least(100, floor(6000/100)=60)=60 -> would qualify). Tier 1 must consume the
-- outflow with the exact inflow, leaving the +$59.50 unlinked.
  ('d4000000-0000-4000-8000-000000000009', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', '00000000-0000-4000-8000-00000000a401',
   'posted', 'sync', 'Ambiguous out', '2026-07-14', 'pgtap:nm:s5out'),
  ('d4000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', '00000000-0000-4000-8000-00000000a402',
   'posted', 'sync', 'Exact in', '2026-07-14', 'pgtap:nm:s5inexact'),
  ('d4000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-00000000a001',
   '00000000-0000-4000-8000-00000000a101', '00000000-0000-4000-8000-00000000a402',
   'posted', 'sync', 'Near-miss in (loses)', '2026-07-15', 'pgtap:nm:s5innear');

insert into public.journal_batches
  (id, household_id, canonical_transaction_id, description, effective_date, command_id)
values
  ('d4000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-00000000a001',
   'd4000000-0000-4000-8000-000000000001', 'S1 out', '2026-07-01', 'd4000000-0000-4000-8000-0000000000e1'),
  ('d4000000-0000-4000-8000-0000000000b2', '00000000-0000-4000-8000-00000000a001',
   'd4000000-0000-4000-8000-000000000002', 'S1 in', '2026-07-01', 'd4000000-0000-4000-8000-0000000000e2'),
  ('d4000000-0000-4000-8000-0000000000b3', '00000000-0000-4000-8000-00000000a001',
   'd4000000-0000-4000-8000-000000000003', 'S2 out', '2026-07-03', 'd4000000-0000-4000-8000-0000000000e3'),
  ('d4000000-0000-4000-8000-0000000000b4', '00000000-0000-4000-8000-00000000a001',
   'd4000000-0000-4000-8000-000000000004', 'S2 in', '2026-07-05', 'd4000000-0000-4000-8000-0000000000e4'),
  ('d4000000-0000-4000-8000-0000000000b5', '00000000-0000-4000-8000-00000000a001',
   'd4000000-0000-4000-8000-000000000005', 'S3 out', '2026-07-07', 'd4000000-0000-4000-8000-0000000000e5'),
  ('d4000000-0000-4000-8000-0000000000b6', '00000000-0000-4000-8000-00000000a001',
   'd4000000-0000-4000-8000-000000000006', 'S3 in', '2026-07-08', 'd4000000-0000-4000-8000-0000000000e6'),
  ('d4000000-0000-4000-8000-0000000000b7', '00000000-0000-4000-8000-00000000a001',
   'd4000000-0000-4000-8000-000000000007', 'S4 out', '2026-07-10', 'd4000000-0000-4000-8000-0000000000e7'),
  ('d4000000-0000-4000-8000-0000000000b8', '00000000-0000-4000-8000-00000000a001',
   'd4000000-0000-4000-8000-000000000008', 'S4 in', '2026-07-11', 'd4000000-0000-4000-8000-0000000000e8'),
  ('d4000000-0000-4000-8000-0000000000b9', '00000000-0000-4000-8000-00000000a001',
   'd4000000-0000-4000-8000-000000000009', 'S5 out', '2026-07-14', 'd4000000-0000-4000-8000-0000000000e9'),
  ('d4000000-0000-4000-8000-0000000000ba', '00000000-0000-4000-8000-00000000a001',
   'd4000000-0000-4000-8000-00000000000a', 'S5 in exact', '2026-07-14', 'd4000000-0000-4000-8000-0000000000ea'),
  ('d4000000-0000-4000-8000-0000000000bb', '00000000-0000-4000-8000-00000000a001',
   'd4000000-0000-4000-8000-00000000000b', 'S5 in near', '2026-07-15', 'd4000000-0000-4000-8000-0000000000eb');

-- Cash leg on a301 (checking, outflows) or a302 (card, inflows); balanced
-- offset on a317 (expense) / a318 (income). Σ per batch = 0.
insert into public.journal_postings (batch_id, ledger_account_id, entity_id, amount_minor, currency) values
  -- S1 exact: -20000 / +20000
  ('d4000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-00000000a301',
   '00000000-0000-4000-8000-00000000a101', -20000, 'USD'),
  ('d4000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-00000000a317',
   '00000000-0000-4000-8000-00000000a101',  20000, 'USD'),
  ('d4000000-0000-4000-8000-0000000000b2', '00000000-0000-4000-8000-00000000a302',
   '00000000-0000-4000-8000-00000000a101',  20000, 'USD'),
  ('d4000000-0000-4000-8000-0000000000b2', '00000000-0000-4000-8000-00000000a318',
   '00000000-0000-4000-8000-00000000a101', -20000, 'USD'),
  -- S2 large near-miss over cap: -50000 / +49850
  ('d4000000-0000-4000-8000-0000000000b3', '00000000-0000-4000-8000-00000000a301',
   '00000000-0000-4000-8000-00000000a101', -50000, 'USD'),
  ('d4000000-0000-4000-8000-0000000000b3', '00000000-0000-4000-8000-00000000a317',
   '00000000-0000-4000-8000-00000000a101',  50000, 'USD'),
  ('d4000000-0000-4000-8000-0000000000b4', '00000000-0000-4000-8000-00000000a302',
   '00000000-0000-4000-8000-00000000a101',  49850, 'USD'),
  ('d4000000-0000-4000-8000-0000000000b4', '00000000-0000-4000-8000-00000000a318',
   '00000000-0000-4000-8000-00000000a101', -49850, 'USD'),
  -- S3 small pair, 1% cap wins: -3000 / +2950
  ('d4000000-0000-4000-8000-0000000000b5', '00000000-0000-4000-8000-00000000a301',
   '00000000-0000-4000-8000-00000000a101', -3000, 'USD'),
  ('d4000000-0000-4000-8000-0000000000b5', '00000000-0000-4000-8000-00000000a317',
   '00000000-0000-4000-8000-00000000a101',  3000, 'USD'),
  ('d4000000-0000-4000-8000-0000000000b6', '00000000-0000-4000-8000-00000000a302',
   '00000000-0000-4000-8000-00000000a101',  2950, 'USD'),
  ('d4000000-0000-4000-8000-0000000000b6', '00000000-0000-4000-8000-00000000a318',
   '00000000-0000-4000-8000-00000000a101', -2950, 'USD'),
  -- S4 qualifying near-miss: -8000 / +7950
  ('d4000000-0000-4000-8000-0000000000b7', '00000000-0000-4000-8000-00000000a301',
   '00000000-0000-4000-8000-00000000a101', -8000, 'USD'),
  ('d4000000-0000-4000-8000-0000000000b7', '00000000-0000-4000-8000-00000000a317',
   '00000000-0000-4000-8000-00000000a101',  8000, 'USD'),
  ('d4000000-0000-4000-8000-0000000000b8', '00000000-0000-4000-8000-00000000a302',
   '00000000-0000-4000-8000-00000000a101',  7950, 'USD'),
  ('d4000000-0000-4000-8000-0000000000b8', '00000000-0000-4000-8000-00000000a318',
   '00000000-0000-4000-8000-00000000a101', -7950, 'USD'),
  -- S5 exact-beats-near-miss: out -6000 / exact in +6000 / near in +5950
  ('d4000000-0000-4000-8000-0000000000b9', '00000000-0000-4000-8000-00000000a301',
   '00000000-0000-4000-8000-00000000a101', -6000, 'USD'),
  ('d4000000-0000-4000-8000-0000000000b9', '00000000-0000-4000-8000-00000000a317',
   '00000000-0000-4000-8000-00000000a101',  6000, 'USD'),
  ('d4000000-0000-4000-8000-0000000000ba', '00000000-0000-4000-8000-00000000a302',
   '00000000-0000-4000-8000-00000000a101',  6000, 'USD'),
  ('d4000000-0000-4000-8000-0000000000ba', '00000000-0000-4000-8000-00000000a318',
   '00000000-0000-4000-8000-00000000a101', -6000, 'USD'),
  ('d4000000-0000-4000-8000-0000000000bb', '00000000-0000-4000-8000-00000000a302',
   '00000000-0000-4000-8000-00000000a101',  5950, 'USD'),
  ('d4000000-0000-4000-8000-0000000000bb', '00000000-0000-4000-8000-00000000a318',
   '00000000-0000-4000-8000-00000000a101', -5950, 'USD');

-- ---------------------------------------------------------------------------
-- Detection: service path (auth.uid() null -> membership guard skipped).
-- Tier 1 finds 2 exact pairs (S1, S5-exact); tier 2 finds 1 near-miss (S4).
-- ---------------------------------------------------------------------------
select is(public.keel_detect_transfers('00000000-0000-4000-8000-00000000a001'),
  3, 'detector returns total across both tiers (2 exact + 1 near-miss)');

-- (1) Tier 1 unchanged: the exact S1 pair is suggested.
select is(
  (select count(*)::int from public.transfer_links
    where household_id = '00000000-0000-4000-8000-00000000a001'
      and txn_out = 'd4000000-0000-4000-8000-000000000001'
      and txn_in  = 'd4000000-0000-4000-8000-000000000002'
      and status  = 'suggested'),
  1, 'S1 exact-opposite pair is suggested (tier 1 behavior preserved)');

-- (2) $1 cap holds on large amounts: S2 diff 150 > tol 100 -> NO link.
select is(
  (select count(*)::int from public.transfer_links
    where household_id = '00000000-0000-4000-8000-00000000a001'
      and txn_out = 'd4000000-0000-4000-8000-000000000003'
      and txn_in  = 'd4000000-0000-4000-8000-000000000004'),
  0, 'S2 ($500/$498.50, diff $1.50) is NOT suggested: the $1 cap holds on large sums');

-- (3) 1% cap wins on small amounts: S3 diff 50 > tol 30 -> NO link.
select is(
  (select count(*)::int from public.transfer_links
    where household_id = '00000000-0000-4000-8000-00000000a001'
      and txn_out = 'd4000000-0000-4000-8000-000000000005'
      and txn_in  = 'd4000000-0000-4000-8000-000000000006'),
  0, 'S3 ($30/$29.50, diff $0.50) is NOT suggested: the 1% cap ($0.30) wins when smaller');

-- (4) Qualifying near-miss: S4 diff 50 <= tol 80 -> suggested.
select is(
  (select count(*)::int from public.transfer_links
    where household_id = '00000000-0000-4000-8000-00000000a001'
      and txn_out = 'd4000000-0000-4000-8000-000000000007'
      and txn_in  = 'd4000000-0000-4000-8000-000000000008'
      and status  = 'suggested'),
  1, 'S4 ($80/$79.50, diff $0.50 <= $0.80 tol) IS suggested as a near-miss');

-- (5) Exact beats near-miss: the S5 outflow pairs EXACTLY with +$60.00 ...
select is(
  (select count(*)::int from public.transfer_links
    where household_id = '00000000-0000-4000-8000-00000000a001'
      and txn_out = 'd4000000-0000-4000-8000-000000000009'
      and txn_in  = 'd4000000-0000-4000-8000-00000000000a'
      and status  = 'suggested'),
  1, 'S5: exact +$60.00 inflow wins the outflow (tier 1 consumes it first)');
-- ... and the near-miss +$59.50 inflow is left unlinked (outflow already taken).
select is(
  (select count(*)::int from public.transfer_links
    where household_id = '00000000-0000-4000-8000-00000000a001'
      and (txn_in = 'd4000000-0000-4000-8000-00000000000b'
           or txn_out = 'd4000000-0000-4000-8000-00000000000b')),
  0, 'S5: the near-miss inflow is NOT paired (its only outflow was consumed by tier 1)');

-- Exactly the three expected links exist for alpha, nothing spurious.
select is(
  (select count(*)::int from public.transfer_links
    where household_id = '00000000-0000-4000-8000-00000000a001'),
  3, 'exactly three links total: two exact + one near-miss, no spurious pairs');

-- (6) Determinism / idempotency: a second pass creates no duplicates.
select is(public.keel_detect_transfers('00000000-0000-4000-8000-00000000a001'),
  0, 'a second detection pass inserts nothing (idempotent)');
select is(
  (select count(*)::int from public.transfer_links
    where household_id = '00000000-0000-4000-8000-00000000a001'),
  3, 'link count is stable across re-detection (deterministic replay)');

select * from finish();rollback;
