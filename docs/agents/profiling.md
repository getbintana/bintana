# Profiling and measured costs

The traps and decisions of this area, each with what it cost and the rule it left. [`AGENTS.md`](../../AGENTS.md) states the rules that apply to every change; this file is the evidence behind them and the detail that only matters here.

## Profiling: Sysprof, and what the marks are for

`runtime/src/bta_profile.c`. A sampled profile of this runtime is a stack of
`JS_CallInternal`: QuickJS interprets, so no native frame names the `.js`
function that was running. The marks are the other half, and they are also the
half that is assertable -- a capture is a file, and `tests/widgets`' `Profile`
reads a child's back.

**Two roads in, one `profile_emit` underneath**, because the two APIs disagree
about their arguments and would otherwise drift. The **collector**
(`sysprof_collector_mark(time, duration, group, name, message)`,
`SYSPROF_CONTROL_FD`) is what GTK itself uses under `sysprof-cli` or the
application's *Profile a new process*, and a run under it carries the samples
and GTK's frame marks besides. A **capture file**
(`sysprof_capture_writer_add_mark(writer, time, cpu, pid, duration, group,
name, message)` -- `duration` in a different place and unsigned) is
`--profile <file>`: no Sysprof installed, opened in the application later.
The IDE's *Project → Run with profiling* is that road (`Runner.start(true)`):
the capture goes to `Environment.TempDirectory`, the log names it, and it opens
in `sysprof` when there is one -- `tests/ide`'s `p_running` runs it with the
opening turned off (`openCaptures`), since Sysprof is a window.
`SYSPROF_TRACE_FD`, which is what `sysprof-cli --use-trace-fd` sets, takes the
writer road too, the way an app calling `sysprof_capture_writer_new_from_env`
is expected to.

What bit, or would, in the order it was learned:
- **The times are microseconds on `CLOCK_MONOTONIC`**, which is exactly
  `g_get_monotonic_time()`. Sysprof's own `example/app.c` comments say
  *nsec* in three places and are wrong; the header
  (`sysprof-clock.h`) is `tv_sec * 1000000 + tv_nsec / 1000`.
- **`group` and `name` are truncated by the capture format** (24 and 40
  characters, `SysprofCaptureMark`), silently; `message` is not. A mark whose
  name is a long handler wants the message.
- **The writer is not thread-safe and the collector is.** A `Task` marks from
  its own thread -- that is the work a capture wants attributed most -- so the
  writer is held under one `GMutex`. The collector keeps a buffer per thread and
  locks only in its shared mode, which this process does not reach.
- **A counter is not a span, and one name has an id per road.** `Profile.Counter`
  keeps a table of name to the ids the collector and the writer handed out (the
  collector numbers from `(pid << 16)`, the writer from 1), defines each counter
  once on the roads that are live and sets it after -- the writer's
  `define_counters`/`set_counters` want the `time, cpu, pid` triple the
  collector's do not, which is why this is its own function and not a flag on
  `profile_emit`. The table is under its own mutex and written from workers; the
  value is a double, which is what a JavaScript number is; and
  `SysprofCaptureCounter` keeps **31 characters of the name**, silently, the
  same bargain marks make at 24 and 40. `bta_profile_finish` destroys the table
  -- a capture writer is flushed by unref and this one is not, so leaving it
  would be the last allocation standing at teardown.
- **GTK's frame marks are the distribution's build, not ours.** Fedora's GTK
  4.22 carries `libsysprof-capture` and calls `sysprof_collector_mark` itself
  (measured: `../src/libsysprof-capture/sysprof-collector.c` in
  `libgtk-4.so.1`), so frames appear under the collector with no line here. A
  GTK built without profiler support contributes none, and a `--profile` file
  never carries them -- that road has no samples either.
- **Nothing is initialised until somebody listens.** `bta_profile_start` reads
  `--profile` and the two `SYSPROF_*` variables once; with none of them there is
  no `collector_init`, no writer, no allocation, and each instrumented point is
  a load of one bool (`bta_profile_begin()` answers 0, `bta_profile_end` returns
  on it). `Profile.Active` is `false` and `Begin`/`End`/`Mark`/`Counter` are
  no-ops -- **including `End`'s mismatch refusal**, which would otherwise make an
  instrumented application fail wherever it is not being profiled. `Counter`
  alone still refuses a value that is not a finite number with the profiler off,
  deliberately: arguments are checked the way every other verb's are, because a
  program's typo should not wait for a capture to be noticed.
