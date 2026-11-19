// The mascot: the 3D cat (Image/cat_mascot3d.glb), in its own transparent
// canvas, above the ink trail. It has two looks and blends between them:
//
//   gold   (the hero)          matte gold, with a heat wave rippling across it
//                              every few seconds: the surface swells as the
//                              wave passes and its crest glows white-hot,
//                              cooling to orange, pink and violet behind it
//   sketch (the Works section) light grey clay, diagonal hatching that
//                              thickens into the shadows, a thin lime outline
//
// It spins once when the Works section arrives, rests looking a little to the
// left, and turns to look right while you hover the reel, a card or the cat.

import { BackSide, Box3, BufferGeometry, Group, Mesh, PerspectiveCamera, Scene, ShaderMaterial, Vector3, WebGLRenderer } from "three"
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js"
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js"

const DEG = Math.PI / 180
/** resting yaw (looking a little left); the page turns it right on hover */
export const CAT_REST = -30 * DEG
/** the canvas is this much larger than the cat (room for its bob); must match work.ts */
export const CAT_FRAME = 1.15

// The heat wave, in the model's own units (it stands about one unit tall):
// a band travels across the cat on a slant, once every three seconds.
const WAVE = /* glsl */ `
uniform float uTime;
uniform float uGold;
const vec3 WAVE_DIR = vec3(0.86, 0.42, 0.29);
float waveX(vec3 p) {
  float w = mix(-0.75, 1.25, fract(uTime / 3.0));
  return (dot(p, WAVE_DIR) - w) / 0.11;   // 0 on the crest, negative behind it
}`

const CLAY_VS = /* glsl */ `
${WAVE}
varying vec3 vN;
varying vec3 vV;
varying float vX;
void main() {
  float x = waveX(position);
  // a small packet of ripples riding on the crest, swelling the surface
  float ripple = sin(x * 2.6) * exp(-x * x * 0.35);
  vec3 p = position + normal * ripple * 0.011 * uGold;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = -mv.xyz;
  vX = x;
  gl_Position = projectionMatrix * mv;
}`

const CLAY_FS = /* glsl */ `
uniform float uGold;
uniform vec3 uKey;      // view-space light direction
uniform float uPeriod;  // hatch period, device px
varying vec3 vN;
varying vec3 vV;
varying float vX;

// heat as it cools: white-hot at the crest, then amber, orange, pink, violet
vec3 heatRamp(float h) {
  h = clamp(h, 0.0, 1.0);
  vec3 cold = vec3(0.42, 0.12, 0.95);
  vec3 pink = vec3(1.0, 0.18, 0.62);
  vec3 orange = vec3(1.0, 0.42, 0.05);
  vec3 amber = vec3(1.0, 0.78, 0.32);
  vec3 white = vec3(1.0, 0.98, 0.92);
  if (h < 0.3) return mix(cold, pink, h / 0.3);
  if (h < 0.6) return mix(pink, orange, (h - 0.3) / 0.3);
  if (h < 0.85) return mix(orange, amber, (h - 0.6) / 0.25);
  return mix(amber, white, (h - 0.85) / 0.15);
}

void main() {
  vec3 N = normalize(vN);
  vec3 V = normalize(vV);
  vec3 L = normalize(uKey);
  float d = dot(N, L);
  float lit = max(d, 0.0);
  float wrap = clamp((d + 0.35) / 1.35, 0.0, 1.0);
  float sky = 0.5 + 0.5 * N.y;
  vec3 H = normalize(L + V);
  float facing = max(dot(N, V), 0.0);

  // ---- sketch: soft grey clay with hatching in the shade ----
  float spec = pow(max(dot(N, H), 0.0), 40.0) * 0.18;
  float rim = pow(1.0 - facing, 3.0) * 0.12;
  vec3 sketch = vec3(0.86, 0.86, 0.85) * (0.36 + 0.5 * wrap + 0.14 * sky) + spec + rim;
  float shade = 1.0 - smoothstep(0.1, 0.55, lit * 0.85 + sky * 0.15);
  float coverage = clamp(shade * 0.42, 0.0, 0.3);
  float s = fract((gl_FragCoord.x - gl_FragCoord.y) / uPeriod);
  float aa = 0.9 / uPeriod;
  float stripe = 1.0 - smoothstep(coverage - aa, coverage + aa, abs(s - 0.5));
  sketch = mix(sketch, vec3(0.13, 0.13, 0.14), stripe * step(0.02, coverage) * 0.92);

  // ---- gold: matte, a broad soft sheen, warm in the shadows ----
  vec3 gold = vec3(0.80, 0.61, 0.28);
  float sheen = pow(max(dot(N, H), 0.0), 10.0) * 0.16;
  vec3 golden = gold * (0.22 + 0.68 * wrap + 0.16 * sky) + vec3(1.0, 0.86, 0.55) * sheen
              + gold * pow(1.0 - facing, 2.5) * 0.25;
  // the heat wave: hot on the crest, cooling behind it, nothing ahead of it
  float x = vX;
  float crest = exp(-x * x * 0.9);
  float wake = x < 0.0 ? exp(x * 0.55) * (1.0 - crest) : 0.0;
  float heat = clamp(crest + wake * 0.55, 0.0, 1.0);
  vec3 glow = heatRamp(crest * 0.95 + wake * 0.35);
  golden = mix(golden, golden * 0.35 + glow, heat * 0.8);

  gl_FragColor = vec4(mix(sketch, golden, uGold), 1.0);
}`

