# TreeView

One column of text, in a hierarchy, addressed by **key**.

Reach for it when what you are showing is a shape — folders inside folders, a
document's outline, a set of categories with things under them — and one line of
text per node is all there is to say. What every node needs is a name of its own
that your code chooses: a path, an id, a category. That is the key, and from then
on the tree is spoken to in keys and never in positions.

It is a `Widget` and a control like any other, so everything on
[Widget](Widget.md) is on it too; what follows is what is its own.

## Every member

Everything it has of its own, in one place. Each links to where it is explained;
the short phrase is there so a name can be found by eye, and the sentence that
matters is in the section.

**Properties**

| | | |
|---|---|---|
| `AutoExpand` | a node opens when it gains children | [opening and closing](#opening-and-closing) |
| `Count` (ro) | how many nodes, at every level | [the nodes](#the-nodes) |
| `Key` | the selected node's key; assigning selects | [the selection](#the-selection) |
| `Text` (ro) | the selected node's words | [the selection](#the-selection) |

**Methods**

| | | |
|---|---|---|
| `Add(key, text, [parentKey], [icon])` | a node, under another or at the root | [the nodes](#the-nodes) |
| `Clear()` | empties the whole tree | [the nodes](#the-nodes) |
| `Activate([index])` | raises `Activate` for that visible position, as a double click would; the selected node with no argument | [the selection](#the-selection) |
| `ActivateOnSingleClick` | raise `Activate` on one click instead of two. Default `false` | [the selection](#the-selection) |
| `CollapseAll()` | closes every node | [opening and closing](#opening-and-closing) |
| `CollapseNode(key)` | closes one | [opening and closing](#opening-and-closing) |
| `Exists(key)` | → whether that node is there | [the nodes](#the-nodes) |
| `ExpandAll()` | opens every node | [opening and closing](#opening-and-closing) |
| `ExpandNode(key)` | opens one, and the way to it | [opening and closing](#opening-and-closing) |
| `Expanded(key)` | → whether it is open | [opening and closing](#opening-and-closing) |
| `RemoveNode(key)` | takes a node out, **and its subtree** | [the nodes](#the-nodes) |
| `Reveal(index)` | brings that visible row into view | [the nodes](#the-nodes) |
| `SetIcon(key, name)` | its picture, `""` for none | [the nodes](#the-nodes) |
| `SetText(key, text)` | renames it | [the nodes](#the-nodes) |

**Events**

| | | |
|---|---|---|
| `Activate()` | a node was double clicked, or Enter | [the selection](#the-selection) |
| `Select()` | the selection moved | [the selection](#the-selection) |

## Which list is this one

Four controls here are lists, and **what differs is what a row is**. Everything
else — the selection, adding, removing, clearing — is spelt the same way in all
four on purpose.

| | a row is | reach for it when |
|---|---|---|
| `ListBox` | a string | the list is words, and they may be translated |
| `RowList` | a widget you built | a row is a small form: fields, a switch, a button |
| **`TreeView`** | **a name, addressed by key** | **a hierarchy, with no headings and one column** |
| `TableView` | fields, and they may nest | rows have columns — flat, on demand, or a tree |

**Between this and a `TableView` that nests, one thing decides, and GTK decides
it: a table cannot hide its heading row.** So a hierarchy *without* headings is a
`TreeView`, and one *with* them — columns, widths, alignment per column — is a
`TableView` whose rows carry a `Key`. Everything else they both do, they do with
the same words.

Three differences are worth knowing, and each has a reason:

- **`Add`.** Here it is `Add(key, text, [parentKey], [icon])`, because in a tree
  every row *is* a node and a key is not optional. There it is
  `Add(values, [{ Key, Parent, Icon }])`, because a table's row may or may not be
  one and the options are what say which.
- **`Text`.** A node has one, so this control answers it. A table's row has
  several cells and *which* would be "the text" is arbitrary, so it answers
  `Cell(key, column)`.
- **`Index`.** A table has one because it is also a flat list. A tree is
  addressed **by key and only by key**: a position is a position in the *visible*
  list, and it moves the moment something above it is collapsed.

## On a form

```json
{ "type": "TreeView", "name": "FileTree",
  "properties": { "X": 0, "Y": 30, "Width": 240, "Height": 480,
                  "HAlign": "Fill", "VAlign": "Fill" } }
```

```js
fill(folder) {
    this.FileTree.Clear();

    for (const entry of this.scan(folder))
        this.FileTree.Add(entry.path, entry.name, entry.parent, iconFor(entry));
}

FileTree_Select()   { this.show(this.byKey[this.FileTree.Key]); }
FileTree_Activate() { this.open(this.byKey[this.FileTree.Key]); }
```

That is the shape of the IDE's own project tree
([`ide/modules/ProjectTree.js`](../../../ide/modules/ProjectTree.js)), which is
the largest tree in this repository and worth reading: it keys forms by
`form:<name>`, categories by `cat:<name>` and folders by `dir:<path>` so that a
key can never collide with a file's, and keeps a `byKey` map from key to whatever
the row really is — which is the pattern.

**A parent goes in before its children.** `parentKey` names a node, and a key
nothing has added yet is not there to go under.

## The nodes

| | |
|---|---|
| `Add(key, text, [parentKey], [icon])` | a node. `key` is yours to choose and must be unique in this tree; an empty `parentKey` is a root; `icon` is a name from the theme, and one the theme lacks is dropped rather than drawn as a hole |
| `SetText(key, text)` | renames a node, keeping it where it is — and keeping the selection on it. **Translated** |
| `SetIcon(key, name)` | its picture, or `""` for none. One column, so no column argument |
| `RemoveNode(key)` | takes that node out **and the subtree with it** — a node whose parent is gone is not something this control can show |
| `Reveal(index)` | brings that visible row into view with the least scrolling it takes, and answers whether there was one. The index is a visible position, like `Activate`'s |
| `Exists(key)` | → whether that node is there. The question you ask *before* you know, so it answers rather than throwing |
| `Clear()` | empties the whole tree |
| `Count` (ro) | how many nodes there are, **at every level**, open or closed |

**The key is the name your program uses and the text is the name the user
reads.** Keep them apart: renaming a node is `SetText`, and it does not change
what anything else in your code refers to. A key is an id, a path, a primary
key — whatever you would have used to find the thing again.

**One namespace, so prefix what could collide.** Everything in one tree shares the
key space; if the same tree holds files and categories, `cat:forms` and
`forms/Form1.js` cannot be confused, where `forms` and `forms` can.

## The selection

| | |
|---|---|
| `Key` | the selected node's key, `""` for none. Assigning selects that node, **opening the way to it**, and raises `Select` |
| `Text` (ro) | the words of the selected node, `""` when nothing is selected |
| `Activate([index])` | the double click from code; the selected node with no argument |
| `ActivateOnSingleClick` | raise `Activate` on one click instead of two. Default `false` |
| **event** `Select()` | the selection moved — by the user, by an assignment, or because what was selected is no longer visible |
| **event** `Activate()` | a double click on a node, or Enter on it: the gesture for *open this one* |

**There is no `MultiSelect` and no `Index`.** A hierarchy is selected one node at
a time — which is what a tree has meant since the first one — and a position in
it is a position in the *visible* list, so it is not something to keep.

**`Activate([index])` is the double click from code**, and
`ActivateOnSingleClick` decides which click raises the event in the first place
(default `false`, like every other list here). The index is the visible position
— what a click lands on — and with no argument it is the node already selected,
which is what Enter does. A position that is not there is nothing to activate
and not an error.

**`Select` is for following the selection and `Activate` for acting on it**, the
same division every list here makes: a tree that opened a file every time
somebody pressed the down arrow would be unusable.

## Opening and closing

| | |
|---|---|
| `ExpandNode(key)` | opens it, **and the way to it**: a node only exists on screen once its ancestors are open |
| `CollapseNode(key)` | closes it |
| `ExpandAll()` | opens every node |
| `CollapseAll()` | closes every node |
| `Expanded(key)` | → whether it is open |
| `AutoExpand` | a node opens as it arrives, and again when it gains a child after being closed by hand. Default `true` |

`ExpandNode` and not `Expand`: [`Expand`](Widget.md) is `Widget`'s layout
property, on every control, and means *absorb the slack in the box*. A method of
that name here would shadow it.

**`AutoExpand` is why a tree filled from code arrives open.** Turn it off before
filling and the tree arrives with every branch closed, which is what a big tree
wants; the alternative is `CollapseAll()` afterwards, which does the same work
twice.

Two halves do it, and both are `TableView`'s: `GtkTreeListModel`'s own
autoexpand opens each row as it arrives -- which is also why a node with nothing
under it reads as open, and why its arrow is hidden rather than drawn -- and an
explicit reveal of the **parent** reopens a node that was closed by hand and then
gained a child, which GTK's does not do. `TreeView` used to have neither, opening
every node itself on every `Add`; what that cost is in
[widgets.md](../../widgets.md#reaching-a-row-which-is-shared-with-tableview-and-used-to-be-quadratic).

## What goes wrong

- **The node was added and nothing appeared.** Its `parentKey` names a node that
  does not exist yet — add parents before children — or an ancestor is closed and
  nothing opened the way to it.
- **The selection vanished.** Collapsing a node that holds the selected one
  leaves nothing selected: `Key` reads `""`. The node is still there, and
  `ExpandNode` plus `Key = k` puts the user back where they were, which is what
  a tree that rebuilds itself should do.
- **Rebuilding the tree lost the user's place.** `Clear()` and refill is the
  ordinary way to reload, and it forgets what was open and what was chosen. Read
  `Key` and the keys that were `Expanded` first, and put them back after — the
  IDE does exactly that on every reload.
- **Two nodes fought over one key.** Keys are one namespace per tree; prefix the
  kinds that could collide.
- **A whole branch disappeared.** `RemoveNode(key)` takes the subtree: that is the
  only thing it can do, since a node with no parent has nowhere to be.
- **The icon is missing and nothing said so.** An icon name the theme does not
  have is dropped. `Application.HasIcon(name)` is the question, and a fallback
  chain is what the IDE's tree uses.

## What it does not do

- **No columns and no headings.** That is a [`TableView`](TableView.md) whose
  rows carry a `Key` — the same hierarchy, with fields.
- **No more than one selected node.**
- **No editing in place, no dragging a node onto another.** Renaming is
  `SetText`, from a dialog or a field of your own; moving a node is `RemoveNode` and
  `Add` under the new parent, which is also the moment your own data moves.
- **No sorting.** The tree shows the order the nodes went in, per parent. Sort
  the data first.

## See also

[`TableView`](TableView.md) · [`ListBox`](ListBox.md) ·
[`ide/modules/ProjectTree.js`](../../../ide/modules/ProjectTree.js) ·
[`examples/table`](../../../examples/table), whose third page is the same
hierarchy with columns
