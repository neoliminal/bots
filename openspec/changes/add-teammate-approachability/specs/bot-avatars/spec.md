# Bot Avatars Specification (Delta)

## ADDED Requirements

### Requirement: Cursor-following idle gaze
The avatar of the active conversation SHALL track the user's cursor with its gaze while in the idle (ambient-wander) state: the tandem eye pair deflects toward the pointer, ramping with distance up to the normal gaze radius, and smoothly trails pointer movement. Cursor tracking SHALL apply only to the active conversation's avatar (sidebar and message-caption avatars keep ambient wander), SHALL NOT override any non-wander state's choreography (thinking, working, peer gaze, etc.), SHALL fall back to ambient wander when the pointer leaves the window, and SHALL be disabled under reduced motion.

#### Scenario: Idle eye contact in the open thread
- **WHEN** the open conversation's Bot is idle and the user moves the cursor across the screen
- **THEN** that avatar's eyes follow the cursor while sidebar avatars continue their independent ambient wander

#### Scenario: States keep their choreography
- **WHEN** the active Bot transitions from idle to thinking or working while the cursor moves
- **THEN** the state's own gaze (fixed glance, scanning) takes over and the cursor is ignored until the Bot is idle again

#### Scenario: Pointer leaves the window
- **WHEN** the cursor exits the app window while the active Bot is idle
- **THEN** the avatar returns to ambient wandering rather than freezing at the last cursor position

#### Scenario: Reduced motion
- **WHEN** the user has reduced motion enabled
- **THEN** the idle gaze does not track the cursor
