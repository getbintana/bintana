# Modules: a file that keeps its own names

**Status: stages 0 to 4 done (2026-10-11 and 12).** The spike changed nothing
and found nothing that sends the plan back; its results are under stage 0.
Stage 1 is fork patch 13; stage 2 is `runtime/src/bta_module.c`, and
`lib/markdown` is its first module; stage 3, the explicit `import`, is the same
file's loader; stage 4 is the IDE's half and fork patches 14 to 16.

It answers L1 and D1 of [the October 2026 audit](../audit-2026-10.md): one
global scope for every file and library, and a dynamic `import()` that compiles
and then aborts the process at exit.

## What the application needed

Bintana has no modules on purpose. Every class and function declared at the top
level of any `.js` of the project is visible from every other one, with no
`import` line -- the model of VB and Gambas, and the reason a `.form`'s `type`,
`startup`, `main`, `Task.Start` and `Widget.New` can all find a class by its
bare name. That half works and this plan keeps it.

What does not work is the other half of the same decision: **nothing is private
to a file**, so names collide. Measured, with a console project naming
`uses: ["markdown"]`:

- **A helper of the author's silently replaces the library's.**
  `lib/markdown/Markdown.js` declares `function slug(text)` for heading anchors.
  A project that writes its own `function slug(s) { return s.toUpperCase(); }`
  changes every anchor the library makes, with no error:

  ```
  without it: {"Kind":"Heading", ..., "Id":"precios-y-condiciones"}
  with it:    {"Kind":"Heading", ..., "Id":"PRECIOS Y CONDICIONES"}
  ```

- **A constant of the author's stops the program from starting.**
  `const GAP = 8;` in the project is `SyntaxError: redeclaration of 'GAP'`,
  pointing at the author's line -- `GAP` is the library's, along with `PAD`,
  `LIGHT`, `DARK`, `INDENT`, `heading`, `strip`, `inline`, `cells`, `blocks`.

- **The libraries already defend themselves by hand.** `lib/qr` prefixes every
  top-level name (`qrSegment`, `qrInterleave`, `QR_EXP`, `QR_BLOCKS`): C's
  namespacing, written out. `lib/markdown` did not, and the two probes above are
  the result.

- **Most of what is global would be private if it could be.** Of the 280
  top-level names in `ide/forms` and `ide/modules`, **221 are used only in the
  file that declares them** (`GRID`, `PAGE`, `SHEET`, `HUNK`, `HANDLE`,
  `FOLDER`, `PREVIEW`, `LOG_MAX` …), and all 221 occupy the one scope every new
  file has to avoid. Counted with a grep of top-level declarations against
  whole-word uses in the other files; it over-counts sharing (a common word
  matches anywhere), so 221 is a floor.

Gambas has no `import` either, and has none of this: each file has a scope of
its own. **The missing thing is a file scope, not an import statement.**

## The design

Standard syntax, one Bintana rule on top of it:

1. **A file with no `export` and no `import` is evaluated as it is today**: a
   script in the shared scope. Nothing written so far changes, the IDE's 30 000
   lines included.
2. **A file with an `export` is a module.** What it exports is visible in every
   file of the project **without an `import`**; what it does not export is
   private to the file.

   ```js
   // Prices.js
   const IVA = 0.21;                       // private to this file
   export function withIva(n) {            // visible in the whole project
       return n * (1 + IVA);
   }
   ```
   ```js
   // Invoice.js -- no import, as today
   withIva(100);                           // 121
   ```

3. **A name exported by two owners is distributed to nobody**; every other name
   of both owners still is. Two libraries that both export `Parser` load fine.
4. **Using an ambiguous name without an `import` is an error naming both
   owners**: *'Parser' is exported by csv and ini: choose one with import*.
