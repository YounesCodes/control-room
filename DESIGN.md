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
  the color is identity, never health. Git Bash uses the upstream Git for Windows
  icon, gray at rest and in color on hover, keyboard focus, or selection. Terminal ANSI
  colors belong to host output and remain separate from the application palette.
  Read-only configuration and command blocks may use a small syntax palette for
  sections, keys, strings, paths, and variables. Keep those colors inside code;
  they describe syntax and do not signal service health.
  PowerShell logos reveal blue on hover, keyboard focus, or selection outside
  Settings. Settings keeps shell marks steady while the whole preference row
  receives a quiet hover fill. Git Bash also stays gray throughout Settings.
  Command Prompt and the generic local-terminal
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

On macOS, overlay the native traffic-light controls on one continuous app bar, without a separate system titlebar or visible application name. Keep the Connections heading in that bar, independent of the sidebar width, and begin the sidebar and workspace below it. Reserve one consistent leading area for the traffic lights in normal mode, Settings, and the Focus Mode tab strip. Center the native buttons on the same horizontal line as the header actions. Keep space between the native buttons and app content, and start the sidebar divider below the bar. Use Command for application shortcuts, leaving Control combinations available to terminal programs. Windows retains its custom window controls. Local Mac tabs offer installed zsh, Bash, and fish profiles; administrator profiles remain a Windows feature. Dialogs cycle every focusable control with Tab, including buttons on macOS. Mouse activation gives buttons a keyboard return target, and overflowing header metrics handle arrow-key scrolling explicitly.

## Layout and hierarchy

The app has a compact titlebar, a left connection rail, a Workspace tab strip,
and a main content area. Keep the rail useful without letting it dominate the
active work. Bound dense lists and detail pages so wide windows do not stretch
their contents across the screen.

Use the connection rail for Saved Connections, search, grouping, and remote
feature navigation. Order remote capabilities by expected frequency of use:
Terminal, Docker, Systemd, Logs, Ports, then History. Local
Workspaces are terminal-only, so do not show remote
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
scan. Give each split group one tab with a tiled-layout icon, its name, and pane count.
Number new groups (Group 1, Group 2) rather than naming them after a member terminal. Show the active
group's terminals in a separate compact pane row. Pane tabs reveal their
individual Rename and Close controls on hover or keyboard focus, the same way
every other tab does. Group tabs reveal Rename group (pencil) and Ungroup icons
with the same motion, and confirm ungrouping with its effect on the open terminals.
Keep inactive groups' member tabs out of that row. The active
Workspace, group, and pane need a clear non-text state cue. Frame the selected
split pane on all four edges, above terminal content, without blocking input or
divider interaction. Where a pane meets the window border, inset its frame one pixel
and size panes in whole pixels so display scaling never hides a side. The pane row
marks its selected tab without an underline, which would sit on that frame. Keep a thin window drag strip across the top of the Focus Mode
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
Outside Terminal, collapse its titlebar slot and fade and slide the button out;
reverse the motion when Terminal returns. Keep native window controls fixed and
make the hidden button inert.
Entering and leaving Focus Mode coordinates the sidebar and titlebar exit/entrance,
tab-strip movement, pane controls, and workspace bounds in one short transition.
Keep terminal text at its original pixel size and native window controls fixed.
Preserve the live terminal sessions and keyboard focus. Reverse promptly when the
user toggles again. Unsupported webviews apply the state immediately.
Apply focus state synchronously. Documentation, Settings, and native window
controls appear immediately on exit, outside the animated workspace. Use a short
live workspace slide and sidebar fade rather than captured terminal frames or
animated terminal scaling; resize the terminal once per toggle.

New terminal is also how a terminal is split: in Focus Mode its menu opens with
three mode cards, New tab, Split right, and Split down, each showing the result in
miniature with the new terminal's tile filled above a one-line label. It reopens on
New tab; the split cards switch the targets to split targets, including terminals
already open. There is no separate Split button. A terminal's tab can also be
dragged from the strip onto the focused view: carried below the strip it waits,
dimmed, in its own slot, while the view previews the split at the nearest edge of the
pane under the pointer, captioned like pane moves; a pane's center only hints toward
the edges. Back in the strip the drag reorders again, and Escape cancels.

