# The IDE

`ide/` is a Bintana project like any other, and that is the point: it proves the
runtime is enough to write a real application in.

```
ide/
  project.json       startup MainForm, sources in dependency order
  forms/             a window each: the .form and the class that answers it
    MainForm         the whole window: toolbar, tree, tabs, designer, console
    AskForm          "type a name"                    ConfirmForm    yes/no
    NewProjectForm   name, description, folder        ProjectForm    its settings
    MenuForm         the menu editor                  ColumnForm     a TableView's columns
    IconForm         the icon chooser                 ImageForm      an image, full size
    SearchForm       find across the project          PoForm         a catalogue, entry by entry
    AboutForm        the version, and what it runs on
  modules/           the classes behind them, all of them `Ide.<name>`
    Classes.js       what the project holds, and what each class is called
    ProjectTree.js   ...as the file tree shows it
    FormFiles.js     creating, renaming, deleting a form -- and writing its code
    TabSet.js        the open files, each page owning its editor or its canvas
    Designer.js      the form designer: the canvas, and what a gesture means
    Chrome.js        what it draws over the form: outline, handles, guides
    ControlTree.js   what the form is made of, as a tree
    PropertyGrid.js  what one property of the selection is worth
    Palette.js       what can be added, and the icon and size of every type
    TitleBar.js      the strip over a design page
    Completion.js    what the editor proposes, and from what
    Finder.js        the find bar
    Runner.js        running the project, and reading what it printed
    Manifest.js      project.json, and everything that writes to it
    Recovery.js      the dirty tabs, copied aside against a crash
    Session.js       the desk as it was left: the window, and what was open
    ProjectFile.js   project.json as a Record: what it may say -- name, version,
                     startup, sources, description
    Strings.js       every string the project shows, walked out of its sources
    Translations.js  the catalogues: the .po format, the plural rules, msgmerge
    Exporter.js      the project tree as one .tar
  icons/             own icons, as fallbacks for what a desktop lacks
  po/                the IDE's own catalogues
```

**The file name is the class name, and the class is in `Ide`.** Every file in
`modules/` declares `Namespace("Ide")` and assigns one class — `Ide.Designer`,
`Ide.TabSet`, `Ide.Classes` — so twenty-three names like `Classes`, `Runner`,
`Export` and `Chrome` stop standing in the global lexical scope where a
top-level `class` quietly wins over a runtime global of the same name. It is
also the project that should be using the feature: this is the largest Bintana
program there is, and namespaces exist for exactly a folder like this one.

The forms stay bare. A form's name is what the *runtime* looks it up by —
`startup`, the `class` of a `.form`, the file it finds by name — they are unique
and already say what they are, and `Ide.` in front of every one of them would
buy nothing. **`Ide` is declared by the code, not read off `modules/`**, which
is the rule the runtime states and this is what it looks like: `Modules.Designer`
would be the folder talking, and the folder has nothing to say.


**Enter and Escape are declared, not handled.** Every dialog here used to carry
the same five lines — `Form_KeyPress(key) { if (key !== "Escape") return false;
this.dismiss(); return true; }` — in seven files, character for character. They
are `"Cancel": true` on the button Escape was pressing anyway and `"Default": true`
on the one Enter should, in the `.form`, where the designer can see the gesture and
edit it. `AskForm` also declares `ActivatesDefault` on its field, which is what
retired its `TxtValue_Activate` as well.

Two of them are worth reading as examples of the choice being *per dialog*.
`ConfirmForm` declares no `Default` at all and focuses `BtnNo` instead: Enter must
not be able to delete something, and a focused button answers Enter itself, so
focusing No is the answer — focus and default are different questions and this is
where the difference shows. `IconForm` declares only `Cancel`, because Enter over a
gallery of icons should pick the highlighted one, which is a separate decision and
not this one.

**Why the helpers are classes and the handlers are not.** A control's event is
looked up on the *form* — `bta_emit` asks `form.BtnRun_Click` — so every handler has
to be a method of `MainForm` and cannot live anywhere else. What it can do is be one
line. `Designer` established the shape and the rest follow it: the handler names the
intent, the class does the work.

So `MainForm.js` is the window and little else — the project it has open, the recent
list, `refresh`, and one line per control event — with a block of one-line
delegations that is the surface the helpers call each other through, and the surface
`tests/ide` drives by name. Everything that had a subject of its own has left, and
each of the two files that used to be 2 300 and 2 800 lines is now a class per
subject.

**One class per panel, in the designer.** `Designer` is the canvas: what is
selected, what a drag or a key does to it, how a control is added and named, the
undo history, reading and writing the `.form`. The three panels beside it are each a
widget the *IDE* owns and the active designer fills in — `Chrome`, `ControlTree`,
`PropertyGrid` — and one of the four is shared outright: the palette is one
`Palette` for every open form, because what it offers depends on the project
and not on the form, and rebuilding it per designer cost a third of a suite run.

A project the IDE opens may have an `app.css` of its own; it is listed and edited
like any other file, with CSS highlighting, and it is where the `Style` drop-down
gets its classes.

The IDE itself has **no `app.css`**, which is the point: what it looks like is
`Style` in its `.form` files and nothing else, and every class it names is one the
desktop's theme already declares.

| | |
|---|---|
| `BtnRun` | `suggested-action` — the primary action, in the theme's accent |
| `BtnStop`, `ConfirmForm.BtnYes`, `MenuForm.BtnDelete` | `destructive-action` |
| `AskForm.BtnOk`, `NewProjectForm.BtnCreate`, `MenuForm.BtnOk`, `BtnWelcomeOpen` | `suggested-action` |
| toolbar and design-bar buttons, `TabActions` | `flat` — no face until hovered |
| `ToolBar`, `DesignBar` | `toolbar` |
| `RunGroup` | `linked` — and it is what keeps `BtnRun` blue; see below |
| `LblFiles`, `LblWelcomeRecent` | `heading` |
| `LblStatus`, `LblWelcomeHint` | `dim-label` |
| `LblWelcome` | `title-1` — the welcome page's name of the program |
| `SideBar` | `sidebar` |

`.toolbar` **flattens the buttons directly inside it** — `.toolbar > button` in
Adwaita, which is the GNOME look and exactly right for the three flat icon
buttons. It is wrong for `Run`, whose whole job is to be the one button with a
face. The theme's own escape is in the selector: `.toolbar > :not(.linked) >
button`, so a group carrying `linked` is left alone. That is what `RunGroup` is —
and `Run` measures `srgb(49,130,227)` inside the toolbar, the accent it is
supposed to be, while `Stop` keeps its own. Linking the pair is also what a
play/stop pair looks like everywhere else.

The bar itself is `background-color: #f6f5f4` in this theme, which is the window's
own colour — so wrapping the buttons in a box changes nothing visible *here*.
That is the point of doing it: the strip is now a container that carries a class,
so a theme that draws a real toolbar draws one, and a project that wants to say
something about it has something to say it about.

Each of those was checked before it was used, because a class the theme does not
declare is not an error — it simply does nothing, silently. `tests/probe.sh` reads
the pixel: a plain button is `srgb(248,247,247)`, `suggested-action` is
`srgb(48,129,227)`, `destructive-action` `srgb(219,26,35)`, `flat` the window's own
background; a `sidebar` panel is `srgb(251,250,250)` against `srgb(246,245,244)`.
The typography ones change the box and `Bounds()` is enough: `heading` draws
"Propiedades" at 100x22 where a plain `Label` draws 87x20. `pill` and `card` were
dropped that way — libadwaita has them, GTK's own Adwaita does not.

No privileges: everything below uses the same API any application has. When
something was missing, it was added to the runtime first — that is why
`Arrangement`, `Split`, `Notebook`, `Switcher`, `RowList`, `SourceEditor`,
`Terminal`, `DragData`, dynamic menus and `Application.ConfigDirectory` exist.

## The window

`MainForm.form` is drawn in coordinates like any other form — it used to be
`Arrangement: "Vertical"`, back when a window that survived a resize could not
use them. What makes it survive one now is the anchors its controls carry.
Inside:

```
Pages (Switcher)        HAlign/VAlign Fill: the window, in two faces
  "Welcome"  WelcomeBox   a column, centred: icon, title, the two commands,
                          and the recent list
  "Workspace" WorkBox     a Fixed holding everything below, unchanged
ToolBar (Panel)         a row, HAlign Fill: the strip across the top
  BtnOpen BtnReload BtnSave   flat icon buttons
  RunGroup (Panel)      Run and Stop, linked into one pair
  LblStatus             HExpand: takes the width the buttons leave
Split                   HAlign/VAlign Fill: the whole window below the toolbar
  SideBar (Panel)       "Project" label + FileTree, both Fill
  RightSplit (Split)
    WorkArea (Split)      the pages, and beside them the panel that speaks for them
      EditorBox (Panel, a column)  the notebook and the bar under it; hidden with
                        the notebook, since with no page there is nothing to search
        Tabs (Notebook) one page per open file, made and destroyed with it.
                        TabActions sits in the strip; hidden when there is no page
          page of a .js   its own SourceEditor
          page of a .form its own CanvasScroll -> Canvas (Overlay: Surface + Glass)
                          and its own Designer driving them
        FindBar (Panel, a column)  hidden until asked for: FindRow always, and
                        ReplaceRow only when replacing
      SidePanel (Panel, a column)  shared; hidden unless a form is showing.
                        SideTabs (Switcher), and nothing else
                            "Properties"  PropGrid, the whole page
                            "Controls"    ControlsBox: SideSplit (Palette +
                                          WidgetTree) with DesignBar under it
    ConsoleBox (Notebook) the bottom panel: two pages, both Fill
                            "Output"    LogView, a read-only TextEditor
                            "Terminal"  Shell, built in code and only where
                                        Widget.Available("Terminal") says yes
```

`SideBar` works in coordinates because its height follows from numbers the
`.form` itself declares — `Split`'s `Height` and `RightSplit`'s `Position`. That
is the test for whether a container can be drawn: **can its size be derived from
what is written down?**

`ConsoleBox` used to be one of those and is a `Notebook` now, for the reason at
the bottom of the list below. The label that used to sit over the output pane
went with the change: a tab already says what the page is, and two of them
saying it is the `forms` folder with a `Formularios` inside it.

Five things could not, and stayed containers:

- **The splits.** A draggable divider is not something an anchor can express, and
  the project tree, the console and the property panel are all resized with one.
  They are controls placed and anchored like any other; what they do with their
  two halves is their own business, the way a `Notebook`'s pages are.
- **`WorkArea`.** The divider between the pages and the side panel, dragged like
  any other.
- **`SidePanel`.** Its height is what the split leaves *minus the tab strip*, and
  the strip's height is the theme's to decide — so there is no coordinate for
  `PropGrid`'s bottom edge that is right on every desktop. Drawn against a
  measured 431 it overflowed a real 427 by 4px, and an anchor keeps the gap it was
  drawn with, so those 4px stayed at every window size. `tests/ide` now asserts
  that nothing in this panel hangs out of it — on each of the switcher's pages in
  turn, since what is not on screen has no allocation to check and a 0×0
  satisfies every one of those inequalities while saying nothing.
- **The views inside `Tabs`.** `Fill` keeps the gaps a control was *drawn* with, so
  it needs a design size to keep them from. A view is created by code with no idea
  how big its page will be, so a control put in one would keep its natural size.
  A box has no such question.
- **`ConsoleBox`.** Two pages, one of which is built in code and only on a build
  that has VTE — so how many there are is not something written down, and a
  notebook's pages are its own business exactly as a `Split`'s two halves are.

**Every page owns what is in it.** A code tab makes its own `SourceEditor`; a form
tab makes its own canvas — `Scroller` → `Overlay` → `Surface` + `Glass` — and its
own `Designer` driving them. Both die with the page. Nothing is moved between
pages and nothing is rebuilt on a switch, because switching a notebook is all the
showing and hiding there is.

`placeContent()` is what is left of the switching: it repoints the *names* —
`this.Editor`, `this.designer`, `this.Surface`, `this.Glass` — at the tab on
screen, and shows the side panel when that tab is a form. They are not controls
of the `.form` any more; they are words for "the active one", and `null` when
there is none.

The side panel is **not** one column of three. A `Switcher` divides it in two —
**Properties**, and **Controls** with the palette above the tree — because 280
pixels of width cannot show a property grid, a palette and a tree at once, and
what it did instead was give each of them a third of the height. The two pages
are the two halves of designing, and the strip says which is on screen without
anything having to be read. `Properties` is the page it opens on: selecting a
control is the commonest thing anyone does here, and that page is where the
answer shows. Nothing switches the page by itself — a selection made from the
tree would pull the tree out from under the pointer.

The design actions — delete, bring to front, send to back — go **inside** the
`Controls` page and not under the switcher, because that is what they are about:
the shape of the tree, not the value of a property. Under the strip they showed
up beneath the property grid too, which is a row of buttons answering a question
that page never asked.

**Saving is not one of them.** There is one `Save`, in the toolbar, and it saves
whatever the active tab is — a `.form` through the designer, a `.js` through the
editor. The design bar used to carry a second one that did exactly the same
thing, with an `Enabled` of its own that could disagree with the toolbar's about
whether there was anything to save; `refresh()` and `Ctrl+S` both read
`isDirty()`, and now so does the only button there is.

It is **not per tab** either. Palette, control tree and property grid are chrome
about *the selection*, and there is one selection because there is one active
tab; the designer being switched to takes them over in `adopt()`. Two things had
to be true for that to work, and neither was:

- The palette's buttons install their handlers on the IDE **by name**
  (`Pal_Button_Click`), so the handler must act on `ide.designer` and not on the
  designer that happened to build it — otherwise a click adds a control to a
  canvas nobody is looking at.
- Filling the grid assigns values to editors, and a `ColorButton` or a
  `FontButton` reports that change on GTK's own time, after the grid's `updating`
  flag is back down. So switching to a tab pushed three undo entries and marked it dirty.
  `applyEditor` now ignores an edit that changes nothing, which is true whoever
  caused it.

That second one was always there; it was invisible while every switch rebuilt the
surface and threw the undo stacks away. Which is the argument for per-tab in one
sentence: **what a widget keeps for itself is only kept by not rebuilding it.**
Undo, selection, caret and scroll now survive a switch because nothing touches
them. Measured, an editor is ~240 KB for a small file and ~550 KB for a 78 KB one
and a form's canvas ~1.5 MB, against a process that idles at 113 MB.
`saveActiveState`/`loadActiveState` no longer copy text, caret or tree in and out;
only the dirty flag is carried, because a tab label shows it while another tab is
on screen.

## The welcome page

With no project open there is no workspace to show: an empty tree, a dead
toolbar, a tab strip of no tabs and a line in the console asking for a project is
a window pretending to be busy. What it shows instead is what it can *do* —
open a project, start one, or go back to one it knows.

`Pages` is a `Switcher` with `Strip: "None"`, which is a bare stack: one page on
screen and nothing to click between them. `openProject()` moves it to the
workspace and nothing moves it back, because nothing closes a project.

The page itself is a column: one `Panel` arranged `Vertical`, with `HAlign` and
`VAlign` `Center` and `VExpand` on, which is all it takes to sit in the middle of
whatever room there is — no coordinates, and so no measurement of a menu bar
whose height is the theme's. (It was a `Fixed` with a centred anchor first,
because `HAlign` in a box did nothing yet; fixing that made this the shorter
answer.) Inside: an `Image` at 96px carrying the same icon the window does, the
name in `title-1`, a line in `dim-label`, the two commands, and the recent
projects as a `ListBox`.

The commands are not new ones. `BtnWelcomeOpen` calls `BtnOpen_Click` and
`BtnWelcomeNew` calls `newProject()`: this page exists because a window with no
project has nowhere else to put them. The list is the menu's, built in one place
(`showRecent()`) so the two cannot disagree about what was opened last, and
choosing a row drops the selection afterwards — GTK does not report selecting
what is already selected, so without that the same project could be chosen only
once.

