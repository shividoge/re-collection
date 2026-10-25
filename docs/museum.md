# The museum (`#/museum`)

A walkable museum for photos and videos: real-looking rooms you walk through on foot, with each
piece framed on a wall, lit, and labelled. Not XR yet; it runs in any browser (laptop or iPad).

## Walking

- **Calm room:** tap a picture (or → / ←, N / P) and the view glides slowly to it; drag gently to
  look around. No free walking.
- **Other rooms (Classic gallery included), laptop:** drag to look, W A S D or the arrow keys to walk (Shift to walk faster),
  N / P for the next and previous piece.
- **Other rooms, tablet:** drag to look, tap the floor to walk there, tap a picture (or → / ←) to
  walk up to it.
- A guided walk goes through the doorways and ends facing the piece, with its caption below.

## Rooms

Five styles, chosen per exhibition with the buttons at the top (remembered on the device). The
**Classic gallery** is the default.

| Style | Room | Frames |
|---|---|---|
| **Classic gallery** (default) | a classic picture gallery at a modest scale: rose-red fabric walls, raised-panel wainscot, ivory cornice with gilded brackets, a skylight lantern, herringbone floor with a darker parquet border running through the doorways, a red Persian-style rug in every other room (bare floor in the others, to compare), arched doorways lined in wood; a round tufted settee with a red-and-gold porcelain jar in each room, candle torchères either side of the fireplace or doorway, candle sconces between pictures, a marble fireplace on the entrance wall, a large window behind a white sheer with red velvet drapes on the last room's far wall, red-and-gold covered vases on pedestals | ornate gilded frames (beads, cove, corner rosettes), three large pictures per side wall above the panelling |
| **Calm room** (default) | living-room size, home-height ceiling, plain matte boards, warm light walls, bright even light | dark wood frames, cream mats, 4–6 large pieces per room |
| Sunlit gallery | pale oak floor, white walls, a skylight | thin black frames, white mats |
| Warm salon | herringbone parquet, plum walls with a dark lower panel, chandelier | gilded frames |
| Grand hall | polished stone, tall walls, beams and high windows | dark wood frames, mats |

Rooms are added as an exhibition grows (5–10 pieces per room, joined by doorways). Every surface
is generated in code (`web/src/museum/textures.ts`), so nothing is downloaded and it works offline.

## Why the calm room (and the classic gallery)

The classic gallery is the family's choice of look: warmer and more traditional, walkable, with
furniture and a lightly reflective herringbone floor under the rug. It keeps the even skylight
and one row of pictures. When the calm-room rules matter more (a matte plain floor, guided
movement only), switch the exhibition to the Calm room.

The calm room is the plainest room for the person with dementia, built from what design research for dementia
recommends. Most of this is expert consensus rather than trial evidence, and none of it was
tested in a virtual museum, so treat it as the best available guess:

- **Small and homelike, not grand.** Reviews of care settings link small, familiar, homelike
  spaces with more engagement and less agitation (Marquardt, Bueter & Motzek 2014, HERD 8(3);
  Bowes & Dawson 2019). The grand hall is the opposite.
- **A plain, matte floor.** Design guidance warns that shiny floors can look wet and busy
  patterns can look like steps or holes, so: wide plain boards, no reflections, no herringbone.
- **Bright, even light, no glare and no dark corners.** Older eyes are more sensitive to glare,
  and light shows promise for mood and orientation (Goudriaan et al. 2021, systematic review of
  37 studies). So: a broad soft ceiling light, a faintly glowing ceiling, no vignette.
- **Few, large pictures with clear contrast.** Museum programmes that worked for people with
  dementia (Meet Me at MoMA; Camic et al. 2014) look at a few works, slowly, with someone
  talking about them. Dark frames on a light warm wall make each picture easy to find.
- **No self-steered movement.** Only slow, guided glides to a picture (tap it, or the arrows);
  no walking keys, no tapping the floor, and a gentler drag to look. VR studies with people with
  dementia that went well used passive viewing; continuous self-steered movement is what makes
  people dizzy, and teleporting costs orientation (Clifton & Palmisano).

## Furnishings

The classic gallery is furnished like an old picture gallery, none of it pretending to be part
of the family's exhibition: a round tufted velvet settee in the middle of each room with a
pedestal and a red-and-gold porcelain jar rising from it, bronze candle torchères either side of
the fireplace or doorway, brass candle sconces between the pictures, a carved marble fireplace
with a flickering fire and candelabra on the entrance wall, and in the last room a large window
(frosted panes glowing with daylight behind a white sheer, red velvet drapes at the sides;
nothing outside is shown) between a pair of covered vases on pedestals. The vases follow
19th-century Sèvres-style covered vases with a deep red ground decorated in gold and mounted in
chased gilt bronze, a mark of luxury in grand French interiors of the Napoleon III period.

Rugs alternate: the first room shows the bare herringbone, the next a red Persian-style rug
(medallion, corner pieces, rosette border), so the two looks can be compared. Visitors walk around all
of it, and guided walks step round it.

## Putting things in an exhibition

1. **Drop** photos or videos anywhere on the museum page (or press "Add photos or videos" on an
   iPad). They hang in the exhibition that's open and stay on that device (IndexedDB). "Take down"
   removes one again.
2. **Our visits** fills itself from the guide: each finished capture hangs as its video, followed
   by two of its keyframes, with the title and date the family gave it, and a link to step into
   the visit in 3D.
3. **Curated exhibitions** come from `web/public/museum/exhibitions.json`:

```json
{
  "exhibitions": [
    {
      "id": "grandma-80",
      "title": "Grandma's 80th",
      "subtitle": "The garden party, June 2024",
      "style": "salon",
      "items": [
        { "kind": "photo", "src": "/museum/grandma-80/cake.jpg", "title": "The mango cake", "date": "June 14, 2024", "caption": "Priya baked it the night before." },
        { "kind": "video", "src": "/museum/grandma-80/song.mp4", "poster": "/museum/grandma-80/song.jpg", "title": "Everyone singing" }
      ]
    }
  ]
}
```

`style` is `classic` (the default), `calm`, `gallery`, `salon` or `hall`. Items hang in the order listed. Put the files under
`web/public/museum/` (they're served from `/museum/...`). Only real photos and videos the family
shared: nothing in the museum is invented.
