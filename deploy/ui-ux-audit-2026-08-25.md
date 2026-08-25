# UI/UX and accessibility audit — 2026-08-25

## Executive assessment

The app has a modern visual foundation: restrained surfaces, consistent rounded geometry, clear primary actions, responsive portrait/landscape navigation, explicit loading/empty/error states, vector iconography, and strong field-workflow orientation. It is suitable for continued production refinement, but it is not yet fully aligned with WCAG 2.1 AA or a mature design-system standard.

This audit covers the latest GitHub `main` implementation across Dashboard, Map, Customers, Customer Detail, Check-in, Activity, Orders, Order Creation, Settings/Admin, Login, dialogs, navigation, light/dark themes, Armenian/English, portrait, compact landscape, loading, empty, error, offline, and permission states.

## Findings by priority

### Critical/high — corrected in batch 1

| Finding | Standard/impact | Resolution |
|---|---|---|
| Viewport blocked user zoom with `maximum-scale=1` | WCAG 1.4.4; harms low-vision users | Removed zoom restriction |
| Drawer allowed focus and screen-reader navigation behind it | WCAG 2.4.3 and 4.1.2 | Added modal semantics, inert background, focus entry/trap/restore, and expanded-state reset |
| Menu and photo-removal controls were below 44×44 px | WCAG 2.5.5 | Expanded interaction targets while retaining compact visible glyphs |
| Search fields relied on placeholder text as their name | WCAG 3.3.2 and 4.1.2 | Added programmatic accessible names |
| Plan-mode tabs lacked tab semantics and arrow navigation | WCAG 2.1.1 and 4.1.2 | Added tab/tabpanel roles, selected state, roving tabindex, and arrow keys |

### Major — safe next batches

| Finding | Evidence/impact | Planned correction |
|---|---|---|
| Several compact controls remain under 44 px | Activity filters and other dense toolbars contain local size overrides | Normalize all interactive components to a shared target-size token |
| Relative timestamps are English-only | `formatRelative()` emits `m ago`, `h ago`, and `d ago` in Armenian mode | Add localized relative-time formatting |
| Button `type` is inconsistently explicit | Many dynamically rendered buttons depend on context/default behavior | Add `type="button"` except for intentional submit actions |
| Inline presentation styles bypass reusable components | Orders, activity sorting, charts, and progress bars use inline styles | Move static styles to component classes; retain only data-driven CSS variables |
| Dense data text reaches 0.60–0.72rem | Navigation, map attribution, summaries, and metadata can be difficult at large text settings | Establish a 12px minimum for meaningful UI copy, with wrapping/truncation rules |
| Some custom menus need complete keyboard behavior | Menu roles exist, but focus movement/Escape behavior is implemented inconsistently | Create one shared accessible menu controller |
| Tier radiogroup is click-only | Radio semantics exist but arrow-key selection is absent | Add roving tabindex and arrow-key behavior |
| Drawer and install controls use inconsistent close icon sources | Mix of shared vectors and multiplication glyphs remains outside Map | Standardize shared close/plus/minus icon components |

### Contrast findings

| Token pair | Measured ratio | WCAG result |
|---|---:|---|
| Light primary text / page | 17.33:1 | Pass |
| Light secondary text / page | 5.72:1 | Pass |
| Light tertiary text / page | 4.24:1 | Fail for normal text |
| Light accent / white | 5.19:1 | Pass |
| Dark primary text / card | 15.63:1 | Pass |
| Dark secondary text / card | 5.93:1 | Pass |
| Dark tertiary text / card | 3.25:1 | Fail for normal text |
| Dark accent / card | 5.13:1 | Pass as foreground |
| Light/dark borders / cards | 1.22:1 / 1.45:1 | Below 3:1 where the boundary is required to identify a control |

The tertiary and boundary tokens are global. Changing them affects every screen, so this is classified as an approval-required visual-system adjustment rather than a silent patch.

## Visual hierarchy and consistency

### What works

- Primary headings and calls to action are easy to locate.
- Card geometry and spacing are broadly consistent.
- Status colors are semantically stable across the primary workflows.
- Map controls now use a coherent vector family.
- Portrait and short-landscape navigation have dedicated layouts.
- Loading, empty, validation, offline, and retry states are represented.

### Remaining concerns

- Dashboard combines progress, summary, trends, activity, and quick actions into a long first screen; prioritization is diluted below the next-visit action.
- Map combines five filter chips, up to five control buttons, route planning, panels, and a floating add action; novice users face high control density.
- Settings combines personal preferences, security, administration, approvals, catalog, exports, and performance; scanning cost is high for privileged roles.
- The raised center Map tab is visually dominant even when another task is more urgent, creating a persistent hierarchy conflict.
- Armenian labels are sometimes reduced rather than allowed to wrap or use a shorter localized term.

## Implementation plan

1. **Batch 1 — accessibility fundamentals (implemented):** zoom, drawer modality/focus, search names, touch targets, semantic plan tabs.
2. **Batch 2 — interaction consistency:** shared keyboard menu/radiogroup behavior, explicit button types, localized relative time, remaining target-size fixes.
3. **Batch 3 — responsive typography:** meaningful-text minimums, Armenian wrapping, 200% zoom and 320px-width corrections.
4. **Batch 4 — component cleanup:** remove static inline styles, consolidate close/add controls, document spacing/type/target tokens.
5. **Batch 5 — visual-system contrast:** adjust tertiary text, borders, and filled-accent states after approval; verify both themes.
6. **Batch 6 — information architecture (approval required):** simplify Dashboard, Map controls, bottom navigation, and privileged Settings/Admin structure.
7. **Release validation:** automated checks, keyboard pass, VoiceOver/TalkBack pass, English/Armenian, light/dark, portrait/landscape, 320–430px phones, tablet, 200% zoom, and offline/GPS-denied flows.

## Approval-required proposals

No work in this section should begin without product confirmation.

1. **Navigation architecture:** replace the permanently emphasized raised Map tab with a conventional equal-weight tab bar, or reduce primary tabs and move secondary destinations into Menu.
2. **Map control consolidation:** move secondary controls into one expandable tool button or bottom sheet, leaving locate, add, and the active filter immediately visible.
3. **Settings split:** separate personal Settings from an Admin workspace for team, approvals, catalog, notification defaults, and exports.
4. **Dashboard prioritization:** make Next Visit the single dominant task, collapse duplicate summary information, and move secondary analytics below a progressive-disclosure section.
5. **Global contrast refresh:** strengthen tertiary text and component boundaries and introduce separate accent tokens for foreground links versus filled controls in dark mode.

## Approved implementation status

Approved on 2026-08-25 and implemented without changing the five-item primary navigation:

- Map secondary controls consolidated into an accessible expandable tools group.
- Settings split into Personal and Admin workspaces with tab semantics and keyboard navigation.
- Dashboard reprioritized around Next Visit; duplicate summary tiles removed and analytics moved into progressive disclosure.
- Global contrast system refreshed with separate filled-accent and interactive-boundary tokens for light and dark themes.

## Validation limitation

Static implementation, semantics, CSS, localization, and automated regression checks are covered here. Final compliance still requires testing the deployed authenticated application on physical devices with VoiceOver/TalkBack and at 200% zoom; automated review cannot certify those behaviors alone.
