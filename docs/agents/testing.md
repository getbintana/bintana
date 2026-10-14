# Testing

The traps and decisions of this area, each with what it cost and the rule it left. [`AGENTS.md`](../../AGENTS.md) states the rules that apply to every change; this file is the evidence behind them and the detail that only matters here.

## Tests

Seven Bintana projects are run by the suite — `ide`, `markdown`, `qr`, `report`,
`smoke`, `widgets` and `xlsx` — each printing `N passed, M failed` and quitting with a
non-zero status on failure. They are applications, not a harness — write
assertions the way the suite already does. A project is any directory under
`tests/` with a `project.json` that does not declare `main`, so adding one is
adding a directory: nothing lists them. (The console projects — `api`, `icons`,
`install`, `pack`, `runner`, `styles` — are tools and are driven by their own
`.sh`.)

**`tests/plugins/` is not a project**: it holds the C sources of the native
plugins the suite loads (`testplug.c` — the reference implementation
`docs/plugins.md` points at — plus a no-entry-point one and `abi1/`, a frozen
copy of the version-1 header). CMake builds them into
`<build>/testlibs/<name>/<name>.so`, and `tests/widgets` copies one from beside
the running binary into a scratch library. No `project.json`, so the runner
walks past it.

**`tests/runner` is the suite's own runner, and it is a Bintana project too** —
a console one (`"main"`), so it needs no display and can be the thing that decides
whether the projects need a virtual one. `tests/run.sh` is ten lines: find the
binary, say so when there is none, `exec` it. The binary it picks is the one the
runner reports as `Application.Executable`, so `BINTANA=<path>` needs nothing passed down.
Do not grow the shell script back — the display, the hang guard, the filtering and
the reporting all live in `tests/runner/Main.js`.

`tests/ide` loads the **real** `ide/**/*.js` (see its `project.json`) and drives
the IDE the way a user would. Its `.form` files are symlinks to the IDE's own,
so the two cannot drift — and **a form added to the IDE is a symlink added
here**, or the test project builds that dialog with no controls at all and the
first assignment to one of them throws `cannot set property 'Text' of
undefined`. The new `.js` has to go in `tests/ide/project.json`'s `sources` too;
a file listed in neither place is a class that never loads.

**The runner points `XDG_DATA_HOME` at a scratch directory under `/tmp`**
(`bta-suite-<pid>/data`), because `tests/ide`'s `apps` phase installs a menu
entry for real. Without it every suite run would leave a `bta-suite-app.desktop`
in the developer's menu, and only that phase would be able to say why. What is
deliberately *not* moved is `~/.config/bintana`: the projects' own settings
directory has always been written to by the tests, and `tests/ide`'s `settings`
and `session` phases are about it.

**`tests/report` is how a shipped library is tested, and the shape is worth
copying.** `Save()` runs the same `Canvas_Draw` synchronously against an image
surface, so `Canvas.Dump()` on the next line is *that page's* calls -- which is
how a banded document is asserted page by page without a screen and without
waiting for a frame a preview would only ever give you for the current one. The
five regressions it covers are in the file's header, and every one of them was
put back and watched go red: a test that passes against the bug it names is not
a test.

Event tests must make the round trip: assigning `TextBox1.Text` from JS has to
reach GTK, come back as a real `changed` signal, and land on
`TextBox1_Change`. Testing the JS side alone proves nothing.

**Always wrap `Form_Open` in try/catch in a test project.** An uncaught throw
aborts `Form_Open` before `Application.Quit`, and the run hangs until the runner's
timeout instead of failing. The same shape of hang comes from *nobody reporting*:
in both large projects something has to call the reporter when the last thing that
would have is filtered out.

