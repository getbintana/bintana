# Layout

The traps and decisions of this area, each with what it cost and the rule it left. [`AGENTS.md`](../../AGENTS.md) states the rules that apply to every change; this file is the evidence behind them and the detail that only matters here.

## Fixed surfaces, boxes and anchors

- **The property grid greyed `HAlign` and `VAlign` on a `Fixed` surface, and
  they are the only two that work there.** `PLACED_BY_ANCHORS` listed them with
  `Expand`/`HExpand`/`VExpand` under *a fixed surface keeps the place it was
  given*, which is true of the three `Expand*` (measured inert) and false of the
  alignments: in `bta_fixed.c` they **are** the anchor rule, and `Fill` is the
  only way a control on a surface follows its window. Symptom: a `Calendar` on a
  `Fixed` form did not grow with the window, and the one pair that could make it
  was turned off in the designer -- editing the `.form` by hand was the only way
  out. Only the three `Expand*` are off now, with a sentence that points at the
  alignments; `tests/ide`'s `palette` phase asserts both halves. **A reason
  written for a set of properties has to be true of each member**: the measurement
  covered `Expand`, and the list grew `HAlign` beside it.
- **A `Scroller` fills as well as scrolls, and the property that decides it is
  `Arrangement` -- which nothing said, so it was reported as a missing
  container.** Its slot is a `BtaFixed` by default, and a `Fixed` sizes what is
  in it at the content's own minimum: there is no design size for an anchor to
  keep a gap against (only a **form** has one -- the `is_form` note above), so
  `HAlign: "Fill"` on a scroller's content has nothing to fill and a declared
  `Width` is not even a floor on a `Fill` axis. Arranged `Horizontal` or
  `Vertical` the slot is a `GtkBox`, which stretches an expanding child across
  itself and lets it outgrow the view along itself. Measured, a `Grid` of
  `Homogeneous` tiles with a 180x130 floor in a 900x500 view: **one tile
  898x498, four 2x2 at 445x245, twenty a 924x538 grid with `ScrollMaxY 38`**,
  and the view 900x500 throughout. The same declarations unarranged leave the
  grid at its content's own floor -- **180x130 for the one tile and 366x266 for
  the four**, in the same 900x500 view, with the rest of it empty.
  `tests/widgets`' `FillScroll` asserts both halves and goes red on three
  assertions with the arrangement taken away.
  **What decides scrolling versus growing the window is `Scrollbars`, and a
  floor is not it**: the same twenty tiles under `Scrollbars: "Vertical"` take
  the window from 900 to 924 wide, with `MinWidth` set or not (measured both
  ways, four runs). An axis that may not scroll has to be given its content's
  minimum and propagates it outwards.
  `docs/issues/ISSUE-fill-and-scroll.md` is deleted as answered, and the
  lesson is the one that keeps recurring here: **before reporting a gap,
  measure the properties the container already has.** The report was written
  against `Grid` (fills, cannot scroll), `Flow` (scrolls, does not fill) and
  `Scroller` (documented as *content as big as it needs*, which is the default
  slot and not the only one) -- three true sentences, and the fourth was in
  nobody's reach because no document had put `Arrangement` and `Scroller` in
  the same paragraph.
