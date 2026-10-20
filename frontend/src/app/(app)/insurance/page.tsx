"use client";

import { Plus, RefreshCw } from "lucide-react";
import { Suspense, useState } from "react";
import { toast } from "sonner";

import { PageHeader } from "@/components/data/page";
import { Button } from "@/components/ui/button";
import { TabList, TabPanel, Tabs } from "@/components/ui/misc";
import { useUrlState } from "@/hooks/use-url-state";
import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { pluralize } from "@/lib/utils";

import { useOperationsScan } from "@/features/operations/api";
import { CertificatesTab, ClaimsTab, PoliciesTab, PropertyTaxTab } from "@/features/operations/insurance-tabs";

const TABS = ["policies", "certificates", "claims", "tax"] as const;
type Tab = (typeof TABS)[number];

const CREATE_LABEL: Record<Tab, string> = {
  policies: "New policy",
  certificates: "New certificate",
  claims: "New claim",
  tax: "New assessment",
};

function InsuranceView() {
  const { can } = useAuth();
  const url = useUrlState();
  const raw = url.get("tab");
  const tab: Tab = TABS.includes(raw as Tab) ? (raw as Tab) : "policies";
  const [creating, setCreating] = useState<Tab | null>(null);
  const scan = useOperationsScan();

  const runScan = () =>
    scan.mutate(undefined, {
      onSuccess: (r) => {
        const parts = [
          pluralize(r.policies_expiring, "policy expiring", "policies expiring"),
          pluralize(r.certificates_lapsed, "certificate lapsed", "certificates lapsed"),
          pluralize(r.protest_deadlines, "protest deadline"),
          pluralize(r.payments_due, "tax payment due", "tax payments due"),
        ];
        toast.success(`Scan complete · ${pluralize(r.alerts_raised, "new alert")}`, { description: parts.join(" · ") });
      },
      onError: (e) => toast.error(errorMessage(e)),
    });

  const createProps = (t: Tab) => ({
    creating: creating === t,
    onCreatingChange: (o: boolean) => setCreating(o ? t : null),
  });

  return (
    <>
      <PageHeader
        title="Insurance & property tax"
        description="Policy inventory, tenant and vendor certificates, claims, assessments, protests and tax payments."
        actions={
          <>
            {can("operations", "edit") && (
              <Button onClick={runScan} loading={scan.isPending}>
                {!scan.isPending && <RefreshCw />}
                Run expiration scan
              </Button>
            )}
            {can("operations", "create") && (
              <Button variant="primary" onClick={() => setCreating(tab)}>
                <Plus />
                {CREATE_LABEL[tab]}
              </Button>
            )}
          </>
        }
      />
      <Tabs
        value={tab}
        onValueChange={(v) => {
          setCreating(null);
          url.replaceAll({ tab: v === "policies" ? null : v });
        }}
      >
        <TabList
          className="mb-5"
          tabs={[
            { value: "policies", label: "Policies" },
            { value: "certificates", label: "Certificates" },
            { value: "claims", label: "Claims" },
            { value: "tax", label: "Property tax" },
          ]}
        />
        <TabPanel value="policies">{tab === "policies" && <PoliciesTab {...createProps("policies")} />}</TabPanel>
        <TabPanel value="certificates">{tab === "certificates" && <CertificatesTab {...createProps("certificates")} />}</TabPanel>
        <TabPanel value="claims">{tab === "claims" && <ClaimsTab {...createProps("claims")} />}</TabPanel>
        <TabPanel value="tax">{tab === "tax" && <PropertyTaxTab {...createProps("tax")} />}</TabPanel>
      </Tabs>
    </>
  );
}

export default function InsurancePage() {
  return (
    <Suspense>
      <InsuranceView />
    </Suspense>
  );
}
