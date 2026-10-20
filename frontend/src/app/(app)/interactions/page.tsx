"use client";

import { Suspense } from "react";

import { PageHeader } from "@/components/data/page";
import { TabList, TabPanel, Tabs } from "@/components/ui/misc";
import { useUrlState } from "@/hooks/use-url-state";
import { useAuth } from "@/lib/auth";

import { InteractionsLog } from "@/features/outreach/interactions-log";
import { SequencesTab } from "@/features/outreach/sequences-tab";
import { TeamActivity } from "@/features/outreach/team-activity";

function InteractionsView() {
  const { can } = useAuth();
  const url = useUrlState();
  const manager = can("outreach", "approve");
  const raw = url.get("tab");
  const tab = raw === "sequences" || (raw === "team" && manager) ? raw : "log";

  return (
    <>
      <PageHeader title="Interactions" description="Every call, email, text, meeting, tour, letter and note — and what happens next." />
      <Tabs value={tab} onValueChange={(v) => url.replaceAll({ tab: v === "log" ? null : v })}>
        <TabList
          className="mb-5"
          tabs={[
            { value: "log", label: "Log" },
            { value: "sequences", label: "Sequences" },
            ...(manager ? [{ value: "team", label: "Team activity" }] : []),
          ]}
        />
        <TabPanel value="log">{tab === "log" && <InteractionsLog />}</TabPanel>
        <TabPanel value="sequences">{tab === "sequences" && <SequencesTab />}</TabPanel>
        {manager && <TabPanel value="team">{tab === "team" && <TeamActivity />}</TabPanel>}
      </Tabs>
    </>
  );
}

export default function InteractionsPage() {
  return (
    <Suspense>
      <InteractionsView />
    </Suspense>
  );
}
