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
