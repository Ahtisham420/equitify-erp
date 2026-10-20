"use client";

import { Suspense } from "react";

import { PageHeader } from "@/components/data/page";
import { TabList, TabPanel, Tabs } from "@/components/ui/misc";
import { useUrlState } from "@/hooks/use-url-state";

import { ComplianceTab } from "@/features/dealroom/compliance-tab";
import { RoomsTab } from "@/features/dealroom/rooms-tab";
import { ToursTab } from "@/features/dealroom/tours-tab";

const TABS = [
  { value: "tours", label: "Tours" },
  { value: "rooms", label: "Deal rooms" },
  { value: "compliance", label: "Compliance" },
];

function ToursView() {
  const url = useUrlState();
  const tab = url.get("tab") ?? "tours";

  return (
    <>
      <PageHeader
        title="Tours & deal rooms"
        description="Property tours with routing and feedback, controlled-access deal rooms, and brokerage compliance."
      />
      {/* Switching tabs resets list filters so they do not leak between different record types. */}
      <Tabs value={tab} onValueChange={(v) => url.replaceAll({ tab: v === "tours" ? null : v })}>
        <TabList className="mb-5" tabs={TABS} />
        <TabPanel value="tours">
          <ToursTab />
        </TabPanel>
        <TabPanel value="rooms">
          <RoomsTab />
        </TabPanel>
        <TabPanel value="compliance">
          <ComplianceTab />
        </TabPanel>
      </Tabs>
    </>
  );
}

export default function ToursPage() {
  return (
    <Suspense>
      <ToursView />
    </Suspense>
  );
}
