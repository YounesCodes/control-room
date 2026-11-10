# Control Room design

Control Room should feel like an instrument: compact, calm, and ready for quick
inspection or terminal work. This document records the design decisions that
span screens and the reasons behind them.

Product boundaries and security rules live in `AGENTS.md`. Exact feature
behavior lives in the implementation, its tests, and the user manual in `docs/`.
`src/styles.css` owns exact colors, spacing, typography, sizing, and motion
values. Do not copy token tables or per-feature specifications here.

## Design principles

- **Instrument, not dashboard.** People scan and operate Control Room. Put
  useful state first, keep dense information legible, and give terminal work the
  space it needs. Avoid hero banners, decorative gradients, and walls of metric
  cards.
- **Monochrome with intent.** The application chrome stays neutral. Built-in
  color signals success, warning, or failure. Tag colors, brand marks, terminal
  ANSI colors, and code syntax colors identify things. They never signal health.
- **Keyboard-first and desktop-native.** Keep important actions available by
  keyboard and discoverable in the interface. Use native window controls and
  app-owned dialogs, menus, and terminal panes. Do not rely on hover alone.
- **Honest feedback.** Make loading, empty, stale, unavailable, and failed states
  distinct. Present the fact the host returned, not a stronger conclusion. A
  missing value must look missing, not like zero. Destructive actions name their
  effect and use a clear confirmation step.
- **Stable layouts.** Revealing a control, opening a menu, or updating a live
  value must not move its neighbors. Reserve the space first.
- **One coherent system.** Reuse existing tokens, components, and interaction
  patterns. Add a new pattern when the work needs one, then document its intent
  and test its important behavior.

## Layout

### App frame

The app has a compact titlebar, a left connection rail, a Workspace tab strip,
and a main content area. Keep the rail useful without letting it dominate the
active work. Bound dense lists and detail pages so wide windows do not stretch
their contents across the screen.

The rail holds Saved Connections, search, grouping, and remote feature
navigation. Order capabilities by expected frequency of use: Terminal, Docker,
Systemd, Logs, Ports, then History. Local Workspaces are terminal-only, so hide
the capability navigation and its divider for them. Windows hosts offer
Terminal, Services, Ports, Docker, and container Logs. Mac hosts keep the Linux
order but name launchd jobs Services and list them without the systemd
dependency explorer, because launchd reports no dependency graph. Keep Docker
and Logs discoverable when Docker is missing and let their views report the
failure. Do not repeat a connection's identity in a second header or status
rail.

Compact windows replace the rail with a titlebar navigation drawer. The drawer
holds host selection and every inspection view, and contains keyboard focus
until it closes. Reflow forms, toolbars, and Settings instead of shrinking type
or scaling the app. Keep native window controls fixed and dialogs inside the
viewport. Content stays usable at the supported minimum window size.

On macOS, the native traffic lights overlay one continuous app bar with no
system titlebar or visible app name. The Connections heading sits in that bar,
independent of sidebar width, and the same leading space is reserved in
Settings and the Focus Mode tab strip. Use Command for app shortcuts so Control
combinations reach terminal programs. Windows keeps its custom window controls.

### Resizable panes

Connection, inspection, and terminal split panes have draggable,
keyboard-operable dividers. Saved sizes stay within limits that leave the
neighboring pane usable. A small window may constrain a displayed size without
overwriting the saved one. Double-click or Enter resets a divider, and Reset
layout restores every panel size. Stack list/detail views when two columns no
longer fit.

Scrollbar thumbs fade in only while their own section is hovered, terminal
panes included. Keep the gutter reserved so a thumb never shifts content.

### Workspace tabs

- Tabs reorder by dragging past a short threshold, or with Control+Shift and
  the arrow keys. Dropping outside the strip or pressing Escape restores the
  order. A reorder moves the whole Workspace with its session and focus. The
  saved order is the tab order.
- Tabs are equal width and shrink within readable limits. Past that, show a
  window of complete tabs with previous/next controls and an All terminals
  menu. Never paint a partial tab. New terminal stays outside the scrolling
  list.
- Rename and Close appear on hover or keyboard focus, in space the name uses at
  rest. Saved Connection cards reveal their three-dot button the same way.
- Each tab carries its shell or host OS mark. Overflow menus list full names,
  stay inside the window, and support arrow keys, Home, End, Enter, and Escape.

### Focus Mode and splits

Focus Mode reduces chrome around terminal work. Normal mode keeps each
Workspace independently selectable.

- Toggling preserves live sessions, keyboard focus, and the active target. Use
  a short workspace slide and sidebar fade. Never scale or animate the terminal
  surface, and resize the terminal once per toggle.
