# Control Room design

The design reference for Control Room: the principles behind the interface and
the visual and interaction decisions that hold it together. If the code and this
document disagree, one of them is wrong.

Scope, trust boundaries, and architecture invariants live in AGENTS.md. What each
view does for a user lives in the manual under `docs/`. This file covers how the
interface looks and behaves.

> The palette and layout rules below are not aspirational. Automated tests check
> them on every commit (see [Guardrails](#guardrails)).

---

## Design principles

1. **Instrument, not dashboard.** Control Room is scanned and operated, not read
   top to bottom. Density and legibility beat decoration. No hero banners, no
   metric-card walls, no gradients. Show the summary first, put state into form
   (a dot, a chip, an accent bar), and give the terminal the room.

2. **Monochrome with intent.** The interface is near-black and greyscale. The
   only built-in non-neutral colours are three status hues (success, warning,
   failure). User-picked Connection Tag colors are the one metadata exception.
   They identify machines and never imply health. Colour always has a job here,
   and the tests enforce the built-in palette.

3. **Keyboard-first, desktop-native.** Real window chrome, a command palette,
   discoverable shortcuts, split panes, focus mode. Nothing important is
   mouse-only, and nothing important is a hidden keyboard-only trick.

4. **Safe by construction.** Remote operations are read-only, sudo is off until
   the user allows it, and nothing sensitive is persisted. The UI never implies
   more reach than the boundaries in AGENTS.md allow, and it says when a fact is
   missing rather than drawing a zero.

5. **Honest feedback.** Every asynchronous view has explicit loading, empty, and
   error states. Destructive actions look distinct and get confirmed in the
   app's own dialogs, never a bare OS `prompt` or `confirm`. Copy says exactly
   what will happen.

6. **A system, not a pile of styles.** One token set governs colour, type,
   spacing, radius, elevation, and motion. New UI composes existing tokens and
   components instead of inventing one-off values.

---

## Layout and information architecture

A CSS grid with a 42 px custom titlebar row and a 244 px sidebar column. The
window enforces a 960 x 640 minimum, below 1120 px the sidebar and page padding
tighten, and page content is capped at 980 px so a wide window does not stretch
a dense list into a banner.

Navigation is two levels and never nests deeper.

- **Left rail.** The connection list is divided into manually ordered,
  collapsible groups plus a derived Ungrouped section. Search matches connection
  names, SSH targets, group names, and tags. Once a remote Workspace is open, the
  rail also holds the view switcher (Overview, Terminal, Systemd, Ports, Docker,
  Boot, Logs, Baselines, History, Scratchpad); a local Workspace shows none of
  it, because there is no Remote Host to inspect. "Local terminal" and "Add
  connection" are pinned at the bottom, the launcher listing only the shells this
  machine actually has.
- **Workspace tab strip.** One tab per open Workspace across the top of the main
  area, plus "New terminal" and the split and focus controls.
- **Main area.** The active view. Terminal panes stay mounted but hidden across
  view switches, so navigation never tears a session down.

Identity shows once per place, never duplicated into a redundant "status rail".
The host OS mark and a session presence dot carry identity and liveness in the
rail and tabs. The labelled connection status stays in the Terminal toolbar.

A distraction-free terminal focus mode, toggled by button, hides the rail and
titlebar and can tile several sessions as split panes.

---

## Visual language

### Colour

A greyscale system on a near-black ground. Depth comes from making surfaces
lighter as they rise, the standard move for dark UIs, not from heavy shadows.

The only built-in non-neutral colours in the UI are three status hues. They carry
meaning (connection and session state, systemd unit and container state, command
exit status, inline messages) and never act as accents.

| Role    | Hex       | Meaning                                           |
| ------- | --------- | ------------------------------------------------- |
| Success | `#42d17a` | connected, running, active, exit 0                |
| Warning | `#d6a84a` | connecting, sudo-required, paused                 |
| Failure | `#ef5b6b` | error, failed or dead, non-zero exit, destructive |

The accent is off-white (`#f2f2ee`): the primary button, the "you are here" bar
and underline, and focus rings. Even error and warning surfaces stay neutral
grey, and the status hue shows only in the border and text.

Connection Tag badges may use a color selected by the user. The badge uses that
hue for its text, a translucent version for its background, and a stronger
translucent version for its border. The renderer lightens selections that would
not stay legible on Control Room's dark surfaces. A tag color never communicates
runtime state.

### Typography

Two families, one for chrome and one for anything technical.

- **Space Grotesk.** A bundled variable font (weights 300-700) for all UI chrome.
  It is a squared grotesque that stays sharp at the dense 10-13 px sizes the
  interface lives at, which gives the app a voice instead of the default system
  look. It ships as `woff2` so the desktop build works offline with no fallback
  flash, and the system stack is the fallback.
- **Cascadia Mono, then Consolas, then monospace** for the terminal, logs, code,
  unit and container names, Compose identities, container IDs, and history
  commands.

The type scale is small: 20 px section headings, ~17 px stat values, 12.5 px
body, 11.5 px controls, and 10 px uppercase labels with tracking. Numeric columns
use `tabular-nums`.

### Spacing, radius, elevation, motion

- **Spacing.** A consistent rhythm, not arbitrary values. Layout uses flex or
  grid `gap`, not per-element margins that collapse.
- **Radius.** A three-step scale, 4/6/8 px (small controls, then menus and cards,
  then modals). Connection Tag badges and their color wells are the circular
  exceptions.
- **Elevation.** The surface ramp below, plus two neutral shadow tokens for
  popovers and modals.
- **Motion.** Quiet on purpose. Roughly 110 ms on interactions, 160 ms on overlay
  entrances, all off under `prefers-reduced-motion`.

### Icons

`lucide-react`, sized 13-18 px by context, `strokeWidth` ~1.8 for nav and marks.
Host OS marks use the Debian and Ubuntu logos (Simple Icons, CC0) with a generic
server glyph as fallback, overlaid with the session presence dot.

---

## Design tokens

All values are CSS custom properties on `:root` in `src/styles.css`. Neutral
tokens must stay neutral (RGB channels within 4 of each other). The three status
hues above are the only exceptions.

**Base palette**

| Token                                   | Value                             |
| --------------------------------------- | --------------------------------- |
| `--app-bg`                              | `#090909`                         |
| `--sidebar-bg`                          | `#050505`                         |
| `--topbar-bg` / `--terminal-bg`         | `#000`                            |
| `--text`                                | `#f2f2ee`                         |
| `--text-muted`                          | `#adadaa`                         |
| `--text-faint`                          | `#7a7a77`                         |
| `--text-strong`                         | `#fff`                            |
| `--accent` / `--accent-hover`           | `#f2f2ee` / `#fff`                |
| `--on-accent`                           | `#000`                            |
| `--success` / `--warning` / `--failure` | `#42d17a` / `#d6a84a` / `#ef5b6b` |

**Surface elevation ramp** (lighter is higher)

| Token               | Value     | Use                                  |
| ------------------- | --------- | ------------------------------------ |
| `--surface-sunken`  | `#050505` | inputs, terminal, log wells, sidebar |
| `--surface-base`    | `#090909` | main content                         |
| `--surface-chrome`  | `#070707` | tab strip, toolbars, pane headers    |
| `--surface-raised`  | `#161616` | hover fills, cards                   |
| `--surface-overlay` | `#1c1c1c` | menus, modals, the command palette   |

**Interaction fills and borders**

| Token                                     | Value                 |
| ----------------------------------------- | --------------------- |
| `--fill-hover`                            | `#1a1a1a`             |
| `--fill-active`                           | `#242424`             |
| `--fill-selected`                         | `#2a2a2a`             |
| `--fill-control` / `--fill-control-hover` | `#171717` / `#242424` |
| `--border-strong`                         | `#454545`             |
| `--border`                                | `#343434`             |
| `--border-subtle`                         | `#232323`             |
| `--border-faint`                          | `#1a1a1a`             |

**Radius and motion**

| Token                                         | Value                        |
| --------------------------------------------- | ---------------------------- |
| `--radius-sm` / `--radius-md` / `--radius-lg` | `4px` / `6px` / `8px`        |
| `--motion-fast` / `--motion-med`              | `110ms` / `160ms`            |
| `--ease`                                      | `cubic-bezier(0.2, 0, 0, 1)` |
| `--shadow-popover` / `--shadow-modal`         | neutral drop shadows         |

**Terminal ANSI defaults.** User-editable in Settings and live-previewed. This is
the remote-content palette, not part of the monochrome chrome.

| Slot                | Default   |
| ------------------- | --------- |
| Foreground / cursor | `#f2f2ee` |
| Red (errors)        | `#ff6f7d` |
| Green (prompts)     | `#52cf91` |
| Yellow              | `#e8c56c` |
| Blue (directories)  | `#55aef2` |
| Magenta             | `#c793ff` |
| Cyan                | `#65d4d1` |

---

## Interaction and state

Every interactive element runs the same states: default, hover (`--fill-hover`),
active or selected (`--fill-active` / `--fill-selected`), focus-visible (a 2 px
accent ring), and disabled (0.4 opacity, `not-allowed`). A 2 px accent bar marks
selection and "you are here" on rail rows, nav items, and list rows. The active
tab uses an underline instead. Same idea either way.

**Session presence.** Connection rows and Workspace tabs carry a small presence
dot on the OS mark: green for connected, amber for connecting, red for error,
grey for disconnected. Live sessions read at a glance. The dot's ring colour
matches the row or tab background, so it looks cut out of the icon.

**Connection organization.** A Saved Connection can belong to one group and carry
up to twelve case-insensitive, color-coded tags. The organization dialog owns tag
creation, renaming, color selection, and deletion; the Saved Connection editor
only assigns existing tags.

**Panel states.** Every data view separates loading (spinner and label), empty
(icon and guidance), and error (icon, message, and retry). Cached lists show
stale data with a warning rather than going blank, and past a day old a cached
pane says how old the facts are instead of presenting them as current.

**Elevated commands.** Permission and capability are separate, and the UI says
both. The global switch in Settings is an override, so while it is on the
per-host checkbox is checked, disabled, and captioned with the reason, and the
host keeps its own value underneath. Whether the account has passwordless sudo is
a host fact, reported in Overview beside systemd, journald, and Docker, and under
the editor's checkbox once "Test structured access" has run; without it, allowing
sudo on an account that sudo questions looks like it did nothing. A pane that
hits a permission wall offers "Retry with sudo" whatever the switch says, because
elevating one request stays possible on a host that allows nothing.

**Dialogs are in-app, never native.** A shared `Modal` backs `PromptDialog` (text
input, used for renaming a Workspace) and `ConfirmDialog` (message with
confirm/cancel, and a red danger variant for destructive actions). Deleting a
connection, closing a connected Workspace, discarding Settings, clearing History,
removing the integration, and installing an update all route through these. No
native `prompt` or `confirm` survives anywhere.

**Command palette.** `Ctrl+Shift+P` opens a palette that searches open terminals,
connections, workspace views, and contextual actions. It follows the
combobox/listbox pattern with `aria-activedescendant`, arrow, Home, End, Enter,
and Escape keys, a focus trap, and focus restoration. It is the fastest way
through a multi-connection setup.

**Terminal.** One pane and toolbar serve every session, with split panes and
focus mode for tiling. xterm draws bold text with weight rather than from the
bright palette (`drawBoldTextInBrightColors: false`), so a bold `01;34` directory
shows exactly the "Blue" configured in Settings and the colour preview stays
honest.

A local shell borrows that pane with local words: it is _running_ rather than
_connected_, and _stopped_ and _restarted_ rather than disconnected and
reconnected. A shell that exits on its own keeps its Workspace, says so in the
pane notice, and offers Restart, because an exited shell is an ordinary event and
losing the tab would be the surprise.

**Opening terminals.** "New terminal" and Split share one grouped,
keyboard-navigable target list and differ in what they do with the answer. "New
terminal" offers every Saved Connection and every installed local shell, and each
selection opens its own Workspace, so picking the active target gives a second
independent terminal instead of changing the Workspace the menu came from. Split
adds the group "New terminal" cannot have, the terminals already open, and lists
existing terminals, new local shells, then new Saved Connections. Empty groups
are dropped, so a machine with no local shells shows no heading for them.

---

## Components

New UI composes the primitives in `src/components/` rather than restyling their
insides: `Modal` (the accessible dialog shell behind every dialog, labelled, with
Esc and backdrop close and focus trap and restore), `PromptDialog` and
`ConfirmDialog`, `CommandPalette`, `PanelState` (`LoadingState`, `EmptyState`,
`ErrorState`), `HostOsIcon`, `StatusDot`, `WindowControls`, `TerminalPane`,
`TerminalTargetMenu` (the shared list behind "New terminal" and Split),
`ResourceMeter`, `UpdateIndicator`, and `ReleaseNotes` with `WhatsNewDialog`.

Shared layout patterns: the split page (a dense list beside a detail panel) used
by Systemd, Ports, Docker, and Baselines; the definition grid and capability list
on the Overview host dashboard; the dense row with a leading status indicator;
and the compact chip for exit codes, counts, and section states.

---

## Displaying host data

These rules apply wherever a pane shows what a host reported. What each pane
collects is in AGENTS.md and its tests; what it means for a user is in `docs/`.

- **Magnitude, not verdict.** The Overview load meters are neutral grey. Length
  carries the value, and a status hue would imply a judgement on whether 80% is
  bad, which depends on the host and not on the app.
- **Absence looks like absence.** A reading the host did not return says so
  instead of drawing a zero, because a flat line at the bottom is
  indistinguishable from an idle machine. The same holds for a baseline section
  that was never captured and for a listener whose owner could not be resolved.
- **States stay distinct.** The five baseline section states use the three status
  hues plus a neutral dashed chip, and each chip carries the sentence that
  separates it from its neighbours, because the difference between an absent
  subsystem and an unreadable one decides what the user does next.
- **Say the boundary in the pane.** Panes that repeat a read or discard one say
  so in place: the Overview meters name their cadence and say nothing is kept,
  and a live baseline comparison names that side Live state and says the read was
  discarded. A chart that appears to be recording invites the question of where
  the recording went.
- **Bounded views stay searchable.** Long lists get a filter, failures sort
  first, and copy and export write exactly what the panel shows, filter included.

**Updates are designed to be missable.** Control Room updating itself is
infrastructure, not a feature competing for attention. While the app is current
the titlebar is untouched. When an update exists it earns two quiet words next to
Settings and a small dot, never a banner, a toast, a badge, or a colour the
palette does not already have. The dot turns `--success` only once an update is
downloaded and waiting, the one state where something is left to decide. Its
details popover drops out of the titlebar, which layers above the session strip
so the strip can never paint over the panel. A failed automatic check shows
nothing at all, because an unreachable release feed is not an application error.

---

## Keyboard model

Shortcuts exist only where they earn their place, and each one is discoverable
through the palette, tooltips, or empty-state hints. We skip browser and WebView
combinations like `Ctrl+Shift+N` and `F11`, because the WebView eats them before
the app sees them. Those actions live on buttons and in the palette instead.

| Shortcut       | Action                                      |
| -------------- | ------------------------------------------- |
| `Ctrl+Shift+P` | Open the command palette                    |
| `Ctrl+Shift+T` | Switch the active Workspace to its Terminal |
| `Ctrl+Shift+R` | Reconnect or restart the active session     |
| `Ctrl+Shift+W` | Close the active Workspace                  |

The terminal lets these bubble up to the app and keeps copy and paste on
`Ctrl+Shift+C` and `Ctrl+Shift+V`. Every other key goes to the shell.

Right click inside the terminal is the terminal's own convention rather than a
preference, because a clipboard gesture that half the users have turned off is a
gesture nothing can rely on. AGENTS.md holds the rule; the design consequence is
that Settings offers no switch for it, and that a context-menu key press is left
alone because no button opened it.

---

## Accessibility

- **Contrast.** The text hierarchy and the three status colours meet WCAG AA, and
  the main text clears AAA. Tests check this against the actual backgrounds.
- **Focus.** A consistent 2 px accent focus-visible ring on every interactive
  element, sized and contrasted for WCAG 2.2 Focus Appearance, and it never clips
  inside dense rows.
- **Semantics.** Real buttons and inputs, dialog roles with accessible names, the
  palette's combobox and listbox roles, `aria-current` on the active view and
  tab, labelled window controls, and `aria-label`s on icon-only controls.
- **Colour is never the only signal.** Status is shape-coded (a dot, a rotated
  square, a ring) and text-labelled.
- **Motion.** Every transition and animation collapses under
  `prefers-reduced-motion: reduce`.
- **Hit targets.** Interactive controls meet a comfortable minimum. Hover-only
  affordances (a tab close, row actions) stay keyboard-reachable via
  `:focus-within` and are not clickable while hidden.

---

## Guardrails

Two test files encode the design decisions that must not drift.

- **`src/color-palette.test.ts`** scans every built-in hex and rgb literal in
  `src/styles.css` and fails unless the only non-neutral colours are exactly the
  three status hues. Runtime Connection Tag colors are stored data, not
  stylesheet literals. It also checks WCAG contrast for the text hierarchy, the
  accent, and the status colours, and pins the terminal ANSI defaults.
- **`src/ui-hierarchy.test.ts`** locks the structure: the titlebar row, the
  bounded connection list and content cap, terminal padding on the xterm element,
  focus-mode rules, session presence in navigation, in-app rather than native
  confirms, the global elevation switch alongside the per-pane sudo retries, the
  update control's place left of Settings, one owner for the update lifecycle, no
  `dangerouslySetInnerHTML` anywhere in the updater path, and the exact counts of
  host-OS marks, drag regions, and window controls in the shell.

Both, plus the Rust suite, run under `npm run check` (format, lint, test, build)
and in CI. When you change the UI, keep them green. If a change is a real design
decision, update the guardrail in the same commit and say why.

---

## Non-goals

Control Room stays a focused inspector, and the scope exclusions in AGENTS.md are
the list. Skipped on purpose: the AI-terminal direction, mobile and cloud sync,
and SaaS-dashboard styling. None of it fits a local, read-only, single-user
inspector. New work should sharpen the existing views and their contextual
actions, measured against the principles above, before it adds another panel.
