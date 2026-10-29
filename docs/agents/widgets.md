# Widgets and GTK

The traps and decisions of this area, each with what it cost and the rule it left. [`AGENTS.md`](../../AGENTS.md) states the rules that apply to every change; this file is the evidence behind them and the detail that only matters here.

## Containers, lists and pages

- **A `GtkStack` cannot be reordered and its pages are addressed by name.** GTK
  offers nothing for either, so a `Switcher` counts pages by walking the stack's
  children and `Reorder` takes every page out and puts it back -- referencing
  each one first, since removing it drops the last reference GTK holds, and
  blocking the `Switch` handler for the duration, or a rebuild that ends where it
  started reports a fistful of switches nobody made. A page's title lives on the
  `GtkStackPage`, which goes away with the page, so it is carried across by hand.
- **A page that is not on screen still reports `Visible: true`, and keeps the
  last rectangle it was given.** A `GtkStack` does not hide its pages — it
  allocates only the visible one — so `Bounds()` on the page behind answers
  yesterday's number and `Visible` answers true either way. Measured on a
  `Switcher` whose pages were a 240-wide panel and a button: after the swap the
  panel still read `w=240`, and the button read `w=0` until its page was first
  shown. *Which page* is `Current`, and that is what a test asks. **And the stack
  measures every page, visible or not** — which is what makes it right for a view
  that swaps (the column keeps its floor) and wrong for a panel that folds (the
  half could not go under the far page's minimum; `docs/agents/layout.md`). The
  GTK switch for the second, `hhomogeneous: false`, is not exposed yet, and the
  `Homogeneous` a `Switcher` already answers is the inherited no-op
  `docs/agents/runtime.md` describes.
- **An order lives in one function, `bta_container_reorder`, and three callers
  ask it**: `Reorder(child, index)`, `Raise`/`Lower`, and the designer's drag.
  It sits beside `bta_container_attach`/`detach` because it is the same
  knowledge — what a slot does with a child — and because an index has to mean
  the same thing to all three. It did not: `Raise()` on an overlay's base moved
  it to last sibling while `overlay->child` still pointed at it, so the base went
  on filling and painted *over* its own floaters. `Container.Placement` is the
  same knowledge published (`Coordinates` `Order` `Layers` `Pages` `Halves`),
  because the IDE was keeping a table of class names instead and it drifted:
  `Overlay`, `Flow` and `RowList` reached the palette classified as boxes.
- **A `GtkListBox` and a `GtkFlowBox` keep their children in a `GSequence` of
  their own, so a sibling move is not a reorder.** Indices, the keyboard walk,
  headers and the filter all read that sequence, and `gtk_widget_insert_after`
  does not touch it — so a reorder goes out through `remove` and back in through
  `insert`, at which point three things bite. The wrapper must be referenced
  across the two calls: the box holds the only reference and `remove` ends in
  `gtk_widget_unparent`, so a row finalised between them takes the control's
  parent with it and leaves a control that exists, answers, and is in no list.
  The handlers must be blocked, or a move that ends where it began reports a
  `Select` nobody made. And **the row must be unselected before the remove**:
  `gtk_list_box_remove` clears the box's own pointer but leaves
  `ROW_PRIV(row)->selected` set, and `gtk_list_box_select_row` returns early on a
  row that already claims to be selected — so the row comes back *drawing*
  selected while `Index` answers `-1`, and nothing but a click gets out of it.
  One more, for the future: `insert` ignores its position when a sort function is
  set, so a `Sorted` property on either would make `Reorder` a silent no-op.
- **A `GtkAspectFrame` is not a `GtkFrame`**, and that one fact is most of what
  `AspectFrame` cost. It descends straight from `GtkWidget`, has no caption, and
  its CSS node is `aspectframe` -- so `GTK_IS_FRAME` does not catch it, both
  `bta_container_attach` and `bta_container_detach` need a branch of their own,
  and the detach goes through `gtk_aspect_frame_set_child(af, NULL)` rather than
  an unparent, or GTK keeps its pointer and the container goes on believing it is
  full. Its `Placement` is `Single`, the sixth word: one child and one place, so
  a gesture there is *land* -- told `Coordinates` an editor offers X/Y that do
  nothing, told `Order` it asks for an order the container has not got.
- **In an `Overlay` the bottom of the stack is the layer that fills.** The base
  is a GTK *property* (`gtk_overlay_set_child`) and the floaters are a list, so
  `Reorder(child, 0)` swaps the property rather than moving a sibling — both
  widgets referenced across it, since `set_child` refuses a widget that still has
  a parent and unparents whoever was base. That makes `Lower()` on a floater mean
  *become the base*, which is a change in what that verb does in one container
  and is written down in `llm/controls.md` and `widgets.md` for that reason. A
  base swap reparents two widgets (unrealize/realize); a move among floaters is
  one `insert_after` and reparents nothing.
- `GtkTreeListModel`'s child-model callback must never return `NULL`. Returning
  it for a childless node marks that node a leaf permanently, and children
  added later never appear. `bta_tree.c` returns the empty store instead and
  hides the expander reactively.
- A `RowList` puts every child in a `GtkListBoxRow` of its own, so a child's
  GTK parent is that row and not the slot. `bta_slot_child` looks through it;
  code that walks a slot's children by hand will not.
- **Telling a store an item changed costs a tree its selection, and a flat list
  keeps it.** GTK's selection model follows the *item* across an
  `items-changed`, so `SetCell` on a flat `TableView` leaves the highlight where
  it was. Under a `GtkTreeListModel` it cannot: the model answers with fresh
  `GtkTreeListRow` wrappers and the selection was on one of those. So renaming a
  node moved the selection to nowhere -- in `TreeView`'s new `SetText`, in
  `TableView`'s tree mode, and in `SortBy` before them. Every one of those
  remembers the node and puts it back; a caller that changed a cell did not ask
  to move anything. **The general shape: anything that goes through
  `items_changed` on a tree has to restore the selection**, and the reason a flat
  list does not is worth knowing before assuming the two behave alike.
- **Four controls answering the same question four ways is a bug with no failing
  test.** `ListBox`, `RowList`, `TreeView` and `TableView` are all lists, and
  they had drifted: `RowList` published three members and no way to select
  anything from code, `TableView` had `MultiSelect` and `Selection` without the
  four verbs that move a selection, `TreeView` could be emptied but never have
  one node removed, and `RowList` took GTK's `activate-on-single-click` default
  where `ListBox` deliberately sets the other one. None of that fails anything --
  it is only visible when a program moves a list from one control to the next and
  finds half its vocabulary missing. **The check is to read the four surfaces
  side by side**, which is now a table at the top of the list section in
  `controls.md`; the rule that came out of it is that what a row *is* differs
  between them and nothing else may.
- **What a `bind` connects, an `unbind` has to disconnect -- and the bug that
  proves it looks like nothing at all.** Whether a node draws a disclosure arrow
  is decided when its row is bound; a parent is routinely added *before* its
  children (`Add` takes a parent by key), so the row was bound when the answer
  was still "no children" and nothing rebinds it when they arrive. The arrow
  never appears and the folder cannot be opened -- no error, no warning, just a
  tree that does not work. The bound row has to watch its own children store
  (`items-changed`) and let go of it in `unbind`, or the next node recycled into
  that row keeps the previous one's watch. `TreeView` had already learned this;
  `TableView`'s tree mode had to learn it again.
  **And the first probe hid it**: it called `SetIcon` on the parent *after*
  adding the children, which rebinds the row and recomputes the arrow. A check
  written one call later than the bug would not have found it. When a rendered
  thing looks right, ask what else in the probe could have made it right.

## Popover, menus and accelerators

- **`Popover` is a verb, and the control that used to carry the name is gone --
  every trap this list had about it came from living in the form's tree.**
  `Popover.Show(content, anchor, [{ Rect, Position, Arrow, Autohide, Closed }])`,
  `Close(content)` and `IsOpen(content)` (`bta_popover.c`); the content is any
  control, usually a component with a `.form` of its own, drawn in its own tab.
  The control was a container with one child, it took no room, and so the
  designer could not draw, pick or drop into it (`ISSUE-popover-designer`,
  deleted as answered), it could live only in a container that allocates through
  a layout manager, `Visible` had to be read-only, and the runtime kept a
  `GtkPopoverContent` workaround in every walk over a slot. The same decision as
  `MenuButton`: it is something the runtime does, and a widget of its own bought
  a place for those problems to live. What was measured on the way, so it is not
  measured twice:
  - **Where the `GtkPopover` is parented is the whole of the design, and it is
    not the anchor.** A probe under AddressSanitizer, one anchor at a time:
    parented to a `Button`, `Entry`, `Scroller`, `SpinButton` or `DropDown` it
    works and says *Finalizing ..., but it still has children left* unless
    something unparents on `destroy`; parented to a **`ListBox` or a
    `TextView` it hangs the process at full CPU** (they manage their children
    themselves and take the popover for a row or an embedded widget) -- which
    are the likeliest anchors there are, an editor for a hint and a list for
    its menu; parented to the `GtkWindow` it says *Finalizing GtkWindow* for the
    same reason. It is parented to **the window's own content** (`gtk_window_
    get_child`: the form's surface, or the column holding its menu bar), whose
    dispose unparents its children, and the rectangle is worked out against that
    with `gtk_widget_compute_bounds`, which answers for any descendant. That one
    choice is also why the old restrictions are gone: no layout-manager rule, no
    container-must-be-mapped rule.
  - **A window that closes does not finalise, so a weak reference on the popover
    never tells.** `Form.Close` leaves the window alive for as long as the
    program holds the form, and its children with it; the popover is only
    *unmapped* and `closed` is not emitted, because nothing popped it down.
    Measured: `Closed` never arrived. The job listens to `unmap` as well as
    `closed`, and keeps the weak reference for the window that really is
    finalised.
  - **An anchor that leaves the screen closes the popover**, and that is a
    correctness rule and not tidiness: deleting the anchor while its popover was
    open took the window's focus with it, and GTK's own first-focus walk then
    went into the open popover and asserted (`gtk_widget_is_ancestor: assertion
    'GTK_IS_WIDGET (widget)'`, the old *autohide focus walk* critical from the
    other side). The job connects `unmap` on the anchor and pops down. `Show`
    still seeds a focus on the way in -- `grab_focus`, then a Tab walk, then
    `gtk_window_set_focus`, because a window that has not painted yet takes
    neither of the first two.
  - **No JavaScript runs inside a GTK signal here.** `closed` and `unmap` arrive
    from inside hiding a window or disposing an anchor, and a program's `Closed`
    that deletes something is the `widget_disconnect_tree` hazard. The signal
    marks the job and queues an idle (`job_settle`), which tells the program and
    then lets go; the idle holds a **reference on the job and not a pointer to
    it**, since a freed job's address is handed to the next one. So `Closed`
    arrives a turn after `Close()`, `IsOpen` is false at once, and a `Show`
    from inside `Closed` reopens the same job instead of tearing it down.
  - **The control is held by the job, not by the form.** Strong, invisible to
    the collector on purpose (the `form_hold` bargain), freed on every road: the
    popover closing, the window closing (`unmap`), the window finalised, and
    `bta_popover_cleanup` at teardown, before the context goes. A control put
    elsewhere or taken out while it is shown goes through `bta_popover_take` from
    the top of `bta_container_detach` -- the popover is not a container the
    program ever saw, so detach has no branch for it, and without the call a
    `Close()` followed by `Add()` was *cannot remove from this container* for the
    turn before the idle ran.
  - **A `Show` refuses before it moves anything.** The content comes out of
    wherever it was (`bta_widget_bring_in`, as `Add` does) and a refusal after
    that would leave a control with no parent that its program did not ask to
    lose; options are validated first, and a misspelt one is refused by name.
  - **The suite cannot show a popover on a window that has not painted.**
    `gtk_popover_focus` asserts when the window has no focus at its first paint,
    and a test that opens one on the frame a rectangle appears reads as a bug in
    the runtime; `testPopover` waits for the window's first paint (`Timer.After`)
    in the one place it opens one over a second window.
  - **`bta_slot_first_child` still exists and is GTK's first child.** It was the
    one place a popover's `GtkPopoverContent` wrapper was looked through; the
    wrapper is no longer in any slot, and every walk still starts there so the
    next wrapper has one place to go. `bta_fixed_focus` still skips
    `GTK_IS_POPOVER`: ours are children of the surface now, and a closed one
    that GTK names as the `focus_child` made the walk start after it and find
    nothing left.
- **A context menu has to walk outwards to be reachable.** A widget that handles
  its own press keeps the event -- a `Button` does -- so a container's `Menu`
  would open everywhere except over its contents. `popup_nearest` walks from the
  widget that saw the click up to the first one with a menu, translating the
  point as it goes. Popup actions live in a `popup` group on the widget, not the
  window's `form` group, so nothing shadows a menu bar action.
- Whether a popover actually *appeared* is not answerable from JS, so the suite
  covers the spec, the dispatch and the lifetime, and the display is checked by
  hand -- a popover is a separate surface, so it only shows up in a **root**
  capture, never in a window one.
- **A menu built from a spec you did not write lands on *your* form.** The three
  are one mechanism seen three times, and the designer's menu bar preview hit all
  of them: `make_item` does `JS_SetPropertyStr(ctx, form, name, obj)`, so a
  previewed `MnuOpen` **replaces** the IDE's own; the dispatch is
  `bta_emit_on(form, name, "Click")`, an ordinary `<name>_Click` property lookup,
  so clicking the picture would have opened a project; and `set_accels` ends in
  `gtk_application_set_accels_for_action`, which is the **application** -- a
  designed form with `<Control>s` in its menu takes Ctrl+S off the IDE. Rename
  after the path and drop the shortcuts (`MenuBar.sanitise`). The same lookup
  is what makes it work at all: a handler assigned from code is found like any
  other, which is how a menu built at run time gets one.
- **And that assignment is checked now.** `make_item` and `bta_actions_build`
  both looked away from `JS_SetPropertyStr`, exactly as the control loader did
  before `bta_form.c` was fixed: a menu item or a command named `Actions`,
  `Menus`, `Controls`, `DefaultButton` or `CancelButton` bound to **nothing**,
  `MnuActions_Click` never fired, and the form loaded as if all were well.
  Both refuse the form now, saying which item and why. The rule the fix needed:
  **nothing is wired until the name is ours** -- the `GSimpleAction` is built
  *after* the bind, because a refused bind frees the wrapper and an action
  already in the group would hold a handler pointing at freed memory.
- **`Menu` needs the widget to be in a form's tree already.** It names handlers on
  `w->form`, and a widget that has not been added to anything has none -- the
  property setter says so where it is set. Build, `Add`, *then* assign `Menu`;
  which is the `.form` loader's order too. **"Says so" was not true until the
  audit**: the answer was `cannot set property 'MnuX' of undefined` from inside
  `make_item`, and `HeaderMenu` inherited it. Both setters refuse now with the
  same sentence, before building anything.
- **A menu item's action outlives its wrapper, so the wrapper's finaliser has to
  disconnect it.** `make_item` binds `form[name]` to a fresh wrapper, and the
  wrapper owns `mi`; the `GSimpleAction` is held by the group too. Rebinding the
  name -- which `HeaderMenu` does on *every* right click, and which two menus
  sharing an item name do the first time the second is built -- finalised the
  old wrapper and left its action connected to a freed `mi`: the menu bar's
  `form.MnuCopy`, activated after a heading menu reused the name, ran
  `on_menu_activate` on freed memory. `menuitem_finalizer` and
  `action_finalizer` both `g_signal_handlers_disconnect_by_data` now (the latter
  also dropped a reference it never released). The orphaned action does
  nothing, which is the truth about an item nothing can reach.
  **And the collision itself is refused now**, which is the maintainer's call: a name
  on the form belongs to one thing, so `make_item` reads `form[name]` first and
  refuses a name held by an item of *another* menu, a control, a command or a
  member, pointing at `actions` -- one command, an `{ "action": … }` item in
  each menu. *The same menu* is told apart by an owner (the widget whose
  `Menu`/`HeaderMenu` it is, or the form for its bar) plus the prefix in
  `path`, set around `build_items` in the three entry points, so a heading menu
  rebuilt on every right click and a `Menu` assigned again still pass. Two
  things it found at once: the IDE's canvas menu, assigned to each form tab's
  own canvas, re-published `MnuCvRename` from a second widget -- it is the
  command `ActRenameCtl` now -- and **the designer built a drawn control's
  `Menu` live on the IDE's own form**, so drawing `MainForm.form` had been
  replacing the real tab strip's items. A drawing now keeps `Menu` and
  `HeaderMenu` as a declared note and builds neither (`DRAWN_NOT_BUILT` in
  `forms.js`); the serialiser writes the note back as it does a translated
  caption.
  **`Action` is the third, and it was found from the other side**: a drawn
  control's command is looked up among the actions of the form it is on, which
  is the IDE's, so every button of a project bound to a command the IDE has not
  got threw and was drawn as a grey stand-in -- fourteen of `bintana-project`'s
  `MainForm`, `BtnWelcomeOpen` among them -- and the two it had (`ActNew`,
  `ActOpen`) were bound to the IDE's own commands. It is in `DRAWN_NOT_BUILT`
  now, and `Designer.lendAction` lends the label and the icon from the drawn
  form's own `actions` by `bta_action_dress`'s rule, leaving the loader's
  `__declared` note so a save writes nothing it lent. **Anything a control
  resolves against `w->form` is resolved against the IDE in a drawing** -- a new
  property of that kind wants the same treatment, and `tests/ide`'s `nested`
  phase (`Mandos.form`) is the shape of the test.
  **The property grid has to know it too, or the row lies.** The control
  answers `""` for a note it did not build, so `DRAWN_NOTES` in
  `PropertyGrid.js` makes those rows read `Declared()` and write the note
  (`Designer.setDrawnNote`), and `Action` is a drop-down of the drawn form's
  commands. A **lent** `Text`/`Icon` is not the control's either: the row is
  empty, the command's value is the placeholder and the tooltip names the
  command (`PropertyGrid.lentBy`, which recognises the note `lendAction`
  leaves); emptying a label of the control's own lends the command's back.
  Two things bit on the way. **"Iconic" means an icon the control declared**,
  not one the command lent it a line earlier -- read the lent one as declared
  and emptying `Text` gave back nothing, because the button looked like an
  icon button. And **`restore` rebuilds from a snapshot, not from the root**,
  so a value read off the node passed to `buildSurface` was gone after the
  first undo; `drawnActions` is a getter on `this.root`, and the snapshot
  carries `actions` like it carries `menus`.
  **The commands are edited with `ActionForm`** (*Form > Edit commands...*, `MnuEditCommands` -- `MnuCommands` is the command palette, and taking its name silently replaced Ctrl+Shift+P's handler),
  the menus' shape: a dialog on the spec, applied on OK. A command something
  points at is not deleted, a name another thing on the form has is refused,
  and a rename is the control rename's bargain -- the pointing controls and
  menu items follow (`Designer.eachActionUse`), `X_Execute` and `this.X` move in
  the `.js`, the form is saved and undo is cleared.
  **A stand-in honours `Visible: false` too**, for the same reason from the
  other side: a built control is handed every property and a hidden one drops
  out of the drawing, while a stand-in was handed only its name and geometry --
  so `bintana-project`'s `Plan`, a `Report` the form keeps hidden because it
  only prints, sat on the board under the page that is shown. `Visible` is a
  stand-in row now and lives in the node. Its test closes the tab before
  reopening: **an open tab keeps its designer**, so `openNamed` on it rebuilds
  nothing and an assertion about what the file does on opening passes against
  the bug.
- **GTK4 runs an application's accelerators before the focused widget, so an
  Edit menu took Ctrl+C from every text field.** `set_accels_for_action` is
  resolved in the capture phase: the IDE's `MnuCopy` (`<Control>c`) copied the
  selected *control* as JSON while the user had a word selected in the property
  grid. `yield_to_text` in `bta_menu.c` is the rule now, for every application:
  when a menu item or command whose accelerators include a standard editing key
  (Ctrl+C/X/V/A/Z, Ctrl+Shift+Z, Ctrl+Y) is activated and the active window's
  focus is a `GtkText` or `GtkTextView`, the field's own action
  (`clipboard.copy`, `text.undo`...) runs and the handler does not. A click on
  the item goes the same way -- Edit > Copy copies what has the focus -- and
  `Action.Execute()` does not (`executing`), since code asked for the command.
  The suite cannot send a key; it was measured with `xdotool` on an `Xvfb` with
  a window manager: focus in a `TextBox` copies its text, focus on a button runs the
  handler. **The designer depends on the canvas taking the focus** (`glass.
  SetFocus()` on a click), or Ctrl+C after picking a control would copy the
  grid's text instead.
- **`.titlebar` is a class; `menubar` is only a node.** TitleBar's trick -- wear
  the classes GTK styles its own decoration with -- does **not** generalise.
  `menubar`, `menubar > item` are node names, and no widget an application builds
  is named `item`. Check before designing around it: `./tests/styles.sh` lists
  *classes*, and `menubar` is not in it; `gresource extract <libdir>/libgtk-4.so.1
  /org/gtk/libgtk/theme/Default/Default-light.css` is where the rules are. Some
  themes add a `.menubar` alias and the one inside libgtk does not, which is the
  wrong way round to build on.
- **A `Button` has a floor and a `Label` does not.** Adwaita gives `button` a
  `min-height: 24px` that applies to its **content**, so with a menu bar's 4px of
  padding above and below plus the border, the shortest button there is comes to
  34 -- against a real menu bar's 27. Measured, which is the only way this shows
  up: `Bounds()` reports the content box, so the button *reads* as 24 tall while
  taking 34. A row of `Label`s with the same padding is 27 exactly.
- **A real menu bar can be measured from Bintana.** The IDE is a form with menus,
  so its window has one; `Bounds()` is in window coordinates and the surface
  starts below the bar, so the Y of the first control **is** the bar's height. 27
  here, against the 28 the IDE's own `.form` was hand-written with -- which is the
  argument for measuring: the hand-written number was already wrong, and on a
  desktop with a larger font it is not one pixel.
- A menu label goes through GTK's mnemonic parser: a `_` eats the letter after it
  and underlines it. `bta_menu.c` doubles it in the labels of a `dynamic` item,
  which are data; any other text that comes from data and ends up in a menu needs
  the same.
- **A popover built on a widget that is in no window works exactly once.**
  `gtk_source_view_get_completion()` builds the completion object and its popover
  on the spot, so `ed.Completion = true` before `container.Add(ed)` gave it a
  surface with no size: one bad render
  (`Trying to snapshot GtkGizmo without a current allocation`) and then
  `gdk_popup_present: assertion 'width > 0' failed` on every attempt after. A
  `.form` never hits it -- the loader parents before applying properties -- and
  ordinary code does, because build-then-add is the natural order. Anything that
  needs a window is attached on `realize`, not in the setter.

## Properties, serialisation and the designer surface

- **`settableProperties` had the override rule backwards, and a read-only
  property could not be taken away.** The walk collected a name if *any* class
  in the chain had both accessors, so a subclass's getter-only declaration was
  skipped and the base's setter was offered, serialised and loaded anyway --
  exactly the `Popover.Visible` the old control had to refuse -- the class is gone and the rule is not. It is the boundary
  `Widget.Member` already walked: **the most derived class that declares a name
  decides whether it is settable**, tracked with a `seen` list rather than a
  check on the result. `forms.js`, and the general fix rather than a special
  case for one class.
  **And a `__` name is skipped, because it is a note and not a property.** The
  runtime's notes (`__declared`, `__children`, `__menus`, `__actions`) became
  accessors on `Widget.prototype` when the strict-plan cleanup moved them off
  the wrapper, and `__declared` is the one with a setter -- the loader and
  `rad.js` both write it -- so the getter/setter walk found it and the property
  grid offered it for editing. Stated as a prefix and not a list of four, so a
  note added later is skipped for free.
- **The walk that answers which properties a control has was the most
  expensive thing in the runtime, and it is cached now.** It asked for a
  descriptor for every name of every prototype in the chain -- 87 of them for
  a `Button` -- and **233 microseconds a call**, measured: the property grid
  takes it on every selection and the serialiser on every control of every
  save. The answer is **cached per prototype**, and the cache is **validated
  by the number of names the prototype has**, so a member added or removed
  rebuilds the entry and a prototype that did not change costs one array.
  Measured over 20000 calls: 4650 ms -> 1222 ms, **233 us -> 61 us**; and
  the serialiser over a form of twenty controls went from 7.7 ms to 4.9 ms.
  **The rule the cache must not break is the one above**: the most derived
  class that declares a name decides whether it is settable, so *every* name
  is marked seen and not only the settable ones -- the cached entry keeps
  both, the names and which of them are settable.
- **A benchmark that runs several variants in one process measures the garbage
  collector.** The walk allocates a descriptor per name, so the first variants
  of it left millions of objects behind and the collector's work landed on the
  later ones: the same code measured 4620 ms in one run and 11544 ms in
  another, and **a cache measured slower than the code it replaced**. One
  variant per process, and the numbers agree to a percent.
- **A `Decimal`-valued property was invisible to the serialiser, and
  `savableValue` is where.** The serialiser walks the prototype chain for
  accessors and then filters what it found -- strings, numbers, booleans and
  arrays -- so every object was skipped as "not a plain value". A `Decimal` is an
  object and **is** savable (`JSON.stringify` writes it through its own
  `toJSON`), so `DecimalBox.Value` was not written and a field came back at zero
  with nothing said. `v instanceof Decimal` is the one object that passes the
  filter; a new property holding one needs no other change, and one holding a
  *different* object will be skipped the same way.
- **`GTK_INPUT_ERROR` leaves GTK using an uninitialized `new_value`.** The
  documented way to refuse what was typed into a `GtkSpinButton` is to answer
  `GTK_INPUT_ERROR` from the `input` handler, and it reads a `gdouble` the
  handler never wrote -- measured, the field came out holding a denormal. A
  refusal restores the text itself (`gtk_editable_set_text` on the entry) and
  answers `true`, which is what `DecimalBox` does; the double is only a view and
  the exact value lives in a note, so the handler always has the text it wants.
- **A `ColorButton`/`FontButton` reports its change on GTK's own time.** A
  flag raised around filling the property grid (`PropertyGrid.updating`) is back down by the
  time the signal arrives, so filling the grid arrived in `applyEditor` anyway --
  three entries onto the undo stack and a form marked dirty that nobody touched.
  Invisible for as long as every tab switch rebuilt the surface and threw the
  stacks away. The fix that does not depend on timing: **an edit that changes
  nothing is not an edit**, checked against what the property already is.
- **A widget's state dies when you reassign what it holds.** Moving one
  `SourceEditor` between notebook pages meant `Editor.Text = state.text` on every
  switch, and GtkSourceView drops its undo history when the buffer is replaced:
  the text came back, the history did not. Anything a widget keeps for itself --
  undo, selection, scroll -- is only kept by *not* rebuilding it. Measured before
  deciding: a `SourceEditor` per tab is ~240 KB (small file) to ~550 KB (78 KB
  file) and 2-4 ms, against 113 MB idle. "Costly" was worth checking rather than
  assuming; a design tree is the expensive one, ~1.5 MB per open form.
- **A control that cannot say *nothing* answers something, and that is a data
  bug wearing a widget's clothes.** A `GtkCalendar` always holds a day, so a
  `DatePicker` answered today for a field nobody filled in and an optional
  `Field.Date` -- which spells the empty date `""` and has always let it through
  -- took a date the program never meant, with no error anywhere. The empty
  state is a flag of ours (`bta-date-empty`) with the calendar left holding what
  it had, so the popover opens on a sensible month; choosing a day ends it, a
  page turn does not and raises no `Change`. **`Calendar` refuses `""`** instead
  of sharing it: a month is drawn with a day on it. `ComboBox` was the last
  one, and is answered the same way, opt-in: `AllowEmpty` keeps a sentinel row
  of `""` at position 0 of the model, which *is* nothing chosen, and every door
  reads the model through `combo_off` so the program never counts it. **GTK
  cannot do it directly**: `GtkDropDown` owns a `GtkSingleSelection` with
  autoselect on, which ignores `GTK_INVALID_LIST_POSITION` (measured: `Index =
  -1` stayed put), and nothing exposes the model to change that. A mutation
  that can take the chosen row away (`Items`, `RemoveRow`) blocks
  `notify::selected` and raises one `Select` for the net change. The popup
  shows the sentinel as a blank first line, which is also how a person undoes
  a choice. Off by default, because `Index = -1` has always meant *moves
  nothing*.
- **`Cursor` is the same rule, arrived at from the other side.** A cursor set on
  an ancestor reaches a descendant only while the descendant has none, and the
  ones that matter have one: the `GtkText` inside a `TextBox` and a `SpinBox`
  and the `GtkTextView` inside an `Editor` all carry `text`, a `LinkButton`
  carries `pointer`. So `cursor_apply` walks `gtk`, `inner` and the editable's
  delegate exactly as `w_set_flag` does. Two things follow that are not
  obvious. **`Auto` restores rather than clears** -- each part remembers what it
  had under `bta-cursor-kept` the first time it is touched, or clearing would
  leave a link with no hand for the rest of the run. And **`Form.Cursor` is not
  a busy pointer for the window**: a child with its own wins, GTK has no way
  down, and that is documented rather than worked around.
- **The names `Cursor` takes are ours, and that is deliberate.** The runtime
  passes vocabularies through when they are the platform's -- icon names, font
  families, `Shortcut`'s accelerators -- and this one does not, because it is
  the only one that is closed *and* abbreviated. It also has to be checked here:
  `gdk_cursor_new_from_name` is documented to answer NULL for a name no theme
  knows and **does not** -- it answers a live cursor for `bogus-name-xyz` --
  so an unchecked typo would be a property that reads back correctly and draws
  an arrow. The table in `bta_widget.c` is the single place the CSS spelling
  appears, and `bta_widget_cursor_options()` builds the drop-down out of it so
  the two cannot drift.
- A `Notebook` whose page is empty -- the IDE hides the editor while designing --
  still absorbs height if it expands, and that shows up as a blank band that
  grows with the window. `setMode` turns its `VExpand` off and leaves `HExpand`.

## Drag and drop

- A `GtkDragSource` goes in the **capture** phase. A `Button`'s own gesture
  claims the press, so a source in `bubble` never reaches the drag threshold: the
  control would be draggable everywhere except on the controls one drags from.
- **A `Drop`'s point is the accepting widget's, and a scroller's already
  carries its scroll -- so placing a dropped row is a comparison and nobody
  has to measure a layout mid-gesture.** `examples/kanban` appended for its
  first two versions on the belief that it could not be done: `Drop(data, x,
  y)` and `child.Bounds(that widget)` are the *same* space, which is what
  `gtk_widget_compute_point` gives. Measured with a real pointer on a column
  scrolled down -- the drop arrived at `y=168` while the cards above the view
  read `Y: -293, -206, -119, -32` and the ones in it `55, 142, 229` -- so
  adding `ScrollY` is counting the scroll twice. Two more from the same
  sitting, both of which a synthetic `Emit` would have hidden because it only
  asserts our own numbers back: **a hidden child measures 0x0 at the origin**
  rather than keeping its last rectangle, so a walk over children skips what
  is not `Visible`; and **what such a walk must answer is a child's *name* and
  not an index**, since a filter hides rows without taking them out, so the
  third row shown can be the seventh the list holds. Written down in
  `llm/controls.md`'s `Drop` row and in `reference/widgets/Widget.md`, which
  said only `Drop(data, x, y)` while this was being guessed at.
- **A drag that starts from a control cancels its click, and the program hears
  `MouseCancel`.** The source claims the press in the capture phase (which is
  also what stops the click firing at the end), and a claimed sequence makes the
  widget's `GtkGestureClick` emit `cancel` with no `released`. Measured with a
  real pointer on a `Label` with `DragData`: `MouseDown`, `DragBegin`,
  `MouseCancel`, `DragEnd` -- the cancel arrives from an idle, a gesture being
  reset when its widget is hidden or disposed -- and no `MouseUp`. A plain click
  beside it gives `MouseDown`, `MouseUp` and nothing else (`testMouseCancel`).
- **A second finger *ends* a click gesture; it does not cancel it.** Measured with
  a virtual touch screen (`tests/manual/touch/run.sh`): `end`, and neither
  `released` nor `cancel`, while a drag and drop that claims the sequence gives
  `cancel`. `MouseCancel` listens to both (`end` connected after the class
  handler, so a click that did finish has already cleared its mark) and the
  GTK documentation, which names only `cancel`, would have left it silent for
  the commonest case.
- **No drag starts inside a `RowList`, in either phase.** A `GtkListBox` claims
  the press for its own selection, so a card with `DragData` set selects and
  nothing else -- measured with a one-row probe that printed `SELECTED` and no
  `DROPPED`, while the same gesture from a bare `Button` dropped fine. It is the
  VTE shape above seen from the list side. A column of draggable cards is a
  `Scroller` arranged `Vertical`, which claims nothing, with selection
  (`MouseDown` plus a class), filtering (`Visible`) and editing (double click)
  written by hand -- one `On` each, on the card. Found building
  `examples/kanban`, and written down in `docs/widgets.md` under `RowList`,
  where somebody choosing a container will read it.
- **A `GtkDropTarget`'s `enter`/`motion` carry only the point, and `preload` is
  what puts the string beside it.** The data only exists at `drop` unless the
  target preloads it on hover, so `DragEnter`/`DragOver` read it off the target
  with `gtk_drop_target_get_value` -- same `GValue` the drop arrives with, one
  gesture earlier, and `""` on a very early enter rather than holding the event
  back. The alternative is `gdk_drop_read_value_async` per motion, which is a
  callback to marry back to a position that has already moved.
- **A refusing answer has to be strict, and the reason is what a handler that
  says nothing returns.** `DragOver` refuses on `false`, so the check is
  `JS_IsStrictEqual(r, JS_FALSE)`: `KeyPress`/`MouseWheel` can afford the loose
  `JS_ToBool` because their handlers consume by returning `true`, but here the
  refusing answer is the falsy one and `undefined` -- what every handler that
  shows a line and answers nothing returns -- would refuse every drag anywhere.
- **And the refusal lives in `DragOver` alone, although both events answer
  one.** `on_drag_enter` and `on_drag_motion` go through the same helper and
  return the same *no action*, which is what made *"`DragEnter` refuses
  too"* look true from the code -- and it is not, because GTK's `motion` sets
  the action again a few milliseconds later. Measured three ways with a real
  pointer, dropping on a target that refuses: in `DragEnter` only, the `Drop`
  **arrives**; in `DragOver` only, it does not; in both, it does not. So a
  `false` from `DragEnter` is worth exactly the time until the pointer moves a
  pixel -- and **that time is always zero**, which is what makes it dead rather
  than narrow: GTK raises a `motion` at the *same point* immediately after every
  `enter`, in every gesture measured (`DragEnter card-7 60,0` then
  `DragOver card-7 60,0`), so there is no drop that can land in between. The
  documents said `DragEnter`/`DragOver` in three places and say `DragOver` now,
  and `examples/kanban` had the matching `return false` in its `dragEnter`,
  which is gone for the reason `examples/serve` has no `".."` guard: a refusal
  that cannot fire teaches the next reader the wrong vocabulary. Read from the
  C this is invisible: the two paths are identical and what discards one of the
  answers is in GTK.
- **`drag-end` finishes every drag, so it is the only source-side signal
  connected.** Success and refusal were measured; Escape is GTK's documented
  finish rather than a measured one -- an `xdotool key Escape` mid-drag under
  XTEST did not cancel anything and the drag went on to a `Drop`. Connecting
  `drag-cancel` beside it would answer twice for one failed gesture. And a
  single long `xdotool mousemove` jump made *during* a drag registers nothing
  -- enter/motion only arrived for small stepwise moves, which is also the
  shape of a real hand.
- **A drop is not a leave, and the leave it owes arrives during somebody
  else's drag.** `DragLeave` is documented as *the drag left without dropping*,
  which is true and is half the sentence. Measured with a real pointer: after a
  `Drop` nothing else comes -- five seconds of stillness and no leave -- and
  GTK delivers that target's `leave` at the **next** drag instead, right after
  its `DragBegin` and for a target the new drag never went over:

      Ok Drop card-7 60,60 / Src DragEnd / Src DragBegin / Ok DragLeave /
      No DragEnter card-7

  So a target that lights up in `DragEnter` and puts itself out in `DragLeave`
  **stays lit after a drop**, which is the shape anybody writes first, and a
  program counting enters against leaves is handed one it did not ask for.
  `examples/kanban` is right because `dropOn` calls its own `dragLeave` before
  it moves anything -- a line that looked like belt and braces and is the whole
  of it. Written into the `Drop` and `DragLeave` rows rather than fixed:
  emitting a leave of our own from `on_drop` would make the late one a
  **second** leave for one gesture, and swallowing that late one means keeping
  a flag per target for a tidiness nobody asked for. A drag that leaves without
  dropping, and a drop that was refused, both raise it in their own gesture.
- **The desktop's file drop is a different *type*, not a different value.**
  `AcceptDrop` registers a `GtkDropTarget` for `G_TYPE_STRING`, which is the
  application's own `DragData`; the file manager offers `GDK_TYPE_FILE_LIST` (or
  a bare `G_TYPE_FILE` for one file), and a target that does not name those types
  never sees the drop at all -- it is refused by GTK before any handler runs, so
  there is nothing to debug and nothing in the log. Hence `AcceptFiles` as a
  second property with a second target rather than a mode on the first, which
  also keeps `AcceptDrop === true` meaning what it has always meant in every
  `.form` already written.
- **A dropped file may have no path.** Something on a remote share is a real
  `GFile` whose `g_file_get_path` is NULL; handing its URI over as if it were a
  path fails one line later, in whatever `File.Load` the handler wrote, and looks
  like a bug in the application. Those are dropped, and a drop with nothing local
  in it is refused rather than delivered as an empty list -- a handler called with
  nothing would have to check for it, and every one of them would forget.

## Icons, themes and styles

- An own `-symbolic` icon is drawn with **fills**: GTK's recolouring forces
  `fill`, and a stroke keeps the colour in the file (black on a dark theme).
- **A headless run does not see the desktop's icon theme.** Under `xvfb-run` GTK
  falls back to Adwaita (1520 icons), while a desktop session runs its own
  theme (the one measured had 2575). So `Application.HasIcon` answers about a theme that is
  not the user's, and `tests/ide`'s walk over every declared `Icon` passes on a
  name that comes out blank on the real screen -- `view-more-symbolic` did.
  **`tests/icons.sh` is how you check one now** -- a console project, so it needs
  no display at all and could not ask GTK even by accident:
  it reads the desktop's theme off the disk, follows what it inherits, adds the
  ~127 symbolic icons GTK4 carries *inside its own library* -- the ones no theme
  directory shows, and the ones easiest to forget -- plus whatever the project
  ships in `icons/`, and reports every `Icon` declared in a `.form` that nothing
  provides. Running the suite on a real display answers the same question by
  putting dozens of windows over whatever the user is doing, which is a bad
  trade and is no longer the advice.
- **A headless run does not see the desktop's *theme* either, and `Style` is the
  half nobody checks.** Which CSS classes exist is the theme's answer, so a class
  the user's theme lacks is accepted, saved into the `.form`, and does nothing --
  the same shape of failure as a missing icon, without even a blank square to see
  it by. `tests/styles.sh` prints what the theme really defines and what each
  class is written for; the node each control is, which decides whether a class
  can match at all, is in [`docs/widgets.md`](https://github.com/getbintana/bintana-docs/blob/main/docs/widgets.md#styling-the-vocabulary).
  **Moving a widget's CSS node is a breaking change for anyone's `app.css`**:
  this tree moved three of them in one afternoon before anything checked, which is
  why `testCssNode` in `tests/widgets` now writes every node down and fails on a
  type that is not in the table.
- **A control whose face is a button wears the theme's button rules from a sheet
  of the runtime's own.** A `ComboBox` is a `dropdown` and what is *painted* is
  the `button` inside it, so `flat` -- which the theme writes as `button.flat` --
  landed on a wrapper nobody sees and did nothing; the same for `DatePicker`
  (`menubutton`), `ColorButton` (`colorbutton`) and `FontButton` (`fontbutton`).
  `runtime/css/base.css` names the path those four need; it is baked into the
  binary like the prelude and loaded *under* every `app.css` (same priority,
  added first: measured, with two providers at one priority the last one added
  takes the rule, so a project overrides it whatever its specificity).
  **The states are copied with the class**, because `flat` is not one rule:
  `button.flat:hover` and `:active`/`:checked` sit beside the rest state in the
  theme, and a rest-state-only rule gives a control that is flat until the
  pointer arrives and then wears the plain button's gradient and frame. The tints
  are `alpha(@theme_fg_color, …)` -- 0.16 and 0.24, the weights that make
  Adwaita light's `#dad6d2` and `#cdc7c2` over `#f6f5f4` -- rather than the
  literal grey, so a dark or high-contrast desktop hovers with its own ink;
  `:disabled`/`:backdrop` need no rule, the base one already beats
  `button:disabled` because a provider above the theme takes the property in any
  state. Measured on an `Xvfb` with `xfwm4`, `tests/probe.sh` on the pixels: at
  rest `srgb(246,245,244)`, the window's own, against a plain one's framed
  `srgb(250,249,249)`; hover `srgb(213,214,214)` against the theme's own flat
  button at `srgb(218,214,210)`; pressed `srgb(198,198,199)`; a disabled one
  stays flat. **What it will not do is guess a colour** -- `suggested-action` on
  a `ColorButton` is still nothing, and that is a rule in the project's
  `app.css`. `tests/styles.sh` reads the sheet with the theme, so
  `ide/modules/Styles.js` says `flat` fits those four and the class chooser
  offers it as its own. (The other road -- putting the class on the face in C --
  would reach the theme's whole `button` vocabulary at once, including the
  states, at the cost of `Style` landing on two nodes; the sheet was the call.)
- **A `Separator`'s declared size is the room, and the rule is the pixel in the
  middle of it -- a shape the runtime owes to GTK, not one GTK has.** In GTK 4
  a `GtkSeparator` draws nothing of its own: `gtkseparator.c` has no measure
  and no snapshot, it is a `separator` CSS node the theme paints over the
  *whole allocation*, so a separator 76 wide is a 76-wide band of border colour
  -- the square everybody draws once. The runtime insets what is *painted*
  through a CSS margin, which GTK applies when it allocates and does not count
  when it measures (`gtk_widget_allocate`, `gtk_widget_adjust_size_request`),
  so a box's cell and a surface's rectangle stay exactly what they were and the
  rule comes out centred. Measured on the IDE's own toolbar and in
  `tests/widgets`: `Width: 12` on a `Vertical` one is a cell of 12 with a
  **1x120 rule five pixels in** -- `Bounds()` answers the *cell* (the room plus
  the rule, which is what the layout gave the control, and what the designer
  needs to select) while the room itself is the rule's own CSS margin -- and
  `Width: 1` is no room at all, the rule filling its box as it always did. The
  theme still decides the rule's colour; `Margin` is one number for all four
  sides rather than CSS's four, which is why the room is the size.
  **And the container cannot stretch it into a band**: the axis across the rule
  is the one a size means room on, and a box fills a child across itself -- a
  horizontal rule in a horizontal bar came out the bar's whole height (28 of a
  44-pixel toolbar). `widget_apply_align` centres a `Separator` on that axis
  wherever GTK is the one placing it -- and it is asked *there*, not in the room
  function, because `Add` re-applies the declared alignment after the attach,
  which undid the first version of this and brought the band back. Measured: the
  same rule loose in a 40-pixel bar is **1x1**, and the room itself is computed
  on arrival (`bta_container_attach`, plus `bta_widget_adopt` for a page
  appended to a notebook, which never attaches) and on every relayout.
