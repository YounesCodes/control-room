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
  connections; they do not imply health. OS and shell marks may reveal their
  brand color on a hovered or selected tab or host row to identify the target;
  the color is identity, never health, and it never shows at rest. Terminal ANSI
  colors belong to host output and remain separate from the application palette.
  Local shell logos reveal their own colors on hover, keyboard focus, or selection:
  Git orange and PowerShell blue. Command Prompt and the generic local-terminal
  launcher use muted gray at rest and white on hover, keyboard focus, or selection.
  Use each local shell's own mark in workspace tabs, launch and split menus,
  overflow lists, the command palette, and Settings. Administrator shells keep
  their shell mark with a small shield badge.
  OS and shell logos share one footprint and artwork scale, preserving each
  logo's proportions. Larger dialog-heading marks use the same sizing rule.
  Use the solid PowerShell mark with its cut-out prompt so it remains legible
  at small sizes.
- Docker navigation uses the whale silhouette in neutral gray at rest, including
  while selected. Reveal Docker blue on hover or keyboard focus. Individual
  container graph cards use bundled SVG image logos for explicitly recognized
  repositories, neutral at rest and showing brand hues on hover, keyboard focus,
  or selection. Unknown images and container actions use the Lucide Container
  outline. Dark brand hues are lightened enough to remain visible on graph cards.
  Match full image repositories and known aliases, never container names
  or arbitrary registry basenames. Compose project icons stay unchanged.
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
inspection navigation for them. Hide the capability navigation and its divider
for local Workspaces so the connection list uses the available sidebar height.
Scratchpad stays in the terminal toolbar for every Workspace kind.
Optional header metrics may read system usage
for a local tab without adding inspection pages. Keep connection and Workspace identity visible
where it helps navigation, but do not repeat the same identity in a second
header or a separate status rail. An enabled metrics strip may name the active
target beside its readings.

Normal mode keeps each Workspace independently selectable. Focus mode reduces
chrome around terminal work and makes split panes and terminal groups easy to
scan. Give each split group one tab with its name and pane count. Show the active
group's terminals in a separate compact pane row. Pane tabs reveal their
individual Rename and Close controls on hover or keyboard focus, the same way
every other tab does. Use labeled Rename group and Ungroup buttons
at the row's end, and confirm ungrouping with its effect on the open terminals.
Keep inactive groups' member tabs out of that row. The active
Workspace, group, and pane need a clear non-text state cue. Frame the selected
split pane on all four edges, above terminal content, without blocking input or
divider interaction. Keep a thin window drag strip across the top of the Focus Mode
tabs and terminal tools, ending at the fixed window controls, even when tabs overflow.
Avoid a blank column between controls. Focus Mode
header cells — tabs and buttons — fill the strip's full height so their highlight
reaches the top edge; the drag strip overlays the top pixels of the whole strip and
stays the drag target. Buttons and tabs
remain ordinary click targets. Use a compact plus and dropdown control for
New terminal outside the scrolling tabs, its two glyphs clustered and the chevron quieter
than the plus so the pair reads as one button.
Local Terminal Mode starts the default enabled standard local shell in normal focus
mode, with the Connections rail hidden.
Leaving focus mode returns to the active Workspace without changing its target
or its session.
Anchor the Focus terminal toggle beside the window controls at the top right.
Keep the same button and screen position in both modes, including split groups
and overflowing tabs, so toggling never moves it away from the pointer.

Every terminal split has a draggable, keyboard-operable divider, including nested
splits and groups that mix local and remote terminals. Save pane proportions with
their group and retain them when switching views. Constrain displayed sizes in
small windows without overwriting the saved proportions. Reset a divider to equal
sizes with a double-click or Enter.

When Workspace tabs overflow, keep New terminal outside the scrolling list.
Use equal-width tabs that shrink within readable limits. When they no longer fit,
show a window of complete tabs with previous/next controls; never paint a partial
tab at either edge. The All terminals menu lists full names and marks the selected
item at the right edge. Keep icons and names aligned at the left. Include shell
logos and remote host OS marks beside each entry, and a group icon for split groups.
The pane row has its own All panes menu. Selecting a hidden item reveals its
complete tab, including in focus mode. Keep overflow menus within the window
and support arrow keys, Home, End, Enter, and Escape.
Let tab names use the space reserved for Rename and Close until the tab is
hovered or focused. Revealing those controls must not resize neighboring tabs.
Saved Connection cards use the same sliding action space: the status indicator
rests at the right edge and moves left when hover, keyboard focus, or an open
connection menu reveals the three-dot button.

