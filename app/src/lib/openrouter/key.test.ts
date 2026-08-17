import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getKey, readDevEnvKey, resetKeyCache } from "./key";

beforeEach(() => {
  resetKeyCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("readDevEnvKey", () => {
  it("returns the key in dev mode", () => {
    expect(readDevEnvKey({ DEV: true, VITE_OPENROUTER_API_KEY: "sk-or-dev" })).toBe(
      "sk-or-dev",
    );
  });

  it("never returns a key outside dev mode, even when the env var is set", () => {
    // Regression: in a production `vite build`, DEV is statically false; the
    // env fallback must be dead code so the key cannot ship in the bundle.
    expect(
      readDevEnvKey({ DEV: false, VITE_OPENROUTER_API_KEY: "sk-or-leaked" }),
    ).toBeUndefined();
    expect(readDevEnvKey({ VITE_OPENROUTER_API_KEY: "sk-or-leaked" })).toBeUndefined();
  });

  it("treats an empty or non-string value as unset", () => {
    expect(readDevEnvKey({ DEV: true, VITE_OPENROUTER_API_KEY: "" })).toBeUndefined();
    expect(readDevEnvKey({ DEV: true, VITE_OPENROUTER_API_KEY: 42 })).toBeUndefined();
    expect(readDevEnvKey({ DEV: true })).toBeUndefined();
  });
});

describe("getKey (non-Tauri fallback)", () => {
  it("resolves from the dev env var and caches it", async () => {
    vi.stubEnv("VITE_OPENROUTER_API_KEY", "sk-or-test");
    await expect(getKey()).resolves.toBe("sk-or-test");
    vi.stubEnv("VITE_OPENROUTER_API_KEY", "sk-or-changed");
    await expect(getKey()).resolves.toBe("sk-or-test");
  });

  it("rejects when no key is available", async () => {
    vi.stubEnv("VITE_OPENROUTER_API_KEY", "");
    await expect(getKey()).rejects.toThrow(/No OpenRouter API key available/);
  });
});