Every terminal split has a draggable, keyboard-operable divider, including nested
splits and groups that mix local and remote terminals. Where two perpendicular
dividers line up across another, offer each half of the crossed divider on its own,
so every row or column of a grid resizes independently; dragging a half regroups the
tree around it with identical geometry. Once the halves part, the other line spans
its whole side, as tiled layouts require. Save pane proportions with
their group and retain them when switching views. Constrain displayed sizes in
small windows without overwriting the saved proportions. Reset a divider to equal
sizes with a double-click or Enter.

Split panes carry no header strip: the pane tabs already name them and offer Close.
Each pane shows a small frosted six-dot grip in its top-right corner while the
pointer is over the pane or the grip has keyboard focus. Pointing at it spreads and
brightens the dots; dragging or arranging rings it.
Dragging it moves the pane; clicking it opens Arrange. A center drop swaps leaves;
edge drops detach and dock the live pane. Preview the resulting position before
committing as one outlined shape with a single caption, without per-zone labels; the
preview glides between positions, and a cramped target turns red with its reason. Escape cancels. Arrange is a popover
anchored to the grip that maps the group in miniature, the moving pane dashed. Each
other tile's center swaps and its edge trapezoids dock, matching the drop zones;
pointing at or focusing one previews the landing spot and names the move, and an
unavailable one says why. A segmented control below sets the saved split orientation. Keep terminals
mounted in a flat keyed list; animate layout edits briefly without scaling text.
When even responsive rotation cannot fit the group, scroll its surface locally
and keep each terminal usable. Scrollbars and animated panes must not change the
responsive split direction. Window resizing never changes saved directions or ratios.

Compact windows replace the Connections rail with a titlebar navigation drawer.
Keep host selection and all inspection views in that drawer, with keyboard focus
contained until it closes. Preserve rail widths when returning to a wide window.
Reflow forms, toolbars, and Settings rather than reducing typography or scaling
the application. Keep native window controls fixed and dialogs inside the viewport.

Workspace tabs reorder by dragging them along the strip. A short threshold
keeps plain clicks their own act; past it the tab lifts under a shadow,
follows the pointer inside the strip's borders, and the tabs it passes
slide one slot over in the same motion. Holding the
lifted tab at an overflowing strip's edge pages the window open, so any tab
can reach the first or last position. Dropping outside the strip, or Escape,
restores the previous order; a finished drag never selects the dragged tab
by the click that follows it. Reordering moves whole Workspaces, so the
active terminal, its session, and its focus carry over, and Control+Shift
with the arrow keys move a focused tab one slot. In focus mode the strip's
group rows reorder the same way: a group moves as one block, keeping its
member Workspaces together, while the per-pane strip stays focused on its
panes. Saved order is the tab order itself, so a restart restores it.

When Workspace tabs overflow, keep New terminal outside the scrolling list.
Use equal-width tabs that shrink within readable limits. When they no longer fit,
show a window of complete tabs with previous/next controls; never paint a partial
tab at either edge. When space runs out, keep the All terminals menu and show as
many complete tabs as fit. The menu lists full names and marks the selected item
at the right edge. Keep icons and names aligned at the left. Include shell
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
global note. Switching between them never reloads or resizes the popover.
Follow the selected split pane without mixing note owners, and
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
For container-owned endpoints, omit Docker and containerd daemon unit shortcuts;
these describe the runtime rather than the container's service. Preserve the raw
socket diagnostics and genuine service links, including standalone daemon listeners.
Show reachability as Not tested. Host firewall policy is separate evidence and
must never label a card as reachable or blocked. Selecting a port or connection
smoothly zooms and centers it in the graph area beside the inspector, then
slides a closable inspector in from the right. Give the inspector equal top and
bottom canvas gutters. Slide zoom controls to the lower-left when it opens,
then back to the lower-right when it closes, keeping its footer clear.
Direct pan and zoom interrupt the camera transition. Keep the inspector heading
and actions fixed,
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

