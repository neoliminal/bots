// A BotAvatar bound to the engine's live runtime state feed.

import { BotAvatar } from "../features/avatars";
import { useBotRuntimeState } from "./runtimeHooks";

export interface LiveAvatarProps {
  botId: string;
  color: string;
  name: string;
  size?: number;
  reduceMotion?: boolean;
  /** Idle gaze tracks the cursor (active-conversation avatars only). */
  followCursor?: boolean;
  /** Tracking strength multiplier (see BotAvatarProps.gazeIntensity). */
  gazeIntensity?: number;
}

export function LiveAvatar({
  botId,
  color,
  name,
  size = 32,
  reduceMotion,
  followCursor,
  gazeIntensity,
}: LiveAvatarProps) {
  const state = useBotRuntimeState(botId);
  return (
    <BotAvatar
      color={color}
      state={state}
      size={size}
      reduceMotion={reduceMotion}
      label={name}
      followCursor={followCursor}
      gazeIntensity={gazeIntensity}
    />
  );
}
