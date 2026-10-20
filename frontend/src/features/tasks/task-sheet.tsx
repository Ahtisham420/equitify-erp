"use client";

import { Check, Link2, Lock, RotateCcw, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { EntityPicker, UserPicker } from "@/components/data/entity-picker";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, Sheet } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { ApiError, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDateTime, isOverdue, titleCase } from "@/lib/utils";

import {
  RELATED_TYPES,
  TASK_PRIORITIES,
  TASK_TYPE_LABELS,
  TASK_TYPES,
  fromLocalInput,
  relatedHref,
  toLocalInput,
  useSaveTask,
  useTask,
  useTaskAction,
  type Task,
  type TaskInput,
} from "./api";
import { RelatedRecordPicker } from "./record-pickers";

interface FormState {
  title: string;
  description: string;
  task_type: string;
  priority: string;
  due_at: string;
  assignee_id: string | null;
  related_type: string;
  related_id: string | null;
  related_label: string | null;
  depends_on: string[];
}

function toForm(t?: Task | null, defaults?: Partial<TaskInput>): FormState {
  return {
    title: t?.title ?? defaults?.title ?? "",
    description: t?.description ?? defaults?.description ?? "",
    task_type: t?.task_type ?? defaults?.task_type ?? "general",
    priority: t?.priority ?? defaults?.priority ?? "normal",
    due_at: toLocalInput(t?.due_at ?? defaults?.due_at),
    assignee_id: t?.assignee_id ?? defaults?.assignee_id ?? null,
    related_type: t?.related_type ?? defaults?.related_type ?? "",
    related_id: t?.related_id ?? defaults?.related_id ?? null,
    related_label: t?.related_label ?? defaults?.related_label ?? null,
    depends_on: t?.depends_on ?? [],
  };
}

/** Prompts for a resolution note; required for cancellation, optional for completion. */
export function ResolveTaskDialog({
  task,
  action,
  onOpenChange,
}: {
  task: Pick<Task, "id" | "title"> | null;
  action: "complete" | "cancel";
  onOpenChange: (open: boolean) => void;
}) {
  const [note, setNote] = useState("");
  const run = useTaskAction();
  useEffect(() => setNote(""), [task]);
  const required = action === "cancel";
  return (
    <Dialog
      open={!!task}
      onOpenChange={onOpenChange}
      title={action === "complete" ? "Complete task" : "Cancel task"}
      description={task?.title}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Back</Button>
          <Button
            variant={action === "cancel" ? "danger" : "primary"}
            disabled={required && note.trim().length < 3}
            loading={run.isPending}
            onClick={() =>
              task &&
              run.mutate(
                { id: task.id, action, note: note.trim() || null },
                {
                  onSuccess: () => {
                    toast.success(action === "complete" ? "Task completed" : "Task cancelled");
                    onOpenChange(false);
                  },
                  onError: (e) => toast.error(taskErrorDetail(e)),
                },
              )
            }
          >
            {action === "complete" ? "Complete" : "Cancel task"}
          </Button>
        </>
      }
    >
      <Field label="Resolution note" required={required} hint={required ? "Explain why this work is no longer needed." : "Optional — what was done."}>
        <Textarea autoFocus value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </Dialog>
  );
}

