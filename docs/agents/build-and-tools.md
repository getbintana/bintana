# Build, commands and CI

The traps and decisions of this area, each with what it cost and the rule it left. [`AGENTS.md`](../../AGENTS.md) states the rules that apply to every change; this file is the evidence behind them and the detail that only matters here.

## Commands

```sh
cmake -S . -B build && cmake --build build -j    # build (needed after any C change)
./tests/run.sh                                    # whole suite
./tests/run.sh widgets                            # one project
./tests/run.sh widgets record                     # one test of it
./tests/run.sh ide designer                       # one project, up to one phase
./tests/run.sh ide list                           # what a project can be asked for
BINTANA=/other/bintana ./tests/run.sh             # suite against another build
TIMEOUT=2400 ./tests/run.sh                       # a slower machine than this one
BINTANA_PROFILE=/tmp/caps ./tests/run.sh          # a Sysprof capture per project, under /tmp/caps
./tests/asan.sh                                   # suite under AddressSanitizer
tests/try.sh <project> [args...]                  # run any project, on a virtual display
./tests/api.sh                                    # does the runtime still say what it publishes, and is api.json current?
./tools/apijson.sh                                # rewrite api.json, the surface as data -- tests/api.sh fails while it is stale
./tools/llms.sh                                   # rewrite llms-full.txt from the documents llm.txt lists
./tests/icons.sh                                  # which declared icons this desktop has, and which draw
./tests/styles.sh                                 # which style classes its theme defines
./tests/install.sh                                # what `make install` produces, run out of a staging prefix
./tests/pack.sh                                   # what `lib/package` writes, read back file by file
./tests/bench.sh                                  # how fast the interpreter is: Gambas's eight programs, timed and checked
```

**Nothing here opens a window, and that is the scripts' doing rather than
yours.** `run.sh` and `asan.sh` both export `HEADLESS=${HEADLESS-1}`, so the
suite draws on a virtual display whatever the machine has; `HEADLESS=` — empty,
not `0` — is the way back to a real screen. It was a rule before it was a
default, written in three documents, and it was still walked into five times:
the runner falls back to `xvfb-run` only when there is **no** `DISPLAY`, which
is CI and never a desktop, so the bare form opened the suite over somebody's
work and took the keyboard for a minute. A rule that has to be remembered on
every invocation is a rule that will be forgotten on one of them. Anything else
that draws goes through `tests/try.sh`, which cannot make the mistake either.

These need a real screen and so need saying out loud before running one:

```sh
./build/bintana tests/widgets                         # one test project, by hand
./build/bintana ide examples/hello                    # the IDE
./build/bintana examples/hello                        # a project on its own
LANGUAGE=es ./build/bintana ide examples/hello        # the IDE in Spanish (ide/po/es.po)
./build/bintana examples/i18n                         # layout under translation, measured
```

**A new property, method, event or global is not finished until `tests/api.sh`
passes.** `docs/llm/` claims to be the *complete* public surface — the thing you
hand somebody who has to write an application and should never have to read
`runtime/src` — and that claim is only worth something because something fails
when it stops being true. The check reads the accessor tables and the `bta_emit`
calls against `controls.md`, and the globals against `library.md`, so adding
either without a row breaks it; so does documenting an event with the wrong
number of arguments. Both of those were real: `MouseWheel` was written
`(dx, dy, ctrl, shift)` in three documents and passes two, and
`Application.LibraryPath` had been public and called by the IDE with no row
anywhere.

**What a member is for is written once, beside it, and the documentation's
rows are written from there.** The comment above a member's C entry is its
signature on the first line and its description on the lines after:

```c
/* Load(path) -> string
 *   the whole file as a string. **Throws if it cannot be read**, and the
 *   message names the file
 */
```

`tools/extract_signatures.cmake` keeps the text beside the signature,
`Widget.Members` hands it out as `Doc` (and `Native`, which says a member is
written in C), `Widget.EventDoc` answers for an event, the IDE's popup shows the
first sentence under the list, and **`bintana-docs`' `tools/docs.sh` writes it
into every table row of `docs/llm` and `docs/reference` that names the member**
-- the whole text in a two-column table, the first sentence in an index row --
working from `api.json` rather than from the runtime, which is why
`./tools/apijson.sh` runs here first. The tables, their order and headings, and
all the prose around them stay written by hand; **a member row's text is not**,
and `bintana-docs`' check fails while a page is not what `tools/docs.sh` would
write, while `tests/api.sh` fails here on a native member with no description
at all. So: change the comment, run `./tools/apijson.sh`, and let the
documentation repository follow. Before this each member was described up to
three times -- the compact row, the reference's index row and its section row --
and nothing compared them. The migration took the texts that were there: the
longest in visible characters (a link's target does not count, or a link made a
shorter text win), plus the sentences after the first of the others that said
something it did not (a default, *read-only while …*) -- appending their *first*
sentences produced two descriptions of one thing glued together. The links in a
description are written from the root (`docs/llm/library.md#bytes`), since one
text lands in pages in different directories; `tools/docs` makes each one
relative to its page.

