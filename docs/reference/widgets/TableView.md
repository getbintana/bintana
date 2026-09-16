# TableView

A list with columns, and its rows may nest.

This is the control to reach for whenever a row has **fields** — a file and its
size and kind, a client and their town and balance, a folder that opens onto the
files inside it. It draws its own headings, scrolls itself, sorts on a click, and
holds its rows either as strings it owns or as an answer it asks you for.

It is a `Widget` and a control like any other, so everything on
[Widget](Widget.md) is on it too; what follows is what is its own.

## Every member

Everything it has of its own, in one place. Each links to where it is explained;
the short phrase is there so a name can be found by eye, and the sentence that
matters is in the section. **Everything on [`Widget`](Widget.md) is also on it** —
`Visible`, `Enabled`, `Font`, `Style`, `Tooltip`, `Bounds()` and the rest — and is
not repeated here.

**Properties**

| | | |
|---|---|---|
| `AutoExpand` | a node opens when it gains children | [a tree](#a-tree) |
| `ColumnLines` | rules between the columns | [the columns](#the-columns) |
| `Columns` | the headings and their widths | [the columns](#the-columns) |
| `Count` | how many rows — **settable** | [the rows](#the-rows-it-holds), [on demand](#on-demand-a-table-that-holds-nothing) |
| `Index` | the selected row | [the selection](#the-selection) |
| `Key` | the selected node's key | [a tree](#a-tree) |
| `MultiSelect` | more than one row at a time | [the selection](#the-selection) |
| `RowLines` | rules between the rows | [the columns](#the-columns) |
| `Selection` (ro) | every selected row | [the selection](#the-selection) |
| `Sortable` | clickable headings | [sorting](#sorting) |

**Methods**

| | | |
|---|---|---|
| `Add(values, [options])` | one row, or one node | [the rows](#the-rows-it-holds), [a tree](#a-tree) |
| `Cell(row, column)` | → one value | [the rows](#the-rows-it-holds) |
| `Clear()` | empties it | [the rows](#the-rows-it-holds) |
| `CollapseAll()` | closes every node | [a tree](#a-tree) |
| `CollapseNode(key)` | closes one | [a tree](#a-tree) |
| `Deselect(index)` | unselects a row | [the selection](#the-selection) |
| `DeselectAll()` | selects nothing | [the selection](#the-selection) |
| `Exists(key)` | → whether that node is there | [a tree](#a-tree) |
| `ExpandAll()` | opens every node | [a tree](#a-tree) |
| `ExpandNode(key)` | opens one, and the way to it | [a tree](#a-tree) |
| `Expanded(key)` | → whether it is open | [a tree](#a-tree) |
| `Remove(index)` | takes a row out | [the rows](#the-rows-it-holds) |
| `Row(index)` | → that row's values | [the rows](#the-rows-it-holds) |
| `Select(index)` | selects a row | [the selection](#the-selection) |
| `SelectAll()` | every row, with `MultiSelect` | [the selection](#the-selection) |
| `SetCell(row, column, value)` | one cell, in place | [the rows](#the-rows-it-holds) |
| `SetIcon(row, column, name)` | an icon beside a cell | [the rows](#the-rows-it-holds) |
| `SortBy(column, [ascending])` | reorders the rows it holds | [sorting](#sorting) |
| `SortColumn(column, [ascending])` | clicks a heading from code | [sorting](#sorting) |

**Events**

| | | |
|---|---|---|
| `Activate()` | a row was double clicked | [the selection](#the-selection) |
| `Data(row, column)` | a cell is needed — **the answer is the return value** | [on demand](#on-demand-a-table-that-holds-nothing) |
| `Select()` | the selection moved | [the selection](#the-selection) |
| `Sort(column, ascending)` | a heading was clicked — **the handler decides** | [sorting](#sorting) |

## Which list is this one

Four controls here are lists, and **what differs is what a row is**. Everything
else — the selection, adding, removing, clearing — is spelt the same way in all
four on purpose.

| | a row is | reach for it when |
|---|---|---|
| `ListBox` | a string | the list is words, and they may be translated |
| `RowList` | a widget you built | a row is a small form: fields, a switch, a button |
| `TreeView` | a name, addressed by key | a hierarchy, with no headings and one column |
| **`TableView`** | **fields, and they may nest** | rows have columns — flat, on demand, or a tree |

A `Grid` is none of these: it is a layout for controls you place, not a list of
data.

**A `TableView` replaces the pair people used to build**: a `TreeView` for the
hierarchy and a table beside it for the fields, re-filled every time the
selection moved. That arrangement loses the headings over the tree, the alignment
per row and the single scrollbar, and keeps each node's other values in a
structure of its own by hand.

## The three shapes, and choosing one

A table either **holds** its rows or it does not, and the ones it holds may
**nest**. Which of the three you are in is decided by the first row that goes in,
and `Clear()` decides again:

| | `Add(values)` | `Add(values, { Key })` | `Count = n` |
|---|---|---|---|
| **holding its rows** | ✔ | ✖ | clears the rows |
| **on demand** | clears the count, and holds that row | ✖ | ✔ |
| **a tree** | ✖ | ✔ | ✖ |

- **Holding its rows** is the ordinary one. The table owns the strings, so
  `Cell`, `Row`, `SetCell`, `SetIcon` and `SortBy` all answer: there is something
  there to answer about.
- **On demand** is `Count = n` and a `Data` handler. A hundred thousand rows cost
  a number, because the table asks for the cells it is about to draw and nothing
  else. The four calls above are refused: the values live wherever your handler
  reads them.
- **A tree** is `Add(values, { Key, Parent })`. The headings sit over the
  hierarchy, every node carries its own fields, and it is one scrolling surface.
  From then on a row is addressed by its **key**.

Mixing them is refused where you write it, with the reason:

```
Add: this table is a tree -- every row in one is a node, so it needs a key:
Add(values, { Key, Parent })
```

## A table on a form

Declared in the `.form` like any control, columns and all — they are an ordinary
property, so the designer edits them and the catalogue translates their headings:

```json
{ "type": "TableView", "name": "Files",
  "properties": {
    "X": 10, "Y": 10, "Width": 554, "Height": 250,
    "HAlign": "Fill", "VAlign": "Fill", "MinWidth": 260, "MinHeight": 140,
    "Sortable": true,
    "Columns": [ { "Text": "Name" },
                 { "Text": "Size", "Width": 90, "Alignment": "Right" },
                 { "Text": "Kind", "Width": 160 } ] } }
```

and filled from code:

```js
Form_Open() {
    for (const [name, size, kind] of FILES) {
        this.Files.Add([name, size, kind]);
        this.Files.SetIcon(this.Files.Count - 1, 0, iconFor(kind));
    }
}

Files_Select()  { this.BtnDelete.Enabled = this.Files.Index >= 0; }
Files_Activate() { Message.Info("{0} is {1}", this.Files.Cell(this.Files.Index, 0),
                                              this.Files.Cell(this.Files.Index, 2)); }
```

That fragment is the first page of [`examples/table`](../../../examples/table),
shortened; the example itself is the three shapes side by side, on three pages.

**It scrolls itself.** A `TableView` is already a scrolling view of its rows —
putting one inside a `Scroller` gives it infinite room to grow into and takes the
scrollbar away from the rows, which is the opposite of what was wanted.

## The columns

| | |
|---|---|
| `Columns` | the headings: an array of `{ Text, Width, Alignment }`. `Text` is **translated**; `Width` is a request in pixels and `0` means the column sizes itself; `Alignment` is `Left` `Center` `Right` |
| `ColumnLines` | rules between the columns. Default `false` |
| `RowLines` | rules between the rows. Default `true` |

Only `Text` is required, and `Width: 0` — the default — means *size yourself to
what is in you*. **The last column takes the slack**, whatever its width says, so
a table never ends in a gap: put the column that should absorb the width last,
give the short ones beside it a fixed width (a size, a date, an amount), and
right-align the numbers.

A width is where a column **starts**, not a cage: the user can drag the edge
between two headings. What they cannot do is reorder the columns, because the
order is the form's design and a layout the user rearranges is one the form
cannot then reason about.

Re-declaring `Columns` rebuilds the headings and **keeps the rows**. A row holds
the values it was given, not a copy cut to the columns that existed at the time:
add `["a", "b", "c"]` to a table of two columns and the third value is there,
unshown, and appears if a third column is declared later. The other way round, a
row shorter than there are columns simply reads blank in the rest.

## The rows it holds

| | |
|---|---|
| `Add(values, [options])` | one row, as an array of strings, in column order. `options` is `{ Key, Parent, Icon }` — see [a tree](#a-tree) |
| `Count` | how many rows. **Settable**, and setting it is the on-demand shape |
| `Cell(row, column)` | → one value. Refused on an on-demand table, which has no cells to answer about |
| `Row(index)` | → that row's values, as the array it was given — including any it was given beyond the columns declared |
| `SetCell(row, column, value)` | one cell, in place. The selection stays where it is |
| `SetIcon(row, column, name)` | an icon from the theme beside a cell's text. `""` takes it off |
| `Remove(index)` | takes that row out. In a tree it takes the subtree with it |
| `Clear()` | empties it — **and forgets which of the three shapes this table was** |

**In a tree, every one of these takes a key where it says `row`** — see
[a tree](#a-tree). `Add` takes the text of each cell and nothing else; the icon
is a second call.
That is what keeps `Add(["a", "b", "c"])` the way a row is written — a cell is
text, and an icon is a name the desktop draws.

**Removing more than one row goes back to front.** `Selection` is the selected
rows in order, and taking one out shifts every row after it:

```js
for (const at of [...this.Files.Selection].reverse()) this.Files.Remove(at);
```

Front to back deletes the wrong rows the moment two are selected, and works
perfectly until somebody selects two.

## The selection

| | |
|---|---|
| `Index` | the selected row, `-1` for none. Assigning selects it. Default `-1` |
| `Selection` (ro) | every selected row, as an array of indices in order |
| `MultiSelect` | more than one row at a time. Refused on a tree |
| `Select(index)` | selects that row, leaving the others where several are allowed |
| `Deselect(index)` | unselects it |
| `SelectAll()` | with `MultiSelect` |
| `DeselectAll()` | selects nothing |
| **event** `Select()` | the selection moved — by the user or by an assignment. Ask `Index` for where it is and `Cell`/`Row` for what is there; `Key` when the table is a tree |
| **event** `Activate()` | a double click on a row, or Enter on it. The gesture for *open this one* |

`Select` fires for a selection made in code as well as one made with the mouse,
which is what a form wants: the button under the table is enabled in one place
rather than in every place that moves the selection.

**`Index` answers the first selected row**, once there is more than one:
selecting 0, then 2, then 3 leaves `Index` at `0` and `Selection` at `[0, 2, 3]`.
Ask `Selection` whenever `MultiSelect` is on.

## Sorting

| | |
|---|---|
| `Sortable` | the headings become clickable. Default `false` |
| **event** `Sort(column, ascending)` | one was clicked. **The handler decides what happens** |
| `SortBy(column, [ascending])` | actually reorders the rows the table holds |
| `SortColumn(column, [ascending])` | the same as clicking that heading from code: the arrow moves and `Sort` is raised |

**A sortable table does not sort itself**, and this is the one thing about it
that surprises everybody once. It cannot: a table that answers `Data` has no rows
to reorder, and the same word must not mean two different things depending on
which shape the table is in. So the click arrives as an event and the answer is
one line:

```js
Files_Sort(column, ascending) { this.Files.SortBy(column, ascending); }
```

An on-demand table answers it by changing what its `Data` handler reads — sorting
the source, or reading it backwards — and the rows redraw where they are.

**The selection follows the rows through a sort**, in both shapes: the rows that
were selected are still the selected ones, at whatever positions they have moved
to. The same is true of `SetCell` — changing a cell does not move the highlight.

## On demand: a table that holds nothing

Set `Count` and answer `Data`:

| | |
|---|---|
| `Count` | how many rows there are. Assigning it puts the table in this shape and clears any rows it held |
| **event** `Data(row, column)` | the table needs a cell. **The return value is the answer**: a string, or `{ Text, Icon }` for a cell with a picture |

```js
Form_Open()            { this.Big.Count = 100000; }
Big_Data(row, column)  { return column === 0 ? String(row) : String(row * row); }
```

A hundred thousand rows cost the number: the handler is called for the cells
about to be drawn, which is a few dozen for a screenful, and again when you
scroll.

**The handler must be a lookup.** It runs inside GTK's own drawing, once per
visible cell each time a row is bound, so anything slow in it is slow on every
scroll — and anything with a side effect changes the world while the world is
being measured. Read from an array, a `Record`, a map you already have; do not
open a file, do not query a database, do not write to a control.

`Cell`, `Row`, `SetCell` and `SetIcon` are refused here, and that is the shape
being honest: the values are not in the table, they are wherever your handler
reads them, and the table cannot answer for somebody else's data. `Add` is not
refused — it clears the count and the table starts holding rows again.

## A tree

Give a row a `Key` and the table becomes a hierarchy with headings over it.

| | |
|---|---|
| `Add(values, { Key, Parent, Icon })` | a node. `Key` is its name — any string, unique in this table; `Parent` is the key of the node it goes under, and no parent is a root; `Icon` decorates its first column |
| `Key` | the selected node's key; assigning selects it, opening the way to it. `""` selects nothing |
| `Exists(key)` | → whether that node is there. `false` on a flat table rather than a refusal: it is the question you ask *before* you know |
| `AutoExpand` | a node opens as it arrives, and again when it gains a child after being closed by hand. Default `true` |
| `ExpandNode(key)` | opens it, and the way to it |
| `CollapseNode(key)` | closes it |
| `ExpandAll()` | opens every node |
| `CollapseAll()` | closes every node |
| `Expanded(key)` | → whether it is open |
| `Count` (ro here) | how many nodes there are, **at every level** |

**A parent goes in before its children**: `Parent` names a key, and a key that
nothing has added yet is not there to go under.

**In a tree, a row is addressed by its key** — `Cell(key, column)`,
`SetCell(key, …)`, `SetIcon(key, …)`, `Row(key)`, and `Remove(key)`, which takes
the subtree with it. That is not a second spelling of the same thing: a *position*
in a tree is a position in the **visible** list, so it moves the moment something
above it is collapsed. `Index` still says where the highlight is right now, and
`Key` is the one to keep.

Sorting sorts **siblings within each parent**, which is the only order a
hierarchy has: sorting the flattened list would put a child above its own parent.

`ExpandNode` and not `Expand`: `Expand` is `Widget`'s layout property, on every
control, and means *absorb the slack in the box*.

## What goes wrong

- **The table is empty and nothing threw.** A tree whose `Parent` names a key
  that was never added has nowhere to go; add the parent first.
- **Clicking a heading does nothing.** `Sortable` makes the heading clickable; a
  `Sort` handler is what sorts. See [Sorting](#sorting).
- **A row was removed and the wrong one went.** Remove back to front — see
  [the rows it holds](#the-rows-it-holds).
- **`Cell` throws.** The table is on demand, so it has no cells. Read from
  wherever your `Data` handler reads.
- **The rows vanished when the count was set.** `Count = n` is the on-demand
  shape and clears what was held. It is one control and three shapes; `Clear()`
  is how you change your mind.
- **Scrolling is jerky with many rows.** Something in `Data` is not a lookup.
- **The table grew past the window.** It scrolls itself, so it does not need a
  `Scroller` around it; what it needs is `HAlign`/`VAlign` of `Fill`, or an
  `Expand`, so the room it gets is the room there is.

## What it does not do

- **No editing in place.** A cell is text the program put there; a table is for
  showing rows and choosing one. Editing belongs on a form beside it, which is
  also where the validation and the undo are.
- **No columns the user can reorder.** They can drag a heading's edge to widen
  one — a declared width is where it starts — but the order is the form's.
- **No grouping, no totals, no frozen columns.** A report is
  [`report`](../../llm/report.md), which has bands, groups and totals and goes out
  as a PDF.
- **It does not sort itself.** Said twice on purpose.

## See also

[`ListBox`](ListBox.md) · [`RowList`](RowList.md) · [`TreeView`](TreeView.md) ·
[`Record`](../globals/Record.md), for rows that are data rather than strings ·
[`examples/table`](../../../examples/table) · [`examples/clients`](../../../examples/clients)
