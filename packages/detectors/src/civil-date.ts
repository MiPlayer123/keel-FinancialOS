export interface CivilDateParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

const floorDiv = (dividend: number, divisor: number): number => Math.floor(dividend / divisor);

export const isLeapYear = (year: number): boolean =>
  year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

export const daysInMonth = (year: number, month: number): number => {
  if (!Number.isInteger(year) || year < 1 || year > 9999 || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new RangeError('year/month is outside the supported civil-date range');
  }
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
};

export const parseCivilDate = (value: string): CivilDateParts => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) throw new RangeError('civil date must be YYYY-MM-DD');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (
    !Number.isInteger(year) || year < 1 || year > 9999 ||
    !Number.isInteger(month) || month < 1 || month > 12 ||
    !Number.isInteger(day) || day < 1 || day > daysInMonth(year, month)
  ) {
    throw new RangeError('invalid Gregorian civil date');
  }
  return { year, month, day };
};

const formatCivilDate = ({ year, month, day }: CivilDateParts): string =>
  `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;

/** Howard Hinnant's proleptic-Gregorian days-from-civil algorithm. */
export const civilDateToEpochDay = (value: string): number => {
  const parsed = parseCivilDate(value);
  let year = parsed.year;
  year -= parsed.month <= 2 ? 1 : 0;
  const era = floorDiv(year, 400);
  const yearOfEra = year - era * 400;
  const shiftedMonth = parsed.month + (parsed.month > 2 ? -3 : 9);
  const dayOfYear = floorDiv(153 * shiftedMonth + 2, 5) + parsed.day - 1;
  const dayOfEra =
    yearOfEra * 365 + floorDiv(yearOfEra, 4) - floorDiv(yearOfEra, 100) + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
};

/** Inverse of civilDateToEpochDay; rejects dates outside four-digit years. */
export const epochDayToCivilDate = (epochDay: number): string => {
  if (!Number.isSafeInteger(epochDay)) throw new RangeError('epoch day must be a safe integer');
  const shifted = epochDay + 719_468;
  const era = floorDiv(shifted, 146_097);
  const dayOfEra = shifted - era * 146_097;
  const yearOfEra = floorDiv(
    dayOfEra - floorDiv(dayOfEra, 1_460) + floorDiv(dayOfEra, 36_524) - floorDiv(dayOfEra, 146_096),
    365,
  );
  let year = yearOfEra + era * 400;
  const dayOfYear =
    dayOfEra - (365 * yearOfEra + floorDiv(yearOfEra, 4) - floorDiv(yearOfEra, 100));
  const monthPrime = floorDiv(5 * dayOfYear + 2, 153);
  const day = dayOfYear - floorDiv(153 * monthPrime + 2, 5) + 1;
  const month = monthPrime + (monthPrime < 10 ? 3 : -9);
  year += month <= 2 ? 1 : 0;
  if (year < 1 || year > 9999) throw new RangeError('epoch day is outside four-digit civil years');
  return formatCivilDate({ year, month, day });
};

export const addCivilDays = (value: string, days: number): string => {
  if (!Number.isSafeInteger(days)) throw new RangeError('civil day delta must be an integer');
  return epochDayToCivilDate(civilDateToEpochDay(value) + days);
};

export const addGregorianMonths = (value: string, months: number): string => {
  if (!Number.isSafeInteger(months)) throw new RangeError('civil month delta must be an integer');
  const parsed = parseCivilDate(value);
  const monthIndex = parsed.year * 12 + parsed.month - 1 + months;
  const year = floorDiv(monthIndex, 12);
  const month = monthIndex - year * 12 + 1;
  if (year < 1 || year > 9999) throw new RangeError('month addition leaves four-digit civil years');
  return formatCivilDate({ year, month, day: Math.min(parsed.day, daysInMonth(year, month)) });
};
