"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";

import { EmptyState, PageHeader } from "@/components/data/page";
import { RecordTimeline } from "@/components/data/timeline";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/misc";
import { errorMessage } from "@/lib/api";
import { formatDateTime, formatNumber } from "@/lib/utils";

import { ENTITY_LABELS, JOB_STATUS_LABELS, useImportJob, type ImportJobDetail } from "@/features/imports/api";
import { CommitStep, ImportRowsTable, MapStep, PreviewStep, ResultsView, Stepper, UploadStep, stepForJob, type Step } from "@/features/imports/import-wizard";

function reachableSteps(job: ImportJobDetail): Step[] {
  if (job.status === "uploaded" || job.status === "mapped") return ["map"];
  if (job.status === "validated") return ["map", "preview", "commit"];
  return [];
}

function JobWizard({ job }: { job: ImportJobDetail }) {
  const [step, setStep] = useState<Step>(stepForJob(job));

  useEffect(() => setStep(stepForJob(job)), [job.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const finished = step === "results";

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Imports", href: "/imports" }, { label: job.filename }]}
        title={job.filename}
        description={`${ENTITY_LABELS[job.entity_type]} · ${formatNumber(job.row_count)} rows · source ${job.data_source_name ?? "—"}`}
        meta={
          <>
            <StatusBadge status={job.status} label={JOB_STATUS_LABELS[job.status]} />
            {job.options.on_duplicate && <Badge tone="outline">Duplicates: {job.options.on_duplicate === "update" ? "updated" : "skipped"}</Badge>}
            <span className="text-xs text-ink-3">Uploaded {formatDateTime(job.created_at)}</span>
            {job.committed_at && <span className="text-xs text-ink-3">· committed {formatDateTime(job.committed_at)}</span>}
          </>
        }
      />
      {!finished && <Stepper current={step} reachable={reachableSteps(job)} onSelect={setStep} />}

      {step === "map" && <MapStep job={job} onDone={() => setStep("preview")} />}
      {step === "preview" && (job.status === "validated" ? (
        <PreviewStep job={job} onBack={() => setStep("map")} onNext={() => setStep("commit")} />
      ) : (
        <ImportRowsTable job={job} mode="preview" />
      ))}
      {step === "commit" && <CommitStep job={job} onBack={() => setStep("preview")} onDone={() => setStep("results")} />}
      {finished && <ResultsView job={job} />}

      <Card className="mt-5">
        <CardHeader title="Activity" description="Upload, mapping, validation, commit and rollback events for this import." />
        <CardBody>
          <RecordTimeline entityType="import_job" entityId={job.id} />
        </CardBody>
      </Card>
    </>
  );
}

function ImportDetail({ id }: { id: string }) {
  const isNew = id === "new";
  const { data: job, isLoading, error } = useImportJob(isNew ? null : id);

  if (isNew) {
    return (
      <>
        <PageHeader breadcrumbs={[{ label: "Imports", href: "/imports" }, { label: "New import" }]} title="New import" />
        <Stepper current="upload" reachable={[]} onSelect={() => undefined} />
        <UploadStep />
      </>
    );
  }
  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-7 w-80" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (error || !job) {
    return (
      <EmptyState
        title="Import not found"
        description={errorMessage(error)}
        action={
          <Link href="/imports">
            <Button>Back to imports</Button>
          </Link>
        }
      />
    );
  }
  return <JobWizard job={job} />;
}

export default function ImportPage({ params }: { params: { id: string } }) {
  return (
    <Suspense>
      <ImportDetail id={params.id} />
    </Suspense>
  );
}
