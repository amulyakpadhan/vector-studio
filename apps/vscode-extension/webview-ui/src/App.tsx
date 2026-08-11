/**
 * Top-level shell for the webview. Reconstructs the two Next routes
 * (`/studio` and `/studio/:id`) as a tiny hash router and wraps them in the
 * same providers the web app uses (React Query + Toaster). Every screen below
 * is the unmodified component from `apps/web`.
 */
import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Brand } from "@/components/Brand";
import { Dashboard } from "@/components/Dashboard";
import { Studio } from "@/components/Studio";
import { Toaster } from "@/components/Toaster";

function useHashRoute(): string {
  const [hash, setHash] = useState(() => window.location.hash || "#/studio");
  useEffect(() => {
    const on = () => setHash(window.location.hash || "#/studio");
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}

function StudioHome() {
  return (
    <div className="shell">
      <header className="topbar">
        <Brand />
        <div className="spacer" />
        <a
          className="btn ghost sm"
          href="https://github.com/amulyakpadhan/vyn-studio"
          target="_blank"
          rel="noreferrer"
        >
          GitHub
        </a>
      </header>
      <Dashboard />
    </div>
  );
}

export default function App() {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 15_000 },
        },
      }),
  );

  const hash = useHashRoute();
  // "#/studio" -> home; "#/studio/<id>" -> that connection's studio.
  const match = hash.match(/^#\/studio\/(.+)$/);

  return (
    <QueryClientProvider client={client}>
      {match ? <Studio connectionId={decodeURIComponent(match[1])} /> : <StudioHome />}
      <Toaster />
    </QueryClientProvider>
  );
}
