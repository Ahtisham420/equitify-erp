"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { useUrlState } from "@/hooks/use-url-state";
import { api, type Page, type Params } from "@/lib/api";

/**
 * Standard list hook: reads search/filter/sort/page from the URL and fetches a Page<T>.
 * `extra` adds fixed params (e.g. a parent id) that are not part of the URL.
 */
export function useListQuery<T>(key: string, path: string, extra?: Params, opts: { pageSize?: number } = {}) {
  const url = useUrlState();
  const page = url.getNumber("page", 1);
  const pageSize = url.getNumber("page_size", opts.pageSize ?? 25);
  const params: Params = { ...url.params, ...extra, page, page_size: pageSize };

  const query = useQuery({
    queryKey: [key, "list", path, params],
    queryFn: () => api.get<Page<T>>(path, params),
    placeholderData: keepPreviousData,
  });

  return { ...query, url, page, pageSize, params };
}
