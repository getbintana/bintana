# QuickJS: the fork and the language

The traps and decisions of this area, each with what it cost and the rule it left. [`AGENTS.md`](../../AGENTS.md) states the rules that apply to every change; this file is the evidence behind them and the detail that only matters here.

## The eighteen patches in vendor/

`vendor/quickjs` is a **submodule** of
[`getbintana/quickjs`](https://github.com/getbintana/quickjs), branch `bintana`:
upstream **v0.17.0** plus the eighteen patches below, one commit each (the eighth
carries a fix as a second commit, `1493dc7`, until it is squashed into it). The fork's
`BINTANA.md` is the recipe; what follows is what each patch does and what
dropping it costs.

**And one upstream fix taken before its release: the GCC 14+ fix, `6de8b67`
in the fork, a port of bellard/quickjs `10c81b1`, which made the interpreter two to three times faster here.** `JS_MKVAL`
wrote only the 32-bit half of a `JSValue`'s union, and since GCC 14 (GCC PR
114134) every `js_int32`/`js_bool` inlined into `JS_CallInternal` became a
read-modify-write through the stack. On GCC 16: a 3e7-turn integer
loop went **1650 -> 580 ms** and 2e7 property reads **1092 -> 570 ms**, Release
against Release. It is a port under the eleventh and not a patch,
listed in `BINTANA.md`, and the rebase onto the release that contains it simply
drops it. **The release builds were `-O0` too**: an unset
`CMAKE_BUILD_TYPE` is `Debug` here, and the `package` and `windows` jobs set
none, so the tarball and the zip ran four times slower than the same source
optimised -- `RelWithDebInfo` in both now, as `docs/installing.md` says.

**The runtime never throws an `InternalError`, because upstream made that
class uncatchable from JavaScript** (`db0fe52`, after v0.17.0) -- it means the
engine is in a state nobody should carry on from. The runtime used to throw one
122 times, for ordinary failures a program is documented to catch (`File.Load`'s
*cannot read*, Http, Zip, Sqlite, Media), so on that engine every `try {
File.Load } catch` would have stopped catching with nothing failing to build.
Every one is `JS_ThrowPlainError` now: each was read, and none was a wrong
argument that wanted a `TypeError`. `tests/api` fails on a
`JS_ThrowInternalError` anywhere under `runtime/src`, naming the line, and
`tests/widgets`' `File` asserts a failed `File.Load` is caught as an `Error`
(red on the old spelling). A new throw is `JS_ThrowPlainError`, or a
`TypeError`/`RangeError` when that is what the refusal is. The rebase past
v0.17.0 still has two things to read: the same range changes
`JSInterruptHandler` to take a `JSContext*` (`876442b`, `task_interrupt` in
`bta_task.c`) and compiles an untagged template literal to `OP_add` (`c359cac`),
which is the path patch 1 hooks -- `testDecimal`'s template assertions are the
ones to read.

**A stale `origin/bintana` in the submodule looks exactly like a diverged pin,
and it is not one.** Working on the seventh patch, `vendor/quickjs` sat detached
at a commit whose history had the same seven subjects as `origin/bintana` and
whose trees differed by one hunk -- the `free` a value `JS_DebugSetLocal` returns
early without, on a frame with no locals, which is the `JS_FreeRuntime` abort
patch 4's own note records. That reads as **"the published branch lost a fix"**,
which is what I concluded, wrote into this file, and put in a commit message.

It had not. The fork checkout has its own `.git`, its `origin/bintana` was
already the pinned commit, and nothing was missing anywhere: the submodule's
remote-tracking ref simply had never been fetched since the push. **A
remote-tracking ref is a cached belief about a remote, and the only way to know
is to fetch** -- so

```sh
git -C vendor/quickjs fetch && git -C vendor/quickjs log --oneline origin/bintana..HEAD
```

before concluding anything from `git branch -vv` in a submodule. Two clones of
one repository, one of which is a **working directory of the application rather
than the fork itself**: the fix was where it had always been.

**And a false finding in a commit message is worse than none**, because this
file then repeats it: both were corrected in the amend, and the hunk is what
made me look for the fork checkout at all -- which is where the actual work
belongs. **The patch goes in a checkout of the fork**, on the `bintana` branch,
and the submodule moves to the commit that comes out of it.

An upgrade happens in two repositories:

```sh
# in a checkout of the fork
git fetch upstream --tags && git rebase v0.18.0 bintana   # resolve, build
git push --force-with-lease origin bintana

# in this tree
git submodule update --remote vendor/quickjs              # and commit the pin
```

Then the suite. All eighteen are marked `Bintana patch` in the source, and
**dropping one does not fail to build** -- that is the property they share and
the reason `tests/widgets` asserts each of them (`Decimal`, `JsonFiles`,
`strictChecks`, `testDebugger`, `testCuratedLanguage`, `LongAppend`,
`StringSearch`, `Modules`, `Imports`) -- the
fifth of which carries the seventh, the eighth, the ninth and the thirteenth,
and the last two the fourteenth to the eighteenth. Grep the fork for the
marker after a rebase; there is no build-time check that they survived.
### 1. Operators on a Decimal

`quickjs.h` gains `JS_SetArithHandler`, and four of the arithmetic slow paths in
`quickjs.c` -- `js_add_slow`, `js_binary_arith_slow`, `js_unary_arith_slow`,
`js_relational_slow` -- consult it **before** they reach `ToPrimitive`. One
helper, `js_arith_hook`, maps the interpreter's opcode to a public enum so an
embedder never depends on the opcode numbering.

It is what makes `precio * cantidad + iva` exact
(`runtime/src/bta_decimal.c`), where a value is an exact **fraction** rather than
a scaled integer -- the scaled version could not make `(10 / 3) * 3` be ten, and
that is the assertion to run first if this ever looks broken. quickjs-ng removed the operator overloading and
the `BigDecimal` that Bellard's quickjs carried, so without this the only decimal
possible is `a.Plus(b)` -- which for the audience this language is written for is
not a decimal at all. **Dropping the patch does not fail to build**: the handler
is never called, every operator on a `Decimal` silently falls through to
`ToPrimitive`, and arithmetic answers with doubles again. `tests/widgets`
asserts it (`Decimal`), including that nothing *else* changed -- a patch to the
interpreter's arithmetic is where a language breaks quietly.
### 2. JSON numbers and the decimal comma

`json_parse_number` used `strtod`, which reads the C locale's decimal separator:
`json_parse_number` used `strtod`, which reads the C locale's decimal separator.
The runtime calls `setlocale(LC_ALL, "")` at startup and so does GTK, so on any
desktop that writes a
decimal comma -- es, de, fr, pt, ru -- **`JSON.parse("0.05")` answered 0**, and
silently: a `.form` carrying `Step: 0.05` loaded a spin that would not step, a
rate in a settings file came back whole, and nothing said so. It is fixed by
calling `js_atod`, which is QuickJS's own conversion and what every other number
path in that file already uses.

`tests/widgets` asserts it (`JsonFiles`), and that assertion only means anything
in a locale with a comma -- which is the machine this is developed on, and not
CI's. Check it after any QuickJS upgrade.
### 3. Which property was refused

Three sites that refuse an addition to a non-extensible object threw *"object is
not extensible"*, and the atom was in hand at every one of them. They name it
now: **`no 'Txt' to assign: the object is not extensible`**. Two lines of helper
and three call sites, the same shape `JS_ThrowTypeErrorReadOnly` two lines above
has always had.

It matters because of `bintana --strict`, where a control is made
non-extensible so a misspelt property throws where it is written
(`docs/plans/strict-plan.md`). The point of that mode is to be told *which* name the
class does not have, and without this it says only that something was refused --
which, on a line that assigns three properties in a row, is the wrong half of the
answer.

