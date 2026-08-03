-- fix(reimbursements): drop the ambiguous 5-arg reimbursement command overloads.
--
-- 20260721110000_reimbursements_approval_token_binding.sql re-declared
-- keel_reimbursement_create_claim / _settle / _reverse_settlement with a NEW
-- trailing `p_approval_token_id uuid default null` parameter using
-- `create or replace function`. Because the argument COUNT changed (5 -> 6),
-- that created a SECOND overload rather than replacing the original — leaving
-- both the 5-arg and 6-arg signatures live. A caller passing 5 arguments (every
-- RPC caller, and pgTAP suites 011/029) now resolves ambiguously:
--   42725: function public.keel_reimbursement_create_claim(...) is not unique
--
-- The 6-arg form defaults the token to NULL, so it fully subsumes the 5-arg
-- form. Drop the obsolete 5-arg overloads so the name resolves uniquely again.
-- keel_reimbursement_reverse_claim was never given a 6-arg overload, so it is
-- unaffected and intentionally left alone.

drop function if exists public.keel_reimbursement_create_claim(uuid, text, jsonb, uuid, jsonb);
drop function if exists public.keel_reimbursement_settle(uuid, text, jsonb, uuid, jsonb);
drop function if exists public.keel_reimbursement_reverse_settlement(uuid, text, jsonb, uuid, jsonb);

-- keel_reimbursement_reverse_claim also gained a 6-arg overload (line 115 of the
-- token-binding migration) without dropping its original 5-arg form, so it is
-- ambiguous too (pgTAP 011 "claim creation is reversible").
drop function if exists public.keel_reimbursement_reverse_claim(uuid, text, jsonb, uuid, jsonb);
