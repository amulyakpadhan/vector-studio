import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Providers } from "./providers";
import { NO_FLASH_THEME_SCRIPT } from "@/lib/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: "Vyn Studio — the universal vector database studio",
  description: "Connect, browse, search, and visualize any vector database. Cloud or self-hosted.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Tints mobile browser chrome to match whichever theme is active.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f8fa" },
    { media: "(prefers-color-scheme: dark)", color: "#080b10" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Runs before hydration so a saved light/dark preference applies at
            first paint instead of flashing dark, then re-painting. Nothing
            to do here for "system" — the CSS's own prefers-color-scheme
            query already gets that right with no script needed. */}
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH_THEME_SCRIPT }} />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