- **The event span sits inside the handler check**, so the ~3850 dispatches per
  pointer sweep this file measured, with one handler among them, raise one mark
  and not 3850. The label is built (`g_strdup_printf`) only when the profiler is
  on, and it is what the dispatch looked up: `<Name>_<Event>`. **The end stamp is
  read before the label is built** (`bta_profile_end_at`), so the profiler's own
  string work is not charged to the handler -- which on a 3.6 us handler would
  be a share of it, and exactly the kind of error that matters when the question
  is a microsecond one. The same rule for `Script`, whose basename is built
  after the end is taken.
- **`Profile.Begin` spans are per thread and nest LIFO** -- a worker has its own
  -- and a mismatched `End` throws naming both, rather than putting one span's
  time on another's name. `bta_profile_finish` frees an open stack for the main
  thread; a worker's goes with the `GPrivate` destructor.
- **For callgraphs worth reading, build with debug symbols and frame
  pointers** -- the default `Debug` build has both; a release wants
  `-g -fno-omit-frame-pointer`. One project at a time, since one capture file
  holds one run: `tests/try.sh --profile /tmp/w.syscap tests/widgets 12345`, or
  `sysprof-cli -- ./build/bintana ide examples/hello`.
- **`BINTANA_PROFILE=<dir>` profiles the whole suite, one capture per project.**
  It is an environment variable because the runner **builds** each child's
  command line: `./tests/run.sh --profile x` would hand the flag to the runner,
  which is not the program being measured. The runner reads it and turns it into
  `--profile <dir>/<project>.syscap` on each child. One file per project and not
  one for the suite, since a capture is one run and several processes writing
  one file would truncate each other's.

Measured on one development machine (Debug build): `--profile` over `tests/widgets` writes a 125 KB
capture carrying **1199 marks** (1065 `Event`, 88 `Draw`, 79 `Form`, 35 `Task`,
10 `Script`, the rest `Save` and the one `Startup`), and `sysprof_capture_reader`
reads every one of them back; the same suite passes with the profiler off, where
nothing is written at all.

**The first harvest was the IDE, and the event marks are what it found.**
`--profile` over `tests/ide` is 3.9 MB and **37,449 marks** in 354 s with the
suite green (2818 assertions then; 3139 today) -- against 431 s for the ordinary runner run, so
the writer's per-mark cost does not show at this size. 37,238 of those marks are
`Event` and 211 are the runtime's (`Bintana`); **28,402 of them are one
handler**, `PropGrid_Filter` -- the property grid's filter answering GTK for
every row of every rebuild, 76 % of the capture. **That count is not a cost, and
reading durations rather than counting marks is what the second look is for**:
the same handler is **104 ms of the whole run** (28,402 calls at 3.66 us, max
32 us) -- a row-table lookup and a string compare, asked once per row per
rebuild, about 40 rows times the ~700 rebuilds a driven IDE does. Exclusive
(leaf) time over the same capture -- a mark's duration less the marks nested
inside it, since the spans nest and a parent's inclusive time carries its
children -- puts `Click` first at **1.94 s**, then `BtnSave_Click` 249 ms, and
`Editor_Cursor` **216 ms over 252 calls, 0.86 ms each**, which is the
per-keystroke live check a person would feel; `PropGrid_Filter` is eighteenth.
**A capture counts *and* times; the first capture counts and the second reads
the clock.**

**The first optimization that harvest paid for was `Editor_Cursor`, and the
spans were temporary.** Four calls it made on every caret move were found by
putting `Profile.Begin`/`End` around each -- the IDE does not carry them now --
and measured before and after over the same `tests/ide` phase (a phase, because
a full profile is 6 minutes a run): `Launch.show` **0.43 → 0.16 ms**, of which
the manifest was read three times (`this.all`, then `this.chosen`, then `named`)
and the run-config radio menu was rebuilt whether or not it said anything;
`Completion.declaredClasses` **0.94 → 0.07 ms**, because it asked
`TabSet.contentOf` for every open tab and a designer's answer was
`serializeForm()` -- the whole drawn form -- per question; and
`Widget.Members` was **2.9 ms** of that same check for a runtime global,
because `rawMembers` handed the project's sources to a namesake the sources do
not declare and the runtime parses every one into an index before it looks --
**0.37 ms** once the sources are passed only where a source declares the name.
`this.` completion parsed the file per caret move, now once per text. Over the
whole project the event went **216 → 184 ms over 252 calls (0.86 → 0.73 ms)**.
Two attempts did not pay and are
written down so they are not tried again: **`File.Info` is 141 us** -- it
queries the content type and renders themed icons for `Icon` -- so stamping a
cache with it saved exactly nothing over the read it was meant to skip; and
sharing `declaredClasses`' parse with `this.` completion re-reads every open
tab's text, which on a big file measured *worse* than one parse per editor text.
**A cache key has to be cheaper than what it guards, and the obvious key is
usually not.**

