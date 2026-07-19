-- fix(recurring): keel_recurring_reap_stale_suggestions is owned by keel_api and
-- reads/records recurring_detector_runs, but keel_api had no grant on that table
-- (only keel_worker did). So the worker's post-upsert reap raised 'permission
-- denied for table recurring_detector_runs', failing the whole detection run and
-- leaving stale P2P/paycheck suggestions un-reaped. Grant keel_api the same
-- SELECT+INSERT keel_worker holds. Already applied to live.
grant select, insert on public.recurring_detector_runs to keel_api;
