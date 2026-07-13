'use client';

import { useEffect, useState } from 'react';
import { Tags, Plus, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { useHousehold } from '@/components/keel/household-context';
import { createCategory, fetchCategories, type CategoryRow } from '@/lib/keel-api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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

/**
 * Category manager, create-only slice. New categories appear in every picker
 * (ledger, rules, budgets) immediately. Rename/archive are deferred until
 * system categories get a stable key (PFC auto-categorization joins by name).
 */
export function CategoriesCard() {
  const { householdId } = useHousehold();
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'expense' | 'income'>('expense');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!householdId) return;
    let active = true;
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

  if (!householdId) return null;

  async function add() {
    if (!householdId || name.trim().length === 0) return;
    setBusy(true);
    try {
      await createCategory({ householdId, name: name.trim(), kind });
      toast.success(`Added ${name.trim()}. It's available in every picker now.`);
      setName('');
      setAdding(false);
      setCategories(await fetchCategories(householdId));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create the category.');
    } finally {
      setBusy(false);
    }
  }

  const expense = categories.filter((c) => c.kind === 'expense');
  const income = categories.filter((c) => c.kind === 'income');

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Tags className="size-4" />
          Categories
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {categories.length > 0 ? (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-1.5">
              {expense.map((c) => (
                <Badge key={c.ledgerAccountId} variant="secondary">
                  {c.name}
                </Badge>
              ))}
            </div>
            {income.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {income.map((c) => (
                  <Badge key={c.ledgerAccountId} variant="outline">
                    {c.name}
                  </Badge>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {adding ? (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="cat-name">Name</Label>
              <Input
                id="cat-name"
                value={name}
                maxLength={80}
                placeholder="e.g. Climbing, Pets, Side income"
                onChange={(e) => {
                  setName(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void add();
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select
                value={kind}
                onValueChange={(v) => {
                  if (v) setKind(v);
                }}
              >
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="expense">Spending</SelectItem>
                  <SelectItem value="income">Income</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={busy || name.trim().length === 0}
                onClick={() => {
                  void add();
                }}
              >
                {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                Add
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setAdding(false);
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setAdding(true);
            }}
          >
            <Plus className="size-4" />
            New category
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
