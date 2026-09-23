# ComboBox

A drop-down: one of a list, chosen on one line.

The same list a [`ListBox`](ListBox.md) holds, closed up into the room a field
takes. Reach for it when the choice is *settled* most of the time and the list is
in the way the rest of it.

It is a `Widget` and a control like any other, so everything on
[Widget](Widget.md) is on it too; what follows is what is its own.

## Every member

| | | |
|---|---|---|
| `Count` (ro) | how many rows | [the list](#the-list) |
| `Index` | which is chosen, `-1` for none. Default `-1` | [what is chosen](#what-is-chosen) |
| `Items` | the contents, as an array of strings. **Translated** | [the list](#the-list) |
| `Text` | the chosen text | [what is chosen](#what-is-chosen) |
| `Add(text, [key])` | one more row, with the application's own name for it | [the list](#the-list) |
| `Key` | the selected row's key; assigning selects | [what is chosen](#what-is-chosen) |
| `KeyAt(index)` | → that row's key, without selecting it | [the list](#the-list) |
| `RemoveRow(index)` | takes a row out | [the list](#the-list) |
| `SetText(index, text)` | renames one in place | [the list](#the-list) |
| `Clear()` | empties it | [the list](#the-list) |
| **event** `Select()` | the selection moved | [what is chosen](#what-is-chosen) |

## When it is not a `ComboBox`

- **Two or three choices that should all be visible** — a `Group` of
  [`CheckButton`](CheckButton.md)s, which shows the options instead of hiding
  them.
- **On or off** — [`Switch`](Switch.md) or [`CheckButton`](CheckButton.md).
- **The list is long and being browsed** — [`ListBox`](ListBox.md), which stays
  open.
- **The user may type something that is not in the list** — a
  [`TextBox`](TextBox.md); this control chooses, it does not accept.

## The list

| | |
|---|---|
| `Items` | the contents, as an array of strings. Assigning replaces every row at once. **Translated**: a list declared in a `.form` goes through the catalogue |
| `Add(text, [key])` | one more, at the end. `key` is the application's own name for it |
| `KeyAt(index)` | → that row's key, without selecting it. **`RangeError`** when there is no such row |
| `RemoveRow(index)` | takes one out. **`RangeError`** when there is no such row |
| `SetText(index, text)` | renames one in place, leaving the selection where it is. **Translated**; **`RangeError`** when there is no such row |
| `Clear()` | empties it, and nothing is chosen afterwards |
| `Count` (ro) | how many rows there are |

**Renaming one row is not `Items` again.** Reading the array, changing a string
and assigning it back loses the selection and is how a program ends up comparing
translated text to find the row it wanted; `SetText` is one row, in place.

**Words go in the `.form`, data comes from code.** A drop-down of *Small /
Medium / Large* is prose and belongs in the file, where a translator finds it; a
drop-down of the project's files is filled from code and must not be.

## What is chosen

| | |
|---|---|
| `Index` | which row is chosen, `-1` for none. Assigning chooses it and raises `Select` |
| `Key` | the chosen row's key, `""` for none; assigning chooses the row it belongs to, and a key nothing has is a `RangeError`. `""` moves nothing, as `Index = -1` does |
| `Text` | the chosen row's words. Reading it is reading the *translated* text |
| **event** `Select()` | the selection moved — by the user or by an assignment |

**Compare `Index`, never `Text`.** The words are prose and a translated build
answers in another language; the position is the same in every language. This is
the trap this tree already fell into once — a `ComboBox` of keywords declared in
a `.form`, compared by text, which stopped working the moment the catalogue had
an entry for it.

## What goes wrong

- **The comparison stopped working in another language.** Compare `Index`.
- **Assigning `Index` ran the handler.** It does; guard while a form fills
  itself in.
- **Nothing is chosen at the start.** `Index` is `-1` by default: a drop-down
  that should open on something says so — in the `.form` or right after `Items`.
- **`Clear()` left the handler thinking something was chosen.** It leaves
  nothing chosen, and what a form shows about the selection is yours to update.

## What it does not do

- **No typing.** It chooses from the list.
- **No icons, no columns, no groups.** [`ListBox`](ListBox.md) for words that
  stay visible, [`TableView`](TableView.md) for rows with fields.
- **No multiple selection.**

## See also

[`ListBox`](ListBox.md) · [`CheckButton`](CheckButton.md) ·
[`TextBox`](TextBox.md)