**A member written in JavaScript says it in a JSDoc comment** -- rad.js,
forms.js and every library under `lib/` -- and nothing else changes: the
parser reads the comment (the tenth fork patch), `Application.Symbols` hands it
out as `Doc` with the type after `@returns` as `Returns`, and `Widget.Members`
answers with it, so the manifest carries it, `tools/docs.sh` writes those rows
from the same field, and `tests/api.sh` fails on a public JavaScript member
with no comment the same way it fails on a native one.

```js
/** runs `tick` once after `delay` milliseconds, and answers the `Timer` */
static After(delay, tick) { … }
```

Four things are worth knowing before writing one. **The comment has to touch
the declaration** -- ending on the line above it or on the same line -- or it
documents nothing: a `/** … */` inside a body is not the next method's. **A
plain `/* … */` is never read**, so the implementation notes above a member
stay where they are and the JSDoc goes directly above the declaration, under
them. **The parser sees declarations and not calls**: a class member, a
top-level function, a function assigned at the top level (`File.LoadJson =
function`, `Widget.prototype.Dump = function`), and each function an object
literal holds when that literal is the right side of a top-level assignment
(`GLOBAL.Settings = { Get() {} }`). A `defineProperty` call is none of those,
which is why forms.js writes the accessors it adds to classes the C made
(`Caption`, `Controls`, `Menus`, `Actions`, `Item`) as small classes copied
across by `mixIn` -- **a class the prelude declares and never installs is read
as a mixin**, and what it declares documents that name wherever it went
(`prelude_mark` in `bta_widget.c`). And **the prelude is read once, lazily**:
rad.js and forms.js are baked into the binary, so the index `Widget.Members`
answers them from is built on the first question and kept -- which also means
editing one needs a rebuild before the new comment is seen, the rule that file
already has. The 169 JavaScript descriptions were migrated from the rows the
way the C ones were; the forty the documentation only had as prose or in a
three-column table (`Field.Text` and its kind, `Settings`, `Nsis`) were
written by hand. A `<control>_<event>` method is a handler the class wrote for
itself and is not asked about.

**There is no declaration file for outside editors, and that is a decision.**
A generator (`tools/typings`) wrote `bintana.d.ts` for VS Code, and `api.sh`
held it to the runtime; it was removed because nothing here consumed it and the
completion that matters is the IDE's own, which asks the runtime
(`Widget.Members`, `Application.Symbols`) and never read a declaration. A
generated file with no consumer is a check about itself. Do not bring one back
to fix a completion: fix the runtime verb the IDE asks.

**Every one of those but `asan.sh` is a Bintana project now** — `tests/runner`,
`tests/icons`, `tests/styles`, `tests/install`, `tests/bench`, each a console
project (`"main"`, no display) with a ten-line `.sh` in front of it that finds
the binary. There is no Python left in the repository, and adding a desk tool
means writing a project, not a script.

**`tests/bench.sh` is how a change to the interpreter is measured, and it
measures whichever binary runs it** -- `build/` is Debug, three times slower
than an optimised build, so point `BINTANA` at a `RelWithDebInfo` or `Release`
one before believing a number. The programs are Gambas's (`benchmark/` in its
tree), written again here because theirs are GPL-2, at their sizes so the
numbers sit beside Gambas's published table; each runs in a process of its own
and **checks its answer**, so a faster wrong result is a failure and never a
time. Not in `tests/run.sh`, since a timing is not an assertion. What it found
the first day is in `docs/testing.md`: QuickJS beats CPython 3.14 on floating
point (`mandelbrot`, `nbody`) and loses the other five Python finishes, and **appending to a long string grew
faster than its length** -- a fifth of `string2`'s appends was 90 ms and all of
them 1067 ms over five times the data -- which was the engine's rope rebalance
and is the eleventh patch now (`string2` 34.8 -> 3.9 s); the twelfth made
`string1` a `memchr` (10.3 -> 5.5 s), and the eight programs together went
65.7 -> 30.0 s. `-O3` against `-O2` moves `string1` 24 % one way and `nbody` 12 % the
other, and nothing else: the packages' `RelWithDebInfo` stays.

