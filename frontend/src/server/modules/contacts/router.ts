import { desc } from "drizzle-orm";

import * as audit from "../../common/audit";
import { applySort, facetCounts, page, paginate } from "../../common/query";
import { created, csvResponse, HttpError, noContent } from "../../core/http";
import { Ctx, Router } from "../../core/router";
import {
  ORG_TYPES, organizations, people, PHONE_TYPES, RESPONSIVENESS, ROLES, STRENGTHS,
} from "./schema";
import {
  affiliationIn, affiliationUpdate, bulkIn, contactPointIn, contactPointUpdate, enrichmentIn, mergeIn,
  organizationCreate, organizationUpdate, personCreate, personUpdate,
} from "./schemas";
import * as service from "./service";
import type { OrgFilters, PeopleFilters } from "./service";

export const router = new Router();

const PEOPLE_SORTS = {
  full_name: people.full_name, state: people.state, last_touch_at: people.last_touch_at,
  next_action_at: people.next_action_at, relationship_strength: people.relationship_strength,
  updated_at: people.updated_at, created_at: people.created_at,
};
const ORG_SORTS = {
  name: organizations.name, org_type: organizations.org_type, state: organizations.state,
  last_touch_at: organizations.last_touch_at, next_action_at: organizations.next_action_at,
  updated_at: organizations.updated_at, created_at: organizations.created_at,
};

function peopleFilters(ctx: Ctx): PeopleFilters {
  const q = ctx.query;
  return {
    q: q.str("q", { max: 200 }),
    state: q.strs("state"),
    relationship_strength: q.strs("relationship_strength"),
    responsiveness: q.strs("responsiveness"),
    role: q.strs("role"),
    organization_id: q.uuid("organization_id"),
    owner_id: q.uuid("owner_id"),
    tag: q.strs("tag"),
    has_next_action: q.bool("has_next_action"),
    overdue: q.bool("overdue"),
    touched_before: q.date("touched_before"),
    ids: q.uuids("ids"),
  };
}

function orgFilters(ctx: Ctx): OrgFilters {
  const q = ctx.query;
  return {
    q: q.str("q", { max: 200 }),
    org_type: q.strs("org_type"),
    state: q.strs("state"),
    relationship_strength: q.strs("relationship_strength"),
    owner_id: q.uuid("owner_id"),
    tag: q.strs("tag"),
    has_next_action: q.bool("has_next_action"),
    ids: q.uuids("ids"),
  };
}

const ENTITY_TYPES = ["person", "organization"] as const;
const missing = (name: string) => new HttpError(422, [{ loc: ["query", name], msg: "Field required", type: "missing" }]);

