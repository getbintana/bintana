# Tables

The traps and decisions of this area, each with what it cost and the rule it left. [`AGENTS.md`](../../AGENTS.md) states the rules that apply to every change; this file is the evidence behind them and the detail that only matters here.

## Tables

- **A `GListStore` append raises `items-changed`, and GTK's item manager walks
  the list for each one -- so `Add` in a loop is quadratic.** 10 000 rows took
  0.65 s, 20 000 2.3 s and 40 000 17.4 s (D3 of the October audit), and filling
  a table from a query is exactly that loop. **`AddRows(rows)`** builds every
  row first and hands them over in one `g_list_store_splice`: 40 000 rows in
  42 ms and one change to the view. It is refused on a tree, whose rows are
  nodes with keys, and a refusal adds none of them -- nothing reaches the store
  until every row came through its conversion.
- **`Clear()` is the way out of every mode, on-demand included.** It reset a
  tree to flat but left a table answering `Data` with its `Count`, so
  `Add(values, { Key })` refused with *Clear() it first* and `Clear()` could not
  satisfy it. And a `Data` answer whose `Text` or `Icon` failed to convert left
  the exception pending inside a bind -- reported now like a `Data` that throws,
  with `null` meaning no icon rather than the icon named `null`.
- **`CellEdit` read everything after the handler it had just called, and the
  row index was never there.** `on_cell_edited` passed `row->index`, which only
  `bta_table_model_item` ever writes -- so in a flat table built with `Add`
  every real edit reported and redrew **row 0**, and the suite could not see it
  because it only ever raised the event with `Emit("CellEdit", 0, ...)`. And a
  handler that called `Clear`, `RemoveRow` or `SetCell` unbound or rebound the
  label synchronously, freeing the row, `bta-edit-old` and the label's buffer
  the code went on to read. The index is asked of the store now, before and
  after; the row, the label and the table's wrapper are held and both texts
  copied across the emit. It is `table_report_edit` now, which every editor
  kind goes through, and `EditCell`/`EndEdit` drive it from the suite
  (`TableEditors`); see *A table cell's editors*.
- **A table sorts the text it shows, so the order has to know about numbers
  without knowing the format.** `SortBy` compared cells with `g_utf8_collate`,
  and every column of numbers came out `10, 100, 9`. A per-column type was the
  obvious fix and the wrong one: the cell holds display text, which may be
  `1.234,56`, and parsing it would be guessing a format. So the default is
  **natural order** (`g_utf8_collate_key_for_filename`: the locale's collation
  with digit runs compared as numbers, one key per row computed once, not per
  comparison), and `SortBy(col, asc, compare)` hands the two cells' text to the
  program for what natural order reads wrongly -- a minus sign, grouped
  thousands, a day-first date. **It is stable now**, by a tie broken on the
  position the row had, because `g_list_store_sort` promised nothing about equal
  rows and a second sort could shuffle the first; the rows go back in with one
  `g_list_store_splice`. A comparator that throws or answers no number abandons
  the sort with the store untouched -- in a tree, the levels already sorted stay
  sorted, since each is its own store.
  **And where the minus lands is glib's answer, not the table's**: `-5` sorts
  first under glib 2.88 (Fedora 44) and last under the runner's 2.80, so a
  test that stripped it with `.replace("-5,", "")` passed on Fedora and failed there
  -- green locally, red on `no-xml`, `no-unix-print` and `no-vte`, which are the
  only jobs that run a full suite against that older library.
  The test filters the minus row wherever it lands now; asserting its position
  would be asserting a library version.
- **`GtkColumnView` cannot hide its heading row**, and that fact decides a design
  question rather than being a detail of one. `set_show_row_separators` and
  `set_show_column_separators` are what can be turned off; `set_header_factory`
  is for *section* headings. So a hierarchy with no headings is not expressible
  in a column view, which is why `TreeView` is not "a `TableView` with one
  column" and why the tree mode went into the table rather than columns going
  into the tree. Check what a widget can turn *off* before designing on the
  assumption that it can.
