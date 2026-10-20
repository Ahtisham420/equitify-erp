"use client";

import { Plus } from "lucide-react";
import { Suspense, useState } from "react";

import { EmptyState, PageHeader } from "@/components/data/page";
import { Button } from "@/components/ui/button";
import { TabList, TabPanel, Tabs } from "@/components/ui/misc";
import { useUrlState } from "@/hooks/use-url-state";
import { useAuth } from "@/lib/auth";

import { BackupsTab } from "@/features/platform/backups-tab";
import { BusinessRulesTab } from "@/features/platform/business-rules-tab";
import { FlagsTab } from "@/features/platform/flags-tab";
import { IntegrationsTab } from "@/features/platform/integrations-tab";
import { ExportsTab, JobsTab } from "@/features/platform/monitoring-tabs";
import { OverviewTab } from "@/features/platform/overview-tab";
import { RetentionTab } from "@/features/platform/retention-tab";
import { WebhooksTab } from "@/features/platform/webhooks-tab";

const TABS = [
  { value: "overview", label: "Overview" },
  { value: "integrations", label: "Integrations" },
  { value: "flags", label: "Feature flags" },
  { value: "webhooks", label: "Webhooks" },
  { value: "jobs", label: "Jobs" },
  { value: "exports", label: "Exports" },
  { value: "retention", label: "Retention & legal holds" },
  { value: "backups", label: "Backups" },
  { value: "rules", label: "Business rules" },
];

function PlatformView() {
  const { can, loading } = useAuth();
  const url = useUrlState();
  const raw = url.get("tab");
  const tab = TABS.some((t) => t.value === raw) ? (raw as string) : "overview";
  const [creatingFlag, setCreatingFlag] = useState(false);
  const [creatingHook, setCreatingHook] = useState(false);
  const [creatingBackup, setCreatingBackup] = useState(false);
  const canAdmin = can("platform", "approve");

  if (!loading && !can("platform", "view")) {
    return <EmptyState title="No access" description="Platform administration requires the Platform & Integrations permission." />;
  }

  const action =
    !canAdmin ? undefined : tab === "flags" ? (
      <Button variant="primary" onClick={() => setCreatingFlag(true)}>
        <Plus /> New flag
      </Button>
    ) : tab === "webhooks" ? (
      <Button variant="primary" onClick={() => setCreatingHook(true)}>
        <Plus /> New subscription
      </Button>
    ) : tab === "backups" ? (
      <Button variant="primary" onClick={() => setCreatingBackup(true)}>
        <Plus /> Record backup
      </Button>
    ) : undefined;

  return (
    <>
      <PageHeader
        title="Platform"
        description="Integrations, security controls, jobs, webhooks, retention and recovery for every module."
        breadcrumbs={[{ label: "Admin" }, { label: "Platform" }]}
        actions={action}
      />
      <Tabs value={tab} onValueChange={(v) => url.replaceAll({ tab: v === "overview" ? null : v })}>
        <TabList className="mb-5 overflow-x-auto scrollbar-thin" tabs={TABS} />
        <TabPanel value="overview">{tab === "overview" && <OverviewTab />}</TabPanel>
        <TabPanel value="integrations">{tab === "integrations" && <IntegrationsTab />}</TabPanel>
        <TabPanel value="flags">{tab === "flags" && <FlagsTab creating={creatingFlag} onCreatingChange={setCreatingFlag} />}</TabPanel>
        <TabPanel value="webhooks">{tab === "webhooks" && <WebhooksTab creating={creatingHook} onCreatingChange={setCreatingHook} />}</TabPanel>
        <TabPanel value="jobs">{tab === "jobs" && <JobsTab />}</TabPanel>
        <TabPanel value="exports">{tab === "exports" && <ExportsTab />}</TabPanel>
        <TabPanel value="retention">{tab === "retention" && <RetentionTab />}</TabPanel>
        <TabPanel value="backups">{tab === "backups" && <BackupsTab creating={creatingBackup} onCreatingChange={setCreatingBackup} />}</TabPanel>
        <TabPanel value="rules">{tab === "rules" && <BusinessRulesTab />}</TabPanel>
      </Tabs>
    </>
  );
}

export default function PlatformPage() {
  return (
    <Suspense>
      <PlatformView />
    </Suspense>
  );
}
