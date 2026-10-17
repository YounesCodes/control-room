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
inspection navigation for them. Optional header metrics may read system usage
for a local tab without adding inspection pages. Keep connection and Workspace identity visible
where it helps navigation, but do not repeat the same identity in a second
header or a separate status rail. An enabled metrics strip may name the active
target beside its readings.

Normal mode keeps each Workspace independently selectable. Focus mode reduces
chrome around terminal work and makes split panes and terminal groups easy to
scan. Give each split group one tab with its name and pane count. Show the active
group's terminals in a separate compact pane row. Keep individual Rename and Close
controls visible on each pane tab. Use labeled Rename group and Ungroup buttons
at the row's end, and confirm ungrouping with its effect on the open terminals.
Keep inactive groups' member tabs out of that row. The active
Workspace, group, and pane need a clear non-text state cue. Frame the selected
split pane on all four edges, above terminal content, without blocking input or
divider interaction. Keep a thin window drag strip across the top of the Focus Mode
header, even when tabs overflow, without a blank column between controls. Buttons and tabs
remain ordinary click targets. Use a compact plus and dropdown control for
New terminal outside the scrolling tabs.
Local Terminal Mode starts the default enabled standard local shell in normal focus
mode, with the Connections rail hidden.
Leaving focus mode returns to the active Workspace without changing its target
or its session.

Every terminal split has a draggable, keyboard-operable divider, including nested
splits and groups that mix local and remote terminals. Save pane proportions with
their group and retain them when switching views. Constrain displayed sizes in
small windows without overwriting the saved proportions. Reset a divider to equal
sizes with a double-click or Enter.

When Workspace tabs overflow, keep New terminal outside the scrolling list.
Use equal-width tabs that shrink within readable limits. When they no longer fit,
show a window of complete tabs with previous/next controls; never paint a partial
tab at either edge. The All terminals menu lists full names and marks the selected
item. Include shell logos and remote host OS marks beside each entry, and a group
icon for split groups. The pane row has its own All panes menu. Selecting a hidden item reveals
its complete tab, including in focus mode. Keep overflow menus within the window
and support arrow keys, Home, End, Enter, and Escape.
Let tab names use the space reserved for Rename and Close until the tab is
hovered or focused. Revealing those controls must not resize neighboring tabs.

Connection and inspection panes have draggable, keyboard-operable dividers.
Keep saved widths within limits that leave the neighboring pane usable. Reflow
content at the pane's width, and stack list/detail views when two columns no
longer fit. A smaller window may temporarily constrain a saved width; widening
it should restore that preference. Provide individual divider resets and a
visible Reset layout action for all panel sizes. Use a thin hover line within
a larger drag target. The host list and capability navigation share a horizontal
divider and scroll independently as their available heights shrink.

Content should stay usable at the supported minimum window size. Keep primary
navigation reachable. In dialogs, keep the title and actions available while a
long body scrolls. Menus should open as anchored overlays and must not resize or
reflow the row that opened them.

Scratchpad uses the full workspace width and grows with the window. Keep its
heading and editor aligned. Systemd service rows scroll within their own bounded
area, leaving search, filters, and refresh available above the list.

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

Keep the terminal color picker open while a user adjusts it. Update the preview
and any readability warning when the picker closes, and let the user save a
deliberate low-contrast choice.

Use borders and restrained fills to separate controls and surfaces. Make the
selected state easy to locate without shifting nearby content. Selected Saved
Connections and host section rows share an inset outline around the whole box.
Avoid heavy shadows; reserve stronger elevation for overlays such as menus and
dialogs.

### Type and density

Use Inter Variable for interface text, Space Grotesk for headings and
display sizes, and Cascadia Mono, with system monospace
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

Host OS marks use the Debian, Ubuntu, and Windows marks, with a generic server glyph
for other distributions. A generic mark does not mean the OS was undetected;
its accessible label names the detected distribution when available.

