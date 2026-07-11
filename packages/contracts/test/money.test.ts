import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  MinorUnitsStringSchema,
  MoneyDtoSchema,
  minorUnits,
  moneyFromDto,
  moneyToDto,
  parseMinorUnits,
  serializeMinorUnits,
} from '@keel/contracts';

describe('minor-unit wire format (Law 4: no floats ever)', () => {
  it('accepts integer decimal strings', () => {
    for (const ok of ['0', '1', '-1', '8742', '-8742', '9007199254740993']) {
      expect(MinorUnitsStringSchema.safeParse(ok).success).toBe(true);
    }
  });

  it('rejects floats, exponents, separators, blanks, and negative zero', () => {
    for (const bad of [
      '1.5',
      '-0.01',
      '1e5',
      '1,000',
      '',
      ' 1',
      '1 ',
      '+1',
      '01',
      '-0',
      'NaN',
      'Infinity',
      '0x10',
    ]) {
      expect(MinorUnitsStringSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('round-trips every bigint through the wire format losslessly', () => {
    fc.assert(
      fc.property(fc.bigInt(), (value) => {
        const wire = serializeMinorUnits(minorUnits(value));
        expect(parseMinorUnits(wire)).toBe(value);
      }),
    );
  });

  it('survives values beyond Number.MAX_SAFE_INTEGER exactly', () => {
    const beyondFloat = 2n ** 63n - 1n; // int64 max
    expect(parseMinorUnits(beyondFloat.toString())).toBe(beyondFloat);
  });

  it('parseMinorUnits throws on invalid input rather than coercing', () => {
    expect(() => parseMinorUnits('1.5')).toThrow(RangeError);
    expect(() => parseMinorUnits('87.42')).toThrow(RangeError);
  });
});

describe('MoneyDto', () => {
  it('parses and round-trips', () => {
    const dto = MoneyDtoSchema.parse({ amountMinor: '-8742', currency: 'USD' });
    const money = moneyFromDto(dto);
    expect(money.amountMinor).toBe(-8742n);
    expect(moneyToDto(money)).toEqual(dto);
  });

  it('rejects JSON numbers outright — money never rides in a number', () => {
    expect(MoneyDtoSchema.safeParse({ amountMinor: 8742, currency: 'USD' }).success).toBe(false);
    expect(MoneyDtoSchema.safeParse({ amountMinor: 87.42, currency: 'USD' }).success).toBe(false);
  });

  it('rejects unknown currencies', () => {
    expect(MoneyDtoSchema.safeParse({ amountMinor: '1', currency: 'EUR' }).success).toBe(false);
  });
});