## What it says about itself

*Help > About Bintana* is `AboutForm`, and like every other dialog here it is a
Bintana form rather than a runtime primitive: GTK ships a `GtkAboutDialog` and
the IDE cannot have it, since what an about box is made of — an icon, three
labels and a button — is already there. A column with `Margin` on it, because a
`Margin` on a form sets GTK's margins on a window and a window has no outside.

It says two things a window title cannot, and only those two are filled in from
code:

- **the version**, `BTA_VERSION`, which is what a bug report needs and which used
  to be printed to the console at startup, where it was gone the moment a project
  was opened;
- **the binary**, `Application.Executable`, which is not obvious on a machine carrying
  more than one build — `BINTANA=/other/bintana ./tests/run.sh` is a habit, and `bintana ide`
  is whatever the `PATH` found. Ellipsized, with the whole path in the tooltip, so
  a long one cannot push the dialog wider than it was drawn.

Everything else is prose in the `.form`, where the catalogue reads it: a label
whose text is a constant has no business being assigned from code, or the
translation of it would have nowhere to come from.

It found a runtime bug that had nothing to do with about boxes and everything to
do with being the last window alive — see *A finalised widget is still reachable
from GTK* in [`architecture.md`](architecture.md).

## Where files go

**A project has a shape, and the IDE creates it rather than leaving it to be
tidied later.** A new form with nothing open goes to `forms/`, a new component to
`components/`, and a new project starts with `forms/Form1` already in place. With
a file open the new one lands *beside it*, which was always the rule and is the
one people expect: one creates a form while working on another.

**Unless the project has no window at all.** *New project* asks what it starts at
before where it goes — *a form* or *a function* — and a project that starts at a
function is a different set of files: `main` in the manifest, `Main.js` at the
root rather than in `forms/` (a folder is where several of a kind go, and a `main`
is one function in one place), and **no `app.css`**, since a stylesheet for a
program with nothing on screen is a file that can only ever be wrong. The hint
line under the fields names what will be created, so which kind was chosen is
visible before accepting and not discovered in the tree afterwards.

The folder names are the categories the project view groups by, which is the
point — the directory ends up shaped like the view one reads it in.

**And having done that, the view stops drawing them.** `forms/` with a
*Formularios* inside it is one thing said twice, the second half a translation of
the first, and once the IDE writes there by default every project has it.
`TOOL_DIRS` in `Classes` names the four folders a *tool* chose — `forms`,
`components`, `modules` and the runtime's `po` — and `subfoldersOf` leaves them
off the tree (it is also what keeps them from becoming namespaces, below); their files are gathered as though they were at the root, into the
categories they would have had anyway. This is not a new rule but the old one
finally stated: **a folder the programmer organised is a node, a folder a tool
named is not**, which is what `po/` had been doing alone since translations
existed.

Only while the folder holds nothing but its kind, and only at the root. A `.png`
left in `modules/` puts the folder back on the tree — hiding it would be hiding
somebody's file from them — and a `src/forms/` somebody nested is theirs, drawn
like any other. The Files view is untouched by all of it: there the folder is
there, because on the disk it is.

**And a folder is not a namespace**, which is what makes this safe to do by
default: nothing about a folder's name reaches a class, so filing a file into
`forms/` changes where it lives and not what its class is called. `startup` in a new project is still `Form1`, and the runtime finds a
form by name wherever the file is.

The IDE's own tree is the first client: `ide/forms/` holds the twelve
`.form`/`.js` pairs, `ide/modules/` the eighteen loose classes, and the root is
`project.json`, `icons/` and `po/`. It had thirty-five files in it.

## The tree, in two views

A chooser at the top of the tree, where the heading used to be: **Project** and
**Files**. They are worth having separately for the reason Android Studio has
them — the first is where one works, and the second is where one goes when the
first is not telling the whole truth.

**Project is a lie about the disk, deliberately.** A form's two files are one
node, catalogues from anywhere gather under one category, the folders a tool
named are not drawn at all, **the hierarchy is the namespaces and not the
directories**, and everything is grouped by what it *is*. That is what makes it the view
one works in, and what makes it unable to answer *why is there a stray file in
here*.

### The hierarchy is the namespaces

A namespace is a node, nested for `A.B`, and the classes in it hang under it
wherever their files are. `Widgets.Stepper` is what a `.form` writes, what
`startup` names and what the runtime resolves — it is what that class *is*, and
this is the view that groups by that. The directory it sits in is the other
view's subject.

It buys three things a folder tree cannot say:

- **One namespace declared in two folders is one node.** That is the case the
  directory can only show twice, and the reason this is the hierarchy rather
  than a decoration on it.
- **A folder that only fed a namespace stops being drawn** — the same rule as
  `forms/` and `po/`, for the same reason: `widgets` holding one `Widgets` says
  it twice. A folder holding anything else — an image, a class in no namespace —
  is still a folder, with what is left in it.
- **A class in no namespace is at the top**, which is exactly what the runtime
  says of a bare name when it resolves one.

`Classes.namespaceOf(file)` is the answer, read out of the code — the
`Namespace(...)` call plus an assignment that really puts *this* file's class
there — because that is what the runtime will act on. The scan is kept from one
listing to the next by each file's timestamp and length: reading every source on
every save cost 38 ms on the IDE's own project against 11 ms for the whole of
`rescan`, and a `stat` for a file nobody touched brings it back to 1 ms. It is
`make`'s bargain one notch finer, and the notch is why `File.Info().Modified`
now carries milliseconds instead of whole seconds.

The IDE's own project is the demonstration, and `tests/ide` opens it to check:
`Ide` with twenty classes under a *Modules* category, the forms at the top
level in no namespace at all, and neither `modules/` nor `forms/` drawn as a
folder.

**Files is the directory as it is**: folders first, then files, everything shown
— including what the project does not recognise. A `README`, a `.tar` an export
left behind, an `.svg` in `icons/`: those were invisible in this IDE until this
view existed, because `Classes.scan` collects only the extensions it can edit.

Three things it leans on, all of them recent:

- **The icons are the desktop's**, asked per file through `File.Info`. A `.tar`,
  a `.md` and a font come out looking like what they are without this file
  keeping a table of guesses — which is half of why `Info` was added.
- **What opens in a tab is decided by content type, not by extension.**
  `File.Info().Type` starting with `text/` is what a file has when a person can
  read it; a list of extensions here would be wrong the first time somebody used
  one nobody thought of. (`notes.bin` being a PNG under another name is the case
  the suite pins.)
- **And what is not text goes to the desktop** on a double click, through
  `File.Open` — which is the honest answer for a `.tar`, and better than either
  refusing or opening it as text it is not.

Both views fill the same `byKey`, so selecting, renaming and deleting work the
same in either and nothing downstream has to know which is up. The choice is
kept in `Settings`, because it is a way of working and not something one
re-chooses every morning.

The names in the chooser are prose and go through the catalogue, so what is
stored and compared is the **index**: comparing the text would mean comparing a
translation, which is the trap a `ComboBox` of keywords already taught this
project once.

## The project tree

`listFiles()` rebuilds a `TreeView` from `Directory.List`, showing only what is editable
(`.js`, `.form`, `.json`). Each form is grouped with its code, because a form is one
thing that happens to live in two files:

```
widgets              a folder: its own categories inside
  Forms
    Stepper          key "form:widgets/Stepper"
      design         key "widgets/Stepper.form"
      code           key "widgets/Stepper.js"
Forms                the top level's own
  Form1              key "form:Form1"
    design           key "Form1.form"
    code             key "Form1.js"
Components           the same, for classes that extend Component
Modules              loose .js
Other                everything else
```