- **A `GtkColumnView`'s heading is the one surface of a widget here that raises
  no pointer event, and GTK is why.** Its title gesture claims the press
  (`click_pressed_cb` in `gtkcolumnviewtitle.c`) before the bubble phase runs,
  so the `MouseDown` a control reports never arrives on a heading -- measured,
  and the reason `TableView.HeaderClick(column, button, ctrl, shift)` exists.
  The runtime's own gesture is in the **capture** phase (which runs first) and
  **does not claim**, because claiming is what would stop GTK from sorting on
  the primary release and from presenting the column's `header-menu` model on
  the secondary one -- the model is installed at the press, GTK shows it at the
  release. Two facts of GTK's own structure are load-bearing and commented
  where they are read: the heading row is the view's **first child** and its
  titles are children **in column order** (hidden columns are not children), so
  a child's index is the column's -- checked in 4.10 and 4.22, no public
  accessor for either, and `Columns[i].Visible` would invalidate the walk.
  **And the menu is built for each click**, because an item has to know which
  column it was opened over: the wrappers on the form are replaced with it, so
  `this.MnuHide.Enabled = false` set from code does not survive the next right
  click. Context belongs in the event's answer (`{ enabled: … }`), which is the
  same rule `Sort` already states for sorting.

## A link in a TableView cell

`Columns[].Link: true` makes a column's cells `GtkLabel`s holding a markup link
(`<a href>`), **not** `GtkLinkButton`s: the label keeps `Alignment` and the
ellipsis, and GTK already gives a link in a label the underline, the pointer, the
focus stop and Enter. Its default `activate-link` hands the address to the
desktop. The address is the cell's text; `SetUri` (held rows) and `Uri` in
`Data`'s answer replace it, and there **an empty `Uri` is "not a link" while an
absent one is "the text"** -- two answers, not one. `CellLink(row, column, uri)`
is raised first and `false` refuses, which is `CellEdit`'s veto; the answer to
GTK is inverted, because TRUE from `activate-link` means *handled, do not open*.
`Link` and `Editable` on one column are refused at declaration. The row is read
and the arguments built before the emit, since a handler may empty the table and
unbind the label under it. Measured with a real pointer on an `Xvfb`: the click
reaches `CellLink` with the right arguments; `tests/widgets` holds the
declaration, `SetUri` and the event's contract, and **whether the desktop then
opens the address is by hand** -- the suite must never launch a browser. The
designer's column dialog offers it as a *Cell* kind beside the editors (see
*A table cell's editors*).
**The probe killed the user's window manager**: clean up a hand-driven `Xvfb`
and its window manager by the PIDs you started (`$!`), never `pkill` by the
window manager's name -- it matches the desktop's own.

## A table cell's editors