5. **An explicit `import` is standard JavaScript and is scoped to its file and
   to the name it brings.** It fixes one conflict in one file and asks nothing of
   any other:

   ```js
   // Importer.js
   import { Parser } from "csv";            // here, Parser is csv's
   const p = new Parser();
   const t = withIva(100);                  // still arrives by itself
   ```
   ```js
   import { Parser as CsvParser } from "csv";
   import { Parser as IniParser } from "ini";
   ```

   This is the language's own shadowing -- a binding of the file wins over the
   shared scope -- so nothing has to be invented for it.

So whoever never has a conflict never writes an `import`, whoever has one
writes one line in one file, and whoever comes from JavaScript writes what they
already know. What stops in every case is a collision nobody is told about.

`export` is the standard keyword with a non-standard reach. Two consequences to
state where an author reads (`bintana-llm`'s language chapter, which today says
*"There are no imports"*): somebody who knows JavaScript will read an `export`
with no `import` beside it as unfinished code; and a project file that relies on
the implicit reach does not run unchanged in Node or a browser. A library file
that exports and imports nothing does.

### What an explicit `import` also buys

Three things the implicit rule cannot give, and which are why `import` is
accepted at all rather than refused:

- **A `Task` knows what its file needs.** A worker loads the file of the task
  class and nothing else, so `examples/sheets/SheetReader.js` carries its
  helpers in itself and says so in its header. Loading every exported file into
  the worker is not the answer -- forms among them need `Form`, which a worker
  has not got -- but the graph of a task file's explicit imports is exactly what
  it needs.
- **Load order follows from the code.** `examples/quote` depends on `Line`
  being evaluated before `Quote` (`Field.List(Line)` runs while `Quote` is
  declared), and the only fix today is the order of `sources` in `project.json`,
  with an error that does not mention it. An imported name is evaluated first by
  the engine's own module linking.
- **Two owners of one name can both be used**, through `as`.

## Why this is not free: modules need promises

**QuickJS-ng evaluates a module through a promise.** `js_evaluate_module`
creates one with `JS_NewPromiseCapability` (`vendor/quickjs/quickjs.c`, near
33636), and the runtime does not install `JS_AddIntrinsicPromise` -- `Promise`
is not part of the language. That intrinsic is also the only thing that
registers the engine's async classes, and their absence is the whole mechanism
behind patch 5 (`async` refused in the parser), behind `Array.fromAsync` being
deleted in `close_hatches`, and behind D1: `import()` builds an object of an
unregistered class that is never collected, and `JS_FreeRuntime` asserts.

So the precondition is: **install the intrinsic, delete what it publishes**
(`Promise`, and anything reachable from it -- `close_hatches` already deletes
by name), keep refusing `async` and `import()` in the parser as a decision about
the language rather than as a guard against a collector hole, and **drain the
job queue** (`JS_ExecutePendingJob`) after evaluating each module. Whether
anything else then becomes reachable that returns a promise is a stage 0
question.

Registering the classes is worth having on its own: the family of *"an object
of an unregistered class is never collected"* stops being possible, which is a
better guard than finding its doors one at a time.

## Stages

### Stage 0 -- spike, no changes kept

On a branch, measured and thrown away:

1. Install `JS_AddIntrinsicPromise`, delete `Promise` in `close_hatches`. Does
   `./tests/run.sh` stay green, and is `./tests/asan.sh` clean at teardown?
   List every builtin that can now hand a program a promise (anything
   `JS_NewPromiseCapability` is called from, minus what is refused).
2. Evaluate one file of a project as a module (`JS_EVAL_TYPE_MODULE`), copy its
   exports into the shared scope, and call them from a script file. Measure the
   compile-and-evaluate cost against today's per file, over the IDE's sources.
3. Does the debugger work on a module? Today a file is compiled and run in two
   steps under `--debug` (`bta_runtime.c`, the `bta_debug_compiled` call); a
   module compiles to a module record, not a function. Breakpoints, locals and
   `eval` in a module function.
4. Does `Application.Symbols` (patches 6-10) report a module's declarations, and
   can it say which are exported?