- The Focus toggle keeps the same position beside the window controls in both
  modes, so toggling never moves it away from the pointer. Outside Terminal it
  slides out and becomes inert.
- A thin window drag strip runs across the top of the Focus Mode header. Tabs
  and buttons fill the header's full height and stay ordinary click targets.
- Each split group has one tab with a tiled-layout icon, a numbered name such
  as Group 1, and a pane count. The active group's terminals appear in a
  separate pane row. Frame the selected pane on all four edges.
- New terminal is also how a terminal is split. Its Focus Mode menu opens with
  New tab, Split right, and Split down cards that show the result in miniature.
  There is no separate Split button. Dragging a tab onto the focused view
  splits at the nearest pane edge.
- Split panes carry no header strip. A six-dot grip in the pane's top-right
  corner appears on hover or keyboard focus. Dragging it moves the pane and
  clicking it opens Arrange. A center drop swaps panes and an edge drop docks.
  Preview the result as one outlined shape before committing. A cramped target
  turns red and gives its reason. Escape cancels.
- Window resizing never changes saved split directions or ratios. When a group
  cannot fit, scroll its surface locally and keep each terminal usable.
- Local Terminal Mode starts the default local shell in Focus Mode with the
  rail hidden.

### Overlays

Menus, panels, and popovers open as anchored overlays with one shared entrance
and exit motion. They flip above the trigger when the window lacks room, keep
their edges inside the window gutters, and dismiss after a resize instead of
floating away from their anchor. Dialogs keep the title and actions visible
while a long body scrolls.

Scratchpad opens from the terminal toolbar or command palette as a compact
overlay anchored to its button, for every Workspace kind. A remote terminal
edits its connection note and a local terminal edits its own tab's note. Both
can switch to the shared global note without reloading or resizing the popover.
It follows the selected split pane without mixing note owners. Pasting note
text never runs it.

## Inspection views

Host inspectors cover services, containers, ports, and logs. Resource readings
belong to the optional header metrics.

### Shared canvas and inspector

Ports, Docker, and the Systemd dependency graph share one pan-and-zoom canvas,
its camera controls, its selection behavior, and its inspector layout.

- Fit the whole graph on load, filtering, resize, and Fit to view, leaving room
  for controls and an open inspector. Default and reset framing are identical.
- Selecting a node zooms to it and slides a closable inspector in from the
  right. The Close button, Escape, clicking the selected node again, and
  clicking empty canvas all close it, restore the full framing, and return
  focus to the node. Dragging pans without closing. Direct pan and zoom
  interrupt any camera transition.
- Arrow keys on a node select the nearest node in that direction, using stable
  layout coordinates. Home and End move focus only. Inspector fields,
  disclosures, and scrollable evidence keep their native keys.
- Inspectors stay closed until selection. They have a fixed heading and fixed
  actions around a separately scrolling body of expandable sections, all with
  the same disclosure motion. The panel has no outer focus outline, and its
  controls keep visible focus.
- Search and filters open on demand from one compact toolbar. Counts and
  collection time live in the heading's tooltip and accessible description.
  Zoom controls sit in a lower corner, clear of the inspector.
- Route connectors orthogonally through reserved gutters, never through cards.

### Ports

Group listening sockets, established connections, and published Docker mappings
by their known owners. Merge a Docker publication with its listeners into one
endpoint card when address, protocol, and host port match. Never merge solely
by port. Keep ambiguous matches, different owners, and unknown-owner sockets
separate, and keep every source record in the inspector.

Default to listeners and published mappings. Connection-only endpoints sit
behind a filter and use a quieter dashed border. Placing a peer-only record
beside a related listener is a layout choice and does not establish ownership.

Cards stay compact: port, protocol, binding scope, Docker target, and peer
count. Reachability reads Not tested. Host firewall policy is separate evidence
and never labels a card reachable or blocked. Link to Docker for container
details instead of repeating them.

On Mac hosts, Application Firewall rules and Packet Filter state are separate
evidence, and neither implies that a port is reachable. When Docker reaches
another machine through its selected context, show that context and keep its
published ports off the Mac's own listeners.

### Docker

Group containers by validated Compose project, with an Ungrouped branch for the
rest. A published port opens its exact endpoint in Ports, matched by container
ID, address, ports, and protocol. Report a missing publication instead of
selecting another owner on the same port.

Recognized images show their logo, matched by full repository name or known
alias and never by container name. Unknown images use the Lucide Container
outline. Exited containers are neutral gray. Red is for failed or dead
containers.

### Systemd

- The inventory row shows name, description, and one meaningful state. Failed
  rows use failure color. Inactive and disabled units stay neutral. Show a
  failed count only when it is nonzero.
