// The player's controls. The picture itself is never a separate player: the
// reel (or the card) that was clicked zooms to fill the screen, goes to black,
// and starts again from the top. This overlay only adds the controls on top of
// whichever video is playing: close, sound, a hairline timeline across the
// middle, and a chip that follows the pointer to play / pause.

import gsap from "gsap"
import { ICONS, pixelSvg, soundSvg } from "./icons"

const fmt = (s: number) => {
  if (!isFinite(s)) s = 0
  const m = Math.floor(s / 60)
  const r = Math.floor(s % 60)
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`
}

export class Player {
  isOpen = false
  private el: HTMLElement
  private video: HTMLVideoElement | null = null
  private onCloseRequest: (() => void) | null = null
  private closeBtn: HTMLButtonElement
  private soundBtn: HTMLButtonElement
  private bar: HTMLElement
  private fill: HTMLElement
  private head: HTMLElement
  private time: HTMLElement
  private dur: HTMLElement
  private chip: HTMLElement
  private chipIcon: HTMLElement
  private returnFocus: HTMLElement | null = null
  private idleT = 0
  private raf = 0
  private chipPos = { x: -200, y: -200, tx: -200, ty: -200 }
  private scrubbing = false
  private sync = () => this.syncIcons()
  private meta = () => {
    if (this.video) this.dur.textContent = fmt(this.video.duration)
  }

  constructor(root: HTMLElement) {
    this.el = root
    this.closeBtn = root.querySelector(".player__close")!
    this.soundBtn = root.querySelector(".player__sound")!
    this.bar = root.querySelector(".player__bar")!
    this.fill = root.querySelector(".player__fill")!
    this.head = root.querySelector(".player__head")!
    this.time = root.querySelector(".player__time")!
    this.dur = root.querySelector(".player__dur")!
    this.chip = root.querySelector(".player__chip")!
    this.closeBtn.innerHTML = pixelSvg(ICONS.close, "pxi")
    this.soundBtn.innerHTML = soundSvg()
    this.chip.innerHTML = `<span class="player__chip-icon"></span>`
    this.chipIcon = this.chip.firstElementChild as HTMLElement

    this.closeBtn.addEventListener("click", () => this.requestClose())
    this.soundBtn.addEventListener("click", () => this.video && this.setMuted(!this.video.muted))
    root.addEventListener("click", (e) => {
      if ((e.target as Element).closest(".player__btn, .player__bar")) return
      this.toggle()
    })
    root.addEventListener("pointermove", (e) => {
      this.chipPos.tx = e.clientX
      this.chipPos.ty = e.clientY
      const overUi = !!(e.target as Element).closest(".player__btn, .player__bar")
      this.chip.classList.toggle("is-hidden", overUi)
      this.wake()
    })
    root.addEventListener("pointerleave", () => this.chip.classList.add("is-hidden"))

    // scrub along the hairline
    const seek = (e: PointerEvent) => {
      const v = this.video
      if (!v) return
      const r = this.bar.getBoundingClientRect()
      const u = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
      if (isFinite(v.duration)) v.currentTime = u * v.duration
      this.paint()
    }
    this.bar.addEventListener("pointerdown", (e) => {
      this.scrubbing = true
      this.bar.setPointerCapture(e.pointerId)
      seek(e)
    })
    this.bar.addEventListener("pointermove", (e) => this.scrubbing && seek(e))
    this.bar.addEventListener("pointerup", () => (this.scrubbing = false))
    this.bar.addEventListener("pointercancel", () => (this.scrubbing = false))

    window.addEventListener("keydown", (e) => {
      if (!this.isOpen) return
      if (e.key === "Escape") this.requestClose()
      else if (e.key === " " && !(e.target as Element).closest("button")) {
        e.preventDefault()
        this.toggle()
      } else if ((e.key === "m" || e.key === "M") && this.video) this.setMuted(!this.video.muted)
      else if (e.key === "Tab") this.trapFocus(e)
    })
  }

  private trapFocus(e: KeyboardEvent) {
    const items = [this.closeBtn, this.soundBtn]
    const i = items.indexOf(document.activeElement as HTMLButtonElement)
    e.preventDefault()
    items[(i + (e.shiftKey ? items.length - 1 : 1)) % items.length].focus()
  }

  /** Puts the controls over a video that is already full screen. */
  attach(video: HTMLVideoElement, trigger: HTMLElement | null, onCloseRequest: () => void) {
    this.video = video
    this.onCloseRequest = onCloseRequest
    this.returnFocus = trigger
    this.isOpen = true
    video.addEventListener("play", this.sync)
    video.addEventListener("pause", this.sync)
    video.addEventListener("ended", this.sync)
    video.addEventListener("loadedmetadata", this.meta)
    this.meta()
    this.el.hidden = false
    this.el.classList.remove("is-idle")
    this.chip.classList.add("is-hidden")
    this.setMuted(video.muted)
    this.syncIcons()
    gsap.fromTo(this.el.querySelectorAll(".player__btn, .player__bar"), { opacity: 0 }, { opacity: 1, duration: 0.5, stagger: 0.06 })
    this.wake()
    const loop = () => {
      this.raf = requestAnimationFrame(loop)
      this.paint()
      const c = this.chipPos
      c.x += (c.tx - c.x) * 0.22
      c.y += (c.ty - c.y) * 0.22
      this.chip.style.transform = `translate3d(${c.x.toFixed(1)}px, ${c.y.toFixed(1)}px, 0)`
    }
    cancelAnimationFrame(this.raf)
    this.raf = requestAnimationFrame(loop)
  }

  /** Takes the controls away (the owner then zooms the picture back). */
  detach() {
    if (!this.isOpen) return
    this.isOpen = false
    const v = this.video
    if (v) {
      v.removeEventListener("play", this.sync)
      v.removeEventListener("pause", this.sync)
      v.removeEventListener("ended", this.sync)
      v.removeEventListener("loadedmetadata", this.meta)
    }
    this.video = null
    cancelAnimationFrame(this.raf)
    gsap.to(this.el.querySelectorAll(".player__btn, .player__bar, .player__chip"), {
      opacity: 0,
      duration: 0.25,
      onComplete: () => {
        this.el.hidden = true
        gsap.set(this.el.querySelectorAll(".player__btn, .player__bar, .player__chip"), { clearProps: "opacity" })
      },
    })
    // focus goes back quietly: no ring on the picture after a mouse close
    const back = this.returnFocus
    if (back && document.activeElement && this.el.contains(document.activeElement)) back.focus({ preventScroll: true, focusVisible: false } as FocusOptions)
  }

  private requestClose() {
    if (this.isOpen) this.onCloseRequest?.()
  }

  private toggle() {
    const v = this.video
    if (!v) return
    if (v.paused || v.ended) v.play().catch(() => {})
    else v.pause()
    this.wake()
  }

  private setMuted(m: boolean) {
    if (this.video) this.video.muted = m
    this.soundBtn.classList.toggle("is-muted", m)
    this.soundBtn.setAttribute("aria-label", m ? "Turn sound on" : "Mute")
  }

  private syncIcons() {
    const v = this.video
    const playing = !!v && !v.paused && !v.ended
    this.chipIcon.innerHTML = pixelSvg(playing ? ICONS.pause : ICONS.play, "pxi")
    this.el.classList.toggle("is-playing", playing)
  }

  private wake() {
    this.el.classList.remove("is-idle")
    clearTimeout(this.idleT)
    this.idleT = window.setTimeout(() => {
      if (this.video && !this.video.paused && !this.scrubbing) this.el.classList.add("is-idle")
    }, 2200)
  }

  private paint() {
    const v = this.video
    if (!v) return
    const u = v.duration ? v.currentTime / v.duration : 0
    this.fill.style.transform = `scaleX(${u.toFixed(4)})`
    this.head.style.left = `${(u * 100).toFixed(3)}%`
    const t = fmt(v.currentTime)
    if (this.time.textContent !== t) this.time.textContent = t
  }
}