**`tests/asan.sh` is worth a run after anything that touches lifetimes.** It
builds with clang (Fedora ships compiler-rt but not gcc's `libasan`), runs the
projects, and reports what `tests/lsan.supp` did not suppress. Both memory
bugs this codebase has had were use-after-free that only showed up as a crash on
some machines; the sanitizer says so on every machine. A third joined them and
was found by reading rather than by running: `Painter.LineDash` built its
refusal message out of the array *after* `g_free`, which came out right on every
normal build because `g_free` does not poison -- the rejection list now carries
`p.LineDash = [-1]`, which is what makes the sanitizer the thing that would say
so next time.

**When `asan.sh` fails talking about the compiler, the problem is the cache.**
A `build-asan/` left over from another toolchain keeps that compiler's absolute
path in `CMakeCache.txt`, and CMake refuses to change the compiler of an
existing cache -- so the run dies in `cmake_check_build_system` with *"is not a
full path to an existing compiler tool"* before building anything, naming a
`clang` that is simply gone. `CC=` does not help, because the cache wins.
**Delete `build-asan/` and let the script reconfigure**; it is generated, git
ignores it, and the script creates it when it is missing.

**A frame is not a promise.** `tests/ide/Driver.js` has `until(cond)`: it yields
until something is true instead of counting frames by hand. A text change
re-measures on a frame of GTK's choosing, and a machine under a sanitizer takes
more of them -- counting is what made two of these tests flaky.

**And the sharper version: never assert that something has *not* happened yet.**
`until` fixes waiting for a frame; nothing fixes racing one. `tests/widgets`
asserted `ScrollY === 0` immediately after `GotoLine(380)`, on the reasoning
that a scroll asked for through a text mark lands on a later frame -- which is
true when the view has no validated allocation and **false when it has one**,
because `gtk_text_view_scroll_to_mark` then honours it at once. Measured at
about one failure in five, standalone, on an idle machine; it read as a
regression three separate times during unrelated work, which is the real cost of
a test like this. The assertion is gone and the `until` below it carries the
half that is real -- *the scroll does arrive*. The documents that stated the
same thing as a certainty (`reference/widgets/Editor.md`, `plans/git-plan.md`)
say *may* now. **A negative about timing is not a property of the code; it is a
bet on the scheduler.**
**And the same bet can hide in a test that waits, because what it waits *for*
is not the only clock in it.** `testExecControlLate` starts a child whose
grandchild writes to descriptor 3 a third of a second later, and asserts the
line is dropped -- which is only true if the job was freed first, and the job is
freed on a loop that does not start until the rest of `Form_Open` has run.
Under AddressSanitizer that takes longer than 0.3 s, so the exit, the read and
the write were all pending at once, the read was dispatched first, the line was
delivered while the job was alive -- correct behaviour -- and the test went red
in every sanitized run while passing five out of five standalone. The sleep is
two seconds now, which is an order of magnitude of headroom for the free path.
The lesson is the same one: **find every clock a test depends on, not only the
one it waits on.** `tests/ide`'s `recovery` phase had one more: the IDE's own thirty-second
snapshot tick, which could land between answering the recovery offer and
asserting the snapshot was gone -- with the tab deliberately left dirty, so the
tick wrote a correct new one. Never inside an ordinary run, once under
`asan.sh`, whose `ide` takes ten minutes. The phase stops the tick and takes
its snapshots by hand.

**And a rectangle is not a promise either: measure it again before every
gesture.** The stack assertions took the overlay's rectangle once and aimed two
drops at it -- and what lands in a container changes that container's own
rectangle, so by the second drop the point was outside it. Green here, red under
`asan.sh`, which is the signature of this mistake rather than of a bug in the
code being tested. `middleOf(c)` re-reads `rectOf` each time and `settled(ide)`
goes between the gestures; three assertions came back green under the sanitizer
with nothing else changed.

**Anything that depends on layout needs a frame first.** `PickAt`, `OriginIn`
and an unset `Width`/`Height` all read GTK's allocation, and a widget that was
just created, or whose container was just made visible, has none until the main
loop runs again. `Form_Open` itself runs *before* the window is presented. This
is why `tests/ide/Driver.js` is a generator: each `yield` hands control back to
GTK for a frame. Add one after showing the designer, switching to a form tab,
or creating a control — before clicking on it.

## Verifying by hand

Some things the suite cannot see: rendering, real key and pointer delivery,
focus, window management. Checking them has repeatedly found what the tests
could not — z-order occlusion, a desktop stealing a shortcut, a relative path
breaking only under a real `cwd`, an icon that resolves and renders blank, a drag
that never starts because a `Button`'s gesture claimed the press.

**Ask in this order.** A screenshot is the last resort, not the first: looking at
one is expensive and proves nothing twice.

**1. Ask the running application.** Most questions are numeric, and a number can
become an assertion that stays in the suite:

```js
print(this.Dump());            // the widget tree, with what GTK really gave
this.Btn.Bounds()              // {X, Y, Width, Height}, allocated, window coords
this.Btn.Bounds(this.Panel1)   // the same in that container's coordinates
```

`Width`/`Height` report the **request**, which is a minimum — `Bounds()` is what
tells you a label declared 120 wide is really 433 and has stretched its window.
Note that `Bounds()` returns the drawn box, so a theme's margins make a `Button`
smaller than the size it was given; a `Panel` matches exactly.

**2. Ask the screenshot instead of reading it.** `tests/probe.sh` captures by
window name and answers questions about the pixels:

```sh
tests/probe.sh shot   "Bintana IDE" /tmp/s.png    # capture + geometry to click by
tests/probe.sh pixel  /tmp/s.png 30 49             # srgb(237,216,182)
tests/probe.sh region /tmp/s.png 400x200+300+120   # mean= spread=   (spread~0: blank)
tests/probe.sh diff   /tmp/a.png /tmp/b.png        # pixels that differ
```

A uniform region is an empty one: that is the shape of the blank-band bug, and
`region` is how it stays found.

**3. Look, only for what has to be judged by eye** — does this icon read as a
frame, is this dialog well composed. Crop to the part in question: a window costs
ten times the corner of it that matters.

When a screenshot and an in-app measurement disagree, believe the measurement.

Three things that will waste your time:
- **The window manager places the window differently on every run.** Get the
  geometry from `probe.sh shot` (or `xdotool getwindowgeometry --shell`) and click
  relative to it. Hardcoded coordinates from an earlier screenshot land outside
  the window and look exactly like "the app lost focus".
- **Activate a window before clicking it.** GTK draws an unfocused window greyed
  out (`:backdrop`) — which looks exactly like every button being disabled — and
  the click that focuses it is eaten. `probe.sh shot` activates; a bare `xdotool
  click` does not.
- **Capture the window, not the screen**, and make sure no earlier instance
  survived (`pkill -x bintana`). A leftover window overlapping the new one produces
  screenshots of a state that no longer exists — which reads as a rendering bug
  and is not one. Menus and drag icons are the exception: they are separate
  surfaces and only appear in a root capture.
- **An uncaught error in a handler used to be a paragraph on stderr that nothing
  read.** The runtime prints one and carries on, which is right for an
  application -- a handler that throws should not take the window down -- and
  wrong for the suite: `GitForm` threw six TypeErrors into a run that reported
  *0 failed*, because the phase that opened it asserted the window existed and
  moved on. Every assertion it made was true and the window was broken.
  `tests/ide` installs `Application.OnError` now and counts one as a failure,
  with the first frame of its stack. **A new phase does not have to remember
  this**, which is the point; what it does mean is that a test deliberately
  provoking an error has to catch it.
- **`tests/ide/Driver.js` is forty-nine phases, and the phase is the scope.** It used
  to be one 4000-line generator where every `const` shared one scope, so a name
  near the top collided with one added at the bottom and the suite died with
  `SyntaxError: invalid redefinition of lexical identifier` — three times in one
  sitting, over declarations 2000 lines apart. Add assertions inside the phase they
  belong to; a name only has to be unique within it now.
- **`tests/widgets` selects where `tests/ide` runs a prefix**, and the difference is
  the shape of the tests, not a missing feature: the widget tests each build what
  they need and delete it, so any one of them can run alone (`run.sh widgets record`
  is 71 assertions in 0.2 s). Its couplings are declared in `NEEDS`, both ways --
  the async tail checks what `Terminal` and `TimerShorthand` set up, so asking for
  either brings the other. A test whose deferred half lives in the tail and does not
  say so answers with half its assertions and looks complete.
- **The phases are a narrative, so a run can stop early but not start late.**
  `./tests/run.sh ide designer` runs the prefix ending at that phase —
  424 assertions against 3083 for the whole project -- 9.2 s against 409 to 624 on this
  machine -- which is what makes iterating on an early phase bearable. Each phase works on the project the ones before it built and
  renamed, so selecting one in the middle *alone* would fail on state that was
  never created.
- **The desktop grabs bare function keys.** On Xfce, `F2`, `F3` and `Alt+F2` open
  the application finder and never reach the app. Menu `shortcut` accepts a list
  for this reason: *Find next* is `["F3", "<Control>g"]` and only the second one
  fires here. Verified by hand — the accelerator is registered and correct, and
  the key simply never arrives.
- **And a stolen key steals the focus with it, which makes every test after it
  lie.** Pressing `F3` at the IDE opened the finder *in front of it*, so the next
  `Ctrl+G` went to the finder and looked like a broken accelerator, and the next
  `Escape` looked like an event the runtime never delivered. Both were fine. When
  a key does nothing, check `xdotool getactivewindow` before believing the app is
  at fault — and `pkill -x xfce4-appfinder` (never `pkill -f`, whose pattern
  matches the shell command containing it, killing your own shell).

Copy a project to `/tmp` before driving it interactively — a stray drag plus a
save will edit `examples/hello` for real.

## Test traps

- **The suite is headless by default, and that is a mechanism replacing a rule
  that failed five times.** `asan.sh` exported `HEADLESS=${HEADLESS:-1}` first,
  after four sanitizer runs went onto the user's desktop -- each of them the
  whole suite, dozens of windows over whatever the user was doing. `run.sh` went on
  needing the prefix by hand for a while longer, and was walked into again; both
  export `HEADLESS=${HEADLESS-1}` now, with `-` so an explicitly empty one still
  reaches a real screen. "Remember to" is not a mechanism. The same goes for a probe of your own under `/tmp` -- `xvfb-run`
  is one word. Even driving one by hand does not need the user's screen: xvfb is a real
  X server and `xdotool` works against it, so a resize or a click done "for
  real" belongs there too.
- **`HEADLESS=1` is read by `tests/runner`, the suite's own runner. The binary
  does not read it at all.** `HEADLESS=1 ./build/bintana <project>` is a window on the user's desktop,
  and it *looks* exactly like the safe thing right up until it opens -- which is
  how a catalogue probe went onto the user's screen twice, sixty seconds each. Run an
  ad-hoc project with **`tests/try.sh <dir>`**, which is `xvfb-run` and cannot be
  forgotten; going back to a real screen there is `HEADLESS= tests/try.sh`, and
  it should be a question you can say out loud (an icon, a theme). Debugging
  under `gdb` changes nothing about this: `gdb --args xvfb-run -a ./build/bintana
  <project>` debugs the same binary on a display nobody uses, and a bare
  `gdb ./build/bintana tests/widgets` is a windowed suite on the user's screen held
  open by a breakpoint.
- **And a real screen is worse than an inconvenience: it fails assertions.** A
  run on the user's desktop put every window *on that screen* — dozens of them,
  taking the focus, and a stray click on one moves the focus and breaks whatever
  was measuring, which is a plausible source of any one-run-in-three failure.
  Measurements differ too: the same `tests/ide` that passes under xvfb failed a
  `Calendar`'s drawn size on that session, because the theme and the font are not
  the ones the numbers were written against. So `HEADLESS=` is for a question
  about the real desktop, never for an ordinary run. The exception is
  the one AGENTS.md already names: icons resolve against Adwaita under xvfb, so a
  run that is about an icon has to be a real one (`tests/ide` answers two
  assertions more on a real theme, which is that difference and not a bug).
- **When Xvfb is missing, ask for it; another virtual display is a false red
  suite.** `run.sh` exports `HEADLESS=1` and the runner's only way to honour it
  is `xvfb-run`, so a machine without `xorg-x11-server-Xvfb` stops with *no
  display and no xvfb-run* — and the tempting next move is a display that is
  already there. **Measured, on this machine, in one afternoon:** under
  `weston --backend=headless` the windows map and are never allocated, and
  `tests/widgets` came back **3215 passed, 75 failed** — `Bounds()` answering
  0x0, `never became true`, `expected 372x200, got 400x229` — every one of them
  a layout assertion reading as a real bug in code nobody had touched; the same
  weston with Xwayland did not finish a run at all. With `Xvfb` installed the
  same tree is **3263 passed, 0 failed**. The dependencies are in
  [`docs/installing.md`](../installing.md#running-the-test-suite), and **when
  one is missing the right move is to ask whoever is at the machine to install
  it** — not to improvise a substitute and not to run on their screen. A
  missing tool is one sentence; the alternatives cost more to disbelieve than
  the install costs to do, and the half hour spent on them is the half hour
  this note exists to save. `sudo dnf install xorg-x11-server-Xvfb xdotool` is
  the whole of it here.
- **A test that walks a focus order has to own every stop in it.** `Fixed1` in
  `tests/widgets` had five children by the time `testTabOrder` ran — a scroller
  another test left in it, focusable — so "past the last one the focus leaves"
  walked into it and read exactly like a broken sort. Add a container of your own
  and put the controls in that.
- **And it has to re-grab the focus in the tail, not only before it.**
  `testTabOrder` grabbed once, synchronously, and walked in the async tail after
  every other test -- where anything shown since may have moved the focus, and
  the walk then fails with the focus sitting on the first control, which reads
  as a broken order. Adding six PDF exports shifted the tail's schedule enough
  to make that deterministic: three green-or-red runs became three red ones, and
  the bisect blamed the exports while the bug was the grab. Every walk in that
  test grabs first now, including the first one.
- **`gtk_widget_child_focus` refuses a widget that is not mapped**, answering
  false and moving nothing, and `Form_Open` runs *before* the window is
  presented. `grab_focus` does not care, so `SetFocus()` works there and every
  walk fails — which looks like the order being wrong rather than the window not
  being up yet.
- **A test that shows a window of its own changes the frame timing of the
  pushed-surface assertions in `testExec`**, which measure a form on the frame it
  settles and read `gap 16` back as `0` about one run in three. Not a new bug:
  `testFileDialog`'s choosers did it first, and the guard there waits for two
  equal readings, which two polls can both satisfy before the second layout pass.
  `DefaultButton`/`ActivatesDefault` are early in `TESTS` for this, and the real
  fix is a stronger guard in that test rather than an ordering that has to be
  remembered.
- **Submitting a modal with an xdotool key can haunt the run.** `key` sends
  down, waits 12 ms, sends up; a dialog that submits and closes inside that gap
  takes the up down with it -- `BadWindow` on the send, the release never
  processed, the key held server-side. What follows is auto-repeat into the
  newly focused window: the opener button re-fires and a phantom dialog sits
  there, one per submit, each invisible to a window capture of the main form.
  A thousand repeats were measured before anybody looked at the log. Submit
  with a mouse click (clean), and read `BadWindow` after a dialog-submit key
  as the signature. Real users cannot hit this: a physical release routes by
  focus instead of at a corpse. Found driving `examples/kanban`.
- **A test that opens a file chooser breaks the test after it, not itself.** A
  `Dialog.OpenFile`/`SaveFile`/`SelectFolder` is modal and nothing in JS can
  close one, so it stays on top of the form the next test measures: one left open
  turned `testExec`'s pushed-surface assertions red (`gap 16` read back `0`) while
  `testFileDialog` passed on its own, and the failure reads exactly like an anchor
  bug in code nobody touched. `Dialog.Color`'s two get away with it; a file dialog
  does not. Which is why the suite asserts every **refusal** -- those throw before
  the chooser exists, so they show nothing -- and the accepted options are on the
  by-hand list above. Verifying them is one capture: the title on the frame,
  `Name` in the field, `Folder` in the breadcrumb, and a `*.js *.mjs` filter
  listing `MAYUS.JS`, which is what says the pattern became a **suffix** and not a
  glob.
- **A test that starts a child with a window steals the focus from the suite
  that started it.** The library test spawns the runtime on a scratch project and
  went on with the rest of the run; the child's window took the focus and turned
  three of `testTabOrder`'s assertions red -- the hazard that test's own comment
  warns about, arriving from a direction it did not expect. The fix is
  `this.Visible = false` in the child's `Form_Open`, which runs *before* `Show()`
  returns, so the window is never mapped at all. A child that needs a widget but
  not a window is the shape to reach for: a console project cannot make one.
- **A test that throws on purpose must take `Application.OnError` first, and the
  test it breaks is somebody else's.** An uncaught error with no handler set
  opens a modal `GtkAlertDialog`, and `report_error` opens no second one until
  that one is dismissed (`reporting_error`, which is what stops a handler
  throwing on every tick from stacking dialogs forever). Nothing in a test
  dismisses it. So the moment `tests/widgets` grew a `Draw` that throws
  deliberately, the guard stayed up for the rest of the run and `testErrors` --
  three thousand assertions later, and about nothing to do with drawing -- failed
  with `an uncaught error reaches the application: expected 1, got 0`. Assigning
  `Application.OnError` means no dialog, and the message becomes assertable
  besides; put it back to `null` afterwards.
- **A flag surviving is not the effect happening, and a test that asserts the
  flag passes while the feature is dead.** `TableView.Sortable` read back `true`
  and the headers did nothing: a `.form` applies properties in the order the file
  lists them, which is alphabetical, so `Sortable` was set when there were no
  columns and `Columns` then rebuilt them with no sorter. The assertion
  *"re-declaring the columns keeps them sortable"* checked
  `t.Sortable === true` -- the flag -- and stayed green for the whole life of the
  bug. Two rules fall out of it:
  **assert the effect, not the state that was supposed to cause it**; and where
  the effect needs a pointer GTK will not let you fake, add the API that performs
  it (`SortColumn` is the header clicked from code) rather than settling for the
  flag. Reverting the fix and watching the new test go red is how you know it was
  ever a test.
- **A run that produces no criticals has not passed if the feature never ran.**
  The completion bug "did not reproduce" under Xvfb for a day, and the reason was
  that without the resources there is no popover to present and therefore no
  assertion to fail. A negative result is evidence only once the positive one has
  been seen at least once -- assert that the thing *happened*, not that nothing
  complained.
- **And an assertion about the output pane can pass on somebody else's line.**
  The test for the warning above searched the whole scrollback for the handler's
  name -- which `openHandler` had already logged, two steps earlier, naming the
  same method and the same file. It stayed green with the fix reverted. Take the
  length of `LogView.Text` before the gesture and search only what came after,
  and key on a phrase only the new message uses.
- **A test that waits must be counted, or it does not fail -- it goes quiet.**
  `tests/widgets`' `until` pushes its failure when it gives up, two seconds
  later, and the run had already reported: the assertions inside it never ran and
  the total was six lower than the day before with nothing red to say why. That is
  how the `Resize` bug above survived having a test written for it. `until` now
  counts what is outstanding and `finish()` refuses to report while anything is,
  so a condition that never comes true is a red line and not a smaller number.
- **`Maximized` and `FullScreen` read `false` on a form that was never shown, and
  that is correct.** They are states of a window, not requests remembered like
  `Modal`: GTK answers about the window that exists. A test asserting `Maximized`
  right after setting it fails for that reason and not because the property is
  broken -- assert after `Show()` and an `until(...)`, and expect nothing at all
  from `Minimize()`, which has no reader.
- **Driving the IDE by hand: the click that focuses the window is eaten, and it
  looks exactly like a broken feature.** Selecting a form in the file tree appeared
  to stop opening the designer after a change here -- the tree row highlighted and
  nothing else happened -- and the conclusion "the change broke it" survived two
  more screenshots. It was the focus. `probe.sh shot` activates, but a *sequence* of
  `xdotool` clicks with sleeps between them can still start out unfocused; activate
  immediately before the click that matters, and when a feature looks broken by hand
  while the suite is green, suspect the input before the code.
- **Gestures coalesce, so a probe that clicks twice in the same place is
  measuring a double click.** Two 0.4 s-apart clicks in that same sitting
  produced three `MouseUp`s for five gestures and one `DblClick` that never
  arrived, which read as `MouseUp` being unreliable -- it is not. Leave more than
  GTK's double-click time (1.2 s was ample) between gestures in a pointer probe,
  or the answer is about the coalescing and not about the widget.
- **A throw inside `Form_Open` hangs a phase-limited `tests/run.sh`**, because it
  becomes a dialog and the driver waits for a window that is sitting behind it.
  `Notebook.Append(child, label)` wants a *widget* for the label and threw a
  `TypeError` on a string; the run went to the 120 s timeout with nothing on
  stdout but the traceback. If a `run.sh <project> <phase>` stops producing
  assertions, read the traceback before believing the phase is slow.
- **A throw inside `Form_Open` becomes a dialog and nothing on the terminal, so
  headless it looks like the program worked.** `examples/clients` seeded its
  database with `Object.assign({ ClientId: c.Id }, o)` -- and **most of `Object`
  is not in this language** (`Object.keys`, `Object.assign` and the rest were
  taken away; `Dictionary` replaced them, see `llm/issues.md`). The `TypeError`
  landed in `Form_Open`'s own `try`, went to `Message.Error`, and a twelve-second
  headless run printed *nothing at all* while the application came up with an
  empty table. Two rules out of it: build an object and then assign to it rather
  than reaching for `Object.*`, and when a headless run of an example is silent,
  check what it *wrote* rather than trusting the silence.
