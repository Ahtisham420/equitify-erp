"use client";

import { Download } from "lucide-react";
import { Suspense } from "react";
import { toast } from "sonner";

import { PageHeader } from "@/components/data/page";
import { Button } from "@/components/ui/button";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu";
import { TabList, TabPanel, Tabs } from "@/components/ui/misc";
import { useUrlState } from "@/hooks/use-url-state";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";

import {
  BacklogTable,
  CompletenessPanel,
  DuplicatesList,
  QualityStats,
  StaleTable,
  ThresholdsEditor,
  useQualitySummary,
} from "@/features/imports/data-quality";

const EXPORTS = [
  { entity: "properties", label: "Properties", module: "properties" },
  { entity: "people", label: "People", module: "contacts" },
  { entity: "organizations", label: "Organizations", module: "contacts" },
  { entity: "tasks", label: "Tasks", module: "tasks" },
] as const;

function DataQualityView() {
  const { can } = useAuth();
  const url = useUrlState();
  const tab = url.get("tab") ?? "backlog";
  const { data } = useQualitySummary();
  const exports = EXPORTS.filter((e) => can(e.module, "export"));

  const download = async (entity: string) => {
    try {
      await api.download("/exports/core", { entity }, `${entity}.csv`);
      toast.success("Export downloaded");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <>
      <PageHeader
        title="Data quality"
        description="Completeness, verification backlog, stale facts and duplicate rate across the property master."
        actions={
          exports.length > 0 && (
            <Menu>
              <MenuTrigger asChild>
                <Button>
                  <Download />
                  Export core data
                </Button>
              </MenuTrigger>
              <MenuContent>
                <MenuLabel>Complete CSV export</MenuLabel>
                {exports.map((e) => (
                  <MenuItem key={e.entity} onSelect={() => download(e.entity)}>
                    {e.label}
                  </MenuItem>
                ))}
              </MenuContent>
            </Menu>
          )
        }
      />

      <div className="space-y-5">
        <QualityStats data={data} />
        <CompletenessPanel data={data} />

        <Tabs value={tab} onValueChange={(v) => url.replaceAll({ tab: v === "backlog" ? null : v })}>
          <TabList
            className="mb-4"
            tabs={[
              { value: "backlog", label: "Verification backlog", count: data?.verification_backlog },
              { value: "stale", label: "Stale facts", count: data?.stale_total },
              { value: "duplicates", label: "Duplicates", count: data?.duplicate_groups },
              { value: "thresholds", label: "Thresholds" },
            ]}
          />
          <TabPanel value="backlog">
            <BacklogTable />
          </TabPanel>
          <TabPanel value="stale">
            <StaleTable summary={data} />
          </TabPanel>
          <TabPanel value="duplicates">
            <DuplicatesList />
          </TabPanel>
          <TabPanel value="thresholds">
            <ThresholdsEditor />
          </TabPanel>
        </Tabs>
      </div>
    </>
  );
}

export default function DataQualityPage() {
  return (
    <Suspense>
      <DataQualityView />
    </Suspense>
  );
}
