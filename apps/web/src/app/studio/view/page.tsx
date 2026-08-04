"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { Studio } from "@/components/Studio";

/**
 * A single static page for viewing any connection, id passed as `?id=`
 * instead of a dynamic route segment. Static export (needed for the desktop
 * build) can't pre-render `/studio/[id]` for every id — connection ids are
 * generated client-side at runtime — so this is the export-compatible shape.
 */
function StudioView() {
  const id = useSearchParams().get("id") ?? "";
  return <Studio connectionId={id} />;
}

export default function StudioViewPage() {
  return (
    <Suspense fallback={null}>
      <StudioView />
    </Suspense>
  );
}
