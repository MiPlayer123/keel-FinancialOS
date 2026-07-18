// C6 operational metering/breaker adapters. Keep this module's public inputs
// intentionally narrow: no provider credential, request body, or JWK can cross
// the SQL metering boundary (Law 12).

// deno-lint-ignore no-explicit-any
export type MeterAdminClient = { rpc: (name: string, args: Record<string, unknown>) => any };

export type ProviderCallKind =
  | 'link_token_create'
  | 'sandbox_public_token_create'
  | 'item_public_token_exchange'
  | 'accounts_get'
  | 'item_remove'
  | 'webhook_key_get'
  | 'transactions_sync'
  | 'investments_holdings_get'
  | 'investments_transactions_get'
  | 'cron_enqueue_syncs'
  | 'quarantine_capped'
  | 'budget_refused';

export const PLAID_DAILY_CALL_LIMIT = 10_000;

export interface MeterCallInput {
  provider: 'plaid';
  kind: ProviderCallKind;
  householdId?: string | null;
  start: number;
  ok: boolean;
  errorCode?: string | null;
  requestId?: string | null;
  itemRef?: string | null;
  quantity?: number;
}

const METER_FIELDS = new Set([
  'provider',
  'kind',
  'householdId',
  'start',
  'ok',
  'errorCode',
  'requestId',
  'itemRef',
  'quantity',
]);

const rpcData = async <T>(
  admin: MeterAdminClient,
  name: string,
  args: Record<string, unknown>,
): Promise<T> => {
  const { data, error } = await admin.rpc(name, args);
  if (error) throw new Error(`${name} failed: ${error.message ?? 'unknown RPC error'}`);
  return data as T;
};

export const meterCall = async (
  admin: MeterAdminClient,
  input: MeterCallInput,
): Promise<void> => {
  for (const key of Object.keys(input)) {
    if (!METER_FIELDS.has(key)) throw new Error(`unexpected metering field: ${key}`);
  }
  try {
    await rpcData<null>(admin, 'keel_meter_provider_call', {
      p_provider: input.provider,
      p_kind: input.kind,
      p_household_id: input.householdId ?? null,
      p_latency_ms: Math.max(0, Math.round(Date.now() - input.start)),
      p_ok: input.ok,
      p_error_code: input.errorCode ?? null,
      p_request_id: input.requestId ?? null,
      p_item_ref: input.itemRef ?? null,
      p_quantity: input.quantity ?? 1,
    });
  } catch {
    // Telemetry is best-effort. Keep the warning constant so a failed meter
    // can never reflect provider data or credentials across Law 12.
    console.warn('KEEL_PROVIDER_METER_UNAVAILABLE');
  }
};

export const reserveProviderCall = (
  admin: MeterAdminClient,
  provider: 'plaid',
  dailyLimit: number,
): Promise<boolean> =>
  rpcData<boolean>(admin, 'keel_provider_budget_reserve', {
    p_provider: provider,
    p_daily_limit: dailyLimit,
  });

export const refundProviderCall = async (
  admin: MeterAdminClient,
  provider: 'plaid',
): Promise<void> => {
  await rpcData<null>(admin, 'keel_provider_budget_refund', { p_provider: provider });
};

export const claimActiveSyncs = (
  admin: MeterAdminClient,
  minimumIntervalSeconds = 900,
): Promise<number> =>
  rpcData<number>(admin, 'keel_cron_enqueue_active_syncs', {
    p_min_interval_seconds: minimumIntervalSeconds,
  });
