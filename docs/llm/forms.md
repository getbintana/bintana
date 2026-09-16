# Forms

## project.json

```json
{
  "name": "Notes",
  "version": "1.0",
  "startup": "MainForm",
  "sources": ["Util.js", "AskName.js", "MainForm.js"],
  "description": "optional, free text"
}
```

| Key | Meaning |
|---|---|
| `name` | `Application.Name`, and the folder under `~/.config/bintana` the settings go in |
| `version` | free text, optional. `Application.Version` reads it back; `""` when absent. **Not** the runtime's version, which is `BTA_VERSION` |
| `startup` | the class instantiated and shown at launch. A `Form` subclass |
| `main` | a **function** to call instead, for a tool with no window. Excludes `startup` |
| `sources` | the `.js` files to evaluate, **in this order**, as paths relative to the project |
| `uses` | libraries of shared classes, by name (`["charts"]`). Their `.js` loads before yours and their forms are found like yours, so a `.form` may use their classes. A name that is not installed stops the program and says where it looked |
| `description` | free text; the runtime ignores it |

Without `sources`, every `.js` under the project is loaded, subdirectories
included, sorted by path. An empty list means the same as no list.

**Declare `sources` whenever one class extends another of the same project** —
including every dialog that extends `Form`, if you want a load order you can
reason about. A class whose file is never evaluated does not exist, and the
symptom is a `ReferenceError` from the loader with no other clue.