**And a profiled by-hand run has to reproduce the runner's screen.** The first
attempt used a bare `xvfb-run -a` (and so does `tests/try.sh`), whose default
screen is smaller than the runner's `--server-args=-screen 0 1280x1024x24`, and
eight geometry assertions failed -- panes that did not grow on a resize, a hint
that would not fit beside a call. Every one read as the profiler changing the
layout; none had anything to do with it.

## Profiling the interpreter: perf, and what is left

`perf record` over `tests/bench --child <program>` against a `RelWithDebInfo`
build is the profile of the engine (Sysprof's marks are the profile of a
program). Four things measured with it, after the eleventh and twelfth patches:
- **At `perf_event_paranoid` 2, the kernel half of a call chain is what is
  refused**: `perf record -g` (and `--call-graph dwarf`) answers *Failure to
  open any events for recording*, which reads as "perf does not work here" --
  and I wrote that into a plan twice, first about perf and then about call
  graphs. **`--user-callchains` is the whole fix**: `perf record -e
  cpu_core/cycles/u --call-graph dwarf,16384 --user-callchains` works, and
  user space is all there is to see here. DWARF and not frame pointers, since
  the runtime is not built with them; read the stacks with `perf script` and
  aggregate by the frame you want (the caller of `styles_rebuild` was found
  that way). A flat profile by `--sort dso` and
  then `--dsos bintana --sort sym` is enough to split a workload between the
  interpreter and GTK; to profile a suite, put a script in `BINTANA=` that
  `exec`s `perf record ... build-rwd/bintana "$@"`, and read it per process
  (`--sort pid`, then `--pid`), since `perf` follows the children the tests start.
  What that split found is in `docs/plans/interpreter-plan.md`, stage 0.
- **On a hybrid CPU (performance and efficiency cores) `perf` records two events.** Without
  `-e cpu_core/cycles/u` the report shows `cpu_atom/cycles` first, and its 23
  samples -- start-up, on an efficiency core -- put `do_lookup_x` in the
  dynamic linker at 52 % of `sort`. It is nothing; the 9 000 samples on the
  performance cores are 90 % `JS_CallInternal`. Read `# Samples:` before a
  percentage.
- **What is left is the interpreter and the value size, not a function to
  fix.** `polynom` and `sort` are 90 % `JS_CallInternal`; `primes` is 27 %
  `set_value`, which is a store into an 80 MB array of 16-byte `JSValue`s and
  so a cache miss, not code; `btree` is object creation and property lookup
  (`find_own_property`, `JS_SetPropertyInternal2`, the arena) -- QuickJS has no
  inline caches, so every `this.left` is a hash lookup, and adding them is a
  project rather than a patch.
- **A global costs 5 to 10 % over a local, measured**: a call through a
  top-level function 514 against 477 ms over 1e7, a top-level `const` 292
  against 271, `new` of a top-level class no difference. Every Bintana program
  is globals, and it is not worth changing.
