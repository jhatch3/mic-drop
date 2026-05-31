import { useEffect, useState } from "react";
import { PAL, FONT, Panel } from "@/ui";

interface SongEntry {
  song_id: string;
  title: string;
  artist: string;
  difficulty: number;
  gamemode?: string;
}

interface Props {
  gamemode: "karaoke" | "dance";
  selectedId: string;
  onSelect: (id: string) => void;
}

const DIFF_LABELS: Record<number, string> = { 1: "★☆☆☆☆", 2: "★★☆☆☆", 3: "★★★☆☆", 4: "★★★★☆", 5: "★★★★★" };

export default function SongPicker({ gamemode, selectedId, onSelect }: Props) {
  const [songs, setSongs] = useState<SongEntry[]>([]);

  useEffect(() => {
    // Always use the static manifest for filtering — it has the gamemode field.
    fetch("/assets/songs/manifest.json")
      .then((r) => r.json())
      .then((data: SongEntry[]) => {
        const filtered = data.filter((s) => !s.gamemode || s.gamemode === gamemode);
        setSongs(filtered);
        if (!selectedId && filtered.length > 0) onSelect(filtered[0].song_id);
      })
      .catch(() => {});
  }, [gamemode]);

  if (songs.length === 0) return null;

  return (
    <Panel
      color={PAL.white}
      title="PICK A SONG"
      titleBg={PAL.ink}
      titleFg={PAL.cyan}
      style={{ width: "100%", maxWidth: 420 }}
    >
      {songs.map((s) => {
        const selected = s.song_id === selectedId;
        return (
          <button
            key={s.song_id}
            onClick={() => onSelect(s.song_id)}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              width: "100%",
              padding: "10px 12px",
              marginBottom: 6,
              background: selected ? PAL.magenta : PAL.cream,
              border: `3px solid ${selected ? PAL.ink : PAL.ink + "44"}`,
              cursor: "pointer",
              fontFamily: FONT.display,
              fontSize: 15,
              letterSpacing: 1,
              color: selected ? PAL.white : PAL.ink,
              textAlign: "left",
              boxShadow: selected ? `3px 3px 0 ${PAL.ink}` : "none",
            }}
          >
            <span>
              <span style={{ fontSize: 17 }}>{s.title}</span>
              <span style={{ fontFamily: FONT.mono, fontSize: 12, opacity: 0.7, marginLeft: 8 }}>
                {s.artist}
              </span>
            </span>
            <span style={{ fontFamily: FONT.mono, fontSize: 11, opacity: 0.8, whiteSpace: "nowrap" }}>
              {DIFF_LABELS[s.difficulty] ?? ""}
            </span>
          </button>
        );
      })}
    </Panel>
  );
}
