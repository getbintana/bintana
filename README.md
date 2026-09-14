# Bintana

A RAD environment in the spirit of Visual Basic and Gambas: forms laid out by
absolute coordinates, one class per form, and handlers that wire themselves up
by name. The engine is **QuickJS** embedded in a **GTK4** runtime written in C.

The language is plain modern JavaScript. What is VB-like is the *model* — forms,
controls, `Control_Event` methods, no imports, no build step for the code.

**The IDE is written in Bintana and runs on this runtime.** That is the rule of
the project: the IDE has no privileges and no special API. When it needs
something the runtime lacks, what gets added is a runtime feature that every
application then has.

```sh
cmake -S . -B build && cmake --build build -j

./build/bintana examples/hello        # an application
./build/bintana ide examples/hello    # the IDE, opening a project
./build/bintana --debug examples/hello   # ...and the same program stopped for a
                                  # debugger: events out on descriptor 3, commands
                                  # in on stdin. The IDE is what speaks it

LANGUAGE=es ./build/bintana examples/hello    # ...in Spanish, from examples/hello/po/es.po
LANGUAGE=es ./build/bintana ide examples/hello    # the IDE itself, from ide/po/es.po
./build/bintana examples/i18n         # what translation does to a layout, measured
./build/bintana examples/table        # TableView: rows it holds, and 100 000 it does not
./build/bintana examples/viewer       # Picture: fit against zoom, and a folder of images
./build/bintana examples/viewer ~/Pictures    # ...on a folder of your own
./build/bintana examples/files        # RowList: a directory filtered without rebuilding a row
./build/bintana examples/calculator   # Decimal: 0,1 + 0,2 is 0,3, and (10/3)*3 is 10. Keypad works
./build/bintana examples/contacts     # Locale.Compare: Ñanculeo between Núñez and Ortiz, and ver finds Echeverría
./build/bintana examples/agenda       # Day: a calendar date is not an instant. A day at a time
./build/bintana examples/quote        # Record + Decimal: the shape declared once, and the cents add up
./build/bintana examples/clients      # Database.Sqlite + Table: a screen over a table, and its orders
./build/bintana examples/stopwatch    # Stopwatch: the clock that only goes forward, and ticks that do not count
./build/bintana examples/usage        # Exec: a long child streaming, and a Stop that means it
./build/bintana examples/usage ~/     # ...on a folder of your own
./build/bintana examples/notes        # A folder of notes: the file name is the title, and it saves itself
./build/bintana examples/drawing     # DrawingArea: a sparkline, a gauge and a pie — and what a frame really costs
./build/bintana examples/charts      # Charts from lib/charts: five shapes, two axes, and 21 600 readings you can zoom into
./build/bintana examples/report      # Report from lib/report: the Crystal Reports bands, grouped and totalled, out as one PDF
./build/bintana examples/markdown    # Markdown from lib/markdown: a document drawn at a readable measure, its headings beside it, out as one PDF
./build/bintana examples/video       # Video + AudioPlayer: clips from lorem.video, a live HLS stream, and an audio-only cue
./build/bintana examples/notify      # Overlay: a message over the content, and a spinner over the work
./build/bintana examples/jokes       # Http on a window: async, and a Stop that means it
./build/bintana examples/http        # Http from the console: the blocking spelling, against a public API
./build/bintana examples/session     # Http with cookies and Basic auth: a login the next request remembers
./build/bintana examples/serve       # Http.Server: a static file server on :8080. Runs until Ctrl-C
LANGUAGE=es ./build/bintana examples/agenda   # ...and the long date the catalogue rewrites
./tests/run.sh                   # 5561 assertions in 5 projects, on a virtual display
HEADLESS= ./tests/run.sh          # the same, on *your* screen -- empty, not 0. Three
                                  # windows and the keyboard for a minute, and a couple
                                  # of assertions measure your theme and not the one
                                  # the numbers were written against
sudo cmake --install build        # ...or install it: see below
./tests/install.sh                # what that would produce, tried without installing it
```

Dependencies: `gtk4`, `gtksourceview-5` (with headers), `gio-unix-2.0` (part of
glib, and already there wherever gtk4 is) and pkg-config. QuickJS is
vendored in `vendor/quickjs` (quickjs-ng v0.16.1), with three patches of our own
in it -- see [AGENTS.md](AGENTS.md).

Five more are **optional**, and CMake says what it found either way. `libsystemd` only
adds `Logger.Target = "Journal"`; without it the build is the same and logging
goes to the terminal. `libsoup-3.0` is what `Http` speaks, `sqlite3` is what
`Database.Sqlite` opens, and `gstreamer-1.0` is what `Video` and `AudioPlayer`
play through; without each, the build is the same and the thing itself says
which package is missing when it is called. `vte-2.91-gtk4` is the pty behind
`Terminal` and is optional too — the class is still there, still draws and still
loads out of a `.form`, and only `Run`, `Stop` and `Kill` refuse;
`Widget.Available("Terminal")` is what a program asks first. It is the only
dependency with no Windows port, which is why it stopped being required.
Everything needs an X or Wayland display; there is no headless mode.

This file is the overview and the quick reference. The technical documentation —
how the runtime is built, the formats in detail, per-widget semantics, how to
extend either side, how the IDE works — is in [`docs/`](docs/README.md).

**Writing an application, and nothing else, is [`docs/llm/`](docs/llm/README.md):**
the language, the forms, every control, every global, how to validate what you
wrote without a screen, and how to report what the runtime is missing. It is
self-contained and says nothing about the runtime's internals, which is what
makes it the thing to hand to somebody — or something — that has to write an
application and has not read the rest.

## Installing

```sh
cmake -S . -B build -DCMAKE_INSTALL_PREFIX=/usr/local
cmake --build build -j
sudo cmake --install build          # or: sudo make -C build install
```

That puts the runtime in `<prefix>/bin/bintana`, the IDE in
`<prefix>/share/bintana/ide`, the examples beside it, and two files that turn
the pair into an application: a `bintana-ide` launcher and a menu entry. Afterwards:

```sh
bintana-ide                          # the IDE, from the menu or from a shell
bintana-ide ~/my-project             # ...opening a project
bintana /usr/local/share/bintana/examples/hello   # any project, installed or not
```

**The IDE is installed as the project directory it is**, not as a bundle:
`bintana-ide` is a one-line script that hands `bintana` the path to
`share/bintana/ide` — the same command anybody runs by hand, under a name a
menu entry can carry. Nothing about an installed IDE differs from the one in
this repository, which is what keeps there from being two of them.

The installed examples are read-only like everything else under a prefix; copy
one somewhere of your own before opening it in the IDE to edit.

`./tests/install.sh` does the whole of this into a staging directory under
`/tmp` and starts the installed IDE on a display of its own, so the question
*would an install work* has an answer that does not involve installing anything.

---

## 1. Writing an application

A project is three kinds of file in one directory:

```
hello/
  project.json     which class to open, and in which order to load the code
  app.css          what the application looks like (optional; see §6)
  Form1.form       the widget tree (JSON)
  Form1.js         behaviour only
```

`Form1.js`:

```js
class Form1 extends Form {

    Form_Open() {
        this.TextBox1.SetFocus();
    }

    Button1_Click() {
        this.ListBox1.Add(`Hello ${this.TextBox1.Text}!`);
    }
}
```

No `import`, no `addEventListener`, no `main`. A method named
`<Control>_<Event>` is connected on its own. The form's own events dispatch as
`Form_Open` / `Form_Close`, whatever the class is called.

Every class declared at the top level of any `.js` in the project is visible
from the others without importing it — the runtime resolves them in the global
lexical scope. A class can also live in a namespace (see below), which is what
lets two folders each have a `Stepper`.

### The language

Modern JavaScript, minus what this kind of program never uses. `Promise`,
`Proxy`, `Reflect`, typed arrays and `WeakRef` are not installed; `eval`,
`Function`, `globalThis`, `Symbol`, `setTimeout` / `setInterval` and the
reflection under `Object` (`defineProperty`, `getPrototypeOf`, `create`,
`__proto__` …) are
removed once the runtime has booted, along with the generator-function
constructor that compiled strings by another road.

`JSON`, `RegExp`, `Map`/`Set`, `Date`, `Object.keys`, classes, generators and
everything else stay. A dictionary is read with `for...in` — safe here, since
nothing can manipulate a prototype any more — and a bag of properties is applied
to a control with `widget.Apply({…})`, the inverse of `Serialize()`. A property
is declared with `get` / `set`, which is also how the designer finds it. This is a smaller language to learn, not a sandbox: a
project still holds every capability the runtime gave it.

Where a raw primitive and a Bintana way of doing the same thing both exist, the
Bintana one is what you write: `File.LoadJson` / `File.SaveJson` instead of
`JSON.parse(File.Load(...))`, `Timer.After` / `Timer.Every` instead of
`setTimeout` / `setInterval` (which are removed), `Logger.Info` / `Logger.Error`
instead of `console`, `Application.CheckSource` instead of `new Function`, and a
`Record` (§7) instead of a bag of keys nobody checks. The IDE uses them
throughout, which is how we know they are enough: **not one file in it is read or
written through `JSON.parse`/`JSON.stringify`** — fifteen `File.LoadJson` /
`File.SaveJson` calls instead — and what is left of raw `JSON` there is a deep
copy, a few comparisons and one string literal.

### project.json

```json
{
  "name": "Hello",
  "version": "1.0",
  "startup": "Form1",
  "sources": ["Util.js", "Form1.js"],
  "description": "optional, free text"
}
```

`version` is free text and optional — `Application.Version` reads it back, and a
project that declares none answers `""`. It is the *application's* version, not
the runtime's: that one is `BTA_VERSION`, and confusing the two is what an About
box does until there is a field to read.

`startup` is the class instantiated and shown at launch. `sources` fixes the
load order and is only needed when one class extends another of the same
project; without it every `.js` under the project is loaded — subdirectories
included — sorted by path.

Files may be organised in folders (`"sources": ["Widgets/Stepper.js"]`), and the
runtime finds a class's `.form` anywhere in the tree.

`uses` is the other half of that: **a library of shared classes**, named rather
than copied.

```json
{ "startup": "MainForm", "uses": ["charts"] }
```

