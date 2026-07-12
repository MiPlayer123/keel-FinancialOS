import { civilDateToEpochDay, daysInMonth, epochDayToCivilDate, parseCivilDate } from './civil-date.js';
import type { CadenceAnchor } from './types.js';

const mod = (value: number, divisor: number): number => ((value % divisor) + divisor) % divisor;
const dateString = (year: number, month: number, day: number): string =>
  `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;

export const cadenceDatesBetween = (
  anchor: CadenceAnchor,
  fromDate: string,
  toDate: string,
): string[] => {
  const from = parseCivilDate(fromDate);
  const to = parseCivilDate(toDate);
  if (fromDate > toDate) return [];
  if (anchor.kind === 'epoch_grid') {
    const fromDay = civilDateToEpochDay(fromDate);
    const toDay = civilDateToEpochDay(toDate);
    const first = anchor.anchorEpochDay + Math.ceil((fromDay - anchor.anchorEpochDay) / anchor.intervalDays) * anchor.intervalDays;
    const dates: string[] = [];
    for (let day = first; day <= toDay; day += anchor.intervalDays) dates.push(epochDayToCivilDate(day));
    return dates;
  }

  const fromMonth = from.year * 12 + from.month - 1;
  const toMonth = to.year * 12 + to.month - 1;
  const dates: string[] = [];
  for (let monthIndex = fromMonth; monthIndex <= toMonth; monthIndex += 1) {
    const year = Math.floor(monthIndex / 12);
    const month = monthIndex - year * 12 + 1;
    const anchorDays = anchor.kind === 'day_pair' ? anchor.days : [anchor.day] as const;
    if (anchor.kind === 'day_of_month' && mod(monthIndex, anchor.intervalMonths) !== anchor.phase) continue;
    for (const anchorDay of anchorDays) {
      const date = dateString(year, month, Math.min(anchorDay, daysInMonth(year, month)));
      if (date >= fromDate && date <= toDate && dates.at(-1) !== date) dates.push(date);
    }
  }
  return dates;
};
