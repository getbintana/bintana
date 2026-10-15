# The IDE

The traps and decisions of this area, each with what it cost and the rule it left. [`AGENTS.md`](../../AGENTS.md) states the rules that apply to every change; this file is the evidence behind them and the detail that only matters here.

## The IDE's own tree, and the workspace per tab

**The IDE's own tree is `forms/` and `modules/`.** A form is two files that
travel together, so `MainForm.form` and `MainForm.js` live side by side in
`ide/forms/`; the loose classes -- `Designer`, `TabSet`, `Classes` -- are in
`ide/modules/`. That is the shape the IDE now creates for any project (a new
form with nothing open goes to `forms/`), and it was applied here first because
this is the biggest project there is to try it on: the root had thirty-five
files in it.

Two things follow. A path in a document or a test is `ide/forms/MainForm.js`
now; and **a folder a tool named is not a node in the project view.** `TOOL_DIRS`
in `ide/modules/Classes.js` lists the four -- `forms`, `components`, `modules`,
`po` -- and the view reads off it: a `forms` node with a `Formularios` inside it
says one thing twice. A folder the programmer organised means something; a folder
a tool named does not.

That rule used to have a second half -- *and it is not a namespace either* --
which is gone, because **no folder's name is a namespace any more**: a namespace
is what the code declares and nothing else, so there is nothing to exempt.
`namespaceHere(folder)` answers what the classes already in a folder declare,
which is what the New form dialog offers; the first class of a namespace is told
which one. See the note above it, and [`docs/ide.md`](https://github.com/getbintana/bintana-docs/blob/main/docs/ide.md#folders-and-namespaces-which-are-not-the-same-thing).

**Every file of the IDE is a module** (see *A file with `export` is a
module*). A file in `ide/modules/` says `export class <name>`, named like the
file -- `Designer`, `TabSet`, `Classes` -- and a form says `export class
MainForm extends Form`, since a form's name is what the runtime looks it up by.
What one file uses of another is exported where it is declared and reached by
its bare name, with no `import`; everything else is the file's own. It was
`Namespace("Ide")` and `Ide.Designer` until the modules plan, and the move
found what the shared scope had been hiding: of 326 top-level names, **99 are
exported** -- the 45 classes, the 26 forms and 28 more another file uses
(`SOURCE_LINK`, `PALETTE`, `inFolder` ...) -- and the other 227 are private
now. The list was taken from fork patch 16's
free names, not from a search for words, which also offered `lines`, `snap`
and `plain` -- locals of the same spelling in other files. **A name a test
reads** (`GRID`, `PALETTE_TABS`, `completionScopeNames`) is exported for that
reason, and `tests/ide/Driver.js` stays a script. A new top-level name used
from a second file wants `export` where it is declared, and the load says so
otherwise: `ReferenceError: X is not defined`, at the use.

**The IDE is written in Bintana and has no privileged API.** When the IDE
needs something the runtime lacks, the fix is a runtime feature every
application then gets — not a special case in the IDE.

The corollary runs the other way too, and is easy to forget: before writing C,
check whether the thing is expressible as a Bintana form. `AskForm` and
`ConfirmForm` are dialogs, not runtime primitives.

**The workspace belongs to the tab, and the strip is above it.** `Workspace`
(`ide/modules/Workspace.js`) builds, once per open file, everything under the
tab strip: the palette, the control tree and the design bar on the left, the
canvas or the editor in the middle, and the property grid, the events page or
the outline on the right. It is per tab because a widget belongs to one parent
and a notebook puts its pages under its own strip, so a shared panel cannot be
under it -- it stood beside the whole notebook and the strip stopped at the
editor's edge. The cost was measured with Sysprof before the choice was made:
the whole workspace is ~7 ms with an empty palette, the palette is most of it
at ~14 ms in the IDE, against the 44-211 ms a form tab already costs to open
(the canvas, the designer and the form built for real). Four things follow:
- **A widget built in code is not published on the form.** Only the `.form`
  loader does `form[name] = control`; `Container.Add` binds it for dispatch and
  nothing else. So `ide.WidgetTree`, `ide.PropGrid` and the rest do not exist
  by construction: `TabSet.placeContent` repoints them at the active page's,
  and at `null` where the page has no such half. A new per-tab widget wants its
  line there, or no handler can reach it.
- **A palette button belongs to the page it is on.** Its `On("Click")` closes
  over its own designer, so a reference held across a tab switch adds to the tab
  it came from -- which a user cannot do and a test did, until it refetched
  after the switch.
- **A named menu item cannot be per tab.** The control tree's menu exposes its
  items on the form, and a second tree's `MnuTrRename` is a name the runtime
  refuses; the three items are commands now (`ActTrRename`, `ActTrExpand`,
  `ActTrCollapse`), the bargain `CANVAS_MENU` had already made.
- **`Session` remembers the widths, not the widgets.** The per-page splits are
  rebuilt with every tab, so `Session.divider(name, fallback)` answers with the
  live value of the page on screen and falls back to the saved one, and
  `DIVIDERS` lists `PageSplit`/`CenterSplit`/`SideSplit`/`EditSplit`.
- **The project panel folds to its own strip, and the half of the split stays
  under it.** `MainForm.foldSide` hides the content and keeps the half -- hiding
  the half whole would hand its room to the work area and GTK would hide the
  divider with it (`gtk_paned_size_allocate`, the one-child branch), taking the
  strip down too. The divider moves only *after* the content is out, because a
  `Split`'s half cannot be squeezed below what it holds: a `Position` of 30 with
  the tree up clamps to the tree's own minimum, and with the content hidden it
  lands on the strip's (~36 in Adwaita; the 30 is a request). The width to come
  back to is not the divider's while folded, so it is kept beside the fold --
  `side: { hidden, width }` in `session.window`, read and written by
  `Session.side`/`noteSide` -- and re-applied by `Form_Open` before the window
  is mapped. For that to work the half itself declares **no** `Width`: a
  declared `Width` on a split's child is a floor that survives the content
  going away (measured; see `docs/agents/layout.md`). Its content is
  `SideView`, the button that folds it `BtnSideHide` (in `SideHead`, beside the
  view chooser), and what takes its place is `SideStrip`: **one button per
  view, each opening its own** -- the single `BtnSideShow` it replaces could
  only bring back whatever was up. Those buttons are **built from the view
  list** and not declared in the .form, because how many there are is that
  list's answer and a .form is loaded once (`buildSideStrip`). The half is
  arranged **`Horizontal` with the strip first**, so the buttons sit against
  the leading edge and keep their natural width: measured, with the divider
  dragged out while folded the half goes 36 -> 120 and a button keeps its own
  width (arranged `Vertical` with the strip last it stretched across the half,
  which a drag made a six-hundred-pixel button).
- **The side bar's views are one list, and the chooser and the strip are two
  roads filled from it.** Each panel publishes its rows beside itself --
  `ProjectTree.sideEntries` for the tree's two groupings, `Changes.sideEntries`
  for the git page -- and `MainForm.sideViews` is the one place that lists them,
  so another panel is a page of `SideStack` in the .form plus a row where its
  class lives, with nothing in the window counting them. A row carries the
  chooser's `text` (the literal inside `Locale.Text`, where the extractor finds
  it), the strip button's `tip` and `icons` (the first the desktop really has
  wins and the IDE's own come last, so a button is never blank),
  the `page` of `SideStack` and the `show` that brings it up. `dressViews`
  fills `CmbView.Items` and `buildSideStrip` makes the buttons from the same
  rows; both roads end in `showSideView`, which remembers `side.view` -- a
  view's index, beside `ProjectTree`'s own `tree.view`, which is what the tree
  is built from. **A view is not a page**: the tree's two groupings share
  `TreePage`, which is why the strip has three buttons and the stack two, and
  `Changes.visible` asks the stack (`SideStack.Children[Current] ===
  ChangesSplit`) rather than a number in the chooser's list that a panel added
  before it would move. **The Changes page is a `Split`** -- the list over the
  commit box -- and not a panel with a fixed 72-pixel box under it: a message
  with a body is written in a box whose height the person chooses. Its name is
  in `Session`'s `DIVIDERS` and in `END_FIXED` (the box is the half that keeps
  its height, `COMMIT_H` when nobody has chosen), which is the same bargain
  `RightSplit` makes for the console. The swap itself is a `Switcher`'s and not a `Visible`
  per child: *one of these shows* is what a stack is, and it keeps the column's
  floor across the swap because it measures every page -- which is what a view
  change wants and the reason the fold above is a panel and not a page. A page
  behind still reports `Visible: true` and keeps the last rectangle it was
  given, so neither of those says what is on screen (measured;
  `docs/agents/widgets.md`).
