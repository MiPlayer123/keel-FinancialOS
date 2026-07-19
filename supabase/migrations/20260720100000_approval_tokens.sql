-- SLICE 0 (statement-ingestion-v2.md §SLICE 0) — Approval-token SQL primitive.
--
-- Law 11 (typed AI responses): "material AI outputs are records ... with
-- approval tokens binding exact payload, actor, scope, version, expiry."
-- packages/contracts/src/ai.ts already carries ApprovalTokenSchema as a Zod
-- TYPE, but there was NO SQL enforcement primitive (grep approval_token|redeem|
-- issue_token over supabase/migrations returned nothing). This migration is
-- that primitive: a one-use, tamper-evident, expiring token that a class-B+
-- command redeems before it mutates canonical truth.
--
-- Law 7 (one authorization compiler / scope-safe calculation): the token binds
-- payload_sha256 over the SERVER-normalized payload via keel_payload_hash — the
-- same hash function the command procs already use for idempotency — so the
-- exact bytes approved are the exact bytes executed. This file also extracts
-- keel_statement_create's validation+insert body into ONE shared
-- keel_statement_validate_and_materialize helper (BC-v2.1 §9.1 scope-safe
-- calculation) that both the manual create path and the future draft-approval
-- path call — no copied validation logic. keel_statement_create is refactored
-- to delegate to it; behavior stays byte-identical for the manual path.
--
-- Ownership/grant ritual mirrors 20260710210600 command_procs and
-- 20260712150000 reconciliation exactly: procs owned by keel_api (non-login,
-- non-super, non-BYPASSRLS), EXECUTE to keel_api + authenticated, RLS
-- member-read only, no direct client write. Export INCLUDE follows the receipts
-- chain idiom (20260718171000).

-- ---------------------------------------------------------------------------
-- Status enum + table
-- ---------------------------------------------------------------------------
create type public.approval_token_status as enum ('issued', 'redeemed', 'expired', 'revoked');

create table public.approval_tokens (
  token_id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id),
  actor_user_id uuid not null references auth.users(id),
  command text not null,
  payload_sha256 text not null check (payload_sha256 ~ '^[a-f0-9]{64}$'),
  normalized_payload jsonb not null,
  scope jsonb not null,
  account_id uuid,
  proposal_kind text not null,
  proposal_ref uuid,
  proposal_version int not null,
  policy_version text not null,
  status public.approval_token_status not null default 'issued',
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  redeemed_at timestamptz,
  redeemed_command_id uuid,
  created_at timestamptz not null default now(),
  unique (household_id, token_id),
  -- Composite tenant FK: an account_id, when present, must belong to this
  -- household (cross-tenant reference smuggling fails closed, same idiom as
  -- statements.fk_statement_account_tenant in 20260712150000).
  constraint fk_approval_token_account_tenant
    foreign key (household_id, account_id) references public.accounts (household_id, id)
);

-- Hot path: redeem does `select ... for update where token_id = $1`; the pk
-- already covers that. This index serves the sweeper/read model that lists a
-- household's live tokens.
create index approval_tokens_household_status_idx
  on public.approval_tokens (household_id, status);

