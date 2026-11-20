// The Works section.
//
// 1. Arrival (always seen in full the first time): the page settles on the
//    section and holds while a small reel card rises, flies into its frame and
//    resolves out of pixels; the heading flickers in letter by letter; the cat
//    spins once. Word one starts exactly on the reel's left edge and word
//    two's I ends on it, so M, edge and I share one vertical line.
// 2. Scroll: over two screens of scrolling the reel grows to fill the screen
//    (looping its first 20 s), the heading folds into one row and leaves, the
//    cat climbs to the top right and becomes the logo. Then project cards rise
//    straight up and peel away like sticky notes, alternating left and right,
//    with a small "next" card at the bottom right.
// 3. Hover: the reel (or a card) pixelates and the cat turns further right.
//    Click: the same picture zooms to fill the screen, goes to black, and the
//    film starts from the top a second later, fading in, with sound.

import gsap from "gsap"
import type Lenis from "lenis"
import { VideoGL, type ReelRect } from "./videoGL"
import { Title, flickerWords, splitWords } from "./title"
import { Player } from "./player"
import { ICONS, pixelSvg } from "./icons"
import type { Cat3D } from "./cat3d"

const WORDS: [string, string] = ["MARKETING", "STUDIO"]
/** letters drawn as their pixel glyphs: the A, and the S and O of STUDIO */
const PIXEL_AT: [number[], number[]] = [[1], [0, 5]]
const FULL_SRC = "/video/work-full.mp4"
/** the reel loops its first seconds while it is part of the page */
const LOOP_END = 20
/** screens of scrolling for the reel to grow, then to hold full screen */
const GROW = 2
/**
 * Screens of scrolling past the section's top in which nothing moves. Scroll
 * momentum from the hero spends itself here, so the heading never drifts out
 * of alignment by accident; the page also settles back onto the section.
 */
const HOLD = 0.35
/** the cat's canvas is this much larger than the cat (room for its bob); must match cat3d.ts */
const CAT_FRAME = 1.15
/** screens of scrolling per card */
const CARD_UNIT = 0.9
/** card scroll offset: where card 0 is when the cards' screen first pins */
const CARD_LEAD = 1.25
/** the cat looks a little left at rest and a little right when hovered */
const CAT_REST = -30 * (Math.PI / 180)
const CAT_HOVER = 30 * (Math.PI / 180)

const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x))
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const inOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
const outCubic = (t: number) => 1 - Math.pow(1 - t, 3)
const lerpRect = (a: ReelRect, b: ReelRect, t: number): ReelRect => ({
  x: lerp(a.x, b.x, t),
  y: lerp(a.y, b.y, t),
  w: lerp(a.w, b.w, t),
  h: lerp(a.h, b.h, t),
  r: lerp(a.r, b.r, t),
})

export interface WorkOptions {
  lenis: Lenis
  /** hands the section the page's scroll gate (return false: the gesture is taken) */
  setScrollGate: (g: (e: { deltaY: number; event: Event }) => boolean) => void
  /** where the cat stands in the hero (it travels from there to the section's corner) */
  catSlot: HTMLElement
  /** the reel or a card has taken the whole screen (the page's own canvas steps aside) */
  onCinema: (on: boolean) => void
}

