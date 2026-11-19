// The two-word heading. Every letter is its own element, drawn in two layers
// (ink on the ground, white "difference" over the reel), and every letter can
// be one of four things: gone, a ghost, solid, or its own pixelated twin. The
// pixel twin of A, S and O is the hand-drawn glyph from SOA.svg; the other
// letters' twins are the same glyph rendered on a coarse grid. Every letter
// sits in a box of fixed width, so the edge alignments hold in any state.

import gsap from "gsap"
import { PIXEL_GLYPHS, glyphBox, glyphSvg } from "./glyphs"

/** a hairline text stroke, in em: a touch more weight than medium, never bold */
export const STROKE_EM = 0.007

export const DISPLAY_FONT = `"Helvetica Now Display", "Helvetica Neue", Helvetica, Arial, ui-sans-serif, sans-serif`

export type LetterState = "off" | "ghost" | "solid" | "pixel"

export interface TitleMetrics {
  /** ink extents at 100px, relative to each word's origin */
  l1: number
  r1: number
  /** the second word without its last letter (the part that ends on the reel's edge) */
  l2: number
  r2: number
  /** the whole second word */
  r2full: number
  cap: number
  asc: number
  desc: number
}

interface Letter {
  ch: string
  final: LetterState
  s: LetterState
  els: HTMLElement[]
  px: HTMLCanvasElement[]
  /** hand-drawn pixel glyph for this letter's pixel state, if it has one */
  svg: boolean
  /** at 100px: advance, ink left, ink right (relative to the letter box) */
  adv: number
  inkL: number
  inkR: number
}

const STATES: LetterState[] = ["ghost", "off", "pixel", "ghost", "solid", "off"]

export class Title {
  readonly lines: HTMLElement[][] = [[], []] // [line][layer]
  private letters: Letter[] = []
  private metricsCache: TitleMetrics | null = null
  private base = [
    { x: 0, y: 0 },
    { x: 0, y: 0 },
  ]
  private font = 100

  constructor(
    private layers: HTMLElement[],
    readonly words: [string, string],
    pixelAt: [number[], number[]],
    private weight = 500,
  ) {
    words.forEach((word, li) => {
      const startIndex = this.letters.length
      for (let i = 0; i < word.length; i++)
        this.letters.push({
          ch: word[i],
          final: pixelAt[li].includes(i) ? "pixel" : "solid",
          s: "off",
          els: [],
          px: [],
          svg: pixelAt[li].includes(i) && !!PIXEL_GLYPHS[word[i]],
          adv: 60,
          inkL: 0,
          inkR: 60,
        })
      layers.forEach((layer) => {
        const line = document.createElement("span")
        line.className = "wt__line"
        for (let i = 0; i < word.length; i++) {
          const L = this.letters[startIndex + i]
          const el = document.createElement("span")
          el.className = "wt__ch"
          el.dataset.s = "off"
          el.textContent = word[i]
          const cv = document.createElement("canvas")
          cv.className = "wt__px"
          el.appendChild(cv)
          if (L.svg) {
            el.classList.add("has-glyph")
            el.insertAdjacentHTML("beforeend", glyphSvg(PIXEL_GLYPHS[L.ch], "wt__glyph"))
          }
          line.appendChild(el)
          L.els.push(el)
          L.px.push(cv)
        }
        layer.appendChild(line)
        this.lines[li].push(line)
      })
    })
  }

  private fontString(px: number, weight = this.weight) {
    return `${weight} ${px}px ${DISPLAY_FONT}`
  }

  metrics(): TitleMetrics {
    if (this.metricsCache) return this.metricsCache
    const c = document.createElement("canvas").getContext("2d")!
    c.font = this.fontString(100)
    if ("fontKerning" in c) (c as any).fontKerning = "none"
    const mh = c.measureText("H")
    const cap = mh.actualBoundingBoxAscent
    // every letter gets a box: font letters their advance, pixel glyphs their
    // drawn width plus a small bearing either side
    for (const L of this.letters) {
      if (L.svg) {
        const box = glyphBox(PIXEL_GLYPHS[L.ch])
        const gw = (box.w / box.h) * cap
        const b = cap * 0.07
        L.adv = gw + 2 * b
        L.inkL = b
        L.inkR = b + gw
      } else {
        const m = c.measureText(L.ch)
        // display tracking, a touch tight as large Helvetica wants
        L.adv = m.width - 1.5
        // ink edges from the rendered pixels: the metric boxes are rounded
        // to whole pixels and can be a pixel off, which shows on the edge line
        const ink = inkColumns(L.ch, this.fontString(INK_PX))
        // the stroke grows the ink by half its width on each side
        const half = (STROKE_EM * 100) / 2
        L.inkL = (ink ? (ink[0] * 100) / INK_PX : -m.actualBoundingBoxLeft) - half
        L.inkR = (ink ? (ink[1] * 100) / INK_PX : m.actualBoundingBoxRight) + half
      }
    }
    const n1 = this.words[0].length
    const w1 = this.letters.slice(0, n1)
    const w2 = this.letters.slice(n1)
    const inkRightOf = (ls: Letter[], k: number) => ls.slice(0, k - 1).reduce((a, l) => a + l.adv, 0) + ls[k - 1].inkR
    this.metricsCache = {
      l1: w1[0].inkL,
      r1: inkRightOf(w1, w1.length),
      l2: w2[0].inkL,
      r2: inkRightOf(w2, w2.length - 1),
      r2full: inkRightOf(w2, w2.length),
      cap,
      asc: mh.fontBoundingBoxAscent ?? 92,
      desc: mh.fontBoundingBoxDescent ?? 24,
    }
    return this.metricsCache
  }