**Dropping this patch does not fail to build**, and nothing stops working: the
refusal is still a refusal. The message goes back to the vague one, and
`tests/widgets` says so (`strictChecks` asserts `no 'Txt' to assign`).
### 4. The debugger

`quickjs.h` gains `JS_SetDebugHandler`, `JS_DebugStopOnThrow` and six readers --
`JS_DebugPosition`, `JS_DebugBacktrace`, `JS_DebugLocals`, `JS_DebugLines`,
`JS_DebugEval` and `JS_DebugSetLocal` -- and `JSStackFrame` gains two fields. Everything that *decides* anything is in
`runtime/src/bta_debug.c`; the vendor only exposes what its own frames already
hold. `docs/plans/debug-plan.md` is the design and the measurements.
- **The hook is reached through a second dispatch table**, not a branch
  (2026-10-29, the third commit). With computed goto, `JS_CallInternal` picks
  `dispatch_table` or `debug_table` once at entry from `rt->debug_handler`;
  every entry of `debug_table` is the trampoline `case_debug_step`, which calls
  the handler with `pc - 1` and jumps where `dispatch_table` would have. The
  `switch` spelling keeps the old branch. **What it rests on**: the handler is
  installed before any code runs and never removed, so a frame cannot need the
  other table halfway -- an *attach* would break that, and the comment beside
  the macro says where the table would then be re-read. Dropping it does not
  fail to build and fails no test: what it changes is a clock (the ordinary
  road 9-13 % faster), and the record is the table in
  `docs/plans/interpreter-plan.md`, stage 1. Before it, the hook was a branch
  in both spellings of `SWITCH`, measured at **+12.5 % / +16.4 %** before the
  GCC fix and **0 % / about 10 %** after (arithmetic / property reads).
- **The handler is called once per line, not per opcode** (the fourth to
  seventh commits). The frame keeps `debug_pc_lo`/`debug_pc_hi`, the pcs of the line
  `debug_line` was read from -- the whole run of pc2line entries on it, since
  QuickJS writes one per expression for the column -- and `case_debug_step`
  compares the pc with them and calls the handler only outside;
  `bta_line_range` answers the line and its range then, by a binary search of
  a table of runs kept on the `JSFunctionBytecode` (`bta_lines`, decoded from
  pc2line the first time a debugger asks, freed with the function, NULL with
  no debugger). Per opcode the handler had decoded from the start of the
  function, which with the IDE attached and nothing armed made a loop 30 times
  slower; the numbers are in `docs/plans/debug-plan.md`, *What the debugger
  costs while it is attached*. **What it rests on**: inside the range,
  `JS_DebugPosition` would only have answered "the same line", which
  `on_step` returns on before it does anything else -- so a new early return
  in `on_step` that comes *before* the position (a stop that wants every
  opcode) would need the trampoline to call it again. Dropping any of the
  three fails no test: the debugger's tests pass on all, slower.
- **`JSStackFrame.this_obj`** exists because `this` is a *parameter* of the call
  and had no slot on the frame: a debugger could read every local of a method
  and not the one name its body uses most. Borrowed like `cur_func` -- the
  caller holds it for the length of the call -- so it is neither duplicated nor
  marked.
- **`JSStackFrame.debug_line`** is the line that frame was last reported at.
  One line is many opcodes, so something has to say when the program *left* it,
  and a single global "last line" cannot: returning from a call lands back on
  the line that made it, which stopped twice. The memory belongs to the frame
  because the question does.
- **A line with no pc2line entry of its own cannot stop.** QuickJS emits an
  entry where the line *changes*, so two statements it runs together share one:
  `let total = 0;` right under `function Main() {` has none. A breakpoint there
  would arm and never fire, silently. `JS_DebugLines` is what lets
  `bta_debug.c` move it to the next line that exists and tell the IDE where it
  went -- which is why a file is compiled and run in two steps. (It used to be
  one step without `--debug`; it is always two now, because whether a file is a
  script or a module is decided by compiling it -- see *A file with `export` is
  a module* -- and the compile is then the one that runs.)
- **A direct eval cannot read a frame, and that is not a bug to work around.**
  It is the eval that sees an enclosing scope, and QuickJS compiles one against
  a lexical scope index the *compiler* wrote into each `OP_eval`; there is no
  such number for an arbitrary pc, so with none of them arguments and `var`s are
  in scope and a `let` is not. `JS_DebugEval` wraps the expression in a function
  of the frame's own names and calls it with the frame's own values instead,
  which also buys the property worth having: **what an immediate window can name
  is exactly what the values panel shows.**
- **Frame 0 is the topmost frame running *code*.** A throw is reported from
  inside `Error`'s own constructor -- a native frame with no line and no locals
  -- so the numbering skips native frames *at the top*, in one place
  (`bta_frame_first`), and `frame: 1` means the same frame to the backtrace, to
  `locals` and to `eval`. A native frame *between* two JavaScript ones is a real
  part of the stack and is reported as `(native)`.
- **Stopping on a throw is every throw.** Whether something above will catch it
  is not a question the engine can answer when it is raised. The hook is in
  `build_backtrace`, after `in_build_stack_trace` is back down so the handler
  can build one of its own, and it is told apart from the per-opcode call by a
  **NULL pc** -- one handler, because two would be two places to keep in step.
- **The debugger must not stop inside its own expression.** A watch, a condition
  or an immediate runs JavaScript while the program is held; without a flag the
  hook fires inside it and the debugger stops in itself, with the program's
  stack underneath. `dbg.evaluating` is that flag and every entry point sets it.
- **An audit found four ways the channel ended the program wrongly, and each is
  now a rule.** *The IDE going away* set RUN and left every breakpoint and
  stop-on-throw armed, so the next breakpoint said so down a closed pipe and
  SIGPIPE killed the program (exit -13, the code after it never run):
  `detach()` disarms everything on end of input or `EPIPE`, and SIGPIPE is
  **blocked around the write** and taken off the queue with `sigtimedwait`
  rather than ignored, because an ignored signal is inherited by every child
  `Exec` starts. *The debugger's own JavaScript* -- `JS_ParseJSON` of an order,
  the getters `locals` renders -- stopped the program inside the debugger when
  stop-on-throw was on: every order runs under `evaluating`
  (`obey_as_debugger`). *`JS_DebugSetLocal`* returned early on a frame with no
  locals without freeing the value, and `JS_FreeRuntime` aborted (134) -- the
  vendor patch now frees it on every road. *Two orders in one write* went into
  stdio's buffer while `poll` watched the descriptor, and the second waited
  forever: stdin is unbuffered under `--debug`. Two more from the same audit:
  an order past **8 KB** was split by a fixed `fgets` buffer into two fragments
  that each failed to parse, so a long `eval` never answered -- `read_order`
  reads a whole line into a `GString`; and a breakpoint matched the file by a
  **bare suffix**, so one on `Form1.js` stopped in `MyForm1.js` (and an empty
  name in every file) -- `path_is` wants the tail to start at a separator. `testDebuggerOrders` is red on
  the old binary for the second and third; the SIGPIPE half needs the channel
  closed from outside and was measured with a Python driver.