- **A hand-written list in a test drifts exactly like a hand-written list in the
  code.** The icon walk was seven form names typed out; by the time anybody
  looked the IDE had eleven forms, and `ColumnForm`, `PoForm`, `ProjectForm` and
  `SearchForm` had never had an icon checked -- `ColumnForm` was declaring
  `view-table-symbolic`, which is in no theme the suite was checked against and not inside GTK either, so
  the dialog came up with no icon and the suite was green. AGENTS.md even
  described the test as walking *every* `.form` under `ide/`, which is what it
  does now: `Directory.List` the directory. A test about files that names its files is
  the same mistake `EventNames()` retired for widget types.
- **A `.form` names one icon; code picks the first of a list that resolves.**
  Moving a control from code into the file quietly drops its fallback — which is
  how the IDE's tab-strip button came out blank, since `view-more-symbolic` is
  not on the desktop it was checked on and nothing said so. `tests/ide` now walks every `.form`
  under `ide/` and checks each declared `Icon` against `Application.HasIcon`.
  **And the names the IDE's own forms declare are the `-symbolic` spelling**,
  because the full-colour legacy ones are not on every desktop: `edit-find`,
  `go-up`, `document-new` and `applications-development` are Fedora's
  `AdwaitaLegacy` and Ubuntu's Yaru, and the Adwaita a bare runner falls back to
  ships only the symbolic set. Sixteen icons drew blank on the runner and every
  one of them was fine on a desktop with the legacy icons -- which is what walking every `.form` is for.