- **A `Split` inside a `Fixed` gave its diff 46 pixels of a 620-pixel window.**
  Two mistakes that look like one. The window was a `Fixed` root with every
  region at an `X`, a `Y` and a height of its own, so a taller window gave the
  extra room to nobody -- that half is the rule
  [`docs/widgets.md`](https://github.com/getbintana/bintana-docs/blob/main/docs/widgets.md#which-of-the-two-models-a-form-should-use)
  already states, *a window of regions is boxes*, written and then broken anyway.
  The half that made it unusable rather than merely rigid: the `Split`'s two
  children were bare `Panel`s with `Spacing` and nothing else, so **the
  expansion stopped there** -- everything inside them had `VExpand` and it
  counted for nothing, and the panes came out at the tab strip's natural height.
  `VExpand` on a control is a claim on the room *its parent has*; a parent that
  claims none has none to give. Measured both ways in `tests/ide` (`git`), which
  is what the assertion there is for: 46 pixels before, 395 after.
- A widget must be attached to its parent **before** X/Y are applied, or the
  coordinates never reach a live surface. The loader and `Container.AddNode`
  both do this in that order.
- **A `Fixed` slot is `BtaFixed`, not `GtkFixed`** (`runtime/src/bta_fixed.c`).
  It reads x/y/w/h and `HAlign`/`VAlign` off each child's `BtaWidget`, so moving
  a control is `gtk_widget_queue_allocate` on the parent and attaching one is a
  bare `gtk_widget_set_parent` — there are no coordinates to hand over and no
  per-child layout data to keep in step.
- **`BTA_IS_FIXED` and `bta_surface_is_fixed` are two questions.** The macro says
  the widget is one of our surfaces, which is what `Arrangement` may re-arrange;
  the function says which arrangement it is wearing *now*, since the same widget
  answers `Fixed` before lunch and `Horizontal` after. Reading the type where the
  arrangement was meant is how `HAlign` gets taken away from every child of a box
  (`widget_apply_align`). Its reference size is latched from its
  **declaration** when it has one -- the `.form`'s `Width`/`Height`, or the
  `Resize` a surface built in code got before it was shown -- and from its first
  real allocation otherwise; code that resizes a surface that declared nothing
  before it has ever been allocated is setting the design size, not resizing
  anything.
- **A `Split` used to let a window be made smaller than its own contents**, and
  the symptom is overlap rather than clipping: GTK's paned defaults to
  `shrink-*-child = TRUE`, so it reports a minimum of nothing and the halves are
  drawn over each other and over their neighbours. `build_split` turns both off.
  The cost is that a window's minimum becomes real -- the IDE's went from 720
  (broken at that size) to 1100, which is what `SideBar` 260, `SidePanel` 280 and
  the rest add up to. Lowering it means expressing those as split **positions**
  rather than child widths, which is a separate piece of work.
- **`MinWidth`/`MinHeight` mean nothing in a box.** They are the floor for a
  *stretched* control on a surface; in a box the floor is `Height`/`Width`
  itself, and `Expand` is what makes the control take more. `PoForm`'s editors
  got `MinHeight` first and were squeezed to 46px; `Height` plus `Expand` is the
  pair that gives a floor of 64 and growth to whatever there is.
- **A `Fixed` inside a hidden page that declares no size latches the wrong design
  size, and the symptom is a whole panel laid out at the old window size.** A
  hidden `Switcher` page is never allocated, so its first allocation happens when
  it is *shown* -- and if the window was enlarged first, that is the size it
  latches. Every anchor under it then has `dx = 0` and nothing fills. Enlarging
  the IDE on the welcome page and then opening a project is the case: the
  workspace came up at 1100x720 inside a 1500x950 window. **A declaration is the
  way out** -- a `.form`'s `Width`/`Height` is latched whatever the allocation
  order -- and **not a runtime bug** for the rest: `WorkBox`, `SideBar` and
  `ConsoleBox` were `Fixed` when each of them is a *column* -- a label over a
  tree, a toolbar over a split -- with every child `Fill` at the full width and
  coordinates that never meant anything. A box has no design size to get wrong.
  (`ConsoleBox` is a `Notebook` now, for a further reason: how many pages it has
  depends on whether the build has VTE, so it is not something written down.)
  Reach for `Fixed` when a person drew it, not when the shape happens to be
  rectangles.
- **`Width` is not "has it been allocated", and a guard that asks it may be
  asking nothing.** `tests/ide`'s `whenLaidOut` waited for `FileTree.Width > 0`,
  and FileTree declared 260 -- so it answered before GTK had allocated anything
  and the guard returned immediately, for as long as the declaration was there.
  `Bounds()` is the allocation and nothing else. Swapping it in makes that guard
  wait for real, and it then times out, so something in the driver's startup does
  not lay the window out when it runs -- worth chasing, and noted where it lives.
- **`Margin` on a `Form` used to leave a transparent window**, and that is worth
  knowing because the symptom pointed nowhere near the cause. A margin is room
  *outside* a widget and outside a toplevel there is nothing, so GTK honoured it
  by insetting the window's *content* -- and the window's background is painted
  on the content, so what was left was a band of window that nothing drew:
  transparent under a compositor, black in an `import` capture. Measured, a form
  declaring `Width: 1120` came up as a 1120x620 X window with a 1104x604 form in
  it, and the right and bottom strips read `mean=0.567 spread=0.471` against
  `0.96 spread=0.01` for the same strips of a form without a margin. The two
  examples it happened to were the two using a `DrawingArea`, which is what the
  bug looked like it was about; it was the only two forms in the tree declaring
  `Margin` on the form.
  `w_set_margin` puts it on the surface for a form now (`margin_target`), so the
  window keeps its whole size and paints all of it and what moves is what is
  inside -- which is what anyone writing it meant. A menu bar is a sibling of the
  surface, so it still spans the window. The old workaround -- one `Panel`
  holding everything with the margin on that -- is no longer needed, though the
  two dialogs that use it are correct as they stand. `testFormMargin` asserts both
  halves, since either alone passes for the broken version.
- **A `Grid` on a `Fixed` surface negotiates with nobody.** Its neighbours are
  placed by coordinate and have no say, so a grid whose contents outgrow its
  declared width overflows them exactly as the row of buttons it replaced did.
  Putting the menu editor's six buttons in a grid changed *nothing* until the
  dialog itself stopped being a surface -- measured, not guessed: still 15px over
  the tree's edge afterwards. What makes columns give way to each other is the
  parent being elastic.
- **A form's contents can make it open wider than it was drawn, and that is what
  translation does to every dialog.** `bta_fixed_measure` reports the bounding box
  of each child's *minimum*, so a caption whose translated text outgrew its
  declared width pushes the surface out instead of clipping -- right, and the
  reason the anchor origin cannot be the first allocation. It used to be, so on a
   pushed form the design size *became* the pushed size: every anchor went inert
   and the extra room sat dead against the far edge. The IDE's own *New
   translation* dialog is where it was seen -- the input stopped 77px short and the
   buttons sat 85px left of the corner. **The declared `Width`/`Height` is the
   origin now, on every surface and not only on a form**
   (`ISSUE-fixed-fill-child`): it was `is_form` alone, and that made `Fill`
   inert on a `Panel` a box had stretched -- the panel's first allocation *is*
   the cell, so it latched that and no slack was ever left. A component's
   `Tile.form` drawn at 180x130 with a `Fill` child as big as it stayed 180
   wide in a 640 cell, and the only way around it was changing the component's
   `Arrangement`, a decision its host cannot make. A `Width` inside a box is
   still a *minimum* as a request; as the origin of its children's coordinates
   it is the design, and that is true whatever gives the surface its room. The
   allocation is the fallback only when nothing was declared. Two consequences
   measured while fixing it: a `Panel`'s `Margin` is **not** chrome to subtract
   (a 100x100 panel with `Margin: 5` is a 100x100 box at (5,5) -- GTK shifts it
   inside the cell and keeps its size), and `testBoxAlign`'s last assertion
   moved with the rule: a `Center` child of a stretched panel now anchors
   against the declaration and not against the cell.
- **The design height is the declared one less what sits around the surface,
  read off the widgets.** It was `MIN(declared, allocated)` -- a menu bar's
  subtraction guessed from the allocation, right only when the window opens at
  the size it declares. A form drawn 400 tall and opened at 300 (a remembered
  size, a `Resize` in `Form_Open`) latched 300, and a `Fill` panel drawn 380
  tall kept a negative gap at every size after: 560 tall in a 480 window,
  measured. Now it subtracts the other children of the surface's holder (the
  menu bar) and the surface's own margins, which are the same numbers whatever
  size the window happens to be; `testDesignHeightShort` is red without it.
