export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000/api/v1";

const TOKEN_KEY = "eqf_token";

export const tokenStore = {
  get(): string | null {
    if (typeof window === "undefined") return null;
    return window.localStorage.getItem(TOKEN_KEY);
  },
  set(token: string) {
    window.localStorage.setItem(TOKEN_KEY, token);
  },
  clear() {
    window.localStorage.removeItem(TOKEN_KEY);
  },
};

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

type Scalar = string | number | boolean | null | undefined;
export type Params = Record<string, Scalar | Scalar[]>;

export class ApiError extends Error {
  constructor(
    public status: number,
    public detail: unknown,
    message: string,
  ) {
    super(message);
  }
}

export function toQuery(params?: Params): string {
  if (!params) return "";
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) {
      if (v === null || v === undefined || v === "") continue;
      sp.append(key, String(v));
    }
  }
  const qs = sp.toString();
  return qs ? `?${qs}` : "";
}

function describe(detail: unknown, fallback: string): string {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((d: { loc?: (string | number)[]; msg?: string }) => {
        const field = d.loc?.filter((p) => p !== "body").join(".");
        return field ? `${field}: ${d.msg}` : d.msg;
      })
      .join("; ");
  }
  if (detail && typeof detail === "object" && "message" in detail) {
    return String((detail as { message: unknown }).message);
  }
  return fallback;
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong";
}

async function request<T>(method: string, path: string, opts: { params?: Params; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const token = tokenStore.get();
  if (token) headers.Authorization = `Bearer ${token}`;

  let body: BodyInit | undefined;
  if (opts.body instanceof FormData) {
    body = opts.body;
  } else if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}${toQuery(opts.params)}`, { method, headers, body });
  } catch {
    throw new ApiError(0, null, "Cannot reach the server. Check your connection.");
  }

  // An expired/revoked session (including on /auth/me) sends the user to sign in again; only the sign-in calls
  // themselves report their 401 inline.
  if (res.status === 401 && !path.startsWith("/auth/login") && !path.startsWith("/auth/mfa")) {
    tokenStore.clear();
    if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
      const next = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.href = `/login?next=${next}`;
    }
  }

  if (!res.ok) {
    let detail: unknown = null;
    try {
      detail = (await res.json()).detail;
    } catch {
      /* non-JSON error */
    }
    throw new ApiError(res.status, detail, describe(detail, `Request failed (${res.status})`));
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

async function download(path: string, params: Params | undefined, filename: string): Promise<void> {
  const token = tokenStore.get();
  const res = await fetch(`${API_URL}${path}${toQuery(params)}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    let detail: unknown = null;
    try {
      detail = (await res.json()).detail;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, detail, describe(detail, "Export failed"));
  }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export const api = {
  get: <T>(path: string, params?: Params) => request<T>("GET", path, { params }),
  post: <T>(path: string, body?: unknown, params?: Params) => request<T>("POST", path, { body, params }),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, { body }),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, { body }),
  delete: <T = void>(path: string) => request<T>("DELETE", path),
  download,
};
