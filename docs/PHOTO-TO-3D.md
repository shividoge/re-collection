# Feature brief: 3D spaces from photos that already exist

**Ask (Shivin):** the software should also make 3D renders from existing images, for example the interior of a home from a real-estate listing, not only from a LiDAR phone capture. This page says what is possible, what is not, and how to build the part that is. Nobody has started it.

## What is realistic by Sunday 9 AM

**Possible: an estimated 3D view of each photo.** A monocular depth model guesses a depth for every pixel of one photo. Lifted into 3D with an assumed camera, each photo becomes a coloured point cloud you can orbit, like a pop-up diorama. This runs in the browser, needs no new hardware, and can go through our existing facts, review, narration and revisit pipeline.

**Not realistic: a faithful, measured room from a few listing photos.** Listing photos are wide, few, and barely overlap, so structure-from-motion (COLMAP) or Gaussian splatting usually cannot find a consistent camera for each one. It also needs a GPU server. A full room rebuilt from 4 to 8 photos would be a guess presented as a model, which breaks our rule below. Only attempt it if someone uploads 30 or more overlapping photos of one room, and treat that as a stretch.

## The rule this must not break

**Nothing fake; areas without data stay empty** (`CLAUDE.md`). A LiDAR capture is *measured*. A depth model is *estimated*. So everything made from photos must say so, everywhere:

- `manifest.json` gets `"source": "photos"` and `"depth": { "estimated": true, "model": "<name and version>" }`.
- The viewer and the public site show an **"Estimated from photos, not measured"** badge on these scenes, and they never sit in the same count as measured scans without a label.
- Don't stitch separate photos into one fake room. Show each photo's view separately, in a gallery.

## Photos and permission

Don't scrape listing sites. Zillow and most listing sites forbid it, and the photos belong to the photographer or agent. Use photos Shivin or a teammate took, or has the right to use. Don't put third-party listing photos on the public site.

## Suggested build (a few hours, in this order)

1. **Upload photos.** A drop zone on the family side (`#/captures`) next to the zip drop. Read the photos in the browser; keep EXIF for the field of view if it is there, otherwise assume about 65 degrees horizontal.
2. **Depth in a Web Worker.** A small ONNX model such as Depth Anything V2 Small, run with `@huggingface/transformers` (WebGPU where available, WASM otherwise). Load the model once and cache it. Nothing is uploaded anywhere.
3. **Lift to 3D.** Unproject each pixel with the assumed intrinsics (the same math as `docs/capture-format.md`), colour from the photo, drop pixels at depth edges (flying pixels), and clip the far range. Output the same `room.bin` shape the viewer already reads, one per photo.
4. **Package it as a capture.** Write a capture folder with the photos as `keyframes/`, `room.bin` per view, and the manifest above. The guide's validation needs a small `source: "photos"` branch (no `video`, `frames.jsonl` or `depth.bin`); change `docs/capture-format.md` first.
5. **Facts for free.** Fact extraction already reads keyframes, so photos go through it unchanged (`guide/src/facts.mjs`). The family approves facts as usual and the revisit narration works.
6. **Show it.** Reuse the viewer's orbit and the hole-filling; add the "Estimated" badge. Keep the work off the main thread so the page stays smooth.

## Done when

- Dropping 3 or more of your own photos produces an orbitable 3D view of each within about a minute on a MacBook Air.
- Every photo-based scene is labelled "Estimated from photos" in the family tools and on the public site.
- Facts extract, can be approved, and a revisit narrates them.
- Nothing is uploaded off the machine for the depth step, and no listing-site photos are in the repo.
- Tests for the unprojection and for the manifest validation.

## Honest limits to say in the pitch

Depth from one photo has the right shape but the wrong scale and soft edges. It can't see behind objects or around corners. It is a good way to *show a place*, not to *measure* one.

## Prior reference

Déjà View (Shivin's earlier project) turned photos into 3D spaces. It is a reference for what is possible; per the hackathon rule, write every line fresh and credit it in the Devpost.
