# Mac App Shell Specification

## Purpose

Deliver the Bots client as a first-class macOS application. Built on the lightweight hybrid shell defined in the project tech stack (`openspec/project.md`), it must be indistinguishable from a native app in daily use: proper windowing, menu bar presence, native notifications, deep links, Keychain-backed auth, code signing/notarization, and silent auto-update. The shell hosts every other client-side capability (messaging, live view, approvals).

## Requirements

### Requirement: Native macOS application packaging
The client SHALL be distributed as a signed, notarized macOS application bundle (`Bots.app`) that installs by drag-and-drop or via `.dmg`, runs on macOS 13+ (Apple Silicon and Intel), and passes Gatekeeper without warnings.

#### Scenario: First launch on a clean Mac
- **WHEN** a user downloads the `.dmg`, drags `Bots.app` to Applications, and opens it for the first time
- **THEN** the app launches without Gatekeeper warnings, presents onboarding/sign-in, and registers itself for notifications and deep links

#### Scenario: Universal binary
- **WHEN** the app is launched on an Apple Silicon Mac
- **THEN** it runs natively (arm64) without Rosetta

### Requirement: Menu bar presence and native menus
The app SHALL provide a standard macOS menu bar (App/File/Edit/View/Window/Help with standard shortcuts) and a persistent menu bar (status item) extra showing at-a-glance Bot activity, with quick actions (open app, pause all Bots, jump to a running task).

#### Scenario: Status item shows activity
- **WHEN** at least one Bot is actively executing a task
- **THEN** the menu bar status item reflects the active state and its menu lists each running task with a one-click "watch" action

#### Scenario: Closing the window does not quit
- **WHEN** the user closes the main window while Bots are running
- **THEN** the app continues running in the menu bar, continues to deliver notifications, and reopens the window when the status item or dock icon is clicked

### Requirement: Native notifications
The app SHALL deliver macOS-native notifications (UNUserNotificationCenter) for events defined by the `notifications` capability, with actionable buttons (e.g., Approve, Take over, View) that deep-link to the relevant thread or approval.

#### Scenario: Actionable approval notification
- **WHEN** a Bot requests approval while the app window is closed
- **THEN** a native notification appears with "Review" and "Approve" actions, and choosing "Review" opens the app directly to that approval

### Requirement: Deep links
The app SHALL register the `bots://` URL scheme and resolve links to threads (`bots://thread/{id}`), tasks (`bots://task/{id}`), approvals (`bots://approval/{id}`), and live views (`bots://live/{botId}`).

#### Scenario: Deep link from notification
- **WHEN** a `bots://task/{id}` link is opened from a notification or another app
- **THEN** the app comes to the foreground and navigates to that task's detail view

### Requirement: Secure local session storage
The app SHALL store authentication tokens exclusively in the macOS Keychain and SHALL NOT write secrets to plaintext files, logs, or the local message cache.

#### Scenario: Token at rest
- **WHEN** the user is signed in and the app is quit
- **THEN** the refresh token exists only as a Keychain item scoped to the app's code signature, and no token material is present in application support files

### Requirement: Auto-update
The app SHALL check for updates on launch and periodically, download updates in the background, verify the update signature, and apply on next restart with user consent (or silently if the user enabled automatic updates).

#### Scenario: Background update
- **WHEN** a new signed release is published and the user has automatic updates enabled
- **THEN** the update is downloaded and staged in the background and applied on the next app restart without manual steps

### Requirement: Offline and degraded operation
The app SHALL remain usable offline for reading cached threads and composing messages, queueing outbound messages locally and syncing when connectivity returns. It SHALL clearly indicate connection state and that Bots continue working server-side while the client is offline.

#### Scenario: Compose while offline
- **WHEN** the user sends a message to a Bot while the Mac is offline
- **THEN** the message is stored in a local outbox, shown as "pending", and delivered automatically when the connection is restored

#### Scenario: Reconnect state
- **WHEN** connectivity is restored after an interruption
- **THEN** the app resyncs missed messages and task updates without requiring a restart, and the connection indicator returns to normal

### Requirement: Performance envelope
The app SHALL launch to an interactive window in under 2 seconds on a base M1 Mac, idle below 1% CPU with no live view open, and keep steady-state memory under 400 MB with typical usage (10 threads, one live view closed).

#### Scenario: Idle resource use
- **WHEN** the app is running in the background with no active live view
- **THEN** measured CPU usage over a 5-minute window averages below 1%
