# The museum (`#/museum`)

A walkable museum for photos and videos: real-looking rooms you walk through on foot, with each
piece framed on a wall, lit, and labelled. Not XR yet; it runs in any browser (laptop or iPad).

## Walking

- **Laptop:** drag to look, W A S D or the arrow keys to walk (Shift to walk faster), N / P for
  the next and previous piece.
- **Tablet:** drag to look, tap the floor to walk there, tap a picture (or → / ←) to walk up to it.
- A guided walk glides through the doorways and ends facing the piece, with its caption below.

## Stepping into a picture, and the music

Tap the picture you're standing at, or press **Step in** on its label (Enter on a keyboard; from
elsewhere it walks you there first). The visitor goes into the picture, as if the frame were a
window onto a real place: the view leans toward it, then rushes in, the museum smearing into a
radial "warp" blur with the colours parting, light streaking past like stars at speed and a glow
gathering in the middle (`web/src/museum/warp.ts`, `DiveCamera.tsx`, `Streaks.tsx`). On the far
side the picture's own world comes out of the blur (`StepIn.tsx`):
- a piece from a visit opens onto that visit's 3D room, seen from where the phone was at that
  moment, so the picture and the room line up; the person can look around, replay the visit and
  talk about it there;
- any other photo fills the view and drifts slowly; a video plays, its own sound rising gently.

Every photo and video hangs in the museum as an old oil painting, so snapshots look at home in
gilded frames (`web/src/museum/paint.ts`, painted once into a texture by `painter.ts`; a video is
repainted only when it shows a new frame): soft brushwork that keeps edges, brush marks laid along
the picture's contours, rich but deep colour under warm varnish, a canvas weave and darkened
edges. The painting stays on through the dive and the arrival; then it lifts away over a few
seconds, leaving the photo or video exactly as it was taken, while the picture's own sound rises
at the same time (`Painted.tsx`). For a visit, the 3D room takes over once the paint has lifted.

**‹ Museum** (or Escape) runs the same journey backwards: the world smears away into the warp,
and the view pulls back out of the frame to where the visitor stood. The picture becomes a
painting again on the way out.

Quiet music plays while walking: Erik Satie's *Gymnopédie No. 1*, a public domain recording by
Robin Alciatore for Musopen (`web/public/museum/audio/`, credits there). It starts softly on the
first click (browsers allow no sound before one), fades away completely when you step into a
picture (each picture has its own sound), and rises again slowly when you come back. **♪ Music**
turns it off and on (remembered on the device). The sound of going through is made in the
browser once, offline (`web/src/museum/sound.ts`): rushing air climbing with the speed, a deep
rumble, a soft shimmer rising an octave, and the air parting in a sweep at the crossing, in a
wide hall. Stepping out plays it backwards. Nothing rings on at the end.

## The AI guide (voice)

**🗣 Guide** next to the music turns on a voice that tells the person about each memory and
answers what they ask. In the editor, each picture has "+ Tell the AI guide about this memory":
the story behind it (who, where, when, what happened) and a "Never bring up" line. The guide says
only what's written there and the visit's approved facts.

- **At the frame:** a short intro (one or two sentences) when they arrive at a picture.
- **Inside:** the fuller story (three or four sentences) once they've stepped in and the paint has
  lifted.
- **Questions, any time:** the microphone is on while the guide is; they just talk. The guide stops
  the moment they start, and answers about the memory in front of them.
- **The music fades down gradually while it speaks, never to silence,** and rises again after.
- What it says is shown large at the bottom of the screen too.

How it works (contract: `docs/architecture-v3.md` §6.6.1):
- **Cartesia** is the voice and the ears: **Sonic** speaks, streamed as it's generated, a little slower
  than conversation; **Ink-2** listens, and its turn detection says when the person starts (the guide
  stops) and finishes (the guide answers). The browser gets a 10-minute token from Convex; the API
  key never leaves the backend.
- **Moss** is the guide's memory: each memory's notes and approved facts are indexed in one Moss
  index, tagged with the memory, and a question searches only that memory's notes, in milliseconds.