const LINE_VS = /* glsl */ `
${WAVE}
uniform float uWidth;
void main() {
  float x = waveX(position);
  float ripple = sin(x * 2.6) * exp(-x * x * 0.35);
  vec3 p = position + normal * (uWidth + ripple * 0.011 * uGold);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`

const LINE_FS = /* glsl */ `
void main() { gl_FragColor = vec4(0.906, 1.0, 0.0, 1.0); }`

export class Cat3D {
  private renderer: WebGLRenderer
  private scene = new Scene()
  private camera = new PerspectiveCamera(24, 1, 0.1, 30)
  private bob = new Group()
  private pivot = new Group()
  private px = 0
  private t = 0
  private clay: ShaderMaterial
  private line: ShaderMaterial
  private hulls: Mesh[] = []
  private lineW = 0.006
  ready = false
  /** 0 sketch (the Works section) .. 1 matte gold with the heat wave (the hero) */
  gold = 1

  /** spring-driven yaw toward the target; the intro adds a whole turn on top */
  yaw = CAT_REST
  private yawV = 0
  yawTarget = CAT_REST
  spin = { turn: 0 }

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "high-performance" })
    this.renderer.setClearColor(0x000000, 0)
    const shared = { uTime: { value: 0 }, uGold: { value: 1 } }
    this.clay = new ShaderMaterial({
      vertexShader: CLAY_VS,
      fragmentShader: CLAY_FS,
      uniforms: { ...shared, uKey: { value: new Vector3(-0.45, 0.75, 0.55).normalize() }, uPeriod: { value: 7 } },
    })
    this.line = new ShaderMaterial({
      vertexShader: LINE_VS,
      fragmentShader: LINE_FS,
      side: BackSide,
      uniforms: { ...shared, uWidth: { value: 0.006 } },
    })
    this.scene.add(this.bob)
    this.bob.add(this.pivot)
    this.camera.position.set(0, 0, 4)
  }

  async load(url: string) {
    const draco = new DRACOLoader().setDecoderPath("/draco/")
    const loader = new GLTFLoader().setDRACOLoader(draco)
    const gltf = await loader.loadAsync(url)
    draco.dispose()
    const obj = gltf.scene
    const box = new Box3().setFromObject(obj)
    const size = box.getSize(new Vector3())
    const c = box.getCenter(new Vector3())
    const s = 1 / Math.max(size.x, size.y)
    obj.scale.setScalar(s)
    obj.position.set(-c.x * s, -c.y * s, -c.z * s)
    // clay on every mesh, and an outline hull behind it
    const meshes: Mesh[] = []
    obj.traverse((o) => {
      if ((o as Mesh).isMesh) meshes.push(o as Mesh)
    })
    for (const m of meshes) {
      m.material = this.clay
      const hull = new Mesh(m.geometry as BufferGeometry, this.line)
      hull.position.copy(m.position)
      hull.quaternion.copy(m.quaternion)
      hull.scale.copy(m.scale)
      hull.renderOrder = -1
      m.parent?.add(hull)
      this.hulls.push(hull)
    }
    // the outline grows in object units; keep it a fixed fraction of the cat
    this.lineW = 0.0065 / s
    this.pivot.add(obj)
    const fov = (this.camera.fov * Math.PI) / 180
    this.camera.position.z = (0.5 / Math.tan(fov / 2)) * 1.12 * CAT_FRAME
    this.camera.lookAt(0, 0, 0)
    this.ready = true
  }

  /** Drawing-buffer size, set once per layout (the canvas' CSS size is the page's business). */
  setSize(px: number) {
    px = Math.round(px)
    if (px === this.px) return
    this.px = px
    this.renderer.setPixelRatio(1)
    this.renderer.setSize(px, px, false)
    this.camera.aspect = 1
    this.camera.updateProjectionMatrix()
    // about 45 stripes across the cat
    this.clay.uniforms.uPeriod.value = Math.max(4, px / CAT_FRAME / 45)
  }

  /**
   * The buffer keeps one size and the page scales the canvas down as the cat
   * travels; stripes are drawn in buffer pixels, so widen their period as the
   * cat shrinks, keeping them at least ~3.5 screen pixels apart (no shimmer).
   * `scale` is screen device px per buffer px.
   */
  setHatchScale(scale: number) {
    const base = Math.max(4, this.px / CAT_FRAME / 45)
    this.clay.uniforms.uPeriod.value = Math.max(base, 3.5 / Math.max(0.05, scale))
  }

  update(dt: number) {
    if (!this.ready) return
    this.t += dt
    // slightly under-damped: the turn lands with a small overshoot
    const k = 60
    const damp = 2 * Math.sqrt(k) * 0.75
    const a = k * (this.yawTarget - this.yaw) - damp * this.yawV
    this.yawV += a * dt
    this.yaw += this.yawV * dt
    this.pivot.rotation.y = this.yaw + this.spin.turn * Math.PI * 2
    this.bob.rotation.x = Math.sin(this.t * 1.1) * 0.035
    this.bob.rotation.z = Math.sin(this.t * 0.7) * 0.02
    this.bob.position.y = Math.sin(this.t * 1.5) * 0.012
    const g = Math.min(1, Math.max(0, this.gold))
    this.clay.uniforms.uTime.value = this.t
    this.clay.uniforms.uGold.value = g
    this.line.uniforms.uTime.value = this.t
    this.line.uniforms.uGold.value = g
    // the lime outline belongs to the sketch: it thins away into the gold
    this.line.uniforms.uWidth.value = this.lineW * (1 - g)
    const showLine = g < 0.97
    for (const h of this.hulls) h.visible = showLine
    this.renderer.render(this.scene, this.camera)
  }
}
