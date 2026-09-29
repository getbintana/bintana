# Notebook

Pages in tabs. Its children **are** its pages.

The window that holds several things the user chooses between: the tabs of an
editor, the sections of a settings dialog, the panels of a workspace.

It is a [`Container`](Container.md), so everything there is here too; what
follows is what is its own.

## Every member

| | | |
|---|---|---|
| `Count` (ro) | how many pages there are | [the pages](#the-pages) |
| `Current` | which page is showing, `-1` when there are none | [the page showing](#the-page-showing) |
| `Strip` | where the tabs are | [the strip](#the-strip) |
| `Tabs` | the labels, as an array of strings | [the strip](#the-strip) |
| `Append(child, [label])` | one more page, at the end | [the pages](#the-pages) |
| `GetAction(where)` | the widget in that end of the strip, or `null` | [a widget in the strip](#a-widget-in-the-strip) |
| `RemovePage(index)` | takes that page out, and the control in it goes with it | [the pages](#the-pages) |
| `SetAction(control, [where])` | puts a widget **in the tab strip** instead of making it a page | [a widget in the strip](#a-widget-in-the-strip) |
| `SetTabLabel(index, label)` | renames one, and **`label` is a widget** like `Append`'s — what a tab showing a file name and an asterisk needs | [the strip](#the-strip) |
| **event** `Switch(index)` | a different page is showing — chosen by the user or assigned | [the page showing](#the-page-showing) |
| **event** `Reordered(page, index)` | the pages changed order — a tab dragged along the strip, or `Reorder(page, index)` from code, and **both arrive here** | [the pages](#the-pages) |

## The pages

| | |
|---|---|
| `Append(child, [label])` | one more page, at the end. The child **is** the page — usually a [`Panel`](Panel.md), which is then an ordinary container. **`label` is a widget too** (a [`Label`](Label.md)), not text: a tab has room for one, where a [`Switcher`](Switcher.md)'s page name is a string. A tab label that has to change is a `Label` you keep and mutate |
| `RemovePage(index)` | takes that page out, and the control in it goes with it |
| `Count` (ro) | how many pages there are. **An action widget in the strip is not one** |

A page declared in a `.form` is an ordinary child; `Tabs` names them.
[`Reorder`](Container.md#the-order-they-are-in) moves a page along the strip, and
**a tab can also be dragged along it**. Both roads report the same event:

| | |
|---|---|
| **event** `Reordered(page, index)` | the pages changed order — a tab dragged along the strip, or `Reorder(page, index)` from code, and **both arrive here**. `index` is where the page landed, which is the half a caller keeping its own list of pages needs |

Anything keeping a list of pages beside the notebook has to follow it: the strip
moves without asking, and a list that is not rebuilt on `Reordered` answers with
the wrong page from the next click on.

## The page showing

| | |
|---|---|
| `Current` | which page is showing, `-1` when there are none. Assigning it switches, and **raises `Switch`**. Default `-1` |
| **event** `Switch(index)` | a different page is showing — chosen by the user or assigned |

**A notebook with no pages is not nothing**: it is an expanding widget with an
empty body, which is why a window that may have none hides the whole thing rather
than leaving a blank band. That is what the IDE does when every file is closed.

## The strip

| | |
|---|---|
| `Strip` | where the tabs are: `Top` `Bottom` `Start` `End`, or `None` for no strip at all — which is a notebook only code switches, and a [`Switcher`](Switcher.md) is usually the better answer. Default `"Top"` |
| `Tabs` | the labels, as an array of strings. **Translated** |
| `SetTabLabel(index, label)` | renames one, and **`label` is a widget** like `Append`'s — what a tab showing a file name and an asterisk needs |

## A widget in the strip

| | |
|---|---|
| `SetAction(control, [where])` | puts a widget **in the tab strip** instead of making it a page. `where` is `Start` or `End`; `null` takes it out. In a `.form` this is a child carrying `"strip": "End"` |
| `GetAction(where)` | the widget in that end of the strip, or `null` |

The button at the end of a strip of tabs — *close all*, *new tab*, a menu — which
is a place a window has and a page is not. In a `.form` it is a child carrying
`"strip": "End"`, which is how it survives being opened and saved by a designer.

## What goes wrong

- **`Count` is one more than the tabs.** An action widget is in the strip and is
  not a page — it is not counted, so if the number is wrong, something else is.
- **Assigning `Current` ran the handler.** It does.
- **A blank band above the content.** A notebook with no pages: hide it.
- **The tab labels came back in another language.** They are prose and go through
  the catalogue; a tab showing a file name is set with `SetTabLabel` from code.
- **Your own list of pages answers with the wrong one.** A drag moves the strip
  without anything asking; rebuild the list from `Children` on `Reordered`.

## What it does not do

- **No closing button per tab.** A tab is a label; the close is a
  `SetAction` button plus your own menu, which is what the IDE does.
- **No dragging tabs between windows.**

## See also

[`Switcher`](Switcher.md) · [`Panel`](Panel.md) · [`Split`](Split.md) ·
[ide.md](../../ide.md), whose tabs are this control
