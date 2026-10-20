"use client";

import { Suspense } from "react";

import { PageHeader } from "@/components/data/page";
import { TabList, TabPanel, Tabs } from "@/components/ui/misc";
import { useUrlState } from "@/hooks/use-url-state";

import { EntityExplorer } from "@/features/ownership/entity-explorer";
import { InterestsTable } from "@/features/ownership/interests-table";
import { LinkReviewQueue } from "@/features/ownership/link-review";

function OwnershipView() {
  const url = useUrlState();
  const tab = url.get("tab") ?? "interests";

  return (
    <>
      <PageHeader
        title="Ownership"
        description="Who owns and controls each property, with evidence, confidence and time-bound history."
      />
      <Tabs value={tab} onValueChange={(v) => url.replaceAll({ tab: v === "interests" ? null : v })}>
        <TabList
          className="mb-5"
          tabs={[
            { value: "interests", label: "Interests" },
            { value: "suggestions", label: "Link suggestions" },
            { value: "explorer", label: "Entity explorer" },
          ]}
        />
        <TabPanel value="interests">
          <InterestsTable />
        </TabPanel>
        <TabPanel value="suggestions">
          <LinkReviewQueue />
        </TabPanel>
        <TabPanel value="explorer">
          <EntityExplorer />
        </TabPanel>
      </Tabs>
    </>
  );
}

export default function OwnershipPage() {
  return (
    <Suspense>
      <OwnershipView />
    </Suspense>
  );
}
