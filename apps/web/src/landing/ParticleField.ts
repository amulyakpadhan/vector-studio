import * as THREE from "three";

/**
 * The landing-page particle field.
 *
 * ~4,000 points that morph between four arrangements as the page scrolls —
 * a raw cloud → semantic clusters → a query neighbourhood ring → an ordered
 * lattice — telling the "chaos becomes structure you can query" story. Color
 * is graded aqua→violet by view depth in the shader, so it shifts as the
 * field slowly rotates. Hand-tuned; not a framework.
 */
export class ParticleField {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly group: THREE.Group;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.ShaderMaterial;

  private readonly count: number;
  private readonly targets: Float32Array[]; // one arrangement per state
  private readonly seeds: Float32Array; // per-particle phase for idle motion
  private readonly current: Float32Array; // live positions

  private progress = 0; // 0..1 scroll progress
  private renderedProgress = 0; // eased toward `progress`
  private clock = new THREE.Clock();
  private raf = 0;
  private disposed = false;
  private reducedMotion = false;
  private readonly ro: ResizeObserver;

  constructor(private readonly canvas: HTMLCanvasElement, count = 4000) {
    this.count = count;
    this.reducedMotion =
      globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio ?? 1, 2));

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 2000);
    this.camera.position.set(0, 0, 150);

    this.group = new THREE.Group();
    this.scene.add(this.group);

    this.targets = [
      this.makeSphere(),
      this.makeClusters(),
      this.makeTorus(),
      this.makeLattice(),
    ];
    this.seeds = new Float32Array(count);
    for (let i = 0; i < count; i++) this.seeds[i] = Math.random() * Math.PI * 2;
    this.current = this.targets[0]!.slice();

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute("position", new THREE.BufferAttribute(this.current, 3));

    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uSize: { value: this.reducedMotion ? 2.2 : 2.6 },
        uScale: { value: 1 },
        uAqua: { value: new THREE.Color("#1fe0c4") },
        uViolet: { value: new THREE.Color("#7a5cff") },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
    });

    this.group.add(new THREE.Points(this.geometry, this.material));

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    this.resize();
    this.animate();
  }

  /** Set scroll progress 0..1 (page top → bottom). */
  setProgress(p: number): void {
    this.progress = Math.max(0, Math.min(1, p));
  }

  // ─── target arrangements ────────────────────────────────────

  private makeSphere(): Float32Array {
    const a = new Float32Array(this.count * 3);
    const R = 62;
    for (let i = 0; i < this.count; i++) {
      // fibonacci sphere + radial jitter → a soft cloud shell
      const t = i / this.count;
      const phi = Math.acos(1 - 2 * t);
      const theta = Math.PI * (1 + Math.sqrt(5)) * i;
      const r = R * (0.7 + Math.random() * 0.3);
      a[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      a[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      a[i * 3 + 2] = r * Math.cos(phi);
    }
    return a;
  }

  private makeClusters(): Float32Array {
    const a = new Float32Array(this.count * 3);
    const K = 7;
    const centers: [number, number, number][] = [];
    for (let k = 0; k < K; k++) {
      const phi = Math.acos(1 - 2 * ((k + 0.5) / K));
      const theta = Math.PI * (1 + Math.sqrt(5)) * k;
      const R = 60;
      centers.push([
        R * Math.sin(phi) * Math.cos(theta),
        R * Math.sin(phi) * Math.sin(theta),
        R * Math.cos(phi),
      ]);
    }
    for (let i = 0; i < this.count; i++) {
      const c = centers[i % K]!;
      a[i * 3] = c[0] + gauss() * 12;
      a[i * 3 + 1] = c[1] + gauss() * 12;
      a[i * 3 + 2] = c[2] + gauss() * 12;
    }
    return a;
  }

  private makeTorus(): Float32Array {
    const a = new Float32Array(this.count * 3);
    const R = 58;
    const r = 15;
    for (let i = 0; i < this.count; i++) {
      const u = (i / this.count) * Math.PI * 2 * 7; // wind around several times
      const v = Math.random() * Math.PI * 2;
      const rr = r * (0.6 + Math.random() * 0.4);
      a[i * 3] = (R + rr * Math.cos(v)) * Math.cos(u);
      a[i * 3 + 1] = rr * Math.sin(v);
      a[i * 3 + 2] = (R + rr * Math.cos(v)) * Math.sin(u);
    }
    return a;
  }

  private makeLattice(): Float32Array {
    const a = new Float32Array(this.count * 3);
    const side = Math.ceil(Math.cbrt(this.count));
    const gap = 118 / side;
    const off = (side - 1) / 2;
    for (let i = 0; i < this.count; i++) {
      const x = i % side;
      const y = Math.floor(i / side) % side;
      const z = Math.floor(i / (side * side)) % side;
      a[i * 3] = (x - off) * gap + gauss() * 1.2;
      a[i * 3 + 1] = (y - off) * gap + gauss() * 1.2;
      a[i * 3 + 2] = (z - off) * gap + gauss() * 1.2;
    }
    return a;
  }

  // ─── loop ───────────────────────────────────────────────────

  private readonly animate = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.animate);

    // ease scroll progress for buttery morphs
    this.renderedProgress += (this.progress - this.renderedProgress) * 0.06;
    const p = this.reducedMotion ? 0.34 : this.renderedProgress;

    const segCount = this.targets.length - 1;
    const scaled = p * segCount;
    const seg = Math.min(segCount - 1, Math.floor(scaled));
    const frac = smoothstep(scaled - seg);
    const from = this.targets[seg]!;
    const to = this.targets[seg + 1]!;

    const t = this.clock.getElapsedTime();
    const pos = this.geometry.getAttribute("position") as THREE.BufferAttribute;
    const arr = this.current;
    const wobble = this.reducedMotion ? 0 : 1;
    for (let i = 0; i < this.count; i++) {
      const j = i * 3;
      const drift = Math.sin(t * 0.6 + this.seeds[i]!) * 0.8 * wobble;
      arr[j] = from[j]! + (to[j]! - from[j]!) * frac + drift;
      arr[j + 1] = from[j + 1]! + (to[j + 1]! - from[j + 1]!) * frac + drift;
      arr[j + 2] = from[j + 2]! + (to[j + 2]! - from[j + 2]!) * frac;
    }
    pos.needsUpdate = true;

    if (!this.reducedMotion) {
      this.group.rotation.y = t * 0.05 + p * Math.PI * 0.6;
      this.group.rotation.x = Math.sin(t * 0.1) * 0.12 + p * 0.2;
    }
    this.camera.position.z = 150 - p * 26;

    this.renderer.render(this.scene, this.camera);
  };

  private resize(): void {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.material.uniforms.uScale!.value = h * this.renderer.getPixelRatio();
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.geometry.dispose();
    this.material.dispose();
    this.renderer.dispose();
  }
}

function gauss(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function smoothstep(x: number): number {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
}

const VERT = /* glsl */ `
  uniform float uSize;
  uniform float uScale;
  varying float vDepth;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vDepth = clamp((-mv.z - 90.0) / 120.0, 0.0, 1.0);
    gl_PointSize = uSize * (uScale / 900.0) * (300.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */ `
  precision mediump float;
  uniform vec3 uAqua;
  uniform vec3 uViolet;
  varying float vDepth;
  void main() {
    vec2 uv = gl_PointCoord - vec2(0.5);
    float d = length(uv);
    if (d > 0.5) discard;
    float glow = smoothstep(0.5, 0.0, d);
    vec3 col = mix(uAqua, uViolet, vDepth);
    gl_FragColor = vec4(col, glow * (0.55 + 0.45 * (1.0 - vDepth)));
  }
`;
