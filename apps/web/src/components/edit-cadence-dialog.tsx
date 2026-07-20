'use client';

import { useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  buildCadenceAnchor,
  EDITABLE_CADENCE_LABELS,
  reclassifyCadence,
  type EditableCadence,
} from '@/lib/recurring';

const CADENCE_ORDER: EditableCadence[] = [
  'weekly', 'biweekly', 'semimonthly', 'monthly', 'quarterly', 'annual',
];

/**
 * Correct a recurring/paycheck series' cadence. The founder's Deeptune payroll
 * pays on the 15th and the last calendar day of every month (semi-monthly), but
 * detection read it as biweekly; this is the general fix — pick the true cadence
 * and, for the calendar-anchored ones, the day(s) of the month. Semi-monthly
 * defaults to the 15th & 31st (the 31 month-end-clamps to Feb 28/29, Apr 30,
 * etc. server-side). Class B: suggest→approve, audited, reversible (a later
 * edit or re-detect can change it again).
 */
export function EditCadenceDialog(props: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
  seriesId: string;
  seriesLabel: string;
  householdId: string;
  userId: string;
  /** A recent occurrence/observed date to anchor epoch-grid + default day picks. */
  referenceDate: string;
}) {
  const { open, onClose, onDone, seriesId, seriesLabel, householdId, userId, referenceDate } =
    props;
  const [cadence, setCadence] = useState<EditableCadence>('semimonthly');
  const [day1, setDay1] = useState('15');
  const [day2, setDay2] = useState('31');
  const [monthDay, setMonthDay] = useState(() => referenceDate.slice(8, 10));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsPair = cadence === 'semimonthly';
  const needsDay = cadence === 'monthly' || cadence === 'quarterly' || cadence === 'annual';

  const validationError = useMemo(() => {
    const inDom = (s: string) => /^\d+$/.test(s) && Number(s) >= 1 && Number(s) <= 31;
    if (needsPair) {
      if (!inDom(day1) || !inDom(day2)) return 'Enter two days between 1 and 31.';
      if (Number(day1) === Number(day2)) return 'The two days must be different.';
    }
    if (needsDay && !inDom(monthDay)) return 'Enter a day between 1 and 31.';
    return null;
  }, [needsPair, needsDay, day1, day2, monthDay]);

  const submit = async () => {
    if (validationError) return;
    setBusy(true);
    setError(null);
    try {
      const anchor = buildCadenceAnchor(cadence, referenceDate, {
        day: needsDay ? Number(monthDay) : needsPair ? Number(day1) : undefined,
        day2: needsPair ? Number(day2) : undefined,
      });
      await reclassifyCadence({ seriesId, cadence, cadenceAnchor: anchor, householdId, userId });
      onDone();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update the cadence.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Fix the schedule</DialogTitle>
          <DialogDescription>
            Correct how often {seriesLabel} repeats. This only changes KEEL&apos;s
            projection — no money moves, and you can change it again anytime.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Repeats</Label>
            <Select
              value={cadence}
              items={Object.fromEntries(
                CADENCE_ORDER.map((c) => [c, EDITABLE_CADENCE_LABELS[c]]),
              )}
              onValueChange={(v) => {
                if (v) setCadence(v);
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CADENCE_ORDER.map((c) => (
                  <SelectItem key={c} value={c}>
                    {EDITABLE_CADENCE_LABELS[c]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {needsPair ? (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="cad-day1">First day</Label>
                <Input
                  id="cad-day1"
                  inputMode="numeric"
                  value={day1}
                  onChange={(e) => {
                    setDay1(e.target.value);
                  }}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cad-day2">Second day</Label>
                <Input
                  id="cad-day2"
                  inputMode="numeric"
                  value={day2}
                  onChange={(e) => {
                    setDay2(e.target.value);
                  }}
                />
              </div>
              <p className="col-span-2 text-xs text-muted-foreground">
                Use 31 for &ldquo;last day of the month&rdquo; — it lands on Feb 28/29,
                Apr 30, and so on automatically.
              </p>
            </div>
          ) : null}

          {needsDay ? (
            <div className="space-y-1.5">
              <Label htmlFor="cad-monthday">Day of month</Label>
              <Input
                id="cad-monthday"
                inputMode="numeric"
                value={monthDay}
                onChange={(e) => {
                  setMonthDay(e.target.value);
                }}
              />
              <p className="text-xs text-muted-foreground">
                Use 31 for the last day; shorter months clamp automatically.
              </p>
            </div>
          ) : null}

          {(validationError ?? error) ? (
            <p className="text-xs text-destructive">{validationError ?? error}</p>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void submit()}
            disabled={busy || validationError !== null}
          >
            {busy ? 'Saving…' : 'Save schedule'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
