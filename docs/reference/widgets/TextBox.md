# TextBox

One line of editable text.

A name, a number, a search, a password: the field a form is mostly made of. One
line and only one — a `GtkEntry` has no notion of a newline at all — so anything
with paragraphs in it is a [`TextEditor`](TextEditor.md).

It is a `Widget` and a control like any other, so everything on
[Widget](Widget.md) is on it too; what follows is what is its own.

## Every member

**Properties**

| | | |
|---|---|---|
| `ActivatesDefault` | Enter presses the form's default button | [Enter](#enter) |
| `Alignment` | `Left` `Center` `Right`, default `"Left"` | [what the field expects](#what-the-field-expects) |
| `Icon` | an icon inside the field, clickable | [what the field expects](#what-the-field-expects) |
| `MaxLength` | characters, `0` for no limit | [what is in it](#what-is-in-it) |
| `Password` | the characters are hidden | [what is in it](#what-is-in-it) |
| `Placeholder` | shown while it is empty. **Translated** | [what is in it](#what-is-in-it) |
| `Purpose` | what the keyboard should expect | [what the field expects](#what-the-field-expects) |
| `ReadOnly` | shown but not editable | [what is in it](#what-is-in-it) |
| `SelectedText` (ro) | what is selected, `""` for nothing | [the selection](#the-selection) |
| `Text` | what is in it. **Translated** | [what is in it](#what-is-in-it) |

**Methods**

| | | |
|---|---|---|
| `Select(start, length)` | selects that run | [the selection](#the-selection) |
| `SelectAll()` | selects everything, so typing replaces it | [the selection](#the-selection) |

**Events**

| | | |
|---|---|---|
| `Activate()` | Enter in the field | [Enter](#enter) |
| `Change()` | the value changed, **including from code** | [what is in it](#what-is-in-it) |
| `IconClick()` | the icon inside the field was clicked | [what the field expects](#what-the-field-expects) |

`Caption` is an alias of `Text`, so a form may declare either.

## When it is not a `TextBox`

- **More than a line** — [`TextEditor`](TextEditor.md), which wraps and scrolls;
  [`SourceEditor`](SourceEditor.md) when it is code.
- **A number with a range** — [`SpinBox`](SpinBox.md), which has `Min`, `Max` and
  `Step` and cannot be given letters at all. `Purpose: "Number"` here only tells
  the keyboard what to expect; it does not validate.
- **A date** — [`DatePicker`](DatePicker.md), which answers `"YYYY-MM-DD"` and
  opens a calendar; a typed date is a parsing problem you do not have to have.
- **One of a set** — [`ComboBox`](ComboBox.md).
- **Something to read and copy but not edit** — a `ReadOnly` field looks like a
  field, which says *this is a value you may take*; a
  [`Label`](Label.md#selectable) with `Selectable` says *this is text on a form*.

## On a form

```json
{ "type": "TextBox", "name": "TxtFind",
  "properties": { "X": 8, "Y": 8, "Width": 220,
                  "Placeholder": "Search", "Icon": "edit-find-symbolic" } }
```

```js
TxtFind_Change()    { this.needle = this.TxtFind.Text; this.List.Refilter(); }
TxtFind_IconClick() { this.TxtFind.Text = ""; }
```

That is the shape of a search field — [`examples/files`](../../../examples/files)
and [`examples/contacts`](../../../examples/contacts) both have one: it filters as
you type, so there is no button to press and nothing to wait for.

## What is in it

| | |
|---|---|
| `Text` | what is in the field. **Translated**, so a starting value declared in a `.form` goes through the catalogue — which is why a value that is *data* is assigned from code |
| `Placeholder` | the grey words shown while it is empty. **Translated**. It is a hint, never a label: a field whose only label is its placeholder has no label once somebody types in it |
| `MaxLength` | how many characters may be typed; `0` is no limit |
| `ReadOnly` | shown but not editable. **The program can still write to it** — which is what a field that reports something wants |
| `Password` | the characters are drawn as dots. `Text` still answers with the real thing, because the program is the one asking |
| **event** `Change()` | the value changed — typed, pasted, cleared, **or assigned from code**: the round trip goes out to GTK and back, so a form that fills a field in raises its own handler |

**`Change` fires for an assignment.** Measured: `this.Txt.Text = "hello"` raises
`Change` once. A form that fills its fields from a record and validates in
`Change` will validate while it is filling them in, which is the re-entrance every
data form here has to deal with: a `loading` flag around the assignments, and the
handler returns early while it is set.

**`MaxLength` cuts what is already there.** Measured: a field holding `hello`
given `MaxLength = 3` reads `hel` from then on. It is a property about the field,
not about typing, so set it before the value.

## The selection

| | |
|---|---|
| `SelectedText` (ro) | what is selected, `""` when nothing is |
| `Select(start, length)` | selects that run, counting from `0` |
| `SelectAll()` | selects everything, so **the next keystroke replaces it** |

`SelectAll()` is what a field wants when it is given the focus for a value the
user is expected to overwrite — a rename dialog, a quantity, a search that is
being re-run. `SetFocus()` alone leaves the caret where it was.

## What the field expects

| | |
|---|---|
| `Purpose` | `Text` `Digits` `Number` `Phone` `Url` `Email` `Name` — what the keyboard and the input method should expect. Default `"Text"`. On a phone it is which keyboard appears; on a desktop it is what the input method does. **It does not validate**: a field of `Purpose: "Number"` still takes letters, and what refuses them is a [`SpinBox`](SpinBox.md) or your own check |
| `Alignment` | `Left` `Center` `Right`, default `"Left"`. Numbers read right-aligned, which is the one case worth changing it for |
| `Icon` | an icon **inside** the field, at the end. Clicking it raises `IconClick` |
| **event** `IconClick()` | that icon was clicked |

The icon is the field's own verb: a magnifier that clears the search, an eye that
shows the password, a calendar that opens a picker. It costs no room on the form,
which is the reason to prefer it to a button beside the field.

## Enter

| | |
|---|---|
| `ActivatesDefault` | Enter presses the form's **default button** *instead of* raising `Activate` |
| **event** `Activate()` | Enter in the field, when `ActivatesDefault` is off |

**One or the other, and the dialog wants the first.** A dialog with a field and an
OK button should set `ActivatesDefault` and put the work in the button's handler:
one place does the work, and Enter and the button cannot drift apart. `Activate`
is for the field that *is* the command — a search box that runs on Enter, a
console entry.

## What goes wrong

- **The handler ran while the form was filling itself in.** `Change` fires for an
  assignment. A `loading` flag around the assignments, and return early.
- **Enter does nothing.** No button on the form declares `Default`, or
  `ActivatesDefault` is off and there is no `Activate` handler.
- **Enter submitted the form and the field's own handler never ran.**
  `ActivatesDefault` is on; that is what it does.
- **The value came back cut.** `MaxLength` cut it — it applies to what is already
  there, not only to typing.
- **Letters got into a number field.** `Purpose` is a hint to the keyboard;
  validate yourself, or use a [`SpinBox`](SpinBox.md).
- **The placeholder disappeared and nobody knows what the field is.** A
  placeholder is a hint; a field that needs a name needs a
  [`Label`](Label.md) beside it.
- **A password came out in a log.** `Password` hides the drawing, not the value.

## What it does not do

- **No newlines.** A `GtkEntry` has none to hold.
- **No validation, no mask, no format.** What a field accepts is your `Change` or
  `LostFocus` handler, or a control that cannot be given the wrong thing —
  `SpinBox`, `DatePicker`, `ComboBox`.
- **No completion.** That is [`SourceEditor`](SourceEditor.md)'s, which is a
  different control for a different job.
- **No undo.** The editors have it; a one-line field does not.

## See also

[`TextEditor`](TextEditor.md) · [`SpinBox`](SpinBox.md) ·
[`DatePicker`](DatePicker.md) · [`ComboBox`](ComboBox.md) ·
[`Label`](Label.md) · [`examples/files`](../../../examples/files)