- **And the canvas is what is left, which at the declared 1100 is 281.** The
  project's tree, the tab's controls column and its side panel each keep a
  floor, so the room a form is drawn in shrank by the panels this change moved
  under the strip -- and `tests/ide`'s `nested` phase, which asserts there is
  room *around* a 360 form, went red with this commit and stayed red for every
  commit after it, while the message said *suite green*. The window it ran in
  is whatever `~/.config/bintana/ide-test` last saved, so a run that inherited
  a wider one passed. The phase sizes the window it measures in now; **a test
  about the room around something sets the room**, because the settings file
  the suite shares is somebody else's state. The same inheritance put the
  `palette` phase's property grid at 188 px after a run that left the console
  higher, so `Driver.js` deletes `session.window` at load, before `Form_Open`
  can restore it: every run starts at the window `MainForm.form` declares.

`tests/ide`'s `designer` phase holds the shape -- the strip spans, the panels
begin below it, the canvas and both panels are inside the page -- and the
whole-project count in [`docs/testing.md`](../testing.md) moves with it.

## IDE traps

- **A form is asked whether it is closing, and the answer is a return value.**
  `on_close_request` in `bta_controls.c` hands back what `Form_Close` returned, so
  **true keeps the window open** -- `KeyPress`'s convention, and returning nothing
  (which is every handler written before this) lets it go. It governs `Close()`
  as much as the X, so a Cancel button, Escape and the frame's button are one
  road. What a handler must not do is close its own window again from inside
  itself; `Application.Quit`, or a `Close()` from the dialog's answer, are a
  return to the main loop away and are fine. This is what `PoForm` and the IDE's
  own quit are built on -- both used to have to choose what the *ungovernable*
  path did, and both chose differently.
- **Selecting a row must never start a process.** A tree selection moves with the
  arrow keys, so "open it when it is selected" -- which is what the IDE does for
  every file -- would spawn a translation editor once per row walked through. A
  catalogue is opened on `Activate` (double click, or Enter) instead, and the
  status bar says so, because a click that appears to do nothing is worse than
  either. That also means it is never *open*, so the tree's menu could not act on
  it the usual way: `selectedCatalogue` is what the left button pointed at, kept
  separately from the open file and released the moment anything else is chosen.
- **A right click does not move a `TreeView`'s selection.** So a context menu item
  that aims at the row it was opened over acts on a *different* row — whichever was
  selected last. The IDE's tree menu acts on the file that is **open** instead,
  which is what the File menu's Rename and Delete already did; the left button is
  what opens, so *select then ask* is the gesture. Found by right-clicking a form
  and getting a menu greyed out for the previous selection.
- - **The project tree's filter prunes after building and does not filter while
  adding.** `ProjectTree.node` is the one door every row goes through (it records
  each row's parent and label, because a `TreeView` cannot be asked who a node's
  parent is), and `prune()` removes what does not match and calls `ExpandAll`. A
  match keeps its whole subtree and the way up to it; a removed key must leave
  `byKey` **and** `labels`, or `Git.markTree` calls `SetText` on a row that is not
  there. `TxtFilter_Change` fires while the `.form` loads, before `projectTree`
  exists -- the *field initialiser does not beat the load* trap -- so it asks.
- **The control tree's filter (`TreeFind`) is per tab and its state is the
  designer's.** The box is built in `Workspace` beside `PropFind` and repointed by
  `TabSet.placeContent`; `TreeFind_Change` hands the text to `designer.tree`
  (`ControlTree.setFilter`), which keeps it, folds it into `shape()` so a changed
  filter rebuilds and an edit does not, and skips what neither matches nor holds a
  match. A match keeps its subtree.
- **The options buttons beside both filters are commands, never named items.**
  The project tree's is declared in `MainForm.form` (`BtnFtOptions`, `Menu` of
  `ActFt*` actions, popped by `BtnFtOptions_Click`); the control tree's is
  `Workspace.treeOptions`, one per tab, whose `Menu` (`TREE_OPTIONS`) is assigned in
  `bind()` because a menu needs the page to be in the window, and whose click is an
  `On` closing over its own button. A named item would be a second `MnuX` per tab.
- **`TreeView.SetTooltip(key, text)` is per node, and the project tree puts the
  path there** (`ProjectTree.tip`), left off where it would repeat the label. It is
  not translated and it costs the rows one `gtk_widget_set_tooltip_text` on bind --
  which also has to *clear* it, since rows are recycled.
- **Filters are not remembered, and Escape empties them.** `openProject` clears
  `projectTree.filter` and `TxtFilter`; `TxtFilter_KeyPress`/`TreeFind_KeyPress`
  empty the box and hand the focus to the tree. `Ctrl+Alt+F` and `Ctrl+Alt+C` focus
  the two. The control tree keeps the **selected** control on the tree whatever the
  filter says (it is part of `shape()`), and `sync()` refreshes first when a filter
  is set, or a control picked on the canvas that the box hides has no row.
- **No tab open is a state with a message, not an empty room.** `TabSet.render`
  hides the strip when `Tabs.Count` is 0 (a notebook with no page still takes
  space) and shows `EmptyBox` in its place -- declared in `MainForm.form`, visible
  by default because the welcome page is the first state and `render` has not run
  then. `tests/ide`'s *nothing in the work area is showing* assertion exempts it.
- **A side by side diff is not two files side by side.** The viewer showed the
  old version on the left and the new one on the right, scrolled together, and
  that is genuinely useless: nothing says which lines are the change, and after
  the first added line the two columns are off by one, so the locked scrolling
  lines up code with unrelated code. What makes it a diff is the padding -- a
  `Gap` row facing every added line -- and the paint. `Diff` reads git's own
  unified output for both; it never computes a diff, and the reason is worth
  keeping: the pair a viewer is handed can be four thousand lines, and an LCS of
  that is a table of sixteen million cells.
- **git names a file from the root of the repository; the IDE names it from the
  root of the project.** They are the same sentence only when the project *is*
  the repository, which is what every test and every hand-run had been. Open
  `examples/clients` -- a project inside *this* repository -- and git says
  `examples/clients/ClientsForm.js` where `openInTab`, the tree's keys and
  `File.Join(project, …)` all say `ClientsForm.js`. Nothing errors: the tree
  marks nothing because no name ever matches, and the diff's worktree pane comes
  up **empty**, because it went looking for
  `<project>/examples/clients/ClientsForm.js`. `Git` keeps git's own answer
  (`rev-parse --show-prefix`) and crosses the boundary in `strip`/`full`; and
  every listing carries `-- .`, since a repository can hold more than this
  project and the panel must not offer to stage somebody else's folder.
