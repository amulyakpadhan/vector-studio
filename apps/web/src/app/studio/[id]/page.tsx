import { Studio } from "@/components/Studio";

export default async function StudioPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Studio connectionId={id} />;
}
