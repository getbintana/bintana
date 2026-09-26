# Testing

```sh
./tests/run.sh                          # all six projects, 7157 assertions
./tests/run.sh widgets                  # one project
./tests/run.sh widgets record           # one test of it
./tests/run.sh ide designer             # one project, stopping after a phase of it
./tests/run.sh ide list                 # what it can be asked for
./tests/pack.sh                         # lib/package, the packaging step's output: 57 assertions
BINTANA=/other/bintana ./tests/run.sh
TIMEOUT=300 ./tests/run.sh              # a slower machine than the one this was written on
HEADLESS= ./tests/run.sh                # ...on your own screen; see below
```

**The suite runs on a virtual display by default**, and `HEADLESS=` — empty, not
`0` — is the way back to a real screen for the questions that need one. It used to
be the other way round, and the prefix was written first in every example here:
the runner falls back to `xvfb-run` only when there is **no** `DISPLAY`, which is
the CI case and never the desktop case, so the bare command on a machine somebody
is using opened the suite over their work and took the keyboard for a minute.
That happened five times, every one of them by somebody who knew the rule — which
is the argument for a default rather than a rule. `tests/asan.sh` had reached the
same conclusion first, and both now export `HEADLESS=${HEADLESS-1}`: with `-`
rather than `:-`, so that an explicitly empty one survives and the way back
works.

The second argument goes through to the project as its own second argument — the
first is always the runner's pid, which the projects use to name their scratch
directories. What a project makes of it is its business: `tests/ide` reads it as a
phase to stop after and `tests/widgets` as the tests to run, which is why the two
answer `list` differently.

The tests are **Bintana applications, not a harness**. Each one prints
`N passed, M failed` and quits with a non-zero status on failure; the runner runs
them under a per-project timeout and reports. A test project is a directory under
`tests/` whose `project.json` does not declare `main` — there is no list to add a
new one to.

**And the runner is one too.** `tests/runner` is a console project -- `"main"` in
its manifest, so it opens no window and needs no display, which is what lets it be
the thing that decides whether the suite needs a virtual one. `tests/run.sh` is
the ten lines of shell that cannot be: finding the binary and saying so when there
is none is the one job that has to work when the runtime does not, and a runner
written in Bintana cannot be what tells you that Bintana will not build. Past
that it hands over, and the binary it chose is the binary the runner reports as
its own -- there is no path passed down and nothing that can disagree about which
build ran.

**What the runner filters, it filters from the start of the line**, and that is
worth a sentence because the coarse version cost two full runs. GTK's portal
chatter and Mesa's complaint about a display with no GPU say nothing about the
runtime, so the runner drops them; matching those words *anywhere* in a line also
drops a test's own failure report, because `tests/ide` says what a check saw by
quoting the log view and the log view had `libEGL warning` in it. The summary
read `2 failed` with nothing above it naming them, and running the project
directly -- outside the runner -- is what showed the two lines existing all
along. A filter aimed at the toolkit must not be able to swallow what a project
says *about* the toolkit.

**And what the runner cannot fail on is a GLib critical.** The filter drops
warnings; a `GLib-GObject-CRITICAL` is *printed* and then counted by nothing,
because pass or fail is the child's exit status and a critical does not change
it. No script sets `G_DEBUG=fatal-criticals` either. That blindness is not
theoretical: `Split.Reorder` called `g_object_ref(NULL)` twice on a split with
one half, the reorder came out right, and two criticals went past on every green
run for as long as nobody read the output. **So read what a run printed, not
only what it counted** — and if you are touching reference counts, run it once
with `G_DEBUG=fatal-criticals` by hand.

**A sanitized build is not just slower, it is shallower.** The stack budget
`JS_SetMaxStackSize` sets is a number of bytes, and AddressSanitizer's frames are
about ten times fatter -- so the same budget that walks a hundred levels of widget
tree ordinarily walked ten under the sanitizer, which is the exact depth of the
IDE's own window. `tests/ide` was red there and green everywhere else for that
reason alone. The budget follows the build now, and `tests/widgets`'
`DeepSerialize` is the assertion that says so in whichever one is running.

The hang guard is `Timer.After` and `Kill`, which is where the shell's `timeout`
went. It sends SIGTERM and then SIGKILL five seconds later, to the child's whole
**process group**: killing `xvfb-run` alone left its X server orphaned to init
once per timeout, and the survivor held the output pipe open so the last of the
project's output was never read. See [`runtime-api.md`](runtime-api.md#exec). That timeout is a guard against a
hang -- an uncaught throw in `Form_Open` aborts before `Application.Quit` and the
project would sit there forever -- so it has to stay well clear of how long a
project legitimately takes: `tests/ide` drives the whole IDE and takes **4m45
here**, twice that under a sanitizer -- which is 95% of the whole suite's wall
clock, against 8.8 seconds for `widgets` and about 3 each for the other three, so
running the projects in parallel would buy nothing. The guard is 600 because it
was 300 and a passing run tripped it. `TIMEOUT=<seconds>` overrides it, and
`tests/asan.sh` raises it on its own. A guard set just above the real time makes a
slow machine look like a broken one. **And the runner prints what each project
cost with its result** — `== widgets passed in 9.0s` — so the next time that
guard needs measuring, the number is read off a run instead of remembered. There is no framework to learn: `check`,
`eq`, `neq` and `throws` are ten lines at the top of each project.

**Not the same ten lines, and it is worth reading them before writing a test.**
Each project has the helpers it needed and no others: `tests/ide` has `check`,
`eq` and `neq`; `tests/widgets` and `tests/markdown` have `check`, `eq` and
`throws`. Reaching for one a project does not have is not a red line, it is a
`ReferenceError` in the middle of a phase -- which reads as a hang, since the
phases after it never run and the window never closes. `check` and a `try` is
what a project without `throws` writes instead.

Everything needs a display, and that is deliberate: a test that does not go
through GTK proves nothing about a GTK binding. It does not need *your* display,
though — with no `DISPLAY` or `WAYLAND_DISPLAY` (`Environment.HasDisplay`, which
is a question about the environment and not about the runner, since the runner
never has one), it falls back to
`xvfb-run` (with the cairo renderer, since a virtual display is the least likely
place to have a GL context), which is what makes the suite runnable over ssh and
in CI: `.github/workflows/ci.yml` installs the dependencies plus `xvfb` and runs
`./tests/run.sh` unchanged.

## The six projects

