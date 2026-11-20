import "lenis/dist/lenis.css"
import "./style.css"
import "./work.css"

import gsap from "gsap"
import Lenis from "lenis"
import { Stage } from "./gl/stage"
import { Globe, Tilt, elementInverse, globeUniforms } from "./hero"
import { initWork } from "./work/work"

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
    // a missing font file must not hold the loader for long
    await Promise.race([
      Promise.all([
        document.fonts.load('500 100px "Helvetica Now Display"'),
        document.fonts.load('400 16px "Helvetica Now Display"'),
        document.fonts.load('700 16px "Helvetica Now Display"'),
      ]).then(() => document.fonts.ready),
      new Promise((r) => setTimeout(r, 1800)),
    ])
  } catch {
    /* fall back to system fonts */
  }
}

/** Entrance of the wordmark (0 hidden .. 1 whole), shared by the DOM and the GPU mark. */
const wipe = { u: 0 }

/**
 * The wordmark burns in the way the cat burns away: a soft front sweeps across
 * it from the top right to the bottom left, and behind the front it shimmers
 * in a heat haze that settles as it lands, with a warm glow that cools off.
 */
function burnIn(mark: HTMLElement, p: number) {
  const disp = document.querySelector("#heat-in feDisplacementMap")
  if (p >= 1) {
    mark.style.removeProperty("mask-image")
    mark.style.removeProperty("-webkit-mask-image")
    mark.style.filter = ""
    disp?.setAttribute("scale", "0")
    return
  }
  const f = -18 + p * 136 // the front's position along the diagonal, %
  const mask = `linear-gradient(to bottom left, #000 ${(f - 16).toFixed(1)}%, rgba(0,0,0,0.35) ${(f - 6).toFixed(1)}%, transparent ${f.toFixed(1)}%)`
  mark.style.setProperty("mask-image", mask)
  mark.style.setProperty("-webkit-mask-image", mask)
  const heat = Math.pow(1 - p, 1.4)
  disp?.setAttribute("scale", (64 * heat).toFixed(1))
  mark.style.filter = `url(#heat-in) drop-shadow(0 0 ${(6 + 22 * heat).toFixed(1)}px rgba(255, 140, 60, ${(0.75 * heat).toFixed(3)}))`
}

