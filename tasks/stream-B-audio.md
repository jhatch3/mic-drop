# Stream B — Audio Scoring + Song Prep

**You own:** `backend/scoring/`, `assets/songs/`, `tools/prep/`

---

## Your files
```
backend/scoring/
  scorer.py   ← librosa.pyin scoring logic
  router.py   ← POST /api/score endpoint
assets/songs/
  manifest.json
  <song-id>/
    instrumental.mp3
    contour.json
    meta.json
tools/prep/
  prep.py           ← offline demucs + pyin script
  requirements.txt
```

---

## Step 1 — Ship first (unblocks everyone)
In `backend/scoring/scorer.py`, add the dev stub:

```python
def score_take(audio_bytes, contour, player_id):
    # stub — replace with pyin later
    import librosa, io
    y, sr = librosa.load(io.BytesIO(audio_bytes), sr=16000, mono=True)
    duration = len(y) / sr
    score = min(100, max(0, int(50 + duration % 50)))
    voiced = [f for f in contour["frames"] if f["voiced"]]
    frames_scored = len(voiced)
    frames_hit = int(score * frames_scored / 100)
    return {"song_id": contour["song_id"], "player_id": player_id,
            "score": score, "frames_scored": frames_scored, "frames_hit": frames_hit}
```

Also create one **fake `contour.json`** for any song (even a sine sweep) so C can render the graph immediately. Follow the schema in `contracts/schema/contour.schema.json`.

## Step 2 — Pick 3 songs and start prep (longest lead time — do this ASAP)
```
tools/prep/requirements.txt:
  demucs
  librosa
  numpy
  soundfile
  jsonschema
```

```bash
# For each song:
python prep.py --audio song.mp3 --start 41 --end 122 --song-id blinding-lights
```

Prep script (`prep.py`) does:
1. Trim audio to segment
2. `demucs` → vocals.wav + no_vocals.wav → encode to instrumental.mp3
3. `librosa.pyin` on vocals.wav at 10ms hop → contour.json
4. Validate contour against the JSON schema
5. Write `assets/songs/<song-id>/`

**Songs must be ready by Hour 6** or C⇄B integration is blocked.

## Step 3 — Real scoring (replace the stub)
In `scorer.py`, swap the stub with real `librosa.pyin`:

```python
import librosa, numpy as np, io

HOP_MS = 10
HIT_CENTS = 50
ALIGN_FRAMES = 3

def score_take(audio_bytes, contour, player_id):
    y, sr = librosa.load(io.BytesIO(audio_bytes), sr=16000, mono=True)
    hop = int(sr * HOP_MS / 1000)
    f0, _, _ = librosa.pyin(y, fmin=librosa.note_to_hz('C2'),
                             fmax=librosa.note_to_hz('C7'), sr=sr, hop_length=hop)
    times = librosa.frames_to_time(np.arange(len(f0)), sr=sr, hop_length=hop)
    midi = 69 + 12 * np.log2(np.where(f0 > 0, f0, np.nan) / 440)

    voiced = [f for f in contour["frames"] if f["voiced"] and f["midi"] is not None]
    frames_hit = 0
    for vf in voiced:
        window = np.where(np.abs(times - vf["t"]) <= ALIGN_FRAMES * HOP_MS / 1000)[0]
        if not len(window): continue
        best = window[np.nanargmin(np.abs(midi[window] - vf["midi"]))]
        if np.isnan(midi[best]): continue
        diff = midi[best] - vf["midi"]
        cents = (diff - 12 * round(diff / 12)) * 100   # octave fold
        if abs(cents) <= HIT_CENTS:
            frames_hit += 1

    n = len(voiced)
    return {"song_id": contour["song_id"], "player_id": player_id,
            "score": round(100 * frames_hit / n) if n else 0,
            "frames_scored": n, "frames_hit": frames_hit}
```

## Step 4 — Wire the endpoint (`router.py`)
```python
# POST /api/score
# multipart: song_id (str), player_id (str), audio (file — WebM/Opus)
```
Load `assets/songs/<song_id>/contour.json`, call `score_take`, return the Score object.

## Done-when
```
✓ near-perfect reference vocal scores > 90
✓ silence scores < 10
✓ same vocal shifted an octave still scores > 90  (octave fold working)
```

## Manifest format
```json
[
  { "song_id": "blinding-lights", "title": "Blinding Lights", "artist": "The Weeknd", "difficulty": 3 },
  ...
]
```

## Integration points
- **→ C**: they GET `/assets/songs/manifest.json` and load contour.json for the graph
- **→ D**: they call `score_take()` directly (or via `/api/score`) from `finish.py`