A library is a directory of `.js` and `.form` files whose sources load before the
project's own and whose forms are indexed with them, so a `.form` can say
`"type": "Chart"` about a class the project does not contain. It may also carry a
`po/` catalogue and an `icons/` directory of its own — read before and after the
project's respectively, so the project always has the last word — and a
`project.json` whose `sources` orders its own files, which is what a library whose
classes extend each other needs. It is looked for in the project's own `lib/`, in `$BINTANA_LIB_PATH`, in
`~/.local/share/bintana/lib`, and then **one hop from the runtime's own
binary** — `../lib` in the source tree, `../share/bintana/lib` installed, which
is the same hop because `bin/` and `share/bintana/` move together. A name that
is not there stops the program and prints every place it looked. Three libraries
ship here — `charts` (a `Chart` component in five shapes, documented in
[docs/llm/charts.md](docs/llm/charts.md)), `report` (a banded `Report`
component, documented in [docs/llm/report.md](docs/llm/report.md)) and
`markdown` (a `Markdown` document viewer, documented in
[docs/llm/markdown.md](docs/llm/markdown.md)) — and
[`examples/charts`](examples/charts), [`examples/report`](examples/report) and
[`examples/markdown`](examples/markdown)
are the projects that use them; the full list of
places and the reasons are in
[docs/formats.md](docs/formats.md#libraries-uses).

### Namespaces

A folder of classes can live under one name:

```js
/* Widgets/Stepper.js */
Namespace("Widgets");

Widgets.Stepper = class Stepper extends Component { ... };
```

```json
{ "type": "Widgets.Stepper", "name": "Step1" }
```

A namespace is an ordinary object on `globalThis` — no imports, no compile step —
and it is what lets two folders each have a `Stepper`. Without one, a class name is
global and has to be unique in the project.

**A namespace is declared by the code, and a folder's name is never one.** The
runtime resolves `Widgets.Stepper` from the `Namespace("Widgets")` above and from
nothing else, and the IDE reads it the same way. What the IDE offers when you
create a class in a folder is **the namespace the classes already there are in** —
read from their code, so a batch written together stays consistent — and the first
class of a namespace is told which one, because that is a decision and not a side
effect of `mkdir`. Moving a file between folders changes no name at all.

That rule replaced one where a folder *did* spell a namespace, and the reason is
worth keeping: it needed an exception for every folder a tool had named
(`forms/`, `components/`, `modules/`, `po/`, and `lib/` once libraries arrived),
and it made a file move rename a class and rewrite every `.form` that placed it.
Two folders feeding one namespace — which is what namespaces are *for* — could
not be expressed at all.

The IDE is written this way itself: the twenty classes in `ide/modules/` are
`Ide.Designer`, `Ide.TabSet`, `Ide.Classes` and so on — `Ide` because their code
says so, and not `Modules.*` because no folder ever names one.

### The .form format

Pure JSON. The loader **knows no control in particular**: it applies each entry
of `properties` as an ordinary JavaScript assignment, so it goes through the
widget's real setter.

```json
{
  "format": "bintana-form/1",
  "class": "Form1",
  "properties": { "Text": "Hello Bintana", "Width": 420, "Height": 260 },
  "menus": [ ... ],
  "children": [
    { "type": "Button", "name": "Button1",
      "properties": { "X": 20, "Y": 96, "Width": 120, "Height": 36, "Text": "Greet" } }
  ]
}
```

Containers carry their own `children`. A child of a `Notebook` may carry
`"strip": "Start" | "End"`, which puts it in the **tab strip** instead of making
it a page — the one place a child says where it goes and not just what it is,
because a notebook's children are its pages by definition. A form with no
`.form` is legal: it is built from code.

---

## 2. How it is implemented

**One runtime, two halves.** `runtime/src/*.c` is the GTK4 side; `runtime/js/rad.js`
is baked into the binary and evaluated once at startup, and holds everything
expressible in JS (serialisation, `Caption` aliases, `Controls`).

**All widget classes share one `JSClassID`.** What makes a `Button` a `Button` is
its prototype, not its native class. The hierarchy lives in the prototype chain,
assembled from a table each module contributes rows to:

```
Widget ├── Control ── Label, Button, Image, TextBox, CheckButton,
       │              ToggleButton, Switch, ListBox, ComboBox, SpinBox, Slider,
       │              ProgressBar, DatePicker, Calendar, ColorButton,
       │              FontButton, TreeView, TableView, Terminal,
       │              Editor ── TextEditor, SourceEditor,
       │              DrawingArea, Video
       └── Container ── Form, Panel, Grid, Frame, Split, Notebook, Switcher,
                        Overlay, AspectFrame, RowList, Scroller, Flow
```

Each JS object carries a `BtaWidget` in its opaque slot: `gtk` is what the parent
lays out, `inner` the control proper (they differ when something is wrapped in a
scroller), `slot` is where a container's children go.

**Events dispatch by name.** `bta_emit(w, "Click", ...)` looks up
`<name>_Click` on the widget's form and calls it. Nothing is registered; a
handler added to the class at any time is found the next time the event fires.

**The serialiser is the exact inverse of the loader.** It discovers what to save
by walking the prototype chain for accessors that have **both** a getter and a
setter, and omits anything equal to a freshly constructed control's value. This
is the invariant the whole thing rests on:

> Add a property to a widget in C and it becomes designable, serialisable and
> editable, with no other change anywhere.

A read-only accessor is excluded automatically, because the loader could never
assign it back. A property that only accepts certain values declares them next
to itself in C, and `PropertyOptions()` hands the list to whoever is editing it —
which is how the designer offers a drop-down for `Alignment` without ever having
heard of `Alignment`.

---

## 3. Widget reference

### Widget — inherited by everything

| | |
|---|---|
| Geometry | `X`, `Y`, `Width`, `Height`, `Move(x,y)`, `Resize(w,h)` |
| State | `Name`, `Visible`, `Enabled`, `Focusable`, `Focused` (ro), `Tooltip`, `Show()`, `Hide()`, `SetFocus()` |
| Layout | `Margin`, `Expand`, `HExpand`, `VExpand`, `ColumnSpan` (in a `Grid`), `TabIndex` (on a surface) |
| Where it sits | `HAlign`, `VAlign` (`Auto`/`Start`/`End`/`Center`/`Fill`), `MinWidth`, `MinHeight` |
| Appearance | `Style` — the classes it wears (`"danger"`, `"card title"`); see §6 |
| Colour | `Background`, `Foreground` (any CSS colour; `""` restores the theme) — the exception to `Style` |
| Font | `Font` (a Pango description, `"Cantarell Bold 12"`; `""` restores the theme) — likewise |
| Tree | `Delete()`, `Remove()` (detach without destroying), `Raise()`, `Lower()` |
| Drag and drop | `DragData`, `AcceptDrop`, `AcceptFiles` (see §5) |
| Context menu | `Menu`, `PopupMenu(x,y)` (see §4) |
| Introspection | `PropertyNames()`, `PropertyOptions(name)`, `TextProperties()`, `EventNames()`, `Serialize()`, `Apply(props)`, `Dump()` |
| Text as a resource | `Declared(name)`, `Fill(...args)`, `SetDesign(name, value)`, `DesignValue(name)` — see §7 |
| Measuring | `OriginIn(container)` → `[x, y]`; `Bounds([container])` → `{ X, Y, Width, Height }`, what GTK actually allocated |

`EventNames()` is the list of events a control raises, **most derived first** — a
Button answers `["Click", "MouseDown", …]`. Declared next to the class in C, so a
control added there is one the designer can write a handler for with nothing else
changed. The head is the one a double click writes. A class of the project
declares its own with `static Events`, and it is read at that class's step of the
same walk, so the ordering holds through a component that extends a component
(see §3).

Events on every widget: `MouseDown(x,y,button,ctrl,shift)`, `MouseMove(...)`,
`MouseUp(...)`, `MouseEnter(x,y)`, `MouseLeave()`, `MouseWheel(dx,dy)`,
`DblClick(x,y,button,ctrl,shift)`, `KeyPress(key,ctrl,shift,alt)`,
`KeyRelease(...)`, `Drop(data,x,y)`, `FileDrop(paths,x,y)`, `GotFocus()`, `LostFocus()`.

`MouseEnter`/`MouseLeave` are the question motion cannot answer: there is no
`MouseMove` for having left. Returning `true` from `MouseWheel` consumes the
scroll, which is how a control that reacts to the wheel stops the scroller around
it from also moving.

`GotFocus`/`LostFocus` are how "when the user is done with this box" is said —
checking what was typed belongs there, and `Activate` (Enter) is only the other
half of the answer. Both answer for the **control**: a `TextBox`'s focus really
sits on the `GtkText` inside its entry and an editor's on the view inside its
scroller, so `Focused` reports the focus being *within* it, which is the question
a form is asking.

Coordinates are relative to the widget itself. Returning `true` from `KeyPress`
**consumes** the key — without that, the arrows would move the focus instead of
the selected control.

**A control that handles a key keeps it, and that makes the two key events
asymmetric.** These are attached in the bubble phase so what has the focus gets
first refusal, and a `TextBox` claims the press of a printable key because that
press *is* the typing; it has no use for the release and does not claim it. So on
a text box `b` arrives as `KeyRelease` and never as `KeyPress`, while `F5` and
`Escape` — which the entry does not want — arrive as both. Pair the two halves of
a key only on a widget that does not edit text; to watch typing, use `Change`.

`Width`/`Height` are a size *request*, i.e. a minimum: a control whose natural
size exceeds it renders larger. `Bounds()` is the other side of that — the box
GTK really gave, in window coordinates, or in a container's if one is passed.
`Dump()` prints the whole subtree with those numbers, which is what to reach for
before reaching for a screenshot.

### Controls

| Class | Properties and methods | Events |
|---|---|---|
| `Label` | `Text`, `Alignment` (`Left`/`Center`/`Right`), `Wrap` | — |
| `Button` | `Text`, `Icon`, `Default`, `Cancel`, `Click()` — `Default` is what Enter presses on its form, `Cancel` what Escape does | `Click` |
| `Image` | a picture: `Icon` (a theme name) or `File` (a path) — one at a time — and `Size` in pixels | — |
| `Separator` | a rule: `Orientation` (`Horizontal`/`Vertical`), and nothing else | — |
| `TextBox` | `Text`, `Icon` (inside the field, clickable), `ReadOnly`, `Password`, `ActivatesDefault` (Enter presses the form's default button *instead of* raising `Activate`) | `Change`, `Activate`, `IconClick` |
| `CheckButton` | `Text`, `Active`, `Group` — a box one ticks, or one of a named set (see below) | `Click` |
| `Switch` | `Active` — a `CheckButton` drawn as a setting that takes effect at once; no caption, the words beside it are a `Label` | `Click` |
| `ToggleButton` | `Text`, `Icon`, `Active`, `Click()` — a button that stays in | `Click` |
| `Picture` | `File`, `Fit`, `Zoom`, `SourceWidth`/`SourceHeight` (ro) — a photograph, which is not an icon | — |
| `Spinner` | `Active` — work with no end in sight, which is most work | — |
| `LinkButton` | `Text`, `Uri` — an address, handed to the desktop | `Click` |
| `LevelBar` | `Value`, `Min`, `Max`, `Mode`, `Orientation` — a reading, not a progress | — |
| `ListBox` | `Items`, `Index`, `Text` (ro), `Count` (ro), `MultiSelect`, `Selection` (ro), `Add`, `Remove`, `Clear`, `Select(i)`, `Deselect(i)`, `SelectAll()`, `DeselectAll()` | `Select` |
| `ComboBox` | `Items`, `Index`, `Text`, `Count` (ro), `Add`, `Clear` | `Select` |
| `SpinBox` | `Value`, `Min`, `Max`, `Step`, `Decimals` | `Change`, `Activate` |
| `Slider` | `Value`, `Min`, `Max`, `Step`, `ShowValue`, `Orientation` — the same four words a `SpinBox` uses, asked with the mouse | `Change` |
| `ProgressBar` | `Value` (0 to 100), `Text`, `ShowText`, `Orientation`, `Pulse()` | — |
| `DatePicker` | `Value` (`"2026-08-11"`), `Format` (what the button reads) — a date on one line, with a calendar in its popover | `Change` |
| `Calendar` | `Value`, `Marks` (ro), `Mark(date)`, `Unmark(date)`, `ClearMarks()`, `ShowHeading`, `ShowDayNames`, `ShowWeekNumbers` — the month itself, with the days that matter marked on it | `Change` |
| `ColorButton` | `Value` (a CSS colour, `""` for none) — a swatch that opens the desktop's chooser, with a clear beside it | `Change` |
| `FontButton` | `Value` (a Pango description, `""` for none) — the font shown in itself, with a clear beside it | `Change` |
| `TreeView` | `Key`, `Text` (ro), `Count` (ro), `AutoExpand`, `Add(key,text,parentKey,icon)`, `Exists(key)`, `Remove(key)` (with its subtree), `SetText(key,text)`, `SetIcon(key,name)`, `ExpandNode(key)`, `CollapseNode(key)`, `Expanded(key)`, `ExpandAll`, `CollapseAll`, `Clear` | `Select`, `Activate` |
| `TableView` | a list with columns, **and its rows may nest**: `Columns`, `Count` (settable: see below), `Index`, `Selection` (ro), `MultiSelect`, `Sortable`, `RowLines`, `ColumnLines`, `Add(values,[{Key,Parent}])`, `Row(i)`, `Cell(row,col)`, `SetCell(row,col,value)`, `SetIcon(row,col,name)`, `Select(i)`, `Deselect(i)`, `SelectAll`, `DeselectAll`, `SortBy(col,asc)`, `SortColumn(col,asc)`, `Remove(i)`, `Clear`; as a tree: `Key`, `AutoExpand`, `Exists(key)`, `ExpandNode(key)`, `CollapseNode(key)`, `Expanded(key)`, `ExpandAll`, `CollapseAll` | `Select`, `Activate`, `Data`, `Sort` |
| `TextEditor` | multi-line plain text: `Text`, `Line` (ro), `Column` (ro), `Selection` (ro), `Modified`, `ReadOnly`, `Wrap`, `CanUndo`/`CanRedo` (ro), `GotoLine`, `Select`, `Insert`, `Append`, `Clear`, `Undo`, `Redo` — a note, a description, a log | `Change`, `Cursor` |
| `SourceEditor` | the same, plus what a source file needs: `Language`, `Theme`, `ShowLineNumbers`, `ShowMarks`, `Completion`, `CompletionTitle`, `Mark`/`Unmark`/`Marks`/`ClearMarks` | `Change`, `Cursor`, `Complete` |
| ...searching (a `SourceEditor`'s) | `Search(text, {CaseSensitive, WholeWord, Regex})` → how many, `Matches` (ro), `MatchIndex` (ro), `FindNext()`, `FindPrevious()`, `Replace(with)`, `ReplaceAll(with)` | |
| `Terminal` | `Available` (ro), `Text` (ro), `Running` (ro), `ScrollbackLines`, `FontScale`, `LinkPattern`, `Run(argv,cwd)`, `Stop()`, `Kill()`, `Feed(text)`, `Clear()` | `Exit(code)`, `Link(text)` |
| `Video` | a clip that plays, in the window: `Uri` (a URI or a plain path), `User`/`Password` (RTSP digest; the secret never reads back), `Latency`, `Volume`, `Muted`, `Loop`, `Fit`, `Position`/`Duration`/`Playing`/`Seekable`/`Buffering`/`SourceWidth`/`SourceHeight` (ro), `Play()`, `Pause()`, `Stop()`, `Seek(s)`, `Save(path)` — sound with no window is `AudioPlayer` (see §7) | `Ended()`, `Error(message, kind)` |
| `DrawingArea` | a surface to draw on: `Redraw()`, `Dump()`, `Save(path,[w],[h])`, `SavePdf(path,w,h,[pages],[before])` — the `Draw` event hands over a `Painter` | `Draw` |

**There are two editors and they are one class apart.** `TextEditor` is a
`GtkTextView` and `SourceEditor` is a `GtkSourceView`, which in GTK is a subclass
of the first — so the buffer, the cursor, the selection, undo and the two events
are declared once on an abstract `Editor` and inherited by both. `Terminal` is VTE
with a real pty; highlighting, undo, colours and interactive input are all the
widget's own doing, and `PropertyOptions("Language")` asks GtkSourceView what it
has, so the list cannot drift from what the setter accepts.

**And a log pane is a `TextEditor`, not a `Terminal`.** `Append` writes at the end
and scrolls there whatever the cursor was doing, and it works with `ReadOnly` on,
which is the whole of what showing a child's output takes. A pty buys typing,
colour and `less`; if none of those is used, it is a dependency paid for nothing.
The IDE's own output pane made that mistake and is a `TextEditor` now.

Which one a form wants is not a close call: **a `TextEditor` is the multi-line
field this widget set went without**, for observations, a note, a description, a
log pane. The alternative was a `TextBox`, which is one line and whose `GtkEntry`
cannot hold a newline at all, or the source editor with its languages turned off
— and that is what the IDE itself did, in three lines of apology in its
translation editor:

```js
box.Language        = "";          /* prose, not source */
box.ShowLineNumbers = false;
box.Wrap            = true;
```

Those three lines are gone. A `TextEditor` arrives wrapping, in the theme's font,
with no gutter and nothing to highlight — and a `SourceEditor` arrives not
wrapping, monospaced, with its gutter, because code that wraps hides its own
indentation. `Wrap` is the same inherited property; what differs is what each
control starts at.

**And `Text` is prose on one and not on the other**, which is why they are
siblings rather than one extending the other: a `.form` may declare a starting
note in a `TextEditor` and have it translated like any caption, while a
`SourceEditor`'s `Text` must never reach a catalogue — see §7. A declaration like
that accumulates *down* a class chain, so a source editor inheriting the plain
one's would put a line of somebody's code in a `.po` file. Two siblings can
disagree about a property; a child cannot disagree with its parent.

**A `TableView` is a list with columns, and its rows may nest.** It is the
control this widget set was missing: `ListBox` is strings, `RowList` is widgets
and `Grid` is a layout, so every program with rows and fields drew them by hand.

**What separates it from `TreeView` is one thing, and GTK decides it**: a
`GtkColumnView` cannot hide its heading row. So a hierarchy *with* headings —
columns, widths, alignment — is a table whose rows nest, and one *without* them
is still a `TreeView`. They are not two spellings of each other.

```json
{ "type": "TableView", "name": "Customers",
  "properties": { "Columns": [ { "Text": "Name",    "Width": 200 },
                               { "Text": "Balance", "Width": 90,
                                 "Alignment": "Right" } ] } }
```

```js
this.Customers.Add(["Ana", "10.50"]);
this.Customers.SetCell(0, 1, "99.99");     // one cell, in place
```

**A row with a `Key` is a node**, and the first one makes the table a tree:

```js
this.Files.Add(["src", "3", "10:32"],       { Key: "/src" });
this.Files.Add(["main.c", "12 KB", "09:41"], { Key: "/src/main.c", Parent: "/src" });

this.Files.ExpandNode("/src");
Files_Select() { this.show(this.Files.Key); }
```

The eight members that come with it — `Key`, `AutoExpand`, `Exists`,
`ExpandNode`, `CollapseNode`, `ExpandAll`, `CollapseAll`, `Expanded` — are
`TreeView`'s words with `TreeView`'s meanings, so there is nothing new to learn
about the second control. **In a tree a row is addressed by its key**, because a
position is a position in the *visible* list and moves when something above it
collapses: `Cell(key, column)`, `Row(key)`, `Remove(key)` — which takes the
subtree with it. A table is flat or a tree, decided by the first row put in it,
and `Clear()` decides again.

**A column is declared, not built.** `Columns` is an ordinary array property, so
it survives in the `.form`, the designer's grid edits it, and the headings go
through the catalogue — which is why a column is an object with a `Text` and not
a bare string: `Width` and `Alignment` belong to the column and must never be
translated. Saying which part is prose is what `texts = "Columns.Text"` does, and
a rule that translated every string in the object would have put `Right` in the
catalogue and let a translator change what a keyword means.

**A table need not hold its data.** `Count = 50000` says how many rows there are
and the table asks `Data(row, column)` for each cell it draws — which is a few
dozen calls a scroll, not fifty thousand. The handler's **return value** is the
answer, a string or `{ Text, Icon }`:

```js
Big_Data(row, col) {
    return col === 0 ? this.names[row] : { Text: this.sizes[row], Icon: "folder" };
}
```

That is Gambas' `Data` event and WinForms' `VirtualMode`, and it is the
difference between a table that can be backed by a query and one that cannot.
`Add` and `Count` are the two ways to say what a table holds and setting one
clears the other, the bargain `Image.Icon` and `Image.File` already make. Asking
such a table for a `Row`, a `Cell`, a `SetIcon` or a `SortBy` is refused rather
than answered with nothing: the rows exist, but their values live where the
handler reads them.

**`Sortable` makes the headers clickable, and the table does not reorder
itself.** Clicking one raises `Sort(column, ascending)`; the handler decides,
which is the only rule that can hold for an on-demand table too. When the table
does own its rows that handler is one line:

```js
Customers_Sort(col, up) { this.Customers.SortBy(col, up); }
```

Gambas draws the same line between `Sorted` (the indicator) and `Sort` (who
actually reorders). `SortColumn(col, asc)` is the heading clicked from code — the
arrow moves and `Sort` is raised — which is what restoring a saved sort on
startup wants, and the only way the click can be tested.

`SetIcon(row, col, name)` puts a picture beside a cell's text — a separate call
and not a second kind of value, so `Add(["Ana", "10.50"])` stays the way a row is
written. An icon the theme cannot draw is dropped, as everywhere else.

`Width` is where a column starts and not a cage — every column is draggable, and
`0` means it sizes itself. The last one takes the slack, so a table never ends in
a gap. A row may be shorter than there are columns: a row is data and the columns
are a view of it, so the cells that are not there read as `""` rather than as an
error, and adding a column does not invalidate every row already in the table.

**A `Separator`'s thickness is the line, not the room around it.** It paints its
whole allocation, so one 12 high is a line 12 thick; the space above and below
goes on `Margin`. The natural size of a horizontal rule is one pixel, which also
makes it a small thing to aim at once placed — the control tree and a rubber band
are how it is selected again, as with anything else too small to hit.

**A `DrawingArea` is the one control with no content of its own.** Everything
else here shows something it was given; this one raises `Draw` and whatever the
handler paints is what is on the screen. What it hands over is a `Painter` — a
drawing context with names — and the whole of the vocabulary is paths
(`MoveTo`/`LineTo`/`CurveTo`/`Arc`/`Rectangle`, then `Fill` or `Stroke`), a pen
(`Color`, `LineWidth`, `LineDash`, `LineCap`, `LineJoin`, `Antialias`), text
(`Text`, `TextWidth`, `TextHeight`), a picture (`Image`), the transform
(`Push`/`Pop`, `Translate`, `Scale`, `Rotate`) and a clip:

```js
Plot_Draw(p, width, height) {
    p.LineDash = [2, 3];
    for (const y of this.ticks) { p.MoveTo(40, y); p.LineTo(width - 8, y); }
    p.Stroke();

    p.LineDash = [];
    p.Color    = "#3584e4";
    p.Polyline(this.points);            /* one call, however many points */
    p.Stroke();
}
```

Three things about it are decisions rather than details. **A painter is valid only
inside the `Draw` it came from** and refuses afterwards, because keeping it to
draw from a timer later is a write into memory GTK has freed. **It arrives knowing
the theme's ink** (`Foreground`, and `Dark` for which way round the ground is), so
a drawing is visible on a light desktop and on a dark one without asking — GTK
answers the foreground and nothing else, which is why there is no `Background` and
a drawing leaves the control's own to show through. And **angles are in degrees**,
for `Arc` and `Rotate` both: `p.Rotate(-90)` for an axis label is obviously right
where `-Math.PI / 2` is not.

`Save(path)` runs the same `Draw` against an image surface and writes a PNG —
which is how a chart reaches a report, and how a drawing is asserted in a suite
with no screen. **`SavePdf(path, width, height, [pages], [before])` is that once
per page into one file**, on a vector surface, in points: what a document wants,
and what a report leaves the application as. A `Draw` that throws writes no file
either way. `Dump()` is the other half of that: the last frame as text, one
call per line, so what was drawn can be diffed instead of looked at. What the
surface is made of, what was left out of it and the measurements the API turns on
are in [docs/widgets.md](docs/widgets.md#drawingarea-and-painter); charts are the
client it was built for, and they ship — `lib/charts`, documented in
[docs/llm/charts.md](docs/llm/charts.md).

**A `DatePicker` and a `Calendar` are one control's worth of code apart**, and
which one a form wants is a question of room: a field asking for a birthday has a
line for it, a month is 250 by 220, and an agenda showing which days are taken
needs the month. So the picker keeps its calendar in a popover and the calendar
*is* the widget; the value, the ISO text, the refusals and the `Change` are the
same ones, written once.

**Turning the page is a change of value in both**, which is GTK's doing: it has
one date and no separate notion of the month on screen, so browsing to April moves
the value to April and raises `Change`. It used to raise nothing -- `day-selected`
does not fire on a page turn -- so a picker's value went stale behind the
application's back, with its own button still reading the old month.

What only the month can do is **mark** days — `Mark("2026-03-04")` — and that is
the whole argument for it being a control rather than a popover pinned open.
**A mark is a date, and GTK's is a day of the month**: `gtk_calendar_mark_day`
takes a number from 1 to 31 and puts it on whatever month is on screen, so the
list of dates is kept here and the marks in view are redrawn whenever the page
turns. Marking the 4th of April while March shows draws nothing until April does,
which is measured rather than asserted — three renders of the same form, where the
mark in view changes the picture and the one a month away changes nothing.

**A thing that is on or off has `Active`, not `Value`.** `CheckButton`,
`ToggleButton` and `Switch` are what GTK calls `active`, and the word says in
context what `Value` never did: `if (this.ChkCase.Active)` reads as a question
about a state. `Value` stays where there *is* a value — a `SpinBox`'s number, a
`Slider`'s, a `DatePicker`'s date, a `ColorButton`'s colour. The rule is one
line: **`Active` is whether it is on, `Value` is what it holds.**

**There is one `CheckButton` and no `RadioButton`, because GTK4 has one widget
and no radio.** `GtkRadioButton` was removed: a radio *is* a check button that
belongs to a group, and belonging is what draws it round, makes the set exclusive
and makes a second click leave it on. Two classes over one widget, differing only
in whether a property is set, is a distinction the toolkit stopped making.

**This is not what other RAD tools do** — VB, Delphi and Gambas all ship two
controls — and the honest cost is that a set now has to be **named**: an empty
`Group` is a box one ticks, and a name makes it one of that set. The old class
made a set out of the *container*, which cannot survive one class: with a tick
and a choice being the same widget, "everything in this Panel is one set" would
turn every row of check boxes into a set of choices. The container still scopes
the name, so the same `Group` in two `Panel`s is two sets.

What the two-class version got wrong is the other half of the argument: a
`RadioButton` alone in its container had no group at all, so GTK drew it square
and a second click turned it off. It was a check box in looks *and* in behaviour,
and the first one dropped on a form is exactly when one looks at it.

**Searching is the editor's, not the caller's.** `Search()` says what to look for
and answers how many there are, highlighting every one; it deliberately does not
move the cursor, since typing in a find field and jumping to a match are two
things that happen at different moments. `FindNext`/`FindPrevious` wrap around,
`Replace` acts on the match the cursor is standing on, and the count is worked
out on the spot rather than asked of GtkSourceView, whose own answer arrives
some frames later.

**A `Terminal` can make text in its output clickable.** `LinkPattern` is a regex
(`"[\\w./+-]+\\.js:\\d+"`), and clicking something that matches raises
`Link(text)` — what the text *means* is the application's business. Dragging
across a match selects it as it always did: the click is reported on release, and
only when press and release landed on the same match. There is nothing to
highlight on a build with no VTE, so `Link` never fires there.

The IDE turns a traceback into somewhere to go without any of this now — its
output pane is a `TextEditor`, so a click moves the cursor and `Line`/`Column`
say where it landed (§8).

### Containers

**`Grid`** is rows and columns whose sizes come from what is in them. Children
flow into it in order, wrapping at `Columns`; a column is as wide as its widest
child, a child with `HExpand` takes the slack, and `ColumnSpan` on a child lets a
note or a button row run under several. No new vocabulary — `HAlign`/`HExpand`
mean here what they mean in a box — and it is the answer to a caption that grows
in translation, which a row of coordinates has none.

**`Expander`** is a `Frame` that folds: a caption one presses (`Text`), and
everything under it appears or goes away (`Expanded`, and a `Toggle` event). It
is a container and not a panel hidden from code because the *window* has to
know — folding it takes its height back.

All of them have `Add(widget)`, `Clear()`, `Children` (ro), `Arrangement`,
`Placement` (ro), `Anchored`, `Reorder(child,index)`, `FocusNext()` /
`FocusPrevious()`, plus `PickAt(x,y)`, `ContainerAt(x,y,[ignore])` and
`LocalPoint(x,y,from)` for asking the layout what is where.

`Anchored` is on by default. Off, the children stay exactly where they were
drawn however big the container gets — what a **drawing board** wants as opposed
to a window: the IDE's design canvas is reused for every form opened, so
anchoring it would show each one resized to whoever was drawn on it first.

A `Scroller` is the answer to the other half of that: content whose size is not
its parent's business. The view is as big as the room it is given, the board
inside it is as big as what is on it, and the difference scrolls — which is what
makes the IDE's own 1100-wide window editable in a 520-wide canvas.

`Reorder` moves a child among its siblings: in a box that *is* its position, a
notebook moves the page with its tab, a split has two halves so the index says
which one, and in an `Overlay` the order is the stack — index `0` is the base
layer, the one that fills. A `Fixed` refuses, and it is the only one that does:
there the order is the painting order, which `Raise`/`Lower` already say.

`Placement` is which of those a container does, asked of the runtime rather than
guessed from the class: `Coordinates`, `Order`, `Layers`, `Pages`, `Halves` or
`Single`.
Every container answers, including the six that refuse `Arrangement` — it is what
an editor needs in order to know what a drag means, and the designer asks nothing
else.

| Class | How it places its children |
|---|---|
| `Panel` | absolute coordinates, or a row or a column: `Arrangement`, `Spacing`, `Homogeneous` |
| `Frame` | same as Panel, with a title (`Text`) |

| `Split` | two children with a draggable divider, per `Arrangement`: `Position` |
| `Notebook` | in tabs: `Tabs` (the strip as strings), `Count` (ro), `Current`, `Append(child,[label])`, `Remove(i)`, `SetTabLabel(i,label)`, `SetAction(control,[where])`, event `Switch(index)` |
| `Switcher` | in pages picked from a strip of linked buttons: `Tabs` (the strip as strings), `Strip` (`Top`/`Bottom`/`Start`/`End`/`None` — `None` is a bare stack only code switches), `Count` (ro), `Current`, `Append(child,[name])`, `Remove(i)`, event `Switch(index)` |
| `Overlay` | stacked: the first child fills and the rest float on top, placed by `HAlign`/`VAlign`/`Margin` and layered by the order. `Reorder(child,0)` makes a layer the base; X/Y mean nothing in here |
| `AspectFrame` | one child, given the biggest rectangle of a proportion that fits, centred: `Ratio` (`"16:9"`, or `0` for the child's own). Its minimum is its child's, so a wall of them is not a wall of floors — what it is *for* is giving a picture's rectangle to whatever rides on it |
| `RowList` | one row per child, with scrolling and selection — and the list vocabulary the other three have: `Index`, `Count` (ro), `MultiSelect`, `Selection` (ro), `ActivateOnSingleClick`, `Select(i)`, `Deselect(i)`, `SelectAll`, `DeselectAll`, `Activate([i])`, `Remove(i)`, `Refilter()`; events `Select`, `Activate`, `Filter` |
| `Scroller` | coordinates, with scrollbars: the view is the room there is, the content as big as it needs |
| `Flow` | a gallery: children wrap into as many columns as fit, and it scrolls itself: `Spacing`, `MinPerLine`, `MaxPerLine` |

`Arrangement` (`"Fixed"` / `"Horizontal"` / `"Vertical"`) is the word a container
with a choice to make answers: it chooses between the RAD coordinate model and an
elastic layout, and there is no separate box class because a container arranged as
a row *is* one. Changing it keeps the children, in order, and a `Fixed` container that
becomes a row and goes back gets every coordinate back with it — at any time, with
a container full of controls, which is the one thing anybody wants the property
for. Forms a user draws want `Fixed` — which survives a resize on its own, see
below — and the other two are for a tree built by code, where the sizes are not
known until it runs.

**Not every container has one.** It is the word for a container whose slot is a
surface of ours: `Panel`, `Frame`, `Expander`, `Scroller`, `Form` and a
`Component`. A `Split` overrides it with two values and no `Fixed`, because two
halves have an axis and no coordinates. The rest arrange by their own nature and
**refuse** it, reading `""` — `Grid` is a table, `Flow` wraps, `RowList` is rows,
`Notebook` and `Switcher` are pages, and an `Overlay` is a stack:

```js
Widget.New("Grid").Arrangement = "Vertical";   // TypeError: Grid arranges its
                                               // children by its own nature
```

### The order Tab takes them in

`TabIndex` on each control, and the surface carries it out. Ties go to the order
the children are in, and everything is 0 until something says otherwise — so a
form that declares nothing is walked in the order it was drawn, which is what
every form written before this got.

```json
{ "type": "TextBox", "name": "TxtName",  "properties": { "TabIndex": 1 } },
{ "type": "TextBox", "name": "TxtEmail", "properties": { "TabIndex": 2 } }
```

**There is no `TabStop` beside it, and that is not an omission**: `Focusable`
already is one. A control Tab must skip is a control that cannot take the focus,
which is the same sentence said once.

It is declared per control because GTK4 walks the focus in **child-list order**
and removed GtkContainer's focus chain — and on a surface that list is already
spoken for, since children *paint* in it, which is what `Raise`/`Lower` say. One
list cannot be both orders, which is why VB, Delphi and Gambas all keep ZOrder
and TabIndex apart. What carries it out is the surface's own `focus`, the
supported place for a GTK4 widget to say this, rather than catching the key: a
focused editor or `Terminal` takes Tab for indentation and shell completion
long before GTK asks a container for the next control, so both keep working with
nothing special written for them.

`TabIndex` is **sparse and never renumbered**. VB and Delphi keep a dense
sequence by shuffling every sibling when one is set, which is both the fiddly
part of using them and something this runtime must not do — a control's siblings
are its form's, and on the designer's canvas that form is the IDE.

In a box there is nothing to declare: there the order Tab takes is the order
things are drawn in, exactly as `X`/`Y` mean nothing there either.

`FocusNext()` / `FocusPrevious()` are what Tab does, said from code, and answer
whether the focus moved. On any container, so the walk can be kept inside the
panel holding the fields instead of always crossing the window — a form is a
container, so `this.FocusNext()` in a dialog means what it looks like.

Enter walking to the next field is the case they exist for — the alternative is
naming the next control, which writes the order down a second time in the copy
nobody updates when the form is redrawn.

### Controls that follow the window

A `Fixed` container is not frozen: every control says with `HAlign`/`VAlign` what
becomes of it when the container is not the size the coordinates were written for.

| | on a surface, when the container grows | in a box, split or page |
|---|---|---|
| `Auto` (default) | stays put, as `Start` | fills the cell, as `Fill` |
| `Start` | keeps the distance to the left/top edge — stays put | against the near edge, its own size |
| `End` | keeps the distance to the right/bottom edge — slides | against the far edge, its own size |
| `Fill` | keeps both — stretches | takes the whole cell |
| `Center` | keeps the proportion — moves half the slack | in the middle, its own size |

```json
{ "type": "Button", "name": "Ok",
  "properties": { "X": 300, "Y": 160, "Width": 80, "Height": 30, "Text": "OK",
                  "HAlign": "End", "VAlign": "End" } }
```

An *OK* button that stays in its corner, a `TextBox` that grows with the window,
a dialog whose contents stay centred — without giving up the coordinates that
were drawn. The reference size is the one the container is first given, so
nothing moves until the window really changes.

These are GTK's own four words and they mean the same in a box, so `Fill`
stretches wherever the control lives — a column of buttons with one of them
`Center` is a centred button, no coordinates involved. `Auto` is the fifth,
because the two containers disagree about what *nothing was asked for* means, and
naming the disagreement is what lets the other four mean one thing in both. They
cover the same ground as VB.NET's `Anchor`, as one value out of a list rather
than a set of flags — which is why the designer's grid offers them as a drop-down
with nothing added to it.

**On a stretched axis `Width` stops being a minimum.** The size is derived from
the container's, so the number in the `.form` is where the gaps were measured
from, and the window can be made *smaller* than the form was drawn. What stops
it going too far is `MinWidth`/`MinHeight`:

```json
{ "type": "ListBox", "name": "ListBox1",
  "properties": { "X": 20, "Y": 144, "Width": 380, "Height": 96,
                  "HAlign": "Fill", "VAlign": "Fill",
                  "MinWidth": 200, "MinHeight": 60 } }
```

With neither declared, the floor is whatever GTK says the control needs. They
only mean something on an axis that stretches — on any other the drawn size is
already the minimum.

### Form

`Text`/`Caption`, `Icon`, `Modal`, `Resizable`, `Maximized`, `FullScreen`,
`Controls` (every bound child), `Menus` (ro: the menu spec as declared),
`DefaultButton` / `CancelButton` (ro — and see below: they are `null` until the
form has been shown), `Show()`, `Close()`, `Center()`,
`Minimize()`, `Serialize()`, `SaveForm(path)`, plus everything a container has.
Events `Open`, `Close` and `Resize(width, height)`.

**A form is asked whether it is closing, and answers by returning.** `Form_Close`
returning `true` keeps the window open; returning nothing at all — which is what
every handler written before this did — lets it go, so the default is the old
behaviour and the veto is something one says out loud. It exists because the
alternative is losing work: the X is the one path an application cannot govern, so
a form with unsaved changes had to choose between saving behind the user's back
and dropping what was typed, and both are surprises. Nothing here blocks, so
answering has one shape — refuse now, ask, and quit from the answer:

```js
Form_Close() {
    if (!this.dirty) return;
    ConfirmForm.ask("Quit", "There are unsaved changes.", "Quit without saving",
                    () => Application.Quit(0));
    return true;                    /* keep the window while the question is up */
}
```

It governs `Close()` as much as the X, which is what makes it one road instead of
two — a Cancel button and Escape end up in the same handler. What it must not do
is close *this* window again from inside itself.

**`Resizable: false` is for the dialog that has nothing to gain from being
dragged bigger** — asking for a name, confirming a deletion. It stops the *user*
resizing the frame and nothing else: the contents still size the window, so a
caption translated into a longer language still opens it wider than the designer
drew it (measured: a 400 px `ConfirmForm` opening at 930 for a long message).
That is the behaviour to want, and the reason this is not a way to pin a layout.

`Maximized` and `FullScreen` are **states, not requests**: unlike `Modal`, they
read `false` until there is a window, and setting one before `Show()` applies it
when the window appears. `Minimize()` is a verb for the same reason in reverse —
there is nothing to read back, since a minimised window is one the compositor
chose not to draw and GTK does not report it.

`Resize(w, h)` fires with the size the window really has — the same numbers
`Bounds()` gives, so a handler that relays out by hand has them without
measuring — and it fires when the window is first given a size too, which is
where `Bounds()` first means anything. One event per size: it rides
`GdkSurface::layout`, which GTK emits for relayouts that are not resizes as
well, and the runtime drops a repeat.

**What Enter and Escape do is declared on the buttons**, as it is in VB, Delphi
and Gambas: `Default` on the one Enter presses, `Cancel` on the one Escape does.
The form's two read-only properties are the resolved answer, not a second place
to declare it — a form naming a control would be the same fact written twice.

```json
{ "type": "Button", "name": "BtnOk",     "properties": { "Text": "OK", "Default": true } },
{ "type": "Button", "name": "BtnCancel", "properties": { "Text": "Cancel", "Cancel": true } }
```

Escape presses the Cancel button and does nothing at all without one: Qt and GTK3
close a dialog on Escape whether it asked to or not, and a window that discards
work on a stray keystroke has to say so out loud. A `Form_KeyPress` that returns `true` still wins — code
written for this form beats a declaration made about it — and a disabled Cancel
button refuses Escape exactly as it refuses a click.

The default is settled when the form is **shown**, which is what keeps a form
being *drawn* out of the window's business: the designer builds a form's controls
inside the IDE's own window, so a setter that reached the window could not tell
the drawing from the application. Two buttons declaring `Default` is a form in
the wrong order rather than an error — the first in tree order wins and the other
is cleared, so what the grid shows is the one that really answers Enter.

**And it is settled after `Form_Open`, not before**, so a form that builds its own
buttons in that handler is as ordinary as one that declared them in its `.form`.
The consequence is the one thing to know before reading either property:
`DefaultButton` and `CancelButton` are `null` *inside* `Form_Open` and answer a
frame later, which is where a test has to ask them. A `Default` assigned to a form
that is already open does not move it until the next `Show()`.

It says nothing about how the button is *drawn*: `Default` is the keyboard and
`Style` is the looks, and a `Close` that answers Enter should not come out
accented. `Style = "suggested-action"` is the theme's own class for the ones that
should.

### Component — a form that is not a window

A component is its own `.form` and its own class, used inside another form as if
it were a control. [`examples/hello`](examples/hello) has one, `About`: an icon
and a line of text, placed at the bottom of `Form1` and told what to say from
`Form_Open`. It is the small version of what follows — a `.form` drawn in the
designer, one published accessor, and no behaviour at all.

```js
class Stepper extends Component {
    static Events         = ["Change"];
    static Options        = { Step: ["1", "5", "10"] };
    static TextProperties = ["Caption"];

    get Value()  { return this._value || 0; }
    set Value(v) {
        this._value = Number(v) || 0;
        this.Shown.Text = String(this._value);
        this.Emit("Change", this._value);      // arrives as Step1_Change on the host
    }
    Up_Click()   { this.Value = this.Value + 1; }
    Down_Click() { this.Value = this.Value - 1; }
}
```

```json
{ "type": "Stepper", "name": "Step1",
  "properties": { "X": 8, "Y": 8, "Width": 180, "Height": 34, "Value": 5 } }
```

Nothing had to learn about it. The loader instantiates any class the project
declares (`Widget.New` resolves the runtime's classes and then the project's),
the serialiser discovers `Value` the way it discovers a `Button`'s `Text`, and
`Emit(event, ...)` raises an event that arrives by name like any control's.

Its children are **its own**: a `Button` inside it dispatches to the component's
handlers, not to the form holding it, and the form does not see them. It is
saved as a black box — type, name and properties, no children, because what is
inside comes from its own `.form`.

The IDE creates one with *File -> New component...*, lists the project's
components in a `Project` tab of the palette, and places them like any control.
Its designer runs in its own process and does not have the project's classes, so
what it places is a stand-in: it can be named, moved, resized and written back
exactly as it came. It is **drawn from the component's own `.form`** -- the half
that is declared -- and one whose drawing shows nothing to read (a `Chart` is a
`DrawingArea` and a thousand lines of painting) falls back to the component icon
and its type. **Its own properties are editable too** —
the grid reads them out of the component's source by the rule the serialiser
uses, an accessor with both a getter and a setter, and writes the value into the
node the runtime will read it from.

The three statics above are the rest of what a control says about itself. A
property is discoverable because it is *there*; what a class **raises**, what a
property **accepts**, and which of its strings a person **reads** are
declarations — a control written in C states them next to its properties and
`EventNames()`, `PropertyOptions()` and `TextProperties()` publish them. Those
walk the class table, which a class of the project is not in, so a component had
nowhere to say any of it: a double click wrote `Step1_MouseDown`, a property with
three legal values got a text field, and a caption the component exposed to the
form holding it reached no catalogue.

Declaring them puts all three back where the C ones already are, on both sides of
the process line. At **run time** they are what `EventNames()`, `PropertyOptions()`
and `TextProperties()` answer on a live instance — read inside the same prototype
walk the class table is looked up in, so a class's own comes before what it
inherits and `EventNames()[0]` means what it means everywhere else. In the
**IDE**, which never loads the project's code, the same declarations are read out
of the source: the *Write handler* menu and the editor's `Step1_` completion
offer `Change` first, `Step` gets a drop-down, and `Caption` is extracted from
the form holding the component while `Step` is not.

A component may extend a component, and the chain is walked whole: a
`class Chip extends Stepper` publishes its own event, then Stepper's, then every
widget's. Only literal lists are read — one a class computes is not a
declaration, and a half-read one would be published as though it were whole.

Building a tree from code is `AddNode(node)` / `BuildChildren(node)` on any
container — the same `.form` node shape the loader reads. It is what lets the
designer show a form it is not running.

---

## 4. Menus

A form declares its menus next to its controls and handles them like any other
event — `MnuSave_Click()`:

```json
"menus": [
  { "name": "MnuFile", "text": "_File", "children": [
      { "name": "MnuSave", "text": "Save", "shortcut": "<Control>s" },
      { "separator": true },
      { "name": "MnuRecent", "text": "Recent", "dynamic": true },
      { "name": "MnuQuit", "text": "Quit", "shortcut": "<Control>q" }
  ]}
]
```

Each item is exposed on the form by name (`this.MnuSave`) with `Name`, `Enabled`
and `Click()`. Disabling an item **also kills its accelerator**, so a shortcut can
never fire a command the UI shows as unavailable.

`shortcut` also takes a list — `["F2", "<Control><Shift>r"]` — because desktops
grab bare function keys (on Xfce, `F2` opens the application finder and never
reaches the app).

An item marked `"dynamic": true` is a submenu whose entries are **not** in the
`.form`: the application assigns them, because how many there are is data.

```js
this.MnuRecent.Items = ["one", "two"];   // reassign whenever it changes

MnuRecent_Click(index, text) { ... }     // which entry was chosen
```

Every entry activates the same action, told apart by its index, so none of them
needs a name and the list can change size with nothing declared anywhere.
`Enabled = false` greys out the whole submenu, which is how an empty list is
shown without anything in it being choosable. `Click(index)` fires an entry from
code. Labels are literal: a `_` in `"foo_bar"` shows, instead of turning into the
mnemonic underline the way the `"_File"` written in the `.form` does.

### Items that remember

A tick in a menu is an item with a state, and `Value` is that state:

```json
{ "name": "MnuGrid",  "text": "Show grid", "check": true, "shortcut": "<Control>g" },
{ "name": "MnuTheme", "text": "Theme", "dynamic": true, "radio": true }
```

```js
MnuGrid_Click(on)  { this.designer.grid = on; }   // what it just became
this.MnuGrid.Value = settings.grid;               // restoring it ticks nothing

this.MnuTheme.Items = ["Light", "Dark"];
this.MnuTheme.Value = 1;                          // Dark, marked in the menu
MnuTheme_Click(index, text) { ... }               // as any dynamic item's
```

`"check"` is one command that is on or off; `"radio"` is a dynamic item that
marks the entry chosen and remembers it, which is the one-of-several version of
the same thing — so it means nothing without `"dynamic"`, and the loader says so
rather than drawing an item whose mark never appears. A radio's `Value` is the
entry's index, and an index no entry has (`-1`, the value it starts at) is how
"none of them" is said.

**Assigning `Value` does not fire `Click`.** Restoring a setting at startup would
otherwise run the command it stands for, and nobody chose anything; `Click()` is
how a program chooses on purpose.

### Context menus

A widget's `Menu` is the **same spec** a form's menu bar is written with, so a
right click is answered by an ordinary `Name_Click` handler and nothing can tell
which one it came from:

```json
{ "type": "Panel", "name": "Canvas",
  "properties": { "Menu": [ { "name": "MnuDel", "text": "Delete" },
                            { "separator": true },
                            { "name": "MnuTop", "text": "Bring to front" } ] } }
```

```js
MnuDel_Click() { ... }              // and this.MnuDel.Enabled = false
```

It is an ordinary property, so it can be declared in the `.form` as above or
assigned at runtime, and reassigning it replaces the menu. `PopupMenu(x, y)`
opens it from code — from a key, say — at a point in the widget's coordinates.

**A control with no menu of its own passes the click outwards.** A `Button`
handles its own press, so the event never reaches the panel it sits in; without
that, a container's menu would work everywhere except over its contents. The
nearest widget that has one answers, so a control may still override its
container's.

---

## 5. Drag and drop

Three properties of any widget and two events — one drag from inside the
application, one from the desktop:

```js
BtnLabel.DragData = "Label";      // draggable; this is what travels
Canvas.AcceptDrop = true;         // receives what this application drags
Canvas.AcceptFiles = true;        // receives files from the file manager

Canvas_Drop(data, x, y) { ... }        // x, y relative to Canvas
Canvas_FileDrop(paths, x, y) { ... }   // paths: an array of full paths
```

The coordinates are the same ones `MouseDown` reports, so what is dropped can
land where the pointer is. What travels is a string, on purpose: it is what
crosses between two widgets that know nothing about each other — the IDE's
palette hands the designer the name of a class — and needs no type registered
anywhere. Emptying `DragData` turns dragging off again.

**A file dropped from outside is a different drop, and so a different event.**
`AcceptDrop` carries the application's own string; the desktop offers a list of
files, which is what `AcceptFiles` takes and what `FileDrop` hands over — the
gesture a user tries before they look for *File > Open*. Only files with a local
path arrive: something on a remote share is a real file with no path, and
handing over its URI as if it were one would fail in the `File.Load` a line
later.

While dragging, the pointer carries a stamp of the source widget, held where it
was grabbed.

---

## 6. Styles and icons

### Styles

An application decides what it looks like once, in one place: `<project>/app.css`.
It is found by name — nothing in `project.json` points at it — and a control wears
what it declares by setting `Style`:

```css
/* app.css */
.danger        { background-color: #c01c28; color: #ffffff; }
.danger:hover  { background-color: #e01b24; }
.card          { border-radius: 8px; padding: 12px; }
```

```js
this.BtnDelete.Style = "danger";
this.Panel1.Style    = "card";
this.Title.Style     = "title-1";     // one of the theme's own
```

`Style` is a list, so `"card title-3"` wears both. What is stored is the list
normalised to single spaces, and a name that could not be a CSS class is refused
rather than kept: unlike a font family or an icon name, nothing downstream would
ever resolve it, so a typo is only a typo — and one that shows up as *the style
did nothing*.

The desktop's theme already declares plenty of classes, so a project is dressed
before `app.css` has a line in it: `suggested-action`, `destructive-action`,
`flat`, `circular`, `large-title`, `title-1` … `title-4`, `heading`, `body`,
`caption`, `caption-heading`, `dim-label`, `monospace`, `frame`, `view`,
`sidebar`, `toolbar`, `linked`, `boxed-list`, `navigation-sidebar`.

**The IDE is dressed entirely this way and ships no `app.css` at all** — see
[the IDE](docs/ide.md). Worth knowing before copying a class name from anywhere:
one the theme does not declare is not an error, it simply does nothing. `pill` and
`card` are libadwaita's, not GTK's, and were dropped for exactly that reason —
found by measuring, not by reading.

**`Background`, `Foreground` and `Font` are the exception, not the norm.** They
dress one control by hand and sit *above* the stylesheet, so where they are used
they still win. They are for what a class cannot say — a colour computed while
the program runs, which is what the designer's own selection bars are — and a
project that reaches for them to make three buttons match has written its
stylesheet in three places instead of one. The cascade, in order:

| | |
|---|---|
| the desktop's theme | what a control looks like by default |
| `<project>/app.css` | the application's own classes |
| `Background`, `Foreground`, `Font` | this one control, this once |

A rule GTK cannot parse is reported on stderr with its line — visible in the
IDE's log pane when the project is run from there — and the rest of the sheet is
kept.

In the designer, `Style` is a **drop-down**: the classes `app.css` declares, then
the theme's. What it cannot do is *wear* them on the canvas — the designer draws
real controls in the IDE's own process, and a stylesheet belongs to a process, so
a class of the project's shows up when the project is run. The theme's own do
show, because they are the IDE's too.

### Icons

`Button.Icon` and `TextBox.Icon` take the name of an icon from the desktop's
theme. A name that is not there is dropped — better a button with its text than
the broken-image glyph — and `Application.HasIcon(name)` is how to find out
beforehand and choose another.

`Form.Icon` is the **window's** icon — what the desktop shows for it in a task
list, a switcher or a dock. Same rule as a button's, with one difference that
matters: a name the theme lacks is simply not shown, but it is *kept*, so a
`.form` round-trips what it declared even on a machine whose theme is missing it.

`<project>/icons` is the application's own icon directory: an SVG in there is
used by name just like a desktop one, and goes at the end of the search path, so
an application cannot shadow the system's. A name ending in `-symbolic` is
recoloured by GTK to follow the text colour — the same icon then looks right on a
light theme, on a dark one, and white on a selected button. For that the drawing
has to be **fills**: the recolouring forces `fill`, and anything that is `stroke`
keeps the colour in the file.

`Application.Icons()` is the other question — not "is this one there" but "what
is there at all", which is what anything letting a person *choose* an icon needs.
It gives every name in the search path, sorted, narrowed by a substring if one is
passed. The names come from the theme's index and are not rendered, so a chooser
checks the page it shows with `HasIcon` rather than paying for thousands of
renders up front.

`HasIcon` answers for what will be *seen*: it renders the icon and looks for ink,
because a theme's index can claim an icon it does not really ship (GTK hands back
its `image-missing`) or ship an SVG that renders to nothing.

---

## 7. Globals

| | |
|---|---|
| `Application` | `Name`, `Version`, `Path`, `Config`, `Exe`, `Args`, `HasIcon(name)`, `HasCommand(name)`, `Icons([contains])`, `OnError`, `Quit(code)` |
| `Message` | `Info(text, ...args)`, `Warning`, `Error` — the text goes through the catalogue |
| `Locale` | `Text(msgid, ...args)`, `Plural(one, many, n, ...)`, `Context(ctxt, msgid, ...)`, `Read(path)`, `Current`, `Available` |
| `File` | `Load`, `Save`, `Exists`, `IsDir`, `Delete`, `Rename`, `Join`, `Absolute`, `Name`, `Directory`, `Ext`, `BaseName` |
| `Directory` | `List(path, pattern?)`, `Make(path)` |
| `Exec` | `Exec(argv, onLine, onExit)` — captures the output line by line |
| `Dialog` | `SelectFolder(title, [opts], cb)`, `OpenFile(...)`, `SaveFile(...)`, `Color(title, current, cb)` — `opts` is `{Folder, Name, Filters}` |
| `Clipboard` | `Copy(text)`, `Paste(cb)` |
| `Bytes` | a file's contents when they are not text: `Length`, `At`, `Slice`, `Concat`, `Equals`, `ToText`, `ToBase64`, `ToHex`; `File.LoadBytes` / `File.SaveBytes` |
| `Hash` | `Md5`, `Sha1`, `Sha256`, `Sha512` of a string; `File.Hash(path, [algorithm])` for a file, read in blocks |
| `Screen` | `Width`, `Height`, `Scale`, `Monitors()` — the desktop's geometry. No primary monitor and no work area: GTK4 answers neither |
| `Time` | `Now`, `Add(time, minutes)`, `Between(from, to)`, `Seconds(time)` — a time of day as `"HH:MM"`, the clock half of `Day` |
| `Text` | `Width(text,[font],[opts])`, `Height`, `Size`, `Lines`, `Font` — what a string measures where there is no `Painter` to ask |
| `Settings` | `Get(key, fallback)`, `Set`, `Has`, `Delete`, `Keys`, `Clear`, `Path` |
| `Timer` | `Timer.After(ms, fn)`, `Timer.Every(ms, fn)`; `new Timer(delay, tick)`: `Delay`, `Tick`, `Enabled`, `Start`, `Stop`, `Once` |
| `Logger` | `Debug`, `Info`, `Warning`, `Error`; `Level`, `Target`, `Handler` |
| `Http` | a client (`Client`, `Get`/`Post`/…, `GetWait`/…, `Stream` for an answer read as it arrives, always `Bytes` bodies) and a server (`Server`, `Request`, `Answer`) over libsoup3 |
| `AudioPlayer` | `new AudioPlayer()`: sound with no window — `Uri`, `User`/`Password` (RTSP digest), `Latency`, `Volume`, `Muted`, `Loop`, `Position`/`Duration`/`Playing`/`Seekable`/`Buffering` (ro), `OnEnded`/`OnError`, `Play()`, `Pause()`, `Stop()`, `Seek(s)` — over GStreamer, like `Video`, and a cue nobody keeps is still heard to its end |
| `Multipart` | `new Multipart()`: `Field`, `File`, `Part`, `Length` — a file upload as a value, for `Http` in either direction |
| `Record` / `Field` | the shape data has, declared once — see below |
| | `print`, `BTA_VERSION` |

`Application.Directory` is the project directory; `Application.ConfigDirectory` is a directory
of the application's own under the user's config (`~/.config/bintana/<name>`),
created at startup, so saving a setting is one `File.Save` and no ceremony. Named
after the project, two projects never read each other's settings.

`Exec` takes an array of arguments, never a shell string: there is no shell to
quote for, so a file name with spaces or quotes cannot turn into a command.

**An error nobody caught is shown.** A handler that throws used to leave the
application running with nothing said — the button simply stopped working. Now it
goes to the terminal *and* to a dialog with the stack, which is the part that says
where to look. `Application.OnError = (message, stack) => ...` takes it over for an
application that would rather log it or show it its own way.

`Settings` is what an application remembers between runs — anything JSON carries,
kept in `Application.ConfigDirectory/settings.json`, written on every change and readable
by hand:

```js
Settings.Set("recent", [dir, ...Settings.Get("recent", [])].slice(0, 8));
```

`Timer` is how an application schedules anything: `Timer.After(250, fn)` for one
shot, `Timer.Every(1000, fn)` to repeat, and both hand the timer back so it can
be stopped. The raw `setTimeout`/`setInterval` are not part of the language.

`Clipboard.Copy` is a call and `Clipboard.Paste` takes a callback — the clipboard
belongs to whoever owns the selection, so its contents arrive when that
application answers. The asymmetry is the platform's, not a choice.

### Text as a resource

A form's captions are declared in its `.form`, so they are translated **without
anything asking**: the loader looks up every property the control's class declares
as prose and the file needs no markup at all.

```
myproject/
  po/
    es.po          <- found by name, like icons/ and app.css
```

The literal is the key, gettext-style, so a form reads as prose and an
application with no catalogue is a working one. The runtime reads the `.po`
directly — nothing in a project directory is compiled — which is also the file
Poedit and Weblate edit.

In a RAD project, text in code is the exception, and it needs a helper only where
the runtime does not already own the position:

```js
Message.Info("Saved");                                 /* already a text position */
Message.Error("Cannot open {0}: {1}", path, err);      /* ...with arguments */
Locale.Text("Hello {0}!", name)                        /* built at the moment */
Locale.Plural("{0} file", "{0} files", n)
```

**A template literal in one of those positions is the one real trap**: the msgid
arrives already filled in, so no catalogue can ever match it. The IDE's
*Project > Update translations* extracts every string and reports exactly that.

Better still, keep the template in the form and pass data:

```json
{ "properties": { "Text": "{0} files, {1} unsaved" },
  "design":     { "Text": "12 files, 2 unsaved" } }
```

```js
this.LblStatus.Fill(files.length, dirty.length);
```

The `design` block is what the **designer** shows — Android's `tools:text` — so a
label whose text the code fills in can still be laid out. It can never reach a
running application: only the designer reads that key. The property grid has a
*Design values* switch and a button that fills one with a sample.

Which properties count as prose is the class's own declaration, and that is the
point: `SourceEditor.Text` is source code and a catalogue must never rewrite it, while a plain `TextEditor`'s is prose and is translated.
`Widget.TextProperties()` publishes the answer. See
[docs/resources.md](docs/resources.md).

### Records — the shape data has

A control declares its properties and everything else discovers them: the
serialiser writes what it finds, the designer's grid edits it, a drop-down appears
for a property that says what it accepts. **A `Record` is that, for data** —
nothing else was, so every program that read a JSON file named the keys, checked
them and complained about them by hand.

```js
class Customer extends Record {
    static Fields = {
        Name:     Field.Text({ required: true, max: 80 }),
        Email:    Field.Text({ as: "email_address" }),
        Balance:  Field.Number({ decimals: 2, min: 0 }),
        Category: Field.Enum(["Retail", "Wholesale"]),
        Active:   Field.Bool(true),
        Since:    Field.Date(),
        Tags:     Field.List(Field.Text()),
    };
}

const c = new Customer({ Name: "Ana" });
c.Balance = 10.567;                 // 10.57: rounded to what it holds
c.Category = "Other";               // throws, naming the two it accepts
File.SaveJson(path, c);             // { "Name": "Ana", "Balance": 10.57 }

const read = Customer.Load(File.LoadJson(path));
if (read.Problems.length) ...       // everything wrong with it, at once
```

What a declaration produces is **ordinary accessors**, so a record is discovered by
the same machinery a widget is: `Serialize`, `Apply`, `PropertyNames` and
`PropertyOptions` all work on one, and a field written by hand is a field like any
other. Declaring is only how the accessors get written.

Assigning is checked and throws with the offending value, as every setter in this
runtime does. Reading a file is the deliberate exception: `Load` leaves what it
cannot accept at the field's starting value and reports it, because a row that no
longer satisfies today's rules must still be readable or it can never be
corrected. Keys the record does not describe survive the round trip, so an older
program cannot delete a newer one's field by saving the file.

`Naming` (`same`, `lower`, `snake`) says how the *file* spells its keys, once,
instead of an `as:` on every line — and `as` is the exception for the field the
rule does not fit.

**A record holds records**, which is what makes master–detail a declaration
rather than two objects kept in step by hand:

```js
class Quote extends Record {
    static Fields = {
        Customer: Field.Text({ required: true }),
        Lines:    Field.List(Line),               // a list of records
        Ship:     Field.Record(Address),          // one, and it starts absent
    };
}

const q = Quote.Load(File.LoadJson(path));        // lenient, lines included
q.Validate();       // ["Lines[2].Price: 0 at least, got -5"] — the index and the member
File.SaveJson(path, q);                           // one object
```

A shape may contain itself — a tree of categories, a menu — which needs a thunk,
because inside a class body the class is not bound yet:
`Children: Field.List(() => Node)`.

**And a record reads and writes a table.** `Naming = "snake"` is the SQL
spelling, `key: true` is the identity, and nothing in between converts a value —
because a row *is* a file, which is what `Load` and `Serialize` already read and
write:

```js
const db      = Database.Sqlite("data/sales.db");
const clients = db.Table("clients", Client);

const c = clients.Save(new Client({ Name: "Ana" }));   // INSERT; c.Id is filled
clients.Where("balance > ? ORDER BY name", 0)          // the filter is SQL, bound
```

`Database.Sqlite` is named for the library it is, not `Connection`, because half
of what a driver does is not portable — a decimal stored as text is a fact about
sqlite and not about this runtime. The full reference for both is in
[docs/runtime-api.md](docs/runtime-api.md#record-and-field).

---

## 8. The IDE

`ide/` is a Bintana project like any other: `project.json`, `MainForm`, a class per
subject beside it (`Designer`, `TabSet`, `Classes`, ... — see
[docs/ide.md](docs/ide.md)), the `AskForm` / `ConfirmForm` / `NewProjectForm` /
`SymbolForm` / `IconForm` dialogs, and `icons/`. It has a project tree, a tabbed
editor with highlighting, run/stop with the output in a log pane, a real VTE terminal in a tab beside it, menus with
accelerators, a **debugger**, and a **form designer**.

The project tree groups each form with its code: a form is one thing even though
it lives in two files.

```
Forms
  Form1
    design        Form1.form
    code          Form1.js
Modules
  Util.js
Documents
  README.md
Other
  project.json
```

- **New project** (`Ctrl+Shift+N`) asks for name, description and base folder, and
  shows the path it will create before accepting. It starts with `forms/Form1`
  already in place: **a project has a shape and the IDE creates it**, rather than
  leaving a root to fill up and be tidied later. A new form goes beside whatever
  is open, or to `forms/` when there is nothing to be beside; a component to
  `components/`. The names are the categories the project tree groups by, so the
  directory ends up shaped like the view — and a folder is *not* a namespace, so
  the class is still `Form1`.
- **Recent projects** is a submenu of the last eight projects opened, written down
  in `Application.ConfigDirectory`, so it survives closing the IDE. A project that no
  longer exists drops off it silently.
- Forms are created (`Ctrl+N`), renamed (`F2`) and deleted without leaving the
  IDE. Renaming a form moves both files, rewrites the class name and updates
  `sources` and `startup` in `project.json`. References from *other* files are not
  touched: the IDE says which ones still name the old one instead of blindly
  rewriting someone else's code.
- Tabs keep per-file state: switching loses no unsaved change, and the status bar
  keeps an asterisk on what is dirty.
- **A `.md` opens as the document it is**, drawn by `lib/markdown` -- headings,
  lists, tables, code blocks and the project's own pictures -- with a *Source*
  toggle a click away, because a tab that could not edit it would be the IDE
  refusing to let anybody fix a typo in their own README. A link to another file
  of the project opens it the way clicking it in the tree would. **A project
  nobody has opened here before opens on its README**; one that was in the middle
  of something reopens what was being worked on.
- **Find and replace** (`Ctrl+F`, `Ctrl+H`, `F3`, `Shift+F3`) is a bar under the
  editor, not a dialog: the text stays visible while one types in it. It counts as
  you type (`3/12`), matches case, whole words or a regular expression, and wraps.
  What it is a view of is *the active tab's* search — the highlight belongs to the
  editor, and every code tab owns its editor — so switching tabs re-counts there
  and a form tab, having no text, closes it.
- **Go to definition** (`F12`) answers what *Find in project* could only search
  for. The word under the caret, looked up and never guessed: `this.greet` is the
  method declared in this file, `this.Ok` is the control on the `.form` beside it
  — which opens the designer and selects it, since a designer has no lines — and
  `Child` or `Whatever.Child` is the class of that name wherever the project
  declares it. A name nothing declares goes **nowhere** and says so in the log,
  which is the same answer completion gives to `const x = makeThing(); x.` and for
  the same reason: a wrong jump is worse than no jump. The runtime's own names are
  F1's question, not this one.
- **Go to...** (`Ctrl+Shift+O`, `Ctrl+L`) is the methods of the open file as a
  list, in the order they are written, narrowed as one types — the procedure
  list Visual Basic kept over the code, and Lazarus's Code Explorer. **One box and not two:** digits
  are a line number rather than a filter, so `2` goes to line 2 and `t2` searches,
  and `Ctrl+L` is a second key on the same command instead of a second window.
- **Find in project** (`Ctrl+Shift+F`) is a window of its own: the same term
  against every file the project owns, with the three switches, a filter built
  from the project's own extensions, and the hits as a tree — a node per file, a
  node per line, and double clicking one opens the file with the match selected.
  A window and not a bar for the opposite reason a find bar is one: what it
  searches is not on screen, so there is nothing to keep visible, and what it has
  instead is a result set. Not modal, since the point of a result is to be gone
  to; one at a time, raised rather than opened twice, so the last search is still
  there when it comes back.
- **Saving a `.js` compiles it** — `Application.CheckSource`, which does not run
  it — and puts what the compiler said in the gutter beside the line, with the
  message as its tooltip and the same thing in the console where it is clickable.
  On save and not on every keystroke: half a line is not a syntax error. It never
  refuses the save; broken code is what one has written when one stops to go and
  look something up.
- **Quitting with unsaved work asks first**, and the window's own X asks the same
  question — `Form_Close` is a veto now, so there is one road out of the IDE
  rather than a governed one and an ungovernable one. The answers are *quit
  without saving* and *save all and quit*, and the dialog names the files.
- **Exporting** (`Ctrl+Shift+E`) writes the whole project directory as one `.tar`
  beside it, with the project's own name suggested. Plain tar and nothing else: a
  project is text, so what an archive of one is for is holding the tree together,
  and which compressor to use is a question nobody asked. Writing it *inside* the
  project is refused rather than worked around — tar would skip the file it is
  writing, so the archive would come out quietly missing something and every
  later export would pack the earlier ones.
- **The project's own settings** (`Ctrl+Shift+P`) are a dialog: name, the form it
  starts at, description, and the order the code is loaded in. It validates nothing
  itself — it assigns to the `ProjectFile` record and reports whichever field the
  record refused, so adding a field to the record is all it takes to have the dialog
  check it too.
- **The tree marks the form the project starts at** with a play triangle, and *Set
  as startup form* on its context menu is how that changes. What gets written is the
  qualified class name, which is what the runtime looks a class up by.
- **The tree has two views**, chosen at its head: *Project*, which groups by what
  a file is — a form's two files as one node, the catalogues together, `po/` not
  drawn — and *Files*, which is the directory as it really is, including
  everything the project does not recognise. A `README`, a `.tar`, an `.svg` in
  `icons/` were invisible here until the second one existed. Icons come from the
  desktop per file, what opens in a tab is decided by content type rather than by
  extension, and what is not text goes to whatever the desktop opens it with.
- **A file that changed underneath says so.** Each open tab watches its file, and
  a rewrite from outside puts a bar over the editor with a *Reload* button —
  which asks first when there is unsaved work. What tells somebody else's write
  from the IDE's own is the bytes, not a timestamp: each tab keeps what it last
  read or wrote.
- **The project's images are shown, not just listed.** A `.png` gets a category
  of its own in the tree and a double click opens a modal viewer — fit, 1:1,
  zoom and pan — which is the runtime's own `Picture` in a `Scroller`, the IDE
  using what it ships. `examples/viewer` is the same thing as an application.
- **The console says where.** A traceback names a file and a line, and clicking one
  opens that file there. A run that ends badly goes there on its own, without
  waiting to be clicked: pressing Run and being left in front of a wall of text
  with the file it names one click away is the thing that fixes. Only files of the
  project — a traceback runs through the runtime's own frames too.

**Git shows the diff before the commit.** The tree marks what changed
(`name [M]`), the status bar carries the branch and the counts, and *Changes*
(`Ctrl+Shift+D`) is a window with the files on the left and the two versions
side by side on the right -- in the file's own language, which is how a person
reads what they are about to commit, with a unified tab underneath for what two
panes cannot show. Stage, unstage, discard and commit per file. The engine is
the git CLI, asked for with `HasCommand` the way `msgmerge` and `tar` already
are; nothing here is a new dependency.

*Git → Branch* lists the branches with the one you are on marked and switches to
another -- saving first, and asking when there is something uncommitted, because
a switch can refuse halfway. It is `switch` and not `checkout`, whose two
meanings depend on whether the name turns out to be a branch or a path.
*History* (`Ctrl+Shift+H`) is the commits, what each one touched, and the same
side-by-side pair between a commit and the one before it.

The same list is also a page of the side bar -- the third entry of the chooser
that picks *Project* or *Files* -- with a one-line message box where Enter is the
button, because a window that covers the editor is a poor place to make three
small commits in an afternoon. Double click a row and the window opens on that
file; the row's menu stages, unstages, discards and stages everything, and they
are the same commands the window presses.

*Fetch*, *Pull* and *Push* are the only git here that takes as long as somebody
else's server does, so they are the only git here that does not block: an `Exec`
into the log pane, one at a time, with Stop reaching them -- and the status bar
grows `↑2` / `↓1` once the branch follows one, counting what was last fetched and
never going to the network. Pull saves first and is `--ff-only`; push carries
`--set-upstream` on a branch that follows nothing, so git never answers with a
command to retype. **None of them can ask for a password**: with no credential
helper they fail fast and say so rather than opening an askpass window or waiting
on a prompt nobody can see, and answering like a person is what the Terminal tab
is for. *Clone a repository...* is the one that runs where there is no project,
and opens what lands. The design is in [docs/git-plan.md](docs/git-plan.md).

**Debugging** (`Ctrl+F9`) runs the project and stops it where you said. `F9`
toggles a breakpoint on the caret's line, `F8` / `Shift+F8` / `Ctrl+Shift+F8`
step into, over and out, `Ctrl+F8` pauses a program that is running, and
`Ctrl+F9` again carries on. The keys are Visual Basic's, which is also where
Gambas, Delphi, Lazarus and Visual Studio got theirs; *Run* gave `F9` up and
kept `Ctrl+R`, because `F9` meaning *run* was this IDE's alone.

The bottom panel grows a *Debug* page: the call stack, the arguments and
variables of whichever frame is chosen -- **that frame's**, so standing one
level up shows what the caller was holding -- and a box that asks. An expression
typed in it is answered where the program is standing; *Watch* keeps it and asks
it again at every stop; activating a value offers to change it, and the new one
is an expression rather than a literal. A breakpoint can carry a condition, and
*Stop where something is thrown* stops on the line that threw, with the frame
that built the failure still alive.

An object is shown **by what is in it** -- `{ nombre: "Ana", saldo: 31 }` --
because `[object Object]` is what a debugger shows when it has given up. And
what the box can name is exactly what the list shows: the runtime compiles the
expression as a function of the frame's own names, which is the only way a
`let` is in scope at all. The gutter mark *is* the breakpoint, which is what
`SourceEditor.Mark`'s `Bookmark` kind was written for, so there is no second
list to disagree with what is on screen.

**A breakpoint can move, and says so.** QuickJS gives a line number only where
the line changes, so a statement the compiler ran together with the one above it
can never stop; the runtime answers where the breakpoint really landed and the
mark follows it, with a line in the log. A mark beside a line that will never
stop is worse than no mark.

What does the stopping is `bintana --debug`, which blocks the program and
speaks a line of JSON at a time -- out on a third stream and in on stdin, which
is what `Exec`'s `Control` option and the handle's `Write` were added for. Both
are ordinary capabilities now: any application can drive a child that speaks a
protocol. The design, what *complete* would mean, what a branch per opcode costs
measured, and DAP as the plan to evaluate are in
[docs/debug-plan.md](docs/debug-plan.md).

### The designer

Selecting a `.form` opens the designer instead of the text editor. It edits **real
controls**, not a drawing of controls: the surface holds the form's actual
widgets, and on top of it a transparent layer (`Glass`) keeps the mouse — which is
why clicking a `Button` selects it instead of pressing it.

Select, drag (snapped to a 4 px grid), resize from eight handles, multi-select
with Ctrl or a rubber band, align and distribute, change depth, re-parent by
dropping into a `Panel` or `Frame`, and edit any property from the grid. Alignment
guides appear while dragging when an edge, or a centre, comes close to another
control's. Undo and redo cover everything, as snapshots of the serialised tree.

**The palette** is tabs of square icon buttons, one per type of control, laid out
as a gallery — how many fit on a line is the panel's width to decide, and a tab
with more than fits scrolls. Pressing
one adds the control in the first free spot and makes it what `Ctrl+Insert`
repeats; **dragging** one to the form puts it where it is dropped, centred on the
pointer and snapped to the grid — and inside a container if dropped on one.

**The palette offers every control there is**, in five tabs: `Basic` (`Button`,
`Label`, `Image`, `Picture`, `Separator`, `TextBox`, `CheckButton`,
`ToggleButton`, `Switch`, `LinkButton`), `Data` (`ComboBox`, `SpinBox`, `ListBox`,
`Slider`, `DatePicker`, `Calendar`, `ColorButton`, `FontButton`, `ProgressBar`,
`LevelBar`, `Spinner`), `Views` (`TreeView`, `TableView`, `TextEditor`,
`SourceEditor`, `Terminal`, `RowList`, `Flow`, `DrawingArea`, `Video`), `Boxes` (`Panel`, `Grid`, `Frame`, `Expander`,
`Scroller`) and `Split` (`Split`, `Notebook`, `Switcher`, `Overlay`). The three
pickers sit together because they are one gesture: a date, a colour and a font are
all **picked** from the desktop's own chooser rather than spelled out. There is no
box class to offer: a `Panel` **is** the box, and `Arrangement` says whether it
holds coordinates, a row or a column.

*Every* is asserted rather than claimed — the suite asks `Widget.Types()` what
exists and fails on anything the palette does not offer, `Form` and `Component`
excepted. Which is how it was found that six of them were missing: `TreeView`,
`SourceEditor`, `Terminal`, `RowList`, `Overlay` and `Flow` were controls of the
runtime that no button offered, and five of them are what the IDE's own windows
are built out of.

**Except what this build cannot run**, which is the same question the other way
round and is `Widget.Available(type)`. `Terminal` on a runtime built without VTE
is the case: the class is there and a `.form` holding one still opens, so
`Widget.Types()` is the wrong list to build a palette from — the button is
simply absent, rather than placing a control whose only warning would be a
dialog at run time. Both directions are asserted, since a filter that dropped
everything would satisfy the first on its own.

**Elastic forms** are designed too, not only `Fixed` ones. The surface lays its
children out the way the running form will, so a form declared `Vertical` is a
column and a `Horizontal` box is a row. In a box there are no coordinates to move
a control by, so dragging one **reorders** it — a mark shows where it will land —
and the arrow keys do the same. Dropping from the palette picks a place in the
row rather than a point.

The IDE opens its own `MainForm` either way: it is drawn in coordinates now, and
what makes it survive a resize is the `HAlign`/`VAlign` its controls carry.

Adding to a **notebook** makes a page and names its tab; pages reorder with their
tabs, and `Notebook.Tabs` is an ordinary array property, so the names survive in
the `.form`. A **switcher** is the same, with one segmented strip instead of a row
of tabs -- which is what a panel with two or three views of itself wants, and what
the IDE's own side panel is.

`SetAction(control, "Start" | "End")` puts a control in the **tab strip itself** —
the room at either end that a page cannot reach. It is not a page: `Count` and
`Children` go on counting only those. The IDE's tab strip ends in a button
carrying *Close tab*, *Close others*, *Close all* and *Save all*: the same
commands the File menu has, where the tabs they act on are. A **split** takes exactly two halves and says so rather than throwing
when a third is dropped on it.

**Menus** are edited with `Ctrl+M` (*Form → Edit menus...*), in a dialog that is
itself a Bintana form. It shows the whole bar as a tree — submenus, items and
rules — and edits the spec the `.form` carries, because there is nothing on the
canvas to click: a GTK4 menu is a model wired to actions, not a widget. Adding,
reordering, deleting, names, shortcuts and dynamic entries are all there, the
result is one undoable edit, and double clicking an item writes its
`Name_Click` handler exactly as double clicking a control does.

**Alignment works on the edges you can see.** A theme draws a `Button`'s face
inside its box — 17 px a side here — so aligning declared coordinates left a
button and a label visibly out of line. Align and same-size correct for that
inset, and *same width* means the same drawn width, which takes two different
requests when the two controls draw differently.

**A control that does not fit says so.** `Width` is a request, i.e. a minimum, so
a label with more text than room comes out wider and takes its window with it.
The designer flags it: the outline turns amber and the status bar says what it
really draws.

**A style is chosen from the application's own.** The `Style` row is a drop-down
built from `<project>/app.css` plus the classes the theme ships, so dressing a
control is picking one of the answers the application has already given. The
three rows under it are what is left when no class can say it — see §6.

**Fonts and colours are picked, not spelled.** A `Font` row *is* a `FontButton`
— the font shown in itself — and clearing it goes back to the theme's.

**Colours are picked, not spelled.** A `Background` or `Foreground` row *is* a
`ColorButton`: the swatch shows what the value is, pressing it opens the
desktop's chooser, and the button beside it clears back to `""` — whatever the
theme says, which is the state most controls are in and the one you need a way
back to. The two sit in a `linked` panel, so they draw as one control: a value
and the way back to none of it are one thing. And a `ColorButton`'s or a
`FontButton`'s own `Value` gets the same editor, decided by the class of the
control selected: the IDE offers both from the palette, so it would be a strange
thing to then edit the value they exist to pick as six characters of text.

**A number that is not whole stays that way.** Every numeric row used to be a
spin with no decimals, which took the edit and destroyed it — `Opacity = 0.55`
came back `1`. How precise a property is gets asked rather than listed: a
throwaway wearing the selected control's own properties is handed a number with
six decimals, and how many come back is how many the row offers. No list could be
right — `Value` is fractional on a `ProgressBar` and whole on a `Slider`, and the
same slider told `Decimals = 3` holds three of them.

**Icons are chosen, not typed.** An `Icon` row in the grid is a field with a
button on it that opens a chooser — a search box over every icon the desktop has,
2589 of them here, wrapping into as many columns as the window is wide — with
*None* to clear it. Cancelling is not the same as
choosing none: one leaves the icon alone, the other is a thing one means to do.

**The control tree** shows what the form is made of, and is the other way to
select something — the only one for a control behind another or inside a
container too small to aim at. The IDE's own window opened in it is 38 controls
nested 8 deep, and each is one click away. Its root stands for the form itself,
which is what an empty selection edits, so it is also how the form's own
properties are reached. It shares the side panel with the grid through a
splitter, and selecting from either side goes through the same code, so the two
can never disagree. Each node carries the icon of its type, from the same table
the palette uses, and **double clicking one renames** the control — the same
rename the grid's `Name` row does, handlers and all.

**The form is resized by dragging its border** — the right edge, the bottom, or
the corner that is both — snapped to the grid, undoable, with the size in the
status bar as it moves. **The anchored controls follow and their coordinates are
rewritten**, down to each one's `MinWidth`/`MinHeight`: an anchor is measured
against the form's declared size, so once that changes the old numbers no longer
describe what the runtime would draw. Only the far edges have grips: the form's origin is
`0,0`, so dragging the near ones would mean moving every control rather than
resizing anything.

**The form's own properties** are edited with nothing selected — click the bare
canvas or the tree's root — and are discovered the same way a control's are, so
`Modal`, `Arrangement`, `Background` and whatever gets added next are all there.

**The property grid** has no fixed list: it asks the control what properties it
has (`PropertyNames()`), the same mechanism the serialiser uses to decide what to
save. The editor per row is chosen by the value — a number gets a `SpinBox`, a
boolean or anything that declares its accepted values gets a `ComboBox`, the rest
a `TextBox`. So a new property in C shows up here edited properly, without the
designer knowing it exists.

**`Completion` offers the words already in the file** as you type — the floor of
what an editor owes, and the whole of what can be known without being told
anything. Off by default: an editor is also used to show a log or a diff, and a
popover over one of those is uninvited.

**And what knows what the text *means* is the `Complete` event**, which the IDE
answers with lookups rather than inference: `this.` offers the controls on the
`.form` beside the file and the methods the file declares, `this.Btn1.` the real
properties of a `Button`, `Btn1_` the events it raises with the handler's name
already spelled, and `File.` the members `File` really has. Nothing is guessed —
which is also why `const x = makeThing(); x.` proposes nothing, and says so
rather than inventing an answer.

**Copy, cut, paste and duplicate** (`Ctrl+C`, `Ctrl+X`, `Ctrl+V`, `Ctrl+D`) move
controls between forms, between tabs and between two IDEs: what goes on the
clipboard is the control as a `.form` node, in text, so a control on the
clipboard is the same thing a file holds. Names are made fresh all the way down —
a copied `Panel` brings its contents — because a name is unique across the form
and not among siblings. What does not travel is the code: a paste is a second
control, not the same one, so nothing is written for its handlers. Pasting
follows the selection, which is how one puts something *into* a container;
duplicating does not, because a duplicate is a sibling.

**Double clicking a control writes its handler** and jumps to it: `Button1_Click`
for a button, `Change` for a text box, and the form's own event on the background.
Which event that is comes from the control (`EventNames()[0]`) and not from a list
in the IDE — there was such a list, fifteen types by hand, and five controls were
missing from it. *Form → Write handler* offers **every** event the selection
raises, marking the ones already written, since those it jumps to rather than
writing twice.

**And that list is drawn, not only offered.** The side panel's second page is
**Events**: a row per event the selection raises, the method each one would be
written as, and a bullet on the ones the `.js` already answers — which is the
Object Inspector's *Events* tab in Delphi and Lazarus, and Visual Basic's
procedure drop-down. Activating a row goes through the same `openHandler` the
double click does, so an event already answered is jumped to rather than written
twice. With nothing selected it is the form's own events, under the name `Form`.
It decides nothing: the events come from the control, the marks from the `.js`,
and a control that grows an event in C appears here with no list to update — the
same bargain the property grid makes with `PropertyNames()`.

Renaming a control from the grid carries its handlers along in the `.js` — with
word boundaries, so renaming `Button1` never touches `Button10`.

**Deleting one keeps its handlers and gives up its name.** The code is the user's
and a Delete is not a request to lose it, so the `.js` is left alone — but the
name is then spoken for: a new control never takes a name the code still answers
for. Without that, deleting `Button1` and drawing another button gave it
`Button1` back, and it silently inherited whatever `Button1_Click` still did — a
fresh control that already does something, with nothing anywhere saying why. The
console names the handlers that stayed and the file they are in, because dead
code nobody knows about is how that happened. Reclaiming them deliberately is a
*rename*, which is the gesture that says *this control is that one*.

---

## 9. Tests

Four Bintana projects under `tests/`, each printing `N passed, M failed` and
quitting with a non-zero status on failure. They are applications, not a harness.

```sh
./tests/run.sh                  # all four, on a virtual display: that is the default
./build/bintana tests/widgets   # one of them, on your own screen
```

**So is the runner.** `tests/runner` is a console project — `"main"` in its
manifest, no window and no display — which is what lets it be the one that decides
whether the projects need a virtual one, finds `xvfb-run` when they do, guards
each against hanging and reports. `tests/run.sh` is the ten lines of shell that
cannot be written in Bintana: finding the binary, and saying so when there is
none.

- `tests/smoke` — the loader, events, the basic controls.
- `tests/widgets` — containers, `Arrangement`, both editors, `TreeView`,
  `RowList`, drag and drop, icons, the serialiser round trip, `File`/`Directory`/`Exec`.
- `tests/report` — `lib/report`: the pagination, the group ladder and the totals,
  read off the page. A shipped library is part of the contract, so it is tested
  like one: `Save()` draws synchronously and `Canvas.Dump()` is what that page
  put down.
- `tests/ide` — loads the **real** `ide/**/*.js` and drives the IDE the way a user
  would. Its `.form` files and `icons/` are symlinks to the IDE's own, so the two
  cannot drift.

Event tests make the round trip: assigning `TextBox1.Text` from JS has to reach
GTK, come back as a real `changed` signal and land on `TextBox1_Change`. Testing
the JS side alone proves nothing.

---

## 10. Known limitations

- `set_size_request` fixes the **minimum** size, not the exact one. A control whose
  natural size exceeds the request (a `Label` with long text) renders larger than
  the `.form` says. That is GTK's model and not a bug to fix — forcing an exact
  allocation would clip text instead — so the designer reports it rather than
  fighting it.
- `Form.Center()` is a no-op: on Wayland the compositor decides placement.
- `Message.*` does not block. GTK4's dialogs are asynchronous, so it does not
  behave like VB's `MsgBox`; a confirmation with an answer is a form
  (`ConfirmForm`), not a runtime primitive.
- `.js` load order matters when one class extends another of the same project.
  `sources` in `project.json` fixes it.
- The designer edits menus in a dialog rather than on the canvas — there is
  nothing to reorder, since a GTK4 menu is a model wired to actions and not a
  widget. The board **does** show the form's menu bar: a `Panel` and a `Label`
  per menu, dressed in the theme's own numbers and opening real menus through
  `Menu` and `PopupMenu`, the same bargain the title bar above it makes. Two
  things a stylesheet would close and the IDE will not grow one for: a previewed
  entry does not light up under the pointer the way `menubar > item` does, and it
  does not draw the 1px rule a real bar has inside its own height — which would
  have cost a 28th pixel, and the height is what the canvas depends on.
- An `Overlay`'s layers are shown and can be selected, but the designer has no
  gesture for stacking them: what it orders are the children of a box, a
  notebook's pages and a split's two halves.
- A `.form` always opens in the designer; there is no way to see it as text.
- The designer **offers** the project's style classes but does not wear them: a
  stylesheet belongs to a process, and the canvas is drawn in the IDE's. Loading
  the project's `app.css` would restyle the IDE itself — one `button { … }` in it
  reaches every button in that window — so what a class of the project's looks
  like is seen by running it. The theme's own classes do show.
- **A control has no mnemonic.** There is no `&Save` giving a button Alt+S, and no
  label that hands the focus to the field beside it. Menus do have them, and
  always have: `_File`, `F_orm`, with the underscore travelling in the msgid so
  the *translator* picks the letter — `_File` becomes `_Archivo`, F in one
  language and A in the other. What a control gets instead of a mnemonic is a menu
  item with a `shortcut`, which is a real accelerator and takes a list of them.

  This one is **decided rather than pending**, so the reasoning is worth keeping:

  - **The lineage dropped it.** Gambas has no marker on `Button.Text` and no
    `Buddy`-style property on `Label` — thirteen properties and not one links a
    label to a control. What it kept from VB is `Menu.Shortcut`. GNOME's own
    libadwaita-era dialogs largely do not set mnemonics either, macOS never had
    them, and the web's `accesskey` is dead in practice: it collides with the
    browser's shortcuts and with assistive technology.
  - **The cost lands on translators, and this project cares about that more than
    most.** The marker lives inside prose that goes through the catalogue, so the
    translator chooses the accelerator. Five curated menu titles is fine — it
    works today. Twelve controls on a dialog times every language is a collision
    waiting to happen, and *nothing would say so*: two controls claiming Alt+A
    render perfectly and one of them simply never answers.
  - **The half that would have been worth it is the label pointing at its
    field** (`Alt+N` focuses Name), and its real argument was never the Alt key
    but the accessibility relation it might carry — a screen reader announcing a
    field by its label. GTK does not document `gtk_label_set_mnemonic_widget` as
    setting `labelled-by`, and it was not verified, so that argument is not
    available. Without it the feature is nostalgia.

  If it is ever revisited, that label-to-field half is the piece to build, and
  verifying the accessibility relation is the thing to do first.

### Three things that were considered and are not coming

Written down so the argument is not had twice.

- **No `ToolBar` class.** GTK4 *removed* `GtkToolbar`; a toolbar there is a box
  wearing the theme's `toolbar` class, with `flat` buttons — which is exactly what
  the IDE's own already is, a `Panel` with `Arrangement: Horizontal` and
  `Style: "toolbar"`. A class would be a second name for a combination that has
  one, and this project already answered the same question about boxes: a `Panel`
  *is* the box. The one thing a class could add is **overflow** — collapsing what
  does not fit into a menu, which GTK4 gives no help with and nothing here needs
  while the IDE's own window has a 1100px floor.
- **No `ToolButton`.** `Button` already does all of it: set `Text` and `Icon`
  together and it builds the box itself, `Icon` alone gets the `image-button`
  treatment, and `Style = "flat"` is the rest. A second class with the same two
  properties, differing in nothing, is the `ListBox`/`ListView` confusion by
  another name.
- **No `MenuButton`.** A button that drops a menu is a `Button` with a `Menu` and
  one line: `Btn_Click() { this.Btn.PopupMenu(0, 0); }`. That is how the IDE's own
  tab-strip button works. A `GtkMenuButton` would add the drop-down arrow (an icon
  here), and announcing itself as a menu button to a screen reader — real, but
  unverified, and not worth a second way to attach a menu to a widget.

## What is next

1. **What the debugger costs when it is off.** The debugger itself is built and
   complete in function — breakpoints and conditional ones, the three steps, the
   stack with a frame you can stand in, values by name, watches, the immediate
   box, and stopping where an uncaught exception was thrown. What is left is a
   number: the branch per opcode that makes it possible measures 12–16 % with the
   debugger *off*, which is why it is scaffolding. The bytecode patch that
   replaces it — a software breakpoint, the `0xCC` of gdb — is designed in
   [docs/debug-plan.md](docs/debug-plan.md), along with DAP, written down as the
   plan to evaluate rather than the thing to build first.

2. Packaging an application for distribution without the project tree. *Export
   project* is not that and does not replace it: it hands over the tree itself,
   which is the question that comes before this one.

3. **A live preview of a component in the designer.** A component is a class in
   the *project's* process, so the designer places a stand-in reading `[Chart]`
   and a `design` block gives it sample data. Teaching the designer to instantiate
   a project's own components would fix it for every component at once, which is
   why it is not the chart set's problem — see [docs/ide.md](docs/ide.md).

Records over a database — a form bound to a table, the way every tool in this
family does it — is designed but **deliberately not built**: what stage one would
deliver on its own is a form showing a single record, against a good deal of
machinery. The design, the prior art it comes from and the alternatives that were
refused are written down in [docs/data-plan.md](docs/data-plan.md), so that
picking it up does not mean having the conversation again.

---

## Licence

MIT — see [LICENSE](LICENSE).

QuickJS-ng, vendored under `vendor/quickjs`, is MIT as well and carries its own
[LICENSE](vendor/quickjs/LICENSE); its copyright notice has to travel with any
copy of it, which is what that file is for. Nothing else is bundled: GTK4,
GtkSourceView and VTE are linked against and belong to their own projects.
