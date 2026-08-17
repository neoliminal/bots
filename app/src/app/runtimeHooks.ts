// React hooks over the engine's per-bot runtime state feed.

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { botRuntime, type BotRuntimeState } from "../lib/engine";

/** Subscribe to a single bot's runtime state (defaults to "idle"). */
export function useBotRuntimeState(botId: string): BotRuntimeState {
  const subscribe = useCallback(
    (onChange: () => void) => botRuntime.subscribe(botId, onChange),
    [botId],
  );
  const getSnapshot = useCallback(() => botRuntime.getState(botId), [botId]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

const SEP = "\x00";

/** Subscribe to the runtime states of a set of bots (roster view). */
export function useRuntimeStates(
  botIds: readonly string[],
): Record<string, BotRuntimeState> {
  const key = botIds.join(SEP);
  const [states, setStates] = useState<Record<string, BotRuntimeState>>(() => {
    const initial: Record<string, BotRuntimeState> = {};
    for (const id of botIds) initial[id] = botRuntime.getState(id);
    return initial;
  });

  useEffect(() => {
    const ids = key === "" ? [] : key.split(SEP);
    const unsubs = ids.map((id) =>
      botRuntime.subscribe(id, (state) => {
        setStates((prev) => (prev[id] === state ? prev : { ...prev, [id]: state }));
      }),
    );
    return () => {
      for (const unsub of unsubs) unsub();
    };
  }, [key]);

  return states;
}
