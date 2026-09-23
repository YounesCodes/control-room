# Control Room design

Control Room should feel like an instrument: compact, calm, and ready for quick
inspection or terminal work. This document records the reasoning behind the
interface and the patterns that should carry into new screens.

Product boundaries and security rules live in `AGENTS.md`. Feature behavior is
documented with its implementation, tests, and user manual in `docs/`. Exact
colors, spacing, typography, sizing, and motion values are owned by
`src/styles.css`; do not copy token tables here. Tests cover selected design
guardrails, not every choice described below.

## Design principles

- **Instrument, not dashboard.** People scan and operate Control Room. Put
  useful state first, keep dense information legible, and give terminal work the
  space it needs. Avoid hero banners, decorative gradients, and walls of metric
  cards.
- **Monochrome with intent.** The application chrome stays neutral. Built-in
  color signals success, warning, or failure. User-selected tag colors identify
  connections; they do not imply health. Terminal ANSI colors belong to host
  output and remain separate from the application palette.
- **Keyboard-first and desktop-native.** Keep important actions available by
  keyboard and discoverable in the interface. Use native window controls and
  app-owned dialogs, menus, and terminal panes. Do not rely on hover alone.
- **Honest feedback.** Make loading, empty, stale, unavailable, and failed states
  distinct. Say what the app read and what it did not. Destructive actions name
  their effect and use a clear confirmation step.
- **One coherent system.** Reuse existing tokens, components, and interaction
  patterns. Add a new pattern when the work needs one, then document its intent
  and test its important behavior.

## Layout and hierarchy

The app has a compact titlebar, a left connection rail, a Workspace tab strip,
and a main content area. Keep the rail useful without letting it dominate the
active work. Bound dense lists and detail pages so wide windows do not stretch
their contents across the screen.

Use the connection rail for Saved Connections, search, grouping, and remote
feature navigation. Local Workspaces are terminal-only, so do not show remote
inspection navigation for them. Keep connection and Workspace identity visible
where it helps navigation, but do not repeat the same identity in a second
header or a separate status rail.

Normal mode keeps each Workspace independently selectable. Focus mode reduces
chrome around terminal work and makes split panes and terminal groups easy to
scan. The active Workspace, group, and pane need a clear non-text state cue.
Leaving focus mode returns to the active Workspace without changing its target
or its session.

Content should stay usable at the supported minimum window size. Keep primary
navigation reachable. In dialogs, keep the title and actions available while a
long body scrolls. Menus should open as anchored overlays and must not resize or
reflow the row that opened them.

## Visual language

### Color and surfaces

Use neutral surfaces to establish depth, with higher surfaces lighter than lower
ones. Reserve built-in hues for status. Do not add a new accent color for an
individual screen or action. Keep a status hue paired with a shape, label, or
other cue so color is never the only signal.

Connection tags are user metadata and may use user-selected colors. Keep their
text readable against the app surfaces and never use tag color to imply
connection state. Terminal ANSI colors are user-editable in Settings and belong
to the terminal output palette, not the app chrome.

Use borders and restrained fills to separate controls and surfaces. Make the
selected state easy to locate without shifting nearby content. Avoid heavy
shadows; reserve stronger elevation for overlays such as menus and dialogs.

### Type and density

Use Space Grotesk for interface text and Cascadia Mono, with system monospace
fallbacks, for terminal and technical values. Align numeric columns and use
tabular figures where values are compared. Keep supporting text readable at the
app's compact density; do not shrink informational labels to make a layout fit.

Prefer clear hierarchy over extra labels: a section title, a useful value, and a
short explanation are better than repeated captions. Let technical identifiers
wrap or truncate deliberately so they do not force a pane wider.

### Spacing, shape, and motion

Use the existing spacing, radius, and motion tokens. Prefer layout gaps over
one-off margins. Keep related controls grouped and leave enough room between
labels, values, and outlines. Use the shared shape scale rather than inventing
new radii for each screen.

Transitions should clarify a state change without delaying work. Respect
`prefers-reduced-motion`. Use Lucide icons consistently, and pair icon-only
actions with accessible names and tooltips where useful.

## Interaction patterns

### Controls and state

Interactive controls need clear default, hover, selected, focus-visible, and
disabled states. Use the established button hierarchy: one primary action for
the main decision, secondary actions for alternatives, danger styling for
confirmed destructive work, and labelled icon buttons for compact controls.

Show asynchronous panels with distinct loading, empty, stale, unavailable, and
error states. When cached data is visible, mark it stale instead of presenting
it as current. Give errors a recovery action when one exists, and preserve the
specific cause when it helps the user recover.

In split list/detail pages, keep the selection visible. If a filter hides the
selected item, say that the selection is filtered and provide a direct way to
reveal it or clear the filter. Empty lists and their detail areas should describe
the same state.

Use app dialogs for confirmation and editing. Give them an accessible title,
move keyboard focus into the dialog, keep focus within it, and return focus when
it closes. Keep destructive actions explicit. Place contextual menus near their
trigger and within the window.

### Navigation and terminal work

Use host marks and session presence to help users find a connection or
Workspace. Keep the labelled connection state in the Terminal view; use compact
presence cues in navigation. Local shells use local terms such as running,
stopped, and restarted. Remote sessions use connected, disconnected, and
reconnected.

The terminal is the main working surface, not a dashboard card. Keep common
session actions close to it and use the same pane for local and remote sessions.
Search results should remain distinguishable without washing out ANSI colors;
make the active result more prominent than other matches and give users a
location cue in the overview ruler.

When an inactive terminal receives output or rings its bell, show a subtle cue
on its Workspace tab. Clear the cue when the user returns to that terminal.
Distinguish incoming log lines from the reader's scroll position. Scrolling up
must preserve the reading position, count newer lines, and provide a direct
return to the latest line. Wrapping is a view choice and must not change the
stream.

Keep the command palette searchable and keyboard-operable. Make shortcuts
discoverable through the palette, tooltips, or nearby hints. The full shortcut
list belongs in `docs/src/content/docs/reference/keyboard-shortcuts.md`.

### Host data and updates

Present the fact the host returned, not a stronger conclusion. A missing value
must look missing, not like zero. Keep unavailable, unsupported, skipped, and
unchanged states distinct. Separate socket binding, firewall policy, and
reachability claims.

Keep live Overview meters neutral; their magnitude alone is not a health
judgment. Show when the latest reading arrived and distinguish an initial read
from a failed refresh. A live baseline comparison should be visibly identified
as live and unsaved.

Control Room's own updater is quiet while the app is current. When an update is
available, make its status and next action easy to find without a blocking
banner. Show download progress, require confirmation before installing, and keep
the app's updates clearly distinct from any host package information.

## Accessibility

- Maintain readable contrast for text, controls, focus rings, and status cues.
- Provide visible keyboard focus and keyboard access to actions that appear on
  hover.
- Use semantic buttons, inputs, and dialog roles. Give icon-only controls names.
- Pair color with text, shape, position, or another cue.
- Keep controls usable at the supported minimum window size and do not rely on
  motion to communicate state.
- Honor reduced-motion preferences.

## Maintaining this guide

Exact implementation values belong in `src/styles.css`; design intent belongs
here. `src/color-palette.test.ts` and `src/ui-hierarchy.test.ts` protect selected
palette, contrast, and structural rules. If a design decision changes, update
the relevant guardrail and explain the reason in the change. Run `npm run check`
to validate the frontend and Rust gates.