Inspector panels keep their normal surface border without an outer focus outline.
Keep visible keyboard focus indicators on their buttons, fields, and disclosures.
All four arrows on a graph node or the focused inspector select a nearby node
in that direction using canvas positions, favoring aligned nodes. Use stable layout
coordinates so camera transitions do not change the destination. Stay put when no
node exists in that direction. Frame the selection immediately. Keep Home/End as focus-only navigation. Leave inspector
controls and scrollable evidence to their native keys; Escape returns to the selected node.

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
behavior.

Systemd starts with a compact unit inventory: name, description, and one meaningful
state. Start without a selected unit; loading or refreshing never picks one.
Restore an explicit selection when returning to an existing workspace or following
a unit link. Keep enablement and other metadata in the inspector. Show a failed count
only when nonzero; keep other counts and collection time in the heading tooltip.
Search, filtering, and sorting open from one toolbar.
Search moves its icon left to reserve toolbar space, then reveals the input in
that space. Enclose the icon and input in one control with a single thin focus
border and no extra ring. Align its contents within the same height.
Retract from the current width and opacity so early dismissal does not flash.
Use a full-width toolbar row when needed at narrow widths. Anchor filters below
their icon and toolbar edge, clamp them inside the pane, and reposition on resize.
Failed rows use failure color; inactive and disabled units remain neutral. Preserve the selected identity through
refreshes and show a reveal action when filters hide it. Large inventories render
only the visible rows while retaining keyboard access to every unit.
Keep the inventory vertical-only. Truncate long unit names and descriptions inside
their row, with complete values available in the tooltip and inspector.
Outline the whole selected Systemd row rather than marking only its left edge.
Use one shared rounded highlight that glides between nearby selections. Retarget
from its current position during rapid navigation. Snap on filter changes or
distant virtual-list jumps so the selected unit is never waiting for a long sweep.
Up/Down selects adjacent units in the filtered, sorted inventory and updates the
open inspector immediately. Keep keyboard focus on the row and scroll it into
view, including in virtual inventories. The inspector itself also accepts Up/Down;
leave its fields, disclosures, and scrollable evidence to their native keys.
Keep the panel in place while its new identity and content briefly fade and slide
into view.

The dependency view uses the shared graph controls, pan/zoom camera behavior, and
closable inspector. Its links represent systemd evidence rather than host grouping.
Default the inventory to Focused: services, timers, sockets, and paths, excluding
routine systemd, D-Bus, login-session, and module-loader units. Always include
failed units of every type. Keep unknown application services visible, including
stopped and disabled services. Offer a visible Focused / All units switch with a
sliding selection fill. Reveal the updated inventory
with a short fade and vertical slide in either direction, preserving its live rows,
scrolling, and focus. Retarget an interrupted reveal from its rendered position.
Show visible and total counts
when they differ. Search and explicit type filters reach the whole inventory;
dependency graphs always retain all reported unit types. Keep the scope with the
workspace and let a filtered selection reveal itself in All units.
Show one category at a time: Dependencies (Requires/Wants), Ordering (After/Before),
or Activation (Triggers). Consolidate relationships with the same direction into
one connector. Keep opposite requirements separate. Ordering arrows run from the
earlier unit to the later unit, combining equivalent After/Before constraints.
Keep edges free of text and show exact reported evidence on hover
or keyboard focus. Explain arrow direction once for the active category. Use
solid strokes in Ordering and Activation. In Dependencies, use solid strokes
when Requires is present and dashed strokes for Wants-only links. Show matching
line samples and their meanings beside the direction key.
End each line at the base of its arrowhead, leaving the tip clear of the target card. Never use
label boxes or relationship nodes. Pair line patterns with directed arrows, keep
arrowheads crisp, and route connectors outside cards. Use consistent node sizes
and deterministic columns, placing incoming units left and outgoing units right.

