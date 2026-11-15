# Control Room design

Control Room should feel like an instrument: compact, calm, and ready for quick
inspection or terminal work. This document records the design language that
applies across the whole app and the reasons behind it.

Product boundaries and security rules live in `AGENTS.md`. Feature behavior
lives in the implementation, its tests, and the user manual in `docs/`.
`src/styles.css` owns exact colors, spacing, typography, sizing, and motion
values. Do not copy token tables or feature specifications here.

## Design principles

- **Instrument, not dashboard.** People scan and operate Control Room. Put
  useful state first, keep dense information legible, and give terminal work the
  space it needs. Avoid hero banners, decorative gradients, and walls of metric
  cards.
- **Monochrome with intent.** The application chrome stays neutral. Built-in
  color signals success, warning, or failure. Tag colors, brand marks, terminal
  ANSI colors, and code syntax colors identify things. They never signal health.
- **Keyboard-first and desktop-native.** Keep important actions available by
  keyboard and discoverable in the interface. Let the window manager handle
  titlebar and edge drags. Use app-owned dialogs, menus, and terminal panes.
  Do not rely on hover alone.
- **Honest feedback.** Make loading, empty, stale, unavailable, and failed states
  distinct. Present the fact the host returned, not a stronger conclusion. A
  missing value must look missing, not like zero, and an empty result must
  never pass for a quiet one. Destructive actions name their effect and use a
  clear confirmation step.
- **Stable layouts.** Revealing a control, opening a menu, or updating a live
  value must not move its neighbors. Reserve the space first, and give live
  numbers fixed slots and tabular digits.
- **One coherent system.** Reuse existing tokens, components, and interaction
  patterns. Add a new pattern when the work needs one, then document its intent
  here if it applies across the app.

## Layout

The app has a compact titlebar, a left connection rail, a Workspace tab strip,
and a main content area. Keep the rail useful without letting it dominate the
active work. The terminal is the main working surface, not a dashboard card.
Bound dense lists and detail pages so wide windows do not stretch their
contents across the screen. Do not repeat a connection's identity in a second
header or status rail.

Restored windows have rounded corners and maximized or fullscreen windows are
square.

On macOS, the native traffic lights overlay one continuous app bar with no
system titlebar, and the same leading space stays reserved in every header that
replaces it.

Compact windows reflow forms, toolbars, and navigation instead of shrinking
type or scaling the app. Keep native window controls fixed and dialogs inside
the viewport. Content stays usable at the supported minimum window size. Stack
list/detail views when two columns no longer fit.

Dividers between panes are draggable and keyboard-operable, and reset on
double-click or Enter. Saved sizes leave the neighboring pane usable, and a
small window may constrain a displayed size without overwriting the saved one.

Scrollbar thumbs fade in only while their own section is hovered. Keep the
gutter reserved so a thumb never shifts content.

## Visual language

### Color and surfaces

Use neutral surfaces to establish depth, with higher surfaces lighter than lower
ones. Reserve built-in hues for status, and pair each with a shape, label, or
other cue. Do not add a new accent color for an individual screen or action.

Use borders and restrained fills to separate controls and surfaces. Selected
rows get an outline around the whole box, never only a left edge. Persistent
navigation selection uses a quiet, faintly warm fill with a hairline border,
never the bright accent. Avoid heavy shadows and reserve stronger elevation for
menus and dialogs.

User-chosen colors, such as connection tags and terminal ANSI colors, identify
things and never imply state.

### Marks and icons

OS, shell, and image marks stay gray at rest and reveal their brand color on
hover, keyboard focus, or selection. All marks share one footprint and artwork
scale. When a mark is unknown, use a generic glyph whose accessible label still
names what was detected.

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
value in a tooltip or inspector. Keep host text intact: dim or highlight it,
never rewrite it.

### Spacing, shape, and motion

Use the existing spacing, radius, and motion tokens. Prefer layout gaps over
one-off margins. Search fields, form inputs, and selectors share one compact
height, a quiet border, and a single focus border without an extra glow.
Selected text uses a neutral gray highlight, never the system blue.

Transitions clarify a state change without delaying work. Compact controls dip
slightly when pressed. Dense rows, tabs, and list items deepen their fill
instead, so high-frequency targets never shift. Sliding selection fills and
content reveals retarget from their current pose when interrupted. Live states
use small cues that rest once their point is made. Never scale or animate the
terminal surface. Reduced motion removes transitions without changing the
outcome.

