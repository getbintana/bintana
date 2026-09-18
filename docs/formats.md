# File formats

A project is a directory. Nothing is generated, nothing is compiled, and every
file in it is meant to be readable and editable by hand as well as by the IDE.

```
myproject/
  project.json          what to run and in which order
  MainForm.form         a widget tree
  MainForm.js           its behaviour
  Util.js               a module: plain classes and functions
  widgets/              folders, as deep as you like
    Stepper.form
    Stepper.js
  app.css               optional: the application's own look
  icons/                optional: the application's own icons
  po/                   optional: es.po, pt_BR.po — the translations
```

`po/` is found the way `icons/` and `app.css` are, by name. The `.po` and not a
compiled `.mo`, because nothing in a project directory is generated — and because
`.po` is the file every translation tool already edits. The IDE lists the
catalogues in the project tree and hands one to that tool rather than opening it
itself; see [resources.md](resources.md).

`app.css` is found the way `icons/` is — by name, with nothing in `project.json`
pointing at it. It is loaded once at startup, above the desktop's theme and below
the per-widget `Background`/`Foreground`/`Font`, and its classes are what a
control wears through `Style`. A rule GTK cannot parse is reported on stderr with
its line and the rest of the sheet is kept.

A class is found by its **name**, from anywhere: `Widget.New("Stepper")` and a
`.form` node of `"type": "Stepper"` both mean *the* Stepper of this project, and
the runtime looks for `Stepper.form` throughout the tree.

## Namespaces

A folder full of classes can put them under one name:

```js
/* Widgets/Stepper.js */
Namespace("Widgets");

Widgets.Stepper = class Stepper extends Component {
    Up_Click() { this.Value = this.Value + 1; }
};
```

```json
{ "type": "Widgets.Stepper", "name": "Step1", "properties": { "Value": 5 } }
```

A namespace is an ordinary object on `globalThis` and nothing more — no module
system, no imports, no compile step. `Namespace("A.B")` nests, creating both.
What it buys is that two folders may each have a `Stepper`.

The namespace is declared **by the code**, not deduced from the directory: the
runtime obeys what the file says. Nothing requires a folder to be a namespace,
and the IDE asks before making one — it just keeps the two in step afterwards,
because that is a sane convention. It never asks for `forms/`, `components/`,
`modules/` or `po/`: those are folders a *tool* named, and a name nobody chose is
not a namespace. The IDE's own twenty classes live in `modules/` and answer to
`Ide.Designer`, `Ide.TabSet` and so on, because their files say `Namespace("Ide")`
— which is this paragraph, working.

### How a name resolves

| written | resolved by |
|---|---|
| `Stepper` | the global lexical scope — a top-level `class` binds there, not onto `globalThis` |
| `Widgets.Stepper` | a walk down properties from `globalThis`; no `eval` is involved |

And its `.form` is looked for in this order:

1. the qualified name, matched against the path (`Widgets/Stepper.form`);
2. failing that, the bare last segment — so a class that calls itself
   `Widgets.Stepper` still finds its file when the file sits elsewhere.

For a **bare** name, the file nearest the project root wins. A class in no
namespace conceptually lives at the top, so a project holding both
`Stepper.form` and `Widgets/Stepper.form` resolves a plain `Stepper` to the
first and `Widgets.Stepper` to the second. Putting one class in a namespace
never breaks the one that was already there.

Two files at the **same depth** with one name is a genuine ambiguity: neither is
"the" one, the runtime refuses to load either and says so, and the IDE warns as
soon as it lists the files. Qualifying the name is the way out.

## project.json

```json
{
  "name": "Bintana IDE",
  "version": "0.1.0",
  "startup": "MainForm",
  "sources": ["AskForm.js", "ConfirmForm.js", "Designer.js", "MainForm.js"],
  "uses": [],
  "description": "optional, free text"
}
```

