"use client";

import { Printer } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";

import { EmptyState, PageHeader } from "@/components/data/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/misc";
import { errorMessage } from "@/lib/api";
import { formatDate, formatDateTime } from "@/lib/utils";

import { useLoi, useOffer } from "@/features/offers/api";

const PRINT_CSS = `
@media print {
  body * { visibility: hidden !important; }
  #loi-document, #loi-document * { visibility: visible !important; }
  #loi-document { position: absolute; left: 0; top: 0; width: 100%; border: 0 !important; box-shadow: none !important; }
}
`;

function LoiView({ id }: { id: string }) {
  const { data: offer } = useOffer(id);
  const { data: loi, isLoading, error } = useLoi(id);

  if (isLoading) return <Skeleton className="mx-auto h-[600px] w-full max-w-3xl" />;
  if (error || !loi) {
    return (
      <EmptyState
        title="LOI not available"
        description={errorMessage(error)}
        action={<Link href={`/offers/${id}`}><Button>Back to offer</Button></Link>}
      />
    );
  }

  const p = loi.property;
  const sent = offer?.status !== "approved";

  return (
    <>
      <style>{PRINT_CSS}</style>
      <PageHeader
        breadcrumbs={[{ label: "Offers", href: "/offers" }, { label: `${loi.opportunity_title} · v${loi.version}`, href: `/offers/${id}` }, { label: "Letter of intent" }]}
        title="Letter of intent"
        description={sent ? "Frozen exactly as sent." : "Generated from the approved terms of this version."}
        meta={sent ? <Badge tone="blue">As sent</Badge> : <Badge tone="green">Approved terms</Badge>}
        actions={
          <Button variant="primary" onClick={() => window.print()}>
            <Printer /> Print
          </Button>
        }
      />

      <article id="loi-document" className="mx-auto max-w-3xl rounded-lg border border-line bg-surface px-12 py-10 text-[13.5px] leading-relaxed text-ink shadow-card">
        <header className="mb-8 flex items-start justify-between gap-6">
          <div>
            <p className="text-xs uppercase tracking-wider text-ink-3">Letter of intent</p>
            <h2 className="mt-1 text-lg font-semibold">{p ? p.name || p.address_line : loi.opportunity_title}</h2>
            {p && <p className="text-ink-2">{[p.address_line, p.city, p.state, p.postal_code].filter(Boolean).join(", ")}</p>}
          </div>
          <p className="whitespace-nowrap text-ink-2">{formatDate(loi.generated_at, "MMMM d, yyyy")}</p>
        </header>

        <p className="mb-6">
          {loi.buyer_entity ?? "Buyer"} (&ldquo;Buyer&rdquo;) submits this letter of intent to {loi.seller_name ?? "Seller"} (&ldquo;Seller&rdquo;) for the
          purchase of the property described below on the following terms.
        </p>

        <dl className="divide-y divide-line border-y border-line">
          {loi.paragraphs.map((para, i) => (
            <div key={para.key} className="grid grid-cols-[180px_1fr] gap-4 py-3">
              <dt className="font-medium">
                {i + 1}. {para.heading}
              </dt>
              <dd className="whitespace-pre-wrap text-ink-2">{para.text}</dd>
            </div>
          ))}
        </dl>

        <div className="mt-12 grid grid-cols-2 gap-10">
          {["Buyer", "Seller"].map((who) => (
            <div key={who}>
              <p className="mb-10 text-xs uppercase tracking-wider text-ink-3">{who}</p>
              <div className="border-t border-ink/60 pt-1 text-xs text-ink-3">Signature / date</div>
              <p className="mt-1 text-xs text-ink-2">{who === "Buyer" ? loi.buyer_entity ?? "" : loi.seller_name ?? ""}</p>
            </div>
          ))}
        </div>

        <footer className="mt-10 border-t border-line pt-3 text-2xs text-ink-3">
          Offer v{loi.version} · prepared from approved underwriting model
          {loi.underwriting.version != null ? ` v${loi.underwriting.version}` : ""}
          {loi.approvals.length > 0 && ` · approved by ${loi.approvals.map((a) => `${a.approver_name ?? "—"} (${formatDateTime(a.decided_at)})`).join(", ")}`}
        </footer>
      </article>
    </>
  );
}

export default function LoiPage({ params }: { params: { id: string } }) {
  return (
    <Suspense>
      <LoiView id={params.id} />
    </Suspense>
  );
}
