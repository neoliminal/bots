# Agent Computer — Delta for harden-security-audit

## ADDED Requirements

### Requirement: The personal host is the user's machine, not a session

A personal host SHALL be treated as hardware the user owns, not as a
disposable compute session: shell commands on it require the user's approval,
and the tool description presented to the model SHALL state that the machine
is persistent and holds the user's own files, keys, and signed-in browser.

A shell on such a machine is a superset of every gated action — it can delete,
send, and read credentials without touching those tools — so it SHALL NOT
inherit the disposable session's frictionless default.

#### Scenario: Selecting the personal host does not disable the gates

- **WHEN** the user selects their personal host as the session provider and a
  bot calls the shell tool
- **THEN** the call pauses for approval, exactly as it would on the user's Mac

### Requirement: The browsing daemon authenticates its callers

The browsing daemon on the personal host SHALL accept commands only from a
caller presenting a per-install secret held in a file readable only by the
user, SHALL accept only the expected method and path, SHALL reject any request
carrying an `Origin` header, SHALL verify the `Host` header names the loopback
address it listens on, and SHALL bound request size and duration.

Binding to loopback is not sufficient: any local process can reach it, and a
cross-origin request from any page the user (or a bot) has open is a CORS
simple request that executes without a preflight. Rebinding defeats the host
check unless it is validated.

#### Scenario: Unauthenticated request is refused

- **WHEN** a local process posts a browse command without the secret
- **THEN** the daemon refuses it and performs no browser action

#### Scenario: Web page cannot drive the browser

- **WHEN** a page in any browser on the host posts a browse command
- **THEN** the request is refused because it carries an `Origin` header

### Requirement: The user can revoke shared browsing state

The user SHALL be able to sign the shared browser profile out of all sites
(or one site) from the app, without deleting files by hand. Every Bot browses
through ONE persistent profile signed in to the user's accounts, so revoking
that shared state has to be reachable.

#### Scenario: Signing out from settings

- **WHEN** the user chooses to sign out of all sites in session settings
- **THEN** the shared profile's cookies are cleared on the host and the result
  is reported

### Requirement: Session display adoption is verified

The host daemon SHALL verify a graphical session before adopting its
environment to show the browser on the user's screen: it identifies the
session process by the kernel-recorded executable name, verifies the
executable resolves inside a system directory, rejects candidates whose
display credentials point outside the user's own runtime directories, and
logs which process was adopted.

#### Scenario: Planted process is not adopted

- **WHEN** a process the user could have been tricked into running advertises
  itself with a session-like name from a writable directory
- **THEN** it is not adopted, and the daemon falls back to headless rather
  than showing the signed-in browser on an attacker-controlled display