const csvCell = (v: unknown) => {
  if (v === null || v === undefined) return "";
  const s = v instanceof Date ? v.toISOString() : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvText = (cols: string[], rows: Array<Record<string, unknown>>) =>
  [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\r\n") + "\r\n";

router.get("/contacts/meta", async (ctx) => {
  await ctx.require("contacts", "view");
  return {
    roles: ROLES, org_types: ORG_TYPES, phone_types: PHONE_TYPES, strengths: STRENGTHS, responsiveness: RESPONSIVENESS,
    mergeable: Object.fromEntries(Object.entries(service.MERGEABLE).map(([k, v]) => [k, [...v].sort()])),
  };
});

// ---------------------------------------------------------------- duplicates & merges

router.get("/contacts/duplicates", async (ctx) => {
  const user = await ctx.require("contacts", "view");
  const entityType = ctx.query.enum("entity_type", ENTITY_TYPES);
  const status = ctx.query.enum("status", ["open", "merged", "dismissed"] as const) ?? "open";
  return service.duplicateQueue(ctx.db, entityType, status, user);
});

router.post("/contacts/duplicates/scan", async (ctx) => {
  const user = await ctx.require("contacts", "edit");
  const entityType = ctx.query.enum("entity_type", ENTITY_TYPES);
  if (!entityType) throw missing("entity_type");
  const [scanned, created_] = await service.scanDuplicates(ctx.db, entityType, user);
  return { scanned, new_candidates: created_ };
});

router.post("/contacts/duplicates/{review_id}/dismiss", async (ctx) => {
  const user = await ctx.require("contacts", "edit");
  return service.duplicateOut(await service.dismissDuplicate(ctx.db, ctx.uuid("review_id"), user));
});

router.post("/contacts/merge", async (ctx) => {
  const user = await ctx.require("contacts", "edit");
  const rec = await service.merge(ctx.db, await ctx.body(mergeIn), user);
  return (await service.mergeHistory(ctx.db, rec.entity_type, rec.survivor_id))[0];
});

router.get("/contacts/merges", async (ctx) => {
  await ctx.require("contacts", "view");
  return service.mergeHistory(ctx.db, ctx.query.enum("entity_type", ENTITY_TYPES), ctx.query.uuid("record_id"));
});

router.post("/contacts/merges/{merge_id}/unmerge", async (ctx) => {
  const user = await ctx.require("contacts", "edit");
  const rec = await service.unmerge(ctx.db, ctx.uuid("merge_id"), user);
  const hit = (await service.mergeHistory(ctx.db, rec.entity_type, rec.survivor_id)).find((m) => m.id === rec.id);
  if (!hit) throw new HttpError(500, "Internal Server Error");
  return hit;
});

// ---------------------------------------------------------------- contact points & affiliations

router.patch("/contact-points/{cp_id}", async (ctx) => {
  const user = await ctx.require("contacts", "edit");
  const body = await ctx.body(contactPointUpdate);
  if (!service.canSensitive(user)) throw new HttpError(403, "Editing contact details requires contacts:view_sensitive");
  const cp = await service.updateContactPoint(ctx.db, await service.getPoint(ctx.db, ctx.uuid("cp_id")), body, user);
  return service.pointOut(cp, true);
});

router.delete("/contact-points/{cp_id}", async (ctx) => {
  const user = await ctx.require("contacts", "edit");
  await service.removeContactPoint(ctx.db, await service.getPoint(ctx.db, ctx.uuid("cp_id")), user);
  return noContent();
});

async function affiliationFor(ctx: Ctx, a: { id: string; person_id: string }) {
  const hit = (await service.affiliationsFor(ctx.db, { person_id: a.person_id })).find((x) => x.id === a.id);
  if (!hit) throw new HttpError(500, "Internal Server Error");
  return hit;
}

router.post("/affiliations", async (ctx) => {
  const user = await ctx.require("contacts", "edit");
  const a = await service.createAffiliation(ctx.db, await ctx.body(affiliationIn), user);
  return created(await affiliationFor(ctx, a));
});

router.patch("/affiliations/{aff_id}", async (ctx) => {
  const user = await ctx.require("contacts", "edit");
  const body = await ctx.body(affiliationUpdate);
  const a = await service.updateAffiliation(ctx.db, ctx.uuid("aff_id"), body, user);
  return affiliationFor(ctx, a);
});

// ---------------------------------------------------------------- people

router.get("/people", async (ctx) => {
  const user = await ctx.require("contacts", "view");
  const p = ctx.listParams();
  const f = peopleFilters(ctx);
  const where = service.buildPeopleWhere(f, { sensitive: service.canSensitive(user) });
  const [rows, total] = await paginate(ctx.db, people, where, applySort(p.sort, PEOPLE_SORTS, desc(people.updated_at)), p);
  return page(await service.peopleItems(ctx.db, rows, user), total, p);
});

router.get("/people/facets", async (ctx) => {
  const user = await ctx.require("contacts", "view");
  const f = peopleFilters(ctx);
  const s = service.canSensitive(user);
  const w = (skip: string) => service.buildPeopleWhere(f, { sensitive: s, skip: new Set([skip]) });
  return {
    state: await facetCounts(ctx.db, people, w("state"), people.state),
    relationship_strength: await facetCounts(ctx.db, people, w("relationship_strength"), people.relationship_strength),
    responsiveness: await facetCounts(ctx.db, people, w("responsiveness"), people.responsiveness),
    role: await service.roleFacets(ctx.db, w("role")),
  };
});

router.get("/people/export", async (ctx) => {
  const user = await ctx.require("contacts", "export");
  const p = ctx.listParams();
  const f = peopleFilters(ctx);
  const sensitive = service.canSensitive(user);
  const rows = await ctx.db
    .select()
    .from(people)
    .where(service.buildPeopleWhere(f, { sensitive }))
    .orderBy(...applySort(p.sort, PEOPLE_SORTS, desc(people.updated_at)))
    .limit(50_000);
  const cols = [
    "id", "full_name", "title", "primary_email", "primary_phone", "mailing_address", "city", "state", "postal_code",
    "relationship_strength", "responsiveness", "last_touch_at", "next_action_at",
  ];
  const out = rows.map((r) => {
    const vals: Record<string, unknown> = Object.fromEntries(cols.map((c) => [c, (r as Record<string, any>)[c]]));
    if (!sensitive) {
      vals.primary_email = service.maskEmail(r.primary_email);
      vals.primary_phone = service.maskPhone(r.primary_phone);
      vals.mailing_address = vals.postal_code = null;
    }
    return vals;
  });
  await audit.record(ctx.db, {
    actor: user, action: "person.exported", entity_type: "person", summary: `${rows.length} rows`,
    changes: { sensitive_included: sensitive }, ip_address: user.ip_address,
  });
  await ctx.db.commit();
  return csvResponse(csvText(cols, out), "people.csv");
});

router.post("/people", async (ctx) => {
  const user = await ctx.require("contacts", "create");
  const body = await ctx.body(personCreate);
  const force = ctx.query.bool("force") ?? false;
  return created(await service.personOut(ctx.db, await service.createPerson(ctx.db, body, user, force), user));
});

router.post("/people/bulk", async (ctx) => {
  const user = await ctx.require("contacts", "edit");
  return { updated: await service.bulkUpdate(ctx.db, "person", await ctx.body(bulkIn), user) };
});

router.get("/people/{person_id}", async (ctx) => {
  const user = await ctx.require("contacts", "view");
  return service.personOut(ctx.db, await service.getPerson(ctx.db, ctx.uuid("person_id")), user);
});

router.patch("/people/{person_id}", async (ctx) => {
  const user = await ctx.require("contacts", "edit");
  const body = await ctx.body(personUpdate);
  const p = await service.updatePerson(ctx.db, await service.getPerson(ctx.db, ctx.uuid("person_id")), body, user);
  return service.personOut(ctx.db, p, user);
});

router.delete("/people/{person_id}", async (ctx) => {
  const user = await ctx.require("contacts", "delete");
  await service.archivePerson(ctx.db, await service.getPerson(ctx.db, ctx.uuid("person_id")), user);
  return noContent();
});

router.post("/people/{person_id}/contact-points", async (ctx) => {
  const user = await ctx.require("contacts", "edit");
  const body = await ctx.body(contactPointIn);
  const cp = await service.addContactPoint(ctx.db, "person", ctx.uuid("person_id"), body, user);
  return created(service.pointOut(cp, service.canSensitive(user)));
});

router.get("/people/{person_id}/enrichments", async (ctx) => {
  await ctx.require("contacts", "view");
  return (await service.enrichments(ctx.db, "person", ctx.uuid("person_id"))).map(service.enrichmentOut);
});

router.post("/people/{person_id}/enrichments", async (ctx) => {
  const user = await ctx.require("contacts", "edit");
  const body = await ctx.body(enrichmentIn);
  return created(service.enrichmentOut(await service.addEnrichment(ctx.db, "person", ctx.uuid("person_id"), body, user)));
});

router.get("/people/{person_id}/context", async (ctx) => {
  await ctx.require("contacts", "view");
  const id = ctx.uuid("person_id");
  await service.getPerson(ctx.db, id);
  return service.context(ctx.db, "person", id);
});

// ---------------------------------------------------------------- organizations

router.get("/organizations", async (ctx) => {
  const user = await ctx.require("contacts", "view");
  const p = ctx.listParams();
  const where = service.buildOrgWhere(orgFilters(ctx));
  const [rows, total] = await paginate(
    ctx.db, organizations, where, applySort(p.sort, ORG_SORTS, desc(organizations.updated_at)), p,
  );
  return page(await service.orgItems(ctx.db, rows, user), total, p);
});

router.get("/organizations/facets", async (ctx) => {
  await ctx.require("contacts", "view");
  const f = orgFilters(ctx);
  const w = (skip: string) => service.buildOrgWhere(f, new Set([skip]));
  return {
    org_type: await facetCounts(ctx.db, organizations, w("org_type"), organizations.org_type),
    state: await facetCounts(ctx.db, organizations, w("state"), organizations.state),
    relationship_strength: await facetCounts(ctx.db, organizations, w("relationship_strength"), organizations.relationship_strength),
  };
});

router.get("/organizations/export", async (ctx) => {
  const user = await ctx.require("contacts", "export");
  const p = ctx.listParams();
  const sensitive = service.canSensitive(user);
  const rows = await ctx.db
    .select()
    .from(organizations)
    .where(service.buildOrgWhere(orgFilters(ctx)))
    .orderBy(...applySort(p.sort, ORG_SORTS, desc(organizations.updated_at)))
    .limit(50_000);
  const cols = [
    "id", "name", "legal_name", "org_type", "website", "domain", "phone", "mailing_address", "city", "state",
    "postal_code", "state_of_formation", "registered_agent", "relationship_strength", "last_touch_at",
  ];
  const out = rows.map((r) => {
    const vals: Record<string, unknown> = Object.fromEntries(cols.map((c) => [c, (r as Record<string, any>)[c]]));
    if (!sensitive) {
      vals.phone = service.maskPhone(r.phone);
      vals.mailing_address = vals.postal_code = null;
    }
    return vals;
  });
  await audit.record(ctx.db, {
    actor: user, action: "organization.exported", entity_type: "organization", summary: `${rows.length} rows`,
    changes: { sensitive_included: sensitive }, ip_address: user.ip_address,
  });
  await ctx.db.commit();
  return csvResponse(csvText(cols, out), "organizations.csv");
});

router.post("/organizations", async (ctx) => {
  const user = await ctx.require("contacts", "create");
  const body = await ctx.body(organizationCreate);
  const force = ctx.query.bool("force") ?? false;
  return created(await service.orgOut(ctx.db, await service.createOrg(ctx.db, body, user, force), user));
});

router.post("/organizations/bulk", async (ctx) => {
  const user = await ctx.require("contacts", "edit");
  return { updated: await service.bulkUpdate(ctx.db, "organization", await ctx.body(bulkIn), user) };
});

router.get("/organizations/{org_id}", async (ctx) => {
  const user = await ctx.require("contacts", "view");
  return service.orgOut(ctx.db, await service.getOrg(ctx.db, ctx.uuid("org_id")), user);
});

router.patch("/organizations/{org_id}", async (ctx) => {
  const user = await ctx.require("contacts", "edit");
  const body = await ctx.body(organizationUpdate);
  const o = await service.updateOrg(ctx.db, await service.getOrg(ctx.db, ctx.uuid("org_id")), body, user);
  return service.orgOut(ctx.db, o, user);
});

router.delete("/organizations/{org_id}", async (ctx) => {
  const user = await ctx.require("contacts", "delete");
  await service.archiveOrg(ctx.db, await service.getOrg(ctx.db, ctx.uuid("org_id")), user);
  return noContent();
});

router.post("/organizations/{org_id}/contact-points", async (ctx) => {
  const user = await ctx.require("contacts", "edit");
  const body = await ctx.body(contactPointIn);
  const cp = await service.addContactPoint(ctx.db, "organization", ctx.uuid("org_id"), body, user);
  return created(service.pointOut(cp, service.canSensitive(user)));
});

router.get("/organizations/{org_id}/enrichments", async (ctx) => {
  await ctx.require("contacts", "view");
  return (await service.enrichments(ctx.db, "organization", ctx.uuid("org_id"))).map(service.enrichmentOut);
});

router.post("/organizations/{org_id}/enrichments", async (ctx) => {
  const user = await ctx.require("contacts", "edit");
  const body = await ctx.body(enrichmentIn);
  return created(
    service.enrichmentOut(await service.addEnrichment(ctx.db, "organization", ctx.uuid("org_id"), body, user)),
  );
});

router.get("/organizations/{org_id}/context", async (ctx) => {
  await ctx.require("contacts", "view");
  const id = ctx.uuid("org_id");
  await service.getOrg(ctx.db, id);
  return service.context(ctx.db, "organization", id);
});
