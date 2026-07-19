-- fix(metering): allow investments_holdings_get / investments_transactions_get in
-- keel_meter_provider_call's hardcoded kind allowlist.
--
-- 20260718120000 (WS-C investments) added these two Plaid call kinds to the
-- usage_events TABLE check constraint, but NOT to this metering PROC's own
-- hardcoded allowlist. So metering an investments call raised
-- 'KEEL_INVALID_COMMAND: provider meter kind is not allowed' — which broke
-- reconnecting/syncing any INVESTMENT account (e.g. Fidelity) with a 500 on
-- /connections/link. Two allowlists, only one was updated. This adds the kinds
-- to the proc. Verified live: the reconnect flow meters investments_holdings_get
-- / investments_transactions_get (plaid-client.ts:312,317).
CREATE OR REPLACE FUNCTION public.keel_meter_provider_call(p_provider text, p_kind text, p_household_id uuid, p_latency_ms integer, p_ok boolean, p_error_code text, p_request_id text, p_item_ref uuid, p_quantity integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_error_code text;
begin
  if p_provider is distinct from 'plaid' then
    raise exception 'KEEL_INVALID_COMMAND: provider meter provider is not allowed'
      using errcode = 'P0009';
  end if;
  if p_kind is null or p_kind not in (
    'link_token_create',
    'sandbox_public_token_create',
    'item_public_token_exchange',
    'accounts_get',
    'item_remove',
    'webhook_key_get',
    'transactions_sync',
    'investments_holdings_get',
    'investments_transactions_get',
    'cron_enqueue_syncs',
    'quarantine_capped',
    'budget_refused'
  ) then
    raise exception 'KEEL_INVALID_COMMAND: provider meter kind is not allowed'
      using errcode = 'P0009';
  end if;
  if p_request_id is not null
     and p_request_id !~ '^[A-Za-z0-9_-]{1,64}$' then
    raise exception 'KEEL_INVALID_COMMAND: provider request id is not allowed'
      using errcode = 'P0009';
  end if;
  v_error_code := case
    when p_error_code is null or p_error_code in (
      'ITEM_LOGIN_REQUIRED', 'ITEM_NOT_FOUND', 'ITEM_ERROR',
      'INVALID_ACCESS_TOKEN', 'INVALID_CREDENTIALS', 'INVALID_REQUEST',
      'INVALID_INPUT', 'INVALID_FIELD', 'INTERNAL_SERVER_ERROR',
      'RATE_LIMIT_EXCEEDED', 'PLANNED_MAINTENANCE', 'PRODUCT_NOT_READY',
      'INSTITUTION_DOWN', 'INSTITUTION_NOT_RESPONDING', 'ITEM_LOCKED',
      'USER_SETUP_REQUIRED', 'ACCESS_NOT_GRANTED',
      'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION',
      'provider_budget_exhausted', 'provider_error'
    ) then p_error_code
    else 'provider_error'
  end;

  insert into public.usage_events
    (household_id, event_type, resource_type, resource_id,
     provider, kind, latency_ms, ok, error_code, request_id, quantity)
  values
    (p_household_id, 'provider_call',
     case when p_item_ref is null then null else 'provider_item' end,
     p_item_ref, p_provider, p_kind, p_latency_ms, p_ok, v_error_code,
     p_request_id, p_quantity);
end;
$function$

