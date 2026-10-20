"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from "react";

import { api, tokenStore } from "@/lib/api";

export type Action = "view" | "create" | "edit" | "approve" | "export" | "delete" | "view_sensitive";

export interface Me {
  id: string;
  email: string;
  full_name: string;
  job_title: string | null;
  role: { id: string; key: string; name: string };
  team_id: string | null;
  status: string;
  mfa_enabled: boolean;
  permissions: Record<string, string[]>;
  approval_limits: Record<string, number | null>;
}

interface AuthContextValue {
  user: Me | null;
  loading: boolean;
  can: (module: string, action?: Action) => boolean;
  signOut: () => Promise<void>;
  refresh: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const hasToken = typeof window !== "undefined" && !!tokenStore.get();

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["me"],
    queryFn: () => api.get<Me>("/auth/me"),
    enabled: hasToken && pathname !== "/login",
    staleTime: 5 * 60_000,
    retry: false,
  });

  useEffect(() => {
    if (pathname !== "/login" && !tokenStore.get()) {
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    }
  }, [pathname, router]);

  const can = useCallback(
    (module: string, action: Action = "view") => {
      const perms = data?.permissions;
      if (!perms) return false;
      if (perms["*"]?.includes("*")) return true;
      const granted = perms[module] ?? [];
      return granted.includes("*") || granted.includes(action);
    },
    [data],
  );

  const signOut = useCallback(async () => {
    try {
      await api.post("/auth/logout");
    } catch {
      /* session may already be gone */
    }
    tokenStore.clear();
    queryClient.clear();
    router.replace("/login");
  }, [queryClient, router]);

  const value = useMemo<AuthContextValue>(
    () => ({ user: data ?? null, loading: hasToken && isLoading, can, signOut, refresh: () => void refetch() }),
    [data, hasToken, isLoading, can, signOut, refetch],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
