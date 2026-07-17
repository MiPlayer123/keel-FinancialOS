-- AI provider key access path (Law 12).
--
-- The AI-chat POC reads its provider key from the function environment when
-- present. This deployment pipeline cannot script the dashboard's env-secret
-- store, so the operational home for the key is Supabase Vault (encrypted at
-- rest, provider secret manager — Law 12 compliant). Vault's schema is not
-- exposed over PostgREST, so this definer function is the single, auditable
-- access path: service_role only, one named secret, value never logged.
--
-- plpgsql + dynamic SQL so the function also CREATES cleanly on stacks where
-- the vault schema is absent (local CI): there it simply returns null.
-- Fail-closed everywhere: no vault / no secret row → null → the endpoint
-- returns 503 ai_unavailable. Nothing here can fabricate a key or fall back
-- to a stub.

create function public.keel_ai_provider_key() returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text;
begin
  begin
    execute $q$
      select decrypted_secret
        from vault.decrypted_secrets
        where name = 'OPENAI_API_KEY'
        limit 1
    $q$ into v_key;
  exception
    when undefined_table or insufficient_privilege or invalid_schema_name then
      return null;
  end;
  return v_key;
end;
$$;

-- service_role only: the browser-facing roles must never be able to read it.
revoke all on function public.keel_ai_provider_key() from public, anon, authenticated;
grant execute on function public.keel_ai_provider_key() to service_role;