- `gtk_icon_theme_has_icon()` promises more than the theme delivers: it can say
  yes and hand back its `image-missing`, or an SVG that renders to nothing (art
  outside the frame, no `viewBox`). `bta_icon_available` renders it at 16x16 and
  looks for ink; on a button with no text the difference is a blank square.
- `Background` on a `Button` needs `background-image: none`: the theme's gradient
  is an image and would cover the colour. `widget_styles_apply` does it.
- **Two stylesheets, and the order between them is the whole design.**
  `<project>/app.css` loads at `PRIORITY_APPLICATION` and carries the classes
  `Style` names; the per-widget `Background`/`Foreground`/`Font` sheet loads one
  above it, so the by-hand exception still wins where it is used. Equal
  priorities would have left the winner to the order the providers happened to be
  added in -- both write single-class selectors, so specificity does not separate
  them. A test that only round-trips the property sees none of this: `testStyleSheet`
  measures a label wearing `.t-big` against a bare one, which is the only thing
  that can tell "the sheet was loaded" from "the property remembered a string".
- **An image in memory is a verb, not a property.** `Picture.LoadBytes(bytes)`,
  `Image.LoadBytes(bytes)`, `Painter.Image` taking a string *or* `Bytes`, and
  `DrawingArea.ToPng()` answering `Bytes` -- the circle `Http` (which answers
  `Bytes`) and `File.LoadBytes`/`SaveBytes` left open, which used to be crossed
  with a temporary file. Verbs because a property here promises the designer can
  edit it and the `.form` can carry it, and a megabyte of JPEG is neither; the
  `File` properties stay, and the old rule holds -- last source wins, so bytes
  clear `File` and `Icon`. **The painter's image cache is the path's alone**: a
  freed buffer's address can be handed out again, so a cache keyed on bytes
  would eventually paint the wrong picture. Measured cost of that choice: 2.7 ms
  a call against 0.045 ms cached, for a 640x480 PNG.