| Key | Meaning |
|---|---|
| `name` | `Application.Name`, and the folder under `~/.config/bintana` that `Application.ConfigDirectory` points at |
| `version` | `Application.Version`; free text, optional. What the project calls its own release — not the runtime's, which is `BTA_VERSION` |
| `startup` | the class instantiated and shown at launch |
| `main` | a **function** to call instead, for a project with no window (below). Excludes `startup` |
| `sources` | `.js` files to evaluate, in this order, as paths relative to the project (`"widgets/Stepper.js"`) |
| `uses` | libraries of shared classes to load **before** the project's own sources (`["charts"]`) — see [Libraries](#libraries-uses) |
| `description` | not used by the runtime; the IDE writes it and leaves it alone |
| `launch` | how the project is run, as named configurations — arguments, working directory, environment (below). **Read by the IDE and not by the runtime**, which takes its arguments from the command line like any program |

Without `sources`, every `.js` under the project is loaded — subdirectories
included — sorted by path, so at least the order is reproducible. **An empty list
is the same as no list**: `collect_sources` falls back to the directory scan when
what it built is empty, so `"sources": []` loads exactly what the missing key loads.
Worth knowing before writing code that asks whether a project has one — an
`Array.isArray` check calls an empty list a list, and the IDE used to, which would
have frozen the load order of a project that had asked for the scan. It *matters* whenever one class is named while another is being **declared**, and
that is two cases rather than one. `extends` is the obvious one: the parent has to
be evaluated first. The other is a **static field that mentions a class**, which
runs at declaration just the same — `Lines: Field.List(Line)` in a `Record` is a
`ReferenceError: Line is not defined` if `Line`'s file comes second, with the
traceback pointing at the declaration and nothing pointing at `sources`.
[`examples/quote`](../examples/quote) is the case in the tree: `Quote.js` before
`QuoteForm.js`, and `Line` before `Quote` inside it. Where the order cannot be
arranged, `Field.List(() => Line)` defers the mention to the first use instead —
see [runtime-api.md](runtime-api.md#a-record-inside-a-record). Creating a form from
the IDE registers it in `sources`, and without that entry the class silently never
loads.

### `launch`: how the project is run

```json
"launch": [
  { "name": "Demo",
    "arguments": ["--data", "demo/facturas"],
    "directory": "",
    "environment": ["BTA_DEMO=1"],
    "strict": true,
    "stoponthrow": false }
]
```

| Key | Meaning |
|---|---|
| `name` | what the *Project → Run configuration* menu shows. Required, and its own |
| `arguments` | handed to the project as `Application.Arguments`, one entry per argument — not one string to split, because a path with a space in it is ordinary |
| `directory` | where the child starts. Empty is the project's own, which is what most want |
| `environment` | `NAME=value`, one a line. A **change** and not a replacement: what is not named here is inherited, since a child that lost `HOME` would not start |
| `strict` | run it with [`--strict`](plans/strict-plan.md) |
| `stoponthrow` | the debugger stops where something is thrown |

**Versioned on purpose.** *What this project needs in order to start* is a fact
about the project and not about whoever opened it, so it sits beside `sources`
and `uses` and the whole team gets it. Two things that are **not** here, because
they are not that: which configuration you have chosen, and the IDE's *run
strictly anyway* tick. Both are yours, both are in `Settings`, and neither is
committed.

**The switches are copied, not inherited.** The IDE keeps a global *suggestion*
— which switches a new configuration should start with — and copies it in when
one is made. Changing the suggestion afterwards changes nothing that exists,
which is `git init`'s pattern rather than `git config`'s, and `/etc/skel`'s for a
new account. What it buys is that this file says what will happen, whole: nothing
in it depends on the machine of whoever reads it.

A project with no `launch` is the ordinary case and runs exactly as it always
did: its own directory, no arguments.

### `main`: a project with no window

```json
{ "name": "runner", "main": "Main" }
```

A project declares `startup` or it declares `main`, and the difference is whether
it draws. `main` names a function, it is called with no arguments once the sources
are loaded, and **GTK is never initialised**: the program runs with no display,
which is what a tool run over ssh, from a hook or inside CI needs.

It is for the work *around* an application — a test runner, a build step, a tool
that reads the desktop's icon themes off the disk. Those were shell scripts, and a
shell script is a second language in the repository with a second set of rules.

The program ends when nothing is owed an answer: no child running, no timer armed,
no file watched. So a `main` that prints and returns ends by returning, and one
that spawns something waits for it without being told to — the bargain node makes,
and the only one under which both shapes are written the obvious way.
`Application.Quit(code)` ends it at any point, and is the only way to end it with a
status.

Everything a form needs is still declared — the widget classes, `Form`, `Timer` —
but there is no display to build one on: `new Form()` in a console project is a
GTK error, not a Bintana one. `Application.HasIcon` answers `false`,
`Application.Icons()` answers empty and `File.Info(path).Icon` answers `""` for
the same reason — all three resolve against the icon theme — and that is a fact
about the display rather than about the desktop. The other four fields of `Info`
answer normally. A tool that asks what icons exist has to
read the themes off the disk, which is what it wanted anyway (see
[testing.md](testing.md)).

A missing `project.json` is not fatal: the IDE will open the directory and say the
project cannot run. Neither is a broken one: the IDE reads it as a `Record` (see
[ide.md](ide.md#projectjson-as-a-record)), reports everything wrong with it in the
console, and opens the project anyway — refusing would leave the one program that
can fix the file unable to open it. A key the runtime does not know is left
untouched when the IDE saves, so a manifest from a newer version survives an older
one editing it.

## Libraries: `uses`

**A library is a directory of `.js` and `.form` files.** No manifest, no version,
no dependencies of its own: what a project was short of is a place to keep shared
*classes*, and a directory of them is the whole of what that takes.

```json
{ "name": "Sales", "startup": "MainForm", "uses": ["charts"] }
```

Its sources are evaluated **before** the project's own -- a project's class may
extend a library's and never the other way round -- and **its forms are indexed
with the project's**, which is what lets a form say `"type": "Chart"` about a
class that is not in the project tree.

Everything a project can have beside its classes, a library can have too:

| | |
|---|---|
| `<lib>/project.json` | **only `sources` is read from it**, and only to order the library's own `.js`. A library with one class needs none; one whose classes extend each other does, because `BarChart extends Chart` sorts the wrong way round by path. Reusing the name and the key is the whole mechanism -- there is no second manifest format. Nothing else in that file means anything, and `bintana <library>` is not a thing to do |
| `<lib>/po/<lang>.po` | its own catalogue, read **before** the project's. One table and several files, so a project that translates a string a library also translates has the last word; a language only a library ships is still offered by `Locale.Available` |
| `<lib>/icons/` | on the icon search path after the project's, so a project can put its own drawing over a library's by shipping the same name |
| `<lib>/app.css` | **not** read. A stylesheet belongs to an application: a library that restyled every `button` in the program would be the one thing here that cannot be overruled |
| `<lib>/<name>.<suffix>` | **the native half**: a plugin, named after the directory and loaded before the library's `.js` so it can install a global the JavaScript then wraps. `so`, `dll` or `dylib` by platform. A directory with none is an ordinary JavaScript library; one that is there and cannot be used stops the program. See [plugins.md](plugins.md) |

### Where a library is looked for

Six places, most specific first. `lib_candidates` in `bta_runtime.c` is the list
and carries the reasons; this is the summary:

| | |
|---|---|
| `<project>/lib/<name>` | the project's own copy, or a library private to it |
| `$BINTANA_LIB_PATH` | colon separated. Developing a library that is in neither tree yet |
| `~/.local/share/bintana/lib/<name>` | installed for one person, without root |
| `<binary>/../lib/<name>` | **the source tree**, uninstalled |
| `<binary>/../share/bintana/lib/<name>` | installed beside the binary |
| `/usr/share/bintana/lib/<name>` | a distribution's, with the binary elsewhere |

**The two that resolve from the binary are the same relative hop**, and that is
the point: `bin/` and `share/bintana/` move together under `--prefix` and under a
packager's `DESTDIR`, where a path baked in at configure time does not. It is the
argument [`tools/bintana-ide.in`](../tools/bintana-ide.in) already makes for the
launcher, applied inside the runtime -- and it is what makes
`./build/bintana examples/charts` find `lib/charts` in the source tree with nothing
configured and nothing installed. The order otherwise follows the icon theme's,
which this codebase already walks in `tests/icons`: the user's own, then the
system's.

A name that is not found **stops the program**, printing every path it tried.
Carrying on would fail a moment later with `unknown widget type 'Chart'`, which
says nothing about a missing library.

**The search is published in both directions**, which is what lets a tool write
this key rather than only read it: `Application.LibraryPath(name, [project])`
resolves one name, and `Application.Libraries([project])` says which names those
six places offer — sorted, each once, the nearest copy winning exactly as `uses`
would resolve it. The IDE's project dialog ticks them off the second one; it is
in the runtime because a second copy of a six-entry search path drifts, and the
copy that drifts is the one nobody runs from a shell.

Three ship here. `lib/charts` is [`examples/charts`](../examples/charts)' chart
component, `lib/report` is the banded `Report` that
[`examples/report`](../examples/report) draws a statement of account with, and
`lib/markdown` is the document viewer
[`examples/markdown`](../examples/markdown) reads its own guide in. All three
use none of the three optional files, which is the ordinary case for a library of
one class. What they publish is documented like the runtime's own surface, in
[llm/charts.md](llm/charts.md), [llm/report.md](llm/report.md) and
[llm/markdown.md](llm/markdown.md), and
`tests/api.sh` holds those pages to the same completeness rule it holds
`llm/controls.md` to: **a library that ships with the runtime is part of the
contract**, and a property nobody wrote down is a property nobody can use.

Completeness is not correctness, though, and for a library that draws, the page
being complete says nothing about the drawing being right: `tests/report` and
`tests/markdown` are the other half, and each asserts what landed on the page off
`DrawingArea.Dump()`.

## The .form format

Pure JSON, and the loader knows no control in particular.

```json
{
  "format": "bintana-form/1",
  "class": "MainForm",
  "properties": { "Text": "Hello", "Width": 420, "Height": 260 },
  "actions": [ ... ],
  "menus": [ ... ],
  "children": [ ... ]
}
```

| Key | Meaning |
|---|---|
| `format` | `"bintana-form/1"`. Written by the serialiser; not enforced on load |
| `class` | the class this file belongs to. The constructor looks for `<Class>.form` by name, in any folder of the project |
| `properties` | assigned to the form itself |
| `actions` | commands a button, a menu item and a key point at; forms only. **Before `menus`**: both a menu item and a control may name one |
| `menus` | see below; forms only |
| `children` | the widget tree |

A child node:

```json
{
  "type": "Button",
  "name": "BtnSave",
  "properties": { "X": 20, "Y": 96, "Width": 120, "Height": 36, "Text": "Save" },
  "children": []
}
```

- `type` is a class name, resolved by `Widget.New`: the runtime's widgets first,
  then the project's own classes -- which is how a component appears in a `.form`
  as an ordinary type. A project's classes live in the global lexical scope and
  never land on `globalThis`, so looking one up there would find nothing.
- `name` becomes `widget.Name`, is exposed on the form as `this.<name>`, and is the
  prefix of its handlers. It has to be a valid JS identifier.
- `properties` are applied **in the order written**, as plain assignments. Order
  can matter: `Value` before `Max` on a `SpinBox` would be clamped, which is why
  the factory range is wide, and `Arrangement` is written first by the serialiser
  so that every coordinate and size after it is read in the layout it was meant
  for. Re-arranging a container that already holds children is legal and keeps
  them (see [widgets.md](widgets.md#panel-and-the-boxes)); what the ordering buys
  is that a `Fixed` node's `X`/`Y` are not applied to a box on the way in.
- `children` nest to any depth. A container's children are added to it, not to the
  form.
- `design` is the other dictionary a node may carry: see below.

### `design`: what the designer shows, and the application never does

```json
{ "type": "Label", "name": "LblStatus",
  "properties": { "Text": "{0} files, {1} unsaved" },
  "design":     { "Text": "12 files, 2 unsaved" } }
```

`properties` is what the application will run with; `design` is what the
*designer* should show, so a form whose text the code fills in can still be laid
out. Android's `tools:` namespace is the same idea, and `strip` above is the
precedent for a node key that is neither a type nor a property.

**A design value cannot reach a running application**, and structurally rather
than by a check: the only code that applies one is `Container.AddNode(node,
true)`, the designing branch, and the C loader has no idea the key exists.

**It is worth whatever the property is worth**, not only text: the block is
applied over `properties`, so anything settable can carry one. A list that is
filled at run time is the case that needs it — `"design": { "Items": ["Ana",
"Beto"] }` on a `ListBox`, `"design": { "Count": 3 }` on a `TableView`, which is
its on-demand mode and draws that many rows under the headings.

The IDE's property grid edits this block behind its *Design values* switch, and
its sample button fills one with **literal words** — so the file holds text
rather than a token the loader would have to understand.

### `item`: what a list holds while it is being designed

```json
{ "type": "RowList", "name": "Contacts",
  "properties": { "X": 16, "Y": 48, "Width": 380, "Height": 200 },
  "item":       { "of": "Partes.Chip", "count": 3 } }
```

A list is filled by the program, so a designer draws it as an empty box — and a
form is laid out *around* one: how tall a row is decides whether what sits under
the list collides with it. `item` names a **component** and how many of it to
draw. Android's `tools:listitem` is the same idea; pointing at a class rather
than at a layout file is the one change, and it is what lets the form's own code
build the same thing, so the drawing and the program are one widget instead of
two that drift.

**A key of its own and not a design value**, which is forced rather than chosen:
`design` is applied over `properties` by `AddNode(node, true)`, so a key that is
not a property throws there and the control falls back to a stand-in. `strip` is
the precedent for a node saying something that is neither its type nor a
property.

[`examples/contacts`](../examples/contacts) is the one that has one, and it is
worth reading as the argument for the shape: its row used to be a forty-line
`row(contact)` method — a class with the word `class` left out — and is a
`Contact` component now, so the designer draws the same class the program builds.
The row's own labels carry `design` values, which is what puts a plausible name
and city in the drawn rows.

**The runtime carries it and applies nothing.** It is written by the serialiser
(`SetItem`/`Item`) so the key survives a round trip through a designer that
opened the file — a designer cannot put it back by itself, because `Serialize`
recurses past anything nested. While it is set the serialiser writes **no
children** for that container, so a save can never turn three drawn rows into
three real ones.

### Prose, and the catalogue

The loader looks every property the control's class declares as prose up in
`po/<lang>.po` on its way in, so a `.form` needs no markup for a translated
application. Menu `text` labels go through it too.

Which properties those are is the class's own declaration — `Widget
.TextProperties()` publishes it — and never a rule about the name, because
`SourceEditor.Text` is source code and `Style` is a class name. See
[resources.md](resources.md).

The serialiser writes the **declared** value back, not the translated one. That
matters more than it sounds: it reads the current value of every property, so
without a note a form opened in Spanish and saved would come back with the
Spanish in it and the original gone — the same shape as rule 5 below, where
saving an allocation turned a measurement into a floor.

The parent-then-position order is load-bearing in the other direction too: a
widget must be attached to its parent **before** `X`/`Y` are applied, or the
coordinates never reach a live `GtkFixed`. The loader and `Container.AddNode()`
both do it in that order.

A form with no `.form` file is legal — it is built from code, and that is what
`tests/widgets` does for its round-trip check.

Note that the sentence about `GtkFixed` above is now `BtaFixed`, but the order is
the same rule.

### `strip`: the one child that is not a page

A child of a `Notebook` may carry **`"strip"`** — `"Start"` or `"End"` — which
puts it in the tab strip rather than making it a page:

```json
{ "type": "Button", "name": "TabActions", "strip": "End",
  "properties": { "Tooltip": "Tab actions", "Menu": [ ... ] } }
```

(No `Icon` here on purpose: a `.form` can name only one, and a name the desktop
lacks is dropped in silence. The IDE picks this button's icon in code from a list
of candidates and falls back to a glyph — see [the IDE](ide.md#tabs).)

A `Switcher`'s pages have no such thing: its strip is a segmented control and
there is nowhere in it for a widget to go, so `Tabs` — a list of plain strings —
is all a switcher's strip can be, and the whole of it.

It is the only place a child node says *where* it goes and not just what it is,
and it exists because a notebook's `children` **are** its pages by definition:
there was no word for the other thing a notebook can hold. Without one, a strip
widget could only be put there from code and the next save deleted it — silently,
which is the worst kind, and which is what stopped the IDE's own window from
surviving a round trip through its own designer.

The loader calls `SetAction()` for it rather than attaching it, so whatever that
method does about adoption and lifetimes it does here too; `Notebook.Serialize()`
asks `GetAction()` for both ends and writes them back with the marker. `Count`
and `Children` go on meaning pages throughout.

### Actions

A command several places point at, declared once:

```json
"actions": [
  { "name": "ActDelCtl", "text": "Delete control", "icon": "edit-delete",
    "shortcut": "Delete", "enabled": false }
]
```

| Key | Meaning |
|---|---|
| `name` | required. It becomes `this.<name>` and `<name>_Click`, exactly as a menu item's does |
| `text` | the label a control or a menu item takes when it declared none. **Translated**, once, however many places show it |
| `icon` | likewise |
| `shortcut` | an accelerator, or a list of them |
| `enabled` | `false` for a command that starts unavailable — which a command needing a selection does |

A control names one with the ordinary property `"Action": "ActDelCtl"`, and a
menu item with `{ "action": "ActDelCtl" }` **instead of** a `name` — an item that
points at a command is not one, so it has nothing to name. The block comes
before `menus` because the loader reads it first.

The behaviour, and what it refuses, is in
[widgets.md](widgets.md#action-one-command-in-several-places).

### Menus

Menus are declared on the form, next to its controls:

```json
"menus": [
  { "name": "MnuFile", "text": "_File", "children": [
      { "name": "MnuSave", "text": "Save", "shortcut": "<Control>s" },
      { "separator": true },
      { "name": "MnuRecent", "text": "Recent", "dynamic": true },
      { "name": "MnuQuit", "text": "Quit", "shortcut": ["<Control>q", "<Control>w"] }
  ]}
]
```

| Key | Meaning |
|---|---|
| `text` | the label. `_` marks the mnemonic, GTK style |
| `name` | required for a leaf: it becomes `this.<name>` and `<name>_Click` |
| `children` | makes it a submenu; a submenu needs no name |
| `separator` | `true` for a rule between items |
| `shortcut` | an accelerator, or a list of them |
| `dynamic` | `true` for a submenu whose entries the application assigns |
| `check` | `true` for an item that ticks on and off; `Value` is the tick |
| `radio` | `true` on a `dynamic` item: marks the entry chosen, and `Value` is its index |

The IDE edits this block with `Ctrl+M` rather than by hand; see
[ide.md](ide.md#the-menu-editor).

Implementation notes that leak into the format:

- A separator is not an item. GMenu has no such thing: each run of items between
  separators becomes one *section*, and the sections are what draw the rules.
- Each item is one `GSimpleAction` in a per-window group named `form`, so two forms
  can use the same item names.
- A `dynamic` item's action takes the entry index as its parameter, which is why
  its entries need no names of their own and why `Click(index)` takes one.
- What draws a tick or a radio mark is the *action*, not the item: a boolean state
  and no parameter is a tick, an index parameter with a state is a mark. So the
  four kinds differ only in how the action is declared, and `radio` without
  `dynamic` is refused rather than drawing an item whose mark can never appear —
  there would be no entries to mark. `check` together with `dynamic` is refused
  for the mirror reason: a dynamic item's state is *which* entry, which is `radio`.
- An accelerator can only name a command that takes no argument, so `dynamic` and
  `radio` items have none: which of their entries would it press?
- Labels of `dynamic` entries are **data**: `bta_menu.c` doubles any `_` so a
  project called `foo_bar` reads as `foo_bar` instead of losing the `b` to a
  mnemonic. Text declared in the `.form` keeps mnemonic behaviour.

## Serialisation rules

`Form.prototype.Serialize()` produces the whole file; `Widget.prototype.Serialize()`
one node. They are the exact inverse of the loader, and what to write is
*discovered*, never listed:

1. Walk the prototype chain for accessors with **both** a getter and a setter.
   Read-only ones (`ListBox.Count`, `Editor.Line`, `Container.Children`) are
   skipped because the loader could never assign them back.
2. Skip values equal to a freshly constructed control's, so a file says only what
   was actually changed. The comparison instantiates one bare control per type,
   once, and caches it.
3. Skip `Name` (written as the node's `name`), `Caption` (an alias of `Text`, which
   would be written twice) and `Modified` (editing state, not design state).
4. Skip `X`/`Y` unless the parent lays out by coordinate -- which a box, a
   `Grid`, a `Flow`, a `RowList` and an **`Overlay`** do not: a layer of a stack
   is placed by `HAlign`/`VAlign`/`Margin`, so a hand-written file carrying
   coordinates on one loses those two numbers the first time it is saved.
   `Container.Placement` is the property that answers which model a container
   uses, and the designer's grid greys the rows and says why.
5. Skip `Width`/`Height` for a child of a box **unless one was declared** -- see
   below.
6. Write `Arrangement` first when present, so the sizes and coordinates that
   follow it are applied in the layout they belong to. Not because the property
   refuses to be set later -- it does not, and re-arranging keeps the children.
7. Only strings, numbers, booleans and arrays are written. Anything else (a widget
   value, an object) is not representable and is left out.
8. `menus` are written back from the spec the loader was given (`Form.Menus`),
   before `children`. They cannot be read back from GTK -- a GMenu has no nesting
   left, its separators are section boundaries and its items are actions -- so the
   spec is kept for exactly this reason. Without it, saving a form from the
   designer dropped its whole menu bar, silently.

Consequences worth knowing: `DragData`, `AcceptDrop` and `Tooltip` are ordinary
properties, so they round-trip through the `.form` and appear in the designer's
grid like everything else. `Menus` is read-only, which is what keeps it out of
`properties` and at the top level where it belongs.

### Sizes in a box

Rule 5 is the one that had to be learnt. Inside a container that lays out by
coordinate, a size is the design and belongs in the file. Inside a **box** it is
a *request* -- a floor -- and the box decides the rest.

`Width` and `Height` report the **allocation** when nothing was declared, which
is what makes them worth reading and dangerous to write down: saving what a
control happened to measure turns today's measurement into tomorrow's minimum.
The IDE's own notebook page measured 427 tall while a file was open, and once
saved it kept 427px of blank under the tab strip in the designer, at every window
size, with nothing on screen to say why.

So the serialiser asks `SizeRequest()` -- what was asked for, `-1` on an axis
nobody declared -- rather than the properties. A control that did ask keeps its
size: a 34px button in a toolbar is a decision, not a measurement.

## The icons directory

`<project>/icons` is added to the GTK icon search path at startup, at the **end**,
so an application cannot shadow the desktop's icons. The layout is flat:

```
icons/bta-button-symbolic.svg   ->  Icon = "bta-button-symbolic"
```

A name ending in `-symbolic` is recoloured by GTK to follow the text colour, which
is what makes one drawing work on a light theme, a dark theme, and inverted on a
selected button. For that the art has to be **fills**: the recolouring forces
`fill`, so a `stroke` keeps the colour written in the file.

Prefer the desktop's own icon and keep yours as the fallback, chosen with
`Application.HasIcon()`. That predicate renders the icon and looks for ink, because
a theme's index can claim a name it does not ship (GTK hands back `image-missing`)
or ship an SVG that renders to nothing — art placed outside the frame with no
`viewBox`. On the machine this was written on, four of nine "universal" desktop
names fail one way or the other.
