# The reference

**One page per class, for the person writing an application.** What the control
is, when to reach for it and when to reach for its neighbour, a real example off
the tree, every property, method and event with a real explanation, what goes
wrong, and what it deliberately does not do.

It is a third audience, and the two that already exist do not cover it:

| | For | Shape |
|---|---|---|
| [`llm/`](../llm/README.md) | a language model writing an application, which has no IDE and writes every file by hand | the philosophy, the formats, and the **whole surface said in as few words as it takes** — `Alignment`: `Left` `Center` `Right`, default `"Left"` |
| **this** | **the person at the IDE** (after [first-app.md](../first-app.md)) | **the same members, each explained: what it is for, what the default means in practice, and what happens when it is wrong** |
| the rest of [`docs/`](../README.md) | whoever changes the runtime | how it is built in C, and what it takes to add a widget |

The two references hold **the same rows**. What differs is how much each cell
says, never which members are there: a page that documents a selection would send
a reader looking in the other one for the rest, and both of them are meant to be
the last place you look.

## What a page contains

In this order, because it is the order the questions arrive in:

1. **What it is** — a paragraph, in plain words.
2. **Every member** — *these are all its properties, these are all its methods,
   these are all its events*, in one place, alphabetically, each with a phrase
   short enough to find a name by eye and a link to where it is explained. It
   comes before the prose on purpose: a reference answers first and argues
   afterwards, and somebody who arrived here from F1 with the control already in
   front of them needs the list and not the essay.
3. **Which one is this** — the neighbours it is confused with, and the one
   sentence that separates them. Most of the time lost with a widget set is lost
   here.
4. **The shapes it comes in**, where a control has more than one.
5. **On a form** — a `.form` fragment and the handlers beside it, taken from an
   example in the tree so that it cannot be fiction, and a link to that example.
6. **The members again**, in sections by what they are for — the columns, the
   rows, the selection, sorting — each with its own table, and this time with the
   cell that explains. Every member is in one of them.
7. **What goes wrong** — the symptom first, because that is what the reader has
   in front of them, and then why.
8. **What it does not do** — the decisions, so nobody goes looking for a switch
   that was never there.
9. **See also**.

**The short phrase has a second reader.** `SourceEditor`'s completion already
takes `{ Text, Detail }` — the IDE puts the control's type beside an event name
with it today — so the day a completion popup says what a property *is*, the
string it shows is this one. That is why it is a phrase and not a sentence: six
words, uniform across the pages, and in the second column of the summary table
where something can find it.

**Twice is deliberate and it is checked both ways.** `tests/api.sh` reads which
members belong to which class out of the class registration in the C, and asks
for each of them *in the summary* and *again outside it*: a member that is listed
and never explained is a long page quietly turning back into a short one, and a
member the summary forgot is a reader concluding the control cannot do it.

Two rules about the writing. **A long cell has to answer something the short one
does not** — what it is for, what the default means in practice, what breaks —
and where there is nothing more to say it repeats the short line and moves on:
`Visible` does not deserve a paragraph, and pretending otherwise is what makes
half the reference documentation in the world unreadable. And **what is stated
here is checked or measured**, not remembered: the behaviour in these pages came
from the C, from a probe written to ask, or from an example that does it.

## Two halves, two folders

| | |
|---|---|
| `widgets/` | one page per **class**: `TableView`, `Label`, `Split`, `Form`. `Widget` is what they all inherit from, containers included, which is why the folder is called that and not `controls/` |
| `globals/` | one page per **global**: `File`, `Logger`, `Timer`, `Locale`, `Decimal`, `Record`. It is what the rest of this tree calls them and what [`llm/library.md`](../llm/library.md) is the short form of |
| `libraries/` | one page per **component a shipped library publishes**: `Chart`, `Report`, `Markdown`. They are reached with `uses` in `project.json`, which makes what they publish part of the contract exactly as a control's properties are |

A page's name is the class or the global it documents, exactly as it is spelt in
code — `widgets/TableView.md`, `globals/File.md` — so the IDE can find the page
for a control without a table in the middle.

## What is here

