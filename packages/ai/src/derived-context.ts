/**
 * Deterministic auto-derived household context for the agent prompt (slice 5).
 *
 * The server computes a handful of stable facts (accounts connected, entities,
 * whether budgets exist) and this pure function renders them into a short block
 * injected beneath the user's authored profile. It is NOT model-authored and
 * carries no ingested text — account/entity names here are user-tier labels the
 * user chose, not bank memos. Same facts → identical output (unit-tested).
 */

export interface DerivedAccount {
  readonly name: string;
  readonly subtype: string;
}

export interface DerivedEntity {
  readonly name: string;
}

export interface DerivedContextFacts {
  readonly accounts: readonly DerivedAccount[];
  readonly entities: readonly DerivedEntity[];
  /** YYYY-MM the budget check covers. */
  readonly budgetsMonth: string;
  /** Whether any budget target/total is set for that month. */
  readonly hasBudget: boolean;
}

const MAX_ACCOUNTS = 30;
const MAX_ENTITIES = 20;

/** Render the derived-context block, or '' when there is nothing to say. */
export const buildDerivedContext = (facts: DerivedContextFacts): string => {
  const lines: string[] = [];

  if (facts.entities.length > 0) {
    const names = facts.entities.slice(0, MAX_ENTITIES).map((e) => e.name);
    const suffix = facts.entities.length > MAX_ENTITIES ? ', …' : '';
    lines.push(`Entities in this household: ${names.join(', ')}${suffix}.`);
  }

  if (facts.accounts.length > 0) {
    const shown = facts.accounts.slice(0, MAX_ACCOUNTS).map((a) => `${a.name} (${a.subtype})`);
    const suffix = facts.accounts.length > MAX_ACCOUNTS ? `, and ${String(facts.accounts.length - MAX_ACCOUNTS)} more` : '';
    lines.push(`${String(facts.accounts.length)} connected account(s): ${shown.join(', ')}${suffix}.`);
  } else {
    lines.push('No accounts are connected yet.');
  }

  lines.push(
    facts.hasBudget
      ? `A budget is set up for ${facts.budgetsMonth}.`
      : `No budget is set up for ${facts.budgetsMonth} yet.`,
  );

  return lines.join('\n');
};