Connection and inspection panes have draggable, keyboard-operable dividers.
Keep saved widths within limits that leave the neighboring pane usable. Reflow
content at the pane's width, and stack list/detail views when two columns no
longer fit. A smaller window may temporarily constrain a saved width; widening
it should restore that preference. Provide individual divider resets and a
visible Reset layout action for all panel sizes. Use a thin hover line within
a larger drag target that stays clear of neighboring scrollbar gutters.
The host list and capability navigation share a horizontal
divider and scroll independently as their available heights shrink.
Scrollbar thumbs appear only while their own scrollable section is hovered,
including terminal panes, fading in and out rather than snapping. Keep
scrollbar space reserved so revealing a thumb does not shift content or change
the available scrolling area.

Content should stay usable at the supported minimum window size. Keep primary
navigation reachable. In dialogs, keep the title and actions available while a
long body scrolls. Menus should open as anchored overlays and must not resize or
reflow the row that opened them.

Scratchpad opens from the terminal toolbar or command palette as a compact
overlay anchored to its own button. Keep a gutter from the window edge and
reposition it when the window resizes. A remote terminal edits its connection
note, a local terminal edits its own tab's note, and both can switch to the shared
global note. Follow the selected split pane without mixing note owners, and
retain Global selection across pane changes. Keep autosave, recovery drafts,
Undo, Redo, Clear, and confirmed Delete in this editor. Pasting note text never
runs it. Restore legacy Scratchpad pages to Terminal without changing saved notes.
Systemd service rows scroll within their own bounded
area, leaving search, filters, and refresh available above the list.

Ports uses the entire inspection area as a pan-and-zoom graph. Keep search,
filters, and reading information in one compact toolbar. Show listener counts and collection time only
in the Ports heading's hover tooltip and accessible description, with no click
card. Align the tooltip to the heading and place it outside the entire toolbar
with a clear gap. Keep warning recovery actions separate. Use search and filter
panels opening on demand. Filter panels pair visible field labels with a compact
heading containing Reset and Close, without a separate action footer. Keep zoom
controls in the lower corner. Route owner
branches orthogonally through reserved gutters, never through other cards.
Use side connections where a column continues and enter its final card from
the top, ending the branch at the card. End the horizontal bus at the top of
the rightmost column's first card, even when that column has more cards below.
Group listening
sockets, established connections, and published Docker mappings by their known
owners. Present matching Docker publications, listeners and their IPv4/IPv6
bindings as one endpoint card while retaining every source record in the inspector.
Match Docker by address, protocol and host port, and connection summaries by
protocol, local port and explicit service or PID evidence. Keep ambiguous matches,
different owners and unknown-owner sockets separate. Never merge solely by port.
Default to listeners and published mappings; put connection-only endpoints behind
Show established connections or the Established / outbound filter. Render those
endpoints with a quieter dashed border. Place peer-only records inside a unique
related listening group when PID evidence matches, or when process name, protocol
and local port match one group. Label these as related processes and preserve
their own owner and source records; this layout relationship does not establish
service ownership. Keep ambiguous matches and explicit conflicting units separate.
Sort unrelated peer-only groups after listening owners.
Keep cards compact: port, protocol, binding scope, Docker target and peer count.
Keep process and per-socket information in expandable inspector sections.
Show container ownership and published bindings in Ports; link to Docker for
image, Compose, lifecycle, network, mount, and container log details.
Show reachability as Not tested. Host firewall policy is separate evidence and
must never label a card as reachable or blocked. Selecting a port or connection
smoothly zooms and centers it in the graph area beside the inspector, then
slides a closable inspector in from the right. Give the inspector equal top and
bottom canvas gutters. Slide zoom controls to the lower-left when it opens,
then back to the lower-right when it closes, keeping its footer clear.
Reduced motion moves the controls immediately. Direct pan and zoom interrupt
the camera transition. Reduced motion applies the framing immediately. Keep the
inspector heading and actions fixed,
with grouped label/value rows in a separately scrolling body. Use a thin
scrollbar that fades when the body is not hovered. Keep every binding,
firewall, ownership, and endpoint field available there, with the
existing service, container, and log actions. Fit the entire graph on initial
load, filtering, resize, and Fit to view, leaving space for controls and an open
inspector. Keep the default and reset framing identical. Keyboard focus
reveals offscreen nodes. Closing the inspector restores the default full-graph framing and returns focus
to its node. The Close button, Escape, clicking the selected node again, and
clicking empty canvas space all close it. Dragging the canvas pans without
closing the inspector.

