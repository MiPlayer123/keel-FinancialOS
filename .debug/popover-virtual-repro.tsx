import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { Popover } from '@base-ui/react/popover';
import { useWindowVirtualizer } from '@tanstack/react-virtual';

const rows = Array.from({ length: 200 }, (_, index) => index);

function Row({ index }: { index: number }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div style={{ display: 'flex', height: 56, alignItems: 'center', gap: 8 }}>
      <span>Row {index}</span>
      <Popover.Root open={open} onOpenChange={setOpen} modal="trap-focus">
        <Popover.Trigger data-testid={`trigger-${index}`}>Open</Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner sideOffset={4}>
            <Popover.Popup data-testid={`popup-${index}`} style={{ background: 'white', border: '1px solid black', padding: 8 }}>
              <input autoFocus aria-label={`input-${index}`} />
              <Popover.Close>Close</Popover.Close>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}

function App() {
  const parentRef = React.useRef<HTMLDivElement | null>(null);
  const mode = new URLSearchParams(location.search).get('mode') ?? 'transform';
  const virtualizer = useWindowVirtualizer({
    count: rows.length,
    scrollMargin: parentRef.current?.offsetTop ?? 0,
    estimateSize: () => 56,
    overscan: 8,
  });

  return (
    <div ref={parentRef} style={{ overflow: 'hidden', border: '1px solid black' }}>
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((item) => (
          <div
            key={item.key}
            data-index={item.index}
            ref={virtualizer.measureElement}
            style={{
              position: 'absolute',
              top: mode === 'top' ? item.start - virtualizer.options.scrollMargin : 0,
              left: 0,
              width: '100%',
              transform:
                mode === 'transform'
                  ? `translateY(${item.start - virtualizer.options.scrollMargin}px)`
                  : undefined,
            }}
          >
            <Row index={item.index} />
          </div>
        ))}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);

if (new URLSearchParams(location.search).has('test')) {
  setTimeout(() => {
    scrollTo(0, 3000);
    setTimeout(() => {
      const trigger = document.querySelector<HTMLButtonElement>('[data-testid^="trigger-"]');
      trigger?.click();
      setTimeout(() => {
        const popup = document.querySelector<HTMLElement>('[data-testid^="popup-"]');
        const passed =
          trigger?.getAttribute('aria-expanded') === 'true' &&
          popup !== null &&
          popup.contains(document.activeElement);
        document.body.dataset.testResult = passed ? 'pass' : 'fail';
        document.body.dataset.activeElement = document.activeElement?.outerHTML ?? '';
        document.title = passed ? 'PASS' : 'FAIL';
      }, 500);
    }, 500);
  }, 500);
}