- **A module is a record and not a function, and the readers had to learn
  both halves of that.** `JS_DebugLines` answered nothing for a module (its
  `bta_lines_of` returned on `JS_TAG_MODULE`), so a breakpoint in a module file
  had no line to arm on; it reads the record's `func_obj`, the module body's
  bytecode, now. And **a module's private top-level names are closure variables
  of every function that uses them** -- `const K` in a module, read by
  `twice`, lives in `twice`'s `var_refs` and not in its frame -- so the values
  panel did not show it and `eval` of `n + K` was `ReferenceError`.
  `JS_DebugLocals` and `JS_DebugEval` read `closure_var` through the function
  object's `var_refs` after the frame's own names (an own name hides an outer
  one, as in the code), skipping what a parameter list cannot take (an arrow's
  `this`, `new.target`, the engine's `<...>`). The row carries `Closure: true`.
  The same was always true of a variable a nested function captures from an
  enclosing one; a module made it the common case. `tests/widgets`'
  `modulesDebugger` stops in a module and reads `K` both ways.
- **Dropping this patch does not fail to build.** The handler is never called,
  `--debug` waits for a debugger that can never stop anything, and the IDE's
  Debug menu does nothing at all. `tests/widgets` asserts it (`testDebugger`):
  it runs a real program under `--debug` through `Exec`'s `Control` and `Write`,
  and *the debugger stopped it once* is zero without the hook. `tests/ide`'s
  `debug` phase covers the IDE's half -- the commands, and the gutter mark being
  the state -- and deliberately starts no child, because driving one from there
  says the same thing again, slower and through a window.
- **Three more verbs arrived later, and two of them were already half there.**
  Conditions had been built in the runtime for as long as they existed and had no
  way in from the IDE: `Debugger.armCommand` sent `{do,file,line,id}` and never
  `when`. The way in is one dialog (`BreakpointForm`) for the condition and the
  **logpoint**'s message, and the trap it carries is that **a setting changed on
  a running program is a fresh breakpoint** -- the protocol has no *change a
  breakpoint*, so it is a `clear` by the id that is armed and a new `break`.
  A logpoint is `log` on the same order: the expression is evaluated where the
  program stands, sent as `{"event":"log",…}` and **the program is not stopped**,
  which is why a loop records every turn and holds none. Because a log line is a
  sentence and not a value, `evaluate` gained a `message` mode that hands a
  string back unquoted, where the immediate box and the values panel quote one --
  and the string is unwrapped by the evaluator rather than by `say_log`, so there
  is one place that knows how a result becomes text.
  **`runto` is a one-shot breakpoint**: armed like any other, removed from
  `dbg.breaks` the moment it is reached, so a loop under it stops once; a second
  `runto` drops the first, and it is not announced with `armed` because there is
  no mark for the IDE to move. It appears in `obey` with the other verbs and is
  ignored by an older runtime, which is the whole point of *a verb appears when
  it works* -- and the comment at the end of `obey` had been listing `runto`,
  `eval` and `stopOnThrow` as not built long after two of them were, which is how
  a reader concludes a verb is missing.
  `tests/widgets` holds the protocol (`testDebuggerRunTo`, `testDebuggerLog`) and
  `tests/ide`'s `debug` phase holds the IDE's half: the dialog, the tooltip that
  says both settings, the arm command carrying them, and the refusal of run to
  cursor with nothing running.
### 5. `async` is refused where it is written

Two guards in `js_parse_function_decl2` (`quickjs.c`) turn every spelling of
`async` into a `SyntaxError` on the word itself. Two, because `func_kind`
arrives two ways: a method or an arrow is called with it already set, a
declaration or an expression has it upgraded from the keyword a few lines in.
Both are one `if`.

**What it replaced is the reason it exists, and it is not obvious.** Not
installing `JS_AddIntrinsicPromise` was a decision about the language and a good
one -- but that intrinsic is also **the only thing that registers the engine's
ten async classes**, `JS_CLASS_ASYNC_FUNCTION` among them. An unregistered
class has a NULL finalizer and a NULL mark function, so the object `js_closure`
built for an `async` function never released its bytecode and was never
collected, and `JS_FreeRuntime`'s `assert(list_empty(&rt->gc_obj_list))` aborted
the process at exit -- **after** the program had done its work and called
`Application.Quit(0)`, with an exit status of 134. A build with `NDEBUG` leaked
it in silence instead. It cost nothing for years because nothing in this tree
writes `async`; the day an application did, it would have looked like a bug in
the runtime's teardown and not in a word the manual said was unavailable.

**The intrinsic is installed now, and the decision about the language is
not reversed**: modules need it (a module is evaluated through a promise), so
`bta_new_context` installs it and `bta_close_hatches` deletes the `Promise`
name. What that changes here is only the failure: an async object would now be
collected. The guard stays, because the language still has no promise to give
an async function -- and with the classes registered, `import()` and a module's
top-level `await` went from aborting to working, which is why patch 13 refuses
them beside this one.

The bisection that found it is worth keeping: an async function **inside a
function that is never called** is clean, which rules out the parser and the
bytecode and names the culprit as *creating the object*. That is why the guard
is in the parser rather than in `js_closure` -- the refusal belongs where the
word is, so `Application.CheckSource` sees it and an editor can underline it.

**Dropping this patch does not fail to build**, and nothing stops working until
somebody writes the word. `tests/widgets` asserts it
(`testCuratedLanguage`): seven spellings -- declaration, expression, arrow,
class method, object method, async generator, and one that awaits -- each
refused with a message and a column.
### 6. The parser reports what it declared

`quickjs.h` gains `JS_SetSymbolHandler` and `JSSymbolKind`, and the parser calls
the handler -- installed for one compile and taken out after it -- from
`js_parse_class` (the class at its name, each method at its own), from
`js_parse_function_decl2` (a top-level `function`), and from `set_object_name`
and `js_parse_assign_expr2` (an anonymous class expression, named by the
assignment that wraps it). It is what `Application.Symbols` is: classes, methods
and top-level functions with their line, so an editor does not have to guess
with a pattern.

**The four patterns it retired are the argument.** `FormFiles.hasHandler`,
`openHandler`, `handlersIn` and `Navigator.SYMBOL` each answered *what does this
file declare* differently: one anchored at four spaces, one matched a mention in
a call, all of them found a method in a comment, and the IDE marked handlers as
written and jumped to calls because of it. A parser knows what a comment and a
string are, and there is one of it. It is also faster: **3.4 ms against 5.1 and
6.9 ms**, measured on the IDE's own 110 KB `MainForm.js`.

**Three things about the patch itself are load-bearing.** The handler lives on
the runtime and is installed around a single `JS_Eval(COMPILE_ONLY)` rather than
gated by a flag, because what an embedder wants is one compile's answer and a
handler that stayed would report `rad.js` and every `.form`; a syntax error
still reports what was collected, because half a file is the ordinary state of
one somebody is typing in; and an anonymous class expression is reported *after*
its methods, since its name only exists once the assignment around it is parsed
-- the one case where the order is not source order.

**Dropping this patch does not fail to build.** `Application.Symbols` compiles
and answers `[]` for every source, so the IDE's outline, its handler marks and
its go-to-symbol all go empty together -- with the suite red in `tests/widgets`
(`testCuratedLanguage` asserts the classes, methods and lines) and in `tests/ide`
(`goto` asserts a method typed and not saved is still found).
### 7. The parser reports a class's base class

`JSSymbolHandler` gains a `supertype`, which is the name in an `extends` clause.

**It is the smallest change in this list and the one that was missing for
longer than it looks like it is.** The sixth patch answers *what a file
declares*: a class, its methods, the class a method is in. It does not answer
*what a class has*, and the difference is everything above the class's own
body — `Widget` alone is 66 names, so an editor asking about a library class
was being offered **2 of the 68** it has. Nothing could be done about it in the
IDE: a class in a file the IDE never runs is a lexical binding with no class
behind it, so the runtime's own lookup refuses it too, and **the missing thing
was a class, not a lookup.**

**Three things are load-bearing, and the first is a wrong answer the first
version gave.** The heritage is parsed *after* the class is named, so the report
cannot happen where it did:
- **A class with an `extends` is reported after the heritage is read**, and one
  with none is reported exactly where it was. The property the early report
  existed for — *a half-typed file still lists what it declared* — is kept by a
  third report in the `fail` path, with no supertype, since the heritage is
  either what failed or what was never reached.
- **A `supertype` is captured as a bare identifier and then checked against the
  opcode the heritage compiled to.** `extends mixin(Base)` and
  `extends Base.field` both *start* with an identifier, and trusting the token
  reported `mixin` as the base class — a wrong answer where the comment
  promised none, and the reason the header says "a bare identifier". Four
  opcodes are a name and nothing done to it (`OP_scope_get_var`, `OP_get_var`,
  `OP_get_loc`, `OP_get_loc_check`); everything else reports nothing. No
  lookahead, no backtracking, no reading the bytecode back for a name.
- **Every one of the 207 classes in this tree extends a bare identifier** —
  `Form` 125, `Record` 45, `Component` 30, and six more. That is what makes the
  limit cost nothing here, and it is a measurement rather than an assumption:
  `grep -rhoE "class \w+ extends [\w.]+" --include="*.js"` over `ide/ lib/
  examples/ tests/ runtime/js/`.

**Dropping this patch does not fail to build** and nothing stops working: the
symbol report is the sixth patch's, unchanged in everything but one more
argument. `tests/widgets` asserts it (`testCuratedLanguage`: a class that
extends one, a chain, one that extends nothing, an `extends` that is a call, a
method, and **a class that breaks in its body still carrying the supertype it
read before the break**), and without it the editor's completion of a library
class is the 2 of 68 again.
### 8. The parser reports a member's parameters, and its kind

`JS_SYMBOL_STATIC` / `_GETTER` / `_SETTER` beside `JS_SYMBOL_METHOD`, and a
`params` on every method, in the spelling a declaration uses: `[name]`
optional, `...name` a rest.

**The two arrived in one commit, and the plan said two.** The seventh was going
to be `static`-versus-accessor alone and separable; the parameters are the
parameter loop in `js_parse_function_decl2`, and the kind is only known at the
call site — **so reporting the parameters moves the report, and a moved report
sees the kind for nothing.** Two patches would have been one patch and one
patch that had to wait for the other.

**The parameters are the one answer a host cannot get elsewhere**, and that is
what the seventh patch's author had already worked out from the other side:
ECMAScript discards a parameter's name at parse time, so the function object
keeps the count and not the names, and `Function.length` is a *lower bound* the
moment one parameter has a default. A class in a file the host never runs has
neither. The loop is the last place the information exists — `Make(a, b)` and
`WithOpts(a, b = 1)` and `WithRest(a, ...rest)` all read out of it.

**And a `static` and an accessor were the same answer to three questions.** All
three reach `js_parse_class` as a method of the same name, so
`Application.Symbols` reported `static Make()`, `get Value()` and `turn()`
identically — and the test said `Make` was a `Method`, which is how a
limitation ends up written down as an expectation. `Chart.Refresh` and
`Widget.New` are properties of their class and not of an instance; a `get X` is
a property. The difference is `Value: T` against `Value(): T`.

**Three bugs the shape of it produced, all in the first version.** The buffer
was zeroed *inside* the parameter loop, so only the last parameter of a method
with more than one survived — `Make(a, b)` reported `b`. A rest was marked
optional on top of being a rest, and `...rest` came out `[...rest]`, a rest that
takes nothing. And the parentheses went on nowhere for the first attempt, so the
host received `a` where it expected `(a)`: **the parentheses are added by the
reporter and not by the loop**, which is what makes one spelling for the parser's
answer and for a class's own `Signatures`.

**And a fourth, which every test passed and generated output shipped.** The buffer lived on `JSParseState` -- one for the whole parse -- and
a method is reported *after* its body, so any nested function with a
parenthesised list overwrote it: `Ask(message, options)` with a
`map((x, y, z) => x)` inside reported `(x,y,z)`, and a top-level function,
reported *before* its own loop, carried the previous function's list.
The declaration generator of the time (since removed) wrote
`QrCode.Encode(value, n)` for `Encode(text, opts)` and `Table.Where(row)` for
`Where(sql, ...params)`, and `api.sh` was green, because the generator and the
check read the same parser -- **an oracle that shares its
source with the thing it checks agrees with it, bugs included.** The list is a
field of `JSFunctionDef` now (a nested function has its own `fd`), the function
report comes right after the loop (and in the `fail` path, so a half-typed list
still lists the function), and `testCuratedLanguage` holds every nested shape:
an arrow in the body, a function in a getter, an arrow in a default, two
top-level functions in a row. The same commit gave a `static get`/`set` kinds of
its own (`StaticGetter`/`StaticSetter`) -- it was reported as an instance
getter.

**Dropping it does not fail to build** either, and the fallback is the seventh
patch's answer with no kinds: a member's name and nothing else. `tests/widgets`
asserts it in `testCuratedLanguage` (the three kinds, and the parameters of a
plain, an accessor and a static), and `tests/ide` asserts that a library class's
method says its parameter *names* — which is the half no runtime verb could
reach.
### 9. The parser reports every scope and every declared variable

`JS_SYMBOL_VARIABLE` and `JS_SYMBOL_SCOPE`, and the handler gains an
`end_line`. It is what lets the IDE offer, for a bare name, the parameters and
locals in scope at the cursor rather than every word in the buffer.

**The variable is reported in `js_define_var` and nowhere else**, because all
four declaration paths go through it -- `js_parse_var`, the `for...of` head and
both destructuring branches -- and a `catch` binding does too; four call sites
would have been four places to forget one. The name has been read by then, so
the line is `last_line_num`. **The scope is reported at `done:`**, for every
function the parser finishes -- an arrow and a function expression as much as a
method -- with `last_line_num` as its end, and in the `fail` path with the
current token's line: a function that broke is a scope up to where it broke,
which is the line somebody is typing on. A scope may be anonymous, which is the
one kind `js_report_symbol_span` lets through with no name.

**Every existing consumer filters by `Kind`**, and the ones that did not --
`tests/widgets`' `named()`, and a count of what broken source reached -- were
asserting over *every* symbol and broke on the first run; they ask for
declarations now. Anything new that reads `Application.Symbols` whole wants the
same filter.

**Dropping it does not fail to build**: the report is the eighth patch's with
two kinds fewer, and the IDE's bare names go back to the globals alone.
`tests/widgets` asserts it (`testCuratedLanguage`: each declared name at its
line, a scope with its parameters and span, an arrow, and one that broke) and
`tests/ide`'s `completion` asserts what the IDE makes of it.
### 10. The parser reports each declaration's JSDoc comment

The handler gains a `doc`, and there is one more kind, `JS_SYMBOL_ASSIGNED`.
It is what makes a member written in JavaScript document itself the way a
native one does beside its C entry (see *what a member is for is written once*).

**The lexer keeps the last comment that opens with two stars**, as a span of
the source and the line it ended on, and a declaration takes it
(`js_take_doc`) only when it is adjacent (`js_doc_adjacent`): ending on the
line before or on the same line, with nothing between it and the token but an
identifier, a dot, an `=`, a `*` or whitespace. Without the adjacency the first
version documented a plain method with the last `/** … */` written inside the
body of the one above it. A class's comment is taken at its line, a member's at
its line, a top-level function's before its parameters -- and an anonymous
class held in `pending_class_doc` until the assignment that names it reports it.

**`JS_SYMBOL_ASSIGNED` is a function assigned at the top level, named by its
target as written**: `File.LoadJson`, `Widget.prototype.Dump`. The
assignment's left side and its documentation are *looked at* before the right
side is parsed and taken only if what was parsed made a closure
(`OP_fclosure`/`OP_set_name`), because by the time a function on the right is
read the last comment is one inside its body. **An object literal on the right
reports each function it holds** as assigned to `<target>.<name>` --
`GLOBAL.Settings.Get` -- through `literal_owner`, which the literal takes so a
literal nested inside it owns nothing; a getter is reported with no
parameters and a setter not at all, since it is the same name. The host reads
the target's segment before the member as the owner, and `prototype` before
that as *an instance member*, so whatever the target was reached through does
not matter.

**Dropping it does not fail to build**: every `Doc` is empty, `tests/api.sh`
reports every JavaScript member as undocumented and `tools/docs.sh` stops
writing their rows. `tests/widgets` asserts it (a class, a method with tags, a
comment inside a body documenting nothing, an assigned function with an inline
`@returns`, a literal's method and getter, a nested literal owning nothing, and
the same through `Widget.Members` with `Sources`), and `tests/ide`'s
`completion` asserts a library member's popup row.
### 11. A long append stays linear

`js_rope_push` in `quickjs.c`, called from `JS_ConcatString` when a rope's
open leaf is full: the closed leaf joins the subtree on its left while the two
are the same depth, and the join carries leftwards -- a binary counter. It is
the one patch that is about speed and nothing else, and like 2 and 3 it is a
candidate to send upstream.

**What it replaced was quadratic, and `tests/bench` is what said so.** QuickJS
concatenates through ropes: a short append is copied into the rope's last leaf
until that leaf passes `JS_STRING_ROPE_SHORT_LEN` (512), and then the full leaf
was hung under a **new root, one level deeper**. At `JS_STRING_ROPE_MAX_DEPTH`
(60) the rope is rebalanced, which walks and rebuilds every leaf -- and a
rebalanced rope of a few hundred thousand leaves is already ~26 deep, so the
next rebalance came after another ~34 leaves (17 KB). Measured, appending four
characters at a time: 1e6, 2e6, 4e6 and 8e6 appends took **88, 218, 652 and
2731 ms**; with the threshold raised to 1000 as a diagnosis, 66, 131, 260 and
521. With the patch the rope left of the open leaf is a chain of perfect
subtrees of decreasing depth, about **2 log2(leaves) deep -- 42 at the longest
string the engine allows** -- so the rebalance is never reached: 75, 132, 259,
523 ms. Gambas's `string2` (26 million appends, 104 MB) went **34.8 -> 3.9 s**;
nothing else in the bench moved.

Three things about the shape of it. **A shared rope is never written to**: the
push takes new nodes and duplicates the children it keeps, so a copy someone
held is untouched, which the fork's test checks by appending ropes kept from
earlier. **Only a closed leaf is pushed**: a short append still goes into the
open leaf, or every four-character piece would become a leaf of its own. And
**raising the threshold is not the fix** -- it divides the quadratic term by
sixteen and keeps it.

The fork carries `tests/test_rope_append.js` (40 seeds of appends, prepends and
shared ropes against the same parts joined, plus the linearity); it was clean
under AddressSanitizer with gcc and with clang -- an ASan build routes every
block through `malloc` (`JS_ARENA_LARGE_BLOCKS_ONLY`), so the rope nodes *are*
seen there, unlike the arena note below -- and with `JS_DUMP_LEAKS`. **Dropping
it does not fail to build**: `tests/widgets`' `LongAppend` asserts twice the
appends take less than three times as long, which was 4.45 on the old engine.
### 12. A string search is the C library's

`string_cmp` compares two narrow (8-bit) strings with `memcmp`,
`string_indexof_char` finds a byte with `memchr`, and
`String.prototype.indexOf` (forwards) and `includes` go through
`string_indexof`. Like 11 it is about speed alone and a candidate to send
upstream.

**`indexOf` and `includes` did not even use the engine's own search.** They
compared the needle at every position through `string_cmp`, which reads one
character at a time with `string_get`; `string_indexof` -- what `replace`,
`replaceAll` and `split` use -- at least skipped to the next occurrence of the
first character, a byte at a time. So a search that finds nothing walked the
whole string at about 1.7 ns a byte: `indexOf` of an absent needle over 4 MB,
200 times, was **1343 ms, and 16 ms with the patch**; Gambas's `string1` (a
string growing to 540 KB and `replaceAll`'d 33,768 times) went **10.3 -> 5.5
s**. What is left there is copying -- linearising the rope the `+=` made and
building the result -- which `memcpy` already does.

**The answers are the fork's test and the speed is this tree's.** The fork
carries `tests/test_string_search.js`: seven searches held to ones written out
in JavaScript, 4000 random cases over narrow and wide alphabets, empty needles
and positions past either end, watched to fail on a deliberately wrong
reference. `tests/widgets`' `StringSearch` asserts the speed without a clock:
a **wide** string keeps the loops, so the same search over the same length
narrow and wide is a ratio of the machine with itself -- 1.0 on the old engine
(167 against 167 ms), 30 to 50 with the patch -- and the check is four.
**Dropping it does not fail to build**, and that ratio is what goes red.
`lastIndexOf`, `startsWith` and `endsWith` still compare position by position,
through the `memcmp` now; a backwards search has no `memrchr` the C standard
promises, and the other two compare at one position only.
### 13. `await` and `import()` are refused where they are written

`js_refuse_await` in `quickjs.c`, asked wherever the parser accepts an
`await` -- the expression, `for await`, and `await using` in a statement, a
`for` head and a `for...of` head -- and a guard in the `import` case of the
primary expression that refuses `import(` while the token is still `import`, so
the column names the word. **The fifth patch's other half**, and written for
`docs/plans/modules-plan.md`, whose evidence it is:
- **`import()` compiled, and a program that called it aborted at exit (134)**,
  audit D1: it builds a promise, the runtime registers no async classes, and
  the object is never collected -- patch 5's mechanism by the one door patch 5
  did not guard. **And registering the classes does not make it safe**: the
  modules plan installs `JS_AddIntrinsicPromise` (a module is evaluated through
  a promise), and measured with it, `import()` runs and hands the program a
  promise whose `constructor` is the `Promise` the global deletion took away.
- **A module's top level is the only `await` left.** With patch 5 refusing every
  async function, the one function whose kind is still `JS_FUNC_ASYNC` is a
  module's body, so the guard asks `func_kind` and meets nothing else -- `await`
  stays an ordinary name in a script (`const await = 1` compiles), and inside a
  non-async function it is still the engine's own *unexpected 'await'*. Measured
  in a module with the intrinsic in: `export const x = await 41;` evaluated,
  drained by the job queue and exited 0, which is the language growing a
  promise it does not have.
- **`js_parse_for_in_of` reads `await using` on its own**, without asking the
  function's kind -- the first version guarded the four places that ask and
  `for (await using r of [])` still compiled. A probe that compiles every
  spelling as a module is what found it; the `await` paths are five and not
  four.

**Dropping it does not fail to build**: `import()` compiles again and aborts at
exit, and a module may await. `tests/widgets`' `testCuratedLanguage` asserts the
`import()` half (two spellings, refused at the word's column, and `import` and
`await` still names in a script) and is red on four assertions without the
patch; the top-level `await` half is `Modules`' (three spellings, at the
word's column), since it needed a module to be compiled at all. The fork's own `make test` stays 0/118: the nine
upstream tests it now refuses all use top-level `await` or `import()`, the way
patch 5 already refused the ones using `async`.
### 14. A module compiled to be looked at can be thrown away

`JS_FreeUnevaluatedModule` in `quickjs.c`: `js_free_module_def` for a record
still `UNLINKED`, nothing for one the context has linked or evaluated, and
`JS_FreeValue` for anything that is not a module. `Application.CheckSource` and
`Application.Symbols` free what they compiled with it.

**`JS_FreeValue` never frees a module**, and nothing says so: a module value is
refcounted, but a record lives in the context's `loaded_modules` list until the
context goes, so freeing the value only drops a count. A script compiled to be
checked is collected; a module text compiled to be checked stayed. Measured on
`ide/modules/Designer.js` (136 KB) with `export` added: **923 KB a
`CheckSource` plus `Symbols`**, against 1.4 KB for the same text as a script --
and an editor checks the file on screen at every pause in the typing, so the
IDE would have grown by a megabyte a pause in any module file. With the patch,
0.3 KB. Stage 2 of the modules plan shipped with this, and stage 3 wrote it
down as open; the measurement is what made it the first thing stage 4 did.

**Dropping it does not fail to build** (the call goes back to being a
`JS_FreeValue`, so remove the calls with it): `tests/widgets`' `Modules` checks
a 1500-function module forty times and asserts the process grew by less than
4 MB -- 78 MB without the patch. **Not under `tests/asan.sh`**, and the reason is
a trap of its own: AddressSanitizer's quarantine holds what is freed, so the
resident size there measures the quarantine -- a *script* grew 1.3 MB a check,
and the assertion read 296 MB with the patch in; `quarantine_size_mb=0` makes
both 4 KB. The test skips itself when `ASAN_OPTIONS` is set, which `asan.sh`
exports. A memory assertion by RSS is an assertion about an unsanitized build.
### 15. The parser reports what a module exports and imports

`JS_SYMBOL_EXPORT` and `JS_SYMBOL_IMPORT` for the handler of patches 6-10,
reported by `js_report_module_entries` once an `export` or `import` statement
has parsed, at the line of its keyword. **Every spelling of either ends in three
tables of the module** -- export entries, star exports, import entries -- so the
report reads the entries the statement added instead of hooking `js_parse_class`,
`js_parse_var` and the function parser one spelling at a time; a statement that
broke reports nothing, since its entries are half filled. `Application.Symbols`
hands them out as `Kind: "Export"` (`Name` the exported name, `default` or `*`;
`Parent` the local name) and `"Import"` (`Name` the local name, `Parent` the
imported one), with the specifier in a new field, **`From`** -- the handler
carries it in the slot a class keeps its base in, and the runtime moves it so
`Super` stays a base class. Two things that are easy to get wrong: an import's
local name is on the closure variable `add_import` made, and `var_idx` *is* that
variable's index (the first version searched the closure variables for an equal
`var_idx`, which is the module's import count and not the same number); and
`export default <expression>` stands for the engine's own `*default*` binding,
which is reported as no local name rather than leaking that spelling.

**Dropping it does not fail to build**: no row says `Export` or `Import`, so the
IDE offers a module's private names again, the outline marks nothing and F12
does not follow an import. `tests/widgets`' `Imports` asserts the rows of every
spelling and `tests/ide`'s `modules` phase what the IDE makes of them.
### 16. A compile reports the free names it uses

`JS_EnumFreeNames(ctx, compiled, cb, opaque)` hands the embedder every name a
compiled script or module looks up in the global scope, each with the line of
the use, once per use. **It reads the final bytecode, not the parser**: after
the last pass a name nothing in the file binds is an opcode carrying its atom
(`get_var`, `get_var_undef` for `typeof`, `put_var`, `delete_var`,
`make_var_ref`), and the walk is `JS_DebugLines`' -- the function, then its
constant pool -- with `find_line_num` for the line. A report from the parser
would have had to follow the scope analysis by hand; the bytecode is its
answer. A declaration at a script's top level (`define_var`, `define_func`,
`put_var_init`) is not a use; the `with_*` forms are not globals.