- Start with no unit selected. Loading or refreshing never picks one. A
  selection survives refreshes, and a filter that hides it offers a reveal
  action.
- The default scope is Focused: services, timers, sockets, and paths, minus
  routine system units, plus every failed unit. A visible Focused / All units
  switch changes scope. Search and type filters reach the whole inventory.
- Up and Down move the selection and update an open inspector immediately.
  Large inventories render only visible rows and keep keyboard access to every
  unit.
- The dependency graph shows one category at a time: Dependencies, Ordering, or
  Activation. Links come from reported systemd evidence, never from unit names.
  Edges carry no text and show their evidence on hover or keyboard focus.
  Requires is solid and Wants-only is dashed, with a legend beside the
  direction key.
- The graph starts at one unit with up to six neighbors and expands on request
  to 25 visible units. Keep layout slots through expansion and collapse so the
  root does not jump.
- The unit inspector leads with identity, state, essential runtime details, and
  failure results. Configuration and Advanced start collapsed and load when
  opened. Relationship browsing stays in the graph and journal reading stays in
  Logs. Code blocks preserve the original host text.
- Runtime properties refresh periodically without loading text or resetting
  open sections. A failed refresh keeps the last reading beside its error.
- Selection, filters, graph root, expansion, and inspector state stay with the
  workspace. A changed SSH target discards them.
- Toolbar controls keep fixed slots. Switching views or opening search never
  moves the view switch or Refresh.

### Logs

Logs reads in the order of the task: what to read, how much, then one
Start/Stop control that keeps its footprint. The view shows one source.
Choosing another clears it, and during a stream the newest choice restarts the
stream in a fresh view. Never disable the source controls during a restart.

View controls for search, level filters, wrap, and clear sit on the log frame
they affect. Pausing holds lines, never drops them, and says how many are
waiting. Scrolling up preserves the reading position, counts newer lines, and
offers a direct return to the latest line. Wrapping is a view choice and must
not change the stream.

Render log text in the terminal font and keep the host text intact. Dim
timestamp and source prefixes instead of rewriting them, strip only terminal
escapes, and keep line numbers out of copied text and screen reader output.
Mark warning and error lines with a margin bar, number color, and quiet tint.
When the host hides entries, such as a journal the account cannot read, say so
with a recovery action. An empty stream must never pass for a quiet unit.

## Visual language

### Color and surfaces

Use neutral surfaces to establish depth, with higher surfaces lighter than lower
ones. Reserve built-in hues for status, and pair each with a shape, label, or
other cue. Do not add a new accent color for an individual screen or action.

Use borders and restrained fills to separate controls and surfaces. Selected
rows get an outline around the whole box, never only a left edge. Avoid heavy
shadows and reserve stronger elevation for menus and dialogs.

Connection tags use user-selected colors and never imply connection state.
Terminal ANSI colors are user-editable, belong to terminal output, and apply to
every open terminal. Each configurable color also sets its bright variant.
Defaults use classic CGA bright colors with slightly lighter gray text on
black.

### Marks and icons

OS, shell, and image marks stay gray at rest and reveal their brand color on
hover, keyboard focus, or selection. Three exceptions apply. Settings keeps
shell marks steady. The Docker navigation icon stays gray while selected.
Command Prompt and the generic local launcher go from gray to white. All marks
share one footprint and artwork scale. Administrator shells keep their shell
mark with a small shield badge.

Recognized Linux distributions use their own logo and others get a generic
server glyph whose accessible label still names the detected distribution.
Windows marks include the detected 10 or 11 version when known.

Use Lucide icons, except for the Phosphor Bold magnifiers shared by every
search and zoom control. Give icon-only actions accessible names and tooltips.

### Type and density

Use Inter Variable for interface text, Space Grotesk for headings and display
sizes, and Cascadia Mono with system monospace fallbacks for terminal and
technical values. Use tabular figures where values are compared. Do not shrink
informational labels to make a layout fit. Terminal text uses regular weight,
including ANSI bold.

Prefer clear hierarchy over extra labels. Let technical identifiers wrap or
truncate deliberately so they do not force a pane wider, and keep the full
value in a tooltip or inspector.

### Spacing, shape, and motion

Use the existing spacing, radius, and motion tokens. Prefer layout gaps over
one-off margins. Search fields, form inputs, and selectors share one compact
height, a quiet border, and a single focus border without an extra glow.

Transitions clarify a state change without delaying work. Compact controls dip
slightly when pressed. Dense rows, tabs, and list items deepen their fill
instead, so high-frequency targets never shift. Sliding selection fills and
content reveals retarget from their current pose when interrupted. Live states
such as connecting, new output, a bell, or a downloaded update use small cues
that rest once their point is made. Reduced motion removes transitions without
changing the outcome.