| Project | What it covers |
|---|---|
| `tests/smoke` | The `.form` loader, event dispatch, the basic controls, nesting |
| `tests/widgets` | Containers, `Arrangement`, `HAlign`/`VAlign`, boxes and splits, a `Scroller` that **fills the room it is given and scrolls when it cannot** (`FillScroll`: the default `Fixed` slot leaving its content at its own size, and the same declarations arranged handing it the view's width and height, and then scrolling once the content asks for more than there is — which is the pair a missing container was reported for, and three of its assertions go red with the `Arrangement` taken away), `Notebook`, `RowList`, `TreeView`, both editors and the source one's search (including the offset/index crossing: `Offset`/`OffsetAt` in characters against `LineOf`, which converts a search's UTF-16 index exactly with the separator model GTK draws, and the same pair on `Text`), radio grouping, the value controls (`Slider`, `ProgressBar`, `DatePicker`, `Calendar` and its marks, `ToggleButton`, `Switch`), multiple selection, menu items that hold a state, drag and drop (the surface, since there is no synthetic pointer — the five feedback events installing, dispatching with the point, and a handler answering `false` as what a refusal looks like — plus the one thing *placing* a drop rests on, which is that a hidden child measures 0x0 at the origin rather than keeping its last rectangle), icons, `PropertyOptions`, a handler installed on the control itself (`On`: it runs, it replaces rather than accumulating, `null` removes it, the answer comes back, `this` is undefined, an event the class does not raise is refused, a second handler for one event refused at both doors that can make the pair -- `On` over a name and a `Name` over an `On` -- and a component built with `new` reporting to whoever holds it, which is the half the naming convention cannot reach), removing a child from every container and refilling it, **including that `Remove()` detaches on the six controls that used to answer to their own `Remove(index)`** — `RemoveRow`/`RemovePage`/`RemoveNode` now (`Removal`), a row's own application key (`Key`/`KeyAt`, `Add(text, key)`, and the four doors that keep a `ComboBox`'s keys in step with its model), renaming one in place (`SetText`), the double click from code (`Activate`) and bringing a row into view (`Reveal`, measured on a `RowList`, whose rows are widgets a `Bounds()` can be asked of; **an editable cell's own gesture is a pointer one and is on the by-hand list**, while `TableView`'s test holds the declaration and `CellEdit`'s veto — and `TableHeaderMenu` holds the heading's the same way: `HeaderMenu` as declared, its items bound, and `HeaderClick(column, button, ctrl, shift)` arriving with all of it, while the heading's own click is a pointer one), `Add` on a control that is already somewhere moving it rather than attaching it twice, and a container put inside what it contains refused rather than hanging (`AddMoves`), a container that keeps a proportion (`Aspect`: the ratio written four ways and refused three, one child and a second refused, and the two numbers that make it usable -- its minimum is its child's, and the child is the biggest rectangle of that shape that fits, centred, reshaped when the ratio changes while it runs), a surface that floats over a control (`Popover`: the open/close round trip with the two events it raises, `Visible` read-only and refused as a design property and never serialised, one child with a second refused, the four sides offered and a fifth refused by name, `Show()` and a popover in no container refusing, `Clear`/`Remove` on the content, and that a closed popover is not where the Tab walk stops -- `FocusNext()` answered `false` on a panel full of controls while GTK went on naming it), moving a child in every container that has an order and what an index means in each (`Reorder`: the same four moves asserted on a box, a `Grid`, a `Flow`, a `RowList` and an `Overlay`; `Placement` per class; a stack's base layer, which is `Children[0]` and the one that fills, through `Reorder`, `Raise`/`Lower` and the base being deleted; and a `RowList` row reordered **with the selection on it**, which has to survive the round trip through GTK's own remove and raise no event), what every numeric setter refuses (`NumericSetters`: a value past an integer, a `Columns.Width` that is a word, and the two named properties), a missing argument refusing with a sentence rather than an empty exception (`MissingArgs`: the fifteen members that returned `JS_EXCEPTION` with nothing set, and the painter's non-finite coordinates, which are refused by name), a path or `Save` text that is not a string refused instead of converted (`StrictArgs`, which also covers an `Exec` environment value and an HTTP header whose conversion fails), the serialiser round trip, a command several places point at (`Action`: the shared `Enabled`, and the four things a bound control refuses), `Record`/`Field` and records inside records (`Nested`: a list of them, a shape that contains itself, and a cycle refused rather than hung on), a record over a sqlite table (`Database`: the driver, `Table`, and the four ways a shape can fail to fit a table — **120 assertions with sqlite and one without**, since it is an optional build dependency and the claim there is that it says which package is missing), moving pictures and sound (`Media`: a `Video` played to its end and replayed, seekable once known, its frame measured and saved as a PNG, `Pause` holding a position, a node with declared properties round-tripping back to the same file, `Loop` still going past one length, `Buffering` reading `100` on a local clip that never waits for data (below 100 needs a server throttled under the bitrate, which is a measurement by hand and not a test), a missing file and an unreachable RTSP camera answering `Error` with a message that names the clip and a `kind` a form can branch on, an `AudioPlayer` cue played and looped — **and the properties still answering without GStreamer, where only the verbs refuse**, since the designer and the serialiser read every value of a control and must not depend on an optional build dependency. **The clips are generated with `gst-launch-1.0` into a temporary directory rather than committed**, the TLS certificate's bargain; where there is no `gst-launch` the parts that need a file are skipped, and where GStreamer has its base plugins but not the GTK4 sink — a CI runner, say — the video half skips and the audio half runs), `TextProperties`/`Locale`/`Fill` and design values (`LocaleRead`: a catalogue read as data -- the header as entry zero, a fuzzy entry kept flag and all, an untranslated one, a plural with its second msgid and every form, a context that is its own entry, comments as written, the `#~` tail as raw lines with a null msgid -- **and written back by `Locale.Write`**: *nothing lost* and *writing twice changes nothing*, the two properties the pair promises, plus the refusals a writer owes -- a path, an entry, a `msgid` or a form that is not text, and the whole text built before the file is touched so a refusal leaves the catalogue alone), the first real rectangle (`Allocated`: the `On` half and the named half, once each, the box against `Bounds()`, and a control on a hidden page hearing it when the page is shown), the curated language (`CuratedLanguage`: the removed names absent, `RegExp` among them and `RegExp.prototype.constructor` with it -- so a literal cannot hand the constructor back -- and `Regex`'s `Unicode` flag doing what `\p{L}` and an emoji need; `CheckSource`'s line and column, which no `Error` setting can move; and **`Application.Symbols`**, the classes, methods and top-level functions with their lines -- a nested function not reported, a comment and a string producing nothing, a getter and a setter as two, a namespaced class expression named by its own name and an anonymous one by the assignment, and source that does not compile answering what the parser reached), `Locale.Compare` and `Locale.Matches`, `Day`, `Stopwatch`, `Exec` and its `Stop` (including a `Control` line that arrives two seconds after the child has ended -- dropped, where it used to complete into a freed job and crash CI, and two seconds because at a third of a second the assertion was a bet on how long `Form_Open` still had to run under a sanitizer; stdin written to a filter and closed, which is what makes `sort` answer -- `Exec.Wait`'s `Input` and the handle's `CloseInput`; 300 KB written into a `cat` that echoes it, which used to hang the program; `Timeout` and `Stop()` reaching a grandchild that holds the output after its leader exited; a child that quits with `Printer.Send`'s dialog still open and ends with 0 rather than an abort -- and that **a NUL does not end its output** -- `Exec.Wait` was built on a call that hands back a C string, so `git status -z` read one record and lost the rest), **a program run under the debugger** (`testDebugger`: `bintana --debug` through `Exec`'s `Control` and `Write` -- a breakpoint armed, the program stopped on that line, the stack naming the frame and its caller, an argument read by name out of `vardefs`, `this` among them because the vendor patch gave the frame a slot for it, and a `let` before its declaration correctly absent. It is also what guards that patch: without the hook in the interpreter nothing ever stops and the build is fine), **and what a stopped program can be asked** (`testDebuggerAsks`: a conditional breakpoint that stops on the one turn its test holds, a `const` of the stopped frame and a `let` of the caller's read by name -- which a direct eval cannot reach and is why the runtime compiles the expression as a function of the frame's own names -- an expression that throws answering its message instead of failing, a value written back reaching the program's own arithmetic, and a stop on the line that threw with the frame that built the failure still alive), a `File.Watch` that stops itself, a form shown narrower than it was drawn, **a shown form the runtime holds** (`FormKeepalive`: one closed and one left open with nothing in JavaScript pointing at either — the two roads the drop and the teardown sweep take, since the collection itself is not forceable from here), the `Grid`, what this build can run and what it merely *has* (`Available`: an ordinary control, an abstract class, a component of the project, a name that is no class at all — and `Terminal` either way, **with a branch for each**: with VTE the pty, the pattern and the scrollback; without it the state still answering, a `.form`'s `LinkPattern` still round-tripping, and `Run`/`Stop`/`Kill` refusing by name, since a build with no pty must still be able to draw and save a form that has a `Terminal` in it — and `Video`, whose answer is **asked of the machine** (GStreamer's registry, and the GTK4 sink in it): the class and the instance are asserted to agree, and the palette phase in `tests/ide` is what holds the two directions of `Available` against the buttons), **how a class is asked what it has without building a control** (`ClassIntrospection`: every class query against the same answer its instance gives — properties, methods, events, prose and options — with an abstract class answering, a project's `Stepper` resolved by its qualified name and answering differently from the root one, `Member` telling a property from a method from a read-only name, and a name that is no class refused) and **the parameters a member declares beside itself** (`Signatures`: a method's comment, an event's, an override answering its own where the ancestor answers another, a project class's `static Signatures` inherited by its subclass, and `null` for a name that declares nothing), the CSS node of every control, a library's native half (`Plugin`: a real shared object built by CMake from `tests/plugins/testplug.c` and loaded through `uses`, every verb of the callback table driven through it -- a global installed, text, numbers, objects, arrays and an error JavaScript catches, **a JavaScript function the plugin calls back** -- with its error reaching the caller and a non-function refused -- the declared arity padding a missing argument with `undefined`, the library's `.js` running after the `.so`, `cleanup` at teardown, and the loader's two refusals: a plugin claiming another ABI and a shared object with no entry point, each stopping the program and naming the file -- plus `testplug-abi1`, the same source compiled against the **frozen version-1 header** in `tests/plugins/abi1/`, which is what catches a field reordered in the host table without the number moving), the clipboard both ways round, in both currencies (`Clipboard`: a copy comes back; an image goes on as `Bytes` and reads back as a 120x80 `Picture`; text where there is an image is `""` and an image where there is text is `null`; and what it refuses — a string, no bytes, bytes that are not an image, and a paste with no callback), a `DrawingArea` rendered without a screen (`Save` into a PNG, and `Dump` asserted call by call; `Print` to a PDF with no dialog, the range and the copies answered back, the refusals, and no half-written file when a page throws — the dialog itself cannot be clicked by a test and is checked by hand), XML documents (`XmlFiles`: `Available` first, since libxml2 is optional; parsing, entities, attributes — **and the namespaced ones**, which is how `xml:lang` is spelled: `SetAttrNS`/`AttrNS`/`RemoveAttrNS` round-tripping through the writer, `Attr("lang")` answering `null` for `xml:lang` because an unprefixed name means no namespace, `AttributeNames` still listing the local name, and an undeclared namespace refused by URI —, the namespace resolved, `Find`/`FindAll`/`Children` in file order, building and the copy-in-another-tree rule, a removed node refusing to answer rather than reading freed memory, the orphan list kept by the node and not by the wrapper (a node removed through two wrappers, a child added back after a `Text` assignment, a detached root moved under its own orphan — each a double free at teardown that only `tests/asan.sh` reports), `SetNamespace` twice and a clashing declaration refused in words, the canonical shape with its declaration and its kept comment and its escaped ampersand, the error naming line and file — and a worker parsing one, asserted in `testTask`), and a record over it (`XmlRecord`: `Field.DateTime` with a zone kept as written, and a range refused beside one rather than ordered wrongly; `static Xml`, `attribute`, `in`/`element` and the three verbs — `ToXml(true)` writes every field where `ToXml()` leaves the defaults out; `LoadXml` reads a field by its `as`/`Naming` spelling and not by its property name, is lenient, and says what it did not model with the path in each sentence — an unknown element or attribute, and also child markup, an attribute or a repetition inside a scalar, which are three things it is not taking — checks the root and the namespace **list**, and leaves a value the setter refuses at its start; `SaveXml` in place — a comment, an unknown element, an unknown attribute and an unknown child all untouched while the record's own edits land, a list reconciled by `key` with one item removed and one added, **a key at its default matched and kept** (`UID 0` beside an unmodelled child: the element is not replaced, the key is written, and a non-key default of the same element is still removed, while `ToXml()` writes a default key too), a new item of a list with no `in` placed after the last one of its name, or where the declaration puts it, rather than at the end of the record's element, and an emptied list taking its wrapper with it — plus a round trip through `File.SaveXml`/`File.LoadXml`), `File`/`Directory`/`Exec` (including a line appended without reading the file back, and `Logger.Target` set to a path), **the application's own identity** (`ApplicationId`: a child project with an `id` answers it through `Application.Id`, one without answers `""`, and one whose id is not an application id **stops the program** naming it — which is the half a window's class depends on, and the reason the rule is not left to the desktop to discover), **the user's own menu entries** (`Desktop`: an entry installed into a scratch `XDG_DATA_HOME`, read back and removed — **and `Write`, the same entry at a path the caller names, making the directory**, which is the half a packaging step uses, since the entry a package installs is not one this user's menu has; every refusal the runtime makes — an id that could be a path, a group that is not a `[Desktop Entry]`, an application with no `Exec`, a value that is not text; and then the one thing a file comparison cannot say, which is that the desktop's own reader understands it — `gio launch` runs the entry against a script that dumps its arguments, and a space, a percent, a double quote, a dollar, a backslash and an accent all come back exactly as they went in), an HTTP client against servers of its own on 127.0.0.1 (`HttpWait`: the blocking spelling, the verbs, a built upload, the stub without libsoup; `Http`: the callbacks, every verb echoed, a multipart framed and reposted, Basic auth, `Accept-Language`, no proxy, a jar that sends back, a proxy proved by transit, tuned pools, redirect, cancel and guard, and two requests in flight with one of them stopped — each callback handed its own handle, which is what lets a form drop the answer to a request it replaced), an answer read **as it arrives** (`HttpStream`, against a server that dribbles a line every fifth of a second: the first line asserted under half a second **and** the last one more than half a second after it, since without the second half a server that answered all at once would pass; the blank line that separates two SSE events arriving as `""`; a CRLF feed with no carriage return left on it; an error page that comes back whole with the line callback never called; a stream stopped from **inside** its own line callback; a guard that cuts one with what already arrived kept; and a streamed `POST`, which is how a completions endpoint talks) a handler that replaces itself mid-request and reads a captured variable afterwards, which was a use-after-free under ASan (`HttpServerSwap`), and a handler that answers and then stops its own server, which used to cut the answer (`HttpServerStop`), and serving over the same transport (`HttpServer`, dogfooded through the client: ephemeral port, echo, `404`, silence is `500`, `Stop` true then false; `Allow`, `Auth`, uploads parsed back, and `Tls` probed over real HTTPS — **the three HTTP tests need `python3` for the servers the client is aimed at, and the TLS step also needs `openssl`, which makes its own throwaway certificate into a temporary directory rather than keeping one in the tree; each is skipped, not failed, where the tool is missing**) |
| `tests/report` | `lib/report`: pagination, the group ladder, the totals, the masthead, the bands that grow, the PDF, printing it with no dialog, `Page` and a paper change pulling the page back both raising no `Page` (a setter must not raise an event), a band taller than the page warned about once through `Logger`, and the five regressions the library shipped once, and a margin side that is not a finite number refused; `Min`/`Max` over numeric text, mixed kinds and names, and a `Decimal` group key (`testExtremes`). **It also holds `lib/charts`' own regressions** (`testCharts`, which is why the project `uses` both): gaps in a line and an area drawn as gaps rather than throwing, `YMin`/`YMax` refusing a non-number, a range wider than a double, a stacked `Line` turned `Bar`, a pie with a zero keeping its indices, a decimated stack's second band on the first, a wheel over the whole series not consumed, a lone slot centred, and the hover on a stacked `Area` finding the band under the pointer and marking the top of it — each seen red against the library before the fix |
| `tests/markdown` | `lib/markdown`: what the parser makes of each block, the markup a paragraph is drawn as, the pictures (including the one that is not there), scrolling and `ScrollTo` (an assignment to `Scroll` raising no event and a key raising one), anchors in any script and deduplicated (`setup`, `setup-1`), a delimiter row with the wrong cell count not making a table, an intraword `_` closing nothing, a tab indenting a nested item, the export at the width it was asked for, and a pagination that cuts between blocks and never through one. **The selection and the links are asserted on the words and on the frame**: what a drag covers, what a double click takes, that the highlight is painted behind the text and that an export carries none, that a selection survives the column changing under it — which is what it is a pair of offsets for — and, for a link, that a click follows it, that a click past the words follows nothing, that a drag is not a click, and that an anchor nobody claimed scrolls. It also loads `examples/markdown/Guide.md`, so the library's shop window is read by something Margins that leave no room on the sheet are refused by `SavePdf` rather than hanging it, and a side that is not a finite number by the setter. |
| `tests/qr` | `lib/qr`: the encoder against numbers from outside this code — the Reed-Solomon codewords of the standard's annex I example (`01234567` at 1-M) and of the "HELLO WORLD" 1-Q every tutorial walks through, the fifteen-bit format strings and the eighteen-bit version strings of its tables, the data capacities of table 7, and the famous 40-L limits (2953 bytes, 7089 digits, 4296 alphanumerics) at the boundary and one past it — plus the function patterns where the standard puts them, `Bytes` encoding to the same symbol as the text, the refusals, and the SVG and block-character outputs. **The masks the penalty rules choose for six inputs are pinned**, each checked against Project Nayuki's reference, because the zigzag and the wrong cells still make a well-formed symbol that does not scan: a rewrite of section 7.8.3 goes red instead of changing every code in silence. The view is asserted off `Canvas.Dump()` after a synchronous `Save()`: whole pixels a module, centred, black on white because the theme did not get a say, and one fill for all the dark modules |
| `tests/ide` | The IDE itself, driven the way a user drives it — including **F1 and the reference window** (`help`): which page each of the three answers picks, that the window lands on the member, that a link between two pages is followed and that Back goes back — and **installing the project as a user application** (`apps`): the menu item, the dialog, the id a name slugs to, an entry that points at this executable and this project, a rename that moves the file instead of leaving two, and an uninstall that leaves nothing. The runner points `XDG_DATA_HOME` at a scratch directory, so the entry is not one anybody's menu will offer Three phases hold what the IDE writes back: `foreign` opens a Latin-1 `.js` and `.form` and drives every road that writes a tab -- save, save all, a source rewrite, a recovery snapshot and its restore, a reload -- asserting the bytes did not move (and that a UTF-8 file holding U+FFFD is an ordinary tab); `prefixes` renames `Btn` beside a `Btn_Ok` and back, so a handler is only ever its control's name plus one of its events; `background` renames a form and a class a form places while that tab is behind another, and saves it. The `git` phase also discards `data[1].json` beside `data1.json` (a path, not a glob) and an untracked folder, reads an `RM` record on both sides of the Changes window, and pushes a new branch with two remotes only after asking which; `recovery` holds an offer nobody answered through a tick and a door out; `forms` deletes on a filesystem with no trash (faked) only after a second question, and says rather than throws when that delete fails. |

**A shipped library is held to its page the way the runtime is.** `tests/api.sh`
proves `docs/llm/report.md` documents everything `Report` publishes; it cannot
prove any of it is true, and for a library that draws, *true* is what the reader
needs. `tests/report` -- and `tests/markdown`, which is the same shape -- is the other half, and its shape is the reusable part:
`Save()` runs the same `Canvas_Draw` synchronously against an image surface, so
`Canvas.Dump()` on the next line is **that page's** calls — which is how a banded
document is asserted page by page with no screen and no waiting for a frame,
which would only ever show the current page. Off that dump it reads the words
that landed, the font each one was drawn in, and the transform the page was
placed with.

Two of its assertions are worth knowing about because they are not obvious. The
font in force for a run is the last `Font` line before its `Text` line, which is
how "one band's `Bold 18` leaked into every row under it" becomes something a
test can say. And **a frame that ran to the end is proved by the dump**, not by
`Save()` returning: the clip it opens and the `Pop` that closes it are in the
dump, and a frame that died halfway has neither. That assertion was written when
a throwing `Draw` could not be seen from outside at all; `Save` and `SavePdf`
fail now (`bta_emit_ok`), and the dump is still what tells a frame that finished
from one that merely did not throw.

`tests/ide` loads the **real** `ide/**/*.js` — its `project.json` points at them — and
its `.form` files and `icons/` are symlinks to the IDE's own, so the two cannot
drift. A change to the IDE that breaks the IDE breaks this test.

## Running part of it

Both large projects can be asked for a part of themselves, and **they mean
different things by it**, because they are different shapes of test.

**An uncaught error in a handler is a failure.** The runtime prints one and
carries on -- right for an application, wrong for a suite -- so the driver takes
them over with `Application.OnError` and counts each as a failure with the place
it came from. It was added the day a window shipped throwing six of them into a
run that said *0 failed*: every assertion the phase made was true, and the
window was broken.

`tests/ide` is forty-five **phases**, each a generator with a scope of its own,
listed in `PHASES` at the bottom of `Driver.js`. `./tests/run.sh ide <name>` runs
every phase up to and including the last one whose name contains `<name>`:

```
welcome files designer palette clipboard taborder completion handlers events
goto images watch tooldirs namespaces selfns views document help forms nested projects
menus folders strings settings columns export apps errors problems names
outline check quick recovery unsaved session search git debug launch running
```

`unsaved` is the one about losing work: every road that used to drop typed
text without asking -- Close all and Close others, leaving the project,
writing a handler or renaming a control into a `.js` with unsaved edits,
renaming a form with its `.js` open -- and the recovery snapshot a clean close
or a discarded project leaves behind.

`./tests/run.sh ide list` prints that list, which is the copy that cannot go
stale; the one above is here to be read.

The saving is the point of it: `welcome files` is **102** assertions and
`designer` **365**, against **2594** for the whole project — measured at 3.7 s,
9.0 s and 242 s on the machine this was last run on, where what carries over to
another machine is the proportion and not the seconds. Iterating on an early
phase stops being minutes a time.

**It runs a prefix, not a selection**, and that is not a limitation to be fixed
later — it follows from what the test *is*. The phases are a narrative: each one
works on the project the ones before it built, renamed and edited, so a run can
stop early but cannot start late. Making them independent would mean each building
its own fixture, which is a different and much larger test.

**And a phase that opens a project goes through `openFresh`**, not through
`ide.openProject`. Since `Session`, opening a project gives it back the tabs it
was left with — so reopening the temporary project in the middle of a run would
drag the previous phase's strip along, and three phases assert what a fresh one
looks like. `openFresh` closes the tabs and forgets the remembered sessions
first, which is what a first open really is; it also keeps one run of the suite
out of the next one's settings, since `examples/hello` and `ide/` are the same
two paths every time. The `session` phase is the one that must *not* use it.

A partial run says so — `ide: 365 passed, 0 failed  [only welcome, files,
designer]` — because a green line that reads like the whole suite when eight of
a phase never ran is the worst thing this file could print. The same reason
`run.sh` exits 2 on a project name that matches nothing, instead of passing
without having tested anything.

One consequence worth knowing: only the `running` phase used to end the run (it
reports from the child's exit callback), so a run that stopped before it reported
nothing and hung until the timeout — which reads exactly like a frozen test.
`drive` now reports when the generator finishes, and whoever ends the run on its
own says so with `reportsItself`.

### tests/widgets selects

`tests/widgets` is 162 tests listed in `TESTS`, and a filter there **selects** rather
than running a prefix — `./tests/run.sh widgets record` is 140 assertions
against 4061 in about eight. It can select because these tests are
independent: each builds the controls it needs and deletes them again. The two that
are not say so in the file:

- `Serializer` runs first and stays first: it has to see the form exactly as the
  `.form` left it, and everything after dirties it.
- `Exec` is the asynchronous tail — it reports and quits — and what it checks
  includes what `Terminal` and `TimerShorthand` left behind, since a terminal's
  text is only readable a beat after being fed and a timer has to have fired. So
  `NEEDS` pulls those in both directions: asking for the tail brings them, and
  asking for either of them brings the tail that finishes them. Without the second
  direction, `run.sh widgets terminal` answered with half of the terminal's
  assertions and looked complete.

Two things filtering exposed, both of which had been unreachable:

- `checkTimers` reads what **`TimerShorthand`** sets, not `testTimer` — the filter
  `timer` matched both by substring and hid it. Asking for `terminal` did not, and
  the run died in an async callback where `Form_Open`'s try/catch cannot see it.
- `finish()` swept the scratch directory unconditionally, and listing one that was
  never created throws — from inside the catch that calls `finish()`, so the run
  reported nothing and waited for the timeout. Cleanup that fails must not sink the
  report.

Both are the same lesson: **a path the suite never takes is a path nobody has
tested**, and running part of a test suite takes paths the whole one does not.

## What a test has to prove

**Make the round trip.** Assigning `TextBox1.Text` from JS has to reach GTK, come
back as a real `changed` signal, and land on `TextBox1_Change`. Asserting that a JS
property remembers what was assigned to it proves nothing about the binding:

```js
this.TextBox1.Text = "hi";
check("assigning Text raises Change", this.changes > before);
```

**Drive the UI, not the model.** `tests/ide` selects in the tree by setting
`FileTree.Key`, presses buttons with `Btn.Click()`, chooses menu items with
`Mnu.Click()`, and clicks the canvas through `Glass_MouseDown(x, y)` — the same
handlers the runtime would dispatch. The palette is exercised by clicking its real
buttons:

```js
palette(ide, "CheckButton").Click();
```

**Compile what was rewritten.** After the IDE edits a `.js`, `new Function(source)`
is the only honest way to claim it is still valid JavaScript.

**Assert against the layout, not against arithmetic.** Where a control ends up
inside a `Frame` is the theme's decision, so the test asserts that the real position
differs from the naive sum — if they matched, the test would be proving nothing.

## Two things that will bite

**Wrap `Form_Open` in try/catch.** An uncaught throw aborts `Form_Open` before
`Application.Quit` is ever reached, and the run hangs until the timeout instead of
failing with a message.

**Anything that depends on layout needs a frame first.** `PickAt`, `OriginIn` and an
unset `Width`/`Height` all read GTK's allocation, and a widget just created — or one
whose container was just made visible — has none until the main loop runs again.
`Form_Open` itself runs *before* the window is presented.

`tests/ide/Driver.js` is a generator for exactly this: each `yield` hands control
back to GTK for a frame.

```js
ide.openNamed("Form1.form");
yield;                       // hand GTK a frame
```

**One frame is not a promise.** GTK does not have to have allocated anything by
the next turn of the main loop, and under load it often has not — which is what
made a handful of these tests fail once every few runs on a busy machine. Never
count frames; wait for the thing itself:

```js
yield* until(() => ide.designer.rectOf(button).w > 0);   // a specific fact
yield* settled(ide);                                      // the layout stopped moving
```

`until(cond)` polls a frame at a time and gives up after thirty, so a genuinely
broken expectation still fails with real values rather than hanging.

**`tests/widgets` has an `until` of its own, and a waiting test has to be
counted.** It is callback-shaped rather than a generator — the assertions that
depend on the wait live inside it — so a condition that never comes true does not
fail loudly: it pushes its failure two seconds later, by which time the run has
reported, and the assertions inside it simply never ran. The total comes out a
few lower than the day before with nothing red to explain it. That is how a whole
block of `testWindowState` sat unrun for as long as it did, and why the sanitizer
— slow enough for the timeout to land first — is what finally showed it. `until`
counts what is outstanding now and `finish()` refuses to report while anything
is, so the silence is a red line again.

`settled(ide)` waits until two consecutive frames report identical geometry. Use
it around anything that reads **drawn** geometry, which is more than it sounds:
`align` works off the inset (drawn size against requested size) and `distribute`
off drawn positions, so driving either before the layout has settled measures the
previous frame and moves controls to where they used to be — *before* the call as
much as after it.

That distinction found a real mistake. `align left moves the others to the
anchor` asserted that two controls ended up with the same `X`; it only passed
because the insets had not been measured yet and both came back zero. Aligned
means the same *drawn* edge, and a Frame and a Label need requests one pixel
apart to get there.

The driver also waits for the first allocation before starting at all, by polling
`FileTree.Width` (a widget with no size of its own reports zero until GTK has
allocated the window).

## The public surface, which the suite does not cover

```sh
tests/api.sh
```

`docs/llm/controls.md` is meant to be the **whole** public surface: an application
author should never have to open `runtime/src` to learn whether a property exists.
`tests/api` is what makes that a claim rather than a hope — a console project that
parses the `JSCFunctionListEntry` tables and every `bta_emit` call, and fails when
a member has no row in the reference, or when an event is documented with a
different number of arguments than the runtime passes.

It parses rather than links, so it answers when the runtime does not build, which
is the same bargain `tests/icons` and `tests/styles` make. 275 widget members and
45 events as this is written, plus 11 class statics, 254 on the globals and 80
published by `lib/` -- the numbers `./tests/api.sh` prints, and every one of them
has been stale at some point in this repository.

**The class statics are read from where they are installed**, which is the hole
this had: `Widget.New`, `Types` and `Available` are built by
`JS_SetPropertyStr(ctx, ctor, …)` and are in no `JSCFunctionListEntry` table, so
the member scan could not see them and neither could the typings check. They are
public, the IDE calls them, and nothing would have failed had any of them lost
its row. Every one of them now needs a `` `Widget.Name(` `` row in
`controls.md` and a `static Name` in `bintana.d.ts`.

**And every method and event declares its parameters**, which is what makes a
signature a fact instead of a sentence: a one-line comment above the C entry (or
above the class row for an event) is turned by the build into the table
`Widget.Signature` and `Widget.EventSignature` answer with, and the check fails
on a method or event with none. It also compares the parameters in
`controls.md`'s long pages and in `bintana.d.ts` against what the runtime
answers — the same rule the event arity has always had, one step further. The
`.d.ts` gained real signatures out of it (`Bounds(container?: any)` where it used
to say `(...values: any[])`), and the first run found five events whose comment
had borrowed a same-named method's parameters: `ListBox.Select` is a method
*and* an event, and the two are asked about separately.

**The globals are held to the same rule**, against `docs/llm/library.md`, and
they were not until it was written: a table that was not a widget's was exempted
from the `controls.md` check and *nothing asked anything else*, so 46 members of
`Locale`, `Decimal`, `Connection`, `Log` and `Day` were documented by hand or not
at all. It reads both shapes the runtime builds a global with — a
`JSCFunctionListEntry` table and a run of `JS_SetPropertyStr` — and it found
three real gaps the day it was written: `Application.LibraryPath`, which the IDE
calls, and `Decimal`'s `toString` and `toJSON`. It has gone on earning it:
`Application.Libraries` was added to the runtime for the project dialog and the
check named it as undocumented before any test of it had been run. Which globals those are is an
explicit list in `tests/api/Check.js`, because the same C shape builds half the
runtime's *return values* and a scan that guessed would demand a heading for
every one of them.

**And `docs/reference/widgets/` is held to a stricter one.** A long page
documents the same members as `llm/controls.md` with a real explanation of each,
so the check asks for every member **twice**: once in the page's `## Every
member` summary — the index somebody scans — and once outside it, where it is
explained. A member listed and never explained is a long page quietly turning
back into a short one; a member the summary forgot is a reader concluding the
control cannot do it. Which members belong to which class is read out of the
class registration in the C (`BTA_CLASS_ENUM_TEXT("TableView", …, table_props,
…)`), so there is no list here to fall behind. A class with no page at all is
**counted, not failed**, and the run ends with how many are left.

`docs/reference/libraries/` is held the same way against the Bintana source of
each shipped library — a page is found by its class's file name, so a library
that adds a class is a page the check asks for with no list to update — and
`docs/reference/globals/` against the C tables and the
object-building runs `checkGlobals` already reads — one line per page in
`GLOBAL_PAGES` saying which of them make it up, which is the same discipline
`GLOBAL_TABLES` has and for the same reason. The eight globals built in ways this
does not parse (`Message`, `Exec`, `Settings`, `Timer`, `Stopwatch`,
`Dictionary`, `Regex`, `Clipboard`) have pages held to nothing but existing, and
the check says so in its own comment rather than leaving it to be discovered.

**The libraries in `lib/` are held to the same rule**, against
`docs/llm/<library>.md`. They ship with the runtime, so a project reaching one
with `uses` is using a public API and not reading somebody's example: the check
reads what a library publishes out of the Bintana -- accessors and methods with
a capital initial, `static Events`, and the arity of each `Emit` -- and reports a
library with no reference page at all before anything else. Five ship --
`lib/charts`, `lib/markdown`, `lib/package`, `lib/qr` and `lib/report` -- and
[`llm/charts.md`](llm/charts.md), [`llm/markdown.md`](llm/markdown.md),
[`llm/package.md`](llm/package.md), [`llm/qr.md`](llm/qr.md) and
[`llm/report.md`](llm/report.md) are their pages.

**The event arity is the half worth having.** A missing row is obvious the first
time somebody looks for it; a signature that is confidently wrong is not.
`MouseWheel` was written `(dx, dy, ctrl, shift)` in three documents and passes
two, for as long as nobody counted.

**`tests/api.sh` runs in CI**, which the other four scripts do not: it parses C
and Markdown, opens no window and costs a second, and every claim it checks is
the kind that rots without looking rotten.

**It asks the question the other way round too**: the checks above ask whether
what exists is written down, and the link check asks whether what is written
down still exists. `docs/issues/ISSUE-printing.md` was deleted the day printing
arrived and two pages went on pointing at it, still saying there was no printer
in prose that read as current -- while the bookkeeping in
`docs/issues/README.md` was updated by hand. Code spans are taken out first, so
`` `[text](href)` `` in a table of Markdown syntax is prose about the format and
not a link; a `.md` under `examples/` is that project's own data and outside the
scope, which is what lets `examples/markdown/Guide.md` point at a picture that
is deliberately not there.

## The declarations an editor that is not the IDE reads

```sh
tests/typings.sh                    # the runtime, and the IDE's own forms
tests/typings.sh examples/clients   # ...and that project's too
```

`tools/typings` writes `tools/typings/bintana.d.ts` -- every class and global the
runtime publishes -- plus a `forms.d.ts` and a `tsconfig.json` per project, so
**VS Code works on a Bintana project with nothing installed**: completion, go to
definition and hover. The argument, and the measurements that shaped it, are in
[plans/completion-plan.md](plans/completion-plan.md).

Three things about it belong here.

**It is a form project run headless**, and it is the one desk tool in this tree
that cannot be a console project: its whole method is to ask a real control what
it has, and `Widget.New` refuses without a display -- *"a project with a `main`
has no display, so it cannot make widgets"*.

`bintana.d.ts` is **installed**, beside the libraries rather than with the docs,
because it is read by a tool and not by a person: a project outside this tree
points its `tsconfig.json` at `<prefix>/share/bintana/bintana.d.ts` the way a
project names a library with `uses`. `tests/install.sh` asks for it by name.

**`tests/api.sh` holds the generated file to the runtime**, which is what makes a
generated file worth having rather than a stale one nobody notices: every member
the C declares has to appear in it, by name, or the check fails saying which and
telling you to run the generator. It earned that the hour it was written --
sixteen read-only properties were missing (`Children`, `Focused`, `Line`,
`Column`, `CanUndo`, `Selection`, `ScrollMaxX` and nine more), because
`PropertyNames()` answers *what a property grid can set* and a declaration file
wants the other ones too. It also checks `ide/forms.d.ts` against the `.form`
files under `ide/`, which goes stale a different way: not when the runtime gains
a member, but when somebody draws a control.

**And the last step of writing it is running `tsc` over what came out**, which is
the cheapest check it has and found two duplicate identifiers that nothing else
would have: `Record` collides with TypeScript's own `Record<K, V>`, and `Marks`
is a read-only property on a `Calendar` and a method on a `SourceEditor`. That
step is by hand -- TypeScript is not a dependency of this repository and is not
about to become one for a check that runs when somebody changes the generator.

## Two reproductions kept by hand

`tests/manual/` holds two standalone C programs. Neither runs in the suite and
both earned their place by settling a question the suite could not:

| | |
|---|---|
| `cairo-cost.c` | what a frame of drawing costs, per figure and per point, straight against cairo. It was written before there was any binding to measure through, and it is what says the cost is in **covered pixels** -- 5,000 points as a readable curve 2.15 ms, the same 5,000 as a zigzag 109 ms. The numbers are in [widgets.md](widgets.md#drawingarea-and-painter) |
| `completion-popover.c` | sixty lines of plain GTK, with `gtk_source_init()` on one line that can be commented out, which is the shortest demonstration that the completion popover's collapse is a **missing initialisation** and not a bug in whatever provider is loaded. Being plain GTK with no `GApplication` of its own, it also shows that *where* the call goes matters |

Both are compiled by the comment at the top of each file. They are kept rather
than deleted because the question each answers comes back: the first every time
somebody proposes drawing more points, the second every time a popover misbehaves.

## Icons, which the suite cannot judge

`tests/icons.sh` checks every `Icon` declared in a `.form` against the icons this
desktop really has, **without a display**: it reads the theme and what it
inherits off the disk, adds the symbolic set GTK4 embeds in its own library, and
adds whatever the project ships in `icons/`.

**And whether the file it found will actually draw**, which turned out to be a
second question and not the same one. GTK 4.20 replaced the librsvg path for
symbolic icons with a parser of its own, and that parser does not apply
`transform` — so a theme that positions its artwork with one draws every such
icon outside its own box. elementary-xfce does it in 120 of its 258 symbolic
icons: the file is there, the name resolves, `Application.HasIcon` says yes, and
the button is blank. It was found by an arrow that would not appear in
`examples/agenda`, and the tool now reports those separately from the ones that
are simply absent.

Like the runner, the tool is a **Bintana console project** (`tests/icons`) and
the `.sh` is the bootstrap. Reading the themes off the disk is not an
implementation detail here but the whole design: `Application.HasIcon` would
answer about whatever display the process has, and a console project has none, so
the Adwaita-under-Xvfb mistake is not available to make.

It exists because the suite structurally cannot answer this. Under Xvfb GTK falls
back to Adwaita, so a name Adwaita ships and the user's theme does not passes
every assertion and draws nothing on the screen -- `view-more-symbolic` did it
once and `view-table-symbolic` did it again, the second time behind a
hand-written list of forms that had drifted from the directory.

```sh
tests/icons.sh            # every .form in the tree
tests/icons.sh ide        # only that directory
```

It exits non-zero when something is missing **or blank**, so it can be a step in a
checklist;
it is deliberately *not* part of `tests/run.sh`, because what it answers is about
the machine it runs on and CI's machine is not the one anybody looks at.

## Style classes, which it cannot judge either

`tests/styles.sh` is the same bargain for `Style`: it reads the theme's own
selectors and prints which classes exist and what each is written for — whether
it is qualified for a node (`button.suggested-action`), and whether its rules are
about the children rather than the thing carrying it (`.boxed-list > row`). It is
a console project too (`tests/styles`), and it reads the theme straight out of
the library: `gresource extract` writes to its output and the lines *are* the
answer, so there is no temporary file and no trap to remove it.

```sh
tests/styles.sh                 # the theme compiled into GTK
tests/styles.sh --all           # every class in it, by how much it is used
tests/styles.sh --json          # the same, as the table ide/modules/Styles.js holds
tests/styles.sh path/to/gtk.css # a theme of your own
```

`--json` prints JSON and nothing else — the header line the shell version printed
above it made the one mode meant for a machine the one mode a machine could not
read. It is how `ide/modules/Styles.js` is regenerated: the IDE's class chooser
orders by it, so that a `Button` is offered the button classes first and a
`ListBox` is not. That file says so in its header, and a stale row in it costs
ordering rather than a class nobody can write — the field it sits behind is free
text.

Nothing asserts a class name, and nothing could: which classes exist is the
theme's answer, and the desktop the program runs on is not this one. A class the
theme does not have is accepted, saved into the `.form`, and does nothing —
exactly the shape of failure `icons.sh` exists for. What the suite *can* check is
the other half, which is ours: which CSS node each control is, since a class that
lands on the wrong node cannot match whatever the theme says. `Widget.CssNode()`
asks GTK, and `tests/widgets` writes the whole table down — every placeable type,
or the run fails. It is there because three of those nodes moved in one afternoon
(`Panel` from `box` to `fixed`, `ColorButton` from `box` to `colorbutton`,
`Form`'s column now built only when there is a menu bar) and every assertion
stayed green: for the stylesheet of anyone using the runtime, each of those is a
rule that stops matching.

The vocabulary it prints, and the node table to read it against, are in
[widgets.md](widgets.md#styling-the-vocabulary).

## The install, which the suite cannot see either

`tests/install.sh` answers a question none of the suite's projects can be asked:
whether what `make install` produces works. Everything else here runs the IDE as
`<repo>/ide`, where every file it could want is beside it because it was never
moved — and an install moves it.

```sh
./tests/install.sh              # needs cmake, Xvfb and xdotool
```

It installs the build into a staging prefix under `/tmp` (`cmake --install
--prefix`, which is what a packager does and the case most likely to be broken
by a path written down at configure time), checks that both project trees came
out whole, and then **starts the installed IDE through the installed launcher**
and asks the display what appeared.

The window is the assertion, and it is one string:
`IDE de Bintana — hello` under `LANGUAGE=es`. Three separate things had to be
found for that title — the installed sources, the installed `po/es.po`, and the
project the launcher was handed — and no lighter check covers them. Its class is
the IDE's application id, which is what the installed `bintana-ide.desktop`
claims to match — and both ends are read out of the installed `project.json`
rather than written down in the test, so what is checked is that the two
installed halves agree.

**It brings up an `Xvfb` of its own instead of using `xvfb-run`**, and that is
forced rather than chosen: `xvfb-run` owns its display for the length of one
command, and the whole check is a *second* command asking that display what the
first one drew. Nothing here ever touches the caller's screen, so unlike the
suite it is safe to run bare.

The failure modes it exists for are all quiet ones: a form nobody added to a
list, a catalogue that landed where the runtime does not look, a launcher
carrying the prefix it was configured with rather than the one it ended up in.
None of them is a build error, and none shows up until a menu entry opens a
window with something missing from it.

**And what an installed runtime offers a compiler is answered by compiling --
and then by loading.** The development surface a native plugin needs is one
header (`include/bintana/bta_plugin.h`) and the `bintana.pc` that points at it,
so the test finds the `.pc` anywhere under the staged prefix, asks
`pkg-config --cflags bintana` with `PKG_CONFIG_PATH` aimed at it, and builds
`tests/plugins/testplug.c` against that prefix with the answer. A header in the
wrong directory or a `Cflags` that points nowhere looks exactly like a
successful install until somebody outside this tree tries to build a plugin.

The plugin the compiler produced is then put in a library directory of its own
and the **installed** runtime is run against a console project that names it,
answering the half a compile cannot: the installed loader, its GModule, its ABI
check, and the global the plugin installs.

## Scratch state

Tests that touch the filesystem work under `/tmp` and clean up after themselves —
a project left behind makes the next run fail for something that is not the code.

The directory carries the runner's pid: the runner passes its own
`Environment.ProcessId` after the project path, it arrives as `Application.Arguments[0]`, and the projects build
`/tmp/bta-test-ide-<pid>` out of it. Without that, two suites at once — a flake
hunt beside an ordinary run, two CI jobs on one machine — edit each other's files,
and the collisions fail assertions that read exactly like real bugs (*"a form can
be created in a folder: expected true, got false"*). Invoked by hand with no
argument the directory is simply untagged.

`Application.ConfigDirectory` is per project name, so `tests/ide` writes its own
`~/.config/bintana/ide-test/recent.json` and can never touch the real IDE's list.
That test both uses and exercises the persistence: the second run of the suite reads
back a list whose `/tmp` entries no longer exist, which is what proves they get
filtered out.

## Under the sanitizer

```sh
./tests/asan.sh
```

Builds with clang and AddressSanitizer, runs the test projects, and reports
anything `tests/lsan.supp` did not suppress -- GTK, fontconfig and the GL stack
leak plenty of their own, and the suppression file is what keeps those out of the
way so that what is left is ours.

Both memory bugs this codebase has had were use-after-free: a wrapper collected
while GTK still showed the widget, and a handler that outlived the widget it
carried. Neither is deterministic, and both showed up as a crash that could as
easily not have happened. The sanitizer turns that into an answer.

The reports go to files rather than the terminal because the child project the
IDE test runs writes to a pty that the test then reads, and a leak summary in
there looks exactly like the child misbehaving -- which is a false failure I
walked into.

## Asking instead of looking

Most of what a screenshot gets asked is a number, and a number belongs in the
suite. `Bounds()` reports what GTK allocated (as against `Width`, which is the
request), and `Dump()` prints a subtree with those numbers:

```js
eq("the dialog keeps its declared width", dlg.Bounds().Width, 640);
check("nothing was pushed out of the panel", box.Dump().includes("hidden") === false);
```

**An ad-hoc probe is a project, and `tests/try.sh <dir>` runs one** without
putting it on anybody's screen. It is `xvfb-run` around the binary, and it exists
because `HEADLESS` is read by the runner and *not* by `bintana`: `HEADLESS=1
./build/bintana <dir>` looks like the safe thing right up until the window opens. Two
files under a scratch directory and a `print` of what they measured is how most
questions in this document were answered — what a property really does to an
allocation, which of two defaults GTK ships. `HEADLESS= tests/try.sh` is the way
back to a real screen for the questions that need one.

When it really is about pixels, `tests/probe.sh` asks the capture rather than
showing it: `pixel` for a colour, `region` for whether an area is uniform (which is
what "blank" means), `diff` for whether anything changed at all. See
[`AGENTS.md`](../AGENTS.md#verifying-by-hand).

## What the tests cannot see

Rendering, real key and pointer delivery, focus, window management, **whether a
disclosure arrow is actually drawn** (a `TableView` in tree mode answers
`Expanded(key)` about its *state*; that the arrow is on the row and openable is a
picture, and it was a picture that caught the bind/unbind bug), and **a drop
that starts outside the application**: nothing in the suite can drag a file out
of a file manager, so `AcceptFiles` and `FileDrop` are asserted as far as their
surface goes — the properties, the serialisation, the handler over a list of
paths — and the gesture itself is one to try by hand once, by dragging a picture
onto `examples/viewer`. Those are checked
by hand with `xdotool` and ImageMagick's `import`, and doing so has repeatedly found
what the suite could not: z-order occlusion, a desktop stealing a function key, a
relative path that only breaks under a real `cwd`, an icon that resolves but renders
blank, a drag that never starts because a `Button`'s gesture claimed the press, and a
click on a `Terminal` match that never arrived because VTE had claimed the sequence
— the suite covered the pattern, the parsing and the dispatch, and every one of
those passed while the click did nothing.

The way to check something that only a pointer can answer, without a screenshot
doing the deciding: patch the IDE's own `Form_Open` from an extra `.js` in a
throwaway project that loads the real `ide/**/*.js`, have it drive itself to the state
in question and `print` what it measures, then click with `xdotool` and read the log.
That is how the output pane's links were checked both ways — that clicking one
goes to the line, and that dragging across one still selects text instead. The
pane is a read-only `TextEditor` now, and the same method answered the questions
its click rests on: that a click really does move the insertion cursor in one,
that `Line`/`Column` report where, that `Selection` is `""` for a click and the
covered text for a drag, and that a drag usually produces no `MouseUp` at all.
A two-file probe under the scratch directory and an `Xvfb` of its own was enough
for those — no IDE to drive, since the question was about the widget.

Three things that waste time when doing it:

- **The window manager places the window differently on every run.** Read the
  geometry (`xdotool getwindowgeometry --shell`) and click relative to it. On a
  bare `Xvfb` there is no window manager at all, so `xdotool windowactivate`
  fails -- harmlessly, but it prints an error that reads like the probe not
  working.
- **Gestures coalesce.** Two clicks in the same place 0.4 s apart are a double
  click, and a probe that does not know it measures three releases for five
  gestures and concludes the wrong thing. Leave over a second between distinct
  gestures, and print `MouseDown` beside whatever is being measured so the
  sequence is visible.
- **Capture the window, not the screen** (`import -window $WID`) — and make sure no
  earlier instance survived, or the screenshot shows a state that no longer exists.
  Menus and drag icons are separate surfaces, though, so those need the root window.
- **When a screenshot and an in-app measurement disagree, believe the measurement.**
  Print `OriginIn` and the widget's own numbers from inside the running application
  instead of estimating pixels off a scaled crop.

**The tab order is checked without pressing Tab.** `Form.FocusNext` /
`FocusPrevious` go through the same `gtk_widget_child_focus` GTK itself calls, so
what runs is the real surface `focus` vfunc and the real GTK walk, and `Focused`
says where it landed — declared order, ties falling back to the drawn order, and
an unfocusable control skipped. What is left for a person is the *key* arriving,
and the reason to check it is that an editor and a `Terminal` are supposed to
keep Tab for themselves: indentation and shell completion have to still work.

**Enter and Escape are declarations the suite can check and keys it cannot press.**
`Button.Default` / `Button.Cancel` are covered on every side that is measurable:
the flags, what the serialiser writes, that two of them resolve to one, that
deleting the button leaves the form with none — and `Form.DefaultButton` asks the
*window* rather than the flag, so it is the assertion that says `form_show` really
reached `gtk_window_set_default_widget`. What is left is the key arriving, which
is one run of the IDE: `Ctrl+N` opens a prompt, Escape must dismiss it, Enter in
the field must accept it. Worth doing after touching either, because a
`Form_KeyPress` that consumes the key first, a desktop that grabs it, and a
focused button that answers Enter itself are all invisible from inside.

**A file chooser cannot be in the suite at all**, and it is the sharpest case of
this: `Dialog.OpenFile`/`SaveFile`/`SelectFolder` are modal, nothing in JS can
close one, so the chooser sits on top of the form the *next* test measures. One
turned `testExec`'s pushed-surface assertions red while `testFileDialog` passed
on its own — `Dialog.Color`'s two get away with it and a file dialog does not. So
the accepted options are checked by hand and every **refusal** is in the suite,
where a refusal shows nothing by construction: it throws before the chooser
exists. Checking the other half is four numbers off one capture — the title
reached GTK, `Name` prefilled the field, `Folder` set the breadcrumb, and the
listing under a `*.js *.mjs` filter shows `MAYUS.JS`, which is the whole reason
`*.ext` becomes a suffix instead of a glob.

**Translation is a test the suite cannot be.** `LANGUAGE=es ./build/bintana ide
examples/hello` runs the IDE off `ide/po/es.po`, and running it that way found four
kinds of string that escape extraction and one layout that overflows -- none of
which any assertion was looking for. `examples/i18n` is the reduced case: the same
three buttons laid out four ways, and a report of which row ran past its room in
which language. Numbers, so the answer is not an impression.

Copy a project to `/tmp` before driving it interactively: a stray drag plus a save
will edit `examples/hello` for real.