**`sources` evaluates code and nothing else.** Everything a project *finds* is
resolved against the directory being run: a class's `.form` is looked for under
that directory, and `Application.Directory` is that directory. So listing
`"../MainForm.js"` gets you the class and not its window — the `.form` is not
found, every `this.<control>` is `undefined`, and **nothing says so**, because a
form with no `.form` is legal and built from code. A second project that drives an
application has to bring the `.form` and the data files with it, by copy or by
symlink. See [validation.md](validation.md#2-make-it-check-itself).

### A tool with no window

```json
{ "name": "report", "main": "Main" }
```

`main` names a function, called once with no arguments after the sources load.
**GTK is never initialised**: no display is needed, which is what makes this the
right shape for something run over ssh, from a hook, or in CI. `new Form()` in
such a project is an error.

The program ends when nothing is owed an answer — no child running, no timer
armed, no file watched. `Application.Quit(code)` ends it with a status.

## The .form file

Pure JSON. The loader knows no control in particular: it applies each entry of
`properties` as an ordinary assignment, through the widget's real setter.

```json
{
  "format": "bintana-form/1",
  "class": "MainForm",
  "properties": { "Text": "Notes", "Width": 640, "Height": 420 },
  "menus": [ … ],
  "children": [
    { "type": "TextBox", "name": "TxtName",
      "properties": { "X": 12, "Y": 12, "Width": 300, "Height": 34,
                      "HAlign": "Fill", "Placeholder": "Search…" } },
    { "type": "Panel", "name": "Toolbar",
      "properties": { "X": 0, "Y": 0, "Width": 640, "Height": 44,
                      "Arrangement": "Horizontal", "Spacing": 6,
                      "Style": "toolbar", "HAlign": "Fill" },
      "children": [
        { "type": "Button", "name": "BtnNew",
          "properties": { "Text": "New", "Icon": "document-new-symbolic",
                          "Style": "flat" } }
      ] }
  ]
}
```

| Key | Meaning |
|---|---|
| `format` | `"bintana-form/1"`. Write it; it is not enforced on load |
| `class` | the class this file belongs to. A class finds `<Class>.form` by name, anywhere in the tree |
| `properties` | assigned to the form itself |
| `menus` | the menu bar; forms only. See [Menus](#menus) |
| `children` | the widget tree |

A child node:

| Key | Meaning |
|---|---|
| `type` | a class name: a runtime control, or one of the project's own components |
| `name` | becomes `Widget.Name`, is exposed as `this.<name>`, and prefixes its handlers. Must be a valid JS identifier, unique on the form, and **not something a `Form` already answers to** — `Actions`, `Menus`, `Controls`, `DefaultButton` and `CancelButton` are read-only, so a control called one of them binds to nothing and the form refuses to load, saying which. The same rule holds for a **menu item** and a **command**: all three blocks bind what they name on the form, by name, in the same way |
| `properties` | applied **in the order written** |
| `children` | nested, to any depth. A container's children are added to it |
| `design` | what the *designer* shows instead; unreachable from a running application |
| `strip` | `"Start"` or `"End"`, on a child of a `Notebook` only: puts it in the tab strip instead of making it a page |

**Order inside `properties` can matter.** Two rules cover it:

- A range before a value: `Min` and `Max` before `Value` on a `SpinBox` or a
  `Slider`, or the value is clamped to the factory range on its way in.
- `Arrangement` first, which is what the serialiser writes and the habit to
  keep, so that the coordinates and sizes after it are read in the layout they
  were meant for.

A form with no `.form` file is legal; it is built from code.

### design values

```json
{ "type": "Label", "name": "LblStatus",
  "properties": { "Text": "{0} files, {1} unsaved" },
  "design":     { "Text": "12 files, 2 unsaved" } }
```

`properties` is what the application runs with. `design` is what the designer
should show, so a label the code fills in can still be laid out. It cannot reach
a running application. `this.LblStatus.Fill(files.length, dirty.length)` fills
the declared template at runtime.

## Behaviour: one class, methods named after events

```js
"use strict";

class MainForm extends Form {

    Form_Open() {
        this.TxtName.SetFocus();
        this.reload();
    }

    BtnNew_Click() { … }

    TxtName_Change() { this.List.Refilter(); }

    /* Returning true keeps the window open. Returning nothing lets it close. */
    Form_Close() {
        if (!this.dirty) return;
        Confirm.ask("There are unsaved changes.", "Quit",
                    () => Application.Quit(0));
        return true;
    }

    /* Not an event: an ordinary method, called from the ones above. */
    reload() { … }
}
```

- A method named `<Control>_<Event>` is connected by name. Nothing else is.
- The form's own events are `Form_Open`, `Form_Close`, `Form_Resize` —
  **literally `Form_`**, whatever the class is called.
- `this.<name>` is any named child of the `.form`, and any menu item.
- Ordinary state goes on `this`. There is no model layer imposed on you.
- A handler that returns a value matters in exactly four places: `Form_Close`
  (`true` vetoes), `KeyPress`/`MouseWheel` (`true` consumes), `TableView`'s
  `Data` (the cell) and `RowList`'s `Filter` (`false` hides the row).

### Events on every widget

`MouseDown(x, y, button, ctrl, shift)`, `MouseUp(…)`, `MouseMove(…)`,
`MouseEnter(x, y)`, `MouseLeave()`, `MouseWheel(dx, dy)`,
`DblClick(x, y, button, ctrl, shift)`, `KeyPress(key, ctrl, shift, alt)`,
`KeyRelease(…)`, `GotFocus()`, `LostFocus()`, `Drop(data, x, y)`.

Coordinates are relative to the widget itself. Returning `true` from `KeyPress`
consumes the key; returning `true` from `MouseWheel` stops the scroller around
it from also moving.

**The two key events are asymmetric on anything that edits text.** A `TextBox`
claims the press of a printable key — that press *is* the typing — so `b`
arrives as `KeyRelease` and never as `KeyPress`, while `F5` and `Escape` arrive
as both. To watch typing, use `Change`.

Each control's own events are in [controls.md](controls.md). `w.EventNames()`
answers at runtime, most derived first.

## The layout model

**Coordinates by default.** A form's slot and a `Panel` lay out by `X`/`Y` and
`Width`/`Height`, which is what a drawn form is. `Arrangement` chooses
otherwise:

| `Arrangement` | |
|---|---|
| `"Fixed"` (default) | absolute coordinates |
| `"Horizontal"` | a row; `X`/`Y` mean nothing, `Spacing` and `Homogeneous` do |
| `"Vertical"` | a column, likewise |

There is no separate box class: a container arranged as a row *is* one. It may be
changed at any time — the children are kept in order, and going back to `Fixed`
restores their coordinates. Not every container accepts it: `Grid`, `Flow`,
`RowList`, `Overlay`, `Notebook` and `Switcher` arrange by their own nature and
refuse it, and so does an `AspectFrame` — `Placement` is the read-only property
that answers for all of them.
See [controls.md](controls.md#container--inherited-by-every-container).

**In an `Overlay` the children are layers**, and a layer is placed by
`HAlign`/`VAlign`/`Margin`: the first child fills, and one that says nothing
fills too. `X`/`Y` mean nothing there and **are not written**, so a file
hand-written with coordinates on a layer loses them the first time the form is
saved. The order in the file is the stack, bottom first.

**`Width`/`Height` are a minimum, not an exact size.** A control whose natural
size exceeds the request renders larger — a `Label` with long text will. This is
GTK's model. `Bounds()` reports what was really allocated.

### Controls that follow the window

Every control says with `HAlign`/`VAlign` what becomes of it when its container
is not the size the coordinates were written for.

| | on coordinates, when the container grows | in a row, column, split or page |
|---|---|---|
| `Auto` (default) | stays put, as `Start` | fills the cell, as `Fill` |
| `Start` | keeps its distance to the left/top edge | against the near edge, its own size |
| `End` | keeps its distance to the right/bottom edge — slides | against the far edge, its own size |
| `Fill` | keeps both — stretches | takes the whole cell |
| `Center` | keeps the proportion — moves half the slack | centred, its own size |

So: an OK button that stays in its corner is `HAlign: "End", VAlign: "End"`. A
text box that grows with the window is `HAlign: "Fill"`. A list that takes
whatever room is left is `"Fill"` on both.

**On a stretched axis the drawn size stops being the floor**, so the window can
be made smaller than the form was drawn. `MinWidth`/`MinHeight` are the floor,
and they only mean anything on an axis that stretches.

```json
{ "type": "ListBox", "name": "List",
  "properties": { "X": 12, "Y": 56, "Width": 616, "Height": 300,
                  "HAlign": "Fill", "VAlign": "Fill",
                  "MinWidth": 200, "MinHeight": 80 } }
```

`Margin` is the room around a control; `Padding` the room inside it. **They do not
take the same value**: `Margin` is a single number for all four sides, `Padding`
is a string of one to four sizes. A `Margin` given `Padding`'s spelling —
`"0 0 0 12"` — is refused, naming the value, as every numeric property is.
`Expand` / `HExpand` / `VExpand` decide who absorbs slack in a row or a column.
`ColumnSpan` lets a child of a `Grid` run under several columns.

### The order Tab takes

`TabIndex` per control, on a container laying out by coordinate. Ties go to the
order the children are in, and everything is `0` until something says
otherwise, so a form that declares nothing is walked in the order it was drawn.
It is sparse and never renumbered.

There is no `TabStop`: a control Tab must skip is `Focusable: false`.

In a row or a column there is nothing to declare — there the order is the order
the children are in, exactly as `X`/`Y` mean nothing there either.

`FocusNext()` / `FocusPrevious()` on any container is what Tab does, said from
code, and answers whether the focus moved.

### Enter and Escape

Declared on the buttons, not on the form:

```json
{ "type": "Button", "name": "BtnOk",     "properties": { "Text": "OK",     "Default": true } },
{ "type": "Button", "name": "BtnCancel", "properties": { "Text": "Cancel", "Cancel": true } }
```

Escape presses the `Cancel` button and does **nothing at all** without one — a
window does not discard work on a stray keystroke unless it said so. A disabled
Cancel button refuses Escape as it refuses a click. A `Form_KeyPress` returning
`true` still wins.

`Default` is the keyboard and `Style` is the looks: an accented button is
`Style: "suggested-action"`, and the two are independent on purpose. Put
`Default` on the button that finishes typing; never on one that deletes
something.

A single-field dialog usually wants both halves — the button and the field:

```js
TxtName_Activate() { this.BtnOk_Click(); }
```

`TextBox.ActivatesDefault: true` is the other spelling: Enter presses the form's
default button *instead of* raising `Activate`.

### A key that presses a control

`Shortcut` on any widget, GTK's syntax, one or a list:

```json
{ "type": "Button", "name": "Btn7", "properties": { "Text": "7", "Shortcut": ["7", "KP_7"] } }
```

It activates the control: a `Button` clicks, a `CheckButton` toggles, a
`TextBox` raises `Activate`. **`Return` and `KP_Enter` never fire** — the window
claims them for its default widget, which is what `Button.Default` is for.
`Escape` works as an ordinary shortcut.

## Form: the window

`Text` (alias `Caption`), `Icon`, `Modal`, `Resizable`, `Maximized`,
`FullScreen`, `HideOnClose`, plus everything a container has.
Read-only: `Controls`, `Menus`, `DefaultButton`, `CancelButton`.
Methods: `Show()`, `Close()`, `Center()`, `Minimize()`, `Serialize()`,
`SaveForm(path)`.
Events: `Open`, `Close`, `Resize(width, height)`.

- `Show()` fires `Open` the first time, and presents the window. A modal window
  is made transient for the active one.
- **`Show()` runs `Form_Open` before it returns.** Whatever the handler set is
  readable on the next line, with no waiting. What needs a frame is anything that
  *measures* — those are two different questions.
- `DefaultButton` and `CancelButton` are resolved **after** `Form_Open` — so a
  form may build its own buttons in that handler, and so both read `null` inside
  it. Ask them a frame later.
- **A closed form's window is taken apart.** `Show()` on it is not an error and
  not a window either — it stays 0×0. A form meant to be opened again either
  declares `HideOnClose: true` or is constructed again every time.
- `Maximized` and `FullScreen` read `false` until there is a window; setting one
  before `Show()` applies it when the window appears. Keep them out of the
  `.form`.
- `Resizable: false` bounds the *user*, not the layout: the contents still drive
  the window's size, so a translated caption still opens it wider.
- `Center()` is a no-op on Wayland — the compositor places windows.
- `Form_Resize` fires with the size GTK settled on, including the first time.

## A dialog that asks something

`Message.Info`/`Warning`/`Error` **show and return**; they do not block and they
have no answer. A question that needs an answer is a form you write, with a
static `ask` and a callback. This is the idiom — copy it:

```js
class AskName extends Form {

    static ask(prompt, current, onName) {
        const dlg = new AskName();
        dlg.LblPrompt.Text = prompt;
        dlg.TxtName.Text   = current || "";
        dlg.onName         = onName;
        dlg.Modal          = true;
        dlg.Show();
        dlg.TxtName.SetFocus();
        dlg.TxtName.SelectAll();          /* so typing replaces what is offered */
        return dlg;
    }

    BtnOk_Click() {
        const name = this.TxtName.Text.trim();
        if (!name) return;                /* nothing typed is not an answer */
        this.Close();
        if (this.onName) this.onName(name);
    }

    TxtName_Activate() { this.BtnOk_Click(); }
    BtnCancel_Click()  { this.Close(); }
}
```

```js
AskName.ask("Name for the note", "", (name) => this.create(name));
```

**The callback runs only when there is an answer**, so no caller has to tell
*cancelled* from *chose nothing*. Its `.form` declares `Resizable: false` and
puts `Default` on OK.

For a confirmation, the same shape with nothing `Default` and the focus on
Cancel — Enter must not be able to delete anything.

## Menus

Declared on the form, next to its controls, and handled like any other event.

```json
"menus": [
  { "name": "MnuFile", "text": "_File", "children": [
      { "name": "MnuNew",  "text": "New",  "shortcut": "<Control>n" },
      { "name": "MnuSave", "text": "Save", "shortcut": "<Control>s" },
      { "separator": true },
      { "name": "MnuRecent", "text": "Recent", "dynamic": true },
      { "separator": true },
      { "name": "MnuQuit", "text": "Quit", "shortcut": "<Control>q" }
  ]},
  { "name": "MnuView", "text": "_View", "children": [
      { "name": "MnuGrid",  "text": "Show grid", "check": true, "shortcut": "<Control>g" },
      { "name": "MnuTheme", "text": "Theme", "dynamic": true, "radio": true }
  ]}
]
```

| Key | Meaning |
|---|---|
| `text` | the label. `_` marks the mnemonic, GTK style |
| `name` | required on a leaf: it becomes `this.<name>` and `<name>_Click`. Unique across the whole form and not something a `Form` already answers to, the same rule a control's name keeps and for the same reason — it is the same assignment |
| `children` | makes it a submenu; a submenu needs no name |
| `separator` | `true` for a rule between items |
| `shortcut` | an accelerator, or a list of them: `["F2", "<Control><Shift>r"]` |
| `dynamic` | `true` for a submenu whose entries the application assigns |
| `check` | `true` for an item that ticks on and off; `Value` is the tick |
| `radio` | `true` on a `dynamic` item: marks the chosen entry, `Value` is its index |

Each item is exposed by name with `Name`, `Enabled`, `Value`, `Click()` and —
on a `dynamic` one — `Items`, the entries the application assigns. It answers
`PropertyNames()` and `EventNames()` too, the way a control does: a menu item is
not a widget, so `Widget.New` cannot make one to ask, and a tool that wants to
know what one has had nothing to ask at all.

```js
MnuSave_Click() { this.save(); }
MnuGrid_Click(on) { this.grid = on; }               /* what it just became */

this.MnuRecent.Items = ["one", "two"];              /* reassign whenever it changes */
MnuRecent_Click(index, text) { this.open(text); }

this.MnuTheme.Items = ["Light", "Dark"];
this.MnuTheme.Value = 1;                            /* Dark, marked, and fires nothing */
```

- **Disabling an item also kills its accelerator**, so a shortcut can never fire
  a command the UI shows as unavailable.
- **Assigning `Value` does not fire `Click`** — restoring a saved setting must
  not run the command it stands for. `Click()` chooses on purpose.
- `Enabled = false` on a dynamic item greys out the whole submenu, which is how
  an empty list is shown.
- A dynamic entry's label is **data**: an `_` in it shows as itself. Text
  declared in the `.form` keeps mnemonic behaviour.
- `radio` without `dynamic` is refused, and so is `check` with `dynamic`.
- A `dynamic` or `radio` item cannot carry a `shortcut` — an accelerator can
  only name a command that takes no argument.

Also declare `shortcut` on a bare function key **as a list** with a modified
alternative: desktops grab `F2` and it may never reach the application.

### Context menus

A widget's `Menu` is the same spec, and a right click is answered by an
ordinary `Name_Click` — nothing can tell which menu it came from.

```json
{ "type": "Panel", "name": "Canvas",
  "properties": { "Menu": [ { "name": "MnuDel", "text": "Delete" },
                            { "separator": true },
                            { "name": "MnuTop", "text": "Bring to front" } ] } }
```

An ordinary property: declare it in the `.form` or assign it at runtime;
reassigning replaces the menu. `PopupMenu(x, y)` opens it from code, in the
widget's coordinates — which is also how a button that drops a menu is built:

```js
BtnMore_Click() { this.BtnMore.PopupMenu(0, 0); }
```

A control with no menu of its own passes the click outwards to the nearest
widget that has one.

## Actions: one command in several places

A command a button, a menu item and a key all point at — declared once, in an
`actions` block beside `menus`:

```json
{ "format": "bintana-form/1", "class": "MainForm",
  "actions": [
    { "name": "ActDelete", "text": "Delete", "icon": "edit-delete-symbolic",
      "shortcut": "Delete", "enabled": false }
  ],
  "children": [
    { "type": "Button", "name": "BtnDel", "properties": { "Action": "ActDelete" } }
  ],
  "menus": [
    { "text": "_Edit", "children": [ { "action": "ActDelete" } ] }
  ] }
```

```js
ActDelete_Click() { this.designer.deleteSelected(); }   // once, not four times
this.ActDelete.Enabled = hasSelection;                   // and all of them follow
```

| On an action | |
|---|---|
| `Name`, `Text`, `Icon` (ro) | what the `.form` declared. The label goes through the catalogue **once**, however many places show it |
| `Enabled` | the whole reason this exists: one assignment, and every button, menu item and accelerator naming the command follows |
| `Click()` | pressed from code, the way a menu item can be |
| `PropertyNames()`, `EventNames()` | what this class has, asked of it the way a control is asked. A command is not a widget, so nothing else can make one to ask |
| **event** `Click()` | the command was invoked — by a button, a menu item or its key |

**What makes it worth having is the shared `Enabled`, not the shared body.** A
command that needs a selection greys out in every place it appears from one
assignment, and its label is translated once. `Shortcut` on a control is not this:
it says which key presses *that control*, and a command in two places is still
written twice.

Four rules, and each of them is a mistake the runtime refuses rather than a
convention to remember:

- **A command's `name` is a member of the form**, so it may not be one the form
  already has: `Actions`, `Menus`, `Controls`, `DefaultButton`, `CancelButton`.
  One that is binds to nothing, and the form refuses to load saying which.
- **A control bound to a command has no `Enabled` of its own.** Assigning one
  throws, naming the command. Two places deciding whether one command is
  available is the bug this exists to prevent.
- **`Text` and `Icon` come from the command only where the control declared
  neither**, so a toolbar stays icons and an Edit menu stays words while both
  name one command — and they are *not* written back when the form is saved, so
  the command stays the one place the label lives.
- **A menu item that points at a command needs no name of its own.** It is a
  place the command appears and not a command, so there is nothing to enable and
  nothing to name: the second and third copy of a command in a context menu stop
  needing `MnuCvDel` and `MnuTrDel` names at all.

A name that is not one of the form's actions is refused where it is written, and
so is a control that cannot be pressed — a `Label` has no command.

## Drag and drop

Two properties and one event:

```js
this.BtnLabel.DragData = "Label";      /* draggable; this string is what travels */
this.Canvas.AcceptDrop = true;         /* receives */

Canvas_Drop(data, x, y) { this.place(data, x, y); }
```

Coordinates are the ones `MouseDown` reports, so what is dropped lands under the
pointer. What travels is a string, on purpose: nothing has to be registered
anywhere. Emptying `DragData` turns dragging off. Both are ordinary properties
and round-trip through the `.form`.

## Components — a form that is not a window

A component is its own `.form` and its own class, used inside another form as if
it were a control.

```js
class Stepper extends Component {
    static Events         = ["Change"];
    static Options        = { Step: ["1", "5", "10"] };
    static TextProperties = ["Caption"];

    get Value()  { return this._value || 0; }
    set Value(v) {
        this._value = Number(v) || 0;
        this.Shown.Text = String(this._value);
        this.Emit("Change", this._value);      /* arrives as Step1_Change on the host */
    }

    Up_Click()   { this.Value = this.Value + 1; }
    Down_Click() { this.Value = this.Value - 1; }
}
```

```json
{ "type": "Stepper", "name": "Step1",
  "properties": { "X": 8, "Y": 8, "Width": 180, "Height": 34, "Value": 5 } }
```

- Its children are **its own**: a `Button` inside it dispatches to the
  component's handlers, and the host form does not see them.
- A property is discovered because it is *there* — an accessor with both a
  getter and a setter. That is also what makes it serialisable and editable.
- The three statics are what a class cannot be asked: what it **raises**, what a
  property **accepts**, and which of its strings a person **reads**. Only
  literal lists count.
- `Emit(event, ...args)` raises an event that arrives by name like any
  control's.
- A component may extend a component; the chain is walked whole.

Use one for a group of controls that appears more than once with behaviour of
its own. A group that appears once is a `Panel`.

## Building a tree from code

Only for what is not known until it runs.

```js
const row = new Panel();
row.Arrangement = "Horizontal";        /* before it has children */
row.Spacing = 6;
row.Add(label);
this.List.Add(row);

this.List.AddNode({ type: "Button", name: "B1", properties: { Text: "Go" } });
```

`Add(widget)`, `Clear()`, `Children` (read-only), `Reorder(child, index)`,
`AddNode(node)` and `BuildChildren(node)` are on every container. A control
created in code has no handler wired to it unless the form declares one by that
name.

**Anything that measures needs a frame first.** `OriginIn`, `PickAt`, `Bounds`
and an unset `Width`/`Height` all read GTK's allocation, and a widget just
created has none until the main loop runs again. `Form_Open` itself runs before
the window is presented. `Timer.After(0, …)` is the shortest wait; do not count
frames — poll for the fact you need.

## Styles

An application decides what it looks like once, in `<project>/app.css`. It is
found by name; nothing in `project.json` points at it.

```css
/* app.css */
.danger       { background-color: #c01c28; color: #ffffff; }
.danger:hover { background-color: #e01b24; }
.note-title   { font-weight: bold; }
```

```js
this.BtnDelete.Style = "danger";
this.Title.Style     = "title-1";      /* one of the theme's own */
```

`Style` is a list, so `"card title-3"` wears both. A name that could not be a
CSS class is refused.

The desktop's theme already declares plenty, so a project is dressed before
`app.css` has a line in it: `suggested-action`, `destructive-action`, `flat`,
`circular`, `large-title`, `title-1` … `title-4`, `heading`, `body`, `caption`,
`caption-heading`, `dim-label`, `monospace`, `frame`, `view`, `sidebar`,
`toolbar`, `linked`, `boxed-list`, `navigation-sidebar`. A class the theme does
not declare is not an error — it simply does nothing, so check with
[`tests/styles.sh`](validation.md#5-style-classes) rather than copying a name from
elsewhere.

A toolbar is a `Panel` with `Arrangement: "Horizontal"` and `Style: "toolbar"`,
holding `flat` buttons. There is no `ToolBar`, `ToolButton` or `MenuButton`
class and none is coming; see [issues.md](issues.md#already-decided).

`Background`, `Foreground` and `Font` are the exception, not the norm: they
dress one control by hand and win over the stylesheet. Use them for a colour the
program computes. Three buttons that should match belong in `app.css`.
`Radius`, `Padding`, `Shadow`, `Border`, `FontScale` and `Opacity` are the same
kind of thing — per-widget, above the sheet.

## Icons

`Icon` on a `Button`, `ToggleButton`, `TextBox`, `Image` or `Form` takes the
name of an icon from the desktop's theme. **A name the theme cannot draw is
dropped** — better a button with its text than a broken-image glyph — so an
icon-only control silently comes out empty.

```js
if (Application.HasIcon("document-open-symbolic")) this.Btn.Icon = "document-open-symbolic";
```

`Application.Icons([contains])` lists every name available. `Form.Icon` is the
window's icon, and unlike the others it is *kept* even when the theme lacks it,
so a `.form` round-trips.

Prefer a desktop icon and keep your own as the fallback. `<project>/icons/*.svg`
is used by name, at the end of the search path. A name ending in `-symbolic` is
recoloured by GTK to follow the text colour — for that, the drawing must be
**fills**, since the recolouring forces `fill` and a `stroke` keeps its own
colour.

Check every icon you declared with [`tests/icons.sh`](validation.md#4-icons)
before handing the work over. Four of nine "universal" names failed on the
machine this was written on.

## Text a person reads

A form's captions are declared in its `.form` and translated with **nothing
asked**: the loader looks up every property the control's class declares as
prose in `po/<lang>.po` on the way in. The literal is the key, gettext-style, so
an application with no catalogue is a working one.

```
myapp/po/es.po
```

Which properties are prose is the class's own declaration —
`Label.Text` is, a plain `TextEditor.Text` is, a `SourceEditor.Text` is not (it is
source code), `Style` is not,
`ListBox.Items` and `Notebook.Tabs` are. `w.TextProperties()` answers, and
[controls.md](controls.md) lists them per control.

Text built while the program runs needs a helper only where the runtime does not
already own the position:

```js
Message.Info("Saved");                                /* already a text position */
Message.Error("Cannot open {0}: {1}", path, e.message);
Locale.Text("Hello {0}!", name)
Locale.Plural("{0} file", "{0} files", n)
Locale.Context("verb", "Open")                        /* the word with two senses */
```

**A template literal in one of those positions is the one real trap.** The msgid
arrives already filled in, so no catalogue can ever match it and nothing says so
at runtime:

```js
Message.Info(`Saved in ${path}`);            /* wrong: unreachable msgid */
Message.Info("Saved in {0}", path);          /* right */
```

`{0}` is positional so a translator can reorder the holes.

**A msgid that is nothing but holes is not a text position.** `Locale.Text("{0}
{1}", month, year)` puts the entry `"{0} {1}"` in the catalogue, which tells a
translator nothing and gives them nothing to translate — the words are in the
arguments, where the catalogue cannot reach them. If the order is what varies,
that is what a real msgid expresses: `Locale.Text("{0} of {1}", month, year)`, or
`Locale.Date(date, "Month")` and let the desktop spell it. Better still, keep
the template in the `.form` and pass data with `Fill`:

```json
{ "properties": { "Text": "{0} files, {1} unsaved" },
  "design":     { "Text": "12 files, 2 unsaved" } }
```

```js
this.LblStatus.Fill(files.length, dirty.length);
```

## What the serialiser writes back

Only if you save a form from code (`SaveForm(path)`), or want to know why a
`.form` looks the way it does:

- Properties with both a getter and a setter, discovered along the prototype
  chain. Read-only ones are skipped.
- Only what differs from a freshly constructed control.
- `Arrangement` first.
- `X`/`Y` only when the parent lays out by coordinate; `Width`/`Height` in a box
  only if one was declared.
- Only strings, numbers, booleans and arrays.
- The **declared** value, not the translated one.
