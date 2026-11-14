import "@fontsource-variable/outfit"
import "@fontsource/jetbrains-mono/500.css"
import "./style.css"

import gsap from "gsap"
import { Stage } from "./gl/stage"
import { Globe, Tilt, elementInverse, globeUniforms } from "./hero"

const root = document.documentElement
const $ = <T extends Element = HTMLElement>(s: string) => document.querySelector(s) as T

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((res, rej) => {
    const img = new Image()
    img.decoding = "async"
    img.onload = () => res(img)
    img.onerror = rej
    img.src = src
  })
}

/**
 * Decodes an image off the page (a detached copy of the same URL). In-page
 * images inside the still-hidden document can stall decode() indefinitely in
 * Chrome, so the loader never waits on those - and never waits forever.
 */
function decoded(img: HTMLImageElement, timeout = 2500) {
  const probe = new Image()
  probe.src = img.currentSrc || img.src
  const done = probe.decode ? probe.decode().catch(() => {}) : Promise.resolve()
  return Promise.race([done, new Promise<void>((r) => setTimeout(r, timeout))])
}

async function fontsReady() {
  try {
    await Promise.all([document.fonts.load('700 100px "Outfit Variable"'), document.fonts.load('500 12px "JetBrains Mono"')])
    await document.fonts.ready
  } catch {
    /* fall back to system fonts */
  }
}

/** Entrance wipe of the wordmark, shared by the DOM clip and the GPU mark. */
const wipe = { u: 0 }

// ---------- the page's entrance, played once the screen has flooded black ----------
function entrance(stage: Stage | null) {
  const tl = gsap.timeline({ paused: true })
  const chrome = gsap.utils.toArray<HTMLElement>(".chrome > *")
  const mark = $(".hero__wordmark")

  tl.addLabel("open", 0)
    .call(() => root.classList.remove("is-loading"), [], 0)
    // the wordmark wipes in from the left (its transform belongs to the tilt)
    .set(mark, { opacity: 1 }, "open")
    .fromTo(
      wipe,
      { u: 0 },
      {
        u: 1,
        duration: 1.15,
        ease: "expo.out",
        onUpdate: () => {
          mark.style.clipPath = wipe.u >= 1 ? "" : `inset(-10% ${((1 - wipe.u) * 100).toFixed(2)}% -10% 0%)`
        },
      },
      "open",
    )
    .fromTo(chrome, { opacity: 0, y: -12 }, { opacity: 1, y: 0, duration: 0.8, ease: "power3.out", stagger: 0.07 }, "open+=0.1")
    .fromTo(
      [".hero__case", ".hero__cone", ".hero__services"],
      { opacity: 0, y: 16 },
      { opacity: 1, y: 0, duration: 0.9, ease: "power3.out", stagger: 0.1 },
      "open+=0.35",
    )

  if (stage) tl.fromTo(stage, { intro: 0 }, { intro: 1, duration: 1.1, ease: "power2.inOut" }, "open+=0.15")
  return tl
}

