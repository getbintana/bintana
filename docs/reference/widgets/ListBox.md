# ListBox

A list of strings, and the simplest list there is.

Reach for it when the rows **are words** — the notes in a folder, the languages a
project translates into, the recent files. It holds the text itself, so the list
is one assignment and the answer to *what is selected* is a string.

It is a `Widget` and a control like any other, so everything on
[Widget](Widget.md) is on it too; what follows is what is its own.

## Every member

Everything it has of its own, in one place. Each links to where it is explained;
the short phrase is there so a name can be found by eye, and the sentence that
matters is in the section.

**Properties**

| | | |
|---|---|---|
| `ActivateOnSingleClick` | one click activates instead of two | [the selection](#the-selection) |
| `Count` (ro) | how many rows | [the rows](#the-rows) |
| `Index` | the selected row, `-1` for none | [the selection](#the-selection) |
| `Items` | the whole list, as an array of strings | [the rows](#the-rows) |
| `MultiSelect` | more than one row at a time | [the selection](#the-selection) |
| `Selection` (ro) | every selected row | [the selection](#the-selection) |
| `Text` (ro) | the selected row's words | [the selection](#the-selection) |

**Methods**

| | | |
|---|---|---|
| `Activate(index)` | raises `Activate` for that row | [the selection](#the-selection) |
| `Add(text)` | one row at the end | [the rows](#the-rows) |
| `Clear()` | empties it | [the rows](#the-rows) |
| `Deselect(index)` | unselects a row | [the selection](#the-selection) |
| `DeselectAll()` | selects nothing | [the selection](#the-selection) |
| `RemoveRow(index)` | takes a row out | [the rows](#the-rows) |
| `Select(index)` | selects a row | [the selection](#the-selection) |
| `SelectAll()` | every row, with `MultiSelect` | [the selection](#the-selection) |

**Events**

| | | |
|---|---|---|
| `Activate()` | a row was double clicked, or Enter | [the selection](#the-selection) |
| `Select()` | the selection moved | [the selection](#the-selection) |

## Which list is this one

Four controls here are lists, and **what differs is what a row is**. Everything
else — the selection, adding, removing, clearing — is spelt the same way in all
four on purpose.

| | a row is | reach for it when |
|---|---|---|
| **`ListBox`** | **a string** | **the list is words, and they may be translated** |
| `RowList` | a widget you built | a row is a small form: fields, a switch, a button |
| `TreeView` | a name, addressed by key | a hierarchy, with no headings and one column |
| `TableView` | fields, and they may nest | rows have columns — flat, on demand, or a tree |

A `ComboBox` is the same list closed up into one line: the same `Items`, `Index`
and `Text`, shown as a drop-down. Reach for it when the choice is *settled* and
the list is in the way the rest of the time.

## On a form

```json
{ "type": "ListBox", "name": "Notes",
  "properties": { "X": 8, "Y": 8, "Width": 220, "Height": 300,
                  "HAlign": "Fill", "VAlign": "Fill" } }
```

```js
show() {
    this.Notes.Items = this.notes.map((one) => one.title);
}

Notes_Select()   { this.open(this.Notes.Index); }
Notes_Activate() { this.Ed.SetFocus(); }
```

That is [`examples/notes`](../../../examples/notes), which keeps its notes in an
array and the list in step with it — the shape almost every use of this control
has: **the list shows, the array knows**. `Index` is what joins them, which is
why the rows go in in the array's order and stay in it.

## The rows

| | |
|---|---|
| `Items` | the whole list, as an array of strings. Assigning replaces every row at once; reading gives the rows as they are now. **Translated** — a list declared in a `.form` goes through the catalogue |
| `Add(text)` | one row at the end, which is what a list being filled a row at a time wants |
| `RemoveRow(index)` | takes that row out |
| `Clear()` | empties it |
| `Count` (ro) | how many rows there are |

**Assigning `Items` is the fast path and the honest one**: replacing a list of
forty rows is one call and one redraw, where forty calls to `Add` are forty of
each. Use `Add` when the rows arrive one at a time — a search filling in as the
answers come back.

**A list of strings is a list of *strings*.** Whatever the row stands for — a
file, a client, a record — lives in an array beside it, and `Index` is the
subscript into that array. Sorting is done to the array, before it is handed
over: the control shows the order it was given and never invents one.

## The selection

| | |
|---|---|
| `Index` | the selected row, `-1` for none. Assigning selects it — and **raises `Select`** |
| `Text` (ro) | the words of the selected row, `""` when there is no selection |
| `Selection` (ro) | every selected row, as an array of indices in order |
| `MultiSelect` | more than one row at a time |
| `Select(index)` | selects that row, leaving the others where several are allowed |
| `Deselect(index)` | unselects it |
| `SelectAll()` | with `MultiSelect` |
| `DeselectAll()` | selects nothing |
| `Activate(index)` | raises `Activate` for that row from code, as a double click would |
| `ActivateOnSingleClick` | raise `Activate` on one click instead of two. Default `false` |
| **event** `Select()` | the selection moved — by the user **or by an assignment** |
| **event** `Activate()` | a double click on a row, or Enter on it: the gesture for *use this one* |

`Index` answers the **first** selected row once there is more than one; ask
`Selection` whenever `MultiSelect` is on. `Text` follows `Index`, so it is the
first one's words.

**`Select` is for following a selection and `Activate` for acting on it.** A form
that opens a note on `Select` opens one every time somebody walks the list with
the arrow keys; `ActivateOnSingleClick` is there for the lists where a click *is*
the action — a menu of choices, a palette.

## What goes wrong

- **The handler runs while the form is filling itself in.** Assigning `Index`
  raises `Select`, so a method that rebuilds the list and then selects a row
  re-enters whatever `Select` does. Assigning `Items` and calling `Add` do
  **not** raise it. `examples/notes` carries a `showing` flag for exactly this,
  which is the plain answer: set it around the assignment and return early.
- **The button stayed enabled after the row was removed.** `RemoveRow` and `Clear`
  leave nothing selected — `Index` is `-1` — and **raise no event**, so whatever
  `Select` was keeping up to date is now stale. Update it yourself on the line
  after, or call the same method `Select` calls.
- **The rows and the data drifted apart.** `Index` is a subscript into your
  array; anything that reorders one has to reorder the other, which is why
  sorting belongs to the array.
- **Everything walked past opened.** That is `Select` doing its job; the gesture
  for *open* is `Activate`.
- **A list declared in the `.form` came back translated in an odd language.**
  `Items` is prose and goes through the catalogue. Rows that are data — file
  names, keys, ids — are filled from code, not declared.

## What it does not do

- **No icons, no columns, no rows of your own.** A row is a string. Icons and
  fields are [`TableView`](TableView.md); a row that is a little form is
  [`RowList`](RowList.md).
- **No filtering.** `RowList` has `Filter`; here the filtering is done to the
  array before `Items` is assigned, which is one line and no second opinion about
  what is shown.
- **No sorting.** Sort the array with `Locale.Compare` — the desktop's order, not
  the code-unit one — and assign it.

## See also

[`ComboBox`](ComboBox.md) · [`RowList`](RowList.md) · [`TreeView`](TreeView.md) ·
[`TableView`](TableView.md) · [`examples/notes`](../../../examples/notes)