- **Clearing `Image.Icon` has to clear `IMG_NAME_KEY` too**, which it did not:
  `bta_image_set_icon` leaves the name on the widget and hooks the icon theme so
  the icon survives a change of theme or scale, and that name outlived the
  `File` that replaced it -- so the next theme change put the old icon back over
  the picture. Invisible until something else was shown.
- **Neither GTK setting answers "is the desktop dark".** `gtk-theme-name` is
  `"Default"` under Adwaita and `gtk-application-prefer-dark-theme` is `false`
  under `GTK_THEME=Adwaita:dark` -- both measured -- so `Widget.Dark` is derived
  from `gtk_widget_get_color()`, the ink really being drawn, which is what
  `Painter.Dark` always did and is now the same function (`bta_widget_dark`).
  Two traps around it: **an unrooted widget has no resolved style** and answers
  white in every theme, so the fallback is the application's first window; and
  the `GtkSettings` the `ThemeChange` handlers hang off outlives every window,
  so they go through `bta_widget_watch` or they fire on a freed form. Inside the
  handler the colours are already the new ones, measured -- no idle hop needed.
  **The fallback is `bta_style_root()` and every reader of the ink goes through
  it**, which is the whole of what it is for: `Widget.Dark` had it and
  `Painter.Foreground` did not, so a `Chart` built for a document and saved with
  `Save()` came out with a white title, a white legend and white axis labels over
  a transparent ground -- the slices and bars drawn correctly, so it reads as a
  chart without words rather than as an error, and `Save` is exactly the call
  that needs no window. Every caller had to write `Foreground = "#222222"` to
  avoid it. **A control *inside* a window that is merely hidden was measured
  drawing correctly**, so the condition is *in no window* and not *in no shown
  window*; and a **console project has no theme to ask at all** (no GTK
  settings, no window), which is not a hole in the fallback but the truth -- a
  document drawn there has no theme in it, which is what `lib/report` already
  means by pinning `INK = "#000000"`. **And the theme's ink is not paper's ink**:
measured with `GTK_THEME=Adwaita:dark`, the same chart saved with no window comes
out with *light* text, which on a white page is the original bug back. The
fallback answers "what would this look like on screen", which is right for a
control; a program drawing for paper pins its ink, as `lib/report` does and
`bintana-zabbix` does for its charts.
- **`Application.HasIcon` renders and looks for ink**, so it already answers "will
  this draw" and not merely "does the theme have it" -- which is why the palette's
  fallback chains work at all on a desktop whose symbolic icons are positioned
  with a `transform`. What it cannot do is invent a fallback: a name with nothing
  behind it comes back `""` and the button is *empty*. That is what
  `color-select-symbolic` did to the palette's `ColorButton` here -- embedded in
  GTK, overridden by the desktop's theme, blank -- and the fix is a drawn icon behind it,
  not a cleverer lookup.
- **A leading comment can make a valid SVG unreadable.** gdk-pixbuf decides a
  file is SVG by looking for `<svg` in its first bytes, so a header comment long
  enough to push the element past that window loads as *"Unrecognized image file
  format"* with nothing wrong in the file. `tools/bintana-ide.svg` keeps one line
  above the element and everything else inside it. The renderer under it is
  glycin now, which is also the one that ignores `transform` (see the icon note
  above) and which rejects `--` inside a comment where a browser would not.
- **A Pango context holds font sizes in device units, not points.** Reading the
  theme's font from `gtk_widget_get_pango_context()` and showing it reported
  11pt as `14,67px` -- the right font in the wrong unit, and one the user never
  chose. `GtkSettings:gtk-font-name` is the desktop's own spelling, in points.
- **Numbers written into CSS need `g_ascii_formatd`.** GTK calls `setlocale()` at
  startup, so `%g` writes `11,5` on a machine like this one and CSS silently
  ignores the rule. The colours are safe because `gdk_rgba_to_string` is
  locale-independent; anything formatted by hand is not.

## Focus, keys and gestures

- **`Focusable` reaches `inner` and the editable's delegate, and the *getter* has
  to ask the same three.** A `TextBox`'s focus sits on the `GtkText` *inside* its
  entry and an editor's on the view inside its scroller -- the same *contains*
  rather than *is* that `Focused` reports -- so `gtk_widget_child_focus` walked
  past the unfocusable outside straight into the focusable inside. `w_set_flag`
  reaches `inner` and, for a `GtkEditable`, its delegate. Found by a tab-order
  test expecting Tab to skip a `TextBox`.
  **The getter was left reading `w->gtk` alone, which answered `false` for every
  `TextBox` in the tree** -- in GTK4 the outside of an entry is not focusable at
  all, the `GtkText` inside is -- so a property that read back wrong *worked*, and
  that is a bug only whoever asks it a question can find. The question arrived
  years later: the designer's tab-order dialog lists the children Tab can reach,
  listed the buttons and skipped every field. `widget_focusable` is the three
  widgets the setter writes, asked in one place.