**What it is for is the load-time half of stage 4**: `bta_compile` notes each
file's free names (`note_uses` in `bta_module.c`), and `bta_modules_check`,
once every source has loaded -- and in a worker once its file has run -- refuses
a file that uses a name two modules export, with *`Use.js:12: 'Parser' is
exported by Csv.js and Ini.js: choose one with import`*. **The getter's throw
at the use was not enough, and the reason is order**: a file loaded between the
two owners read the first one's value in its top-level code, silently -- the
second owner only made the name ambiguous after. `Modules`' `ambiguousUse` is
that case, and with the check taken out it prints `EARLY function`.

**Dropping it does not fail to build** (the call is the only use): every file
loads, a name two modules export is refused only where it runs, and the
`Modules` and `Imports` assertions about the load go red.
### 17. Which module an export's binding belongs to

`JS_GetExportOrigin(ctx, m, name, &local)` answers, for an exported name of a
linked module, the name of the module whose own binding it is and that
binding's local name -- `js_resolve_export`, the engine's own walk through
`export { x } from`, `export *` and their chains; an `export * as ns` answers
the module it names, with `*`. **What it replaced was a comparison of values**:
`distribute` called a second exporter of a name a re-export when the two values
were `===`, which is right for a class or a function and wrong for a number --
two files each declaring `export let count = 0` passed for one owner, `count`
answered the first file's forever, and an increment in the second was
invisible. A review found it by asking the IDE, which counted files and warned
where the runtime was silent. An owner is now `<path>\n<local name>`, so one
binding handed out by several files is one owner and two bindings are two,
whatever they hold.

