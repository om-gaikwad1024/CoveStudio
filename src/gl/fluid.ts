// A small GPU "stable fluids" solver. It owns two fields:
//   velocity  (sim resolution)  – how the liquid moves
//   dye       (dye resolution)  – r: ink density, g: heat (decays faster), b: spare
// Everything downstream (ink, text inversion, the key's glow) reads the dye.

import { GL, PingPong, Program, Target, blit, createTarget, deleteTarget } from "./gl"

const HEAD = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
`

// Up to MAX_SPLATS gaussian stamps in one pass. uP: (x, y, fx, fy); uC: (ink, heat, radius², _)
export const MAX_SPLATS = 24
// The stamps alone (no read of the field): drawn additively into the field,
// and only inside the stamps' bounding box, so the cost follows the pointer
// rather than the screen.
const SPLAT = HEAD + `
uniform float uAspect;
uniform vec4 uP[${MAX_SPLATS}];
uniform vec4 uC[${MAX_SPLATS}];
uniform int uN;
uniform int uMode;
void main() {
    vec3 acc = vec3(0.0);
    for (int i = 0; i < ${MAX_SPLATS}; i++) {
        if (i >= uN) break;
        vec2 p = vUv - uP[i].xy;
        p.x *= uAspect;
        float g = exp(-dot(p, p) / uC[i].z);
        acc += uMode == 0 ? vec3(uP[i].zw * g, 0.0) : vec3(uC[i].xy * g, 0.0);
    }
    o = vec4(acc, 0.0);
}`

const ADVECT = HEAD + `
uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform vec2 uTexel;
uniform float uDt;
uniform vec3 uDissipation;
uniform vec2 uSrcTexel;
uniform float uTension;
uniform float uCeil;
uniform float uErode;
uniform vec2 uErodeScale;
void main() {
    vec2 coord = vUv - uDt * texture(uVelocity, vUv).xy * uTexel;
    vec4 r = texture(uSource, coord);
    // Surface tension, cheaply: a little smoothing every step rounds every edge
    // and swallows thin wisps, so the liquid holds together and retracts into
    // beads (mercury) instead of tearing into threads (water).
    if (uTension > 0.0) {
        vec4 n = texture(uSource, coord + vec2(uSrcTexel.x, 0.0)) + texture(uSource, coord - vec2(uSrcTexel.x, 0.0))
               + texture(uSource, coord + vec2(0.0, uSrcTexel.y)) + texture(uSource, coord - vec2(0.0, uSrcTexel.y));
        r = mix(r, n * 0.25, uTension);
    }
    r.x = min(r.x, uCeil);
    // Evaporation: ink is eaten away at a steady rate rather than faded, so the
    // outline creeps inward from the moment it is laid, thin parts go first and
    // pinch off into beads, and thick cores shrink last. The rate varies a
    // little across the surface, so a trail splits into strands as it dries.
    if (uErode > 0.0) {
        vec2 q = vUv * uErodeScale;
        vec2 i = floor(q);
        vec2 f = fract(q);
        f = f * f * (3.0 - 2.0 * f);
        float a = fract(sin(dot(i, vec2(127.1, 311.7))) * 43758.5);
        float b = fract(sin(dot(i + vec2(1.0, 0.0), vec2(127.1, 311.7))) * 43758.5);
        float c = fract(sin(dot(i + vec2(0.0, 1.0), vec2(127.1, 311.7))) * 43758.5);
        float d = fract(sin(dot(i + vec2(1.0, 1.0), vec2(127.1, 311.7))) * 43758.5);
        float n = mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
        r.x = max(r.x - uErode * uDt * (0.55 + 0.9 * n), 0.0);
    }
    o = vec4(r.xyz / (1.0 + uDissipation * uDt), 1.0);
}`

const DIVERGENCE = HEAD + `
uniform sampler2D uVelocity;
uniform vec2 uTexel;
void main() {
    float L = texture(uVelocity, vUv - vec2(uTexel.x, 0.0)).x;
    float R = texture(uVelocity, vUv + vec2(uTexel.x, 0.0)).x;
    float T = texture(uVelocity, vUv + vec2(0.0, uTexel.y)).y;
    float B = texture(uVelocity, vUv - vec2(0.0, uTexel.y)).y;
    vec2 C = texture(uVelocity, vUv).xy;
    if (vUv.x - uTexel.x < 0.0) L = -C.x;
    if (vUv.x + uTexel.x > 1.0) R = -C.x;
    if (vUv.y + uTexel.y > 1.0) T = -C.y;
    if (vUv.y - uTexel.y < 0.0) B = -C.y;
    o = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
}`

const CURL = HEAD + `
uniform sampler2D uVelocity;
uniform vec2 uTexel;
void main() {
    float L = texture(uVelocity, vUv - vec2(uTexel.x, 0.0)).y;
    float R = texture(uVelocity, vUv + vec2(uTexel.x, 0.0)).y;
    float T = texture(uVelocity, vUv + vec2(0.0, uTexel.y)).x;
    float B = texture(uVelocity, vUv - vec2(0.0, uTexel.y)).x;
    o = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0);
}`

// Vorticity keeps the neck wobbly; gravity pulls dense ink down so thin
// parts sag into drips, as paint does.
const FORCES = HEAD + `
uniform sampler2D uVelocity;
uniform sampler2D uCurl;
uniform sampler2D uDye;
uniform vec2 uTexel;
uniform float uCurlAmt;
uniform float uGravity;
uniform float uDt;
void main() {
    float L = texture(uCurl, vUv - vec2(uTexel.x, 0.0)).x;
    float R = texture(uCurl, vUv + vec2(uTexel.x, 0.0)).x;
    float T = texture(uCurl, vUv + vec2(0.0, uTexel.y)).x;
    float B = texture(uCurl, vUv - vec2(0.0, uTexel.y)).x;
    float C = texture(uCurl, vUv).x;
    vec2 f = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
    f /= length(f) + 0.0001;
    f *= uCurlAmt * C;
    f.y *= -1.0;
    vec2 v = texture(uVelocity, vUv).xy;
    float d = texture(uDye, vUv).r;
    v += f * uDt;
    v.y -= uGravity * smoothstep(0.25, 1.2, d) * uDt;
    o = vec4(clamp(v, -1000.0, 1000.0), 0.0, 1.0);
}`

const PRESSURE = HEAD + `
uniform sampler2D uPressure;
uniform sampler2D uDivergence;
uniform vec2 uTexel;
void main() {
    float L = texture(uPressure, vUv - vec2(uTexel.x, 0.0)).x;
    float R = texture(uPressure, vUv + vec2(uTexel.x, 0.0)).x;
    float T = texture(uPressure, vUv + vec2(0.0, uTexel.y)).x;
    float B = texture(uPressure, vUv - vec2(0.0, uTexel.y)).x;
    float div = texture(uDivergence, vUv).x;
    o = vec4((L + R + B + T - div) * 0.25, 0.0, 0.0, 1.0);
}`

const GRADIENT = HEAD + `
uniform sampler2D uPressure;
uniform sampler2D uVelocity;
uniform vec2 uTexel;
void main() {
    float L = texture(uPressure, vUv - vec2(uTexel.x, 0.0)).x;
    float R = texture(uPressure, vUv + vec2(uTexel.x, 0.0)).x;
    float T = texture(uPressure, vUv + vec2(0.0, uTexel.y)).x;
    float B = texture(uPressure, vUv - vec2(0.0, uTexel.y)).x;
    vec2 v = texture(uVelocity, vUv).xy - vec2(R - L, T - B);
    o = vec4(v, 0.0, 1.0);
}`

// The drag field: for each point, how far the page seen there has been carried
// by the liquid (in uv). It is advected with the flow, so letters under the
// trail are dragged and curled along with it, then it relaxes back to zero and
// the letters slide home.
const DRAG = HEAD + `
uniform sampler2D uVelocity;
uniform sampler2D uOffset;
uniform vec2 uTexel;
uniform float uDt;
uniform float uDrag;
uniform float uRelax;
uniform vec2 uSrcTexel;
void main() {
    vec2 u = uDt * texture(uVelocity, vUv).xy * uTexel * uDrag;
    vec2 c = vUv - u;
    // a touch of smoothing keeps the drag coherent: letters bend, never shred
    vec2 e = uSrcTexel;
    vec2 off = texture(uOffset, c).xy * 0.6
             + (texture(uOffset, c + vec2(e.x, 0.0)).xy + texture(uOffset, c - vec2(e.x, 0.0)).xy
              + texture(uOffset, c + vec2(0.0, e.y)).xy + texture(uOffset, c - vec2(0.0, e.y)).xy) * 0.1;
    off -= u;
    off /= 1.0 + uRelax * uDt;
    float l = length(off);
    if (l > 0.025) off *= 0.025 / l;
    o = vec4(off, 0.0, 1.0);
}`

const SCALE = HEAD + `
uniform sampler2D uTex;
uniform float uValue;
void main() { o = uValue * texture(uTex, vUv); }`

export interface FluidSettings {
  simRes: number
  dyeRes: number
  velocityDissipation: number
  inkDissipation: number
  /** ink eaten per second (evaporation from the outline in) */
  erode: number
  heatDissipation: number
  pressure: number
  pressureIterations: number
  curl: number
  gravity: number
  /** 0..1 smoothing of the dye per step: higher reads heavier, more cohesive */
  tension: number
  /** how far the type under the liquid is dragged by its flow (x the flow) */
  drag: number
  /** how fast dragged type slides back into place (1/s) */
  relax: number
}

export const DEFAULT_FLUID: FluidSettings = {
  simRes: 128,
  dyeRes: 300,
  velocityDissipation: 2.4,
  inkDissipation: 0.1,
  erode: 1.35,
  heatDissipation: 2.2,
  pressure: 0.8,
  pressureIterations: 6,
  curl: 0,
  gravity: 34,
  tension: 0.07,
  drag: 0.5,
  relax: 1.3,
}

export class Fluid {
  velocity!: PingPong
  dye!: PingPong
  offset!: PingPong
  private dragP: Program
  pressure!: PingPong
  divergence!: Target
  curl!: Target
  private splatP: Program
  private advectP: Program
  private divP: Program
  private curlP: Program
  private forceP: Program
  private presP: Program
  private gradP: Program
  private scaleP: Program
  private aspect = 1
  settings: FluidSettings

  constructor(private gl: GL, private fmt: { rg: any; rgba: any; r: any }, settings: FluidSettings) {
    this.settings = { ...settings }
    this.splatP = new Program(gl, SPLAT)
    this.advectP = new Program(gl, ADVECT)
    this.divP = new Program(gl, DIVERGENCE)
    this.curlP = new Program(gl, CURL)
    this.forceP = new Program(gl, FORCES)
    this.presP = new Program(gl, PRESSURE)
    this.gradP = new Program(gl, GRADIENT)
    this.scaleP = new Program(gl, SCALE)
    this.dragP = new Program(gl, DRAG)
  }

  private res(base: number, w: number, h: number) {
    const a = w / h
    const min = Math.round(base)
    const max = Math.round(base * Math.max(a, 1 / a))
    return w > h ? { w: max, h: min } : { w: min, h: max }
  }

  resize(cssW: number, cssH: number) {
    const gl = this.gl
    this.aspect = cssW / cssH
    const s = this.res(this.settings.simRes, cssW, cssH)
    const d = this.res(this.settings.dyeRes, cssW, cssH)
    const L = gl.LINEAR
    const N = gl.NEAREST
    // Fields are rebuilt fresh; a resize is rare and the ink is ephemeral anyway.
    this.velocity?.dispose(gl)
    this.dye?.dispose(gl)
    this.offset?.dispose(gl)
    this.pressure?.dispose(gl)
    deleteTarget(gl, this.divergence)
    deleteTarget(gl, this.curl)
    this.velocity = new PingPong(gl, s.w, s.h, this.fmt.rg, L)
    this.dye = new PingPong(gl, d.w, d.h, this.fmt.rgba, L)
    this.offset = new PingPong(gl, d.w, d.h, this.fmt.rg, L)
    this.pressure = new PingPong(gl, s.w, s.h, this.fmt.r, N)
    this.divergence = createTarget(gl, s.w, s.h, this.fmt.r, N)
    this.curl = createTarget(gl, s.w, s.h, this.fmt.r, N)
  }

  private pBuf = new Float32Array(MAX_SPLATS * 4)
  private cBuf = new Float32Array(MAX_SPLATS * 4)
  private n = 0

  /**
   * Queues a stamp. x, y in 0..1 (y up); fx, fy force; ink/heat dye amounts;
   * radius as a share of screen height (distances are measured in heights
   * because x is scaled by the aspect).
   */
  splat(x: number, y: number, fx: number, fy: number, ink: number, heat: number, radius: number) {
    if (this.n >= MAX_SPLATS) this.flush()
    const i = this.n++ * 4
    this.pBuf[i] = x
    this.pBuf[i + 1] = y
    this.pBuf[i + 2] = fx
    this.pBuf[i + 3] = fy
    this.cBuf[i] = ink
    this.cBuf[i + 1] = heat
    this.cBuf[i + 2] = radius * radius
  }

  /** Applies queued stamps: one pass into velocity, one into dye. */
  flush() {
    if (!this.n) return
    const gl = this.gl
    // bounding box of the queued stamps, 3 sigma out, in uv
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0
    for (let i = 0; i < this.n; i++) {
      const j = i * 4
      const r = Math.sqrt(this.cBuf[j + 2]) * 3
      const rx = r / this.aspect
      x0 = Math.min(x0, this.pBuf[j] - rx)
      x1 = Math.max(x1, this.pBuf[j] + rx)
      y0 = Math.min(y0, this.pBuf[j + 1] - r)
      y1 = Math.max(y1, this.pBuf[j + 1] + r)
    }
    x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(1, x1); y1 = Math.min(1, y1)
    if (x1 <= x0 || y1 <= y0) {
      this.n = 0
      return
    }
    const p = this.splatP.use()
    gl.uniform4fv(p.loc("uP"), this.pBuf)
    gl.uniform4fv(p.loc("uC"), this.cBuf)
    gl.uniform1i(p.loc("uN"), this.n)
    p.f1("uAspect", this.aspect)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE)
    gl.enable(gl.SCISSOR_TEST)
    const into = (t: Target, mode: number) => {
      gl.uniform1i(p.loc("uMode"), mode)
      const sx = Math.floor(x0 * t.w)
      const sy = Math.floor(y0 * t.h)
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo)
      gl.viewport(0, 0, t.w, t.h)
      gl.scissor(sx, sy, Math.ceil(x1 * t.w) - sx + 1, Math.ceil(y1 * t.h) - sy + 1)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }
    into(this.velocity.read, 0)
    into(this.dye.read, 1)
    gl.disable(gl.SCISSOR_TEST)
    gl.disable(gl.BLEND)
    this.n = 0
  }

  step(dt: number) {
    const gl = this.gl
    const S = this.settings
    this.flush()
    const v = this.velocity
    const tx = 1 / v.read.w
    const ty = 1 / v.read.h
    gl.disable(gl.BLEND)

    // vorticity only when asked for: the mercury trail runs without swirl
    if (S.curl > 0) {
      this.curlP.use().f2("uTexel", tx, ty).tex("uVelocity", v.read.tex)
      blit(gl, this.curl)
    }

    this.forceP
      .use()
      .f2("uTexel", tx, ty)
      .f1("uCurlAmt", S.curl)
      .f1("uGravity", S.gravity)
      .f1("uDt", dt)
      .tex("uVelocity", v.read.tex)
      .tex("uCurl", this.curl.tex)
      .tex("uDye", this.dye.read.tex)
    blit(gl, v.write)
    v.swap()

    this.divP.use().f2("uTexel", tx, ty).tex("uVelocity", v.read.tex)
    blit(gl, this.divergence)

    this.scaleP.use().f1("uValue", S.pressure).tex("uTex", this.pressure.read.tex)
    blit(gl, this.pressure.write)
    this.pressure.swap()

    const pp = this.presP.use().f2("uTexel", tx, ty).tex("uDivergence", this.divergence.tex)
    for (let i = 0; i < S.pressureIterations; i++) {
      pp.tex("uPressure", this.pressure.read.tex)
      blit(gl, this.pressure.write)
      this.pressure.swap()
    }

    this.gradP.use().f2("uTexel", tx, ty).tex("uPressure", this.pressure.read.tex).tex("uVelocity", v.read.tex)
    blit(gl, v.write)
    v.swap()

    const a = this.advectP.use().f2("uTexel", tx, ty).f1("uDt", dt)
    a.tex("uVelocity", v.read.tex).tex("uSource", v.read.tex)
    a.f3("uDissipation", S.velocityDissipation, S.velocityDissipation, S.velocityDissipation)
    a.f2("uSrcTexel", tx, ty).f1("uTension", 0).f1("uCeil", 1e4).f1("uErode", 0)
    blit(gl, v.write)
    v.swap()

    a.tex("uVelocity", v.read.tex).tex("uSource", this.dye.read.tex)
    a.f3("uDissipation", S.inkDissipation, 0, 1)
    a.f2("uSrcTexel", 1 / this.dye.read.w, 1 / this.dye.read.h).f1("uTension", S.tension).f1("uCeil", 1.6).f1("uErode", S.erode)
    a.f2("uErodeScale", 9 * this.aspect, 9)
    blit(gl, this.dye.write)
    this.dye.swap()

    this.dragP
      .use()
      .f2("uTexel", tx, ty)
      .f1("uDt", dt)
      .f1("uDrag", S.drag)
      .f1("uRelax", S.relax)
      .f2("uSrcTexel", 1 / this.offset.read.w, 1 / this.offset.read.h)
      .tex("uVelocity", v.read.tex)
      .tex("uOffset", this.offset.read.tex)
    blit(gl, this.offset.write)
    this.offset.swap()
  }
}
