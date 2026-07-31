import Link from "next/link";

export function Brand() {
  return (
    <Link href="/studio" className="brand">
      <span className="brand-mark">V</span>
      <span>
        Vyn <span style={{ color: "var(--text-dim)", fontWeight: 400 }}>Studio</span>
      </span>
    </Link>
  );
}
