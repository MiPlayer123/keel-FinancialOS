/**
 * Master-detail race guard (teardown C6 review finding): the desktop panel
 * lets a user switch straight from transaction A to transaction B while A's
 * save/void/split-save is still in flight. A completion is keyed to the
 * transaction it was FOR, not to "whatever is open now" — so a stale
 * completion from A must never clear B's currently-open edit panel and
 * discard B's in-progress draft. Only the transaction that completed AND is
 * still the one open may be cleared.
 */
export function resolveEditingAfterSave<T extends { transactionId: string }>(
  current: T | null,
  savedTransactionId: string,
): T | null {
  return current && current.transactionId === savedTransactionId ? null : current;
}