Interpolate changing numbers briefly from the displayed value. Show first
readings and unavailable values immediately. Assistive technology reads the
collected value, not animation frames.

## Interaction patterns

### Controls and state

Interactive controls need clear default, hover, selected, focus-visible, and
disabled states. Use one primary action for the main decision, secondary
actions for alternatives, danger styling for confirmed destructive work, and
labelled icon buttons for compact controls. Filled accent is reserved for the
main decision inside a dialog or flow, so persistent actions stay quiet. An
unavailable primary action recedes to an outline with faint text, so it never
outweighs the enabled buttons beside it. Icon-only delete buttons in lists stay
neutral until hovered or focused, then turn red.

Row and tab actions such as Rename, Close, or a three-dot menu appear on hover
or keyboard focus, in space the content uses at rest.

Tooltips name icon-only controls, explain shape-only status marks, show values
that can be cut off, and say what a button does when its text does not. Do not
add one that repeats the visible label or sits on a universally understood
control such as a close or clear cross. A trigger's tooltip stays hidden while
the menu or panel it opened is showing.

Status indicators sit after labels, stay circular in every state, and hide when
idle. Work in progress uses a neutral rotating ring. Activity the user has not
seen gets a subtle cue that clears when they return, never a gray unread badge.

### Feedback and errors

When a first read has a known shape, show a static skeleton where the content
will appear: rows for lists, label and value pairs for fields, lines for text,
and a host with its nodes for a graph canvas. The surrounding pane, toolbar, or
dialog stays in place, and the skeleton carries a status naming what is being
read. A refresh keeps the existing data visible instead. Work whose result has
no known shape keeps the rotating ring.

When cached data is visible, mark it stale. Give errors a recovery action when
one exists and keep the specific cause when it helps the user recover. Inline
errors use an alert icon and the message on a faint red tint, without a
bordered box. Warnings use the same shape in amber, and successes use it in
green. Offer sudo only for a permission error.

### Overlays and dialogs

Menus, panels, and popovers open as anchored overlays with one shared entrance
and exit motion. They flip above the trigger when the window lacks room, keep
their edges inside the window gutters, and dismiss after a resize instead of
floating away from their anchor. Menus support arrow keys, Home, End, Enter,
and Escape.

Use app dialogs for confirmation and editing. Give them an accessible title,
move keyboard focus in, keep it there, and return it on close. Keep the title
and actions visible while a long body scrolls. Write titles in sentence case,
naming the action the way the button that opened it does. Let the title,
placeholders, and defaults explain a form instead of an intro paragraph or
required markers, and lay its fields on one grid. Size a dialog to its content.
When a hint points to a control elsewhere, show that control's icon beside its
exact name.

### Canvas and inspector

Graph views share one pan-and-zoom canvas, its camera controls, its selection
behavior, and its inspector layout. Fit the whole graph on load and reset.
Selecting a node opens a closable inspector from the right. Close, Escape, and
clicking empty canvas close it and return focus to the node. Inspectors have a
fixed heading and fixed actions around a separately scrolling body. Route
connectors through gutters, never through cards.

### Discoverability

Keep the command palette searchable and keyboard-operable, and make shortcuts
discoverable through it, tooltips, or nearby hints. The full shortcut list
belongs in `docs/src/content/docs/reference/keyboard-shortcuts.md`.

## Accessibility

- Maintain readable contrast for text, controls, focus rings, and status cues.
- Provide visible keyboard focus and keyboard access to actions that appear on
  hover.
- Use semantic buttons, inputs, and dialog roles. Give icon-only controls names.
- Pair color with text, shape, position, or another cue.
- Keep exiting and hidden controls inert and out of the accessibility tree.
- Do not rely on motion to communicate state.

## Maintaining this guide

Record a decision here only when it applies across the app: the palette,
surfaces, type, motion, or a pattern several screens share. A rule that belongs
to one feature goes in that feature's code, tests, and `docs/`, not here. Leave
exact values to `src/styles.css`. `src/color-palette.test.ts` and
`src/ui-hierarchy.test.ts` protect selected palette, contrast, and structural
rules. If a design decision changes, update the relevant guardrail and explain
the reason in the change.