- **The designer's surface stands in for the form, so a form property it must
  answer to has to be copied onto it by hand.** `buildSurface` applied
  `Arrangement` and nothing else, so a form declared `Horizontal` with
  `Spacing: 12` was drawn with no gap at all -- the grid said 12, the canvas
  showed 0, and the running form was right. `Margin`, `Padding`, `Font`,
  `Radius`, the colours and the rest were in the same state. `FORM_LOOK` in
  `Designer.js` lists what the surface wears; `applyFormLook` applies it after
  the arrangement on every rebuild (a missing key goes back to a fresh
  control's value) and `setFormProperty` for a later edit. `Style` is
  deliberately not in the list: the surface's own `Style` is `background`.
  **`Margin` and `Padding` are one padding here** (`formBox`), on the surface
  *and* on Glass: the runtime puts both inside the window, a real `Margin` on
  the surface left a ring of the board's colour that made the grips look off
  the corner, and `Bounds()` is the content box, so a surface padded alone put
  every selection outline padding-pixels off its control (558 against 598 with
  40). **`Border` insets too and its width is part of `formInset()`**: a CSS
  border shrinks the content box exactly like a padding, so the surface wears
  the border, its own padding is the inset *less* the border, and Glass wears
  the whole inset as padding and no border -- the same border drawn twice with
  alpha would come out darker. Without that the outlines landed a border-width
  off and the far grips two of them (measured with a probe: content 100x100 in
  a 200 board). A sum past the 1000 a `Padding` carries per side is clamped, so
  a form the runtime accepts still opens. **The grips go on the corner that is
  drawn, not on the declared size**: contents that cannot get narrower keep the
  window bigger than asked, so `layoutFormHandles` reads the surface's
  allocation plus `formInset()` and looks again after 40 ms until it stops
  changing (nothing announces that allocation). A test that sets a form size
  drives the grid's editor, not `setFormProperty`, which does not relayout the
  chrome by itself. A new form property that changes layout wants a line in
  `FORM_LOOK`.
- **`refresh()` runs on every keystroke, so nothing in it may spawn a child.**
  The IDE's `refresh()` is called from typing, from selecting, from every tab
  switch; asking a tool a question there costs a process per event. `Git`'s
  branches were already filled in `refreshGit()` for this reason, and the
  remotes joined them: *is there anywhere to fetch from* reads `remoteNames`,
  which the last refresh worked out, and never `git remote`. The general shape:
  anything in `refresh()` must be a field somebody else filled.
- **The form's resize grips encode the selection, and a tab just opened has no
  allocation to draw them on.** Grey while a control is selected, the selection's
  blue when the form is, and no line along the form's edge: always-blue grips made
  the form read as selected beside a selected control. `Glass` has no allocation
  on the first frame of a new tab, so the grips drew nothing until something
  moved -- the layout asks again until there is one (the `Chrome.position` rule).
  The side panels' titles are `heading` labels from `Workspace.titled`; `text`
  arrives already through `Locale.Text`, since the literal has to be at the call
  site for the extractor.
- **The IDE has a sheet of its own, and it is for the class a theme cannot
  name.** `ide/app.css` is found by name beside `project.json` -- the source
  tree and the installed tree alike, `ide/` being copied whole -- and
  `tests/ide` has it symlinked beside the forms, so the suite runs the IDE
  dressed as it ships. Today it dresses one thing: the property grid's group
  headings, which wear the theme's `heading` (the type) plus the IDE's own
  `prop-group` (the band over the group), with `HAlign Fill` so the band spans
  the row. `titlebar`/`default-decoration` were the first attempt and are the
  desktop's *window* chrome -- backdrop handling and decoration metrics -- not
  a section band, which is what a class of our own is for.
- **The designer held a control at 0 on the near edges and at nothing on the far
  ones.** Every move was `Math.max(0, x)`, so with a `Padding` on the form (or a
  panel) a control could be dragged, dropped, nudged or grown past the right and
  bottom of the content box, and the running form clipped it. `keepInside` in
  `Designer.js` is the one place that knows the room (`parent.Bounds()` is the
  content box, whose origin is X=0) and all five roads go through it -- drag,
  handle resize, `dropInto`, `dropControl`, and the arrows. A room that is not
  laid out yet (0x0) is no limit, and a control bigger than the room stays at 0.
  `tests/ide`'s `palette` phase asserts the keys and a drag past the corner;
  **a new road that moves a control has to ask `keepInside` too**, or it is the
  sixth hole. The align-to-anchor moves (`Designer.js` near `anchor.X + at.x`)
  still use only `Math.max(0, ...)`: they line a control up with another, so the
  far edge is the anchor's problem.
- **The IDE's menu entry is `<id>.devel.desktop`, because `<id>.desktop` is the
  Flatpak's.** A desktop file's name is its desktop-file id and a user-level one
  wins, so installing a project from the IDE under its bare id hid the packaged
  application of the same id and the menu started the source tree. The window
  is still matched by `StartupWMClass` (the id), and an entry an older IDE left
  under the bare id is found by `X-Bintana-Project` like any other, so Update
  moves it and Uninstall removes it. `Apps.entryId` is the one place the
  name is decided -- the dialog's state line asks it too.
- **Checking the event name against `EventNames()` found a handler the IDE had
  been installing on controls that cannot raise it**, which is the whole argument
  for checking it in one sentence. `PropertyGrid.bindEditor` wired
  `Prop_<Key>_IconClick` on **every** editor in design mode, and two of the three
  shapes `makeEditor` builds there have no icon in the field to click: the
  `ITEM_OF` drop-down is a `ComboBox`, and a design *number* is a `TextBox`
  deliberately given no sample button. Under dispatch by name those were two
  properties written onto `MainForm` that nothing would ever look up -- no error,
  no warning, and no way to find them short of reading both functions together.
  `On` threw on the first one, naming the fourteen events a `ComboBox` does
  raise. **The guard is asked of the icon** (`editor instanceof TextBox &&
  editor.Icon`) and not by repeating `makeEditor`'s condition, so the two cannot
  drift.
  **And the guard was put on one branch of two.** The other wired the chooser
  by the key's *name* -- `Icon`, `Columns`, `Style` -- and `Grid.Columns` is a
  number, so it gets a spin: selecting any `Grid` threw out of `On` and left the
  grid half built. The pickers ask the icon now too, and `tests/ide`'s `forms`
  phase selects a grid. **A key's name is not its editor's shape**; ask the
  editor.
- **What the IDE kept dispatching by name is exactly what is not a widget.**
  Nineteen sites in seven files became `On`; what is left is three, all menu
  items -- `MenuBar`'s leaves and `PropertyGrid`'s sample entries -- because a
  GTK4 menu is a model and an item has no note to carry a handler on. So
  `MenuBar.clear()` still exists and is half of what it was (the `_MouseDown`
  line went with the entries, which are `Label`s), and `bar.owned` now holds menu
  item names only. `tests/ide` still drives one of those by name
  (`ide[`${leaf}_Click`]()`), which is the assertion that the named road is still
  there for the half that needs it.
  **The sample menu could not be converted and had to be fixed in place.**
  `pickSample` rewired nine `PropSample<N>_Click` on every open, each closing
  over that click's editor and key -- so the set left on the form held the editor
  and the control of whichever field was sampled last, for the life of the
  process, with no `delete` anywhere. It is wired **once** now and reads
  `this.sampleKey`. A handler that cannot live on a widget has to be given a
  target it looks up rather than one it closes over.
- **`AddNode` parents a control before it applies its properties**, so a value the
  runtime refuses throws with the subtree already half built. Anything that
  catches that -- the designer, which stands in for what it could not build --
  has to take the leftovers out first, or the stand-in's node and the controls
  that did get built are both written to the file. The IDE's own `MainForm` went
  through one save and came back with six controls duplicated.
- **...and `AddNode` builds the node *and its whole subtree* in one call, which
  makes a failure land on an ancestor.** The designer caught the throw for a
  component it cannot instantiate while the panel around it was being built, so
  the panel became the stand-in and its siblings were deleted: opening
  `examples/qr/QrForm.form` was a board with one grey `[Panel TextPage]` and
  nothing else on it, and the save was innocent (a stand-in carries its node),
  which is why it read as "the IDE cannot open this form". `buildNode` builds
  one level at a time now -- `parent.AddNode({ ...node, children: [] }, true)`
  and then recurses -- so the stand-in replaces exactly the node that failed.
  `tests/ide`'s `forms` phase has the nested case.
- **...and `Serialize` writes a stand-in as the `Component` it is drawn with.**
  `nodeOf` hands back the node a stand-in carries, and it was only asked about
  the surface's own children: for anything else it called `Serialize`, whose
  walk is the runtime's and knows nothing of `__node`. So a `Report` inside a
  scroller came back from the first *edited* save as `"type": "Component"`,
  tinted, with the drawing's `Arrangement` and `Spacing` -- and the application
  lost `Paper` and `PageCount`. The undo snapshot and an `Arrangement` change
  called `Serialize` directly, so there even a component on the form itself
  turned into a plain `Component` that the next save wrote down for good.
  `standInsBack` walks the node `Serialize` wrote beside the controls and swaps
  each stand-in's entry for its own node (a notebook's strip widgets included);
  the runtime still decides which children are written. **Anything that writes
  the surface goes through `nodeOf`, never `Serialize`.** The existing test was
  green throughout because it saved a clean tab, which writes nothing: the
  `forms` phase now edits first, and undoes, redoes and rearranges.
