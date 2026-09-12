# Expander

A [`Frame`](Frame.md) that folds.

*Advanced options*, *Details*, the part of a form most people never open. Folded,
it takes no room but its own caption; open, it is an ordinary container.

It is a [`Container`](Container.md), so everything there is here too; what
follows is what is its own.

## Every member

| | | |
|---|---|---|
| `Expanded` | open or folded | [open and folded](#open-and-folded) |
| `Text` | the caption one presses. **Translated** | [open and folded](#open-and-folded) |
| **event** `Toggle()` | it was opened or folded | [open and folded](#open-and-folded) |

## Open and folded

| | |
|---|---|
| `Text` | the caption beside the arrow. **Translated** |
| `Expanded` | whether it is open. Assigning it opens or folds it, and **raises `Toggle`** |
| **event** `Toggle()` | it was opened or folded — by the user or by an assignment |

**Folding takes its height back, which is why the window has to know.** An
expander inside a column makes the window shorter when it folds and taller when
it opens; that is the point of it, and it is also why an expander at the *bottom*
of a form behaves better than one in the middle, where everything under it moves.

A form that remembers whether it was open saves `Expanded` with the rest of its
settings — the value is a fact about one person's habits, not about the form.

## What goes wrong

- **The window jumps about.** Something below it moves when it folds; put it
  last, or give the region a `MinHeight`.
- **Assigning `Expanded` ran the handler.** It does.
- **It does not fold back to nothing.** Its child has a `MinHeight`, or the
  window itself cannot be made smaller.

## What it does not do

- **No animation to control**, and no *fold everything* — a page of expanders
  that should behave as one is a loop over them.

## See also

[`Frame`](Frame.md) · [`Notebook`](Notebook.md) · [`Panel`](Panel.md)
