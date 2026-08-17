# Design: Harden the platform against the security audit findings

## The organizing idea

The audit's structural finding was that one gate stood in one place. The fix
is not more gates but a better question at the single gate: **not "what tool is
this?" but "what is this call, on whose machine, with what in context?"**

Three axes were missing from `decide()`:

| Axis | Before | After |
|---|---|---|
| Arguments | discarded (`_args`) | `classify(args)`, tighter-of-two |
| Whose machine | "is it local?" | "does the user own it?" |
| What is in context | not modelled | untrusted-content taint |

Everything else follows from those.

## D1 — Classification tightens, never loosens

`decide` computes the decision for the declared category and, when a tool
declares `classify`, for the classified category, and returns the stricter.
This is what makes `credential`/`payment` reachable without trusting the
classifier: a classifier that returns a gentler category cannot weaken
anything, so a buggy or hostile one fails safe. Connector tools are classified
by name at the platform layer, so a server cannot decline its own floor.

Rejected alternative: letting tools declare `category` per call directly.
That makes the category attacker-influenceable for MCP tools, which is exactly
the property we need to deny.

## D2 — Taint, not blanket gating

Gating every write after any web read would make the product unusable. The
taint set is deliberately narrow: only the categories through which *injected
text can escalate* — writing the bot's own future instructions, delegating
under a different policy, and reaching the network again (the exfiltration
leg). `shell-session` deliberately stays allow: it is an isolated VM whose
escape routes (network egress, sync-back of prompt-influencing files) are
themselves covered.

The first web read in a run is therefore free; the read *after* untrusted
content is in context is not. That is what turns a silent
harvest-then-exfiltrate chain into one the user sees.

Taint is per-run and one-way. It is not persisted: a fresh run starts clean,
which keeps the model of "what is gated right now" simple enough to explain.

## D3 — `self-modify` as its own category

Memory entries and `skills/**` are spliced verbatim into every later system
prompt, so a write there is an instruction to the bot's future self, not a
file write. Giving it a category (rather than special-casing memory) means the
same rule covers all three routes in: the memory tool, a workspace write, and
a session write mirrored back. The path test is deliberately lenient
(`./Skills/`, backslashes, bare `skills`) because it guards a boundary —
near-misses must land on the safe side.

Sync-back refuses `skills/` outright rather than gating it: it is the one
direction where a *remote* machine chooses the filename, and there is no
legitimate reason for a session to author a skill.

## D4 — The envelope

Tool results are wrapped with a header stating the content is data, and the
delimiters are stripped from the payload before wrapping. Stripping is what
makes the fence real: without it, fetched text containing the closing
delimiter forges a boundary and continues as trusted narration. Output is also
capped, so a large page cannot crowd out the actual instructions.

## D5 — Host-side defense in depth

The Rust layer previously trusted the webview completely: every command was
callable from JS, and all gating lived in the renderer. That remains true of
the approval pipeline (moving it host-side is a larger change), but the
commands that most needed a second opinion now have one — target pinning,
per-bot machine ownership, command/env validation for spawned servers, and
bounded walks and reads. These do not depend on the renderer being correct.

## D6 — Known consequence: release builds have no key

Compiling `get_dev_api_key` out of release is correct — a shipped binary must
not carry a command whose purpose is to hand `keys/.env` to the webview — but
it leaves a packaged build with no key source. The error now says so
explicitly instead of surfacing "command not found". A Settings key-entry path
(ideally the `security` spec's vault) is required before the app ships; it is
deliberately out of scope here rather than bolted on under a security change.
