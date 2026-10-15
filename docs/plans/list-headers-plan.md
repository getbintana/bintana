# Headers and homogeneous rows in a list

**Not started.** The two halves of one look a list cannot ask for today, whose
first caller is the IDE: the property grid's group headings are a `Label` row
wearing a band (`ide/app.css`, `.prop-group`), and they are **a row** --
selectable, counted by the filter, and as tall as a hand-tuned padding says.
What the page wants instead is a *header*: a band across the list, the same
size as the rows, that no click can select. The reference is gtk4's widget
factory (its `munsell` list), read in its source and measured here against the
installed app.

## What the application needed, measured

The heading today is `PropertyGrid.addHeading`'s `Label` with
`"heading prop-group"` and `HAlign: "Fill"`, and the band's geometry is
`ide/app.css`'s padding. Measured in the IDE on an Xvfb:

| `padding` of `.prop-group` | the band | a property row |
|---|---|---|
| `3px` | 26 px | 44 px |
| `12px` | 44 px | 45 px |

So "similar" is reached by arithmetic against a font's height, and a row whose
editor is taller moves the number again. Two more things follow from the
heading being a row:

- **It is selectable.** The first row of a fresh grid comes out with the
  selection (the list takes focus), which is a highlight over a heading that
  says nothing.
- **It counts.** `PropertyGrid`'s `rowInfo`/`Refilter` map row indices, and the
  filter hides a heading by hand ("shown while anything under it is"), because
  nothing in the runtime knows a heading from a row.

## Prior art: what gtk4-widget-factory does

Its `munsell` page is the case, and the mechanism is `GtkListBox`'s own:

- `gtk_list_box_set_header_func` builds the header (`update_title_header`, a
  bold `GtkLabel` with 12/6/6/6 margins) and hands it to the row with
  `gtk_list_box_row_set_header` -- the row that starts the group.
- **GTK allocates it as a widget of the list, above the row and at the list's
  full width** (`gtk_list_box_size_allocate` measures `ROW_PRIV(row)->header`
  into `header_allocation` and moves the row down by it). That is where "same
  width" and "not selectable" come from: a click on a header lands on no row,
  and the selection highlight cannot reach it. Measured live, by clicking: a
  header changes **0.04 %** of the window's pixels; a row, **5.3 %** (the blue
  selection, edge to edge).
- Rows go `gtk_list_box_row_set_activatable(row, FALSE)` and their contents
  `can-focus: FALSE` -- the row still selects, its header never does.
- **The header's height is its own**: the factory's margins (≈37) against rows
  (≈40) is a chosen likeness, not a mechanism.
- The `GtkSizeGroup` in the factory's `.ui` (mode 2, vertical) is over **another**
  list's rows: it is the mechanism for *equal heights*, and `GtkListBox` itself
  has no `homogeneous` for it.

## The design: two pieces, not alternatives

**1. A header attached to a row.** The road GTK already has, so the list -- and
not a padding -- decides the width, and no click reaches it. What the author
writes is where a group *starts* (a heading between rows), which is not what the
factory's header *func* does (it derives the boundary from row data): the shape
here is a verb on the list, or a flag on the child, decided below.

What the IDE gains: no band arithmetic; no selection over a heading; and the
filter gets simpler -- GTK skips a row's header when the row is filtered
(`row_is_visible` guards the header branch in the same allocate).

What it costs: **a header is not a row**, so the grid's index map (`rowInfo`,
`Refilter`, and anything counting rows) counts rows and not children, and the
rebuild path has to keep the two in step.

**2. `Homogeneous`.** A boolean on `ListBox` and `RowList`, implemented inside
the runtime with a `GtkSizeGroup` -- vertical: the rows already share the
list's width, so both axes would say nothing. The runtime reaches the rows only
through the list (`gtk_list_box_append` wraps what is appended), so the group is
maintained on `Add` and dropped on `Clear`, and never exposed as a
`GtkSizeGroup` object of its own.

This is the half `Style` cannot say at all: a class reaches the control's own
node (the `GtkScrolledWindow`), and the rows are GTK's.

## What was rejected

- **The CSS-only road** -- today's: the band's height copies a row's, in a file
  that hears nothing when a font or an editor changes. Kept as the interim look
  until this lands; the plan is what replaces its arithmetic.
- **`Homogeneous` as the whole answer**: equalising heights makes the heading as
  tall as a row, but not unselectable, and not full width by construction.
- **Clipping** (`gtk_widget_set_overflow`) was weighed while chasing the
  corners of the framed list (a separate question, cancelled): a rounded clip
  does not make a heading unselectable, and it cuts whatever else a child
  paints.

## Open questions, for the owner

- The header's shape and name: a list verb (`AddHeader(...)` ahead of the row it
  heads) or a flag on the child; and whether a row can be asked *not* to be
  selectable without being a header (the grid's selection is not read by the IDE
  at all).
- Whether `Homogeneous` is heights only (this plan assumes so) or the two axes,
  and whether it belongs to both list classes or to the `ListBox` the `RowList`
  already is.
- Whether `ide/app.css` keeps the band's *colour* once the geometry comes from
  the runtime -- yes, by this plan: a colour the theme has no word for stays a
  class; the arithmetic is what goes.

## What is deliberately absent

Sticky headers as one scrolls; headers for the other lists (`TreeView` and
`TableView` have their own stacking/strip mechanisms and their own callers);
keyboard navigation changes; and anything the `.form` format would have to learn
beyond what the chosen API needs -- the format knows no control.
