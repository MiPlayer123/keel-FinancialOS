grant insert on public.audit_log to keel_api;

drop policy if exists audit_log_api_insert on public.audit_log;
create policy audit_log_api_insert on public.audit_log
for insert to keel_api
with check (true);
