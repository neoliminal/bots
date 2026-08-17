# Bot Avatars Specification

## Purpose

Every Bot is represented by a cute animated ball — a small round character in the Bot's color with two minimal, expressive eyes. The eyes are deliberately simple: two white, ink-outlined shapes with rounded ends (not cartoon eyeballs — no pupils or irises) that move in tandem, grow and shrink, and morph between a few shapes. They look around, blink, and play distinct animations keyed to what the Bot is actually doing (thinking, talking to another Bot, working, waiting on the user, sleeping). Avatars make a team of invisible cloud workers feel alive and legible at a glance: the roster, threads, menu bar, and notifications all reuse the same character. Animations are implemented as a state-machine-driven animation asset (single asset, state-driven, GPU-cheap — runtime per the project tech stack) rendered in the app.

## Requirements

### Requirement: Ball avatar identity
Each Bot SHALL have a ball avatar with a user-selectable color (from a curated palette plus custom color), chosen at creation and editable any time. The ball SHALL be rendered with a soft vertical gradient of its color (lighter top, deeper bottom) and a subtle gloss highlight — juicy and saturated, since avatar color is the primary source of color in an otherwise monochrome light UI (see docs/design/visual-style.md). Eyes remain the minimal white ink-outlined shapes per the Minimal eyes requirement. The avatar SHALL be visually consistent everywhere the Bot appears: sidebar/roster, thread header, message bubbles, live-view overlay, menu bar extra, and notifications (static snapshot where animation isn't possible).

#### Scenario: Choosing a color
- **WHEN** the user creates a Bot and picks teal
- **THEN** the Bot's ball is teal in every surface of the app, and no other Bot can be assigned an indistinguishable color without a warning

#### Scenario: Color change propagates
- **WHEN** the user changes a Bot's color from teal to orange
- **THEN** all surfaces update immediately without restart

### Requirement: Minimal eyes
Each eye SHALL be a single closed shape with rounded ends — white, outlined in ink, with no pupils or irises. Expression comes entirely from the pair's shared geometry: the two eyes move in tandem across the ball's curved surface (one gaze rotates the ball beneath them, so they travel along an arc, draw together as they near the edge, and foreshorten as the surface turns away — never sliding flat across the face), grow and shrink together or per expression, and morph between a small shape vocabulary — vertical rounded shapes (neutral/open), dots/circles (alert, surprised, or occasional variation), horizontal sleepy lines (tired/sleeping), short squints (thinking/effort), and upward arcs (happy). An eye MAY taper along its length — thicker at one end than the other — and that asymmetry SHALL be available as expressive vocabulary, since where the weight sits changes the read of an otherwise identical shape. Blinking is the shape collapsing to a line and back. Eyes SHALL be bold enough to read clearly at roster sizes; the white fill carries legibility against any ball color, and the outline color SHALL stay visible against the ball (ink on light and mid balls, lifted off near-black ones).

#### Scenario: No cartoon anatomy
- **WHEN** an avatar is rendered in any state at any size
- **THEN** each eye is a single rounded-end white shape with an ink outline (or its morph target: dot, line, or arc), with no pupils or irises

#### Scenario: Tandem movement
- **WHEN** the avatar looks toward a gaze target
- **THEN** both eyes move together as a pair under one gaze, following the ball's curvature rather than moving independently or sliding flat

#### Scenario: Shape morphs read as mood
- **WHEN** a Bot becomes tired/paused
- **THEN** its eyes ease into horizontal sleepy lines; and when it becomes alert (e.g., waiting on the user), the shapes grow — optionally rounding into dots — within a smooth morph, never a hard swap

### Requirement: Ambient eye life
The eyes SHALL behave continuously and organically: idle wandering gaze (the pair drifting in tandem), periodic blinking (randomized ~2–8 s intervals, stroke collapsing to a line), and subtle size breathing, so the character never looks frozen. Eyes SHALL orient toward contextually relevant targets where applicable (e.g., toward the other Bot's avatar during a bot-to-bot exchange).

#### Scenario: Ambient life
- **WHEN** a Bot is idle and visible on screen
- **THEN** its eyes wander and blink naturally, with no two Bots' animations in visible lockstep

#### Scenario: Gaze targeting
- **WHEN** Bot A sends a message to Bot B in a group thread and both avatars are visible
- **THEN** Bot A's eyes turn toward Bot B's avatar for the duration of the exchange animation

### Requirement: State-driven animations
The avatar SHALL play a distinct, recognizable animation for each Bot activity state, driven by the Bot's real runtime state (from the presence/status feed) with transition latency under 1 second. The minimum state set:

| State | Animation (canonical description) |
|---|---|
| **Idle** | gentle bob, wandering gaze, blinks |
| **Thinking** | strokes shorten to squints and drift upward, ball tilts, slow "pondering" wobble |
| **Working (computer use)** | eyes dart in scanning pattern (screen-reading), subtle busy vibration |
| **Talking to user** | eyes to camera, bounce synced to message delivery |
| **Talking to another Bot** | leans and gazes toward peer avatar, alternating "speaking" pulses |
| **Waiting on user (blocked)** | strokes grow tall (or round into attentive dots) toward camera, periodic polite hop |
| **Handoff/receiving task** | ball nudges toward peer, eyes exchange a glance, brief carry gesture |
| **Error/blocked externally** | strokes pop into startled dots, small shake, then settle into a determined squint on retry |
| **Paused/sleeping** | eyes as horizontal sleepy lines, slow breathing squash-and-stretch, occasional "zzz" |
| **Celebrating (task complete)** | strokes curve into happy upward arcs, single joyful bounce with tiny confetti burst |

#### Scenario: Thinking is visibly thinking
- **WHEN** a Bot begins an extended reasoning step
- **THEN** its avatar transitions to the thinking animation within 1 second, and returns to working/idle when reasoning completes

#### Scenario: Bot-to-bot conversation is visible
- **WHEN** two Bots exchange messages while the user watches the roster
- **THEN** both avatars play the talking-to-bot animation oriented toward each other, making the collaboration legible without reading the thread

#### Scenario: Completion celebration
- **WHEN** a Bot completes an assigned task
- **THEN** the avatar plays the celebration animation once (not looping) and settles to idle

### Requirement: Animation as truthful status
Avatar state SHALL reflect the Bot's actual runtime state — the same source of truth as the roster status — never a decorative loop. If the state feed is disconnected, avatars SHALL show a distinct "connection lost" dimmed look rather than continuing to fake liveness.

#### Scenario: No false liveness
- **WHEN** the client loses its realtime connection
- **THEN** avatars dim to the disconnected look until state resumes, rather than continuing to animate as if current

### Requirement: Menu bar and small-size presence
The avatar system SHALL scale down gracefully: at menu-bar and badge sizes (≥16 px) the ball and eye state (idle/working/blocked) SHALL remain readable, with fine detail (confetti, micro-saccades) automatically disabled below 32 px.

#### Scenario: Menu bar glance
- **WHEN** the user glances at the menu bar extra while one Bot is blocked on them
- **THEN** that Bot's tiny ball shows the attentive waiting look, distinguishable from its working teammates

### Requirement: Performance and accessibility
All visible avatars together SHALL cost under 3% CPU on a base M1 with 8 avatars animating (GPU-composited, paused entirely when offscreen or the window is hidden). The app SHALL honor macOS "Reduce Motion" by switching to minimal cross-fades with static expression poses, and every state SHALL have a text equivalent for accessibility (VoiceOver reads "Scout — thinking").

#### Scenario: Reduce Motion respected
- **WHEN** the user enables Reduce Motion in macOS settings
- **THEN** avatars stop bouncing/wobbling and convey state via static expressions and gentle fades, with no loss of status information

#### Scenario: Offscreen costs nothing
- **WHEN** the app window is minimized with no avatars visible
- **THEN** avatar animation work drops to zero (state tracking continues, rendering does not)
