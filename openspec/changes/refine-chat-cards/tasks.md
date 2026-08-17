# Tasks — Refine Chat Cards

## 1. Question cards

- [x] 1.1 ThreadView: card container (prompt title, letter badges on option rows, inline own-answer field wired to onChoiceSelect) (+ tests)
- [x] 1.2 Receipt collapse when answeredWith is set — prompt + chosen answer + check, unchosen options hidden (+ tests incl. retroactive rendering of already-answered blocks)

## 2. Sidebar waiting states

- [x] 2.1 Amber "Waiting for you…" status line + amber dot for state "waiting" (unread blue dot wins) (+ tests)

## 3. Template import, file-first

- [x] 3.1 "Import template…" opens the file picker directly; paste-JSON demoted to a "paste JSON instead" toggle (+ tests)

## 4. Personal-host discovery

- [x] 4.1 Rust `host_discover` (bounded dns-sd browse, parsed candidates) + native binding (+ Rust parse tests)
- [x] 4.2 SessionSettings "Scan network" → candidate chips prefill the target field; plain empty-state message (+ tests)

## 5. Verification

- [x] 5.1 tsc + full unit suite + cargo test green; walk delta scenarios
