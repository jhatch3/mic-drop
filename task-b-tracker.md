# Stream B Tracker — Audio Scoring + Song Prep

Running log of work done on Stream B. Newest entries at the bottom.

## Decisions

- **Pitch engine:** `librosa.pyin` for both offline prep and runtime scoring (per `tasks/stream-B-audio.md`). CLAUDE.md mentions `torchcrepe` + CREPE; the task file wins.
- **Song assets:** committed to the repo under `assets/songs/<song-id>/`.
- **Contour schema:** `contracts/schema/contour.schema.json` is empty (Stream C/D will land it). For now, contours follow the minimal shape from CLAUDE.md — reconcile when the schema lands.
  - Shape: `{ "song_id": str, "hop_ms": int, "frames": [{"t": float, "midi": float|null, "voiced": bool}, ...] }`
  - Invariant: `midi` is `null` iff `voiced` is `false`.
  - Hop: 10 ms (100 fps), segment-relative `t`.
- **Song picks:** MVP ships with **1 song only (Firework)**. More songs added post-MVP. The synthetic `demo-sweep` fixture stays as a dev/test asset.
- **Snowflake & audio (revised):** songs **do** go in Snowflake — user wants a growing library without holding all data locally. Pattern: Snowflake `songs` table (BINARY mp3 + VARIANT contour) is source of truth; backend syncs to `assets/songs/<id>/` on cold start / cache miss; local disk is the serving layer so demo-time gameplay never depends on a Snowflake roundtrip. mp3 must stay under 8 MB (BINARY limit) — fine for ≤3 min instrumentals at 128 kbps. Stream D still owns `matches` / `players` / leaderboard.

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

### Step 3 — Real pyin scorer (done)

Replaced the stub in `backend/scoring/scorer.py` with `librosa.pyin` per the task algorithm:

- 16 kHz mono load, 10 ms hop (160 samples).
- `librosa.pyin` with `fmin=C2`, `fmax=C7`.
- f0 → MIDI; `np.nan` for unvoiced/zero.
- Per voiced target frame: ±3-frame (±30 ms) window, pick singer frame with min |MIDI diff|, octave-fold into `[-6, 6]` semitones (`diff - 12*round(diff/12)`), convert to cents. Hit if `|cents| <= 50`.
- `score = round(100 * hit / scored)`.
- Constants: `HOP_MS=10`, `SR=16000`, `HIT_CENTS=50`, `ALIGN_FRAMES=3`.

Edge-case guard added (not in task pseudocode): skip the frame if all candidates in the alignment window are NaN. The task's `nanargmin` would have raised.

### Step 4 — POST /api/score (done)

`backend/scoring/router.py` exposes `router: APIRouter` with `POST /api/score`:
- multipart form: `song_id` (str), `player_id` (str), `audio` (file).
- 404 if `assets/songs/<song_id>/contour.json` is missing.
- Returns the `Score` dict from `score_take`.

Not wired into a FastAPI app yet — `backend/main.py` is empty and belongs to Stream D. Whoever assembles the app does: `from backend.scoring.router import router; app.include_router(router)`. Also needs `python-multipart` (added to `backend/requirements.txt`).

### Validation (done)

`backend/requirements.txt` pinned: `fastapi`, `uvicorn[standard]`, `python-multipart`, `librosa`, `numpy`, `soundfile`. Anaconda system Python has a numba/NumPy 2.4 incompatibility, so a `.venv/` was created at repo root (gitignored already). Validation script synthesized sine-tone takes matching the demo-sweep contour and ran them through `score_take`:

| case                       | score | hit/scored |
|----------------------------|------:|-----------:|
| perfect                    |   100 |  1200/1200 |
| silence                    |     0 |     0/1200 |
| octave-up (+12 semis)      |   100 |  1200/1200 |
| octave-down (-12 semis)    |   100 |  1200/1200 |
| off-by-1-semitone (100¢)   |     0 |     0/1200 |
| off-by-half-step (50¢)     |    86 |  1028/1200 |

All three task done-when checks pass: ref >90 ✓, silence <10 ✓, octave-shifted >90 ✓. (50¢ boundary lands at 86 — close to the hit threshold, as expected.)

### Step 2 — Real song prep (1 of 3 done: Firework)

`tools/prep/prep.py` shipped. Pipeline:
1. ffmpeg trim → wav (44.1 kHz, stereo)
2. `python -m demucs --two-stems=vocals` → `vocals.wav` + `no_vocals.wav`
3. ffmpeg encode no_vocals → `instrumental.mp3` (libmp3lame, q=2)
4. `librosa.pyin` on vocals @ 16 kHz, 10 ms hop → `contour.json`
5. Write `meta.json` and clean up work dir

