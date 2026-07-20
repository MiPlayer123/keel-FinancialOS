-- AI agent SLICE 2 — notes reversibility (Law 2: every AI write is undoable).
-- The agent applies notes as Class A auto+undo. keel_note_save (create/edit)
-- and keel_note_archive already exist and audit; the only missing reversal is
-- UN-archiving, so an agent-archived note can be restored. Mirrors the style of
-- keel_note_archive in 20260718000000_notes_tasks.sql (membership re-check +
-- audit_log). Idempotent create-or-replace; grants match the sibling procs.

create or replace function public.keel_note_unarchive(p_household_id uuid, p_note_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_before jsonb; v_after jsonb;
begin
  if auth.uid() is null then raise exception 'KEEL_NOT_AUTHENTICATED' using errcode = 'P0004'; end if;
  if not exists (select 1 from public.household_memberships where household_id = p_household_id and user_id = auth.uid()) then
    raise exception 'KEEL_NOT_FOUND' using errcode = 'P0006';
  end if;
  -- Must currently be archived to restore it (idempotency: an already-active
  -- note is not found here, so a double-undo is a no-op error, not a silent
  -- state flip).
  select to_jsonb(n) into v_before from public.household_notes n
    where n.id = p_note_id and n.household_id = p_household_id and n.archived_at is not null;
  if v_before is null then raise exception 'KEEL_NOT_FOUND' using errcode = 'P0006'; end if;
  update public.household_notes set archived_at = null, updated_at = now()
    where id = p_note_id and household_id = p_household_id;
  select to_jsonb(n) into v_after from public.household_notes n where n.id = p_note_id;
  insert into public.audit_log (household_id, actor, action, object_type, object_id, before, after)
  values (p_household_id, jsonb_build_object('kind','user','userId',auth.uid()), 'notes.unarchive', 'note', p_note_id, v_before, v_after);
end;
$$;

revoke all on function public.keel_note_unarchive(uuid, uuid) from public, anon;
grant execute on function public.keel_note_unarchive(uuid, uuid) to authenticated;
