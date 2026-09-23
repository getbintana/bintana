# RowList

One row per child, and **each row is a widget you built**.

Reach for it when a row is a little form: an icon and two labels, a name with a
switch beside it, a result with a button on it. A [`ListBox`](ListBox.md) holds
strings and a [`TableView`](TableView.md) holds fields; this holds *controls*,
which is what a property editor, a settings page or a list of search results
needs.

It is a **`Container`**, so the rows go in with `Add(control)` and come out with
`Clear()` — a row is not a kind of data here, it is a child. Everything on
[Widget](Widget.md) and [Container](Container.md) is on it too; what follows is
what is its own.

## Every member

Everything it has of its own, in one place. Each links to where it is explained;
the short phrase is there so a name can be found by eye, and the sentence that
matters is in the section. **Putting rows in and taking them all out is
`Container`'s** — `Add(control)`, `Clear()`, `Children` — and is in [the
rows](#the-rows).

**Properties**

| | | |
|---|---|---|
| `ActivateOnSingleClick` | one click activates instead of two | [the selection](#the-selection) |
| `Count` (ro) | how many rows, hidden ones included | [the rows](#the-rows) |
| `Index` | the selected row, `-1` for none | [the selection](#the-selection) |
| `MultiSelect` | more than one row at a time | [the selection](#the-selection) |
| `Selection` (ro) | every selected row | [the selection](#the-selection) |

**Methods**

| | | |
|---|---|---|
| `Activate([index])` | raises `Activate` for that row | [the selection](#the-selection) |
| `Deselect(index)` | unselects a row | [the selection](#the-selection) |
| `DeselectAll()` | selects nothing | [the selection](#the-selection) |
| `Refilter()` | the answer to `Filter` may have changed | [filtering](#filtering) |
| `RemoveRow(index)` | takes a row out, **and its control with it** | [the rows](#the-rows) |
| `Reveal(index)` | brings that row into view | [the rows](#the-rows) |
| `Select(index)` | selects a row | [the selection](#the-selection) |
| `SelectAll()` | every row, with `MultiSelect` | [the selection](#the-selection) |

**Events**

| | | |
|---|---|---|
| `Activate()` | a row was double clicked, or Enter | [the selection](#the-selection) |
| `Filter(control, index)` | should this row be shown? | [filtering](#filtering) |
| `Select()` | the selection moved | [the selection](#the-selection) |

## Which list is this one

Four controls here are lists, and **what differs is what a row is**. Everything
else — the selection, adding, removing, clearing — is spelt the same way in all
four on purpose.

| | a row is | reach for it when |
|---|---|---|
| `ListBox` | a string | the list is words, and they may be translated |
| **`RowList`** | **a widget you built** | **a row is a small form: fields, a switch, a button** |
| `TreeView` | a name, addressed by key | a hierarchy, with no headings and one column |
| `TableView` | fields, and they may nest | rows have columns — flat, on demand, or a tree |

**If the row is fields, prefer a `TableView`**: it draws the headings, aligns the
columns down the list and sorts on a click, none of which a row of `Label`s does
by itself. Come here when the row has something in it that is not text — a
button, a switch, a progress bar — or when it is a *component* of your own, which
is the shape that pays: `examples/contacts` builds its rows from a `Contact`
component, so the designer draws the same class the program builds.

## On a form

```json
{ "type": "RowList", "name": "List",
  "properties": { "X": 8, "Y": 40, "Width": 380, "Height": 300,
                  "HAlign": "Fill", "VAlign": "Fill" } }
```

```js
addRow(name, info) {
    const row = new Panel();
    row.Arrangement = "Horizontal";
    row.Spacing = 8;
    row.Margin  = 4;

    this.List.Add(row);        /* the row first, then what goes inside it */

    const label = new Label();
    label.Text      = name;
    label.HExpand   = true;
    label.Ellipsize = true;    /* a long name gives up its tail, not the row */
    row.Add(label);
}
```

That is [`examples/files`](../../../examples/files), shortened. Note the order:
**the row goes into the list before it is filled**, which is what keeps a half
built row from being measured.

## The rows

| | |
|---|---|
| `Add(control)` | `Container`'s: one control, one row, at the end |
| `Clear()` | `Container`'s: empties it, destroying every row's control |
| `Children` (ro) | `Container`'s: the controls, one per row, in order |
| `RemoveRow(index)` | takes that row out — **and the control in it goes with it**: the row is the widget's wrapper, so this is the same as deleting the child. **`RangeError`** when there is no such row |
| `Reveal(index)` | brings that row into view with the least scrolling it takes, and answers whether there was one |
| `Count` (ro) | how many rows there are, **hidden ones included** |

**A row is a control and nothing else is a row.** What the row stands for lives in
an array beside the list, exactly as it does for a `ListBox`, and `Index` is the
subscript: `this.files[this.List.Index]`.

**Build the row out of a component when it is more than a line.**
`examples/contacts` used to build its rows in a forty-line method — a class with
the word `class` left out — and is a `Contact` component now: the row is declared
in a `.form`, the designer can draw it, and the list can be drawn *while the form
is being designed* (`item` in [formats.md](../../formats.md#item-what-a-list-holds-while-it-is-being-designed)).

## The selection

| | |
|---|---|
| `Index` | the selected row, `-1` for none. Assigning selects it and **raises `Select`**. **A hidden row is still a row**: `Filter` changes what is on screen, not what the list holds |
| `Selection` (ro) | every selected row, as an array of indices in order |
| `MultiSelect` | more than one row at a time |
| `Select(index)` | selects that row, leaving the others where several are allowed |
| `Deselect(index)` | unselects it |
| `SelectAll()` | with `MultiSelect` |
| `DeselectAll()` | selects nothing |
| `Activate([index])` | raises `Activate` for that row from code; the selected one with no argument. Answers whether there was one |
| `ActivateOnSingleClick` | raise `Activate` on one click instead of two. Default `false` |
| **event** `Select()` | the selection moved. Ask `Index` or `Selection` for which rows; what is *in* them is the widgets you put there |
| **event** `Activate()` | a double click on a row, or Enter on it |

**The indices count every row, shown or hidden.** That is the one thing to hold
on to when a list filters: `Count` is what was added, `Index` is a position in
that, and the array beside the list lines up with both.

## Filtering

| | |
|---|---|
| **event** `Filter(control, index)` | asked while the list is laid out, once per row. **Returning `false` hides the row**; no handler at all shows every one |
| `Refilter()` | says the answer may have changed, so ask again |

```js
List_Filter(row, index) { return this.shows(this.files[index]); }

TxtFind_Change() { this.needle = this.TxtFind.Text; this.List.Refilter(); }
```

**The rows are built once** — when the folder is read, the query comes back, the
list is filled — and filtering only decides which of them are drawn. Nothing is
created or destroyed by typing in a search box, which is what makes a filter
instant and what keeps the focus and the caret where they were.

**A lookup and nothing that is not a lookup.** `Filter` runs while the list is
being laid out, so anything with a side effect in it changes the world while the
world is being measured. Decide from data you already have. `examples/files` puts
the predicate in a method of its own and calls it from both places — the handler
and the label that says *12 of 48* — because two copies of that rule is how a
list comes to show thirteen rows while claiming twelve.

## What goes wrong

- **The selection jumped to another row when the filter changed.** Hiding a row
  does not move `Index`, but the *visible* row the user is looking at does move.
  Keep what is selected as the thing in your array, not as a number, whenever a
  filter is in play.
- **Typing in the search box is slow.** Something in `Filter` is not a lookup —
  it is reading the disk, formatting a date, or asking a control.
- **The count in the status bar disagrees with the list.** Two copies of the
  predicate. One method, two callers.
- **Removing a row destroyed a control that was wanted elsewhere.** The pair is
  worth knowing: `list.RemoveRow(index)` takes the row out **and destroys** the
  control in it, while `control.Remove()` — `Widget`'s, which detaches without
  destroying — takes the row out and **keeps** it, ready to be added somewhere
  else. Measured on a list of two: either way the count goes to one; only the
  second leaves something to add back.
- **A row is a `Panel` with everything in it and it looks nothing like the
  design.** A row that is more than a line or two wants to be a component, where
  it can be drawn, named and reused.

## What it does not do

- **No headings, no columns.** The rows are your controls, so lining them up is
  your layout — or a [`TableView`](TableView.md), which was built for exactly
  that.
- **No sorting.** Sort the array and refill the list; there is nothing here to
  reorder, since the order is the order the children went in.
- **No rows on demand.** Every row is a real widget, so a hundred thousand of
  them are a hundred thousand widgets: past a few hundred rows, the control that
  scales is a `TableView` with a `Count` and a `Data` handler.

## See also

[`ListBox`](ListBox.md) · [`TableView`](TableView.md) ·
[`Container`](Container.md) · [`examples/files`](../../../examples/files) ·
[`examples/contacts`](../../../examples/contacts)
