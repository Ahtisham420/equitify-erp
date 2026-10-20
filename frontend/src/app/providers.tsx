"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Toaster } from "sonner";

import { TooltipProvider } from "@/components/ui/misc";
import { ApiError } from "@/lib/api";
import { AuthProvider } from "@/lib/auth";

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={client}>
      <AuthProvider>
        <TooltipProvider>
          {children}
          <Toaster
            position="bottom-right"
            toastOptions={{
              classNames: {
                toast: "!rounded-lg !border !border-line !bg-surface !text-ink !shadow-pop !text-sm",
                description: "!text-ink-2",
              },
            }}
          />
        </TooltipProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
