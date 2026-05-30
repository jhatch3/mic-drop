# Speech Agent — Audio Ingestion, Pitch Extraction & Speech-to-Text

How Pitch Battle turns raw captured singing into **pure data**: a per-frame pitch contour
(f0 → MIDI) for scoring, plus a word-level transcript used for captions and (lenient)
lyrics scoring. **All processing is server-side (Python / FastAPI).** The browser only
records and uploads — there is no live client-side graph in this design.

> Related: this is the implementation detail behind the spec's `/api/score`
> (`docs /pitch-battle-mvp-spec (1).md`, §3.1–3.4, §6). Pitch + timing stay the
> **deterministic money score**; transcript and lyrics are additive, non-authoritative.

---

## Pipeline at a glance

```
upload (webm/opus | wav)
        │
        ▼
  decode + resample  ──▶  mono float32 @ 16 kHz  (ffmpeg + soundfile)
        │
        ├──────────────▶  PITCH:  torchcrepe → f0(Hz)+conf → MIDI contour → align/score
        │                         (10 ms hop, octave-folded cents, |cents| ≤ 50 = hit)
        │
        └──────────────▶  STT:    faster-whisper → words + timestamps
                                  ├─ transcript / captions
                                  └─ lyrics score (fuzzy-align vs reference lyrics)
        │
        ▼
  merge ─▶ Score JSON { pitch, timing, lyrics, transcript, words, ... }
```

Pitch and STT are independent over the same decoded audio — run them concurrently
(`asyncio.gather` / threadpool).

---

## 1. Ingest the sound (decode → numpy)

The browser's `MediaRecorder` typically emits **`webm/opus`** (sometimes `wav`). The backend
needs it as a **mono float32 array at a fixed sample rate**. Use **16 kHz** — enough for vocal
pitch and STT, and it matches the scoring grid.

- **Decode reliably:** shell out to **ffmpeg** (handles opus/webm/mp3/m4a where pure-Python
  readers fail), then read PCM with **`soundfile`**. `librosa.load()` also works (uses
  soundfile + audioread/ffmpeg fallback), but explicit ffmpeg is the most predictable for opus.

```python
import io, subprocess, soundfile as sf, numpy as np

def load_audio(path: str, sr: int = 16000) -> np.ndarray:
    """Decode any container → mono float32 @ sr."""
    wav = subprocess.run(
        ["ffmpeg", "-i", path, "-ac", "1", "-ar", str(sr), "-f", "wav", "pipe:1"],
        capture_output=True, check=True,
    ).stdout
    audio, _ = sf.read(io.BytesIO(wav), dtype="float32")
    return audio  # shape (n_samples,)
```

**Picks:** `ffmpeg` (system binary or the `imageio-ffmpeg` wheel) + `soundfile`.
`pydub` is a convenience wrapper if preferred (still needs ffmpeg).

**Gotchas:** opus *requires* ffmpeg; always force mono + a fixed `sr` so frame timestamps
line up with the reference contour.

---

## 2. Pitch — the "pure data" (f0 → MIDI contour)

Pitch as data = the **fundamental frequency f0 (Hz) per short frame** plus a **voicing
confidence**, on a fixed hop. The spec uses **10 ms hop (100 fps)**. Convert each f0 to a
**MIDI note number (float)** — the project's canonical pitch unit:

```
midi = 69 + 12 * log2(f0_hz / 440)
```

### Library picks (monophonic singing)

| Library | Method | Singing accuracy | GPU | Output |
|---|---|---|---|---|
| **`torchcrepe`** ✅ primary | CREPE neural tracker (PyTorch) | Excellent, few octave errors | optional (CPU works, slower) | f0 Hz + periodicity (confidence) |
| **`librosa.pyin`** ✅ no-GPU fallback | probabilistic YIN | Good | none | f0, voiced_flag, voiced_prob |
| `praat-parselmouth` | Praat autocorrelation | Good, robust | none | f0 track |
| `crepe` (TensorFlow) | original CREPE | Excellent | needs TF | f0 + confidence |
| `basic_pitch` (Spotify) | polyphonic note transcription | overkill (notes, not a contour) | optional | MIDI notes |

**Recommendation:** **`torchcrepe`** for the authoritative score (best accuracy, fewest
octave errors), with **`librosa.pyin`** as a zero-GPU fallback so the pipeline runs anywhere.

```python
import torch, torchcrepe, numpy as np

def pitch_contour(audio: np.ndarray, sr: int = 16000, hop_ms: int = 10):
    hop = int(sr * hop_ms / 1000)                       # 160 samples @16k = 10 ms
    x = torch.tensor(audio).unsqueeze(0)
    f0, conf = torchcrepe.predict(                       # f0 in Hz, conf 0..1
        x, sr, hop_length=hop, model="full",
        fmin=50, fmax=1100, return_periodicity=True, batch_size=512,
    )
    f0, conf = f0[0].numpy(), conf[0].numpy()
    midi = 69 + 12 * np.log2(np.where(f0 > 0, f0, np.nan) / 440)
    voiced = conf >= 0.5                                 # low confidence → unvoiced
    return [
        {"t": round(i * hop_ms / 1000, 3),
         "midi": float(m) if v else None, "voiced": bool(v)}
        for i, (m, v) in enumerate(zip(midi, voiced))
    ]                                                    # matches contour.json (spec §3.2)
```

`librosa.pyin` fallback:

```python
f0, voiced, vprob = librosa.pyin(audio, sr=sr, fmin=65, fmax=1100,
                                 frame_length=2048, hop_length=hop)
```

**This contour IS the pure data.** Scoring aligns the singer's voiced frames to the reference
contour and counts hits via **octave-folded cents error**:

```
diff   = singer_midi - target_midi
folded = diff - 12 * round(diff / 12)      # → [-6, 6] semitones
cents  = folded * 100                       # hit when |cents| <= 50
score  = 100 * frames_hit / frames_scored   # frames_scored = voiced target frames
```

No LLM, reproducible — exactly the spec's `/api/score`.

**Gotchas:** octave errors (CREPE ≫ autocorrelation — the main reason to prefer it); keep the
**same hop + sr** as the reference contour or timing drifts; threshold confidence so
silence/breaths never count as hits; the ±3-frame (±30 ms) alignment window absorbs
human/system latency — don't tighten it.

---

## 3. Speech-to-text (transcript + lyrics scoring)

One STT call feeds **both** outputs — consume it two ways.

> ⚠️ **STT on *singing* is genuinely hard.** Sustained vowels, melisma, and bleed from the
> backing track wreck word accuracy far more than on speech. Treat lyrics scoring as
> **forgiving and approximate**, and lean on **word-level timestamps** to align against the
> *known* reference lyrics rather than trusting raw transcription.

### Options

| Option | Where | Word timestamps | Singing notes | Fit |
|---|---|---|---|---|
| **`faster-whisper`** ✅ primary | local (CTranslate2) | yes (`word_timestamps=True`) | best open option; still imperfect on singing | no external account, easy in FastAPI |
| `whisper.cpp` | local CPU | yes | same model, CPU-friendly | tiny footprint |
| **Gemini** (multimodal audio) | cloud | approximate | decent; already a sponsor track | leans on Gemini |
| **ElevenLabs Scribe** | cloud | yes | dedicated STT w/ timestamps | leans on ElevenLabs track |
| Deepgram / AssemblyAI | cloud | yes (excellent) | strong, real-time capable | best raw quality, external |

**Recommendation:** **`faster-whisper`** by default (local, word timestamps, no extra
account). Keep it behind an interface so Gemini / ElevenLabs Scribe are drop-in swaps —
mirror the spec's `ESCROW_MODE` pattern with e.g. `STT_PROVIDER=whisper|gemini|elevenlabs`.

```python
from faster_whisper import WhisperModel
model = WhisperModel("small", device="cpu", compute_type="int8")   # or "cuda"/"float16"

def transcribe(path: str):
    segments, _ = model.transcribe(path, word_timestamps=True)
    words, text = [], []
    for seg in segments:
        text.append(seg.text)
        for w in seg.words:
            words.append({"word": w.word.strip(), "start": w.start, "end": w.end})
    return {"transcript": " ".join(text).strip(), "words": words}
```

### Using it two ways

**(a) Transcript / captions** — return `transcript` (+ `words` for karaoke-style highlighting).

**(b) Lyrics score** — compare recognized words to the song's **reference lyrics** (already a
field in the spec's `songs` metadata). Don't expect exact matches — normalize + fuzzy-align:

1. Lowercase, strip punctuation, collapse whitespace on both sides.
2. Token-align recognized vs reference — `rapidfuzz` (`token_sort_ratio`/`Levenshtein`) or
   stdlib `difflib.SequenceMatcher`.
3. `lyrics_score = 100 * matched / reference_tokens` (a WER-style coverage metric).

Keep it lenient — a fun bonus signal, **never** the money score.

```python
from rapidfuzz import fuzz
def lyrics_score(recognized: str, reference: str) -> float:
    norm = lambda s: " ".join(s.lower().split())
    return float(fuzz.token_sort_ratio(norm(recognized), norm(reference)))  # 0..100
```

---

## 4. Where this lives in the repo

- **`backend/scoring/`** — `load_audio()` + `pitch_contour()` + the existing align/score step
  → the authoritative pitch/timing `Score`.
- **`backend/transcription/`** (new; or fold into `backend/ai`) — `transcribe()` +
  `lyrics_score()` behind a `STT_PROVIDER` interface (whisper / gemini / elevenlabs).
- **Contracts (`/contracts`)** — the scorer JSON already has a `lyrics` field; extend the
  `Score` type with `lyrics` (0–100 or `null`) and optional `transcript` / `words`. Change
  contracts there first, then dependents.
- **Concurrency** — run pitch and STT together; merge into one response.

### Suggested dependencies

`numpy`, `soundfile`, `ffmpeg` (binary or `imageio-ffmpeg`), `torch` + `torchcrepe`,
`librosa` (fallback pitch + utils), `faster-whisper`, `rapidfuzz`.

---

## 5. Verification

1. **Decode:** a `.webm` and a `.wav` of the same take yield same-length mono 16 kHz arrays.
2. **Pitch sanity:** clean reference vocal scores **>90**; **silence ~0**; the same vocal
   shifted an **octave still >90** (octave-fold works). A sine sweep returns the expected
   MIDI ramp.
3. **STT:** a spoken clip transcribes near-verbatim; a sung clip shows degraded-but-aligned
   words with timestamps; `lyrics_score` is high for correct words, low for gibberish.
4. **End-to-end:** one upload returns `{ pitch, timing, lyrics, transcript, words }`, with
   pitch + timing **reproducible** across repeated runs (same input → same number).