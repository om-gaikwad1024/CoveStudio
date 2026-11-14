// Paints the page's light-on-dark marks (type, chrome) into an offscreen 2D
// canvas, white on black, at the GL canvas's resolution. The composite reads it
// to know where letters are, so the ink can turn them dark with an RGB edge
// and the glass key can bend them. The DOM stays the real, accessible text;
// this is only its silhouette.

import type { GL } from "./gl"

export interface MaskSource {
  /** Called inside the painter's transform (css px, origin top-left of viewport). */
  paint(ctx: CanvasRenderingContext2D): void
}

interface Cached {
  font: string
  spacing: string
  upper: boolean
  asc: number
  desc: number
}

function effectiveOpacity(el: Element): number {
  let o = 1
  let n: Element | null = el
  while (n && n !== document.body) {
    const v = parseFloat(getComputedStyle(n).opacity)
    if (!isNaN(v)) o *= v
    if (o <= 0.001) return 0
    n = n.parentElement
  }
  return o
}

export class MaskPainter {
  readonly canvas = document.createElement("canvas")
  private ctx = this.canvas.getContext("2d", { alpha: false })!
  readonly tex: WebGLTexture
  private fonts = new WeakMap<Element, Cached>()
  private sources: MaskSource[] = []
  dirty = true
  private scale = 1