**Dropping it does not fail to build**: every owner is the file that
distributes, so a re-export becomes a second owner and refuses every use of
the name. `Imports`' `reexportValue` and `sameValue` hold both directions.
### 18. A module's own top-level names, and free names without `typeof`

`JS_EnumModuleDeclarations(ctx, compiled, cb, opaque)` reports the closure
variables a module body creates itself (`JS_CLOSURE_MODULE_DECL`) -- its
top-level `let`, `const`, `function` and `class`, exported or not; an import is
another kind and `*default*` is skipped. `JS_EnumFreeNamesFlags` is patch 16's
walk with `JS_FREE_NAMES_SKIP_TYPEOF`, which leaves `get_var_undef` out.

**What it is for is a forgotten `export`.** Making a file a module turns every
name it does not export private, silently, and a file elsewhere that used one
finds out with *X is not defined* on the day that line runs -- a migration of
`bintana-project` lost `CONSTRAINT_SNET` (the second name of a `const` list)
past a careful pass and only a rich harness caught it. `bta_modules_check` now
refuses at load a file that reads a name some *other* module declares and keeps,
when nothing else in the program answers it (no global property, no script's
top-level binding), and **lists every such use**, not the first -- adopting
modules file by file is exactly when several are missing, and one per run is a
migration by trial. That list is also the answer to *what does this file have
to export*, which is why no verb for it was added. **`typeof X` is not a use**:
it asks whether a name exists, and `testModules`' own *private name stays home*
assertions are written that way -- which is how the first version, without the
flag, found the exemption by going red on three of them. An ambiguous name
still counts a `typeof`, since its getter throws for one as for any read.