5. **How a file is recognised as a module.** `JS_DetectModule` is not the
   answer: it compiles in a fresh runtime and answers *true* for nearly every
   strict script. Candidates: compile as a script and, on a `SyntaxError` whose
   position is an `export`/`import` keyword at the top level, compile again as a
   module (two compiles, only for module files); or have the symbol handler
   report a top-level `export`/`import` (a fork patch).

If any of 1-3 fails, the plan is rewritten.

**Done, 2026-10-11: none failed.** The spike code was thrown away; what it
measured, point by point:

1. **The intrinsic costs nothing the suite can see.** `JS_AddIntrinsicPromise`
   in `bta_new_context` and `Promise` deleted in `close_hatches`: `tests/run.sh`
   is 8637 passed, 0 failed, and `tests/asan.sh` the same with no report.
   `typeof Promise` is `undefined` and `async` is still refused by patch 5.
   **`import("./x.js")` no longer aborts** -- it answers a promise and the
   process exits 0, which confirms D1's cause -- **and that promise is the
   hatch**: `p.constructor` is the `Promise` constructor the global deletion
   took away. So stage 1 is not optional once the intrinsic is in. The other
   builtins that make a promise (`js_async_function_call`,
   `js_async_generator_next`, `js_async_from_sync_iterator_next`) are reached
   only through syntax patch 5 already refuses; `JS_LoadModule` and
   `JS_PromiseThen` are the embedder's.
   **One more door, found here**: a module may `await` at its top level
   (`export const x = await 41;` evaluates, drained by the job queue, exit 0).
   Stage 1 refuses it beside `import()`. `import.meta` is reachable too, and
   answers `{}`.
2. **A module costs what a script costs.** All 70 files of `ide/forms` and
   `ide/modules` compile as modules unchanged, and compiling the 70 is 44.3 ms
   as modules against 45.6 ms as scripts (20 passes, a fresh runtime per file).
   Evaluating one and copying its namespace onto the global object is the
   whole of rule 2: with a project naming `markdown`, a module declaring a
   private `slug` and `GAP` and exporting `withIva` and a class left the
   library's anchor at `precios-y-condiciones`, collided with nothing, and a
   script file called both exports with no `import`.
3. **The debugger works in a module, with two changes.** `JS_DebugLines`
   answered nothing for a module record (`bta_lines_of` returns on
   `JS_TAG_MODULE`); reading the record's `func_obj` instead is four lines in
   the fork, and then a breakpoint in a module function arms, stops, reports the
   stack across the module and the script that called it, and reads the
   arguments. **What it cannot read is a module-private name**: `eval` of
   `n + K`, with `K` a top-level `const` of the module, is `ReferenceError` --
   to the engine `K` is a closure variable of the function, and
   `JS_DebugEval`/`JS_DebugLocals` read the frame's own names. Today the same
   is true of any variable a function captures from an enclosing one; a module
   makes it the common case. A fork patch (closure variables in locals and
   eval) belongs to stage 2.
4. **`Application.Symbols` reads a module** once it compiles one as a module:
   functions, classes, methods, parameters and JSDoc, as for a script. It does
   not say which are exported -- stage 4's patch, as planned. `CheckSource`
   needs the same switch, or every module is `unsupported keyword: export`.
5. **The text of the error is not the detector.** A script compile answers
   `unsupported keyword: export` with its position for every spelling of
   `export`, but an `import` declaration is a generic `Unexpected token` at
   the token after it. The rule that needs no patch: **compile as a script; on
   a `SyntaxError`, compile as a module; whichever got further in the file is
   the answer** -- a module with a later error then reports the later error,
   and a broken script reports its own. A second compile happens only for
   module files and broken ones. One helper, asked by the loader, `Symbols`,
   `CheckSource` and the task loader alike.

### Stage 1 -- refuse `import()` (independent, D1)

A guard in `js_parse_*` beside patch 5's, refusing a dynamic `import(` with a
message and a column; the spelling added to `testCuratedLanguage`. This lands
whatever happens to the rest: it is a process abort today. With stage 2 a static
`import` declaration becomes legal and the dynamic one stays refused, since it
answers with a promise.

