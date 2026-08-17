# E2E tests (Playwright)

Browser-level flow tests for the Bots app, run against the real Vite dev
server (the same bundle `tauri dev` loads) with everything outside the web
app mocked:

- **Tauri IPC bridge** — an init script installs a fake
  `window.__TAURI_INTERNALS__` whose `invoke` answers `get_dev_api_key`
  with `sk-test-fake` and every other command with a benign `null`, so the
  app follows its "running in Tauri" code path without a Rust host.
- **OpenRouter catalog** — `https://openrouter.ai/api/v1/models` is
  intercepted and served from a ~10-model fixture (Anthropic / OpenAI /
  Google flagships, a utility model, and one no-tools model for capability
  gating). See `support/mocks.ts`.
- **OpenRouter chat completions** — `…/api/v1/chat/completions` is answered
  in-page with a genuine `ReadableStream` SSE body whose deltas are paced,
  so streaming UI (typing indicator, Stop button) is observable and
  abortable deterministically. A `page.route` safety net guarantees no real
  network request escapes even if the in-page shim is bypassed.

No real network access or API key is needed.

## Running

There are intentionally **no package.json scripts** for this; invoke
Playwright directly from `app/`:

```sh
# one-time: install the browser binary
npx playwright install chromium

# run the whole suite (starts `npm run dev` on :1420 automatically,
# or reuses an already-running dev server outside CI)
npx playwright test

# a single file / test
npx playwright test e2e/chat.spec.ts
npx playwright test -g "stop button"

# headed / debug / UI mode
npx playwright test --headed
npx playwright test --debug
npx playwright test --ui

# view the report & failure traces (trace is recorded on failure)
npx playwright show-report
```

Config lives in `../playwright.config.ts` (testDir `e2e/`, single Chromium
project, baseURL `http://localhost:1420`, `trace: "retain-on-failure"`,
webServer `npm run dev`).

## Layout

| Path | Purpose |
| --- | --- |
| `support/mocks.ts` | Tauri bridge fake, model-catalog fixture, SSE chat stream mock (`installMocks`, `setChatReply`, `chatRequests`) |
| `support/helpers.ts` | Accessible-selector flow helpers (`openApp`, `createBot`, `composer`, `messageLog`) |
| `create-bot.spec.ts` | Create flow: role prefill, featured-model pick, immediate messageability |
| `chat.spec.ts` | Send + streamed reply; Stop button while streaming + cancellation |
| `edit-bot.spec.ts` | Settings modal: catalog search (`anthropic` filter), capability gating, saving a model pick |
| `avatar-gallery.spec.ts` | Dev menu → avatar gallery → back to chat |

## Conventions

- Select via **accessible roles / labels / text** (`getByRole`,
  `getByLabel`), never DOM structure or CSS classes — thread internals are
  free to change without breaking these tests.
- Specs are named `*.spec.ts` and live only in `e2e/`; vitest picks up only
  `src/**/*.test.{ts,tsx}`, so the two suites never see each other's files.
- Each test gets a fresh browser context (clean `localStorage`), so tests
  create their own bots through the UI and are order-independent.
- To reshape the streamed reply in a test, call
  `setChatReply(page, { deltas, delayMs })` before sending; to assert on
  what was sent to the provider, read `chatRequests(page)`.
