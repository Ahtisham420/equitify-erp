"use client";

import { ScanSearch } from "lucide-react";
import { Suspense } from "react";
import { toast } from "sonner";

import { PageHeader } from "@/components/data/page";
import { Button } from "@/components/ui/button";
import { TabList, TabPanel, Tabs } from "@/components/ui/misc";
import { useUrlState } from "@/hooks/use-url-state";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";

import { useScan } from "@/features/reactivation/api";
import { AnalyticsTab } from "@/features/reactivation/analytics-tab";
import { QueueTab } from "@/features/reactivation/queue-tab";
import { TriggersTab } from "@/features/reactivation/triggers-tab";

const TABS = ["queue", "triggers", "analytics"] as const;

function ReactivationView() {
  const { can } = useAuth();
  const url = useUrlState();
  const raw = url.get("tab");
  const tab = TABS.includes(raw as (typeof TABS)[number]) ? (raw as string) : "queue";
  const scan = useScan();

  return (
    <>
      <PageHeader
        title="Reactivation"
        description="Dead deals come back with their original context when the reason they died may no longer apply."
        actions={
          can("reactivation", "approve") ? (
            <Button
              loading={scan.isPending}
              onClick={() =>
                scan.mutate(undefined, {
                  onSuccess: (r) => toast.success(`${r.checked} triggers checked · ${r.fired} fired · ${r.woken} snoozed items returned`),
                  onError: (e) => toast.error(errorMessage(e)),
                })
              }
            >
              <ScanSearch /> Run scan
            </Button>
          ) : undefined
        }
      />
      <Tabs value={tab} onValueChange={(v) => url.replaceAll({ tab: v === "queue" ? null : v })}>
        <TabList
          className="mb-5"
          tabs={[
            { value: "queue", label: "Queue" },
            { value: "triggers", label: "Triggers" },
            { value: "analytics", label: "Analytics" },
          ]}
        />
        <TabPanel value="queue">{tab === "queue" && <QueueTab />}</TabPanel>
        <TabPanel value="triggers">{tab === "triggers" && <TriggersTab />}</TabPanel>
        <TabPanel value="analytics">{tab === "analytics" && <AnalyticsTab />}</TabPanel>
      </Tabs>
    </>
  );
}

export default function ReactivationPage() {
  return (
    <Suspense>
      <ReactivationView />
    </Suspense>
  );
}
