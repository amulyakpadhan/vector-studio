"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { GITHUB_URL } from "@/lib/links";

/** Split a line into per-character spans so it can assemble letter by letter,
 * like values snapping into place. Spaces stay unwrapped so words can wrap.
 *
 * `gradient` paints the brand ramp across the whole phrase: background-clip
 * on a wrapper can't work once the text lives in child spans (the wrapper has
 * no glyphs of its own to clip to), so each character instead samples its own
 * slice of a gradient stretched across every character. */
function ScatterText({
  text,
  delay = 0,
  stagger = 0.028,
  gradient = false,
}: {
  text: string;
  delay?: number;
  stagger?: number;
  gradient?: boolean;
}) {
  const total = Math.max(text.replace(/ /g, "").length, 1);
  let charIndex = 0;
  return (
    <>
      {/* Assistive tech reads this copy; without it the split spans below get
          announced letter by letter. The animated pieces are hidden from the
          accessibility tree so the heading isn't read twice. */}
      <span className="sr-only">{text}</span>
      {text.split(" ").map((word, w, words) => (
        <span className="lp-word" key={`${word}-${w}`} aria-hidden="true">
          {word.split("").map((ch, c) => {
            const i = charIndex++;
            const gradientStyle = gradient
              ? {
                  backgroundSize: `${total * 100}% 100%`,
                  backgroundPosition: `${total > 1 ? (i / (total - 1)) * 100 : 0}% 0`,
                }
              : undefined;
            return (
              <span
                key={`${ch}-${c}`}
                className={`lp-char${gradient ? " lp-char-grad" : ""}`}
                style={{ animationDelay: `${delay + i * stagger}s`, ...gradientStyle }}
              >
                {ch}
              </span>
            );
          })}
          {w < words.length - 1 ? " " : null}
        </span>
      ))}
    </>
  );
}

/** Reveals its children once they scroll into view. Character animations
 * inside start paused (see .lp-reveal .lp-char) and run on reveal, so a
 * heading assembles as it enters the viewport rather than on page load. */
function Reveal({ children, className }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      el.classList.add("is-visible");
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            el.classList.add("is-visible");
            io.unobserve(el); // reveal once, don't re-hide on scroll back
          }
        }
      },
      { threshold: 0.25 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={ref} className={`lp-reveal ${className ?? ""}`}>
      {children}
    </div>
  );
}

/** A scroll-revealed feature block: the frame slides in, then the heading
 * assembles character by character and the body settles in behind it. */
function FeatureCard({
  kicker,
  heading,
  children,
}: {
  kicker: string;
  heading: string;
  children: React.ReactNode;
}) {
  const stagger = 0.016;
  // Body waits for the heading to finish assembling.
  const bodyDelay = 0.22 + heading.replace(/ /g, "").length * stagger + 0.12;
  return (
    <Reveal className="lp-feature-card">
      <div className="lp-kicker lp-fade" style={{ animationDelay: "0.05s" }}>
        {kicker}
      </div>
      <h2>
        <ScatterText text={heading} delay={0.22} stagger={stagger} />
      </h2>
      <p className="lp-fade" style={{ animationDelay: `${bodyDelay}s` }}>
        {children}
      </p>
    </Reveal>
  );
}

export function Landing() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fieldRef = useRef<{ setProgress: (p: number) => void; dispose: () => void } | null>(null);

  useEffect(() => {
    let disposed = false;
    async function boot() {
      const { ParticleField } = await import("@/landing/ParticleField");
      const canvas = canvasRef.current;
      if (!canvas || disposed) return;
      // Fewer particles on small screens — mobile GPUs are the constraint.
      const count = window.innerWidth < 768 ? 1800 : 4000;
      const field = new ParticleField(canvas, count);
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
            Vyn <span className="lp-brand-sub">Studio</span>
          </span>
        </div>
        <div className="lp-nav-right">
          <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="btn ghost sm lp-nav-github">
            GitHub
          </a>
          <Link href="/studio" className="btn primary sm">
            Launch studio
          </Link>
        </div>
      </nav>

      <div className="lp-content">
        <section className="lp-hero">
          <div className="lp-eyebrow lp-fade" style={{ animationDelay: "0.1s" }}>
            The universal vector database studio
          </div>
          <h1 className="lp-title">
            <ScatterText text="See your " delay={0.18} />
            <ScatterText text="vector space." delay={0.36} gradient />
          </h1>
          <p className="lp-lead lp-fade" style={{ animationDelay: "0.8s" }}>
            Connect, browse, search, and visualize any vector database — cloud or self-hosted —
            from one fast, modern UI. The MongoDB Compass for vectors, with a 3D embedding
            explorer no other tool has.
          </p>
          <div className="lp-cta lp-fade" style={{ animationDelay: "0.95s" }}>
            <Link href="/studio" className="btn primary">
              Launch the studio →
            </Link>
            <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="btn">
              ★ Star on GitHub
            </a>
          </div>
          <div className="lp-hint lp-fade" style={{ animationDelay: "1.15s" }}>
            drag or tap the field to disturb it
          </div>
          <div className="lp-scroll-hint">scroll ↓</div>
        </section>

        <section className="lp-feature" id="engines">
          <FeatureCard
            kicker="Every engine, one interface"
            heading="Qdrant, Pinecone, Weaviate — no more juggling consoles."
          >
            One connection manager for all your databases. Browse collections, edit records,
            run vector search — with a UI that adapts to what each engine actually supports.
          </FeatureCard>
        </section>

        <section className="lp-feature right" id="visualize">
          <FeatureCard
            kicker="The differentiator"
            heading="Watch your embeddings become a place."
          >
            Project a collection to 3D with UMAP and explore it as a living point cloud. Color
            by any field. Clusters you can see are semantic neighborhoods you can reason about.
          </FeatureCard>
        </section>

        <section className="lp-feature" id="query">
          <FeatureCard
            kicker="Query, visualized"
            heading="Click a point. Watch its nearest neighbors light up."
          >
            A live similarity search rendered in space — see exactly what a query retrieves and
            why. No embedding API required; it uses the vectors already in your database.
          </FeatureCard>
        </section>

        <section className="lp-feature right" id="privacy">
          <FeatureCard
            kicker="Yours, always"
            heading="Runs in your browser. Credentials never leave your machine."
          >
            No server sits between you and your data. Connect self-hosted databases through the
            tiny local bridge — same trust model as Postman, none of the risk.
          </FeatureCard>
        </section>

        <section className="lp-final">
          <Reveal>
            <h2 className="lp-final-title">
              <ScatterText text="Explore your " delay={0.15} stagger={0.02} />
              <ScatterText text="vector space." delay={0.32} stagger={0.02} gradient />
            </h2>
            <div className="lp-cta lp-fade" style={{ animationDelay: "0.75s" }}>
              <Link href="/studio" className="btn primary">
                Launch the studio →
              </Link>
              <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="btn">
                ★ Star on GitHub
              </a>
            </div>
            <div className="lp-foot lp-fade" style={{ animationDelay: "0.9s" }}>
              Open source · Free forever for solo use
            </div>
          </Reveal>
        </section>
      </div>
    </div>
  );
}