- **Claude** writes the intro and story when the caretaker saves (so they play instantly) and answers
  questions from only what Moss found. Code (`backend/convex/lib/guide.ts`) drops any sentence that
  cites nothing it was given, or touches what the family asked never to bring up.
- **Convex** holds the notes and the written words (reactive, so a saved edit reaches the palace at
  once) and makes every call out with the keys kept server-side.

## Visit together and the Memory Window

On the iPad, **Visit together** shows a code and a link; a helper who opens
`#/museum?join=CODE` on their phone walks the same museum: moving to a picture on either screen
moves the other. Every picture from a visit has a **Memory Window** button (on the helper's phone:
**Open on the iPad**) that opens the visit, head-tracked, on the iPad; **Back to the museum**
returns both. The old hall's address, `#/memories` (and `#/memories?join=CODE`), now opens
`#/museum`.

## Keeping it light on a tablet

The museum draws only when something changes (walking, looking, a dive, a video frame); between
those the candles flicker at 20 frames a second for a minute after the last touch, then the room
rests (`pace.ts`). Still furniture is merged into one mesh per shared material (`materials.ts`,
`merge.ts`), the candle flames are two instanced meshes, and the floor's reflection is redrawn only
when the view moves. Videos load nothing until they play, each file has one `<video>` element,
and only the picture in focus and one neighbour play (`playback.ts`). `bun
web/scripts/measure-museum.ts <url> <out dir>` measures all this at iPad-like settings in headless
Chrome.

## Rooms

One style: a classic picture gallery at a modest scale. Rose-red fabric walls, raised-panel
wainscot, an ivory cornice with gilded brackets, a skylight lantern, a herringbone floor with a
darker parquet border running through the doorways, a Persian medallion rug in every room, and
arched doorways lined in wood. Pictures hang in ornate gilded frames (beads, cove, corner
rosettes), three large ones per side wall above the panelling, in one row, under the even light
of the skylight.

Rooms are added as an exhibition grows (up to 8 pieces per room, joined by doorways). Every
surface is drawn in code (`web/src/museum/textureGen.ts`), once, at build time: `bun
web/scripts/bake-museum-textures.ts` writes them as small WebP images to
`web/public/museum/textures/` (committed; rerun it after changing a generator). No stock images.

## Furnishings

The rooms are furnished like an old picture gallery, none of it pretending to be part
of the family's exhibition: a round tufted velvet settee in the middle of each room with a
pedestal and a red-and-gold porcelain jar rising from it, bronze candle torchères either side of
the fireplace or doorway, brass candle sconces between the pictures, a carved marble fireplace
with a flickering fire and candelabra on the entrance wall, and in the last room a large window
(frosted panes glowing with daylight behind a white sheer that falls to the floor, red velvet
drapes at the sides;
nothing outside is shown) between a pair of covered vases on pedestals. The vases follow
19th-century Sèvres-style covered vases with a deep red ground decorated in gold and mounted in
chased gilt bronze, a mark of luxury in grand French interiors of the Napoleon III period.

Every room has a Persian medallion rug in the manner of Tabriz and Kashan carpets (a fine crimson
herati field, navy corner pieces, a layered medallion with pendants, a palmette-and-rosette
border on a gold vine, a cotton fringe) on the herringbone. Visitors walk around all
of it, and guided walks step round it.

## What hangs in it

The museum is the patient's page, so it changes nothing: no adding or taking down pictures, no
other exhibitions and no link back to the rest of the site. Only music, previous / next, stepping
into a picture, the Memory Window and Visit together.

It shows **Our visits**: what the caretaker set up in the editor (`#/museum/edit`: pictures,
order, titles, captions), or, until they do, an automatic arrangement from the finished
captures: each visit hangs once, as its video (a still if it has none), with the title and date
the family gave it, then stills from the visits fill a second room. Stepping into a visit's
picture opens its 3D room. With no finished visits yet, the page says the museum is being set
up. Only real visits the family filmed: nothing in the museum is invented.