- **A `Fill` child's far-side gap is part of what the surface has to measure.**
  `bta_fixed_measure` asked for `offset + minimum`, which is the left coordinate
  and nothing about the right margin -- so the control that grew pushed the
  surface by exactly its own growth and came out flush against the edge while
  every control beside it kept its 16px. Only `Fill`, whose promise is to keep
  *both* distances; adding a `Start` child's trailing gap would grow the surface
  by the whole margin it was drawn inside. Measuring needs the design size to know
  that gap and the first pass has none, so latching one queues a resize: **a
  pushed form is laid out twice, and `Bounds().Width > 1` is true a frame before
  the layout is right.** That cost a red test that was measuring the first frame.
- **And the floor is applied *after* the anchor, growing away from the anchored
  edge.** A control that outgrew its declared width would otherwise take its own
  growth *and* the whole slack, ending up past the edge it is anchored to.
  `anchor_axis` takes the declared size and the floor separately for this reason;
  it used to take `max(declared, floor)` and add the slack to that.
- **`Ellipsize` and `Wrap` collapse a label's width request, so a label with no
  declared `Width` has nothing to wrap or ellipsize into.** `label_fit` sets
  `max-width-chars = 1` for either, and GTK clamps the request back up to the
  declared `Width` -- which a value label in a `Grid` cell has not got, so a
  table of forty values drawn while building `examples/factory` came out as a
  column of `...` while `Text` answered every one of them. It reads as a table
  of missing values and it is a table of labels with no box; the fix is the
  width or not asking, never the label.