**Dropping it does not fail to build** (the calls are the only uses):
`Modules`' `private`, `privateAnswered` and `exportNothing` go red.

## The language: what the curation took and what it left

- **A worker gets `Locale`'s facts and not its catalogue, and the split is the
  process boundary.** `Number`, `Date`, `Currency`, `Parse`, `DecimalPoint`,
  `Compare` and `Matches` read `localeconv` and the C library's collation --
  properties of the process that every thread inherits, which is why .NET's
  `CultureInfo`, Java's `Collator` and Qt's `QCollator` all work off the main
  thread. `Text`, `Plural`, `Context`, `Current` and `Available` read `L`, the
  process-global hash table the main thread fills and can reload mid-run, so
  they are a race and not merely prose out of place; `Read`/`Write` go with
  them, being the catalogue editor's pair. `bta_locale_init_facts` builds the
  object from **the same `locale_props` table** and deletes the prose names, so
  there is one definition of the surface and the extractor and the docs see one
  list -- a second table would be a second list to keep in step. The assertion
  is `testTask`'s: a worker orders `Ana` before `Bruno`, folds `Córdoba`, and
  has no `Locale.Text`.
- **A wrong answer that looks like the right tool is worse than a missing one,
  and `localeCompare` was the case that proves it.** With no ICU it compared
  code units, so `"Álvarez".localeCompare("Zapata")` was `1` -- and measured,
  `list.sort((a, b) => a.localeCompare(b))` returns **exactly** what
  `list.sort()` with no comparator returns. It was not a rough approximation of
  alphabetical order; it added nothing at all, while carrying the name of the
  thing that would. Five documents warned about it and nothing ever argued for
  keeping it. It is a `TypeError` naming `Locale.Compare` now.
  **The refusal lives in `rad.js` and not in `close_hatches`** for one reason
  worth reusing: a deletion says only *not a function*, while a replacement can
  say what to use -- the same bargain as the QuickJS patch that made the
  extensibility refusal name its property. Either place would have reached both
  sides; **a worker calls `bta_close_hatches` too** (`bta_task.c`, right after
  its own `task_delete` list, which is about main-thread globals and not about
  hatches), so the `gone[]` list is one catalogue and not two. The worker used
  to get a **different sentence**, because `Locale` was not installed there at
  all and sending it to `Locale.Compare` would have been the second wrong
  answer in a row; `bta_locale_init_facts` gives a worker the half of `Locale`
  that needs no catalogue (`ISSUE-worker-locale-order`, deleted as answered),
  so it is one sentence on both sides now.