-- ---------------------------------------------------------------------------
-- Immutable-except-status trigger. A token is a binding record: once issued,
-- only its status (and the redemption stamps that accompany a redemption) may
-- change, and only forward from 'issued'. Every other column is frozen. This
-- is the append-only discipline of Law 2 applied to the approval record.
-- ---------------------------------------------------------------------------
create function public.keel_approval_token_guard() returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'KEEL_IMMUTABLE: approval tokens are append-only'
      using errcode = 'P0001';
  end if;

  -- Only issued -> {redeemed, expired, revoked} transitions are legal.
  if old.status <> 'issued' then
    raise exception 'KEEL_IMMUTABLE: approval token % already terminal (%)', old.token_id, old.status
      using errcode = 'P0001';
  end if;
  if new.status = 'issued' or new.status not in ('redeemed', 'expired', 'revoked') then
    raise exception 'KEEL_IMMUTABLE: illegal approval token transition % -> %', old.status, new.status
      using errcode = 'P0001';
  end if;

  -- Every column except status + the redemption stamps must be untouched.
  if new.token_id is distinct from old.token_id
     or new.household_id is distinct from old.household_id
     or new.actor_user_id is distinct from old.actor_user_id
     or new.command is distinct from old.command
     or new.payload_sha256 is distinct from old.payload_sha256
     or new.normalized_payload is distinct from old.normalized_payload
     or new.scope is distinct from old.scope
     or new.account_id is distinct from old.account_id
     or new.proposal_kind is distinct from old.proposal_kind
     or new.proposal_ref is distinct from old.proposal_ref
     or new.proposal_version is distinct from old.proposal_version
     or new.policy_version is distinct from old.policy_version
     or new.issued_at is distinct from old.issued_at
     or new.expires_at is distinct from old.expires_at
     or new.created_at is distinct from old.created_at then
    raise exception 'KEEL_IMMUTABLE: only approval token status may change'
      using errcode = 'P0001';
  end if;

  -- redeemed_at / redeemed_command_id may only be set on a redemption, never
  -- cleared or set on expire/revoke.
  if new.status = 'redeemed' then
    if new.redeemed_at is null or new.redeemed_command_id is null then
      raise exception 'KEEL_IMMUTABLE: redemption must stamp redeemed_at and redeemed_command_id'
        using errcode = 'P0001';
    end if;
  else
    if new.redeemed_at is distinct from old.redeemed_at
       or new.redeemed_command_id is distinct from old.redeemed_command_id then
      raise exception 'KEEL_IMMUTABLE: only a redemption may stamp redemption columns'
        using errcode = 'P0001';
    end if;
  end if;

  return new;
end;
$$;

create trigger approval_tokens_status_only
  before update or delete on public.approval_tokens
  for each row execute function public.keel_approval_token_guard();

