/**
 * Minimal FastAPI-style router. Routes are matched in registration order (like FastAPI), with `{name}` path
 * params, so a static route registered before `/{id}` wins exactly as it did in Python.
 *
 *   export const router = new Router();
 *   router.get("/properties/{property_id}", async (ctx) => {
 *     const user = await ctx.require("properties", "view");
 *     return row;               // 200 JSON;  created(x) -> 201;  noContent() -> 204;  or a Response
 *   });
 */
import { z, type ZodTypeAny } from "zod";

import type { Db } from "../db";
import { CurrentUser, getCurrentUser, requireUser } from "./deps";
import { HttpError, parse } from "./http";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bad = (loc: string, msg: string, where: "query" | "path" = "query") =>
  new HttpError(422, [{ loc: [where, loc], msg, type: "value_error" }]);

type NumOpts = { ge?: number; gt?: number; le?: number; lt?: number };
function checkNum(name: string, n: number, o: NumOpts) {
  if (Number.isNaN(n)) throw bad(name, "Input should be a valid number");
  if (o.ge !== undefined && n < o.ge) throw bad(name, `Input should be greater than or equal to ${o.ge}`);
  if (o.gt !== undefined && n <= o.gt) throw bad(name, `Input should be greater than ${o.gt}`);
  if (o.le !== undefined && n > o.le) throw bad(name, `Input should be less than or equal to ${o.le}`);
  if (o.lt !== undefined && n >= o.lt) throw bad(name, `Input should be less than ${o.lt}`);
}

/** Typed accessors over the URL query string. A missing/blank param returns `undefined` (FastAPI `None`). */
export class Query {
  constructor(public sp: URLSearchParams) {}

  private raw(name: string): string | undefined {
    const v = this.sp.get(name);
    return v === null || v === "" ? undefined : v;
  }
  str(name: string, o: { max?: number; min?: number; pattern?: RegExp } = {}): string | undefined {
    const v = this.raw(name);
    if (v === undefined) return undefined;
    if (o.max !== undefined && v.length > o.max) throw bad(name, `String should have at most ${o.max} characters`);
    if (o.min !== undefined && v.length < o.min) throw bad(name, `String should have at least ${o.min} characters`);
    if (o.pattern && !o.pattern.test(v)) throw bad(name, "String should match pattern");
    return v;
  }
  /** Required string param. */
  need(name: string, o: { max?: number; min?: number } = {}): string {
    const v = this.str(name, o);
    if (v === undefined) throw bad(name, "Field required");
    return v;
  }
  int(name: string, o: NumOpts = {}): number | undefined {
    const v = this.raw(name);
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isInteger(n)) throw bad(name, "Input should be a valid integer");
    checkNum(name, n, o);
    return n;
  }
  num(name: string, o: NumOpts = {}): number | undefined {
    const v = this.raw(name);
    if (v === undefined) return undefined;
    const n = Number(v);
    checkNum(name, n, o);
    return n;
  }
  bool(name: string): boolean | undefined {
    const v = this.raw(name);
    if (v === undefined) return undefined;
    if (["true", "1", "yes", "on", "t", "y"].includes(v.toLowerCase())) return true;
    if (["false", "0", "no", "off", "f", "n"].includes(v.toLowerCase())) return false;
    throw bad(name, "Input should be a valid boolean");
  }
  uuid(name: string): string | undefined {
    const v = this.raw(name);
    if (v === undefined) return undefined;
    if (!UUID_RE.test(v)) throw bad(name, "Input should be a valid UUID");
    return v;
  }
  /** Repeated param (`?a=1&a=2`) -> string[] | undefined. */
  strs(name: string): string[] | undefined {
    const v = this.sp.getAll(name).filter((x) => x !== "");
    return v.length ? v : undefined;
  }
  uuids(name: string): string[] | undefined {
    const v = this.strs(name);
    v?.forEach((x) => {
      if (!UUID_RE.test(x)) throw bad(name, "Input should be a valid UUID");
    });
    return v;
  }
  ints(name: string): number[] | undefined {
    return this.strs(name)?.map((x) => {
      const n = Number(x);
      if (!Number.isInteger(n)) throw bad(name, "Input should be a valid integer");
      return n;
    });
  }
  /** `YYYY-MM-DD` string (validated). Use for `date` columns (mode "string"). */
  date(name: string): string | undefined {
    const v = this.raw(name);
    if (v === undefined) return undefined;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw bad(name, "Input should be a valid date");
    return v;
  }
  /** ISO datetime (or date) -> Date. */
  datetime(name: string): Date | undefined {
    const v = this.raw(name);
    if (v === undefined) return undefined;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) throw bad(name, "Input should be a valid datetime");
    return d;
  }
  enum<T extends string>(name: string, values: readonly T[]): T | undefined {
    const v = this.raw(name);
    if (v === undefined) return undefined;
    if (!(values as readonly string[]).includes(v)) throw bad(name, `Input should be one of: ${values.join(", ")}`);
    return v as T;
  }
  /** Validate the whole query string with a zod schema (values are strings; use z.coerce.*). */
  parse<S extends ZodTypeAny>(schema: S): z.infer<S> {
    const obj: Record<string, string | string[]> = {};
    for (const key of new Set(this.sp.keys())) {
      const all = this.sp.getAll(key);
      obj[key] = all.length > 1 ? all : all[0];
    }
    return parse(schema, obj, "query");
  }
}