- **A widget that claims a gesture sequence cancels every other gesture on it,
  in either phase.** Not only the bubble-phase problem the drag source has: VTE
  claims the press for its own text selection, so the `GtkGestureClick` that made
  `Terminal.LinkPattern` work saw `pressed` and then *never* saw `released` — in
  capture too, because claiming is not about ordering. Something that needs both
  halves of a click on a widget that handles its own has to be a
  `GtkEventControllerLegacy`, which has no sequence to lose. It gets surface
  coordinates rather than the widget's, so the point goes through
  `gtk_widget_compute_point`.
- **A `GtkText` claims the key press and lets the key release through**, so
  `KeyPress` and `KeyRelease` are not two views of the same keystroke. Bubble
  phase gives the focused widget first refusal, and for a printable key on a
  `TextBox` the press *is* the typing, so it is claimed; the release is of no use
  to the entry and arrives. Measured: `b` -> release only; `F5` and `Escape` ->
  both. Do not "fix" the missing press, and do not pair the two halves of a key on
  anything that edits text.
  **Return is claimed like a printable key, and that is what keeps a multiline
  box from hearing it**: with a `TextEditor` focused, neither plain Return nor
  Ctrl+Return ever arrived as a `KeyPress` (measured; the release did, and
  Ctrl+Return had already written a line in the view). **And a control's
  `Shortcut` does not fire while a text view has the focus either**: an `F5` --
  which nothing consumes -- reached the editor's own `KeyPress` and did not
  activate a button whose `Shortcut` was `F5` in the same window, while the same
  key activated that button with the focus on the button, on the form, or in a
  window with no text view in it at all. So a box with a body commits by its
  button -- the IDE's Changes panel is what measured it -- and catching
  Ctrl+Enter *inside* a text view is a runtime feature and not a handler.
- **`GtkButton` does not claim its press, so `DragToMove` drags a window from a
  button.** The gesture is on the window, in the bubble phase, and moves only
  past the drag threshold -- `GtkWindowHandle`'s own recipe, which has no rule
  about its children either; a header bar's buttons are dragged by the same way.
  A click on the button is still a click (no move, `Click` raised once) and the
  drag raises no `Click`, released off it. What does claim is text: a drag in a
  `TextBox` selects and the window stays. Measured in `testFrameless`, which
  expected the button to stop the move and was wrong.
- **With no window manager, `gdk_toplevel_begin_move` still moves the window**:
  GDK's X11 backend emulates the move when nobody answers `_NET_WM_MOVERESIZE`,
  so under the suite's bare `xvfb-run` an `xdotool` drag lands where it was
  dragged (+60,+40 for ten steps of 6,4). That is what lets `testFrameless`
  assert the move rather than the flag. The function is `gdk_`, not `gtk_` --
  `GdkToplevel` is the surface's interface.
- **`Background` takes what `gdk_rgba_parse` takes, and that is not CSS's
  `transparent`.** A see-through window (`Decorated: false` for a clock) is
  `"rgba(0,0,0,0)"`; `"transparent"` is refused as *not a colour*. **That the
  desktop then shows through is not verified.** On an Xvfb with
  `xfwm4 --compositor=on` the window's corner read `srgb(0,0,0)` -- which was the
  root window's black and proves nothing -- and over a light root image the same
  window showed a black square: the window paints nothing, and something between
  it and the screen does not blend (that xfwm4 on llvmpipe, or GDK not taking an
  ARGB visual there). Settle it on a real compositing desktop before relying on it.

## Editors

- **`gtk_text_view_scroll_to_iter` on a view with no allocation does nothing, and
  says nothing.** A tab that was just opened has not been laid out yet, so
  revealing a match through an iter leaves the selection right and the view
  somewhere else -- which reads as the jump being wrong rather than early.
  `scroll_to_mark` keeps the request and carries it out on the frame there is one,
  so anything that scrolls right after building or switching a view has to go
  through a mark. **`Editor.Select` and `GotoLine` both do, and the second one
  only since somebody called it from a third place.** This entry used to end
  "`GotoLine` predates this and is called where a frame has already passed",
  which was true of the two callers it had -- a traceback clicked in the log and
  the find bar, both inside a tab already on screen -- and false the day the
  events page opened the `.js` and jumped to the handler in the same turn. The
  symptom is the one this whole entry is about and it is easy to misread: the
  cursor is on the right line, the view is at the top of the file, and nothing
  anywhere says so. **The rule has no exceptions worth writing down**: if it
  scrolls, it goes through a mark.

  It was **not assertable** while an `Editor` answered where its *cursor* was
  and never where it was scrolled to; `ScrollY` exists now -- asked for by a
  diff viewer and not by this -- and `tests/widgets` (`EditorScroll`) asserts
  the jump. One thing that test had to learn and anything reading a scroll has
  to know: **the mark is honoured on the next frame**, so `ScrollY` on the line
  after `GotoLine(n)` still answers where the view was. Assigning a scroll is
  immediate; asking to be shown a line is not.
- **`GtkSourceSearchContext`'s `occurrences-count` is filled in by a background
  scan and answers `-1` until it lands.** Same for `get_occurrence_position`. A
  find bar built on either shows "12 matches" some frames after the search, and a
  test can only wait and hope — which is the shape of every flaky test this repo
  has had. `Matches`/`MatchIndex` walk the matches with
  `gtk_source_search_context_forward` instead: synchronous, exact, assertable, and
  unmeasurable on a source file.
- **`gtk_list_box_get_selected_row` answers `NULL` in `SELECTION_MULTIPLE`.** So
  `ListBox.Index` and `.Text` would have gone blank the moment `MultiSelect` was
  turned on, on a list with three rows selected. Both walk the rows looking for
  `row_is_selected` now. GTK also reports the two modes through different signals
  (`row-selected` / `selected-rows-changed`) and emits the second in *both*, so
  the multiple handler has to stay quiet in single mode or every selection arrives
  twice.
- **There are two editors now, and which one a name means matters.**
  `SourceEditor` is GtkSourceView (`bta_editor.c`) and `TextEditor` is a plain
  GtkTextView (`bta_text.c`); the shared half -- `Text`, `Line`, `Column`,
  `Offset`, `LineOf`, `OffsetAt`, `Selection`, `Modified`, `ReadOnly`, `Wrap`,
  `CanUndo`/`CanRedo`, `GotoLine`, `Select`, `Insert`, `Append`, `Clear`,
  `Undo`, `Redo`, `Change`, `Cursor` -- is
  an abstract `Editor` both inherit, because a `GtkSourceView` *is* a
  `GtkTextView` and the code was already written against the base class's API.
  The IDE's code tabs are `SourceEditor`s; `PoForm`'s translation boxes are
  `TextEditor`s and used to be the source editor with `Language = ""`,
  `ShowLineNumbers = false` and `Wrap = true` -- which is what the plain one now
  is by default, and the reason it exists.
- **An offset is a character and an index is a JavaScript number, and the
  runtime has a verb for each so no caller crosses them by hand.**
  `Offset`/`OffsetAt(line, [column])` count **characters**, as `Column` and
  `Select` do -- an emoji is one, and `OffsetAt(Line, Column) === Offset`.
  `LineOf(index)` (and `Text.LineOf(text, index)`) receives the **index a search
  returned** -- the number `Regex.Index`, `indexOf` and `slice` speak, which
  counts UTF-16 units and calls that emoji two. **The conversion is a walk and
  not an identity**: on `"🙂\nx"`, index 2 is the `\n` (line 1) while character
  2 is the `x` (line 2), so handing a search's index straight to GTK's
  `get_iter_at_offset` answers the wrong line on any file with an astral
  character before a break -- silently, and correctly on every file without
  one. That is why `LineOf` reads the text and the other two do not: GTK
  answers a character directly. **The separators are GTK's, since the line goes
  to `GotoLine`**: `\n`, `\r\n` as one, a lone `\r` and U+2029 break; U+2028
  does not break a buffer although Pango breaks it, so `Text.Lines` and
  `LineOf` disagree on that one character. Eight crossings in the IDE became
  `Text.LineOf`; `Live.lineAt` was dead and went; `Live.caret` stays hand-rolled
  on purpose, because it compares against a match's `Index` and both sides are
  already JS numbers.
- **`Editor` is abstract for one reason, and it is not tidiness.** `texts`
  accumulates *down* the class chain (`class_list_of`), and there is no way for a
  child to refuse what its parent declared. A plain `TextEditor` should declare
  its `Text` as prose -- a form may put a starting note in one, and it is a
  caption like any other -- while a `SourceEditor` must never, or a `.po` file
  would rewrite somebody's source, silently and only in one language. Siblings can
  disagree about a property; a child cannot disagree with its parent. If either
  class ever needs the *other's* metadata, the answer is not to reparent them:
  it is another sibling.
- **A renamed control fails silently in a `.form`.** `applyNode` assigns what a
  file declares (`widget[key] = value`) and never asks whether the class has that
  property, so a `.form` that still says `TextEditor` where it means the source
  one loads the plain editor and its `Language`, `ShowLineNumbers` and the rest
  become ordinary JavaScript properties on the object -- no error, no
  highlighting, no gutter. Every `.form` in this tree was converted with the
  rename; a project outside it has to be, and there is nothing that will say so.
- **The two defaults the editors disagree about are `Wrap` and the font**, and
  both are deliberate: prose in a narrow box with a horizontal scrollbar is
  unreadable, and code that wraps hides its own indentation. So `Wrap` starts
  `true` on a `TextEditor` and `false` on a `SourceEditor`, and only the source
  one is monospaced. A test asserting a default has to build a **fresh** control
  for it -- `this.Ed` has been through the source editor's own tests by then, one
  of which turns wrapping on, and that is a failure that only appears in a full
  suite run.
- **`gtk_source_init()` has to be called, and nothing says so when it is not.**
  It registers GtkSourceView's GResources, and every part of the library that is a
  plain widget works without it -- view, buffer, highlighting, undo, search. Only
  what is built from a template fails, and the completion popover is the one thing
  that is: it appears once, is never dismissed, is left behind as a stray window,
  and then `gdk_popup_present: assertion 'width > 0' failed` forever. It reads as
  a bug in the completion provider and it is not one (gtksourceview#300, closed
  on exactly this). **And it goes in `on_activate`, not before
  `g_application_run`**: what it does is load CSS against the default display, so
  called before GTK is up it is a silent no-op --- `gdk_display_get_default()`
  answers `(nil)` there. `gtk_source_finalize()` runs on the way out, or the
  library's static data is what `tests/asan.sh` reports as ours.