- **An anchor keeps the gap a control was *drawn* with, so a container can only
  be drawn in coordinates if its size follows from what the `.form` declares.**
  A guess taken from a measurement is wrong for good: the IDE's `SidePanel` is
  the split's height minus a tab strip the theme sizes, and drawing `PropGrid`
  against a measured 431 left it 4px outside a real 427 — at every window size,
  because the negative gap is preserved like any other. That panel is a column
  for this reason, and so are `WorkArea` and the views inside `Tabs`.
- **A surface stretched to room that is nobody's design size must have
  `Anchored` off.** The designer's `Surface`/`Glass` are sized by the IDE, not by
  the form on them, so anchoring showed every control resized to the canvas — a
  `TextBox` declaring 380 drawn at 504. `Designer.js` turns it off for both. The
  flag lives on the container's `BtaWidget` as well as in the layout manager,
  because a new manager has nowhere to read it from; `cont_set_arrangement`
  carries it over.
- **A `GtkPaned` that cannot give a child its minimum hands it the space
  anyway.** The design canvas demanded the full width of the form on it, so
  widening the property panel pushed the canvas 120px outside its own half of the
  split and over that panel. Content whose size is not its parent's business goes
  in a `Scroller`: the view is the room there is, the board is as big as what is
  on it. Making the board "ask for no room" instead is not the fix — it clips,
  and a form bigger than the canvas becomes unreachable, which is what stopped
  `MainForm` from being editable in its own designer.
- **Taking a child out mirrors putting it in, per kind of slot.**
  `bta_container_detach` has a branch each for `BtaFixed`, `GtkBox`, a notebook
  page, `GtkStack`, `GtkGrid`, `GtkPaned` and `GtkOverlay`, and each one is the
  inverse of the matching branch in the attach above it. Three defects came from
  that symmetry being incomplete, all found at once by an application that
  rebuilt a container:
  - `GtkGrid` had **no branch**, so `Clear`/`Delete`/`Remove` on a grid threw
    `cannot remove from this container`. Now `gtk_grid_remove`, with the existing
    `bta_grid_reflow` closing the hole.
  - `bta_container_clear` walked `gtk_widget_get_first_child` and unparented
    anything that was not ours — a paned's drag handle among them, which is three
    `Gtk-CRITICAL gtk_widget_unparent` per call and success reported anyway. It
    now collects what is ours in one pass and detaches in a second. **The two
    passes are load-bearing**: detaching moves the sibling list, so a
    `while (first_child)` loop only terminates while every child is going.
  - `GtkPaned` and `GtkOverlay` were *unparented* rather than cleared through the
    property holding them, so GTK kept its pointer and the container went on
    believing it was full — a cleared split refused the next `Add`, a cleared
    overlay tripped an assertion. Latent until something refilled one.
  - And a fourth, later: taking the **base layer** out of a `GtkOverlay` left
    floaters with nothing filling, and `Children[0]` no longer the base — which
    is the whole of what an index means in a stack. Attach makes the first child
    the base, so detach promotes the next one, guarded by
    `gtk_widget_in_destruction` because GTK unparents everything in dispose and
    promoting a child on its way out is handing `set_child` a corpse.
  The test to keep is `tests/widgets`' `Removal`: fill, empty, fill again, on
  every container. Nothing had asked for that round trip before.
