/**
 * Single entry point for the whole REST API (/api/v1/*). Modules register their routes on `apiRouter`
 * (see server/registry.generated.ts); each request runs inside one DB session/transaction.
 */
import { ZodError } from "zod";

import { HttpError, jsonResponse, Reply, validationError } from "@/server/core/http";
import { Ctx } from "@/server/core/router";
import { withSession } from "@/server/db";
import { apiRouter } from "@/server/registry.generated";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: { path?: string[] } };

async function handle(req: Request, { params }: Params): Promise<Response> {
  const path = "/" + (params.path ?? []).join("/");
  const matched = apiRouter.match(req.method, path);
  if (matched === null) return jsonResponse({ detail: "Not Found" }, 404);
  if (matched === "method") return jsonResponse({ detail: "Method Not Allowed" }, 405);

  let after: Array<() => Promise<void> | void> = [];
  try {
    const response = await withSession(async (db) => {
      const ctx = new Ctx(req, db, matched.params);
      const result = await matched.handler(ctx);
      after = db.after;
      if (result instanceof Response) return result;
      if (result instanceof Reply) {
        return result.status === 204
          ? new Response(null, { status: 204, headers: result.headers })
          : jsonResponse(result.body, result.status, result.headers);
      }
      return jsonResponse(result === undefined ? null : result);
    });
    for (const fn of after) {
      Promise.resolve()
        .then(fn)
        .catch((err) => console.error("[background task failed]", err));
    }
    return response;
  } catch (err) {
    if (err instanceof HttpError) return jsonResponse({ detail: err.detail }, err.status, err.headers);
    if (err instanceof ZodError) {
      const e = validationError(err);
      return jsonResponse({ detail: e.detail }, e.status);
    }
    console.error(`[api] ${req.method} ${path} failed`, err);
    return jsonResponse({ detail: "Internal Server Error" }, 500);
  }
}

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const PUT = handle;
export const DELETE = handle;
