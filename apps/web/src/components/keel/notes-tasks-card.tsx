'use client';

import { useMemo, useState } from 'react';
import { Archive, Check, ClipboardList, Loader2, Pin, Plus } from 'lucide-react';
import { toast } from 'sonner';

import { useKeelQuery } from '@/lib/use-keel-query';
import { archiveNote, saveNote, saveTask, setTaskStatus, type NoteTaskRow } from '@/lib/keel-api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';

function dueLabel(dueOn: string | null): string | null {
  if (!dueOn) return null;
  const date = new Date(`${dueOn}T00:00:00`);
  if (Number.isNaN(date.getTime())) return dueOn;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function NotesTasksCard({ householdId }: { householdId: string }) {
  const { rows, loading, error, refetch } = useKeelQuery<NoteTaskRow>(
    'notes_tasks.list',
    householdId,
  );
  const [noteBody, setNoteBody] = useState('');
  const [taskTitle, setTaskTitle] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const openTasks = useMemo(
    () => rows.filter((row) => row.type === 'task' && row.status === 'open'),
    [rows],
  );
  const notes = useMemo(() => rows.filter((row) => row.type === 'note'), [rows]);
  const previewRows = rows.slice(0, 6);

  async function refreshAfter(action: () => Promise<unknown>, success: string) {
    setBusy(success);
    try {
      await action();
      await refetch();
      toast.success(success);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Notes & tasks update failed.');
    } finally {
      setBusy(null);
    }
  }

  async function addNote() {
    const body = noteBody.trim();
    if (body.length === 0) return;
    await refreshAfter(() => saveNote({ householdId, body }), 'Note saved.');
    setNoteBody('');
  }

  async function addTask() {
    const title = taskTitle.trim();
    if (title.length === 0) return;
    await refreshAfter(() => saveTask({ householdId, title }), 'Task added.');
    setTaskTitle('');
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ClipboardList className="size-4 text-muted-foreground" />
          Notes & tasks
        </CardTitle>
        <CardAction>
          <Badge variant="secondary" className="font-normal">
            {String(openTasks.length)} open · {String(notes.length)} notes
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void addTask();
            }}
          >
            <Input
              value={taskTitle}
              onChange={(event) => {
                setTaskTitle(event.target.value);
              }}
              maxLength={160}
              placeholder="Task: Pay Alex back"
              aria-label="New task"
            />
            <Button
              type="submit"
              size="sm"
              disabled={taskTitle.trim().length === 0 || busy !== null}
            >
              {busy === 'Task added.' ? (
                <Loader2 data-icon="inline-start" className="animate-spin" />
              ) : (
                <Plus data-icon="inline-start" />
              )}
              Add task
            </Button>
          </form>
          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void addNote();
            }}
          >
            <Textarea
              value={noteBody}
              onChange={(event) => {
                setNoteBody(event.target.value);
              }}
              maxLength={1000}
              placeholder="Note: Xbox cash back expires this month"
              aria-label="New note"
              className="min-h-9"
            />
            <Button
              type="submit"
              variant="outline"
              size="sm"
              disabled={noteBody.trim().length === 0 || busy !== null}
            >
              {busy === 'Note saved.' ? (
                <Loader2 data-icon="inline-start" className="animate-spin" />
              ) : (
                <Plus data-icon="inline-start" />
              )}
              Add note
            </Button>
          </form>
        </div>

        <Separator />

        {loading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading notes and tasks…
          </p>
        ) : error ? (
          <p className="text-sm text-muted-foreground">{error}</p>
        ) : previewRows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Keep lightweight reminders next to your money: things to pay, cash-back windows, or
            small bookkeeping follow-ups.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {previewRows.map((row) =>
              row.type === 'task' ? (
                <div
                  key={`task-${row.id}`}
                  className="flex items-start justify-between gap-3 rounded-lg border px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{row.title}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <Badge
                        variant={row.priority === 'high' ? 'default' : 'outline'}
                        className="font-normal"
                      >
                        {row.priority}
                      </Badge>
                      {dueLabel(row.dueOn) ? (
                        <Badge variant="secondary" className="font-normal">
                          Due {dueLabel(row.dueOn)}
                        </Badge>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => {
                        void refreshAfter(
                          () => setTaskStatus({ householdId, taskId: row.id, status: 'done' }),
                          'Task completed.',
                        );
                      }}
                    >
                      <Check data-icon="inline-start" />
                      Done
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => {
                        void refreshAfter(
                          () => setTaskStatus({ householdId, taskId: row.id, status: 'dismissed' }),
                          'Task archived.',
                        );
                      }}
                    >
                      <Archive data-icon="inline-start" />
                      Archive
                    </Button>
                  </div>
                </div>
              ) : (
                <div
                  key={`note-${row.id}`}
                  className="flex items-start justify-between gap-3 rounded-lg border px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="line-clamp-2 text-sm text-muted-foreground">{row.body}</p>
                    {row.pinned ? (
                      <Badge variant="secondary" className="mt-1 font-normal">
                        <Pin className="size-3" />
                        Pinned
                      </Badge>
                    ) : null}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => {
                      void refreshAfter(
                        () => archiveNote({ householdId, noteId: row.id }),
                        'Note archived.',
                      );
                    }}
                  >
                    <Archive data-icon="inline-start" />
                    Archive
                  </Button>
                </div>
              ),
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
