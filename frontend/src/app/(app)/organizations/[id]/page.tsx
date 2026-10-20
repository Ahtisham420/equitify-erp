"use client";

import { Archive, ExternalLink, GitMerge, Lock, MoreHorizontal, Pencil } from "lucide-react";
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
import { ORG_TYPE_LABELS, STRENGTH_TONE, useOrganization, type Organization } from "@/features/contacts/api";
import { ContactPointsCard } from "@/features/contacts/contact-points";
import { ContextPanel } from "@/features/contacts/context-panel";
import { CompareDialog, MergeHistory } from "@/features/contacts/duplicate-review";
import { EnrichmentsCard } from "@/features/contacts/enrichments";
import { OrganizationFormSheet } from "@/features/contacts/organization-form";
import { OrganizationPicker } from "@/features/contacts/pickers";
import { RelationshipCard } from "@/features/contacts/relationship-card";
import { RecordInteractions } from "@/features/outreach/record-interactions";
import { OwnerSignals } from "@/features/signals/owner-signals";
import { RecordDocuments } from "@/features/documents/record-documents";
import { OwnerProfileView } from "@/features/ownership/owner-profile";
import { RelatedEntitiesCard } from "@/features/ownership/related-entities";

function Profile({ o }: { o: Organization }) {
  const { can } = useAuth();
  const site = o.website ? (o.website.startsWith("http") ? o.website : `https://${o.website}`) : null;
  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <div className="space-y-5 lg:col-span-2">
        <Card>
          <CardHeader title="Profile" />
          <CardBody>
            <FieldGrid cols={3}>
              <FieldItem label="Operating name">{o.name}</FieldItem>
              <FieldItem label="Legal name">{o.legal_name}</FieldItem>
              <FieldItem label="Type">{ORG_TYPE_LABELS[o.org_type] ?? titleCase(o.org_type)}</FieldItem>
              <FieldItem label="Website">
                {site ? (
                  <a href={site} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
                    {o.domain ?? o.website} <ExternalLink className="size-3" />
                  </a>
                ) : null}
              </FieldItem>
              <FieldItem label="Main phone" extra={o.masked ? <Lock className="size-3" /> : undefined}>
                {o.phone ? <span className="font-mono">{o.phone}</span> : null}
              </FieldItem>
              <FieldItem label="State of formation">{o.state_of_formation}</FieldItem>
              <FieldItem label="Mailing address" className="col-span-2" extra={o.masked ? <Lock className="size-3" /> : undefined}>
                {o.masked ? <span className="text-ink-3">Restricted</span> : [o.mailing_address, o.city, o.state, o.postal_code].filter(Boolean).join(", ")}
              </FieldItem>
              <FieldItem label="Registered agent">{o.registered_agent}</FieldItem>
              <FieldItem label="Source">{o.source}</FieldItem>
              <FieldItem label="Created">{formatDateTime(o.created_at)}</FieldItem>
              <FieldItem label="Updated">{formatDateTime(o.updated_at)}</FieldItem>
            </FieldGrid>
            {o.notes && <p className="mt-4 whitespace-pre-wrap border-t border-line pt-3 text-sm text-ink-2">{o.notes}</p>}
          </CardBody>
        </Card>
        <AffiliationsCard mode="organization" ownerId={o.id} items={o.members} />
        <ContactPointsCard kind="organization" ownerId={o.id} points={o.contact_points} masked={o.masked} />
      </div>
      <div className="space-y-5">
        <RelationshipCard kind="organization" id={o.id} record={o} />
        {can("ownership", "view") && <RelatedEntitiesCard id={o.id} />}
        {o.tags.length > 0 && (
          <Card>
            <CardHeader title="Tags" />
            <CardBody className="flex flex-wrap gap-1">
              {o.tags.map((t) => (
                <Badge key={t}>{t}</Badge>
              ))}
            </CardBody>
          </Card>
        )}
      </div>
    </div>
  );
}

function OrganizationDetail({ id }: { id: string }) {
  const router = useRouter();
  const url = useUrlState();
  const { can } = useAuth();
  const { data: o, isLoading, error } = useOrganization(id);
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
  if (error || !o) {
    return <EmptyState title="Organization not found" description={errorMessage(error)} action={<Link href="/organizations"><Button>Back to organizations</Button></Link>} />;
  }

  const archive = async () => {
    try {
      await api.delete(`/organizations/${id}`);
      toast.success("Organization archived");
      router.replace("/organizations");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const currentMembers = o.members.filter((m) => m.is_current).length;

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Organizations", href: "/organizations" }, { label: o.name }]}
        title={o.name}
        description={[o.legal_name && o.legal_name !== o.name ? o.legal_name : null, [o.city, o.state].filter(Boolean).join(", ")].filter(Boolean).join(" · ") || undefined}
        meta={
          <>
            <Badge tone="outline">{ORG_TYPE_LABELS[o.org_type] ?? titleCase(o.org_type)}</Badge>
            <Badge tone={STRENGTH_TONE[o.relationship_strength] ?? "neutral"} dot>{titleCase(o.relationship_strength)} relationship</Badge>
            <span className="text-xs text-ink-3">{currentMembers} {currentMembers === 1 ? "person" : "people"}</span>
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
                  <MenuItem icon={<GitMerge />} onSelect={() => setMergePick(true)}>Merge with another organization…</MenuItem>
                  {can("contacts", "delete") && (
                    <MenuItem icon={<Archive />} destructive onSelect={() => setArchiving(true)}>Archive organization</MenuItem>
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
          <Profile o={o} />
        </TabPanel>
        <TabPanel value="context">
          <div className="space-y-5">
            <ContextPanel kind="organization" id={id} />
            {can("signals") && <OwnerSignals kind="organization" ownerId={id} />}
            {can("documents") && <RecordDocuments entityType="organization" entityId={id} />}
          </div>
        </TabPanel>
        <TabPanel value="interactions">
          <RecordInteractions filter={{ organization_id: id }} />
        </TabPanel>
        {can("ownership", "view") && (
          <TabPanel value="ownership">
            <OwnerProfileView kind="organization" id={id} />
          </TabPanel>
        )}
        <TabPanel value="enrichment">
          <EnrichmentsCard kind="organization" id={id} />
        </TabPanel>
        <TabPanel value="activity">
          <Card>
            <CardBody>
              <RecordTimeline entityType="organization" entityId={id} />
            </CardBody>
          </Card>
        </TabPanel>
        <TabPanel value="merges">
          <Card className="overflow-hidden">
            <MergeHistory kind="organization" recordId={id} />
          </Card>
        </TabPanel>
      </Tabs>

      <OrganizationFormSheet open={editing} onOpenChange={setEditing} organization={o} />
      <ConfirmDialog
        open={archiving}
        onOpenChange={setArchiving}
        title="Archive this organization?"
        description="The record, its relationships and its history are retained. It will no longer appear in lists."
        confirmLabel="Archive"
        destructive
        onConfirm={archive}
      />
      <Dialog
        open={mergePick}
        onOpenChange={setMergePick}
        title="Merge with another organization"
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
        <OrganizationPicker value={mergeWith} onChange={setMergeWith} />
      </Dialog>
      <CompareDialog kind="organization" pair={pair} onOpenChange={(o2) => !o2 && setPair(null)} />
    </>
  );
}

export default function OrganizationPage({ params }: { params: { id: string } }) {
  return (
    <Suspense>
      <OrganizationDetail id={params.id} />
    </Suspense>
  );
}
