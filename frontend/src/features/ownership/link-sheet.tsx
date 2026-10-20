"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, Sheet } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/misc";
import { errorMessage } from "@/lib/api";
import { titleCase } from "@/lib/utils";

import { OwnerPicker } from "@/features/contacts/pickers";

import { LINK_RELATIONSHIPS, useLinkMutations, type Evidence, type Link, type OwnerKind } from "./api";
import { cleanEvidence, EvidenceEditor, EvidenceList } from "./evidence";

const REL_HINT: Record<string, string> = {
  manager: "controls", member: "is a member of", officer: "is an officer of", director: "is a director of",
  registered_agent: "is registered agent for", parent: "is the parent of", affiliate: "is affiliated with",
  family: "is family of", advisor: "advises",
};

export function relationPhrase(rel: string) {
  return REL_HINT[rel] ?? titleCase(rel).toLowerCase();
}

/** Record a control/affiliation relationship manually with evidence. */
export function LinkSheet({ open, onOpenChange, from }: { open: boolean; onOpenChange: (o: boolean) => void; from?: { kind: OwnerKind; id: string } }) {
  const m = useLinkMutations();
  const [fromKind, setFromKind] = useState<OwnerKind>("person");
  const [fromId, setFromId] = useState<string | null>(null);
  const [toKind, setToKind] = useState<OwnerKind>("organization");
  const [toId, setToId] = useState<string | null>(null);
  const [relationship, setRelationship] = useState("manager");
  const [confidence, setConfidence] = useState("80");
  const [source, setSource] = useState("Manual entry");
  const [notes, setNotes] = useState("");
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [confirmed, setConfirmed] = useState(true);

  useEffect(() => {
    if (!open) return;
    setFromKind(from?.kind ?? "person");
    setFromId(from?.id ?? null);
    setToKind("organization");
    setToId(null);
    setRelationship("manager");
    setConfidence("80");
    setSource("Manual entry");
    setNotes("");
    setEvidence([]);
    setConfirmed(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, from?.kind, from?.id]);

  const personPair = fromKind === "person" && toKind === "person";
  const rels: readonly string[] = personPair ? ["family", "advisor"] : LINK_RELATIONSHIPS.filter((r) => r !== "family" || fromKind === "person");

  const submit = () =>
    m.create.mutate(
      {
        from_kind: fromKind, from_id: fromId, to_kind: toKind, to_id: toId, relationship,
        confidence: Math.min(100, Math.max(0, Number(confidence) || 0)) / 100, source: source.trim() || "Manual entry",
        notes: notes.trim() || null, evidence: cleanEvidence(evidence), confirmed,
      },
      {
        onSuccess: () => {
          toast.success(confirmed ? "Relationship recorded" : "Relationship added to the review queue");
          onOpenChange(false);
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Add relationship"
      description="Entity-to-entity or person-to-entity control and affiliation, with supporting evidence."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={!fromId || !toId || !rels.includes(relationship)} loading={m.create.isPending} onClick={submit}>
            Save relationship
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <Field label="From">
          <OwnerPicker kind={fromKind} onKindChange={setFromKind} value={fromId} onChange={setFromId} />
        </Field>
        <Field label="Relationship">
          <Select value={relationship} onChange={(e) => setRelationship(e.target.value)} options={rels.map((r) => ({ value: r, label: `${titleCase(r)} — ${relationPhrase(r)}` }))} />
        </Field>
        <Field label="To">
          <OwnerPicker kind={toKind} onKindChange={setToKind} value={toId} onChange={setToId} />
        </Field>
        {(relationship === "family" || relationship === "advisor") && (
          <p className="rounded-md border border-caution/30 bg-caution-soft px-3 py-2 text-xs text-ink-2">
            Record family and advisor relationships only where lawfully obtained. Mark personal-circumstance evidence as sensitive.
          </p>
        )}
        <div className="grid grid-cols-3 gap-3">
          <Field label="Source" className="col-span-2"><Input value={source} onChange={(e) => setSource(e.target.value)} /></Field>
          <Field label="Confidence %"><Input inputMode="numeric" value={confidence} onChange={(e) => setConfidence(e.target.value)} /></Field>
        </div>
        <Field label="Evidence"><EvidenceEditor value={evidence} onChange={setEvidence} /></Field>
        <Field label="Notes"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        <label className="flex items-center gap-2 text-sm text-ink-2">
          <Checkbox checked={confirmed} onChange={setConfirmed} />
          Confirmed — otherwise it goes to the review queue as a suggestion
        </label>
      </div>
    </Sheet>
  );
}

/** Confirm a suggested link, optionally changing the relationship or its direction. */
export function ConfirmLinkDialog({ link, onOpenChange }: { link: Link | null; onOpenChange: (o: boolean) => void }) {
  const m = useLinkMutations();
  const [relationship, setRelationship] = useState("affiliate");
  const [reverse, setReverse] = useState(false);
  const [note, setNote] = useState("");

  useEffect(() => {
    if (link) {
      setRelationship(link.relationship);
      setReverse(false);
      setNote("");
    }
  }, [link]);

  if (!link) return <Dialog open={false} onOpenChange={onOpenChange} title="Confirm relationship" />;
  const [a, b] = reverse ? [link.to_label, link.from_label] : [link.from_label, link.to_label];
  const personPair = link.from_kind === "person" && link.to_kind === "person";
  const rels: readonly string[] = personPair ? ["family", "advisor"] : LINK_RELATIONSHIPS;

  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      title="Confirm relationship"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            loading={m.confirm.isPending}
            onClick={() =>
              m.confirm.mutate(
                { id: link.id, body: { relationship, reverse, note: note.trim() || undefined } },
                {
                  onSuccess: () => {
                    toast.success("Relationship confirmed");
                    onOpenChange(false);
                  },
                  onError: (e) => toast.error(errorMessage(e)),
                },
              )
            }
          >
            Confirm
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-ink">
          <span className="font-medium">{a ?? "—"}</span> <span className="text-ink-2">{relationPhrase(relationship)}</span>{" "}
          <span className="font-medium">{b ?? "—"}</span>
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Relationship">
            <Select value={relationship} onChange={(e) => setRelationship(e.target.value)} options={rels.map((r) => ({ value: r, label: titleCase(r) }))} />
          </Field>
          <label className="mt-6 flex items-center gap-2 text-sm text-ink-2">
            <Checkbox checked={reverse} onChange={setReverse} />
            Reverse direction
          </label>
        </div>
        <div>
          <p className="mb-1.5 text-xs font-medium text-ink-2">Evidence</p>
          <EvidenceList items={link.evidence} hidden={link.hidden_evidence} />
        </div>
        <Field label="Review note"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" /></Field>
      </div>
    </Dialog>
  );
}