Include reported reverse and activation dependencies, without deriving links from unit
names. Start at one unit and up to six neighbors. Show more or expand a node on
request, up to 25 visible units. Preserve layout slots and smoothly refit zoom and
position after Show more, Show less, and branch expansion or collapse. Rebase
scene coordinates before the camera transition so the root does not jump. Include
nodes arriving from pending reads, but let manual pan/zoom cancel that adjustment
until the next expansion action. Reserve inspector space when fitting an expanded
overview and return to that overview when the inspector closes.
Selecting a node always zooms directly to it, including in an expanded graph.
Clicking the selected node again closes inspection and fits all visible nodes to
the available plot. Keep the direction key and zoom controls in a separate footer
row outside the clipped, pannable viewport. Let that row wrap at narrow widths;
neither the inspector nor graph content may cover its controls or legend.
Late inspector data must not replace that focus; an expansion action resumes fitting.
Initial framing centers the whole visible scene while keeping nodes readable at
85% or larger; expansion and Fit to view may zoom out further. One-sided incoming
or outgoing relationships must not pin the root to the plot center.
Search retains paths to matches.
Pair Show more with Show less for expansion changes.
When an expansion control disappears, restore keyboard focus to a nearby expansion
control. Mouse actions must not move focus to the root and reveal its tooltip.
Expanded nodes keep a visible Collapse control. Collapsing removes unreachable
expanded descendants while keeping shared branches. Restore a collapsed branch with Expand.
Reveal connectors in their arrow direction while nodes move 8px into place over 240ms.
Keep removed nodes and edges as inert,
visual-only snapshots for a 240ms fade and slight movement. Cancel ghosts when
nodes reappear and preserve layout slots during collapse.
Double-click or Shift+Enter refocuses
the graph. Selection, filters, root, and expansion stay with the workspace during
navigation. Changed SSH targets discard that context and use separate detail caches.

