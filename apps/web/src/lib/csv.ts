/**
 * Minimal RFC-4180-ish CSV parsing + bank-export heuristics. Pure string
 * work — money never becomes a float here: amounts are normalized straight
 * to integer minor-unit strings (Law 4).
 */

/** Parse CSV text into rows of fields (handles quotes, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? '';
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || (row[0] ?? '').trim() !== '') rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.length > 1 || (row[0] ?? '').trim() !== '') rows.push(row);
  return rows;
}

/** Normalize a cell to YYYY-MM-DD; accepts ISO, MM/DD/YYYY, MM-DD-YYYY. */
export function parseCsvDate(cell: string): string | null {
  const s = cell.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1] ?? ''}-${iso[2] ?? ''}-${iso[3] ?? ''}`;
  const us = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/.exec(s);
  if (us) {
    const mm = (us[1] ?? '').padStart(2, '0');
    const dd = (us[2] ?? '').padStart(2, '0');
    const y = us[3] ?? '';
    if (Number(mm) < 1 || Number(mm) > 12 || Number(dd) < 1 || Number(dd) > 31) return null;
    return `${y}-${mm}-${dd}`;
  }
  return null;
}

/**
 * Normalize a money cell to a SIGNED integer minor-units string.
 * Accepts "-12.34", "(12.34)" (accounting negatives), "$1,234.5", "12".
 */
export function parseCsvAmount(cell: string): string | null {
  let s = cell.trim();
  if (s === '') return null;
  let negative = false;
  if (s.startsWith('(') && s.endsWith(')')) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replaceAll(/[$,\s]/g, '');
  if (s.startsWith('-')) {
    negative = !negative ? true : negative;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }
  if (!/^\d*(\.\d{0,4})?$/.test(s) || s === '' || s === '.') return null;
  const [whole = '0', frac = ''] = s.split('.');
  // Bank exports are 2dp; truncate anything beyond (never round money).
  const cents = (frac + '00').slice(0, 2);
  const minor = `${whole === '' ? '0' : whole}${cents}`.replace(/^0+(?=\d)/, '');
  if (minor === '0' || minor === '00') return '0';
  return negative ? `-${minor}` : minor;
}

export type CsvColumnGuess = { date: number | null; amount: number | null; description: number | null };

/** Guess which columns hold date/amount/description from a header row. */
export function guessColumns(header: string[]): CsvColumnGuess {
  const lower = header.map((h) => h.trim().toLowerCase());
  const find = (...names: string[]) => {
    for (const n of names) {
      const idx = lower.findIndex((h) => h === n);
      if (idx >= 0) return idx;
    }
    for (const n of names) {
      const idx = lower.findIndex((h) => h.includes(n));
      if (idx >= 0) return idx;
    }
    return null;
  };
  return {
    date: find('transaction date', 'posting date', 'post date', 'date'),
    amount: find('amount', 'value'),
    description: find('description', 'payee', 'merchant', 'name', 'memo', 'details'),
  };
}