/** `q`, `page`, `page_size`, `sort` (FastAPI ListParams). */
export interface ListParams {
  q: string | undefined;
  page: number;
  page_size: number;
  sort: string | undefined;
}

export class Ctx {
  user: CurrentUser | null = null;
  readonly query: Query;
  readonly url: URL;

  constructor(
    public req: Request,
    public db: Db,
    public params: Record<string, string>,
  ) {
    this.url = new URL(req.url);
    this.query = new Query(this.url.searchParams);
  }

  get ip(): string | null {
    const fwd = this.req.headers.get("x-forwarded-for");
    return fwd ? fwd.split(",")[0].trim() : this.req.headers.get("x-real-ip");
  }
  get userAgent(): string | null {
    return this.req.headers.get("user-agent");
  }

  /** Path param as a validated UUID. */
  uuid(name: string): string {
    const v = this.params[name];
    if (!v || !UUID_RE.test(v)) throw bad(name, "Input should be a valid UUID", "path");
    return v;
  }
  /** Path param as a raw string. */
  param(name: string): string {
    return this.params[name];
  }
  int(name: string): number {
    const n = Number(this.params[name]);
    if (!Number.isInteger(n)) throw bad(name, "Input should be a valid integer", "path");
    return n;
  }

  listParams(o: { defaultPageSize?: number; maxPageSize?: number } = {}): ListParams {
    const q = this.query.str("q", { max: 200 })?.trim();
    return {
      q: q || undefined,
      page: this.query.int("page", { ge: 1 }) ?? 1,
      page_size: this.query.int("page_size", { ge: 1, le: o.maxPageSize ?? 200 }) ?? o.defaultPageSize ?? 25,
      sort: this.query.str("sort", { max: 60 }),
    };
  }

  /** Parse + validate the JSON body (pydantic body model). */
  async body<S extends ZodTypeAny>(schema: S): Promise<z.infer<S>> {
    let data: unknown;
    try {
      data = await this.req.json();
    } catch {
      throw new HttpError(422, [{ loc: ["body"], msg: "Field required", type: "missing" }]);
    }
    return parse(schema, data, "body");
  }
  /** JSON body if present, else `fallback` (FastAPI optional body). */
  async bodyOpt<S extends ZodTypeAny>(schema: S, fallback: z.infer<S>): Promise<z.infer<S>> {
    const text = await this.req.text();
    if (!text.trim()) return fallback;
    return parse(schema, JSON.parse(text), "body");
  }
  /** multipart/form-data (UploadFile + Form fields). */
  async form(): Promise<FormData> {
    try {
      return await this.req.formData();
    } catch {
      throw new HttpError(422, [{ loc: ["body"], msg: "Expected multipart form data", type: "value_error" }]);
    }
  }

  /** `Authed` dependency. */
  async authed(): Promise<CurrentUser> {
    if (!this.user) this.user = await getCurrentUser(this.db, this.req, this.ip);
    return this.user;
  }
  /** `Depends(require(module, action))` */
  async require(module: string, action = "view"): Promise<CurrentUser> {
    return requireUser(await this.authed(), module, action);
  }

  /** Run after the response's transaction commits (FastAPI BackgroundTasks). Opens its own session if it needs the DB. */
  background(fn: () => Promise<void> | void): void {
    this.db.after.push(fn);
  }
}

export type Handler = (ctx: Ctx) => Promise<unknown> | unknown;

interface Route {
  method: string;
  re: RegExp;
  keys: string[];
  handler: Handler;
}

export class Router {
  routes: Route[] = [];

  private add(method: string, path: string, handler: Handler): this {
    const keys: string[] = [];
    const pattern = path.replace(/\{(\w+)(:path)?\}/g, (_m, key, p) => {
      keys.push(key);
      return p ? "(.+)" : "([^/]+)";
    });
    this.routes.push({ method, re: new RegExp(`^${pattern}/?$`), keys, handler });
    return this;
  }
  get = (path: string, h: Handler) => this.add("GET", path, h);
  post = (path: string, h: Handler) => this.add("POST", path, h);
  patch = (path: string, h: Handler) => this.add("PATCH", path, h);
  put = (path: string, h: Handler) => this.add("PUT", path, h);
  delete = (path: string, h: Handler) => this.add("DELETE", path, h);

  /** Merge another router (registration order is preserved). */
  use(other: Router): this {
    this.routes.push(...other.routes);
    return this;
  }

  match(method: string, path: string): { handler: Handler; params: Record<string, string> } | "method" | null {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.re.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { handler: r.handler, params };
    }
    return pathMatched ? "method" : null;
  }
}

export type { Db };
