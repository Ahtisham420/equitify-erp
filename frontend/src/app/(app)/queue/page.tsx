"use client";

import { Suspense } from "react";

import { PageHeader } from "@/components/data/page";

import { DailyQueue } from "@/features/outreach/daily-queue";

export default function QueuePage() {
  return (
    <Suspense>
      <PageHeader title="Daily queue" description="A finite, prioritized list for today. Every item shows why it is here." />
      <DailyQueue />
    </Suspense>
  );
}
