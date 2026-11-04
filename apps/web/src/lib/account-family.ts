/**
 * Account continuity (migration 20261104210000): an account REPLACED BY
 * another — a reissued card's old number, a relinked bank account — reads as
 * part of its successor. The ledger keeps them apart (postings never move);
 * these helpers let a screen treat the pair as one account. Pure.
 */

export type FamilyAccount = {
  id: string;
  replacedByAccountId?: string | null;
};

/** The account whose history `id` shows under: follows the replaced-by chain to its end (cycle-safe). */
export function successorOf(id: string, accounts: readonly FamilyAccount[]): string {
  const next = new Map(accounts.map((a) => [a.id, a.replacedByAccountId ?? null]));
  const seen = new Set<string>([id]);
  let current = id;
  for (;;) {
    const n = next.get(current);
    if (!n || seen.has(n)) return current;
    seen.add(n);
    current = n;
  }
}

/** `ids` plus every account that (transitively) was replaced by one of them. */
export function withPredecessors(ids: Iterable<string>, accounts: readonly FamilyAccount[]): Set<string> {
  const out = new Set(ids);
  for (const a of accounts) {
    if (a.replacedByAccountId && out.has(successorOf(a.id, accounts))) out.add(a.id);
  }
  return out;
}

/** True when the account was replaced by another account present in the list (pickers hide it). */
export function isReplaced(account: FamilyAccount, accounts: readonly FamilyAccount[]): boolean {
  return successorOf(account.id, accounts) !== account.id;
}