`tests/install.sh` is the only one that needs no `HEADLESS` of its own, and it is
not an exception to the rule above: it never uses the caller's display at all. It brings up an `Xvfb` of its own, because the check is a second command
asking that display what the first one drew — which is precisely what `xvfb-run`
cannot do, since it owns its display for the length of one command.

The suite needs a display but not yours: it runs under `xvfb-run` by default, and
falls back to it anyway when there is no `DISPLAY`/`WAYLAND_DISPLAY`, which is
what `.github/workflows/ci.yml` relies on. Anything you drive by hand still needs a real display. Build deps:
`gtk4` (**4.10 or newer** -- `GtkAlertDialog` and `GtkFileDialog`),
`gtksourceview-5` (with headers), pkg-config, and `gmodule-2.0`, which is the
plugin loader and comes with glib. QuickJS is vendored as a submodule, so
nothing to install for it -- and a fresh clone wants `--recurse-submodules`, or
`git submodule update --init` before the first configure. Eight are optional and CMake says what it found either
way: `sqlite3`, `libsystemd`, `libsoup-3.0`, `gstreamer-1.0`,
**`vte-2.91-gtk4`** -- the pty behind `Terminal`, and the only dependency with
no Windows port -- `libxml2`, which is what `Xml` parses with,
`libsecret-1`, the system's vault behind `Keyring`, which has no Windows port
either, and `sysprof-capture-4` (Fedora `sysprof-capture-devel`), which is what
`--profile` and the runtime's marks in a Sysprof capture are built on. The libxml2 one is
optional in the build only: on most desktops GTK4 already loads libxml2 at
runtime, so what the package buys is the headers. **Package names per distribution and what each
one turns on are in [`docs/installing.md`](../installing.md)**, which is also
where the `Xvfb`/`xdotool`/`python3`/`openssl` the suites want are listed. **Build both ways before touching anything under
an `#ifdef`**: a wrapper `pkg-config` that exits 1 for one module name and
delegates the rest is the whole of it
(`cmake -S . -B build-x -DPKG_CONFIG_EXECUTABLE=<wrapper>`), and
`BINTANA=<path> BINTANA_LIB_PATH=$PWD/lib ./tests/run.sh` runs the
suite against it -- the library path because `lib/` is found relative to the
*executable*, so a build in another directory fails twelve chart assertions for
a reason that has nothing to do with what was turned off.

`.js` and `.form` files are data read at runtime — **no rebuild needed** after
editing anything under `ide/`, `tests/`, or `examples/`.

**`runtime/js/rad.js` is the exception, and it does not look like one.** It is
baked into the binary (`bta_prelude.h`), so editing it and running the suite tests
the *previous* one — silently, and every assertion that should have failed passes.
`tests/run.sh` warns when a source is newer than the binary; invoking `./build/bintana`
by hand skips that warning, which is how it bites.

**A push is the machine owner's, and a failure to push is a question for them.**
The remote is SSH (`git@github.com:getbintana/bintana.git`) and an agent's shell
has no key, so `git push` answers `Permission denied (publickey)`. That is not a
puzzle with a workaround — HTTPS, a token, another remote are all ways of not
asking. Commit locally, leave the tag made, and say the two commands.  It is the
same rule as the Xvfb one in the traps: **when a thing fails for a missing tool,
a permission or a package, ask the person at the machine; do not retry
alternatives.** Their one sentence costs less than your half hour, and an
improvised substitute is what turns a question into a false result.

**And a commit says who wrote it, by its own name.** The machine owner is the
author — `git commit` under their own `user.name`, which is the repository's
config and not an override — and the agent is the trailer:
`Co-Authored-By: opencode (<modelo>) <noreply@opencode.ai>`. The model in
parentheses is the one that actually wrote it, so an agent that does not know
its own name asks rather than copying the last trailer it saw. The
history had ninety-two commits signed `Co-Authored-By: Claude` while the agent
writing them was not Claude, because each one copied the trailer of the commit
before it; a false statement in the permanent record is precisely what a trailer
exists to prevent. **An agent that does not know its own name asks rather than
copying the last one it saw**, and the whole history was rewritten to take those
out — which is why a `git log` older than that rewrite and a checkout of it
disagree.

## Build, CI and portability

