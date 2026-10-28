import { and, asc, eq, isNotNull, isNull, or } from "drizzle-orm";

import * as audit from "../../common/audit";
import { created, HttpError, noContent } from "../../core/http";
import { Router } from "../../core/router";
import { get, insert, patch, remove } from "../../db/orm";
import { globalSearch } from "./global_search";
import { savedViews } from "./schema";
import { savedViewIn } from "./schemas";

export const router = new Router();

/** Permission-aware search across the record graph; each source is skipped if the user lacks view access. */
router.get("/search", async (ctx) => {
  const user = await ctx.authed();
  const q = ctx.query.need("q", { min: 2, max: 200 });
  const limit = ctx.query.int("limit", { le: 50 }) ?? 20;
  return globalSearch(ctx.db, user, q, limit);
});

router.get("/saved-views", async (ctx) => {
  const user = await ctx.authed();
  const module = ctx.query.str("module");
  const teamId = user.user.team_id;
  return ctx.db
    .select()
    .from(savedViews)
    .where(
      and(
        isNull(savedViews.deleted_at),
        or(
          eq(savedViews.owner_id, user.id),
          eq(savedViews.visibility, "company"),
          // A user without a team can never match a team-visible view.
          teamId ? and(eq(savedViews.visibility, "team"), eq(savedViews.team_id, teamId), isNotNull(savedViews.team_id)) : undefined,
        ),
        module ? eq(savedViews.module, module) : undefined,
      ),
    )
    .orderBy(asc(savedViews.name));
});

router.post("/saved-views", async (ctx) => {
  const user = await ctx.authed();
  const body = await ctx.body(savedViewIn);
  if (!user.can(body.module, "view")) throw new HttpError(403, "You cannot save views for this module");
  const view = await insert(ctx.db, savedViews, {
    ...body,
    owner_id: user.id,
    team_id: user.user.team_id,
    created_by_id: user.id,
    updated_by_id: user.id,
  });
  await audit.record(ctx.db, {
    actor: user, action: "saved_view.created", entity_type: "saved_view", entity_id: view.id,
    summary: `${body.module}: ${body.name}`,
  });
  await ctx.db.commit();
  return created(view);
});

router.patch("/saved-views/{view_id}", async (ctx) => {
  const user = await ctx.authed();
  const body = await ctx.body(savedViewIn);
  const view = await get(ctx.db, savedViews, ctx.uuid("view_id"));
  if (!view || view.deleted_at) throw new HttpError(404, "View not found");
  if (view.owner_id !== user.id && !user.is_admin) throw new HttpError(403, "Only the owner can change this view");
  await patch(ctx.db, savedViews, view, { ...body, updated_by_id: user.id });
  await ctx.db.commit();
  return view;
});

router.delete("/saved-views/{view_id}", async (ctx) => {
  const user = await ctx.authed();
  const view = await get(ctx.db, savedViews, ctx.uuid("view_id"));
  if (!view || view.deleted_at) throw new HttpError(404, "View not found");
  if (view.owner_id !== user.id && !user.is_admin) throw new HttpError(403, "Only the owner can delete this view");
  await remove(ctx.db, savedViews, view);
  await ctx.db.commit();
  return noContent();
});
