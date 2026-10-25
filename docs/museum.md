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

**‹ Museum** (or Escape) runs the same journey backwards: the world smears away into the warp,
and the view pulls back out of the frame to where the visitor stood.

Quiet music plays while walking: Erik Satie's *Gymnopédie No. 1*, a public domain recording by
Robin Alciatore for Musopen (`web/public/museum/audio/`, credits there). It starts softly on the
first click (browsers allow no sound before one), fades away completely when you step into a
picture (each picture has its own sound), and rises again slowly when you come back. **♪ Music**
turns it off and on (remembered on the device). The sound of going through is made in the
browser once, offline (`web/src/museum/sound.ts`): rushing air climbing with the speed, a deep
rumble, a soft shimmer rising an octave, and the air parting in a sweep at the crossing, in a
wide hall. Stepping out plays it backwards. Nothing rings on at the end.

## Rooms

One style: a classic picture gallery at a modest scale. Rose-red fabric walls, raised-panel
wainscot, an ivory cornice with gilded brackets, a skylight lantern, a herringbone floor with a
darker parquet border running through the doorways, a Persian medallion rug in every room, and
arched doorways lined in wood. Pictures hang in ornate gilded frames (beads, cove, corner
rosettes), three large ones per side wall above the panelling, in one row, under the even light
of the skylight.

Rooms are added as an exhibition grows (up to 8 pieces per room, joined by doorways). Every
surface is generated in code (`web/src/museum/textures.ts`), so nothing is downloaded and it
works offline.

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

## Putting things in an exhibition

1. **Drop** photos or videos anywhere on the museum page (or press "Add photos or videos" on an
   iPad). They hang in the exhibition that's open and stay on that device (IndexedDB). "Take down"
   removes one again.
2. **Our visits** fills itself from the guide: each finished capture hangs as its video, followed
   by two of its keyframes, with the title and date the family gave it. Stepping into any of them
   opens the visit's 3D room at that moment.
3. **Curated exhibitions** come from `web/public/museum/exhibitions.json`:

```json
{
  "exhibitions": [
    {
      "id": "grandma-80",
      "title": "Grandma's 80th",
      "subtitle": "The garden party, June 2024",
      "items": [
        { "kind": "photo", "src": "/museum/grandma-80/cake.jpg", "title": "The mango cake", "date": "June 14, 2024", "caption": "Priya baked it the night before." },
        { "kind": "video", "src": "/museum/grandma-80/song.mp4", "poster": "/museum/grandma-80/song.jpg", "title": "Everyone singing" }
      ]
    }
  ]
}
```

Items hang in the order listed. Put the files under
`web/public/museum/` (they're served from `/museum/...`). Only real photos and videos the family
shared: nothing in the museum is invented.
