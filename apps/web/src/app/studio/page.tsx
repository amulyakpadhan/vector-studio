import { Brand } from "@/components/Brand";
import { Dashboard } from "@/components/Dashboard";
import { GITHUB_URL } from "@/lib/links";

export default function StudioHomePage() {
  return (
    <div className="shell">
      <header className="topbar">
        <Brand />
        <div className="spacer" />
        <a className="btn ghost sm" href={GITHUB_URL} target="_blank" rel="noreferrer">
          GitHub
        </a>
      </header>
      <Dashboard />
    </div>
  );
}
