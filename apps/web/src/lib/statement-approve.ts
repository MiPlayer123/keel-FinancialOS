// SLICE 7 (statement-ingestion-v2.md §10 UI slice 1) — the CLIENT half of the
// token-binding gate (Law 11), extracted as pure logic so it can be unit-tested
// without a DOM (repo convention: pure logic in src/lib, components covered by
// build + integration).
//
// THE GATE: the exact statement body the user approves must be the exact body
// that gets written. Server-side that is enforced by
// keel_cmd_statements_approve_draft rebuilding ONE v_payload and passing it to
// BOTH keel_approval_token_redeem AND keel_statement_validate_and_materialize.
// The client's obligation is the mirror image: issue a token for a body, then
// submit approve_draft with THE SAME body — never a re-derived or re-serialized
// one. buildStatementBody() constructs that body ONCE; runIssueThenApprove()
// hands the SAME object reference to issue and to approve. If they ever diverged,
// the server's hash(v_payload@issue) != hash(v_payload@redeem) and the approve
// would fail — but by construction here they cannot diverge.
//
// Currency comes from the ACCOUNT, never hardcoded USD [A6]. Zero lines are
// supported for anchor/valuation statements [A6].

import { parseSignedDollars } from '@/lib/hash';

/** One editable draft line in the review dialog. */
export type ApproveLineInput = { date: string; amount: string; description: string };

/** The reviewed, editable form the user confirms before approval. */
export type ApproveFormInput = {
  periodStart: string;
  periodEnd: string;
  /** Dollar strings as typed; parsed to minor units here (BigInt, no floats). */
  opening: string;
  ending: string;
  currency: string;
  lines: ApproveLineInput[];
  balanceCheck: 'strict' | 'anchor';
  /** Required when balanceCheck === 'anchor'. */
  anchorReason?: 'investment_valuation' | 'market_value' | 'no_transaction_detail';
  anchorGapExplanation?: string;
};

/** The exact statement body sent to BOTH issue and approve_draft. Snake-cased at
 *  the API boundary by the edge function; here it stays camelCase to match the
 *  ApproveStatementDraftPayloadSchema.statement contract. `sourceHash`/`accountId`
 *  are deliberately ABSENT — the server binds them (Law 5): the client must not
 *  carry them, or the two sides could diverge. */
export type StatementBody = {
  periodStart: string;
  periodEnd: string;
  openingMinor: string;
  endingMinor: string;
  currency: string;
  lines: { lineKey: string; date: string; amountMinor: string; description: string }[];
  anchorReason?: 'investment_valuation' | 'market_value' | 'no_transaction_detail';
  anchorGapExplanation?: string;
};

export type BuildBodyResult =
  | { ok: true; body: StatementBody }
  | { ok: false; error: string };

/**
 * Build the ONE statement body from the reviewed form. Deterministic,
 * side-effect free. All money is BigInt on minor-unit strings (Law 4).
 */
export function buildStatementBody(form: ApproveFormInput): BuildBodyResult {
  if (!form.periodStart || !form.periodEnd) {
    return { ok: false, error: 'Enter the statement period.' };
  }
  if (form.periodStart > form.periodEnd) {
    return { ok: false, error: 'Period start must be on or before period end.' };
  }
  if (!/^[A-Z]{3}$/u.test(form.currency)) {
    return { ok: false, error: 'The account has no valid currency.' };
  }
  const openingMinor = parseSignedDollars(form.opening);
  const endingMinor = parseSignedDollars(form.ending);
  if (openingMinor === null || endingMinor === null) {
    return { ok: false, error: 'Enter valid opening and ending balances.' };
  }

  const lines: StatementBody['lines'] = [];
  let sum = 0n;
  let i = 0;
  for (const l of form.lines) {
    i += 1;
    if (!l.date) return { ok: false, error: `Line ${String(i)} needs a date.` };
    const amountMinor = parseSignedDollars(l.amount);
    if (amountMinor === null) {
      return { ok: false, error: `Line ${String(i)} has an invalid amount.` };
    }
    if (l.date < form.periodStart || l.date > form.periodEnd) {
      return { ok: false, error: `Line ${String(i)} is outside the period.` };
    }
    sum += BigInt(amountMinor);
    lines.push({
      lineKey: `line-${String(i)}`,
      date: l.date,
      amountMinor,
      description: l.description.trim() || `Line ${String(i)}`,
    });
  }

  if (form.balanceCheck === 'strict') {
    // opening + Σ lines = ending, to the cent (mirrors the server's strict rule).
    if (BigInt(openingMinor) + sum !== BigInt(endingMinor)) {
      return {
        ok: false,
        error: 'Opening plus all lines must equal the ending balance exactly.',
      };
    }
  } else {
    // anchor: no balance equation; requires a typed reason + gap explanation.
    if (
      form.anchorReason === undefined ||
      !form.anchorGapExplanation ||
      form.anchorGapExplanation.trim().length === 0
    ) {
      return {
        ok: false,
        error: 'Anchor statements need a reason and a gap explanation.',
      };
    }
  }

  const body: StatementBody = {
    periodStart: form.periodStart,
    periodEnd: form.periodEnd,
    openingMinor,
    endingMinor,
    currency: form.currency,
    lines,
    // In anchor mode both fields are validated non-empty above, so the spread is
    // always well-typed (no undefined leaks under exactOptionalPropertyTypes).
    ...(form.balanceCheck === 'anchor' && form.anchorReason && form.anchorGapExplanation
      ? {
          anchorReason: form.anchorReason,
          anchorGapExplanation: form.anchorGapExplanation.trim(),
        }
      : {}),
  };
  return { ok: true, body };
}

/** Injected API surface — real in the app, mocked in tests. */
export type ApproveDeps = {
  issue: (input: {
    householdId: string;
    draftId: string;
    balanceCheck: 'strict' | 'anchor';
    statement: StatementBody;
  }) => Promise<{ tokenId: string; expiresAt: string }>;
  approve: (input: {
    householdId: string;
    userId: string;
    draftId: string;
    approvalTokenId: string;
    balanceCheck: 'strict' | 'anchor';
    statement: StatementBody;
  }) => Promise<unknown>;
};

/**
 * The gate, client half: issue a token bound to `body`, then approve with THE
 * SAME `body` object. The identical reference is passed to both calls — a test
 * asserts `issue.statement === approve.statement`.
 */
export async function runIssueThenApprove(args: {
  householdId: string;
  userId: string;
  draftId: string;
  balanceCheck: 'strict' | 'anchor';
  body: StatementBody;
  deps: ApproveDeps;
}): Promise<{ tokenId: string }> {
  const { householdId, userId, draftId, balanceCheck, body, deps } = args;
  // (a) FIRST issue the approval token bound to this EXACT body.
  const issued = await deps.issue({ householdId, draftId, balanceCheck, statement: body });
  // (b) THEN approve with the SAME body + the token. The server redeems the
  // token (proving hash(server-normalized body) == the issued hash) and
  // materializes the same normalized body in one transaction.
  await deps.approve({
    householdId,
    userId,
    draftId,
    approvalTokenId: issued.tokenId,
    balanceCheck,
    statement: body,
  });
  return { tokenId: issued.tokenId };
}