Keep inspectors closed until selection.
Remember open inspector state separately for Explorer and Dependency graph while
switching views. Returning to a view restores its inspector for the current selection.
Remember disclosure sections and body/code scroll positions per unit, view, and SSH
target. Restore scroll after lazy evidence arrives, without overriding user input.
Explicitly closing either inspector through Close details, Escape, or clicking its
selected item clears both open states, the inspected selection,
and its highlight. Keep graph roots and expansion context separate from that selection.
Use a compact, content-height panel with
a visible 32px slide on entry and a slide on exit. Graph selection opens the inspector
and starts camera framing immediately,
without a click timer or waiting for remote details. Keep that inspector visible from
its first frame with a short 160ms entrance. Center the graph inspector vertically
at the right of the canvas, including while its content changes.
Keep exiting controls inert and hidden from assistive
technology, cancel exits when reopened, and remove them immediately under reduced
motion. Use the same transitions for relationship categories and filter panels.
Keep view switching in one visible toolbar control; do not repeat the graph action in the inspector.
Slide one selection fill between Explorer and Dependency graph with the same motion
as Focused / All units. Use symmetric easing so expansion and contraction feel equally quick.
Measure its position and width so it fits the unequal
labels, follows window-size changes, and reverses from its current
pose on rapid switching. Apply the same sliding fill to Dependencies, Ordering,
and Activation. Place the initial fill immediately.
Refresh runtime properties for the inspected service periodically without inserting
loading text or resetting open sections. Pause reads in hidden windows and stop
when the inspector closes. Keep the last reading with an error if refresh fails;
never replace unavailable memory with zero.
Interpolate service memory, CPU time, task and restart counts, and uptime briefly
between readings with tabular digits, starting
from the displayed value if a newer reading arrives mid-transition. Show the first
reading immediately. Assistive technology reads the collected value rather than
intermediate animation frames.
Name the graph action Dependency graph. Keep the full target in its accessible
name and tooltip, and show it beside the action and in the graph heading. Cap the
visible name at 24 characters. Let the card fit its text. Keep scope and relationship
category controls in the right-hand tools group before search and refresh, independently
of name length. Keep refresh at the far-right edge.
Keep search directly before refresh in both views. Remove the inventory filter from
layout immediately when entering the graph so retained exits cannot shift the icons later.
Before selection, show a disabled Dependency graph action.
Keep the inventory count identical in both views so its text
and width do not change during navigation. Put scope and relationship controls in
one fixed-size, clipped toolbar slot. Anchor inert exits inside that slot so they
never paint across the heading or view switch. Keep the slot on its own centered
row at narrow widths in both modes. Incoming controls start in their final
slot and never jump when the exit ends. Reserve a usable width for expanded search.
At intermediate widths, keep actions beside the view switch and put scope/category controls
on their own row instead of dropping action icons into an otherwise empty row.
Keep search inline whenever the controls fit, and wrap before the input can collapse.
Reserve search space in both states so opening it does not resize or move the view
switch or refresh action. Scope/category controls may move with the field's expansion.
Truncate names based on available pane
width, independently of search visibility. Animate only the search field within
that space.
Opening Dependency graph focuses the selected unit, including a selected neighbor of a previously explored root. Inventory
row clicks only toggle inspection; double-clicks must not change views.
Use a separately scrolling body and fixed actions. Unit inspectors adapt to services,
timers, sockets, and mounts. Prioritize identity, state, essential runtime details,
and failure results. Configuration and Advanced start collapsed. Keep relationship
browsing in the graph instead of duplicating its dependency list in the inspector.
Keep Configuration directly accessible for unit files and drop-ins. Put conditions,
assertions, runtime details, and effective properties under Advanced. Keep journal
reading in the full Logs view, reached through View journal in the fixed footer.
Unit files and full effective properties load when opened, with separate
unavailable and truncated states. Keep file contents distinct from the manager's
effective properties. Render code with selectable, wrapping monospace text and
restrained syntax colors. Give long command and schedule fields the full inspector
width. Preserve the original host text, including whitespace, quotes, and escapes;
command metadata may gain visual line breaks without rewriting copied content.
Reuse inspector disclosure motion. Show Ports navigation only for services or sockets with a
fresh, known listener ownership match to that exact unit. Opening Advanced may read
listeners without elevation, sharing the Ports view's workspace cache. Hide the
shortcut while ownership is unknown or its read is unavailable.

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
when the picker closes and save the chosen colors without readability warnings.

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

Search fields use compact type and height, an inset icon with a clear gutter,
a quiet surface border, and one visible focus border without an extra glow.
Use the same compact proportions for ordinary form inputs and selectors across
the app. Keep dropdown chevrons smaller than the values beside them.
Round both the dropdown field and its opened option list. Keep option rows inset
inside the popup corners, with clear selection, hover, and keyboard-focus states.

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
surface itself. Use Lucide icons
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
Checkboxes use a compact dark square, a quiet gray outline, and a white tick
when selected. Keep a dark selected fill, a lighter hover border, and a clear
keyboard focus ring. Retain native checkbox semantics, disabled and mixed states,
and the native rendering in Windows high-contrast mode.
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
Windows hosts offer Terminal, Services, Ports, Docker, and container Logs.
Scratchpad opens from their terminal toolbar. Keep Docker and Logs discoverable even when Docker is missing;
their views report installation or daemon access failures. Optional header metrics inspect
Windows itself, including when the terminal runs WSL. Service inventory is read-only;
firewall profiles describe policy without claiming a port is reachable.

Use host marks and session presence to help users find a connection or
Workspace. Put session indicators after labels, separate from OS and shell marks.
Hide idle connection and session dots in host rows, tabs, and Focus Mode.
Do not show gray unread-output badges on terminal tabs or groups. Keep bell alerts.
Show indicators for connecting, busy, and error states. Keep session
state accessible in every mode. Local shells use running, stopped, and restarted;
remote sessions use connected, disconnected, and reconnected.

