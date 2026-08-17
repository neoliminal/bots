# Bot Management Specification (Delta)

## ADDED Requirements

### Requirement: Persona templates
The platform SHALL support persona templates: shareable packs bundling a role title, role description, standing instructions, and optional starter workspace files. Creating a Bot from a template SHALL prefill the creation flow (name suggestion, role, instructions, starter files) while leaving everything editable before the Bot is created. Templates SHALL be plain, inspectable files.

#### Scenario: Create from a template
- **WHEN** the user imports a "Research Assistant" persona template and creates a Bot from it
- **THEN** the creation flow is prefilled with the template's role, instructions, and starter files, the user can edit any of it, and the resulting Bot behaves per the (possibly edited) pack

#### Scenario: Template is inspectable before use
- **WHEN** the user opens an imported template before creating a Bot from it
- **THEN** its full contents (role, instructions, file list) are readable in plain form — nothing executes on import

### Requirement: Export Bot as template
The user SHALL be able to export any existing Bot as a persona template containing its role, description, and standing instructions. Exports SHALL exclude credentials, memories, message history, and any user-identifying content, and the export flow SHALL show exactly what the template will contain before writing it.

#### Scenario: Clean export
- **WHEN** the user exports their tuned "Landing Page Bot" as a template
- **THEN** the template contains role and instructions only — no memories, threads, credentials, or personal data — and the user sees the exact contents before export completes
