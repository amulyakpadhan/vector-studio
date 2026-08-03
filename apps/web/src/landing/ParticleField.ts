import * as THREE from "three";

/** A click/tap shockwave that expands outward and fades. */
interface Ripple {
  center: THREE.Vector3; // in group-local space
  born: number; // elapsed time at creation
}

const RIPPLE_LIFE = 2.2; // seconds
const RIPPLE_SPEED = 55; // world units/sec the wavefront travels
const RIPPLE_BAND = 20; // thickness of the shockwave shell
const POINTER_RADIUS = 17; // radius around the cursor ray that reacts
const POINTER_PUSH = 7; // how far particles are shoved off the ray

/**
 * The landing-page particle field.
 *
 * ~4,000 points that morph between four arrangements as the page scrolls —
 * a raw cloud → semantic clusters → a query neighbourhood ring → an ordered
 * lattice — telling the "chaos becomes structure you can query" story. Color
 * is graded aqua→violet by view depth in the shader, so it shifts as the
 * field slowly rotates.
 *
 * The field is also interactive: particles are pushed away from the pointer,
 * and a click/tap sends an expanding shockwave through them. Both effects
 * feed an `energy` attribute the shader uses to brighten and enlarge points,
 * so touched regions light up. Hand-tuned; not a framework.
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
  private readonly energy: Float32Array; // 0..1 glow, decays each frame

  private progress = 0; // 0..1 scroll progress
  private renderedProgress = 0; // eased toward `progress`
  private clock = new THREE.Clock();
  private raf = 0;
  private disposed = false;
  private reducedMotion = false;
  private readonly ro: ResizeObserver;

  // pointer interaction
  private readonly pointerNdc = new THREE.Vector2(0, 0);
  private pointerActive = false;
  /** Cursor position on the z=0 plane, kept in WORLD space: the field keeps
   * rotating, so this is re-projected into local space every frame — cache the
   * local value once and the repulsion would slowly orbit off the cursor. */
  private readonly pointerWorld = new THREE.Vector3();
  private readonly pointerLocal = new THREE.Vector3();
  private readonly rayOriginLocal = new THREE.Vector3();
  private readonly rayDirLocal = new THREE.Vector3();
  private readonly raycaster = new THREE.Raycaster();
  private readonly plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  private ripples: Ripple[] = [];

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
    this.energy = new Float32Array(count);

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute("position", new THREE.BufferAttribute(this.current, 3));
    this.geometry.setAttribute("energy", new THREE.BufferAttribute(this.energy, 1));

    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uSize: { value: this.reducedMotion ? 2.2 : 2.6 },
        uScale: { value: 1 },
        uAqua: { value: new THREE.Color("#1fe0c4") },
        uViolet: { value: new THREE.Color("#7a5cff") },
        uHot: { value: new THREE.Color("#ff6b8a") },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
    });

    this.group.add(new THREE.Points(this.geometry, this.material));

    if (!this.reducedMotion) {
      canvas.addEventListener("pointermove", this.onPointerMove, { passive: true });
      canvas.addEventListener("pointerdown", this.onPointerDown, { passive: true });
      canvas.addEventListener("pointerleave", this.onPointerLeave, { passive: true });
    }

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    this.resize();
    this.animate();
  }

  // ─── pointer interaction ────────────────────────────────────

  /** Screen coords → the point on the z=0 plane, in world space. */
  private updatePointerWorld(clientX: number, clientY: number): boolean {
    const rect = this.canvas.getBoundingClientRect();
    this.pointerNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointerNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    return this.raycaster.ray.intersectPlane(this.plane, this.pointerWorld) !== null;
  }

  /** World pointer → the group's (rotating) local frame, for this frame.
   * Also brings the camera position across, so proximity can be measured
   * against the cursor *ray* rather than a single point: a particle that looks
   * like it's under the cursor should react regardless of its depth. */
  private syncPointerLocal(): void {
    this.pointerLocal.copy(this.pointerWorld);
    this.group.worldToLocal(this.pointerLocal);
    this.rayOriginLocal.copy(this.camera.position);
    this.group.worldToLocal(this.rayOriginLocal);
    this.rayDirLocal.copy(this.pointerLocal).sub(this.rayOriginLocal).normalize();
  }

  private readonly onPointerMove = (e: PointerEvent): void => {
    this.pointerActive = this.updatePointerWorld(e.clientX, e.clientY);
  };

  private readonly onPointerLeave = (): void => {
    this.pointerActive = false;
  };

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (!this.updatePointerWorld(e.clientX, e.clientY)) return;
    this.pointerActive = true;
    // Ripples anchor in local space so the wave travels with the field.
    this.syncPointerLocal();
    this.ripples.push({ center: this.pointerLocal.clone(), born: this.clock.getElapsedTime() });
    // Keep only the few most recent — old ones have faded anyway.
    if (this.ripples.length > 4) this.ripples.shift();
  };

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

    // Advance the rotation before anything reads the group's transform, so
    // world→local pointer projection below uses this frame's orientation.
    if (!this.reducedMotion) {
      this.group.rotation.y = t * 0.05 + p * Math.PI * 0.6;
      this.group.rotation.x = Math.sin(t * 0.1) * 0.12 + p * 0.2;
      this.group.updateMatrixWorld();
    }

    const pos = this.geometry.getAttribute("position") as THREE.BufferAttribute;
    const energyAttr = this.geometry.getAttribute("energy") as THREE.BufferAttribute;
    const arr = this.current;
    const nrg = this.energy;
    const wobble = this.reducedMotion ? 0 : 1;

    // Drop ripples that have finished expanding.
    if (this.ripples.length) {
      this.ripples = this.ripples.filter((r) => t - r.born < RIPPLE_LIFE);
    }
    // Re-project the cursor into the (now-rotated) local frame each frame so
    // the repulsion stays under the pointer instead of drifting with the spin.
    if (this.pointerActive) this.syncPointerLocal();
    const ox = this.rayOriginLocal.x;
    const oy = this.rayOriginLocal.y;
    const oz = this.rayOriginLocal.z;
    const dirx = this.rayDirLocal.x;
    const diry = this.rayDirLocal.y;
    const dirz = this.rayDirLocal.z;
    const interactive = this.pointerActive || this.ripples.length > 0;

    for (let i = 0; i < this.count; i++) {
      const j = i * 3;
      const drift = Math.sin(t * 0.6 + this.seeds[i]!) * 0.8 * wobble;
      let x = from[j]! + (to[j]! - from[j]!) * frac + drift;
      let y = from[j + 1]! + (to[j + 1]! - from[j + 1]!) * frac + drift;
      let z = from[j + 2]! + (to[j + 2]! - from[j + 2]!) * frac;

      // Energy decays smoothly so glow fades instead of popping off.
      let e = nrg[i]! * 0.92;

      if (interactive) {
        // Cursor repulsion, measured against the cursor *ray*: take the part of
        // (particle - rayOrigin) perpendicular to the ray, so anything that
        // looks close to the pointer on screen is pushed aside, whatever its
        // depth. Pushing along that perpendicular clears a tunnel under the
        // cursor rather than a sphere floating in space.
        if (this.pointerActive) {
          const vx = x - ox;
          const vy = y - oy;
          const vz = z - oz;
          const along = vx * dirx + vy * diry + vz * dirz;
          if (along > 0) {
            // perpendicular component = v - (v·d)d
            const perpX = vx - along * dirx;
            const perpY = vy - along * diry;
            const perpZ = vz - along * dirz;
            const dist = Math.sqrt(perpX * perpX + perpY * perpY + perpZ * perpZ) || 1e-4;
            if (dist < POINTER_RADIUS) {
              const falloff = 1 - dist / POINTER_RADIUS; // 1 on the axis → 0 at edge
              const shove = (falloff * falloff * POINTER_PUSH) / dist;
              x += perpX * shove;
              y += perpY * shove;
              z += perpZ * shove;
              if (falloff > e) e = falloff;
            }
          }
        }

        // Click ripples: a travelling shell that shoves and lights particles.
        for (const r of this.ripples) {
          const age = t - r.born;
          const radius = age * RIPPLE_SPEED;
          const dx = x - r.center.x;
          const dy = y - r.center.y;
          const dz = z - r.center.z;
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-4;
          const band = Math.abs(dist - radius);
          if (band < RIPPLE_BAND) {
            const fade = 1 - age / RIPPLE_LIFE;
            const strength = (1 - band / RIPPLE_BAND) * fade;
            const shove = (strength * 10) / dist;
            x += dx * shove;
            y += dy * shove;
            z += dz * shove;
            if (strength > e) e = strength;
          }
        }
      }

      arr[j] = x;
      arr[j + 1] = y;
      arr[j + 2] = z;
      nrg[i] = e;
    }
    pos.needsUpdate = true;
    energyAttr.needsUpdate = true;

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
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointerleave", this.onPointerLeave);
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
  attribute float energy;
  uniform float uSize;
  uniform float uScale;
  varying float vDepth;
  varying float vEnergy;
  void main() {
    vEnergy = energy;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vDepth = clamp((-mv.z - 90.0) / 120.0, 0.0, 1.0);
    // Excited particles swell, so touched regions read as brighter clusters.
    gl_PointSize = uSize * (1.0 + energy * 2.2) * (uScale / 900.0) * (300.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */ `
  precision mediump float;
  uniform vec3 uAqua;
  uniform vec3 uViolet;
  uniform vec3 uHot;
  varying float vDepth;
  varying float vEnergy;
  void main() {
    vec2 uv = gl_PointCoord - vec2(0.5);
    float d = length(uv);
    if (d > 0.5) discard;
    float glow = smoothstep(0.5, 0.0, d);
    vec3 col = mix(uAqua, uViolet, vDepth);
    // Energised points shift toward the hot accent. Keep the brightness gain
    // modest — additive blending stacks overlapping points, and pushing harder
    // blows the cluster out to white and loses the brand colour.
    col = mix(col, uHot, vEnergy * 0.8);
    float alpha = glow * (0.55 + 0.45 * (1.0 - vDepth)) * (1.0 + vEnergy * 0.9);
    gl_FragColor = vec4(col * (1.0 + vEnergy * 0.25), min(alpha, 1.0));
  }
`;
