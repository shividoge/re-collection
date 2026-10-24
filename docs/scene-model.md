# Scene model v1 (the editor's shared data)

The contract for everything the editor adds on top of a capture: objects, places, readable text, sound events, notes, sites, and enhanced views. The guide server (Shivin) stores and serves it, the web app (Firdavs) reads and writes it through `docs/guide-api.md`, and Claude's extraction fills parts of it. The capture package itself (`docs/capture-format.md`) is never modified.

Status: **[planned]** for all of it. Plan v3 (Sat evening) adds these capabilities to the existing product; the product, audience and framing stay the same (see `CLAUDE.md` Section 1).

## Why this exists

Today an "object" lives only while the family has it selected (the web grows a region from the clicked point and forgets it on deselect), and facts are a flat list tied to times. The editor needs things that persist and that other things can point at: a note on Grandma's armchair, every moment the mango cake is on camera, the clearest frame of a birthday card, the same armchair in next week's visit. This file defines those things once, so the guide, the web and Claude's extraction agree.

## The four kinds of truth (provenance)

Every item below carries a `source`. The UI must always show which one it is.

| `source` | Meaning | Examples | How the UI shows it |
|---|---|---|---|
| `observed` | Sensor data exactly as recorded | room points, video frames, audio, depth, camera poses | Plain. The default look |
| `computed` | Deterministic math on observed data; rerunning gives the same answer | a selection's size, when an object was on camera, a stabilized crop, a perspective-corrected view, alignment between captures | Plain, with a small `computed` tag that opens the recipe |
| `estimated` | A model's output, which can be wrong | transcript words, Claude's object labels, read text and facts, speaker labels, sound events, cleaned-up audio, hole-filled surfaces, photo-to-3D | Dashed or hatched, with an `estimated` tag and its confidence |
| `human` | Written or decided by a person | notes, the family's fact wording, approvals, a corrected label | The author's name and time |

Rules:
- A `computed` item built from an `estimated` input is `estimated`. Provenance only gets weaker as it travels.
- Nothing `estimated` reaches the person with dementia unless a family member approved it as a fact (`CLAUDE.md` 6.3). The editor shows estimates to the family, clearly labeled.
- Areas with no data stay empty. Hole filling and other "make it look solid" passes are `estimated` and must be switchable off ("Measured only").

```ts
type Source = "observed" | "computed" | "estimated" | "human";

/** How something was made. Every entity, appearance, artifact and measurement has one. */
type Provenance = {
  source: Source;
  method: string;                  // "region-grow@1", "claude-objects@1", "deepfilternet3", "icp-yaw@1", "family"
  model?: string;                  // the model that actually answered, e.g. "claude-opus-5-5"
  params?: Record<string, unknown>;
  inputs: SourceRef[];             // what it was made from; "Trace to source" walks these
  confidence?: number;             // 0..1 when the method gives one
  createdAt: string;               // ISO
  createdBy?: string;              // user id for `human`, job id otherwise
};

/** A pointer into original or derived material. */
type SourceRef =
  | { type: "frame"; captureId: string; t: number }                                            // a video frame
  | { type: "region"; captureId: string; t: number; box: [number, number, number, number] }    // normalized x, y, w, h in the stored (landscapeRight) image
  | { type: "audio"; captureId: string; tStart: number; tEnd: number; track?: string }          // track = artifact id; omitted = original audio
  | { type: "transcript"; captureId: string; tStart: number; tEnd: number; quote: string }
  | { type: "points"; captureId: string; voxels: number[]; voxelMeters: number }               // room cloud voxels (computed with the web's voxel index)
  | { type: "artifact"; artifactId: string }
  | { type: "entity"; entityId: string };
```

The existing fact `Evidence` (`frame`, `transcript`) is a subset of `SourceRef`. Facts gain the new kinds without breaking old `moment.json` files.

## Coordinates

- **Capture space:** the capture's ARKit world (`docs/capture-format.md`). Everything tied to one capture uses it.
- **Site space:** a shared frame for all captures of the same place (below). For a site's first capture, site space equals that capture's space. Every other capture gets a `captureToSite` transform.
- ARKit worlds are gravity-aligned (y up), so captures of the same room differ only by a turn around y plus a shift. Alignment solves those 4 degrees of freedom, not 6.

## Sites

A site is a place that gets recorded more than once: "Mom's room at Sunrise", "Priya's kitchen". Captures belong to at most one site.

```ts
type Site = {
  id: string;
  name: string;
  captures: { captureId: string; alignment: Alignment | null }[];   // null = not aligned yet
};

type Alignment = {
  captureToSite: number[];         // 4×4 column-major, same layout as frames.jsonl T
  rmsMeters: number;               // fit error on overlapping room points
  overlap: number;                 // 0..1 share of points with a neighbor within 2 cm
  provenance: Provenance;          // computed (ICP); human when the family placed it by hand
};
```

Alignment with `rmsMeters > 0.03` or `overlap < 0.3` is shown as "rough" and can't drive change detection until a person confirms it.

## Entities (things that persist)

An entity is anything someone may want to select, follow, annotate or search for: an object (the armchair, the cake), a surface (the floor, a wall), a place in the room (by the window), or a person-as-present-in-the-scene (a body, not a face).