**Done, 2026-10-11, as fork patch 13** (`AGENTS.md` has its note). Stage 0
widened it: `js_refuse_await` also refuses a module's top-level `await` in all
five places the parser accepts one, since with patch 5 in place a module's
body is the only async function left. `testCuratedLanguage` asserts the
`import()` half and is red without the patch; the `await` half is asserted in
stage 2, the first time the runtime compiles a module.

### Stage 2 -- `export` makes a file a module

- The loader (`bta_runtime.c`, the per-file `JS_Eval`) evaluates a module file
  as a module and distributes its exports into the shared scope; a script file
  is untouched.
- Two owners of a name: the name is not distributed and a reference to it
  throws the sentence of rule 4. The cheap version is an accessor on the global
  object that throws when read; the load-time check is stage 4.
- Libraries are the same rule: a library file with `export` keeps its helpers.
  `lib/markdown` goes first, since it is the measured case.
- `tests/widgets`: the two probes above as assertions (a private `slug` of the
  library is not replaced; a private `GAP` does not collide), an ambiguous name
  with its message, and an `export` read from a script file.

**Done, 2026-10-11.** What building it decided, beyond the bullets above
(`AGENTS.md`, *A file with `export` is a module*, has the traps):

- **Where an export lives -- the first open question -- is the global object,
  as a non-configurable accessor**, and exporting a name the runtime installs
  is refused at load. Non-configurable makes a script that declares the same
  name afterwards a redeclaration error; one that declared it before is found
  and refused naming the module. The getter reads the namespace, so an
  `export let` is live and read-only outside its file.
- **Detection is stage 0's rule plus one case**: a module compile resolves its
  imports, so one that fails with anything but a `SyntaxError` read the whole
  text and is a module.
- **`export default` is refused** until stage 3 gives it a way to be named.
- **The debugger needed a fork change beside patch 4's readers**: lines for a
  module record, and closure variables in the values panel and in `eval`,
  which is what a module's private names are to the engine.
- `tests/api.sh`'s check that no two libraries claim a top-level name reads
  only a module's exports: 88 names in `lib/` became 49 with markdown's move.

### Stage 3 -- explicit `import`

- `JS_SetModuleLoaderFunc2`: `"./x.js"` resolves against the importing file
  inside the project; a bare name resolves to a library of `uses` (a library not
  in `uses` is refused, naming the manifest). A module already evaluated by the
  loader is the same record, so importing it does not evaluate it twice.
- **A library is several files and an import names one thing.** The candidate
  is a synthetic module per library (`JS_NewCModule`) whose exports are the
  union of its files' -- the same union rule 3 already computes, with the same
  ambiguity refused.
- `Task`: a task file's explicit imports are loaded into the worker.
  `examples/sheets` moves its helpers out, as the proof.

**Done, 2026-10-12.** What building it decided (`AGENTS.md`, *A file with
`export` is a module*, has the traps):

- **The library module is text, not `JS_NewCModule`**: one
  `export * from "<path>"` per module file of the library, compiled under the
  library's bare name. A C module's exports are values set once, so an
  `export let` would have stopped being live; `export *` keeps the bindings,
  excludes `default`, and *is* the union rule -- a name two files export is
  left out and refused as ambiguous by the engine when imported. A library
  with no module file refuses an import, naming why: its classes are reached
  by name.
- **A module's name is its canonical path**, which is what lets the loader and
  the engine agree that a file is already loaded; a file only imported need
  not be in `sources`, and one both imported and listed is evaluated once.
- **What an import brought in is handed out like any module**, after the file
  that imported it ran; a re-export is the same binding and not a second
  owner.
- **`export default` is allowed again**, reached only through an import.
- **`Task`**: the worker loads its file and what it imports.
  `examples/sheets` moved its helpers to `SheetParts.js`, which is not in
  `sources` and arrives by the reader's import, on both threads.
- `CheckSource` and `Symbols` compile an import against one empty module and
  read nothing from the disk.