  /** Forget measurements (after the web font arrives). */
  invalidate() {
    this.metricsCache = null
  }

  /** Distance from a line box's top to its baseline, at font size f (line-height 1). */
  baselineOffset(f: number) {
    const m = this.metrics()
    return (f / 100) * ((100 - (m.asc + m.desc)) / 2 + m.asc)
  }

  /** Sets the size and the resting origin of each line (css px, line-box top-left). */
  place(f: number, x1: number, y1: number, x2: number, y2: number) {
    this.font = f
    this.layers.forEach((l) => (l.style.fontSize = `${f}px`))
    const m = this.metrics()
    const k = f / 100
    const capH = k * m.cap
    const capTop = this.baselineOffset(f) - capH
    for (const L of this.letters) {
      for (const el of L.els) {
        el.style.width = `${(L.adv * k).toFixed(2)}px`
        const g = el.querySelector<SVGElement>(".wt__glyph")
        if (g) {
          g.style.left = `${(L.inkL * k).toFixed(2)}px`
          g.style.top = `${capTop.toFixed(2)}px`
          g.style.width = `${((L.inkR - L.inkL) * k).toFixed(2)}px`
          g.style.height = `${capH.toFixed(2)}px`
        }
      }
    }
    this.base[0] = { x: x1, y: y1 }
    this.base[1] = { x: x2, y: y2 }
    this.offset(0, 0, 0, 0)
    this.buildPixels()
  }

  offset(dx1: number, dy1: number, dx2: number, dy2: number) {
    const b = this.base
    const t1 = `translate3d(${(b[0].x + dx1).toFixed(2)}px, ${(b[0].y + dy1).toFixed(2)}px, 0)`
    const t2 = `translate3d(${(b[1].x + dx2).toFixed(2)}px, ${(b[1].y + dy2).toFixed(2)}px, 0)`
    this.lines[0].forEach((l) => (l.style.transform = t1))
    this.lines[1].forEach((l) => (l.style.transform = t2))
  }

  /** Re-render every letter's pixel twin for the current size. */
  private buildPixels() {
    const f = this.font
    const m = this.metrics()
    const capH = (f / 100) * m.cap
    const cell = Math.max(2, Math.round(capH / 9))
    const base = this.baselineOffset(f)
    const colours = this.layers.map((l) => getComputedStyle(l).color)
    const scratch = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!
    for (const L of this.letters) {
      if (L.svg) continue
      L.els.forEach((el, li) => {
        const cv = L.px[li]
        const w = el.offsetWidth || f * 0.6
        const cw = Math.ceil(w / cell) + 1
        const chh = Math.ceil(f / cell) + 1
        cv.width = cw
        cv.height = chh
        scratch.canvas.width = cw
        scratch.canvas.height = chh
        scratch.clearRect(0, 0, cw, chh)
        // a touch heavier than the type, so thin strokes survive the grid
        scratch.font = this.fontString(f / cell, this.weight + 90)
        scratch.textBaseline = "alphabetic"
        scratch.fillStyle = "#000"
        scratch.fillText(L.ch, 0, base / cell)
        const img = scratch.getImageData(0, 0, cw, chh)
        const d = img.data
        const rgb = parseRgb(colours[li])
        for (let i = 0; i < d.length; i += 4) {
          const on = d[i + 3] > 105
          d[i] = rgb[0]
          d[i + 1] = rgb[1]
          d[i + 2] = rgb[2]
          d[i + 3] = on ? 255 : 0
        }
        const ctx = cv.getContext("2d")!
        ctx.putImageData(img, 0, 0)
        cv.style.width = `${cw * cell}px`
        cv.style.height = `${chh * cell}px`
      })
    }
  }