- **GtkSourceView 5 draws the mark tooltip itself, and nothing was asking it
  to.** The renderer that owns the mark lane implements `query_tooltip`, and GTK
  calls a widget's `query_tooltip` only when *that* widget carries
  `has-tooltip` -- which GtkSourceView sets on the view alone. So the
  implementation is unreachable and a mark's message never shows, while the
  `Mark(line, kind, [text])` row, `docs/widgets.md` and the C comment beside it
  all promised the tooltip for as long as nobody hovered an icon. Measured on
  5.20.0 with a real pointer on an `Xvfb` of its own: hovering a `Warning` mark
  drew nothing, and `mark_tooltips_on` -- two lines asking every renderer of the
  left gutter for tooltips, called where `ShowMarks` creates the renderer --
  turns the same build into the message in GtkSourceView's own tooltip.
  **That is the whole check, because the effect needs a pointer**: the suite can
  only say the text is on the mark, which it already did, and did.

## Calendar, radios and pickers

- **Re-grouping a check button that is already in the target's group closes the
  chain into a ring.** `gtk_check_button_set_group` moves a button out of its
  list and into the target's, so pointing one at a group it is already in unlinks
  and relinks it inside itself. Nothing complains; the next click walks the group
  to turn the others off and walks forever, and what you see is a test with no
  output and a process that will not end. `bta_radio_regroup` unlinks **every**
  child first and only then rebuilds, which is one pass more and the only shape
  that cannot make a cycle.
- **A radio taken out of a container is still linked into the chain it left.**
  GTK4's group is a linked list, not a name, so `bta_radio_regroup` unlinks the
  child *first* and then rebuilds the slot's chain — otherwise turning that radio
  on later turns something off in a container it is no longer in, which is a bug
  found months later. Every path that adds or removes a child goes through it
  (`bta_container_attach`/`detach`), and it returns at once for anything that is
  not a `CheckButton` -- which is one class now, a tick until it is given a
  `Group` and one of a set afterwards, because GTK4 has no radio widget to
  mirror.
- **`GtkCalendar` has one date and no notion of the month on screen**, so turning
  the page *is* a change of value: two presses of the next-month arrow moved
  `Value` from `2026-03-08` to `2026-05-08`. Until this was found it raised
  nothing -- `day-selected` does not fire on a page turn, only `notify::month` --
  so a form's date silently went stale, and a `DatePicker`'s button label with it
  (it read March while `Value` answered May). `on_date_page` in `bta_controls.c`
  is all three answers together: the marks in view, the label, and `Change`. Both
  it and `on_date_selected` are blocked while `Value` is assigned, or one
  assignment that lands in another month would raise the event on the way and
  again at the end.
- **A `Calendar`'s mark is a date and GTK's is a day of the month.**
  `gtk_calendar_mark_day` takes 1-31 and marks it in whatever month is displayed,
  so marks would follow the page and land on the wrong days. What the widget keeps
  is the list of dates (sorted, normalised, `MARKS_KEY`); GTK's marks are redrawn
  from the part of it in view every time the month changes.
- **The page-turn path has no suite coverage and cannot have any**, because
  nothing in JS can turn the page: `Value` blocks the handler by design and there
  is no way to press GTK's own arrow. It was measured instead, and this is the
  command that does it again -- an `Xvfb` of its own, because `xvfb-run` owns its
  display for one command and this needs two:

  ```sh
  Xvfb :99 -screen 0 1024x768x24 & sleep 2
  DISPLAY=:99 ./build/bintana <probe-project> &            # a Calendar at 8,60
  W=$(DISPLAY=:99 xdotool search --name CalProbe | tail -1)
  DISPLAY=:99 xdotool mousemove --window $W 133 72 click 1     # the > arrow
  DISPLAY=:99 import -window $W /tmp/turned.png
  ```

  The same shape answered "is a mark drawn at all", which JS also cannot see: four
  renders compared with `tests/probe.sh diff` -- a mark in the month on screen
  changes the picture, one a month away changes **zero pixels**, and turning the
  page to that month brings it out.
- A `GtkCalendar` has no whole-date setter below GTK 4.20 (`select_day` is
  deprecated in favour of a `set_date` that raises the floor), so `DatePicker`
  sets year, month and day — day to 1 first, or standing on the 31st and moving to
  February clamps on the way through — with the handler blocked for the three so
  one assignment is one `Change`. **The three setters are 4.14, not "old"**, and
  the floor this tree declares is 4.10: `gtk_calendar_set_day`/`_month`/`_year`
  and `gtk_css_provider_load_from_string` (4.12, the appearance sheet) were the
  only four calls above the floor, and each has a `GTK_CHECK_VERSION` guard now
  falling back to `select_day` and `load_from_data`. CI runs GTK 4.14, so no run
  here could ever have said so; the check is `GDK_AVAILABLE_IN_*` in the header,
  which is the same rule the `GDK_ACTION_NONE` note above states.
  **And a signal is not a call, so that scan did not see it**:
  `GtkSpinButton::activate` is **4.14**, and on 4.10–4.13 the `g_signal_connect`
  was a critical at startup and `SpinBox`'s `Activate` an event that never
  fired -- nothing compiles differently. It is guarded now, with a key
  controller for the older GTK. A signal's `version` is in the GIR
  (`/usr/share/gir-1.0/Gtk-4.0.gir`) or the docs, and a property's is too;
  check both, not only the functions.
- **A `ComboBox` has no empty text and, with items, no empty state.**
  `cmb.Text = ""` throws `'' is not one of <name>'s items`, and `Index = -1`
  **moves nothing**: GTK's autoselect leaves the first row chosen the moment
  `Items` is assigned, and only `Clear()` leaves none. Measured -- `Items` then
  `Index = -1` still reads the first row, and a sample written to show *nothing
  chosen* came up saying *Low*. So a form whose field can be empty gives the
  combo a placeholder row (`Items = ["—", …]`) and selects that when there is
  no record; `Index = -1` is what an *empty* list reads, not a way to empty
  one.
- **That autoselect is an event, and during a `.form` load it arrives before
  the form has the `Cmb` it names.** `notify::selected` is wired straight to
  `Select` (`on_combo_selected`), so both roads the loader takes raise it --
  `Items`, whose one splice leaves the first row chosen, and `Index` -- while
  the window is still being built. The handler runs, `this` is the form under
  construction, and **the control it reaches for is not bound yet**: on
  `examples/flood`, assigning `Items` on `CmbSize` called `CmbSize_Select` →
  `newGame()` → `this.CmbSize.Index`, and the runtime printed
  `TypeError: cannot read property 'Index' of undefined` with the stack naming
  the road -- `at CmbSize_Select`, `at set Items (native)`, `at Form (native)`.
  The window still opened; the handler was the only casualty, which is exactly
  why this is written down. The handler guards on something only `Form_Open`
  can have made (`this.board` there), not on the selection looking meaningful;
  a handler installed with `On` before the `Items` it is for is the same case
  in code.
- **A `DatePicker`'s empty state is a flag of its own, and a `Calendar` refuses
  one.** `Value = ""` is *no date* -- the state GTK's calendar has not got -- so
  an **optional `Field.Date` round-trips through a picker**: the button reads
  `Placeholder` (an em dash by default), picking a day is the one gesture that
  ends the empty state, and browsing months in an empty picker does not fill it
  in. It is the field's and not the month's: a `Calendar` refuses `""` rather
  than accepting it and lying. **The limit it replaced is what put `required`
  into a shape**: `examples/clients` declared `Since` that way because the
  control could not show *no date*, which is exactly the kind of leak a declared
  binding has to decide about -- the field is optional now, and the empty date
  is what a new record shows. `docs/plans/data-plan.md` records the pair of
  widget limits that example found.

## Terminal and the output pane

- **A click in a `ReadOnly` `TextEditor` does move the insertion cursor**, so
  `Line`/`Column` say where it landed and `Selection` is `""` -- which is the
  whole of what replaced VTE's `LinkPattern`. Measured with a real pointer
  (`xdotool` on an `Xvfb` of its own, a two-file probe under the scratch
  directory), because none of it is answerable from the suite: there is no
  synthetic pointer here.
- **...and the handler is `MouseUp`, not `Cursor`.** `Cursor` fires on the click
  and looks like the obvious one -- it also fires on every arrow key, so reading
  a log with the keyboard would open a file per keystroke. Same probe, same
  sitting: a plain click gives `Cursor` (at press), `MouseDown`, then `MouseUp`
  with the cursor already there and no selection; a drag gives `Cursor` events
  with a growing `Selection` and, usually, **no `MouseUp` at all** -- GTK's own
  drag gesture claims the sequence, which is the VTE trap above seen from the
  other side. `Selection !== ""` is still the guard, because "usually" is not a
  contract.
- **`Terminal.Stop()` does not end an interactive shell, and the pty does.**
  Bash ignores SIGTERM when it is interactive, so the IDE's terminal tab still
  reads `Running === true` after `stopShell()` -- which looked like a leak
  waiting to happen. It is not: closing the pty makes the kernel hang up its
  foreground process group, which is what closing a terminal window has always
  meant, and VTE does that when the widget goes. Measured by starting a bash in
  the tab, quitting the IDE and looking for it (`ps`): nothing left behind. So
  the SIGTERM is for everything that *does* honour it, and following it with a
  `Kill()` would be the IDE sending SIGKILL to whatever build or editor somebody
  had running. A test can only assert the first half, so it drives `SHELL` at
  `/bin/cat`; the second half is a by-hand measurement and says so.

**A key an editor would take is not `KeyPress`'s, and the call that proves it
is the one a test cannot make.** `KeyPress` is a *bubbling* controller on
`w->gtk` -- right for a form's shortcuts, "whatever has the focus gets first
refusal" -- so on a `SourceEditor` the view has taken Tab, Enter, the arrows and
every printable key before it is raised: a real `a` typed into one never reached
`Editor_KeyPress` at all (measured with `xdotool` on a bare `Xvfb`, no window
manager: the focus follows the pointer). Calling `Editor_KeyPress("Tab", ...)`
from a test reached the handler either way, which is how the first version of
the snippets' Tab passed its tests and did nothing in a window. **`KeyPreview`**
(`bta_text.c`, `on_key_preview`) is the same key on a `GTK_PHASE_CAPTURE`
controller on the *view*: the controllers of one widget run in the order they
were added, capture ones first, and the completion's own is added when it is
first asked for, so this one is before it and a Tab with the popup open still
reaches the handler. `tests/widgets`' `EditorKeyPreview` runs a child under
`xdotool` and is red with the phase changed back to bubble. **A new event for a
key a control's own widget handles wants the capture phase and a test that sends
a real key.**

