# KAD Field Visits design system

## Core tokens

| Token | Purpose |
|---|---|
| `--bg`, `--bg-card`, `--bg-elevated` | Page, card, and elevated/translucent surfaces |
| `--text`, `--text-dim`, `--text-tertiary` | Primary, supporting, and tertiary copy |
| `--accent` | Links, focus rings, icons, and accent foregrounds |
| `--accent-fill` | Filled controls that must retain readable white text in both themes |
| `--border` | Decorative separators and card grouping |
| `--control-border` | Required visible boundary for inputs and interactive components |
| `--radius`, `--radius-lg` | Standard and elevated geometry |
| `--shadow-subtle`, `--shadow-elevated` | Selected controls and floating surfaces |

Do not use `--border` as the only visual boundary of an interactive control. Do not use `--accent` as a filled background when the control contains text; use `--accent-fill`.

## Interaction standards

- Minimum touch target: 44×44 CSS pixels.
- Every icon-only button requires an accessible name.
- Focus uses the shared `:focus-visible` ring and must never be removed.
- Tabs use `tablist`, `tab`, `tabpanel`, `aria-selected`, and roving tabindex; Left/Right arrows change selection.
- Modal surfaces trap focus, make background content inert, close with Escape, and restore focus.
- Secondary Map actions live in the Map Tools group; zoom and current location remain immediately available.

## Information hierarchy

- Dashboard order: greeting → Next Visit → progress → quick actions → insights → recent activity.
- Analytics that do not affect the immediate field task use progressive disclosure.
- Settings contains Personal and Admin workspaces; privileged operations must not be mixed into personal preferences.
- The five-item primary navigation remains unchanged until user research supports a migration.

## Responsive behavior

- Portrait uses bottom navigation; short landscape uses the existing side rail.
- Content must remain usable at 320px width, 200% zoom, and long Armenian labels.
- Map tools open inward from the right edge and must not cover the primary navigation.

## Accessibility contrast targets

- Normal text: at least 4.5:1.
- Large text and meaningful graphics: at least 3:1.
- Interactive component boundaries: at least 3:1 against adjacent surfaces.
- Disabled controls are exempt from minimum contrast but must remain identifiable as disabled.