- **A form's declared size includes its own `Padding` and `Border`, and the
  anchors were measured as if it did not.** `Padding` is CSS on the window's
  node; GTK takes it off before the surface is allocated, so a form declared
  412x276 with `Padding: 6` is laid out in **400x264** while
  `bta_fixed_layout_allocate` latched 412x276 as the origin of its anchors. A
  `Fill` child drawn flush with the padding came out 12 px short on the right and
  the bottom -- the designer, an unanchored board that shows the declared sizes,
  had no such gap, which is how it read as *the runtime disagrees with the
  design*. The latch subtracts the form's padding and border now
  (`gtk_style_context_get_padding`/`_border` on the window, deprecated in 4.10
  and the only reader of the CSS box: `gtk_widget_get_width` of the window, its
  surface and the layout are all already the content box, so there is nothing to
  diff). **Forms only**: a `Panel`'s declared `Width` is the box its children were
  drawn in. `tests/widgets`' `DesignPadding` is a child that measures a `Fill`
  panel before and after a resize, red by 12 px without it. Found in
  `~/Escritorio/Prueba`, after the designer learned to keep controls inside the
  content box and made the mismatch visible.
- **`Arrangement` is only on a container whose slot is a `BtaFixed`.** `Panel`,
  `Frame`, `Expander`, `Scroller`, `Form` and a `Component` have one; `Split`
  overrides the property with `Horizontal`/`Vertical` and no `Fixed`; `Grid`,
  `Flow`, `RowList`, `Overlay`, `Notebook` and `Switcher` throw *arranges its
  children by its own nature* and read `""`. It may be set at **any** time,
  children and all — `cont_set_arrangement` swaps the layout manager and nothing
  moves. (It used to refuse once a container held something, which is what made
  the property useless for the one thing it exists for; that restriction is gone
  and so is the note that used to be here.)
- **An alignment is carried out by the *parent's* layout, so the parent is what
  has to be told.** `gtk_widget_set_halign` queues an allocate on the **child**,
  and that only re-allocates the child into the rectangle it already had -- so
  the value is stored and never applied. Measured on a layer of an `Overlay`:
  declared `Center`, then set to `Start` from code, it stayed at (185, 91) and
  moved to (0, 0) only when something else made the overlay lay out, which is
  how it was found -- hiding the layer and showing it again. `widget_apply_align`
  queues the allocate on the parent for that reason, for every kind of container
  and not only a `BtaFixed` (which had its own queue in `bta_widget_relayout`
  because it reads x/y off the child). Anything a person changes in a property
  grid is exactly that sequence, so this is the shape of bug that only ever
  shows up by hand: `tests/widgets`' `Reorder` now asserts the move.
- **`HAlign`/`VAlign` are carried out by two different things, and the container
  decides which.** In a box they are GTK's `halign`/`valign`; on a `BtaFixed`
  they are the anchor rule and GTK's must stay `Fill`, or GTK would align the
  widget *inside* the rectangle the surface just worked out -- a control drawn
  200 wide with `Start` comes back its natural width. `widget_apply_align()` is
  re-asked on every adoption and every relayout, because a control changes
  containers and `Arrangement` alone turns the row under it into a surface. The
  default is `Auto` and not `Start` for the same reason: the two containers
  disagree about what nothing-was-asked-for means, and a shared default would
  have moved every box child ever written.
- `Width`/`Height` are `size_request`, i.e. a **minimum** — *except* on an axis
  whose `HAlign`/`VAlign` is `Fill`, where the size is derived and the request is
  the control's floor (`MinWidth`/`MinHeight`, or its natural minimum) instead.
  A control whose natural size exceeds the request renders larger than the
  `.form` says.
- **A `Width`/`Height` in a box is a *minimum*, not a size.** A `SourceEditor`
  declared 605 tall makes the notebook holding it 605 tall, and a `Scroller`
  declared 520 wide is a canvas the split can no longer squeeze. Everything in a
  box asks for the least it can live with and expands into the rest; the last
  child of a panel whose minimums exceed it hangs out of the bottom edge and
  stays there at every window size.
