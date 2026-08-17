// Tiny persistence abstraction: get/set JSON by key.
// The interface is async so a SQLite-backed implementation (via Tauri)
// can replace the localStorage implementation without touching callers.

export interface KeyValueStorage {
  /** Read and JSON-parse the value stored at `key`. Returns null when absent or unreadable. */
  get<T>(key: string): Promise<T | null>;
  /** JSON-serialize and store `value` at `key`. */
  set<T>(key: string, value: T): Promise<void>;
  /** Delete the value stored at `key` (no-op when absent). */
  remove(key: string): Promise<void>;
}

/** localStorage-backed implementation. Keys are namespaced with `prefix`. */
export function createLocalStorage(prefix = "bots."): KeyValueStorage {
  return {
    async get<T>(key: string): Promise<T | null> {
      try {
        const raw = globalThis.localStorage.getItem(prefix + key);
        if (raw === null) return null;
        return JSON.parse(raw) as T;
      } catch {
        // Corrupt JSON or storage unavailable — treat as missing.
        return null;
      }
    },
    async set<T>(key: string, value: T): Promise<void> {
      globalThis.localStorage.setItem(prefix + key, JSON.stringify(value));
    },
    async remove(key: string): Promise<void> {
      globalThis.localStorage.removeItem(prefix + key);
    },
  };
}

/** In-memory implementation, useful for tests. */
export function createMemoryStorage(): KeyValueStorage {
  const data = new Map<string, string>();
  return {
    async get<T>(key: string): Promise<T | null> {
      const raw = data.get(key);
      if (raw === undefined) return null;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return null;
      }
    },
    async set<T>(key: string, value: T): Promise<void> {
      data.set(key, JSON.stringify(value));
    },
    async remove(key: string): Promise<void> {
      data.delete(key);
    },
  };
}
