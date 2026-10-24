# The museum (`#/museum`)

A walkable museum for photos and videos: real-looking rooms you walk through on foot, with each
piece framed on a wall, lit, and labelled. Not XR yet; it runs in any browser (laptop or iPad).

## Walking

- **Calm room:** tap a picture (or → / ←, N / P) and the view glides slowly to it; drag gently
  to look around. No free walking.
- **Other rooms, laptop:** drag to look, W A S D or the arrow keys to walk (Shift to walk faster),
  N / P for the next and previous piece.
- **Other rooms, tablet:** drag to look, tap the floor to walk there, tap a picture (or → / ←) to
  walk up to it.
- A guided walk goes through the doorways and ends facing the piece, with its caption below.

## Rooms

Four styles, chosen per exhibition with the buttons at the top (remembered on the device). The
**Calm room** is the default.

| Style | Room | Frames |
|---|---|---|
| **Calm room** (default) | living-room size, home-height ceiling, plain matte boards, warm light walls, bright even light | dark wood frames, cream mats, 4–6 large pieces per room |
| Sunlit gallery | pale oak floor, white walls, a skylight | thin black frames, white mats |
| Warm salon | herringbone parquet, plum walls with a dark lower panel, chandelier | gilded frames |
| Grand hall | polished stone, tall walls, beams and high windows | dark wood frames, mats |

Rooms are added as an exhibition grows (5–10 pieces per room, joined by doorways). Every surface
is generated in code (`web/src/museum/textures.ts`), so nothing is downloaded and it works offline.

## Why the calm room

It's the room for the person with dementia, built from what design research for dementia
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

`style` is `calm` (the default), `gallery`, `salon` or `hall`. Items hang in the order listed. Put the files under
`web/public/museum/` (they're served from `/museum/...`). Only real photos and videos the family
shared: nothing in the museum is invented.
