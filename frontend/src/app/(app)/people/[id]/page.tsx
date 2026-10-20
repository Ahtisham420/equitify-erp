"use client";

import { Archive, GitMerge, Lock, MoreHorizontal, Pencil } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense, useState } from "react";
import { toast } from "sonner";

import { EmptyState, FieldGrid, FieldItem, PageHeader } from "@/components/data/page";
import { RecordTimeline } from "@/components/data/timeline";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { Skeleton, TabList, TabPanel, Tabs } from "@/components/ui/misc";
import { useUrlState } from "@/hooks/use-url-state";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDateTime, titleCase } from "@/lib/utils";

import { AffiliationsCard } from "@/features/contacts/affiliations";
import { ROLE_LABELS, STRENGTH_TONE, usePerson, type Person } from "@/features/contacts/api";
import { ContactPointsCard } from "@/features/contacts/contact-points";
import { ContextPanel } from "@/features/contacts/context-panel";
import { CompareDialog, MergeHistory } from "@/features/contacts/duplicate-review";
import { EnrichmentsCard } from "@/features/contacts/enrichments";
import { PersonFormSheet } from "@/features/contacts/person-form";
import { PersonPicker } from "@/features/contacts/pickers";
import { RelationshipCard } from "@/features/contacts/relationship-card";
import { RecordInteractions } from "@/features/outreach/record-interactions";
import { OwnerSignals } from "@/features/signals/owner-signals";
import { TalkingPoints } from "@/features/platform/talking-points";
import { RecordDocuments } from "@/features/documents/record-documents";
import { OwnerProfileView } from "@/features/ownership/owner-profile";

function Profile({ p }: { p: Person }) {
  const prefs = Object.entries(p.contact_preferences ?? {}).filter(([, v]) => v !== null && v !== "" && v !== undefined);
  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <div className="space-y-5 lg:col-span-2">
        <Card>
          <CardHeader title="Profile" />
          <CardBody>
            <FieldGrid cols={3}>
              <FieldItem label="First name">{p.first_name}</FieldItem>
              <FieldItem label="Last name">{p.last_name}</FieldItem>
              <FieldItem label="Title">{p.title}</FieldItem>
              <FieldItem label="Mailing address" className="col-span-2" extra={p.masked ? <Lock className="size-3" /> : undefined}>
                {p.masked ? <span className="text-ink-3">Restricted</span> : p.mailing_address}
              </FieldItem>
              <FieldItem label="City / state">{[p.city, p.state, p.masked ? null : p.postal_code].filter(Boolean).join(", ")}</FieldItem>
              <FieldItem label="Source">{p.source}</FieldItem>
              <FieldItem label="Created">{formatDateTime(p.created_at)}</FieldItem>
              <FieldItem label="Updated">{formatDateTime(p.updated_at)}</FieldItem>
            </FieldGrid>
            {prefs.length > 0 && (
              <div className="mt-4 border-t border-line pt-3">
                <p className="mb-1 text-xs text-ink-3">Contact preferences</p>
                <div className="flex flex-wrap gap-1">
                  {prefs.map(([k, v]) => (
                    <Badge key={k} tone="outline">{titleCase(k)}: {titleCase(String(v))}</Badge>
                  ))}
                </div>
              </div>
            )}
            {p.notes && <p className="mt-4 whitespace-pre-wrap border-t border-line pt-3 text-sm text-ink-2">{p.notes}</p>}
          </CardBody>
        </Card>
        <ContactPointsCard kind="person" ownerId={p.id} points={p.contact_points} compliance={p.compliance} masked={p.masked} />
        <AffiliationsCard mode="person" ownerId={p.id} items={p.affiliations} />
      </div>
      <div className="space-y-5">
        <RelationshipCard kind="person" id={p.id} record={p} />
        {p.tags.length > 0 && (
          <Card>
            <CardHeader title="Tags" />
            <CardBody className="flex flex-wrap gap-1">
              {p.tags.map((t) => (
                <Badge key={t}>{t}</Badge>
              ))}
            </CardBody>
          </Card>
        )}
      </div>
    </div>
  );
}

