# Controls

**This is the complete surface, not a selection.** Every property, method and
event of every class is below — 47 classes, 274 distinct members and 44 events,
which is what `tests/api.sh` prints. If something is not here, the runtime does
not have it, and you should not have to open the project tree to find that out.

It is generated from the runtime and checked against it, which is what makes that
claim worth anything: the class list comes from `Widget.Types()`, the properties
from the accessor tables in C, the enumerated values from `PropertyOptions()`, the
defaults from a freshly built control, and **every method's and event's
parameters from the comment the member declares them in, with the event's
argument count also held against the `bta_emit` call that raises it**.
`tests/api.sh` fails if a member exists and is not documented here, or is
documented with parameters the runtime does not declare.

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
│   ├── ListBox  ComboBox  SpinBox  DecimalBox  Slider  DatePicker  Calendar
│   ├── ColorButton
│   ├── FontButton
│   ├── TreeView  TableView  Terminal  DrawingArea  Video
│   └── Editor  (abstract)
│       ├── TextEditor      a plain GtkTextView: a note, a log, observations
│       └── SourceEditor    GtkSourceView: languages, gutter, search, marks
└── Container  (abstract)
    ├── Panel  Frame  Expander  Grid  Flow  Scroller  RowList  Overlay  AspectFrame
    ├── Split  Notebook  Switcher  Popover
    ├── Form
    └── Component
