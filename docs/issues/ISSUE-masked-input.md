# ISSUE: a field cannot declare the shape of what is typed into it

## What the application needed

A tax-id field that takes `12.345.678-9` and nothing else, and a phone
field that takes `+34 600 00 00 00`. The concrete case was an invoicing form
where the customer types their VAT number and the number has to be right
before the invoice can be issued: the digits in their places, the dashes
where they belong, and a letter refused rather than caught on save.

## What I wrote instead

A `Change` handler on the `TextBox` that rewrites what was typed into the
shape the field wants: strip the characters that do not belong, put the
separators back, write the result into `Text`. It costs a handler that has to
know the shape, per field, and a caret that jumps to the end of the field on
every keystroke while the rewriting happens.

## The code I wish I could have written

```js
// a field that says what it accepts:
{
  "type": "TextBox",
  "name": "TxtTaxId",
  "properties": { "Mask": "00.000.000-0" }
}
// where `0` is a digit and everything else is a literal, and the field
// refuses what does not fit rather than the program catching it on save
```

## Why the existing words do not cover it

`TextBox` has fourteen members and none of them is a mask: `Text`,
`MaxLength`, `Purpose`, `Alignment`, `Selection`, `Offset`, `Insert`,
`Select`, `SelectAll`, `Placeholder`, `Icon`, `ReadOnly`, `Password` and
`ActivatesDefault` (`runtime/src/bta_controls.c:2988-3064`). `Purpose` is
close and says so itself: it names what the keyboard and the input method
should expect, and it "**does not validate**: a field of `Purpose: "Number"`
still takes letters" (`:2999-3007`). `MaxLength` counts characters and
nothing else; `Password` only draws dots. Nothing else in the runtime masks
anything either: the only matches for "mask" under `runtime/src` are
`pthread_sigmask` (`runtime/src/bta_debug.c:294`, `:301`, `:310`),
`PangoFontMask` (`runtime/src/bta_widget.c:1832`) and `umask`
(`runtime/src/bta_zip.c:1536`, `:1538`).

## Prior art

VB6's `MaskedEdit` control, whose `Mask` property is set in the property
sheet. .NET `MaskedTextBox`. Java Swing's `JFormattedTextField`. Delphi's
VCL `TMaskEdit`, with its `EditMask`, and the IDE's own Input Mask editor.
GTK4 has no masked entry of its own — `GtkEntry` and `GtkEntryBuffer` are
the whole of it.

## How much it mattered

It works, but a part of it is noticeably worse: a tax id, a phone or a date
field has to validate in a `Change` handler.