  constructor(private gl: GL) {
    this.tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, this.tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]))
  }

  addSource(s: MaskSource) {
    this.sources.push(s)
    this.dirty = true
  }

  resize(w: number, h: number, scale: number) {
    this.canvas.width = w
    this.canvas.height = h
    this.scale = scale
    this.fonts = new WeakMap()
    this.dirty = true
  }

  /** Forget cached font metrics (after fonts load or a breakpoint changes). */
  invalidateFonts() {
    this.fonts = new WeakMap()
    this.dirty = true
  }

  private fontOf(el: Element): Cached {
    let c = this.fonts.get(el)
    if (c) return c
    const cs = getComputedStyle(el)
    const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
    const ctx = this.ctx
    ctx.font = font
    const m = ctx.measureText("Hgy")
    c = {
      font,
      spacing: cs.letterSpacing === "normal" ? "0px" : cs.letterSpacing,
      upper: cs.textTransform === "uppercase",
      asc: m.fontBoundingBoxAscent ?? parseFloat(cs.fontSize) * 0.8,
      desc: m.fontBoundingBoxDescent ?? parseFloat(cs.fontSize) * 0.2,
    }
    this.fonts.set(el, c)
    return c
  }

  /** Text nodes are drawn word by word from their DOM boxes. */
  private paintText(el: Element) {
    const ctx = this.ctx
    const op = effectiveOpacity(el)
    if (op <= 0.01) return
    const f = this.fontOf(el)
    ctx.font = f.font
    try {
      ;(ctx as any).letterSpacing = f.spacing
    } catch {}
    ctx.globalAlpha = op
    ctx.textBaseline = "alphabetic"
    ctx.textAlign = "left"
    const clipEl = el.closest("[data-ink-clip]")
    if (clipEl) {
      const r = clipEl.getBoundingClientRect()
      ctx.save()
      ctx.beginPath()
      ctx.rect(r.left, r.top, r.width, r.height)
      ctx.clip()
    }
    const range = document.createRange()
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let node: Node | null
    while ((node = walker.nextNode())) {
      const text = node.textContent || ""
      // split into words so wrapped lines land where the browser put them
      const re = /\S+/g
      let m: RegExpExecArray | null
      while ((m = re.exec(text))) {
        range.setStart(node, m.index)
        range.setEnd(node, m.index + m[0].length)
        const rects = range.getClientRects()
        if (!rects.length) continue
        const r = rects[0]
        const word = f.upper ? m[0].toUpperCase() : m[0]
        const y = r.top + (r.height - (f.asc + f.desc)) / 2 + f.asc
        ctx.fillText(word, r.left, y)
      }
    }
    if (clipEl) ctx.restore()
    ctx.globalAlpha = 1
  }

  private paintPill(el: Element) {
    const op = effectiveOpacity(el)
    if (op <= 0.01) return
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    const bw = parseFloat(cs.borderTopWidth) || 1.5
    const rad = Math.min(r.height / 2, parseFloat(cs.borderTopLeftRadius) || r.height / 2)
    const ctx = this.ctx
    ctx.globalAlpha = op
    ctx.lineWidth = bw
    ctx.strokeStyle = "#fff"
    ctx.beginPath()
    ctx.roundRect(r.left + bw / 2, r.top + bw / 2, r.width - bw, r.height - bw, rad)
    ctx.stroke()
    ctx.globalAlpha = 1
  }

  private svgCache = new WeakMap<Element, { img: HTMLImageElement; key: string; ok: boolean }>()
  /** Inline SVGs are rasterised once per size and redrawn at their box. */
  private paintSvg(el: SVGSVGElement) {
    const op = effectiveOpacity(el)
    if (op <= 0.01) return
    const r = el.getBoundingClientRect()
    if (r.width < 1) return
    const key = `${Math.round(r.width)}x${Math.round(r.height)}`
    let c = this.svgCache.get(el)
    if (!c || c.key !== key) {
      const clone = el.cloneNode(true) as SVGSVGElement
      clone.setAttribute("width", String(r.width * this.scale))
      clone.setAttribute("height", String(r.height * this.scale))
      clone.setAttribute("color", "#ffffff")
      clone.style.color = "#ffffff"
      const xml = new XMLSerializer().serializeToString(clone)
      const img = new Image()
      const entry = { img, key, ok: false }
      img.onload = () => {
        entry.ok = true
        this.dirty = true
      }
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(xml)
      this.svgCache.set(el, entry)
      c = entry
    }
    if (!c.ok) return
    this.ctx.globalAlpha = op
    this.ctx.drawImage(c.img, r.left, r.top, r.width, r.height)
    this.ctx.globalAlpha = 1
  }

  private silhouettes = new WeakMap<HTMLImageElement, HTMLCanvasElement>()
  /** The image's alpha as a white silhouette, made once per image. */
  private silhouette(img: HTMLImageElement): HTMLCanvasElement | null {
    if (!img.complete || !img.naturalWidth) return null
    let c = this.silhouettes.get(img)
    if (c) return c
    c = document.createElement("canvas")
    const k = Math.min(1, 2048 / Math.max(img.naturalWidth, img.naturalHeight))
    c.width = Math.round(img.naturalWidth * k)
    c.height = Math.round(img.naturalHeight * k)
    const x = c.getContext("2d")!
    x.drawImage(img, 0, 0, c.width, c.height)
    x.globalCompositeOperation = "source-in"
    x.fillStyle = "#fff"
    x.fillRect(0, 0, c.width, c.height)
    this.silhouettes.set(img, c)
    return c
  }

  /** A plain image: its silhouette in its on-screen box. */
  private paintImg(el: HTMLImageElement) {
    const op = effectiveOpacity(el)
    if (op <= 0.01) return
    const s = this.silhouette(el)
    if (!s) return
    const r = el.getBoundingClientRect()
    this.ctx.globalAlpha = op
    this.ctx.drawImage(s, r.left, r.top, r.width, r.height)
    this.ctx.globalAlpha = 1
  }

  /**
   * An image tilted in 3D inside an untransformed parent: its corners are
   * projected through the computed transform and the silhouette is laid on the
   * affine through three of them (the tilt is small, so that is exact enough).
   */
  private paintMark(el: HTMLImageElement) {
    const op = effectiveOpacity(el)
    if (op <= 0.01) return
    const s = this.silhouette(el)
    if (!s) return
    const box = el.parentElement!.getBoundingClientRect()
    const w = box.width
    const h = box.height
    const t = getComputedStyle(el).transform
    const M = t && t !== "none" ? new DOMMatrix(t) : new DOMMatrix()
    const cx = box.left + w / 2
    const cy = box.top + h / 2
    const proj = (x: number, y: number) => {
      const p = M.transformPoint(new DOMPoint(x - w / 2, y - h / 2, 0, 1))
      return { x: cx + p.x / p.w, y: cy + p.y / p.w }
    }
    const tl = proj(0, 0)
    const tr = proj(w, 0)
    const bl = proj(0, h)
    const ctx = this.ctx
    ctx.save()
    ctx.globalAlpha = op
    ctx.transform((tr.x - tl.x) / w, (tr.y - tl.y) / w, (bl.x - tl.x) / h, (bl.y - tl.y) / h, tl.x, tl.y)
    ctx.drawImage(s, 0, 0, w, h)
    ctx.restore()
  }

  /** Redraws when dirty and uploads. Returns true if the texture changed. */
  update(): boolean {
    if (!this.dirty) return false
    this.dirty = false
    const ctx = this.ctx
    const s = this.scale
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = "#000"
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)
    ctx.setTransform(s, 0, 0, s, 0, 0)
    ctx.fillStyle = "#fff"
    document.querySelectorAll("[data-ink]").forEach((el) => {
      const kind = (el as HTMLElement).dataset.ink
      if (kind === "text") this.paintText(el)
      else if (kind === "pill") this.paintPill(el)
      else if (kind === "svg") this.paintSvg(el as SVGSVGElement)
      else if (kind === "img") this.paintImg(el as HTMLImageElement)
      else if (kind === "mark") this.paintMark(el as HTMLImageElement)
    })
    for (const src of this.sources) {
      ctx.save()
      src.paint(ctx)
      ctx.restore()
    }
    const gl = this.gl
    gl.bindTexture(gl.TEXTURE_2D, this.tex)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.canvas)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    return true
  }
}
