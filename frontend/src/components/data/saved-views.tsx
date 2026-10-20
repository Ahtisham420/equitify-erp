"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bookmark, Globe2, Lock, Plus, Trash2, Users } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { useUrlState } from "@/hooks/use-url-state";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";

export interface SavedView {
  id: string;
  name: string;
  module: string;
  params: Record<string, string | string[]>;
  visibility: "private" | "team" | "company";
  owner_id: string;
  is_default: boolean;
}

const VIS_ICON = { private: Lock, team: Users, company: Globe2 };

/** Save and re-apply the current URL filter state for a list. */
export function SavedViewsMenu({ module }: { module: string }) {
  const url = useUrlState();
  const qc = useQueryClient();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<SavedView["visibility"]>("private");

  const { data: views = [] } = useQuery({
    queryKey: ["saved-views", module],
    queryFn: () => api.get<SavedView[]>("/saved-views", { module }),
    staleTime: 60_000,
  });

  const create = useMutation({
    mutationFn: () => {
      const { page: _page, ...params } = url.params;
      return api.post<SavedView>("/saved-views", { name, module, params, visibility });
    },
    onSuccess: () => {
      toast.success("View saved");
      setOpen(false);
      setName("");
      qc.invalidateQueries({ queryKey: ["saved-views", module] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/saved-views/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["saved-views", module] }),
    onError: (e) => toast.error(errorMessage(e)),
  });

  const hasFilters = Object.keys(url.params).some((k) => !["page", "page_size"].includes(k));

  return (
    <>
      <Menu>
        <MenuTrigger asChild>
          <Button variant="secondary">
            <Bookmark />
            Views
          </Button>
        </MenuTrigger>
        <MenuContent width={260}>
          <MenuLabel>Saved views</MenuLabel>
          {views.length === 0 && <p className="px-2 py-2 text-xs text-ink-3">No saved views yet</p>}
          {views.map((v) => {
            const Icon = VIS_ICON[v.visibility] ?? Lock;
            return (
              <div key={v.id} className="group flex items-center">
                <div className="flex-1">
                  <MenuItem icon={<Icon />} onSelect={() => url.replaceAll(v.params)}>
                    {v.name}
                  </MenuItem>
                </div>
                {v.owner_id === user?.id && (
                  <button
                    onClick={() => remove.mutate(v.id)}
                    className="mr-1 hidden rounded p-1 text-ink-3 hover:bg-muted hover:text-negative group-hover:block"
                    aria-label={`Delete ${v.name}`}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                )}
              </div>
            );
          })}
          <MenuSeparator />
          <MenuItem icon={<Plus />} disabled={!hasFilters} onSelect={() => setOpen(true)}>
            Save current view…
          </MenuItem>
        </MenuContent>
      </Menu>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Save view"
        description="Saves the current search, filters and sort so you can reuse them."
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" disabled={!name.trim()} loading={create.isPending} onClick={() => create.mutate()}>
              Save view
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Name" required>
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Texas STNL under $5M" />
          </Field>
          <Field label="Visibility">
            <Select
              value={visibility}
              onChange={(e) => setVisibility(e.target.value as SavedView["visibility"])}
              options={[
                { value: "private", label: "Only me" },
                { value: "team", label: "My team" },
                { value: "company", label: "Everyone" },
              ]}
            />
          </Field>
        </div>
      </Dialog>
    </>
  );
}
