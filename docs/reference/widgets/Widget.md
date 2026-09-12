# Widget

What every control is, before it is anything in particular.

`Widget` is the class at the root of the set: a `Label`, a `Button`, a `Split`, a
`Form` and a component of your own all have everything on this page, with the
same names and the same meanings. **You never make one** — there is no
`new Widget()` — and that is the point: what is here is the vocabulary that does
not change from one control to the next, so learning it once is learning it for
all of them.

Two classes sit between this and the rest, and they add nothing a form has to
learn separately: **`Control`** is the branch for the things that are not
containers, and **[`Container`](Container.md)** is the one for the things that
hold other controls — `Add`, `Children`, `Clear` and the layout words live there.

## Every member

Everything it has, in one place. Each links to where it is explained; the short
phrase is there so a name can be found by eye, and the sentence that matters is
in the section.

**Properties**

| | | |
|---|---|---|
| `AcceptDrop` | takes a drop from this application | [drag and drop](#drag-and-drop) |
| `AcceptFiles` | takes files dropped from the desktop | [drag and drop](#drag-and-drop) |
| `Action` | the command this control points at | [commands, menus and keys](#commands-menus-and-keys) |
| `Background` | any CSS colour, `""` for the theme's | [how it looks](#how-it-looks) |
| `Border` | `"2 dashed #3584e4"` | [how it looks](#how-it-looks) |
| `ColumnSpan` | how many columns of a `Grid` it covers | [how it is placed](#how-it-is-placed) |
| `Cursor` | what the pointer looks like over it | [how it looks](#how-it-looks) |
| `Dark` (ro) | whether it is drawn on a dark ground | [how it looks](#how-it-looks) |
| `DragData` | the string that travels when it is dragged | [drag and drop](#drag-and-drop) |
| `Enabled` | answers the mouse and the keyboard | [shown, enabled, focused](#shown-enabled-focused) |
| `Expand` | absorbs slack on both axes | [how it is placed](#how-it-is-placed) |
| `Focusable` | can take the keyboard focus | [shown, enabled, focused](#shown-enabled-focused) |
| `Focused` (ro) | whether the focus is **within** it | [shown, enabled, focused](#shown-enabled-focused) |
| `Font` | a Pango description, or part of one | [how it looks](#how-it-looks) |
| `FontScale` | a multiplier on the size in force | [how it looks](#how-it-looks) |
| `Foreground` | the colour of its text | [how it looks](#how-it-looks) |
| `HAlign` | what becomes of it across its room | [how it is placed](#how-it-is-placed) |
| `HExpand` | absorbs horizontal slack | [how it is placed](#how-it-is-placed) |
| `Height` | height **requested**: a minimum | [where it is and how big](#where-it-is-and-how-big) |
| `Margin` | room around it, one number | [how it is placed](#how-it-is-placed) |
| `Menu` | a context menu | [commands, menus and keys](#commands-menus-and-keys) |
| `MinWidth` | the floor a stretched control keeps | [how it is placed](#how-it-is-placed) |
| `MinHeight` | the same downwards | [how it is placed](#how-it-is-placed) |
| `Name` | how the form reaches it, and its handlers' prefix | [name and identity](#name-and-identity) |
| `Opacity` | `0`…`1` | [how it looks](#how-it-looks) |
| `Padding` | room inside it | [how it looks](#how-it-looks) |
| `Radius` | rounded corners | [how it looks](#how-it-looks) |
| `Shadow` | `"x y blur [spread] [colour]"` | [how it looks](#how-it-looks) |
| `Shortcut` | the key that activates it | [commands, menus and keys](#commands-menus-and-keys) |
| `Style` | the CSS classes it wears | [how it looks](#how-it-looks) |
| `TabIndex` | where Tab reaches it | [how it is placed](#how-it-is-placed) |
| `Tooltip` | plain text, **translated** | [words on it](#words-on-it) |
| `VAlign` | the same, vertically | [how it is placed](#how-it-is-placed) |
| `VExpand` | absorbs vertical slack | [how it is placed](#how-it-is-placed) |
| `Visible` | shown or not | [shown, enabled, focused](#shown-enabled-focused) |
| `Width` | width **requested**: a minimum, not a size | [where it is and how big](#where-it-is-and-how-big) |
| `X` | left edge, in the parent's coordinates | [where it is and how big](#where-it-is-and-how-big) |
| `Y` | top edge, likewise | [where it is and how big](#where-it-is-and-how-big) |

**Methods**

| | | |
|---|---|---|
| `Bounds([container])` | → what GTK really allocated | [where it is and how big](#where-it-is-and-how-big) |
| `CssNode()` | → the node name it is styled as | [what it answers about itself](#what-it-answers-about-itself) |
| `Delete()` | removes it **and destroys it** | [shown, enabled, focused](#shown-enabled-focused) |
| `Emit(event, …)` | raises an event on the form | [commands, menus and keys](#commands-menus-and-keys) |
| `EventNames()` | → the events it raises, most derived first | [what it answers about itself](#what-it-answers-about-itself) |
| `Hide()` | makes it invisible, keeping its place | [shown, enabled, focused](#shown-enabled-focused) |
| `Lower()` | to the bottom of the painting order | [how it is placed](#how-it-is-placed) |
| `Move(x, y)` | sets `X` and `Y` together | [where it is and how big](#where-it-is-and-how-big) |
| `OriginIn(container)` | → where it sits in that container | [where it is and how big](#where-it-is-and-how-big) |
| `PopupMenu(x, y)` | opens its `Menu` at a point | [commands, menus and keys](#commands-menus-and-keys) |
| `PropertyOptions(name)` | → the exact strings that property takes | [what it answers about itself](#what-it-answers-about-itself) |
| `Raise()` | to the top | [how it is placed](#how-it-is-placed) |
| `Remove()` | detaches it **without** destroying it | [shown, enabled, focused](#shown-enabled-focused) |
| `Resize(width, height)` | sets `Width` and `Height` together | [where it is and how big](#where-it-is-and-how-big) |
| `SetFocus()` | gives it the keyboard focus | [shown, enabled, focused](#shown-enabled-focused) |
| `Show()` | makes it visible | [shown, enabled, focused](#shown-enabled-focused) |
| `SizeRequest()` | → `[width, height]` as requested, `-1` for unasked | [where it is and how big](#where-it-is-and-how-big) |
| `StyleRule()` | → the CSS rule its own class carries | [what it answers about itself](#what-it-answers-about-itself) |
| `TextProperties()` | → which of its properties hold prose | [words on it](#words-on-it) |

**Events**

| | | |
|---|---|---|
| `DblClick(x, y, button, ctrl, shift)` | two clicks | [the mouse and the keyboard](#the-mouse-and-the-keyboard) |
| `Drop(data, x, y)` | something was dropped on it | [drag and drop](#drag-and-drop) |
| `FileDrop(paths, x, y)` | files were dropped on it | [drag and drop](#drag-and-drop) |
| `GotFocus()` | the focus arrived **anywhere within it** | [shown, enabled, focused](#shown-enabled-focused) |
| `KeyPress(key, ctrl, shift, alt)` | a key went down. **`true` consumes it** | [the mouse and the keyboard](#the-mouse-and-the-keyboard) |
| `KeyRelease(key, ctrl, shift, alt)` | and came up | [the mouse and the keyboard](#the-mouse-and-the-keyboard) |
| `LostFocus()` | *the user is done with this one* | [shown, enabled, focused](#shown-enabled-focused) |
| `MouseDown(x, y, button, ctrl, shift)` | a button went down on it | [the mouse and the keyboard](#the-mouse-and-the-keyboard) |
| `MouseEnter(x, y)` | the pointer came in | [the mouse and the keyboard](#the-mouse-and-the-keyboard) |
| `MouseLeave()` | and left | [the mouse and the keyboard](#the-mouse-and-the-keyboard) |
| `MouseMove(x, y, button, ctrl, shift)` | it moved over it; `button` is `0` | [the mouse and the keyboard](#the-mouse-and-the-keyboard) |
| `MouseUp(x, y, button, ctrl, shift)` | and came up | [the mouse and the keyboard](#the-mouse-and-the-keyboard) |
| `MouseWheel(dx, dy)` | the wheel turned. **`true` consumes it** | [the mouse and the keyboard](#the-mouse-and-the-keyboard) |

**And what `rad.js` adds**, on every widget just the same — `PropertyNames()`,
`Serialize()`, `Apply(properties)`, `Declared(name)`, `Fill(…)`, `Dump()`,
`SetDesign(name, value)`, `DesignValue(name)`, `SetItem(of, count)`, `Item` — in
[what it answers about itself](#what-it-answers-about-itself).

## Name and identity

| | |
|---|---|
| `Name` | how the form reaches it — `this.BtnSave` — and the prefix its handlers carry: `BtnSave_Click`. A valid JavaScript identifier, unique on the form |

**The name is the wiring.** Events are dispatched by name: a control called
`BtnSave` raises its `Click` at the method `BtnSave_Click` on the form that owns
it, and nothing has to be connected, registered or bound. Renaming a control
renames its handlers — which is why the IDE's rename does both, and why renaming
one by hand in a `.form` leaves a handler nothing will ever call.

It is also why a widget built in code gets a `Name` before it gets anything else
if you want events from it, and why two controls on one form may not share one.

## Where it is and how big

| | |
|---|---|
| `X` | the left edge, in the parent's coordinates. **It means something only inside a container laying out by coordinate**; in a row or a column the parent decides and this reports where it ended up |
| `Y` | the top edge, likewise |
| `Width` | the width **requested**, which is a *minimum* and not an exact size: a control whose contents need more renders larger. Reading it gives what was asked for, falling back to what GTK allocated when nothing was |
| `Height` | the height, likewise |
| `MinWidth` | the floor a **stretched** control may not be squeezed below — see [how it is placed](#how-it-is-placed) |
| `MinHeight` | the same downwards |
| `Move(x, y)` | `X` and `Y` together, because that reads better in a loop |
| `Resize(width, height)` | `Width` and `Height` together |
| `SizeRequest()` | → `[width, height]` as requested, with `-1` on an axis nobody declared. What the serialiser asks, so that a measurement never becomes a floor |
| `Bounds([container])` | → `{ X, Y, Width, Height }`: what GTK really allocated, in window coordinates or in the coordinates of the container you pass |
| `OriginIn(container)` | → `[x, y]`: where this widget's corner is in that container's space |

**A declared size is a floor, not a promise.** `Width: 80` on a `Label` with a
long sentence in it is a label wider than 80, and that is GTK doing what it was
asked. To keep something inside a width, the control needs a way to give text up
— `Ellipsize`, `Wrap`, a `Scroller` around it.

**Nothing has a size before a frame.** `Bounds()` and a `Width` that was never
declared answer `0` until the window has been laid out once, so a measurement
taken in `Form_Open` measures nothing. `Timer.After(0, …)` is where that belongs:
it runs after the layout, and every measured thing in this tree does it that way.

## How it is placed

| | |
|---|---|
| `Expand` | absorbs the slack on both axes — the one word that makes a control fill the room left over in a row or a column |
| `HExpand` | the horizontal half of it, when the two answers differ |
| `VExpand` | and the vertical |
| `HAlign` | `Auto` `Start` `End` `Center` `Fill` — what becomes of it across its room when that room is not the size it was drawn for |
| `VAlign` | the same, down it |
| `Margin` | room **around** it: one number for all four sides, never a list. On a `Form` it insets the contents, a window having no outside |
| `ColumnSpan` | how many columns of a [`Grid`](Grid.md) it runs under |
| `TabIndex` | where Tab reaches it on a surface laid out by coordinate. Sparse, never renumbered; `0` means *in drawn order* |
| `Raise()` | to the top of the painting order, among its siblings on a surface |
| `Lower()` | and to the bottom |

**A stretched control asks for its floor and not for the size it was drawn at**,
and this is the rule that surprises people once: on an axis whose alignment is
`Fill`, the size request becomes `MinWidth`/`MinHeight` rather than
`Width`/`Height` — because the number in the `.form` is where the gaps were
measured from, not a minimum the window must always leave room for. Without it, a
window could never be made smaller than the form was designed. It is also how a
component with a drawn size of its own is put into a small pane: `HAlign` and
`VAlign` of `Fill`, and the floor is whatever `MinWidth`/`MinHeight` say.

## Shown, enabled, focused

| | |
|---|---|
| `Visible` | shown or not. `true` by default; a `Form` starts `false` and `Show()` is what presents it |
| `Show()` | makes it visible |
| `Hide()` | makes it invisible. A hidden control **keeps its place in the tree** and its position in a box |
| `Enabled` | answers the mouse and the keyboard. `true` by default, and **read-only in effect while `Action` is set**: a control that points at a command takes the command's answer |
| `Focusable` | can take the keyboard focus. Turn it on for a container that wants keys — a drawing surface, a board |
| `Focused` (ro) | whether the focus is **within** it, which is why a `TextBox` answers `true` while the focus really sits on the entry inside it |
| `SetFocus()` | puts the focus here |
| `Remove()` | detaches it from its parent **without destroying it**, so it can be put somewhere else |
| `Delete()` | removes it **and destroys it**. What is in it goes too |
| **event** `GotFocus()` | the focus arrived anywhere within it |
| **event** `LostFocus()` | where *the user is done with this box* is said — validation, formatting, saving a field |

**`Remove()` and `Delete()` are the pair worth keeping straight**: one hands the
control back to you, the other ends it. Re-parenting in GTK4 needs the first,
because a container refuses a widget that already has a parent.

## How it looks

| | |
|---|---|
| `Style` | the CSS classes it wears, space separated: `"card title-3"`. **The first thing to reach for**: the theme draws `suggested-action`, `destructive-action`, `dim-label`, `title-1`…`title-4`, `heading`, `card`, `frame`, `boxed-list`, `toolbar`, `flat`, `linked`, `pill`, `monospace` |
| `Background` | any CSS colour; `""` restores the theme's. The **exception** to `Style`, for when the colour is data — a status, a category, a swatch |
| `Foreground` | the same, for the text |
| `Font` | a Pango description (`"Cantarell Bold 12"`) or part of one (`"Bold"`, `"12"`). `""` restores the theme's |
| `FontScale` | a multiplier on whatever size is in force: `1.1` is 110%. `1` is *nothing said*; `0` is refused |
| `Opacity` | `0`…`1`, where `1` is *nothing said* |
| `Padding` | room **inside** it, one to four sizes. `"0"` asks for none, `""` takes the theme's |
| `Radius` | rounded corners, one to four sizes in CSS order: `"8"`, `"8 8 0 0"` |
| `Border` | width, style and colour in one string: `"2 dashed #3584e4"` |
| `Shadow` | `"x y blur [spread] [colour]"`. One shadow, never inset |
| `Cursor` | what the pointer looks like over it: `Auto` `Arrow` `Hand` `Text` `Wait` `Crosshair` `Move` `NotAllowed` `ZoomIn`… A **child** with one of its own wins, which is why `Form.Cursor = "Wait"` is not a busy pointer for the whole window |
| `Dark` (ro) | whether it is drawn on a dark ground, derived from the ink its text uses. What a drawing chooses its palette by |

**Reach for `Style` before the colour properties.** A class is a name the theme
paints, and it follows the desktop into dark mode, into a high-contrast theme and
into whatever the next release does; a hard-coded `Background` is a decision made
once, on one theme. The colour properties are for the case where the colour *is*
the information.

**Nothing here is a stylesheet.** What a `Style` class means is the theme's, or
your project's `app.css` — see [styles](../../resources.md) — and what this
property does is say which classes the control wears.

## Words on it

| | |
|---|---|
| `Tooltip` | plain text, and `""` is none rather than an empty balloon. **Translated** |
| `TextProperties()` | → which of this control's properties hold prose, which is what the catalogue collects and what a designer offers to translate |
| `Fill(…args)` | fills the **declared** text as a template: a `Label` declared `"{0} files"` and filled with `12` reads *12 files*, and the number stays out of the catalogue |
| `Declared(name)` | → what the `.form` said, whatever has been assigned since — which is what makes `Fill` possible on a control that has already been filled once |

Prose belongs in the `.form` and reaches the user through the catalogue; values
are filled in from code. `Fill` is the join between the two, and the reason a
translated string can carry `{0}` at all.

## Commands, menus and keys

| | |
|---|---|
| `Action` | the **command** this control points at, or `""`. A control that has one takes its `Enabled` — and its `Text` and `Icon` when it declared neither — and refuses an `Enabled` of its own. Only a control that can be pressed may have one |
| `Shortcut` | the key that activates it: `"F5"`, `"<Control>s"`, or a list `["7", "KP_7"]`. **`Return` never fires**, the window claiming it for its default button |
| `Menu` | a context menu, as the same array of items a form's `menus` uses. Reassigning replaces it |
| `PopupMenu(x, y)` | opens that menu at a point in this control's own coordinates — how a button that drops a menu is built |
| `Emit(event, …args)` | raises an event that arrives by name on the host form. **What a component announces itself with** |

**One command, several places.** A toolbar button, a menu item and a context menu
entry that all do the same thing should all name the same `Action`: its
availability is computed once and every one of them follows. Three copies of
`Enabled = …` is how a menu item comes to be greyed while its button is not.

## Drag and drop

| | |
|---|---|
| `DragData` | the string that travels when this control is dragged. Empty turns dragging off |
| `AcceptDrop` | receives a drop from **this application**, which arrives as `Drop` |
| `AcceptFiles` | receives files dragged in from **the desktop**, which arrive as `FileDrop`. Independent of `AcceptDrop`: a control may take one, the other or both |
| **event** `Drop(data, x, y)` | something with a `DragData` was dropped here |
| **event** `FileDrop(paths, x, y)` | files were dropped here. `paths` is an array of full paths — **only files that have one**: something on a remote share has no local path and does not arrive, and a drop of nothing but those is refused rather than delivered empty |

## The mouse and the keyboard

Every widget raises these, with coordinates **relative to itself**:

| | |
|---|---|
| **event** `MouseDown(x, y, button, ctrl, shift)` | a button went down |
| **event** `MouseUp(x, y, button, ctrl, shift)` | and came up |
| **event** `MouseMove(x, y, button, ctrl, shift)` | the pointer moved over it. `button` is `0` here |
| **event** `MouseEnter(x, y)` | the pointer came in |
| **event** `MouseLeave()` | and left — the question motion cannot answer, since there is no `MouseMove` for having gone |
| **event** `MouseWheel(dx, dy)` | how far the wheel turned, in GTK's units: one notch is `1.0` on a wheel and a fraction on a touchpad. **Returning `true` consumes it**, which stops the scroller around it from also moving |
| **event** `DblClick(x, y, button, ctrl, shift)` | two clicks |
| **event** `KeyPress(key, ctrl, shift, alt)` | a key went down. **Returning `true` consumes it.** A control that edits text claims a printable key, so on a `TextBox` `b` arrives only as `KeyRelease` |
| **event** `KeyRelease(key, ctrl, shift, alt)` | and came up. Nothing here is consumable |

`key` is the desktop's name for the key — `"Left"`, `"Page_Down"`, `"Escape"`,
`"space"`, `"F5"`, `"plus"` — not a character.

**These are additive and arrive after the control's own behaviour**: a `Button`
still clicks, and a `MouseDown` handler on it runs as well as, not instead of.

## What it answers about itself

Written in `rad.js` rather than in C, and on every widget just the same. This is
the half that makes a designer, a serialiser and a test possible without any of
them being privileged:

| | |
|---|---|
| `PropertyNames()` | → every settable property, found along the prototype chain — including the ones a component of your own declares |
| `PropertyOptions(name)` | → the exact strings that property accepts, or an empty list. What fills a drop-down in the property grid, and the reason a list of values is never typed twice |
| `EventNames()` | → the events it raises, **most derived first**: `[0]` is the one a double click in the designer writes a handler for |
| `Serialize()` | → this widget as a `.form` node |
| `Apply(properties)` | → the widget: the inverse of `Serialize`. A missing dictionary applies nothing, so `Apply(maybe)` is safe |
| `Dump()` | prints the whole subtree with the geometry GTK really allocated. **Reach for this instead of a screenshot**, in a test and while working |
| `StyleRule()` | → the CSS rule this widget's own class currently carries |
| `CssNode()` | → the GTK node name it is styled as (`"button"`, `"entry"`) |
| `SetDesign(name, value)`, `DesignValue(name)` | what the **designer** shows instead of what the code will fill in. Unreachable from a running application |
| `SetItem(of, count)`, `Item` (ro) | a container: the component the **designer** draws in it while the form is laid out, and how many. See [`item`](../../formats.md#item-what-a-list-holds-while-it-is-being-designed) |

## What goes wrong

- **The handler never runs.** The method's prefix is not the control's `Name`, or
  the control was built in code and never given one. `EventNames()` says what it
  raises; the name says where it arrives.
- **It came out bigger than the `.form` says.** A size is a floor. Give the text
  a way to give up — `Ellipsize`, `Wrap` — or put the thing in a `Scroller`.
- **It came out smaller, or the window will not shrink.** The opposite half of
  the same rule: on a `Fill` axis the floor is `MinWidth`/`MinHeight`, and a
  control that must never be squeezed below something says so there.
- **`Bounds()` answered zeroes.** Nothing has been laid out yet. Measure from
  `Timer.After(0, …)`, not from `Form_Open`.
- **`Enabled = false` did nothing.** The control has an `Action`, and the command
  decides. Set it on the command.
- **The colours look wrong in dark mode.** Hard-coded `Background`/`Foreground`
  do not follow the theme. Use `Style`, and ask `Dark` when a drawing has to
  choose ink for itself.
- **A key never arrives.** Something ahead of it consumed the press, or the
  control is not `Focusable`, or `Return` — which the window's default button
  claims — was the key.
- **A control moved to another parent threw.** GTK4 refuses a widget that already
  has a parent: `Remove()` it first, which detaches without destroying.

## What it does not do

- **No `Text`.** Not every widget has words; the ones that do declare their own,
  and `Caption` is the alias `Form`, `Label`, `Button`, `TextBox` and
  `CheckButton` answer to.
- **No stylesheet of its own.** `Style` names classes; what they mean is the
  theme's or `app.css`'s.
- **No animation, no transition, no transform.** A control is where it is.
- **No `Parent`.** A widget does not publish the container it is in: what holds
  what is the form's, and asking upwards is how a control comes to know about the
  screen it is on.

## See also

[`Container`](Container.md) · [`Form`](Form.md) · [`Label`](Label.md) ·
[forms.md](../../llm/forms.md), for how a `.form` becomes controls ·
[resources.md](../../resources.md), for prose, catalogues and `app.css`