Session indicators keep a circular shape in every state, including errors.
Service and container status markers also stay circular and align centrally with
their status text. Keep the text label beside container markers so color is not
the only cue.
Exited containers use neutral gray; reserve red for failed or dead containers.
Connecting sessions and foreground host reads or terminal commands replace the
solid dot with a neutral gray rotating ring. This also applies to
pane and group tabs.
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
Logs reads in the order of the task: what to read, how much, then one Start/Stop
control that keeps its footprint. The view shows one source: choosing another clears
it, and while streaming the newest choice restarts the stream in a fresh view. Never
disable the source controls during a restart; keyboard focus must stay in place.
View controls (search, level filters, wrap, clear) sit on the log frame they
affect. Pausing holds lines, never drops them, and says how many are waiting.
Render log text in the terminal font and size. Keep the host text intact: dim
timestamp and source prefixes rather than rewriting them, strip only terminal escapes,
and keep line numbers as generated content so they are neither copied nor read
aloud. Wrapped text hangs under its message, not the gutter. Mark warning and
error lines with a margin bar, number color, and quiet tint; the filters say the
levels come from a level the line states, then words in the message, not journal
priority. Search highlights
matches and counts them. The log region is keyboard-scrollable and not a live region.
When the host hides entries, such as a journal the account cannot read, say so with a
recovery action; never leave an empty stream to look like a quiet unit.

Keep the command palette searchable and keyboard-operable. Make shortcuts
discoverable through the palette, tooltips, or nearby hints. The full shortcut
list belongs in `docs/src/content/docs/reference/keyboard-shortcuts.md`.

Keep Documentation in the titlebar beside Settings. It opens the public docs in
the default browser and remains available in Settings. Hide it during terminal
Focus Mode to keep the terminal controls compact.
Use an open-book icon for Documentation so it reads as a manual.

Settings fills the window below a draggable titlebar with native window controls.
Hide Connections and Workspace tabs while Settings is open, and restore the
existing workspace and focus mode when it closes. Use the available page width
for its form and keep Back and Save visible while its body scrolls.
Use a slim category rail on wide windows and a category selector at narrow widths.
In the category rail, Up/Down changes category and moves focus with it. Home/End
selects the first or last category. Tab enters the rail at its selected item.
Use the selected category highlight as its keyboard focus cue, without a rectangular
focus outline.
Search across categories by setting names and keywords, with category context on
results. Preserve drafts and useful category scroll positions. Keep numeric fields
compact, with readable values in short, quietly bordered inputs and selectors.
Save explicitly, with dirty, saving, saved, and error feedback. Reserve a steady
status slot and Save button width so feedback changes never move the search field.
Right-align status text beside Save, with a larger gap from search. On narrow
windows, search fills a separate row below the heading and save actions.
Settings uses readable section titles. Group
terminal font, size, and color controls with one shared live preview that stays visible while those controls scroll. Keep terminal
behavior separate from appearance and local shell availability.
Arrange colors in a compact grid; stack the preview above its controls on narrow
windows. Category changes reveal the whole form together with the Systemd unit fade and
vertical motion, preserving draft controls.
Terminal uses a persistent row of Appearance, Tabs & naming, and Local shells tabs.
Separate tabs with thin vertical bars and mark the selected tab with bold text
without outlines or filled backgrounds. These automatically selected tabs use
the bold label as their keyboard focus cue instead of a rectangular focus ring. Show only its panel, starting at the normal content gutter. Left/Right
wraps between tabs; Home/End selects the first or last. Preserve mounted draft
controls and use the category reveal motion when switching panels. Search still
shows matching sections across all panels.