Docker shares the Ports canvas, camera controls, selection behavior, and inspector
layout. Fit the full container graph before a selection is made. Group container
nodes by validated Compose project by default, with an Ungrouped branch for
containers without a validated project and service. Search and filters open from
the compact toolbar. Filters offer container state and an ungrouped layout.
Keep counts and collection time in the heading tooltip. Container details use
expandable sections in a scrolling body, with Refresh and View logs fixed outside
that body. Follow a container opened from Ports directly to its node and inspector.
Published ports are compact binding summaries that open the exact endpoint in
Ports. Match the container ID, address, host port, target port, and protocol;
report a missing publication rather than selecting another owner on the same port.
Ports includes publications by default without a separate Docker-only filter.
The container inspector repeats the selected image logo beside its title, using
the same generic fallback for unknown images. Docker and Ports inspector sections
share a short fade-and-slide reveal when expanded. Keep native disclosure keyboard
behavior and show section content immediately when reduced motion is requested.

## Visual language

### Color and surfaces

Use neutral surfaces to establish depth, with higher surfaces lighter than lower
ones. Reserve built-in hues for status. Do not add a new accent color for an
individual screen or action. Keep a status hue paired with a shape, label, or
other cue so color is never the only signal.

Connection tags are user metadata and may use user-selected colors. Keep their
text readable against the app surfaces and never use tag color to imply
connection state. Terminal ANSI colors are user-editable in Settings and belong
to the terminal output palette, not the app chrome. Saved colors apply to every
open local and SSH terminal, including hidden tabs and terminals using search.
Each configurable ANSI color also controls its bright variant so shells use the
same selected colors.
Defaults use classic CGA bright colors for prompts and ANSI output, with slightly lighter gray
text on black.

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

Terminal text uses regular weight, including ANSI bold prompts and directory names.

Prefer clear hierarchy over extra labels: a section title, a useful value, and a
short explanation are better than repeated captions. Let technical identifiers
wrap or truncate deliberately so they do not force a pane wider.

### Spacing, shape, and motion

Use the existing spacing, radius, and motion tokens. Prefer layout gaps over
one-off margins. Keep related controls grouped and leave enough room between
labels, values, and outlines. Use the shared shape scale rather than inventing
new radii for each screen.

Transitions should clarify a state change without delaying work. Presses
acknowledge with movement: compact controls dip slightly, while dense rows,
tabs, and list items deepen their fill so high-frequency targets never shift.
Anchored menus, panels, and popovers share one entrance and exit motion. Each
anchors to its trigger with a small consistent gap, flips above it when the
window lacks the room, and keeps its edges inside the window gutters; a menu
dismisses rather than floating away from its anchor after a resize. Live states —
connecting, new terminal output, a bell, a downloaded update — use small
one-purpose cues that rest once their point is made. Never animate the terminal
surface itself. Respect `prefers-reduced-motion`. Use Lucide icons
consistently, except for the shared Phosphor Bold magnifiers used by every search
and zoom control. Keep their filled silhouettes and use matching plus/minus
variants for zoom. Pair icon-only actions with accessible names and tooltips
where useful.

## Interaction patterns

### Controls and state

Interactive controls need clear default, hover, selected, focus-visible, and
disabled states. Use the established button hierarchy: one primary action for
the main decision, secondary actions for alternatives, danger styling for
confirmed destructive work, and labelled icon buttons for compact controls.
The connection rail's persistent Add connection action stays quiet on a raised
charcoal surface with a border, so the host list keeps its dominance; filled
accent stays reserved for the one main decision inside a dialog or flow.
Center the Add connection icon and label as one block.
New terminal in the tab strip is the shared launcher for connections and local
shells, including before the first tab opens. Keep administrator shells in their
own group. When setup is needed, put instructions in a collapsed disclosure
below the targets so ordinary launches stay compact.

Show asynchronous panels with distinct loading, empty, stale, unavailable, and
error states. When cached data is visible, mark it stale instead of presenting
it as current. Give errors a recovery action when one exists, and preserve the
specific cause when it helps the user recover. Terminal failure banners use a
full-height recovery action at the right edge, separated by a quiet divider.
Center its icon and label together and let the message wrap independently.

