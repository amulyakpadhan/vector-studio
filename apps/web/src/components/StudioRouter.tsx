"use client";

import { useSearchParams } from "next/navigation";
import { Brand } from "./Brand";
import { Dashboard } from "./Dashboard";
import { Studio } from "./Studio";
import { ThemeToggle } from "./ThemeToggle";
import { GITHUB_URL } from "@/lib/links";

/**
 * `/studio` itself vs. `/studio?id=<connectionId>` — a query param rather than
 * a `/studio/[id]` dynamic route, so this page can be statically exported for
 * the Tauri desktop build (`generateStaticParams` has no way to know
 * connection ids, which only ever exist in the browser's own localStorage).
 */
export function StudioRouter() {
  const params = useSearchParams();
  const id = params.get("id");

  if (id) return <Studio connectionId={id} />;

  return (
    <div className="shell">
      <header className="topbar">
        <Brand />
        <div className="spacer" />
        <ThemeToggle />
        <a className="btn ghost sm" href={GITHUB_URL} target="_blank" rel="noreferrer">
          GitHub
        </a>
      </header>
      <Dashboard />
    </div>
  );
}
