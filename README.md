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
| `src/gl/mask.ts` | paints the hero's still white marks (nav pills, services list, logo, the scroll hint) into a texture so the ink can drag and colour them |
| `src/palette.ts` | the brand palette (from `Image/brand-board.webp`, see `PALETTE.md`), shared with the shaders |
| `src/gl/fluid.ts` | GPU stable-fluids: velocity + dye; no swirl, light surface tension so the trail behaves like mercury; stamps drawn additively inside their bounding box |
| `src/gl/passes.ts` | composite (white ink, dragged type, edge colour, solved for the page's `difference` blend), loader (white → black halftone flood) |
| `public/img/cd-play.webm` / `.mp4` / `cd-poster.webp` | the CD (from `Image/CD_VId.webm`): still frame at rest; hovering spins the disc up and plays it on a loop, leaving winds it down. WebM keeps alpha; Safari gets the MP4 flattened onto the page colour |
| `src/hero.ts` | wireframe globe, spring 3D tilt (wordmark, CD case, cone), and the GPU "live marks" (wordmark, globe) for things that move every frame |

The 3D cat stands in the middle of the hero (`.hero__cat` marks its place; it is drawn by the Works
section's cat), with "Scroll to experience" under it. In the hero it is dark matte black with soft white
highlights, and it turns to face the pointer wherever it is on the page (yaw and pitch on soft springs,
like the objects on buttermax.net). Every three seconds a heat wave ripples through it, from its back round
to its front (the surface swells, the crest glows white-hot, cooling to orange, pink and violet behind it).
Slammed (the pointer arriving faster than ~900 px/s, or a click), the spot it hit flashes white-hot and a
ring of heat spreads from it through the body (0.85 s), wrapping round the head to the far side. One wave
at a time: the idle wave cools away the moment the cat is hit (0.2 s) and starts its beat again from the
beginning once the cat has calmed (0.9 s after the ring); where the outgoing ring meets the last of the
cooling idle crest, that spot glows a moment hotter.

Entrance: after the loader, the wordmark and the cat burn in the way the cat burns away before the page
turn (1.4 s). The wordmark is revealed by a soft diagonal front (a CSS mask sweep) through a heat haze
(SVG filter `#heat-in`, feTurbulence + feDisplacementMap, its strength animated by `burnIn` in main.ts)
with a warm glow that cools as it lands; the cat runs its burn front in reverse as soon as the model is
ready. Nothing in the hero can be selected or dragged (`draggable="false"`, `user-select: none`, and
`dragstart` is cancelled page-wide).

Hero ⇄ Works is a page turn, taken at the scroll input before the page moves (`flipDown` / `flipUp`).
Down: a heat front burns the cat away from bottom left to top right (`BURN_TIME` 1.4 s); when it is 75%
gone the section starts coming up, and it is in place as the last of the cat burns away (`TURN_DOWN`,
the last quarter of the burn). The cat then burns back in at the section's corner as the sketch (grey
clay, hatching, lime outline). Up, from the section's top, at twice the pace: the corner cat burns away
(0.7 s), the page carries itself up (0.62 s), the black cat burns back in (0.7 s). Back at the top by any
other road, the cat forms again on its own. The cat's drawing buffer never changes size (resizing
mid-scroll stutters).

**The trail (whole site).** It inverts whatever it crosses; the reel, the cards, the 3D cat, the CD and
the cone sit above it (z > 20) and stay untouched, everything else is under it. In the hero it is the
original trail: the ink covers the page and draws the hero's white marks (the mask: pills, services,
logo, wordmark, globe, scroll hint) inverted inside itself, dragged by the flow, with a drifting band of
palette colour where its edge cuts a letter. Past the hero the same ink is shown in `difference`, so it
inverts whatever lies there (lime → deep blue, black type → white). While the hero's bottom edge is on
screen, main.ts splits the screen there each frame: `#gl` above the edge, an inverting copy (`#gl-dif`,
the same pixels via one 2D `drawImage`) below it, so the trail is continuous across the boundary. (A single
canvas in `difference` over the hero was tried and rejected: it needs the mask to match the page pixel
for pixel, and every small mismatch shows as ghost outlines.) Ink is laid only where a pointer or finger
moves.

Trail: a flat, plain-edged white liquid that evaporates the way buttermax.net's does — measured there
at slow, medium and fast pointer speeds. Ink is eaten away at a steady rate (with a little spatial
variation), so the outline creeps inward from the moment it is laid, thin parts pinch off into beads
and strands, thick cores shrink last; everything is gone ~1 s after the pointer stops. Slow movement
makes one fat blob riding the cursor, medium a tadpole (fat head, tapering tail), fast a long even band
that collapses into strands. Type under the liquid is dragged a little with the flow and slides back.
The colour band at the edge drifts through the palette at `uTime * 0.09` (`passes.ts`). The head keeps up
with the cursor: a frame's movement is stamped every ~7 px (up to 28 stamps, the ink spread so a stroke
carries the same amount), and a light lead is laid toward the browser's predicted pointer position
(`getPredictedEvents`), since the system cursor is drawn a frame or two ahead of the page.

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
| `src/work/cat3d.ts` | the 3D cat (`public/models/cat.glb`, Draco), grey clay + screen-space hatching + lime outline; matte black facing the pointer with travelling heat waves in the hero, the sketch in the Works corner; it burns away / back in behind a heat front (`dissolve`); rests looking 30° left, turns 30° right on hover (`CAT_REST`, `CAT_HOVER` in `work.ts`) |
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

The deck: one gesture, one card. Every wheel or touch gesture passes the page's scroll gate (Lenis'
`virtualScroll` option, set up in main.ts); inside the cards section the deck takes it, so the page never
scrolls there on its own: the gesture moves the deck exactly one card in one eased 1 s glide, and the rest
of that gesture (a trackpad's inertia tail) is ignored. Arriving from the reel lands on the first card;
past the last card, or above the first, the page scrolls freely again. A touch with no distance yet is
never taken, so taps stay taps. The small card at the bottom right shows the main reel (drawn from the
reel itself, so no second video and nothing reloads as the cards change); clicking it takes the page up to
the reel and opens it.

Hold and settle: the first 0.35 screen of scrolling past the section's top moves nothing (`HOLD` in
`work.ts`), so momentum can never nudge the heading out of alignment; when a scroll comes to rest within
that hold the page settles exactly onto the section's top.

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
