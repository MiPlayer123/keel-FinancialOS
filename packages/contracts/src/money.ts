import { z } from 'zod';
import type { Brand } from './brand.js';

/**
 * Money = BIGINT minor units (CLAUDE.md Law 4). In-process representation is
 * `bigint`; JSON transport is a decimal string, never a JS number — float64
 * cannot represent all int64 values and silently corrupts money.
 */
export type MinorUnits = Brand<bigint, 'MinorUnits'>;

/** ISO-4217 codes KEEL accepts today. Extend deliberately; never free-text. */
export const CURRENCY_CODES = ['USD'] as const;
export type CurrencyCode = (typeof CURRENCY_CODES)[number];
export const CurrencyCodeSchema = z.enum(CURRENCY_CODES);

/** Wire format for minor units: optional-sign digit string, no leading zeros. */
export const MinorUnitsStringSchema = z
  .string()
  .regex(/^-?(0|[1-9][0-9]*)$/, 'minor units must be an integer decimal string')
  .refine((s) => s !== '-0', { message: 'negative zero is not a valid amount' });

export const minorUnits = (value: bigint): MinorUnits => value as MinorUnits;

export const parseMinorUnits = (wire: string): MinorUnits => {
  const parsed = MinorUnitsStringSchema.safeParse(wire);
  if (!parsed.success) {
    throw new RangeError(`invalid minor-unit string: ${JSON.stringify(wire)}`);
  }
  return BigInt(parsed.data) as MinorUnits;
};

export const serializeMinorUnits = (value: MinorUnits): string => value.toString();

/** Transport shape for a monetary amount. */
export const MoneyDtoSchema = z.object({
  amountMinor: MinorUnitsStringSchema,
  currency: CurrencyCodeSchema,
});
export type MoneyDto = z.infer<typeof MoneyDtoSchema>;

export interface Money {
  readonly amountMinor: MinorUnits;
  readonly currency: CurrencyCode;
}

export const moneyFromDto = (dto: MoneyDto): Money => ({
  amountMinor: parseMinorUnits(dto.amountMinor),
  currency: dto.currency,
});

export const moneyToDto = (money: Money): MoneyDto => ({
  amountMinor: serializeMinorUnits(money.amountMinor),
  currency: money.currency,
});
