'use client';

import { useRef } from 'react';
import { useWindowVirtualizer } from '@tanstack/react-virtual';

import { type CategoryRow, type RichTransactionRow } from '@/lib/keel-api';
import { TxnRow, type ListCallbacks } from '@/components/keel/txn-edit-dialog';

/**
 * WS-H (F-005): virtualized transaction list. Renders only the rows in (and
 * near) the viewport instead of every row in the DOM — the account-detail page
 * was mounting all 644 rows of the main checking account unsliced, and the
 * ledger capped at 120 with a "show more" purely to keep the DOM small.
 *
 * Row markup is the SAME `TxnRow` the plain `TxnList` uses, so the two lists
 * are visually identical. Rows have variable height (notes, tags, split/
 * transfer badges add lines), so we measure each mounted row (`measureElement`)
 * rather than assume a fixed height — the estimate is only the initial guess.
 *
 * The list virtualizes against the WINDOW scroll (not an inner scroll
 * container) so the page keeps its single natural scrollbar and the detail
 * sheet/header behave exactly as before. A spacer div of the full measured
 * height reserves the scroll range; only the visible slice is positioned
 * absolutely inside it.
 */
export function VirtualTxnList({
  rows,
  categories,
  running,
  bordered,
  businessNames,
  onRecategorize,
  onEdit,
  selecting,
  selected,
  onToggle,
  onApproveAuto,
}: {
  rows: RichTransactionRow[];
  categories: CategoryRow[];
  running?: Map<string, string> | undefined;
  /** Match TxnList's non-virtual container chrome for a seamless swap. */
  bordered?: boolean | undefined;
  /** tagId -> business name; see TxnRow. */
  businessNames?: Map<string, string> | undefined;
} & ListCallbacks) {
  const parentRef = useRef<HTMLDivElement | null>(null);

  // Window scroll: these pages scroll the document, not an inner container, so
  // the list keeps the page's single natural scrollbar. scrollMargin offsets
  // the virtualizer by the list's distance from the top of the document so row
  // positions line up with where the list actually sits on the page.
  const virtualizer = useWindowVirtualizer({
    count: rows.length,
    scrollMargin: parentRef.current?.offsetTop ?? 0,
    // ~56px is a typical single-line row; variable rows are re-measured on mount.
    estimateSize: () => 56,
    // Render a few extra rows above/below the viewport so fast scrolls don't
    // flash blank space.
    overscan: 8,
    getItemKey: (index) => {
      const r = rows[index];
      return r ? `${r.transactionId}:${String(index)}` : index;
    },
  });

  const items = virtualizer.getVirtualItems();

  return (
    <div
      ref={parentRef}
      className={
        bordered
          ? 'border-t border-border'
          : 'overflow-hidden rounded-lg border border-border'
      }
    >
      <div style={{ height: `${String(virtualizer.getTotalSize())}px`, position: 'relative' }}>
        {items.map((item) => {
          const t = rows[item.index];
          if (!t) return null;
          return (
            <div
              key={item.key}
              data-index={item.index}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                // Subtract scrollMargin: item.start is measured from the top of
                // the document, but this slice is positioned relative to the
                // list's own box (which begins scrollMargin px down the page).
                transform: `translateY(${String(item.start - virtualizer.options.scrollMargin)}px)`,
              }}
            >
              <TxnRow
                t={t}
                topBorder={item.index > 0}
                categories={categories}
                running={running}
                businessNames={businessNames}
                onRecategorize={onRecategorize}
                onEdit={onEdit}
                selecting={selecting}
                selected={selected}
                onToggle={onToggle}
                onApproveAuto={onApproveAuto}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
