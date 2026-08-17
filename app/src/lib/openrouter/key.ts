// Dev API key resolution.
//
// Security invariants (openspec/project.md):
// - The key value is held only in module memory; it is NEVER logged and NEVER
//   persisted from JS (no localStorage/SQLite/etc.).
// - In a DEVELOPMENT Tauri build the key comes from the Rust host via the
//   `get_dev_api_key` command; in tests/browser dev it falls back to
//   VITE_OPENROUTER_API_KEY. That command is compiled out of release builds
//   (it would let any renderer flaw read keys/.env), so a packaged build has
//   no key source until a settings-entry path exists.

let cachedKey: string | null = null;

function isTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
  );
}

/**
 * Dev/test-only env lookup for VITE_OPENROUTER_API_KEY. Pure — the caller
 * supplies the env object — and uses a computed property name so Vite's
 * build-time define step (which only string-replaces static
 * `import.meta.env.VITE_*` dot access) can never inline the key's value.
 * Exported for tests.
 */
export function readDevEnvKey(env: Record<string, unknown>): string | undefined {
  if (!env["DEV"]) return undefined;
  const name = ["VITE", "OPENROUTER", "API", "KEY"].join("_");
  const value = env[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Resolve the dev/test fallback key. `import.meta.env.DEV` folds to `false`
 * in `vite build`, so this whole branch — including the module's only
 * reference to the env object Vite would otherwise inline — is eliminated
 * from production bundles. No key value can ship in dist/ (verified by
 * building with a sentinel key and grepping the output).
 */
function envFallbackKey(): string | undefined {
  if (import.meta.env.DEV) {
    return readDevEnvKey(import.meta.env as unknown as Record<string, unknown>);
  }
  return undefined;
}

/** Resolve the OpenRouter API key. Do not log or persist the returned value. */
export async function getKey(): Promise<string> {
  if (cachedKey !== null) return cachedKey;

  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    try {
      cachedKey = await invoke<string>("get_dev_api_key");
      return cachedKey;
    } catch (err) {
      // `get_dev_api_key` is compiled out of RELEASE builds on purpose: a
      // shipped app must never carry a command that hands the developer's
      // keys/.env to the webview, where any renderer flaw could call it.
      // Development builds still have it, so this path means a packaged
      // build is running with no key source yet.
      throw new Error(
        "No OpenRouter API key available. Reading keys/.env is a " +
          "development-only capability and is not compiled into packaged " +
          "builds; a packaged app needs a key entered in settings " +
          `(not built yet). Underlying error: ${
            err instanceof Error ? err.message : String(err)
          }`,
      );
    }
  }

  const envKey = envFallbackKey();
  if (!envKey) {
    throw new Error(
      "No OpenRouter API key available (not running in Tauri and VITE_OPENROUTER_API_KEY is unset)",
    );
  }
  cachedKey = envKey;
  return cachedKey;
}

/** Test helper: drop the in-memory key cache. */
export function resetKeyCache(): void {
  cachedKey = null;
}
