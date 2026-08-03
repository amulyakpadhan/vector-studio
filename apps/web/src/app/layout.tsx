import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "Vyn Studio — the universal vector database studio",
  description: "Connect, browse, search, and visualize any vector database. Cloud or self-hosted.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Tints mobile browser chrome to match the app background.
  themeColor: "#080b10",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