```

`Widget`, `Control`, `Container` and `Editor` cannot be instantiated. `Form` and `Component`
are what a project's own classes extend.

[`examples/factory`](../../examples/factory) is this whole page as a window: a
tab per family, each class shown in a few of the configurations it is used in.

### What there is, and what this build can run

Three questions about a class one has only the **name** of — which is the
position a palette, a `.form` loader and an extractor are all in:

| | |
|---|---|
| `Widget.Types()` → array | every class the runtime has, in registration order |
| `Widget.New(type)` → widget | makes one. The runtime's classes first, then the project's own and its libraries' — which is how a component appears in a `.form` as an ordinary `"type"`. Throws on a name that is neither |
| `Widget.Available(type)` → boolean | whether **this machine** can run one. `false` for a name that is no class at all, so it answers rather than throwing |

**`Types()` is every class, the six that cannot be placed included.** The four
abstract roots are in it — `Widget.PropertyNames("Widget")` answers where
`Widget.New("Widget")` refuses — and so are `Form` and `Component`. A palette
filters those six out: the first four are not controls, and the last two are not
*in* a window, one being the window itself and the other with no class of its own
being nothing to place.

`Types` and `Available` are not the same list, and the difference is the point:
[`Terminal`](#terminal) is always in `Types()` because the class is always there
— it constructs, it draws, a `.form` with one in it loads — and
`Available("Terminal")` is false on a runtime built without VTE, where starting
a child refuses. **Offer from `Available`, load from `Types`**: a palette
button for a control the user cannot finish is worse than a missing button, and
a `.form` that already holds one still has to open.

A class may also answer **at run time**, because a build-time flag is not always
the question: [`Video`](#video) needs GStreamer *and* its GTK4 sink, and a
runtime built with GStreamer on a machine whose registry lacks the sink cannot
play one. `Available("Video")` asks the machine (once — the answer is cached)
and answers `false` there, so the palette drops the button on exactly the
machines that could never have made it work.

A class of the project's own is available whenever it resolves: a component is
JavaScript, and JavaScript this runtime can always run.

### What a class has, with no control built

A palette, a property grid and an extractor are all holding a **name** — a
`.form` says `"type": "Button"` — and each of them wants what a control would
answer about itself. These are those answers, asked of the class: the same walk
the instance methods run, started at the class prototype, so the two cannot
disagree.

| | |
|---|---|
| `Widget.PropertyNames(type)` → array | the properties a control of that class can be **set to** |
| `Widget.Methods(type)` → array | its methods, **most derived first**, and not its `constructor` |
| `Widget.EventNames(type, [options])` → array | the events it raises, **most derived first**: `[0]` is the one a double click in the designer writes a handler for |
| `Widget.TextProperties(type)` → array | which of this control's properties hold prose, which is what the catalogue collects and what a designer offers to translate |
| `Widget.PropertyOptions(type, name)` → array | the exact strings that property accepts, or an empty list. What fills a drop-down in the property grid, and the reason a list of values is never typed twice |
| `Widget.Members(type, [options])` → array | **every** public member of anything the name resolves to, each `{ Name, Kind, Params, Signature, Returns, Doc, Native }`, **`Doc` what the member is for** — the description written beside it in the C, or the JSDoc comment above it in JavaScript (rad.js, forms.js, a library read through `Sources`), the text these rows are written from — and **`Native` whether it is written in C**, `Kind` one of `Property`, `ReadOnly`, `Method`, `Static`, **`Returns` what a method or property declares it answers** — the text after the arrow in its signature comment, or in a JSDoc comment's `@returns {T}` (`Bytes`, `string[]`, `{ X, Y, Width, Height }`), `""` when nothing is declared —, and **`Params` the number of arguments it takes, plus `Signature` — the parameter list with the real names: the comment beside a native member's C entry (a control's method, a class static, a global's verb), a class's `static Signatures`, or the parser — over a library's source for a class this process never ran, and over the member's own source for a function written in JavaScript (`Timer.After` is `(delay, tick)`)** — — read off the function value, so a library is checked without anybody writing its arity down. `Widget.Signature` is the better answer where it exists, because it has the names; `-1` means nobody knows, which is every property and every static accessor. **A getter with no setter is `ReadOnly`**, the word `Widget.Member` gives the same name, and a property carries no `Signature`. For a member read out of a source, `Params` is counted from the parser's list by `Function.length`'s rule — the names before the first `[x]` or `...x` — so the same method answers the same count read or built. **It is the one that answers for a class that is not a widget** — `Timer`, `QrCode`, `Package` — where the three above refuse, and it takes a global that is a bag of functions (`File`, `Locale`, `Printer`) as readily as a class. A lower-case name is the class talking to itself and is not listed. **A type no global holds** — `HttpClient`, `HttpServer`, `HttpRequest`, `Connection`, `XmlDocument`, `XmlNode`, the prototypes of what a verb hands back — is answered from its table in the runtime, properties included, and a global class (`Connection`) gains what its driver adds. `options` takes **`All: true`**, which lists the lower-case names too — what a builtin like `String` or `Array` is made of — and **`Own: true`**, which answers only what the class **itself** declares: the question a reference page is written around, since what a class inherits is documented where it is declared — and **`Sources`, an array of source texts**, and **`Forms`, an array of `.form` texts**, for a class that is a lexical binding in a file this process never runs — a library's class, read by an editor that must not execute the project it is editing. The sources are read with the same parser `Application.Symbols` uses, the `extends` chain is followed, and the walk goes back to the class table at the first base the sources do not declare — which is `Form`, and a hundred names. **A class the sources declare wins over a class of the same name in the runtime**, because in a program that uses that library the library's is the class being written. A form's children are members too, and reading one needs no display: `JS_ParseJSON` and a walk of `children`, paired to the class by the form's own `class` key and not by the file's name. **They are offered for a class that is loaded as well as one only declared**, because a child is an *own property of the instance* and no prototype walk sees one either way. A lower-case child is not a member, a `.form` that does not parse is the loader's complaint rather than this verb's, and an entry that is not a string is refused; a name neither declared nor resolvable names both facts. **The source half answers in the loaded half's words**: a `static` is `Static`, a `get X` alone is `ReadOnly`, a getter with a setter is one `Property`, and a `static get` is a `Static` with `Params` `-1` — what the same class says once it is loaded. See *why there is a fifth verb* |
| `Widget.Member(type, name)` → string | what the name is on that class: `Property`, `ReadOnly`, `Method`, or `""` for one it has not got. The question `in` answers about a control, with the kind the loader needs — a **`ReadOnly`** name makes a `.form` refuse to load |
| `Widget.Signature(type, name)` → string | the parameters a **method** declares: `"([container])"`, `"(event, fn)"`, `"()"`. `null` where the class declares none, or where the name is no method |
| `Widget.EventSignature(type, name, [options])` → string | the same for an **event**: `"(x, y, button, ctrl, shift)"`. A name that is both — `ListBox.Select` — is answered by each. `{ Sources: [...] }` reads it from the comment above the raise |
| `Widget.EventDoc(type, name, [options])` → string | what an event is for, or `null`: the description written above the class row that declares it, walked up the chain like `EventSignature`, since an event is emitted and not defined. `{ Sources: [...] }` reads it from the comment above the raise |

The type resolves exactly as `Widget.New` does — the runtime's classes first,
then the project's own and its libraries' — and a name that is no class, or a
class that is not a widget, **throws** the same way. **An abstract class
answers**: `Widget.PropertyNames("Widget")` is the one question no probe could
ask, because `Widget.New` refuses to build one. Nothing here touches a display,
so a console project can ask.

**The parameters are declared beside the member**, never in a second list: a
one-line comment above its C entry — `/* Bounds([container]) */` — and the build
turns those into the table `Widget.Signature` reads. A class of the project's
own states them as `static Signatures = { Up: "(delta)" }`, because JavaScript
cannot reflect an argument's name. `tests/api.sh` fails on a method or an event
that declares none.


### Where to find one

**Inherited by everything:** [`Widget`](#widget--inherited-by-everything) · [`Container`](#container--inherited-by-every-container)

**Controls:** [`Label`](#label) · [`Button`](#button) · [`ToggleButton`](#togglebutton) · [`CheckButton`](#checkbutton) · [`Switch`](#switch) · [`Spinner`](#spinner) · [`Separator`](#separator) · [`LinkButton`](#linkbutton) · [`Image`](#image) · [`Picture`](#picture) · [`Video`](#video) · [`TextBox`](#textbox) · [`SpinBox`](#spinbox) · [`DecimalBox`](#decimalbox) · [`Slider`](#slider) · [`ProgressBar`](#progressbar) · [`LevelBar`](#levelbar) · [`DatePicker`](#datepicker) · [`Calendar`](#calendar) · [`ColorButton`](#colorbutton) · [`FontButton`](#fontbutton) · [`ListBox`](#listbox) · [`ComboBox`](#combobox) · [`TreeView`](#treeview) · [`TableView`](#tableview) · [`TextEditor`](#texteditor) · [`SourceEditor`](#sourceeditor) · [`Terminal`](#terminal) · [`DrawingArea`](#drawingarea)

**Containers:** [`Panel`](#panel) · [`Frame`](#frame) · [`Expander`](#expander) · [`Grid`](#grid) · [`Flow`](#flow) · [`Scroller`](#scroller) · [`RowList`](#rowlist) · [`Overlay`](#overlay) · [`AspectFrame`](#aspectframe) · [`Split`](#split) · [`Notebook`](#notebook) · [`Switcher`](#switcher) · [`Popover`](#popover) · [`Form`](#form) · [`Component`](#component)

### Why there is a fifth verb

**`PropertyNames`, `Methods` and `EventNames` answer about a *widget*, and that
boundary is load-bearing**: a property grid, a palette and the serialiser all need
`Widget.PropertyNames("Util")` on an ordinary class to *refuse*, or the grid offers
a shape it cannot read. So they keep refusing.

What the refusal left with **no way to be asked** was a different question: *what
does this name have?* The IDE completing `Timer.` or `Printer.` found that `Timer.`
answered **zero entries** -- `Timer` was known and its members were not, because
`Dictionary.Keys` on a class is empty: a static is a property of the class and not
of an object, so the obvious verb cannot see it. The answer is the runtime's, so
the IDE has no second reader of what a class has.

**`Widget.Members` takes a class and a global object alike**, so a caller asks one
verb for `File` and for `Confirm` and there is no third place where a name becomes
something to walk. **Statics are read off the constructor** and instance members
off the prototype, because that is where each of them lives, and a name that
answers on both is one member.

## Widget — inherited by everything

Every control and every container has all of this.

| Member | |
|---|---|
| `AcceptDrop` | receives a drop from **this application**, which arrives as `Drop(data, x, y)` |
| `AcceptFiles` | receives files dragged in from **the desktop**, which arrive as `FileDrop(paths, x, y)`. Independent of `AcceptDrop`: a control may take one, the other, or both |
| `Background` | any CSS colour; `""` restores the theme's. The **exception** to `Style`, for when the colour is data — a status, a category, a swatch |
| `Border` | width, style and colour in one string: `"2 dashed #3584e4"` |
| `ColumnSpan` | how many columns of a `Grid` it runs under. `1` |
| `DragData` | the string that travels when this control is dragged. Empty turns dragging off |
| `Cursor` | what the pointer looks like over it: `Auto` (nothing said) `Arrow` `Hand` `Grab` `Grabbing` `Text` `VerticalText` `Wait` `Progress` `Help` `Crosshair` `Cell` `ContextMenu` `Move` `Scroll` `Copy` `Link` `NoDrop` `NotAllowed` `ZoomIn` `ZoomOut` `None` `ResizeHorizontal` `ResizeVertical` `ResizeTopLeft` `ResizeTopRight` `ResizeColumn` `ResizeRow`. Reaches the parts a control is made of, so it is seen over an entry's text too — but a *child* control with one of its own wins, which is why `Form.Cursor = "Wait"` is not a busy pointer for the whole window |
| `Action` | the **command** this control points at, or `""`. A control that has one takes its `Enabled` — and its `Text` and `Icon`, when it declared neither — from the command, and **refuses** to be told an `Enabled` of its own. Only a control that is pressed can have one; a name that is not one of the form's `actions` is refused. See [forms.md](forms.md#actions-one-command-in-several-places) |
| `Enabled` | answers the mouse and the keyboard. `true` by default, and **read-only in effect while `Action` is set**: a control that points at a command takes the command's answer |
| `Expand` | absorbs the slack on both axes — the one word that makes a control fill the room left over in a row or a column |
| `Focusable` | can take the keyboard focus. Turn it on for a container that wants keys — a drawing surface, a board. The answer is the **control's** and not the outside widget's: a `TextBox` reads `true` while the entry GTK lays out is not focusable at all, its inner `GtkText` being where the focus really sits |
| `Font` | a Pango description — `"Cantarell Bold 12"` — or a partial one: `"Bold"`, `"12"`. `""` restores the theme |
| `FontScale` | a multiplier on whatever size is in force: `1.1` is 110%. `1` is "nothing said"; `0` is refused |
| `Foreground` | likewise, for the text |
| `HAlign` | `Auto` `Start` `End` `Center` `Fill` — what becomes of it when the container is not the size the coordinates were drawn for |
| `HExpand` | the horizontal half of it, when the two answers differ |
| `Height` | the height, likewise |
| `Margin` | room **around** it: one number for all four sides, never a list. On a `Form` it insets the contents, a window having no outside. Not a list. |
| `Menu` | a context menu, as the same array of items a form's `menus` uses. Reassigning replaces it. The items name handlers on the form, so a control built in code is **added before** its `Menu` is assigned — before that it is refused with a sentence. **An item's name belongs to one menu**: a second menu declaring it, or a name already taken by a control or a member of the form, is refused — one command in several menus is a form `action` with an `{ "action": … }` item in each. Rebuilding the same menu is fine |
| `MinHeight` | the same for `VAlign` |
| `MinWidth` | the floor a stretched control may not be squeezed below. Only means something on an axis whose `HAlign` is `Fill` |
| `Name` | how the form reaches it — `this.BtnSave` — and the prefix its handlers carry: `BtnSave_Click`. A valid JavaScript identifier, unique on the form |
| `Opacity` | `0`…`1`, where `1` is *nothing said* |
| `Padding` | room **inside** it, one to four sizes. `"0"` asks for none, `""` takes the theme's |
| `Radius` | rounded corners, one to four sizes in CSS order: `"8"`, `"8 8 0 0"`. `""` or all zeroes is square |
| `Shadow` | `"x y blur [spread] [colour]"`. One shadow, never inset. A colour alone or a bare number is refused |
| `Shortcut` | the key that activates it: `"F5"`, `"<Control>s"`, or a list `["7", "KP_7"]`. **`Return` never fires**, the window claiming it for its default button |
| `Style` | the CSS classes it wears, space separated: `"card title-3"`. **The first thing to reach for**: the theme draws `suggested-action`, `destructive-action`, `dim-label`, `title-1`…`title-4`, `heading`, `card`, `frame`, `boxed-list`, `toolbar`, `flat`, `linked`, `pill`, `monospace`. A name that could not be a class is refused |
| `TabIndex` | where Tab reaches it on a surface laid out by coordinate. Sparse, never renumbered; `0` means *in drawn order*. The IDE edits it as a list — *Form > Tab order...* — which is the shape a relation needs |
| `Tooltip` | plain text, and `""` is none rather than an empty balloon. **Translated** |
| `Dark` (ro) | whether it is drawn on a dark ground, derived from the ink its text uses. The same answer `Painter.Dark` gives, and a `Form` raises `ThemeChange` when the desktop moves it. What a drawing chooses its palette by |
| `VAlign` | the same, vertically |
| `VExpand` | absorbs vertical slack |
| `Visible` | shown or not. `true` by default; a `Form` starts `false` and `Show()` is what presents it |
| `Width` | width **requested**: a minimum, not an exact size. Reads the allocation when nothing was declared. `0`..`32767` (or `-1`, *not asked*) — a display holds no more, and more was a `BadAlloc` that killed the process; the same for `Height`, `MinWidth`, `MinHeight` and `Resize`. Reading it gives what was asked for, falling back to what GTK allocated when nothing was |
| `X` | the left edge, in the parent's coordinates. **It means something only inside a container laying out by coordinate**; in a row or a column the parent decides and this reports where it ended up. `-32767`..`32767`, like `Y` and `Move` |
| `Y` | the top edge, likewise |
| `Focused` (ro) | whether the focus is **within** it, which is why a `TextBox` answers `true` while the focus really sits on the entry inside it |
| `Bounds([container])` | `{ X, Y, Width, Height }`: what GTK really allocated, in window coordinates or in the coordinates of the container you pass |
| `CssNode()` | the GTK node name it is styled as (`"button"`, `"entry"`) |
| `Delete()` | removes it **and destroys it**. What is in it goes too |
| `Emit(event, ...args)` | raises an event that arrives by name on the host form. **What a component announces itself with** |
| `On(event, fn)` | installs **this control's own** handler for an event, for a control built in code: no name, and nothing left on the form to delete. Installing again replaces; `On(event, null)` removes; it answers with the control, so it chains. The handler is called with `this` undefined; an event name that is not in `EventNames()` throws, and so does installing one the form already answers by name — a control has one handler for one event, refused at `On`, at a rename, and at the `Add` that brings the control to that form. It is also how a `Component` added from code is heard: its `Emit` finds this before the `<name>_<event>` road |
| `EventNames()` | the events it raises, **most derived first**: `[0]` is the one a double click in the designer writes a handler for |
| `Hide()` | makes it invisible. A hidden control **keeps its place in the tree** and its position in a box |
| `Lower()` | and to the bottom |
| `Move(x, y)` | `X` and `Y` together, because that reads better in a loop |
| `OriginIn(container)` | `[x, y]`: where this widget's corner is in that container's space |
| `PopupMenu(x, y)` | opens that menu at a point in this control's own coordinates — how a button that drops a menu is built |
| `PropertyOptions(name)` | the exact strings that property accepts, or an empty list. What fills a drop-down in the property grid, and the reason a list of values is never typed twice |
| `Raise()` | to the top of the painting order, among its siblings on a surface |
| `Remove()` | detaches it from its parent **without destroying it**, so it can be put somewhere else |
| `Resize(width, height)` | sets `Width` and `Height` together |
| `SetFocus()` | gives it the keyboard focus |
| `Show()` | makes it visible |
| `SizeRequest()` | `[width, height]` as requested, with `-1` on an axis nobody declared. What the serialiser asks, so that a measurement never becomes a floor |
| `StyleRule()` | the CSS rule this widget's own class currently carries |
| `TextProperties()` | which of this control's properties hold prose, which is what the catalogue collects and what a designer offers to translate |

### The events every widget raises

Every one of these reaches a method named `<Control>_<Event>`. The argument list
is what `bta_emit` really passes, counted from the call — not from prose.

| Event | |
|---|---|
| **event** `MouseDown(x, y, button, ctrl, shift)` | coordinates are relative to the widget |
| **event** `MouseUp(x, y, button, ctrl, shift)` | and came up |
| **event** `MouseMove(x, y, button, ctrl, shift)` | the pointer moved over it. `button` is `0` here |
| **event** `MouseEnter(x, y)` | the question motion cannot answer: there is no `MouseMove` for having left |
| **event** `MouseLeave()` | and left — the question motion cannot answer, since there is no `MouseMove` for having gone |
| **event** `MouseWheel(dx, dy)` | how far the wheel turned, in GTK's units: one notch is `1.0` on a wheel and a fraction on a touchpad. **Returning `true` consumes it**, which stops the scroller around it from also moving |
| **event** `DblClick(x, y, button, ctrl, shift)` | two clicks |
| **event** `KeyPress(key, ctrl, shift, alt)` | a key went down. **Returning `true` consumes it.** A control that edits text claims a printable key, so on a `TextBox` `b` arrives only as `KeyRelease` |
| **event** `KeyRelease(key, ctrl, shift, alt)` | and came up. Nothing here is consumable |
| **event** `GotFocus()` | answers for the **control**, so it fires for the focus arriving anywhere within it |
| **event** `LostFocus()` | where *the user is done with this box* is said — validation, formatting, saving a field |
| **event** `Allocated(box)` | the first time GTK has given it a real rectangle — the moment `Form_Open` is reliably too early for. `box` is `Bounds()` exactly (`{X, Y, Width, Height}`, window coordinates). **Once**: a control that was already on screen has missed it, so ask `Bounds()` first when it may have. A control on a hidden page hears it when the page is shown. Nothing polls — the hook is the window's own layout pass |
| **event** `Drop(data, x, y)` | something with `DragData` was dropped on a widget with `AcceptDrop`. The point is in **this widget's** coordinates, and so is `Bounds(this widget)` asked of a child — so *which row a drop is over* is a comparison and not arithmetic, and on a scroller both numbers already carry the scroll (a child above the view reads a negative `Y`). A hidden child measures 0x0, so skip what is not `Visible`. Only arrives when the drop was not refused (see `DragOver`). **Undo here whatever `DragEnter` lit up**: no `DragLeave` follows a drop (see its row). Refused drops never arrive (see `DragOver`). |
| **event** `FileDrop(paths, x, y)` | files were dropped from the file manager or the desktop on a widget with `AcceptFiles`. `paths` is an array of full paths — **only files that have one**: a file on a remote share has no local path and does not arrive, and a drop of nothing but those is refused rather than delivered empty |
| **event** `DragEnter(data, x, y)` | the drag came over a widget with `AcceptDrop`, carrying the same point `Drop` will. What the target lights up with — a column, a highlight — goes here. **The refusal does not live here**: a `false` from this one is overwritten by the very next `DragOver`, which in any real drag is immediately, so a target that refuses says so in `DragOver` |
| **event** `DragOver(data, x, y)` | the drag moved over it, point after point. Where an insertion line sits is recomputed here. **Returning `false` refuses the drop at that point**: the cursor shows it and `Drop` never fires. Anything else — including answering nothing — accepts it, and with no handler everything is accepted. Strictly `false`: a handler that answers nothing returns `undefined`, which must not refuse every drag anywhere |
| **event** `DragLeave()` | the drag left without dropping. Undoes what `DragEnter` did — **and a drop is not a leave**: measured, nothing arrives after a `Drop`, and the leave for that target is delivered at the *next* drag instead, right after its `DragBegin` and for a target that drag never touched. So a target undoes its own feedback in `Drop` as well, and anything counting enters against leaves has to expect the late one |
| **event** `DragBegin()` | on the widget being dragged: the drag started. Grey the card here |
| **event** `DragEnd()` | on the widget being dragged: the drag finished — dropped or refused. Puts back whatever `DragBegin` changed |

`data` in `DragEnter`/`DragOver` is the dragged string, read off the target with preload on — the same value `Drop` arrives with, one gesture earlier. Still loading on a very early `enter` answers `""` rather than holding the event back. There is no feedback half for `FileDrop`: files from the desktop have no travelling string to preload, so a file drag still announces itself only on arrival.

### What every widget also answers

Written in `rad.js` rather than in C, and on every widget just the same:

| Member | |
|---|---|
| `PropertyNames()` | every settable property, found along the prototype chain — including the ones a component of your own declares |
| `Serialize()` | this widget as a `.form` node |
| `Apply(properties)` | the widget: the inverse of `Serialize`. A missing dictionary applies nothing, so `Apply(maybe)` is safe |
| `Dump()` | prints the whole subtree with the geometry GTK really allocated. **Reach for this instead of a screenshot**, in a test and while working |
| `Declared(name)` | what the `.form` said, whatever has been assigned since — which is what makes `Fill` possible on a control that has already been filled once |
| `Fill(...args)` | fills the **declared** text as a template: a `Label` declared `"{0} files"` and filled with `12` reads *12 files*, and the number stays out of the catalogue |
| `SetDesign(name, value)` | what the *designer* shows instead; `""` removes it. Unreachable from a running application |
| `DesignValue(name)` | the value `SetDesign` gave that property, or `undefined` |
| `SetItem(of, count)` | a container: the component the **designer** draws in it while a form is being laid out, and how many. `of: ""` removes it. Unreachable from a running application, which builds the real rows itself |
| `Item` (ro) | `{ of, count }`, or `null`. While it is set the serialiser writes that key and **no children**: what is in the container is a drawing and not the form's |
| `Caption` | an alias of `Text` on `Form`, `Label`, `Button`, `TextBox` and `CheckButton` |

## Container — inherited by every container

| Member | |
|---|---|
| `Anchored` | with it off, children stay exactly where they were drawn however big the container gets — a drawing board rather than a window. Default `true` |
| `Arrangement` | `Fixed` (the default) lays children out by `X`/`Y` and `Width`/`Height`; `Horizontal` is a row and `Vertical` a column, where coordinates mean nothing and `Spacing` and `Homogeneous` do. **Not on every container**; see the table above |
| `Placement` (ro) | how this one places a child, which is the question an editor asks: `Coordinates` `Order` `Layers` `Pages` `Halves`. Every container answers, including the ones that refuse `Arrangement` |
| `Homogeneous` | every child the same size along the axis — what a row of buttons that must all match wants |
| `Spacing` | pixels between children, in a row or a column |
| `Children` (ro) | its real children, one level deep, in the order they are in |
| `Add(widget)` | puts a widget in. A control already in another container is **moved** out of it; one that contains this container is refused, as is the container itself. A `Split` refuses a third |
| `Clear()` | removes **and destroys** every child, and the container can be refilled afterwards |
| `ContainerAt(x, y, [ignore])` | the innermost container that could take a drop there. `ignore` excludes the widget being dragged, which would otherwise always answer |
| `FocusNext()` | whether the focus moved: what Tab does, kept **inside this container** |
| `FocusPrevious()` | the same, backwards |
| `LocalPoint(x, y, from)` | `[x, y]`: a point in another widget's coordinates, expressed in this container's |
| `PickAt(x, y)` | the topmost child at that point, or `null`. **At any depth**: what comes back may be a label inside a panel inside a row |
| `Reorder(child, index)` | moves a child among its siblings. The index counts them *without* the one being moved. **Every container with an order answers it**: a box, a `Grid`, a `Flow`, a `RowList`, a `Notebook`, a `Switcher`, a `Split` (the index names the half) and an `Overlay` (index `0` is the base layer, the one that fills). A `Fixed` refuses — there the order is the painting order, which is `Raise`/`Lower` |
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
| `Grid`, `Flow`, `RowList`, `Overlay`, `AspectFrame`, `Notebook`, `Switcher` | **refused**, reads `""`: *this container arranges its children by its own nature* |

**`Placement` is the same question with an answer for every container**, which
is what an editor needs: `Arrangement` is what a *person* may choose, and it is
`""` on the six above. Read-only, so no `.form` carries it.

| | `Placement` |
|---|---|
| `Panel`, `Frame`, `Expander`, `Scroller`, `Form`, `Component` | `Coordinates` arranged `Fixed`, `Order` as a row or a column |
| `Grid`, `Flow`, `RowList` | `Order` |
| `Overlay` | `Layers` |
| `AspectFrame` | `Single` |
| `Notebook`, `Switcher` | `Pages` |
| `Split` | `Halves` |

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
| `Alignment` | `Left` `Center` `Right` — where the text sits **within the label**, which is only visible once the label is wider than its words. Default `"Left"` |
| `Ellipsize` | keep one line and end it with `…` when it does not fit. What a file name in a row wants: it gives up its tail rather than the row's shape |
| `Lines` | at most this many lines while wrapping; `0` is no limit. Beyond it the text is cut |
| `Markup` | read `Text` as **Pango markup** — `<b>`, `<i>`, `<tt>`, `<s>`, `<span foreground="…">` — instead of as plain words |
| `Selectable` | the user may select the text with the pointer and copy it |
| `Text` | what it says. **Translated**: a label declared in a `.form` goes through the catalogue, and what is filled in from code does not |
| `Wrap` | wrap long text over as many lines as it takes. The label then wants a width to wrap *at* — in a box, that is what `HExpand` gives it |

## Button

A press. `Style: "flat"` is a toolbar button, `"suggested-action"` an accented one, `"destructive-action"` the dangerous one, `"circular"` a round one.

| Member | |
|---|---|
| `Cancel` | Escape on this form presses it. **Without one, Escape does nothing at all**: a dialog that cannot be dismissed with Escape is a dialog somebody will complain about |
| `Default` | Enter on this form presses it. The keyboard only — `Style: "suggested-action"` is the looks |
| `Icon` | an icon name from the theme. With `Text` it builds the box itself — icon, then caption; alone it gets the icon-button treatment, which is the square toolbar shape. **A name the theme cannot draw is dropped in silence**, so a button that came out bare is usually a misspelt icon |
| `Text` | the caption. **Translated** — a button declared in a `.form` goes through the catalogue |
| `Click()` | presses it from code: the handler runs exactly as if the user had, once per call |
| **event** `Click()` | it was pressed — by the mouse, by the keyboard, by its `Shortcut`, by an `Action`, or by `Click()` |

## ToggleButton

A button that stays in.

| Member | |
|---|---|
| `Active` | whether it is in. Assigning it **raises `Click`** |
| `Icon` | an icon from the theme. Alone it gets the icon-button treatment, which is the square toolbar shape; a name the theme cannot draw is dropped in silence |
| `Text` | the caption. **Translated** |
| `Click()` | presses it from code: toggles `Active` and runs the handler |
| **event** `Click()` | it was pressed — or assigned |

## CheckButton

A box one ticks — or, with a `Group`, one of an exclusive set, which is what a radio is. **There is no `RadioButton`**: GTK4 removed it, because belonging to a group is what draws it round, makes the set exclusive and makes a second click leave it on.

| Member | |
|---|---|
| `Active` | whether it is ticked. Assigning it **raises `Click`**, the same as the user ticking it |
| `Group` | empty is a check box. A name makes it one of that exclusive set: ticking one unticks the rest. **The container scopes the name**, so two groups called `kind` in two panels are two sets |
| `Text` | the caption beside the box. **Translated** |
| **event** `Click()` | it was pressed — or assigned |

## Switch

A setting that takes effect at once.

| Member | |
|---|---|
| `Active` | whether it is on. Assigning it **raises `Click`**, the same as the user moving it. No caption: the words beside it are a `Label` |
| **event** `Click()` | it was moved — or assigned |

## Spinner

Work with no end in sight, which is most work.

| Member | |
|---|---|
| `Active` | whether it spins. A spinner that is not spinning is invisible in most themes, so this is the whole of turning it on and off. Work with no end in sight |

## Separator

A rule.

| Member | |
|---|---|
| `Orientation` | `Horizontal` `Vertical`. **The thickness is the line**: it paints its whole allocation, so one 12 high is a line 12 thick. Room around it goes on `Margin`. Default `"Horizontal"`. A `Horizontal` separator is a line across, between two rows of things; a `Vertical` one divides a toolbar |

## LinkButton

An address, handed to the desktop.

| Member | |
|---|---|
| `Text` | what the user reads. **Translated**. With no `Text` the address itself is shown, which is right for a home page and wrong for everything else |
| `Uri` | `https://…`, `mailto:…`, `file:///…` — whatever the desktop knows how to open |
| **event** `Click()` | it was pressed. The address is handed over **as well**: this event is for the application that wants to know, not for one that wants to decide |

