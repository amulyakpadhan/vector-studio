import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

export interface ScenePoint {
  positions: number[][]; // N × (2 or 3)
  colors: Float32Array; // N*3, rgb 0..1
  ids: (string | number)[];
}

export interface SceneOptions {
  background?: number;
  baseSize?: number;
  onHover?: (index: number | null) => void;
  onClick?: (index: number | null) => void;
}

const HIGHLIGHT = new THREE.Color("#ff6b8a"); // coral — query hits
const DIM_FACTOR = 0.18; // non-hits fade back when a query overlay is active

/**
 * A self-contained Three.js point-cloud viewer.
 * Renders projected embeddings as glowing round points, with orbit controls,
 * hover/click picking, and a query overlay that highlights matched ids.
 */
export class ProjectionScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly raycaster: THREE.Raycaster;
  private readonly pointer = new THREE.Vector2();

  private points?: THREE.Points;
  private geometry?: THREE.BufferGeometry;
  private material?: THREE.ShaderMaterial;

  private ids: (string | number)[] = [];
  private baseColors = new Float32Array(0);
  private baseSizes = new Float32Array(0);
  private highlighted = new Set<number>();
  private hoverIndex: number | null = null;

  private readonly opts: SceneOptions;
  private readonly baseSize: number;
  private raf = 0;
  private disposed = false;
  private readonly ro: ResizeObserver;

  constructor(private readonly canvas: HTMLCanvasElement, opts: SceneOptions = {}) {
    this.opts = opts;
    this.baseSize = opts.baseSize ?? 9;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio ?? 1, 2));

    this.scene = new THREE.Scene();
    if (opts.background !== undefined) this.scene.background = new THREE.Color(opts.background);

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 5000);
    this.camera.position.set(0, 0, 60);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.rotateSpeed = 0.6;

    this.raycaster = new THREE.Raycaster();
    // Points need an explicit pick threshold; tuned after data loads.
    this.raycaster.params.Points = { threshold: 1.5 };

    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerdown", this.onPointerDown);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    this.resize();
    this.animate();
  }

  /** Load (or replace) the point cloud. Positions may be 2D or 3D. */
  setData(data: ScenePoint): void {
    this.ids = data.ids;
    const n = data.positions.length;

    // Flatten to xyz, tracking bounds so we can auto-fit the camera + scale.
    const flat = new Float32Array(n * 3);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < n; i++) {
      const p = data.positions[i]!;
      const x = p[0] ?? 0;
      const y = p[1] ?? 0;
      const z = p[2] ?? 0;
      flat[i * 3] = x;
      flat[i * 3 + 1] = y;
      flat[i * 3 + 2] = z;
      if (x < min[0]!) min[0] = x;
      if (y < min[1]!) min[1] = y;
      if (z < min[2]!) min[2] = z;
      if (x > max[0]!) max[0] = x;
      if (y > max[1]!) max[1] = y;
      if (z > max[2]!) max[2] = z;
    }

    // Normalize into a stable ~[-30,30] cube so camera framing is predictable.
    const center = [(min[0]! + max[0]!) / 2, (min[1]! + max[1]!) / 2, (min[2]! + max[2]!) / 2];
    const extent = Math.max(max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!, 1e-3);
    const scale = 60 / extent;
    for (let i = 0; i < n; i++) {
      flat[i * 3] = (flat[i * 3]! - center[0]!) * scale;
      flat[i * 3 + 1] = (flat[i * 3 + 1]! - center[1]!) * scale;
      flat[i * 3 + 2] = (flat[i * 3 + 2]! - center[2]!) * scale;
    }

    this.baseColors = data.colors.slice();
    this.baseSizes = new Float32Array(n).fill(this.baseSize);
    this.highlighted.clear();
    this.hoverIndex = null;

    this.disposeGeometry();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(flat, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(this.baseColors.slice(), 3));
    geo.setAttribute("size", new THREE.BufferAttribute(this.baseSizes.slice(), 1));

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      vertexColors: true, // declares the per-vertex `color` attribute the shader reads
      uniforms: { uScale: { value: this.renderer.getSize(new THREE.Vector2()).height } },
      vertexShader: VERT,
      fragmentShader: FRAG,
    });

    this.geometry = geo;
    this.material = mat;
    this.points = new THREE.Points(geo, mat);
    this.scene.clear();
    this.scene.add(this.points);

    // Pick threshold scales with how spread out the (normalized) points are.
    this.raycaster.params.Points = { threshold: Math.max(0.8, 60 / Math.cbrt(Math.max(n, 1))) };
    this.frameCamera();
  }

  /** Replace per-point colors in place (e.g. when the color-by field changes). */
  setColors(colors: Float32Array): void {
    if (colors.length !== this.baseColors.length) return;
    this.baseColors = colors.slice();
    this.applyColorsAndSizes();
  }

  /** Highlight a set of ids (query results). Pass an empty set to clear. */
  setHighlights(ids: Iterable<string | number>): void {
    const wanted = new Set([...ids].map(String));
    this.highlighted.clear();
    this.ids.forEach((id, i) => {
      if (wanted.has(String(id))) this.highlighted.add(i);
    });
    this.applyColorsAndSizes();
  }

  clearHighlights(): void {
    this.highlighted.clear();
    this.applyColorsAndSizes();
  }

  private applyColorsAndSizes(): void {
    if (!this.geometry) return;
    const colorAttr = this.geometry.getAttribute("color") as THREE.BufferAttribute;
    const sizeAttr = this.geometry.getAttribute("size") as THREE.BufferAttribute;
    const n = this.ids.length;
    const hasOverlay = this.highlighted.size > 0;

    for (let i = 0; i < n; i++) {
      let r = this.baseColors[i * 3]!;
      let g = this.baseColors[i * 3 + 1]!;
      let b = this.baseColors[i * 3 + 2]!;
      let size = this.baseSize;

      if (this.highlighted.has(i)) {
        r = HIGHLIGHT.r;
        g = HIGHLIGHT.g;
        b = HIGHLIGHT.b;
        size = this.baseSize * 2.1;
      } else if (hasOverlay) {
        r *= DIM_FACTOR;
        g *= DIM_FACTOR;
        b *= DIM_FACTOR;
      }

      if (i === this.hoverIndex) size = Math.max(size, this.baseSize * 1.8);

      colorAttr.setXYZ(i, r, g, b);
      sizeAttr.setX(i, size);
    }
    colorAttr.needsUpdate = true;
    sizeAttr.needsUpdate = true;
  }

  private frameCamera(): void {
    this.camera.position.set(0, 0, 95);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  private readonly onPointerMove = (e: PointerEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    const idx = this.pick();
    if (idx !== this.hoverIndex) {
      this.hoverIndex = idx;
      this.applyColorsAndSizes();
      this.opts.onHover?.(idx);
      this.canvas.style.cursor = idx === null ? "grab" : "pointer";
    }
  };

  private readonly onPointerDown = (): void => {
    if (this.opts.onClick) this.opts.onClick(this.hoverIndex);
  };

  private pick(): number | null {
    if (!this.points) return null;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObject(this.points, false);
    if (hits.length === 0) return null;
    let best = hits[0]!;
    for (const h of hits) if ((h.distanceToRay ?? Infinity) < (best.distanceToRay ?? Infinity)) best = h;
    return best.index ?? null;
  }

  private resize(): void {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.material) this.material.uniforms.uScale!.value = h * (this.renderer.getPixelRatio());
  }

  private readonly animate = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.animate);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  idAt(index: number): string | number | undefined {
    return this.ids[index];
  }

  private disposeGeometry(): void {
    this.geometry?.dispose();
    this.material?.dispose();
    this.geometry = undefined;
    this.material = undefined;
    this.points = undefined;
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.controls.dispose();
    this.disposeGeometry();
    this.renderer.dispose();
  }
}

// Round, soft-edged points that scale with distance; color + size per vertex.
const VERT = /* glsl */ `
  attribute float size;
  varying vec3 vColor;
  uniform float uScale;
  void main() {
    vColor = color;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = size * (uScale / 900.0) * (300.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */ `
  varying vec3 vColor;
  void main() {
    vec2 uv = gl_PointCoord - vec2(0.5);
    float d = length(uv);
    if (d > 0.5) discard;
    // Solid disc with only a thin anti-aliased edge (crisp, not a soft blob),
    // plus a subtle brighter-center / darker-rim falloff for a glassy look.
    float alpha = smoothstep(0.5, 0.42, d);
    float rim = smoothstep(0.15, 0.5, d);
    vec3 col = mix(vColor * 1.2, vColor * 0.82, rim);
    gl_FragColor = vec4(col, alpha);
  }
`;