`Columns[].Editor` is a kind with options -- `Text`, `Number` (`Min`, `Max`,
`Step`, `Decimals`), `Date`, `Check` (`ActiveText`, `InactiveText`), `Combo`
(`Items`), `Custom` -- read by `ed_spec_read` in `bta_table.c` against a table
(`ED_KINDS`); a new kind is a row there, a case in `cell_open` and one in
`cell_value`. `Editable: true` is `Editor: "Text"`. **A cell is still text**:
every kind reads the cell and writes text back, so `Add`, `Cell`, `Data`,
`SortBy` and the `.form` know nothing of editors. Per row, `SetEditable` and
`Data`'s `Editable: false` shut a cell before it is typed in; `CellEditor(row,
column)` is asked as an edit begins (`false` refuses, an object is this edit's
editor, `Kind` included except to or from `Check`); `CellEdit`'s string answer
is what is kept. `EditCell`/`EndEdit` are the gesture from code, and the road
`tests/widgets`' `TableEditors` takes. The names were compared against GTK3's
renderers, Qt, WinForms, WPF, Delphi, DevExpress, Lazarus, Gambas, Swing, JavaFX,
Xojo and AG Grid; `ActiveText`/`InactiveText` and not `Checked`, because every
check here says `Active`, and not `Active` alone, because that is a boolean
everywhere else. What bit, all of it measured with a real pointer on an `Xvfb`
with a window manager, since none of it reaches the suite:
- **A flat table's `SetCell` did not redraw, and nothing said so.** GTK 4.22
  keeps the widgets of an item that is the same object across `items-changed`
  and does not bind them again, so `table_row_changed`'s `items_changed(at, 1,
  1)` changed `Cell()` and left the screen as it was -- `SetCell`, `SetIcon`,
  `SetUri`, a taken edit, all of them, for as long as the suite only read
  `Cell()` back. A row emits `changed` now and every bound cell listens
  (`cell_fill`, connected in the bind, disconnected in the unbind, which every
  column has for that reason). A tree was never affected: it gets fresh
  `GtkTreeListRow` wrappers.
- **The press is heard on the column view, not on the cell.** With an edit open
  in one row, GTK's own gesture on *another* row claims that row's press in its
  capture phase, before a capture gesture on the cell under it runs: the second
  row was selected and never opened, while a cell of the same row opened fine.
  One capture `GtkGestureClick` on `w->inner` finds the cell with
  `gtk_widget_pick` -- **up and down**, because a row grown by an open field
  puts the next row's press in GTK's cell padding, which picks
  `GtkColumnViewCellWidget` and not our box.
- **The edit begins on the press, not the release.** The press moves the focus,
  the edit open elsewhere commits, and a release whose widgets moved in between
  was not delivered. The queued begin names the row and the column, not the
  box, and looks the cell up again.
- **Nothing ends an edit inside a GTK signal.** Enter, Escape, the focus leaving
  and a popover closing queue an idle (`cell_settle`) holding the box and the
  edit's `gen`; ending runs the program, which may empty the table. No queued
  job holds a `JSValue`: the table is a weak reference to `w->gtk` looked up
  through `BTA_WIDGET_QUARK`. **An unbind with an edit open is not its end** --
  a store telling a row changed unbinds and binds it again at once -- so it is
  asked a turn later, and an edit whose row scrolled away is committed, not lost.
- **`xdotool click` is not a hand, and the difference hid a whole bug.** It
  presses and releases with no time between, and a person leaves a tenth of a
  second. A press inside an open editor hands the focus to GTK's row widget at
  the press; the edit took that for leaving and committed before the release,
  taking the calendar's button away under it -- so clicking the button closed
  the edit and the calendar never showed, while every `xdotool click` probe
  opened it. `on_view_pressed` notes a press inside the editor and
  `SETTLE_BLUR` gives the field its focus back when the focus went to an
  ancestor of the editor right after one. **Probe a gesture with `mousedown`,
  a sleep and `mouseup`**; the fast form proves nothing about a hand.
- **Two walks, two directions.** F2 looks for the cell *up* from the focus
  (`cell_under`), and a press in a cell's padding looks *down* from GTK's cell
  widget it picked; one helper for both answered one of them wrong.
- **A frameless `GtkButton` still has a button's floor**: the `…` of a `Custom`
  cell made every row 51 high against 36. It is a label, `can-target` off.
- **A day is picked by a press, Enter or Space, never by an arrow key** -- and
  in GTK 4 the arrows did not move the day at all. They move a focus ring over
  the days, leave the selection where it was, and Enter does not select the
  day under the ring (only Space does, and nothing public says which day the
  ring is on): three arrows and Enter committed the day the calendar opened
  on, measured. The calendar's key handler moves the *selection* by a day or a
  week, across months, and Enter or Space commits what is selected. It also
  takes the focus when the popover maps, which otherwise lands on the month's
  back arrow. A press is marked in the capture phase so its `day-selected`
  commits and an arrow's does not.
- **A `Number` rounds as a person rounds**, and printf does not: `%.1f` of
  12.25 is `12.2` (half to even) and of 1.005 is `1.00` (1.00499... in binary).
  `number_text` takes the double's shortest text and rounds it as a decimal, a
  half away from zero -- `Decimal`'s default. **The spin rounds what it shows
  with printf too, and reads its own text back as the value**, so it is handed
  the number already rounded, or 12.25 opens as 12.2.
- **The kinds are published, not copied**: `Widget.PropertyOptions("TableView",
  "Columns.Editor")` answers them out of `ED_KINDS` (`table_options`), which is
  what the designer's column dialog (`ColumnForm`) offers after its own `None`
  and `Link`. The dialog rewrites a column's cell keys only when a cell field
  was touched, so renaming leaves an old `Editable: true` alone, and it hands
  the result to a scratch `TableView` on OK: **the runtime's refusal is the
  dialog's**, rather than a second copy of `ed_spec_read` in the IDE. An edit
  redraws the list without filling the fields back -- writing a `TextEditor`
  from inside its own `Change` is GTK's *invalidate all outstanding iterators*
  warning, and it appeared in the suite's output the first time.
- **An open editor made its row two pixels taller, and the theme did it.** An
  entry, a spin button and a menu button each carry a `min-height` (34 here) and
  padding beyond what a cell's label asks for, so opening any cell grew its row
  36 -> 38 and shifted the table (`examples/plan`: every editor but the check).
  `cell_editor_style` puts `bta-cell-editor` on the editor and one display-wide
  rule takes the floor off. **The selector needs the theme's specificity**:
  `.bta-cell-editor` alone left the spin at 38 and the date at 37, because
  Adwaita's is `spinbutton:not(.vertical)`; `spinbutton.bta-cell-editor:not(.vertical)`
  (and its `> text`, `> button`) is what wins. Measured with a probe that reads
  `RowHeight` before and after `EditCell` on each kind; no suite assertion,
  since the row height is a frame behind the open.
- **A held row's lock is asked of the row, not of the cell**: the rebind
  `SetEditable` asks for comes on GTK's next frame, so `EditCell` right after it
  read the old answer.
- **F2 found leaves, and a commit left the keyboard on nothing.** `cell_under`
  walked *down* from the focus, and a tree's chain is
  `GtkColumnViewRowWidget -> GtkColumnViewCellWidget -> GtkTreeExpander ->
  GtkBuiltinIcon` -- the arrow is the expander's first child and the box its
  child, so the walk ended on an icon; and *after* a commit the focus is GTK's
  wrapper for the row, which telling the store the row changed *rebuilt*, so
  the keys went to the toplevel and no control heard them. Now the cell is the
  box the focus is **inside** (walk up), F2 off a cell is the **selected row's
  first field**, and `cell_finish` puts the focus back **after** the report.
  Keys and a pointer, so on the by-hand list.
- **A flat row the program removed under an open edit was raised as
  `CellEdit(-1, ...)`.** The commit is queued, and a flat table's address for a
  row is its *position* -- which is gone with it. A tree keeps its key and an
  on-demand row is the program's to store, so only the held flat shape is
  reported now: it is not raised at all.
- **`CellEdit` says what ended the edit, last: `how`.** `"enter"`, `"tab"` and
  `"shift-tab"` are the grid's move-on keys -- the keys are consumed, and an
  edit that ends with one is reported even when nothing changed, because the
  program reads the reason and moves; `"pick"` is a day, an item or a tick
  chosen; `"focus"` is the keyboard leaving; `"code"` is `EndEdit`; `"left"` is
  the row unbound, scrolled away. Tab was let go before, so it walked the focus
  out of the grid and the edit ended as a blur that said nothing about where the
  reader meant to go.
- **The current cell is the table's** (`CurrentCell`, `CellChange`): the press,
  F2, `EditCell` and an assignment move it, and a class on the cell's box draws
  it (`.bta-cell-current`, an `outline` so marking a cell does not shift its
  text by a pixel -- a border would). The class is applied at every bind
  (`cell_fill`), so a row scrolled back into view is drawn current with no
  bookkeeping, and moving it finds the drawn cell with the walk `F2` already
  takes: once per move, never per frame. Assigning `CurrentCell` selects the row
  as a press would; the row is held, and every verb that empties a table --
  `Clear`, `RemoveRow`, `RemoveNode`, `Count` -- drops it.
- **Enter is offered to the program before the view activates the row.** GTK's
  column view claims Return for `Activate` (the double click's other half)
  *before* the bubble phase, where a control's `KeyPress` is heard -- measured
  on 4.22: a grid whose Enter moves the cell never heard it, and the row's
  dialog opened instead. So `on_table_key` raises `KeyPress` for the
  Return family itself, and **a handler that returns true consumes it**; one
  that does not gets the same activation as ever. With an edit open it is the
  editor's Enter, not the view's -- checked there, because the capture on the
  column view runs before the editor's own.

## A table beside another view: the geometry it can say

A scheduler, a diff, anything that puts a list next to a drawing needs three
numbers from the list — where its rows are scrolled to, how tall one row is and
how tall the heading row is — and **`GtkColumnView` has none of the three.**
There is no row-height getter (GTK measures rows through the cell factories and
keeps the number to itself), no scroll accessor (the `GtkColumnView` is the
scrollable child of a `GtkScrolledWindow` this control creates, and the
adjustment was never exposed), and no header getter (the heading is a child of
the column view and nothing says which one). So `RowHeight`, `HeaderHeight`,
`ScrollY` and `ScrollMaxY` are all read out of what GTK *does* publish: the
adjustment's `upper` and `page_size`, and the column view's own allocation. Do
not go looking for `gtk_widget_get_first_child` to find the header — that is
reading a child list that is an implementation detail, and `page_size` says the
same number without naming what sits above it.
- **A row's height is the rows' *natural* height over the rows that are
  *drawn*.** Two things had to be got right here, and each one was got wrong
  first by an application that measured it:
  - **The count is the drawn one.** In a tree, `Count` is every node at every
    level and a folded branch is in neither `Count` nor the height, so dividing
    by `Count` answers a row that gets shorter every time something is folded.
    Measured on a tree of fifteen nodes: the wrong answer was a third short with
    one branch folded, and it would have been *worse* the more the user closed.
    The column view's own model is the flattened list in tree mode, which is the
    count to divide by.
  - **The height is `gtk_widget_measure`'s, not the adjustment's `upper`.**
    `upper` is `max(content, page_size)`, so a plan of three tasks in a tall
    window -- the plan that always fits -- divides the whole viewport and
    answers 102 for a row that is 36. `bintana-project`'s view check caught it
    on the fixture with three tasks. Measured on that case: `nat` is 133, the
    heading is 25, the three rows are 36 each and `upper` is the 575 the
    viewport is.
- **`HeaderMinHeight` exists because the heading does not follow the font.** A
  table at 10, 11, 12 and 13 points has rows of 36, 37, 39 and 41 pixels and a
  heading of **25 in every one**: the theme sizes the `header` node and not the
  control, so "make the heading taller" has no answer in the font. The floor is
  set on the heading widget -- the same `gtk_widget_get_first_child` walk
  `table_heading_at` already does over GTK's own structure, checked in 4.10 and
  4.22 -- and it moves the heading and nothing else: the rows and the rows' extent
  are the theme's still. What it bought was a chart beside a list putting two
  rows of axis type in the same band without the type having to be 7 points.
- **There is no way to read a widget's ground, and there never will be one in
  GTK4.** Measured on 4.22: `gtk_style_context_get_property` is gone (not
  deprecated, gone) and `gtk_style_context_lookup_color` answers `false` for
  every name tried — `background-color`, `view_bg_color`, `white`, all of them.
  The painter's note in `bta_paint.c` says this and is right about a control
  painting *itself*; it does not reach **two controls side by side**, which is
  what an application asks when a chart has to sit on a list's surface. A
  transparent background is not the answer either: it leaves the scroll view's
  own ground showing, and on a theme that does not paint a viewport and a list
  alike the seam is still there — which is what `bintana-project` measured on a
  real desktop.
  **The road out of that is the class, not the value.** A theme paints a surface
  with `.view` -- Greybird's own rule is `.view, iconview, .view text, ... {
  color: #212121; background-color: #fcfcfc; }` -- and a `GtkColumnView` wears
  that class *itself*, which is how the theme writes it (`columnview.view`). So
  the answer for "the same ground as the list" is `Style = "view"` on the other
  control, and it was found that way, on a real screen, after two values that
  changed nothing. Worth knowing beside the measurement above: **a control
  paints no background of its own**, so a `Background` set on a `DrawingArea` is
  a no-op, and a value written on top of the class that works is worse than
  nothing -- the runtime writes it at `PRIORITY_APPLICATION + 1`, above the
  theme's, and the two fight.
  **Nothing in `Background` was widened for it, and that is the point.** It takes
  a value; a theme's own name is not one and is refused, and so is the keyword
  `transparent` (the parser is `gdk_rgba_parse`, which knows the spellings that
  carry a value). Both were tried by an application that got nothing twice, and
  both are held as refusals so the next one does not spend the afternoon: the
  road is `Style`.
- **Both numbers are `0` until the scrolled window has a viewport**, and a
  control in a `Fixed` never gives it one: it is handed a rectangle and the
  window inside it keeps a zero-sized viewport. So `page_size` is `0`, the
  heading measures as the whole control, and `nat - heading` divides the
  heading into every row. `TableGeometry` puts its tables in a `Scroller` of
  their own because of this, and a test that measured in a `Fixed` saw 24 rows
  of 37.
- **A table with no columns has no heading row at all**, so `HeaderHeight` is
  `0` — and `0` also means "not laid out yet", which is what the documentation
  says. The distinction is the test's: `TableGeometry` waits for a number to
  come and a table built without `Columns` never gives one, which is how the
  empty-table assertion had to be given a column to be true at all.
- **The numbers are a frame behind the rows.** A row added in this turn has no
  allocation yet, so `RowHeight` is the one before it and `ScrollMaxY` the one
  before that — the same rule `bta_scroll_set` is written around, and the reason
  `TableGeometry` waits with `until` instead of asserting as it goes.
- **Connect the adjustments with `bta_scroll_watch`**, which is also what keeps
  the finaliser's sweep from leaving two handlers pointing at a freed
  `BtaWidget`. They are not the widget, so a hand-rolled `g_signal_connect` on
  the table's own adjustments would fire into freed memory at teardown — the
  failure `tests/asan.sh` is the one that reports.