In split list/detail pages, keep the selection visible. If a filter hides the
selected item, say that the selection is filtered and provide a direct way to
reveal it or clear the filter. Empty lists and their detail areas should describe
the same state.

Use app dialogs for confirmation and editing. Give them an accessible title,
move keyboard focus into the dialog, keep focus within it, and return focus when
it closes. Keep destructive actions explicit. Place contextual menus near their
trigger and within the window.

### Navigation and terminal work

Host OS marks use each recognized distribution's own logo — Debian, Ubuntu,
Fedora, Arch Linux, openSUSE, Alpine, Linux Mint, Kali, RHEL, CentOS, Rocky,
AlmaLinux, NixOS, Manjaro, SUSE, Oracle Linux, and Amazon Linux — with a generic server glyph for other distributions. A
generic mark does not mean the OS was undetected; its accessible label names
the detected distribution when available.

Before opening a new Windows SSH terminal, offer the shells and WSL distributions
available to the connecting account. Keep shell choice in a focused connection
dialog and retain the chosen shell across reconnects and workspace restoration.
Group Windows shells, WSL distributions, and supported Windows Terminal profiles
in compact radio rows. Use a quiet hover fill, a persistent selected border, and
an inset focus ring for keyboard navigation. Windows marks stay gray and include
the detected 10 or 11 version when known.
Windows hosts offer Overview, Terminal, Services, Ports, Docker, and container Logs.
Scratchpad opens from their terminal toolbar. Keep Docker and Logs discoverable even when Docker is missing;
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

Session indicators keep a circular shape in every state, including errors.
Service and container status markers also stay circular and align centrally with
their status text. Keep the text label beside container markers so color is not
the only cue.
Connecting sessions and foreground host reads or terminal commands replace the
solid dot with a neutral gray rotating ring. This also applies to
pane and group tabs. Reduced motion keeps the open ring without rotation.
Command activity uses shell markers where available, otherwise the return of
the rendered prompt, including commands recalled from shell history. Blank or
whitespace-only submissions and command editing stay idle. A pause in output
never counts as command completion. Background header polling uses
the header's own reading state and does not make idle terminals look busy.
Retired session callbacks must not change a replacement session's activity.

Coding agents spin while working and rest at their composer or when paused.
OSC 9;4 progress reports take priority over screen redraws, on both the main
and alternate screens. Running and indeterminate progress spin; cleared,
failed, and paused progress rest. For recognized agent launch commands without
progress reports, the current screen's cancel or interrupt status reports work.
Typing, idle redraws, and approval prompts do not report work. Incomplete
redraws preserve activity until a work or idle status replaces them. Unknown programs
can report activity through OSC 9;4 without command-name detection. A pause in
output never ends work. Ordinary full-screen editors and pagers stay idle.

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
reading state. Keep each label above its value, reserve space for changing numbers,
and use small neutral trend lines for CPU, RAM, and GPU. Keep each value and its
graph in one group, with a subtle divider and a larger gap before the next metric.
Preserve this grouping at narrow widths rather than squeezing the metrics together. Trends hold
at most twenty measured samples in memory, reset on host changes and monitoring
pauses, and never invent points for missing readings. Trends use a fixed
0–100 range. Disk I/O shows separate read and write speeds without a graph. Animate value changes
briefly. A refresh cue runs only while a reading is in progress;
stale and paused charts rest. Respect reduced motion throughout.
Use one compact status button to open reading details, separated from
the numeric readings. Keep Live compact and let longer status labels use only
the space they need. Keep the active host name in its tooltip, accessible label,
and details rather than repeating it in the header. The metric labels, values,
and surrounding space drag the native window. Keep the status button and reading
details as ordinary click targets, and preserve scrolling when the row overflows. Use green
for Live, amber for Stale, and red for Unavailable, paired with text and icons. Keep
Settings and native window controls reachable at narrow widths;
scroll the metric row when needed. Host details must open with a keyboard or click
and include the last reading time and refresh errors. Pause header reads
in Settings and hidden windows. Never treat an unavailable GPU reading as zero.
Label read/write throughput as Disk I/O. Keep filesystem fullness out of the header.
Show I/O in binary bytes per second, with separate Read and Write values in the
details. Ignore retired Storage selections in saved settings without changing
the other selected metrics. I/O covers whole disk devices and must
not double-count partitions or stacked volumes. Missing counters are unavailable,
including after a counter reset or a device-set change during sampling.

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
