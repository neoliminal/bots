import { AVATAR_STATES, STATE_LABELS } from "./types";
import { BotAvatar } from "./BotAvatar";
import { AVATAR_PALETTE } from "./palette";

export interface AvatarGalleryProps {
  /** Avatar size in px for every cell. Default 64. */
  size?: number;
  /** Force reduced-motion rendering for all cells. */
  reduceMotion?: boolean;
}

/** Dev/debug view: one avatar per state, labeled. */
export function AvatarGallery({ size = 64, reduceMotion }: AvatarGalleryProps) {
  return (
    <div className="flex flex-wrap gap-6 p-6">
      {AVATAR_STATES.map((state, i) => (
        <div key={state} className="flex w-24 flex-col items-center gap-2">
          <BotAvatar
            color={AVATAR_PALETTE[i % AVATAR_PALETTE.length]}
            state={state}
            size={size}
            reduceMotion={reduceMotion}
            label={`Bot ${i + 1}`}
            peerAngle={i % 2 === 0 ? 0 : 180}
          />
          <span className="text-center text-xs text-neutral-400">
            {STATE_LABELS[state]}
          </span>
        </div>
      ))}
    </div>
  );
}
