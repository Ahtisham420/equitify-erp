"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";

type UrlValue = string | number | boolean | null | undefined | (string | number)[];

/**
 * List state (search, filters, sort, page) lives in the URL so views are shareable,
 * survive refresh and work with the back button.
 */
export function useUrlState() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const params = useMemo(() => {
    const out: Record<string, string | string[]> = {};
    searchParams.forEach((_, key) => {
      const all = searchParams.getAll(key);
      out[key] = all.length > 1 ? all : all[0];
    });
    return out;
  }, [searchParams]);

  const set = useCallback(
    (updates: Record<string, UrlValue>, opts: { resetPage?: boolean } = {}) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        next.delete(key);
        if (value === null || value === undefined || value === "" || value === false) continue;
        if (Array.isArray(value)) value.forEach((v) => next.append(key, String(v)));
        else next.set(key, String(value));
      }
      if (opts.resetPage !== false && !("page" in updates)) next.delete("page");
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  const replaceAll = useCallback(
    (values: Record<string, UrlValue>) => {
      const next = new URLSearchParams();
      for (const [key, value] of Object.entries(values)) {
        if (value === null || value === undefined || value === "") continue;
        if (Array.isArray(value)) value.forEach((v) => next.append(key, String(v)));
        else next.set(key, String(value));
      }
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname],
  );

  const get = useCallback((key: string) => searchParams.get(key), [searchParams]);
  const getAll = useCallback((key: string) => searchParams.getAll(key), [searchParams]);
  const getNumber = useCallback(
    (key: string, fallback: number) => {
      const n = Number(searchParams.get(key));
      return Number.isFinite(n) && n > 0 ? n : fallback;
    },
    [searchParams],
  );

  return { params, get, getAll, getNumber, set, replaceAll };
}
