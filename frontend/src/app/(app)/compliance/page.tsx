"use client";

import { Plus } from "lucide-react";
import { Suspense, useState } from "react";

import { PageHeader } from "@/components/data/page";
import { Button } from "@/components/ui/button";
import { TabList, TabPanel, Tabs } from "@/components/ui/misc";
import { useUrlState } from "@/hooks/use-url-state";
import { useAuth } from "@/lib/auth";

import { CheckTab } from "@/features/compliance/check-tab";
import { ConsentTab } from "@/features/compliance/consent-tab";
import { OutboundTab } from "@/features/compliance/outbound-tab";
import { RecordsTab } from "@/features/compliance/records-tab";
import { SettingsTab } from "@/features/compliance/settings-tab";

const TABS = ["records", "check", "consent", "outbound", "settings"] as const;

function ComplianceView() {
  const { can } = useAuth();
  const url = useUrlState();
  const raw = url.get("tab");
  const tab = TABS.includes(raw as (typeof TABS)[number]) ? (raw as string) : "records";
  const [creating, setCreating] = useState(false);

  return (
    <>
      <PageHeader
        title="Communication compliance"
        description="Calling and texting restrictions enforced at send time — not left to memory."
        actions={
          tab === "records" && can("compliance", "edit") ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus /> Add record
            </Button>
          ) : undefined
        }
      />
      <Tabs value={tab} onValueChange={(v) => url.replaceAll({ tab: v === "records" ? null : v })}>
        <TabList
          className="mb-5"
          tabs={[
            { value: "records", label: "Records" },
            { value: "check", label: "Check" },
            { value: "consent", label: "Consent & opt-outs" },
            { value: "outbound", label: "Outbound log" },
            { value: "settings", label: "Settings" },
          ]}
        />
        <TabPanel value="records">{tab === "records" && <RecordsTab creating={creating} onCreatingChange={setCreating} />}</TabPanel>
        <TabPanel value="check">{tab === "check" && <CheckTab />}</TabPanel>
        <TabPanel value="consent">{tab === "consent" && <ConsentTab />}</TabPanel>
        <TabPanel value="outbound">{tab === "outbound" && <OutboundTab />}</TabPanel>
        <TabPanel value="settings">{tab === "settings" && <SettingsTab />}</TabPanel>
      </Tabs>
    </>
  );
}

export default function CompliancePage() {
  return (
    <Suspense>
      <ComplianceView />
    </Suspense>
  );
}
