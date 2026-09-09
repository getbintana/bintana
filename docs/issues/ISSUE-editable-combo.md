# ISSUE: no editable / autocompleting combo

## What the application needed

A field that lets the user type to filter a list *and* enter a value that is not
in it: a country field, a client search box that narrows as you type, a "kind"
field where the list is a convenience and not a constraint. The concrete case was
a form whose category was usually one of ten values but occasionally something new.

## What I wrote instead

A `TextBox` beside a `ListBox`, with the `Change` handler re-filling the list and
the `Select` handler writing the choice back — a small component wired by hand,
for every form that wants it. Or the user is forced to pick from a closed
`ComboBox` and free text is simply not offered.

## The code I wish I could have written

```js
// either the combo made open:
//   ComboBox with `Editable: true`, typing filters `Items`, Enter takes the text
// or the entry given a list:
//   TextBox with `Completion: this.categories`, raising `Complete(word)` to filter
```

## Why the existing words do not cover it

`ComboBox` is a `GtkDropDown` — the implementation says it outright, *one choice
out of a closed list* — so `Index` and `Text` are the whole of it and there is no
typing. `TextBox` has `Icon`, `Purpose` and `Placeholder` but no completion list.
`SourceEditor.Completion` exists but is a code editor's word-list, not a form
field's.

## Prior art

VB6 `ComboBox` with `Style = Dropdown` and AutoComplete. .NET
`ComboBox.AutoCompleteMode` / `AutoCompleteSource`. GTK4 removed `GtkComboBoxText`
but still offers `GtkEntryCompletion`, which is what an editable combo is built on.

## How much it mattered

It works, but a part of it is noticeably worse: the single most common free-form
input pattern in a RAD form has to be assembled from two controls every time.
