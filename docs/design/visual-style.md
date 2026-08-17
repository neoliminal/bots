# Bots — Visual Style Guide

Source: user-provided reference screenshot (iMessage-like Mac client, Aug 2026). This is the target look for Bots for Mac, avatars included: **the eyes are white with an ink outline**, as in the reference (per `bot-avatars` spec). They were minimal black strokes until Aug 2026; white reads better on saturated balls and gives the outline something to shape.

## Overall feel
- Light, airy, native-Mac. White/near-white surfaces, hairline borders, generous padding, large corner radii. No dark chrome, no heavy shadows — depth comes from subtle borders and soft off-white panel tints.
- Typography: SF-style system stack (`-apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, sans-serif`). Body ~13–14px, sidebar names semibold 13px, previews regular 13px in gray, timestamps 11px gray.
- Color: monochrome UI (white / #f2f2f7-ish grays / #1c1c1e text) — ALL color comes from the bot avatars and small accents (blue unread dot, blue links).

## Window layout (3 columns)
1. **Sidebar (~260px, white):** traffic lights + a small "+" new-bot button top-right; pill search field (light gray fill #eeeef0, rounded-full, magnifier icon); bot list; footer rows ("Plugins", user account with small avatar).
2. **Chat column (white):** minimal header — bot avatar (small) + name left, panel-toggle icon right; centered small gray timestamp separators; messages; pill composer.
3. **Detail panel (~300px, off-white #f7f7f9, collapsible):** context for the selected bot — screen/session preview card at top (rounded-xl thumbnail with caption "«Bot»'s screen" → for us: session/task activity card), then sections like **Routines** (icon + name + schedule line, e.g. "Morning briefing / Every day at 8:00 AM", paused state in gray). For us: Capability card, Routines, Waiting-on-you items, session status.

## Sidebar rows
- Row: avatar (40px) + two lines (name semibold; last-message preview gray, truncated) + right-aligned relative timestamp (11px gray). Blue dot (8px, #007aff) on unread. Selected row: soft gray rounded-xl fill (#e9e9eb). Hover: lighter fill. Rows ~64px tall, 8px radius spacing rhythm.

## Chat bubbles (iMessage pattern, inverted palette)
- **User (right):** black/near-black fill (#1c1c1e), white text, rounded-2xl (18px) with the bottom-right corner tighter.
- **Bot (left):** light gray fill (#e9e9eb → #f1f1f3), near-black text, rounded-2xl with bottom-left tighter. No avatar next to every bubble in direct threads (header identifies the bot); in delegation/instance contexts, small avatar + name caption above the group.
- Consecutive bubbles from the same author cluster with 2px gaps; cluster gets one tail.
- **File/attachment cards:** white card, hairline border, rounded-xl; doc icon in a tinted rounded square (e.g. red for PDF), filename semibold + meta line ("12 pages · 1.2 MB"), trailing download icon.
- **Links** in bot text: #007aff.
- Delegation cards / approval cards: same white-card language as file cards — hairline border, rounded-xl, compact header row (avatar + "asked Scout for account research"), status line, expandable.

## Composer
- Pill (rounded-full) white field with hairline border; leading circular "+" button (light gray fill); placeholder "Message «Bot»" in gray; trailing circular black mic/send button (28px). Sits on white with comfortable margin.

## Avatars
- Juicy, saturated **vertical gradient** fills (lighter top → deeper bottom, e.g. violet #a78bfa→#7c3aed, blue #38bdf8→#0284c7, green #4ade80→#16a34a, orange, pink, red, teal): the palette IS the product's color.
- Shape: keep our ball (circle) — the reference's varied blob/droplet silhouettes are optional future flair (could map shape to role later). Subtle top-left gloss highlight retained.
- **Eyes: white, ink-outlined, rounded-end shapes** (`bot-avatars`) — tandem movement and morphs unchanged. The white fill does the legibility work on any ball; the outline stays ink on light and mid balls and lifts to slate on near-black customs so the edge doesn't vanish.
- Eyes may **taper** along their length (thicker at one end). The wedge is expressive vocabulary, not decoration: thinking and resolve lean on it, calm states stay even.
- The **open conversation's sidebar row** tracks the cursor much harder than the ambient header follow (3.2x radius and reach) — the bot you're working with should look like it's watching you.
- Gaze rides the **curved surface**: one gaze rotates the ball, and each eye is projected onto it, so the pair arcs, converges toward the edge and foreshortens. Eyes never slide flat across the face like stickers.
- Sizes: 40px sidebar, ~28px chat header, 64px+ in settings/gallery; menu-bar per spec.

## Light is the primary theme
- The app ships light-first to match this reference. Dark mode remains supported (Tailwind dark: variants) but must not drive the design; light is canonical.
