// One canvas, one loop. The stage owns the pointer, the fluid, the key, the
// mask and the passes, and steps resolution down on machines that struggle.

import { Fluid, DEFAULT_FLUID } from "./fluid"
import { GL, Program, Target, blit, createTarget, deleteTarget, hexToRgb } from "./gl"
import { KeyCap, PointerState } from "./keycap"
import { MaskPainter } from "./mask"
import { COMPOSITE_FS, LOADER_FS, SCENE_FS } from "./passes"

export const PALETTE = {
  base: "#0A0A0B",
  ink: "#FFFFFF",
}

export interface StageOptions {
  canvas: HTMLCanvasElement
  keySlot: HTMLElement
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))

/** Loader timing: the cat collapses into a bead, then the bead floods outward. */
export const LOADER = {
  burstAt: 0.32,
  /** front speed as a multiple of the screen diagonal per second */
  speed: 1.05,
}

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


interface Wave {
  x: number // css px
  y: number
  t0: number
  s: number
}

export class Stage {
  readonly gl: GL
  readonly mask: MaskPainter
  readonly key: KeyCap
  private fluid: Fluid
  private sceneP: Program
  private compP: Program
  private loaderP: Program
  private scene: Target | null = null
  private canvas: HTMLCanvasElement
  private slot: HTMLElement
  private reduced = () => false

  private cssW = 1
  private cssH = 1
  private dpr = 1
  private quality = 1
  /** density cap for the canvas: 1x on integrated / mobile GPUs, 1.5x on dedicated */
  private dprCap = 1.5
  readonly tier: "high" | "mid"

  readonly ptr: PointerState = { x: -9999, y: -9999, over: false, down: false }
  private lastPtr = { x: 0, y: 0, has: false }
  // punches
  private waves: Wave[] = []
  private wasOnKey = false
  private lastPunch = -1
  private waveBuf = new Float32Array(12)
  private moves: { x: number; y: number }[] = []
  private lastMoveAt = -1e9
  private coarse = matchMedia("(pointer: coarse)").matches

  /** the touch-screen current is drawing, not a finger: lighter ink */
  private ambient = false

  /** Loader: <0 waiting, then seconds into the sequence; null once finished. */
  loaderT: number | null = -1
  /** Key materialisation 0..1, driven by the page timeline. */
  intro = 0
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
  onFrame: ((dt: number) => void) | null = null

