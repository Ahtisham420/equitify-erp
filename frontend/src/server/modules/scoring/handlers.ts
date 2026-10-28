/** Scoring automations: rescore when the facts behind a score change; log outcomes at decisions. */
import * as events from "../../core/events";
import type { Db } from "../../db";
import { get } from "../../db/orm";
import { opportunities } from "../pipeline/schema";
import { ownedProperties } from "../signals/service";
import * as service from "./service";

async function signalProperties(
  db: Db, propertyId: string | null | undefined, ownerKind: string | null | undefined, ownerId: string | null | undefined,
): Promise<string[]> {
  const pids: string[] = propertyId ? [propertyId] : [];
  if (ownerKind && ownerId) {
    for (const p of await ownedProperties(db, ownerKind, ownerId)) if (!pids.includes(p)) pids.push(p);
  }
  return pids.slice(0, 50);
}

events.on("property.created", async (db, { property_id, actor = null }) => {
  await service.rescoreProperty(db, property_id, actor, { trigger: "property_created" });
});

// Runs after the buy box handler re-evaluates, so eligibility reflects the change.
events.on("property.updated", async (db, { property_id, actor = null }) => {
  await service.rescoreProperty(db, property_id, actor, { trigger: "property_updated" });
});

events.on("ownership.changed", async (db, { property_id, actor = null }) => {
  await service.rescoreProperty(db, property_id, actor, { trigger: "ownership_changed" });
});

events.on("signal.created", async (db, { property_id = null, owner_kind = null, owner_id = null, actor = null }) => {
  for (const pid of await signalProperties(db, property_id, owner_kind, owner_id)) {
    await service.rescoreProperty(db, pid, actor, { trigger: "signal_created" });
  }
});

events.on("signal.updated", async (db, { property_id = null, owner_kind = null, owner_id = null, actor = null }) => {
  for (const pid of await signalProperties(db, property_id, owner_kind, owner_id)) {
    await service.rescoreProperty(db, pid, actor, { trigger: "signal_updated" });
  }
});

events.on("interaction.logged", async (db, { property_id = null, opportunity_id = null, actor = null }) => {
  let pid = property_id;
  if (pid === null && opportunity_id) {
    const o = await get(db, opportunities, opportunity_id);
    pid = o ? o.property_id : null;
  }
  if (pid) await service.rescoreProperty(db, pid, actor, { trigger: "interaction_logged" });
});

events.on("opportunity.stage_changed", async (db, { opportunity_id, to_stage = null, actor = null }) => {
  const o = await get(db, opportunities, opportunity_id);
  if (!o || !o.property_id) return;
  // Log first so the outcome captures the score the decision was made on, then rescore.
  if (to_stage === "dead") {
    await service.logOutcome(db, {
      property_id: o.property_id, opportunity_id: o.id, disposition: "dead", result: "lost", actor,
      notes: (o.dead_reason || "").replace(/_/g, " ") || null,
    });
  } else if (service.PURSUE_STAGES.has(to_stage) || to_stage === "nurture") {
    await service.logOutcome(db, {
      property_id: o.property_id, opportunity_id: o.id, disposition: to_stage, result: "open", actor,
    });
  } else if (to_stage === "closed") {
    await service.logOutcome(db, {
      property_id: o.property_id, opportunity_id: o.id, disposition: "closed", result: "won", actor,
    });
  }
  await service.rescoreProperty(db, o.property_id, actor, { trigger: "stage_changed" });
});

events.on("opportunity.dead", async (db, { opportunity_id, actor = null }) => {
  const o = await get(db, opportunities, opportunity_id);
  if (!o || !o.property_id) return;
  await service.logOutcome(db, {
    property_id: o.property_id, opportunity_id: o.id, disposition: "dead", result: "lost", actor,
    notes: (o.dead_reason || "").replace(/_/g, " ") || null,
  });
});

events.on("closing.completed", async (db, { opportunity_id = null, property_id = null, actor = null }) => {
  let pid = property_id;
  if (opportunity_id && pid === null) {
    const o = await get(db, opportunities, opportunity_id);
    pid = o ? o.property_id : null;
  }
  if (pid) {
    await service.logOutcome(db, { property_id: pid, opportunity_id, disposition: "closed", result: "won", actor });
  }
});
