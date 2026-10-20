"use client";

import { Suspense } from "react";

import { PropertyPicker } from "@/components/data/entity-picker";
import { PageHeader } from "@/components/data/page";
import { TabList, TabPanel, Tabs } from "@/components/ui/misc";
import { useUrlState } from "@/hooks/use-url-state";
import { useAuth } from "@/lib/auth";

import { DelinquencyTab, PlansTab } from "@/features/receivables/collections";
import { ReceivablesDashboard } from "@/features/receivables/dashboard";
import { ChargesTab, PaymentsTab, TenantsTab } from "@/features/receivables/ledger-tabs";
import { ReconciliationBillingTab, SyncTab } from "@/features/receivables/recon-sync";

function ReceivablesView() {
  const url = useUrlState();
  const { can } = useAuth();
  const tab = url.get("tab") ?? "dashboard";
  const propertyId = url.get("property_id") ?? undefined;

  return (
    <>
      <PageHeader
        title="Receivables"
        description="Lease-driven billing, payments, aging, delinquency and collections."
        actions={
          <div className="w-72">
            <PropertyPicker value={propertyId ?? null} onChange={(id) => url.set({ property_id: id })} placeholder="All properties" />
          </div>
        }
      />
      <Tabs value={tab} onValueChange={(v) => url.replaceAll({ tab: v === "dashboard" ? null : v, property_id: propertyId })}>
        <TabList
          className="mb-5"
          tabs={[
            { value: "dashboard", label: "Dashboard" },
            { value: "tenants", label: "Tenant ledgers" },
            { value: "charges", label: "Charges" },
            { value: "payments", label: "Payments" },
            { value: "delinquency", label: "Delinquency" },
            { value: "plans", label: "Payment plans" },
            { value: "reconciliation", label: "Reconciliation billing" },
            ...(can("receivables", "edit") || can("receivables", "export") ? [{ value: "sync", label: "Accounting sync" }] : []),
          ]}
        />
        <TabPanel value="dashboard">
          <ReceivablesDashboard propertyId={propertyId} />
        </TabPanel>
        <TabPanel value="tenants">
          <TenantsTab propertyId={propertyId} />
        </TabPanel>
        <TabPanel value="charges">
          <ChargesTab propertyId={propertyId} />
        </TabPanel>
        <TabPanel value="payments">
          <PaymentsTab propertyId={propertyId} />
        </TabPanel>
        <TabPanel value="delinquency">
          <DelinquencyTab propertyId={propertyId} />
        </TabPanel>
        <TabPanel value="plans">
          <PlansTab propertyId={propertyId} />
        </TabPanel>
        <TabPanel value="reconciliation">
          <ReconciliationBillingTab propertyId={propertyId} />
        </TabPanel>
        <TabPanel value="sync">
          <SyncTab />
        </TabPanel>
      </Tabs>
    </>
  );
}

export default function ReceivablesPage() {
  return (
    <Suspense>
      <ReceivablesView />
    </Suspense>
  );
}