async function boot() {
  const canvas = $<HTMLCanvasElement>("#gl")
  const slot = $("#key-slot")
  const loader = $(".loader")
  const loaderIcon = $(".loader__icon")

  let stage: Stage | null = null
  try {
    stage = new Stage({ canvas, keySlot: slot })
  } catch (err) {
    console.warn("Cove: running without WebGL", err)
    root.classList.add("no-gl")
    canvas.remove()
  }

  // living chrome and objects
  const globe = new Globe($<SVGSVGElement>(".globe"))
  const wordmark = new Tilt($(".hero__wordmark"), { maxX: 7, maxY: 9, reach: 1.25, shift: 6, perspective: 1400 })
  const cdCase = new Tilt($(".hero__case-tilt"), { maxX: 14, maxY: 18, reach: 1.6, shift: 4, perspective: 600, float: true })
  const cone = new Tilt($(".hero__cone img"), { maxX: 10, maxY: 16, reach: 1.6, shift: 4, perspective: 600, float: true })

  // Hovering the case plays the brand reel inside it, from the top, on a loop;
  // leaving stops it and unloads it so nothing decodes in the background.
  const caseEl = $(".hero__case")
  const reel = $<HTMLImageElement>(".hero__reel")
  caseEl.addEventListener("pointerenter", () => {
    reel.src = "/img/cove-reel.webp"
    caseEl.classList.add("is-playing")
  })
  caseEl.addEventListener("pointerleave", () => {
    caseEl.classList.remove("is-playing")
    window.setTimeout(() => {
      if (!caseEl.classList.contains("is-playing")) reel.removeAttribute("src")
    }, 260)
  })
  if (stage) stage.start()

  const markEl = $(".hero__wordmark")
  const globeSvg = $<SVGSVGElement>(".globe")
  const badge = $(".chrome__badge")
  const tick = (dt: number) => {
    globe.update(dt)
    const ptr = stage?.ptr ?? lastPtr
    wordmark.update(dt, ptr)
    cdCase.update(dt, ptr)
    cone.update(dt, ptr)
    if (!stage) return
    // hand the moving marks to the GPU, so the ink inverts them without a mask repaint
    const L = stage.live
    const dpr = stage.deviceScale
    const H = stage.deviceHeight
    elementInverse(markEl, dpr, H, L.markInv)
    stage.markShownPx = markEl.offsetWidth * dpr
    L.markOn = root.classList.contains("is-loading") ? 0 : parseFloat(getComputedStyle(markEl).opacity) || 0
    L.markClip = wipe.u
    const g = globeUniforms(globe, globeSvg, dpr, H)
    const gOp = badge.offsetParent ? parseFloat(getComputedStyle(badge).opacity) || 0 : 0
    if (g) {
      L.globe = [g.globe[0], g.globe[1], g.globe[2], root.classList.contains("is-loading") ? 0 : gOp]
      L.mer = [g.mer[0], g.mer[1], g.mer[2]]
    }
  }
  const lastPtr = { x: -9999, y: -9999, over: false, down: false }
  if (!stage) {
    window.addEventListener("pointermove", (e) => Object.assign(lastPtr, { x: e.clientX, y: e.clientY, over: true }))
    gsap.ticker.add((_, d) => tick(d / 1000))
  }

  // wait for what the first screen needs; the cat waits with it
  const minWait = new Promise((r) => setTimeout(r, 700))
  const [mark] = await Promise.all([
    loadImage("/img/cat-icon.webp").catch(() => null),
    decoded($<HTMLImageElement>(".hero__wordmark")),
    decoded($<HTMLImageElement>(".hero__case-img")),
    decoded($<HTMLImageElement>(".hero__cone img")),
    fontsReady(),
    minWait,
  ])
  if (stage && mark) stage.key.setMark(mark)
  if (stage) stage.setMarkImage($<HTMLImageElement>(".hero__wordmark"))
  stage?.mask.invalidateFonts()

  const tl = entrance(stage)

  if (!stage) {
    gsap.to(loader, { opacity: 0, duration: 0.5, onComplete: () => loader.remove() })
    tl.play()
    return
  }

  // The cat gives a little jump and drops into a bead; the bead floods outward
  // in black until the screen is dark; then the page enters on black.
  const END_AT = stage.loaderDuration()
  gsap
    .timeline()
    .to(loaderIcon, { scale: 1.16, duration: 0.14, ease: "power2.out" })
    .to(loaderIcon, { scale: 0, duration: 0.2, ease: "power3.in" })

  // dev only: ?freeze=0.6 holds the loader at that second
  const freeze = import.meta.env.DEV ? parseFloat(new URLSearchParams(location.search).get("freeze") || "") : NaN
  if (import.meta.env.DEV) (window as any).__cove = { stage, tl }

  stage.maskLive = true
  stage.loaderT = 0
  let done = false
  stage.onFrame = (dt) => {
    tick(dt)
    if (stage!.loaderT === null) return
    if (!isNaN(freeze)) {
      stage!.loaderT = freeze
      return
    }
    stage!.loaderT += dt
    if (!done && stage!.loaderT >= END_AT) {
      done = true
      stage!.loaderT = null
      loader.remove()
      tl.play()
      tl.eventCallback("onComplete", () => {
        stage!.maskLive = false
        stage!.mask.dirty = true
      })
    }
  }

  // layout changes re-measure type
  let rT = 0
  window.addEventListener("resize", () => {
    clearTimeout(rT)
    rT = window.setTimeout(() => stage!.mask.invalidateFonts(), 120)
    stage!.mask.dirty = true
  })
}

boot()
