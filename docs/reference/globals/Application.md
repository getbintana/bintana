# Application

The running program: what it is called, where its files are, and how it ends.

## Every member

| | | |
|---|---|---|
| `Arguments` | whatever followed the project directory on the command line, as an array | [the project](#the-project) |
| `CheckSource(text)` | `null` when the text is valid JavaScript, else `{ Message, Line, Column }` | [asking about the machine](#asking-about-the-machine) |
| `Symbols(text)` | what the text declares — `[{ Name, Kind, Line, Parent, Super, Params, End }]`, out of the parser and with nothing run | [asking about the machine](#asking-about-the-machine) |
| `Globals()` | every name on the global object: the runtime's own, the ones a library installed, and the JavaScript builtins -- `Math`, `JSON`, `Date`, `Map`, `Timer`, `Confirm` | [asking about the machine](#asking-about-the-machine) |
| `ConfigDirectory` | `~/.config/bintana/<name>`, **created at startup**, which is where anything the application remembers belongs. [`Settings`](Settings.md) writes there; nothing of yours should go in the project directory, which is a thing people hand to each other | [where its files are](#where-its-files-are) |
| `DecorationLayout` | how this desktop arranges a title bar — which buttons, and on which side | [asking about the machine](#asking-about-the-machine) |
| `Directory` | the project directory, absolute | [where its files are](#where-its-files-are) |
| `Executable` | the `bintana` binary that is running this, so a project can re-invoke it — which is how the IDE runs a project and how the test runner runs the suites | [where its files are](#where-its-files-are) |
| `HasCommand(name)` | whether that program is on the PATH | [asking about the machine](#asking-about-the-machine) |
| `HasIcon(name)` | whether that icon will actually **draw** something | [asking about the machine](#asking-about-the-machine) |
| `Id` | from `project.json`: the application's identity in reverse DNS — `io.github.you.App` | [the project](#the-project) |
| `Icons([contains])` | every icon name available, sorted, narrowed by substring — what an icon picker is built from | [asking about the machine](#asking-about-the-machine) |
| `Libraries([project])` | the names of every library those same six places offer, sorted, each one once | [libraries](#libraries) |
| `LibraryPath(name, [project])` | where a library by that name is, or `""` — **the same six-place search the runtime does for `uses`** | [libraries](#libraries) |
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
| `Symbols(text)` | what the text declares — `[{ Name, Kind, Line, Parent, Super, Params, End }]`, out of the parser and with nothing run. **`Kind` is `"Class"`, `"Function"`, `"Method"`, `"Static"`, `"Getter"`, `"Setter"`, `"StaticGetter"` or `"StaticSetter"`**, or **`"Variable"`** (each `let`/`const`/`var`, destructured name, `for...of` variable and `catch` binding, at its line) and **`"Scope"`** (every function, anonymous ones included, with its `Params` and the lines it spans, `Line` to **`End`**; one that fails to parse spans up to where it broke) — together, what a name can mean where the cursor is — the member kinds are what separates `Value: T` from `Value(): T`, and a property of the class from one of the instance. **`Params` is the parameter list in the spelling a declaration uses** — `(message, [options], ...rest)`, `()` for a member that takes none, `""` for a class — for members and top-level functions, and **it is the function's own**: an arrow in its body or in a default value does not replace it. It is the one answer a host cannot get elsewhere, because ECMAScript discards a parameter's name at parse time and `Function.length` is a lower bound the moment one has a default. **`Super` is the name in a class's `extends`** and `""` for everything else, including an `extends` that is not a bare identifier. What an editor lists a file with, and the answer a pattern is not allowed to guess at |

**`Symbols` is `CheckSource`'s compile asked a different question.** `Kind` is
`"Class"`, `"Function"`, or one of the member kinds below, `Parent` is the class a method is in and
`""` otherwise, and the parser is the one that would run the file — so a
declaration in a comment or a string is not one, and a method is a method at any
indentation.

**`Params` is what a host cannot get any other way.** ECMAScript discards a
parameter's name when it compiles the declaration, so the function object keeps
the count and not the names, and the count is a *lower bound* the moment one
parameter has a default — `(a, b = 1, c)` reports 1. The parser has the names,
in order, with which are optional and which is a rest, and reports them in the
spelling a declaration uses — `(message, [options], ...rest)`, separated by
`, ` — with `""` for a class, `()` for a member that takes none, and a
top-level function's own list (`""` when it takes none). **The list is the
function's own**, whatever its body holds: an arrow in the body or a function
in a default value has a list of its own and does not replace it — which is
exactly what it did before, when `Ask(message, options)` with a
`map((x, y, z) => x)` inside reported `(x,y,z)`. A function whose list does not
parse is still listed, with what was read of it.

**`Kind` carries the ways of not being a plain method.** `Static`, `Getter`,
`Setter`, `StaticGetter` and `StaticSetter` were all `Method` before the parser
learned to tell them apart, and a reader that cannot say which is the
difference between `Value: T` and `Value(): T` — or, for `static get Fields()`,
between a property of the instance and one of the class.

**`Variable` and `Scope` are what a name can mean where the cursor is.** A
`Variable` is every declared name at its line -- a `let`, a `const`, a `var`, a
`catch` binding, each name a destructuring declares, a `for...of` variable -- and
a `Scope` is every function, arrows and function expressions included, with its
`Params` and the lines it spans, `Line` to `End` (`End` is 0 for every other
kind). An editor puts them together: the scopes that contain a line give their
parameters, and the variables declared inside them above it are the locals. A
function that does not parse is a scope up to where it broke -- which is where
somebody is typing.

**`Super` is what makes the answer a shape and not a list of names.** It is the
name in a class's `extends` clause, and `""` for a class that declares none,
for a method, and — deliberately — for an `extends` that is not a bare
identifier, which reports no name rather than a wrong one. It matters because a
class declared in a file the process never runs is a lexical binding and not a
class, so nothing can ask the runtime what it has: an editor reading a library's
source was offered the 2 members a class declares and none of the 66 it
inherits. A class that breaks in its own body still reports the supertype it
read before the break, and one that breaks *in the heritage* is listed with none.

Text that does not compile answers what the parser reached before
the error: an editor reads this while somebody types, and the complaint is
`CheckSource`'s to give. Nothing runs.

## Globals

| | |
|---|---|
| `Globals()` | every name on the global object: the runtime's own, the ones a library installed, and the JavaScript builtins -- `Math`, `JSON`, `Date`, `Map`, `Timer`, `Confirm`. **A top-level `class` is a lexical binding and not a property of the global object**, so a library's and a project's classes are *not* in it -- read those out of the sources, which is what the IDE does. It exists because the alternative is a hand-written list of global names, and there are a hundred and sixty-four of them |

`Application.Globals()` answers with **what is on the global object**: `File`,
`Directory`, `Locale`, `Timer`, `Message`, `Widget` and the rest of the runtime's
own, whatever a loaded library installed, and the JavaScript builtins — `Math`,
`JSON`, `Date`, `Map`, `Set`, `BigInt`. That set is the point: a caller asking
"what may a program write at the top level" wants all of it, and a curated subset
would be a list to keep.

**A top-level `class` is not in it**, and that is not a gap. `class Foo {}` at the
top level of a file creates a *lexical binding*, not a property of the global
object — so `Confirm`, `Chart` and a project's own classes are absent however the
library is loaded. **A caller that wants those reads the sources**: the IDE's
completion walks the project and every library its `uses` names, and parses the
class declarations out with `Application.Symbols`. Two roads because the runtime
publishes its own through one mechanism and a class through another.

It exists for that reason and no other. The IDE's completion used to keep **a
hand-written table of fourteen global names**, which was missing about eighteen —
`Printer.` and `Http.` completed nothing, and nothing said so.

## Libraries

| | |
|---|---|
| `LibraryPath(name, [project])` | where a library by that name is, or `""` — **the same six-place search the runtime does for `uses`**. Published so that a tool which opens *other* projects asks about theirs rather than keeping a second copy of the path |
| `Libraries([project])` | the names of every library those same six places offer, sorted, each one once. The other direction of the lookup: `LibraryPath` resolves a name you already know, this is what a dialog that offers a choice needs |

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
| `Quit(code)` | quit with that exit status. `0` is *it worked*, and a console tool that answers a question answers with this. A `code` that is not a number is **refused** — `Quit("fail")` used to exit `0`, which a runner reads as success. A `code` that is not a number is refused rather than read as `0`, which a runner would take for success; `Quit()` is `0` |

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