-- ---------------------------------------------------------------------------
-- keel_approval_token_issue — mint a token bound to the server-normalized
-- payload. Actor is derived from the verified JWT, never trusted from the
-- caller (forgery guard, same finding that hardened keel_actor_from_jwt).
-- ---------------------------------------------------------------------------
create function public.keel_approval_token_issue(
  p_household_id uuid,
  p_actor jsonb,               -- accepted for call-shape parity; IGNORED (see below)
  p_command text,
  p_normalized_payload jsonb,
  p_scope jsonb,
  p_account_id uuid,
  p_proposal_kind text,
  p_proposal_ref uuid,
  p_proposal_version int,
  p_policy_version text,
  p_ttl_seconds int
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid;
  v_hash text := public.keel_payload_hash(p_normalized_payload);
  v_token_id uuid := gen_random_uuid();
  v_expires timestamptz;
begin
  -- Membership + write-role check (owner/partner). Read-only members cannot
  -- mint an approval to mutate truth.
  perform public.keel_assert_member_write(p_household_id);

  -- TRUSTED actor from the JWT; ignore p_actor entirely (forgery guard).
  v_uid := (public.keel_actor_from_jwt() ->> 'userId')::uuid;

  if p_command is null or length(p_command) = 0 then
    raise exception 'KEEL_INVALID_COMMAND: command required' using errcode = 'P0009';
  end if;
  if jsonb_typeof(p_normalized_payload) is null then
    raise exception 'KEEL_INVALID_COMMAND: normalized_payload required' using errcode = 'P0009';
  end if;
  if p_proposal_version is null or p_proposal_kind is null or length(p_proposal_kind) = 0
     or p_policy_version is null or length(p_policy_version) = 0 then
    raise exception 'KEEL_INVALID_COMMAND: proposal_kind/version + policy_version required'
      using errcode = 'P0009';
  end if;
  if p_ttl_seconds is null or p_ttl_seconds <= 0 or p_ttl_seconds > 86400 then
    raise exception 'KEEL_INVALID_COMMAND: ttl_seconds must be in (0, 86400]'
      using errcode = 'P0009';
  end if;

  -- When the proposal is scoped to an account, the actor must have write
  -- access to that specific account (account-scoped gate, not household-only —
  -- statement-ingestion-v2 [A10]). The composite tenant FK already refuses a
  -- cross-tenant account_id; this refuses an in-tenant account the actor may
  -- not write.
  if p_account_id is not null
     and not public.keel_recurring_account_access(p_household_id, p_account_id, true) then
    raise exception 'KEEL_SCOPE_VIOLATION: no write access to account %', p_account_id
      using errcode = 'P0006';
  end if;

  v_expires := now() + make_interval(secs => p_ttl_seconds);

  insert into public.approval_tokens (
    token_id, household_id, actor_user_id, command, payload_sha256,
    normalized_payload, scope, account_id, proposal_kind, proposal_ref,
    proposal_version, policy_version, status, issued_at, expires_at
  ) values (
    v_token_id, p_household_id, v_uid, p_command, v_hash,
    p_normalized_payload, p_scope, p_account_id, p_proposal_kind, p_proposal_ref,
    p_proposal_version, p_policy_version, 'issued', now(), v_expires
  );

  return jsonb_build_object(
    'tokenId', v_token_id,
    'payloadSha256', v_hash,
    'actorUserId', v_uid::text,
    'expiresAt', to_char(v_expires at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- keel_approval_token_redeem — one-use, tamper-evident, expiry-enforcing.
-- The caller passes the SERVER-normalized payload (never the client raw body);
-- the redeemer re-hashes it and compares to the bound hash. A redeem is only
-- ever called from inside the command transaction that is about to mutate, so
-- the flip to 'redeemed' and the mutation share fate.
-- ---------------------------------------------------------------------------
create function public.keel_approval_token_redeem(
  p_household_id uuid,
  p_token_id uuid,
  p_command_id uuid,
  p_actor jsonb,               -- accepted for call-shape parity; IGNORED
  p_command text,
  p_normalized_payload jsonb,
  p_proposal_version int
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid;
  v_t public.approval_tokens%rowtype;
  v_hash text;
begin
  perform public.keel_assert_member_write(p_household_id);
  v_uid := (public.keel_actor_from_jwt() ->> 'userId')::uuid;

  -- Row lock the token so two concurrent redeems of the same token serialize;
  -- the second sees status='redeemed' and hits the replay branch below.
  select * into v_t
    from public.approval_tokens
   where household_id = p_household_id and token_id = p_token_id
   for update;
  if not found then
    raise exception 'KEEL_SCOPE_VIOLATION: approval token not found' using errcode = 'P0006';
  end if;

  -- Replay: already terminal. A second redemption of a redeemed token is the
  -- canonical one-use violation (P0007, the idempotency-conflict class).
  if v_t.status <> 'issued' then
    if v_t.status = 'redeemed' then
      raise exception 'KEEL_IDEMPOTENCY_CONFLICT: approval token % already redeemed', p_token_id
        using errcode = 'P0007';
    end if;
    raise exception 'KEEL_INVALID_COMMAND: approval token % is % and cannot be redeemed', p_token_id, v_t.status
      using errcode = 'P0009';
  end if;

  -- Expiry: reject. clock_timestamp() (real wall clock), not now() (transaction
  -- start): a token must not be redeemable past its expiry even inside a
  -- long-running transaction, and it keeps the check testable within one
  -- transaction. NOTE the flip to 'expired' is NOT done here: redeem is called
  -- inside the command transaction that is about to mutate, so a RAISE here
  -- rolls that whole transaction back — any status write we did would roll back
  -- with it. Durably marking expired tokens is the sweeper's job
  -- (keel_approval_token_expire_sweep, below), which runs in its own
  -- transaction and commits. Redeem's contract is: an expired token can never
  -- be redeemed; the terminal 'expired' state is eventually-consistent.
  if clock_timestamp() > v_t.expires_at then
    raise exception 'KEEL_APPROVAL_EXPIRED: approval token % expired at %', p_token_id, v_t.expires_at
      using errcode = 'P0009';
  end if;

  -- Wrong actor: the redeemer must be the same user the token was issued to.
  if v_t.actor_user_id <> v_uid then
    raise exception 'KEEL_INVALID_COMMAND: approval token actor mismatch' using errcode = 'P0009';
  end if;

  -- Wrong command: the token is bound to a specific command.
  if v_t.command <> p_command then
    raise exception 'KEEL_INVALID_COMMAND: approval token command mismatch' using errcode = 'P0009';
  end if;

  -- Tamper: re-hash the SERVER-normalized payload and compare to the bound
  -- hash. Any mutation of the approved payload changes the hash and is refused.
  v_hash := public.keel_payload_hash(p_normalized_payload);
  if v_hash <> v_t.payload_sha256 then
    raise exception 'KEEL_INVALID_COMMAND: approval token payload hash mismatch (tamper)'
      using errcode = 'P0009';
  end if;

  -- Wrong proposal version: the approval was for a specific revision.
  if v_t.proposal_version <> p_proposal_version then
    raise exception 'KEEL_INVALID_COMMAND: approval token proposal version mismatch'
      using errcode = 'P0009';
  end if;

  update public.approval_tokens
     set status = 'redeemed', redeemed_at = now(), redeemed_command_id = p_command_id
   where household_id = p_household_id and token_id = p_token_id;

  return jsonb_build_object(
    'tokenId', v_t.token_id,
    'status', 'redeemed',
    'payloadSha256', v_t.payload_sha256,
    'accountId', v_t.account_id,
    'proposalKind', v_t.proposal_kind,
    'proposalVersion', v_t.proposal_version,
    'redeemedCommandId', p_command_id,
    'redeemedAt', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- keel_approval_token_expire_sweep — durably flip past-expiry 'issued' tokens
-- to 'expired' in their own transaction. Intended to be driven by pg_cron (like
-- the other sweepers in this codebase); safe to call anytime and idempotent
-- (only issued+past-expiry rows move, only forward through the guard). Returns
-- the count flipped. This is the mechanism that makes the terminal 'expired'
-- state durable — redeem itself cannot, because it raises and rolls back.
-- ---------------------------------------------------------------------------
create function public.keel_approval_token_expire_sweep() returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  update public.approval_tokens
     set status = 'expired'
   where status = 'issued'
     and clock_timestamp() > expires_at;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- ONE shared statement validate+materialize (Law 7 / BC-v2.1 §9.1 scope-safe
-- calculation). The current keel_statement_create validation+insert body is
-- extracted VERBATIM into an internal SECURITY DEFINER helper so both the
-- manual create path AND the future draft-approval path call the same routine —
-- no copied validation. This slice does NOT change validation semantics
-- (anchor/coalesce belong to a later slice): the extracted body is character-
-- for-character the shipped keel_statement_create body, so the manual path
-- stays byte-identical. Returns the created statement id.
-- ---------------------------------------------------------------------------
create function public.keel_statement_validate_and_materialize(
  p_household_id uuid,
  p_payload jsonb,
  p_actor jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$declare v_statement uuid:=gen_random_uuid();v_line jsonb;v_account uuid;v_start date;v_period_end date;v_open bigint;v_end bigint;v_sum numeric;begin
if jsonb_typeof(p_payload)<>'object'or(p_payload-'account_id'-'period_start'-'period_end'-'opening_minor'-'ending_minor'-'currency'-'source_hash'-'lines')<>'{}'::jsonb or jsonb_typeof(p_payload->'lines')<>'array'or jsonb_array_length(p_payload->'lines')<1 or jsonb_array_length(p_payload->'lines')>5000 or coalesce(p_payload->>'opening_minor','')!~'^-?(0|[1-9][0-9]*)$'or p_payload->>'opening_minor'='-0'or coalesce(p_payload->>'ending_minor','')!~'^-?(0|[1-9][0-9]*)$'or p_payload->>'ending_minor'='-0'or coalesce(p_payload->>'currency','')!~'^[A-Z]{3}$'or coalesce(p_payload->>'source_hash','')!~'^[a-f0-9]{64}$'then raise exception'KEEL_INVALID_COMMAND: malformed statement'using errcode='P0009';end if;
begin v_account:=(p_payload->>'account_id')::uuid;v_start:=(p_payload->>'period_start')::date;v_period_end:=(p_payload->>'period_end')::date;v_open:=(p_payload->>'opening_minor')::bigint;v_end:=(p_payload->>'ending_minor')::bigint;if v_start>v_period_end then raise exception'bad';end if;exception when others then raise exception'KEEL_INVALID_COMMAND: invalid statement scalars'using errcode='P0009';end;
if not exists(select 1 from public.accounts a where a.household_id=p_household_id and a.id=v_account and a.currency=p_payload->>'currency')or not public.keel_recurring_account_access(p_household_id,v_account,true)then raise exception'KEEL_SCOPE_VIOLATION: account not found'using errcode='P0006';end if;
if(select count(*)<>count(distinct l->>'line_key')from jsonb_array_elements(p_payload->'lines')l)or exists(select 1 from jsonb_array_elements(p_payload->'lines')l where(l-'line_key'-'date'-'amount_minor'-'description')<>'{}'::jsonb or length(coalesce(l->>'line_key',''))not between 1 and 100 or coalesce(l->>'amount_minor','')!~'^-?(0|[1-9][0-9]*)$'or l->>'amount_minor'='-0'or length(coalesce(l->>'description',''))not between 1 and 500)then raise exception'KEEL_INVALID_COMMAND: invalid statement lines'using errcode='P0009';end if;
begin for v_line in select value from jsonb_array_elements(p_payload->'lines')loop if(v_line->>'date')::date not between v_start and v_period_end then raise exception'bad';end if;perform(v_line->>'amount_minor')::bigint;end loop;select sum((l->>'amount_minor')::bigint)::numeric into v_sum from jsonb_array_elements(p_payload->'lines')l;exception when others then raise exception'KEEL_INVALID_COMMAND: invalid statement line values'using errcode='P0009';end;
if v_open::numeric+v_sum<>v_end::numeric then raise exception'KEEL_INVALID_COMMAND: statement lines do not reconcile'using errcode='P0009';end if;
insert into public.statements(household_id,id,account_id,period_start,period_end,opening_minor,ending_minor,currency,source_hash,created_by)values(p_household_id,v_statement,v_account,v_start,v_period_end,v_open,v_end,p_payload->>'currency',p_payload->>'source_hash',(p_actor->>'userId')::uuid);
for v_line in select value from jsonb_array_elements(p_payload->'lines')loop insert into public.statement_lines(household_id,statement_id,line_key,line_date,amount_minor,description)values(p_household_id,v_statement,v_line->>'line_key',(v_line->>'date')::date,(v_line->>'amount_minor')::bigint,v_line->>'description');end loop;
return v_statement;end;$$;

-- Refactor keel_statement_create to delegate validation+insert to the shared
-- helper. Everything OUTSIDE the extracted body (auth, idempotency, the exact
-- v_after/v_result shape, finish_command call, and the unique_violation ->
-- P0007 mapping) is preserved verbatim; only the inlined body is replaced by a
-- call to keel_statement_validate_and_materialize. The manual path stays
-- byte-identical (regression: pgTAP 012 + the byte-identical assertion in this
-- slice's suite).
create or replace function public.keel_statement_create(p_command_id uuid,p_economic_event_key text,p_actor jsonb,p_household_id uuid,p_payload jsonb)returns jsonb language plpgsql security definer set search_path=public as $$declare v_hash text:=public.keel_payload_hash(p_payload);v_replay jsonb;v_actor jsonb;v_statement uuid;v_open bigint;v_end bigint;v_after jsonb;v_result jsonb;begin perform public.keel_assert_member_write(p_household_id);v_actor:=public.keel_actor_from_jwt();v_replay:=public.keel_idempotency_check(p_household_id,p_economic_event_key,v_hash);if v_replay is not null then return v_replay;end if;
v_statement:=public.keel_statement_validate_and_materialize(p_household_id,p_payload,v_actor);
v_open:=(p_payload->>'opening_minor')::bigint;v_end:=(p_payload->>'ending_minor')::bigint;
v_after:=jsonb_build_object('statementId',v_statement,'status','open','openingMinor',v_open::text,'endingMinor',v_end::text);v_result:=jsonb_build_object('commandId',p_command_id,'economicEventKey',p_economic_event_key,'idempotentReplay',false,'effects',v_after,'asOf',to_char(now()at time zone'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"'));perform public.keel_finish_command(p_command_id,'statements.create',p_economic_event_key,p_household_id,v_actor,v_hash,'statements.created','statement',v_statement,v_after,v_result);return v_result;exception when unique_violation then raise exception'KEEL_IDEMPOTENCY_CONFLICT: duplicate statement source'using errcode='P0007';end;$$;

-- ---------------------------------------------------------------------------
-- RLS: member-read only; no direct client write (writes flow only through the
-- SECURITY DEFINER issue/redeem procs, owned by keel_api).
-- ---------------------------------------------------------------------------
alter table public.approval_tokens enable row level security;
revoke all on public.approval_tokens from public, anon, authenticated;
grant select on public.approval_tokens to authenticated, service_role;

create policy approval_tokens_read on public.approval_tokens
  for select to authenticated
  using (exists (
    select 1 from public.household_memberships m
     where m.household_id = approval_tokens.household_id
       and m.user_id = coalesce(
         nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
         nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
       )::uuid
  ));

-- keel_api owns the procs and needs table DML through them (definer runs WITH
-- keel_api's grants + RLS). Grant the DML and an all-access API policy, exactly
-- as statements/reconciliation do for their tables.
grant select, insert, update on public.approval_tokens to keel_api;
create policy approval_tokens_api on public.approval_tokens
  for all to keel_api using (true) with check (true);

-- ---------------------------------------------------------------------------
-- Ownership + grants ritual (verbatim idiom from 20260710210600 /
-- 20260712150000): procs owned by keel_api so definer privileges are exactly
-- keel_api's grants — no table ownership, no BYPASSRLS.
-- ---------------------------------------------------------------------------
grant create on schema public to keel_api;
alter function public.keel_approval_token_issue(uuid,jsonb,text,jsonb,jsonb,uuid,text,uuid,int,text,int) owner to keel_api;
alter function public.keel_approval_token_redeem(uuid,uuid,uuid,jsonb,text,jsonb,int) owner to keel_api;
alter function public.keel_approval_token_expire_sweep() owner to keel_api;
alter function public.keel_statement_validate_and_materialize(uuid,jsonb,jsonb) owner to keel_api;
alter function public.keel_statement_create(uuid,text,jsonb,uuid,jsonb) owner to keel_api;
revoke create on schema public from keel_api;

-- keel_approval_token_guard is a trigger fn on a keel_api-owned table; keep it
-- owned by the migration role (postgres), same as keel_forbid_mutation.

revoke all on function public.keel_approval_token_issue(uuid,jsonb,text,jsonb,jsonb,uuid,text,uuid,int,text,int) from public, anon;
revoke all on function public.keel_approval_token_redeem(uuid,uuid,uuid,jsonb,text,jsonb,int) from public, anon;
-- The shared materialize helper is internal: only the definer command procs
-- call it; clients never call it directly.
revoke all on function public.keel_statement_validate_and_materialize(uuid,jsonb,jsonb) from public, anon, authenticated;

grant execute on function public.keel_approval_token_issue(uuid,jsonb,text,jsonb,jsonb,uuid,text,uuid,int,text,int) to authenticated, keel_api;
grant execute on function public.keel_approval_token_redeem(uuid,uuid,uuid,jsonb,text,jsonb,int) to authenticated, keel_api;
-- The sweep is an internal maintenance job (pg_cron / service_role), never a
-- client-callable command.
revoke all on function public.keel_approval_token_expire_sweep() from public, anon, authenticated;
grant execute on function public.keel_approval_token_expire_sweep() to service_role, keel_api;

-- Ownership assertion (fail-closed): every approval-token / statement definer
-- proc introduced or refactored here must be owned by keel_api, and keel_api
-- must remain a non-login, non-super, non-BYPASSRLS role. Mirrors the
-- reconciliation migration's KEEL_OWNERSHIP guard.
do $$
begin
  if exists (
    select 1 from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     join pg_roles r on r.oid = p.proowner
     where n.nspname = 'public'
       and p.proname in (
         'keel_approval_token_issue',
         'keel_approval_token_redeem',
         'keel_approval_token_expire_sweep',
         'keel_statement_validate_and_materialize',
         'keel_statement_create'
       )
       and p.prosecdef
       and r.rolname <> 'keel_api'
  ) then
    raise exception 'KEEL_OWNERSHIP: approval-token proc not owned by keel_api';
  end if;
  if not exists (
    select 1 from pg_roles
     where rolname = 'keel_api' and rolcanlogin = false and rolsuper = false and rolbypassrls = false
  ) then
    raise exception 'KEEL_OWNERSHIP: invalid keel_api role';
  end if;
end$$;

-- ---------------------------------------------------------------------------
-- Export (Law 6). approval_tokens is portable household data: it is the
-- provenance record of what was approved, by whom, over what payload, when. It
-- carries NO secrets — statements never embed any (the normalized_payload for a
-- statement approval is account_id/period/opening/ending/currency/source_hash/
-- lines, all already-exported ledger facts). normalized_payload is therefore
-- INCLUDED verbatim; the json-secret scan in the export suite guards it. If a
-- future proposal_kind ever binds a secret-bearing payload, redact
-- normalized_payload for that kind BEFORE widening this — documented in
-- NOTES.md. Follows the receipts chain idiom (20260718171000): rename the
-- current outermost export to a pre-layer, then wrap it.
-- ---------------------------------------------------------------------------
grant select on public.approval_tokens to keel_export;
create policy approval_tokens_export on public.approval_tokens
  for select to keel_export using (true);

alter function public.keel_export_household(uuid, timestamptz)
  rename to keel_export_household_pre_approval_tokens;
revoke all on function public.keel_export_household_pre_approval_tokens(uuid, timestamptz)
  from public, anon, authenticated, service_role;

create function public.keel_export_household(
  p_household_id uuid,
  p_as_of timestamptz default null
) returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $$
declare
  v_base jsonb;
  v_tables jsonb;
begin
  v_base := public.keel_export_household_pre_approval_tokens(p_household_id, p_as_of);

  select jsonb_build_object(
    'approval_tokens', coalesce((
      select jsonb_agg(jsonb_build_object(
        'token_id', t.token_id,
        'household_id', t.household_id,
        'actor_user_id', t.actor_user_id,
        'command', t.command,
        'payload_sha256', t.payload_sha256,
        'normalized_payload', t.normalized_payload,
        'scope', t.scope,
        'account_id', t.account_id,
        'proposal_kind', t.proposal_kind,
        'proposal_ref', t.proposal_ref,
        'proposal_version', t.proposal_version,
        'policy_version', t.policy_version,
        'status', t.status::text,
        'issued_at', to_char(t.issued_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'expires_at', to_char(t.expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'redeemed_at', case when t.redeemed_at is null then null else to_char(t.redeemed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
        'redeemed_command_id', t.redeemed_command_id,
        'created_at', to_char(t.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      ) order by t.token_id)
      from public.approval_tokens t where t.household_id = p_household_id), '[]'::jsonb)
  ) into v_tables;

  return jsonb_set(v_base, '{tables}', (v_base->'tables') || v_tables);
end;
$$;

revoke all on function public.keel_export_household(uuid, timestamptz)
  from public, anon, authenticated, service_role;
grant create on schema public to keel_export;
alter function public.keel_export_household(uuid, timestamptz) owner to keel_export;
revoke create on schema public from keel_export;
grant execute on function public.keel_export_household(uuid, timestamptz) to service_role;