- **...and the serialiser used to invent one.** `Width`/`Height` fall back to the
  *allocation* when nothing was declared (`w_get_geom`), so saving a form wrote
  down what every control happened to measure -- turning today's measurement into
  tomorrow's floor. One save of the IDE's own window put `Height: 427` on a
  notebook page and 427px of blank under the tab strip. `collectProperties` now
  asks `SizeRequest()` (`-1` = nobody asked) and skips the pair for a box child;
  fixing the file by hand only lasts until the next save.
- **Tab order cannot ride the child list, because paint order already does.**
  GTK4 walks the focus in child-list order and removed `GtkContainer`'s focus
  chain, so on a `BtaFixed` the drawn order is the tab order -- and that same list
  is what `Raise`/`Lower` reorder. `Widget.TabIndex` is declared per child and
  carried out by `bta_fixed_focus`, the surface's own `focus` vfunc, which is the
  supported place for this and costs nothing elsewhere: a focused editor or
  `Terminal` consumes Tab long before GTK asks a container for the next target, so
  indentation and shell completion need no special case. Sparse and never
  renumbered, for the reason `Button.Default` is resolved at Show -- a control's
  siblings are its *form's*, which on the designer's canvas is `MainForm`.
- **`Resizable: false` does not pin a window's size.** It removes the user's grip;
  the contents still drive the geometry, so a translated caption longer than the
  box it was drawn in opens the window wider anyway -- measured at 930 px on a
  `ConfirmForm` declared 400. Which is the behaviour to keep (the translation trap
  three entries down is *why*), but it means this is not the tool for a layout that
  must not move.
- **A `Split` with no `Grows` grows both halves, and a `Position` set before the
  first allocation is what that allocation honours.** Two reports of one thing:
  enlarging the window grew the side bars (`Split` and `RightSplit` declared no
  `Grows`, so `Both`), and opening a `.js` in a window already big -- maximised, or
  a remembered size -- left the editor at the 300 it was worked out against nothing
  with and gave the *Contenido* outline the rest. The first is `Grows` in
  `MainForm.form` (`Split` `End`, `RightSplit` `Start`). The second is
  `Session.settle`: for the dividers whose **second** half keeps its size
  (`END_FIXED`: `CenterSplit`, `EditSplit`, `RightSplit`) what is saved is that
  half's room (`ends`, beside the unchanged `dividers`) and it is put back on the
  split's first `Allocated`, from the live page's, the saved one, or the declared
  default (`OUTLINE_W`, and `CONSOLE_H` for the console, which is left where it was
  when an older settings file saved the divider without `ends`). A page that is not on screen cannot say its `ends`, so
  `saveWindow` merges with the last ones. Reproduced on an `Xvfb` with a remembered
  width of 1800 -- there is no window manager, so `Maximized` cannot be.