function PersonDetail({ id }: { id: string }) {
  const router = useRouter();
  const url = useUrlState();
  const { can } = useAuth();
  const { data: p, isLoading, error } = usePerson(id);
  const [editing, setEditing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [mergePick, setMergePick] = useState(false);
  const [mergeWith, setMergeWith] = useState<string | null>(null);
  const [pair, setPair] = useState<{ a: string; b: string } | null>(null);
  const tab = url.get("tab") ?? "overview";

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-7 w-80" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (error || !p) {
    return <EmptyState title="Person not found" description={errorMessage(error)} action={<Link href="/people"><Button>Back to people</Button></Link>} />;
  }

  const archive = async () => {
    try {
      await api.delete(`/people/${id}`);
      toast.success("Person archived");
      router.replace("/people");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const currentOrgs = p.affiliations.filter((a) => a.is_current);
  const roles = Array.from(new Set(currentOrgs.map((a) => a.role)));

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "People", href: "/people" }, { label: p.full_name }]}
        title={p.full_name}
        description={[p.title, currentOrgs[0]?.organization_name, [p.city, p.state].filter(Boolean).join(", ")].filter(Boolean).join(" · ") || undefined}
        meta={
          <>
            {roles.map((r) => (
              <Badge key={r} tone="outline">{ROLE_LABELS[r] ?? r}</Badge>
            ))}
            <Badge tone={STRENGTH_TONE[p.relationship_strength] ?? "neutral"} dot>{titleCase(p.relationship_strength)} relationship</Badge>
            {p.masked && (
              <Badge tone="neutral">
                <Lock className="size-3" /> Contact details masked
              </Badge>
            )}
          </>
        }
        actions={
          can("contacts", "edit") && (
            <>
              <Button variant="primary" onClick={() => setEditing(true)}>
                <Pencil /> Edit
              </Button>
              <Menu>
                <MenuTrigger asChild>
                  <Button size="icon" aria-label="More actions">
                    <MoreHorizontal />
                  </Button>
                </MenuTrigger>
                <MenuContent>
                  <MenuItem icon={<GitMerge />} onSelect={() => setMergePick(true)}>Merge with another person…</MenuItem>
                  {can("contacts", "delete") && (
                    <MenuItem icon={<Archive />} destructive onSelect={() => setArchiving(true)}>Archive person</MenuItem>
                  )}
                </MenuContent>
              </Menu>
            </>
          )
        }
      />

      <Tabs value={tab} onValueChange={(v) => url.set({ tab: v === "overview" ? null : v })}>
        <TabList
          className="mb-5"
          tabs={[
            { value: "overview", label: "Overview" },
            { value: "context", label: "Portfolio & deals" },
            ...(can("outreach") ? [{ value: "interactions", label: "Interactions" }] : []),
            ...(can("ownership", "view") ? [{ value: "ownership", label: "Ownership intelligence" }] : []),
            { value: "enrichment", label: "Enrichment" },
            { value: "activity", label: "Activity" },
            { value: "merges", label: "Merge history" },
          ]}
        />
        <TabPanel value="overview">
          <Profile p={p} />
        </TabPanel>
        <TabPanel value="context">
          <div className="space-y-5">
            <ContextPanel kind="person" id={id} />
            {can("signals") && <OwnerSignals kind="person" ownerId={id} />}
            {can("documents") && <RecordDocuments entityType="person" entityId={id} />}
          </div>
        </TabPanel>
        <TabPanel value="interactions">
          <div className="grid gap-5 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <RecordInteractions filter={{ person_id: id }} />
            </div>
            <TalkingPoints personId={id} />
          </div>
        </TabPanel>
        {can("ownership", "view") && (
          <TabPanel value="ownership">
            <OwnerProfileView kind="person" id={id} />
          </TabPanel>
        )}
        <TabPanel value="enrichment">
          <EnrichmentsCard kind="person" id={id} />
        </TabPanel>
        <TabPanel value="activity">
          <Card>
            <CardBody>
              <RecordTimeline entityType="person" entityId={id} />
            </CardBody>
          </Card>
        </TabPanel>
        <TabPanel value="merges">
          <Card className="overflow-hidden">
            <MergeHistory kind="person" recordId={id} />
          </Card>
        </TabPanel>
      </Tabs>

      <PersonFormSheet open={editing} onOpenChange={setEditing} person={p} />
      <ConfirmDialog
        open={archiving}
        onOpenChange={setArchiving}
        title="Archive this person?"
        description="The record, its interactions and its history are retained. It will no longer appear in lists."
        confirmLabel="Archive"
        destructive
        onConfirm={archive}
      />
      <Dialog
        open={mergePick}
        onOpenChange={setMergePick}
        title="Merge with another person"
        description="Pick the record that duplicates this one. You will compare both before anything changes."
        footer={
          <>
            <Button onClick={() => setMergePick(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!mergeWith || mergeWith === id}
              onClick={() => {
                if (mergeWith) setPair({ a: id, b: mergeWith });
                setMergePick(false);
                setMergeWith(null);
              }}
            >
              Compare
            </Button>
          </>
        }
      >
        <PersonPicker value={mergeWith} onChange={setMergeWith} />
      </Dialog>
      <CompareDialog kind="person" pair={pair} onOpenChange={(o) => !o && setPair(null)} />
    </>
  );
}

export default function PersonPage({ params }: { params: { id: string } }) {
  return (
    <Suspense>
      <PersonDetail id={params.id} />
    </Suspense>
  );
}
