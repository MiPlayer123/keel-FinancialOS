'use client';

import { PageHeader } from '@/components/keel/page-header';
import { useHousehold } from '@/components/keel/household-context';
import { NotesTasksCard } from '@/components/keel/notes-tasks-card';
import { Skeleton } from '@/components/ui/skeleton';

export default function NotesTasksPage() {
  return (
    <>
      <PageHeader
        title="Notes & tasks"
        description="Lightweight reminders next to your money — things to pay, cash-back windows, small bookkeeping follow-ups."
      />
      <div className="p-6">
        <NotesTasksBody />
      </div>
    </>
  );
}

function NotesTasksBody() {
  const { householdId, ready } = useHousehold();

  if (!ready || !householdId) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-11 w-full" />
        ))}
      </div>
    );
  }

  // The Home dashboard's card renders `compact` (active-only, capped at 6);
  // this dedicated page renders the same component uncapped and including
  // completed tasks, so "View all" from Home always has somewhere to land.
  return <NotesTasksCard householdId={householdId} />;
}
