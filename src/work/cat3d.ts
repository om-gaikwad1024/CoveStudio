// The mascot: the 3D cat (Image/cat_mascot3d.glb), in its own transparent
// canvas, above the ink trail. Two looks:
//
//   black  (the landing page)  dark matte black with soft white highlights. It
//                              turns to face the pointer wherever it is on the
//                              page. Every three seconds a heat wave ripples
//                              across it, from its back round to its front: the
//                              surface swells as the wave passes and its crest
//                              glows white-hot, cooling to orange, pink and
//                              violet behind it. Slammed by the pointer, the
//                              spot it hit flashes white-hot and a ring of heat
//                              spreads from it through the body; the idle wave
//                              cools away at once and starts its beat again
//                              once the cat has calmed down.
//   sketch (the Works section) light grey clay, diagonal hatching that
//                              thickens into the shadows, a thin lime outline
//
// It never travels between the two: a heat front burns it away from bottom
// left to top right (`dissolve`), and it burns back in, in reverse, in place.

import { BackSide, Box3, BufferGeometry, Group, Mesh, PerspectiveCamera, Scene, ShaderMaterial, Vector3, WebGLRenderer } from "three"
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js"
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js"

const DEG = Math.PI / 180
/** resting yaw (looking a little left) */
export const CAT_REST = -30 * DEG
/** the canvas is this much larger than the cat (room for its bob and hop); must match work.ts */
export const CAT_FRAME = 1.15
/** seconds a slam's heat ring takes to spread through the cat */
const SLAM_TIME = 0.85
/** after the ring, seconds of calm before the idle wave starts its beat again */
const CALM_TIME = 0.9
/** seconds for the idle wave to cool away when the cat is hit */
const IDLE_COOL = 0.2

// The heat waves, in the model's own units (it stands about one unit tall).
const WAVE = /* glsl */ `
uniform float uTime;
uniform float uGold;
uniform float uDissolve;   // 0 whole .. 1 gone
uniform vec3 uSlamP;       // view space: where the slam landed, from the cat's centre
uniform float uSlamT;      // seconds since the slam (< 0: none)
uniform float uIdleT;      // seconds into the idle wave's beat (restarts after a slam)
uniform float uIdleAmp;    // 1 idle wave on .. 0 cooled away
const vec3 WAVE_DIR = vec3(0.86, 0.42, 0.29);
// the idle wave: a band crossing the cat on a slant, once every three seconds
float waveX(vec3 p) {
  float w = mix(-0.75, 1.25, fract(uIdleT / 3.0));
  return (dot(p, WAVE_DIR) - w) / 0.11;   // 0 on the crest, negative behind it
}
// a slam's ring: heat spreading out from the point that was hit, measured as a
// distance through the body (so it wraps round the head and travels to the
// back, rather than sliding across the face). Positive ahead of the crest.
float slamDist(vec3 viewPos, vec3 viewCentre) { return length(viewPos - (viewCentre + uSlamP)); }
float slamX(float d) {
  float R = pow(clamp(uSlamT / ${SLAM_TIME.toFixed(2)}, 0.0, 1.0), 0.8) * 1.35;
  return (d - R) / 0.11;
}
float slamOn() { return uSlamT >= 0.0 && uSlamT < ${(SLAM_TIME + 0.25).toFixed(2)} ? 1.0 - smoothstep(${SLAM_TIME.toFixed(2)}, ${(SLAM_TIME + 0.25).toFixed(2)}, uSlamT) : 0.0; }
// The vanish is a heat wave too: a front sweeps across the cat from bottom
// left to top right. On the front the surface ripples hard; behind it the cat
// is gone. frontX is 0 on the front and grows on the burnt side.
float frontX(vec3 p) {
  float f = mix(-0.7, 1.25, uDissolve);
  return (f - dot(p, WAVE_DIR)) / 0.12;
}
vec3 distort(vec3 p, vec3 n) {
  if (uDissolve <= 0.0) return p;
  float x = frontX(p);
  float band = exp(-x * x * 0.45);
  float rip = sin(x * 3.2 - uTime * 13.0) * band;
  return p + n * rip * 0.028 + WAVE_DIR * band * 0.018;
}
float ripple(float x) { return sin(x * 2.6) * exp(-x * x * 0.35); }`

