// Small living pieces of the hero: the wireframe globe in the chrome and the
// spring-driven 3D tilt for the wordmark and the CD case.

import type { MaskSource } from "./gl/mask"

interface Pointer {
  x: number
  y: number
  over: boolean
}

const TAU = Math.PI * 2

/**
 * A transparent wireframe globe, turning slowly. Three meridians 60° apart make
 * a pattern that repeats every 60°, so the spin reads as continuous.
 */
export class Globe implements MaskSource {
  private mers: SVGEllipseElement[]
  private phase = 0
  private rx: number
  private ry: number
  private cx: number
  private cy: number
  /** degrees per second */
  speed = 14

  constructor(private svg: SVGSVGElement) {
    this.mers = Array.from(svg.querySelectorAll<SVGEllipseElement>(".globe__mer"))
    const rim = svg.querySelector<SVGEllipseElement>(".globe__rim")!
    this.rx = rim.rx.baseVal.value
    this.ry = rim.ry.baseVal.value
    this.cx = rim.cx.baseVal.value
    this.cy = rim.cy.baseVal.value
    this.update(0)
  }

  meridians() {
    return this.widths()
  }

  private widths() {
    return this.mers.map((_, i) => this.rx * Math.abs(Math.sin(this.phase + (i * TAU) / 6)))
  }

  update(dt: number) {
    this.phase = (this.phase + (dt * this.speed * Math.PI) / 180) % TAU
    const w = this.widths()
    this.mers.forEach((m, i) => m.setAttribute("rx", w[i].toFixed(2)))
  }

  paint(ctx: CanvasRenderingContext2D) {
    const m = this.svg.getScreenCTM()
    if (!m) return
    let op = 1
    for (let n: Element | null = this.svg; n && n !== document.body; n = n.parentElement) {
      op *= parseFloat(getComputedStyle(n).opacity) || 0
    }
    if (op <= 0.01 || getComputedStyle(this.svg).display === "none") return
    const { cx, cy, rx, ry } = this
    ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f)
    ctx.globalAlpha = op
    ctx.strokeStyle = "#fff"
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.ellipse(cx, cy, rx, ry, 0, 0, TAU)
    ctx.moveTo(cx - rx, cy)
    ctx.lineTo(cx + rx, cy)
    const hw = rx * Math.sqrt(1 - 0.25)
    ctx.moveTo(cx - hw, cy - ry / 2)
    ctx.lineTo(cx + hw, cy - ry / 2)
    ctx.moveTo(cx - hw, cy + ry / 2)
    ctx.lineTo(cx + hw, cy + ry / 2)
    for (const w of this.widths()) {
      ctx.moveTo(cx + w, cy)
      ctx.ellipse(cx, cy, Math.max(0.01, w), ry, 0, 0, TAU)
    }
    ctx.stroke()
  }
}

export interface TiltOptions {
  /** degrees of rotation at full lean */
  maxX: number
  maxY: number
  /** how far around the element the pointer is felt, as a multiple of its half size */
  reach: number
  /** px of drift toward the pointer */
  shift: number
  perspective: number
  /** an idle bob and sway, for objects */
  float?: boolean
}

/**
 * Turns an element ever so slightly toward the pointer, in 3D, on a damped
 * spring, so it settles instead of snapping. The face turns to look at the
 * cursor; away from it, it eases home.
 */
export class Tilt {
  private rx = 0
  private ry = 0
  private vx = 0
  private vy = 0
  private tx = 0
  private ty = 0
  private t = Math.random() * 10

  constructor(private el: HTMLElement, private o: TiltOptions) {}