Interpolate changing numbers briefly, with tabular digits, from the displayed
value. Show first readings and unavailable values immediately. Assistive
technology reads the collected value, not animation frames.

## Interaction patterns

### Controls and state

Interactive controls need clear default, hover, selected, focus-visible, and
disabled states. Use one primary action for the main decision, secondary
actions for alternatives, danger styling for confirmed destructive work, and
labelled icon buttons for compact controls. Filled accent is reserved for the
main decision inside a dialog or flow, so persistent actions such as Add
connection stay quiet.

When cached data is visible, mark it stale. Give errors a recovery action when
one exists and keep the specific cause when it helps the user recover.

Use app dialogs for confirmation and editing. Give them an accessible title,
move keyboard focus in, keep it there, and return it on close.

### Sessions and terminal work

The terminal is the main working surface, not a dashboard card. Local and
remote sessions use the same pane and the same tab strip actions. New terminal
is the shared launcher for connections and local shells, with administrator
shells in their own group. Before opening a Windows SSH terminal, offer the
shells and WSL distributions available to the account, and keep the choice
across reconnects.

Session indicators sit after labels, apart from OS and shell marks, and stay
circular in every state. Hide idle dots. Connecting sessions and running
commands replace the dot with a neutral rotating ring. When an inactive
terminal receives output or rings its bell, show a subtle cue on its tab and
clear it when the user returns. Do not use gray unread badges.

Busy means work is running. Detect it from shell markers, the prompt's return,
or OSC 9;4 progress reports. A pause in output never counts as completion.
Typing, blank submissions, idle redraws, approval prompts, editors, pagers, and
background header polling stay idle.

Automatic tab titles use only shell-reported metadata, reduced to a bare
executable name. Manual names win. Titles stay in memory and never change saved
workspace names.

Terminal search opens as a compact overlay that does not reduce terminal
height. Keep matches distinguishable without washing out ANSI colors, and make
the active match the most prominent.

Keep the command palette searchable and keyboard-operable, and make shortcuts
discoverable through it, tooltips, or nearby hints. The full shortcut list
belongs in `docs/src/content/docs/reference/keyboard-shortcuts.md`.

### Settings

Settings fills the window below a draggable titlebar and hides Connections and
Workspace tabs. Closing it restores the workspace and focus mode. Use a
category rail on wide windows and a category selector at narrow widths. Search
covers every category by setting name and keyword.

Save is explicit, with dirty, saving, saved, and error feedback in a reserved
status slot. Back and Save stay visible while the body scrolls. Drafts and
category scroll positions survive navigation.

Terminal font, size, and color controls share one live preview that stays
visible while they scroll. Font previews stay in the webview and do not install
fonts. Installation is explicit and reports progress and errors. The current
terminal font stays until the install and the settings save both succeed.

### Header metrics

Header metrics are opt-in and follow the active Workspace. Focus Mode,
Settings, and hidden windows pause their reads.

Use compact labeled values with neutral styling, fixed slots, and right-aligned
numbers, so changing digits never push a label or neighbor. Fit whole readings
into the available width, CPU and RAM first, and keep every selected reading in
the status dropdown. One status button opens reading details. It uses green for
Live, amber for Stale, and red for Unavailable, each with text and an icon.

Trends plot measured samples only, on a fixed 0 to 100 range. Never invent
points for missing readings and never treat an unavailable reading as zero.
Disk I/O shows separate read and write rates for whole devices, without
double-counting partitions. Filesystem fullness stays out of the header.

### Updates

The updater is quiet while the app is current. When an update is available,
show it in a titlebar button that matches Documentation and Settings, without a
blocking banner. The button keeps one footprint across states, shows download
progress in a ring, and switches to a restart icon with a green dot when ready.
Require confirmation before installing. Keep the app's updates distinct from
host package information.

## Accessibility

- Maintain readable contrast for text, controls, focus rings, and status cues.
- Provide visible keyboard focus and keyboard access to actions that appear on
  hover.
- Use semantic buttons, inputs, and dialog roles. Give icon-only controls names.
- Pair color with text, shape, position, or another cue.
- Keep exiting and hidden controls inert and out of the accessibility tree.
- Do not rely on motion to communicate state.

## Maintaining this guide

Record a decision here when it spans screens or explains why the interface
works the way it does. Leave exact values to `src/styles.css` and exact feature
behavior to the implementation and its tests. `src/color-palette.test.ts` and
`src/ui-hierarchy.test.ts` protect selected palette, contrast, and structural
rules. If a design decision changes, update the relevant guardrail and explain
the reason in the change. Run `npm run check` to validate the frontend and Rust
gates.
