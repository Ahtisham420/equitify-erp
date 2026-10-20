"use client";

import { Suspense } from "react";

import { EmptyState, PageHeader } from "@/components/data/page";
import { useAuth } from "@/lib/auth";

import { NLSearch } from "@/features/platform/nl-search";

function AskView() {
  const { can, loading } = useAuth();
  if (!loading && !can("properties", "view")) {
    return <EmptyState title="No access" description="Asking questions about properties requires the Properties view permission." />;
  }
  return (
    <>
      <PageHeader
        title="Ask EquitiFy"
        description="Describe the properties you are looking for. The question is translated into structured filters you can inspect, and only records you are permitted to see are returned."
      />
      <NLSearch />
    </>
  );
}

export default function AskPage() {
  return (
    <Suspense>
      <AskView />
    </Suspense>
  );
}
