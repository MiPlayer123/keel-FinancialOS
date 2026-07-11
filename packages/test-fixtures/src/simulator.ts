import type {
  BankProviderAdapter,
  ProviderSyncEvent,
  SyncPage,
} from '@keel/contracts';
import type { Scenario } from './scenarios.js';

const cloneEvent = (event: ProviderSyncEvent): ProviderSyncEvent => {
  if (event.kind === 'transaction_removed') {
    return { ...event };
  }

  return { ...event, transaction: { ...event.transaction } };
};

const clonePage = (page: SyncPage): SyncPage => ({
  ...page,
  events: page.events.map(cloneEvent),
});

export class SimulatorBankProvider implements BankProviderAdapter {
  readonly name = 'simulator' as const;

  constructor(private readonly scenario: Scenario) {}

  sync(_connectionExternalRef: string, cursor: string): Promise<SyncPage> {
    const pageIndex = cursor === '' ? 0 : Number(cursor);
    if (
      !Number.isSafeInteger(pageIndex) ||
      pageIndex < 0 ||
      (cursor !== '' && String(pageIndex) !== cursor) ||
      pageIndex >= this.scenario.pages.length
    ) {
      return Promise.reject(
        new RangeError(`unknown simulator cursor: ${JSON.stringify(cursor)}`),
      );
    }

    const selectedPage = this.scenario.pages[pageIndex];
    if (selectedPage === undefined) {
      return Promise.reject(
        new RangeError(`unknown simulator cursor: ${JSON.stringify(cursor)}`),
      );
    }

    return Promise.resolve(clonePage(selectedPage));
  }
}
