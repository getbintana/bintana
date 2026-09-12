# Switcher

Pages picked from a strip of linked buttons.

The same stack of pages a [`Notebook`](Notebook.md) holds, with a segmented
control instead of tabs — and, with `Strip: "None"`, a bare stack that only code
switches, which is what a wizard and a *welcome page / workspace* pair are.

It is a [`Container`](Container.md), so everything there is here too; what
follows is what is its own.

## Every member

| | | |
|---|---|---|
| `Count` (ro) | how many pages | [the pages](#the-pages) |
| `Current` | the page showing. Default `-1` | [the page showing](#the-page-showing) |
| `Strip` | `Top` `Bottom` `Start` `End` `None`. Default `"Top"` | [the strip](#the-strip) |
| `Tabs` | the strip, as strings. **Translated** | [the strip](#the-strip) |
| `Append(child, [name])` | one more page | [the pages](#the-pages) |
| `Remove(index)` | takes one out | [the pages](#the-pages) |
| **event** `Switch(index)` | a different page is showing | [the page showing](#the-page-showing) |

## Which of the two is this one

| | reach for it when |
|---|---|
| [`Notebook`](Notebook.md) | the pages are **documents** the user opened — tabs, and a strip that can hold a button |
| **`Switcher`** | **the pages are modes of one window** — a segmented control, or no strip at all |

## The pages

| | |
|---|---|
| `Append(child, [name])` | one more page. The child is the page |
| `Remove(index)` | takes it out, with the control in it |
| `Count` (ro) | how many there are |

## The page showing

| | |
|---|---|
| `Current` | which page is showing. Assigning it switches, and **raises `Switch`** |
| **event** `Switch(index)` | a different page is showing |

**`Strip: "None"` plus `Current` from code is the whole of a wizard**, and of the
IDE's own window, which is a switcher of two pages — the welcome page and the
workspace — with nothing to click between them.

## The strip

| | |
|---|---|
| `Strip` | `Top` `Bottom` `Start` `End`, or `None` |
| `Tabs` | the labels, as strings. **Translated**. A segmented control has nowhere to put a widget, so this is the whole of it |

## What goes wrong

- **Nothing switches.** `Strip: "None"` and nothing assigns `Current`.
- **Assigning `Current` ran the handler.** It does.
- **A button was wanted in the strip.** That is a [`Notebook`](Notebook.md);
  this strip is buttons of its own and holds nothing else.

## See also

[`Notebook`](Notebook.md) · [`Panel`](Panel.md) · [ide.md](../../ide.md)
