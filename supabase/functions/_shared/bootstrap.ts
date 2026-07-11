/**
 * Named-secret configuration for local development.
 *
 * `supabase functions serve --env-file` refuses SUPABASE_-prefixed vars, and
 * the edge runtime pre-sets SUPABASE_SECRET_KEYS={"default": <platform key>}
 * with a READ-ONLY env (Deno.env.set throws NotSupported). So the provisioner
 * writes KEEL_SUPABASE_SECRET_KEYS and this helper merges both maps into a
 * `withSupabase({ env })` override — the documented escape hatch. Hosted
 * deployments set the real named key via Supabase Secrets; the merge then
 * simply passes the platform map through.
 */
export const keelSecretKeys = (): { secretKeys: Record<string, string> } => {
  const platform = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}') as Record<
    string,
    string
  >;
  const local = JSON.parse(Deno.env.get('KEEL_SUPABASE_SECRET_KEYS') ?? '{}') as Record<
    string,
    string
  >;
  return { secretKeys: { ...platform, ...local } };
};