**Every name this runtime publishes has a page**: 46 classes, 27 globals and the
3 components the shipped libraries publish. `tests/api.sh` holds each one to its
members, twice — once in its summary and once where it is explained.

### widgets/

| | |
|---|---|
| [AspectFrame](widgets/AspectFrame.md) | a rectangle of a given proportion, centred in the room there is |
| [Button](widgets/Button.md) | a press |
| [Calendar](widgets/Calendar.md) | the month itself, with the days that matter marked on it |
| [CheckButton](widgets/CheckButton.md) | a box one ticks — or, with a `Group`, one of an exclusive set |
| [ColorButton](widgets/ColorButton.md) | a swatch that opens the desktop's colour chooser |
| [ComboBox](widgets/ComboBox.md) | a drop-down: one of a list, chosen on one line |
| [Component](widgets/Component.md) | a form that is not a window, used inside another form as if it were a control |
| [Container](widgets/Container.md) | what holds other controls |
| [Control](widgets/Control.md) | the branch of the hierarchy for everything that is not a container |
| [DatePicker](widgets/DatePicker.md) | a date on one line, with a calendar in its popover |
| [DrawingArea](widgets/DrawingArea.md) | a surface to draw on |
| [Editor](widgets/Editor.md) | a buffer of text with a cursor in it |
| [Expander](widgets/Expander.md) | a [`Frame`](Frame.md) that folds |
| [Flow](widgets/Flow.md) | a gallery: children wrap into as many columns as fit |
| [FontButton](widgets/FontButton.md) | the font, shown in itself |
| [Form](widgets/Form.md) | the window |
| [Frame](widgets/Frame.md) | a [`Panel`](Panel.md) with a title |
| [Grid](widgets/Grid.md) | rows and columns whose sizes come from what is in them |
| [Image](widgets/Image.md) | an icon or a small picture, drawn at a size |
| [Label](widgets/Label.md) | text the user reads and cannot edit |
| [LevelBar](widgets/LevelBar.md) | a reading, not a progress |
| [LinkButton](widgets/LinkButton.md) | an address, handed to the desktop |
| [ListBox](widgets/ListBox.md) | a list of strings, and the simplest list there is |
| [Notebook](widgets/Notebook.md) | pages in tabs. Its children **are** its pages |
| [Overlay](widgets/Overlay.md) | stacked: the first child fills, the rest float on top |
| [Panel](widgets/Panel.md) | the plain container: a box, a group, a toolbar, a region of a window |
| [Picture](widgets/Picture.md) | a photograph, which is not an icon |
| [ProgressBar](widgets/ProgressBar.md) | work with an end in sight |
| [RowList](widgets/RowList.md) | one row per child, and **each row is a widget you built** |
| [Scroller](widgets/Scroller.md) | content whose size is not its parent's business |
| [Separator](widgets/Separator.md) | a rule |
| [Slider](widgets/Slider.md) | the same four words a [`SpinBox`](SpinBox.md) uses, asked with the mouse |
| [SourceEditor](widgets/SourceEditor.md) | code: highlighting, completion, search and gutter marks |
| [SpinBox](widgets/SpinBox.md) | a number, typed or stepped |
| [Spinner](widgets/Spinner.md) | work with no end in sight, which is most work |
| [Split](widgets/Split.md) | two regions and a divider the user can drag |
| [Switch](widgets/Switch.md) | a setting that takes effect at once |
| [Switcher](widgets/Switcher.md) | pages picked from a strip of linked buttons |
| [TableView](widgets/TableView.md) | a list with columns, and its rows may nest |
| [Terminal](widgets/Terminal.md) | vTE with a real pty: colours, prompts and interactive input all work |
| [TextBox](widgets/TextBox.md) | one line of editable text |
| [TextEditor](widgets/TextEditor.md) | the plain multi-line field |
| [ToggleButton](widgets/ToggleButton.md) | a button that stays in |
| [TreeView](widgets/TreeView.md) | one column of text, in a hierarchy, addressed by **key** |
| [Video](widgets/Video.md) | a clip that plays, in the window |
| [Widget](widgets/Widget.md) | what every control is, before it is anything in particular |

