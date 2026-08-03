-- fix(budgets): drop the ambiguous 5-arg budget command overloads.
--
-- The exact same latent bug 20260803130000 fixed for reimbursements exists for
-- budgets. 20260721100000_budgets_approval_token_binding.sql re-declared
-- keel_cmd_budgets_set_total / _set_target / _remove_target /
-- _set_expected_income with a NEW trailing `p_approval_token_id uuid default
-- null` parameter using `create or replace function`. Because the argument
-- COUNT changed (5 -> 6), that created a SECOND overload rather than replacing
-- the 5-arg original from 20260720170000_budgeting_v2_plan.sql -- leaving BOTH
-- signatures live. Any caller passing 5 arguments (every web RPC caller, which
-- omits the defaulted token) then resolves ambiguously:
--   42725: function public.keel_cmd_budgets_set_total(...) is not unique
--
-- This was NOT caught by CI: the pgTAP double-reset convergence only diffs
-- schema dumps (two overloads exist stably), and no suite invokes a budget
-- command with 5 positional/named args, so the 42725 never fired in CI. It
-- fires at RUNTIME the moment the app calls a budget command. The reimbursement
-- twin (20260803130000) was caught only because pgTAP suites 011/029 DO call
-- those RPCs.
--
-- The 6-arg form defaults the token to NULL, so it fully subsumes the 5-arg
-- form (identical behaviour when no token is supplied). Drop the obsolete 5-arg
-- overloads so each name resolves uniquely again.

drop function if exists public.keel_cmd_budgets_set_total(uuid, text, jsonb, uuid, jsonb);
drop function if exists public.keel_cmd_budgets_set_target(uuid, text, jsonb, uuid, jsonb);
drop function if exists public.keel_cmd_budgets_remove_target(uuid, text, jsonb, uuid, jsonb);
drop function if exists public.keel_cmd_budgets_set_expected_income(uuid, text, jsonb, uuid, jsonb);
