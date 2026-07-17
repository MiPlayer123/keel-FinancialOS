/**
 * Account label with a masked last-4 suffix (teardown C6 residual, D-050):
 * "Chase Checking" -> "Chase Checking ••1234". Helps a household with two
 * accounts at the same institution disambiguate at a glance.
 *
 * Pure formatting only — no lookup, no network. Absence of a mask (manual
 * accounts, or provider accounts linked before the mask migration shipped)
 * falls back to the plain name: this is a hides-at-absence convention, same
 * as the Auto/Reconciled chips (Law 8) — never a guessed or fabricated
 * suffix (Law 9 reproducible numbers).
 */
export function maskAccountLabel(name: string, mask?: string | null): string {
  const trimmed = mask?.trim();
  if (!trimmed) return name;
  return `${name} ••${trimmed}`;
}