## Image

An icon or a small picture, drawn at a size. `Icon` **or** `File`, one at a time.

| Member | |
|---|---|
| `File` | a path to an image, which is what a project's own artwork is. Setting it clears `Icon`, and setting `Icon` clears it: the control draws one thing |
| `Icon` | a name from the desktop's icon theme — `"document-save-symbolic"`, `"folder"`. **A name the theme lacks is not drawn and is kept**, so a form round-trips; `Application.HasIcon(name)` is how to ask first, and a list of candidates with a shipped one last is the pattern this tree uses. Setting it clears `File` |
| `LoadBytes(bytes)` | an image already in memory — what [`Http`](library.md#http) answers with and `File.LoadBytes` reads. Clears both names, since neither is what is drawn any more. **A verb and not a property**: a `.form` could not carry a megabyte of JPEG |
| `Size` | the pixels it is drawn at; `-1` is the icon's natural size. Default `-1` |

## Picture

A photograph, which is not an icon.

| Member | |
|---|---|
| `File` | the path. What `GdkTexture` reads: PNG, JPEG, WebP, TIFF, BMP. **SVG is not among them** — a scalable icon is the pixbuf loaders' business, which is why an [`Image`](../reference/widgets/Image.md) draws one and this does not |
| `LoadBytes(bytes)` | the photograph out of memory instead — a download shown without a temporary file. Clears `File`; `SourceWidth`/`SourceHeight` measure it the same way |
| `Fit` | what to do with the room there is: `Contain` (the whole picture, letterboxed), `Cover` (fill the room, cropping), `Fill` (stretch, distorting) or `ScaleDown` (never enlarge). Default `"Contain"` |
| `Zoom` | how big to be, whatever the room is: a factor, where `1` is one image pixel to one screen pixel. `0` means *let `Fit` decide* |
| `SourceWidth` (ro) | what is really in the file, which is the number a zoom is computed from and the one a title bar shows. `0` when nothing is loaded |
| `SourceHeight` (ro) | the file's own height |

## TextBox

One line of editable text.

| Member | |
|---|---|
| `ActivatesDefault` | Enter presses the form's **default button** *instead of* raising `Activate` |
| `Alignment` | `Left` `Center` `Right`, default `"Left"`. Numbers read right-aligned, which is the one case worth changing it for |
| `Icon` | an icon **inside** the field, at the end. Clicking it raises `IconClick` |
| `MaxLength` | how many characters may be typed; `0` is no limit |
| `Password` | the characters are drawn as dots. `Text` still answers with the real thing, because the program is the one asking |
| `Placeholder` | the grey words shown while it is empty. **Translated**. It is a hint, never a label: a field whose only label is its placeholder has no label once somebody types in it |
| `Purpose` | `Text` `Digits` `Number` `Phone` `Url` `Email` `Name` — what the keyboard and the input method should expect. Default `"Text"`. On a phone it is which keyboard appears; on a desktop it is what the input method does. **It does not validate**: a field of `Purpose: "Number"` still takes letters, and what refuses them is a [`SpinBox`](../reference/widgets/SpinBox.md) or your own check |
| `ReadOnly` | shown but not editable. **The program can still write to it** — which is what a field that reports something wants |
| `Text` | what is in the field. **Translated**, so a starting value declared in a `.form` goes through the catalogue — which is why a value that is *data* is assigned from code |
| `Selection` (ro) | what is selected, `""` when nothing is. The same name, and the same question, as `Editor.Selection` |
| `Offset` (ro) | the caret's position in characters, counting from `0` — `SelStart` |
| `Insert(text)` | writes it at the caret and leaves the caret after it. Not `Text = ...`, which rebuilds the field and puts the caret at the end |
| `Select(start, length)` | selects that run, counting from `0` |
| `SelectAll()` | selects everything, so **the next keystroke replaces it** |
| **event** `Change()` | the value changed — typed, pasted, cleared, **or assigned from code**: the round trip goes out to GTK and back, so a form that fills a field in raises its own handler |
| **event** `Activate()` | Enter in the field, when `ActivatesDefault` is off |
| **event** `IconClick()` | the icon inside the field was clicked |

## SpinBox

A number typed or stepped.

| Member | |
|---|---|
| `Decimals` | places shown and accepted: a whole number from `0` to `20`, refused otherwise. `0` is whole numbers |
| `Max` | the ceiling, likewise. Default `1000000` |
| `Min` | the floor. **Declare it before `Value`**, or the value is clamped to the factory range first and the number you set is not the number you get. Default `-1000000` |
| `Numeric` | refuse anything that is not a number. Default `true`, and there is rarely a reason to turn it off |
| `Step` | what one press of an arrow, or one notch of the wheel, moves. Default `1` |
| `Value` | the number in it |
| `Wrap` | past `Max` comes back to `Min` — for the things that are circular, like an hour or a degree |
| **event** `Change()` | the value changed — stepped, typed, or **assigned from code**: the round trip goes out to GTK and back |
| **event** `Activate()` | Enter in the field, or a double click on a row |

## DecimalBox

A number with a fixed number of places, **and it is exact**. `SpinBox` holds a
double; this holds a `Decimal`, which is what money, a duration or a weight is.

| Member | |
|---|---|
| `Currency` | the symbol. `""` is **this desktop's** currency, with the side and the places `localeconv` says; `"US$"` is another one, and where it goes is still this desktop's rule — `US$ 1.234,56` here, `$1,234.56` there, and the program says neither |
| `Decimals` | with `Currency` and no `Decimals`, the currency's own places: two nearly everywhere, zero for yen. Default `2`, up to `9`. `0` is whole numbers, up to `9` |
| `Format` | `Number` `Currency`. Default `"Number"` |
| `Group` | thousands separators. **Off by default**, because a separator appearing while a number is typed is in the way. Default `false` |
| `Max` | the ceiling, a `Decimal`. Default `1000000000000000` |
| `Min` | the floor, as a `Decimal`. Default `-1000000000000000` |
| `Prefix` | text outside the number — `"aprox. "` |
| `Step` | what one press of an arrow moves, a `Decimal`. Default `1` |
| `Suffix` | text outside it — `" kg"`, `" h"`, `" km/h"` |
| `Text` (ro) | what the field says, with the separators, the grouping and the unit |
| `Value` | the number, a `Decimal`. Assigning a `Decimal`, a number or text; **machine text first** (`"1234.567"`, which is what a `.form` and `Decimal.toJSON()` carry) and this desktop's spelling second (`"1.234,56"`) |
| `Wrap` | past `Max` comes back to `Min` |
| **event** `Change()` | the value changed — stepped, typed, or **assigned from code** |
| **event** `Activate()` | Enter in the field |

**What it holds is what it shows.** `Decimals` is the scale of the value and not
only of the text: a 3-place amount assigned to a 2-place box is rounded to two,
which is what every spin in this family does and what keeps a step from losing
the part it does not show. A program that needs to keep more precision than a
field can display keeps it outside the field.

**The spelling is the desktop's, and the unit is not prose.** The separators and
the grouping come from the locale, and so does the side a currency symbol goes
on — which is why a finance app handling several currencies sets `Currency` to
the symbol and says nothing about where it goes. `Prefix`/`Suffix` are format,
like `Style` or `Font`: a unit that has to be translated is assigned from code
(`this.Weight.Suffix = Locale.Text(" kg")`) and is never collected into a
catalogue, or every `kg` and `€` in the program would be an entry a translator
is asked about. A unit that changes with the number — one pear, three pears — is
a suffix set from `Change` with `Locale.Plural`, which is the signal every value
change raises and needs no API of its own.

## Slider

The same four words a `SpinBox` uses, asked with the mouse.

| Member | |
|---|---|
| `Decimals` | how many places the number it draws has — it does not change what `Value` holds |
| `Inverted` | put the high end where the low one was |
| `Max` | the ceiling. Default `100`, which is what a percentage wants |
| `Min` | the floor. **Declare it before `Value`**, as in a `SpinBox` |
| `Orientation` | `Horizontal` or `Vertical`. A vertical slider reads bottom to top. Default `"Horizontal"` |
| `ShowValue` | draw the number beside the rail — worth it when the number means something to the user, and noise when it does not |
| `Step` | what an arrow key moves; Page moves ten of them. Default `1` |
| `Value` | where it sits |
| `ValuePosition` | which side that number sits on: `Top` `Bottom` `Left` `Right`. Default `"Top"` |
| `ClearMarks()` | takes them all off |
| `Mark(value, [text])` | a tick at that value, with an optional label under it |
| **event** `Change()` | the value changed — dragged, keyed, or **assigned from code**. It fires **while dragging**, once per step, which is what makes a live preview possible and what makes an expensive handler feel heavy |

## ProgressBar

Work with an end in sight.

| Member | |
|---|---|
| `Orientation` | `Horizontal` `Vertical`. Default `"Horizontal"` |
| `ShowText` | draw `Text` inside the bar |
| `Text` | what it reads. **Translated** — and `Fill` is how the numbers stay out of the catalogue: declare `"{0} of {1} files"` and fill it |
| `Value` | `0` to `100`, **clamped rather than refused**: a number outside it lands on the nearest end instead of throwing, because a progress that is 103% is an arithmetic slip and not a reason to stop the work |
| `Pulse()` | one step of the indeterminate animation. For work with no measurable end, a `Spinner` says it better |

## LevelBar

A reading, not a progress.

| Member | |
|---|---|
| `Max` | the top. **Default `1`**, which is GTK's own convention for this control: a fraction, where `0.75` is three quarters. Give it `100` if a percentage reads better in your arithmetic |
| `Min` | the bottom of the scale |
| `Mode` | `Continuous` is a bar that fills; `Discrete` is blocks — five bars of signal, four blocks of battery — which is what to use when the underlying reading has steps. Default `"Continuous"` |
| `Orientation` | `Horizontal` `Vertical`. Default `"Horizontal"` |
| `Value` | where the reading sits |

## DatePicker

A date on one line, with a calendar in its popover.

| Member | |
|---|---|
| `Format` | a strftime pattern — `"%d/%m/%Y"`, `"%e %B %Y"` — for what the **button** shows. It does not change `Value`, which is always ISO |
| `Value` | the date as `"YYYY-MM-DD"` — the same text a [`Day`](library.md#day) works in, which is what makes a date in this runtime comparable, sortable and storable without a timezone ever entering it. Default is today |
| `Placeholder` | what the button reads while `Value` is `""`. Default `"—"`; `""` restores the dash. **Translated** |
| **event** `Change()` | the value changed, including from an assignment in code — the round trip goes out to GTK and back |

**`Value = ""` is no date**, which is what an optional one needs: `Field.Date`
already spells the empty date that way and lets it through when the field is not
required, and until this existed the control answered *today* for a field nobody
filled in — a date the program never meant, written into the record in silence.
The popover still opens on the month it was showing, browsing it does **not** fill
the date in, and choosing a day does. There is no gesture for emptying one again:
a form that offers it puts a button beside the field and writes `Fecha.Value = ""`.

A `Calendar` **refuses** `""`: a month is drawn with a day on it and there is no
way to draw one without.

**Turning the page in the popover is a change of value.** GTK has one date and no
separate notion of the month on screen, so browsing to another month moves `Value`
with it — and raises `Change`, like any other way of changing it. A form that must
not be moved by browsing should read the value when the user says *done*
(`Form_Close`, an OK button) rather than trust the last `Change`. The exception is
the empty one, which browsing leaves empty and silent.

## Calendar

The month itself, where a `DatePicker` is the same date on one line. Both answer
the same ISO text; this one has the room to mark days on it.

| Member | |
|---|---|
| `Marks` (ro) | the dates marked, as `"YYYY-MM-DD"` strings, earliest first |
| `ShowDayNames` | the row of weekday names. Default `true` |
| `ShowHeading` | the month and year above the grid. Default `true` |
| `ShowWeekNumbers` | the week number down the side. Default `false`, and worth turning on where people plan in weeks |
| `Value` | the chosen day as `"YYYY-MM-DD"` — the same text a [`Day`](library.md#day) works in. Default is today |
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
| `Value` | what was chosen, as an `rgb(…)` or `rgba(…)` string — **what `Background`, `Foreground` and `Painter.Color` take**, so a colour goes from this control to whatever is drawn with it and nothing has to parse anything. `""` is no colour, and the button shows the cleared state. What comes back is what `Background` takes |
| **event** `Change()` | the value changed, including from an assignment in code — the round trip goes out to GTK and back |

## FontButton

The font shown in itself, with a clear beside it.

| Member | |
|---|---|
| `Value` | a Pango description — `"Cantarell Bold 12"` — which is **what [`Font`](../reference/widgets/Widget.md#how-it-looks) takes on every control**, what `Painter.Font` takes, and what [`Text`](library.md#text) measures with. `""` is no font, meaning *the theme's* |
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
members wherever more than one row can be chosen; `Add` and `Clear` put rows in
and take them out; `Reveal(index)` brings one into view, which selecting from
code does not; `Select` and `Activate` are the two events, with
`ActivateOnSingleClick` deciding which click raises the second. What differs is
what `Add` takes — and what taking one out is called.

**A row that is not there.** A verb that *changes* the list — `RemoveRow`,
`RemovePage`, `RemoveNode`, `SetText` — refuses with a **`RangeError`**: an
index or a key that does not exist is a mistake in the program, and doing
nothing would leave it to be discovered somewhere else. `Select`, `Deselect`,
`Reveal` and `Activate` answer **`false`** instead, because asking about a row
that is not there is an ordinary question — a list with nothing selected is an
ordinary state — and `Select`'s answer is what a form branches on.

**An index is a number, and anything else is refused** — a `TypeError`, on every
verb that takes one, before anything moves. It used to be converted, and a
conversion makes `undefined` or a key passed by mistake into `0`:
`lb.RemoveRow(undefined)` quietly took out the *first* row.

**Taking one out names the address, not the class.** `RemoveRow(index)` on a
`ListBox`, a `RowList` and a flat `TableView`; `RemovePage(index)` on a
`Notebook` and a `Switcher`; `RemoveNode(key)` on a `TreeView` and on a
`TableView` that is a tree. It is deliberately **not** `Remove`: that is every
control's own *detach* — `Widget.Remove`, "out of its parent, and still alive" —
and six classes answering to the same name meant a `ListBox` could not be taken
out of its container by the documented verb, and that `Remove(key)` and
`Remove()` read as one thing. One word, one meaning, and the verb says which
address it wants where a single `Remove(x)` could not.

What is not shared is what one control alone can answer: `Items` and `Text` need
rows that *are* text (`ListBox`, and `ComboBox` beside it), `Filter` needs rows
that are widgets (`RowList`), `Columns`, `Cell` and `Sortable` need fields
(`TableView`), and `Expanded` and the rest of the nesting words belong to the two
that nest.

**`Key` is the application's own name for a row**, and not its text: a list of
translated strings cannot be addressed by what it says, so `Add(text, [key])`
gives a row a name, `Key` reads the selected one and assigning selects the row it
belongs to, and `KeyAt(index)` reads one without selecting it. It is on
`ListBox`, `ComboBox`, `TreeView` and `TableView` — the two that nest already had
it — and not on a `RowList`, whose rows are widgets and are their own identity.

## ListBox

A list of strings.

| Member | |
|---|---|
| `ActivateOnSingleClick` | raise `Activate` on one click instead of two. Default `false` |
| `Index` | the selected row, `-1` for none. Assigning selects it — and **raises `Select`**. Default `-1` |
| `Items` | the whole list, as an array of strings. Assigning replaces every row at once; reading gives the rows as they are now. **Translated** — a list declared in a `.form` goes through the catalogue |
| `MultiSelect` | more than one row at a time |
| `Text` (ro) | the words of the selected row, `""` when there is no selection |
| `Count` (ro) | how many rows there are |
| `Selection` (ro) | every selected row, as an array of indices in order |
| `Key` | the selected row's key, `""` for none; assigning selects the row it belongs to, `""` clears the selection, and a key nothing has is a `RangeError`. **Compare `Key`, never `Text`** — the words are prose and a translated build answers in another language |
| `KeyAt(index)` | that row's key, without selecting it. **`RangeError`** when there is no such row |
| `Activate(index)` | raises `Activate` for that row, as a double click would; answers whether there was one |
| `Add(text, [key])` | one row at the end, which is what a list being filled a row at a time wants. `key` is the application's own name for it |
| `Clear()` | empties it |
| `Deselect(index)` | unselects it |
| `DeselectAll()` | selects nothing |
| `RemoveRow(index)` | takes that row out. **`RangeError`** when there is no such row |
| `SetText(index, text)` | renames one in place, leaving the selection and the scroll where they are. **Translated**; **`RangeError`** when there is no such row |
| `Reveal(index)` | brings that row into view with the least scrolling it takes, and answers whether there was one |
| `Select(index)` | selects that row, leaving the others where several are allowed |
| `SelectAll()` | with `MultiSelect` |
| **event** `Select()` | the selection moved. Ask `Index` or `Text` for what it is now |
| **event** `Activate()` | a double click on a row, or Enter on it: the gesture for *use this one* |

## ComboBox

A drop-down.

| Member | |
|---|---|
| `Index` | which is chosen; `-1` when the list is empty. Assigning chooses the row; **assigning `-1` moves nothing**, because a drop-down with items always has one chosen (the first, until told otherwise) |
| `Items` | the contents, as an array of strings. Assigning replaces every row at once **and chooses the first one** — a non-empty drop-down always has something chosen. **Translated**: a list declared in a `.form` goes through the catalogue |
| `Text` | the chosen row's words. Reading it is reading the *translated* text |
| `Count` (ro) | how many rows there are |
| `Key` | the selected row's application key; assigning selects the row it belongs to, and a key nothing has is a `RangeError`. `""` moves nothing, as `Index = -1` does — a drop-down with items always has one chosen |
| `KeyAt(index)` | that row's key, without selecting it. **`RangeError`** when there is no such row |
| `Add(text, [key])` | one more, at the end. `key` is the application's own name for it |
| `RemoveRow(index)` | takes that row out. **`RangeError`** when there is no such row |
| `SetText(index, text)` | renames one in place, leaving the selection where it is. **Translated**; **`RangeError`** when there is no such row |
| `Clear()` | empties it, and nothing is chosen afterwards |
| **event** `Select()` | the selection moved. Ask `Index` or `Text` for what it is now |

## TreeView

One column of text, in a hierarchy, addressed by **key**.

**Which of the two hierarchy controls to use is decided by one thing, and GTK
decides it**: a `TableView` cannot hide its heading row. So a hierarchy *without*
headings is a `TreeView`; one *with* them — columns, widths, alignment — is a
`TableView` whose rows nest ([below](#tableview)).

Everything they both do, they do with the same words: `Key`, `Count`,
`AutoExpand`, `Add`, `Clear`, `RemoveNode(key)` (with the subtree), `Exists`,
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
| `ActivateOnSingleClick` | raise `Activate` on one click instead of two. Default `false` |
| `AutoExpand` | open a node as it arrives, and again when it gains a child after being closed by hand. Default `true`. A node with nothing under it reads as open too, which hides nothing and is what turns the arrow off. `TableView`'s is the same mechanism and answers the same |
| `Key` | the selected node's key, `""` for none. Assigning selects that node, **opening the way to it**, and raises `Select`. Keys are yours to choose — a path, an id |
| `Text` (ro) | the words of the selected node, `""` when nothing is selected |
| `Count` (ro) | how many nodes there are, **at every level**, open or closed |
| `Add(key, text, [parentKey], [icon])` | a node. `key` is yours to choose and must be unique in this tree; an empty `parentKey` is a root; `icon` is a name from the theme, and one the theme lacks is dropped rather than drawn as a hole |
| `Clear()` | empties the whole tree |
| `CollapseAll()` | closes every node |
| `CollapseNode(key)` | closes it |
| `Exists(key)` | whether that node is there. The question you ask *before* you know, so it answers rather than throwing |
| `RemoveNode(key)` | takes that node out **and the subtree with it** — a node whose parent is gone is not something this control can show |
| `Reveal(index)` | brings that visible row into view with the least scrolling it takes, and answers whether there was one. The index is a visible position, like `Activate`'s |
| `Activate([index])` | raises `Activate` for that visible position, as a double click would; the selected row with no argument. Answers whether there was one |
| `SetText(key, text)` | renames a node, keeping it where it is — and keeping the selection on it. **Translated** |
| `SetIcon(key, name)` | its icon, or `""` for none. One column, so no column argument — otherwise it is `TableView`'s |
| `ExpandAll()` | opens every node |
| `ExpandNode(key)` | opens it, **and the way to it**: a node only exists on screen once its ancestors are open. Not `Expand`, which is `Widget`'s layout property |
| `Expanded(key)` | whether it is open |
| **event** `Select()` | the selection moved — by the user, by an assignment, or because what was selected is no longer visible. Ask `Key` or `Text` for what it is now |
| **event** `Activate()` | a double click on a node, or Enter on it: the gesture for *open this one* |

## TableView

A list with columns, **and its rows may nest**. The control to reach for whenever rows have fields: `TreeView` is one column of a hierarchy with no headings, `ListBox` is strings, `RowList` is widgets and `Grid` is a layout.

| Member | |
|---|---|
| `ColumnLines` | rules between the columns. Default `false` |
| `Columns` | an array of `{ Text, Width, Alignment, Editable }`. `Text` is **translated**; `Width: 0` sizes itself and the last column takes the slack; `Editable: true` makes a cell a field — clicked, typed and committed — and an editable column reads left-aligned, because a `GtkEditableLabel` is not a label |
| `Count` | how many rows — **settable**, which is the on-demand mode: the table then asks `Data(row, column)` for each cell it draws. **Settable**, and setting it is the on-demand shape. Assigning it puts the table in this shape and clears any rows it held |
| `HeaderMenu` | the menu a column heading offers on a secondary click, as the same array of items `Menu` takes. Built for each click, and every item's handler is told the column, last: `MnuHide_Click(column)`. Like `Menu`, refused on a table that is not in a form yet |
| `Index` | the selected row, `-1` for none. Assigning selects it. Default `-1` |
| `MultiSelect` | more than one row at a time. Refused on a tree |
| `RowLines` | rules between the rows. Default `true` |
| `Sortable` | makes the headers clickable. **The table does not reorder itself** — it raises `Sort`. Default `false` |
| `Selection` (ro) | every selected row, as an array of indices in order |
| `ActivateOnSingleClick` | raise `Activate` on one click instead of two. Default `false` |
| `Activate([index])` | raises `Activate` for that visible position, as a double click would; the selected row with no argument. Answers whether there was one. In both the flat and the tree shape, because a click lands on a position |
| `Add(values, [options])` | one row, as an array of strings. A row shorter than there are columns reads `""` for the rest. Clears an on-demand `Count`. **`options` is `{ Key, Parent, Icon }`, and a row with a `Key` is a node**: the first one makes this table a tree, `Parent` is the key of the node it goes under (absent is a root), and `Icon` is the picture for its first column — the same one `TreeView.Add` takes, so a node need not be added and then decorated |
| `AutoExpand` | opens a node as it arrives, and again when it gains a child after being closed by hand. Default `true`. A tree only. The same mechanism `TreeView` uses, answering the same |
| `Key` | the selected node's key; assigning selects, opening the way to it. `""` selects nothing. A tree only |
| `Exists(key)` | whether that node is there. `false` on a flat table rather than a refusal: it is the question you ask *before* you know |
| `ExpandNode(key)`, `CollapseNode(key)` | opens or closes it. Opening opens the way to it too, since a row only exists once its ancestors are open. Not `Expand`, which is `Widget`'s layout property |
| `ExpandAll()`, `CollapseAll()` | every node |
| `Expanded(key)` | whether it is open |
| `Cell(row, column)` | one value. Refused on an on-demand table, which has no cells to answer about |
| `Clear()` | empties it — **and forgets which of the three shapes this table was** |
| `RemoveRow(index)` | takes that row out. **Flat only** — a tree says `RemoveNode(key)`, and this one refuses with that sentence |
| `RemoveNode(key)` | takes that node out, **and the subtree with it**. **Tree only** — a flat table says `RemoveRow(index)` |
| `Reveal(index)` | brings that visible row into view with the least scrolling it takes, and answers whether there was one |
| `Row(index)` | that row's values, as the array it was given — including any it was given beyond the columns declared. Refused on an on-demand table |
| `SetCell(row, column, value)` | one cell, in place. The selection stays where it is |
| `SetIcon(row, column, name)` | an icon from the theme beside a cell's text. `""` takes it off. Refused on an on-demand table |
| `Select(index)`, `Deselect(index)` | move the selection from code. `Select` leaves the others alone where several are allowed |
| `SelectAll()` | with `MultiSelect` |
| `DeselectAll()` | selects nothing |
| `SortBy(column, [ascending], [compare])` | actually reorders the rows it holds, **by the text the cells show**: natural order by default (`9` before `10`, the locale's collation otherwise), or `compare(a, b)` — the two cells' text, answering a number as `Array.sort`'s does — for what natural order reads wrongly: a minus sign, grouped thousands, a `d/m/Y` date. **Stable**: equal cells keep the order they had, so sorting by one column and then another nests them. A comparator that throws leaves the rows as they were |
| `SortColumn(column, [ascending])` | the same as clicking that heading from code: the arrow moves and `Sort` is raised |
| **event** `Select()` | the selection moved — by the user or by an assignment. Ask `Index` for where it is and `Cell`/`Row` for what is there; `Key` when the table is a tree |
| **event** `Activate()` | a double click on a row, or Enter on it. The gesture for *open this one* |
| **event** `Data(row, column)` | the table needs a cell. **The return value is the answer**: a string, or `{ Text, Icon }` for a cell with a picture |
| **event** `Sort(column, ascending)` | a sortable header was clicked. **The handler decides** — `SortBy` is what actually reorders |
| **event** `CellEdit(row, column, text)` | an editable cell's edit ended — Enter, or the focus moving away. `row` is an index in a flat table and a key in a tree, as every verb here addresses one. **Returning `false` refuses it** and the cell goes back to what it said; anything else is taken and the text is written into the row. An on-demand table holds no cells, so there the handler stores it |
| **event** `HeaderClick(column, button, ctrl, shift)` | a column heading was pressed — the one pointer event a heading raises, because GTK claims its press before the bubble phase. `button` is `1` primary, `2` middle, `3` secondary. **The return value is the menu of the secondary click**: an array replaces `HeaderMenu` for that click, anything else falls back to it. A primary click also raises `Sort` when `Sortable`, on the release |

**The heading's menu is built for each click**, which is what lets an item act on the column it was opened over — and it is why the state a program sets on an item from code does not survive the next right-click. A menu that depends on the context answers it from `HeaderClick`, and a program that wants its own order turns `Sortable` off and orders in the handler.

### A table is flat or a tree

Decided by the first row put in it, and `Clear()` decides again:

| | `Add(values)` | `Add(values, { Key })` | `Count = n` |
|---|---|---|---|
| **flat, holding its rows** | ✔ | ✖ | clears the rows |
| **flat, on demand** | clears the `Count` | ✖ | ✔ |
| **a tree** | ✖ | ✔ | ✖ |

**In a tree, a row is addressed by its key** — `Cell(key, column)`,
`SetCell(key, …)`, `SetIcon(key, …)`, `Row(key)`, `RemoveNode(key)`, which takes the
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
| `Modified` | the editing flag. **Clear it after saving**: nothing else does, and it is what a window title's asterisk and a *save before closing?* are read from |
| `ReadOnly` | shown but not editable. **The program can still write to it**, which is what a log pane needs |
| `Text` | everything in the buffer. Assigning replaces it all and **raises `Change`** |
| `Wrap` | wrap long lines. Default `true` on a [`TextEditor`](../reference/widgets/TextEditor.md), `false` on a [`SourceEditor`](../reference/widgets/SourceEditor.md), which is the right default for each |
| `Line` (ro) | the line the cursor is on, **counting from 1** |
| `Column` (ro) | the cursor's column |
| `Offset` (ro) | the cursor's position as a **character** offset — the same unit `Column` counts in, so an emoji is one |
| `Selection` (ro) | the selected text, `""` for none |
| `CanUndo` (ro) | whether there is anything to go back to — what an *Undo* item's `Enabled` is read from |
| `CanRedo` (ro) | the same, forwards |
| `ScrollX` / `ScrollY` | how far it is scrolled, in pixels, and assignable — clamped to what there is to scroll. **Not** the cursor: `Line` and `GotoLine` are about that, with the scroll following as a side effect |
| `ScrollMaxX` / `ScrollMaxY` (ro) | the furthest `ScrollX` can go — the content's width less the part on screen, and `0` when it all fits |
| `Append(text)` | at the end, **scrolling there**, whatever the cursor was doing — which is what a log pane wants and what makes a read-only editor the right control for one |
| `Clear()` | empties it |
| `GotoLine(line)` | puts the cursor there and scrolls to it |
| `CursorBounds()` → `{ X, Y, Width, Height }` | where the insertion cursor is drawn, in the control's own coordinates — what `Popover.Popup(editor, rect)` points at for a hint beside the cursor. Only once the control has been laid out; a cursor scrolled out of view answers a rectangle outside the control, which is the truth and the caller's to test. Read it once the control has a rectangle; before the window is up there is nothing to be drawn in |
| `PositionAt(x, y)` → `{ Line, Column, Index }` | which character is under that point of the control, in the coordinates `MouseMove` reports — `null` when the point is not over text, so a pointer past the end of a line has no answer to give |
| `LineOf(index)` | the line a **search's index** falls on, 1-based and clamped — `index` is the number `Regex.Index` gives, and it counts UTF-16 units |
| `OffsetAt(line, [column])` | the character offset of that position, clamped as `Select` clamps — the inverse read of `Offset` |
| `Insert(text)` | at the cursor. The selection is left alone, so on a selected word this lands after it rather than replacing it |
| `Redo()` | one step forward |
| `Select(line, [column], [length])` | selects from there. A column past the end of the line is the end of the line |
| `Undo()` | one step back |
| **event** `Change()` | the value changed, including from an assignment in code — the round trip goes out to GTK and back |
| **event** `Cursor()` | the cursor moved. `Line` and `Column` say where |
| **event** `Scroll(x, y)` | it was scrolled — by the wheel, a scrollbar, the keyboard or an assignment. One event for a diagonal move. Two panes locked together is `Before_Scroll(x, y) { this.After.ScrollY = y; }`, and it does not loop: assigning a value it already has emits nothing |

**Two units, and which verb takes which is the whole of it.** `Offset` and
`OffsetAt` count **characters**, as `Column` and `Select` do. `LineOf` receives
the **index a search gives** — the number `Regex.Index`, `indexOf` and `slice`
speak — which counts UTF-16 units, so a character outside the BMP is two of
them. That is deliberate and not an inconsistency: the verb that crosses *from
a search* is handed the search's own number and converts exactly, which is what
`GotoLine(LineOf(m.Index))` is. `OffsetAt(Line, Column) === Offset` always.

The lines `LineOf` counts are GTK's, which is what the editor draws: `\n`,
`\r\n` as one break, a lone `\r` and U+2029 break; **U+2028 does not**, although
Pango breaks it — so `Text.Lines` and `LineOf` can disagree on that one
character, and the one a `GotoLine` will land on is this one.

## TextEditor

A `GtkTextView`: the plain multi-line field. Observations, a note, a description,
a log pane — the text a `TextBox` cannot hold, since a `GtkEntry` has no notion of
a newline at all.

Everything it has is [`Editor`](#editor--inherited-by-both-editors)'s. What is its
own is what it arrives as: **wrapping**, in the theme's font, with no gutter and
nothing to highlight.

| Member | |
|---|---|
| `Text` | everything in the buffer. Assigning replaces it all and **raises `Change`** |

**`Text` is prose here and is not on a `SourceEditor`**, and that is the whole
reason the two are siblings under an abstract class instead of one extending the
other: the declaration accumulates down a class chain, so a source editor
inheriting this row would put a line of somebody's code in a `.po` file.

## SourceEditor

GtkSourceView: highlighting, completion, search and gutter marks are the widget's
own. It is [`Editor`](#editor--inherited-by-both-editors) plus everything below.

| Member | |
|---|---|
| `Completion` | offer the buffer's own words while typing — the floor of what an editor owes, and the whole of what can be known without being told |
| `CompletionTitle` | the heading of the popup your own provider fills. **Translated** |
| `Language` | a GtkSourceView id — `js` `json` `c` `python3` `markdown` `css` `sh` `xml` `sql` `yaml` `diff`… `""` for none. **`PropertyOptions("Language")` asks this machine what it has**, which is the honest list rather than one written down here |
| `ShowLineNumbers` | the gutter's numbers. Default `true` |
| `ShowMarks` | the gutter's marks — see `Mark` |
| `Text` | everything in the buffer. Assigning replaces it all and **raises `Change`** |
| `Theme` | `Adwaita` `Adwaita-dark` `classic` `classic-dark` `cobalt` `cobalt-light` `kate` `kate-dark` `oblivion` `solarized-light` `solarized-dark` `tango`. Default `"classic"` |
| `Matches` (ro) | how many the last `Search` found |
| `MatchIndex` (ro) | which one the cursor is standing on — the `3` in *3/12* |
| `ClearMarks([kind])` | takes them off every line |
| `FindNext()` | moves to the next match, wrapping around |
| `FindPrevious()` | and backwards |
| `Mark(line, kind, [text])` | a gutter mark. `kind` is `Error` `Warning` `Info` `Bookmark` — or `Added` `Removed` `Gap`, which **paint the line** — and `text` is its tooltip |
| `Marks([kind])` | **a record per mark**, in line order: `{ Line, Kind, Text }` — not a list of line numbers, which is what "the lines that carry one" was read as by the first thing that used it |
| `Replace(text)` | the match the cursor is standing on |
| `ReplaceAll(text)` | every match |
| `Search(text, [{CaseSensitive, WholeWord, Regex}])` | how many there are, highlighting every one. **It does not move the cursor**: typing in a find field and jumping to a match happen at different moments. `Regex: true` is **PCRE2** — GtkSourceView's own engine and not the language's [`Regex`](library.md#regex): always multiline, and `\d` `\w` `\b` are Unicode-aware. **It does not move the cursor**: typing in a find field and jumping to a match happen at different moments, and a find bar that jumped on every keystroke would drag the view about while somebody is still typing |
| `ShowCompletion()` | opens the completion popup from code |
| `Unmark(line, [kind])` | takes marks off that line |
| **event** `Complete(word, line, column, text)` | a completion was asked for. Answer with a list, or nothing. An entry is a **word**, or `{ Text, Detail }` for one that says what it is beside itself — a type, a one-line description. An entry that is neither is skipped, not refused |

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
| `ToPng([width], [height])` | the same frame as `Save`, answered as `Bytes` instead of written: a chart to be posted, attached or put in a reply, with nothing on disk. Same sizes, same refusals, same rule that a `Draw` which throws answers nothing |
| `SavePdf(path, width, height, [pages], [before])` | the same `Draw`, once per page, into one **PDF**. The size is in **points**, 72 to the inch (A4 is 595×842, Letter 612×792) and is what the handler is given as its frame size; the surface is vector, so text stays text. `pages` defaults to 1. `before(page)` is called before each page — that is how the handler knows which one it is drawing, since `Draw`'s own arguments do not say. A page that throws leaves **no file** |
| **event** `Draw(painter, width, height)` | paint it. The size is the frame's, in logical pixels |
| **event** `Paginate(width, height)` | **how many sheets this document is at that size**, answered back. Raised by [`Printer`](library.md#printer) once the dialog has settled the paper — the only moment it can be known, and the moment the count that was declared may be wrong. `width`/`height` are the printable area in points, which is the sheet **less the printer's own margins**. A control that declares none keeps the `Pages` it was given, and one whose layout does not move with the paper should declare none: `lib/report` scales to fit and does not, `lib/markdown` re-flows and does. It runs inside the print operation, so measure freely but **raise no events of your own** — one that re-entered the drawing hung the suite |
| **event** `DrawPage(painter, page, width, height)` | paint one **sheet of paper**, raised by [`Printer`](library.md#printer) and by `SavePdf` in place of `Draw`. `page` is 1-based and the size is the printable area in **points**, 72 to the inch. A form that declares no `DrawPage` gets `Draw`, which is right for a drawing that is one page — and is why nothing had to change when this arrived |

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
has to keep together. Paper is [`Printer`](library.md#printer)'s and not this
control's: `Printer.Send(area)` opens the dialog and `Printer.ToFile(area, path)`
writes a PDF without one, and on paper the frame goes to `DrawPage` rather than
`Draw`. Laying a *control* onto a page — rather than what a `Draw` paints — is
still open: a form with real widgets on it has no path to paper except drawing
it by hand.

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
| `Image(path or bytes, x, y, [width], [height])` | a picture, put down with its top-left corner there. **One of `width`/`height` is enough** — the other follows the image's own proportions. With neither it is drawn at its natural size, one image pixel to one. A **string** is a file, absolute or relative to the working directory; **`Bytes`** are the image itself, which is what `Http` answers with. Missing, or not an image, **throws** and ends the frame. A path is decoded once and cached, so a drawing may paint the same logo every frame; **bytes are decoded on every call** — the cache is keyed on the path, and bytes have no key that stays true. Measured: 2.7 ms a call for a 640×480 PNG against 0.045 ms for the same file cached. A handler painting the same bytes every frame wants a `Picture` with `LoadBytes` instead |
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
| `Text(text, x, y, [options])` | the text with its top-left corner there, in `Font`. Leaves no path behind. `options` is `{ Width, Markup, Align }` — see below |
| `TextHeight(text, [options])` | how tall it would be. A chart asking for a line's height passes `"0"`; the same options, so a wrapped or styled run measures as what it will be |
| `TextWidth(text, [options])` | how wide it would be, which is how a label is right-aligned |
| `Translate(x, y)` | move the origin |

**Every coordinate has to be a finite number.** A `NaN` — a series with a missing
reading makes `p.LineTo(x, undefined)` an ordinary line — is worse than a
refusal: cairo records the call, puts the context in an error state, and *the
rest of the frame draws nothing*, with no throw and nothing to see. So a `NaN`,
an infinity or a word is refused where it is written, naming the call it belongs
to (`LineTo: NaN is not a finite number`).

**`Width`, `Markup` and `Align`** are the three things a run of text may be told,
and they are the same three [`Text`](library.md#text) measures with:

| | |
|---|---|
| `Width` | wrap to that many pixels. A word wider than the box is **broken**, never left to overflow |
| `Markup` | the string is **Pango markup** — `<b>`, `<i>`, `<tt>`, `<s>`, `<span foreground=… underline=…>`. Invalid markup **throws where it was written**; `Text.Escape` is how a document's own `<` and `&` get in safely |
| `Align` | `Left` `Center` `Right` — what the wrapped lines are aligned to *inside* `Width` |

**Markup is what a paragraph whose font changes halfway needs.** A line with a
bold word, a name in italic and a code span in it cannot be broken by measuring
strings: the break belongs to whatever knows how wide each piece is, which is
Pango. One call measures it and one call draws it, and they agree because they
are the same layout — the rule every measurement here follows. `Label.Markup` is
the same facility where text is *packed* rather than drawn; `lib/markdown` is
what asked for this one.

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

VTE with a real pty, so colours, prompts and interactive input all work. Use it for anything interactive; for a command you capture, use [`Exec`](library.md#exec) — and for showing what it printed, a read-only [`TextEditor`](#texteditor), whose `Append` is what a log pane wants.

**VTE is optional at build time**, so this is the one control that may not be able to do its job. `Available` says whether it can; `Widget.Available("Terminal")` is [the same question asked of the class](#what-there-is-and-what-this-build-can-run), which is what a palette wants. Where it is false the class is still all here — one constructs, a `.form` naming one loads, every property answers and `Feed`, `Text` and `Clear` work — and `Run`, `Stop` and `Kill` refuse, naming the package that is missing. `Link` never fires there, since there is nothing highlighting anything.

| Member | |
|---|---|
| `Available` (ro) | whether this build can run a child. `Widget.Available("Terminal")` is [the same question asked of the class](#what-there-is-and-what-this-build-can-run), which is what a palette wants. `false` on a runtime built without VTE, where the three verbs refuse |
| `FontScale` | a multiplier on the terminal's own font. Default `1` — the Ctrl+`+` of a terminal, which is a property here rather than a gesture |
| `LinkPattern` | a regex; clicking text that matches raises `Link(text)`. What the text *means* is yours |
| `ScrollbackLines` | how much history it keeps. Default `10000` |
| `Text` (ro) | everything on screen and in the scrollback — what a *copy all* or a bug report wants |
| `Running` (ro) | whether a child is alive |
| `Clear()` | resets it |
| `Feed(text)` | writes to the display **without a child**: a banner, a note about what is about to run, the reason something was refused |
| `Kill()` | SIGKILL, for the one that did not answer |
| `Run(argv, [workdir])` | starts a child on a real pty, so colours, prompts and input all work. `argv` is the program and its arguments as an array — no shell, so nothing is word-split or globbed behind your back |
| `Stop()` | SIGTERM to the child's **process group**, which is what reaches a shell's own children |
| **event** `Exit(code)` | the child ended, with the status a shell would report |
| **event** `Link(text)` | that text was clicked. **What it means is yours** |

## Video

A clip that plays, in the window. One playbin3 per control, shown through the
paintable sink in a `GtkPicture` — which is why it styles as one (see
`Picture`). Audio without a window is [`AudioPlayer`](library.md#audioplayer).

| Member | |
|---|---|
| `Uri` | what to play: a URI (`file://`, `http(s)://`, `rtsp://`) **or a plain local path**, which is turned into one. One property for both, so there is nothing to disagree. Setting it stops whatever was playing |
| `User` | RTSP digest identity, applied to the source the playbin builds. `""` for none |
| `Password` | the secret beside it. **Write-only**: it reads back `""` and is never serialised, so no `.form` carries it in clear text |
| `Latency` | ms the RTSP jitterbuffer may hold. Default `2000`, the source's own. Read when the source is built, so a change lands on the next `Play` from a stopped player |
| `Volume` | `0`…`1`. Default `1` |
| `Muted` | silence without touching `Volume`, so unmuting comes back to where it was |
| `Loop` | reseek instead of ending. A live stream cannot seek, so it ends anyway |
| `Fit` | `Fill` `Contain` `Cover` `ScaleDown`, as a [`Picture`](../reference/widgets/Picture.md)'s. Default `"Contain"` |
| `Available` (ro) | whether **this machine** could play a clip: GStreamer's base plugins **and** the `gtk4paintablesink` element that puts frames in a `GtkPicture`. `Widget.Available("Video")` is the same answer asked of the class, and it is the one a palette asks before offering the control. `false` also on a runtime built without GStreamer |
| `Buffering` (ro) | how full the buffer is, `0`…`100`. `100` is nothing to wait for — a local file never says otherwise — and less is a stream refilling, which **holds the picture while `Playing` stays true**. It is [`ProgressBar.Value`](../reference/widgets/ProgressBar.md)'s range, since that is where a form puts it |
| `Position` (ro) | seconds in, `0` when unknown — which includes playing live |
| `Duration` (ro) | seconds long, `-1` while unknown — which is always, on a live stream |
| `Playing` (ro) | whether it is going — what `Play` asked for, until `Pause`, `Stop`, the end or an error. **Not a sample of the pipeline**, which reads as stopped mid-loop and mid-rebuffer |
| `Seekable` (ro) | whether `Seek` has anything to work on. Answered once the stream is known, not with the first frame |
| `SourceWidth` (ro) | the clip's own width, `0` until a frame has been decoded — `Picture`'s spelling |
| `SourceHeight` (ro) | the clip's own height |
| `Play()` | plays, and replays from the top after `Ended`. **Refused with no `Uri`** |
| `Pause()` | holds the frame and the position |
| `Stop()` | parks it: back to no state, the position forgotten |
| `Seek(seconds)` | jumps there. **Refused on a stream that cannot seek**, naming it |
| `Save(path)` | the frame on screen as a PNG — [`DrawingArea.Save`](../reference/widgets/DrawingArea.md)'s spelling. **Refused before anything has been decoded** |
| **event** `Ended()` | the clip ran out. It leaves the **last frame up** (a pause, not a black stop) |
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

**That second case is why `Available` is asked of the machine and not declared
at build time.** A runtime can have GStreamer and still be on a machine whose
registry lacks the sink — a runner with the base plugins is exactly that shape
— and the palette has to know before a `Video` is offered, not when `Play`
throws. The question costs the plugin registry on its first ask (6 ms with the
cache warm, 573 ms without it) and is cached after, which is why it is asked
lazily rather than at start-up.

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
| `Text` | the caption drawn in the frame's own border. **Translated** — a group's name is prose |

## Expander

A `Frame` that folds.

| Member | |
|---|---|
| `Expanded` | open or folded. Folding it takes its height back, which is why the window has to know. Assigning it opens or folds it, and **raises `Toggle`** |
| `Text` | the caption beside the arrow. **Translated** |
| **event** `Toggle()` | it was opened or folded — by the user or by an assignment |

## Grid

Rows and columns whose sizes come from what is in them. Children flow in order, wrapping at `Columns`; a child with `HExpand` takes the slack and `ColumnSpan` lets one run under several. **The answer to a caption that grows in translation**, which a row of coordinates has none.

| Member | |
|---|---|
| `ColumnSpacing` | pixels between the columns |
| `Columns` | how many columns children wrap at; a column is as wide as its widest child. Default `2`. Default `2`, which is a grid of labels and fields |
| `Homogeneous` | every cell the same size, which is what a keypad wants and a form of fields does not |
| `RowSpacing` | pixels between the rows |

## Flow

A gallery: children wrap into as many columns as fit, and it scrolls itself.

| Member | |
|---|---|
| `ColumnSpacing` | pixels between children on a line |
| `Homogeneous` | every child the same size, which is what a grid of thumbnails wants |
| `MaxPerLine` | at most this many, even when there is room for more. Default `100`, which is *as many as fit* in practice |
| `MinPerLine` | at least this many, even when they have to be squeezed |
| `RowSpacing` | pixels between lines |

## Scroller

Content whose size is not its parent's business: the view is as big as the room it is given, the content as big as it needs, and the difference scrolls. Give it an `Arrangement` and the content follows the view as well, and scrolls only once it cannot fit — [below](#scroller).

| Member | |
|---|---|
| `Scrollbars` | `Both` `Horizontal` `Vertical` `None`. Default `"Both"` |
| `ScrollX` | how far across it is scrolled, in pixels. Assigning **clamps** to `[0, ScrollMaxX]`, so a number past the end means the end |
| `ScrollY` | the same downwards |
| `ScrollMaxX` (ro) | the largest `ScrollX` that still shows content: the content's width minus one view. `0` when there is nothing to scroll |
| `ScrollMaxY` (ro) | the same downwards |
| **event** `Scroll(x, y)` | the position moved — by the user, the wheel, the keyboard, or an assignment. **Both axes are reported together**, so a diagonal move is one event |

**`ScrollY === ScrollMaxY` is the test for *at the bottom***, which is the whole
of infinite scroll: the maximum is the content minus one view, so it is the last
position that still shows something rather than the content's own height.

**`Arrangement` is what makes a scroller *fill* as well as scroll**, and without
it the content is only ever as big as it needs to be. The default slot is a
`Fixed`, which is what lets `X`/`Y` mean something inside a scroller — and a
`Fixed` has no design size for an anchor to keep a gap against, so `HAlign:
"Fill"` on the content has nothing to fill: a panel in a 900-wide view is as
wide as what is in it. Arranged `Horizontal` or `Vertical`, the slot is a box,
and then a child with `HExpand`/`VExpand` is **stretched across the view and
free to grow past it along the view**, which is fill and scroll in one
declaration:

```js
const view = new Scroller();
view.Arrangement = "Vertical";     /* a column of content */
view.Scrollbars  = "Both";
const grid = new Grid();           /* one tile, or twenty */
grid.Columns = 4;
grid.Homogeneous = true;
grid.HExpand = true;               /* claims the width the view has */
grid.VExpand = true;               /* and the height, while there is spare */
view.Add(grid);
```

Measured in a 900x500 view, tiles with a 180x130 floor and `Columns` at
`ceil(sqrt(n))`: one tile is **898x498**, four are 2x2 at **445x245** with
nothing to scroll, and twenty are a **924x538** grid with `ScrollMaxY 38` — the
view never grows, and which of the two happens is decided by how much there is
rather than declared in advance. Unarranged, the same declarations leave the
grid at what is in it — **180x130** for the one tile, **366x266** for the four —
with the rest of the view empty.
[`examples/kanban`](../../examples/kanban) is both ways round in one window: a
row of columns that scrolls sideways, each column a scroller that fills.

**An axis that may not scroll asks its parent for room instead.** `Scrollbars`
is what decides that, and it is not `MinWidth`'s job: the twenty tiles above
under `Scrollbars: "Vertical"` push the window from 900 to 924 wide, with or
without a floor on the scroller, because a view that cannot scroll across has to
be given its content's width. Scroll the axis that must not ask.

**Scrolling to the end of something you just added needs a turn.** A row added in
this turn has no allocation yet, so the maximum is still the old one and
`ScrollY = ScrollMaxY` lands one row short. `Timer.After(0, …)` is where that
belongs — the same rule every measurement here follows.

## RowList

One row per child, each row **a widget of its own**, with scrolling and selection. A `ListBox` holds strings; this holds controls — what a property editor, a settings page or a list of results needs.

| Member | |
|---|---|
| `ActivateOnSingleClick` | raise `Activate` on one click instead of two. Default `false` |
| `Index` | the selected row, `-1` for none. Assigning selects it and **raises `Select`**. **A hidden row is still a row**: `Filter` changes what is on screen, not what the list holds. Default `-1` |
| `Count` (ro) | how many rows there are, **hidden ones included** |
| `MultiSelect` | more than one row at a time |
| `Selection` (ro) | every selected row, as an array of indices in order |
| `Activate([index])` | raises `Activate` for that row, as a double click would; the selected one with no argument. Answers whether there was one |
| `Deselect(index)` | unselects it |
| `DeselectAll()` | selects nothing |
| `Refilter()` | says the answer to `Filter` may have changed. The whole of the API on this side — what a handler answers *from* is yours |
| `RemoveRow(index)` | takes that row out — **and the control in it goes with it**: the row is the widget's wrapper, so this is the same as deleting the child. **`RangeError`** when there is no such row |
| `Reveal(index)` | brings that row into view with the least scrolling it takes, and answers whether there was one |
| `Select(index)` | selects that row, leaving the others where several are allowed |
| `SelectAll()` | with `MultiSelect` |
| **event** `Select()` | the selection moved. Ask `Index` or `Selection` for which rows; what is *in* them is the widgets you put there |
| **event** `Activate()` | Enter in the field, or a double click on a row |
| **event** `Filter(control, index)` | asked while the list is laid out. **Returning `false` hides the row**; no handler shows every one. A lookup and nothing else |

## Overlay

Stacked: the first child fills, the rest float on top. It adds no *member* to `Container` and gives two of them a meaning of their own.

| Member | |
|---|---|
| `Children[0]` | its real children, one level deep, in the order they are in |
| `Reorder(child, 0)` | moves a child among its siblings. The index counts them *without* the one being moved. **Every container with an order answers it**: a box, a `Grid`, a `Flow`, a `RowList`, a `Notebook`, a `Switcher`, a `Split` (the index names the half) and an `Overlay` (index `0` is the base layer, the one that fills). A `Fixed` refuses — there the order is the painting order, which is `Raise`/`Lower` |
| `Raise()` / `Lower()` | to the top of the painting order, among its siblings on a surface |
| `HAlign` / `VAlign` | `Auto` `Start` `End` `Center` `Fill` — what becomes of it when the container is not the size the coordinates were drawn for |

**`X`/`Y` mean nothing in an overlay and are not saved.** A stack is not a
drawing surface: there is no coordinate to give a layer, so a hand-written
`.form` carrying `X`/`Y` on one loses those two numbers the first time it is
saved. The property grid says so on the row.

A message over the content instead of in front of it, which is what
[`examples/notify`](../../examples/notify) is:

```json
{ "type": "Overlay", "name": "Stage", "properties": { "Expand": true },
  "children": [
    { "type": "Panel",   "name": "Content", "properties": { "Arrangement": "Vertical" } },
    { "type": "Spinner", "name": "Spn",
      "properties": { "HAlign": "Center", "VAlign": "Center", "Visible": false } },
    { "type": "Panel",   "name": "Toast",
      "properties": { "HAlign": "Center", "VAlign": "Start", "Margin": 12,
                      "Style": "osd", "Visible": false } } ] }
```

```js
this.Toast.Visible = true;                  /* over the content, not over the app */
this.Spn.Raise();                           /* and above the toast while it spins */
```

## AspectFrame

A rectangle of a given proportion, centred in the room there is. One child, and it gets the whole of that rectangle.

| Member | |
|---|---|
| `Ratio` | the proportion to keep, as `"16:9"` (or `"16/9"`, or a number). **`0` or `""` is the child's own**, which is the default. Kept as written, so the `.form` and the grid answer with `"16:9"` and not with `1.7778`. Settable while the program runs, which is when a stream's shape arrives |

**What it is for is not the picture but the rectangle the picture occupies.**
`Picture` and `Video` already letterbox inside themselves with
`Fit: "Contain"` — what they cannot do is tell anything else *where* the image
ended up, so a caption in the corner of a 16:9 stream lands out on the black.
Put the picture in here and an `Overlay` over it, and `HAlign`/`VAlign` mean the
image's corners:

```json
{ "type": "AspectFrame", "name": "Tile", "properties": { "Ratio": "16:9", "Expand": true },
  "children": [
    { "type": "Overlay", "name": "Stage", "children": [
      { "type": "Video", "name": "Vid" },
      { "type": "Panel", "name": "NameChip",
        "properties": { "HAlign": "Start", "VAlign": "End", "Style": "osd" } } ] } ] }
```

**Its minimum is its child's**, which is what makes it usable in a wall of them:
a frame over a child that asks for nothing asks for nothing, so twenty tiles are
not twenty floors under the window. Measured: a child requesting 200x100 under
`Ratio: "16:9"` gives the frame a minimum of 200x113 — the child's own on one
axis and the proportion on the other — and a child requesting nothing gives 0x0.

`Placement` is `Single`: there is no coordinate to give the child and no order to
put it in, so a second `Add` is refused rather than silently replacing the first.

## Popover

A surface that floats over a control instead of taking room in the layout: the
list of suggestions under a field, the rows a button drops, a small form that
belongs to whatever it points at.

| Member | |
|---|---|
| `Position` | `Top`, `Bottom`, `Left` or `Right`: the side of the anchor it **prefers**, and GTK moves it when there is no room there. Default `"Bottom"` |
| `Arrow` | draw the tail pointing back at the control. Default `false`, unlike GTK's own — a menu wants the tail and a list of suggestions flush against a field does not |
| `Autohide` | `true` by default: a click outside or Escape closes it, and `Close` is raised |
| `Visible` (ro) | the answer to *is it open* — and **read-only**, because it is a state and not a declaration. **Read-only**: opening has a verb, and this is the question half |
| `Popup(anchor, [rect])` | opens it over that control — or, with `rect` (`{ X, Y, Width, Height }` in the anchor's own coordinates), pointed at that rectangle inside it, which is how a hint sits beside an editor's cursor (`Editor.CursorBounds()`). A field that is not a number is refused. The anchor **and the container the popover is in** must be on screen — a hidden panel, a collapsed `Expander` or a page not shown is refused with a sentence. The point is taken once: an anchor that moves, scrolls or is deleted afterwards leaves the popover where it opened. The anchor must have been laid out and the window must be up, because the popup is positioned against the anchor's rectangle. |
| `Close()` | closes it, and does nothing when it is already closed |
| `Show()` | refuses and names `Popup(anchor)`; the inherited one would build a popup surface before the window exists. The inherited verb would show a surface with nothing to point at |
| **event** `Open()` | it came up — `Popup()`, or anything else that showed it |
| **event** `Close()` | it went down: `Close()`, autohide, or the window going with it. **Not** when the popover itself is deleted or taken out while open — its handlers are unhooked before GTK takes it down |

It is a child of a container like almost any other — the `.form` draws it beside what it
belongs to, the loader adopts it, `Children` reaches its content and `Clear()`
empties it — and it contributes **no measure**: a box holding a button and a
popover as tall as a paragraph still asks for the button's 34 pixels, closed and
open. What decides where it appears is `Popup`, not the slot, so a `Fixed`
surface does not give it a rectangle and a box does not stretch it. `Placement`
is `Single` for the same reason an `AspectFrame`'s is: one child, one place, and
a gesture there is *land*.

**It goes on a surface, a `Grid`, a `Flow` or a `RowList`, and nowhere else.** A
`Split`, an `AspectFrame`, a `Notebook` or `Switcher` page, an `Overlay` and
another `Popover` allocate their children themselves rather than through a
layout, and GTK presents a popover only from a layout: opening one there was
`pixman_region32_init_rect: Invalid rectangle`. `Add` refuses it and names the
fix, which is a `Panel` in between. A `Default`/`Cancel` button inside a popover
is found like one anywhere else in the form.

```js
/* A field that drops a list of matches. */
Txt_Change() { this.Sug.Popup(this.Txt); }
Txt_KeyPress(key) {
    if (key === "Escape") { this.Sug.Close(); return true; }
    return false;
}
Lst_Activate() { this.Txt.Text = this.Lst.Text; this.Sug.Close(); }
```

**`Visible` is the open state and not a design property**, which is the one
place a class takes a property away from `Widget`: the loader assigns what a
`.form` declares while the window is still being built, and
`gtk_widget_set_visible(TRUE)` on a popover with no toplevel is a crash inside
GTK — measured, not a warning. So `Widget.Member("Popover", "Visible")` answers
`ReadOnly`, a `.form` that declares it is refused, the property grid does not
offer it and the serialiser never writes it. **A closed popover is not a Tab
stop** either: GTK leaves the surface's focus child pointing at it, so the walk
that started there found nothing left, and `FocusNext()` answered `false` on a
panel full of controls until it was left out.

## Split

Two children with a draggable divider.

| Member | |
|---|---|
| `Arrangement` | `Horizontal` puts them side by side, `Vertical` one over the other. **There is no `Fixed`**: two halves have an axis and nowhere to put a coordinate, which is why this property shadows [`Container`](../reference/widgets/Container.md#the-two-layout-models)'s. Default `"Horizontal"` |
| `Grows` | `Both` (the default), `Start`, `End` or `Neither` — which half takes the room when the split itself grows or shrinks |
| `Position` | where it sits, in pixels from the start of the axis. Assigning moves it; reading gives where it is now, including after the user has dragged it |
| `WideHandle` | a fat divider. Easier to grab, and the right answer when the two halves have no visible edge of their own |

## Notebook

Pages in tabs. Its `children` **are** its pages.

| Member | |
|---|---|
| `Current` | which page is showing, `-1` when there are none. Assigning it switches, and **raises `Switch`**. Default `-1` |
| `Strip` | where the tabs are: `Top` `Bottom` `Start` `End`, or `None` for no strip at all — which is a notebook only code switches, and a [`Switcher`](../reference/widgets/Switcher.md) is usually the better answer. Default `"Top"` |
| `Tabs` | the labels, as an array of strings. **Translated** |
| `Count` (ro) | how many pages there are. **An action widget in the strip is not one** |
| `Append(child, [label])` | one more page, at the end. The child **is** the page — usually a [`Panel`](../reference/widgets/Panel.md), which is then an ordinary container. **`label` is a widget too** (a [`Label`](../reference/widgets/Label.md)), not text: a tab has room for one, where a [`Switcher`](../reference/widgets/Switcher.md)'s page name is a string. A tab label that has to change is a `Label` you keep and mutate |
| `GetAction(where)` | the widget in that end of the strip, or `null` |
| `RemovePage(index)` | takes that page out, and the control in it goes with it |
| `SetAction(control, [where])` | puts a widget **in the tab strip** instead of making it a page. `where` is `Start` or `End`; `null` takes it out. In a `.form` this is a child carrying `"strip": "End"` |
| `SetTabLabel(index, label)` | renames one, and **`label` is a widget** like `Append`'s — what a tab showing a file name and an asterisk needs |
| **event** `Switch(index)` | a different page is showing — chosen by the user or assigned |
| **event** `Reordered(page, index)` | the pages changed order — a tab dragged along the strip, or `Reorder(page, index)` from code, and **both arrive here**. `index` is where the page landed, which is the half a caller keeping its own list of pages needs |

## Switcher

Pages picked from a strip of linked buttons.

| Member | |
|---|---|
| `Current` | which page is showing. Assigning it switches, and **raises `Switch`**. Default `-1` |
| `Strip` | `Top` `Bottom` `Start` `End` `None` — `None` is a bare stack only code switches. Default `"Top"` |
| `Tabs` | the labels, as strings. **Translated**. A segmented control has nowhere to put a widget, so this is the whole of it |
| `Count` (ro) | how many there are |
| `Append(child, [name])` | one more page. The child is the page, and `name` is a **string** — a segmented control has nowhere for a widget, where a [`Notebook`](../reference/widgets/Notebook.md)'s tab label is one |
| `RemovePage(index)` | takes it out, with the control in it |
| **event** `Switch(index)` | a different page is showing |

---

# Form and Component

## Form

The window. See [forms.md](forms.md#form-the-window) for the behaviour a table cannot state.

| Member | |
|---|---|
| `FullScreen` | the same, for the whole screen |
| `HideOnClose` | put away instead of taken apart. **A closed form's window is destroyed**, so `Show()` on it is not a window either — it stays 0×0. Declare this, or construct the form again |
| `Icon` | the window's icon, for a task list or a dock. A name the theme lacks is not shown but **is kept**, so a `.form` round-trips |
| `Maximized` | a **state**: reads `false` until there is a window; set before `Show()` it applies when the window appears. **Keep it out of the `.form`** |
| `Modal` | blocks its parent. Made transient for the active window on `Show()` |
| `Resizable` | bounds the **user**, not the layout: the contents still drive the size, so a longer translation still opens it wider. Default `true` |
| `Text` | the window title. **Translated**. `Caption` is an alias |
| `DefaultButton` (ro) | the button Enter presses, resolved from whichever declared `Default`. **`null` inside `Form_Open`** — it is settled after that handler |
| `CancelButton` (ro) | the button Escape presses, likewise |
| `Center()` | **a no-op on Wayland**: the compositor places windows. [`Screen`](library.md#screen) answers how big the desktop is, which is a different question from where a window goes |
| `Close()` | closes it, through `Form_Close`, which may refuse. The runtime's claim on the form ends here, and on `HideOnClose` when it is put away |
| `Minimize()` | a verb because there is nothing to read back — GTK reports nothing about a minimised window |
| `Show()` | presents the window, and fires `Open` **before returning** the first time. **The runtime holds the form while its window is open**, so `new AskForm().Show()` needs no reference kept anywhere |
| **event** `Open()` | the first time it is shown, **before `Show()` returns**. Where a form fills itself in |
| **event** `Close()` | it is closing. **Returning `true` keeps it open** — which is where *save before closing?* lives. **Returning `true` keeps it open**; returning nothing lets it go |
| **event** `Resize(width, height)` | the size GTK settled on — the same numbers `Bounds()` gives. Fires when the window is first given a size too |
| **event** `ThemeChange()` | the desktop changed the theme. [`Dark`](../reference/widgets/Widget.md#how-it-looks) read inside the handler is already the new answer; **it may fire twice for one change**, so a handler re-reads and restyles rather than counting |

### And on a `Form`

| Member | |
|---|---|
| `Controls` (ro) | every child bound to the form by name, in creation order. `Children` is the containment tree instead, one level deep |
| `Menus` (ro) | the menu spec as declared. It cannot be read back from GTK, which is why the spec is kept; `[]` when there are none |
| `Serialize()` | the whole file, keyed by class |
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
  reasoning is in [widgets.md](../widgets.md#known-limitations).
- **A blocking `MsgBox`** — a question is a form.
- **A list of check boxes** (`CheckedListBox`, a `Checked(row)` the list keeps) —
  a [`RowList`](#rowlist) whose rows carry a `CheckButton`, and **the ticks live
  in your data**. That last half is the whole argument and not a workaround: a
  check the *list* keeps is state in the view, and the moment rows are recycled
  or refiltered it is the wrong row's tick — which is the single most common bug
  in every toolkit that offers one. Keep a `Set` of what is on, show it when you
  build the row, and update it in the button's `Click`. Then filtering, sorting
  and rebuilding cannot lie. [`examples/todo`](../../examples/todo) is the shape
  at its smallest.
