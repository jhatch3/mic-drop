#!/usr/bin/env python3
"""Offline song prep: trim -> demucs split -> instrumental.mp3 + pyin contour.json.

Usage:
  python prep.py --audio sources/firework.mp3 --start 70 --end 120 \
                 --song-id firework --title "Firework" --artist "Katy Perry"
"""
import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

import librosa
import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[2]
ASSETS_ROOT = REPO_ROOT / "assets" / "songs"
SCHEMA_PATH = REPO_ROOT / "contracts" / "schema" / "contour.schema.json"

HOP_MS = 10
SR = 16000


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--audio", required=True, type=Path)
    p.add_argument("--start", required=True, type=float)
    p.add_argument("--end", required=True, type=float)
    p.add_argument("--song-id", required=True)
    p.add_argument("--title")
    p.add_argument("--artist")
    p.add_argument("--difficulty", type=int, default=3)
    p.add_argument("--upload", action="store_true",
                   help="upsert into Snowflake songs table after prep")
    return p.parse_args()


def trim(src: Path, start: float, end: float, dst: Path) -> None:
    subprocess.run(
        ["ffmpeg", "-y", "-i", str(src), "-ss", str(start), "-to", str(end),
         "-ac", "2", "-ar", "44100", str(dst)],
        check=True, capture_output=True,
    )


def run_demucs(trimmed_wav: Path, out_dir: Path) -> tuple[Path, Path]:
    subprocess.run(
        [sys.executable, "-m", "demucs", "--two-stems=vocals",
         "-o", str(out_dir), str(trimmed_wav)],
        check=True,
    )
    vocals_candidates = list(out_dir.rglob("vocals.wav"))
    if not vocals_candidates:
        raise RuntimeError("demucs produced no vocals.wav")
    vocals = vocals_candidates[0]
    return vocals, vocals.with_name("no_vocals.wav")


def encode_mp3(src_wav: Path, dst_mp3: Path) -> None:
    subprocess.run(
        ["ffmpeg", "-y", "-i", str(src_wav),
         "-codec:a", "libmp3lame", "-q:a", "2", str(dst_mp3)],
        check=True, capture_output=True,
    )


def compute_contour(vocals_wav: Path, song_id: str) -> dict:
    y, sr = librosa.load(str(vocals_wav), sr=SR, mono=True)
    hop = int(sr * HOP_MS / 1000)
    f0, voiced_flag, _ = librosa.pyin(
        y, fmin=librosa.note_to_hz("C2"), fmax=librosa.note_to_hz("C7"),
        sr=sr, hop_length=hop,
    )
    times = librosa.frames_to_time(np.arange(len(f0)), sr=sr, hop_length=hop)
    frames = []
    for t, f, vf in zip(times, f0, voiced_flag):
        if vf and not np.isnan(f) and f > 0:
            midi = float(69 + 12 * np.log2(f / 440))
            frames.append({"t": round(float(t), 3), "midi": round(midi, 3), "voiced": True})
        else:
            frames.append({"t": round(float(t), 3), "midi": None, "voiced": False})
    return {"song_id": song_id, "hop_ms": HOP_MS, "frames": frames}


def maybe_validate(contour: dict) -> None:
    if not SCHEMA_PATH.is_file() or SCHEMA_PATH.stat().st_size == 0:
        print(f"  (schema empty at {SCHEMA_PATH.relative_to(REPO_ROOT)} — skipping)")
        return
    try:
        import jsonschema
    except ImportError:
        print("  (jsonschema not installed — skipping)")
        return
    schema = json.loads(SCHEMA_PATH.read_text())
    jsonschema.validate(contour, schema)
    print("  contour passes JSON schema")


def main():
    args = parse_args()
    out_dir = ASSETS_ROOT / args.song_id
    out_dir.mkdir(parents=True, exist_ok=True)
    workdir = out_dir / "_work"
    workdir.mkdir(exist_ok=True)

    trimmed = workdir / "trimmed.wav"
    print(f"[1/5] trim {args.audio.name} {args.start}-{args.end}s")
    trim(args.audio, args.start, args.end, trimmed)

    print("[2/5] demucs split (CPU, ~1-2 min on first run; downloads model)")
    vocals, no_vocals = run_demucs(trimmed, workdir)

    print("[3/5] encode instrumental.mp3")
    encode_mp3(no_vocals, out_dir / "instrumental.mp3")

    print("[4/5] pyin -> contour.json")
    contour = compute_contour(vocals, args.song_id)
    n = len(contour["frames"])
    voiced = sum(1 for fr in contour["frames"] if fr["voiced"])
    print(f"  {n} frames, {voiced} voiced ({100 * voiced / n:.0f}%)")
    maybe_validate(contour)
    (out_dir / "contour.json").write_text(json.dumps(contour, separators=(",", ":")))

    print("[5/5] meta.json")
    meta = {
        "song_id": args.song_id,
        "title": args.title or args.song_id,
        "artist": args.artist or "unknown",
        "difficulty": args.difficulty,
        "duration_sec": round(args.end - args.start, 2),
        "segment_start_sec": args.start,
        "segment_end_sec": args.end,
    }
    (out_dir / "meta.json").write_text(json.dumps(meta, indent=2))

    shutil.rmtree(workdir)
    print(f"done -> {out_dir.relative_to(REPO_ROOT)}")

    if args.upload:
        sys.path.insert(0, str(REPO_ROOT))
        from backend.data.songs_store import sync_manifest, upsert_song
        upsert_song(args.song_id, out_dir)
        sync_manifest()


if __name__ == "__main__":
    main()
