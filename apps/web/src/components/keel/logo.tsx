import { cn } from '@/lib/utils';

/**
 * KEEL wordmark. The mark is a minimal "keel" curve — the structural line a hull
 * is built around — nodding to "system of record / structural spine".
 */
export function KeelMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className={cn('size-6 text-primary', className)}
      aria-hidden
    >
      <path
        d="M5 4v9a7 7 0 0 0 7 7 7 7 0 0 0 7-7"
        stroke="currentColor"
        strokeWidth="2.25"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function KeelLogo({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <KeelMark />
      <span className="text-lg font-semibold tracking-tight lowercase">keel</span>
    </span>
  );
}
