"use client";

import { Suspense } from "react";

import { PageHeader } from "@/components/data/page";

import { AuditTable } from "@/features/admin/audit-table";

export default function AuditPage() {
  return (
    <Suspense>
      <PageHeader
        title="Audit log"
        description="Immutable record of sign-ins, permission changes, exports, deletions and administrative actions. Click a row to see what changed."
      />
      <AuditTable />
    </Suspense>
  );
}
