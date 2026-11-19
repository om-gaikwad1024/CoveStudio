// One canvas, one loop: the page's ink trail and the opening loader.
//
// The rule for the trail, everywhere on the site: the canvas is laid over the
// page in "difference" (see style.css), so whatever sits under it inverts where
// it passes (black ground → white, white type → black, lime → deep blue), and
// whatever must stay untouched (the reel, the cards, buttons, the 3D cat, the
// CD and cone) is layered above it. In the hero it also knows where the type
// is (the mask), so letters drag with the flow and the cut edge carries colour.

import { Fluid, DEFAULT_FLUID } from "./fluid"
import { GL, Program, blit } from "./gl"
import { MaskPainter } from "./mask"
import { COMPOSITE_FS, LOADER_FS } from "./passes"

export interface StageOptions {
  canvas: HTMLCanvasElement
}

export interface PointerState {
  x: number
  y: number
  over: boolean
  down: boolean
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))
const BASE: [number, number, number] = [0x0a / 255, 0x0a / 255, 0x0b / 255]

/** Marks that move every frame, drawn on the GPU instead of through the mask. */
export interface LiveMarks {
  /** wordmark: device-px → image-uv inverse homography (column-major), opacity, wipe */
  markInv: Float32Array
  markOn: number
  markClip: number
  /** globe: origin x, y (device px, GL), device px per svg unit, opacity */
  globe: [number, number, number, number]
  mer: [number, number, number]
}

/** Loader timing: the cat collapses into a bead, then the bead floods outward. */
export const LOADER = {
  burstAt: 0.32,
  /** front speed as a multiple of the screen diagonal per second */
  speed: 1.05,
}

export class Stage {
  readonly gl: GL
  readonly mask: MaskPainter
  private fluid: Fluid
  private compP: Program
  private loaderP: Program
  private canvas: HTMLCanvasElement

  private cssW = 1
  private cssH = 1
  private dpr = 1
  private quality = 1
  /** density cap for the canvas: 1x on integrated / mobile GPUs, 1.5x on dedicated */
  private dprCap = 1.5
  readonly tier: "high" | "mid"

  readonly ptr: PointerState = { x: -9999, y: -9999, over: false, down: false }
  private lastPtr = { x: 0, y: 0, has: false }
  private moves: { x: number; y: number }[] = []
  private coarse = matchMedia("(pointer: coarse)").matches

  /** Loader: <0 waiting, then seconds into the sequence; null once finished. */
  loaderT: number | null = -1
  /** Keep repainting the mask every frame (during type animations). */
  maskLive = false
  /** device px the wordmark spans on screen (set by the page) */
  markShownPx = 1
  readonly live: LiveMarks = {
    markInv: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
    markOn: 0,
    markClip: 1,
    globe: [0, 0, 1, 0],
    mer: [0, 0, 0],
  }
  private markTex: WebGLTexture | null = null
  private markTexW = 1

  private time = 0
  private last = -1
  private frameEma = 16.7
  private slow = 0
  private fast = 0
  private seed = 0
  private raf = 0
  private running = false
  private W = 1
  private H = 1
  onFrame: ((dt: number) => void) | null = null

