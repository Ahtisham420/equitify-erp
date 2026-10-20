"use client";

import { Suspense } from "react";

import { PageHeader } from "@/components/data/page";
import { TabList, TabPanel, Tabs } from "@/components/ui/misc";
import { useUrlState } from "@/hooks/use-url-state";

import { useWorkspace } from "@/features/brokerage/api";
import { ProposalsTab, RecruitingTab, RepAgreementsTab, RequirementsTab } from "@/features/brokerage/crm-tabs";
import { DealsTab } from "@/features/brokerage/deals-tab";
import { ProspectsTab } from "@/features/brokerage/prospects-tab";

const TABS = [
  { value: "prospects", label: "Prospects" },
  { value: "agreements", label: "Rep agreements" },
  { value: "requirements", label: "Requirements & matches" },
  { value: "proposals", label: "Proposals" },
  { value: "deals", label: "Deals" },
  { value: "recruiting", label: "Recruiting" },
];

function BrokerageView() {
  const url = useUrlState();
  const tab = url.get("tab") ?? "prospects";
  const ws = useWorkspace({});
  const meta = ws.data
    ? [
        `${Object.entries(ws.data.prospects_by_stage).filter(([s]) => s !== "lost").reduce((a, [, n]) => a + n, 0)} open prospects`,
        `${(ws.data.listings_by_status.active ?? 0) + (ws.data.listings_by_status.coming_soon ?? 0)} live listings`,
        `${ws.data.open_inquiries} open inquiries`,
        `${ws.data.upcoming_showings} upcoming showings`,
      ]
    : [];

  return (
    <>
      <PageHeader
        title="Brokerage CRM"
        description="Prospecting, representation, requirements, proposals and your personal deal pipeline on the shared property and contact records."
        meta={meta.length ? <span className="text-xs text-ink-3">My workspace: {meta.join(" · ")}</span> : undefined}
      />
      {/* Switching tabs resets list filters so they do not leak between different record types. */}
      <Tabs value={tab} onValueChange={(v) => url.replaceAll({ tab: v === "prospects" ? null : v })}>
        <TabList className="mb-5" tabs={TABS} />
        <TabPanel value="prospects">
          <ProspectsTab />
        </TabPanel>
        <TabPanel value="agreements">
          <RepAgreementsTab />
        </TabPanel>
        <TabPanel value="requirements">
          <RequirementsTab />
        </TabPanel>
        <TabPanel value="proposals">
          <ProposalsTab />
        </TabPanel>
        <TabPanel value="deals">
          <DealsTab />
        </TabPanel>
        <TabPanel value="recruiting">
          <RecruitingTab />
        </TabPanel>
      </Tabs>
    </>
  );
}

export default function BrokeragePage() {
  return (
    <Suspense>
      <BrokerageView />
    </Suspense>
  );
}