**An editor with a minimap is a box, and four helpers learned it.** A
`GtkSourceMap` sits beside the scroller, so a `SourceEditor`'s `w->gtk` is a
`GtkBox` holding the `GtkScrolledWindow` (and the map, built the first time
`ShowMap` is turned on -- a hidden map still follows the buffer, so an editor
that never shows one must not own one). Everything that took `w->gtk` for the
scrolled window -- `bta_scroll_watch`, the adjustments `ScrollX`/`ScrollY` read
and `on_scroller_moved` -- goes through `bta_scrolled(w)`, which finds it by the
`"bta-scrolled"` datum on the box. A new reader of an editor's scroll position
is `bta_scrolled`'s, never `GTK_SCROLLED_WINDOW(w->gtk)`. `tests/widgets`'
`EditorMap` asserts the map by what it does to the room (a wrapped text gets
taller beside it) and that the scroll survived the box.

**Folding is lines made invisible, and four things about GTK shaped it.**
GtkSourceView has no folding, so `SourceEditor` builds it from a
`GtkTextTag` with `invisible` per fold (two marks hold the range), a
`GtkSourceGutterRenderer` subclass for the `▾`/`▸` markers, and
`FoldRanges` from the program -- only whoever knows the language knows where a
block ends. *(1)* **GTK does not join two lines because the break between them
is invisible.** Each buffer line stays a paragraph; a line whose text and break
are both hidden has no height, and a line with only its break visible is an
empty row. The first version hid "from the end of the start line to the end of
the last" and left one blank row under every fold (cursor Y of lines 1..4 came
out `0,18,18,36`); a fold hides `Start + 1` to `End` **whole, breaks included**
(`from` = the start of the first hidden line, `to` = the start of the line
after, or the end of the text). *(2)* **`gtk_text_buffer_get_text(..., FALSE)`
leaves hidden text out**, so `Text` on a folded buffer was the file minus the
fold and saving it would have deleted code: `Text`, `Selection` and `LineOf`
ask for hidden text too, and `tests/widgets`' `EditorFold` is red with the
getter put back. *(3)* **`GtkSourceSearchContext` does not look in invisible
text** -- one match before a fold, none after -- so `Search` and `FindNext`
open every fold first: *nothing found* about code that is in the file is a wrong
answer given in silence. *(4)* **The line-number renderer draws a hidden line**,
at the height it has, which is none, so three numbers print over each other.
GtkSourceView offers no way to skip a line, so the first time anything is folded
the view's numbers are switched off and a renderer of ours (the same class as
the markers, `numbers` set) takes their place at the same position; `ShowLineNumbers` asks
whichever is in use. A renderer that overrides `begin` must **chain to the
parent's**, which is what creates the Pango layout the text is drawn on: without
it every line printed `Pango-CRITICAL: assertion 'PANGO_IS_LAYOUT'` and the
margin was empty. An edit that lands in a fold opens it (a typed character
inside invisible text cannot be seen), but one at the end of the line the fold
hangs from is an ordinary edit; `to` has *left* gravity so the range does not
grow over text inserted at its edge, and the one case offsets cannot decide --
text inserted exactly there -- asks whether it took the fold's tag.
`bta_editor_reveal` opens what hides a line, for `GotoLine` and `Select`. **A closed fold leaves dots after its line, because a margin marker alone does not say that code is there** (the report:
"beyond the icon it is not clear there is folded code"; Android Studio joins the brackets and shows an ellipsis between them).
GtkTextTag has no replacement text, and a `GtkTextChildAnchor` is a character in the buffer, which would change `Text`, so the dots are a `GtkLabel` added with `gtk_text_view_add_overlay`, whose coordinates are the buffer's and which therefore scrolls with the text. It sits after the last character of the line the fold hangs from (`gtk_text_view_get_iter_location` of the break), and nothing signals that layout moved a line -- a resize, a wrap, a font -- so a tick callback on the view puts each chip where it belongs, moving it only when the place changed, and hides one whose line is itself inside another fold (it would be drawn over the outer one's row). The text after the dots is the range's `Tail`, supplied by the program because only it knows what is at the other end; the chip is the `bta-fold-chip` class of `runtime/css/base.css`. The IDE's ranges end on the closer's line, so the closer is hidden with the rest and the chip says it. **An overlay cannot be taken out again:** `gtk_text_view_remove` on one answers `GtkLabel is not a child of GtkSourceView` and the label stays, so after the first click opened a fold its dots were still there, still clickable, with a mark that had been deleted -- the second click went through a dangling pointer (reported from the IDE as *it breaks on the second click*). A chip is therefore never removed: opening a fold hides it and puts it in a spare list, the next fold takes it back, and the view disposes of the rest when it goes. `EditorFoldClick` drives all three stages with a real pointer -- the marker closes, the dots open, and clicks on where the dots were change nothing -- and is red with the hide taken out. The chip's presence is verified by a screenshot -- there is no tree to ask for an overlay. The
click is verified with `xdotool` (`EditorFoldClick`), and a screenshot (a look:
it is the only way to see the gutter) is how the stacked numbers were found.

**Accessibility is applied where the focus is, and four things about GTK shaped
it** (R2 of the audit). `AccessibleName`/`AccessibleDescription` are
`gtk_accessible_update_property` and `Label.For` is `..._update_relation`, but a
screen reader reads the widget that has the *focus*, which is often inside the
outer one -- the `GtkText` in a `GtkEntry`, the toggle in a `GtkDropDown` -- so
`bta_a11y_walk` applies each to the control and to the focusable widgets up to
three levels down (a `TableView`'s cells are widgets too; not ten thousand of
them). *(1)* **`gtk_widget_get_tooltip_text` returns `const char *`**: GTK lends
it. The first version freed it, and `get_tooltip_text` answered the same dangling
address on the next call -- `free(): double free detected in tcache`, and a name
that came back as garbage first (`s=[$\xef]`). The rule in `AGENTS.md` about the
transfer annotation of every `get` was exactly this, and was read after.
*(2)* **A reference list in the variable arguments is the accessibles and a
`NULL`**, `update_relation(a, LABELLED_BY, label, NULL, -1)`, not a `GList`: a
list is taken for one object and answers `Reference of type (null) does not
implement GtkAccessible`. *(3)* **GTK has no reader for a property's value**, but
`gtk_test_accessible_check_property` returns NULL when the value is the one given
and **the value it has** when not, so asking with one nothing has reads it --
measured, with a plain probe, against the default backend and `GTK_A11Y=test`;
with `GTK_A11Y=none` there is no context and it asserts, so `AccessibleInfo()`
asks `gtk_accessible_get_at_context` first and answers nothing. That is what
makes the tests assert what a screen reader is *told* rather than that a property
was assigned (the derived names have no assignment). *(4)* **A button is always
`LabelledBy`**: GTK labels it by its own words, so only a field's answer says
anything about a caption. An icon-only button is named by its `Tooltip` up to 60
characters (`A11Y_TOOLTIP_MAX`): `bta_a11y_refresh` runs from the tooltip's
setter, the name's and `button_rebuild`, since words given later must take the
name back from a tooltip. A `.form` applies properties before the siblings
exist, so `Label.For` given a name not yet built is kept and settled by
`bta_labels_resolve` at the end of `form_build`; `tests/widgets`' `Fielded`
component declares the caption first on purpose, and is red with the resolve
taken out. **`Captioned` is a class of `forms.js`'s own** -- the first fixture
was called that and the project stopped with *redeclaration*.

**`AccessibleHidden` is GTK's own state, which GTK rewrites.** `HIDDEN` is *true*
while a widget is not mapped and *false* once it is, written by GTK **after** the
`map` signal has been emitted -- measured in a plain probe: a `connect_after`
handler set `true` and saw `false` written over it. A decorative mark therefore
survived `Visible = false; Visible = true` only after being put back **in an
idle** that holds a `GWeakRef` and nothing of ours, so a control deleted in the
meantime is simply gone. `notify::visible` happens to run after GTK's write but
is not emitted when the *parent* hides the child (leaving a page), which is the
case that matters, so it is not the hook. `has_state(HIDDEN)` is true for a widget
that is on screen too, with the value false: `AccessibleInfo().Hidden` asks for
the value (`check_state(..., FALSE)` answers non-NULL when it is not false), and
is true for a control not yet shown, which is the truth. Reading it right after
`Add` therefore says `true`: the test waits for a frame, and counts the wait
(`waiting++`), or the assertions after it are a smaller total and not a red line.
**The idle is `G_PRIORITY_HIGH`, not the default idle's 200.** Any idle is late
enough -- GTK's write happens before the signal returns -- but a default one
waits behind every redraw and timer: in the full `tests/widgets` run the mark
came back **223-294 ms** after the map (eleven 10 ms polls), so a screen reader
read the logo for a quarter of a second, and a test that waited a fixed 60 ms
failed only in the full run. At high priority it is back by the first poll
(47 ms of a busy loop, two asks), and the test waits with `until`.

**Three more things the audit after it found.** *(5)* **`gtk_accessible_get_at_context`
returns a reference** (`transfer full` since 4.10, where it became public): used
as a bare truth test it leaked one `GtkATContext` per widget visited on every
`AccessibleInfo()` -- `a11y_has_context` drops it. *(6)* **The walk stops at
another control**: `bta_a11y_walk` went into a container's children, so a
`Panel` named "Domicilio" named the button inside it "Domicilio", and a
`Tooltip` put on the panel afterwards reset the button's own name to nothing
(`testAccessible` is red with the old walk). A widget tagged with a different
`BtaWidget` is skipped with what is under it; a control's slot carries its own
tag and is still reached. *(7)* **A reset takes away only what the runtime set**
(`bta-a11y-label-ours`, `bta-a11y-desc-ours`), so a tooltip with no name to give
cannot erase a label GTK put on a widget of its own control. A probe against
GTK 4.22 found none to erase -- the spin button's two buttons, the password and
search entries, the drop-down, colour, font and menu buttons and the calendar
carry no `LABEL` property on any focusable child -- so this is cheap insurance
against an older or a later GTK, not a measured fix.