// ---------- the page's entrance, played once the screen has flooded black ----------
function entrance(showCat: () => void) {
  const tl = gsap.timeline({ paused: true })
  const chrome = gsap.utils.toArray<HTMLElement>(".chrome > *")
  const mark = $(".hero__wordmark")

  tl.addLabel("open", 0)
    .call(() => root.classList.remove("is-loading"), [], 0)
    // the wordmark burns in through a heat haze (its transform belongs to the tilt)
    .call(() => burnIn(mark, 0), [], "open")
    .set(mark, { opacity: 1 }, "open")
    .fromTo(
      wipe,
      { u: 0 },
      {
        u: 1,
        duration: 1.4,
        ease: "sine.inOut",
        onUpdate: () => burnIn(mark, wipe.u),
        onComplete: () => burnIn(mark, 1),
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
    // the cat burns in with it
    .call(showCat, [], "open")
  return tl
}

// nothing on the page is draggable (images, or a selection carrying them)
document.addEventListener("dragstart", (e) => e.preventDefault())

async function boot() {
  // Smooth scroll for the whole page. The page always opens at the top, so the
  // sections play in order; scrolling waits until the loader has finished.
  if ("scrollRestoration" in history) history.scrollRestoration = "manual"
  window.scrollTo(0, 0)
  // every wheel / touch gesture passes a gate first: a section that owns the
  // gesture (the page turn, the card deck) takes it and the page does not scroll
  let scrollGate: ((e: { deltaY: number; event: Event }) => boolean) | null = null
  const lenis = new Lenis({
    lerp: 0.075,
    wheelMultiplier: 0.85,
    touchMultiplier: 1.4,
    smoothWheel: true,
    virtualScroll: (e) => (scrollGate ? scrollGate(e as { deltaY: number; event: Event }) : true),
  })
  gsap.ticker.add((t) => lenis.raf(t * 1000))
  gsap.ticker.lagSmoothing(0)
  lenis.stop()

  const canvas = $<HTMLCanvasElement>("#gl")
  const loader = $(".loader")
  const loaderIcon = $(".loader__icon")

  let stage: Stage | null = null
  try {
    stage = new Stage({ canvas })
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

  // The CD: hovering spins the disc up and plays it on a loop; leaving winds it
  // down to a stop where it is, like a real player. Safari cannot draw WebM
  // with alpha, so it gets a version flattened onto the page colour.
  const caseEl = $(".hero__case")
  const cd = $<HTMLVideoElement>(".hero__cd")
  const safari = /^((?!chrome|chromium|android|crios|fxios|edg).)*safari/i.test(navigator.userAgent)
  const cdSrc = safari ? "/img/cd-play.mp4" : "/img/cd-play.webm"
  const IDLE_FRAME = 2.75 // the lime cat disc, same as the still
  let cdTarget = 0
  let cdRate = 0
  let cdStarted = false
  const loadCd = () => {
    if (cd.src) return
    cd.src = cdSrc
    cd.preload = "auto"
    cd.addEventListener("loadedmetadata", () => {
      if (!cdStarted) cd.currentTime = IDLE_FRAME
    }, { once: true })
  }
  caseEl.addEventListener("pointerenter", () => {
    loadCd()
    cdTarget = 1
    if (cd.paused) {
      cd.playbackRate = Math.max(0.0625, cdRate || 0.2)
      cd.play().then(() => {
        cdStarted = true
        caseEl.classList.add("has-played")
      }).catch(() => {})
    }
  })
  caseEl.addEventListener("pointerleave", () => (cdTarget = 0))
  const spinCd = (dt: number) => {
    if (cd.paused && cdTarget === 0) return
    // spin-up is quicker than the wind-down, as with a real disc
    const k = 1 - Math.exp(-dt * (cdTarget > cdRate ? 4.5 : 3))
    cdRate += (cdTarget - cdRate) * k
    if (cdTarget === 0 && cdRate < 0.07) {
      cd.pause()
      cdRate = 0
      return
    }
    cd.playbackRate = Math.max(0.0625, cdRate)
  }
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
    spinCd(dt)
    if (!stage) return
    // hand the moving marks to the GPU, so the ink drags and colours them without a mask repaint
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
  await Promise.all([
    loadImage("/img/cat-icon.webp").catch(() => null),
    decoded($<HTMLImageElement>(".hero__wordmark")),
    decoded($<HTMLImageElement>(".hero__case-img")),
    decoded($<HTMLImageElement>(".hero__cone img")),
    fontsReady(),
    minWait,
  ])
  if (stage) stage.setMarkImage($<HTMLImageElement>(".hero__wordmark"))
  stage?.mask.invalidateFonts()
  // One ink trail for the whole page, one rule (see gl/stage.ts): white ink
  // laid over everything in "difference", so whatever lies under it inverts.
  // It steps aside only while a film fills the screen.
  const heroEl = $(".hero")
  let stageOn = true
  let cinema = false
  let heroShown = true
  const syncStage = () => {
    if (!stage || stage.loaderT !== null) return
    const difEl = document.getElementById("gl-dif")
    if (cinema && stageOn) {
      stageOn = false
      stage.stop()
      canvas.style.visibility = "hidden"
      if (difEl) difEl.style.visibility = "hidden"
    } else if (!cinema && !stageOn) {
      stageOn = true
      canvas.style.visibility = ""
      if (difEl) difEl.style.visibility = ""
      stage.start()
    }
    // the hero's type moves with the page: repaint what the ink knows of it
    const b = heroEl.getBoundingClientRect().bottom
    if (b > 0) {
      heroShown = true
      stage.mask.dirty = true
    } else if (heroShown) {
      heroShown = false
      stage.mask.dirty = true // one last repaint: the hero's marks are gone
    }
  }
  window.addEventListener("scroll", syncStage, { passive: true })
  window.addEventListener("resize", () => {
    syncStage()
    stage?.mask.invalidateFonts()
  })
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !stageOn) stage?.stop()
  })

  // the Works section measures its type now that the fonts are in
  let work: ReturnType<typeof initWork> = null
  try {
    work = initWork({
      lenis,
      setScrollGate: (g) => (scrollGate = g),
      catSlot: $(".hero__cat"),
      onCinema: (on) => {
        cinema = on
        syncStage()
      },
    })
  } catch (err) {
    console.warn("Cove: works section failed to start", err)
  }

  const tl = entrance(() => work?.showCat())

  if (!stage) {
    gsap.to(loader, { opacity: 0, duration: 0.5, onComplete: () => loader.remove() })
    tl.play()
    lenis.start()
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

  // Above the hero's bottom edge the ink is the original trail (#gl, normal
  // blending). Below it the same pixels are shown through #gl-dif in
  // "difference", so they invert the section underneath. While the edge is on
  // screen both show, each clipped to its side; otherwise only one does.
  const dif = $<HTMLCanvasElement>("#gl-dif")
  const difCtx = dif.getContext("2d")
  let inkReady = false
  let lastSplit = ""
  stage.afterFrame = () => {
    if (!inkReady) return
    const H = window.innerHeight
    const b = heroEl.getBoundingClientRect().bottom
    let mode: string
    if (b >= H - 0.5) mode = "hero"
    else if (b <= 0.5) mode = "page"
    else mode = "split"
    const key = mode === "split" ? `split:${b.toFixed(1)}` : mode
    if (key !== lastSplit) {
      lastSplit = key
      canvas.style.mixBlendMode = mode === "page" ? "difference" : ""
      canvas.style.clipPath = mode === "split" ? `inset(0 0 ${(H - b).toFixed(1)}px 0)` : ""
      dif.style.display = mode === "split" ? "block" : "none"
      if (mode === "split") dif.style.clipPath = `inset(${b.toFixed(1)}px 0 0 0)`
    }
    if (mode === "split" && difCtx) {
      if (dif.width !== canvas.width) dif.width = canvas.width
      if (dif.height !== canvas.height) dif.height = canvas.height
      difCtx.clearRect(0, 0, dif.width, dif.height)
      difCtx.drawImage(canvas, 0, 0)
    }
  }

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
      // the loader is over: from here the ink follows the hero's edge
      inkReady = true
      tl.play()
      lenis.start()
      tl.eventCallback("onComplete", () => {
        stage!.maskLive = false
        stage!.mask.dirty = true
        loadCd()
        syncStage()
      })
    }
  }
}

boot()
