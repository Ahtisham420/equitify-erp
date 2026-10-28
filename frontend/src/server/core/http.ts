import { z, ZodError, type ZodTypeAny } from "zod";

/** Mirrors FastAPI's HTTPException: the client reads `{ detail }` from the JSON body. */
export class HttpError extends Error {
  constructor(
    public status: number,
    public detail: unknown,
    public headers?: Record<string, string>,
  ) {
    super(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
}

export const notFound = (what: string) => new HttpError(404, `${what} not found`);

/** FastAPI-shaped validation error: `detail: [{ loc, msg, type }]`. */
export function validationError(err: ZodError, where: "body" | "query" | "path" = "body"): HttpError {
  return new HttpError(
    422,
    err.issues.map((i) => ({ loc: [where, ...i.path], msg: i.message, type: i.code })),
  );
}

export function parse<S extends ZodTypeAny>(schema: S, data: unknown, where: "body" | "query" | "path" = "body"): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) throw validationError(r.error, where);
  return r.data;
}

/** Response wrappers a handler may return (a plain value is a 200 JSON response). */
export class Reply {
  constructor(
    public status: number,
    public body?: unknown,
    public headers: Record<string, string> = {},
  ) {}
}
export const created = (body: unknown) => new Reply(201, body);
export const noContent = () => new Reply(204);
export const status = (code: number, body?: unknown) => new Reply(code, body);

export function csvResponse(text: string, filename: string): Response {
  return new Response(text, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename=${filename}` },
  });
}

export const jsonResponse = (body: unknown, code = 200, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? Number(v) : v)), {
    status: code,
    headers: { "Content-Type": "application/json", ...headers },
  });
