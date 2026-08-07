import { Suspense } from "react";
import { StudioRouter } from "@/components/StudioRouter";

export default function StudioHomePage() {
  return (
    <Suspense>
      <StudioRouter />
    </Suspense>
  );
}