### globals/

| | |
|---|---|
| [Application](globals/Application.md) | the running program: what it is called, where its files are, and how it ends |
| [AudioPlayer](globals/AudioPlayer.md) | sound with no window |
| [Bytes](globals/Bytes.md) | a file's contents, when they are not text |
| [Clipboard](globals/Clipboard.md) | copy and paste, which are not symmetrical |
| [Database](globals/Database.md) | a [`Record`](Record.md) over a table |
| [Day](globals/Day.md) | the calendar date, which is the value JavaScript does not have |
| [Decimal](globals/Decimal.md) | exact base-10 arithmetic, with the ordinary operators. **This is what money is.** |
| [Dialog](globals/Dialog.md) | asking the user for a file, a folder or a colour — with the desktop's own |
| [Dictionary](globals/Dictionary.md) | what a bag of data holds |
| [Directory](globals/Directory.md) | what is in a folder, and making and removing them |
| [Environment](globals/Environment.md) | the context the program was started in |
| [Exec](globals/Exec.md) | running another program, and reading what it prints |
| [File](globals/File.md) | reading and writing files, and the names of the paths they live at |
| [Hash](globals/Hash.md) | a checksum, of a string or of a file |
| [Http](globals/Http.md) | a native HTTP client, and a server of its own |
| [HttpServer](globals/HttpServer.md) | serving over the same transport, on the loop the application already runs |
| [Locale](globals/Locale.md) | the user's language, and their way of writing numbers, money, dates and names |
| [Logger](globals/Logger.md) | what a program writes down for itself |
| [Message](globals/Message.md) | telling the user something, with no question attached |
| [Record](globals/Record.md) | the shape data has, declared once |
| [Regex](globals/Regex.md) | a pattern, with nothing remembered between questions |
| [Screen](globals/Screen.md) | how big the desktop is, and how many pieces it is in |
| [Settings](globals/Settings.md) | what the application remembers between runs |
| [Stopwatch](globals/Stopwatch.md) | how long something took |
| [Text](globals/Text.md) | what a string measures, asked where there is no painter |
| [Time](globals/Time.md) | the clock half of [`Day`](Day.md), and the same bargain |
| [Timer](globals/Timer.md) | doing something later, or repeatedly |

### libraries/

| | |
|---|---|
| [Chart](libraries/Chart.md) | a chart, as a component: one class, and `Type` says which kind |
| [Markdown](libraries/Markdown.md) | a Markdown document, as a component |
| [Report](libraries/Report.md) | a banded report, as a component |

**A small class gets a short page, not a padded one.** `Label` has seven members
and `Button` has five: the sections a page has are the sections it needs, and the
two that are always there are the summary and the tables that explain each
member. What a page must never do is reach for filler to look like the page
beside it — the shape is a spine, not a form to fill in.

**The four lists came first on purpose.** They are the group people pick the
wrong member of, and each page carries the same comparison table so that whichever
one you land on tells you about the other three — four pages that agree rather
than four opinions.

**Both folders are written.** Every class the runtime registers has a page and so
does every global, and `tests/api.sh` ends with *0 more with members of their own
still to write*. A class or a global added from now on arrives with a page or the
check says so — counted rather than failed while it is being written, because a
check that went red for a page nobody has started yet is a check somebody turns
off before the week is out. What it refuses outright is a page that is **there**
and incomplete.

Eight globals are held to nothing but existing — `Message`, `Exec`, `Settings`,
`Timer`, `Stopwatch`, `Dictionary`, `Regex` and `Clipboard` — because they are
built in ways `tests/api` does not parse. That is written down in the check
rather than left to be discovered.

A library page is found by its class's **file name**, so a library that adds a
class is a page the check asks for with no list here to update — and a library
that ships with the runtime is part of the contract, since a project says
`uses: ["charts"]` and gets its classes.

**And this is what the IDE shows.** A `.md` opens in the IDE as the document it
is, so these pages are the help: F1 over a selected control lands on its page,
and over a property in the grid lands on the row that describes it.
