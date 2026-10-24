# The museum (`#/museum`)

A walkable museum for photos and videos: real-looking rooms you walk through on foot, with each
piece framed on a wall, lit, and labelled. Not XR yet; it runs in any browser (laptop or iPad).

## Walking

- **Laptop:** drag to look, W A S D or the arrow keys to walk (Shift to walk faster), N / P for the
  next and previous piece.
- **Tablet:** drag to look, tap the floor to walk there, tap a picture (or → / ←) to walk up to it.
- A guided walk goes through the doorways and ends facing the piece, with its caption below.

## Rooms

Three styles, chosen per exhibition with the buttons at the top (remembered on the device):

| Style | Room | Frames |
|---|---|---|
| Sunlit gallery | pale oak floor, white walls, a skylight | thin black frames, white mats |
| Warm salon | herringbone parquet, plum walls with a dark lower panel, chandelier | gilded frames |
| Grand hall | polished stone, tall walls, beams and high windows | dark wood frames, mats |

Rooms are added as an exhibition grows (6–10 pieces per room, joined by doorways). Every surface
is generated in code (`web/src/museum/textures.ts`), so nothing is downloaded and it works offline.

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

`style` is `gallery`, `salon` or `hall`. Items hang in the order listed. Put the files under
`web/public/museum/` (they're served from `/museum/...`). Only real photos and videos the family
shared: nothing in the museum is invented.
