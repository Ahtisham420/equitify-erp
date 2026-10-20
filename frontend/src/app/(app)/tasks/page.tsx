"use client";

import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { Suspense, useState } from "react";

import { PageHeader } from "@/components/data/page";
import { Button } from "@/components/ui/button";
import { TabList, TabPanel, Tabs } from "@/components/ui/misc";
import { useUrlState } from "@/hooks/use-url-state";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";

import { AlertsTab } from "@/features/tasks/alerts-tab";
import { AutomationTab } from "@/features/tasks/automation-tab";
import { SubscriptionsTab } from "@/features/tasks/subscriptions-tab";
import { TasksTab } from "@/features/tasks/tasks-tab";

const TABS = ["tasks", "alerts", "automation", "subscriptions"] as const;

function TasksView() {
  const { can } = useAuth();
  const url = useUrlState();
  const raw = url.get("tab");
  const tab = TABS.includes(raw as (typeof TABS)[number]) ? (raw as string) : "tasks";
  const [creatingTask, setCreatingTask] = useState(false);
  const [creatingSub, setCreatingSub] = useState(false);
  const { data: summary } = useQuery({
    queryKey: ["alerts", "summary"],
    queryFn: () => api.get<{ open: number; critical: number }>("/alerts/summary"),
  });

  return (
    <>
      <PageHeader
        title="Tasks & alerts"
        description="Events and deadlines turned into owned work. Alerts are worked to a recorded resolution."
        actions={
          tab === "tasks" && can("tasks", "create") ? (
            <Button variant="primary" onClick={() => setCreatingTask(true)}>
              <Plus /> New task
            </Button>
          ) : tab === "subscriptions" ? (
            <Button variant="primary" onClick={() => setCreatingSub(true)}>
              <Plus /> New subscription
            </Button>
          ) : undefined
        }
      />
      <Tabs value={tab} onValueChange={(v) => url.replaceAll({ tab: v === "tasks" ? null : v })}>
        <TabList
          className="mb-5"
          tabs={[
            { value: "tasks", label: "Tasks" },
            { value: "alerts", label: "Alerts", count: summary?.open },
            { value: "automation", label: "Automation" },
            { value: "subscriptions", label: "Subscriptions" },
          ]}
        />
        <TabPanel value="tasks">{tab === "tasks" && <TasksTab creating={creatingTask} onCreatingChange={setCreatingTask} />}</TabPanel>
        <TabPanel value="alerts">{tab === "alerts" && <AlertsTab />}</TabPanel>
        <TabPanel value="automation">{tab === "automation" && <AutomationTab />}</TabPanel>
        <TabPanel value="subscriptions">{tab === "subscriptions" && <SubscriptionsTab creating={creatingSub} onCreatingChange={setCreatingSub} />}</TabPanel>
      </Tabs>
    </>
  );
}

export default function TasksPage() {
  return (
    <Suspense>
      <TasksView />
    </Suspense>
  );
}
