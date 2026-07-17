'use client';

import { useEffect, useState } from 'react';
import { Wand2, Plus, Trash2, Loader2, Play, ChevronRight } from 'lucide-react';
import { toast } from 'sonner';

import { useHousehold } from '@/components/keel/household-context';
import {
  applyRules,
  deleteRule,
  fetchCategories,
  fetchRules,
  saveRule,
  type CategoryRow,
  type RuleRow,
} from '@/lib/keel-api';
import { formatMoney, parseDollarsToMinorString } from '@/lib/money';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/** "$50.00 – $200.00" / "$50.00+" / "up to $200.00" for a rule's amount condition, or null if unset. */
function describeAmountRange(min: string | null, max: string | null): string | null {
  if (min === null && max === null) return null;
  if (min !== null && max !== null) {
    return `${formatMoney(min)} – ${formatMoney(max)}`;
  }
  if (min !== null) return `${formatMoney(min)}+`;
  return `up to ${formatMoney(max as string)}`;
}

/**
 * User-authored automation: "when the bank description contains X, set the
 * category and/or rename it." Deterministic; user edits always win.
 * Retroactive apply is two-phase (preview count → confirm) per BC-v2.1 §3.
 * Hidden entirely until the rules backend is deployed (fetch fails → null).
 */
export function RulesCard() {
  const { householdId } = useHousehold();
  const [rules, setRules] = useState<RuleRow[] | null>(null);
  const [available, setAvailable] = useState(true);
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [adding, setAdding] = useState(false);
  const [pattern, setPattern] = useState('');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [renameTo, setRenameTo] = useState('');
  // C18 residual: optional amount-range condition, collapsed by default —
  // most rules are pattern-only and shouldn't have to look past two extra
  // fields they don't need (Law 8: calm over clutter).
  const [amountOpen, setAmountOpen] = useState(false);
  const [amountMinDollars, setAmountMinDollars] = useState('');
  const [amountMaxDollars, setAmountMaxDollars] = useState('');
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [preview, setPreview] = useState<{ categorized: number; renamed: number } | null>(null);

  useEffect(() => {
    if (!householdId) return;
    let active = true;
    fetchRules(householdId)
      .then((r) => {
        if (active) setRules(r);
      })
      .catch((err: unknown) => {
        if (!active) return;
        const msg = err instanceof Error ? err.message : '';
        // Missing backend hides the card; transient errors just leave it empty.
        if (/unknown query|does not exist|not_found/i.test(msg)) setAvailable(false);
        else setRules([]);
      });
    fetchCategories(householdId)
      .then((c) => {
        if (active) setCategories(c);
      })
      .catch(() => {
        if (active) setCategories([]);
      });
    return () => {
      active = false;
    };
  }, [householdId]);

  if (!available || !householdId) return null;

  async function refresh() {
    if (!householdId) return;
    try {
      setRules(await fetchRules(householdId));
    } catch {
      /* keep current list */
    }
  }

  async function add() {
    if (!householdId || pattern.trim().length < 2) return;
    if (!categoryId && renameTo.trim().length === 0) {
      toast.error('Pick a category, a new name, or both.');
      return;
    }
    // Amount condition (C18 residual): blank means "not set" even when the
    // section is expanded — only a non-blank field becomes a bound. Reject
    // early on unparseable/out-of-order input rather than letting the
    // server's typed error surface as a generic failure toast.
    let amountMinMinor: string | null = null;
    let amountMaxMinor: string | null = null;
    if (amountOpen) {
      if (amountMinDollars.trim()) {
        amountMinMinor = parseDollarsToMinorString(amountMinDollars);
        if (amountMinMinor === null) {
          toast.error('Minimum amount looks invalid.');
          return;
        }
      }
      if (amountMaxDollars.trim()) {
        amountMaxMinor = parseDollarsToMinorString(amountMaxDollars);
        if (amountMaxMinor === null) {
          toast.error('Maximum amount looks invalid.');
          return;
        }
      }
      if (amountMinMinor !== null && amountMaxMinor !== null && BigInt(amountMinMinor) > BigInt(amountMaxMinor)) {
        toast.error('Minimum amount must be less than or equal to the maximum.');
        return;
      }
    }
    setBusy(true);
    try {
      await saveRule({
        householdId,
        pattern: pattern.trim(),
        categoryLedgerAccountId: categoryId,
        renameTo: renameTo.trim() || null,
        amountMinMinor,
        amountMaxMinor,
      });
      toast.success('Rule saved. Preview its effect with Apply.');
      setPattern('');
      setCategoryId(null);
      setRenameTo('');
      setAmountOpen(false);
      setAmountMinDollars('');
      setAmountMaxDollars('');
      setAdding(false);
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save the rule.');
    } finally {
      setBusy(false);
    }
  }

  async function runApply() {
    if (!householdId) return;
    setApplying(true);
    try {
      if (!preview) {
        const dry = await applyRules(householdId, true);
        if (dry.categorized === 0 && dry.renamed === 0) {
          toast.info('Rules would change nothing right now.');
        } else {
          setPreview({ categorized: dry.categorized, renamed: dry.renamed });
        }
      } else {
        const result = await applyRules(householdId, false);
        toast.success(
          `Applied: ${String(result.categorized)} categorized, ${String(result.renamed)} renamed.`,
        );
        setPreview(null);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Apply failed.');
    } finally {
      setApplying(false);
    }
  }

  async function remove(ruleId: string) {
    if (!householdId) return;
    try {
      await deleteRule(householdId, ruleId);
      toast.success('Rule deleted. Its renames revert; categories stay until recategorized.');
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not delete the rule.');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Wand2 className="size-4" />
          Rules
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          When a bank description contains your pattern, KEEL sets the category and/or a
          friendly name — automatically, on every sync. Your own edits always win.
        </p>

        {rules !== null && rules.length > 0 ? (
          <div className="space-y-2">
            {rules.map((r) => (
              <div key={r.ruleId} className="flex items-center gap-3 text-sm">
                <span className="min-w-0 flex-1 truncate">
                  &ldquo;{r.pattern}&rdquo;
                  {describeAmountRange(r.amountMinMinor, r.amountMaxMinor) ? (
                    <span className="text-muted-foreground">
                      {' '}
                      and {describeAmountRange(r.amountMinMinor, r.amountMaxMinor)}
                    </span>
                  ) : null}
                  <span className="text-muted-foreground">
                    {' '}
                    → {[r.categoryName, r.renameTo ? `rename "${r.renameTo}"` : null]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Delete rule"
                  onClick={() => {
                    void remove(r.ruleId);
                  }}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No rules yet.</p>
        )}

        {adding ? (
          <div className="space-y-3 rounded-md border border-border p-3">
            <div className="space-y-1.5">
              <Label htmlFor="rule-pattern">When the description contains</Label>
              <Input
                id="rule-pattern"
                value={pattern}
                maxLength={140}
                placeholder="e.g. NETFLIX"
                onChange={(e) => {
                  setPattern(e.target.value);
                }}
              />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Set category to</Label>
                <Select
                  value={categoryId ?? undefined}
                  items={Object.fromEntries(
                    categories.map((c) => [
                      c.ledgerAccountId,
                      c.kind === 'income' ? `${c.name} (income)` : c.name,
                    ]),
                  )}
                  onValueChange={(v) => {
                    setCategoryId(v);
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="(keep category)" />
                  </SelectTrigger>
                  <SelectContent>
                    {categories.map((c) => (
                      <SelectItem key={c.ledgerAccountId} value={c.ledgerAccountId}>
                        <span className={c.parentLedgerAccountId ? 'pl-3' : ''}>
                          {c.name}
                          {c.kind === 'income' ? ' (income)' : ''}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rule-rename">Rename to</Label>
                <Input
                  id="rule-rename"
                  value={renameTo}
                  maxLength={140}
                  placeholder="(keep name)"
                  onChange={(e) => {
                    setRenameTo(e.target.value);
                  }}
                />
              </div>
            </div>

            {amountOpen ? (
              <div className="space-y-1.5 rounded-md border border-dashed border-border p-2.5">
                <div className="flex items-center justify-between">
                  <Label>And the amount is</Label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-auto py-0.5 text-xs text-muted-foreground"
                    onClick={() => {
                      setAmountOpen(false);
                      setAmountMinDollars('');
                      setAmountMaxDollars('');
                    }}
                  >
                    Remove condition
                  </Button>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="rule-amount-min" className="text-xs font-normal text-muted-foreground">
                      At least
                    </Label>
                    <Input
                      id="rule-amount-min"
                      inputMode="decimal"
                      value={amountMinDollars}
                      placeholder="$0.00"
                      onChange={(e) => {
                        setAmountMinDollars(e.target.value);
                      }}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="rule-amount-max" className="text-xs font-normal text-muted-foreground">
                      At most
                    </Label>
                    <Input
                      id="rule-amount-max"
                      inputMode="decimal"
                      value={amountMaxDollars}
                      placeholder="(no limit)"
                      onChange={(e) => {
                        setAmountMaxDollars(e.target.value);
                      }}
                    />
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  Matches the transaction&rsquo;s size regardless of whether it&rsquo;s money in or out.
                  Leave a field blank for no limit on that side.
                </p>
              </div>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-auto gap-1 px-0 text-xs text-muted-foreground hover:bg-transparent hover:text-foreground"
                onClick={() => {
                  setAmountOpen(true);
                }}
              >
                <ChevronRight className="size-3.5" />
                Add amount condition
              </Button>
            )}

            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={busy || pattern.trim().length < 2}
                onClick={() => {
                  void add();
                }}
              >
                {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                Save rule
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setAdding(false);
                  setAmountOpen(false);
                  setAmountMinDollars('');
                  setAmountMaxDollars('');
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setAdding(true);
              }}
            >
              <Plus className="size-4" />
              New rule
            </Button>
            {rules !== null && rules.length > 0 ? (
              <Button
                variant={preview ? 'default' : 'outline'}
                size="sm"
                disabled={applying}
                onClick={() => {
                  void runApply();
                }}
              >
                {applying ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
                {preview
                  ? `Confirm: categorize ${String(preview.categorized)}, rename ${String(preview.renamed)}`
                  : 'Apply to existing…'}
              </Button>
            ) : null}
            {preview ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setPreview(null);
                }}
              >
                Cancel
              </Button>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