- **A cut and a paste is a move, and keeps the name.** The clipboard of a cut
  carries `cut: true` and the form it came from; `Designer.keptName` hands the
  name back unless a control on screen has it (the second paste of one cut is a
  copy) or the paste lands in another form whose `.js` answers for that name.
  The handlers that stayed in the `.js` are the point of keeping it, so a cut
  deletes quietly (`deleteSelected(true)`, no *orphaned handlers* line).
- **Two methods of the same name in one class: the later one wins, silently.**
  `MainForm` had two `renameSelected` four hundred lines apart -- one renaming the
  open file, one renaming the selected control -- so F2 renamed a control and the
  file rename was dead code. Every test about renaming passed, because they all
  called `renameForm` directly and never went through a menu. In a 2000-line class
  this is easy to do and impossible to see; `grep -c "^    <name>("` before adding a
  method, and drive the *menu item* in a test, not only the method under it.
- **Moving a method out of a class is only half done until the old one is gone,**
  and this is the same trap wearing a hat: `MainForm` keeps a one-line delegation
  per method that left (`formOf(f) { return this.classes.formOf(f); }`), so a
  leftover definition of the same name further down would win over the delegation
  and the helper would sit there unused. `grep -n "^    <name>(" ide/*/*.js` should
  answer exactly twice -- once in the helper, once as the delegation.
- **`Form_Close` closes by returning, so the X never reaches `quit()`.** A true
  answer keeps the window open and a falsy one lets it go -- so the path with
  *nothing to ask* closes without calling anything, and anything owed on the way
  out that is only written in `quit()` is owed on the commonest way out and never
  paid. `MainForm.leaving()` is the list both doors pass through (the terminal's
  shell, the session); put new work there and not in `quit()`. Found by reading
  the settings file after a real session and finding nothing in it -- no test
  could have failed, because the test drove `quit()`.
- **Write the thing that cannot fail first, and let the fallible follow-up
  report.** Project settings renamed the metainfo *before* writing
  `project.json`: a metainfo that would not parse threw out of the accept
  callback with the dialog already closed, losing every edit, and a refused
  field left the file renamed to an id the manifest never got. `apply()`
  answers whether it wrote, and the metainfo follows only a written one
  (`Manifest.followIdentity`), carrying `<name>` along with the id -- a renamed
  project used to leave `<name>` behind and `Package.Write` then refused.
- **An operation that renames a file the IDE may have open renames the tab
  too.** `Metainfo.rename` deleted the old file while its tab kept the old
  path, and saving the tab wrote it back beside the new one, old id and all --
  two metainfo files, and `Metainfo.find` free to pick the stale one. `FormFiles`
  already did `renameTab` + `reloadFromDisk`; `Manifest.metainfoMoved` is the
  same pair. A rename onto a file that exists is refused, and only a stock
  `<icon>` is rewritten -- a `remote` or `local` one is the author's.
- **`--` is not literal: git still globs what follows it.** Discarding
  `data[1].json` also restored `data1.json`, silently and with no undo.
  `Git` passes `--literal-pathspecs` on every call; a new git call built
  outside `run`/`remote` has to carry it too. An untracked folder is one
  porcelain row (`?? d/`) and `File.Delete` takes only an empty directory, so
  discarding one threw halfway -- it goes to the trash now, like every other
  delete the IDE makes. **And the panel reads `status -uall`**, so a folder git
  has never seen arrives as the files inside it: a row nobody can tick, open or
  ignore is not a row. The folder-shaped discard path stayed -- a path that
  names one can still be handed in, and the panel is not the only caller.
- **An ignore entry is a pattern and the path is not.** *Add to .gitignore*
  writes the path into **the project's own** `.gitignore` (made when there is
  none) as `/` plus the name: anchored, so a root file does not also ignore
  every file of that name below it; with `\ * ? [ ]` escaped, so
  `data[1].json` does not take `data1.json` with it -- the pathspec lesson one
  file over; and inside the project, so a repository holding several never has
  a file beside it edited. The suite asserts the effect and not the line: the
  ignored file leaves the list, its neighbour with the glob-ish name stays, and
  asking twice writes one entry.
- **`restore --staged` needs a `HEAD`, and a repository with no commit has
  none.** Taking a file out of the index on a fresh repository answered
  `fatal: could not resolve 'HEAD'` -- measured, in the first repository the
  Changes panel was used on, where the tick flipped back and a line landed in
  the log. `Git.unstage` asks first (`rev-parse --verify -q HEAD`) and uses
  `git rm --cached -f -r --` there: `-r` for a record naming a whole new folder,
  `-f` for a file edited after the `add` (git refuses that one otherwise), and
  `--cached` so the worktree file stays. Any other verb that restores *from
  HEAD* has the same hole, and `git diff --cached` does not: it compares
  against the empty tree and works.
- **`File.Load` cannot say a file was not UTF-8; it answers U+FFFD.** An IDE
  that saved what it read destroyed every Latin-1 accent. The test is
  `Bytes.ToText()` throwing, not a search for U+FFFD (a file may hold one). A tab
  with `state.foreign` is read-only and every writing road refuses it -- save,
  save all, `rewriteSource`, recovery -- so a new road that writes a tab asks
  `state.foreign` first.
- **A handler is `<name>_<one event>`, never `<name>_\w+`.** `\w` takes `_`,
  so renaming `Btn` moved `Btn_Ok`'s `Btn_Ok_Click`, and `Btn` read as taken
  because of it; renaming also clears undo, so it could not be taken back.
  `handlersIn`/`renameHandlers` take `designer.eventsOf(control)`.
- **A design tab behind another has a live designer, and it is what saves.**
  Setting `state.root` alone was invisible: `loadActiveState` loads nothing by
  design, so after a rename or a retype, saving that tab wrote the old `.form`
  back beside the new one. Go through `TabSet.setRoot`, which marks the tab
  `stale` so it reloads when shown -- and never load a background designer
  directly, since it would drive the shared side panel.
