/**
 * QIF (Quicken Interchange Format) parsing — import path for decades of
 * Quicken history. Text in, plain rows out; money stays integer minor-unit
 * strings end to end (Law 4). Only bank-style cash records are imported;
 * !Account blocks and investment records are skipped, never guessed at.
 */

export type QifSplit = { categoryName: string | null; amountMinor: string };

export type QifRow = {
  date: string;
  /** Signed minor units: negative = money out (QIF convention preserved). */
  amountMinor: string;
  description: string;
  memo: string | null;
  /** L line: category name ("Groceries" / "Auto:Fuel"); null for transfers ([Account]). */
  categoryName: string | null;
  /** S/E/$ split lines when present; amounts sum to the total in valid files. */
  splits: QifSplit[];
};

const BANK_TYPES = new Set(['bank', 'cash', 'ccard', 'oth a', 'oth l']);

/** "1,234.56" / "-12" / "1234.5" → signed minor string, or null. */
export function parseQifAmount(raw: string): string | null {
  const cleaned = raw.trim().replaceAll(',', '');
  const m = /^(-?)(\d*)(?:\.(\d{0,2}))?$/.exec(cleaned);
  if (!m || (m[2] === '' && !m[3])) return null;
  const sign = m[1] === '-' ? '-' : '';
  const whole = m[2] ? m[2] : '0';
  const frac = (m[3] ?? '').padEnd(2, '0');
  const minor = BigInt(whole) * 100n + BigInt(frac || '0');
  if (minor === 0n) return '0';
  return `${sign}${minor.toString()}`;
}

/**
 * QIF dates: "3/15/2024", "3/15'24" (apostrophe = 2000s), "03/15/24",
 * "2024-03-15". US month-first for slashed forms (Quicken US convention).
 */
export function parseQifDate(raw: string): string | null {
  const t = raw.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (m) return isoOrNull(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[/.-](\d{1,2})['/.-](\d{2,4})$/.exec(t);
  if (m) {
    let year = Number(m[3]);
    if (year < 100) year += year < 70 ? 2000 : 1900;
    return isoOrNull(year, Number(m[1]), Number(m[2]));
  }
  return null;
}

function isoOrNull(y: number, mo: number, d: number): string | null {
  if (y < 1900 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/** A category L-line: "[Checking]" means transfer (no category). */
function categoryFromL(value: string): string | null {
  const v = value.trim();
  if (v === '' || (v.startsWith('[') && v.endsWith(']'))) return null;
  return v;
}

export function looksLikeQif(text: string, fileName?: string): boolean {
  if (fileName?.toLowerCase().endsWith('.qif')) return true;
  return /^!Type:/im.test(text.slice(0, 2000));
}

export function parseQif(text: string): { rows: QifRow[]; skipped: number } {
  const rows: QifRow[] = [];
  let skipped = 0;

  // Current section: bank-ish types import; anything else (incl. !Account
  // blocks and !Type:Invst) is skipped record by record.
  let importable = true;
  let record: Partial<QifRow> & { splits: QifSplit[] } = { splits: [] };
  let pendingSplit: { categoryName: string | null; amount: string | null } | null = null;
  let sawField = false;

  const flushSplit = () => {
    if (pendingSplit && pendingSplit.amount !== null) {
      record.splits.push({
        categoryName: pendingSplit.categoryName,
        amountMinor: pendingSplit.amount,
      });
    }
    pendingSplit = null;
  };

  const flushRecord = () => {
    flushSplit();
    if (!sawField) {
      record = { splits: [] };
      return;
    }
    const { date, amountMinor, splits } = record;
    if (!importable || !date || amountMinor === undefined || amountMinor === '0') {
      skipped++;
    } else {
      rows.push({
        date,
        amountMinor,
        description: (record.description ?? '').trim() || 'Imported transaction',
        memo: record.memo ?? null,
        categoryName: record.categoryName ?? null,
        splits,
      });
    }
    record = { splits: [] };
    sawField = false;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line === '') continue;
    if (line.startsWith('!')) {
      flushRecord();
      const header = line.slice(1).toLowerCase();
      if (header.startsWith('type:')) {
        importable = BANK_TYPES.has(header.slice(5).trim());
      } else {
        // !Account, !Option:..., !Clear:... — metadata blocks, not cash rows.
        importable = false;
      }
      continue;
    }
    const code = line[0] ?? '';
    const value = line.slice(1);
    switch (code) {
      case '^':
        flushRecord();
        break;
      case 'D': {
        const d = parseQifDate(value);
        if (d !== null) record.date = d;
        else Reflect.deleteProperty(record, 'date');
        sawField = true;
        break;
      }
      case 'T':
      case 'U': {
        const a = parseQifAmount(value);
        if (a !== null) record.amountMinor = a;
        else Reflect.deleteProperty(record, 'amountMinor');
        sawField = true;
        break;
      }
      case 'P':
        record.description = value.slice(0, 500);
        sawField = true;
        break;
      case 'M':
        record.memo = value.slice(0, 2000);
        sawField = true;
        break;
      case 'L':
        record.categoryName = categoryFromL(value);
        sawField = true;
        break;
      case 'S':
        flushSplit();
        pendingSplit = { categoryName: categoryFromL(value), amount: null };
        sawField = true;
        break;
      case '$': {
        if (pendingSplit) pendingSplit.amount = parseQifAmount(value);
        break;
      }
      default:
        // N (check no), C (cleared), E (split memo), A (address) — ignored.
        break;
    }
  }
  flushRecord();
  return { rows, skipped };
}
