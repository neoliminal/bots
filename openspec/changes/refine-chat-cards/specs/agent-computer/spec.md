# Agent Computer Specification (Delta)

## ADDED Requirements

### Requirement: Personal host discovery
The settings surface SHALL offer to discover reachable personal-host candidates on the local network (SSH services via mDNS/Bonjour) and present them as one-click choices that prefill the SSH target — the user SHOULD NOT have to type an address the machine can find. Typing a target manually SHALL remain available for hosts that do not advertise. Discovery SHALL be user-initiated (a scan action), never a background network probe.

#### Scenario: Pick the mini-PC from a list
- **WHEN** the user clicks "Scan network" in the personal-host settings and their mini-PC advertises SSH
- **THEN** the host appears as a clickable choice; choosing it prefills the target field (editable), and the user proceeds to Save & test without typing an address

#### Scenario: Nothing advertises
- **WHEN** a scan finds no SSH services
- **THEN** the UI says so plainly and the manual target field remains the path forward
