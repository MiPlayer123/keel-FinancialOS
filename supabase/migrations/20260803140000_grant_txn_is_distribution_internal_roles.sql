-- fix(authz): grant EXECUTE on keel_txn_is_distribution to the internal
-- service roles that own its callers.
--
-- 20260721040000_overlay_writers_skip_distributions.sql created
-- keel_txn_is_distribution(uuid) and granted EXECUTE only to `authenticated`
-- and `service_role`. But the predicate is invoked from SECURITY DEFINER
-- command procs owned by keel_api (keel_cmd_decide_category_suggestion, the
-- overlay category writers) and by keel_worker categorization paths. A definer
-- function executes with its OWNER's privileges, so keel_api hit:
--   42501: permission denied for function keel_txn_is_distribution
-- (pgTAP 016 "owner accepts the rule suggestion"; also the replay integration
-- job). Grant EXECUTE to the internal roles that run the callers.

grant execute on function public.keel_txn_is_distribution(uuid) to keel_api, keel_worker;

-- keel_list_statement_payment_links (keel_api-owned SECURITY DEFINER,
-- 20260720260000) left-joins public.transaction_overrides, but keel_api was
-- never granted SELECT on it -> 42501 "permission denied for table
-- transaction_overrides" (pgTAP 035). Grant the read.
grant select on public.transaction_overrides to keel_api;

-- keel_cmd_statements_decide_payment_link (keel_api-owned SECURITY DEFINER,
-- 20260720260000) PERFORMs keel_detect_transfers on confirm, but that function
-- was granted only to authenticated/service_role -> 42501 "permission denied for
-- function keel_detect_transfers" when keel_api runs it (pgTAP 035 confirm/detach).
grant execute on function public.keel_detect_transfers(uuid) to keel_api;
