'use client';

import { Check } from 'lucide-react';

import type { BusinessEntity } from '@/lib/business-tags';

/**
 * "Is this a business expense?" — the control behind
 * docs/BUSINESS-EXPENSE-RESEARCH.md §4.
 *
 * Presentational only: the caller owns the write (see txn-edit-dialog's
 * setBusiness), the same division of labour the tag chips beside it already
 * use. Shape adapts to the household, which is the whole point of binding the
 * attribution to an entity rather than to a boolean:
 *
 *   one business  -> a single checkbox-style toggle. One click, done.
 *   two or more   -> Personal plus one chip per business, picked exclusively,
 *                    because "business" is no longer an unambiguous answer.
 *   none          -> nothing renders. A household with no business entity has
 *                    nothing to attribute to, and every transaction is already
 *                    personal by default.
 *
 * Deliberately not a money control: attributing an expense to a business
 * classifies it, and does not assert that the business paid for it or owes the
 * payer anything (research doc §5).
 */
export function BusinessToggle({
  businesses,
  value,
  onChange,
  disabled = false,
  labelledBy,
}: {
  businesses: BusinessEntity[];
  /** Currently attributed entity id, or null for personal. */
  value: string | null;
  onChange: (entityId: string | null) => void;
  disabled?: boolean;
  /** id of the visible label, so the group is announced with its name. */
  labelledBy?: string | undefined;
}) {
  // A row can be attributed to a business the list does not contain — an
  // archived one, or a stale entity fetch. Rendering that as "no chip selected"
  // would be a lie the user can act on: in the single-business shape the one
  // chip reads OFF, so a single click silently RE-attributes the row from the
  // invisible business to the visible one. Surface it instead.
  const known = businesses.some((b) => b.entityId === value);
  const options: BusinessEntity[] =
    value !== null && !known
      ? [...businesses, { entityId: value, name: 'Other business', tagId: null }]
      : businesses;

  if (options.length === 0) return null;

  const base =
    'rounded-full border px-2.5 py-0.5 text-xs transition-colors disabled:opacity-50' +
    ' focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50' +
    ' focus-visible:outline-none';
  const on = 'border-foreground/40 bg-secondary text-foreground';
  const off = 'border-dashed border-border text-muted-foreground hover:text-foreground';

  const only = options.length === 1 ? options[0] : undefined;
  if (only) {
    const active = value === only.entityId;
    return (
      <button
        type="button"
        disabled={disabled}
        aria-pressed={active}
        // The visible text is the entity name alone. It used to read
        // "Business (<name>)", which doubles up under the section's own
        // "Business" heading and reads absurdly when the entity is itself
        // named for the fact it is a business: an entity called "Business
        // (LLC)" rendered as "Business (Business (LLC))". The name also
        // matches what the multi-business shape shows, so the two shapes
        // no longer label the same thing differently.
        //
        // A bare name does not say what pressing it DOES, so the accessible
        // name spells that out. It contains the visible text, so voice
        // control still matches on the name (WCAG 2.5.3).
        aria-label={`Count this expense in ${only.name}'s books`}
        className={`inline-flex max-w-full items-center gap-1.5 ${base} ${active ? on : off}`}
        onClick={() => {
          onChange(active ? null : only.entityId);
        }}
      >
        <Check
          className={`size-3.5 shrink-0 ${active ? '' : 'opacity-30'}`}
          aria-hidden="true"
        />
        {/* Entity names run to 200 chars in the schema; without this a legal
            name blows past 390px, the same trap the ledger badge fell into. */}
        <span className="truncate">{only.name}</span>
      </button>
    );
  }

  // Exclusive choice, so radio semantics rather than a row of toggle buttons:
  // aria-pressed would announce each chip independently with nothing saying
  // they are one set.
  return (
    <div
      role="radiogroup"
      aria-labelledby={labelledBy}
      className="flex flex-wrap items-center gap-1.5"
    >
      <button
        type="button"
        role="radio"
        disabled={disabled}
        aria-checked={value === null}
        className={`${base} ${value === null ? on : off}`}
        onClick={() => {
          onChange(null);
        }}
      >
        Personal
      </button>
      {options.map((business) => {
        const active = value === business.entityId;
        return (
          <button
            key={business.entityId}
            type="button"
            role="radio"
            disabled={disabled}
            aria-checked={active}
            className={`inline-flex max-w-full items-center gap-1.5 ${base} ${active ? on : off}`}
            onClick={() => {
              onChange(active ? null : business.entityId);
            }}
          >
            {active ? <Check className="size-3.5 shrink-0" aria-hidden="true" /> : null}
            <span className="truncate">{business.name}</span>
          </button>
        );
      })}
    </div>
  );
}