- **The suite's temp directory may have no trash, and the old delete hid it.**
  `File.Trash` fails where it has none, so every *Delete from project* in
  `tests/ide` fell through to a permanent `File.Delete` without a word -- the
  very thing the comment above `deleteFiles` said it never did. It asks now
  (*Delete permanently*), and a test that deletes goes through
  `deleteAnswering()`. Whether a trash exists is the machine's, so a test of the
  no-trash road fakes `File.Trash` rather than relying on it.
- **An unanswered recovery offer outlives its dialog.** Closing it with the X
  means *later*: the tick used to find nothing dirty and forget the snapshot
  while the dialog was still asking. The tick and every door out keep it now,
  and it rides along in every snapshot of that project until Recover or
  Discard -- so a phase that opens a project with a pending snapshot leaves the
  offer held for the phases after it, and one that asserts exact snapshot
  contents calls `ide.recovery.drop()` first.
- **`-z` rename records carry two paths in either column.** Consume the old
  name and still read both letters: filing `R?` as staged-only hid the edit in
  an `RM`, which could then be neither staged nor discarded. And **push asks
  where** when the branch follows nothing and there are several remotes --
  `--set-upstream origin` was a guess that failed on a repository whose only
  remote had another name.
- **A `force` flag on a close is a decision nobody asked about, and five
  roads were taking it.** `closeByName(name, true)` skips the dirty question,
  which is right *after* a question -- and Close all, Close others and
  `openProject` called it with none, so opening a recent project dropped
  unsaved work in this one without a word. The same afternoon found the other
  shape of the same loss: writing a handler, renaming a control and renaming a
  form all rewrote the `.js` **on disk** and then `reloadFromDisk`'d (or
  ignored) the open tab, so text typed there and not saved was replaced, or a
  stale tab saved `class Form1` back over the rename. The rules now:
  **several tabs going is one question** (`TabSet.whenSettled`, which
  `closeMany` and `MainForm.leaveProject` ask); **every door out of a project
  asks before anything moves** (`leaveProject` on Open, Recent, New and Clone
  -- inside `openProject` is too late, since a new project has moved `project`
  to write its first form); and **a change the IDE makes to source goes to both
  copies** (`TabSet.rewriteSource`: the file, and the open editor with its dirty
  state kept) or, for a new handler, into the live editor as one insertion that
  undo takes back. `reloadFromDisk` on a tab is only for a tab known clean.
  `tests/ide`'s `unsaved` phase drives each road; against the old code ten of
  its assertions fail before a missing dialog stops the phase.
  **And the recovery snapshot is an answer too**: it went only in `quit()`, so
  saving and closing with the X within thirty seconds left it behind to offer
  older text back. `leaving()` forgets it when nothing is dirty, and
  `leaveProject` forgets it once the question is settled.
- **A `design` key that is not a property makes `AddNode` throw, and the control
  silently becomes a stand-in.** The designing branch applies the block *over*
  `properties`, so `"design": { "Item": "Chip" }` on a `RowList` does not do
  nothing -- it raises, `Designer.buildNode` catches it, and a real control turns
  into a grey `[RowList]` box. That is why what a list draws is the node's own
  `item` key beside `design` and not inside it. It is also the good case: a typo
  in a design block cannot be a value that quietly never applies.