- **`git checkout <file>` throws away every uncommitted change in that file**,
  not the one line a probe just made. It was used to undo a one-word `sed`
  test on `bta_widget.c` and took a whole stage of work with it -- recovered
  only because every edit had been scripted in the conversation. Undo a probe
  with the inverse edit, or `git stash` first; never check a file out that
  holds work.
- **A CMake script that reads C with `file(STRINGS)` is reading a CMake list,
  and a list is not lines.** `[` ... `]` groups and `;` separates, so one
  unbalanced bracket (`*q == '['`) merged every following line of
  `bta_widget.c` into one item and **twenty** signature comments stopped being
  lines -- `Widget.Signature("Button", "Bounds")` answered `null`, the build was
  green, and only `testSignatures` noticed. It happened again, quietly, in
  `bta_runtime.c` and `bta_locale.c`: every `Application` and `Locale` verb was
  commented and none reached the table. `tools/extract_signatures.cmake` reads
  each file with `file(READ)`, swaps `[`, `]`, `;` and `\` for markers, splits on
  newlines and puts the markers back only in a kept argument list
  (`bta_read_lines`/`bta_unmark`) -- so the C no longer has to be balanced for
  the extractor. **Any new CMake script over C source wants the same macro.**
  Count `build/generated/bta_signatures.h` before and after a change to it.
- **Fedora's `pkg-config` does search `/usr/local`, and the way to ask whether
  it does answers wrongly.** `pkg-config --variable pc_path pkg-config` prints
  `/usr/lib64/pkgconfig:/usr/share/pkgconfig`, so `/usr/local/lib64/pkgconfig`
  reads as unsearchable -- and `pkg-config --cflags bintana` finds a `.pc` there
  anyway, because `/usr/bin/pkg-config` is a wrapper (`pkgconf-pkg-config`) that
  sets `PKG_CONFIG_LIBDIR=/usr/local/lib64/pkgconfig:/usr/local/share/pkgconfig:/usr/lib64/pkgconfig:/usr/share/pkgconfig`
  before exec'ing pkgconf, and a set `PKG_CONFIG_LIBDIR` **replaces** the
  compiled-in default rather than adding to it. This produced a wrong
  `docs/installing.md` once -- an "install to `/usr` on Fedora" that was never
  necessary. The question with a true answer is `pkg-config --cflags bintana`;
  the variable is a report about pkgconf and not about this machine's
  `pkg-config`. (The pc under `<build>/pkgconfig` is a different case: it is for
  building against a checkout with nothing installed at all.)
- **The compiler in CI is older than the one here.** The runner is GCC 13 and
  this machine is GCC 16, so a name the new one knows is a *syntax* error there:
  `#if defined(__SANITIZE_ADDRESS__) || (defined(__has_feature) && __has_feature(address_sanitizer))`
  reads as a guard and is not one -- `&&` does not short-circuit the token, and
  GCC 13 stops with `missing binary operator before token "("`. Clang's
  `__has_feature` question is nested inside the `#ifdef` that knows the name
  exists (`bta_runtime.c`), and any compiler-version conditional added here is
  the same shape of risk: the runner is the only GCC 13 this repository has.
- **And so is its GTK, which is the one that actually bit.** The runner is
  Ubuntu 24.04 with GTK **4.14** while this machine has **4.22**, so a name added
  since 4.15 compiles here and is an *undeclared identifier* there:
  `GDK_ACTION_NONE` is an enumerator only since **4.20**
  (`GDK_AVAILABLE_ENUMERATOR_IN_4_20` in `gdk/gdkenums.h`) and `bta_widget.c`
  returned it for a refused drag -- green here, `error: 'GDK_ACTION_NONE'
  undeclared` on the runner, and the floor this runtime declares is 4.10. `0` is
  the zero of the flags type and says it in every version. **A new GTK or GDK
  name is checked against the floor, not against this machine**: grep the header
  for its `GDK_AVAILABLE_IN_*`, and when it is newer, spell the older thing.
- **And its libxml2, where a callback's signature changed *constness* --
  and it was Clang that said so.** libxml2 2.12 made
  `xmlStructuredErrorFunc` take a `const xmlError *`; Ubuntu 24.04 ships
  **2.9.14**, whose typedef is `void (*)(void *, xmlErrorPtr)`. The two schema
  callbacks in `bta_xml.c` were declared `const xmlError *`, so the assignment
  was an **incompatible function pointer type** there -- which Clang refuses by
  default and GCC 13 only warns about, so the whole ordinary job stayed green
  and `tests/asan.sh`, the one build that uses Clang, went red on a file
  nobody had touched. `xml_collect_problem`'s parameter follows
  `LIBXML_VERSION` now. **A callback typedef is written the way the header in
  front of you spells it**: a `const` that arrived in 2.12 is the modern
  header's opinion and not part of the ABI, and adding it to an older library
  buys a red sanitizer job and nothing else.