```ts
type Entity = {
  id: string;                      // "e_<uuid>"
  siteId: string | null;           // site-level entities recur across captures
  kind: "object" | "surface" | "place" | "person";
  label: string;                   // "armchair", "mango cake"; family edits it (source becomes human)
  labelProvenance: Provenance;
  personName?: string;             // only when the family typed it; never from faces
  geometry: {
    captureId: string;             // the capture whose space this is in
    bounds: { center: [number, number, number]; size: [number, number, number] };   // axis-aligned, meters
    voxels?: number[];             // room cloud voxels, when it came from a selection
    provenance: Provenance;
  }[];                             // one per capture it was found in
  appearances: Appearance[];
  text: ReadText[];                // labels, captions, writing read off it
  factIds: string[];               // approved facts about it (links the editor to the patient layer)
  hidden: boolean;                 // family removed it; kept for provenance, not shown
};

/** When an entity was on camera. */
type Appearance = {
  captureId: string;
  tStart: number;
  tEnd: number;
  bestT: number;                   // the clearest moment in this stretch
  quality: number;                 // 0..1: size on screen × sharpness × facing the camera × depth confidence
  provenance: Provenance;          // computed from poses + geometry; estimated when it came from a 2D detector
};

type ReadText = {
  text: string;
  at: SourceRef;                   // usually a region on the clearest frame
  provenance: Provenance;          // estimated (Claude reading the crop)
};
```

How entities get made:
1. **From a selection** (family clicks in the room): the web's region growing gives voxels and bounds; "Save" turns it into an entity with `source: computed`, label empty until someone names it or Claude suggests one.
2. **From extraction** (Claude, per capture): Claude names objects in keyframes with 2D boxes; the guide lifts each box into 3D with that frame's depth and pose, merges it with a nearby existing entity or creates one, and marks it `estimated`.
3. **Across captures** on an aligned site: entities whose site-space bounds overlap by more than half are proposed as the same thing; a person confirms.

`Appearance` stretches come from projecting the entity's bounds into every moment frame (the web already does this in `visibleIntervals`), so they're `computed`, not guessed.

## Events (things that happened)

```ts
type SceneEvent = {
  id: string;
  captureId: string;
  kind: "speech" | "sound" | "action" | "change";
  label: string;                   // "laughter", "door opens", "Priya hands over the cake", "armchair moved"
  tStart: number;
  tEnd: number;
  speaker?: string;                // diarization label "S1", or a family-typed name
  entityIds: string[];
  hidden: boolean;                 // family removed it; kept for provenance, not shown
  provenance: Provenance;          // estimated, except speech text, which carries the transcript's provenance
};
```

`change` events come from comparing aligned captures: voxels present in one capture and absent in the other, inside regions both captures actually saw. An area only one capture saw is "not compared", never "changed".

## Artifacts (derived media)

Anything the guide or a worker produces from the originals: cleaned-up audio, one speaker's voice, a stabilized clip, a perspective-corrected crop, a best-view still.

```ts
type Artifact = {
  id: string;                      // "a_<uuid>"
  captureId: string;
  kind: "audio_clean" | "audio_speaker" | "still" | "clip" | "rectified" | "mesh";
  file: string;                    // served at /derived/<captureId>/<id>/<file>
  mime: string;
  tStart?: number;
  tEnd?: number;
  provenance: Provenance;          // inputs always point back at original material
};
```

Originals stay available next to every artifact. The UI offers "original / enhanced" side by side and always plays the original by default.

## Measurements

```ts
type Measurement = {
  id: string;
  captureId: string;
  kind: "distance" | "height" | "path";
  points: [number, number, number][];     // capture space
  meters: number;
  uncertaintyMeters: number;               // from depth noise at that range, voxel size and the points' confidence
  needsCheck: boolean;                      // true when uncertainty > 5% of the value or > 3 cm, or any point is low confidence
  provenance: Provenance;                   // computed
};
```

The UI shows `0.81 m ± 0.02` and, when `needsCheck` is set, "check this in person". Measurements are for understanding the room ("is the walker's path to the bathroom clear?"), not for ordering a door.

## Notes (annotations)

```ts
type Note = {
  id: string;
  kind: "note" | "question" | "finding";
  body: string;
  anchor: Anchor;
  author: string;                  // user id
  createdAt: string;
  replies: { author: string; body: string; createdAt: string }[];
  resolved: boolean;
};

/** Where a note, a share link or a search hit points. At least one of entityId, point, time. */
type Anchor = {
  captureId: string;
  entityId?: string;
  point?: [number, number, number];          // capture space
  time?: { t: number } | { tStart: number; tEnd: number };
  view?: ViewState;                           // what the author was looking at
};
```

Notes are family-only. They never reach the person with dementia and are never sent to the companion or narrator. A family member who wants Claude to use something writes it as a fact and approves it.

## Saved views (share links)

```ts
type ViewState = {
  captureId: string;
  t: number;
  mode: "orbit" | "fly" | "follow";
  camera?: { position: [number, number, number]; target: [number, number, number]; fov: number };   // omitted in follow mode
  entityId?: string;               // the selection
  layers: { measuredOnly: boolean; path: boolean; replay: boolean; video: boolean };
  panel?: "inspect" | "transcript" | "notes" | "search" | "compare";
  compareWith?: string;            // second capture id in compare mode
};
```

A saved view gets an id and a link (`#/v/<viewId>`) that opens exactly that context for anyone allowed to see the capture.

## Integrity

- The guide never modifies a capture's files after `complete`. Derived material goes under `data/derived/<captureId>/`.
- The phone writes a SHA-256 for every file into `manifest.json` (`docs/capture-format.md`). The guide checks them on `complete` and records the result in `status.json`. Every exported view or artifact can name the hashes of the originals it came from.

## Where it lives

The guide stores everything in this file in SQLite (`guide/data/braindance.db`, Node's built-in `node:sqlite`), with derived files on disk. Captures, `moment.json` and session files stay as they are. Routes are in `docs/guide-api.md` under "Editor".
