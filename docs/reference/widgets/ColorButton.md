# ColorButton

A swatch that opens the desktop's colour chooser.

For the case where a colour **is** data: a category, a tag, a series in a chart,
a highlight the user picks. What comes back is exactly what
[`Background`](Widget.md#how-it-looks) and every drawing call here take.

It is a `Widget` and a control like any other, so everything on
[Widget](Widget.md) is on it too; what follows is what is its own.

## Every member

| | | |
|---|---|---|
| `Value` | a CSS colour, `""` for none | [the colour](#the-colour) |
| **event** `Change()` | the value changed, **including from code** | [the colour](#the-colour) |

## The colour

| | |
|---|---|
| `Value` | what was chosen, as an `rgb(…)` or `rgba(…)` string — **what `Background`, `Foreground` and `Painter.Color` take**, so a colour goes from this control to whatever is drawn with it and nothing has to parse anything. `""` is no colour, and the button shows the cleared state |
| **event** `Change()` | the colour changed — chosen, cleared, or **assigned from code** |

The chooser itself is the desktop's, with its palette, its custom colours and its
eyedropper if it has one; nothing about it is this control's to configure.

**A colour that is a *style* does not belong here.** What a button looks like is
[`Style`](Widget.md#how-it-looks) and the theme; this control is for the colours
your data carries.

## What goes wrong

- **The colour came back as a string and something wanted numbers.** It is a CSS
  string on purpose: it is what every colour-taking property here accepts.
- **Clearing it left the old colour.** `""` is the cleared value; read it back
  rather than assuming.
- **Assigning `Value` ran the handler.** It does.

## What it does not do

- **No palette of your own**, no alpha switch, no format choice: the chooser is
  the desktop's.

## See also

[`FontButton`](FontButton.md) · [`Widget`](Widget.md#how-it-looks) ·
[`DrawingArea`](DrawingArea.md)
