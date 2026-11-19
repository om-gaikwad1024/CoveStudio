# Cove Studio

Marketing studio site. Vite + TypeScript, raw WebGL2, GSAP for DOM timing. No framework.

## Run

```bash
npm install
npm run dev        # http://127.0.0.1:5173
npm run build      # type-checks, then builds to dist/
npm run preview    # serves dist/ on :4173
```

In dev, `?freeze=0.6` holds the loader at that second, and `window.__cove` exposes the stage.

## Deploy (Vercel)

Import the folder as a project (or run `vercel` in it). `vercel.json` sets the Vite build, `dist/` as
output and long-cache headers for hashed assets. No env vars.

## How the hero is built

One fixed WebGL canvas sits over the page (`pointer-events: none`) and draws the ink trail and the
opening loader; the DOM keeps the real, accessible text.

| File | Role |
| --- | --- |
| `src/gl/stage.ts` | the single loop: pointer → fluid, the ink pass, the loader, GPU tiering and a canvas-density ladder |
| `src/gl/mask.ts` | paints the hero's still white marks (services list, logo, the scroll hint) into a texture so the ink can drag and colour them |
| `src/palette.ts` | the brand palette (from `Image/brand-board.webp`, see `PALETTE.md`), shared with the shaders |
| `src/gl/fluid.ts` | GPU stable-fluids: velocity + dye; no swirl, light surface tension so the trail behaves like mercury; stamps drawn additively inside their bounding box |
| `src/gl/passes.ts` | composite (white ink, dragged type, edge colour, solved for the page's `difference` blend), loader (white → black halftone flood) |
| `public/img/cd-play.webm` / `.mp4` / `cd-poster.webp` | the CD (from `Image/CD_VId.webm`): still frame at rest; hovering spins the disc up and plays it on a loop, leaving winds it down. WebM keeps alpha; Safari gets the MP4 flattened onto the page colour |
| `src/hero.ts` | wireframe globe, spring 3D tilt (wordmark, CD case, cone), and the GPU "live marks" (wordmark, globe) for things that move every frame |

The 3D cat stands in the middle of the hero (`.hero__cat` marks its place; it is drawn by the Works
section's cat, see below), with "Scroll to experience" under it. In the hero it is matte gold, and every
three seconds a heat wave ripples across it: the surface swells as the wave passes and the crest glows
white-hot, cooling to orange, pink and violet behind it. As the Works section scrolls in, the cat slides
(tied to the scroll) to the section's bottom-right corner and turns into the sketch (grey clay, hatching,
lime outline). Its drawing buffer never changes size on the way (resizing mid-scroll stutters); the
hatching widens its period as the cat shrinks so it never shimmers.

**The trail rule (whole site).** The ink canvas is blended over the page in `difference`. Whatever lies
under it inverts: black ground → white, white type → black, lime → deep blue. Layers that must stay
untouched sit above it (z > 20): the reel, the cards, buttons (the nav pills, which have a solid fill),
the 3D cat, the CD and the cone, the full-screen player. All other type sits under it (z < 20). In the
hero the shader also knows where the white marks are (the mask), so inside the ink the type drags with
the flow and slides back, and where the liquid's edge cuts a letter the cut carries a drifting band of
palette colour; it draws the colour that, differenced with the page, shows exactly that. Ink is laid only
where a pointer or finger moves: nothing draws on its own (touch screens included). Over the reel or the cards, the Works bottom row lifts above them and inverts itself against what is
under it. During the loader the canvas draws normally (the loader is the canvas).

Trail: a flat, plain-edged white liquid that evaporates the way buttermax.net's does — measured there
at slow, medium and fast pointer speeds. Ink is eaten away at a steady rate (with a little spatial
variation), so the outline creeps inward from the moment it is laid, thin parts pinch off into beads
and strands, thick cores shrink last; everything is gone ~1 s after the pointer stops. Slow movement
makes one fat blob riding the cursor, medium a tadpole (fat head, tapering tail), fast a long even band
that collapses into strands. Type under the liquid is dragged a little with the flow and slides back.

Performance: integrated / mobile GPUs start at a 1x canvas, dedicated GPUs at 1.5x; the ladder watches
frame times against the display's own refresh and steps the canvas density. Measured on Intel Iris Xe
at 1600×760: 60 fps in the hero, through the hand-off, the reel's growth and the cards.

## How the Works section is built

Lime ground, ink type. Reference: macmillan.studio's opening (layout and motion studied, not copied).
Scrolling is Lenis (`src/main.ts`); there are no visible scrollbars. The first arrival into the section
always plays in full: the page settles on the section and holds until the heading has landed.

| File | Role |
| --- | --- |
| `src/work/work.ts` | layout + the one frame loop: arrival, reel → full screen over two screens of scroll, cat docking, sticky-note cards, hover, cursor chip, reel/card → player |
| `src/work/title.ts` | "MARKETING / STUDIO": fixed-width letter boxes, per-letter flicker, two layers (ink under the reel, white `difference` seen through a reel-sized window) |
| `src/work/glyphs.ts` | the pixel A, S and O (from `SOA.svg`) |
| `src/work/videoGL.ts` | the reel: one WebGL quad, cover-fit to a moving rounded rect, two-size block pixel dissolve, brightness for the fade through black |
| `src/work/cat3d.ts` | the 3D cat (`public/models/cat.glb`, Draco), grey clay + screen-space hatching + lime outline; matte gold with a travelling heat wave in the hero, blending into the sketch; rests looking 30° left, turns 30° right on hover (`CAT_REST`, `CAT_HOVER` in `work.ts`) |
| `src/work/player.ts` | player controls only (close, sound, hairline timeline, chip; Esc / Space / M). The picture is the reel itself zooming to full screen, black, then the film from the top a second later |
| `public/video/` | from `Image/Work_BG_Vid.mp4`: `work-full` (the reel: loops its first 20 s on the page, plays in full with sound when opened), `cardvid1-5` (first 5 s copies), `work-poster` |

Fonts: Helvetica Now Display everywhere. It is a licensed Monotype font, so it is not in the repo: put
`HelveticaNowDisplay-Regular.woff2`, `-Medium.woff2` and `-Bold.woff2` in `public/fonts/`. Until then the
stack falls back to Helvetica Neue / Helvetica / Arial (the heading re-measures when the font lands).

Alignment: one font size for both words is solved so that word one's ink spans reel edge → right margin
and word two's prefix ("STUDI") spans left margin → reel edge; M, edge and I share one vertical line.
Swap the words in `WORDS` / `PIXEL_AT` at the top of `work.ts`.

Layers in the first screen: the words (`.work__stage`, z 19, under the trail) and the reel
(`.work__media`, z 21, over it) are two pinned layers sharing the screen, so the trail inverts the heading
and the blurb but never touches the reel. The card section's words (`.work__cards-text`) are likewise
under the trail, the cards over it. The trail is 20% narrower than first tuned (`radius` in `stage.ts`).

One card per scroll: once a card has been scrolled past its first third the page carries it the rest
of the way to the next card and holds still until the flick that did it has died out (`stepToCard` in
`work.ts`), so momentum never throws the deck through several cards. A jump (a link, the next-card button)
simply rests on the card it lands by; past the last card the scroll is free.

Hold and settle: the first 0.35 screen of scrolling past the section's top moves nothing (`HOLD` in
`work.ts`), so momentum from the hero can never nudge the heading out of alignment; when a scroll comes to
rest within that hold (or just short of the section) the page settles exactly onto the section's top.

Cards: each card appears at 45% size a little below the middle and grows to full size (about 78% of the
screen tall) centred on the screen; then it peels like a sticky note (pivot on its top edge, bottom up and
toward you, twist) out through a top corner, even cards to the left and odd to the right, while the next
card grows underneath.

Heading weight: Helvetica Now Display Medium plus a hairline `-webkit-text-stroke` (0.007em); the
alignment accounts for the stroke. Grain: light and dark animated specks over the whole page (`.grain`).

The hero's header scrolls away with the hero; the Works bottom row sits at the foot of the section's first screen while the section is arriving, and stays at the viewport bottom once it has the screen.

Performance (Iris Xe, 1600×760, trail running): grow 59 fps / p95 16.9 ms, cards 57 fps. Only the card
nearest the centre plays; two playing video layers at once halve the frame rate. Encode with `setsar=1`:
the source has 959:960 pixels.