- Not done, because nothing asked: a `.js` suffix is not added to a path that
  lacks one, and a library cannot be imported by path from outside it.

### Stage 4 -- the IDE and load-time checks

- The symbol handler reports `export` on a declaration and each `import`
  binding (a fork patch in the shape of patch 10).
- Completion offers another file's private names nowhere; the outline marks
  what is exported; *go to definition* follows an import; rename follows it.
- An ambiguous name used without an `import` is a load-time error with file and
  line, and the IDE underlines it while typing. This needs the parser to report
  the free names a file uses, which no patch does today.
- `sources` order stops mattering for anything reached through an `import`;
  the docs say so.

**Done, 2026-10-12.** What building it decided
(`AGENTS.md`, *A file with `export` is a module* and patches 14 to 16):

- **First, a leak the stages before it left.** A module compiled only to be
  checked was kept by the engine for the life of the context -- 923 KB a
  `CheckSource` plus `Symbols` of a 136 KB module, which an editor pays at
  every pause in the typing. Fork patch 14 frees it.
- **The parser reports exports and imports** (patch 15) as two more kinds of
  symbol, read from the module's own tables after each statement, so every
  spelling -- `export { a as b }`, `export *`, `export default`, `import * as`
  -- is covered by one function. The specifier is `From`.
- Completion offers a module's private names in that file only; the outline
  marks what a module exports; F12 follows a path import to its file; a rename
  of a module's private name stays in its file, and one declared by two files
  is refused.
- **An ambiguous name is refused at load and underlined while typing.** The
  IDE says the runtime's sentence where a name two modules export is used with
  no import. The runtime refuses the load with it, naming the file and the
  line: fork patch 16 hands over the names a compile looks up in the global
  scope, read off the final bytecode rather than the parser, and they are
  checked once every file is in. The getter's throw at the use was not enough,
  because a file loaded *between* the two owners read the first one in its
  top-level code, silently.
- `sources` order: a file only imported need not be listed, and is evaluated
  before the file that imports it (stage 3), which the language page says.

## Open questions

- **Where an export lives.** On `globalThis` it is simple, and then
  `export class Timer` replaces the runtime's `Timer` for the whole program --
  today a top-level `class Timer` only shadows it as a lexical binding, and
  `tests/widgets`' `ClassNamedLikeAGlobal` holds that. Either refuse exporting a
  name the runtime installs (loud, one line), or create a real global lexical
  binding from C. `bta_lookup_global` must find an export either way, since
  `.form` types and `startup` are names.
- **Is `export` the default?** This plan says no: rule 1 keeps every existing
  file a script. A later `project.json` key could make every file a module,
  once the IDE and the libraries have moved.
- **Should the runtime's own code move?** Done for the IDE, 2026-10-12: every
  file of `ide/` is a module, `Namespace("Ide")` is gone from it, and of 326
  top-level names 99 are exported and 227 private. The exports were read off
  fork patch 16's free names rather than searched for, and the IDE's shared
  constants (`SELECT_COLOR`, `SOURCE_LINK`) are simply exported. `rad.js` and
  `forms.js` are the prelude and stay scripts.
- **What happens to `Namespace()`.** It stays: it groups names, which a module
  does not. With the IDE moved, nothing in this tree uses it but its own tests,
  so whether to retire it is the question now.

## Rejected

- **Modules as in Node and the browser, with `import` required.** It is the
  portable answer, and it makes every file of a VB-shaped project start with a
  list of what it uses, rewrites the IDE and every document, and turns the
  `.form`'s bare `type` into a question of which file exports it. The implicit
  reach keeps what works and the explicit `import` is still there for whoever
  wants it.
- **Leaving the model and only warning.** Detecting two top-level functions of
  one name across files, and libraries that clash, catches the silent case and
  gives no privacy: `lib/qr` would still need its prefixes. It is a reasonable
  stopgap if stage 0 fails.
- **npm as the argument.** Most of npm needs Node, `Promise` or `async`; modules
  alone would not open it. The modest gain is a pure ES module copied into
  `lib/`.
