-- Provider-call metering vocabulary: admit /transactions/recurring/get.
--
-- usage_events.kind is a pinned CHECK list, so the new billed call was
-- rejected at insert time — and meterCall swallows telemetry failures by
-- design (plaid-meter.ts: "Telemetry is best-effort"), so the FIRST live
-- Phase 1 fetch ran completely unmetered and invisible. A billed add-on with
-- no usage row is exactly the cost blind spot the user asked to avoid.
alter table public.usage_events drop constraint usage_events_provider_kind_check;
alter table public.usage_events add constraint usage_events_provider_kind_check check (
  kind is null or kind = any (array[
    'link_token_create',
    'sandbox_public_token_create',
    'item_public_token_exchange',
    'accounts_get',
    'item_remove',
    'webhook_key_get',
    'transactions_sync',
    'cron_enqueue_syncs',
    'quarantine_capped',
    'budget_refused',
    'recurring_detection',
    'investments_holdings_get',
    'investments_transactions_get',
    'transactions_recurring_get'
  ])
);

-- The proc carries its OWN pinned kind list (belt-and-braces with the CHECK
-- above), so both have to admit the new kind or the insert still raises P0009.
-- Body reproduced verbatim from live `pg_get_functiondef` with exactly one
-- line added.
create or replace function public.keel_meter_provider_call(
  p_provider text, p_kind text, p_household_id uuid, p_latency_ms integer,
  p_ok boolean, p_error_code text, p_request_id text, p_item_ref uuid,
  p_quantity integer
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
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
    'transactions_recurring_get',
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
$function$;