  set(i: number, s: LetterState) {
    const L = this.letters[i]
    if (!L || L.s === s) return
    L.s = s
    for (const el of L.els) el.dataset.s = s
  }

  hideAll() {
    this.letters.forEach((_, i) => this.set(i, "off"))
  }

  showAll() {
    this.letters.forEach((L, i) => this.set(i, L.final))
  }

  /** Each letter flickers through a few random states before it settles. */
  flickerIn(tl: gsap.core.Timeline, at: number, spread = 0.55) {
    this.letters.forEach((L, i) => {
      let t = at + Math.random() * spread
      const n = 2 + Math.floor(Math.random() * 3)
      for (let k = 0; k < n; k++) {
        const s = STATES[Math.floor(Math.random() * STATES.length)]
        tl.call(() => this.set(i, s), [], t)
        t += 0.045 + Math.random() * 0.11
      }
      tl.call(() => this.set(i, L.final), [], t)
    })
  }

  /** An idle hiccup: one letter loses itself for a beat and comes back. */
  glitch() {
    const i = Math.floor(Math.random() * this.letters.length)
    const L = this.letters[i]
    const alt: LetterState = L.final === "pixel" ? "solid" : Math.random() < 0.5 ? "pixel" : "ghost"
    const seq: LetterState[] = Math.random() < 0.5 ? ["ghost", alt, L.final] : [alt, "off", alt, L.final]
    let t = 0
    for (const s of seq) {
      gsap.delayedCall(t, () => this.set(i, s))
      t += 0.06 + Math.random() * 0.1
    }
  }
}

/** size the ink edges are measured at (finer than the largest heading) */
const INK_PX = 400
let inkCanvas: CanvasRenderingContext2D | null = null

/** Leftmost and rightmost inked column of a glyph, relative to its origin, at INK_PX. */
function inkColumns(ch: string, font: string): [number, number] | null {
  const w = INK_PX * 1.6
  const h = INK_PX * 1.3
  if (!inkCanvas) inkCanvas = document.createElement("canvas").getContext("2d", { willReadFrequently: true })
  const c = inkCanvas
  if (!c) return null
  if (c.canvas.width !== w) c.canvas.width = w
  if (c.canvas.height !== h) c.canvas.height = h
  c.clearRect(0, 0, w, h)
  c.font = font
  c.fillStyle = "#000"
  const ox = INK_PX * 0.3
  const oy = INK_PX
  c.fillText(ch, ox, oy)
  const d = c.getImageData(0, 0, w, h).data
  let minX = w
  let maxX = -1
  for (let y = 0; y < h; y++) {
    const row = y * w * 4
    for (let x = 0; x < w; x++) {
      if (d[row + x * 4 + 3] > 127) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
      }
    }
  }
  if (maxX < 0) return null
  return [minX - ox, maxX + 1 - ox]
}

function parseRgb(c: string): [number, number, number] {
  const m = c.match(/\d+(\.\d+)?/g)
  if (!m) return [0, 0, 0]
  return [+m[0], +m[1], +m[2]]
}

/** Word-level flicker for small type: words blink in out of order. */
export function splitWords(el: HTMLElement) {
  const out: HTMLElement[] = []
  const walk = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const parts = (child.textContent || "").split(/(\s+)/)
        const frag = document.createDocumentFragment()
        for (const p of parts) {
          if (!p) continue
          if (/^\s+$/.test(p)) frag.appendChild(document.createTextNode(p))
          else {
            const s = document.createElement("span")
            s.className = "fw"
            s.textContent = p
            frag.appendChild(s)
            out.push(s)
          }
        }
        child.replaceWith(frag)
      } else if (child.nodeType === Node.ELEMENT_NODE && !(child as Element).matches("svg, sup")) walk(child)
      else if (child.nodeType === Node.ELEMENT_NODE) out.push(child as HTMLElement)
    }
  }
  walk(el)
  return out
}

export function flickerWords(tl: gsap.core.Timeline, words: HTMLElement[], at: number, spread = 0.6) {
  words.forEach((w) => {
    gsap.set(w, { opacity: 0 })
    let t = at + Math.random() * spread
    const n = 1 + Math.floor(Math.random() * 3)
    for (let k = 0; k < n; k++) {
      tl.set(w, { opacity: Math.random() < 0.5 ? 0.25 : 1 }, t)
      t += 0.05 + Math.random() * 0.09
      tl.set(w, { opacity: 0 }, t)
      t += 0.04 + Math.random() * 0.08
    }
    tl.set(w, { opacity: 1 }, t)
  })
}