const CLAY_VS = /* glsl */ `
${WAVE}
varying vec3 vN;
varying vec3 vV;
varying float vX;
varying float vXS;
varying float vSD;
varying vec3 vP;
void main() {
  vec3 centre = (modelViewMatrix * vec4(0.0, 0.5, 0.0, 1.0)).xyz;
  vec3 view0 = (modelViewMatrix * vec4(position, 1.0)).xyz;
  float x = waveX(position);
  float sd = slamDist(view0, centre);
  float xs = slamX(sd);
  // a small packet of ripples riding on each crest, swelling the surface
  float swell = ripple(x) * 0.011 * uGold * uIdleAmp + ripple(xs) * 0.014 * slamOn();
  vec3 p = distort(position + normal * swell, normal);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = -mv.xyz;
  vX = x;
  vXS = xs;
  vSD = sd;
  vP = position;
  gl_Position = projectionMatrix * mv;
}`

const CLAY_FS = /* glsl */ `
uniform float uGold;
uniform float uTime;
uniform float uDissolve;
uniform float uSlamT;
uniform float uIdleAmp;
uniform vec3 uKey;      // view-space light direction
uniform float uPeriod;  // hatch period, device px
varying vec3 vN;
varying vec3 vV;
varying float vX;
varying float vXS;
varying float vSD;
varying vec3 vP;
const vec3 DD = vec3(0.86, 0.42, 0.29);

float fh3(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float fn3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(fh3(i), fh3(i + vec3(1, 0, 0)), f.x), mix(fh3(i + vec3(0, 1, 0)), fh3(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(fh3(i + vec3(0, 0, 1)), fh3(i + vec3(1, 0, 1)), f.x), mix(fh3(i + vec3(0, 1, 1)), fh3(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}

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

// the heat of the waves at this point: the idle wave and a slam's wave
float heatOf(float x) {
  float crest = exp(-x * x * 0.9);
  float wake = x < 0.0 ? exp(x * 0.55) * (1.0 - crest) : 0.0;
  return clamp(crest + wake * 0.55, 0.0, 1.0);
}
vec3 glowOf(float x) {
  float crest = exp(-x * x * 0.9);
  float wake = x < 0.0 ? exp(x * 0.55) * (1.0 - crest) : 0.0;
  return heatRamp(crest * 0.95 + wake * 0.35);
}

void main() {
  // the vanishing front: a ragged burnt edge sweeping bottom left → top right
  float burn = 0.0;
  if (uDissolve > 0.0) {
    float fx = (mix(-0.7, 1.25, uDissolve) - dot(vP, DD)) / 0.12;
    float edge = fx - (fn3(vP * 22.0) - 0.5) * 1.6;
    if (edge > 0.35) discard;
    burn = exp(-edge * edge * 0.5);
  }
  vec3 N = normalize(vN);
  vec3 V = normalize(vV);
  vec3 L = normalize(uKey);
  vec3 col;

  if (uGold > 0.5) {
    // ---- black: dark matte, soft white highlights ----
    float d = dot(N, L);
    float wrap = clamp((d + 0.4) / 1.4, 0.0, 1.0);
    float sky = 0.5 + 0.5 * N.y;
    vec3 H = normalize(L + V);
    float facing = max(dot(N, V), 0.0);
    // a broad, soft sheen (matte: wide and low), a crisp little key highlight,
    // and a faint cool rim that keeps the silhouette off the black ground
    float sheen = pow(max(dot(N, H), 0.0), 9.0) * 0.16;
    float spark = pow(max(dot(N, H), 0.0), 90.0) * 0.55;
    float rim = pow(1.0 - facing, 3.0) * 0.22;
    col = vec3(0.028, 0.028, 0.03) * (0.6 + 0.8 * wrap + 0.4 * sky)
        + vec3(sheen + spark) + vec3(0.82, 0.86, 0.95) * rim;
  } else {
    // ---- sketch: soft grey clay with hatching in the shade ----
    float d = dot(N, L);
    float lit = max(d, 0.0);
    float wrap = clamp((d + 0.35) / 1.35, 0.0, 1.0);
    float sky = 0.5 + 0.5 * N.y;
    vec3 H = normalize(L + V);
    float facing = max(dot(N, V), 0.0);
    float spec = pow(max(dot(N, H), 0.0), 40.0) * 0.18;
    float rim = pow(1.0 - facing, 3.0) * 0.12;
    col = vec3(0.86, 0.86, 0.85) * (0.36 + 0.5 * wrap + 0.14 * sky) + spec + rim;
    float shade = 1.0 - smoothstep(0.1, 0.55, lit * 0.85 + sky * 0.15);
    float coverage = clamp(shade * 0.42, 0.0, 0.3);
    float s = fract((gl_FragCoord.x - gl_FragCoord.y) / uPeriod);
    float aa = 0.9 / uPeriod;
    float stripe = 1.0 - smoothstep(coverage - aa, coverage + aa, abs(s - 0.5));
    col = mix(col, vec3(0.13, 0.13, 0.14), stripe * step(0.02, coverage) * 0.92);
  }

  // the heat waves (hero only): hot on the crest, cooling behind it
  if (uGold > 0.5) {
    // the idle wave (cooling away while the cat has just been hit)
    float h1 = heatOf(vX) * uIdleAmp;
    col = mix(col, col * 0.35 + glowOf(vX), h1 * 0.8);
    // the ring from the point of contact
    float on = uSlamT >= 0.0 && uSlamT < ${(SLAM_TIME + 0.25).toFixed(2)} ? 1.0 - smoothstep(${SLAM_TIME.toFixed(2)}, ${(SLAM_TIME + 0.25).toFixed(2)}, uSlamT) : 0.0;
    float h2 = heatOf(vXS) * on;
    // where the outgoing ring meets the last of the cooling idle crest, a moment hotter
    float meet = exp(-vX * vX * 0.9) * exp(-vXS * vXS * 0.9) * uIdleAmp * on;
    col = mix(col, col * 0.35 + glowOf(vXS), clamp(h2 * 0.85 + meet * 0.6, 0.0, 1.0));
    // the blow itself: a white-hot flash on the spot, gone in a quarter second
    float flash = uSlamT >= 0.0 ? exp(-vSD * vSD / 0.014) * (1.0 - smoothstep(0.0, 0.25, uSlamT)) : 0.0;
    col = mix(col, vec3(1.0, 0.98, 0.92), clamp(flash + meet * 0.45, 0.0, 1.0));
  }
  // the vanishing front burns white-hot, cooling to orange and pink just ahead of it
  col = mix(col, col * 0.3 + heatRamp(0.55 + burn * 0.45), burn * 0.9);
  gl_FragColor = vec4(col, 1.0);
}`

