# Stream B Tracker — Audio Scoring + Song Prep

Running log of work done on Stream B. Newest entries at the bottom.

## Decisions

- **Pitch engine:** `librosa.pyin` for both offline prep and runtime scoring (per `tasks/stream-B-audio.md`). CLAUDE.md mentions `torchcrepe` + CREPE; the task file wins.
- **Song assets:** committed to the repo under `assets/songs/<song-id>/`.
- **Contour schema:** `contracts/schema/contour.schema.json` is empty (Stream C/D will land it). For now, contours follow the minimal shape from CLAUDE.md — reconcile when the schema lands.
  - Shape: `{ "song_id": str, "hop_ms": int, "frames": [{"t": float, "midi": float|null, "voiced": bool}, ...] }`
  - Invariant: `midi` is `null` iff `voiced` is `false`.
  - Hop: 10 ms (100 fps), segment-relative `t`.
- **Song picks:** deferred. User will choose after the real scoring + prep pipeline is implemented. A synthetic `demo-sweep` fixture unblocks Stream C in the meantime.

## Log

### Step 1 — Ship stub + fake contour (done)

Goal: unblock Stream C (live graph) and Stream D (calls `score_take()` directly) without waiting for real songs.

Files landed:
- `backend/scoring/scorer.py` — stub `score_take(audio_bytes, contour, player_id)`. Loads audio with librosa, returns a duration-derived score in the `Score` shape.
- `backend/scoring/__init__.py` — exports `score_take`.
- `backend/scoring/router.py` — left empty; FastAPI wiring is Step 4.
- `assets/songs/manifest.json` — single entry: `demo-sweep`.
- `assets/songs/demo-sweep/meta.json` — fixture metadata.
- `assets/songs/demo-sweep/contour.json` — synthetic 15 s sweep, 100 fps, 1500 frames. 1 s silent intro, 12 s linear MIDI sweep 60 → 72, 2 s silent outro. 1200 voiced frames.
- `tools/prep/requirements.txt` — `demucs`, `librosa`, `numpy`, `soundfile`, `jsonschema`.

Integration notes for other streams:
- **Stream C** can now `GET /assets/songs/manifest.json`, then load `assets/songs/demo-sweep/contour.json` and render the target line. Silent gaps at the head/tail let them verify that voiced=false frames render as gaps, not zeros.
- **Stream D** can `from backend.scoring import score_take` and pass any decoded audio bytes — the stub will return a valid `Score`-shaped dict. Note `frames_scored` reflects the contour's voiced count, so D's mock match flow will produce sensible numbers.

## To do

- **Step 2** — `tools/prep/prep.py`: trim → demucs → pyin → write `assets/songs/<id>/`. Blocker: pick the 3 songs.
- **Step 3** — replace stub in `scorer.py` with real `librosa.pyin` + ±3-frame alignment + octave-folded cents (`HIT_CENTS=50`).
- **Step 4** — `backend/scoring/router.py`: `POST /api/score` (multipart: `song_id`, `player_id`, `audio`). Loads `assets/songs/<song_id>/contour.json`, calls `score_take`, returns `Score`.
- **Done-when checks**: reference vocal >90, silence <10, octave-shifted vocal still >90.
- **Reconcile** the local contour shape with `contracts/schema/contour.schema.json` once Stream C/D lands it. If anything beyond `song_id`/`hop_ms`/`frames` is required, update `demo-sweep/contour.json` and the prep script.
