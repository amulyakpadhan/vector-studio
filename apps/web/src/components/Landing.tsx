"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";

export function Landing() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fieldRef = useRef<{ setProgress: (p: number) => void; dispose: () => void } | null>(null);

  useEffect(() => {
    let disposed = false;
    async function boot() {
      const { ParticleField } = await import("@/landing/ParticleField");
      const canvas = canvasRef.current;
      if (!canvas || disposed) return;
      const field = new ParticleField(canvas);
      fieldRef.current = field;
      update();
    }

    function update() {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const p = max > 0 ? window.scrollY / max : 0;
      fieldRef.current?.setProgress(p);
    }

    void boot();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      disposed = true;
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      fieldRef.current?.dispose();
      fieldRef.current = null;
    };
  }, []);

  return (
    <div className="lp">
      <canvas ref={canvasRef} className="lp-canvas" />

      <nav className="lp-nav">
        <div className="brand">
          <span className="brand-mark">V</span>
          <span>
            Vyn <span style={{ color: "var(--text-dim)", fontWeight: 400 }}>Studio</span>
          </span>
        </div>
        <div className="lp-nav-right">
          <a href="https://github.com/amulyakpadhan/vyn-studio" target="_blank" rel="noreferrer" className="btn ghost sm">
            GitHub
          </a>
          <Link href="/studio" className="btn primary sm">
            Launch studio
          </Link>
        </div>
      </nav>

      <div className="lp-content">
        <section className="lp-hero">
          <div className="lp-eyebrow">The universal vector database studio</div>
          <h1 className="lp-title">
            See your <span className="grad-text">vector space</span>.
          </h1>
          <p className="lp-lead">
            Connect, browse, search, and visualize any vector database — cloud or self-hosted —
            from one fast, modern UI. The MongoDB Compass for vectors, with a 3D embedding
            explorer no other tool has.
          </p>
          <div className="lp-cta">
            <Link href="/studio" className="btn primary">
              Launch the studio →
            </Link>
            <a href="https://github.com/amulyakpadhan/vyn-studio" target="_blank" rel="noreferrer" className="btn">
              ★ Star on GitHub
            </a>
          </div>
          <div className="lp-scroll-hint">scroll ↓</div>
        </section>

        <section className="lp-feature">
          <div className="lp-feature-card">
            <div className="lp-kicker">Every engine, one interface</div>
            <h2>Qdrant, Pinecone, and more — no more juggling consoles.</h2>
            <p>
              One connection manager for all your databases. Browse collections, edit records,
              run vector search — with a UI that adapts to what each engine actually supports.
            </p>
          </div>
        </section>

        <section className="lp-feature right">
          <div className="lp-feature-card">
            <div className="lp-kicker">The differentiator</div>
            <h2>Watch your embeddings become a place.</h2>
            <p>
              Project a collection to 3D with UMAP and explore it as a living point cloud. Color
              by any field. Clusters you can see are semantic neighborhoods you can reason about.
            </p>
          </div>
        </section>

        <section className="lp-feature">
          <div className="lp-feature-card">
            <div className="lp-kicker">Query, visualized</div>
            <h2>Click a point. Watch its nearest neighbors light up.</h2>
            <p>
              A live similarity search rendered in space — see exactly what a query retrieves and
              why. No embedding API required; it uses the vectors already in your database.
            </p>
          </div>
        </section>

        <section className="lp-feature right">
          <div className="lp-feature-card">
            <div className="lp-kicker">Yours, always</div>
            <h2>Runs in your browser. Credentials never leave your machine.</h2>
            <p>
              No server sits between you and your data. Connect self-hosted databases through the
              tiny local bridge — same trust model as Postman, none of the risk.
            </p>
          </div>
        </section>

        <section className="lp-final">
          <h2 className="lp-final-title">
            Explore your <span className="grad-text">vector space</span>.
          </h2>
          <div className="lp-cta">
            <Link href="/studio" className="btn primary">
              Launch the studio →
            </Link>
            <a href="https://github.com/amulyakpadhan/vyn-studio" target="_blank" rel="noreferrer" className="btn">
              ★ Star on GitHub
            </a>
          </div>
          <div className="lp-foot">Open source · Free forever for solo use</div>
        </section>
      </div>
    </div>
  );
}
