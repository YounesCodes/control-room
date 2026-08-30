# Control Room design

The design reference for Control Room: what it is, the principles behind it, and
the visual and interaction decisions that hold it together. This is where design
intent is written down. If the code and this document disagree, one of them is
wrong.

> The palette and layout rules below are not aspirational. Automated tests check
> them on every commit (see [Guardrails](#guardrails)).

---

## Contents

1. [What Control Room is](#what-control-room-is)
2. [Design principles](#design-principles)
3. [Product architecture](#product-architecture)
4. [Technical foundation](#technical-foundation)
5. [Visual language](#visual-language)
6. [Design tokens](#design-tokens)
7. [Interaction and state](#interaction-and-state)
8. [Components](#components)
9. [Keyboard model](#keyboard-model)
10. [Accessibility](#accessibility)
11. [Influences](#influences)
12. [Guardrails](#guardrails)
13. [Non-goals and future](#non-goals-and-future)

---

## What Control Room is

Control Room is a local Windows desktop app for opening interactive SSH sessions
and inspecting Linux hosts. It drives the machine's own Windows OpenSSH client
and ConPTY instead of shipping a second SSH stack, so it reuses your existing
keys, `~/.ssh/config`, and agent.

The first release targets Windows 11 x64 and Debian/Ubuntu-family hosts with
systemd, journald, Bash, and optional Docker. Other Linux systems still work as
terminal-only destinations.

Who it's for: developers and operators who keep a handful of Linux servers and
want a fast, keyboard-driven cockpit. Open a shell, glance at host health, read
services and containers, tail logs, recall exact commands. No web console, no
agent on the host, no second credential store.

The core loop: pick a saved connection and a Workspace opens with a live
terminal. From there you jump to Overview, Services, Docker, Logs, or History as
you need, open more sessions, split them, or move on. Everything the app does to
a remote host is read-only. The terminal is the only place arbitrary commands
run, and you type those yourself.

---

## Design principles

1. **Instrument, not dashboard.** Control Room is scanned and operated, not read
   top to bottom. Density and legibility beat decoration. No hero banners, no
   metric-card walls, no gradients. Show the summary first, put state into form
   (a dot, a chip, an accent bar), and give the terminal the room.

2. **Monochrome with intent.** The interface is near-black and greyscale. The
   only non-neutral colours are three status hues (success, warning, failure).
   So colour always means something here. It is never decoration. That restraint
   is the product's identity, and the tests enforce it.

3. **Keyboard-first, desktop-native.** Real window chrome, a command palette,
   discoverable shortcuts, split panes, focus mode. Nothing important is
   mouse-only, and nothing important is a hidden keyboard-only trick.

4. **Safe by construction.** Remote operations are read-only. The app never
   persists terminal output, fetched logs, SSH or sudo passwords, or private
   keys. A sudo retry is allowed only after a permission error, and it is never
   saved. Rust owns process and argument construction. React never receives
   arbitrary shell execution.

5. **Honest feedback.** Every asynchronous view has explicit loading, empty, and
   error states. Destructive actions look distinct and get confirmed in the
   app's own dialogs, never a bare OS `prompt` or `confirm`. Copy says exactly
   what will happen.

6. **A system, not a pile of styles.** One token set governs colour, type,
   spacing, radius, elevation, and motion. New UI composes existing tokens and
   components instead of inventing one-off values.

---

## Product architecture

### Domain model

The vocabulary is small, and every entity has an ID. A Saved Connection (a
reusable SSH destination) opens one or more Workspaces, each pairing a live
Terminal Session with read-only inspection views. Structured Operations (host
facts, services, containers) and Log Streams run independently of the terminal,
and Enhanced History is an opt-in local record of commands. AGENTS.md carries the
exact term definitions.

### Information architecture

Navigation is two levels and never nests deeper.

- **Left rail.** The connection list (search plus saved connections). Once a
  Workspace is open, the rail also holds the view switcher (Overview, Terminal,
  Services, Docker, Logs, History), with "Add connection" pinned at the bottom.
- **Workspace tab strip.** One tab per open Workspace across the top of the main
  area, plus "New terminal" and the split and focus controls.
- **Main area.** The active view. Terminal panes stay mounted but hidden across
  view switches, so navigation never tears a session down.

Identity shows once per place, never duplicated into a redundant "status rail".
The host OS mark and a session presence dot carry identity and liveness in the
rail and tabs. The labelled connection status stays in the Terminal toolbar.

### Shell layout

A CSS grid with a 42 px custom titlebar row and a ~244 px sidebar column. The
window enforces a 960 x 640 minimum, and below ~1120 px the sidebar and page
padding tighten. A distraction-free terminal focus mode (toggled by button)
hides the rail and titlebar and can tile several sessions as split panes.

---

## Technical foundation

Control Room is a Tauri 2 app: a Rust core behind a WebView2 frontend on
Windows.

**Frontend.** React 19 and TypeScript, built with Vite 8. The terminal is
`@xterm/xterm` v6 with the fit addon, and icons come from `lucide-react`. State
is plain React state, with no global store. Tests run on Vitest and Testing
Library (jsdom).

**Backend.** Rust (edition 2024) with `rusqlite` (bundled SQLite), `chrono`,
`uuid`, and `windows-sys`. It shells out to the system OpenSSH client and drives
ConPTY for the interactive terminal.

The safety model shapes the UI. Remote operations are read-only, and the app
never persists terminal output, fetched logs, passwords, or private keys. SQLite
holds only connections, settings, capabilities, History, and _disconnected_
Workspace layout, so a restored Workspace always comes back disconnected and
never auto-reconnects. Structured features need non-interactive public-key or
agent auth, though the terminal still shows ordinary OpenSSH prompts. AGENTS.md
carries the full architecture and data rules.

One xterm detail worth knowing: xterm draws bold text with weight, not from the
bright palette (`drawBoldTextInBrightColors: false`). So a bold `01;34` directory
shows exactly the "Blue" you configured, which keeps the terminal and the
Settings colour preview in agreement.

---

## Visual language

### Colour

A greyscale system on a near-black ground. Depth comes from making surfaces
lighter as they rise, the standard move for dark UIs, not from heavy shadows.

The only non-neutral colours in the whole UI are three status hues. They carry
meaning (connection and session state, service and container state, command exit
status, inline messages) and never act as accents.

| Role    | Hex       | Meaning                                           |
| ------- | --------- | ------------------------------------------------- |
| Success | `#42d17a` | connected, running, active, exit 0                |
| Warning | `#d6a84a` | connecting, sudo-required, paused                 |
| Failure | `#ef5b6b` | error, failed or dead, non-zero exit, destructive |

The accent is off-white (`#f2f2ee`): the primary button, the "you are here" bar
and underline, and focus rings. Even error and warning surfaces stay neutral
grey, and the status hue shows only in the border and text. The tests enforce
this (see [Guardrails](#guardrails)).

### Typography

Two families, one for chrome and one for anything technical.

- **Space Grotesk.** A bundled variable font (weights 300-700) for all UI chrome.
  It is a squared grotesque that stays sharp at the dense 10-13 px sizes the
  interface lives at, which gives the app a voice instead of the default system
  look. It ships as `woff2` so the desktop build works offline with no fallback
  flash, and the system stack is the fallback.
- **Cascadia Mono, then Consolas, then monospace** for the terminal, logs, code,
  service and container names, container IDs, and history commands.

The type scale is small: 20 px section headings, ~17 px stat values, 12.5 px
body, 11.5 px controls, and 10 px uppercase labels with tracking. Numeric columns
use `tabular-nums`.

### Spacing, radius, elevation, motion

- **Spacing.** A consistent rhythm, not arbitrary values. Layout uses flex or
  grid `gap`, not per-element margins that collapse.
- **Radius.** A three-step scale, 4/6/8 px (small controls, then menus and cards,
  then modals). It replaced an earlier scatter of 2/3/5.
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

**Panel states.** Every data view separates loading (spinner and label), empty
(icon and guidance, such as the Logs and History empty states), and error (icon,
message, and retry, with a "Retry with sudo" affordance where a permission error
allows it). Cached lists show stale data with a warning rather than going blank.

**Dialogs are in-app, never native.** A shared `Modal` backs `PromptDialog` (text
input, used for renaming a Workspace) and `ConfirmDialog` (message with
confirm/cancel, and a red danger variant for destructive actions). Deleting a
connection, closing a connected Workspace, discarding Settings, clearing History,
and removing the integration all route through these. No native `prompt` or
`confirm` survives anywhere.

**Command palette.** `Ctrl+Shift+P` opens a palette that searches open terminals,
connections, workspace views, and contextual actions. It follows the
combobox/listbox pattern with `aria-activedescendant`, arrow, Home, End, Enter,
and Escape keys, a focus trap, and focus restoration. It is the fastest way
through a multi-connection setup. If I had to keep one keyboard feature, this is
the one.

**Terminal.** ConPTY-backed xterm with Unicode, ANSI, and VT output, resize,
scrollback, copy and paste, and control keys (Vim, top, tmux, and the rest).
Reconnect after a drop, or clear the local buffer without sending anything to the
host. Several sessions per connection, with split panes and focus mode for
tiling.

---

## Components

Reusable primitives in `src/components/` that everything else composes.

- **Modal.** The accessible dialog shell (labelled, Esc and backdrop close, focus
  trap and restore). It backs ConnectionDialog, CredentialDialog, PromptDialog,
  and ConfirmDialog.
- **PromptDialog and ConfirmDialog.** The in-app replacements for native dialogs.
- **CommandPalette.** The command palette.
- **PanelState.** `LoadingState`, `EmptyState`, and `ErrorState`.
- **HostOsIcon.** The OS mark with its presence badge.
- **StatusDot and WindowControls.** The status indicator and the custom titlebar
  buttons.
- **TerminalPane.** The xterm host and session lifecycle.

Shared patterns: the split page (a dense list beside a detail panel) used by
Services and Docker; the definition grid and capability list on the Overview host
dashboard; the dense row with a leading status indicator; and the compact chip
for exit codes and counts.

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
| `Ctrl+Shift+R` | Reconnect the active Terminal Session       |
| `Ctrl+Shift+W` | Close the active Workspace                  |

The terminal lets these bubble up to the app and keeps copy and paste on
`Ctrl+Shift+C` and `Ctrl+Shift+V`. Every other key goes to the remote shell.

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

## Influences

The design borrows specific, proven patterns instead of cloning any one product.

- **Session and terminal managers.**
  [Termius](https://termai.sh/blog/termius-vs-warp/) and
  [Tabby](https://sourceforge.net/software/product/Tabby.sh/alternatives) for
  connection lists, per-session state, and tab grouping and search, plus the
  modern expectation that live sessions are visible at a glance.
- **Terminals.** [Warp](https://docs.warp.dev/terminal/windows/tabs/) and
  [Windows Terminal](https://learn.microsoft.com/windows/terminal/) for tab
  strips with hover-revealed controls, split panes, a fast terminal, and session
  restoration.
- **[VS Code](https://code.visualstudio.com/)** for the command palette on
  `Ctrl+Shift+P` and a dense, calm dark chrome.
- **Host consoles.** Lens, Portainer, and Cockpit for the Overview as a real host
  dashboard: a stat strip over grouped facts and semantic capability status.
- **Guidance.** WCAG 2.2 (focus appearance, target size, non-text contrast),
  Refactoring UI and dark-UI elevation practice (depth from lighter surfaces, not
  shadows), and Nielsen Norman Group on feedback, empty and error states, and
  keyboard navigation.

What we skipped, on purpose: the AI-terminal direction (Warp), mobile and cloud
sync (Termius), and SaaS-dashboard styling. None of it fits a local, read-only,
single-user inspector.

---

## Guardrails

Two test files encode the design decisions that must not drift.

- **`src/color-palette.test.ts`** scans every hex and rgb literal in
  `src/styles.css` and fails unless the only non-neutral colours are exactly
  `#42d17a`, `#d6a84a`, and `#ef5b6b`. It also checks WCAG contrast for the text
  hierarchy, the accent, and the status colours, and it pins the terminal ANSI
  defaults. This is what makes "monochrome with intent" a fact instead of a hope.
- **`src/ui-hierarchy.test.ts`** locks the structure: the 42 px titlebar row, the
  bounded connection list and 980 px content cap, terminal padding on the xterm
  element, focus-mode rules, session presence in navigation, the in-app (not
  native) discard confirm, and the exact counts of host-OS marks, drag regions,
  and window controls in the shell.

Both, plus the Rust suite, run under `npm run check` (format, lint, test, build)
and in CI. When you change the UI, keep them green. If a change is a real design
decision, update the guardrail in the same commit and say why.

---

## Non-goals and future

Control Room stays a focused inspector. The features it leaves out (file
transfer, container management, cloud sync, AI, and the rest) are the scope
exclusions in AGENTS.md. New work should sharpen the existing features and their
contextual actions before it adds another panel.

Worth doing later, still in scope: connection tags or grouping in the rail,
recent and pinned ordering in the palette, and more density and responsive
tuning. Each one additive, each one measured against the principles above.
