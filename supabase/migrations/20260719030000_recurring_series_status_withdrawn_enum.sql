-- refine(recurring) part 1/2: add a 'withdrawn' terminal status so a detection
-- run can RETRACT a 'suggested' series it no longer produces, WITHOUT overloading
-- 'rejected' (a distinct USER action in keel_recurring_transition_core, with its
-- own transition, its own re-confirm path 'rejected'->'confirmed', and a Review
-- surface meaning "the user said no"). A system-withdrawn stale suggestion is a
-- different fact: "the detector stopped seeing this", and must be independently
-- reversible (a later run re-suggests it). See 20260719031000 for the reap that
-- uses these values and the upsert change that lets a withdrawn series come back.
--
-- Postgres gotcha (the reason this is its own migration): ALTER TYPE ... ADD
-- VALUE cannot be used in the same transaction that later references the new
-- value. The manual apply path runs each migration file in its OWN
-- --single-transaction psql invocation, so the value added here is committed
-- before 20260719031000 (which reads/writes it) runs. Keep these two ALTERs the
-- ONLY statements in this file.
--
-- Both enums gain the value:
--   recurring_series_status  += 'withdrawn'  (the materialized series state)
--   recurring_transition     += 'withdrawn'  (the append-only status_events row
--                                             the reap writes, preserving the
--                                             timeline-is-authoritative invariant)
--
-- Idempotent: IF NOT EXISTS guards a replay against a partially-applied file.
-- No table/column change → no export DTO change, no pgTAP 008 allowlist change.

alter type public.recurring_series_status add value if not exists 'withdrawn';
alter type public.recurring_transition   add value if not exists 'withdrawn';