Automatic terminal titles default to on. Use only shell-reported executable or
title metadata, reduced to a bounded executable name without arguments or paths.
Keep the shell or host identity and duplicate numbering in the display title.
Manual names take priority. Clear activity on command completion, prompt return,
disconnect, or session replacement. Titles stay in memory and never change saved
workspace names. Unsupported metadata falls back to the normal identity.

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

Command History refreshes its local results after a command is saved for the
open connection. Keep the active search and row focus during these updates.
Check the remote Bash integration separately.

Header metrics are opt-in and follow the active Workspace in normal mode.
Focus Mode hides the header and stops its resource reads.
Use compact labeled values with neutral styling, readable numbers, and a visible
reading state. Keep each label above its value, reserve space for changing numbers,
and use small neutral trend lines for CPU, RAM, and GPU. Keep each value and its
graph in one group, with a subtle divider and a larger gap before the next metric.
Fit whole readings into the space available, prioritizing selected CPU and RAM readings.
Keep every selected reading in the status dropdown as the header narrows. Trends hold
at most twenty measured samples in memory, reset on host changes and monitoring
pauses, and never invent points for missing readings. Trends use a fixed
0–100 range. Disk I/O shows separate read and write speeds without a graph. Interpolate
numeric readings briefly with the same motion as service runtime values, including
percentages, transfer rates, and uptime in the header and details. Keep labels and
opacity steady. Use measured samples for trends, accessible names, and tooltips.
Give disk read and write rates separate fixed slots with right-aligned values so
digit and unit changes cannot push the direction labels or neighboring readings.
Reserve percentage and trend slots even when a chart is unavailable. Right-align
percentage readouts so their percent signs stay anchored as digits change.
Animation frames never become samples. Show first readings, new targets, and
unavailable values immediately. A refresh cue runs only while a reading is in
progress. Stale and paused charts rest.
Use one compact status button to open reading details, separated from
the numeric readings. Keep Live compact and let longer status labels use only
the space they need. Keep the active host name in its tooltip, accessible label,
and details rather than repeating it in the header. The metric labels, values,
and surrounding space drag the native window. Keep the status button and reading
details as ordinary click targets. Use green
for Live, amber for Stale, and red for Unavailable, paired with text and icons. Keep
Settings and native window controls reachable at narrow widths.
Host details must open with a keyboard or click
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

Keep resource readings in the optional host header. Host inspectors focus on services, containers, ports, and logs. Retired selections such as Overview, Boot, and Baselines fall back to Terminal.

Control Room's own updater is quiet while the app is current. When an update is
available, make its status and next action easy to find without a blocking
banner. Match the Download glyph's size and alignment to Documentation, Settings, and Focus Mode.
Use the same transparent button styling as Documentation and Settings.
Keep its footprint fixed across update states, show download progress in a ring
and the tooltip, and switch to a restart icon with a green dot when ready.
Keep full state and version information accessible. Require confirmation before
installing, and keep the app's updates clearly distinct from any host package information.

## Accessibility

- Maintain readable contrast for text, controls, focus rings, and status cues.
- Provide visible keyboard focus and keyboard access to actions that appear on
  hover.
- Use semantic buttons, inputs, and dialog roles. Give icon-only controls names.
- Pair color with text, shape, position, or another cue.
- Keep controls usable at the supported minimum window size and do not rely on
  motion to communicate state.

## Maintaining this guide

Exact implementation values belong in `src/styles.css`; design intent belongs
here. `src/color-palette.test.ts` and `src/ui-hierarchy.test.ts` protect selected
palette, contrast, and structural rules. If a design decision changes, update
the relevant guardrail and explain the reason in the change. Run `npm run check`
to validate the frontend and Rust gates.

Remote Mac workspaces use the same inspection navigation as Linux. Name launchd jobs Services and distinguish their daemon and agent domains. Show unified logs and macOS reboot evidence without Linux boot timing cards. Application Firewall rules and Packet Filter evidence remain separate; neither implies that a port is reachable. When Docker uses another host through a context, show that context and do not associate its published ports with the Mac's own sockets.