- **The bare `sort()` is the half of that which cannot be refused**, and after
  the refusal above it is the one that stays silent. It gives the same wrong
  order and never consults the locale -- a comparator-less `sort` compares UTF-16
  code units by specification, so this is true on every desktop and under `C`.
  It cannot go the same way as `localeCompare` because it is *right* almost
  everywhere it is used: all 26 bare sorts in this tree order paths, file
  extensions, class names, namespaces and the keys of a bag, and **not one of
  them sorts text a person reads**. So this one is documentation and an
  assertion rather than a refusal, and `a < b` is in the same position.
  There is deliberately **no `Locale.Sort`**: `list.sort(Locale.Compare)` is the
  whole of it, nothing in the tree wants more, and a name gets published when
  something needs one -- the rule `close_hatches` states when it empties
  `Object`.
- **`RegExp` is gone and regular expressions are not, which is the whole of what
  taking the name buys.** `/x/g` is syntax and still makes one, so the removal
  could only ever reach `new RegExp(p, flags)` -- the engine built from a
  *string* -- and that is the half worth having: a dynamic pattern has one
  spelling now, `Regex`, which captured the constructor before `close_hatches`
  ran. `RegExp.prototype.constructor` goes with the name, or
  `(/(?:)/).constructor` hands the function straight back; what that read falls
  through to is `Object`, which cannot make a pattern. The documents said for
  years that this "would buy little" and left it; `architecture.md` and
  `runtime-api.md` now say what changed, and the 14 `new RegExp(…)` in the IDE
  and `tests/styles` are `Regex` and literal patterns.
  **And the flag that was only reachable through the constructor is
  `{ Unicode: true }`.** Measured: without it `\p{L}` does not throw -- it
  compiles and matches the literal text `p{L}`, so a Unicode pattern that is not
  a literal was silently wrong rather than missing -- and `.` counts UTF-16
  units, so an emoji is two matches. `Matches` steps a **code point** on an empty
  match under it, which is what `Symbol.matchAll` does; stepping a code unit
  would start the next match inside an emoji.
- **The editor's find bar is a different regex engine, and three differences are
  the kind a pattern notices.** `SourceEditor.Search(text, { Regex: true })` is
  GtkSourceView's `GtkSourceSearchContext`, which compiles with GRegex/PCRE2 --
  read from 5.20.0: `compile_flags = G_REGEX_MULTILINE` always, `CASELESS` when
  the setting says so, `G_REGEX_MATCH_NOTEMPTY` at match time -- and GLib turns
  PCRE2's UCP on for every pattern (2.74 and later). So in the find bar `^` and
  `$` match at every line whatever the pattern, `\d`/`\w`/`\b` are Unicode-aware
  (`ñ`, `٣`), `$` also matches before a final newline, and PCRE2 grammar
  (`\p{L}`, `\K`, atomic groups) is available. In a `Regex` the same text is
  ECMAScript: ASCII `\w`, one line unless `{ Multiline: true }`, `\p{L}` behind
  `{ Unicode: true }`. Two engines in one application, documented where each is
  read -- `library.md`'s `Regex` section, the `Search` row, the `SourceEditor`
  page and `widgets.md` -- because a find bar and a lint that share a pattern
  otherwise disagree in silence.
- **A runtime answer must not be breakable by what the program did to `Error`.**
  `Application.CheckSource` returns `{Message, Line, Column}` and the position
  has exactly one source: a QuickJS error carries no `lineNumber`,
  `columnNumber` or `fileName` (measured, all three `undefined`), so
  `check_position` parses `<check>:LINE:COL` out of `.stack`. That made two
  ordinary assignments break it silently -- `Error.prepareStackTrace` replaces
  the string, `Error.stackTraceLimit = 0` empties it, and both returned
  `Line: 0, Column: 0` for source whose answer is `2:9`, **with the message
  still correct**, so the IDE underlined the first character and nothing said
  why. The second is the likelier: it is what somebody sets to quieten a log.
  `js_check_source` neutralises both for the length of the compile and hands
  them back untouched. The rule generalises: **when a runtime verb reads
  something the program can configure, it reads its own copy.**
- **`for...in` is safe from the builtins, and not for the reason the manual gave
  for years.** It said *nothing can put anything on a prototype any more*, which
  was three claims stacked and only one true. Measured: `for...in` over `{a:1}`
  answers `[a]` -- `toString` and its siblings are reachable (`"toString" in {}`
  is `true`) and simply **non-enumerable**, which is the engine's doing and has
  nothing to do with emptying `Object`. So the safety is real and would survive
  any further curation. But `Object.prototype.x = 1` still works, and from then
  on `for...in` recites `x` over every bag in the program.
  **And the program cannot defend itself**: `freeze`, `seal`,
  `preventExtensions` and `isExtensible` all went with `Object`'s statics, so
  there is no way to lock the prototype and no way to ask whether anything wrote
  to it. That makes the old sentence not merely false but unfalsifiable from
  inside the language. It stays a small risk only because an import reaches only
  the project and its `uses` libraries: the only code that can do it is the project's own and its `uses` libraries.
  **`Dictionary.Keys` is immune** -- it is the `Object.keys` `rad.js` captured,
  own and enumerable -- which is the strongest argument for it and was written
  down nowhere.
  Do not file this under the `in`-operator trap above: that one is about
  **non-enumerable** inherited names, which `for...in` never sees. Two different
  mechanisms, and confusing them is how somebody fixes the sentence and leaves
  the bug.
- **Every name the runtime looks something up by is ASCII, and that is narrower
  than the language it is written in.** QuickJS takes `Peón` as an identifier --
  `Application.CheckSource("class Peón {}")` answers `null` -- and
  `is_identifier` does not: `bta_runtime.c`, `bta_form.c` and `bta_task.c` each
  keep a byte-at-a-time copy on `g_ascii_isalpha`. It covers a `.form` node's
  `type` and `name`, `startup` and `entry`, and a `Task` subclass. **The three
  copies refuse three different things with three different sentences**, so a
  single fix does not cover them and reading one tells you little about the
  others: `bta_runtime.c` answers *"'%s' is not a valid class name"*,
  `bta_form.c` answers *"form: '%s' is not a usable control name"* and is about
  the control's `name` rather than its `type`, and `bta_task.c`'s is not a
  refusal at all -- a folder it cannot spell contributes no namespace prefix and
  what is under it stays findable by its bare name, which is deliberate and says
  so. A *file* called `Peón.js` is indexed; it is the class the code declares
  that has to be spellable, and that is refused later at lookup with the first
  sentence, which is what makes it read as *the class is missing*.
  Documented in `formats.md` and `llm/forms.md` rather than widened: reading
  UTF-8 means unifying three copies first, to enable something nobody has asked
  for, and a class name is also a file name.
