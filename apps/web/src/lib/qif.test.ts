import { describe, expect, it } from 'vitest';

import { looksLikeQif, parseQif, parseQifAmount, parseQifDate } from './qif';

describe('parseQifAmount', () => {
  it('parses signed decimals with thousands separators', () => {
    expect(parseQifAmount('-1,234.56')).toBe('-123456');
    expect(parseQifAmount('12')).toBe('1200');
    expect(parseQifAmount('0.5')).toBe('50');
    expect(parseQifAmount('-0.05')).toBe('-5');
    expect(parseQifAmount('+5')).toBe('500');
  });
  it('rejects garbage', () => {
    expect(parseQifAmount('abc')).toBeNull();
    expect(parseQifAmount('')).toBeNull();
    expect(parseQifAmount('1.2.3')).toBeNull();
  });
});

describe('parseQifDate', () => {
  it('handles the Quicken US formats', () => {
    expect(parseQifDate('3/15/2024')).toBe('2024-03-15');
    expect(parseQifDate("3/15'24")).toBe('2024-03-15');
    expect(parseQifDate('03/15/99')).toBe('1999-03-15');
    // Apostrophe separator is ALWAYS a 2000s year in Quicken.
    expect(parseQifDate("3/15'99")).toBe('2099-03-15');
    expect(parseQifDate('2024-03-15')).toBe('2024-03-15');
  });
  it('flips to day-first when asked', () => {
    expect(parseQifDate('15/3/24', true)).toBe('2024-03-15');
    expect(parseQifDate('5/3/24', true)).toBe('2024-03-05');
  });
  it('rejects impossible dates', () => {
    expect(parseQifDate('13/45/2024')).toBeNull();
    expect(parseQifDate('2/30/2024')).toBeNull();
  });
});

const SAMPLE = `!Type:Bank
D3/15'24
T-42.50
PTrader Joe's
MWeekly groceries
LGroceries
^
D3/16'24
T1,500.00
PACME Payroll
LSalary
^
D3/17'24
T-100.00
P[Transfer out]
L[Savings]
^
!Type:Invst
D3/18'24
T-999.00
PBuy VTI
^
!Type:Bank
D3/19'24
T-60.00
PCostco
SGroceries
$-40.00
SHousehold
$-20.00
^
`;

describe('parseQif', () => {
  it('parses bank records, keeps transfers uncategorized, skips investments', () => {
    const { rows, skipped, ignored, dayFirst } = parseQif(SAMPLE);
    expect(rows).toHaveLength(4);
    expect(skipped).toBe(0);
    expect(ignored).toBe(1); // the investment record is expected noise, not an error
    expect(dayFirst).toBe(false);
    expect(rows[0]).toMatchObject({
      date: '2024-03-15',
      amountMinor: '-4250',
      description: "Trader Joe's",
      memo: 'Weekly groceries',
      categoryName: 'Groceries',
    });
    expect(rows[1]).toMatchObject({ amountMinor: '150000', categoryName: 'Salary' });
    expect(rows[2]).toMatchObject({ categoryName: null }); // [Savings] transfer
    expect(rows[3]?.splits).toEqual([
      { categoryName: 'Groceries', amountMinor: '-4000' },
      { categoryName: 'Household', amountMinor: '-2000' },
    ]);
  });
  it('reads a whole UK file day-first once any date proves it', () => {
    const uk = ['!Type:Bank', "D15/3'24", 'T-10.00', 'PBoots', '^', "D5/3'24", 'T-20.00', 'PTesco', '^'].join('\n');
    const { rows, dayFirst } = parseQif(uk);
    expect(dayFirst).toBe(true);
    expect(rows.map((r) => r.date)).toEqual(['2024-03-15', '2024-03-05']);
  });
  it('counts !Account metadata blocks as ignored, not unparseable', () => {
    const withAccount = ['!Account', 'NChecking', 'TBank', '^', '!Type:Bank', "D3/15'24", 'T-1.00', 'PX', '^'].join('\n');
    const { rows, skipped, ignored } = parseQif(withAccount);
    expect(rows).toHaveLength(1);
    expect(skipped).toBe(0);
    expect(ignored).toBe(1);
  });
  it('detects QIF by extension or header', () => {
    expect(looksLikeQif(SAMPLE)).toBe(true);
    expect(looksLikeQif('Date,Amount\n1/1/24,5', 'export.qif')).toBe(true);
    expect(looksLikeQif('Date,Amount\n1/1/24,5', 'export.csv')).toBe(false);
  });
});
