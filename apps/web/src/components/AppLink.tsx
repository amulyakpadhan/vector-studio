"use client";

import { useEffect, useState } from "react";
import NextLink, { type LinkProps } from "next/link";
import type { AnchorHTMLAttributes, PropsWithChildren } from "react";

type Props = PropsWithChildren<
  LinkProps & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, keyof LinkProps | "href">
>;

/**
 * Drop-in replacement for next/link. Next's App Router client-side navigation
 * (RSC payload fetch + history push) is broken specifically inside Tauri's
 * static-export + custom-protocol environment: clicking a Link renders the
 * raw RSC flight payload as literal text instead of the page. This is a
 * known, still-open upstream Next.js bug (vercel/next.js#48642) reproducing
 * only in production static-export builds under Tauri — not fixable from
 * this app's config.
 *
 * Full browser navigations are unaffected (verified directly against the
 * built export), so inside Tauri this renders a plain <a> instead, forcing a
 * real page load for internal links. Identical to next/link everywhere else
 * (the website, `next dev`) — the Tauri check only resolves after mount.
 */
export function AppLink({ href, children, ...rest }: Props) {
  const [isTauri, setIsTauri] = useState(false);
  useEffect(() => setIsTauri("__TAURI_INTERNALS__" in window), []);

  if (isTauri) {
    return (
      <a href={typeof href === "string" ? href : href.pathname ?? "/"} {...rest}>
        {children}
      </a>
    );
  }
  return (
    <NextLink href={href} {...rest}>
      {children}
    </NextLink>
  );
}