Usage:
```
.venv/bin/python tools/prep/prep.py \
  --audio tools/prep/sources/firework.mp3 \
  --start 70 --end 120 \
  --song-id firework --title "Firework" --artist "Katy Perry"
```

Source audio lives in `tools/prep/sources/` (gitignored — copyrighted). Output is committed to `assets/songs/<song-id>/`.

Extra deps needed beyond `requirements.txt`: `torchcodec` (torchaudio's new save backend — added to `tools/prep/requirements.txt`).

**Firework prepped:** segment 70–120s (50 s of chorus 1), 5001 frames, 89% voiced, MIDI range 53.9–93.7 (median 61.5). Added to `assets/songs/manifest.json`.

### Validation against real vocals (done)

Scored three takes against the Firework contour:

| input                                  | score | hit/scored |
|----------------------------------------|------:|-----------:|
| clean vocals (demucs-extracted)        |    99 |  4408/4451 |
| clean vocals, +1 octave (librosa shift)|    90 |  4027/4451 |
| silence                                |     0 |     0/4451 |
| full mix (vox + instrumental)          |    24 |  1085/4451 |

All three done-when checks pass against the clean-vocal input (the right comparison — a singer's mic captures voice, not the mix). The full-mix score of 24 is a useful negative result: **pyin cannot reliably track a vocal melody through an instrumental backing**, which means C/D should *not* try to send the room mix to `/api/score` — only the singer's mic.

### Snowflake songs schema (applied + populated)

- `backend/data/schema/bootstrap.sql` — admin one-time: `MICDROP_WH` warehouse (XS), `MICDROP` db, `PUBLIC` schema, `MICDROP_APP` role, `MICDROP_APP_USER` service account. Run as `ACCOUNTADMIN`.
- `backend/data/schema/songs.sql` — `songs` table (song_id PK, metadata cols, `mp3_bytes BINARY`, `contour_json VARIANT`) + `songs_catalog` view (everything except the blobs, for cheap listing/joins).
- `.env.example` — populated with `SNOWFLAKE_*` placeholders.

Pending user actions:
1. ~~Run `bootstrap.sql` as ACCOUNTADMIN~~ — done.
2. ~~Run `songs.sql`~~ — done (executed programmatically via `snowflake-connector-python` to also validate the connection). Table + view confirmed.
3. ~~Fill `.env`~~ — done.

Added `snowflake-connector-python` + `python-dotenv` to the venv (need to add to `backend/requirements.txt`).

### Snowflake songs store + lazy cache (done)

- `backend/data/snowflake_client.py` — env-driven `connect()` + `cursor()` context manager. Reads `.env` at repo root via `python-dotenv`.
- `backend/data/songs_store.py` — the data layer:
  - `upsert_song(song_id, asset_dir=None)` — MERGE the prepped files into the `songs` table (idempotent; updates `updated_at`).
  - `get_contour(song_id)` / `get_instrumental_path(song_id)` — lazy cache: returns from `assets/songs/<id>/` if present; else SELECTs from Snowflake, writes to disk, returns. Raises `KeyError` for unknown ids.
  - `sync_manifest()` — regenerates `assets/songs/manifest.json` from the `songs_catalog` view (Snowflake is source of truth for what's in the catalog).
  - `__main__` CLI: `python -m backend.data.songs_store [upload <id> | sync-manifest | list]`.
- `tools/prep/prep.py` — `--upload` flag now upserts to Snowflake + regens manifest after prep.
- `backend/scoring/router.py` — uses `get_contour` instead of reading `assets/songs/<id>/contour.json` directly. Returns 404 if Snowflake doesn't know the song.
- 8 MB BINARY cap enforced in `upsert_song` (raises before sending the row, with a "re-encode at lower bitrate" message).

**Firework uploaded and round-trip validated.** Cleared local cache, called `get_contour("firework")`:
- mp3 came back byte-identical (1,214,827 bytes, sha matches)
- contour came back semantically identical (parsed dicts `==`; JSON byte size differs by ~3 KB due to float reformatting in Snowflake VARIANT round-trip — harmless, scoring uses parsed values)

The current `assets/songs/firework/` files are committed as a seed so a fresh clone runs without Snowflake creds. `demo-sweep` stays as a local-only dev fixture (not in Snowflake, not in `manifest.json`).

## To do

- **Reconcile** local contour shape with `contracts/schema/contour.schema.json` once Stream C/D lands it.
- **Hand-off notes for D**:
  - Include `backend.scoring.router.router` in the FastAPI app.
  - Optional: add `/api/songs` that returns the Snowflake `songs_catalog` view (alternative to C reading `manifest.json` statically).
  - `backend/data/snowflake_client.py` is shared infra; matches/players tables can use it.
- **Optional**: tighten the Firework segment cut if 70–120s misses anything we want.
- **Post-MVP**: more songs via `python tools/prep/prep.py ... --upload`.
