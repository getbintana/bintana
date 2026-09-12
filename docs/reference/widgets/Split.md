# Split

Two regions and a divider the user can drag.

A list beside a detail, a tree beside an editor, a body over a console: whenever
a window has two parts and the user should decide how much room each gets, this
is the container. It holds **exactly two** children and refuses a third.

It is a [`Container`](Container.md), so everything there is here too; what
follows is what is its own.

## Every member

| | | |
|---|---|---|
| `Arrangement` | `Horizontal` `Vertical` **only**. Default `"Horizontal"` | [the two halves](#the-two-halves) |
| `Grows` | `Both` `Start` `End` `Neither` — which half takes the slack | [what happens when it is resized](#what-happens-when-it-is-resized) |
| `Position` | where the divider sits, in pixels from the start | [the divider](#the-divider) |
| `WideHandle` | a fat divider, easier to grab | [the divider](#the-divider) |

No methods and no events of its own. The halves go in with
[`Add`](Container.md#putting-children-in), in order.

## The two halves

| | |
|---|---|
| `Arrangement` | `Horizontal` puts them side by side, `Vertical` one over the other. **There is no `Fixed`**: two halves have an axis and nowhere to put a coordinate, which is why this property shadows [`Container`](Container.md#the-two-layout-models)'s |

The first child added is the start half — left or top — and the second is the
end. A third `Add` throws; to change what is in a split, `Clear()` it and add
two again.

**Each half is usually a `Panel`**, and that is where the coordinates go if the
region is drawn: boxes for the skeleton, a surface inside a region. Splits nest
— the IDE's window is a split whose second half is another split — and each one
remembers its own divider.

## The divider

| | |
|---|---|
| `Position` | where it sits, in pixels from the start of the axis. Assigning moves it; reading gives where it is now, including after the user has dragged it |
| `WideHandle` | a fat divider. Easier to grab, and the right answer when the two halves have no visible edge of their own |

**`Position` is worth saving and putting back.** Where somebody dragged the
divider is a fact about their screen and their eyes, and it belongs in the
application's settings rather than in the form — the IDE keeps its four dividers
in `Settings` for exactly that reason, and puts them back when the window opens.

## What happens when it is resized

| | |
|---|---|
| `Grows` | `Both` (the default), `Start`, `End` or `Neither` — which half takes the room when the split itself grows or shrinks |

`Start` keeps the end half at its size, which is what a detail pane beside a
fixed-width list wants; `End` does the opposite, which is the shape of a sidebar
with a body beside it — the sidebar keeps its width and the body takes the
window. `Neither` keeps both, which only makes sense with something else
absorbing the difference.

**A half that must not be squeezed to nothing says so with `MinWidth` — and with
`HAlign: "Fill"`.** This is the trap that was measured while writing
[`examples/clients`](../../../examples/clients): a `MinWidth` on an axis that is
not filling means nothing, so the divider could be dragged down to 46 pixels
instead of stopping at 280. See
[Container](Container.md#which-model-a-form-should-use).

## What goes wrong

- **A third `Add` threw.** A split is two halves. `Clear()` and add two.
- **The divider will not stay where it was put.** `Position` assigned before the
  window has been laid out is a position on a widget with no size yet: move it
  from `Timer.After(0, …)`, which is where every measurement here belongs.
- **Dragging the divider squeezes a half to nothing.** `MinWidth`/`MinHeight` on
  the half, **and** `HAlign`/`VAlign` of `Fill` on it, or the floor means
  nothing.
- **The wrong half grew.** `Grows`.
- **The divider cannot be grabbed.** `WideHandle`.
- **`Arrangement: "Fixed"` was refused.** There is no third place for a child to
  be.

## What it does not do

- **No collapsing.** A pane that folds away to a strip is a `Split` whose
  `Position` you move, or a [`Switcher`](Switcher.md) that swaps the whole half.
- **No more than two.** Splits nest, which is how three regions are built and how
  every editor with a tree, a body and a console is put together.
- **No remembering.** `Position` is a number your application saves; nothing here
  writes to disk.

## See also

[`Container`](Container.md) · [`Panel`](Panel.md) · [`Notebook`](Notebook.md) ·
[`Scroller`](Scroller.md) · [ide.md](../../ide.md), whose window is three splits