- **`Object.assign` is not in this language, and nothing says so until the window
  closes.** `saveWindow` used it for a day and `Form_Close` threw `not a function`
  -- on the commonest way out, which no suite phase drives except `session`. It
  was green in `designer`, `widgets` and `api`; only the `session` prefix saw it.
  Run the prefix that ends at the *file you changed's own phase* and not only the
  nearest one.
**`tests/ide` always passes a project, so `Form_Open`'s no-project branch is
  never taken.** Reading a field in `refresh()` that only `listFiles()` fills
  crashed `bintana ide` on startup with every one of the 967 assertions still passing —
  the welcome-page ones included, because the crash happens *after* them. Anything
  `refresh()` touches has to be declared as a class field (which is what the note on
  those fields says), and the driver now calls `ide.refresh()` on the welcome page
  to cover it.
- **`Regex.Replace` hands its function one argument, and JavaScript's habit is
  three.** `(m, g1) => "x" + g1` wrote `xundefined` per match with nothing
  said, and `(m) => {}` wrote `undefined`; the contract lived in a comment.
  A function declaring a second parameter is refused before anything runs
  (`Function.length`, so `(m, g = 1)` slips through -- it is the habit that is
  caught, not every spelling), and an answer that is not text or a number is
  refused naming the match. `new Regex("x", "i")` -- RegExp's flags -- is
  refused as a string; walked by `for...in` it was its indices and the refusal
  said `'0' is not one of its options`.
- **`JSON.stringify` writes `NaN`, both infinities and an `undefined` in a list
  as `null`, and says nothing -- so `File.SaveJson` refuses them.** A `0 / 0`
  in a setting came back from the file as a null nobody stored. The check is
  `SaveJson`'s replacer, which sees each value after its `toJSON` exactly as the
  text will, and a `WeakMap` from each holder to its path is what lets the
  refusal say `items[3].x` and not `x`. **There is deliberately no option to
  allow them**: `File.Save(p, JSON.stringify(v, null, 2))` is that option
  already, and the refusal says so. `JSON.stringify` itself is left the
  language's, and an `undefined` in an *object* is still a key that is not
  there. A `Record` never reaches this: `Field.Number` refuses a non-finite
  value on the way in.
- **`key in bag` asks the prototype, and the curation did not take
  `Object.prototype` away.** Every plain object still inherits `toString`,
  `constructor`, `valueOf` and `hasOwnProperty`, so `Settings.Has("toString")`
  answered **true**, `Settings.Get("toString")` answered a **function** for a
  name nothing ever set, and `Record.Load` silently **dropped** an unknown key
  called `toString` or `constructor` -- breaking the documented promise that a
  key the record does not describe survives the round trip, which exists so an
  older program cannot delete a newer one's field by saving the file. A declared
  field whose file key is inherited read the inherited function and complained
  about a key nobody wrote.
  **`for...in` is not the trap** and never was: `Object.prototype`'s members are
  non-enumerable and are never recited. The trap is `in`, and a plain `bag[key]`
  read used as a boolean -- `taken["toString"]` is a function, which is truthy.
  `Dictionary` had it right from the start (`hasOwn.call`, in `Dictionary` in `rad.js`) with
  the reasoning written above it; `Settings` and `Record` are the two that did
  not reach for it, and `Settings` disagreed with itself -- `Keys()` used the
  captured `ownKeys` while `Has` and `Get` beside it used `in`. **Own keys or
  the prototype answers: `hasOwn.call(bag, key)`, never `key in bag`.**
  `rad.js` itself had three more, found last: `regexFlags` accepted
  `new Regex("x", { constructor: true })` because `"constructor" in REGEX_FLAGS`
  is true and then appended the inherited *function* to the flags string, so the
  refusal came out as a syntax error about garbage; and `Table.Insert`/`Save`
  asked `k.Column in decided` about a serialised row. **A bag of own values is
  never asked with `in`** -- the class that had it right from the start is the
  one to copy.
- **The JS stack budget is bytes, and what it buys is levels -- a different
  number in each build.** `JS_SetMaxStackSize` is what stops a recursive walk of
  a widget tree before it reaches the real end of the stack, and the walks are
  recursive because the data is: the serialiser, the loader, the designer.
  Measured, serialising a tower of `Panel`s: **2 MB is a hundred levels in an
  ordinary build and ten under AddressSanitizer**, whose frames are about ten
  times fatter. Ten is exactly the depth of `MainForm.form`, so the sanitized
  suite had no headroom whatever and `tests/ide` failed in the `projects` phase
  with `Maximum call stack size exceeded` -- green in every ordinary run, red
  under the sanitizer, on a tree nobody had touched. Which is precisely the false
  failure `tests/asan.sh` exists to avoid producing rather than to produce. The
  budget follows the build now (6 MB under a sanitizer, 25 levels), both numbers
  well under the thread's 8 MB so a runaway still throws instead of crashing, and
  `tests/widgets`' `DeepSerialize` asserts fifteen levels in whatever build is
  running. **If you make a walk of the tree deeper per level, that is the number
  to re-measure.**
- **What a trip from JS into C costs here, measured**, because more than one
  design decision turns on it and guessing has gone both ways: a trivial getter
  is **290 ns**, a two-argument method **465 ns**, a string setter **505 ns**, and
  a method that returns a fresh object (`Bounds()`) **1,570 ns** -- 200k
  iterations each, QuickJS, no display. So a 16 ms frame holds tens of thousands
  of calls, not hundreds; and **an accessor that allocates an object is 3-5x one
  that returns a number**, which is the argument for `TextWidth(s)` over a
  `TextSize(s)` returning `{Width, Height}` in anything called in a loop.
  The other half of the same measurement: **filling a JS array costs 405 ns per
  element**, so feeding a batched call costs about what making the calls would
  have. QuickJS is an interpreter and the interpreter is the floor -- batching an
  API buys ~2x, never 100x. The table is in
  [`docs/architecture.md`](../architecture.md#what-a-call-across-the-boundary-costs),
  and the cairo half of it in
  [`docs/widgets.md`](https://github.com/getbintana/bintana-docs/blob/main/docs/widgets.md#drawingarea-and-painter).
- **A `JSValue` string is not `malloc`'d, so `tests/asan.sh` cannot see you free
  it and use it.** QuickJS here has its own **arena allocator**:
  `js_malloc_rt` -> `js_arena_malloc`, and `js_arena_free` does **not** call
  `free()` for a small block -- it pushes the block back onto
  `rt->arena_state.free_arena_list` and hands it to the next allocation of the
  same size class. Only a *large* block goes to `rt->mf.js_free`, which is the
  system one. AddressSanitizer poisons what went through the interposed
  `malloc`/`free`, so **every small `JS_FreeCString` is invisible to it**: the
  memory is free and the sanitizer has no idea, and the next `JS_NewString` in
  the same class has usually already overwritten the bytes.
  Measured, deliberately, on the use-after-free this verb had on its own refusal
  path -- `JS_FreeCString(ctx, type)` and then `JS_ThrowTypeError(ctx, "Members:
  '%s' is not a class", type)`, which is the **only** line in the function that
  throws and therefore the only one anybody ever reaches by mistyping a name.
  `tests/asan.sh` over `widgets` reported **nothing**, and neither did it with
  `quarantine_size_mb=256:thread_local_quarantine_size_kb=8192`, which is the
  setting that exists exactly to stop a recycled block from looking live. The
  test was green in both runs, so the only way that bug was ever going to be
  found was by reading it.
  **So the oracle this file leans on is narrower than the file says.** "Both
  memory bugs this codebase has had were use-after-free... the sanitizer says so
  on every machine" is true of the *GTK* ones, where glib's allocator is the
  system's, and **false of anything that is a `JSValue`, a `GBytes`, or a glib
  slice**: read the C, and do not treat a clean `asan.sh` as evidence. A
  *large* `JSValue` string -- past the arena's threshold -- does reach `free()`
  and is caught, so the family is invisible exactly where a short name puts you.
