# ISSUE: nothing in a form mirrors for a right-to-left language

## What the application needed

An Arabic form: the labels on the right of their fields, the fields
right-aligned, the whole panel laid out from the right edge, and the icons
pointing the other way. The concrete case was a warehouse screen for a
customer in Casablanca — the same fields, the same handlers, laid out the
other way round because that is how the language reads.

## What I wrote instead

The form laid out by hand for the other direction: every `Label` given
`HAlign: "End"`, every `TextBox` given `Alignment: "Right"`, and the panels
built with `Arrangement: "Vertical"` so the children stack in the order the
language wants. It costs a second `.form` to keep in step with the first,
and the icons are the part that cannot be fixed by hand at all.

## The code I wish I could have written

```js
// a form that says which way it reads:
{
  "type": "Form",
  "name": "Main",
  "properties": { "Direction": "RightToLeft" }
}
// and the fixed surface inside it mirroring its children, the way a box does
```

## Why the existing words do not cover it

No control in the runtime has a direction. `Widget` has no such property, so
there is nowhere to put "RightToLeft" and nothing reads it. The one place the
runtime touches the idea at all is the icon lookup, and it looks an icon up
left-to-right every time: `runtime/src/bta_controls.c:2318` and `:2388` pass
`GTK_TEXT_DIR_LTR` to the theme, so an icon that has a mirrored variant is
never asked for the mirrored one. The `Fixed` surface is the other half of
the trouble: it anchors each child by its alignment against the declared size
(`runtime/src/bta_fixed.c:194`, `anchor_axis`), and an alignment that means
"end" means the right edge in every language. GTK's own boxes do mirror, so a
form with a box in it and a form with a `Fixed` in it disagree with each other.
GTK4 kept the vocabulary for all of this — `gtk_widget_set_direction`,
`gtk_widget_set_default_direction`, `GTK_TEXT_DIR_RTL`, and a `GtkTextTag`'s
`direction` for a run of text — and the runtime uses none of it.

## Prior art

Qt `QLayout::setDirection` and `Qt::RightToLeft`. WinForms `RightToLeft` and
`RightToLeftLayout`. GTK4 `gtk_widget_set_direction` and `GTK_TEXT_DIR_RTL`.

## How much it mattered

It works, but a part of it is noticeably worse: an RTL locale gets a form
that is half mirrored.
