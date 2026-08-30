# Control Room — Design

This document is the design reference for Control Room: what it is, the
principles behind it, and the concrete visual, interaction, and architectural
decisions that make it feel like one deliberate desktop product. It is the
source of truth for design intent — when code and this document disagree, treat
the disagreement as a bug in one of them.

> Scope note: the design system described here is implemented across the app's
> UI overhaul. The colour palette and layout invariants below are enforced by
> automated tests (see [Guardrails](#guardrails)), so they are not just
> aspirational — they are checked on every commit.

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

Control Room is a **local Windows desktop application for opening interactive
SSH sessions and inspecting Linux hosts**. It drives the machine's own Windows
OpenSSH client and ConPTY rather than shipping a second SSH stack, so it inherits
the user's existing keys, `~/.ssh/config`, and agent.

The first release targets **Windows 11 x64** connecting to **Debian/Ubuntu-family
hosts** with systemd, journald, Bash, and optional Docker. Other Linux systems
still work as terminal-only destinations.

**Who it is for.** Developers and operators who keep a handful of Linux servers
and want a fast, keyboard-driven cockpit: open a shell, glance at host health,
read services and containers, tail logs, and recall exact commands — without a
web console, an agent on the host, or a second credential store.

**The core loop.** Pick a saved connection → a Workspace opens with a live
terminal → jump to Overview / Services / Docker / Logs / History as needed → open
more sessions, split them, or move on. Everything the app does to a remote host
is **read-only**; the terminal is the only place arbitrary commands run, and the
user types those themselves.

---

## Design principles

1. **Instrument, not dashboard.** Control Room is scanned and operated, not read
   top-to-bottom. Density and legibility beat decoration. No hero banners, no
   metric-card walls, no gradients — surface the summary, put state into form
   (a dot, a chip, an accent bar), and let the terminal be the star.

2. **Monochrome with intent.** The interface is a near-black, grayscale control
   surface. The only non-neutral colours are three semantic status hues
   (success / warning / failure). Colour therefore always _means_ something;
   it is never brand decoration. This restraint is the product's identity and is
   test-enforced.

3. **Keyboard-first, desktop-native.** Real window chrome, a command palette,
   discoverable shortcuts, split panes, focus mode, and native-feeling
   interactions. Nothing important is mouse-only, and nothing important is a
   hidden keyboard-only trick.

4. **Safe by construction.** Remote operations are read-only. The app never
   persists terminal output, fetched logs, SSH/sudo passwords, or private keys.
   A sudo retry is allowed only after a permission error and is never saved.
   Rust owns process/argument construction; React never receives arbitrary shell
   execution.

5. **Honest feedback.** Every asynchronous surface has explicit loading, empty,
   and error states. Destructive actions are visually distinct and confirmed in
   the app's own dialogs — never a bare OS `prompt`/`confirm`. Copy says exactly
   what will happen.

6. **A system, not a pile of styles.** One token set governs colour, type,
   spacing, radius, elevation, and motion. New UI composes existing tokens and
   components rather than inventing one-off values.

---

## Product architecture

### Domain model

The app's language is deliberately small and every entity is addressed by ID:

| Term                     | Meaning                                                                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Saved Connection**     | A reusable SSH destination + username, with optional port or identity-file overrides.                                                                                    |
| **Remote Host**          | The Linux system reached through a connection. Several connections may point at one host.                                                                                |
| **Workspace**            | An open view of one connection that groups a Terminal Session with the inspection views. A connection can have several Workspaces.                                       |
| **Terminal Session**     | One interactive SSH shell inside a Workspace. Its state belongs to the session, not the connection.                                                                      |
| **Structured Operation** | A bounded, read-only inspection request (host facts, services, containers) that runs independently of the terminal.                                                      |
| **Log Stream**           | A live journald or Docker log reader with its own lifecycle, held only in memory.                                                                                        |
| **Enhanced History**     | An opt-in, Bash-only local record of commands reported by an installed shell integration — never inferred from keystrokes, never imported from the host's shell history. |

### Information architecture

Navigation is two-level and never nests deeper:

- **Left rail (persistent):** the connection list (search + saved connections),
  then — once a Workspace is open — the Workspace's view switcher
  (Overview · Terminal · Services · Docker · Logs · History), and a primary
  "Add connection" action pinned at the bottom.
- **Workspace tab strip (top of the main area):** one tab per open Workspace,
  plus "New terminal" and the split/focus controls.
- **Main area:** the active view. Terminal panes persist (mounted but hidden)
  across view switches so a session is never torn down by navigation.

Identity is shown once per location and never duplicated into a redundant
"status rail" — the host OS mark plus a session **presence dot** carry identity
and liveness in the rail and tabs; the labelled connection status lives in the
Terminal toolbar.

### Shell layout

A CSS grid: a **42 px custom titlebar row** and a **~244 px sidebar column**.
The window enforces a **960 × 640 minimum**; below ~1120 px the sidebar and page
padding tighten. A distraction-free **terminal focus mode** (toggled by button)
hides the rail and titlebar and can tile multiple sessions as split panes.

---

## Technical foundation

Control Room is a **Tauri 2** application: a Rust core behind a WebView2
(Windows) frontend.

**Frontend** — React 19 + TypeScript, built with Vite 8. The terminal is
`@xterm/xterm` v6 with the fit addon; icons are `lucide-react`. State is local
React state; there is no global store. Tests run on Vitest + Testing Library
(jsdom).

**Backend** — Rust (edition 2024) with `rusqlite` (bundled SQLite) for local
persistence, `chrono`, `uuid`, and `windows-sys`. It shells out to the system
OpenSSH client and drives ConPTY for the interactive terminal.

**Data-flow rules (invariants):**

- Rust owns native process management, SQLite, SSH argument construction, and
  remote command construction. React never receives arbitrary shell execution.
- IDs address every Saved Connection, Workspace, Terminal Session, Structured
  Operation, and Log Stream.
- The app never persists terminal output, fetched logs, SSH/sudo passwords, or
  imported private keys. Saved to SQLite: connections, settings, capabilities,
  History, and _disconnected_ Workspace layout.
- Restored Workspaces come back **disconnected**; the app never auto-reconnects.
- Structured features require non-interactive public-key/agent auth; the
  interactive terminal can still show ordinary OpenSSH prompts.

**xterm note.** Bold text is drawn with weight, not the bright palette
(`drawBoldTextInBrightColors: false`), so a bold `01;34` directory renders in
exactly the "Blue" the user configured — keeping the terminal consistent with
the ANSI-colour settings preview.

---

## Visual language

### Colour

A grayscale system on a near-black ground. Elevation is expressed by making
surfaces **lighter** as they rise (dark-UI convention), not by heavy shadows.

The **only** non-neutral colours anywhere in the UI are three semantic status
hues. They are used for meaning — connection/session state, service/container
state, command exit status, inline messages — never as accents:

| Role    | Hex       | Meaning                                        |
| ------- | --------- | ---------------------------------------------- |
| Success | `#42d17a` | connected, running, active, exit 0             |
| Warning | `#d6a84a` | connecting, sudo-required, paused              |
| Failure | `#ef5b6b` | error, failed/dead, non-zero exit, destructive |

The accent is **off-white** (`#f2f2ee`) — used for the primary button, the
"you are here" accent bar/underline, and focus rings. Even error and warning
_surfaces_ stay neutral gray; the semantic hue appears only in the border and
text. (This is enforced — see [Guardrails](#guardrails).)

### Typography

Two families, one for chrome and one for anything technical:

- **Space Grotesk** (bundled variable font, weights 300–700) for all UI chrome.
  It is a squared grotesque with real character that stays sharp at the dense
  10–13 px sizes the interface lives at, giving the app an engineered voice
  instead of the default system look. Bundled as `woff2` so the desktop build
  works offline with no fallback flash; the system stack is the fallback.
- **Cascadia Mono → Consolas → monospace** for the terminal, logs, code,
  service/container names, container IDs, and history commands.

Type roles are a small scale: 20 px section headings, ~17 px stat values,
12.5 px body, 11.5 px controls, and 10 px uppercase labels with tracking.
Numeric columns use `tabular-nums`.

### Spacing, radius, elevation, motion

- **Spacing** follows a consistent rhythm rather than arbitrary values; layout
  uses flex/grid `gap`, not per-element margins that collapse.
- **Radius** is a three-step scale — `4 / 6 / 8 px` (small controls / menus &
  cards / modals) — replacing the earlier scatter of 2/3/5.
- **Elevation** is the surface ramp (below) plus two neutral shadow tokens for
  popovers and modals.
- **Motion** is deliberately quiet: ~110 ms interaction transitions and ~160 ms
  overlay entrances, all disabled under `prefers-reduced-motion`.

### Icons

`lucide-react`, sized 13–18 px depending on context, `strokeWidth` ~1.8 for
nav/marks. Host OS marks use the Debian/Ubuntu logos (Simple Icons, CC0) with a
generic server glyph fallback, overlaid with the session presence dot.

---

## Design tokens

All values are CSS custom properties on `:root` in `src/styles.css`. Neutral
tokens must stay neutral (RGB channels within 4 of each other); the three
semantic hues above are the only exceptions.

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

**Surface elevation ramp** (lighter = higher)

| Token               | Value     | Use                                  |
| ------------------- | --------- | ------------------------------------ |
| `--surface-sunken`  | `#050505` | inputs, terminal, log wells, sidebar |
| `--surface-base`    | `#090909` | main content                         |
| `--surface-chrome`  | `#070707` | tab strip, toolbars, pane headers    |
| `--surface-raised`  | `#161616` | hover fills, cards                   |
| `--surface-overlay` | `#1c1c1c` | menus, modals, the command palette   |

**Interaction fills & borders**

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

**Radius / motion**

| Token                                         | Value                        |
| --------------------------------------------- | ---------------------------- |
| `--radius-sm` / `--radius-md` / `--radius-lg` | `4px` / `6px` / `8px`        |
| `--motion-fast` / `--motion-med`              | `110ms` / `160ms`            |
| `--ease`                                      | `cubic-bezier(0.2, 0, 0, 1)` |
| `--shadow-popover` / `--shadow-modal`         | neutral drop shadows         |

**Terminal ANSI defaults** (user-editable in Settings; live-previewed). These
are the remote-content palette and are intentionally _not_ part of the
monochrome chrome:

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

**State model per interactive element:** default → hover (`--fill-hover`) →
active/selected (`--fill-active` / `--fill-selected`) → focus-visible (a 2 px
accent ring) → disabled (0.4 opacity, `not-allowed`). Selection and "you are
here" are signalled with a 2 px accent **bar** (rail rows, nav items, list
rows) or **underline** (active tab), for a single consistent language.

**Session presence.** Connection rows and Workspace tabs carry a small presence
dot on the OS mark — green connected, amber connecting, red error, grey
disconnected — so live sessions read at a glance. The dot's ring colour tracks
the row/tab background so it reads as cut out of the icon.

**Panel states.** Every data view distinguishes loading (spinner + label),
empty (icon + guidance, e.g. the Logs and History empty states), and error
(icon + message + retry, with a "Retry with sudo" affordance where a permission
error allows it). Cached lists show stale data with a warning rather than
blanking.

**Dialogs are in-app, never native.** A shared `Modal` backs a `PromptDialog`
(text input; used for renaming a Workspace) and a `ConfirmDialog` (message +
confirm/cancel, with a red danger variant for destructive actions). All of
delete-connection, close-connected-Workspace, discard-Settings, clear-History,
and remove-integration route through these — no OS `prompt`/`confirm` remain.

**Command palette.** `Ctrl+Shift+P` opens a palette that searches open
terminals, connections, workspace views, and contextual actions. It follows the
combobox/listbox pattern with `aria-activedescendant`, arrow/Home/End/Enter/Esc
keys, a focus trap, and focus restoration. It is the fastest path through a
multi-connection workflow and the marquee keyboard surface.

**Terminal.** ConPTY-backed xterm with Unicode/ANSI/VT, resize, scrollback,
copy/paste, and control keys (Vim, top, tmux, etc.). Reconnect after a drop or
clear the local buffer without sending anything to the host. Multiple sessions
per connection; split panes and focus mode for tiling.

---

## Components

Reusable primitives (in `src/components/`) that everything else composes:

- **Modal** — accessible dialog shell (labelled, Esc/backdrop close, focus trap
  and restore); base for ConnectionDialog, CredentialDialog, PromptDialog,
  ConfirmDialog.
- **PromptDialog / ConfirmDialog** — the in-app replacements for native dialogs.
- **CommandPalette** — the keyboard command surface.
- **PanelState** — `LoadingState` / `EmptyState` / `ErrorState`.
- **HostOsIcon** — OS mark with presence badge.
- **StatusDot / WindowControls** — status indicator and custom titlebar buttons.
- **TerminalPane** — the xterm host and session lifecycle.

Shared surface patterns: the **split page** (dense list + detail panel) used by
Services and Docker; the **definition grid** and **capability list** on the
Overview host dashboard; the **dense row** with a leading status indicator; the
compact **chip** (exit codes, counts).

---

## Keyboard model

Shortcuts exist only where they earn their place, and each is discoverable
(palette, tooltips, empty-state hints). Browser/WebView-reserved combinations
(e.g. `Ctrl+Shift+N`, `F11`) are deliberately **not** used, because the WebView
intercepts them; those actions live on buttons and in the palette instead.

| Shortcut       | Action                                      |
| -------------- | ------------------------------------------- |
| `Ctrl+Shift+P` | Open the command palette                    |
| `Ctrl+Shift+T` | Switch the active Workspace to its Terminal |
| `Ctrl+Shift+R` | Reconnect the active Terminal Session       |
| `Ctrl+Shift+W` | Close the active Workspace                  |

The terminal lets these bubble to the app (and keeps copy/paste as
`Ctrl+Shift+C/V`); all other keys go to the remote shell.

---

## Accessibility

- **Contrast** — the text hierarchy and the three semantic colours meet WCAG AA
  (main text exceeds AAA), verified in tests against their backgrounds.
- **Focus** — a consistent 2 px accent focus-visible ring on every interactive
  element, sized and contrasted to satisfy WCAG 2.2 Focus Appearance, and it
  never clips inside dense rows.
- **Semantics** — real buttons/inputs, dialog roles with accessible names, the
  palette's combobox/listbox roles, `aria-current` for the active view/tab,
  labelled window controls, and `aria-label`s on icon-only controls.
- **Not colour alone** — status is shape-coded (dot vs. rotated square vs. ring)
  and text-labelled, not signalled by hue only.
- **Motion** — all transitions/animations collapse under
  `prefers-reduced-motion: reduce`.
- **Hit targets** — interactive controls meet a comfortable minimum; hover-only
  affordances (tab close, row actions) remain keyboard-reachable via
  `:focus-within` and are not clickable while hidden.

---

## Influences

The design borrows specific, proven patterns rather than cloning any one product:

- **Session/terminal managers** — [Termius](https://termai.sh/blog/termius-vs-warp/)
  and [Tabby](https://sourceforge.net/software/product/Tabby.sh/alternatives)
  for connection lists, per-session state, tab grouping/search; the modern
  connection-manager expectation that live sessions are visible at a glance.
- **[Warp](https://docs.warp.dev/terminal/windows/tabs/)** and
  **[Windows Terminal](https://learn.microsoft.com/windows/terminal/)** — tab
  strips with hover-revealed controls, split panes, GPU/-fast terminal feel, and
  session restoration.
- **[VS Code](https://code.visualstudio.com/)** — the command palette on
  `Ctrl+Shift+P` and a dense, calm dark chrome.
- **Host consoles (Lens, Portainer, Cockpit)** — the Overview as a real host
  dashboard: a stat strip plus grouped facts and semantic capability status.
- **Guidance** — WCAG 2.2 (focus appearance, target size, non-text contrast);
  Refactoring UI and dark-UI elevation practice (depth via lighter surfaces, not
  shadows); Nielsen Norman Group on feedback, empty/error states, and keyboard
  navigation.

Deliberately **not** adopted: the AI-terminal direction (Warp), mobile/cloud
sync (Termius), or SaaS-dashboard styling — none fit a local, read-only,
single-user inspector.

---

## Guardrails

Two test files encode the non-negotiable design decisions so the system cannot
silently drift:

- **`src/color-palette.test.ts`** scans _every_ hex/rgb literal in
  `src/styles.css` and fails unless the only non-neutral colours are exactly
  `#42d17a`, `#d6a84a`, `#ef5b6b`. It also checks WCAG contrast for the text
  hierarchy, the accent, and the semantic colours, and pins the terminal ANSI
  defaults. This is what makes "monochrome with intent" a fact, not a hope.
- **`src/ui-hierarchy.test.ts`** locks structural invariants: the 42 px
  titlebar row, the bounded connection list and 980 px content cap, terminal
  padding on the xterm element, focus-mode rules, session presence in
  navigation, the in-app (non-native) discard confirm, and the exact counts of
  host-OS marks / drag regions / window controls in the shell.

Both, plus the Rust suite, run under `npm run check` (format · lint · test ·
build) and in CI. **When changing the UI, keep them green** — or, if a change is
a deliberate evolution of the design, update the guardrail in the same commit
with a rationale.

---

## Non-goals and future

To stay a focused inspector, Control Room deliberately excludes: file transfer,
remote file editing, service/container _management_, cloud accounts,
collaboration, AI features, mobile support, automatic host discovery, background
monitoring, package updates, and private-key storage. New work should prefer
**clearer prioritisation of existing features and better contextual actions**
over adding panels or surfaces.

Reasonable future directions that stay in scope: richer connection organisation
(tags/grouping) in the rail, recent/pinned ordering in the palette, and further
density/responsive tuning — each additive, each measured against the principles
above.