- **The debugger's per-opcode check showed in `perf annotate`** (`movq
  0x500(%r12)` and a `testq` before each dispatch), and is gone from the
  ordinary road: a second dispatch table is chosen when a handler is installed
  (stage 1 of the interpreter plan, built 2026-10-29: 9-13 % on a loop, measured
  interleaved on one pinned core). **Check `uptime` before believing a bench
  run** -- a browser tab at 99 % once moved the whole bench from 30 to 39 s,
  with spreads of 900 ms -- and pin a core (`taskset -c 2`) for a comparison of
  two binaries: interleaved runs on one core spread 1-2 ms.
- **What a program pays under the IDE is the hook, not the dispatch.**
  Attached with nothing armed, a loop ran 13 to 30 times slower than without
  `--debug`: `find_line_num` per opcode (it decodes pc2line from the start of
  the function) and a `poll` per line. Both are gone, and the trampoline now calls C only
  where the pc leaves its line (`debug-plan.md`, *What the debugger costs while
  it is attached*); two to four times is what is left. Measure it by feeding the child a `continue` on stdin and
  sending descriptor 3 to `/dev/null`:
  `(sleep 0.3; echo '{"do":"continue"}'; sleep 60) | build-rwd/bintana --debug <project> 3>/dev/null`.

**What to do about it, and in what order, is [`docs/plans/interpreter-plan.md`](../plans/interpreter-plan.md)**: measure a real workload first, the debugger's check second (built), inline caches last and only past a gate -- upstream had them and took them out (`7de6d46`).

**And QuickJS is compiled with `-funsigned-char` now**, as upstream's CMake
and Bellard's Makefile always did -- this tree passed `-w` alone, so the
engine was built with a signed `char` on x86 and an unsigned one on ARM. No
difference was found (the fork's tests are 0/118 both ways, and its byte
handling reads `uint8_t`), which is why it is alignment and not a fix.

## What things cost, measured

- **The appearance stylesheet is read back, which is why its rebuild can only be
  held for a stretch with no JavaScript in it.** Every `Font`, `Padding`,
  `Radius`, `Shadow`, `Color`, `Border`, `Scale` or `Opacity` reloads the whole
  accumulated sheet, so loading a `.form` was quadratic in its styled controls:
  **50 → 112 ms, 100 → 667 ms, 200 → 2392 ms**, measured, against 5 ms for the
  same form with none. `bta_form_build` holds the rebuild around the whole tree
  and drops it once (**counted** -- a component with a `.form` of its own nests
  one build inside another), which is 14.8 ms at 200.
  **Coalescing it on an idle instead is wrong and looks right**, which is the
  part worth remembering: a `DrawingArea` takes its ink from its control's style
  context and `Save()` draws **synchronously**, so a program that sets
  `Foreground` and saves a PNG in the same turn gets the theme's colour.
  `tests/widgets` says so in one line -- *a drawing takes its ink from the
  control's Foreground* -- and two of `tests/ide`'s designer assertions agree.
  The rule generalises past CSS: **before deferring anything, ask what reads it
  back and whether that reader waits for a frame.**
- **And the same value reloaded it too, which was the commonest case.** A
  `perf` with call graphs over `tests/ide` up to `designer` put
  `styles_rebuild` at **13 %** of the run, 480 of its ~690 samples under
  `w_set_color`: the designer's selection chrome (`ide/modules/Chrome.js`)
  gives its four outline bars and eight grips their colour on every relayout,
  and the colour is nearly always the one they have. With 300 styled controls
  on the display one such assignment cost **4.5 ms**. `bta_widget_style_apply`
  now compares the rule it built with the one the control has and stops there
  when they match: `styles_rebuild` 13 % -> 4.3 %, the phase **10.0 -> 7.7
  billion cycles (-23 %)**. In the runtime and not the IDE, since every
  application assigns what it already has. `testStyleSameValue` holds it by
  ratio (907 against 903 ms before, the same value nearly free after).
- **A tooltip set brings the window's styles up to date.**
  `gtk_widget_set_tooltip_text` answers every set with a tooltip query that
  picks the widget under the pointer (`_gtk_widget_find_at_coords`), and the
  pick validates CSS: 44 of a designer session's restyle samples were
  `w_set_tooltip`. The same text is not set again now. What is left (about
  2 %) is the property grid giving the editors it builds per selection their
  first tooltip -- a real set, and the query looks at the window under the
  pointer whether or not the widget is in one yet, so it is GTK's to pay.
- **What the rest of a designer session's restyling is**, attributed by the
  first runtime frame on each stack: the frame clock's own validation after a
  change (most of it), `bta_fixed_layout_measure` asking a child its size, and
  `bta_container_attach` styling a child it adds. Each needs the styles it
  computes; none was a value set to what it already was.
- **The other four cost claims were measured and are fine, and the numbers are
  here so nobody has to guess again.** An external audit named five places the
  runtime is slow; one of them was real and is the paragraph above. These are
  the rest, on one development machine, so a future *this looks expensive* has something to
  be compared against:
  - **A class looked up with no `.form`** compiles its identifier through
    `JS_Eval` per instance (`bta_lookup_global`). Two hundred project
    components: **2 ms** over the same form built from runtime classes, so about
    10 µs each.
  - **A `.form`'s prose-membership walk** (`bta_widget_text_prop_field`, once
    per property per node, `g_strsplit` every time) is inside a **5 ms** floor
    for two hundred controls -- it does not separate from the noise.
  - **Dispatching an event with no handler.** Every widget carries a motion
    controller at `GTK_PHASE_BUBBLE`, so a pointer over a twelve-deep tree
    raises **12.8 dispatches per position**, each building `<name>_<event>` and
    walking the form's prototype chain for a property that is not there.
    Measured over three full sweeps: 3850 dispatches, **one** of which found a
    handler, **580 ns each** and **2.2 ms** of continuous movement in three
    seconds. It scales with *depth*, not with handlers -- which is the wrong
    way round -- and is still 0.07 % of a core.
  - **Emptying a container** runs `indexOf` and `splice` through the interpreter
    on `__children`, which is superlinear: 100 children **1.4 ms**, 200 **3.7**,
    400 **10.5**, 800 **34.2** with `Clear()`. **`Clear()` is twice as fast as
    deleting children one at a time** (68.8 ms at 800), which is worth knowing
    because it is already the documented verb and now has a reason.

  None of the four is worth changing at the sizes a form reaches. What made them
  worth measuring is that the fifth, which read the same on paper, was two and a
  half seconds.
- **`form_path` walks the project on every miss, and a class built in code
  misses forever — deliberately, and here is the number to reconsider it
  against.** The index maps a class name to its `.form`; a hit is a hash lookup
  and a **miss throws the whole index away and re-walks the project and every
  library**, because a miss also means *a `.form` that appeared since*, which is
  the normal state of affairs while the IDE writes forms in the directory it is
  running from. The comment over the function argues that trade and the argument
  is good.
  What it does not say is that the other half of its own *or* — a class built
  entirely in code, which is legal and documented — misses on **every**
  instantiation, and that a miss is a **filesystem walk** whose cost scales with
  the project rather than with the program. Measured, a form of 200 components
  with no `.form` of their own:
  | project | that form | the same form of runtime classes |
  |---|---|---|
  | 6 files | 7.3 ms | 5.4 ms |
  | 300 files | **67.8 ms** | 5.3 ms |
  | 300 files + a library in `uses` | 69.5 ms | 5.4 ms |

  So about **0.31 ms per instantiation at 300 files**, against 0.01 ms at six,
  and the runtime-class form does not move at all.
  **Left as it is on purpose.** 70 ms is perceptible and not broken, and the fix
  that would work -- treating the index as a cache of the filesystem and
  invalidating it when *this process* writes under the project, since `File.Save`
  is the same runtime -- turns a heuristic into an invariant at the price of a
  silent failure if any writing verb is ever missed. That failure is precisely
  the one the current design exists to prevent.
  **Reconsider when** a project is big enough that opening a form is felt, or
  when components built in code become common -- **which `Widget.On(event, fn)`
  now encourages, so this is the live half of this note rather than the
  hypothetical one.** A palette or a list of cards built from `new <Component>()`
  is exactly the shape that misses on every instantiation, and the table above
  is what it costs. The same question belongs to `task_class_file`, which
  rebuilds on a miss too and for a cheaper reason: there, a miss means
  `Task.Start` is about to throw.
- **And the smallest one, measured anyway because reasoning about it is how the
  others went wrong.** `bta_sys_pending` walks two `GList`s about fifty times a
  second, and only in a **console** project -- `run_console` arms the poll, so an
  application with a window never asks. **20 ns a call**, so 1 µs per second of
  runtime. Counters would be state to keep in step for nothing.
  **The first attempt at that number said 3.1 µs, which is 150× wrong**, and the
  reason is worth more than the measurement: timing one call with
  `g_get_monotonic_time` on either side measures the clock. Two of those cost
  **88 ns** between them and the function returns **microseconds**, so a 20 ns
  body is rounding noise sitting under an instrument four times heavier than
  itself. **Time a thousand iterations and divide** -- and when a micro-benchmark
  reports something surprisingly expensive, suspect the instrument first.
- **Five things a static analyser flags here that are not leaks**, each read and
  dismissed, so the next run of one does not cost the same afternoon:
  `w_set_style` in `bta_widget.c` (freed by `g_clear_pointer`, with the strv beside it by
  `g_strfreev`), `combo_set_items` in `bta_controls.c` (`strv` by `g_strfreev` before
  it returns), `cal_marks` in `bta_controls.c` (a `NULL` widget cannot reach it --
  every caller guards), `http_server_parse_allow` in `bta_http.c` (the list and its
  elements are freed on both early-outs) and `notebook_get_action` in
  `bta_notebook.c` (the output is assigned on every path that returns success).
