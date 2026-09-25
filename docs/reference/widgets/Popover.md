# Popover

A surface that floats over a control instead of taking room in the layout.

The list of suggestions under a field, the rows a button drops, a small form
that belongs to whatever it points at. It is a [`Container`](Container.md), so
everything there is here too; what follows is what is its own.

## Every member

| | |
|---|---|
| `Position` | which side of the anchor it prefers: `Top` `Bottom` `Left` `Right` | [opening](#opening) |
| `Arrow` | draw the tail pointing back at the control | [opening](#opening) |
| `Autohide` | close on a click outside or Escape | [opening](#opening) |
| `Visible` (ro) | whether it is open — **read-only** | [closing](#closing) |
| `Popup(anchor)` | opens it over that control | [opening](#opening) |
| `Close()` | closes it, and is safe at any time | [closing](#closing) |
| `Show()` | refuses, and names `Popup(anchor)` | [opening](#opening) |
| **event** `Open()` | it came up, however it was asked | [the two events](#the-two-events) |
| **event** `Close()` | it went down | [the two events](#the-two-events) |

## Which one is this

**A `Popover` floats over the window; an [`Overlay`](Overlay.md) stacks inside
it.** An overlay's layers are *in* the layout — they take the overlay's
rectangle and a click can land on one — while a popover is a surface of its own
that appears at a point and disappears again, and contributes no measure to the
container it was added to. Reach for the overlay for a spinner over a list and
for the popover for the list a field drops.

**It is not a [`Frame`](Frame.md) and not a [`Panel`](Panel.md)**: those take
room, always, whether or not anything is in them.

## On a form

A popover is a child of a container like any other, so a `.form` draws it beside
what it belongs to and its content is built from the file:

```json
{ "type": "Panel", "name": "Field", "children": [
    { "type": "TextBox", "name": "Txt" },
    { "type": "Popover", "name": "Sug",
      "properties": { "Position": "Bottom", "Autohide": false },
      "children": [ { "type": "RowList", "name": "Lst" } ] } ] }
```

```js
Txt_Change() { this.Sug.Popup(this.Txt); }          /* type, and the list opens */
Txt_KeyPress(key) {
    if (key === "Escape") { this.Sug.Close(); return true; }
    return false;
}
Lst_Activate() { this.Txt.Text = this.Lst.Text; this.Sug.Close(); }
```

**`examples/todo` is the smallest one that uses it**: every row carries a
three-dots button that drops `Move up` / `Move down` / `Delete`, built in code
because there is one row per task — and `tests/widgets` asserts the round trip
itself: it opens, raises `Open`, closes and raises `Close`, and the content
goes in and out again.

[`examples/composites`](../../../examples/composites) has the other two shapes
a popover comes in, and the flag that separates them: a suggestion list under a
field keeps `Autohide: false` because the keyboard has to stay in the entry, so
the program closes it; a select opens with GTK's own menu behaviour and lets
arrows, Enter, Escape and a click outside do the work.

## Opening

| | |
|---|---|
| `Popup(anchor)` | opens it over that control. The anchor must have been laid out and the window must be up, because the popup is positioned against the anchor's rectangle |
| `Position` | `Top`, `Bottom`, `Left` or `Right`: the side of the anchor it **prefers**, and GTK moves it when there is no room there. Default `"Bottom"` |
| `Arrow` | the tail. `false` by default, unlike GTK's own popover: a menu wants the tail and a list of suggestions flush against a field does not |
| `Autohide` | `true` by default: a click outside or Escape closes it, and `Close` is raised |
| `Show()` | refuses. The inherited verb would show a surface with nothing to point at |

**Opening gives the window a focus if it had none**, the anchor first — GTK's
own focus walk for an autohide popover reads the window's focused widget and
asserts when there is none, which is measured and was one critical per open.
A list of suggestions opened from a field therefore goes on having the keyboard
where it was.

## Closing

| | |
|---|---|
| `Close()` | closes it, and does nothing when it is already closed |
| `Visible` (ro) | the answer to *is it open* — and **read-only**, because it is a state and not a declaration |
| `Autohide` | closes it from the outside, and raises `Close` the same way |

**`Visible` is the one property a class takes away from `Widget`.** A `.form`
would assign it while the window is still being built, and
`gtk_widget_set_visible(TRUE)` on a popover with no toplevel is a crash inside
GTK — measured, not a warning. So `Widget.Member("Popover", "Visible")` answers
`ReadOnly`, a `.form` that declares it is refused, the property grid does not
offer it, and the serialiser never writes it.

## The two events

| | |
|---|---|
| **event** `Open()` | it came up — `Popup()`, or anything else that showed it |
| **event** `Close()` | it went down: `Close()`, a click outside, Escape, or the window going with it |

A `Close` handler is where a program puts back what opening changed: the
highlight on the field, the arrow's direction, or the focus. It arrives whether
the program closed the popover or the user did.

## The content

One child, like an [`AspectFrame`](AspectFrame.md), and a second `Add` is a
`RangeError` rather than GTK silently dropping the first. GTK wraps the content
in a widget of its own, which nothing here shows: `Children` reaches the child
that went in, `Clear()` empties it and `Remove()` takes it out.

## What goes wrong

- **`Popup` refuses: the window is not shown yet.** `Form`'s `Open` runs before
  the window is presented, and an anchor with no rectangle has nowhere to point
  at.
- **`Popup` refuses: the popover is in no container.** It is positioned from
  where it lives; `Add` it to the panel the field is in first.
- **`Visible = true` does nothing.** It is read-only on purpose: `Popup(anchor)`.
- **The popover appears in the tab order.** It does not — a closed popover is
  not a Tab stop — but its *content* is focusable while it is open, which is
  what `Autohide: false` is for when the field must keep the keyboard.

## What it does not do

- **No second child**, no arrangement, no coordinates: `Placement` is `Single`.
- **No `X`/`Y`.** Where it appears is what `Popup` points at, not a coordinate
  in the form.
- **No modality.** It does not stop the rest of the window from being used;
  `Autohide` closes it, it does not block. A blocking surface is
  [`Form`](Form.md)'s `Modal`.
- **It has no size of its own.** The content decides how big the popup is.

## See also

[`Container`](Container.md) · [`Overlay`](Overlay.md) ·
[`AspectFrame`](AspectFrame.md) · [`RowList`](RowList.md) ·
[`TextBox`](TextBox.md)
