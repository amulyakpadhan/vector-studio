import { Brand } from "@/components/Brand";
import { Dashboard } from "@/components/Dashboard";

export default function StudioHomePage() {
  return (
    <div className="shell">
      <header className="topbar">
        <Brand />
        <div className="spacer" />
        <a className="btn ghost sm" href="https://github.com/amulyakpadhan/vyn-studio" target="_blank" rel="noreferrer">
          GitHub
        </a>
      </header>
      <Dashboard />
    </div>
  );
}
