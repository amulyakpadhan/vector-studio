"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Toaster } from "@/components/Toaster";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { TauriTitleBar } from "@/components/TauriTitleBar";
import { installTauriFetch } from "@/lib/tauriFetch";

// Module scope, not inside the component: must run once before any connector
// makes its first request, and this module only ever loads once per app.
installTauriFetch();

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: 1,
            refetchOnWindowFocus: false,
            staleTime: 15_000,
          },
        },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <TauriTitleBar />
      {children}
      <Toaster />
      <ConfirmDialog />
    </QueryClientProvider>
  );
}