  update(dt: number, p: Pointer) {
    this.t += dt
    // measure the untransformed box through the parent so the tilt does not feed back
    const box = (this.el.parentElement ?? this.el).getBoundingClientRect()
    const cx = box.left + box.width / 2
    const cy = box.top + box.height / 2
    let nx = 0
    let ny = 0
    if (p.over) {
      nx = (p.x - cx) / ((box.width / 2) * this.o.reach)
      ny = (p.y - cy) / ((box.height / 2) * this.o.reach)
      // fade out beyond reach rather than cutting off
      const d = Math.max(Math.abs(nx), Math.abs(ny))
      const k = d > 1 ? Math.max(0, 1 - (d - 1) * 1.5) : 1
      nx = Math.max(-1, Math.min(1, nx)) * k
      ny = Math.max(-1, Math.min(1, ny)) * k
    }
    const targetY = nx * this.o.maxY
    const targetX = -ny * this.o.maxX
    // critically damped-ish spring: weighty, no overshoot worth noticing
    const w = 7
    const z = 0.82
    this.vy += (w * w * (targetY - this.ry) - 2 * z * w * this.vy) * dt
    this.vx += (w * w * (targetX - this.rx) - 2 * z * w * this.vx) * dt
    this.ry += this.vy * dt
    this.rx += this.vx * dt
    const kf = 1 - Math.exp(-dt * 6)
    this.tx += (nx * this.o.shift - this.tx) * kf
    this.ty += (ny * this.o.shift - this.ty) * kf

    let fy = 0
    let fr = 0
    if (this.o.float) {
      fy = Math.sin(this.t * 1.4) * 4
      fr = Math.sin(this.t * 0.9) * 2.5
    }
    this.el.style.transform =
      `perspective(${this.o.perspective}px) translate3d(${this.tx.toFixed(2)}px, ${(this.ty + fy).toFixed(2)}px, 0) ` +
      `rotateX(${this.rx.toFixed(3)}deg) rotateY(${this.ry.toFixed(3)}deg) rotateZ(${fr.toFixed(3)}deg)`
  }
}

// ---------- live marks for the GPU ----------

/** Unit square → quad homography (Heckbert), rows [a b c; d e f; g h 1]. */
function squareToQuad(q: { x: number; y: number }[]) {
  const [p0, p1, p2, p3] = q
  const dx1 = p1.x - p2.x
  const dx2 = p3.x - p2.x
  const dx3 = p0.x - p1.x + p2.x - p3.x
  const dy1 = p1.y - p2.y
  const dy2 = p3.y - p2.y
  const dy3 = p0.y - p1.y + p2.y - p3.y
  let g = 0
  let h = 0
  if (Math.abs(dx3) > 1e-9 || Math.abs(dy3) > 1e-9) {
    const den = dx1 * dy2 - dx2 * dy1
    g = (dx3 * dy2 - dx2 * dy3) / den
    h = (dx1 * dy3 - dx3 * dy1) / den
  }
  return [
    p1.x - p0.x + g * p1.x, p3.x - p0.x + h * p3.x, p0.x,
    p1.y - p0.y + g * p1.y, p3.y - p0.y + h * p3.y, p0.y,
    g, h, 1,
  ]
}

function invert3(m: number[]) {
  const [a, b, c, d, e, f, g, h, i] = m
  const A = e * i - f * h
  const B = -(d * i - f * g)
  const C = d * h - e * g
  const det = a * A + b * B + c * C || 1e-9
  return [
    A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det,
  ]
}

/**
 * Writes into `out` (column-major mat3) the map from GL device px to the
 * element's 0..1 image space, through its current CSS transform (perspective
 * included). The element's untransformed box is its parent's.
 */
export function elementInverse(el: HTMLElement, dpr: number, H: number, out: Float32Array) {
  const box = el.parentElement!.getBoundingClientRect()
  const w = box.width
  const h = box.height
  const cx = box.left + w / 2
  const cy = box.top + h / 2
  const t = el.style.transform
  const M = t ? new DOMMatrix(t) : new DOMMatrix()
  const proj = (x: number, y: number) => {
    const p = M.transformPoint(new DOMPoint(x - w / 2, y - h / 2, 0, 1))
    return { x: (cx + p.x / p.w) * dpr, y: H - (cy + p.y / p.w) * dpr }
  }
  const inv = invert3(squareToQuad([proj(0, 0), proj(w, 0), proj(w, h), proj(0, h)]))
  // row-major → column-major for GLSL
  out[0] = inv[0]; out[1] = inv[3]; out[2] = inv[6]
  out[3] = inv[1]; out[4] = inv[4]; out[5] = inv[7]
  out[6] = inv[2]; out[7] = inv[5]; out[8] = inv[8]
}

/** Globe placement for the shader: origin (GL device px), px per unit, meridian widths. */
export function globeUniforms(globe: Globe, svg: SVGSVGElement, dpr: number, H: number) {
  const m = svg.getScreenCTM()
  if (!m) return null
  const ox = m.e + m.a * 46 + m.c * 22
  const oy = m.f + m.b * 46 + m.d * 22
  const w = globe.meridians()
  return { globe: [ox * dpr, H - oy * dpr, m.a * dpr] as const, mer: [w[0], w[1], w[2]] as const }
}