export function TaskSheet({
  open,
  onOpenChange,
  taskId,
  defaults,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  taskId?: string | null;
  defaults?: Partial<TaskInput>;
}) {
  const { can } = useAuth();
  const { data: task } = useTask(open ? taskId : null);
  const editing = !!taskId;
  const [form, setForm] = useState<FormState>(toForm(null, defaults));
  const [resolve, setResolve] = useState<"complete" | "cancel" | null>(null);
  const [picked, setPicked] = useState<Record<string, Task>>({});
  const save = useSaveTask(taskId ?? undefined);
  const action = useTaskAction();
  const closed = task ? !["open", "in_progress"].includes(task.status) : false;
  const readOnly = closed || (editing ? !can("tasks", "edit") : !can("tasks", "create"));

  useEffect(() => {
    if (open) setForm(toForm(editing ? task : null, defaults));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, task?.id, task?.updated_at]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const data: TaskInput = {
      title: form.title.trim(),
      description: form.description.trim() || null,
      task_type: form.task_type,
      priority: form.priority,
      due_at: fromLocalInput(form.due_at),
      assignee_id: form.assignee_id,
      related_type: form.related_type || null,
      related_id: form.related_type ? form.related_id : null,
      related_label: form.related_type ? form.related_label : null,
      depends_on: form.depends_on,
    };
    save.mutate(data, {
      onSuccess: () => {
        toast.success(editing ? "Task updated" : "Task created");
        onOpenChange(false);
      },
      onError: (err) => toast.error(errorMessage(err)),
    });
  };

  const deps = task?.dependencies ?? [];
  const depLabel = (id: string): Pick<Task, "id" | "title" | "status" | "due_at"> | undefined => deps.find((d) => d.id === id) ?? picked[id];

  return (
    <>
      <Sheet
        open={open}
        onOpenChange={onOpenChange}
        title={editing ? task?.title ?? "Task" : "New task"}
        description={
          editing && task ? (
            <span className="flex flex-wrap items-center gap-2">
              <StatusBadge status={task.status} />
              {task.blocked && (
                <Badge tone="amber">
                  <Lock className="size-3" /> Blocked by dependencies
                </Badge>
              )}
              {task.escalation_level > 0 && <Badge tone="red">Escalated · level {task.escalation_level}</Badge>}
              <span className="text-xs text-ink-3">Source: {titleCase(task.source)}</span>
            </span>
          ) : (
            "Tasks are owned, dated and linked back to the record they came from."
          )
        }
        footer={
          <>
            {editing && task && !closed && can("tasks", "edit") && (
              <>
                <Button variant="ghost" onClick={() => setResolve("cancel")}>
                  <X /> Cancel task
                </Button>
                <Button onClick={() => setResolve("complete")} disabled={task.blocked}>
                  <Check /> Complete
                </Button>
              </>
            )}
            {editing && task && closed && can("tasks", "edit") && (
              <Button
                loading={action.isPending}
                onClick={() => action.mutate({ id: task.id, action: "reopen" }, { onError: (e) => toast.error(errorMessage(e)) })}
              >
                <RotateCcw /> Reopen
              </Button>
            )}
            {!readOnly && (
              <Button variant="primary" type="submit" form="task-form" loading={save.isPending} disabled={!form.title.trim()}>
                {editing ? "Save changes" : "Create task"}
              </Button>
            )}
          </>
        }
      >
        <form id="task-form" onSubmit={submit} className="space-y-4">
          <fieldset disabled={readOnly} className="space-y-4">
            <Field label="Title" required>
              <Input autoFocus value={form.title} onChange={(e) => set("title", e.target.value)} maxLength={300} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Type">
                <Select value={form.task_type} onChange={(e) => set("task_type", e.target.value)} options={TASK_TYPES.map((t) => ({ value: t, label: TASK_TYPE_LABELS[t] }))} />
              </Field>
              <Field label="Priority">
                <Select value={form.priority} onChange={(e) => set("priority", e.target.value)} options={TASK_PRIORITIES.map((p) => ({ value: p, label: titleCase(p) }))} />
              </Field>
              <Field label="Due">
                <Input type="datetime-local" value={form.due_at} onChange={(e) => set("due_at", e.target.value)} />
              </Field>
              <Field label="Owner">
                <UserPicker value={form.assignee_id} onChange={(id) => set("assignee_id", id)} placeholder={editing ? "Unassigned" : "Me"} />
              </Field>
            </div>
            <div className="grid grid-cols-[150px_1fr] gap-3">
              <Field label="Related record">
                <Select
                  value={form.related_type}
                  onChange={(e) => setForm((f) => ({ ...f, related_type: e.target.value, related_id: null, related_label: null }))}
                  placeholder="None"
                  options={RELATED_TYPES.map((t) => ({ value: t, label: titleCase(t) }))}
                />
              </Field>
              <Field label=" ">
                {form.related_type ? (
                  <RelatedRecordPicker
                    type={form.related_type}
                    value={form.related_id}
                    onChange={(id, label) => setForm((f) => ({ ...f, related_id: id, related_label: label }))}
                  />
                ) : (
                  <p className="flex h-8 items-center text-xs text-ink-3">Link the task to the record it belongs to.</p>
                )}
              </Field>
            </div>
            {editing && task?.related_id && (
              <p className="text-xs text-ink-3">
                Linked to{" "}
                {relatedHref(task.related_type, task.related_id) ? (
                  <Link className="font-medium text-accent hover:underline" href={relatedHref(task.related_type, task.related_id)!}>
                    {task.related_label ?? titleCase(task.related_type)}
                  </Link>
                ) : (
                  task.related_label
                )}
              </p>
            )}
            <Field label="Description">
              <Textarea value={form.description} onChange={(e) => set("description", e.target.value)} rows={4} />
            </Field>

            <section className="space-y-2">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-medium text-ink-2">Depends on</h4>
                <span className="text-2xs text-ink-3">Cannot be completed while a dependency is open</span>
              </div>
              {form.depends_on.length === 0 && <p className="text-xs text-ink-3">No dependencies.</p>}
              <ul className="space-y-1">
                {form.depends_on.map((id) => {
                  const d = depLabel(id);
                  return (
                    <li key={id} className="flex items-center gap-2 rounded-md border border-line px-2.5 py-1.5 text-sm">
                      <Link2 className="size-3.5 text-ink-3" />
                      <span className="min-w-0 flex-1 truncate">{d?.title ?? "Task"}</span>
                      {d && <StatusBadge status={d.status} />}
                      {d?.due_at && <span className={isOverdue(d.due_at) && ["open", "in_progress"].includes(d.status) ? "text-xs text-negative" : "text-xs text-ink-3"}>{formatDateTime(d.due_at)}</span>}
                      {!readOnly && (
                        <button type="button" className="rounded p-0.5 text-ink-3 hover:bg-muted hover:text-ink" onClick={() => set("depends_on", form.depends_on.filter((x) => x !== id))} aria-label="Remove dependency">
                          <X className="size-3.5" />
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
              {!readOnly && (
                <EntityPicker<Task>
                  endpoint="/tasks"
                  value={null}
                  placeholder="Add a dependency…"
                  onChange={(id, item) => {
                    if (!id || !item || id === taskId || form.depends_on.includes(id)) return;
                    setPicked((p) => ({ ...p, [id]: item }));
                    set("depends_on", [...form.depends_on, id]);
                  }}
                  toOption={(t) => ({ id: t.id, label: t.title, sublabel: `${titleCase(t.status)}${t.due_at ? ` · due ${formatDateTime(t.due_at)}` : ""}` })}
                />
              )}
            </section>
          </fieldset>

          {task?.resolution_note && (
            <div className="rounded-lg border border-line bg-subtle/60 p-3 text-sm">
              <p className="text-xs font-medium text-ink-3">Resolution · {formatDateTime(task.completed_at)}</p>
              <p className="mt-1 whitespace-pre-wrap text-ink-2">{task.resolution_note}</p>
            </div>
          )}
          {editing && task && (
            <p className="text-xs text-ink-3">
              Created {formatDateTime(task.created_at)} · updated {formatDateTime(task.updated_at)}
            </p>
          )}
        </form>
      </Sheet>
      <ResolveTaskDialog task={resolve && task ? task : null} action={resolve ?? "complete"} onOpenChange={(o) => !o && setResolve(null)} />
    </>
  );
}

export function taskErrorDetail(err: unknown): string {
  if (err instanceof ApiError && err.detail && typeof err.detail === "object" && "open_dependencies" in (err.detail as object)) {
    const deps = (err.detail as { open_dependencies: { title: string }[] }).open_dependencies;
    return `Complete first: ${deps.map((d) => d.title).join(", ")}`;
  }
  return errorMessage(err);
}