- **The platform guards are the Windows port, and nothing here compiles them.**
  `#ifdef G_OS_WIN32` in `bta_sys.c` (`exec_signal_group`, `exec_control_fd`,
  `bta_exe_path`, `env_has_display`, `env_os`), `locale_group_double` in
  `bta_locale.c`, `SetConsoleOutputCP` in `main.c`, and the `GIOUNIX`/`pthread`
  guards in `CMakeLists.txt` -- plus `runtime/src/bta_desktop.c`, which compiles
  there and means nothing there, and `BTA_HAVE_UNIX_PRINT` in
  `runtime/src/bta_printer.c`, which is off there: printing works, and
  `Printer.Names`/`Printer.Default` refuse with a sentence, because GTK
  publishes no list on Windows. **There is no local way to compile any of
  them**: the `windows` job in `.github/workflows/ci.yml` is the compiler, and
  its first runs are the toolchain spike `docs/plans/portability-plan.md` asked for.
  The same job stages the downloadable zip through
  [`tools/windows-portable.sh`](../../tools/windows-portable.sh) -- DLLs by `ldd`,
  GTK's runtime data by hand, caches rewritten to bare names because an
  absolute path is nobody's on the machine that unzips it. None of that script
  has run on a Windows desktop either; the log, and whoever unzips it, are the
  test.
  Editing one blind and pushing is the loop, so keep each guard as small as it
  can be and put the *why* next to it -- the CI log names a line, not a reason.
  **`windows.h` is a macro minefield and it arrives through GTK**: on Windows
  `gdkwin32.h` includes it, so *every* file that includes `gtk.h` carries its
  macros. `wincrypt.h` defines `PP_NAME` as `4`, which made
  `enum { PP_NAME, PP_DIR, ... }` a syntax error three constants wide -- the
  runtime's own enumerators are `BTA_PATH_*` for that reason. `vfw.h`'s
  `SEARCH_KEY` is *not* reachable this way, so a name being in some Windows
  header is not by itself a collision. And three Unix things compile out:
  `poll.h` does not exist (`bta_debug.c`), `g_subprocess_launcher_set_child_setup`
  is GLib's Unix API (`setsid`, in `bta_sys.c`), and `Exec`'s `Control` stream
  is refused -- the same descriptor-inheritance that the debugger's channel
  needs.
- **A repository path is spelt with `/` on every platform, while
  `Directory.Files` joins with the platform's separator -- and the two are
  crossed in `tools/docs/Rows.js`, which is the check's and the writer's one
  copy.** A page key was `p.slice(root.length + 1)`, so on the Windows job every
  `docs/reference` key came back backslashed; `docRelative` splits a path on `/`
  and read the whole key as one component, so every row carrying a link was
  recomputed with the wrong `..` depth. `tests/api.sh` reported **31 long
  pages** as rows that do not say what the code says -- all of them reference
  pages, because the `docs/llm` keys are literals written with `/` -- and
  `tools/docs.sh` would have written those wrong links into the pages. The
  normalisation belongs at the boundary (`…slice(root.length + 1).replace(/\\/g,
  "/")`), which is where the platform's spelling enters, and `File.Join` takes
  the `/` spelling back on either platform. It is green here and red only on the
  runner, so the evidence is by hand: a scratch copy of `Rows.js` given the
  backslashed keys the walk really returns reports the same 31 pages with the
  fix removed.
- **`add_executable(bintana …)` lists its sources by hand while the signature
  extractor globs `runtime/src/*.c`.** A new `.c` that is not in the list builds
  green up to the link and then fails as *undefined reference to `bta_x_init`* --
  and is already in `generated/bta_signatures.h`, so it looks half registered.
  A new global is five places: the `.c`, its `CMakeLists.txt` line, its init in
  `bta.h`, and the two `install` roads, `bta_runtime.c` **and** `bta_task.c`
  (a global missing from the worker is *not a function* at call time, which
  `testTask`'s `entropy` step now asserts).

**And two about checking the documentation, which cost an hour.**
`bintana-docs/check.sh` with no `BINTANA_API` fetches the `api.json` its
`bintana-ref.txt` pins -- the *previous* surface -- so it is green for a change
it has never seen. Point it at yours:
`BINTANA_API=$PWD/api.json BINTANA_SRC=$PWD ./check.sh`. And `tools/docs.sh` run
that way rewrites **every** row the manifest says is stale, including other
branches' pending work (it rewrote `Background` in `controls.md` and `Widget.md`
here); look at `git diff --stat` and take back what is not yours. A long page
also wants a table row **in the body** for each member, not only in *Every
member*: the check reads that as "explained", and a section of prose naming the
member does not count.

