-- Fix: Slice B (20260721180000) enabled RLS on paycheck_templates and granted
-- keel_api on paycheck_template_lines + paycheck_series_settings, but MISSED the
-- parent paycheck_templates table — it got no keel_api table grant and no
-- api_all RLS policy (only the keel_export + authenticated member_read policies).
--
-- Consequence: keel_cmd_paycheck_save_template is SECURITY DEFINER owned by
-- keel_api; when it ran `select coalesce(max(template_version),0)+1 from
-- paycheck_templates` and then `insert into paycheck_templates`, it failed with
-- "permission denied for table paycheck_templates". The command has therefore
-- never successfully created a template on live. The child paycheck_template_lines
-- (INSERT,SELECT + paycheck_template_lines_api_all) and paycheck_series_settings
-- (INSERT,SELECT,UPDATE) were wired correctly — only the parent was skipped.
--
-- Fix: mirror the paycheck_template_lines pattern exactly (grant SELECT,INSERT +
-- a for-all api_all policy scoped to keel_api). Idempotent: grant is a no-op if
-- already present; policy create is guarded by pg_policies.
grant select, insert on public.paycheck_templates to keel_api;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='paycheck_templates' and policyname='paycheck_templates_api_all') then
    create policy paycheck_templates_api_all on public.paycheck_templates
      for all to keel_api using (true) with check (true);
  end if;
end$$;