Before opening a new Windows SSH terminal, offer the shells and WSL distributions
available to the connecting account. Keep shell choice in a focused connection
dialog and retain the chosen shell across reconnects and workspace restoration.
Group Windows shells, WSL distributions, and supported Windows Terminal profiles
in compact radio rows. Use a quiet hover fill, a persistent selected border, and
an inset focus ring for keyboard navigation. Windows marks stay gray and include
the detected 10 or 11 version when known.
Windows hosts offer Overview, Terminal, Services, Ports, Docker, container Logs,
and Scratchpad. Keep Docker and Logs discoverable even when Docker is missing;
their views report installation or daemon access failures. Optional header metrics inspect
Windows itself, including when the terminal runs WSL. Service inventory is read-only;
firewall profiles describe policy without claiming a port is reachable.

Use host marks and session presence to help users find a connection or
Workspace. Put session indicators after labels, separate from OS and shell marks.
When the sidebar is visible, connected tabs do not repeat its normal connection
dots. Tabs retain connecting, disconnected, and error indicators; in Focus Mode,
they also show normal connection state because the sidebar is hidden. Keep session
state accessible in every mode. Local shells use running, stopped, and restarted;
remote sessions use connected, disconnected, and reconnected.

The terminal is the main working surface, not a dashboard card. Keep common
session actions in the tab strip for the active pane and use the same pane for
local and remote sessions. Open terminal search as a compact overlay so it does
not reduce terminal height. Search results should remain distinguishable
without washing out ANSI colors; make the active result more prominent than
other matches and give users a location cue in the overview ruler.
Keep the search-marker rail borderless so an empty rail does not look like a
scrollbar or a pane divider.

When an inactive terminal receives output or rings its bell, show a subtle cue
on its Workspace tab. Clear the cue when the user returns to that terminal.
Distinguish incoming log lines from the reader's scroll position. Scrolling up
must preserve the reading position, count newer lines, and provide a direct
return to the latest line. Wrapping is a view choice and must not change the
stream.

Keep the command palette searchable and keyboard-operable. Make shortcuts
discoverable through the palette, tooltips, or nearby hints. The full shortcut
list belongs in `docs/src/content/docs/reference/keyboard-shortcuts.md`.

Keep Documentation in the titlebar beside Settings. It opens the public docs in
the default browser and remains available in Settings. Hide it during terminal
Focus Mode to keep the terminal controls compact.

Settings fills the window below a draggable titlebar with native window controls.
Hide Connections and Workspace tabs while Settings is open, and restore the
existing workspace and focus mode when it closes. Use the available page width
for its form and keep Back and Save visible while its body scrolls.
Settings uses readable section titles and short scope descriptions. Group
terminal font, size, and color controls with one shared live preview that stays visible while those controls scroll. Keep terminal
behavior separate from appearance and local shell availability.

Select the current font value on focus or when reopening the field so typing
starts a new search without deleting the saved family. Preserve cursor editing
once a search is in progress. Use one editable Font family combobox for catalog search and manual fallback
lists. Anchor suggestions to the field without moving the controls below it.
Keep typed search text separate from saved settings. Enter accepts a keyboard
selection or keeps a typed manual value; Escape restores the current value.
Font catalog suggestions show each name in its font and update the Settings
preview as the user searches or moves through suggestions. Preview faces stay
in the webview and do not install fonts. Keep installation explicit, report
its progress and errors, and preserve the current terminal font until the
per-user Windows installation and settings save both succeed.

### Host data and updates

Header metrics are opt-in and follow the active Workspace in normal mode.
Focus Mode hides the header and stops its resource reads.
Use compact labeled values with neutral styling, readable numbers, and a visible
reading state. Use one compact status button to open reading details, separated from
the numeric readings. Keep the active host name in its tooltip, accessible label,
and details rather than repeating it in the header. Use green
for Live, amber for Stale, and red for Unavailable, paired with text and icons. Keep
Settings and native window controls reachable at narrow widths;
scroll the metric row when needed. Host details must open with a keyboard or click
and include capacity, the last reading time, and refresh errors. Pause header reads
in Settings and hidden windows. Never treat an unavailable GPU reading as zero.

Present the fact the host returned, not a stronger conclusion. A missing value
must look missing, not like zero. Keep unavailable, unsupported, skipped, and
unchanged states distinct. Separate socket binding, firewall policy, and
reachability claims.

Keep resource readings in the optional host header. Overview presents host identity,
service and container counts, and runtime capabilities without duplicate readings
or resource polling. Its heading shows inspection time; host identity and OS
belong in the System facts rather than a repeated heading mark. A live baseline comparison should be visibly identified
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