**`tests/run.sh widgets <name>` takes one test, and the name is case-sensitive**
(`Hash`, not `hash`); a second name is ignored and the line says `[only Hash]`.
- **An optional dependency is not the same question as an optional *widget*, and
  `Widget.Types()` is the wrong list to build a palette from.** `Terminal` on a
  build without VTE is there, constructs, draws, loads out of a `.form` and
  answers every property: the class is not what is missing, the pty is. So the
  class table gained `available` (`BTA_CLASS_OPTIONAL` passes it; every other
  macro defaults it to true), `Widget.Available(type)` reads it for a caller that
  has a name and no control, and the instance publishes `Available` for one that
  has a control. **Offer from `Available`, load from `Types`** -- the IDE's
  palette filters on the first and `Widget.New` still builds the stub, because a
  `.form` that already holds one has to open.
- **...and a build-time flag is a different question from a machine's answer, so
  a class can now answer with a probe.** `Terminal`'s `available` is whether VTE
  was linked in, which is a constant; `Video` needs GStreamer *and* the
  `gtk4paintablesink` element, and a runtime built with GStreamer on a machine
  whose registry lacks gst-plugins-rs is a real shape -- a CI runner.  So
  `BtaClass.probe` is a function the class declares and `bta_class_runnable`
  picks whichever of the two a class has (`Video` is the one row using
  `BTA_CLASS_ENUM_PROBE`, and `AudioPlayer` is deliberately outside it: sound
  needs no sink).  **The probe caches its own answer**, because the first
  question reads the GStreamer registry: 6 ms warm, **573 ms cold** measured,
  and that is why it is asked on the palette's first question rather than at
  start-up.  The palette test already checked both directions generically
  (available must be offered, unavailable must not), so `Video` dropping its
  button on this build was already covered -- what the widgets test adds is that
  `Video.Available` and `Widget.Available("Video")` cannot drift apart.  The
  issue that asked for it, `docs/issues/ISSUE-video-availability.md`, is deleted
  as answered.
- **An optional dependency that ships inside a required one cannot be left out,
  so its job hides it.** `no-vte` is the honest shape -- libvte is its own
  package, the job does not install it, CMake says so. `gtk4-unix-print` is not:
  its `.pc` is in `libgtk-4-dev`, the same package as `gtk4.pc`, and the
  platforms where it is really absent are Windows and macOS, where the suite
  does not run. So `no-unix-print` puts a pkg-config on `PATH` that answers "no"
  for that one name, and **reads CMake's own line back** to prove the wrapper
  worked -- without that guard a wrapper that stopped working would make the job
  a second copy of the first one, silently, which is the same guard `no-vte`
  carries for the same reason. Measured both ways: with the wrapper the branch
  compiles and `tests/widgets` is 3303, and with the real pkg-config the guard
  fails the job. **`no-libxml` is the third and it is the hidden kind too**:
  libxml2's headers can arrive as some other package's dependency, so the same
  wrapper hides `libxml-2.0` and the same read-back proves it -- measured,
  `tests/widgets` is **99 assertions fewer** in that build than with it
  (measured 3566 against 3665 when the suite was that size; it has grown since),
  and green both ways, because the XML tests fork on `Xml.Available` the way
  `testDatabase` does on sqlite.
- **An optional dependency shipping in the tarball is a promise about somebody
  else's machine.** The `package` job builds for the fewest shared libraries, and
  `libxml2-dev` can be pulled in by `libgtk-4-dev` without anybody asking -- so
  that job hides `libxml-2.0` with the same wrapper and fails if it is found,
  rather than silently making every download need a library the downloader may
  not have.
- **It is hidden in the `package` job and in its own CI job**, like libxml2:
  its headers can arrive as another package's dependency, so the tarball hides
  the module and reads CMake's own `no libsecret:` line back to prove it. The
  Windows job needs no change -- libsecret has no Windows port and the `#else`
  half is what that build compiles.