export function initWork(opts: WorkOptions) {
  const found = document.querySelector<HTMLElement>(".work")
  if (!found) return null
  const root: HTMLElement = found
  const { lenis } = opts
  const q = <T extends Element = HTMLElement>(s: string, from: ParentNode = root) => from.querySelector(s) as T
  const html = document.documentElement

  const introWrap = q(".work__intro")
  const stage = q(".work__stage")
  const glCanvas = q<HTMLCanvasElement>(".work__gl")
  const reel = q<HTMLVideoElement>(".work__src")
  const blurb = q(".work__blurb")
  const hit = q<HTMLButtonElement>(".work__hit")
  const chip = q(".work__chip")
  const win = q(".wt-win")
  const dif = q(".wt--dif")
  const bar = q(".work__bar")
  const barIn = q(".work__bar-in")
  const cardsWrap = q(".work__cards")
  const deck = Array.from(root.querySelectorAll<HTMLButtonElement>(".card"))
  const counter = q(".work__count-n")
  const nextBtn = q<HTMLButtonElement>(".work__next")
  const cursor = document.querySelector<HTMLElement>(".work-cursor")!
  const catCanvas = document.querySelector<HTMLCanvasElement>(".work-cat")!
  const player = new Player(document.querySelector<HTMLElement>(".player")!)
  const cardplay = document.querySelector<HTMLElement>(".cardplay")!
  const cardStill = q<HTMLCanvasElement>(".cardplay__still", cardplay)
  const cardFilm = q<HTMLVideoElement>(".cardplay__video", cardplay)

  const poster = new Image()
  poster.decoding = "async"
  poster.src = "/video/work-poster.webp"

  // medium, thickened a hair by a text stroke (see title.ts): weight without heaviness
  const title = new Title([q(".wt--ink"), dif], WORDS, PIXEL_AT, 100)
  const gl = new VideoGL(glCanvas, reel, poster)
  const coarse = matchMedia("(pointer: coarse)").matches
  if (coarse) root.classList.add("is-touch")

  // icons
  cursor.innerHTML = pixelSvg(ICONS.open, "pxi")
  chip.innerHTML = pixelSvg(ICONS.open, "pxi")
  q(".work__next-chip").innerHTML = pixelSvg(ICONS.open, "pxi")
  root.querySelectorAll(".work__tag-icon").forEach((el) => (el.innerHTML = pixelSvg(ICONS.tag, "pxi")))
  root.querySelectorAll(".work__sq").forEach((el) => (el.innerHTML = pixelSvg(ICONS.square, "pxi")))

  // small type flickers in word by word
  const blurbWords = splitWords(blurb)
  const barWords = splitWords(barIn)
  gsap.set([...blurbWords, ...barWords], { opacity: 0 })
  title.hideAll()

  // ---------- geometry ----------
  let W = 1
  let H = 1
  let narrow = false
  let frame: ReelRect = { x: 0, y: 0, w: 0, h: 0, r: 0 }
  let full: ReelRect = frame
  let pre: ReelRect = frame
  let cat0 = { x: 0, y: 0, s: 100 }
  let dock = { x: 0, y: 0, s: 48 }
  let pixSize = 20
  let lineGap = 0
  let mergeShift = 0
  let exitReach = 0
  let cardW = 300
  let cardH = 420
  let barH = 40
  const dpr = () => Math.min(window.devicePixelRatio || 1, 1.5)
  let cat: Cat3D | null = null
  let catBase = 100
  /** 0 hidden .. 1 shown: the cat's appearance in the Works corner */
  let workCat = 0
  const slamPrev = { x: -9999, y: -9999, on: false }
  /** where the hero cat is on screen (for clicks and its backdrop) */
  let catHero = { x: 0, y: 0, s: 0, on: false }
  /** 0 whole .. 1 burnt away: the hero cat (runs on time, see flipDown) */
  const heroCat = { out: 0 }
  /** the page turning between the hero and the Works section */
  let flip: "none" | "down" | "up" = "none"
  /** while leaving for the hero, the corner cat burns away before the page moves */
  let hideWorkCat = false
  /** seconds for the cat to burn away or burn back in */
  const BURN_TIME = 1.4
  /** seconds for the page to rise into the section (the last quarter of the burn) */
  const TURN_DOWN = BURN_TIME * 0.25
  let catRes = 0
  const catDpr = Math.min(window.devicePixelRatio || 1, 1.25)
  const scrollHint = document.querySelector<HTMLElement>(".hero__scroll")

  function layout() {
    W = stage.clientWidth
    H = stage.clientHeight
    narrow = W / H <= 1
    title.invalidate()
    const m = title.metrics()
    const g = narrow ? Math.max(14, W * 0.045) : Math.max(10, W * 0.0085)
    root.style.setProperty("--g", `${g}px`)
    let f: number, x1: number, y1: number, x2: number, y2: number
    if (!narrow) {
      const L = g
      const R = W - g
      const inkW1 = m.r1 - m.l1
      const inkW2 = m.r2 - m.l2
      // one size for both words, so that word one fills edge → right margin
      // and word two's prefix fills left margin → edge
      f = (100 * (R - L)) / (inkW1 + inkW2)
      f = Math.min(f, (0.2 * H) / (m.cap / 100))
      const s = f / 100
      const V = R - s * inkW1
      const capH = s * m.cap
      const bo = title.baselineOffset(f)
      // the letters touch the top edge and the reel starts right under them
      const capTop1 = 0
      x1 = V - s * m.l1
      y1 = capTop1 + capH - bo
      const top = capTop1 + capH
      const capTop2 = top + capH * 0.55
      x2 = V - s * m.r2
      y2 = capTop2 + capH - bo
      const bottom = Math.min(H * 0.7, top + H * 0.52)
      frame = { x: V, y: top, w: R - V, h: bottom - top, r: 0 }
      root.style.setProperty("--v", `${V}px`)
      blurb.style.left = `${V}px`
      blurb.style.top = `${bottom + H * 0.055}px`
      const cs = Math.min(W * 0.105, H * 0.22)
      cat0 = { x: R - cs * 0.96, y: H - cs - H * 0.012, s: cs }
      lineGap = capTop2 - capTop1
      // when word two climbs onto word one's row, word one steps right to make room for the last letter
      mergeShift = s * (m.r2full - m.r2) + f * 0.2
      exitReach = capTop1 + capH + f * 0.4 + H * 0.04
    } else {
      const inkW1 = m.r1 - m.l1
      const inkW2 = m.r2full - m.l2
      f = (100 * (W - 2 * g)) / Math.max(inkW1, inkW2)
      const s = f / 100
      const capH = s * m.cap
      const bo = title.baselineOffset(f)
      const capTop1 = Math.max(6, H * 0.008)
      x1 = g - s * m.l1
      y1 = capTop1 + capH - bo
      const capTop2 = capTop1 + capH * 1.24
      x2 = g - s * m.l2
      y2 = capTop2 + capH - bo
      const bTop = capTop2 + capH + H * 0.028
      blurb.style.left = `${g}px`
      blurb.style.top = `${bTop}px`
      const top = bTop + blurb.offsetHeight + H * 0.03
      const bottom = H - Math.max(64, H * 0.095)
      frame = { x: g, y: top, w: W - 2 * g, h: Math.max(120, bottom - top), r: 0 }
      root.style.setProperty("--v", `${g}px`)
      const cs = W * 0.24
      cat0 = { x: W - g - cs * 0.86, y: frame.y + frame.h - cs * 0.8, s: cs }
      lineGap = 0
      mergeShift = 0
      exitReach = capTop2 + capH + f * 0.4 + H * 0.04
    }
    title.place(f, x1, y1, x2, y2)
    dif.style.width = `${W}px`
    dif.style.height = `${H}px`
    full = { x: 0, y: 0, w: W, h: H, r: 0 }
    const pw = narrow ? W * 0.46 : Math.max(220, W * 0.17)
    const ph = pw * (narrow ? 1.15 : 0.5)
    pre = { x: (W - pw) / 2, y: H + 8, w: pw, h: ph, r: 14 }
    const ds = clamp(W * 0.036, 42, 66)
    dock = { x: W - g - ds, y: Math.max(8, g * 0.9), s: ds }
    pixSize = narrow ? 14 : clamp(W * 0.012, 14, 26)
    // a card at full size: about 78% of the screen tall
    cardH = Math.min(H * 0.78, (W * (narrow ? 0.82 : 0.5)) / 0.72)
    cardW = cardH * 0.72
    root.style.setProperty("--cw", `${cardW}px`)
    barH = barIn.offsetHeight || 40
    gl.resize(W, H, dpr())
    // the canvas is sized for the cat at its largest (in the hero); smaller
    // places are a scale of it, and the drawing buffer follows the scale
    catBase = Math.max(opts.catSlot.offsetHeight, cat0.s, 40)
    catCanvas.style.width = catCanvas.style.height = `${(catBase * CAT_FRAME).toFixed(1)}px`
    // one drawing-buffer size for the whole journey (resizing it mid-scroll stutters)
    catRes = Math.round(catBase * CAT_FRAME * catDpr)
    cat?.setSize(catRes)
    lastWin = ""
  }

  // ---------- state ----------
  const intro = { p: 0, started: false, done: false }
  const catShow = { v: 0 }
  let catSpun = false
  let catLoading = false
  const ptr = { x: -9999, y: -9999, in: false }
  const cur = { x: -9999, y: -9999, s: 0 }
  let hoverAmt = 0
  let lastWin = ""
  let lastGlitch = 0
  let nextGlitch = 3
  let activeCard = -1
  let time = 0
  let lastRect: ReelRect = frame
  let stageTop = 0
  let pxCard: HTMLButtonElement | null = null
  /** the reel full screen as the player: zoom 0..1 from `from`, brightness for the fade through black */
  const cinema = { on: false, zoom: 0, bright: 1, from: frame as ReelRect }
  let cardOpen = false

  let lastScrollAt = 0
  let settleArmed = false
  lenis.on("scroll", () => {
    lastScrollAt = performance.now()
    settleArmed = true
  })
  window.addEventListener("pointerdown", (e) => {
    if (!catHero.on || !cat) return
    const dx = catHero.x - e.clientX
    const dy = catHero.y - e.clientY
    const r = catHero.s * 0.38
    // a click is a blow on the spot that was clicked
    if (Math.abs(dx) < r && Math.abs(dy) < r * 1.1) cat.slam(-dx / catHero.s, -dy / catHero.s)
  })

  window.addEventListener(
    "pointermove",
    (e) => {
      ptr.x = e.clientX
      ptr.y = e.clientY
      ptr.in = e.pointerType !== "touch"
    },
    { passive: true },
  )
  html.addEventListener("pointerleave", () => (ptr.in = false))

  /** the reel's rect while it arrives: up from below, then into its frame */
  function flyRect(): ReelRect {
    if (intro.done) return frame
    const p = intro.p
    const mid: ReelRect = { x: (W - pre.w) / 2, y: H * 0.52 - pre.h / 2, w: pre.w, h: pre.h, r: pre.r }
    if (p < 0.38) return lerpRect(pre, mid, outCubic(p / 0.38))
    return lerpRect(mid, frame, inOut((p - 0.38) / 0.62))
  }

  function playReel() {
    if (reel.paused) reel.play().catch(() => {})
  }

  /**
   * The first arrival is never skipped: the page settles on the section and
   * holds still until the heading has landed, however hard it was scrolled.
   */
  function startIntro(lock: boolean, fromHero = false) {
    if (intro.started) return
    intro.started = true
    loadMedia()
    playReel()
    if (lock) {
      lenis.stop()
      const target = Math.round(window.scrollY + root.getBoundingClientRect().top)
      lenis.scrollTo(target, fromHero ? { duration: TURN_DOWN, easing: inOut, force: true } : { duration: 0.85, easing: outCubic, force: true })
    }
    const tl = gsap.timeline({
      // from the hero the page is still on its way: let the section arrive first
      delay: fromHero ? TURN_DOWN : 0,
      onComplete: () => {
        intro.done = true
        if (flip === "down") flip = "none"
        if (lock) lenis.start()
      },
    })
    tl.to(intro, { p: 1, duration: 1.45, ease: "none" }, 0)
    title.flickerIn(tl, 0.8, 0.5)
    flickerWords(tl, blurbWords, 1.15, 0.5)
    flickerWords(tl, barWords, 0.95, 0.6)
    tl.call(() => spinCat(), [], 0.85)
  }

  function spinCat() {
    if (!cat?.ready || catSpun) return
    catSpun = true
    gsap.fromTo(cat.spin, { turn: -1 }, { turn: 0, duration: 1.9, ease: "power3.out" })
  }

  let mediaLoaded = false
  function loadMedia() {
    if (mediaLoaded) return
    mediaLoaded = true
    reel.preload = "auto"
    if (!reel.getAttribute("src")) reel.src = reel.dataset.src!
    reel.load()
  }

  function loadCat() {
    if (catLoading) return
    catLoading = true
    import("./cat3d")
      .then(({ Cat3D }) => {
        cat = new Cat3D(catCanvas)
        cat.setSize(catRes)
        return cat.load("/models/cat.glb")
      })
      .then(() => {
        root.classList.add("has-cat")
        catEntrance()
        if (intro.started) spinCat()
      })
      .catch((err) => console.warn("Cove: cat model unavailable", err))
  }

  /** The hero's entrance brings the cat in: it burns in, as it burns away (waits for the model). */
  let catEntranceDue = false
  function showCat() {
    catEntranceDue = true
    if (cat?.ready) catEntrance()
  }
  function catEntrance() {
    if (!catEntranceDue) return
    catEntranceDue = false
    catShow.v = 1
    heroCat.out = 1
    gsap.to(heroCat, { out: 0, duration: BURN_TIME, ease: "sine.inOut" })
  }

  // ---------- the reel becomes the player ----------
  function setCinema(on: boolean) {
    root.classList.toggle("is-cinema", on)
    html.classList.toggle("is-cinema", on)
    opts.onCinema(on)
  }

  function openReel() {
    if (cinema.on || cardOpen || !intro.started) return
    cinema.on = true
    cinema.from = { ...lastRect, y: lastRect.y + stageTop }
    cinema.zoom = 0
    cinema.bright = 1
    lenis.stop()
    setCinema(true)
    // the click is the gesture that allows sound; keep it silent until the restart
    reel.muted = false
    reel.volume = 0
    playReel()
    gsap.killTweensOf(cinema)
    gsap
      .timeline()
      .to(cinema, { zoom: 1, duration: 1.05, ease: "power3.inOut" }, 0)
      .to(cinema, { bright: 0, duration: 0.5, ease: "power1.in" }, 0.7)
      .call(() => {
        reel.pause()
        reel.currentTime = 0
      }, [], 1.25)
      // a second of black, then the film from the top, fading in
      .call(() => {
        reel.volume = 1
        playReel()
        player.attach(reel, hit, closeReel)
      }, [], 2.25)
      .to(cinema, { bright: 1, duration: 1.8, ease: "power1.inOut" }, 2.25)
  }

  function closeReel() {
    if (!cinema.on) return
    player.detach()
    gsap.killTweensOf(cinema)
    gsap
      .timeline({
        onComplete: () => {
          cinema.on = false
          setCinema(false)
          lenis.start()
        },
      })
      .to(cinema, { bright: 0, duration: 0.35, ease: "power1.in" }, 0)
      .call(() => {
        reel.muted = true
        reel.currentTime = 0
        playReel()
      }, [], 0.36)
      .to(cinema, { zoom: 0, duration: 0.95, ease: "power3.inOut" }, 0.4)
      .to(cinema, { bright: 1, duration: 0.6, ease: "power1.out" }, 0.5)
  }

  // ---------- a card becomes the player ----------
  function openCard(card: HTMLButtonElement) {
    if (cinema.on || cardOpen) return
    cardOpen = true
    const v = card.querySelector("video")!
    const b = card.getBoundingClientRect()
    // the card's own current frame, cover-fitted to the screen, carries the zoom
    cardStill.width = Math.round(window.innerWidth)
    cardStill.height = Math.round(window.innerHeight)
    const ctx = cardStill.getContext("2d")!
    ctx.fillStyle = "#000"
    ctx.fillRect(0, 0, cardStill.width, cardStill.height)
    if (v.readyState >= 2) {
      const s = Math.max(cardStill.width / v.videoWidth, cardStill.height / v.videoHeight)
      ctx.drawImage(v, (cardStill.width - v.videoWidth * s) / 2, (cardStill.height - v.videoHeight * s) / 2, v.videoWidth * s, v.videoHeight * s)
    }
    v.pause()
    if (cardFilm.getAttribute("src") !== FULL_SRC) {
      cardFilm.src = FULL_SRC
      cardFilm.preload = "auto"
    }
    cardFilm.muted = false
    cardFilm.volume = 1
    cardFilm.pause()
    gsap.set(cardFilm, { opacity: 0 })
    gsap.set(cardStill, { opacity: 1 })
    lenis.stop()
    setCinema(true)
    cardplay.hidden = false
    const clip = { p: 0 }
    const setClip = () => {
      const k = 1 - inOut(clip.p)
      const t = b.top * k
      const l = b.left * k
      const r = (window.innerWidth - b.right) * k
      const bt = (window.innerHeight - b.bottom) * k
      cardplay.style.clipPath = `inset(${t.toFixed(1)}px ${r.toFixed(1)}px ${bt.toFixed(1)}px ${l.toFixed(1)}px round ${(12 * k).toFixed(1)}px)`
    }
    setClip()
    // load the film in the user's gesture so it may play with sound later
    cardFilm.play().then(() => cardFilm.pause()).catch(() => {})
    gsap
      .timeline()
      .to(clip, { p: 1, duration: 1.05, ease: "none", onUpdate: setClip }, 0)
      .to(cardStill, { opacity: 0, duration: 0.5, ease: "power1.in" }, 0.7)
      .call(() => {
        cardFilm.pause()
        cardFilm.currentTime = 0
      }, [], 1.25)
      .call(() => {
        cardFilm.play().catch(() => {})
        player.attach(cardFilm, card, () => closeCard(b))
      }, [], 2.25)
      .to(cardFilm, { opacity: 1, duration: 1.8, ease: "power1.inOut" }, 2.25)
  }

  function closeCard(b: DOMRect) {
    player.detach()
    const clip = { p: 1 }
    const setClip = () => {
      const k = 1 - inOut(clip.p)
      cardplay.style.clipPath = `inset(${(b.top * k).toFixed(1)}px ${((window.innerWidth - b.right) * k).toFixed(1)}px ${((window.innerHeight - b.bottom) * k).toFixed(1)}px ${(b.left * k).toFixed(1)}px round ${(12 * k).toFixed(1)}px)`
    }
    gsap
      .timeline({
        onComplete: () => {
          cardFilm.pause()
          cardplay.hidden = true
          cardOpen = false
          setCinema(false)
          lenis.start()
        },
      })
      .to(cardFilm, { opacity: 0, duration: 0.35 }, 0)
      .to(cardStill, { opacity: 1, duration: 0.5 }, 0.3)
      .to(clip, { p: 0, duration: 0.95, ease: "none", onUpdate: setClip }, 0.4)
  }

  hit.addEventListener("click", openReel)
  deck.forEach((card) => card.addEventListener("click", () => openCard(card)))
  // the small card opens the main reel: up to its section, then the film
  nextBtn.addEventListener("click", () => {
    if (cinema.on || cardOpen) return
    const target = Math.round(window.scrollY + root.getBoundingClientRect().top)
    lenis.scrollTo(target, { duration: 1.4, easing: inOut, lock: true, force: true, onComplete: () => openReel() })
  })
  const miniCanvas = q<HTMLCanvasElement>("canvas", nextBtn)
  function drawMini() {
    const bw = nextBtn.clientWidth
    const bh = nextBtn.clientHeight
    const d = Math.min(window.devicePixelRatio || 1, 2)
    const cw = Math.round(bw * d)
    const chh = Math.round(bh * d)
    if (miniCanvas.width !== cw) miniCanvas.width = cw
    if (miniCanvas.height !== chh) miniCanvas.height = chh
    const vw = reel.videoWidth
    const vh = reel.videoHeight
    if (!vw || !vh) return
    const s = Math.max(cw / vw, chh / vh)
    const ctx = miniCanvas.getContext("2d")!
    ctx.drawImage(reel, (vw - cw / s) / 2, (vh - chh / s) / 2, cw / s, chh / s, 0, 0, cw, chh)
  }

  // ---------- cards: lazy sources, pixel overlay ----------
  const cardVideos = deck.map((c) => c.querySelector("video")!)
  const ensureSrc = (v: HTMLVideoElement) => {
    if (!v.getAttribute("src") && v.dataset.src) {
      v.src = v.dataset.src
      v.preload = "auto"
    }
  }
  function drawPixelCard(card: HTMLButtonElement) {
    const v = card.querySelector("video")!
    const cv = card.querySelector("canvas")!
    if (v.readyState < 2) return
    const bw = card.offsetWidth
    const bh = card.offsetHeight
    const cell = narrow ? 12 : 16
    const cw = Math.max(2, Math.round(bw / cell))
    const chh = Math.max(2, Math.round(bh / cell))
    if (cv.width !== cw) cv.width = cw
    if (cv.height !== chh) cv.height = chh
    const ctx = cv.getContext("2d")!
    const vw = v.videoWidth
    const vh = v.videoHeight
    const s = Math.max(bw / vw, bh / vh)
    const sw = bw / s
    const sh = bh / s
    ctx.imageSmoothingEnabled = true
    ctx.drawImage(v, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, cw, chh)
  }

  /**
   * Leaving the hero. The first scroll down stops the page; a heat wave burns
   * the cat away (bottom left to top right, about half a second); then the
   * page carries itself to the Works section.
   */
  function flipDown() {
    flip = "down"
    lenis.stop()
    gsap.to(heroCat, { out: 1, duration: BURN_TIME, ease: "sine.inOut" })
    // the section starts coming up when the cat is three quarters gone and is
    // in place as the last of it burns away
    gsap.delayedCall(BURN_TIME * 0.75, () => {
      if (!intro.started) return startIntro(true, true)
      const target = Math.round(window.scrollY + root.getBoundingClientRect().top)
      lenis.scrollTo(target, {
        duration: TURN_DOWN,
        easing: inOut,
        force: true,
        onComplete: () => {
          flip = "none"
          lenis.start()
        },
      })
    })
  }

  /**
   * Back to the hero, at twice the pace of the way down: the corner cat burns
   * away, the page carries itself up, the hero cat forms again.
   */
  function flipUp() {
    flip = "up"
    lenis.stop()
    hideWorkCat = true
    gsap.delayedCall(BURN_TIME * 0.5, () => {
      lenis.scrollTo(0, {
        duration: 0.62,
        easing: inOut,
        force: true,
        onComplete: () => {
          hideWorkCat = false
          gsap.to(heroCat, { out: 0, duration: BURN_TIME * 0.5, ease: "sine.inOut" })
          flip = "none"
          lenis.start()
        },
      })
    })
  }

  // ---------- the deck: one gesture, one card ----------
  // Inside the cards section every wheel or touch gesture moves the deck by
  // exactly one card. The gesture is taken at the input (the page itself never
  // scrolls inside the deck), the move is one eased glide, and the rest of that
  // gesture (a trackpad's long inertia tail) is ignored, so one flick is always
  // one card. Past the last card, or above the first, the page scrolls freely.
  const STEP_TIME = 1.0
  const easeStep = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2)
  const deckState = { moving: false, lastEventAt: 0, gestureSpent: false }

  /** Fractional deck position now: 0 = card 0 at rest, 1 = card 1 at rest… */
  const deckPos = () => (H - cardsWrap.getBoundingClientRect().top) / (H * CARD_UNIT) - CARD_LEAD
  /** Page scroll at which card i rests. */
  const restY = (i: number) => Math.round(window.scrollY + cardsWrap.getBoundingClientRect().top - H + (CARD_LEAD + i) * H * CARD_UNIT)

  function goToCard(i: number) {
    deckState.moving = true
    lenis.scrollTo(restY(i), {
      duration: STEP_TIME,
      easing: easeStep,
      lock: true,
      force: true,
      onComplete: () => (deckState.moving = false),
    })
  }

  /** The deck's share of the scroll gate: true if it took the gesture. */
  function deckGesture(deltaY: number) {
    const N = deck.length
    const f = deckPos()
    // the deck owns the scroll from just before card 0 to just after the last card
    if (f < -0.62 || f > N - 1 + 0.5) return false
    const down = deltaY > 0
    if (down && f >= N - 1 - 0.02) return false // past the last card: let the page go on
    if (!down && f <= 0.02 && f > -0.02) return false // above the first card: back to the reel
    const now = performance.now()
    const quiet = now - deckState.lastEventAt
    deckState.lastEventAt = now
    if (deckState.moving) return true
    // the rest of a gesture that already moved a card is spent
    if (deckState.gestureSpent && quiet < 180) return true
    deckState.gestureSpent = false
    if (Math.abs(deltaY) < 1.5) return true
    const from = Math.round(clamp(f, 0, N - 1))
    let to = down ? Math.floor(f + 0.02) + 1 : Math.ceil(f - 0.02) - 1
    if (f < -0.02) to = 0 // arriving from the reel: land on the first card
    if (f > N - 1 + 0.02) to = N - 1 // arriving from below: land on the last card
    to = clamp(to, 0, N - 1)
    if (to === from && Math.abs(f - from) < 0.02) return true
    deckState.gestureSpent = true
    goToCard(to)
    return true
  }

  // the page's scroll gate: the page turn (hero ⇄ section) and the deck
  opts.setScrollGate(({ deltaY, event }) => {
    // a touch starting (no distance yet) is never taken: taps must stay taps
    if (cinema.on || cardOpen || deltaY === 0) return true
    let taken = false
    if (flip !== "none") taken = true
    else {
      const top = root.getBoundingClientRect().top
      if (deltaY > 0 && window.scrollY < 2 && heroCat.out < 0.5) {
        flipDown()
        taken = true
      } else if (deltaY < 0 && Math.abs(top) < 2 && intro.done) {
        flipUp()
        taken = true
      } else if (intro.done) taken = deckGesture(deltaY)
    }
    if (taken && event.cancelable) event.preventDefault()
    return !taken
  })

  // ---------- the frame loop ----------
  // All layout reads happen first, then all writes, so a frame never forces
  // the browser to lay the page out twice.
  function tick(_: number, deltaMs: number) {
    const dt = Math.min(deltaMs / 1000, 1 / 20)
    time += dt

    // ---- reads ----
    const rr = root.getBoundingClientRect()
    const ir = introWrap.getBoundingClientRect()
    const cardsR = cardsWrap.getBoundingClientRect()
    const slotR = opts.catSlot.getBoundingClientRect()
    const near = rr.top < H * 1.1 && rr.bottom > -H * 0.1
    let onHit = false
    let onCard: HTMLButtonElement | null = null
    if (near && ptr.in && !coarse && !cinema.on && !cardOpen) {
      const el = document.elementFromPoint(ptr.x, ptr.y)
      onHit = !!el?.closest(".work__hit") && intro.started
      onCard = (el?.closest(".card") as HTMLButtonElement) || null
    }

    // ---- writes ----
    html.classList.toggle("in-work", rr.top < 70 && rr.bottom > 70)

    // phase A progress (after the hold), shared by the cat and the section
    stageTop = Math.min(Math.max(ir.top, 0), ir.bottom - H)
    const p = clamp((-ir.top - HOLD * H) / (H * GROW))

    // ---- the cat ----
    // It never travels between sections. In the hero it stands in its place;
    // leaving, a heat wave burns it away before the page moves. Once the Works
    // section is in place it burns back in at the section's corner (and later
    // climbs to the logo's place). Going back up reverses both.
    // the page turn between the hero and the section (see flipDown / flipUp)
    const secTop = window.scrollY + rr.top
    if (flip === "none" && !cinema.on && !cardOpen && !lenis.isStopped) {
      const between = window.scrollY > 2 && window.scrollY < secTop - 2
      if (between && lenis.direction > 0 && heroCat.out < 0.5) flipDown()
      else if (between && lenis.direction < 0 && intro.done) flipUp()
    }
    // back at the top by any road (a key, a link) and not mid-turn: the cat forms again
    if (flip === "none" && window.scrollY < 4 && heroCat.out > 0.001 && !gsap.isTweening(heroCat))
      gsap.to(heroCat, { out: 0, duration: BURN_TIME, ease: "sine.inOut" })
    const heroOut = heroCat.out
    const wantWork = intro.started && rr.top < H * 0.35 && !hideWorkCat ? 1 : 0
    // the Works appearance plays at the same unhurried pace once the section is in place
    workCat = clamp(workCat + (wantWork ? dt / BURN_TIME : -dt / (hideWorkCat ? BURN_TIME * 0.5 : BURN_TIME)))
    const inHero = heroOut < 0.999
    let ccx: number
    let ccy: number
    let cs: number
    if (inHero) {
      ccx = slotR.left + slotR.width / 2
      ccy = slotR.top + slotR.height / 2
      cs = slotR.height
    } else {
      const ec = inOut(clamp(p / 0.85))
      const endLift = Math.min(0, cardsR.bottom - H)
      ccx = lerp(cat0.x + cat0.s / 2, dock.x + dock.s / 2, ec)
      ccy = lerp(cat0.y + stageTop + cat0.s / 2, dock.y + endLift + dock.s / 2, ec)
      cs = lerp(cat0.s, dock.s, ec)
    }
    const dissolve = inHero ? heroOut : 1 - inOut(workCat)
    let onCat = false
    if (ptr.in && !coarse && !cinema.on && !cardOpen && dissolve < 0.5) {
      const r = cs * 0.38
      onCat = Math.abs(ptr.x - ccx) < r && Math.abs(ptr.y - ccy) < r * 1.1
    }
    // a slam: the pointer arriving on the hero cat fast is a blow on the spot it
    // lands on (the cat flashes there and a heat ring spreads from it)
    const pdt = Math.max(1 / 240, dt)
    const pdx = ptr.x - slamPrev.x
    const pdy = ptr.y - slamPrev.y
    const speed = Math.hypot(pdx, pdy) / pdt
    if (inHero && onCat && !slamPrev.on && speed > 900 && slamPrev.x > -9000) cat?.slam((ptr.x - ccx) / cs, (ptr.y - ccy) / cs)
    slamPrev.x = ptr.x
    slamPrev.y = ptr.y
    slamPrev.on = onCat
    catHero = { x: ccx, y: ccy, s: cs, on: inHero && dissolve < 0.5 }
    const catOn = !!cat?.ready && catShow.v > 0.001 && dissolve < 0.999 && ccy - cs < H && ccy + cs > 0 && !cinema.on && !cardOpen
    catCanvas.style.visibility = catOn ? "visible" : "hidden"
    if (catOn && cat) {
      const half = (catBase * CAT_FRAME) / 2
      catCanvas.style.transform = `translate3d(${(ccx - half).toFixed(1)}px, ${(ccy - half).toFixed(1)}px, 0) scale(${(cs / catBase).toFixed(4)})`
      catCanvas.style.opacity = String(catShow.v)
      // matte grey with the heat wave in the hero, the sketch in the Works section
      cat.gold = inHero ? 1 : 0
      cat.dissolve = dissolve
      cat.setHatchScale((cs * CAT_FRAME * (window.devicePixelRatio || 1)) / Math.max(1, catRes))
      // in the hero the cat turns to face the pointer, wherever it is; in its
      // corner it turns to look at what you are pointing at
      if (inHero) {
        cat.look = ptr.in ? { x: clamp((ptr.x - ccx) / (W * 0.45), -1, 1), y: clamp((ptr.y - ccy) / (H * 0.55), -1, 1) } : null
        if (!ptr.in) cat.yawTarget = CAT_REST
      } else {
        cat.look = null
        cat.yawTarget = onHit || onCard || onCat ? CAT_HOVER : CAT_REST
      }
      cat.update(dt)
    }

    if (scrollHint) scrollHint.style.opacity = String(1 - clamp(window.scrollY / (H * 0.18)))

    // ---- settle: a scroll that comes to rest just past (or just short of) the
    // section's top lands on it exactly, so the section always sits in place
    if (settleArmed && performance.now() - lastScrollAt > 220 && intro.done && !cinema.on && !cardOpen && !lenis.isStopped) {
      settleArmed = false
      if (rr.top < -1 && rr.top > -HOLD * H)
        lenis.scrollTo(Math.round(window.scrollY + rr.top), { duration: 0.65, easing: outCubic })
    }

    if (!near && !cinema.on) {
      if (!reel.paused && !(cardsR.top <= 1 && cardsR.bottom >= H - 1)) reel.pause()
      cursor.style.opacity = "0"
      return
    }
    if (!intro.started && rr.top < H * 0.6) startIntro(rr.top > -H * 0.3)
    if (!mediaLoaded && rr.top < H * 1.05) loadMedia()

    // the reel loops its opening while it is part of the page
    if (!cinema.on && reel.currentTime >= LOOP_END) reel.currentTime = 0

    // ---- phase A: the reel grows to the whole screen over two screens of scroll ----
    const e = inOut(p)
    const introVisible = ir.bottom > 0 && ir.top < H
    let rect = lerpRect(flyRect(), full, e)
    lastRect = rect

    // heading: the second word climbs onto the first word's row, then both leave
    const conv = narrow ? 0 : inOut(clamp(p / 0.5))
    const exitY = -inOut(clamp((p - 0.28) / 0.6)) * exitReach
    title.offset(conv * mergeShift, exitY, 0, -conv * lineGap + exitY * 1.04)
    blurb.style.transform = `translate3d(0, ${(-e * H * 0.32).toFixed(1)}px, 0)`
    blurb.style.opacity = String(1 - clamp(p * 2.6))

    // the white heading shows only through a window the size of the reel
    const wx = rect.x.toFixed(1)
    const wy = rect.y.toFixed(1)
    const ww = rect.w.toFixed(1)
    const wh = rect.h.toFixed(1)
    const key = `${wx},${wy},${ww},${wh}`
    if (key !== lastWin) {
      lastWin = key
      win.style.transform = `translate3d(${wx}px, ${wy}px, 0)`
      win.style.width = `${ww}px`
      win.style.height = `${wh}px`
      dif.style.transform = `translate3d(${-rect.x}px, ${-rect.y}px, 0)`
      hit.style.transform = win.style.transform
      hit.style.width = win.style.width
      hit.style.height = win.style.height
    }
    chip.style.transform = `translate3d(${(rect.x + rect.w / 2).toFixed(1)}px, ${(rect.y + rect.h / 2).toFixed(1)}px, 0)`
    hit.tabIndex = intro.started ? 0 : -1

    // ---- the reel ----
    hoverAmt += ((onHit ? 1 : 0) - hoverAmt) * (1 - Math.exp(-dt * 9))
    if (cinema.on) {
      // full screen from wherever it was: the canvas is fixed to the viewport now
      rect = lerpRect(cinema.from, { x: 0, y: 0, w: W, h: H, r: 0 }, cinema.zoom)
      gl.render(rect, pixSize, hoverAmt * (1 - cinema.zoom), 0, cinema.bright)
    } else if (introVisible && !cardOpen) {
      if (intro.started) playReel()
      const ip = intro.p
      const introAmt = 1 - clamp((ip - 0.3) / 0.62)
      const sweep = (1 - clamp(ip / 0.95)) * 1.3
      const pix = lerp(pixSize * 1.7, pixSize, clamp(ip * 1.2))
      const amt = Math.max(introAmt, hoverAmt)
      if (intro.started) gl.render(rect, pix, amt, sweep)
      else gl.clear()
    } else if (cardsR.top <= 1 && cardsR.bottom >= H - 1 && !cardOpen) {
      // the cards' small card shows the reel: keep it running (looped above)
      playReel()
    } else if (!reel.paused) reel.pause()

    // ---- idle hiccups in the heading ----
    if (intro.done && introVisible && p < 0.25 && time - lastGlitch > nextGlitch) {
      lastGlitch = time
      nextGlitch = 2.4 + Math.random() * 3
      title.glitch()
      if (Math.random() < 0.35) gsap.delayedCall(0.12, () => title.glitch())
    }

    // ---- cards (after the reference recording) ----
    // A card appears small near the middle and grows as you scroll, its top
    // climbing until it sits on the top edge of the screen. Then it is peeled
    // off like a sticky note: it pivots on its top edge, the bottom lifts
    // toward you and up, it twists and leaves through a top corner, one card
    // to the left, the next to the right, while the next card is already
    // growing underneath.
    const u = (H - cardsR.top) / (H * CARD_UNIT)
    const N = deck.length
    const pinned = cardsR.top <= 1 && cardsR.bottom >= H - 1
    // Only the card nearest its resting place plays; two moving video layers
    // at once halve the frame rate on integrated GPUs, so the others hold a still.
    let lead = -1
    let leadD = 0.75
    for (let i = 0; i < N; i++) {
      const d = Math.abs(u - CARD_LEAD - i + 0.15)
      if (d < leadD) {
        leadD = d
        lead = i
      }
    }
    const cx0 = W * 0.5
    deck.forEach((card, i) => {
      const s = u - CARD_LEAD - i // -1 appearing .. 0 full size .. 1 peeled away
      const v = cardVideos[i]
      const show = s > -1 && s < 1.02
      if (s > -2 && s < 1.1) ensureSrc(v)
      card.style.visibility = show ? "visible" : "hidden"
      if (!show) {
        if (!v.paused) v.pause()
        return
      }
      if (i === lead && !cinema.on && !cardOpen) {
        if (v.paused) v.play().catch(() => {})
      } else if (!v.paused) v.pause()
      // even cards leave to the left, odd ones to the right
      const side = i % 2 === 0 ? -1 : 1
      let ty: number
      let sc: number
      let tx = 0
      let rx = 0
      let rz = 0
      // at rest the card is centred on the screen
      const restTop = (H - cardH) / 2
      if (s <= 0) {
        // grow: from 45% size, a little below the middle, to full size centred
        const k = inOut(clamp(s + 1))
        sc = lerp(0.45, 1, k)
        const smallTop = H * 0.56 - (cardH * 0.45) / 2
        ty = lerp(smallTop, restTop, k)
      } else {
        // peel: slides up off the screen, bottom swings up toward you, twists out to its side
        const k = s
        const e2 = k * k
        sc = 1 + k * 0.05
        ty = restTop - k * (H * 0.1 + restTop * 0.6) - e2 * (H * 0.32 + restTop)
        rx = Math.min(70, k * 48 + e2 * 18)
        rz = side * (k * 15 + e2 * 7)
        tx = side * (k * W * 0.07 + e2 * W * 0.16)
      }
      card.style.transform =
        `translate3d(${(cx0 - cardW / 2 + tx).toFixed(1)}px, ${ty.toFixed(1)}px, 0) ` +
        `rotateX(${rx.toFixed(2)}deg) rotateZ(${rz.toFixed(2)}deg) scale(${sc.toFixed(4)})`
      // the card being peeled lies on top of the one growing beneath it
      card.style.zIndex = String(10 + N - i)
    })
    const act = Math.round(clamp(u - CARD_LEAD - 0.35, 0, N - 1))
    if (act !== activeCard) {
      activeCard = act
      counter.textContent = `(${String(act + 1).padStart(2, "0")}—${String(N).padStart(2, "0")})`
    }
    // the small card: the main reel, drawn from the reel itself (no second video)
    const miniOn = pinned && u > 1
    nextBtn.classList.toggle("is-on", miniOn)
    if (miniOn && reel.readyState >= 2) drawMini()

    // pixel overlay on the hovered card
    if (pxCard && pxCard !== onCard) pxCard.classList.remove("is-px")
    pxCard = onCard
    if (onCard) {
      onCard.classList.add("is-px")
      drawPixelCard(onCard)
    }

    // ---- the bottom row: ink on the ground, white over the reel or the cards ----
    // the bottom row belongs to the section: while the section is still
    // arriving (or leaving, scrolling up) it sits at the foot of the section's
    // first screen and moves with it, never riding up over the hero
    const barShift = Math.max(0, rr.top)
    barIn.style.transform = barShift > 0 ? `translate3d(0, ${barShift.toFixed(1)}px, 0)` : ""
    const barTop = H - barH
    const overReel = rect.y + rect.h + stageTop > barTop + barH * 0.4 && rect.x < W * 0.6 && introVisible
    const overCards = cardsR.top < barTop + barH * 0.5
    bar.classList.toggle("is-light", overReel || overCards)

    // ---- the cursor chip ----
    const want = onHit || !!onCard
    cur.s += ((want ? 1 : 0) - cur.s) * (1 - Math.exp(-dt * 14))
    if (cur.x < -9000) {
      cur.x = ptr.x
      cur.y = ptr.y
    }
    cur.x += (ptr.x - cur.x) * (1 - Math.exp(-dt * 18))
    cur.y += (ptr.y - cur.y) * (1 - Math.exp(-dt * 18))
    cursor.style.opacity = cur.s > 0.01 ? "1" : "0"
    cursor.style.transform = `translate3d(${cur.x.toFixed(1)}px, ${cur.y.toFixed(1)}px, 0) scale(${cur.s.toFixed(3)})`
    root.classList.toggle("is-pointing", want)
  }

  layout()
  loadCat()
  gsap.ticker.add(tick)
  let rT = 0
  window.addEventListener("resize", () => {
    clearTimeout(rT)
    rT = window.setTimeout(layout, 90)
  })
  // the web font may land after the first measure
  document.fonts?.ready.then(() => layout())
  // start fetching while the visitor is still on the hero, once they scroll
  const early = () => {
    if (window.scrollY > 30) {
      loadMedia()
      window.removeEventListener("scroll", early)
    }
  }
  window.addEventListener("scroll", early, { passive: true })
  window.setTimeout(loadMedia, 5000)

  return { layout, showCat }
}
