# Bots — desktop app

Tauri 2 (Rust host) + React + TypeScript + Vite. Runs on **macOS and Windows**.

See the repo root `README.md` for architecture and `openspec/project.md` for
the canonical project context.

## Prerequisites (both platforms)

- Node.js 20+
- Rust (stable) via [rustup](https://rustup.rs)

### macOS

- Xcode Command Line Tools (`xcode-select --install`)

### Windows

- Visual Studio 2022 (or Build Tools) with the **Desktop development with C++**
  workload — the Rust `stable-msvc` toolchain links against it
- WebView2 runtime (preinstalled on Windows 11)

## Running

```sh
npm install
npm run dev            # web bundle only, on :1420
npm run tauri dev      # full desktop app (Rust host + webview)
npm test               # vitest unit suite
cd src-tauri && cargo test   # Rust host suite (platform-gated tests run per-OS)
```

Dev API keys go in `keys/.env` (`OPENROUTER_API_KEY=...`) in any parent
directory of the repo — see the root README.

## Platform notes

- **Session commands** run through `/bin/sh -c` on macOS and `cmd.exe /d /s /c`
  on Windows, always sandboxed to the bot's workspace with a sanitized
  environment. Bots should therefore emit platform-appropriate shell syntax.
- **MCP servers on Windows**: commands resolve against a fixed PATH
  (System32, `%ProgramFiles%\nodejs`, `%APPDATA%\npm`). Batch-file shims
  (`npx.cmd` and friends) are refused — register servers as `node` plus the
  server's JS entry point, or an `.exe`.
- **Personal-host discovery** uses `dns-sd` (Bonjour). On Windows without
  Bonjour installed, discovery quietly returns no candidates — type the
  `user@host` target manually in Settings instead.
- **Personal-host SSH** uses the OpenSSH client bundled with Windows
  (`System32\OpenSSH\ssh.exe`) when present.
- **Dock badge** counts are macOS-only; other platforms no-op safely.
