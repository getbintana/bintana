# Application

The running program: what it is called, where its files are, and how it ends.

## Every member

| | | |
|---|---|---|
| `Arguments` | whatever followed the project directory on the command line | [the project](#the-project) |
| `CheckSource(text)` | → `null` if the text is valid JavaScript, else `{ Message, Line, Column }` | [asking about the machine](#asking-about-the-machine) |
| `Symbols(text)` | → what the text declares, with the line of each | [asking about the machine](#asking-about-the-machine) |
| `ConfigDirectory` | `~/.config/bintana/<name>`, created at startup | [where its files are](#where-its-files-are) |
| `DecorationLayout` | how this desktop arranges a title bar | [asking about the machine](#asking-about-the-machine) |
| `Directory` | the project directory, absolute | [where its files are](#where-its-files-are) |
| `Executable` | the `bintana` binary, so a project can re-invoke it | [where its files are](#where-its-files-are) |
| `HasCommand(name)` | → whether that program is on the PATH | [asking about the machine](#asking-about-the-machine) |
| `HasIcon(name)` | → whether that icon will actually **draw** something | [asking about the machine](#asking-about-the-machine) |
| `Id` | the application's reverse-DNS identity | [the project](#the-project) |
| `Icons([contains])` | → every icon name available, sorted | [asking about the machine](#asking-about-the-machine) |
| `Libraries([project])` | → the names of every library the six places offer | [libraries](#libraries) |
| `LibraryPath(name, [project])` | → where a library by that name is, or `""` | [libraries](#libraries) |
| `Name` | from `project.json` | [the project](#the-project) |
| `OnError` | assign `(message, stack) => …` to take over uncaught errors | [when something throws](#when-something-throws) |
| `Quit(code)` | quit with that exit status | [ending](#ending) |
| `Version` | what the **project** calls its release | [the project](#the-project) |

## The project

| | |
|---|---|
| `Name` | from `project.json` |
| `Id` | from `project.json`: the application's identity in reverse DNS — `io.github.you.App`. It is **one name in three places**: the window's own class (the runtime hands it to `GtkApplication` for Wayland and to the program name for X11's `WM_CLASS`), the `<id>` of the project's metainfo, and the Flatpak app id. `""` when the project declares none, which is an ordinary project classed by the program's name; a value that is not an application id **stops the program when the project loads**, because every one of those three is something nobody looks at until a dock shows the wrong icon |
| `Version` | what the **project** calls its release; `""` when it declares none. **`BTA_VERSION` is the runtime's** and is not this — showing the wrong one is what an About box does until it knows the difference |
| `BTA_VERSION` | **a bare global, not a member of this** — the runtime's own release as text, the one number `CMakeLists.txt` declares, and what `bintana --version` prints. It is here because this is where the confusion lives; a worker has it too |
| `Arguments` | whatever followed the project directory on the command line, as an array |

## Where its files are

| | |
|---|---|
| `Directory` | the project directory, absolute. What a relative path in a project resolves against — an image a report draws, a document a viewer opens, a data file that ships with the application |
| `ConfigDirectory` | `~/.config/bintana/<name>`, **created at startup**, which is where anything the application remembers belongs. [`Settings`](Settings.md) writes there; nothing of yours should go in the project directory, which is a thing people hand to each other |
| `Executable` | the `bintana` binary that is running this, so a project can re-invoke it — which is how the IDE runs a project and how the test runner runs the suites |

## Asking about the machine

| | |
|---|---|
| `HasIcon(name)` | whether that icon will actually **draw** something. Not whether the theme claims it: an icon that cannot be rasterised here is the same nothing as one that is missing |
| `Icons([contains])` | every icon name available, sorted, narrowed by substring — what an icon picker is built from |
| `HasCommand(name)` | whether that program is on the PATH. **The question that does not need an exception**, since [`Exec`](Exec.md) throws when the program is not there |
| `DecorationLayout` | how this desktop arranges a title bar — which buttons, and on which side. What a drawn title bar reads to look like the real one |
| `CheckSource(text)` | `null` when the text is valid JavaScript, else `{ Message, Line, Column }`. What an editor checks a file with before saving it, and the answer `new Function(src)` is not allowed to give |
| `Symbols(text)` | `[{ Name, Kind, Line, Parent }]`: the classes, methods and top-level functions the text declares, with the line of each. What an editor lists a file with, and the answer a pattern is not allowed to guess at |

**`Symbols` is `CheckSource`'s compile asked a different question.** `Kind` is
`"Class"`, `"Method"` or `"Function"`, `Parent` is the class a method is in and
`""` otherwise, and the parser is the one that would run the file — so a
declaration in a comment or a string is not one, and a method is a method at any
indentation. Text that does not compile answers what the parser reached before
the error: an editor reads this while somebody types, and the complaint is
`CheckSource`'s to give. Nothing runs.

## Libraries

| | |
|---|---|
| `LibraryPath(name, [project])` | where a library by that name is, or `""` — **the same six-place search the runtime does for `uses`**. Published so that a tool which opens *other* projects asks about theirs rather than keeping a second copy of the path |
| `Libraries([project])` | the names of every library those six places offer, sorted, each once. The other direction of the lookup: one resolves a name you have, the other is what a dialog offering a choice needs |

## When something throws

| | |
|---|---|
| `OnError` | assign `(message, stack) => …` and uncaught errors arrive there instead of ending the program |

For an application that wants to log them, show them, or keep going. A test
suite assigns it to fail loudly; the IDE assigns it to put the error in its log
with a link to the line.

**Two strings, and not the `Error`.** The name does not cross, so a `TypeError`
and a `RangeError` arrive the same, and there is nothing to re-throw. It is
enough to log and enough to show, which is what it is for; a handler that needs
to know *which* failure it was has to catch it where it is raised, since
matching on the message is the shape this language refuses elsewhere.

## Ending

| | |
|---|---|
| `Quit(code)` | quit with that exit status. `0` is *it worked*, and a console tool that answers a question answers with this. A `code` that is not a number is **refused** — `Quit("fail")` used to exit `0`, which a runner reads as success |

A window closing does not end a program by itself: what ends it is the last
window going and the main loop running out, or this.

## What goes wrong

- **An About box shows the runtime's version.** `BTA_VERSION` is not
  `Application.Version`.
- **A relative path found nothing.** It resolved against the *working directory*,
  which is where the program was started from; `File.Join(Application.Directory,
  …)` is what a project's own file wants.
- **Settings ended up in the project.** `ConfigDirectory`.
- **An icon is missing on one machine.** Ask `HasIcon`, and keep a fallback —
  the icon theme is the user's, not the application's.
- **`Exec` threw on a machine without the tool.** `HasCommand` first.

## See also

[`Environment`](Environment.md) · [`Settings`](Settings.md) ·
[`Exec`](Exec.md) · [`File`](File.md)
