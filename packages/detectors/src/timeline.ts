import { parseCivilDate } from './civil-date.js';
import type { RecurringSeriesStatus, RecurringStatusEvent } from './types.js';

const orderedEvents = (events: readonly RecurringStatusEvent[]): RecurringStatusEvent[] =>
  events.map((event) => {
    parseCivilDate(event.effectiveDate);
    return event;
  }).sort((left, right) =>
    left.effectiveDate.localeCompare(right.effectiveDate) ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.commandId.localeCompare(right.commandId),
  );

export const statusOnDate = (
  events: readonly RecurringStatusEvent[],
  date: string,
): RecurringSeriesStatus => {
  parseCivilDate(date);
  let status: RecurringSeriesStatus = 'suggested';
  for (const event of orderedEvents(events)) {
    if (event.effectiveDate > date) break;
    switch (event.transition) {
      case 'suggested':
        if (status === 'suggested') status = 'suggested';
        break;
      case 'confirmed':
        if (status === 'suggested' || status === 'rejected' || status === 'cancelled') {
          status = 'confirmed';
        }
        break;
      case 'paused':
        if (status === 'confirmed') status = 'paused';
        break;
      case 'resumed':
        if (status === 'paused') status = 'confirmed';
        break;
      case 'cancelled':
        if (status === 'confirmed' || status === 'paused') status = 'cancelled';
        break;
      case 'rejected':
        if (status === 'suggested') status = 'rejected';
        break;
    }
  }
  return status;
};

export const isSeriesActiveOn = (events: readonly RecurringStatusEvent[], date: string): boolean =>
  statusOnDate(events, date) === 'confirmed';