- **An uncaught error is shown in a window of Bintana's own, and C only asks
  for it.** `showError(message, stack)` at the end of `forms.js` is built out of
  the controls an application uses -- a generic title, a header with the
  message, the backtrace apart in a monospace `TextEditor`, **Copy** (which
  copies the message and the stack and says *Copied*) beside **Close**, which is
  also Escape -- and `show_error_window` in `bta_runtime.c` calls it by name.
  Two things hold it together. **It is one at a time in JavaScript**
  (`errorWindowOpen`, put down by the form's `Close`), because `reporting_error`
  in C is down again the moment the call returns; a handler that throws on a
  timer would stack a window per tick without it. And **the `GtkAlertDialog` is
  still there as the fallback**, with the same two buttons: the error that stops
  a program before `forms.js` has run (`bta_report_fatal`) has nothing else to
  be shown in, and one thrown by `showError` itself is consumed and answered by
  the alert rather than becoming a second error. The words are not translated: a
  prose position the runtime owns has no catalogue. It is a lower-case function,
  so it is not part of the surface -- do not make it a class a project could
  declare over. **`forms.js` is baked into the binary**, so changing it needs a
  rebuild, and a stale `build/` can hide that: if the repo moves,
  `build/CMakeCache.txt` names the old directory and CMake refuses it
  (*different than the directory ... where CMakeCache.txt was created*), so
  `cmake --build build` fails with a `CMake Error` -- and a command that filters
  its output to `error|warning` can read that as "built" and test the old
  binary. Delete `build/CMakeCache.txt` and `build/CMakeFiles` and configure
  again. A dialog with
  no buttons set said `Cerrar`, GTK's own, which is how an old binary shows
  itself in a capture.
- **The IDE copies its dirty tabs aside every thirty seconds, and never writes
  to the project to do it.** `Recovery.js`, into
  `Application.ConfigDirectory/recovery/<digest of the project path>.json`. An
  autosave that saved in place would take away what closing without saving is
  for, so this one cannot: the only thing it can cost is a stale file in the
  config directory. It is read once, when a project opens, and `quit()` deletes
  it on every ordinary way out -- *quit without saving* is an answer, and a
  snapshot that outlived it would offer to undo a decision. `TabSet.contentOf`
  reads the **live** editor or surface rather than `state`, because the active
  tab is the one whose saved state is stalest and the one a crash takes. How
  often is `Settings`' `recovery.seconds` (File > Autosave...), `0` for off, and
  turning it off keeps whatever snapshot exists: it may be the only copy of that
  work.
- **A feature whose cost is measured on the road it opens is not a line, and the
  measurement is the feature.** Tab drag-to-reorder is the case: GTK 4 spells it
  *per page*, so it is asked for every page as it arrives, and there are two
  roads in (`bta_notebook_page_added` for the loader/`Add`/the designer, and
  `notebook_append` which bypasses both) -- and then the notebook can change its
  own order, which means every list kept beside it is a cache, and
  `TabSet.tabOrder` is one. It was built, the docs written, `Reordered`
  published, `tabs reordered` asserted -- and with the feature in, moving between
  a form tab and a code tab left **the page on screen and the tab the names
  speak for as two different answers**: the side panel stuck on the form's, a
  click on a control selecting nothing, and (before the handlers learned to ask)
  a `TypeError` on every mouse motion over the canvas. **None of that was
  reproducible from a fresh session** -- twelve driven tab switches, strip
  clicks, closes of either tab, a sweep of every file-tree row, each compared
  pixel-for-pixel against a healthy reference -- and it still followed a user
  around, so it was reverted rather than explained.
  **The cause was found later, parked in `ide/tab-reorder` as a red assertion
  that had been asking the wrong question.** `TabSet.nameOfPage` walked its
  `openTabs` `Map` with `for...in`, and `for...in` visits the properties of the
  object, of which a `Map` has none -- so it named **no page at all**, and the
  list was rebuilt empty on the first reorder. From then on `Tabs_Switch` (which
  had been changed to read the page through that function) found no name, so a
  tab click moved the notebook and nothing else: the panel stayed on the tab the
  names spoke for while the strip showed another, which is the reported symptom
  exactly. The parked test asked *why the moved page cannot be named*; the answer
  was *not one page -- every page*, and one word (`of` for `in`) turns the whole
  phase green. It is rebuilt with the notebook as the truth: `Tabs_Switch` reads
  `tabs.nameAt(index)` from `Children`, and `reordered()` rebuilds the list from
  the same walk; `tests/ide`'s designer phase asserts both halves across a
  `Reorder`, and `tests/widgets`' notebook test asserts the event itself.
  **The drag gesture itself has no test, because it is a pointer gesture** -- and
  under Xvfb a synthetic press-and-move did not reach GTK's drag path at all. The
  check by hand is GTK's *other* real road, which refuses unless the page **is**
  reorderable: focus a tab and press `Alt+Left`, and `Reordered` arrives with the
  new index (measured on a probe: `[A,B,C]` became `[B,A,C]`, `index=0`). The
  enabling line itself was measured through the CSS class the setter adds
  (`reorderable-page` on every page of a notebook with three).
  Three things, and they are the ones to remember: **a second copy of an answer
  is where the bugs live** (`tabOrder` beside the notebook's own order is exactly
  that, and the drag is what makes them disagree), **an un-reproducible symptom
  following a user is still the feature's**, and **a function that silently
  answers "no" is what turns a loud crash into a wrong panel** -- `for...in` over
  a `Map` is the quietest kind, and it is why the reverted state was a panel
  disagreeing with the screen rather than an error anybody could read. The two
  halves that were always *proved* stayed: the five canvas handlers ask whether
  there is a designer before dereferencing it (`tests/ide` goes red without them,
  and reproduces the reported `TypeError` by name), and
  `TabSet.placeContent` brings the canvas names down with the designer
  instead of leaving them naming the last form.
- **The palette's completeness is asserted, not maintained.** `PALETTE_TABS` in
  `ide/modules/Palette.js` was six types short -- `TreeView`, `SourceEditor`,
  `Terminal`, `RowList`, `Overlay`, `Flow` -- so the IDE was drawn with controls
  its user could not place, and nothing said so *because the icons were already
  there*: `PALETTE_ICON` is shared with the control tree, which needs an icon for
  whatever a form holds. `tests/ide`'s palette phase now asks `Widget.Types()` and
  fails on anything not offered (`Form` and `Component` excepted), so a widget
  added to the runtime lands in that assertion until it has a tab and an icon.
- **Two palette buttons must not be the same picture, and every other assertion
  passes while they are.** Each button had *an* icon and the icon existed, yet
  `ListBox` and `Separator` both drew `view-list-symbolic` and `Panel`, `Grid` and
  `TableView` all drew `view-grid-symbolic` -- a fallback chain reaching the same
  theme name from two entries is all it takes. There is an assertion for it now,
  and it can only see the theme the suite runs under (Adwaita, under Xvfb); the
  developer's own desktop is answered off the disk the way `tests/icons.sh` does
  it, and what it answered lives in the comments beside the names.
- **A name freed by deleting a control is not free: the code still answers for
  it.** Deleting leaves the handlers in the `.js` on purpose, and `uniqueName`
  counted up over the live controls only -- so `Button1` deleted and a button
  drawn came back as `Button1` and inherited `Button1_Click` without a word. Both
  halves are defensible alone and are a silent capture together, which is the
  shape to look for: ask what *else* holds the name before handing it out. The
  check is the file and not a counter, because a counter forgets overnight and
  the file does not.
- **A completion handler is asked about the word, and `before` stops where the
  word starts.** Both halves were guessed wrong the first time. `_` is a word
  character, so a handler being written arrives *as the word* (`Ok_`, then
  `Ok_Cl`) with `before` holding only the indentation -- code that looked for
  `Ok_` to the left of the word answered for exactly one keystroke and then
  stopped. And after a dot the word is what has been typed since (`Te`), so a
  handler keying off `before` alone keeps working while one keys off the cursor
  position does not. Measured through `ShowCompletion` and pinned in
  `tests/widgets`; do not invent these arguments in a test, which is how the
  broken case passed one.
- **The selection chrome is drawn from an allocation, so selecting something
  just created draws nothing.** The outline reads `Bounds()`; the status bar and
  the property grid read the selection itself -- so a control that GTK has not
  laid out yet is *named* as selected and not *shown* as selected, which reads
  as the selection having failed. `Chrome.position()` used to re-draw once after
  30 ms, which is the counting-frames mistake wearing a hat: it happened to be
  enough for the palette, whose click is followed by a layout pass, and was not
  for a paste, whose control arrives in a clipboard callback. It asks again
  until the selection has a size now, bounded, because a control genuinely can
  be 0x0 -- a page nobody is looking at has no allocation and never will while
  it is hidden.
- **`git status --porcelain=v1 -z` spells a rename `R  new\0old\0`**, and the
  IDE read it the other way round: the new file was marked `[D]` and the old
  one was the row offered to open, so a renamed file could not be clicked and
  the tree marked the wrong half. Measured with a real `git mv`; `filesIn`
  (`show --name-status -z`, `R100\0old\0new\0`) was already right -- the two
  commands order the pair differently, which is why the wrong one survived.
- **A project-local `lib/` is the project's files, and not a library, unless
  `uses` names it.** `Classes.rescan` walks the whole project directory into
  `files`, and the six-place search only turns a directory into a library when
  the manifest says so -- so a scan that means *the project's own code* has to
  ask `Classes.inLibrary(file)` itself, which is what `Refactor` does and
  what the tree already did to file a component under its library tab.
  Measured with `tests/ide`'s own fixture: `lib/gadgets/Dial.js` was scanned,
  and its `turn` made a rename of a project method refuse for a class the
  project had never heard of. The same asymmetry runs the other way -- a
  library *is* declared and must not be written, so `Refactor` reads its
  classes to refuse a collision and never rewrites one.
- **The IDE's output pane was a `Terminal` for nothing, and the audit is the
  lesson rather than the fix.** Consumer by consumer, everything that used it
  wanted `Run`, `Clear`, `Text`, `Stop` and `Exit` -- and *nothing* used stdin,
  typing, ANSI colour, `Kill`, `ScrollbackLines` or `less`. The one thing VTE
  uniquely gives, an interactive terminal, had no caller. It is `Exec` plus a
  read-only `TextEditor` now, which is what `examples/usage` already documented,
  and the dependency stopped being required in the same change. Before keeping a
  heavy widget because of what it *can* do, list what the callers actually call.
- **A `.record` is a document, so it gets a category and a dialog and no tab.**
  The tree already had the shape for a file the IDE shows but does not open as
  text -- a catalogue goes to a translation editor, an image to a viewer -- and
  a record's shape is the third: `EDITABLE.record = false` is what keeps it out
  of a tab (the table says how a file *opens*, not whether it is the project's,
  which is every file `scan` finds), the category says what kind of thing it
  is, and the double click hands it to `RecordForm` through
  `MainForm.editRecord`. The
  dialog edits the *document* and not a control's property, so it reads and
  writes the file whole -- and **the options it does not show are kept**: each
  row brings its spec and an edit touches only the keys its controls own, which
  is what lets an option the IDE has never heard of (`attribute` today, whatever
  tomorrow) survive an OK. The fields are checked through `Field.Spec`, the road
  the runtime's own loader takes, so a misspelt option is refused with the
  sentence the project would have read at load rather than by a second copy of
  the rules that would drift -- the column dialog's lesson, one document over.
- **The tree shows every file of the directory, and `TabSet`'s table says how
  one *opens* -- not whether it is the project's.** It used to be the second
  thing: `Classes.scan` listed an extension the table did not name *not at
  all*, so the audio or the data an application ships was invisible in the
  project view (a `.wav`, a `.gpx`, a `.tar`) -- a file of the project the
  person who put it there cannot see. A kind with a road of its own still gets
  the same four things: an `EDITABLE` entry (its language, or `false` for
  never-a-tab), a category, an icon, and the double click said for it
  (`RecordForm` for a shape, `ImageForm` for a picture, `openOutside` for a
  sound). What no category claims lands under `Other`, with the desktop's own
  answer for the click (`opensAsText`: text opens in a tab, anything else goes
  out). One list (`SOUND_EXTS`) is read by the table and by the tree, so
  never-a-tab and grouped cannot drift. Held by `tests/ide`: `sounds` for the
  category, and `views` for the unknown-kind half and for what the two views
  now differ about -- grouping, not membership.
- **A window's panels are shown and hidden from the View menu, and the items
  are views over the widgets rather than a second copy of them.**
  `MnuViewProjectPanel` folds and unfolds the side panel through the same
  `foldSide`/`unfoldSide` its own button and its strip use; `MnuViewOutput` is
  the console's `Visible` and `MnuViewToolbar` the toolbar's; and
  `dressViewMenu` brings the items to what the window is doing after any
  road moves one of them -- which is why *Show problems* and a project check
  end in `showConsole` and not in an assignment: the panel has three roads up
  and one place that dresses them. What is away is furniture of the window like
  the fold, so it rides in `session.window.view` (`Session.view`) and is applied
  in `Form_Open` before the window is mapped.
  **The console's height is not kept anywhere, and that was measured rather
  than assumed**: hiding a half is one widget's `Visible`, and GTK's paned hands
  the room to the half that is left and hides the handle
  (`gtk_paned_size_allocate`, the branch where only one child is visible)
  without touching `start_child_size` or `last_allocation` -- and `RightSplit`
  grows by its `Start` half, so `gtk_paned_compute_position` gives the console
  back the height it had when it comes up again (asserted to the pixel by
  `tests/ide`'s `session`).
  **And a half that is put away cannot say how much room it is worth**, which
  is why `Session.saveWindow` skips a split whose last child is not `Visible`:
  `Position` still holds where the divider was, so `size - Position` grows with
  the window while the half does not, and the last `ends` the file holds stands
  instead. The same phase resizes the window with the console away and asserts
  that number did not move.
  **The panels' own choices are two dynamic radios, and their entries are the
  lists' answers**: *Side panel* is filled from `sideViews()` and *Bottom panel*
  from the notebook's own `Tabs`, so a page built in code is a row with nothing
  here counting pages, and the side bar's three views stay one list with three
  roads into it (the chooser, the strip and this). They are assigned **once**,
  in `Form_Open` after `buildTerminal`, and never again -- assigning `Items` is
  what rebuilds a submenu, and the Problems tab's label is a `Label` that
  `Problems.say` mutates, so a menu that re-read it would say `2 problems`
  there. The mark is the widget's own answer (`CmbView.Index`,
  `ConsoleBox.Current`) and choosing an entry is the same `openSide`/
  `showConsole` the other roads take.
  **The editor's line numbers, wrap and syntax theme are the reader's and not a
  tab's**: one value each, written by the menu, read by `dressEditor` when
  `TabSet` makes an editor, and applied to every open tab at once
  (`TabSet.eachEditor`) so switching tabs cannot undress one. The theme entries
  are `Widget.PropertyOptions("SourceEditor", "Theme")` -- ids and not prose,
  because a catalogue that translated `cobalt` would be translating a keyword,
  which is the column editor's combo one menu over -- and with nothing chosen
  the mark falls back to what the editor on screen reports, the runtime's own
  default being a theme too.
  **The three *Focus ...* commands bring the thing into view first**: the tree
  unfolds its panel on its own page (*Files* when the panel was left on that
  grouping, *Project* otherwise -- *Changes* is a page of the same panel and is
  not this tree, whatever shape its own list has), the console is shown, and
  the focus inside it is the page's own choice -- the stack for the debug page
  rather than its first button, which is what a notebook cannot say.
  **Full screen is a command and not a tick**, and the reason is a state the
  desktop owns: `FullScreen` reads back what the window manager did, and a
  mapped window on a display with no manager at all (the suite's `Xvfb`) does
  not change at all -- measured, and set while the window is *not* mapped it
  does read back, and cannot be taken back while it is. A tick a desktop can
  overrule is a tick that would lie, so the item moves what the window says it
  is now; `tests/ide` presses it for the throw it would be and asserts nothing
  about the state, the way `Maximized` is left alone. `Ctrl+B`, `Ctrl+J` and
  `F11` are the keys, and the toggles, both submenus, the editor settings and
  the focus commands are all driven in that phase, each through the roads it
  has.

## The designer's pages: the page shown is a design value

A `Notebook` or `Switcher` on the canvas shows one page, and reaching another
used to be editing `Current` in the grid. **`Current` is the page the
application opens on, and the page the designer shows is `design.Current`**,
written with `SetDesign`, so looking at a page is never an edit. Two things
were rejected on the way and should not come back: saving the page looked at
as `Current` (Delphi's `ActivePage`: the program then opens wherever the
designer was left), and letting the press through the Glass to the real strip
(it would make the drawn controls live). What bit, in the order it was found:
- **A drawn control ran the IDE's handlers.** Every control on the canvas is
  bound to `MainForm`, so a drawn `Notebook` named `Tabs` that changed page ran
  the IDE's `Tabs_Switch` and moved the IDE to another file -- and the IDE's own
  `MainForm.form`, opened in itself, is full of those names. `Container.Designing`
  on the surface closes the **named road only** for everything inside it
  (`bta_widget_drawn`, a walk up GTK's parents asked only once a named handler
  was found, so it costs nothing on the 3849 dispatches out of 3850 that find
  none). `On` stays open because the designer listens to drawn controls with it
  (`Chrome`'s `Allocated`), and the three doors that refuse a handler pair skip
  a drawn control, since its named handler can never run. Removing the line in
  `Designer` is an uncaught error in `tests/ide`'s `pages` phase.
- **A declared `Current` was lost, and `MainForm.form` carried the proof.** The
  loader applies properties before children, so the index reached a container
  with no pages; both classes now keep it and apply it when that page arrives,
  from **every** road -- the slot's `*_page_added`, `Notebook.Append`, which
  reaches GTK without it, and a *named* `Switcher.Append`, which skipped it.
  The day it started working, `tests/ide`'s welcome assertion went red: the IDE
  window declared `Pages.Current: 1`, written by the designer when somebody saved
  `MainForm.form` while looking at the workspace page -- Delphi's `ActivePage`
  problem, in this tree -- and it had been harmless only because it was lost.
  The runner passes the IDE an argument, so `Form_Open` takes the `openProject`
  branch and never assigns the welcome page. **A `.form`'s `Current` means
  something now**: the audit found no other one above 0.
- **`showPage` is the only road that changes a drawn container's page.** The
  serialiser believes `__declared.Current` only while the page shown is the one
  it applied, so a `Current` assigned behind its back is written down as the
  initial page. The initial page is followed **by the page widget**
  (`Designer.initialPages`), not by index, and `nodeOf` re-writes the notes just
  before every serialisation (`settlePages`) -- a reorder or a delete moves the
  indices under them. `buildNode` holds `design.Current` back until the pages
  exist, or `SetDesign` takes the empty container's `-1` for the declaration.
- **`PageAt` and the two structures it reads.** A notebook's tab is the label
  *and the padding around it*: the label's parent is the tab widget, and asking
  only for the label missed most presses. **A `GtkStackSwitcher` drops the
  button of a hidden page instead of hiding it** (measured on 4.22), so the k-th
  shown button is the k-th shown page, and counting buttons made the third page
  answer as the second. The designer converts with `Bounds(this.surface)`, not
  `LocalPoint`: `LocalPoint` answers in the slot, and a `Switcher`'s slot is the
  stack under the strip, so a press on a top strip came out negative.
- **A page is an object, and three of the gestures already existed.** A new page
  container arrives with two `Panel` pages (`seedPages`, in `newControl`, so the
  palette and a drop both get them), and with one selected the palette's click
  goes to the page on screen (`intoShownPage`); *Add page* passes the container
  to `addControl` explicitly, which is the one road where a new control is meant
  to be a page. The *Tab* row is **not a property**: `TAB_KEY` in
  `PropertyGrid` is a row the grid adds for a page and writes to its container's
  `Tabs[index]`, so the file says what it always said. Moving a page needed
  nothing -- the arrow keys reorder a child of any container with an order -- and
  deleting one is `Delete`, which is why the four page commands the plan listed
  became one (`ActAddPage`).
- **A `Split` gets the same seed, for a reason of GTK's.** With no `Position`
  set a paned puts its divider where the first child's natural size ends, and
  an empty half has none -- so an empty split had its handle against the edge,
  invisible. `seedHalves` adds two `Panel`s and writes `Position` as half the
  palette's size along the split's axis.
- **A test that holds a control across an undo holds a corpse.** `restore`
  rebuilds the surface, so `book` from before the undo is a notebook no longer
  on it: `book.Tabs` answered the old tabs and `book.Count` the old count while
  every edit went to the new one. Look it up by name after anything that
  restores.
- **Nothing about pages is drawn over the canvas.** The first version had a
  page bar (`‹ 2 / 3 Datos › +`) under the page container around the
  selection, and it covered the form: it showed while *any* control inside a
  page was selected, and a container reaching the canvas's bottom edge had no
  room under it, so the bar went inside, over its contents. Previous, next and
  *Add page* are commands now (`ActPrevPage`, `ActNextPage`, `ActAddPage`) in
  the design bar under the control tree, enabled from `Designer.refresh` like
  the rest of it.
- **A tab is clicked on the release, and a press that moves grabs the
  container.** The first version ended the press at the page, which left a
  `Switcher` with nowhere to be dragged from: its buttons span the whole strip
  and its body is the page, so every point of it answered something other than
  the switcher. `tabPress` turns into a move of the container after `TAB_DRAG`
  pixels and the page does not change; one released in place is the click,
  and only then is the page shown and selected. A `Notebook` happened to work
  only through the empty strip beside its tabs. `tests/ide`'s `pages` phase drags `Steps` from its first button.
- **A strip that scrolls hides a tab.** `testPageAt`'s side-strip case failed
  with a `SetAction` button in a 160-pixel notebook: three tabs and the button
  do not fit, and the strip scrolls. The test sweeps a band of parallel lines
  and keeps the one that met the most, since nothing hands out a tab's
  rectangle.
- **The canvas's pick is GTK's, and GTK picks by the border box.** A `Separator`
  with room is a rule *inside* its declared size -- the room is a CSS margin --
  and `gtk_widget_real_contains` tests the border box, so a click on the space
  around a rule came back as the bar the separator is in: a separator with room
  could not be selected on the canvas at all. `Designer.hitTest` asks its own
  `roomAt` after GTK's answer -- the innermost control whose `Bounds()`
  contains the point, hidden ones skipped -- which finds exactly the controls
  whose rectangle is bigger than what they draw, and nothing else: an ordinary
  control's `Bounds()` *is* its border box, so GTK would have returned it.
  `tests/ide`'s `designer` phase clicks two pixels into the room and asserts
  the selection.

## Action: a command in several places

- **The measurement in `widgets.md` understated the case, and finding out how is
  the whole argument for the feature.** It said nine commands in the IDE were
  reachable from both a menu and a button. What it did not say is that their
  availability was computed in **two files with two different expressions**:
  `Designer.refresh` set the buttons and the context menus from
  `selection.length > 0`, and `MainForm.refresh` set the menu bar's items from
  `design && designer.selected !== null`. Whether those agreed was not a
  question anybody could answer by reading either one. It is three assignments in
  one place now, and the second place cannot come back because a bound control
  **refuses** an `Enabled` of its own.
- **`Action` is applied last by the loader, and that is not tidiness.** A command
  lends its label and its icon to a control that declared neither, so binding
  before the control's own `Icon` had been set gave a 34-pixel flat toolbar
  button the command's *words* as well -- and it grew until it pushed the tab
  strip under half the window. Caught by the IDE's own layout assertion
  (`the tabs still span the width`) the first time three of its buttons were
  converted, because **the serialiser writes properties sorted and `Action` sorts
  before `Icon`**. `apply_properties` does two passes for it, the mirror of
  `Arrangement` going first.
- **An icon suppresses the lent label.** The rule that falls out of the above: a
  control that declared an icon is an icon control and takes no words; one that
  declared neither gets both, which is what a menu-shaped button wants.
- **A bound control writes back neither the lent label nor an `Enabled`.** The
  label uses the loader's own `__declared` note -- declared nothing, applied the
  command's -- so the command stays the one place it lives, and a program that
  assigns its own afterwards makes the note stale and wins. `Enabled` is skipped
  outright in `collectProperties`, because it used to be written: saving a form
  while a command was disabled put `"Enabled": false` on every control naming it
  and **the file would not load again**, since the loader is refused the same
  assignment. Found by serialising the first form that had a command.
- **A menu item that points at a command resolves it in the *form's* group, not
  the menu's.** A popover has its own group under a different prefix for its own
  items, so an `{ "action": … }` there had to be spelled `form.` and looked up on
  the form -- otherwise a context menu naming a command would silently get a
  second, empty one. GTK resolves it by walking up from wherever the popover is
  parented.
  **An item that points at a command refuses an `enabled` of its own**, and that
  is the same rule as the pair above: the command is the object, so an `enabled`
  there is a value nothing reads -- and it would look exactly like the one that
  greys every place the command appears. A plain item's spec *does* take
  `enabled` (the key `actions` already had), which is what lets a menu built for
  the moment say *not now* without leaving the entry out.
- **A command raises `Execute`, and a menu item still raises `Click`.** It was
  `Click` for both, because `on_menu_activate` and `on_action_activate` were
  written as one event -- and a command is not clicked: it runs from a button,
  a menu item, an accelerator or code. `Execute` and not `Activate`, because
  `Activate` here already means *Enter or a double click on a row* (`ListBox`,
  `TreeView`, `TextBox`), and it is Delphi's own pair: `TMenuItem.OnClick`
  beside `TAction.OnExecute`. The method that runs one from code is
  `Execute()`. **A form still carrying a command's old `<Name>_Click` is
  refused at load** (`bta_actions_build`), naming the method -- a handler under
  a name the dispatch never asks for is silent, and the rename crossed
  fifty-one handlers in four repositories. And **`tests/api` could not see an
  event a type raises**: the manifest's `Types` carried no events, so the
  command's `Click` passed only because `Button` raises one too, and `Execute`
  was the first name to fail. `API_TYPE_EVENTS` in `tools/apijson` gives
  `Action` and `MenuItem` theirs -- two entries, because nothing can be asked
  for the events of an object a form makes per item -- and the check counts
  them.
- **And the IDE lost six names it only had for want of somewhere to put a
  command.** `MnuCvDel`, `MnuTrDel`, `MnuCvRaise`, `MnuTrRaise`, `MnuCvLower`,
  `MnuTrLower` existed because "a menu item is exposed on the form by name, and
  two widgets cannot both own `MnuDel`" -- its own comment. An item that points
  at an action owns nothing, so it needs no name. Two handlers that delegated to
  a *button's* handler are gone with them, which was the clearest smell there
  was: there had been nowhere to put the command, so one of the four became its
  owner.