  constructor(opts: StageOptions) {
    this.canvas = opts.canvas
    const gl = this.canvas.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: "high-performance",
      preserveDrawingBuffer: false,
    })
    if (!gl) throw new Error("WebGL2 unavailable")
    if (!gl.getExtension("EXT_color_buffer_float")) throw new Error("float targets unavailable")
    gl.getExtension("OES_texture_float_linear")
    this.gl = gl

    const fmt = {
      rgba: { internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT },
      rg: { internal: gl.RG16F, format: gl.RG, type: gl.HALF_FLOAT },
      r: { internal: gl.R16F, format: gl.RED, type: gl.HALF_FLOAT },
    }
    // GPU tier: integrated and mobile chips start at a 1x canvas, dedicated at 1.5x.
    const dbg = gl.getExtension("WEBGL_debug_renderer_info")
    const renderer = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER))
    const integrated = /intel|mali|adreno|powervr|apple gpu|swiftshader|llvmpipe|microsoft basic/i.test(renderer)
    const weak = this.coarse || integrated || (navigator.hardwareConcurrency || 8) <= 4
    this.tier = weak ? "mid" : "high"
    this.dprCap = weak ? 1 : 1.5
    this.fluid = new Fluid(gl, fmt, { ...DEFAULT_FLUID, dyeRes: weak ? 240 : DEFAULT_FLUID.dyeRes })
    this.mask = new MaskPainter(gl)
    this.compP = new Program(gl, COMPOSITE_FS)
    this.loaderP = new Program(gl, LOADER_FS)
    // an empty VAO: the fullscreen triangle comes from gl_VertexID
    gl.bindVertexArray(gl.createVertexArray())

    this.resize()
    window.addEventListener("resize", () => this.resize())
    window.addEventListener("pointermove", this.onMove, { passive: true })
    window.addEventListener("pointerdown", this.onDown, { passive: true })
    window.addEventListener("pointerup", this.onUp, { passive: true })
    document.documentElement.addEventListener("pointerleave", () => (this.ptr.over = false))
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.stop()
      else this.start()
    })
    this.canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault()
      this.stop()
    })
  }

  /** The wordmark's alpha, uploaded once; the shader reads it through its tilt. */
  setMarkImage(img: HTMLImageElement) {
    const gl = this.gl
    this.markTex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, this.markTex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img)
    // mips keep the lookups cache-friendly where the mark is drawn smaller than its source
    gl.generateMipmap(gl.TEXTURE_2D)
    this.markTexW = img.naturalWidth
  }

  /** Device px scale of the canvas, for callers mapping css px into GL space. */
  get deviceScale() {
    return this.dpr
  }
  get deviceHeight() {
    return this.H
  }

  /** Seconds the loader takes to flood the whole screen black. */
  loaderDuration() {
    const diag = Math.hypot(this.W, this.H)
    const spacing = 30 * this.dpr
    // the front must pass the corners, then the last dots must fill in behind it
    const need = diag * 0.5 + (spacing * 1.1) / 0.075
    return LOADER.burstAt + need / (diag * LOADER.speed) + 0.08
  }

  // ---------- input ----------
  private onMove = (e: PointerEvent) => {
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : []
    if (evs.length) for (const c of evs) this.moves.push({ x: c.clientX, y: c.clientY })
    else this.moves.push({ x: e.clientX, y: e.clientY })
    this.ptr.x = e.clientX
    this.ptr.y = e.clientY
    this.ptr.over = true
  }
  private onDown = (e: PointerEvent) => {
    this.ptr.down = true
    this.onMove(e)
  }
  private onUp = () => {
    this.ptr.down = false
  }

  // Ink is laid only where a pointer or a finger actually moves: nothing
  // draws on its own, so a still page stays still on every device.
  private feedPointer() {
    if (!this.moves.length) return
    const minDim = Math.min(this.cssW, this.cssH)
    for (const m of this.moves) {
      if (!this.lastPtr.has) {
        this.lastPtr = { x: m.x, y: m.y, has: true }
        continue
      }
      const dx = m.x - this.lastPtr.x
      const dy = m.y - this.lastPtr.y
      const dist = Math.hypot(dx, dy)
      if (dist < 0.5) continue
      // stamps every ~7px so fast swipes stay continuous; heavier when slow
      const steps = Math.min(10, Math.max(1, Math.ceil(dist / 7)))
      const speed = clamp(dist / 40, 0, 1)
      // slow: one fat blob riding the cursor; fast: a slimmer, even band
      // (0.8: the trail runs 20% narrower than first tuned; its length is unchanged)
      const radius = 0.8 * (0.04 - speed * 0.0128) * (900 / Math.max(500, minDim)) ** 0.15
      const ink = (0.36 + (1 - speed) * 0.16) / Math.sqrt(steps)
      // the push given to the liquid is capped, so a flick cannot throw it into a swirl
      const fx = clamp((dx / steps) * 5.5, -90, 90)
      const fy = clamp((-dy / steps) * 5.5, -90, 90)
      for (let i = 1; i <= steps; i++) {
        const t = i / steps
        const x = this.lastPtr.x + dx * t
        const y = this.lastPtr.y + dy * t
        this.fluid.splat(x / this.cssW, 1 - y / this.cssH, fx, fy, ink * 1.6, 0, radius)
      }
      this.lastPtr.x = m.x
      this.lastPtr.y = m.y
    }
    this.moves.length = 0
  }

  // ---------- layout ----------
  resize() {
    this.cssW = Math.max(1, window.innerWidth)
    this.cssH = Math.max(1, window.innerHeight)
    this.dpr = Math.min(window.devicePixelRatio || 1, this.dprCap) * this.quality
    this.W = Math.round(this.cssW * this.dpr)
    this.H = Math.round(this.cssH * this.dpr)
    this.canvas.width = this.W
    this.canvas.height = this.H
    this.fluid.resize(this.cssW, this.cssH)
    this.mask.resize(this.W, this.H, this.dpr)
  }

  // ---------- loop ----------
  start() {
    if (this.running) return
    this.running = true
    this.last = -1
    this.raf = requestAnimationFrame(this.loop)
  }
  stop() {
    this.running = false
    cancelAnimationFrame(this.raf)
  }

  // the display's frame interval, learned from the fastest recent frames
  private vsync = 16.7
  private ftWin: number[] = []
  private upAt = -100
  private noUpgrade = false

  /** Steps the canvas density down when frames are missed, and back up when they are not. */
  private adapt(now: number) {
    if (this.last < 0) return
    const ft = now - this.last
    this.frameEma += (ft - this.frameEma) * 0.08
    this.ftWin.push(ft)
    if (this.ftWin.length > 120) this.ftWin.shift()
    if (this.ftWin.length >= 30) {
      const sorted = [...this.ftWin].sort((a, b) => a - b)
      this.vsync = Math.max(6, sorted[Math.floor(sorted.length * 0.1)])
    }
    if (this.time < 1.5) return
    if (this.frameEma > this.vsync * 1.07) this.slow++
    else this.slow = 0
    if (this.frameEma < this.vsync * 1.01) this.fast++
    else this.fast = 0
    // an upgrade that is followed by a slowdown is never tried again
    if (this.slow > 30) {
      this.slow = 0
      if (this.time - this.upAt < 12) this.noUpgrade = true
      if (this.quality > 0.8) {
        this.quality = Math.max(0.8, this.quality * 0.9)
        this.resize()
      }
    } else if (this.fast > 360 && !this.noUpgrade && this.quality < 1) {
      this.fast = 0
      this.upAt = this.time
      this.quality = Math.min(1, this.quality * 1.12)
      this.resize()
    }
  }

  private loop = (now: number) => {
    if (!this.running) return
    this.raf = requestAnimationFrame(this.loop)
    const dt = this.last < 0 ? 1 / 60 : Math.min((now - this.last) / 1000, 1 / 20)
    this.adapt(now)
    this.last = now
    this.time += dt
    this.onFrame?.(dt)
    this.frame(dt)
  }

  private frame(dt: number) {
    const gl = this.gl
    this.feedPointer()
    this.fluid.step(dt)

    // The mask holds only what stands still (type, the logo); moving marks are
    // drawn on the GPU (see LiveMarks), so it repaints only when the page moves.
    if (this.maskLive) this.mask.dirty = true
    this.mask.update()

    this.seed = (this.seed + 1) % 977
    const c = this.compP
      .use()
      .tex("uDye", this.fluid.dye.read.tex)
      .tex("uMask", this.mask.tex)
      .tex("uOffset", this.fluid.offset.read.tex)
      .f2("uRes", this.W, this.H)
      .v3("uBase", BASE)
      .f1("uThreshold", 0.22)
      .f2("uDyeTexel", 1 / this.fluid.dye.read.w, 1 / this.fluid.dye.read.h)
      .f1("uTime", this.time)
      .f1("uDpr", this.dpr)
      .f1("uSeed", this.seed)
      .f1("uGrain", 0.07)
    const L = this.live
    c.tex("uMarkTex", this.markTex)
    gl.uniformMatrix3fv(c.loc("uMarkInv"), false, L.markInv)
    c.f1("uMarkOn", this.markTex ? L.markOn : 0)
    c.f1("uMarkClip", L.markClip)
    // mip level: source texels per device pixel across the mark's on-screen width
    c.f1("uMarkLod", Math.max(0, Math.log2(this.markTexW / Math.max(1, this.markShownPx))))
    c.f4("uGlobe", L.globe[0], L.globe[1], L.globe[2], L.globe[3])
    c.f3("uGlobeMer", L.mer[0], L.mer[1], L.mer[2])
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, this.W, this.H)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    blit(gl, null, this.W, this.H)

    // loader on top
    if (this.loaderT !== null && this.loaderT >= 0) {
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
      this.loaderP
        .use()
        .f2("uRes", this.W, this.H)
        .f1("uDpr", this.dpr)
        .f1("uT", this.loaderT)
        .f1("uBurstAt", LOADER.burstAt)
        .f1("uSpeed", Math.hypot(this.W, this.H) * LOADER.speed)
      blit(gl, null, this.W, this.H)
      gl.disable(gl.BLEND)
    }
  }
}