const LINE_VS = /* glsl */ `
${WAVE}
uniform float uWidth;
varying vec3 vP;
void main() {
  float x = waveX(position);
  vec3 p = distort(position + normal * (uWidth + ripple(x) * 0.011 * uGold * uIdleAmp), normal);
  vP = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`

const LINE_FS = /* glsl */ `
uniform float uDissolve;
varying vec3 vP;
float fh3(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float fn3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(fh3(i), fh3(i + vec3(1, 0, 0)), f.x), mix(fh3(i + vec3(0, 1, 0)), fh3(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(fh3(i + vec3(0, 0, 1)), fh3(i + vec3(1, 0, 1)), f.x), mix(fh3(i + vec3(0, 1, 1)), fh3(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}
void main() {
  if (uDissolve > 0.0) {
    float fx = (mix(-0.7, 1.25, uDissolve) - dot(vP, vec3(0.86, 0.42, 0.29))) / 0.12;
    if (fx - (fn3(vP * 22.0) - 0.5) * 1.6 > 0.35) discard;
  }
  gl_FragColor = vec4(0.906, 1.0, 0.0, 1.0);
}`

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
  /** 0 sketch (the Works section) .. 1 matte black with the heat waves (the hero) */
  gold = 1
  /** 0 whole .. 1 burnt away */
  dissolve = 0

  /** spring-driven yaw toward the target; the intro adds a whole turn on top */
  yaw = CAT_REST
  private yawV = 0
  yawTarget = CAT_REST
  spin = { turn: 0 }

  // In the hero it faces the pointer: a yaw and a pitch toward wherever it is,
  // each on its own soft spring (set `look`; null: no pointer, back to rest)
  look: { x: number; y: number } | null = null
  private pitch = 0
  private pitchV = 0
  private slamAt = -1
  /** the idle wave's own clock and strength (a slam cools it, then restarts its beat) */
  private idleT = 0
  private idleAmp = 1
  private idleHoldUntil = -1

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "high-performance" })
    this.renderer.setClearColor(0x000000, 0)
    const shared = {
      uTime: { value: 0 },
      uGold: { value: 1 },
      uDissolve: { value: 0 },
      uSlamP: { value: new Vector3(0, 0, 0.3) },
      uSlamT: { value: -1 },
      uIdleT: { value: 0 },
      uIdleAmp: { value: 1 },
    }
    this.clay = new ShaderMaterial({
      vertexShader: CLAY_VS,
      fragmentShader: CLAY_FS,
      uniforms: {
        ...shared,
        uKey: { value: new Vector3(-0.45, 0.75, 0.55).normalize() },
        uPeriod: { value: 7 },
      },
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
    // one material on every mesh, and an outline hull behind it
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

  /**
   * A blow from the pointer, landing (ox, oy) from the cat's centre on screen,
   * in units of the cat's on-screen size: the spot flashes and a heat ring
   * spreads from it. The idle wave cools away and restarts after the calm.
   */
  slam(ox: number, oy: number) {
    // the cat stands ~1 unit tall and fills 1 / 1.12 of its frame's height
    const x = Math.max(-0.5, Math.min(0.5, ox * 1.12))
    const y = Math.max(-0.55, Math.min(0.55, -oy * 1.12))
    // on its near surface: the hit lands on the front of the body
    ;(this.clay.uniforms.uSlamP.value as Vector3).set(x, y, 0.3)
    this.slamAt = this.t
    this.idleHoldUntil = this.t + SLAM_TIME + CALM_TIME
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

    // facing the pointer: up to ~40° each way, ~18° up or down
    if (this.look) this.yawTarget = this.look.x * 0.7
    const pitchTarget = this.look ? this.look.y * 0.32 : 0
    const pk = 45
    this.pitchV += (pk * (pitchTarget - this.pitch) - 2 * Math.sqrt(pk) * 0.8 * this.pitchV) * dt
    this.pitch += this.pitchV * dt

    this.bob.rotation.x = Math.sin(this.t * 1.1) * 0.035 + this.pitch
    this.bob.rotation.z = Math.sin(this.t * 0.7) * 0.02
    this.bob.position.y = Math.sin(this.t * 1.5) * 0.012

    const g = Math.min(1, Math.max(0, this.gold))
    this.clay.uniforms.uTime.value = this.t
    this.clay.uniforms.uGold.value = g
    this.clay.uniforms.uDissolve.value = Math.min(1, Math.max(0, this.dissolve))
    this.clay.uniforms.uSlamT.value = this.slamAt < 0 ? -1 : this.t - this.slamAt
    // the idle wave: cools away at once when hit; once the cat has calmed it
    // starts its beat from the beginning (off the cat, so it enters cleanly)
    if (this.t < this.idleHoldUntil) this.idleAmp = Math.max(0, this.idleAmp - dt / IDLE_COOL)
    else if (this.idleAmp < 1) {
      this.idleAmp = 1
      this.idleT = 0
    }
    this.idleT += dt
    this.clay.uniforms.uIdleT.value = this.idleT
    this.clay.uniforms.uIdleAmp.value = this.idleAmp
    // the lime outline belongs to the sketch
    this.line.uniforms.uWidth.value = this.lineW * (1 - g)
    const showLine = g < 0.5
    for (const h of this.hulls) h.visible = showLine
    this.renderer.render(this.scene, this.camera)
  }
}