`listFiles()` walks the project with `Classes.scan()`, so **every file is a path
relative to the project** — `"widgets/Stepper.form"` — and that path is its key and
what every operation takes. `addFolder()` is recursive: subfolders first, then the
categories of that folder (`cat:forms:widgets`, so they cannot collide with another
folder's). Leaf keys are the file path; grouping nodes carry a `cat:` or `form:`
prefix so they cannot collide with one. `byKey` maps a key to the file to open,
which is how the group node itself opens the design.

A form and its code are a pair because they are **beside each other**, not because
they share a name: `sibling(file, ext)` is what `pairOf`, the handler writer and the
designer all use, so two folders may each have a `notes.js` without either becoming
the other's code.

## Tabs

One `Notebook` page per open file, and **the page owns what is in it**:
`openInTab` makes a code tab's `SourceEditor`, or a form tab's canvas and the
`Designer` driving it, and `closeTab` destroys the page with both. Each page is a
`Panel` arranged as a column.

`this.Editor`, `this.designer`, `this.Surface` and `this.Glass` are names for
whichever is on screen, repointed by `placeContent()` and **`null` when there is
no tab, or when the tab is the other kind**. Everything that reads them is about
the active tab, so that is the right shape; what touches them elsewhere has to
say so. See [the window](#the-window) for why per-tab, and what it cost.

The strip ends in a button carrying a menu — *Close tab*, *Close others*,
*Close all*, *Save all*. The commands are on the File menu too, but that is
across the window from the tabs they act on, and a strip that has filled up is
where one is looking when the thought arrives.

It is **declared in `MainForm.form`**, on the notebook, with `"strip": "End"` —
menu and all, since `Menu` is an ordinary property. It was built in code until
the format had a word for it, and that was the problem: opening the IDE's own
window in the IDE's own designer and saving it deleted the button, silently.

Per-tab state lives in `openTabs`, keyed by file name:

```js
{ name, mode: "edit" | "design", view, label,
  text, language, line, column,     // edit
  root,                             // design: the .form node as read
  dirty }
```

Switching saves the outgoing tab's state and loads the incoming one's, so no unsaved
change is ever lost by switching. For the active tab the source of truth is the live
widget (`Editor.Modified`, `designer.dirty`), not `state.dirty` — `liveDirty()` is
that distinction. A dirty design tab is re-serialised on the way out, so the
inactive tab holds the real positions.

**A page belongs to the file that opened it**: made by `openInTab`, destroyed by
`closeTab`, and with nothing open there are none. The `.form` used to declare a
first page with the editor inside it, kept forever so the notebook never ran out
— which cost a nameless tab that opened nothing, and a notebook with no pages is
not nothing either: it is an expanding widget with an empty body, and it took
209px between the toolbar and a blank editor. So `renderTabs` hides the strip
when there is no page, and the single `SourceEditor` waits in `WorkArea` — where
the `.form` declares it — between files.

## Find and replace

A bar under the notebook, hidden until `Ctrl+F` (or `Ctrl+H`, which opens the
second row as well). A bar and not a dialog for the reason a find bar always is
one: the text has to stay visible while one types in it.

Walking the matches is `F3` / `Shift+F3`, **or** `Ctrl+G` / `Ctrl+Shift+G`, and the
second pair is not a convenience: this desktop opens its application finder on a
bare `F3`, so the key never reaches the application at all. `Escape` closes the
bar, from the field or from the text.

The searching is **not** here. `SourceEditor.Search` and the four methods around it
are the runtime's, so any application gets them; this is the chrome over them,
which is why it is a `Panel` in `MainForm.form` and its logic is a handful of
handlers. `runFind()` re-runs what the bar says and reports the count; it is called
on every keystroke, on every option change, and after a tab switch.

**The bar is a view of the active tab's search.** The search belongs to the editor
and a code tab owns its editor, so `placeContent()` -- which repoints `this.Editor`
-- calls `syncFind()`: the count is re-taken in the tab now on screen, and a form
tab, having no text, closes the bar. Closing it clears the search, which is what
takes the highlight off; hiding a bar says nothing to an editor.

Two behaviours worth knowing, both of which fall out of the runtime's API:

- `Search()` does not move the cursor, so typing in the field does not drag the
  view around. `F3` is what moves.
- `Replace` acts on the match one is standing on, so with none the first press
  finds and the second replaces -- and after replacing it walks to the next, which
  is what makes the button pressable in a row.

A regex half typed is not an error to report: `(` is a pattern nobody has finished,
and it stops being one on the next keystroke. The counter says `bad regex` and that
is the whole of it.

## Find in project

`Ctrl+Shift+F`, or *Edit → Find in project...*: the same term against every file
the project owns, in a window of its own (`SearchForm`).

**A window and not a bar**, which is the opposite of what the find bar is and for
the opposite reason. A find bar has to be a bar because the text it searches must
stay visible while one types in it; this one searches files that are *not* on
screen, so there is nothing to keep visible -- and what it has instead is a result
set, which is a list, a count, a file filter and somewhere to go from each row.
None of that fits in a strip under the editor.

**Not modal**, like the catalogue editor and for the same reason: the point of a
result is to be gone to, and going to it means working in the window behind this
one. One at a time -- `Ctrl+Shift+F` raises the one that is up rather than
stacking a second answer to the same question -- so the last search is still
there when it comes back, and an empty term leaves it alone. It opens on the
selection the way `Ctrl+F` does, and falls back to whatever the find bar was last
looking for: the two searches start from the same place without being the same
search.

**The file filter is the project's own extensions**, built when the window is
raised and not a table written down here: a project with no catalogues is not
offered `*.po`, and one holding something this IDE never heard of is. What was
chosen survives the rebuild, or coming back to the window would silently widen
the search. `*.js` is matched as a *suffix* and not as a glob, which is the same
bargain `Dialog.OpenFile`'s filters make -- two spellings of "which files" in one
program is one too many. Only the first entry (*Every file*) is prose; the rest
are values, filled from code, because putting keywords in a `ComboBox.Items` from
a `.form` is what sends them through the catalogue.

The searching is JavaScript's here, and that is the honest split rather than a
shortcut. `SourceEditor.Search` is a *widget's* search over the buffer a person is
looking at -- it highlights, it walks matches, it belongs to the view. A file that
is not open has no widget, and loading a hundred of them into editors nobody asked
for, to reuse that code, would cost far more than a `RegExp` over the text. What
the runtime is asked for is what only it can answer: `Directory.List` and `File.Load`.

The results are a tree, a node per file and a node under it per hit, and
**activating** one -- double click or Enter, never selection -- opens the file in
the IDE and takes the editor to the match with `Editor.Select`. Selection
would open a tab per row walked through with the arrow keys, which is the same
reason a catalogue is opened on `Activate`. A `.form` opens in the designer, which
has no text to point at; that is the same answer the IDE gives everywhere else
about a form being a drawing rather than a file one reads.

Two things it says out loud rather than silently:

- **the empty-match guard.** `\b`, `x*` and a half-typed group all match nothing
  at all, and a `lastIndex` that does not move is an infinite loop with the window
  frozen.
- **the cap.** Five hundred hits are listed and the count is the real one, said in
  the label when the two differ. A list that silently stops reads exactly like a
  project with nothing else in it.

## What the editor proposes

Two providers, and the difference between them is the whole point.
`SourceEditor.Completion` offers the words already in the file -- no knowledge of
the language, so typing a control's name a second time is a keystroke and
nothing more is claimed. `ide/modules/Completion.js` answers the other half, through the
`Complete` event, and everything it says is a **lookup**:

| typed | answered with |
|---|---|
| `this.` | the controls on the `.form` beside this file, and the methods this file declares |
| `this.Btn1.` | `PropertyNames()` on a real `Button` -- the class's own, not a list kept here |
| `Btn1_` | `EventNames()`, most derived first, so `Ok_Click` comes before the mouse events |
| `File.` | `Dictionary.Keys(File)` -- so a global that gains a member in C gains it here. **Not for the ones that are classes**: a `class`'s statics are not enumerable, so `Timer.` and `Widget.` answer nothing. Whatever fixes that is not a different way of reading the object -- it is asking somewhere else, the way `PropertyNames()` answers for a control |
| `Ide.` | what the project's own sources assign into that namespace |

The last one is the one the project cannot be *asked*. A namespace is an
ordinary object built at load time, and it belongs to the project — which runs in
another process the IDE does not load — so `namespaceMembers` reads the two
halves the runtime itself will act on: the `Namespace("Ide")` declaration, and an
assignment that really puts a class there. Declaring it is not being in it. It
reads loose `.js` files and not only forms, because that is what a namespace is
mostly made of: eighteen of the IDE's own classes have no `.form` at all, and
this arrived the day they became `Ide.something` and completion went quiet on the
prefix its own authors type most.

Nothing is inferred, which is why the answers can be exact. A completion engine
for JavaScript normally needs a parser and a type inferencer because nothing in
the language says what `x` is; here the runtime publishes what it knows about
itself and the `.form` says what every control is.

**And where it stops is stated rather than papered over.** `const x =
makeThing(); x.` proposes nothing, because nothing in the project says what
`makeThing` returns. The words provider still offers the *spelling* of anything
in the file, which is most of what one wants from a local. Going further needs a
*resolver* rather than an evaluator, and what shape that may take -- and may not
-- is in
[runtime-api.md](runtime-api.md#the-one-thing-eval-is-still-missing-from-and-the-shape-its-answer-has-to-take).

Two things it has to be careful about, both because the handler runs on the
keystroke:

- **The `.form` is read once and kept.** So whoever changes the project's files
  says so -- `listFiles()` and a save both drop it -- or a control added in the
  designer would be missing from `this.` until the IDE was restarted.
- **The file's own methods are scanned from the text**, since the IDE edits the
  project's code rather than loading it, and the scan is redone only when the
  text is not the one it was taken from.

The heading is `CompletionTitle`, set per tab and translated like any caption.

## The project's images

A `.png` used not to be in the tree at all: the IDE lists what it can *open*, and
an image is not something one edits here. Which left *the IDE cannot show you
your own file*, a worse answer than a window that can.

They get a category of their own for the reason the catalogues do — they are not
opened the way everything else is — and it is there **even in a folder that holds
nothing but images**. Dropping it in that case was tried and put back: this is a
view of the *project* and not of the disk, which is why a form's two files are
one node in it, so the categories are the vocabulary it speaks in and one that
comes and goes with what else is in the folder is a vocabulary with a hole. What
the folder is called is a different question, and the answer to it is a different
view.

**Activating one opens a modal viewer**
(`ImageForm`), built out of the runtime's own `Picture` in a `Scroller`: the IDE
using what it ships. Selecting one opens nothing, because the arrow keys walk a
tree and a viewer per row walked through is unusable.

Modal is the decision rather than the default: a viewer one can leave open behind
the designer is a second thing to keep track of, for a gesture that is *look at
this and go back*. The catalogue editor is the opposite case and is not modal —
one edits in it for an hour.

**Fit is a zoom, not a mode.** Inside a `Scroller` a picture is the size its zoom
makes it, so fitting means working the number out from the room — and asking
again until there *is* a room, since a window on its way up has no allocation and
a fit computed then leaves the zoom at zero, which draws nothing and reads as a
file that failed to load.

Not SVG: a `Picture` reads what `GdkTexture` reads, so a project's `icons/` stays
out of the tree rather than offering a viewer that would fail on every file in
it.

## A file that changed underneath

An editor open on a file somebody else rewrote had no way to know, and the only
cure was remembering to reload by hand. Each open tab watches its file
(`File.Watch`), and a change puts a bar over the editor with a **Reload**
button.

**The IDE writes these files itself**, so the question is never *did it change*
but *did somebody else change it*. What answers that is the bytes: each tab
keeps what it last read or wrote, and a change that matches it is the IDE's own
save. Comparing content rather than timestamps answers a second question for
free — a rewrite with identical content has changed nothing worth a notice — and
does not depend on a modification time whose resolution is a second.

A bar and not a dialog, because what it says is *there is a newer version of
this*: news, not a question, and a modal over an editor one is typing in is the
wrong shape for news. It is a `Panel` wearing the theme's toolbar class rather
than a `GtkInfoBar`, which GTK4 deprecated — a bar here is a box with a label
and two buttons, which is what that widget was.

Three things it is careful about:

- **It belongs to the tab on screen.** A file that changed behind a tab nobody
  is looking at has nothing to interrupt; the bar comes up when that tab does.
- **Reloading with unsaved work asks first**, in the words the rest of the IDE
  uses for losing changes.
- **And one can decline.** Keeping what is open puts the bar away for that
  change, because saying it twice would make it something one closes without
  reading.

## What a save says about the file

Saving a `.js` compiles it -- `Application.CheckSource`, which does not run it --
and where it stopped making sense becomes a mark in the editor's gutter, on the
line, carrying the compiler's own message as its tooltip. The console gets the
same thing as `<file>:<line>: <message>`, where `SOURCE_LINK` makes it clickable:
the mark is for the file one is looking at, the line for the file one is not.

**On save and not on every keystroke.** Half a line is not a syntax error, and an
editor that says so while one is still typing it is an editor nobody leaves
switched on. Saving is the moment the file becomes something another process would
read.

**And it never refuses the save.** Code that does not compile is exactly what one
has written when one stops to go and look something up.

## What a crash would have taken

Every thirty seconds — or whatever **File > Autosave...** says — the dirty tabs
are copied into
`~/.config/bintana/Bintana IDE/recovery/<digest>.json`, one file per project,
named after a digest of the project's path — not its name, since two directories
can share one and recovering the wrong `hello` is worse than recovering nothing.

**The project directory is never written to.** That is the whole design and not a
detail of it: an autosave that saved *in place* takes away the one thing closing
without saving is for, and takes it away silently. So what a crash costs is at
most thirty seconds of typing, and what an ordinary session costs is nothing at
all — the files on disk are exactly what the user last saved. VS Code's hot exit,
LibreOffice's AutoRecovery and vim's swap files are the same bargain.

**A tab travels as what it is.** A code tab is its text, read from the live
`SourceEditor` and not from `state.text` — the active tab is the one whose saved
state is stalest and the one a crash is most likely to take. A form tab is its
tree, `serializeForm()` of the surface, so a design half-moved is a design and
not a `.form` that was never written.

**The snapshot is read once, when a project opens**, and only if one was left
behind. Every ordinary way out goes through `quit()`, which throws it away first:
*quit without saving* is an answer, and offering to undo it next time would be
second-guessing the user. What is left behind is therefore what the IDE never got
to ask about — a crash, a kill, a power cut, a session that ended. The dialog
offers **Recover** or **Discard**; recovering opens the tabs and leaves them
dirty, because what is on screen is not what is in the file and the asterisk is
the honest answer. Nothing is written to the project by recovering either.

**How often is the user's**, under **File > Autosave...**, kept in `Settings` as
`recovery.seconds` beside the external translation editor — the IDE's other
preference about how it behaves rather than about a project. Thirty seconds by
default, five the least (below that the tick stops being a net and becomes a
process writing files while somebody types), and **`0` turns it off**, which is a
real answer: a snapshot is a copy of your source in a directory you did not
choose. A prompt and not a preferences window, which the IDE does not have and
should not grow for one number. Turning it off **leaves any snapshot behind** —
it may be the only copy of that work, and deleting it because a setting changed
would be the one unforgivable thing this could do. A value under the floor reads
as the floor rather than being refused: it is somebody saying *as often as you
can*.

Two smaller decisions worth knowing. A tick whose content is identical to the
last write does nothing, so thinking between bursts of typing costs a
`JSON.stringify` and no disk. And a session that ends with nothing dirty deletes
the snapshot rather than leaving one that would offer to restore what is already
in the project.

What this is **not** is a history: one snapshot per project, replaced in place.
Versions of a file over time are a feature about the past, and this is a net
under the present.

## The desk, as it was left

The window comes back the size it was, with its four dividers where they were
left, and a project reopens with the tabs it was closed with — each code tab on
the line its caret was on and the tab that was in front in front. `Session.js`,
and it is two memories rather than one, which is the whole design:

| | |
|---|---|
| `session.window` | the size, whether it was maximised, and the four dividers — **the person's**: one screen, one pair of eyes, and the same answer in every project |
| `session.projects` | one entry per project: the open files in the order the strip had them, the active one, and a line each — **the work's**, and the next project has its own |

**It is kept in `Settings` and never beside the project.** Delphi writes a `.dsk`
next to the `.dpr` and Lazarus an `.lps` next to the `.lpi`, and the first thing
every one of their users does is put it in `.gitignore` — because a project is a
thing one hands to somebody else, and where *my* divider is is not part of it.
`Recovery` settled the same question the same way; this is the cheaper half of
it, since what it protects is a minute of rearranging and not work.

**The map is pruned to the recent list.** The IDE remembers a session for exactly
the projects it offers to reopen, so a directory that has fallen off the menu
takes its session with it and the file cannot grow without end. One list decides
which projects the IDE knows about, and `loadRecent` already drops the ones that
are gone.

**The size is the one seen while the window was not maximised.** A maximised
window reports the screen, and remembering *that* and restoring it un-maximised
gives back a window with no frame left to grab — the bug every toolkit's users
know and none of them can name. `Form_Resize` keeps the last ordinary size, the
flag goes down beside it, and restoring does both: the size first, because it is
what un-maximising has to give back.

**There is no position.** GTK4 cannot place its own window and Wayland will not
let it, so a remembered X and Y would be a setting that lies: written every
time, read every time, obeyed by nothing.

**It is restored in `Form_Open`**, which runs before the window is presented — so
what is written down is the size the window is *mapped* at, and never a resize
somebody watches happen. That is the same moment the `.form`'s own `Width` and
`Height` take effect, which is why this can simply take their place. The
dividers are read the other way round from what one would expect, and on
purpose: the four names are a list in the code, and what the file holds is what
each of them is worth. A file edited by hand — or left by a version that had five
— can then say nothing that reaches a widget this one did not mean to move.

**Reopening a project is no longer a reset.** The tabs come back whenever that
project is opened, by the recent menu or by the tree, which is what `.dsk` and
VS Code both do; what changed with it is that `openProject` saves the session of
the project it is *leaving* before it closes anything. A file that is gone since
is skipped **silently** — a dialog is right when a person asked for that file by
name and wrong six times over when a `git checkout` has taken half of them away.

**And nothing it opens is ever dirty.** Unsaved work is `Recovery`'s, and the two
meet in the right order: the session opens the tabs, then the recovery offer
lands in those same tabs. What is *not* remembered is the selection in a
designer, an editor's scroll and its undo history — those belong to a tab that is
being kept, which is how `TabSet` gives them back across a switch for free;
across a restart there is no tab to keep them in, and writing them down would be
inventing a second, staler notion of what the widget holds. The line survives
because it is the one of them a person can name: *I was at line 400*.

**Both doors write it, and one of them is easy to miss.** `Form_Close` closes by
*returning* — a true answer keeps the window open, a falsy one lets it go — so
the X, which is how most windows are closed, never reaches `quit()`. What is
owed on the way out is therefore a list of its own, `leaving()`: the terminal's
shell, and the desk. The first real session this was tried on left an empty
settings file, which is how the gap was found.

What is **not** remembered either, and is a decision rather than an omission:
the IDE does not reopen the last project on its own. The welcome page is what
starts a session with no argument, and the recent list is one click away on it.

## Running

`BtnRun` saves every dirty tab first — a `.form` and its `.js` travel together, and
running with either unsaved would execute something other than what is on screen —
then spawns the runtime on the project with `Exec`:

```js
this.job = Exec([Application.Executable, ide.project],
                { Directory: ide.project },
                (line) => ide.log(`${line}\n`),
                (code) => this.finished(code));
```

**The output pane is a log view, not a console**, and that is the whole of what
changed here. It ran in a `Terminal` — a real pty — for a consumer that never
typed into it, never coloured anything and never ran `less`: audited, the IDE did
two things, launch a child and show what it printed, and neither needs a pty. So
the child is `Exec`'s and the pane is a read-only `TextEditor` whose `Append`
writes at the end and scrolls there, which is what its own documentation says a
log pane wants.

Two things follow, and both are simplifications. `log()` no longer translates
`\n` to `\r\n` — a terminal is a grid of lines and wanted CRLF; a text buffer
takes the newline it is given. And `findErrorLine` no longer retries: `Exec`
calls the exit callback only once both pipes have seen EOF and `Append` puts a
line in the buffer as it arrives, so everything the child printed is in `Text` by
the time the run is reported over. It used to be ten tries thirty milliseconds
apart, because VTE digests what it is fed on its own time.

`Runner.stop()` is what the Stop button means — `if (this.job && this.job.Running)
this.job.Stop();` — and `Stop` reaches the child's whole **process group**, which
matters because the child is the runtime running somebody's program.

A real terminal is still one tab away: see [*the terminal
tab*](#the-terminal-tab).

### From the error to the line

A traceback names a place -- `at Boom_Click (/path/Form1.js:42:30)` -- and
clicking it goes there. `LinkPattern` and VTE's `Link` event used to do that;
with an ordinary `TextEditor` it is four published properties
(`Selection`, `Line`, `Column`, `Text`), one event, and ten lines of JavaScript:

```js
LogView_MouseUp() { this.runner.followClick(); }             // MainForm

followClick() {                                              // Runner
    const view = this.ide.LogView;
    if (view.Selection !== "") return false;                 // a drag, not a click

    const link = this.linkAt(view.Line, view.Column, view.Text);
    return link ? this.clicked(link) : false;
}
```

A click in a `ReadOnly` editor **moves the insertion cursor**, so `Line` and
`Column` say where it landed and `linkAt` takes the token around that column --
the run of characters a place can be made of -- and matches `SOURCE_LINK` inside
it. Not against the whole line: `at Form_Open (/tmp/Main.js:42:9)` holds one
place, and a click at either end of that line is on neither of them.

`SOURCE_LINK` is one string for the two who need it: the click, which reads the
token back, and the scan that finds the frame a failed run died in.

Three things about the gesture, each of them measured rather than assumed (a real
pointer, on an Xvfb of its own):

- **`MouseUp` and not `Cursor`.** `Cursor` fires on the click and would have been
  the obvious handler -- but it fires on every arrow key too, so reading the log
  with the keyboard would open a file per keystroke.
- **`Selection` is the guard.** A click leaves none; a drag leaves the text it
  covered, and dragging across a place to copy it must not go there.
- **And a drag usually produces no `MouseUp` at all**, because GTK's own drag
  gesture claims the sequence -- the same trap VTE's `LinkPattern` work hit from
  the other side. That is a second line of defence and not one to lean on, which
  is why the guard is there as well.

The cursor clamps to the end of a line, which is the one case a column cannot
tell apart on its own: a click in the empty space to the right of a traceback
reads as a click on its last character. `linkAt` refuses a column past the end
for that reason, and still points at the word before a space *inside* a line,
which is where a click one pixel wide of a place lands.

Clicking one is one way in. The other is a run that ended badly,
which goes there on its own: pressing Run and being left in front of a wall of text
with the file it names one click away is what that fixes. `errorLocation()` takes
the **innermost** frame of the **last** traceback that belongs to this project -- a
traceback is printed innermost first, so the first frame naming a file of ours is
the one that threw, and what is under it is `(native)` or the runtime's. `Run`
clears the console, so anything found is from this run.

Only files of the project: a traceback runs through the runtime's own frames and
through whatever else the program read, and those are not the IDE's to open.

`findErrorLine` looks **once** and gives up quietly, which is the right answer
when the program died of something that named no line at all. It looked ten times
thirty milliseconds apart while the pane was a terminal, because VTE digests what
it is fed on its own time and the exit signal could arrive before the last of the
traceback was on screen. `Exec` and a text buffer have nothing to wait for.

## The terminal tab

`ConsoleBox`'s second page, and the only real `Terminal` left in the IDE. The
output pane above it is a log view because showing what a child printed needs no
pty; this one is Linux's actual terminal -- git, a service, a file to move -- and
it is why `Terminal` was not removed when the console stopped being one.

Three decisions, and each of them is a line of code:

- **It exists only where a child can be run in it.** `buildTerminal` asks
  `Widget.Available("Terminal")` and returns if the answer is no, so a runtime
  built without VTE has a bottom panel of one page and no tab promising something
  that would refuse. Asked of the *class* rather than of a control, because
  building one to ask would be building the thing the answer says not to build.
- **The shell starts when the page is first looked at**, not when the IDE opens:
  a terminal nobody has turned to is a child process nobody asked for, started in
  whatever directory the IDE happened to be launched from. `ConsoleBox_Switch`
  runs `Environment.Get("SHELL") || "/bin/sh"` in the project's directory --
  which is the whole point of it being here -- or in the user's home when there
  is no project open.
- **And leaving asks it to end.** `stopShell()` sends SIGTERM (reaching the whole
  process group) on the way out, and every way out of the IDE owes it —
  `leaving()` is that list and both doors pass through it: `Form_Close` when
  there is nothing to ask, and `quit()` from the answer when there was. It is **not** what ends an interactive shell --
  bash ignores SIGTERM -- and what does is the pty being closed, which hangs up
  its foreground process group the way closing a terminal window always has.
  Measured: nothing is left behind. So the signal is for everything that does
  honour it, and there is deliberately no `Kill()` behind it, because what is in
  the terminal may be a build or an editor.

The control is called `Shell` and not `Terminal`, because `Terminal` is the
class: a field of that name in `MainForm.js` would read as the class in every
line that mentioned it. What the user sees is the tab, and the tab says Terminal.

Two shapes of failure, and one entry point each. A **load error** -- a syntax error,
a class that will not compile -- prints and exits non-zero, and that is the jump. An
**uncaught error in a handler** shows its dialog and the program keeps running, so
there is no exit to notice: that one is the click.

## Renaming, which is refactoring

**Two renames, and they used to share a name.** `renameSelectedFile` is what F2, the
File menu and the tree's menu mean; `renameSelectedControl` is what the canvas's own
menu means. Both were called `renameSelected`, four hundred lines apart in the same
class — so the later definition won, F2 renamed a *control*, and the file rename was
unreachable code. Nothing said so: every assertion about renaming calls `renameForm`
directly, so the suite never went through a menu. `tests/ide` now drives that item,
and the prompt is kept as `ide.renamePrompt` so it can.


Renaming a form (`F2`) moves **both** files, rewrites the class name inside the
`.js`, and updates `sources` and `startup` in `project.json`. Moving only the
`.form` would leave the runtime looking for a `<Class>.form` that no longer exists.

References from *other* files are deliberately **not** rewritten: the IDE lists
which files still name the old class and leaves them alone, rather than blindly
editing someone else's code.

### Deleting a control, and the code it leaves

Renaming a control carries its handlers along. **Deleting one keeps them and
takes the name out of circulation instead**, which is the pair that makes either
half safe:

- the `.js` is not touched, because those handlers are the user's code and a
  Delete is not a request to lose it. Undo brings the control back and finds
  them where it left them.
- and `uniqueName` treats a name the code still answers for as **taken**. It
  used to count up over the *live* controls only, so deleting `Button1` and
  drawing another button handed `Button1` straight back — and the new control
  silently ran whatever `Button1_Click` still did. A control that already does
  something, with nothing anywhere saying why.

The evidence lives in the file rather than in a counter, which is what makes it
survive closing the project: a counter would hand `Button1` back the next
morning. And the console names what stayed and where, because dead code nobody
knows about is exactly how the two halves met.

Reclaiming the old code deliberately is a **rename** — the gesture that says
*this control is that one* — and renaming already carries handlers along.

`FormFiles.handlersIn(source, name)` is the reader both halves use, anchored at
four spaces so a method of the class counts and a `this.Button1_Click()` in a
call does not: a mention is not an answer.

Renaming a control from the property grid carries its handlers along in the `.js`,
with two precise patterns instead of a global replace:

```
this.Button1        ->  this.BtnSave        (access to the control)
Button1_Click(...)  ->  BtnSave_Click(...)  (handler, declared or called)
```

Since `_` counts as a word character, the first pattern does not tread on the
handlers, and neither touches a `Button10` that merely shares a prefix.

This is the one edit that is **not undoable**: the `.js` is rewritten on disk, and
undo only reverts the widget tree — it would put the old name back in the `.form`
while leaving the code with the new one, which is exactly the silent breakage the
feature exists to prevent. So the form is saved and the history cleared.

## The menu editor

`Ctrl+M` opens `MenuForm`, one more Bintana form. Menus cannot be *built* on the
canvas -- a GTK4 menu is a `GMenu` wired to actions, so there is no widget there
to drag into place -- so what is edited is the spec: the same `menus` array the
`.form` carries. The board does show the bar, and clicking it is how most people
will get here (see [The bar on the board](#the-bar-on-the-board)).

The dialog works on a **copy**, so Cancel costs nothing and the designer records
exactly one undoable edit when OK hands the spec back (`Designer.setMenus`). The
tree addresses nodes by path -- `"2/0/1"` is the second child of the first child
of the third menu -- which is both the address and the identity, since the tree is
rebuilt after every change.

It refuses what the loader would refuse, and for the same reasons: an item that is
neither a submenu nor named has no action to raise, a name used twice would make
two items dispatch to one handler, and a name that is not an identifier could not
be a method prefix.

**What kind of item it is** is three check boxes, and they carry the loader's rules
as fields that go grey rather than as an error on OK: `check` is one command that
ticks, `dynamic` is many whose entries the application fills, and `radio` marks
which of those was chosen -- so `radio` is only offered with `dynamic` on, and
asking for `dynamic` takes a tick away. A shortcut goes grey for a dynamic item,
since an accelerator can only name a command that takes no argument.

Each box leaves before deciding: filling the fields assigns `Value`, which raises
`Click` exactly as a person would, so the handler compares against what the node
already says. **An edit that changes nothing is not an edit** -- the same lesson the
property grid learned from `ColorButton`, and it does not depend on when the signal
arrives.

Double clicking an item writes its `Name_Click` handler, the same gesture the
canvas has. The edit is applied first -- writing a handler for an item that a
Cancel would take away again is a trap.

## The bar on the board

The form's own menu bar is drawn between the title bar and the canvas, which is
where the runtime puts the real one: `bta_menus_build` prepends it into a column
inside the window, above the surface.

**It is not the widget, and it does not have to be.** `Ide.MenuBar` is a `Panel`
with a `Label` per top level menu, and the drop-downs are real menus -- every
widget has a `Menu` and a `PopupMenu`. Left click an entry and its menu falls
open; click a leaf and you are writing its handler, the same gesture the canvas
and the editor's tree have. Double click or right click the bar itself and the
menu editor opens.

**Where the look comes from, and where TitleBar's trick stops.** The title bar
can wear the theme's decoration because GTK styles it through *classes*. A menu
bar is styled through a **node name** -- `menubar`, `menubar > item` -- and a node
name is not something an application can put on a widget. `tests/styles.sh` says
so directly: it lists classes, and `menubar` is not among them. Some themes add a
`.menubar` alias (Greybird's GTK4 sheet does); the stylesheet GTK carries inside
`libgtk-4` does not, and that is the theme a desktop without one gets, and the
theme CI runs under. So the bar is built from what the theme *does* offer: the
`background` class is the window colour a menu bar is drawn on, and an entry says
the theme's own `padding: 4px 8px` by hand -- the same thing TitleBar does with
`windowcontrols`' 26.

**Why an entry is a `Label`.** A `Button` was the obvious choice and it is eight
pixels too tall: GTK gives `button` a `min-height: 24px` that applies to its
*content*, so with 4px of padding above and below and its border, the smallest
button there is comes to 34. A real bar is **27**. A label has no floor, and a row
of them with the same padding comes out at 27 exactly.

**The height is measured, not chosen**, because it is not decoration: `Width` and
`Height` are the size of the *window* (`gtk_window_set_default_size`), and the bar
is prepended inside it, so a form with menus has that much less room than it
declares. Before the board showed the bar the designer drew the form at its full
height, and a control placed against the bottom edge came out under the bar at run
time. `Designer.clientSize()` is what the canvas is sized to; `formSize()` stays
the window, and the property grid, the status bar and the form's own grips all
still read that.

The measurement is asked of a real bar: the IDE is itself a form with menus, so
its own window has a `GtkPopoverMenuBar` in it under this desktop's theme and
font, and `Bounds()` reports in window coordinates -- so how far down the IDE's
first control starts *is* a menu bar's height. Measured here: **27**, against the
28 the IDE's own `.form` was written with by hand. The preview is not given that
number, it comes out at it, so `tests/ide` compares the two and fails if a desktop
ever makes them disagree -- rather than quietly putting the canvas in the wrong
place.

Two differences are left, and closing either needs a stylesheet the IDE must not
grow (a rule of ours repaints the IDE itself, the same reason the canvas does not
wear the project's classes): an entry does not light up under the pointer the way
`menubar > item` does, and the 1px rule a real bar draws inside its own height is
not there -- a `Separator` would draw it at the cost of a 28th pixel, and the
height is the half the canvas depends on. What marks the boundary instead is
already drawn: the form's own border, which starts exactly where the bar ends.

**What is previewed is not live**, and it cannot be. The board belongs to the
IDE's own form, and a menu item lands on the form it is built on by name, then
dispatches to `<name>_Click` looked up there. Built as declared, a previewed
`MnuOpen` would replace the IDE's `MnuOpen` and clicking it would open a project;
a `shortcut` would go to `gtk_application_set_accels_for_action`, which is the
whole application, and a designed form with `<Control>s` would take Ctrl+S away
from the IDE. So `MenuBar.sanitise` renames every item after its path, drops
every shortcut, turns an `{ "action": … }` into a plain entry -- the IDE has no
such command -- and flattens a `dynamic` item, whose entries only exist once the
application fills them. A `check` survives: it is the shape of the item, and
ticking a preview costs nothing.

One thing travels that cannot be stopped from JS: a menu label goes through the
catalogue of the process that builds it, and that one is the IDE's. A designed
item whose text is a string the IDE translates is drawn translated in the preview.
The top level entries are not affected -- a `Text` assigned from code is not prose
the loader read.

## The project's own settings

`Ctrl+Shift+P`, or *Project settings...* from the menu bar or from the tree's own
menu, opens `ProjectForm`: the name, the form it starts at, the description, the
libraries it uses, and the order its code is loaded in.

The dialog **checks nothing itself**. It assigns to a `ProjectFile` and reports
whichever setter refused, which is how the field that is wrong gets named without
this form knowing what any of the rules are — add a field to the record and the
dialog validates it for free. Like every other dialog here it works on a copy
(`Record.Clone()`), so Cancel costs nothing.

Two things it knows that a text field could not:

- **The startup is a choice, not a name to remember**: the drop-down is the
  project's own classes. A startup naming a class that is gone is still offered,
  because a project whose startup no longer exists is exactly the one being opened
  to fix it, and silently dropping the broken value would hide what is wrong.
- **What it starts at is asked before which one.** A project declares `startup` or
  it declares `main` — a form or a function, never both, since the runtime would
  call `main` and never open the form, which looks exactly like a form that will
  not show. So the row is a kind (*a form* / *a function*) and then a name, and the
  name control follows the kind: a `ComboBox` of the project's classes for a form,
  a text field for a function, because the IDE never loads the project's code and
  has no functions to offer. One is filled and the other emptied on the way to the
  file, so a manifest written from here cannot declare both.
- **The libraries are ticked, and what is offered is what this machine has.**
  `uses` was the last thing in a manifest that could only be written in a text
  editor: the runtime resolved it and the palette offered whatever it found, but
  nothing in the IDE could add one. What was missing was the *other direction* of
  the same lookup — `Application.LibraryPath` answers about a name you already
  have, and a dialog that offers a choice needs the list — so
  `Application.Libraries` was added to the runtime, walking the same six places,
  and the IDE still owns no copy of that search path. See below for the two
  things the list has to get right.
- **The load order can only be arranged by a project that has one.** A project
  declaring no `sources` is loaded by directory, so the list is shown greyed with
  the order it *would* load in, and *Decide* writes that same order down — nothing
  changes today, and from then on it is arrangeable. That is the one place the
  choice to freeze the order is made on purpose.

### The libraries list

A `RowList` of `CheckButton`s, which is the shape `docs/llm/controls.md` names
for a list of check boxes and for the reason it gives: **the ticks live in the
record**, not in the list. A tick the view keeps is the wrong row's the moment
anything is rebuilt, and a dialog is exactly where that gets discovered late.

Two things it has to get right, and both are about honesty rather than
convenience:

- **A library the project names and the machine does not have is still shown**,
  ticked, dimmed, and saying it was not found — with a tooltip that says the
  runtime will refuse to start the project. It is the same argument the startup
  drop-down makes for a class that is gone: the project being opened is exactly
  the one somebody is opening to find out why it will not run, and a list that
  quietly dropped the name would hide the answer.
- **The ones in use come first, in the order they load.** A library's classes are
  evaluated before the project's own, and two libraries in the order `uses` names
  them — so a new tick is *appended*, never inserted, and unticking leaves the
  rest as they were. The order is a decision the file is making, not a way of
  showing the list.

Each row's tooltip is where that library is, which is the only thing that tells
one the project carries in its own `lib/` from one the system installed — and the
difference somebody about to tick a box wants to know.

Accepting re-lists the project (`Manifest.apply` ends in `listFiles`), so the
library's components are on the palette from the moment the box is ticked.

## Which form the project starts at

The tree marks it with a play triangle instead of the window icon: *this is the one
that runs* is a fact about the project that used to live only in a key of a file.
`listFiles` reads the manifest once per listing for it — a group node asking on its
own would read `project.json` once per form.

Choosing it is *Set as startup form*, on the tree's context menu, which is where
one is looking when the thought arrives. What is written down is the **qualified**
name, because that is what the runtime looks a class up by: a form in a namespace
whose bare name was written would not be found.

**The item acts on the file that is open, not on the row under the pointer.** That
is what the File menu's Rename and Delete already do, and here it is not only
consistency: a right click does not move a `TreeView`'s selection, so an item
aiming at the row it was opened over would act on a different one. The left button
opens, so selecting a form and then asking is the gesture — and there is no *Open*
on the menu for the same reason, since clicking the row already did it.

## project.json, as a record

Every mutation of the manifest goes through one funnel, `withConfig`, which reads
the file as a [`ProjectFile`](../ide/modules/ProjectFile.js) — a `Record` — hands it to a
mutator and writes it back. Before that, what the file was *allowed* to say lived
in the mutators, one `Array.isArray(config.sources)` at a time, and what was wrong
with a broken one was discovered by whoever tripped over it.

```js
class ProjectFile extends Record {
    static Naming = "lower";                  // the file spells its keys that way
    static Fields = {
        Name:        Field.Text({ required: true, max: 120 }),
        Startup:     Field.Text({ max: 120 }),
        Main:        Field.Text({ max: 120 }),
        Sources:     Field.List(Field.Text()),
        Description: Field.Text({ max: 400 }),
    };

    /* One or the other: a field can only speak about itself. */
    Validate() {
        const out = super.Validate();
        if (!this.Startup && !this.Main) out.push("nothing to start: ...");
        else if (this.Startup && this.Main) out.push("declares both ...");
        return out;
    }

    /* Whether `sources` is the list that decides load order. */
    get Lists() { return this.Sources.length > 0; }
}
```

**Neither `Startup` nor `Main` is required, and the rule is in `Validate`** — a
project needs *something* to start, and no single field can say that about
another. A console project (`main`, no window) is an ordinary project to the IDE:
it opens, it runs in the console pane, and it is never told it is missing a
`startup` it was never going to have. Declaring both is the interesting mistake
and is reported as such.

Four things follow, and each of them used to be somebody's job:

- **A mutator cannot write a manifest the runtime would refuse to open**, because
  it assigns through the record's setters. `withConfig` catches a refusal, says
  what was wrong and leaves the file exactly as it was.
- **The four `sources` mutators assign instead of pushing** (`Sources.concat`,
  `.filter`, `.map`), since the setter is what checks the list and a `push` into
  the array it handed over goes around it.
- **`Lists` is the name for "this project decides its own load order".** A project
  without a `sources` list is loaded by directory, and writing one where there was
  none would freeze an order nobody asked for — which is why all four mutators
  start by asking.
- **`reportProject()` says what is wrong once, when the project opens**, into the
  console rather than a dialog: these are things to fix, not something to dismiss
  before working. A manifest that is broken is still opened — refusing would leave
  the one program that can fix it unable to.

And a key the record does not describe is written back untouched, so a project.json
carrying a field from a newer version does not lose it to an older IDE that saved
it.

**Writing the edited record back asks the record which fields it has.** That claim
— *add a field to `ProjectFile` and the dialog validates it for free* — was only
two thirds true: `Manifest.apply` named `Name`, `Startup` and `Description` one per
line, so a fourth field was declared, shown, validated and then silently dropped on
the way to the file. `Version` is the field that showed it. It is a loop over
`edited.PropertyNames()` now, the same discovery a widget's property grid uses, with
`Sources` the one deliberate exception: assigning the list of a project that had
none freezes a load order nobody asked for, which is what *Decide* is for.

## Recent projects

A dynamic menu item (`MnuRecent`) filled from a list kept in `Settings`: most
recent first, no duplicates, eight at most.
Projects that no longer exist are filtered out on load, so the menu offers only what
can be opened. Empty, it shows one disabled entry rather than a submenu that opens
onto nothing.

The same list is the welcome page's, as a `ListBox`. `showRecent()` builds both,
which is the point: two lists of the same thing, filled in two places, are two
lists that will one day disagree. One that is gone by the time it is chosen drops
off and says so, rather than opening nothing.

## Exporting the project

*Project → Export project…* (`Ctrl+Shift+E`) writes the whole directory as one
`.tar` beside it. Not the packaging on the README's list — that is an application
*without* its project tree — but the smaller question that comes before it:
handing a project to somebody without either end needing the IDE to do it.

**Plain tar and nothing else.** A Bintana project is text, so what an archive of
one is *for* is holding the tree together, and which compressor to use is a
question nobody asked. One format is one code path, one filter in the chooser and
one sentence here.

`Exporter` is deliberately two halves, and the seam is the modal dialog:

- `run()` asks — `HasCommand("tar")` before trying, so a missing tar is a
  sentence and not three error lines; `saveAllDirty()` first, because an archive
  of what is on disk while something is unsaved hands over a project other than
  the one on screen, which is the reason `Run` saves too; then `Dialog.SaveFile`
  with the project's own name suggested and the parent folder to start in.
- `write(path)` does it. Everything worth asserting is on this side, because a
  file chooser is a surface nothing in JS can close — see
  [testing](testing.md#what-the-tests-cannot-see). `tests/ide` puts a double in
  `Dialog.SaveFile`, presses the real menu item and reads back the arguments,
  which is how the item is driven without a window being left open.

Two decisions in `write` that are not obvious:

- **An archive inside the project is refused.** It would not *fail* — GNU tar
  notices the file it is writing and skips it — so what comes out is an archive
  quietly missing something, and every later export packs the earlier ones. The
  chooser opens beside the project for the same reason; the refusal is what says
  so when somebody navigates back in.
- **`tar -cf out -C parent name`, never the project's path.** What the archive
  holds has to be one directory named after the project. Handed the path, tar
  stores the components leading to it and unpacking spills a tree over whoever's
  current directory — and the archive still exists, is the right size and reads
  back fine. Only the member names tell the two apart, which is what the test
  asserts.

It is also the first caller of `Dialog.SaveFile`, and reads the way that call was
meant to: a name to suggest, a folder to start in, and a filter whose label is
the caller's own prose.

---

# The designer

Saving goes through `serializeForm()`, which rebuilds the file from the surface
but spreads the node it read underneath: the designer models the controls and the
form's properties, and everything else the file came in with -- `menus` above all,
which no amount of walking the surface could reconstruct -- is carried over
untouched. It did not always, and saving a form used to drop its menu bar without
a word.

`Designer.js` edits **real controls**, not a drawing of controls. `Surface` holds the
actual widgets built from the `.form`; `Glass`, a transparent `Panel` in the same
`Overlay`, sits on top and keeps the mouse — which is why clicking a `Button` selects
it instead of pressing it. Both layers are siblings of one overlay, so they share an
origin and a coordinate measured against one can be drawn in the other.

Events reach the form that owns the controls (`MainForm`), so the handlers live there
and delegate: `Glass_MouseDown` → `designer.mouseDown`.

## Two layout models on one surface

The surface lays its children out the way the running form will:
`buildSurface()` sets its `Arrangement` from the form's before filling it, which
is why every rebuild -- load, undo, redo -- goes through that one door. GTK only
allows the change while the container is empty, hence clear, arrange, fill.

In a `Fixed` form the designer is what it always was: coordinates, snapping,
guides. In a box there are no coordinates at all, so the same gestures mean
something else:

| | Fixed | box | stack |
|---|---|---|---|
| drag | moves, snapped to 4 px, with alignment guides | reorders, with a mark at the boundary | restacks |
| arrows | nudge by a pixel, or by the grid with Shift | move one place along | one layer up or down |
| drop from the palette | lands where the pointer is | inserted at the place in the row | on top of the layer under the pointer |
| what is saved | `X`/`Y` per child | order, and no coordinates | order, and no coordinates |

A **notebook** and a **split** are neither: adding to a notebook makes a page,
which is named after the control so the tab says something, and the page just
added is the one shown. A split holds exactly two halves, so a third child is
refused before anything is created -- the runtime would have thrown, and a throw
mid-gesture is not an answer a designer can give.

**Which of the six it is, the runtime says**: `Container.Placement` answers
`Coordinates`, `Order`, `Layers`, `Pages`, `Halves` or `Single`, and
`placementOf()` is the only place the designer asks. `reorders()` is the
question every gesture that moves a child asks first, and it is *not* "is it a
box": `Coordinates` is a position rather than an order, and `Single` — an
`AspectFrame`, one child and one place — has nothing to move a child to. It used to be decided here from `Arrangement` plus
a table of class names in `pages()` and `split()` -- and that table is how
`Overlay`, `Flow` and `RowList` reached the palette classified as rows: every
gesture reached for an order the runtime refused, *this container has no order to
give*, **raised after the control had been added**. So a drag read as failed and
left something behind -- a child nothing had selected, the insertion mark still
on screen, and the form not even marked as modified. The editor cannot keep a
second list of what the runtime's containers are; it asks.

`dropControl` is written in that order for the same reason: **decide, add,
commit, place**. Where the control goes is a function of the pointer and the
children already there, so it is worked out before anything exists; the selection
and the modified flag are set before the container is asked to do anything else.
From there a refusal can only leave a control in the wrong place -- a whole drop,
badly ordered -- and never a control nothing points at.

In a **stack** there is no line to draw a mark at, because every layer occupies
the whole container: what the drag chooses is *which layer it lands over*, so the
mark is that layer's outline (`Chrome.layerMark`, drawn with the band's own bars)
and `PickAt` is what answers it. X/Y are greyed with a sentence of their own --
*an overlay stacks its children: HAlign and VAlign place this one* -- because
telling somebody "the box decides" about a control in an `Overlay` sends them
looking for a box that is not there.

`Container.Reorder(child, index)` is the runtime primitive underneath, and it
refuses on a `Fixed`: there the order is the painting order, which `Raise` and
`Lower` already say. The index it takes counts siblings *without* the child being
moved, so dragging something forward has to account for the hole it leaves --
that off-by-one is in `mouseUp`. In a stack, index `0` is the base layer, so the
arrows reach *which layer fills* as well as which paints on top.

And the arrows take their undo snapshot **before** the move and push it after,
which is what `mouseUp` already did: pushing first left a dead step behind every
nudge that could not happen -- at either end of a row, and on every container
that used to refuse the move outright.

Before this, an elastic form arrived piled at the origin with negative
coordinates, which is the concrete sense in which the IDE could not be written in
itself: its own window is a column of boxes and splits.

## Selection and chrome

Four thin bars for the outline and eight squares for the handles, created once and
repositioned on every change, all inside `Glass`. Secondary selections get outline
sets from a pool, created on demand and reused. The selection rectangle borrows the
same pool, which is why a test asserts no bar is left switched on after a release.

`selection` is an array whose **last element is the primary**: the one the grid
shows, the one that can be resized, and the one alignment is measured against —
every designer's convention, and the only one that lets the user decide the result.
Selecting a container drops its descendants from the set, or moving them as well as
the parent would shift them twice.

The chrome is placed on what a control **draws**, taken from `Bounds()` -- origin
and size from the same measurement. Mixing the two frames is what made the
highlight sit visibly off its control: `Width` is a request, and a theme's margins
make a `Button`'s face smaller than it and offset inside it (17 px a side here),
so an outline that started at the drawn corner and ran the requested width missed
on both ends.

Positioning uses `OriginIn`, which reads GTK's layout — so a control just created,
moved or rebuilt by an undo has none yet and would answer `(0,0)`. Every reposition
therefore schedules a second pass for the next frame: the first keeps the response
immediate, the second corrects it.

## Dragging, snapping, re-parenting

`beginDrag` records where the cursor grabbed the control, measured while its real
position is still allocated; that distance does not change during the gesture, so on
release the corner is known without measuring again.

Moves snap to a 4 px grid. Alignment guides appear when any of a control's three
lines of interest (leading edge, centre, trailing edge) comes within 5 px of the same
line of another control — which is what turns drawing by hand into something
repeatable. Holding Shift suspends snapping for single-pixel work.

Dropping a control on another container re-parents it. The coordinates have to be
recomputed with `LocalPoint` **before** the move, while the target still has its
layout: `X`/`Y` are relative to the container, so keeping them would teleport the
control. A container cannot be dropped inside itself, and a multi-selection is never
split across containers.

## Copy and paste

`Ctrl+C`, `Ctrl+X`, `Ctrl+V` and `Ctrl+D`, on the controls of a form.

**The clipboard carries `.form` nodes as text**, which is what makes this work
between forms, between tabs and between two IDEs on the same desktop without
anything having to be shared: the serialiser already writes a control as a node
and `AddNode` already builds one, so a control on the clipboard is the same
thing a file holds. It is readable too -- paste it into a text editor and it is
the block that would have been in the file.

```json
{ "format": "bta-clip/1",
  "nodes": [ { "type": "Button", "name": "Ok", "properties": { … } } ] }
```

**What does not travel is the code.** A pasted control gets a fresh name, so its
handlers would be `Button7_Click` and nothing wrote one. Copying `Ok_Click` into
it under the new name would be guessing that the body still means anything where
it landed. Renaming carries handlers along because a rename is the *same*
control; a paste is a second one.

**Names are made fresh all the way down.** A copied `Panel` brings its contents,
and a name is unique across the **form** rather than among siblings -- handlers
are `Name_Event` on the form, so two controls called `Button3` at different
depths collide in the dispatch while nothing on screen looks wrong. The runtime
refuses the second one outright, which is how this is known rather than assumed.
The names a paste has promised but not yet built are counted too, or both halves
of one paste would be given the same one.

**Paste follows the selection; duplicate does not.** Pasting into the selected
container is how one puts something *into* a `Panel`, so paste goes where a new
control from the palette would (`dropTarget`). Duplicating a selected `Panel`
under that rule would drop the copy inside the original, which is nobody's idea
of *one more of these* -- so a duplicate is a **sibling**, placed where the thing
it came from lives.

**A pasted control is selected, and the canvas has to say so.** The status bar
and the property grid read the selection; the outline reads the control's
*allocation* -- so a control GTK has not laid out yet comes out named as selected
and not drawn as selected, which looks exactly like the paste having selected
nothing. The chrome asks again until what is selected has a size, rather than
re-drawing once after a fixed delay: that delay was long enough for the palette,
whose click is followed by a layout pass, and not for a paste, whose control
arrives in a clipboard callback.

**Pasting is the one edit that cannot finish in its own call.** The clipboard's
contents belong to whoever owns the selection and arrive when that application
answers, so `Clipboard.Paste` takes a callback. `Duplicate` is the same code
without the round trip, which is also why it is the one the tests can drive
synchronously.

A clipboard holding something else is the ordinary state of a clipboard, not an
error -- but it does not pass in silence either: a `Ctrl+V` that appears to do
nothing is worse than one that says why, so the console gets a line.

**And the items are disabled over a code tab**, which is not decoration: they
carry `Ctrl+C` and `Ctrl+V`, and an item that stayed enabled would take those
keys away from the editor that is supposed to answer them. A disabled item loses
its accelerator with it -- the same mechanism `Ctrl+F` uses on a form tab.

## Undo

Snapshots of the serialised tree, not a list of inverse actions: `Serialize` and
`BuildChildren` already exist, and a snapshot cannot fall out of sync the way a
badly written inverse action can. A form being designed has dozens of controls, not
millions. The form's own properties are in the snapshot too, so resizing it is
undoable like anything else.

After a restore the controls are new objects, so the selection is recovered by
**name**. Consecutive edits of one property of one control coalesce into a single
entry — a spin sends an event per click, and one entry per event would make the
history useless.

## What is drawn against what was asked for

`Width` and `Height` are a *request*: a minimum. Two consequences the designer
now says out loud instead of leaving to be discovered on screen.

**A control can come out bigger.** A `Label` declaring 120 with too much text
draws 433 and stretches its window by the difference. `Designer.overflow()`
compares `Bounds()` against the request and reports only that direction --
smaller is the theme's margins, which every button has and nobody needs told
about. The outline turns amber and the status bar says the real size.

**A control can come out smaller and offset.** A theme draws a `Button`'s face
inside its box, 17 px a side here, so aligning declared coordinates put a button
and a label visibly out of line. `align` corrects for that inset, and *same
width* means the same drawn width.

The inset is taken from the *size* difference and not from drawn positions,
because sizes are stable where positions are not: a control moved a moment ago
still reports last frame's position, and aligning against that would line things
up with where they used to be.

## The control tree

A `TreeView` of what the form is made of, sharing the switcher's `Controls` page
with the palette through a `Split` — how much of it either needs depends on the
form and on how many types the project adds, so the divider decides rather than
the `.form`.

It is the **other way in**, and for some controls the only one: a control behind
another, or inside a container too small to aim at, has nowhere to be clicked on
the canvas. Opening the IDE's own `MainForm` there gives 38 controls nested 8
deep — `PropGrid` and `BtnLower` live at the bottom of two splits and a box, and
from the tree each is one click away.

Its root stands for the **form itself**, which is what an empty selection edits,
so it is also how the form's own properties are reached without hunting for bare
canvas. The key is `@form`, which no control can be called.

Each node carries the **icon of its type**, from the same table the palette uses,
so a control looks the same wherever the IDE draws it. The table reaches past the
palette's types — `Form`, `TreeView`, `Terminal`, `Scroller` and the rest — because
the tree shows whatever the form holds, palette or not, and a component stand-in
gets the component icon since what it stands for has none of its own.

**Right clicking** either the canvas or a node offers the commands that are
already there — rename, delete, bring to front, send to back, and on the tree
*Expand all* / *Collapse all* — reached from the
pointer instead of from across the window. They carry no command of their own and
go grey with the buttons they duplicate. Two sets of names (`MnuCv*`, `MnuTr*`)
because a menu item is exposed on the form by name, and two widgets cannot both
own a `MnuDel`.

**Double clicking a node renames** what it stands for, through the same
`renameControl()` the grid's `Name` row uses: the identifier is checked, the
handlers in the `.js` follow, and the undo history is cleared because undo cannot
take the code back. On the canvas a double click writes the handler and jumps to
it — different surface, different question.

Selecting from either side ends in `setSelection()` — the one funnel — so the
canvas and the tree cannot disagree about what is selected. Two details keep
that honest:

- **It is rebuilt only when the shape of the form changed**, decided by a
  signature over nesting, order, names and types. Rebuilding it on every edit
  would throw the tree away on each keystroke in the property grid, and take the
  selection with it.
- **Filling it makes the `TreeView` report selections of its own**, none of which
  is the user asking for anything, so `treeMuted` covers the rebuild — the same
  bargain `MainForm.muted` makes for the project tree.

### The board and the space around it

Inside the `Scroller` is a **board**: a column holding the form's title bar and the
canvas, with a margin around the two. So the form is not flush against the corner
of the room it is drawn in, and it is drawn with the decoration it will be shown
with. Nothing is positioned for that: a column stacks the two, neither is told a
size — the canvas is the form's size and the bar is as tall as the theme makes it
— and there is no spacing between them, because a window's title bar sits *on* the
window.

What surrounds the board is the **scroller's own background**, and the board
covers itself with the theme's window colour (`Style = "background"`) so that
background does not show through it. Nothing is laid out and nothing is updated: a colour on
the container covers whatever is not covered, at any size.

It was two panels on the glass, sized from the glass and moved on every layout.
That worked while the surface stretched to the whole canvas area — but once the
`Scroller` arrived the board became the size of the *form*, so `glass.Width -
form.Width` was zero and the shading was a strip of nothing, showing as a sliver
only when the glass happened to come out a few pixels wider than the form. It is
the shape of bug that a measurement cannot have: there is nothing left to measure.

Verified with `tests/probe.sh` on a form drawn 420x260 in a 514x427 view: inside
the board `srgb(246,245,244)`, outside it `srgb(222,222,222)`, the change falling
exactly on the board's edge in both directions, and the caption's own strip
(`Hello Bintana`, 8px in from the corner) sitting on the shade above it.

### The title bar, and where its design comes from

The bar over the canvas is not a label saying which form this is. It is the
decoration the form will be shown with: the window's title — its `Text` if it has
one, its class otherwise, the order a window title follows — its `Icon`, and the
buttons this desktop puts on a window. A component gets none, for the same reason
the property grid offers it no `Text`: a component is not a window.

**None of it is drawn by the IDE.** A picture of a title bar shipped with the IDE
would be one desktop's title bar drawn on every other one, and reading the window
manager's own theme would mean a different file format per window manager. What
the bar wears instead are the style classes GTK dresses a window's own decoration
with — `titlebar` and `default-decoration` on the bar, `title` on the label — so
the theme paints it here exactly as it paints the real thing, and it follows the
desktop when the desktop changes. Where the buttons go comes from
`Application.DecorationLayout`, the setting the window manager reads too, so a
machine that closes on the left is previewed that way.

That is [andreldm's xfwm4-theme-generator](https://github.com/andreldm/xfwm4-theme-generator)
turned around. It asks the GTK theme what a title bar looks like — building style
contexts for those same nodes, rendering them, and writing the pixels out as an
xfwm4 theme — because a window manager cannot run GTK's CSS. The designer is a GTK
application already, so it can skip the rendering and just wear the classes.

Measured on a desktop themed that way, the two agree to the pixel. The preview
comes out **37 px** tall against the **37 px** the window manager reports in
`_NET_FRAME_EXTENTS` for a real form's window, over the same gradient
(`srgb(225,222,219)` at the top to `srgb(218,214,210)` at the bottom) and closed
by the same border (`srgb(191,184,177)`).

**What a theme cannot be asked for is the window itself.** GTK draws one as
`window.csd { border-radius: 8px 8px 0 0; box-shadow: 0 3px 9px 1px rgba(0,0,0,0.5) }`
— a rule on a node named `window`, which is not something a form designer can
build, and CSS offers no way to read a computed value back out. So the board says
both itself, with `Radius` and `Shadow`: rounded by 8 on the top two corners and
square on the bottom two, which is what a window looks like where it meets its own
body, and casting the shadow that makes it sit *above* the desk rather than on it.

The 8 is not invented: it is what GTK's own decoration uses, what the generator
slices its corner images at, and what this desktop's window manager measures out
to — an 8 px arc, probed on a real form's window. The shadow is GTK's numbers
too, and the window manager says the same thing in its own words, which the
generator writes out as `shadow_opacity=50`.

Both go on the **board** and not on the title bar, because it is the board — bar
and canvas together — that is the window; and they are set from `TitleBar.js`
even so, because the corners of the shadow have to be the corners of the bar and
two places that each knew half of that would drift apart.

**The buttons are buttons**, not pictures of buttons: the theme lights them under
the pointer and presses them, which is what tells a person looking at the board
that this is a window. They wear `flat titlebutton`, since GTK's own live in a
`windowcontrols` node no application can build — and for the same reason they say
the rest of that node's rule themselves: `Padding = 0`, 26 square, and a `Radius`
of half that, so the highlight under the pointer is the circle GTK draws
(`windowcontrols button > image { border-radius: 9999px }`) and not a rounded
rectangle. Without the padding the bar comes out 43 px against the desktop's 37,
the button's ordinary padding and all.

Their icons are the desktop's — `window-minimize-symbolic`,
`window-maximize-symbolic`, `window-close-symbolic`, the same three the generator
screenshots — where the icon theme can be asked for them, and the IDE's own
(`ide/icons/bta-window-*-symbolic.svg`) where it cannot. **Name by name**, which
is the order every icon in the IDE follows: this desktop draws
`window-close-symbolic` and cannot be asked for the other two, so it gets its own
cross and two of the IDE's, rather than three of the IDE's because one name was
missing. The three shipped ones are drawn to sit beside a stranger for exactly
that reason — one span, one weight, no style of their own.

The fallback is for a desktop that simply has no such icon; on this one all three
come from the theme, and the runtime keeps them off GTK's icon thread so they can
— see [`runtime-api.md`](runtime-api.md), which has the crash they trip and the
one-road answer to it.

A title bar wider than its window would be no title bar, and a caption is as long
as somebody types, so the title `Ellipsize`s: the board stays the size of the form
whatever it is called. The bar answers one gesture — clicking it selects the form,
which is what the control tree's root does and what a user clicking a window's
title bar is pointing at. Its buttons do not: they are a picture of the window's,
and a preview that could be minimised would be lying about what it is.

## Resizing the form

The border was already drawn (`layoutBounds()`); what it lacked was something to
grab. Three grips sit *straddling* the border, so
either side of the line works: `e`, `s` and `se`. Only the far edges — the form's
origin is `0,0`, and dragging the near ones would move every control instead of
resizing anything.

The drag is its own state (`formDrag`) beside the one for controls, because what
it changes is not a widget: it goes through `setFormProperty()`, the same door the
grid's `Width` row uses, so the grid, the surface, the shading and the status bar
all follow as it moves. The snapshot taken on mouse-down is pushed on release,
and only if the size really changed — a click on a grip is not an edit.

A grip is painted in a darker blue than a control's selection, so the two are
told apart at a glance when a control sits against the form's edge.

**The children follow, and their coordinates are rewritten.** They have to be:
an anchor is measured against the form's *declared* size, so the moment that
changes, a control left at `X=210` in a form grown to 420 is no longer against
the right edge whatever its `HAlign` says. Moving it on screen and leaving the
`.form` alone would show one thing and save another. `adaptChildren()` is the
arithmetic of `bta_fixed.c` applied to the coordinates instead of to the
allocation — floors included: `MinWidth`/`MinHeight` when declared, and the
designer's own minimum when not, so nothing can be squeezed down to something
there is no way to grab again. A container that grew passes its own growth down
to what is inside it.

The baseline is taken when the border is **grabbed**, not read each frame. A
floor makes shrinking lossy — what bottoms out on the way in has no memory of
where it came from — so a drag measured from the last frame would not come back
where it started. Measured from the grab, dragging in past every floor and out
again is exact, which is also why `adaptChildren()` has no early return on a
zero delta: coming back to the starting size has to be *applied* to be undone.

## A component's own properties

A component is a class of the **project**, and the designer runs in the IDE's
process without it — so what it places is a stand-in, and for a long time the
grid could only offer what the designer itself owned: the name and the geometry.

It can offer more than that without the class, by applying the serialiser's rule
to the **text**: a property is an accessor with *both* a getter and a setter.
`Ide.Classes` reads the component's `.js` — the IDE already knows where it is, it
read the same file to decide the class was a `Component` at all — and pairs up
`get X()` with `set X(`. A getter without a setter is left out for the reason it
always is: the `.form` could never put the value back.

The value comes from the **node**, not from the stand-in: a `Label` wearing a
component's name has no `Value`. That also settles the editor, since the grid
chooses by the value — a number gets a spin. For a property being set for the
first time there is nothing to go on but the text, so it is read as the JSON it
is about to become: a `.form` *is* JSON, and `5` and `"5"` are not the same thing
to the setter that will receive it.

What this cannot do is know a default the node does not carry, or validate
against a setter it cannot call. It offers the property and writes what was
typed; the class decides what that means when it runs.

### What the class declares

A property is discoverable because it is *there*: an accessor is a thing in the
text, and on a control written in C it is a thing on the prototype. The other
three questions the runtime answers about a control are not like that. Which
events it raises, which values a property accepts, and which of its strings a
person reads are **declarations** — a C class states them next to its properties
(`BtaClass.events`, `.options`, `.texts`) and `EventNames()`,
`PropertyOptions()` and `TextProperties()` publish them.

Those three walk the *class table*, and a class of the project is not in it. So
a component could not state any of them, and the IDE answered accordingly: a
double click wrote `Step_MouseDown` for every component ever written, a property
with three legal values got a text field, and a caption the component exposed to
the form holding it reached no catalogue. The stand-in made the first one look
deliberate — it is a `Label`, and a `Label` was answering; it happens to declare
no events of its own, so the answer fell through to Widget's and looked like a
considered default rather than the wrong class replying.

The class says it, where `Record` already says its `Fields`:

```js
class Stepper extends Component {
    static Events         = ["Change"];
    static Options        = { Step: ["1", "5", "10"] };
    static TextProperties = ["Caption"];
}
```

Named after the methods that publish them, so a declaration and its answer read
as one thing said on two sides of the process line — and it really is two sides.
At run time the walks in `bta_widget.c` read the static off the prototype's own
`constructor` at each step, which is what `EventNames()` on a live component
answers. The IDE has no live component and never will, so it reads the same
declaration the only way it can: out of the text.

`Ide.Classes` reads them from the source in the same pass that finds the
accessors — once per listing,
so the designer, the grid, the completion and the extractor all ask a lookup and
none of them can be reading an older file than the others — and hands back the
runtime's own shape of answer: **declared first, then inherited**, which is what
makes `componentEvents()[0]` the event a double click should write, exactly as
`EventNames()[0]` is.

Only literals are read. A list built at run time is not something text can
answer for, and half a list is worse than none.

**A class that declares nothing is not a class saying "none".** It is one that
has not been asked, and both callers that care kept an answer for that long
before this existed: the extractor collects nothing rather than guess, and design
mode offers every property rather than hide one. Answering with an empty list
would turn silence into a claim the source never made, and would quietly drop
the captions of every component written before today.

### When a node cannot be built

`buildNode` stands in for whatever it could not make — a component of the
project, or a control carrying a value the runtime refuses (`Style: ".danger"`,
a colour that is not one). The stand-in carries the whole node, so the file
round-trips.

What that costs, and what has to be paid before the stand-in goes in:
`Container.AddNode` parents a control **before** it applies its properties, so a
throw leaves a half-built subtree in the container. A stand-in beside it means
the next save writes the node twice — the controls that did get built, and the
whole node again. The IDE's own `MainForm`, 38 controls, came back from one save
with 44. So `buildNode` deletes whatever the failed attempt added before
standing in, and `tests/ide` opens a form built to fail that way and checks the
save writes it once.

## Values that are picked, not typed

An `Icon` row is a field carrying a button inside it — the same `TextBox.Icon`
the folder chooser in `NewProjectForm` uses — which opens the IDE's own chooser.
A `Background` or `Foreground` row is not a field at all: it **is** a
`ColorButton`, because a swatch is what a colour looks like.

**The chooser and its clear are one control, and the theme says so.** A
`ColorButton` and a `FontButton` have no idea of *none*, and `""` — whatever the
theme says — is the state most controls are in; the clear beside them is the way
back, and it is the row's button rather than anything the runtime builds. The two
go in a `Panel` wearing `linked`, which squares off the corners where they meet
and drops the border between them.

Three conditions, and `tests/ide` asserts each, because a class that reaches
nothing is still accepted and saved:

- **The pair are the panel's own children.** Adwaita writes
  `.linked:not(.vertical) > colorbutton > button`, a *direct* child, so the class
  sits one level above the two and no further. On the row itself it would take in
  the name label, which is not part of the control.
- **The panel is a row.** `:not(.vertical)` is the half of the rule that is easy
  to lose.
- **The clear is a plain button.** It was `flat`, and `flat` is the class that
  takes away exactly what linking draws: those rules set radii and borders,
  `button.flat` blanks background and border-colour outright. A flat member of a
  linked pair is a squared-off swatch with empty space beside it — worse than
  either alone.

`ClassForm` has the same pair twice, declared in its `.form`, and it is built the
same way.

**And the same value is edited the same way wherever it turns up.** A
`ColorButton` and a `FontButton` are placed from the palette now, and the grid
was editing the very value they exist to pick as a line of text: `Value` on a
colour button is a colour for the same reason `Background` is one, so it gets the
swatch and the clear beside it. What decides is **the class of the control
selected**, asked with `instanceof`, not a list of type-and-property pairs — the
control's class is a fact and the list is an opinion that goes stale. A
`ProgressBar`'s `Value` is still a number, and stays a number.

### Numbers that are not whole

Every numeric row used to be a spin with no decimals, which took the edit, saved
it and destroyed it: `Opacity = 0.55` came back `1`, a `Slider`'s `Step = 0.05`
came back `0`. Setting `Decimals` on the spin is not cosmetic — it is what the
box *stores*, so a spin with two of them holds `0.125` as `0.13`.

**How precise a property is gets asked of the control, not written down here.**
Measured across the catalogue there are eight fractional names, and `Value` is
one of them with a different answer per class: fractional on a `LevelBar` and a
`ProgressBar`, which are readings, and whole on a fresh `SpinBox` and `Slider`,
which carry their own `Decimals`. A table keyed by the property name cannot say
that — and one keyed by name *and* class cannot either, because a `Slider` told
`Decimals = 3` really does hold `0.125` and its class says otherwise. **The
answer belongs to the control as it stands**, not to the name and not to the
class.

So the question goes to a throwaway wearing the selection's own properties,
straight off `Serialize()`, and it is a count rather than a yes or no: hand it a
number with six decimals and see how many come back.

| Came back | What it means | The row |
|---|---|---|
| none | the property is whole | the integer spin it always was |
| all six | it did not round at all, so it has no precision of its own | offers two to type into |
| in between | that is the control's own answer | takes it: a `Slider` at `Decimals = 3` says three, a `Terminal`'s `FontScale` says two, a `ProgressBar`'s `Value` says four, being a percentage kept as a fraction |

Never fewer than the number in hand carries, either, so a `.form` holding `0.125`
shows `0.125` rather than rounding it on the way to the screen.

The **live** control cannot be the one asked: assigning `Min` to find out about
it would clamp the `Value` beside it, and putting `Min` back does not put the
`Value` back. A copy can be disturbed freely, which is what it is for. It is
refreshed in `sync`, which is where both things that change the answer arrive —
another control selected, or an edit to this one — and since `applyEditor` ends
in `fill`, setting `Decimals` to 3 re-asks and the `Value` row grows its decimals
in the same beat. One `Serialize` per refresh and one widget per actual change of
state, ~0.3 ms.

**A `Style` row is typed, with a button that offers.** It was a drop-down, and a
drop-down was wrong twice over: the property takes a *list* of classes
(`"card title-3"`) and a combo can only put one in — across the thirty-nine
`.form` files here not one carries a combination, while the IDE's own code uses
three at a time, because from code you can — and which classes exist is the
theme's answer, the project's, and that of whatever theme the person has
installed, so a closed list was a menu claiming to be complete for a vocabulary
that is open by definition.

The button opens a chooser — `StyleForm`, a form like any other, the way the
icon row settled it: a list of names is widgets. It ticks, because `Style` is a
list; it shows the value being built; and what it offers comes from two places
neither of which is a list anybody typed here. The project's classes are read out
of `<project>/app.css` by `styleClasses()` — found by name, exactly as the runtime
finds it — fresh on every popup, so a class written in the editor beside the grid
is offered without reopening anything. The theme's come from `Ide.Styles`, which
is **generated** from the theme itself by `tests/styles.sh --json`.

**And it is ordered by what can actually reach the control**, which is the
difference between a chooser and a list of names. A class is applied to one CSS
node, and the theme writes most of its rules for a particular one: with a `Button`
selected the button classes come first; with a `ListBox`, they are further down,
under a heading of their own, each saying *"the theme writes this one for Button,
LinkButton, ToggleButton"* — **in controls, not in nodes**, because somebody who
selected a list and was told about a `scrolledwindow` has been answered a question
they did not ask. A class that dresses what a control keeps inside itself
(`boxed-list`, `data-table`) says that instead, and where to write it.

Nothing is hidden and nothing is refused: everything is still on the list, still
tickable, and the field behind the dialog is free text — which classes exist is
the theme's answer, and a stale row in the generated table costs ordering, never a
class you cannot write.

### Making one: the class editor

**A class of the project's own is made from the chooser** — *New…* — and it lands
in `<project>/app.css`, because that is what makes it a class rather than a
colour: one name, every control that wears it, changed in one place. `ClassForm`
edits a name and nine values, and a sample wears them while they are typed, which
is also what validates them: a value the runtime refuses is said on a line under
the sample rather than written into somebody's stylesheet.

**The font is typed rather than chosen whole, and the size is a factor.** That is
not a shortcut: the desktop's own type classes are a weight and a relative size
and never a family — `.heading` is `font-weight: 700; font-size: 110%` — which is
what lets them compose and follow whoever runs at a different text scale. A font
chooser can only hand over a whole font, which is the one thing a class should not
freeze. So `Font` takes what Pango takes (`Bold`, `Italic`, `Cantarell 12`),
`Font scale` is the 110%, and `Opacity` is there because `.dim-label` is not a
grey.

**The IDE writes no CSS.** The values go on a control nobody sees and
`Widget.StyleRule()` says what they come to; this adds a name and two braces. The
rest of the file is left exactly as it was — a stylesheet is somebody's, and a
tool that reformats it on the way past is one nobody trusts with theirs.

**And a class it cannot reproduce is not its to edit.** Rather than keep a list of
declarations it understands, `Ide.Sheet.owned` reads the rule back into
properties, regenerates it through the runtime, and compares: anything that does
not come out the same — a gradient, a transition, a `:hover`, a selector of
somebody's own — is left alone, and the editor says to open `app.css` and edit it
there. Which is also why only the project's classes can be edited: the theme's
belong to the desktop.

**And the row says which CSS node the class will land on**, asked of the selected
control through `Widget.CssNode()`. That is the fact that decides whether a class
can match at all: `button.suggested-action` reaches a `Button` and never a
`ColorButton`, whose node is `colorbutton`, and `.boxed-list > row` reaches
neither. A class written for another node is accepted, saved into the `.form` and
does nothing — the quietest failure the runtime has, and the node turns it from
*"it did not work"* into *"of course not"*. The table of them, and what each
control has inside it, is in
[widgets.md](widgets.md#styling-the-vocabulary).

What the canvas cannot do is **wear** them. The designer draws real controls in
the IDE's own process and a stylesheet belongs to a process, so a class of the
project's is offered here and shows up when the project is run; the theme's own do
show, because they are the IDE's too. Loading the project's sheet into the IDE
would style the IDE — a sheet is display-wide, and `button { … }` in it would
reach every button in this window.

That the two are different shapes is the rule the project runs on rather than an
inconsistency: a list of names is widgets, so the icon chooser is a Bintana
form; a colour wheel is not, so it is a control the runtime grew. `isColor(key)`
and the `Icon` check are the whole of the designer's knowledge about which is
which, and both go **by name** — a convention, like `Name` already being special
here.

What the chooser hands back is applied through the same door a typed value goes
through, so it is one undoable edit and nothing else has to know a chooser was
involved.

## The icon chooser

`Button.Icon` and `TextBox.Icon` take a name from the desktop's theme, and there
are 2589 of them here — so the only way to fill one in was to know it by heart
and type it. `IconForm` is an ordinary Bintana form, like every other dialog:
what it needed from the runtime was `Application.Icons()`, the one thing a form
could not do for itself.

The `Icon` row in the grid is a `TextBox` carrying a clickable icon — the same
property `NewProjectForm` uses for its folder chooser, which is what that
property is for. It is recognised **by name**, a convention rather than something
the runtime declares; `Name` is already special in the grid for the same kind of
reason.

Two things the chooser has to get right:

- **It reflows.** The gallery is a `Flow`, so what a line holds is the width's
  business: widening the dialog fits more across instead of leaving the space
  empty. Hand-rolled out of a row of `Panel`s it stayed ten across in a window
  twice as wide, wasting half of it — which is what `Flow` was added for.
- **A page, not the lot.** 2589 buttons is thousands of widgets, all of them
  built before anything appears. It shows 240 and says how many there are, and
  narrowing the search is the way to the rest.
- **What it shows, it has checked.** A theme can name an icon it does not really
  ship, so each one on the page is put through `HasIcon` — but only the page:
  asking it of all 2589 means rendering all 2589.

*Cancel* and *None* are not the same thing, and the callback is what says so:
choosing none calls it with `""`, cancelling calls nothing at all.

## The property grid

A `RowList`: the property name on the left, the control it is edited with on the
right. Which control is decided by the **value**, not by a table of names:

| Value | Editor |
|---|---|
| declares its accepted values (`PropertyOptions`) | `ComboBox` of those values |
| boolean | `ComboBox` of true/false |
| number | `SpinBox` |
| anything else | `TextBox`, applied on Enter |

The rows come from `PropertyNames()`, the same discovery the serialiser uses. That is
what makes a property added in C appear here, edited properly, without the designer
knowing it exists.

### The order of the rows

Alphabetical was one list of forty names with `Name` somewhere in the middle of
it, which is the wrong order for every question anybody asks of this panel. They
are grouped now, and the order is: what a control **is**, what makes it **that
kind** of control, then how it **looks**, where it **sits**, and how it
**behaves**.

| Group | What is in it |
|---|---|
| **Essential** | `Name`, then `Text` — who this is and what it says |
| *the class's name* | what this kind of widget adds: a `Slider`'s `Min`/`Max`/`Marks`, a `CheckButton`'s `Active`/`Group` |
| **Appearance** | `Background`, `Foreground`, `Font`, `FontScale`, `Opacity`, `Style`, `Radius`, `Shadow`, `Padding` |
| **Layout** | `X`/`Y`, `Width`/`Height`, the minimums, `Margin`, `ColumnSpan`, the alignments and expands |
| **Behaviour** | what is left: `Enabled`, `Visible`, `Focusable`, `TabIndex`, `Tooltip`, `Menu`, drag and drop |

Three of those five are written down in `PropertyGrid.js`. **The one that
matters is not, and cannot be**: which properties are the widget's own has to
stay true of a class that gains a property in C, which is the bet the whole grid
is built on. So it is worked out — every concrete widget the runtime publishes is
asked what it has, and what they *all* have is the base every control inherits;
what a `Slider` has beyond that is a `Slider`'s. The runtime deliberately deletes
the reflection that could walk a prototype chain instead (`Object.getPrototypeOf`
among them), so the intersection is not a shortcut, it is the way — and it is
exact, because a property every widget has *is* base, whatever declared it. It
costs one pass over the catalogue, once per run.

A property none of the lists knows about lands in **Behaviour**, which is where
the rest of the general ones already are.

That catch-all is also how a property ends up in the wrong place quietly, and two
did: `FontScale` and `Opacity` are Widget's own, so they are not the control's,
and they were in neither written list, so they were "the rest". They are the two
things the desktop's own type classes are made of — `.title-1` is a weight and a
relative size, `.dim-label` is `opacity: 0.55` — which is appearance and nothing
else. They sit with `Font` now, where the class editor has had them all along.

### What the rows say about themselves

**Bold is "this is in the file".** Which is the same question as "is this not at
its default", asked the way the file itself asks it: `Serialize()` writes only
what differs from a fresh instance of the class, so the keys it hands back are
exactly the ones the `.form` will carry. Nothing in the IDE decides what a
default is — the runtime already does, and a second opinion would eventually
disagree with the file. In design mode it means the same thing about the other
dictionary: bold when the row has a design value of its own. `Name` is the one it
never marks, and rightly: a node carries its name as a field rather than inside
`properties`, and it needs no marking, being the first row of the first group.

**A row that does nothing is turned off, and says why.** A grey row with no
explanation is a bug report waiting to happen, so each of them names the property
responsible: *"Does nothing while `Wrap` is off."* The pairs are checked against
the widget rather than assumed — `Lines` is Pango's cap on a *wrapped* caption,
`ValuePosition` is where a number that is not drawn would go, a `ProgressBar`'s
`Text` is only shown when it is asked for, and a `Picture` under a `Zoom` is the
size the zoom makes it.

The pair that matters most is the one the **parent** decides. On a fixed surface
a control keeps the place and size it was given and the alignment properties are
inert; inside a box the box places it and `X`/`Y` are. Each half is off in the
other's world, and this is measured rather than assumed: a `Button` given
`HExpand`, `Expand` and `HAlign = Fill` on a fixed surface is allocated exactly
the rectangle it had without them (`tests/widgets`).

**The filter box** over the grid is the way to a property in a list of forty. It
matches anywhere in the name, so `col` finds both `Columns` and `ColumnSpan`; it
is a view setting and not an edit, so nothing is applied, nothing is saved, and
it survives selecting another control — one looks for `Margin` and then walks the
form with it still typed.

**Nothing is rebuilt to filter.** The grid holds every row its selection has and
the list hides the ones that do not match — `RowList`'s `Filter` event, which GTK
asks once per row when `Refilter()` says the answer may have changed. It used to
rebuild instead, because a list of controls had no way of hiding one: forty
editors destroyed and forty built per letter typed, which is also what made a
half-typed value unable to survive a search. A heading is shown while anything
under it is, so a group whose rows are all filtered out takes its title with it,
and `rowInfo` is what the grid answers from — GTK hands over a row index, and a
row says nothing about which key it edits.

The grid is rebuilt only when the *set* of properties changes: while dragging, `X`
and `Y` refresh dozens of times a second, and rebuilding the widgets each time would
take the focus and the cursor away from whoever is typing. Editors are created on the
fly, so their handlers are installed on the IDE form on the fly too
(`Prop_<Key>_Activate` and friends) — the same dispatch-by-name every control uses.

With nothing selected the grid edits the **form**: its values are not a control's,
so they come from the root node and are written back there.

Which properties those are is *discovered*, not listed. The form being designed is
not running — the surface stands in for it — so there is no instance to ask, and a
hidden one (`formProbe()`) answers instead: `PropertyNames()`, `PropertyOptions()`
and the factory defaults all come from it, which puts a form's grid on exactly the
footing a control's is on. Only names a top-level window has no use for are held
back, each for a stated reason (`FORM_HIDDEN`): `X`/`Y`, the layout properties that
answer to a surface a window does not sit on, and `Visible`/`Enabled`, which saved
into a `.form` would open it hidden or dead.

This used to be three names written by hand — `Text`, `Width`, `Height` — which
meant a property added to `Form` in C was designable on every control and invisible
on the form. It is the easiest place to break the invariant and the hardest to
notice, since nothing fails: the property is simply not offered.

Three of them the surface has to answer to, because it is what stands in for the
form on screen: `Width`/`Height` resize it, `Background`/`Foreground` paint it, and
`Arrangement` **rebuilds** it — not because the widget cannot be re-arranged in
place (it can, and nothing moves when it is), but because the *file* changes:
whether a child writes `X`/`Y` depends on its parent's arrangement. So the tree is
serialised under the **old** arrangement, the surface re-arranged, and the tree
put back.

### Design values

A `CheckButton` at the head of the panel switches the grid to editing the node's
`design` block instead of its `properties` — what the *designer* shows, so a form
whose text the code fills in can still be laid out.

**One switch for the whole grid rather than a second row per property**, because
the two *are* two dictionaries on the node and editing one at a time is what they
are. Changing mode is not an edit: it must push no undo entry and mark nothing
dirty, which is the lesson `ColorButton` taught this file — and it needs no flag,
because `setDesignMode` returns at once when the mode already matches, so the
switch being filled in from `adopt()` can only ever be a no-op.

In that mode the grid shows **only the properties that hold prose**, asked of the
control (`TextProperties()`) and never matched against a list of names here. Where
a control sits *is* the design, so a geometry has no design value to speak of —
which is what keeps the mode a short, unambiguous list, and what keeps a
`SourceEditor`'s source text out of it entirely.

Three details make it work with no new widget:

- **An empty field means "no design value"**, and the `Placeholder` behind it shows
  what the real one is. Without that, "nothing set" and "set to nothing" would look
  identical and there would be no way to see what you were standing in for.
- **The button inside the field** is the same `TextBox.Icon` + `Prop_<Key>_IconClick`
  the `Icon` row uses. Here it pops a menu of samples — Words, Sentence, Paragraph,
  Name, City, Email, Date, Number — and writes **literal words** into the block. So
  Lorem is not a runtime feature at all: the file holds text rather than an
  `@sample/lorem` the loader would have to understand, and the sample is stable
  between runs, which is what makes two screenshots comparable.
- **A design value is undoable and dirties the form** with nothing added for it:
  undo is a snapshot of the serialised tree, and `design` is part of that tree.

A stand-in is the honest exception: the designer does not have the component's
class, so it cannot know which of its properties are prose and offers all of them.
They go into the node either way, which round-trips because a stand-in's node is
written back as it came.

### The catalogues

`po/*.po` and the `.pot` are listed under a **Translations** category of their
own, at the top level — **the `po/` folder itself is not shown.** A folder is in
the tree because it is where the programmer put the file; `po/` is a place the
*runtime* looks in, so a node holding one category would say the same thing
twice. It is hidden only while everything under it is a catalogue: anything else
in there is somebody's own file and has to stay findable. They are the one kind of project file that **does not open in a tab**, and
`EDITABLE` says so with a `false`: a catalogue is text, so a tab would work, and
that is the hazard — Poedit saving underneath a stale tab, or *Update
translations* rewriting the file while a tab holds the old content, loses a
translator's work. The IDE runs `msgmerge` over these files itself, so the second
editor would be one it created. It is no longer alone in that: `TOOL_DIRS` applies the same rule to `forms/`, `components/` and `modules/`.

Single click selects and the status bar names the gesture; double click or Enter
opens the **catalogue editor** below — or, on the `.pot`, **starts a
translation**, since a template has no translations in it to edit and what it is
for is beginning one. The tree menu carries both, plus *Open in external editor*. **Selection cannot launch anything** — it moves with the arrow
keys, and a tree that spawned Poedit once per row walked through is unusable —
and a click that appears to do nothing is worse than either, which is what the
status line is for.

The tree's menu acts on the file that is *open*, for the reason in
[AGENTS.md](../AGENTS.md) about right clicks not moving a selection. A catalogue
is never open, so it has a word of its own — `ide.selectedCatalogue`, set by the
left button, released the moment anything else is selected — which keeps *select
then ask* true without letting the item act on a row nobody pointed at.

Which *external* program gets it is chosen the way an icon is: `poedit`,
`gtranslator`, `lokalize`, `virtaal`, then `xdg-open`, first one installed
(`Application.HasCommand`). *Project > Translation editor…* overrides it, in
`Settings` rather than `project.json` — a path to a program on this machine is
not a property of the project.

### Starting a translation

*Project > New translation…* copies the template into `po/<locale>.po`. It refuses
a name that is not a locale — `po/Español.po` is a catalogue nothing will ever
load — and it writes that language's own plural rule from `PLURAL_RULES`, which
also decides how many `msgstr[n]` slots each plural entry gets. A language's
plural rule cannot be worked out, so an unlisted locale starts at the English one
and says so in the header.

Without this there was no way to make a first catalogue with no external tool
installed, which is exactly when a project has no translation habit yet.

### The catalogue editor

`ide/forms/PoForm.js`, a window of its own like `MenuForm` — a third kind of tab would
touch how every tab is placed, saved, marked dirty and closed, for a file most
projects have two of. A list of entries marked `●` (nothing in it) or `~` (needs
work) over a pane with the source, one box per plural form, the fuzzy flag and
the `#:` references the extractor wrote.

It deliberately has no translation memory, no fuzzy matching and no format
checks: those are Poedit's, and Poedit is a menu item away. What it covers is the
case a RAD flow produces — your own application's strings, edited where you are.

The one thing it must not get wrong is losing what it does not model.
`Locale.Read` keeps every comment, flag and `#~` block, the editor changes only
the msgstr values and the fuzzy flag, and `Translations.write` puts the rest back
untouched — the suite reads the hand-written `tests/widgets/po/zz.po`, writes it
back, and asserts that nothing was lost and that a second pass changes not one
byte.

Three shapes worth knowing: the boxes are `TextEditor`s -- the plain editor, which
is what this form used to fake with the source one -- because a translation may
contain a newline and a `GtkEntry` would drop it on save; they are built once and
shown or hidden per entry, because rebuilding one takes the focus and the undo
history from whoever is typing; and the window's **X saves** while **Close asks**,
because `on_close_request` returns `FALSE` and this runtime cannot veto a close —
so the ungovernable path is the one that keeps the work.

### Updating translations

*Project > Update translations* walks every `.form` and every `.js` of the project,
writes `po/<name>.pot`, and runs `msgmerge` over whatever catalogues are there.
There is no privileged API in any of it: which properties hold prose comes from
`Widget.New(type).TextProperties()`, and which types exist from `Widget.Types()`.

**Two classes, because they are two subjects.** `Strings` walks the project and
answers a list of entries; it knows nothing about `.po` files, and `tests/ide`
collects from a project that has no `po/` at all to say so. `Translations` is the
catalogues — the format, the quoting, the plural rules, the header a translation
must say for itself, the program the user edits one with, and msgmerge. They met
in one 828-line class for a while and the seam showed: the lint below warns about
a template literal in `Message.Info`, which has nothing to do with a catalogue.
`update()` is where the two meet and the only place they do.

It does not merge by itself. Keeping a translator's work while strings come and go
is `msgmerge`'s whole job; with gettext-tools absent the `.pot` is written anyway,
which is what Poedit's "update from POT file" wants.

It also lints, for the two silent failures nothing else is in a position to see: a
**template literal** in a position that holds prose (the msgid arrives already
interpolated, so no catalogue can match it) and a **literal assigned to a text
property from code** (a caption that escaped the designer, in no `.form`, invisible
to a translator and to this grid). The first is only reported when the literal
parts contain letters — `` `${key}: ${e.message}` `` has nothing to translate, and
a lint that cries wolf gets switched off.

## The palette

Tabs of square icon buttons, one per type, built by `Palette` (`Palette.js`)
— none of it is declared in the `.form`. Each button is a real `Button` named `Pal_<Type>`
with an icon, a tooltip and `DragData = type`, and its handler is installed on the
IDE form the same way the grid's editors are.

**It is one widget shared by every open designer, so it belongs to the IDE and not
to a designer** — which is why the class is the window's (`ide.palette`) and each
designer only asks it to `offer(components)` and to `mark(tool)`. Each of them used
to decide for itself: the constructor built it, `setComponents` built it again for
every open tab on every listing, and `adopt` built it on every switch. That came to
108 rebuilds of the same palette in one suite run, and a rebuild is ~25 widgets a
tab with every icon re-resolved — a hitch every time a user moved between two
forms. Now it is 23, and the guard is one comparison in `offer`.

Taking the panel over never needed a rebuild: the buttons act on `ide.designer`,
so they already dispatch to whoever is on screen. Only what the palette *offers*
changing needs one, and the project's components are the only thing that changes
it. A designer does not build it at construction either — a fresh one's component
list is `[]`, which is never what the palette should show, so building then threw
away a correct palette to rebuild it a moment later.

The buttons live with the palette (`ide.palette.buttons`), or a designer that
skipped a rebuild would find none of them and `mark()` would mark nothing.

Each tab is a **`Flow`**: how many buttons go on a line is the panel's business,
so widening the side panel fits more across instead of leaving the space empty,
and a tab with a project's worth of components scrolls rather than losing the
ones past the bottom — which is what rows of a fixed width did, with no way to
reach them. Measured with 14 components: three lines of six, the rest a scroll
away.

The tabs are `Basic` (`Button`, `Label`, `Image`, `Picture`, `Separator`,
`TextBox`, `CheckButton`, `ToggleButton`, `Switch`, `LinkButton`), `Data`
(`ComboBox`, `SpinBox`, `ListBox`, `Slider`, `DatePicker`, `Calendar`,
`ColorButton`, `FontButton`, `ProgressBar`, `LevelBar`, `Spinner`), `Views`
(`TreeView`, `TableView`, `TextEditor`, `SourceEditor`, `Terminal`, `RowList`,
`Flow`, `DrawingArea`, `Video`), `Boxes`
(`Panel`, `Grid`, `Frame`, `Expander`, `Scroller`, `AspectFrame`) and
`Split` (`Split`, `Notebook`, `Switcher`, `Overlay`) -- the containers a window
like the IDE's is actually built from -- plus `Project` when the project has
components of its own (see below).

**Every type that can be placed is on one of them**, and `tests/ide` asserts it
against `Widget.Types()` rather than against a list of its own. It has to, because
this table was six short and nothing said so: `TreeView`, `SourceEditor`,
`Terminal`, `RowList`, `Overlay` and `Flow` were classes of the runtime that no
button offered -- and the IDE's own forms are built out of five of them, eight
`RowList`s and four `TreeView`s among them. So the IDE was drawn with controls its
user could not place. The icons were already in the table (the control tree needs
one for whatever a form holds, palette or not), which is exactly why the gap was
invisible from the code.

`Views` is the tab that came out of fixing it, and it is what pulled `TableView`
out of `Data`: a table, a tree, an editor and a terminal are one kind of thing --
a window onto something the program has -- where `Data` is the controls that hold a
value. `Form` and `Component` are the two placeable classes deliberately left off:
a form is the surface being drawn on, and a project's components have their own
tab.

**And no two buttons may be the same picture**, which the suite also asserts,
because a palette is read by its pictures and four pairs were sharing one:
`ListBox` and `Separator` both drew `view-list-symbolic`, and `Panel`, `Grid` and
`TableView` all drew `view-grid-symbolic`. Every other assertion passed while that
was true -- each button had *an* icon, and it was the theme's.

**A `DrawingArea` placed on the canvas is empty, and that is correct.** Its content
is whatever its `Draw` handler paints, and the handler belongs to the application
being designed rather than to the IDE -- so the designer draws the control's box,
its selection chrome and nothing inside it. It is the one control whose appearance
cannot be previewed, for the same reason a component of the project cannot be: the
code that would answer is not in this process.

`ColorButton` and `FontButton` go next to `DatePicker`, and for the same reason
the property grid edits a colour with a swatch and a font in itself: all three are
a value a person **picks** out of the desktop's chooser rather than spells. Both
controls had existed in the runtime since the grid needed them, and were reachable
from a form only by writing `new ColorButton()` by hand -- a control the IDE uses
and does not offer.

Two roads to the same place:

- **Press** it: the control lands in the first free spot, shifted along until it does
  not overlap, and that type becomes what `Ctrl+Insert` repeats. The active type is
  marked with the selection blue.
- **Drag** it to the form: `Glass_Drop(type, x, y)` puts it where it was dropped,
  centred on the pointer (which is where the drag stamp was), snapped to the grid,
  and inside whatever container it was dropped on.

Icons prefer the desktop's name and fall back to the IDE's own drawing in
`ide/icons`, chosen with `Application.HasIcon`. Both are in the icon search path, so
picking is a single `find` down a list of names.

**`HasIcon` renders the icon and looks for ink**, which is what makes that list
work at all: a theme in the wild ships SVGs that resolve and draw nothing -- 120 of
elementary's 258 symbolic icons position their artwork with a `transform`, which
GTK 4.20 and later do not apply -- so "the theme has it" and "the theme can draw
it" are two questions and only the second one matters. A name with no drawn
fallback behind it therefore leaves a button *empty*, and one did: the palette's
`ColorButton` on the machine this was written on, because `color-select-symbolic`
is embedded in GTK, overridden by this desktop, and blank. It has
`bta-color-symbolic` behind it now. `tests/icons.sh` answers the same question off
the disk for every icon named in a `.form` -- but not for this table, which is
JavaScript, so what it answered is written into the comments beside the names.

The desktop has no icon for a box, a split, a switcher, a toggle button, a progress
bar or a slider, so those are the IDE's own drawings and there is no theme name
worth trying first: a toggle is not a switch, a progress bar is not a scroller and a
slider is not a speaker, and reaching for the nearest theme name would put a picture
of the wrong control on the button. Two more are the same story in reverse -- the
theme *has* a name and it is the wrong picture, or the right one drawn illegibly:
this desktop's only radio is the *unchecked* one, an empty circle that at 16px says
nothing, and its nearest date icon draws a clock with a plus. So both list the
checked/proper theme name first, the IDE's own drawing next, and the ambiguous
theme name last or not at all. Which one each control ends up with is the desktop's
business and changes between them -- `tests/ide` asserts only that every palette
button gets an icon that renders.

## Double click writes the handler

The central gesture of a RAD. Double clicking a control opens its most likely event
(`Click` for a button, `Change` for a text box, `Select` for a list…), creating the
method if it does not exist, switching to the code tab and putting the cursor in the
empty body. On the background it opens the form's own event.

The method is inserted at the end of the class body, found by counting braces while
skipping strings and comments — a brace inside a string would throw the count off and
land the method anywhere at all. If the body cannot be delimited with confidence it
falls back to the start of the class, which is always correct even if the order reads
oddly.

The `.form` is saved first: the `.js` is about to be written, and the two files must
not end up describing different forms.

## Folders, and namespaces, which are not the same thing

A project outgrows one flat directory, so the IDE works in paths. **A folder's
name is never a namespace.** What makes a class answer to `Widgets.Stepper` is its
own code:

```js
Namespace("Widgets");

Widgets.Stepper = class Stepper extends Component {
};
```

the declaration and not the directory — which is what the runtime resolves, and
therefore the only thing the IDE may read.

**This replaced a rule where a folder did spell one**, and the replacement is
smaller in every direction, so the old rule is worth recording rather than
forgetting:

- It needed an **exception per folder a tool had named** — `forms/`,
  `components/`, `modules/`, `po/`, and `lib/` the moment libraries arrived —
  because otherwise tidying a project renamed somebody's class: moving `Chip`
  into `components/` made it `components.Chip`, folder case and all, and rewrote
  every `.form` that placed one. Five exceptions is the rule telling you it is
  wrong.
- It made a **file move a semantic change**. Dragging a file in the tree renamed
  a class and every reference to it. Now a move moves a file; the class keeps the
  namespace its code declares, wherever the file lands.
- It could not express **two folders feeding one namespace**, which is what a
  namespace is *for* and what the project view is built to draw.

What the IDE offers instead, when you create a class in a folder, is **the
namespace the classes already there are in** — `namespaceHere(folder)`, read from
their code through `namespaceOf`. So a batch written in one place stays
consistent, and the checkbox names the namespace it would join: *Put the class in
`Widgets`, like the others here*. Where no class in the folder is in a namespace
there is **no checkbox at all**, because there is nothing to join: the first class
of a namespace is told which one, and `createForm(path, kind, "Widgets")` is how a
caller says it. A namespace is a decision, not a side effect of `mkdir`.

The option rides in the same dialog as the name rather than a second one, because
the name may grow a folder while it is being typed, and because *Cancel* should
mean "not at all" rather than "not that way". `AskForm.prompt` takes an optional
`{text, checked}` and hands the state back as a second argument; it makes room by
moving the buttons down and growing the window by the same amount.

The IDE is the demonstration of the rule it now follows: the classes in
`ide/modules/` are `Ide.Designer` and `Ide.TabSet` because their code says
`Namespace("Ide")` — never `Modules.Designer`, because no folder names anything.

- *New form...* and *New component...* accept a folder in the name, create it,
  and register `Widgets/Stepper.js` in `sources`. The suggested name is offered
  in the folder of the file being worked on, and is free as a *class*.
- **Identity is the qualified name.** `qualifiedName(file)` reads it out of the
  `.js` — the `Namespace(...)` call plus an assignment that actually puts *this*
  class there — because that is what the runtime will act on. Deducing it from
  the folder would let the two disagree, and the IDE would then write types
  naming a class nobody declared. `classNames()` caches the answers per listing.
- `Widgets.Stepper` and `Parts.Stepper` may both exist; two bare `Stepper` may
  not, and `warnDuplicateClasses()` says so in the console for the ones that
  arrived some other way.
- *Rename*: a bare name renames in place, a name with a folder moves the pair —
  and **a move changes no namespace**, so nothing in the class's own source is
  rewritten. `retargetNamespace()` is still there for the case that does change a
  class's namespace deliberately, and makes two precise edits rather than a global
  replace: a namespace is a common enough word to appear elsewhere in the file.
- **Renaming a class changes the name every `.form` uses for it**, so
  `retypeForms()` rewrites those nodes. They are JSON and the IDE owns their
  shape; the `.js` of *other* classes is only warned about, which is the honest
  limit. A *move* needs none of this, which is the point of it.
- The class being renamed is identified by its qualified name: two namespaces may
  hold the same short name, and only the open file says which one is meant.
- Control names use the **last segment**. A control's handlers are `Name_Event`
  methods, and `Partes.Chip1` is not an identifier.
- A folder with nothing editable in it is not shown: the tree is built from the
  files, so an emptied folder disappears on its own.

## Components of the project

A component is a form that is not a window (`class X extends Component`, with its
own `X.form`). *File -> New component...* writes the pair and registers the source,
the same as a new form; the only difference in the file is that a component has no
`Text`, because it has no title bar.

The IDE finds them by reading the code: `componentsInProject()` looks for
`class <Base> extends Component` in each `<Base>.js` next to a `<Base>.form`. It
cannot ask the class -- that class belongs to the project and is loaded in the
project's process, not the IDE's. What the declaration says is what the runtime
will act on, so that is what the IDE reads.

The scan feeds two things, both from `listFiles()`:

- the tree, where components are a group of their own;
- `designer.setComponents(list)`, which rebuilds the palette with a `Project` tab,
  one button per component, sized from the component's own `.form`. Each is
  listed under the name a `.form` will use for it — `Partes.Chip`, not `Chip`.

Placing one creates a **stand-in**: the designer has the runtime's widgets and none
of the project's, so there is nothing to instantiate. The stand-in is a `Label`
marked `[Type]` carrying the original node in `__node`, and `nodeOf()` writes that
node back with the geometry and the name the designer gave it. Its property grid
offers only `Name`, `X`, `Y`, `Width` and `Height` -- what the designer really owns.
Everything else belongs to the component, and a property one could edit and lose on
the next save would be worse than one that is not shown.

The same mechanism carries a form that uses a component the IDE cannot build:
opening it, moving things around and saving leaves the component exactly as it was.
