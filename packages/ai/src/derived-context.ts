/**
 * Deterministic auto-derived household context for the agent prompt (slice 5).
 *
 * The server computes a handful of stable facts (accounts connected, entities,
 * whether budgets exist) and this pure function renders them into a short block
 * injected beneath the user's authored profile.
 *
 * Law 5: account names can originate from the provider (Plaid) and are
 * therefore DATA-TIER, not trusted labels. Every account/entity name is wrapped
 * in the per-request data boundary so the model treats it strictly as data,
 * never as an instruction — a hostile account name cannot become a prompt
 * directive. Subtypes/counts are enums/numbers and are safe as-is. Same facts +
 * boundary → identical output (unit-tested).
 */
import { wrapData } from './prompt.js';

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

/**
 * Render the derived-context block, or '' when there is nothing to say.
 * `dataBoundary` MUST be the same per-request boundary the system prompt
 * declares — account/entity names are wrapped in it so a hostile provider name
 * is inert data, never an instruction (Law 5).
 */
export const buildDerivedContext = (facts: DerivedContextFacts, dataBoundary: string): string => {
  const lines: string[] = [];
  const w = (s: string): string => wrapData(s, dataBoundary);

  if (facts.entities.length > 0) {
    const names = facts.entities.slice(0, MAX_ENTITIES).map((e) => w(e.name));
    const suffix = facts.entities.length > MAX_ENTITIES ? ', …' : '';
    lines.push(`Entities in this household: ${names.join(', ')}${suffix}.`);
  }

  if (facts.accounts.length > 0) {
    // Subtype is a safe enum; only the name is data-tier and gets wrapped.
    const shown = facts.accounts.slice(0, MAX_ACCOUNTS).map((a) => `${w(a.name)} (${a.subtype})`);
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
