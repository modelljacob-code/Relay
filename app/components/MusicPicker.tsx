"use client";

import { MUSIC_OPTIONS, NO_MUSIC_ID } from "@/lib/audioManager";
import { useEffect, useRef } from "react";

type Props = {
  activeId: string;
  muted: boolean;
  onSelect: (id: string) => void;
  onToggleMute: () => void;
  onClose: () => void;
};

export function MusicPicker({
  activeId,
  muted,
  onSelect,
  onToggleMute,
  onClose,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    function handle(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="absolute right-0 top-full z-50 mt-2 w-64 rounded-2xl border border-relay-text/10 bg-relay-card shadow-xl"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-relay-text/8 px-4 py-3">
        <span className="text-xs font-semibold uppercase tracking-widest text-relay-text/50">
          Music
        </span>
        <button
          type="button"
          onClick={onToggleMute}
          className="rounded-lg px-2 py-1 text-xs text-relay-text/50 transition hover:bg-relay-bg hover:text-relay-text/80"
        >
          {muted ? "🔇 Unmute" : "🔊 Mute"}
        </button>
      </div>

      {/* Track list */}
      <ul className="p-2">
        {MUSIC_OPTIONS.map((opt) => {
          const isActive = activeId === opt.id;
          return (
            <li key={opt.id}>
              <button
                type="button"
                onClick={() => onSelect(opt.id)}
                className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-all ${
                  isActive
                    ? "bg-relay-live/12 text-relay-text"
                    : "text-relay-text/60 hover:bg-relay-text/5 hover:text-relay-text/90"
                }`}
              >
                <span className="text-xl leading-none">{opt.emoji}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium leading-none">
                    {opt.label}
                  </p>
                  <p className="mt-0.5 text-xs text-relay-text/40 truncate">
                    {opt.description}
                  </p>
                </div>
                {isActive && !muted && (
                  <span className="flex h-4 items-end gap-0.5">
                    {[0, 1, 2].map((i) => (
                      <span
                        key={i}
                        className="w-0.5 rounded-full bg-relay-live"
                        style={{
                          height: `${6 + i * 4}px`,
                          animation: `musicBar ${0.6 + i * 0.15}s ease-in-out infinite alternate`,
                        }}
                      />
                    ))}
                  </span>
                )}
              </button>
            </li>
          );
        })}

        {/* No music option */}
        <li>
          <button
            type="button"
            onClick={() => onSelect(NO_MUSIC_ID)}
            className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-all ${
              activeId === NO_MUSIC_ID
                ? "bg-relay-text/8 text-relay-text/70"
                : "text-relay-text/35 hover:bg-relay-text/5 hover:text-relay-text/60"
            }`}
          >
            <span className="text-xl leading-none">🔇</span>
            <div className="flex-1">
              <p className="text-sm font-medium leading-none">No music</p>
              <p className="mt-0.5 text-xs text-relay-text/30">Just silence</p>
            </div>
          </button>
        </li>
      </ul>


      <style>{`
        @keyframes musicBar {
          from { transform: scaleY(0.4); }
          to   { transform: scaleY(1); }
        }
      `}</style>
    </div>
  );
}
