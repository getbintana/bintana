# Controls

**This is the complete surface, not a selection.** Every property, method and
event of every class is below — 384 rows, covering 217 distinct members and 31
events across 41 classes. If something is not here, the runtime does not have it,
and you should not have to open the project tree to find that out.

It is generated from the runtime and checked against it, which is what makes that
claim worth anything: the class list comes from `Widget.Types()`, the properties
from the accessor tables in C, the enumerated values from `PropertyOptions()`, the
defaults from a freshly built control, and **every event signature's argument
count from the `bta_emit` call that raises it**. `tests/api.sh` fails if a member
exists and is not documented here.

How to read it:

- `Name(args)` is a method; `[args]` are optional; `→` says what it answers.
- **event** `Name(args)` is an event, handled by a method called
  `<Control>_<Name>` on the form. See
  [forms.md](forms.md#behaviour-one-class-methods-named-after-events).
- `(ro)` is read-only: you may read it, the loader cannot assign it, and it never
  appears in a `.form`.
- Enumerated values are **exactly** the strings listed; anything else is refused,
  naming the value. So is a number that is not one.
- **Translated** marks a property whose text goes through `po/`. `Tooltip` is one
  on every control.

## The classes

```
Widget                            (abstract)
├── Control    (abstract)
│   ├── Label  Button  Image  Separator  TextBox  CheckButton  Switch
│   ├── ToggleButton  Picture  Spinner  LinkButton  LevelBar  ProgressBar
│   ├── ListBox  ComboBox  SpinBox  Slider  DatePicker  Calendar  ColorButton
│   ├── FontButton
│   ├── TreeView  TableView  Terminal  DrawingArea  Video
│   └── Editor  (abstract)
│       ├── TextEditor      a plain GtkTextView: a note, a log, observations
│       └── SourceEditor    GtkSourceView: languages, gutter, search, marks
└── Container  (abstract)
    ├── Panel  Frame  Expander  Grid  Flow  Scroller  RowList  Overlay
    ├── Split  Notebook  Switcher
    ├── Form
    └── Component
```

`Widget`, `Control`, `Container` and `Editor` cannot be instantiated. `Form` and `Component`
are what a project's own classes extend.


### Where to find one

**Inherited by everything:** [`Widget`](#widget--inherited-by-everything) · [`Container`](#container--inherited-by-every-container)

**Controls:** [`Label`](#label) · [`Button`](#button) · [`ToggleButton`](#togglebutton) · [`CheckButton`](#checkbutton) · [`Switch`](#switch) · [`Spinner`](#spinner) · [`Separator`](#separator) · [`LinkButton`](#linkbutton) · [`Image`](#image) · [`Picture`](#picture) · [`Video`](#video) · [`TextBox`](#textbox) · [`SpinBox`](#spinbox) · [`Slider`](#slider) · [`ProgressBar`](#progressbar) · [`LevelBar`](#levelbar) · [`DatePicker`](#datepicker) · [`Calendar`](#calendar) · [`ColorButton`](#colorbutton) · [`FontButton`](#fontbutton) · [`ListBox`](#listbox) · [`ComboBox`](#combobox) · [`TreeView`](#treeview) · [`TableView`](#tableview) · [`TextEditor`](#texteditor) · [`SourceEditor`](#sourceeditor) · [`Terminal`](#terminal) · [`DrawingArea`](#drawingarea)

**Containers:** [`Panel`](#panel) · [`Frame`](#frame) · [`Expander`](#expander) · [`Grid`](#grid) · [`Flow`](#flow) · [`Scroller`](#scroller) · [`RowList`](#rowlist) · [`Overlay`](#overlay) · [`Split`](#split) · [`Notebook`](#notebook) · [`Switcher`](#switcher) · [`Form`](#form) · [`Component`](#component)

## Widget — inherited by everything

Every control and every container has all of this.

| Member | |
|---|---|
| `AcceptDrop` | receives a drop from **this application**, which arrives as `Drop(data, x, y)` |
| `AcceptFiles` | receives files dragged in from **the desktop**, which arrive as `FileDrop(paths, x, y)`. Independent of `AcceptDrop`: a control may take one, the other, or both |
| `Background` | any CSS colour. `""` restores the theme |
| `Border` | `"2 dashed #3584e4"` — width, style, colour |
| `ColumnSpan` | how many columns of a `Grid` it runs under. `1` |
| `DragData` | the string that travels when this is dragged. Empty turns dragging off |
| `Action` | the **command** this control points at, or `""`. A control that has one takes its `Enabled` — and its `Text` and `Icon`, when it declared neither — from the command, and **refuses** to be told an `Enabled` of its own. Only a control that is pressed can have one; a name that is not one of the form's `actions` is refused. See [forms.md](forms.md#actions-one-command-in-several-places) |
| `Enabled` | answers the mouse and the keyboard. `true` by default. Read-only in effect when `Action` is set |
| `Expand` | absorbs slack on both axes, in a row or a column |
| `Focusable` | can take the focus — turn it on for a container that wants keys |
| `Font` | a Pango description — `"Cantarell Bold 12"` — or a partial one: `"Bold"`, `"12"`. `""` restores the theme |
| `FontScale` | a multiplier on whatever size is in force: `1.1` is 110%. `1` is "nothing said"; `0` is refused |
| `Foreground` | likewise, for the text |
| `HAlign` | `Auto` `Start` `End` `Center` `Fill` — what becomes of it when the container is not the size the coordinates were drawn for |
| `HExpand` | absorbs horizontal slack |
| `Height` | height, likewise |
| `Margin` | room around it, **one** number for all four sides. Not a list. On a `Form` it insets the contents — a window has no outside |
| `Menu` | a context menu, as the same array of items a form's `menus` uses. Reassigning replaces it |
| `MinHeight` | the same for `VAlign` |
| `MinWidth` | the floor a stretched control may not be squeezed below. Only means something on an axis whose `HAlign` is `Fill` |
| `Name` | how the form reaches it (`this.<Name>`) and the prefix of its handlers. A valid JS identifier |
| `Opacity` | `0`…`1`. `1` is "nothing said" |
| `Padding` | room inside it, one to four sizes. `"0"` asks for none; `""` takes the theme's |
| `Radius` | rounded corners, one to four sizes in CSS order: `"8"`, `"8 8 0 0"`. `""` or all zeroes is square |
| `Shadow` | `"x y blur [spread] [colour]"`. One shadow, never inset. A colour alone or a bare number is refused |
| `Shortcut` | the key that activates it: `"F5"`, `"<Control>s"`, or a list `["7", "KP_7"]`. **`Return` never fires** — the window claims it for its default button |
| `Style` | the CSS classes it wears, space separated: `"card title-3"`. A name that could not be a class is refused |
| `TabIndex` | where Tab reaches it, on a container laying out by coordinate. Sparse, never renumbered. `0` means "in drawn order" |
| `Tooltip` | plain text; `""` is none, not an empty balloon. **Translated** |
| `VAlign` | the same, vertically |
| `VExpand` | absorbs vertical slack |
| `Visible` | shown or not. `true` by default; a `Form` starts `false` |
| `Width` | width **requested**: a minimum, not an exact size. Reads the allocation when nothing was declared |
| `X` | left edge in pixels, in the parent's coordinates. Means nothing in a row or a column |
| `Y` | top edge, likewise |
| `Focused` (ro) | whether the focus is **within** it — a `TextBox`'s focus really sits on the entry inside it |
| `Bounds([container])` | → `{ X, Y, Width, Height }`, what GTK really allocated — in window coordinates, or in a container's if one is passed |
| `CssNode()` | → the GTK node name it is styled as (`"button"`, `"entry"`) |
| `Delete()` | removes it from its parent **and destroys it** |
| `Emit(event, ...args)` | raises an event that arrives by name on the host form. What a `Component` announces itself with |
| `EventNames()` | → the events it raises, **most derived first**; `[0]` is the one a double click writes a handler for |
| `Hide()` | makes it invisible; it keeps its place in the tree |
| `Lower()` | to the bottom |
| `Move(x, y)` | sets `X` and `Y` together |
| `OriginIn(container)` | → `[x, y]`: where it sits in that container's coordinates |
| `PopupMenu(x, y)` | opens its `Menu` at a point in its own coordinates. How a button that drops a menu is built |
| `PropertyOptions(name)` | → the exact strings that property accepts, or an empty list |
| `Raise()` | to the top of the painting order, among its siblings on a surface |
| `Remove()` | detaches it without destroying it, so it can be put somewhere else |
| `Resize(width, height)` | sets `Width` and `Height` together |
| `SetFocus()` | gives it the keyboard focus |
| `Show()` | makes it visible |
| `SizeRequest()` | → `[width, height]` as **requested**, `-1` on an axis nobody declared. What the serialiser asks, so a measurement never becomes a floor |
| `StyleRule()` | → the CSS rule its per-widget class currently carries |
| `TextProperties()` | → which of its properties hold prose, and so go through the catalogue |

### The events every widget raises

Every one of these reaches a method named `<Control>_<Event>`. The argument list
is what `bta_emit` really passes, counted from the call — not from prose.

| Event | |
|---|---|
| **event** `MouseDown(x, y, button, ctrl, shift)` | coordinates are relative to the widget |
| **event** `MouseUp(x, y, button, ctrl, shift)` |  |
| **event** `MouseMove(x, y, button, ctrl, shift)` | `button` is `0` here |
| **event** `MouseEnter(x, y)` | the question motion cannot answer: there is no `MouseMove` for having left |
| **event** `MouseLeave()` |  |
| **event** `MouseWheel(dx, dy)` | how far it turned, in GTK's units — one notch is `1.0` on a wheel and a fraction on a touchpad. **Returning `true` consumes it**, which stops the scroller around it from also moving |
| **event** `DblClick(x, y, button, ctrl, shift)` |  |
| **event** `KeyPress(key, ctrl, shift, alt)` | **Returning `true` consumes the key.** A control that edits text claims a printable key's press, so on a `TextBox` `b` arrives only as `KeyRelease` |
| **event** `KeyRelease(key, ctrl, shift, alt)` | nothing here is consumable |
| **event** `GotFocus()` | answers for the **control**, so it fires for the focus arriving anywhere within it |
| **event** `LostFocus()` | where "the user is done with this box" is said |
| **event** `Drop(data, x, y)` | something with `DragData` was dropped on a widget with `AcceptDrop` |
| **event** `FileDrop(paths, x, y)` | files were dropped from the file manager or the desktop on a widget with `AcceptFiles`. `paths` is an array of full paths — **only files that have one**: a file on a remote share has no local path and does not arrive, and a drop of nothing but those is refused rather than delivered empty |

### What every widget also answers

Written in `rad.js` rather than in C, and on every widget just the same:

| Member | |
|---|---|
| `PropertyNames()` | → every settable property, discovered along the prototype chain |
| `Serialize()` | → this widget as a `.form` node |
| `Apply(properties)` | → the widget: the inverse of `Serialize`, and a missing dictionary applies nothing |
| `Dump()` | prints the whole subtree with the geometry GTK really allocated. **Reach for this instead of a screenshot** |
| `Declared(name)` | → what the `.form` said, whatever has been assigned since |
| `Fill(...args)` | fills the declared `Text` as a template: `"{0} files"` and the value stays out of the catalogue |
| `SetDesign(name, value)` | what the *designer* shows instead; `""` removes it. Unreachable from a running application |
| `DesignValue(name)` | → that value |
| `Caption` | an alias of `Text` on `Form`, `Label`, `Button`, `TextBox` and `CheckButton` |

## Container — inherited by every container

| Member | |
|---|---|
| `Anchored` | off, children stay where they were drawn however big it gets — a drawing board, not a window. Default `true` |
| `Arrangement` | `Fixed` `Horizontal` `Vertical` — coordinates, a row, or a column. **Not on every container**; see the table above |
| `Homogeneous` | every child the same size along the axis |
| `Spacing` | pixels between children, in a row or a column |
| `Children` (ro) | its real children, one level deep, in order |
| `Add(widget)` | puts a widget in. A `Split` refuses a third |
| `Clear()` | removes and destroys every child, and it can be refilled afterwards |
| `ContainerAt(x, y, [ignore])` | → the innermost container that could take a drop there. `ignore` excludes the widget being dragged, which otherwise always answers |
| `FocusNext()` | → whether the focus moved: what Tab does, kept inside this container |
| `FocusPrevious()` | → the same, backwards |
| `LocalPoint(x, y, from)` | → `[x, y]`: a point in another widget's space, in this container's |
| `PickAt(x, y)` | → the topmost child at that point, or `null` |
| `Reorder(child, index)` | moves a child among its siblings. The index counts them *without* the one being moved. A `Fixed` refuses — there the order is `Raise`/`Lower` |
| `AddNode(node)` | builds a live widget from a `.form` node and adds it |
| `BuildChildren(node)` | replaces the contents with that node's children |

Every container has all of this as well as everything under
[`Widget`](#widget--inherited-by-everything).

**Every container loses a child**, and gives it back: `Clear()`, `Remove()` and a
child's `Delete()` work on all of them, and a container emptied that way takes
children again. A `Grid` re-flows what stayed, so a hole closes up rather than
persisting. The one rule that is not uniform is `Split`, which holds exactly two
halves and refuses a third `Add` — clearing it and refilling it is fine.

So rebuilding a container's contents is the ordinary thing to write:

```js
buildMonth() {
    this.GrdDays.Clear();
    for (let d = 1; d <= days; d++) {
        const cell = new Label();
        cell.Text = String(d);
        this.GrdDays.Add(cell);
    }
}
```

A fixed pool of cells relabelled in place is still the faster shape for something
redrawn on every keystroke — it builds no widgets at all — but it is now a choice
about cost and not the only thing that works.

**`Arrangement` is not on every container.** Measured:

| | `Arrangement` |
|---|---|
| `Panel`, `Frame`, `Expander`, `Scroller`, `Form`, `Component` | `Fixed` (default), `Horizontal`, `Vertical` |
| `Split` | `Horizontal` (default), `Vertical` — there is no `Fixed` half |
| `Grid`, `Flow`, `RowList`, `Overlay`, `Notebook`, `Switcher` | **refused**, reads `""`: *this container arranges its children by its own nature* |

On the ones that accept it, it may be changed at any time, children and all:
they are kept in order, and a `Fixed` container that becomes a row and goes back
gets every coordinate back with it. In a `.form` write it **first** anyway —
that is what the serialiser does, and property assignment is ordered.


---

# Controls

## Label

Text that is not editable.

| Member | |
|---|---|
| `Alignment` | `Left` `Center` `Right`. Default `"Left"` |
| `Ellipsize` | end a line that does not fit with `…` instead of growing |
| `Lines` | at most this many lines; `0` is no limit |
| `Markup` | read `Text` as Pango markup (`<b>`, `<i>`, `<span>`) |
| `Selectable` | the user may select and copy it |
| `Text` | the caption. **Translated** |
| `Wrap` | wrap long text over several lines |

## Button

A press. `Style: "flat"` is a toolbar button, `"suggested-action"` an accented one, `"destructive-action"` the dangerous one, `"circular"` a round one.

| Member | |
|---|---|
| `Cancel` | Escape on this form presses it. Without one, Escape does nothing at all |
| `Default` | Enter on this form presses it. The keyboard only — `Style: "suggested-action"` is the looks |
| `Icon` | an icon name from the theme. With `Text` it builds the box itself; alone it gets the icon-button treatment. **A name the theme cannot draw is dropped in silence** |
| `Text` | the caption. **Translated** |
| `Click()` | presses it from code, handler and all |
| **event** `Click()` | pressed |

## ToggleButton

A button that stays in.

| Member | |
|---|---|
| `Active` | whether it is in |
| `Icon` | as a `Button`'s |
| `Text` | the caption. **Translated** |
| `Click()` | presses it, which toggles `Active` |
| **event** `Click()` | pressed |

## CheckButton

A box one ticks — or, with a `Group`, one of an exclusive set, which is what a radio is. **There is no `RadioButton`**: GTK4 removed it, because belonging to a group is what draws it round, makes the set exclusive and makes a second click leave it on.

| Member | |
|---|---|
| `Active` | whether it is ticked |
| `Group` | empty is a check box; a name makes it one of that exclusive set — which is what a radio is. The container scopes the name |
| `Text` | the caption. **Translated** |
| **event** `Click()` | pressed |

## Switch

A setting that takes effect at once.

| Member | |
|---|---|
| `Active` | whether it is on. No caption: the words beside it are a `Label` |
| **event** `Click()` | pressed |

## Spinner

Work with no end in sight, which is most work.

| Member | |
|---|---|
| `Active` | whether it spins. Work with no end in sight |

## Separator

A rule.

| Member | |
|---|---|
| `Orientation` | `Horizontal` `Vertical`. **The thickness is the line**: it paints its whole allocation, so one 12 high is a line 12 thick. Room around it goes on `Margin`. Default `"Horizontal"` |

## LinkButton

An address, handed to the desktop.

| Member | |
|---|---|
| `Text` | what it reads. **Translated** |
| `Uri` | the address, handed to the desktop on click |
| **event** `Click()` | pressed |

## Image

An icon or a small picture, drawn at a size. `Icon` **or** `File`, one at a time.

| Member | |
|---|---|
| `File` | a path. Setting it clears `Icon` |
| `Icon` | a theme icon name. Setting it clears `File` |
| `Size` | pixels; `-1` is the icon's natural size. Default `-1` |

## Picture

A photograph, which is not an icon.

| Member | |
|---|---|
| `File` | the photograph's path |
| `Fit` | `Fill` `Contain` `Cover` `ScaleDown`. Default `"Contain"` |
| `Zoom` | a factor, for when `Fit` is not what is wanted |
| `SourceWidth` (ro) | the file's own width, `0` with no file |
| `SourceHeight` (ro) | the file's own height |

## TextBox

One line of editable text.

| Member | |
|---|---|
| `ActivatesDefault` | Enter presses the form's default button *instead of* raising `Activate` |
| `Alignment` | `Left` `Center` `Right`. Default `"Left"` |
| `Icon` | an icon inside the field; clicking it raises `IconClick` |
| `MaxLength` | characters; `0` is no limit |
| `Password` | the characters are hidden |
| `Placeholder` | shown while it is empty. **Translated** |
| `Purpose` | `Text` `Digits` `Number` `Phone` `Url` `Email` `Name` — what the keyboard and the input method should expect. Default `"Text"` |
| `ReadOnly` | shown but not editable |
| `Text` | what is in it |
| `SelectedText` (ro) | what is selected, `""` for nothing |
| `Select(start, length)` | selects that run |
| `SelectAll()` | selects everything, so typing replaces it |
| **event** `Change()` | the value changed, including from an assignment in code — the round trip goes out to GTK and back |
| **event** `Activate()` | Enter in the field, or a double click on a row |
| **event** `IconClick()` | the icon inside the field was clicked |

## SpinBox

A number typed or stepped.

| Member | |
|---|---|
| `Decimals` | places shown and accepted |
| `Max` | the ceiling, likewise. Default `1000000` |
| `Min` | the floor. **Declare it before `Value`** or the value is clamped to the factory range. Default `-1000000` |
| `Numeric` | refuse anything that is not a number. Default `true` |
| `Step` | what one press of an arrow moves. Default `1` |
| `Value` | the number |
| `Wrap` | past `Max` comes back to `Min` |
| **event** `Change()` | the value changed, including from an assignment in code — the round trip goes out to GTK and back |
| **event** `Activate()` | Enter in the field, or a double click on a row |

## Slider

The same four words a `SpinBox` uses, asked with the mouse.

| Member | |
|---|---|
| `Decimals` | places in the number it shows |
| `Inverted` | the high end at the other side |
| `Max` | the ceiling. Default `100` |
| `Min` | the floor; declare before `Value` |
| `Orientation` | `Horizontal` `Vertical`. Default `"Horizontal"` |
| `ShowValue` | draw the number beside the rail |
| `Step` | what an arrow key moves; Page moves ten of them. Default `1` |
| `Value` | the number |
| `ValuePosition` | `Top` `Bottom` `Left` `Right`. Default `"Top"` |
| `ClearMarks()` | takes them all off |
| `Mark(value, [text])` | a tick at that value, with an optional label |
| **event** `Change()` | the value changed, including from an assignment in code — the round trip goes out to GTK and back |

## ProgressBar

Work with an end in sight.

| Member | |
|---|---|
| `Orientation` | `Horizontal` `Vertical`. Default `"Horizontal"` |
| `ShowText` | draw `Text` inside the bar |
| `Text` | what it reads, if `ShowText`. **Translated** |
| `Value` | `0` to `100`, clamped rather than refused |
| `Pulse()` | one step of the indeterminate animation. For work with no measurable end, a `Spinner` says it better |

## LevelBar

A reading, not a progress.

| Member | |
|---|---|
| `Max` | the top. Default `1` |
| `Min` | the bottom of the scale |
| `Mode` | `Continuous` `Discrete` — a bar, or blocks. Default `"Continuous"` |
| `Orientation` | `Horizontal` `Vertical`. Default `"Horizontal"` |
| `Value` | the reading |

## DatePicker

A date on one line, with a calendar in its popover.

| Member | |
|---|---|
| `Format` | a strftime pattern for what the button reads. Default `"%Y-%m-%d"` |
| `Value` | `"YYYY-MM-DD"`, the same text a `Day` works in. Default is today |
| **event** `Change()` | the value changed, including from an assignment in code — the round trip goes out to GTK and back |

**Turning the page in the popover is a change of value.** GTK has one date and no
separate notion of the month on screen, so browsing to another month moves `Value`
with it — and raises `Change`, like any other way of changing it. A form that must
not be moved by browsing should read the value when the user says *done*
(`Form_Close`, an OK button) rather than trust the last `Change`.

## Calendar

The month itself, where a `DatePicker` is the same date on one line. Both answer
the same ISO text; this one has the room to mark days on it.

| Member | |
|---|---|
| `Marks` (ro) | the dates marked, as `"YYYY-MM-DD"` strings, earliest first |
| `ShowDayNames` | the row of weekday names. Default `true` |
| `ShowHeading` | the month and year above the grid. Default `true` |
| `ShowWeekNumbers` | the week number down the side. Default `false` |
| `Value` | `"YYYY-MM-DD"`, the same text a `Day` works in. Default is today |
| `ClearMarks()` | takes them all off |
| `Mark(date)` | marks that date. Marking one twice marks it once |
| `Unmark(date)` | takes that one off. One that was not marked is not an error |
| **event** `Change()` | the value changed, including from an assignment in code — the round trip goes out to GTK and back |

**A mark is a date, and only the ones in the month on screen are drawn.** Mark
the 4th of April while March is showing and nothing appears until the page is
turned to April; the list is what the calendar holds and the marks are a drawing
of the part of it in view. Turning the page draws the marks of the new month with
nothing to re-apply.

`Marks` is read-only because marks are what the application knows — which days
are taken — and not something a designer draws, so no `.form` carries one.
`Mark` refuses a string that is not a date the way `Value` does, and normalises
what it takes: `"2026-3-9"` and `"2026-03-09"` are one mark.

`Value` is the day selected **and** the month on screen, since GTK has one of
each: assigning a date in another month turns the page to it, and turning the page
by hand moves the value — raising `Change`, because it is the same property. What
stays one event is the assignment: one `Value =` is one `Change`, whatever month
it lands in.

## ColorButton

A swatch that opens the desktop's chooser, with a clear beside it.

| Member | |
|---|---|
| `Value` | a CSS colour, `""` for none. What comes back is what `Background` takes |
| **event** `Change()` | the value changed, including from an assignment in code — the round trip goes out to GTK and back |

## FontButton

The font shown in itself, with a clear beside it.

| Member | |
|---|---|
| `Value` | a Pango description, `""` for none |
| **event** `Change()` | the value changed, including from an assignment in code — the round trip goes out to GTK and back |

## The four lists

They differ in **what a row is**, and in nothing else that could have been the
same:

| | a row is | reach for it when |
|---|---|---|
| [`ListBox`](#listbox) | a string | the list is words, and they may be translated |
| [`RowList`](#rowlist) | a **widget** you built | a row is a small form: fields, a switch, a button |
| [`TreeView`](#treeview) | a name, addressed by key | a hierarchy, with no heading row |
| [`TableView`](#tableview) | fields, and they may nest | rows have columns — flat, on demand, or a tree |

**The words for using one are the words for using the next.** `Index` is the
selected row and `Count` is how many; `MultiSelect` with `Selection`,
`Select(i)`, `Deselect(i)`, `SelectAll()` and `DeselectAll()` are the same six
members wherever more than one row can be chosen; `Add`, `Remove` and `Clear`
put rows in and take them out; `Select` and `Activate` are the two events, with
`ActivateOnSingleClick` deciding which click raises the second. What differs is
only what `Add` takes, and that is the difference between the controls.

What is not shared is what one control alone can answer: `Items` and `Text` need
rows that *are* text (`ListBox`, and `ComboBox` beside it), `Filter` needs rows
that are widgets (`RowList`), `Columns`, `Cell` and `Sortable` need fields
(`TableView`), and `Key`, `Expanded` and the rest of the nesting words belong to
the two that nest.

## ListBox

A list of strings.

| Member | |
|---|---|
| `ActivateOnSingleClick` | raise `Activate` on one click instead of two |
| `Index` | the selected row, `-1` for none. Default `-1` |
| `Items` | the whole list, as an array of strings. **Translated** |
| `MultiSelect` | more than one row at a time |
| `Text` (ro) | the selected row's text |
| `Count` (ro) | how many rows |
| `Selection` (ro) | the selected indices, as an array |
| `Activate(index)` | raises `Activate` for that row, as a double click would |
| `Add(text)` | one row at the end |
| `Clear()` | empties it |
| `Deselect(index)` | unselects it |
| `DeselectAll()` | selects nothing |
| `Remove(index)` | takes that row out |
| `Select(index)` | selects that row |
| `SelectAll()` | with `MultiSelect` |
| **event** `Select()` | the selection moved. Ask `Index` or `Text` for what it is now |
| **event** `Activate()` | Enter in the field, or a double click on a row |

## ComboBox

A drop-down.

| Member | |
|---|---|
| `Index` | which is chosen, `-1` for none. Default `-1` |
| `Items` | the drop-down's contents. **Translated** |
| `Text` | the chosen text |
| `Count` (ro) | how many |
| `Add(text)` | one more |
| `Clear()` | empties it |
| **event** `Select()` | the selection moved. Ask `Index` or `Text` for what it is now |

## TreeView

One column of text, in a hierarchy, addressed by **key**.

**Which of the two hierarchy controls to use is decided by one thing, and GTK
decides it**: a `TableView` cannot hide its heading row. So a hierarchy *without*
headings is a `TreeView`; one *with* them — columns, widths, alignment — is a
`TableView` whose rows nest ([below](#tableview)).

Everything they both do, they do with the same words: `Key`, `Count`,
`AutoExpand`, `Add`, `Clear`, `Remove(key)` (with the subtree), `Exists`,
`ExpandNode`, `CollapseNode`, `Expanded`, `ExpandAll`, `CollapseAll`, `SetIcon`.
Three things differ, and each for a reason worth knowing:

- **`Add`.** Here it is `Add(key, text, [parentKey], [icon])`, because in a tree
  every row *is* a node and the key is not optional. There it is
  `Add(values, [{ Key, Parent, Icon }])`, because a table's row may or may not be
  one, and the options are what say which.
- **`Text`.** A node has one, so this control answers it. A table's row has
  several cells and *which* would be "the text" is arbitrary — it answers
  `Cell(key, column)` instead.
- **`Index`.** A `TableView` has one because it is also a flat list. A tree is
  addressed by key and only by key — a position is a position in the *visible*
  list, and it moves when something above it collapses.

| Member | |
|---|---|
| `AutoExpand` | expand a node when it gains children. Default `true` |
| `Key` | the selected node's key; assigning selects. Keys are yours to choose — a path, an id |
| `Text` (ro) | the selected node's text |
| `Count` (ro) | how many nodes, at every level |
| `Add(key, text, [parentKey], [icon])` | a node. Empty `parentKey` is a root; an icon the theme lacks is dropped |
| `Clear()` | empties the whole tree |
| `CollapseAll()` | every node |
| `CollapseNode(key)` | closes it |
| `Exists(key)` | → whether that node is there |
| `Remove(key)` | takes that node out **and the subtree with it** — a node whose parent is gone is not something this control can show |
| `SetText(key, text)` | renames a node. **Translated** |
| `SetIcon(key, name)` | its icon, or `""` for none. One column, so no column argument — otherwise it is `TableView`'s |
| `ExpandAll()` | every node |
| `ExpandNode(key)` | opens it. Not `Expand`, which is `Widget`'s layout property |
| `Expanded(key)` | → whether it is open |
| **event** `Select()` | the selection moved. Ask `Key` or `Text` for what it is now |
| **event** `Activate()` | Enter in the field, or a double click on a row |

## TableView

A list with columns, **and its rows may nest**. The control to reach for whenever rows have fields: `TreeView` is one column of a hierarchy with no headings, `ListBox` is strings, `RowList` is widgets and `Grid` is a layout.

| Member | |
|---|---|
| `ColumnLines` | rules between columns |
| `Columns` | an array of `{ Text, Width, Alignment }`. `Text` is **translated**; `Width: 0` sizes itself and the last column takes the slack |
| `Count` | how many rows — **settable**, which is the on-demand mode: the table then asks `Data(row, column)` for each cell it draws |
| `Index` | the selected row, `-1` for none. Default `-1` |
| `MultiSelect` | more than one row |
| `RowLines` | rules between rows. Default `true` |
| `Sortable` | makes the headers clickable. **The table does not reorder itself** — it raises `Sort` |
| `Selection` (ro) | the selected indices |
| `Add(values, [options])` | one row, as an array of strings. A row shorter than there are columns reads `""` for the rest. Clears an on-demand `Count`. **`options` is `{ Key, Parent, Icon }`, and a row with a `Key` is a node**: the first one makes this table a tree, `Parent` is the key of the node it goes under (absent is a root), and `Icon` is the picture for its first column — the same one `TreeView.Add` takes, so a node need not be added and then decorated |
| `AutoExpand` | a node comes open when it gains children. Default `true`. A tree only |
| `Key` | the selected node's key; assigning selects, opening the way to it. `""` selects nothing. A tree only |
| `Exists(key)` | → whether that node is there. `false` on a flat table rather than a refusal: it is the question you ask before you know |
| `ExpandNode(key)`, `CollapseNode(key)` | opens or closes it. Opening opens the way to it too, since a row only exists once its ancestors are open. Not `Expand`, which is `Widget`'s layout property |
| `ExpandAll()`, `CollapseAll()` | every node |
| `Expanded(key)` | → whether it is open |
| `Cell(row, column)` | → one value. Refused on an on-demand table |
| `Clear()` | empties it |
| `Remove(index)` | takes a row out |
| `Row(index)` | → that row's values. Refused on an on-demand table |
| `SetCell(row, column, value)` | one cell, in place |
| `SetIcon(row, column, name)` | an icon beside a cell's text. Refused on an on-demand table |
| `Select(index)`, `Deselect(index)` | move the selection from code. `Select` leaves the others alone where several are allowed |
| `SelectAll()` | with `MultiSelect` |
| `DeselectAll()` | selects nothing |
| `SortBy(column, [ascending])` | actually reorders the rows it holds |
| `SortColumn(column, [ascending])` | the heading clicked from code: the arrow moves and `Sort` is raised |
| **event** `Select()` | the selection moved. Ask `Index` for where it is, `Cell`/`Row` for what — and `Key` when this table is a tree |
| **event** `Activate()` | Enter in the field, or a double click on a row |
| **event** `Data(row, column)` | an on-demand table needs a cell. **The return value is the answer**: a string, or `{ Text, Icon }` |
| **event** `Sort(column, ascending)` | a sortable header was clicked. **The handler decides** — `SortBy` is what actually reorders |

### A table is flat or a tree

Decided by the first row put in it, and `Clear()` decides again:

| | `Add(values)` | `Add(values, { Key })` | `Count = n` |
|---|---|---|---|
| **flat, holding its rows** | ✔ | ✖ | clears the rows |
| **flat, on demand** | clears the `Count` | ✖ | ✔ |
| **a tree** | ✖ | ✔ | ✖ |

**In a tree, a row is addressed by its key** — `Cell(key, column)`,
`SetCell(key, …)`, `SetIcon(key, …)`, `Row(key)`, `Remove(key)`, which takes the
subtree with it. That is not a second spelling of the same thing: a *position* in
a tree is a position in the **visible** list, so it moves when something above it
collapses. `Index` still answers where the highlight is right now; `Key` is what
to keep.

`MultiSelect` is refused on a tree — a hierarchy is selected one node at a time,
which is what `TreeView` has always been. `Count` is read-only there and counts
**every node at every level**, the way `TreeView.Count` does.

`Sortable` and `SortBy` work, and **sort siblings within each parent**: sorting
the flattened list would put a child above its own parent, which is not an order.
The selection survives a sort in both modes.

## Editor — inherited by both editors

Abstract: a buffer of text with a cursor in it. `TextEditor` and `SourceEditor`
have all of this, and it is written once because GTK's own hierarchy is the same
shape — a `GtkSourceView` *is* a `GtkTextView`.

| Member | |
|---|---|
| `Modified` | the editing flag. Clear it after saving |
| `ReadOnly` | shown but not editable. The *program* can still write to it, which is what a log pane wants |
| `Text` | everything in the buffer |
| `Wrap` | wrap long lines. Default `true` on a `TextEditor`, `false` on a `SourceEditor` |
| `Line` (ro) | the cursor's line, counting from 1 |
| `Column` (ro) | the cursor's column |
| `Selection` (ro) | the selected text |
| `CanUndo` (ro) | whether there is anything to undo |
| `CanRedo` (ro) | likewise |
| `Append(text)` | at the end, scrolling there, whatever the cursor was doing |
| `Clear()` | empties it |
| `GotoLine(line)` | puts the cursor there and scrolls to it |
| `Insert(text)` | at the cursor. The selection is left alone, so on a selected word this lands after it rather than replacing it |
| `Redo()` | one step forward |
| `Select(line, [column], [length])` | selects from there. A column past the end of the line is the end of the line |
| `Undo()` | one step back |
| **event** `Change()` | the value changed, including from an assignment in code — the round trip goes out to GTK and back |
| **event** `Cursor()` | the cursor moved. `Line` and `Column` say where |

## TextEditor

A `GtkTextView`: the plain multi-line field. Observations, a note, a description,
a log pane — the text a `TextBox` cannot hold, since a `GtkEntry` has no notion of
a newline at all.

Everything it has is [`Editor`](#editor--inherited-by-both-editors)'s. What is its
own is what it arrives as: **wrapping**, in the theme's font, with no gutter and
nothing to highlight.

| Member | |
|---|---|
| `Text` | the text. **Translated** — a form may declare a starting note like any other caption |

**`Text` is prose here and is not on a `SourceEditor`**, and that is the whole
reason the two are siblings under an abstract class instead of one extending the
other: the declaration accumulates down a class chain, so a source editor
inheriting this row would put a line of somebody's code in a `.po` file.

## SourceEditor

GtkSourceView: highlighting, completion, search and gutter marks are the widget's
own. It is [`Editor`](#editor--inherited-by-both-editors) plus everything below.

| Member | |
|---|---|
| `Completion` | offer completions while typing, which arrive as `Complete` |
| `CompletionTitle` | the heading of that popup. **Translated** |
| `Language` | a GtkSourceView id: `js` `json` `c` `python3` `markdown` `css` `sh` `xml` `sql` `yaml` `diff` … `""` for none. `PropertyOptions("Language")` asks this machine what it has |
| `ShowLineNumbers` | the gutter's numbers. Default `true` |
| `ShowMarks` | the gutter's marks — see `Mark` |
| `Text` | the source. **Not** a text property — a catalogue must never rewrite code |
| `Theme` | `Adwaita` `Adwaita-dark` `classic` `classic-dark` `cobalt` `cobalt-light` `kate` `kate-dark` `oblivion` `solarized-light` `solarized-dark` `tango`. Default `"classic"` |
| `Matches` (ro) | how many `Search` found |
| `MatchIndex` (ro) | which one the cursor is standing on |
| `ClearMarks([kind])` | takes them off every line |
| `FindNext()` | moves to the next match, wrapping around |
| `FindPrevious()` | and backwards |
| `Mark(line, kind, [text])` | a gutter mark. `kind` is `Error` `Warning` `Info` or `Bookmark` |
| `Marks([kind])` | → the lines that carry one |
| `Replace(with)` | the match the cursor is standing on |
| `ReplaceAll(with)` | every match |
| `Search(text, [{CaseSensitive, WholeWord, Regex}])` | → how many there are, highlighting every one. **It does not move the cursor**: typing in a find field and jumping to a match happen at different moments |
| `ShowCompletion()` | opens the completion popup from code |
| `Unmark(line, [kind])` | takes marks off that line |
| **event** `Complete(word, line, column, text)` | a completion was asked for. Answer with a list of words, or nothing |

It was called `TextEditor` until there was a real one. A `.form` that still says
`TextEditor` where it means this one now loads the plain editor — and the
source-only properties in it do nothing, **silently**, because the loader assigns
what a file declares without asking whether the class has it. Renaming the type in
the file is the whole of the fix.

## DrawingArea

A surface to draw on. Its `Draw` event hands you a [`Painter`](#painter); nothing
else in this widget set puts ink on the screen.

| Member | |
|---|---|
| `Dump()` | the last frame as text, one call per line — empty until something has been drawn |
| `Redraw()` | the drawing may have changed: ask again |
| `Save(path, [width], [height])` | run the same `Draw` against an image surface and write it as a PNG. Without a size it uses the widget's own, and a surface that has never been allocated has none — so pass one. Refused from inside a `Draw` (one painter, one frame at a time) and above 16384 a side. **A `Draw` that throws writes no file** and the throw reaches the caller |
| `SavePdf(path, width, height, [pages], [before])` | the same `Draw`, once per page, into one **PDF**. The size is in **points**, 72 to the inch (A4 is 595×842, Letter 612×792) and is what the handler is given as its frame size; the surface is vector, so text stays text. `pages` defaults to 1. `before(page)` is called before each page — that is how the handler knows which one it is drawing, since `Draw`'s own arguments do not say. A page that throws leaves **no file** |
| **event** `Draw(painter, width, height)` | paint it. The size is the frame's, in logical pixels |

**A drawing area has no natural size.** There is nothing inside it to measure, so
one placed with neither a size nor an `Expand` is allocated 0×0 and its handler is
called with a 0×0 frame: nothing draws and the control reads as broken. Give it a
size, or put it in a box and let it expand.

**Nothing is drawn twice unless you ask.** GTK paints when it needs to — the
window appearing, a resize, another window moving away — and `Redraw()` is how a
change in the data becomes a frame. A drawing that animates is `Timer.Every` plus
`Redraw()`.

`Save()` is the same `Draw`, synchronously, so it is both how a chart reaches a
report and how a drawing is tested without a screen. `SavePdf()` is that once per
page into one file, which is what a document wants: a report leaves the
application as fourteen pages of one PDF rather than as fourteen PNGs somebody
has to keep together.

**There is still no printer.** A PDF is a file; choosing a printer, a paper tray
and a number of copies — and laying a *control* onto a page rather than what a
`Draw` paints — is [ISSUE-printing](../issues/ISSUE-printing.md).

## Painter

What a `Draw` hands over: a drawing context with names. **It is valid only inside
the `Draw` it came from** — every call on one whose frame is over throws, because
keeping it and drawing from a timer later is a write into memory GTK has freed.

It arrives with the theme's ink as `Color`, a line one wide, no dashes, and the
widget's own font.

| Member | |
|---|---|
| `Antialias` | smooth edges. Default `true`. **The one performance knob**: a line that crosses its own height on every segment costs 109 ms antialiased and 7.8 ms without, measured — the cost is in pixels covered, not in points |
| `Color` | any CSS colour, the same spelling `Background` takes (`"rgba(53,132,228,0.2)"`). Reads back the string it was given; before anything is set, the theme's ink |
| `Dark` (ro) | whether the ground is dark, derived from the ink's luminance. What a palette is chosen by |
| `Font` | a Pango description (`"Cantarell Bold 10"`). Defaults to the widget's, so a drawing follows the desktop's font and text scale |
| `Foreground` (ro) | the colour this widget's text is drawn in, resolved — the theme's, or the control's own `Foreground` if a form set one. The one fact a drawing cannot work out for itself. A *change* to it reaches the painter a turn later |
| `LineCap` | `Butt` `Round` `Square` |
| `LineDash` | an array of lengths, `[]` for solid |
| `LineJoin` | `Miter` `Round` `Bevel` |
| `LineWidth` | in pixels. Default `1` |
| `Arc(x, y, radius, from, to)` | **angles in degrees**, clockwise, zero at three o'clock. Appends to the path, so a pie slice is `MoveTo` the centre, `Arc`, `ClosePath`, `Fill` |
| `ArcNegative(x, y, radius, from, to)` | the same arc counter-clockwise. **A ring needs it**: a doughnut segment is the inner start, `Arc` out and round, then `ArcNegative` back along the inner radius — one path. Going back with a `MoveTo` makes a second subpath, and filling two subpaths cuts wedges through the shape |
| `Clip()` | clip to the current path |
| `ClipRectangle(x, y, width, height)` | the common case of it |
| `ClosePath()` | back to where the path started |
| `CurveTo(x1, y1, x2, y2, x, y)` | a cubic Bézier: two control points and the end |
| `Fill()` | fill the path, and clear it |
| `Image(path, x, y, [width], [height])` | a picture file, put down with its top-left corner there. **One of `width`/`height` is enough** — the other follows the file's own proportions. With neither it is drawn at its natural size, one image pixel to one. The path is a file, absolute or relative to the working directory; a file that is missing or is not an image **throws**, which ends the frame. Decoded once and cached, so a drawing may paint the same logo every frame |
| `LineTo(x, y)` | a segment |
| `MoveTo(x, y)` | start somewhere |
| `Polygon(points)` | the same, closed |
| `Polyline(points)` | a flat array — `[x, y, x, y, …]` — as one call. Worth about 2× over a loop of `LineTo`, measured, because filling the array costs what the calls would |
| `Pop()` | back to the last `Push` |
| `Push()` | remember the colour, the pen, the transform and the clip |
| `Rectangle(x, y, width, height)` | into the path |
| `Rotate(degrees)` | degrees, like `Arc` |
| `Scale(x, [y])` | one argument scales both |
| `Stroke()` | stroke the path, and clear it |
| `Text(text, x, y)` | the text with its top-left corner there, in `Font`. Leaves no path behind |
| `TextHeight(text)` | how tall it would be. A chart asking for a line's height passes `"0"` |
| `TextWidth(text)` | how wide it would be, which is how a label is right-aligned |
| `Translate(x, y)` | move the origin |

**There is no `Background`.** GTK4 has no per-widget answer for what colour the
ground is — the supported way to paint one is the widget's own CSS — so
`Background` stays the control's ordinary property and a drawing simply does not
paint over it. `Foreground` and `Dark` are what the theme *can* answer, and they
are enough to choose colours that work either way round.

**A path survives `Push`/`Pop`**, and `Arc` appends to it: that is cairo's model
and it is what a pie slice wants. `Fill`, `Stroke` and `Text` all leave no path
behind, so the usual mistake — a stray line from the last label to the first arc —
cannot happen.

**Degrees, not radians**, for `Arc` and `Rotate` both. This is a language where a
person writes a form: `p.Rotate(-90)` for an axis label is obviously right where
`-Math.PI / 2` is not.

## Terminal

VTE with a real pty, so colours, prompts and interactive input all work. Use it for anything interactive; for a command you capture, use [`Exec`](library.md#exec).

| Member | |
|---|---|
| `FontScale` | a multiplier on the terminal's own font. Default `1` |
| `LinkPattern` | a regex; clicking text that matches raises `Link(text)`. What the text *means* is yours |
| `ScrollbackLines` | how much history it keeps. Default `10000` |
| `Text` (ro) | everything on screen and in the scrollback |
| `Running` (ro) | whether a child is alive |
| `Clear()` | resets it |
| `Feed(text)` | writes to the display without a child |
| `Kill()` | SIGKILL |
| `Run(argv, [workdir])` | starts a child on a real pty, so colours, prompts and input all work |
| `Stop()` | SIGTERM to the child's process group |
| **event** `Exit(code)` | the terminal's child ended |
| **event** `Link(text)` | text matching `LinkPattern` was clicked |

## Video

A clip that plays, in the window. One playbin3 per control, shown through the
paintable sink in a `GtkPicture` — which is why it styles as one (see
`Picture`). Audio without a window is [`AudioPlayer`](library.md#audioplayer).

| Member | |
|---|---|
| `Uri` | what to play: a URI (`file://`, `http(s)://`, `rtsp://`) or a plain local path, which is turned into one. One property for both, so there is nothing to disagree |
| `User` | RTSP digest identity, applied to the source the playbin builds. `""` for none |
| `Password` | the secret beside it. **Write-only**: it reads back `""` and is never serialised, so no `.form` carries it in clear text |
| `Latency` | ms the RTSP jitterbuffer may hold. Default `2000`, the source's own. Read when the source is built, so a change lands on the next `Play` from a stopped player |
| `Volume` | `0`…`1`. Default `1` |
| `Muted` | silence without touching `Volume` |
| `Loop` | reseek instead of ending. A live stream cannot seek, so it ends anyway |
| `Fit` | `Fill` `Contain` `Cover` `ScaleDown`. Default `"Contain"` |
| `Buffering` (ro) | how full the buffer is, `0`…`100`. `100` is nothing to wait for (a local file never says otherwise); less is a stream refilling, which holds the picture while `Playing` stays true. `ProgressBar.Value`'s range, since that is where a form puts it |
| `Position` (ro) | seconds in, `0` when unknown — which includes playing live |
| `Duration` (ro) | seconds long, `-1` while unknown — which is always, on a live stream |
| `Playing` (ro) | whether it is going: what `Play` asked for, until `Pause`, `Stop`, the end or an error. Not a sample of the pipeline, which reads as stopped mid-loop and mid-rebuffer |
| `Seekable` (ro) | whether `Seek` has anything to work on. Answered once the stream is known, not with the first frame |
| `SourceWidth` (ro) | the clip's own width, `0` until a frame has been decoded — `Picture`'s spelling |
| `SourceHeight` (ro) | the clip's own height |
| `Play()` | plays; replays from the top after `Ended` |
| `Pause()` | holds the frame and the position |
| `Stop()` | parks it: back to no state, position forgotten |
| `Seek(seconds)` | jumps there. Refused on a stream that cannot seek, naming it |
| `Save(path)` | the frame on screen, as a PNG — `DrawingArea.Save`'s spelling. Refused before anything has been decoded |
| **event** `Ended()` | the clip ran out |
| **event** `Error(message, kind)` | it failed. `message` names the control and the clip and says why; `kind` is one of `NotFound`, `NotAuthorized`, `Unreachable`, `Decode`, `Error` — a password to ask for and a camera to retry are not the same answer |

`Play` with no `Uri` is refused, and so is a `Seek` with nowhere to go.
`Ended` leaves the last frame up (`Pause`, not a black `Stop`), and `Error`
parks instead. Setting `Uri` stops whatever was playing. A stream that runs
its buffer dry is held until it refills rather than left to stutter, and
`Buffering` is what says so — poll it beside `Position`, on the same `Timer`
(`examples/video` puts it in a bar that is only there while it is filling). A
live source is left alone: it has nothing to catch up on.

GStreamer is optional at build time. Without it the *verbs* refuse — `Play`
and `Seek` name the package, `Save` says there is no frame (which without an
engine there never is), and `Pause`/`Stop` have nothing to stop and do
nothing (`Buffering` answers `100`, since nothing is ever waited for) — while
every property above still answers,
because a `.form` assigns them and the designer reads them back: a runtime
that cannot play a clip is still one a form with a `Video` in it can be drawn,
loaded and saved in. The frames themselves need GStreamer's GTK4 sink
(gst-plugins-rs); where only the base plugins are installed, `Play` says which
element is missing and `AudioPlayer` still works.

---

# Containers

Each of these has everything under [`Container`](#container--inherited-by-every-container) as well.

## Panel

A plain container: absolute coordinates, or a row or a column. This is the box,
the group and the toolbar — a `Panel` with `Arrangement: "Horizontal"` and
`Style: "toolbar"` holding `flat` buttons **is** the toolbar this widget set has.

*Nothing of its own:* everything under [`Container`](#container--inherited-by-every-container)
and [`Widget`](#widget--inherited-by-everything), and the events every widget
raises.

## Frame

A `Panel` with a title.

| Member | |
|---|---|
| `Text` | the title drawn in its border. **Translated** |

## Expander

A `Frame` that folds.

| Member | |
|---|---|
| `Expanded` | open or folded. Folding it takes its height back, which is why the window has to know |
| `Text` | the caption one presses. **Translated** |
| **event** `Toggle()` | the expander was opened or folded |

## Grid

Rows and columns whose sizes come from what is in them. Children flow in order, wrapping at `Columns`; a child with `HExpand` takes the slack and `ColumnSpan` lets one run under several. **The answer to a caption that grows in translation**, which a row of coordinates has none.

| Member | |
|---|---|
| `ColumnSpacing` | pixels between columns |
| `Columns` | how many columns children wrap at; a column is as wide as its widest child. Default `2` |
| `Homogeneous` | every cell the same size |
| `RowSpacing` | pixels between rows |

## Flow

A gallery: children wrap into as many columns as fit, and it scrolls itself.

| Member | |
|---|---|
| `ColumnSpacing` | pixels between children on a line |
| `Homogeneous` | every child the same size |
| `MaxPerLine` | at most this many. Default `100` |
| `MinPerLine` | at least this many children per line |
| `RowSpacing` | pixels between lines |

## Scroller

Content whose size is not its parent's business: the view is as big as the room it is given, the content as big as it needs, and the difference scrolls.

| Member | |
|---|---|
| `Scrollbars` | `Both` `Horizontal` `Vertical` `None`. Default `"Both"` |
| `ScrollX` | how far across it is scrolled, in pixels. Assigning **clamps** to `[0, ScrollMaxX]`, so a number past the end means the end |
| `ScrollY` | the same downwards |
| `ScrollMaxX` (ro) | the largest `ScrollX` that still shows content: the content's width minus one view. `0` when there is nothing to scroll |
| `ScrollMaxY` (ro) | the same downwards |
| **event** `Scroll(x, y)` | the position moved — by the user, the wheel, a keyboard, or an assignment. Both axes are reported together, so a diagonal move is one event |

**`ScrollY === ScrollMaxY` is the test for *at the bottom***, which is the whole
of infinite scroll: the maximum is the content minus one view, so it is the last
position that still shows something rather than the content's own height.

**Scrolling to the end of something you just added needs a turn.** A row added in
this turn has no allocation yet, so the maximum is still the old one and
`ScrollY = ScrollMaxY` lands one row short. `Timer.After(0, …)` is where that
belongs — the same rule every measurement here follows.

## RowList

One row per child, each row **a widget of its own**, with scrolling and selection. A `ListBox` holds strings; this holds controls — what a property editor, a settings page or a list of results needs.

| Member | |
|---|---|
| `ActivateOnSingleClick` | raise `Activate` on one click instead of two. Default `false` |
| `Index` | the selected row, `-1` for none. **A hidden row is still a row**: `Filter` changes what is on screen, not what the list holds. Default `-1` |
| `Count` (ro) | how many rows, hidden ones included |
| `MultiSelect` | more than one row at a time |
| `Selection` (ro) | the selected indices, as an array |
| `Activate([index])` | raises `Activate` for that row, as a double click would; the selected one with no argument |
| `Deselect(index)` | unselects it |
| `DeselectAll()` | selects nothing |
| `Refilter()` | says the answer to `Filter` may have changed. The whole of the API on this side — what a handler answers *from* is yours |
| `Remove(index)` | takes that row out, **and the control in it goes with it**: the row is the widget's wrapper, so this is the same as deleting the child |
| `Select(index)` | selects that row |
| `SelectAll()` | with `MultiSelect` |
| **event** `Select()` | the selection moved. Ask `Index` or `Selection` for which rows; what is *in* them is the widgets you put there |
| **event** `Activate()` | Enter in the field, or a double click on a row |
| **event** `Filter(control, index)` | asked while the list is laid out. **Returning `false` hides the row**; no handler shows every one. A lookup and nothing else |

## Overlay

Stacked: the first child fills, the rest float on top. It adds nothing to `Container`.

*Nothing of its own.*

## Split

Two children with a draggable divider.

| Member | |
|---|---|
| `Arrangement` | `Horizontal` `Vertical` **only** — two halves have an axis and nowhere to put a coordinate, so there is no `Fixed`. Default `"Horizontal"` |
| `Grows` | `Both` `Start` `End` `Neither` — which half takes the slack when the split is resized. Default `"Both"` |
| `Position` | where the divider sits, in pixels from the start |
| `WideHandle` | a fat divider, easier to grab |

## Notebook

Pages in tabs. Its `children` **are** its pages.

| Member | |
|---|---|
| `Current` | the page showing, `-1` when there are none. Default `-1` |
| `Strip` | `Top` `Bottom` `Start` `End` `None` — where the tabs are, or that there are none. Default `"Top"` |
| `Tabs` | the strip, as an array of strings. **Translated** |
| `Count` (ro) | how many **pages** — an action widget in the strip is not one |
| `Append(child, [label])` | one more page |
| `GetAction(where)` | → the widget in that end of the strip, or `null` |
| `Remove(index)` | takes a page out |
| `SetAction(control, [where])` | puts a widget **in the tab strip** instead of making it a page. `where` is `Start` or `End`; `null` takes it out. In a `.form` this is a child carrying `"strip": "End"` |
| `SetTabLabel(index, label)` | renames one tab |
| **event** `Switch(index)` | a different page is showing |

## Switcher

Pages picked from a strip of linked buttons.

| Member | |
|---|---|
| `Current` | the page showing. Default `-1` |
| `Strip` | `Top` `Bottom` `Start` `End` `None` — `None` is a bare stack only code switches. Default `"Top"` |
| `Tabs` | the strip, as strings. **Translated**. A segmented control has nowhere for a widget, so this is the whole of it |
| `Count` (ro) | how many pages |
| `Append(child, [name])` | one more page |
| `Remove(index)` | takes one out |
| **event** `Switch(index)` | a different page is showing |

---

# Form and Component

## Form

The window. See [forms.md](forms.md#form-the-window) for the behaviour a table cannot state.

| Member | |
|---|---|
| `FullScreen` | the same |
| `HideOnClose` | put away instead of taken apart. **A closed form's window is destroyed**, so `Show()` on it is not a window either — it stays 0×0. Declare this, or construct the form again |
| `Icon` | the window's icon, for a task list or a dock. A name the theme lacks is not shown but **is kept**, so a `.form` round-trips |
| `Maximized` | a **state**: reads `false` until there is a window; set before `Show()` it applies when the window appears. Keep it out of the `.form` |
| `Modal` | blocks its parent. Made transient for the active window on `Show()` |
| `Resizable` | bounds the **user**, not the layout: the contents still drive the size, so a longer translation still opens it wider. Default `true` |
| `Text` | the window title. **Translated**. `Caption` is an alias |
| `DefaultButton` (ro) | the button Enter presses, resolved from whichever declared `Default`. **`null` inside `Form_Open`** — it is settled after that handler |
| `CancelButton` (ro) | the button Escape presses, likewise |
| `Center()` | a no-op on Wayland: the compositor places windows. [`Screen`](library.md#screen) answers how big the desktop is, which is a different question from where a window goes |
| `Close()` | closes it, through `Form_Close`, which may refuse |
| `Minimize()` | a verb because there is nothing to read back — GTK reports nothing about a minimised window |
| `Show()` | presents the window, and fires `Open` **before returning** the first time |
| **event** `Open()` | the first time the form is shown, **before `Show()` returns** |
| **event** `Close()` | the window is closing. **Returning `true` keeps it open**; returning nothing lets it go |
| **event** `Resize(width, height)` | the size GTK settled on — the same numbers `Bounds()` gives. Fires when the window is first given a size too |

### And on a `Form`

| Member | |
|---|---|
| `Controls` (ro) | every child bound to the form by name, in creation order. `Children` is the containment tree instead, one level deep |
| `Menus` (ro) | the menu spec as declared. It cannot be read back from GTK, which is why the spec is kept |
| `Serialize()` | → the whole file, keyed by class |
| `SaveForm(path)` | `Serialize()` plus `File.Save`, pretty-printed |

Menu items are reached the same way a control is — `this.MnuSave` — and each has
`Name`, `Enabled`, `Value` and `Click([index])`. See
[forms.md](forms.md#menus).

## Component

A form that is not a window, used inside another form as if it were a control. It
has everything a `Container` has and nothing of its own; what it *adds* is
declared by the class — `static Events`, `static Options`, `static TextProperties`
— and raised with `Emit`. See
[forms.md](forms.md#components--a-form-that-is-not-a-window).

## What is deliberately not here

Do not file an issue for these; the argument is written down and settled.

- **`RadioButton`** — a `CheckButton` with a `Group`.
- **`ToolBar`** — a `Panel`, `Arrangement: "Horizontal"`, `Style: "toolbar"`.
  GTK4 removed `GtkToolbar`.
- **`ToolButton`** — a `Button` with `Icon` and `Style: "flat"`.
- **`MenuButton`** — a `Button` with a `Menu` and
  `Btn_Click() { this.Btn.PopupMenu(0, 0); }`.
- **A mnemonic on a control** (`&Save` giving Alt+S, a label handing focus to
  the field beside it). Menus have mnemonics; controls have `Shortcut`. The
  reasoning is in the root [`README`](../../README.md#10-known-limitations).
- **A blocking `MsgBox`** — a question is a form.
- **A list of check boxes** (`CheckedListBox`, a `Checked(row)` the list keeps) —
  a [`RowList`](#rowlist) whose rows carry a `CheckButton`, and **the ticks live
  in your data**. That last half is the whole argument and not a workaround: a
  check the *list* keeps is state in the view, and the moment rows are recycled
  or refiltered it is the wrong row's tick — which is the single most common bug
  in every toolkit that offers one. Keep a `Set` of what is on, show it when you
  build the row, and update it in the button's `Click`. Then filtering, sorting
  and rebuilding cannot lie.
