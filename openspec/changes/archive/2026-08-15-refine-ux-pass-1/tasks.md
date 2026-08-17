# Tasks — Refine UX Pass 1

## 1. Minimal stroke eyes (spec: bot-avatars, "Minimal stroke eyes")

- [x] 1.1 Replace the eye vocabulary in `poses.ts` with `EyeShape` (open, squint, determined, tall, dot, line, arc) plus an `EYE_GEOMETRY` table (scale/width/rot/bend/lift/tilt per shape) and remap `STATE_POSES` for all 11 states
- [x] 1.2 Rebuild each eye in `BotAvatar.tsx` as ONE rounded-cap `<path>` morphed only via CSS-transitionable transform / stroke-width / path bend — no whites, pupils, irises, clipPaths, or glints anywhere
- [x] 1.3 Tandem gaze: a single translate on the shared `.av-eyes` group moves both eyes together at fixed spacing (translate(34 42) / translate(66 42)); peer gaze aims the pair via `peerGaze`
- [x] 1.4 Blink = collapse to a line (`scaleY(0.1)` on `.av-blinkable`) and back; smooth morph transitions in `avatar.css` for transform, stroke-width, and `d`
- [x] 1.5 Error choreography: startled dots -> brief shake (3 iterations, ~1 s, not infinite) -> settled determined mirrored-tilt squint (`ERROR_SETTLE_MS`, `av-error-settled`); reduced motion shows the settled pose immediately
- [x] 1.6 Preserve ball body animations, one-shot celebration, per-instance desync, visibility pausing, reduced-motion static poses, size<32 detail cutoff, aria labels, disconnected dim; sleeping line eyes coexist with the zzz overlay
- [x] 1.7 Update `BotAvatar.test.tsx`: per-state anatomy (one rounded stroke path per eye, zero circle/ellipse/clipPath/rect inside eyes), tandem gaze, morph classes, error settle/re-arm/reduced-motion, zzz compatibility

## 2. Model picker — featured shortlist plus search (spec: model-configuration, "Picker ergonomics")

- [x] 2.1 New `featured.ts`: `selectFeaturedModels(catalog, inUse)` builds the shortlist by id-pattern matching — latest Claude Sonnet/Opus, latest OpenAI gpt flagship, latest Gemini Pro/Flash, one cheap utility pick — excluding :free/preview/experimental variants, in-use models first, deduped, capped at `FEATURED_CAP`
- [x] 2.2 Catalog-drift fallback: if no matcher hits, feature the latest tool-capable model per provider (major providers first) so the featured section is never empty while the catalog has models
- [x] 2.3 `inUseModelIds(byBot)` collects primary/utility/fallback ids from the model-config store
- [x] 2.4 Rewrite `ModelPicker.tsx`: Featured section + "Browse all N models" expander (full catalog collapsed behind it), prominent search box filtering the ENTIRE catalog locally and instantly on name/id/provider fragments, featured-ranked-first results; capability gating (disabled with reason) in featured, browse, and search
- [x] 2.5 `autoFocusSearch` prop (default true); BotEditor embeds with `autoFocusSearch={false}` so the Name field keeps initial focus in the modal
- [x] 2.6 Tests: `featured.test.ts` (flagship matching, drift resilience, drift fallback, utility pick, variant exclusion, in-use handling, dedupe, cap) and rewritten `ModelPicker.test.tsx` (featured layout, expander, provider/name/id search, ranking, disabled reasons, focus behavior, error state)

## 3. Role description first guess (spec: bot-management, "Role description first guess")

- [x] 3.1 New `roleSuggestions.ts`: pure `suggestRoles({existingBots, recentUserMessages})` over an 8-role library; Personal Assistant always first (dropped only when the roster covers it), roster-covered roles filtered out, usage-keyword boosts from recent messages; `collectRecentUserMessages(threads, limit)` helper
- [x] 3.2 `BotEditor.tsx`: create mode pre-fills the role textarea with the top suggestion (never starts blank); suggestion chips beneath the textarea are one-tap to accept; `window.confirm` guard so user-authored text is never clobbered; edit mode never pre-fills over the existing description
- [x] 3.3 Default wiring: `suggestions` prop defaults to live roster + last ~50 user messages from the chat store (no App.tsx changes needed)
- [x] 3.4 Tests: `roleSuggestions.test.ts` (ordering, complement filtering, usage boost, message collection) and `BotEditor.test.tsx` additions (pre-fill, live wiring, chip replace, no-clobber, edit mode)

## 4. Verification

- [x] 4.1 Cross-feature reconciliation in `BotEditor.tsx` (picker expander + role suggestions coexist; initial focus stays on Name)
- [x] 4.2 `npx vitest run` — 22 files, 225 tests green
- [x] 4.3 `npx tsc --noEmit` — clean
- [x] 4.4 `npm run build` — clean
- [x] 4.5 `cargo check` (src-tauri) — clean