- **A declared `Width` on a `Split`'s child is a floor that survives hiding
  what is inside it, and it blocks folding the half.** `SideBar` declared
  `Width: 260`, so the project panel could not be folded below 260: a position
  is `CLAMP`ed to `start_child_req` (`gtk_paned_compute_position`, both
  `shrink` flags off in `build_split`), and a size *request* is part of a
  widget's minimum whether or not its own children are visible. Measured in a
  probe: `Position = 30` with the content up came out **260**, and **stayed
  260** with the content hidden. The floor belongs to the content instead --
  `SideView`, whose `FileTree` already declares its own 260 -- so it goes away
  with what it holds: the same `Position = 30` landed on the strip's buttons'
  minimum (**36**). Two things follow about the order, and both are in
  `MainForm.foldSide`: hide the content **before** moving the divider, and show
  it **before** moving the divider back -- either way with the move first, the
  clamp eats it and the half stays where it was (measured: `30` with the
  content visible clamped to the content's minimum, `200` in the probe).
  **A child hidden whole is the other case, and it does go away**: the paned
  hands the whole rectangle to the half that is left and hides its handle
  (`gtk_paned_size_allocate`, the branch where only one child is visible)
  without touching `Position` or `last_allocation`, so the half comes back at
  the size it had whatever the window did in between -- and a `Grows: "Start"`
  split gives it back exactly, since `compute_position` carries the difference
  to the half that stayed. That is the bottom panel's way of being hidden
  (`MainForm.foldConsole`), and it is why a `Split` whose second half is not
  `Visible` must not be asked what that half is worth: `Position` still holds
  where the divider was, so `extent - Position` grows with the window while the
  half does not (`Session.saveWindow`).
- **`Label.Alignment` placed the block and left its lines justified left.** It set
  `xalign` only, so a `Wrap`ped paragraph with `Alignment: "Center"` was a centred
  box of left-aligned lines -- measured on the empty view's hint. It sets `justify`
  beside it now (`Center`/`Right`/`Left`). The empty view wears the designer's
  surround (`rgba(0,0,0,0.13)`, the `OUTSIDE_COLOR` of `Designer.js`) and the
  `frame` class; a colour is the exception this project reserves for what a class
  cannot say, and the theme has no class for *the room around a drawing*.
- **Open: two `GLib-GObject-CRITICAL: instance has no handler with id` at
  teardown.** Reproducible, and not ours to explain yet. It fires only after
  `testTabAction`'s exact sequence — a notebook action widget adopted, replaced,
  cleared, then re-adopted at the other end, then the notebook deleted — and
  **only when the process tears down**, never during a step. `SetAction` on its
  own, `Strip` through every value, and deleting a notebook, a switcher or an
  action widget each emit nothing. What produces that message is
  `g_signal_handler_disconnect(instance, id)`, and the calls by id in this
  repository are `bta_tree.c:on_unbind_row` — instrumented, and it never fires for
  this — and two list-item unwatches in `bta_table.c` (`on_unbind_cell`,
  `cell_unwatch_row`) -- and the backtrace below names GTK's own caller instead. **The caller is now named, and it is GTK's own.** From a backtrace under
  the suite's exact child invocation — which is the part that had been getting in
  the way, because the project does not run its tests unless it is started the way
  the runner starts it:

      xvfb-run -a env G_DEBUG=fatal-criticals \
          gdb -batch -ex run -ex "bt 30" \
          --args ./build/bintana --strict tests/widgets 99999

  `--strict` and the pid argument are both required; without them the process
  opens and exits without running anything, and the critical never comes. It
  reproduces on the first try, and the frames are:

      g_signal_handler_disconnect
      gtk_notebook_remove_tab_label
      gtk_notebook_remove
      gtk_notebook_dispose
      g_object_unref
      widget_finalizer            ← the unref of w->gtk

  So the handler is `page->mnemonic_activate_signal`, which GTK connects on a
  page's **tab label** and disconnects when the page goes, and the id is already
  stale when dispose reaches it. Two things narrow what remains: the teardown is
  driven from `widget_finalizer`, so it runs **inside a QuickJS collection cycle,
  in no particular order** — the same hazard `widget_disconnect_tree` above was
  written for — and `tests/asan.sh` is clean over this path, which says the
  instance is a live object that has lost the handler rather than freed memory.
  Still open, and still two lines with nothing failing; but it starts from the
  frames above now, and **not** from `_by_data`, which this note used to blame and
  which the backtrace clears: our sweeps pass the `BtaWidget` as data and GTK's
  handler carries the notebook, so they cannot be reaching it.

## Laying out a form: which of the two models

- **The distance from a window's edge to its controls is 12, and 16 added
  nothing.** elementary's HIG says it (*"12px (minimum) space between any
  widgets and the window's border"*, 6px between buttons) and the old GNOME HIG
  says the same 12-pixel border; the current developer.gnome.org HIG and
  libadwaita publish **no** pixel value at all (only `.toolbar`'s 6px), so a
  GNOME 6/12/18/24 scale is folklore and not a rule. Every `Fixed` form is
  drawn with exactly 12 on each side -- it had 8, 10, 11, 12, 14, 16, 18, 20,
  24 and 26, in the same IDE, with a dialog (`lib/dialog/Confirm`) whose accept
  button ended 14px *outside* its own window -- and a box form puts `Margin: 12`
  on the root or on each child that touches the edge. Toolbar strips (`Bar` with
  `Margin: 6`) are the exception the Adwaita `.toolbar` rule justifies, and a
  list or split that runs to the edge has none by design. Notes: adjacent
  children's margins add, so a `Margin: 12` on two neighbours is 24 between
  them; and moving a `Fixed` form's content means growing its declared
  `Width`/`Height` by the same amount, or the anchors keep the old gaps.
- **A drop-down whose `Items` are prose is addressed by `Index`, never by its
  words.** `Kind` was `"a form"`/`"a function"` and the dialogs assigned and
  compared `Text`; under a Spanish desktop the loader had translated the items,
  so opening *Project settings* threw `'a form' is not one of CmbPrKind's items`.
  The suite runs in English and could not see it. It is `0`/`1` and `Index` now
  (`ProjectForm`, `NewProjectForm`). Keywords go in a list filled from code, as
  the `Items` trap above says; a list that is prose is read by position.
  An audit of every `ComboBox` with `Items` in a `.form` found one more reader
  by text, `examples/charts` (`CmbType.Text` handed to `Chart.Type`; it is filled
  from code now), and `examples/files` and `examples/kanban` already read by
  index. And every IDE dialog was opened under `LANGUAGE=es` and `ru` and
  checked for controls outside the window and overlapping buttons: none left --
  the probe is worth rebuilding when a dialog gains a button (it reported the old
  `ConfirmForm` overlap, which is how it was known to see anything).
- **A row of buttons whose texts are translated is a box and not coordinates.**
  `ConfirmForm` had `BtnOther`, `BtnNo` and `BtnYes` at fixed `X` with `HAlign:
  End`: "Quit without saving" outgrew its 90 and the form was pushed wider, so
  the End-anchored buttons moved by different amounts and `Yes` (295..418)
  covered `Cancel` (264..320) -- measured with a probe. `TabOrderForm` was four
  76-wide buttons in 328, with "Move down" wider than that and the list not
  following the window. Both are a `Bar` panel (`Horizontal`, `Spacing: 8`)
  with an expanding `Spacer` before the right-hand buttons, and the
  `TabOrderForm` root is `Vertical` with the list `VExpand`.
  `lib/dialog/Confirm` had the same row and the same overlap, worse because its
  `Accept` text is the caller's ("Discard all unsaved changes" put `Accept` at
  265..442 over `Cancel` at 235..314); it is a `Bar` now. `AskText` was left
  alone: its two words are fixed and it moves its buttons by coordinate when
  `Option` is shown. Names are
  unchanged: the loader publishes them on the form whatever the nesting.
- **`MinWidth` and `MinHeight` do nothing unless the matching axis is `Fill`.**
  It is documented -- *"only means something on an axis whose `HAlign` is
  `Fill`"* -- and it is still the trap, because a floor that is quietly ignored
  looks exactly like a floor that holds until something squeezes. A `Split` whose
  halves had `MinWidth: 280` and no `HAlign` let the divider be dragged to **46
  pixels** by a window resize; with `HAlign: "Fill"` on both halves it stops at
  280. Anywhere a minimum matters, set the alignment in the same breath.
- **A `Split`'s divider does not spring back.** Once a squeeze has moved it, it
  stays where it was left -- `Position` is where it *starts*, not where it
  returns to. `Grows` decides who takes new room, and neither of them undoes a
  drag.
- **A `Button`'s natural size is its label and nothing else** -- 33x24 for
  `"Save"`, in a box and in a `Fixed` alike, and `GTK_THEME=Adwaita` changes
  nothing. A row of buttons laid out by a box therefore wants a declared `Width`
  or it comes out ragged and cramped. That is a *size* and not a *position*,
  which is the distinction worth keeping: a box layout is there to remove the
  coordinates, not every number.
- **And the rule the documentation was missing, now in
  [`docs/widgets.md`](https://github.com/getbintana/bintana-docs/blob/main/docs/widgets.md#which-of-the-two-models-a-form-should-use):**
  one dense grid of labelled fields is a `Fixed` or a `Grid`; a window with
  *regions* is boxes with a `Fixed` per region. Measured rather than argued --
  `examples/clients` was drawn both ways, and it is 117 numbers (54 of them a
  coordinate) as a `Fixed` against 17 and no coordinates as boxes. The `Fixed`
  version broke on a resize, and the reason generalises: **N controls is N
  independent anchoring decisions, no default is right, and getting one wrong is
  invisible at the size the form was drawn at.**
