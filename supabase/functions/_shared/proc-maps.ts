/**
 * Action -> SECURITY DEFINER proc maps shared by every user-facing surface.
 *
 * The `api` function dispatches /queries and the bespoke /notes/* + /tasks/*
 * routes through these, and the in-app agent hands the SAME maps to its tool
 * executor (_shared/agent.ts). The `mcp` tools name procs directly but call
 * the same procs (and commands go through _shared/command-exec.ts).
 */
export const QUERY_TO_PROC: Record<string, string> = {
  'ledger.trial_balance': 'keel_trial_balance',
  'transactions.list': 'keel_list_transactions',
  'transactions.rich': 'keel_list_transactions_rich',
  // WS-H (F-005): bounded, keyset-paginated + server-filtered variant of the
  // rich read. Same per-row DTO as transactions.rich; carries a nextCursor.
  'transactions.rich_page': 'keel_list_transactions_rich_page',
  // WS-H (F-021): slim server-side transaction search for the command palette.
  'transactions.search': 'keel_search_transactions',
  'categories.list': 'keel_list_categories',
  'balances.latest': 'keel_latest_balances',
  'recurring.list': 'keel_list_recurring',
  'recurring.classification': 'keel_recurring_classification',
  'recurring.schedule_links': 'keel_list_recurring_schedule_links',
  'paychecks.list': 'keel_list_paychecks',
  'paychecks.detected_dismissals': 'keel_list_detected_paycheck_dismissals',
  'paychecks.templates': 'keel_list_paycheck_templates',
  'paychecks.split_suggestions': 'keel_list_paycheck_split_suggestions',
  'reimbursements.list': 'keel_list_reimbursements',
  'expected_reimbursements.list': 'keel_list_expected_reimbursements',
  'statements.list': 'keel_list_statements',
  'statements.drafts': 'keel_list_statement_drafts',
  'statements.cadence': 'keel_statement_cadence',
  'statements.find_payment': 'keel_statement_suggest_payments',
  'statements.payment_links': 'keel_list_statement_payment_links',
  'statements.holdings_diff': 'keel_statement_holdings_diff',
  'dashboard.cash_flow': 'keel_cash_flow',
  'dashboard.net_worth': 'keel_net_worth_as_of',
  'dashboard.net_worth_daily': 'keel_net_worth_daily',
  'dashboard.cash_flow_monthly': 'keel_cash_flow_monthly',
  'accounts.balance_daily': 'keel_account_balance_daily',
  'transfers.list': 'keel_list_transfers',
  'categorization.suggestions': 'keel_list_category_suggestions',
  'notes_tasks.list': 'keel_list_notes_tasks',
  'rules.list': 'keel_list_rules',
  'budgets.list': 'keel_list_budgets',
  'budgets.month': 'keel_budget_month',
  'tags.list': 'keel_list_tags',
  'schedules.list': 'keel_list_schedules',
  'goals.list': 'keel_list_goals',
  'entities.list': 'keel_list_entities',
  'dashboard.cash_flow_forecast': 'keel_cash_flow_forecast',
  'holdings.list': 'keel_list_holdings',
  'investments.overview': 'keel_investments_overview',
  'investments.value_daily': 'keel_investments_value_daily',
  'connections.list_reconnect_matches': 'keel_list_reconnect_matches',
  'connections.list_archived_duplicate_matches': 'keel_list_archived_duplicate_matches',
  'receipts.inbox': 'keel_receipts_inbox',
};

/**
 * Proc names for the AGENT_WRITE_ACTIONS (notes/tasks) — these aren't
 * CommandName so they don't go through COMMAND_TO_PROC/the /commands
 * envelope; the bespoke /notes/* + /tasks/* routes in api/index.ts AND the agent tool
 * executor (agent.ts) both dispatch through this same map, so the proc name
 * is named once, not hand-copied into each caller.
 */
export const AGENT_WRITE_TO_PROC: Record<string, string> = {
  'notes.save': 'keel_note_save',
  'notes.archive': 'keel_note_archive',
  'notes.unarchive': 'keel_note_unarchive',
  'tasks.save': 'keel_task_save',
  'tasks.set_status': 'keel_task_set_status',
};
