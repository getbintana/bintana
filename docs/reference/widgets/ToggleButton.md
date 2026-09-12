# ToggleButton

A button that stays in.

A [`Button`](Button.md) whose press is a state: bold in a toolbar, *show hidden
files*, a mode the window is in. It looks like a button, which is what separates
it from the box and the switch.

It is a `Widget` and a control like any other, so everything on
[Widget](Widget.md) is on it too; what follows is what is its own.

## Every member

| | | |
|---|---|---|
| `Active` | whether it is in | [in or out](#in-or-out) |
| `Icon` | an icon name from the theme, as a `Button`'s | [what it says](#what-it-says) |
| `Text` | the caption. **Translated** | [what it says](#what-it-says) |
| `Click()` | presses it from code, which toggles `Active` | [in or out](#in-or-out) |
| **event** `Click()` | it was pressed | [in or out](#in-or-out) |

## Which of the three is this one

| | reach for it when |
|---|---|
| **`ToggleButton`** | **it belongs in a toolbar and should look like a button** |
| [`CheckButton`](CheckButton.md) | it is an option in a dialog, or one of an exclusive set |
| [`Switch`](Switch.md) | it is a setting that takes effect at once, in a list of settings |

## What it says

| | |
|---|---|
| `Text` | the caption. **Translated** |
| `Icon` | an icon from the theme. Alone it gets the icon-button treatment, which is the square toolbar shape; a name the theme cannot draw is dropped in silence |

A row of them wants `Style: "flat"` and, if they are one exclusive set, a
[`Panel`](Panel.md) with `Style: "linked"` around them — the theme then draws
them as one segmented control.

## In or out

| | |
|---|---|
| `Active` | whether it is in. Assigning it **raises `Click`** |
| `Click()` | presses it from code: toggles `Active` and runs the handler |
| **event** `Click()` | it was pressed — or assigned |

```js
BtnBold_Click() { this.applyBold(this.BtnBold.Active); }
```

**There is no exclusive group here.** A set of toggle buttons of which only one
may be in is a set your handler keeps: turn the others off when one goes on —
three lines, and the only place that rule lives.

## What goes wrong

- **Setting `Active` from code ran the handler.** It does.
- **Two of them are in at once.** Nothing here enforces exclusivity; that is a
  `Group` of [`CheckButton`](CheckButton.md)s or your own handler.
- **It looks like an ordinary button.** It is one, until it is pressed; the
  theme draws the pressed state, and `Style: "flat"` is what makes that
  legible in a toolbar.

## What it does not do

- **No group.** See above.
- **No third state.**

## See also

[`Button`](Button.md) · [`CheckButton`](CheckButton.md) · [`Switch`](Switch.md)