  constructor(opts: StageOptions) {
    this.canvas = opts.canvas
    this.slot = opts.keySlot
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
    // GPU tier: integrated and mobile chips start lean (1x canvas, lean glass),
    // dedicated ones start rich; the ladder moves either way from there.
    const dbg = gl.getExtension("WEBGL_debug_renderer_info")
    const renderer = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER))
    const integrated = /intel|mali|adreno|powervr|apple gpu|swiftshader|llvmpipe|microsoft basic/i.test(renderer)
    const weak = this.coarse || integrated || (navigator.hardwareConcurrency || 8) <= 4
    this.tier = weak ? "mid" : "high"
    this.dprCap = weak ? 1 : 1.5
    this.fluid = new Fluid(gl, fmt, { ...DEFAULT_FLUID, dyeRes: weak ? 240 : DEFAULT_FLUID.dyeRes })
    this.mask = new MaskPainter(gl)
    this.key = new KeyCap(gl, this.reduced)
    if (weak) {
      this.key.low = true
      this.key.quality = 0.72
    }
    this.sceneP = new Program(gl, SCENE_FS)
    this.compP = new Program(gl, COMPOSITE_FS)
    this.loaderP = new Program(gl, LOADER_FS)
    // an empty VAO: the fullscreen triangle comes from gl_VertexID
    gl.bindVertexArray(gl.createVertexArray())

    this.resize()
    window.addEventListener("resize", () => this.resize())
    window.addEventListener("pointermove", this.onMove, { passive: true })
    window.addEventListener("pointerdown", this.onDown, { passive: true })
    window.addEventListener("pointerup", this.onUp, { passive: true })
    document.documentElement.addEventListener("pointerleave", () => {
      this.ptr.over = false
      this.wasOnKey = false
    })
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

  private liveUniforms(p: Program) {
    const L = this.live
    p.tex("uMarkTex", this.markTex)
    this.gl.uniformMatrix3fv(p.loc("uMarkInv"), false, L.markInv)
    p.f1("uMarkOn", this.markTex ? L.markOn : 0)
    p.f1("uMarkClip", L.markClip)
    // mip level: source texels per device pixel across the mark's on-screen width
    const shown = Math.max(1, this.markShownPx)
    p.f1("uMarkLod", Math.max(0, Math.log2(this.markTexW / shown)))
    p.f4("uGlobe", L.globe[0], L.globe[1], L.globe[2], L.globe[3])
    p.f3("uGlobeMer", L.mer[0], L.mer[1], L.mer[2])
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
    this.lastMoveAt = performance.now()
  }
  private onDown = (e: PointerEvent) => {
    this.ptr.down = true
    this.onMove(e)
    if (this.loaderT === null && this.onKey(e.clientX, e.clientY)) {
      // a press on the glass is a blow too: a ring of ink under it, a wave across it
      this.burst(e.clientX, e.clientY)
      this.punch(e.clientX, e.clientY, 0, 0, 0.85)
    }
  }
  private onUp = () => {
    this.ptr.down = false
  }

  /** Rough silhouette of the cap on screen (its projected box, a little inset). */
  private onKey(x: number, y: number) {
    const r = this.key.rect
    const s = this.key.sizePx()
    const cx = r.x + r.w / 2
    const cy = r.y + r.h / 2
    return Math.abs(x - cx) < s * 0.5 && Math.abs(y - cy) < s * 0.47
  }

  /** A blow on the glass: a wave from the point of contact, and a recoil. */
  punch(x: number, y: number, dx: number, dy: number, strength: number) {
    if (this.time - this.lastPunch < 0.28) return
    this.lastPunch = this.time
    this.waves.push({ x, y, t0: this.time, s: strength })
    if (this.waves.length > 3) this.waves.shift()
    this.key.punch(dx, dy, strength)
  }

  burst(x: number, y: number) {
    const u = x / this.cssW
    const v = 1 - y / this.cssH
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 + Math.random() * 0.3
      const f = 520 + Math.random() * 260
      this.fluid.splat(u + Math.cos(a) * 0.01, v + Math.sin(a) * 0.018, Math.cos(a) * f, Math.sin(a) * f, 0.4, 0, 0.022)
    }
  }

  private feedPointer(now: number, dt: number) {
    // On touch screens with nothing happening, a slow current keeps the hero alive.
    if (this.coarse && now - this.lastMoveAt > 2600 && this.loaderT === null) {
      const t = this.time * 0.85
      const r = this.key.rect
      const cx = r.x + r.w / 2
      const cy = r.y + r.h / 2
      // a lazy figure-eight around the key, kept inside the frame
      const ax = Math.min(r.w * 0.42, this.cssW * 0.36)
      const ay = Math.min(r.h * 0.34, this.cssH * 0.18)
      this.moves.push({ x: cx + Math.sin(t * 1.3) * ax, y: cy - ay * 0.4 + Math.sin(t * 2.6) * ay })
      this.ambient = true
    } else this.ambient = false
    if (!this.moves.length) return
    const minDim = Math.min(this.cssW, this.cssH)
    let frameDist = 0
    let fdx = 0
    let fdy = 0
    let hitAt: { x: number; y: number } | null = null
    for (const m of this.moves) {
      if (!this.lastPtr.has) {
        this.lastPtr = { x: m.x, y: m.y, has: true }
        this.wasOnKey = this.onKey(m.x, m.y)
        continue
      }
      const dx = m.x - this.lastPtr.x
      const dy = m.y - this.lastPtr.y
      const dist = Math.hypot(dx, dy)
      if (dist < 0.5) continue
      frameDist += dist
      fdx += dx
      fdy += dy
      // stamps every ~7px so fast swipes stay continuous; heavier when slow
      const steps = Math.min(10, Math.max(1, Math.ceil(dist / 7)))
      const speed = clamp(dist / 40, 0, 1)
      // a fat, round head when slow; a longer, thinner smear when fast
      // slow: one fat blob riding the cursor; fast: a slimmer, even band
      const radius = (0.04 - speed * 0.0128) * (900 / Math.max(500, minDim)) ** 0.15 * (this.ambient ? 0.55 : 1)
      const ink = ((0.36 + (1 - speed) * 0.16) / Math.sqrt(steps)) * (this.ambient ? 0.16 : 1)
      // the push given to the liquid is capped, so a flick cannot throw it into a swirl
      const fx = clamp((dx / steps) * 5.5, -90, 90)
      const fy = clamp((-dy / steps) * 5.5, -90, 90)
      for (let i = 1; i <= steps; i++) {
        const t = i / steps
        const x = this.lastPtr.x + dx * t
        const y = this.lastPtr.y + dy * t
        this.fluid.splat(x / this.cssW, 1 - y / this.cssH, fx, fy, ink * 1.6, 0, radius)
        // first point of this path that lands on the glass
        const on = this.onKey(x, y)
        if (on && !this.wasOnKey && !hitAt) hitAt = { x, y }
        this.wasOnKey = on
      }
      this.lastPtr.x = m.x
      this.lastPtr.y = m.y
    }
    this.moves.length = 0

    // Arriving on the glass fast enough is a punch; harder blows run hotter.
    const v = frameDist / Math.max(dt, 1 / 120)
    if (hitAt && this.loaderT === null && this.intro > 0.9 && v > 900) {
      const len = Math.hypot(fdx, fdy) || 1
      const strength = clamp((v - 900) / 2600, 0.35, 1)
      this.punch(hitAt.x, hitAt.y, fdx / len, fdy / len, strength)
    }
  }

  // ---------- layout ----------
  resize() {
    const gl = this.gl
    this.cssW = Math.max(1, window.innerWidth)
    this.cssH = Math.max(1, window.innerHeight)
    this.dpr = Math.min(window.devicePixelRatio || 1, this.dprCap) * this.quality
    this.W = Math.round(this.cssW * this.dpr)
    this.H = Math.round(this.cssH * this.dpr)
    this.canvas.width = this.W
    this.canvas.height = this.H
    this.fluid.resize(this.cssW, this.cssH)
    this.mask.resize(this.W, this.H, this.dpr)
    deleteTarget(gl, this.scene)
    const half = 0.5
    this.scene = createTarget(
      gl,
      Math.max(1, Math.round(this.W * half)),
      Math.max(1, Math.round(this.H * half)),
      { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE },
      gl.LINEAR,
    )
    this.layoutKey()
  }
  private W = 1
  private H = 1

  private layoutKey() {
    const r = this.slot.getBoundingClientRect()
    this.key.layout(r.left, r.top, r.width, r.height, this.dpr)
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
    // slow: frames are being missed regularly; fast: every frame lands on time
    if (this.frameEma > this.vsync * 1.07) this.slow++
    else this.slow = 0
    if (this.frameEma < this.vsync * 1.01) this.fast++
    else this.fast = 0
    // Ladder, cheapest loss first: key samples → key resolution → canvas density.
    // The key keeps at least 62% resolution; the bicubic upsample covers the rest.
    // An upgrade that is followed by a slowdown is never tried again.
    const k = this.key
    if (this.slow > 30) {
      this.slow = 0
      if (this.time - this.upAt < 12) this.noUpgrade = true
      if (!k.low) k.low = true
      else if (k.quality > 0.64) k.quality = Math.max(0.62, k.quality * 0.92)
      else if (this.quality > 0.8) {
        this.quality = Math.max(0.8, this.quality * 0.9)
        this.resize()
      }
    } else if (this.fast > 360 && !this.noUpgrade) {
      this.fast = 0
      this.upAt = this.time
      if (this.quality < 1) {
        this.quality = Math.min(1, this.quality * 1.12)
        this.resize()
      } else if (k.quality < 1) k.quality = Math.min(1, k.quality * 1.08)
      else if (k.low && this.tier === "high") k.low = false
    }
  }
  private upAt = -100
  private noUpgrade = false

  private loop = (now: number) => {
    if (!this.running) return
    this.raf = requestAnimationFrame(this.loop)
    const dt = this.last < 0 ? 1 / 60 : Math.min((now - this.last) / 1000, 1 / 20)
    this.adapt(now)
    this.last = now
    this.time += dt
    this.onFrame?.(dt)
    this.frame(dt, now)
  }

  private frame(dt: number, now: number) {
    const gl = this.gl
    this.layoutKey()

    // pointer → fluid
    this.feedPointer(now, dt)
    this.fluid.step(dt)

    // The mask holds only what stands still (type, pills, logo); moving marks are
    // drawn on the GPU (see LiveMarks), so it repaints only while the page enters.
    if (this.maskLive) this.mask.dirty = true
    this.mask.update()

    const ink = hexToRgb(PALETTE.ink)
    const base = hexToRgb(PALETTE.base)
    const threshold = 0.22

    const keyVisible = this.intro > 0 && this.key.rect.y + this.key.rect.h > 0 && this.key.rect.y < this.cssH
    this.key.presence = this.intro
    this.key.update(dt, this.ptr)

    if (keyVisible) {
      // page as seen behind the glass — only the patch the key can bend light from
      const sc = this.scene!
      const sx = sc.w / this.cssW
      const sy = sc.h / this.cssH
      const R0 = this.key.rect
      const m = 0.3
      const x0 = Math.max(0, Math.floor((R0.x - R0.w * m) * sx))
      const x1 = Math.min(sc.w, Math.ceil((R0.x + R0.w * (1 + m)) * sx))
      const y0 = Math.max(0, Math.floor((this.cssH - (R0.y + R0.h * (1 + m))) * sy))
      const y1 = Math.min(sc.h, Math.ceil((this.cssH - (R0.y - R0.h * m)) * sy))
      gl.disable(gl.BLEND)
      this.sceneP
        .use()
        .tex("uDye", this.fluid.dye.read.tex)
        .tex("uMask", this.mask.tex)
        .v3("uInk", ink)
        .v3("uBase", base)
        .f1("uThreshold", threshold)
        .f2("uDyeTexel", 1 / this.fluid.dye.read.w, 1 / this.fluid.dye.read.h)
        .f1("uSceneScale", this.W / sc.w)
      this.liveUniforms(this.sceneP)
      if (x1 > x0 && y1 > y0) {
        gl.enable(gl.SCISSOR_TEST)
        gl.scissor(x0, y0, x1 - x0, y1 - y0)
        blit(gl, sc)
        gl.disable(gl.SCISSOR_TEST)
      }
      this.key.render(sc, this.W, this.H, 0)
    }

    // punch waves, oldest first, expired ones dropped
    this.waves = this.waves.filter((w) => this.time - w.t0 < 0.62)
    this.waveBuf.fill(0)
    this.waves.forEach((w, i) => {
      this.waveBuf[i * 4] = w.x * this.dpr
      this.waveBuf[i * 4 + 1] = this.H - w.y * this.dpr
      this.waveBuf[i * 4 + 2] = this.time - w.t0
      this.waveBuf[i * 4 + 3] = w.s
    })

    // to screen
    this.seed = (this.seed + 1) % 977
    const R = this.key.rect
    const c = this.compP.use()
    c.tex("uDye", this.fluid.dye.read.tex)
      .tex("uVel", this.fluid.velocity.read.tex)
      .tex("uMask", this.mask.tex)
      .tex("uOffset", this.fluid.offset.read.tex)
      .tex("uKey", this.key.target!.tex)
      .f2("uKeyTexSize", this.key.target!.w, this.key.target!.h)
      .f2("uRes", this.W, this.H)
      .f4("uKeyRect", R.x * this.dpr, this.H - (R.y + R.h) * this.dpr, R.w * this.dpr, R.h * this.dpr)
      .v3("uInk", ink)
      .v3("uBase", base)
      .f1("uThreshold", threshold)
      .f2("uDyeTexel", 1 / this.fluid.dye.read.w, 1 / this.fluid.dye.read.h)
      .f1("uTime", this.time)
      .f1("uDpr", this.dpr)
      .f1("uIntro", keyVisible ? this.intro : 0)
      .f1("uSeed", this.seed)
      .f1("uGrain", 0.07)
    c.f1("uWaveReach", this.key.sizePx() * 1.25 * this.dpr)
    gl.uniform4fv(c.loc("uWave"), this.waveBuf)
    this.liveUniforms(c)
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
