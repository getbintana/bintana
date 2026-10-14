# Modules

The traps and decisions of this area, each with what it cost and the rule it left. [`AGENTS.md`](../../AGENTS.md) states the rules that apply to every change; this file is the evidence behind them and the detail that only matters here.

## A file with `export` is a module

Stages 2 to 4 of [`docs/plans/modules-plan.md`](../plans/modules-plan.md), in
`runtime/src/bta_module.c` and, for the IDE, `ide/modules`: what a module exports goes on the global object and
reaches every file -- and a `.form`'s `type`, `startup`, `Task.Start`, through
`bta_lookup_global`'s ordinary eval -- with no `import`; the rest is the file's
own. `lib/markdown` is the first module in the tree, and `tests/api.sh`'s count
of top-level names in `lib/` went **88 -> 49** with it. What is worth knowing
before touching it:
- **A text is a module when only the module compile gets further.**
  `bta_compile` compiles as a script, and on a `SyntaxError` as a module, and
  keeps the one whose error is later in the text (or the one with none). Two
  traps were in that sentence: **the error text cannot decide it** -- a script
  compile names `export` (`unsupported keyword`) but answers an `import`
  declaration with a generic `Unexpected token` after the word -- and **a module
  compile resolves its imports in the same step**, so a module importing
  something not there fails with `could not load module` and *no position*,
  after the parse succeeded: a module compile that fails with anything but a
  `SyntaxError` is a module. `JS_DetectModule` is not this; it answers true for
  nearly every strict script.
- **Everything that compiles a project's text goes through `bta_compile`**: the
  loader, a `Task`'s worker, `Application.CheckSource` and `bta_symbols`.
  `bta_symbols` asks it **before** installing the symbol handler and then
  compiles once more in the answer's mode, because a failed script compile
  reports what it read before failing and a module would come out twice.
- **An export is a non-configurable accessor**, and both words are the design.
  The getter reads the module's namespace, so `export let` is live and nobody
  outside the file can assign it (`no setter`). Non-configurable is what makes
  a script that declares the same name **after** the module a `SyntaxError` from
  the engine (`redeclaration of 'Foo'` -- not naming the module, which is a
  message to improve); one that declared it **before** is found by evaluating
  the bare name once the global object has said it has none (`lexical_has`),
  and refused naming the module. A name the runtime installs is refused the
  same way -- the plan's open question, answered loudly: `export class Timer`
  would otherwise replace the runtime's for the whole program.
- **Two owners are not an error until somebody uses the name** -- and a use
  is refused at load, not where it runs (patch 16, `bta_modules_check`). The second is
  written beside the first in a per-context table of C strings
  (`owners_by_ctx`, under a mutex since a worker has a context of its own) and
  the getter, already installed, throws naming both. C strings so that
  `bta_modules_forget` can run after `JS_FreeRuntime` and nothing in it is a
  `JSValue` the runtime would assert on; the namespace lives in the getter's own
  function data, which the collector owns.
- **`export default` reaches nobody by name** and is skipped when the exports
  are handed out; an `import` is the one way to it. It was refused at load
  until stage 3 gave it that way.
- **`tests/api.sh` reads only what a module exports** when it asks whether two
  libraries claim one name -- the private ones collide with nothing, which was
  the check standing in for this feature.

**An `import` is resolved by `bta_modules_scope`'s loader** (stage 3, the
same file), installed on every runtime that runs a project's code -- the main
one in `install_globals`, a worker's before its file is compiled. What building
it settled:
- **A module's name is its canonical path, and that is what makes "once"
  work.** The engine finds an already-loaded module by the name the normaliser
  answers, so `bta_eval_file` and the worker compile under
  `g_canonicalize_filename(path)`, and `./x.js` normalises to the same string.
  A file an import brought in is in the per-context `done` set and the loader
  skips it when `sources` reaches it; a different spelling of one path would
  have evaluated it twice.
- **A library is a module this file writes**: `export * from "<path>"` for each
  of its files that compiles as a module, compiled under the library's bare
  name. `export *` is the plan's union rule for free -- `default` excluded, a
  name two files export left out and refused by the engine as *ambiguous* when
  imported -- and the re-exports are live bindings. A library file not loaded
  yet (in a worker, or a library later in `uses`) is compiled there; a script
  file of the library is skipped, so `import { Chart } from "charts"` refuses
  until `lib/charts` exports.
- **What an import brought in is handed out after the module that imported it
  ran**, from a pending list `load_file` fills, so it reaches later files by
  name like any module. A re-export (`export { withIva } from "./P.js"`) is the
  same binding and is not counted as a second owner: `distribute` asks fork
  patch 17 whose binding it is. (It compared the values first, which made two
  `export let count = 0` one owner -- see patch 17.)
- **Detection needed one more case**: a module compile whose `SyntaxError` is
  not in this text at all -- a file it imports, compiled in the same step --
  has position 0 against this name, and would otherwise lose to the script
  compile's *Unexpected token* on the `import` line. Position 0 now means
  "a module".
- **`CheckSource` and `Symbols` never read the disk for an import**:
  `bta_modules_checking` makes the normaliser answer every specifier with one
  empty C module, `<import>`, which is enough to compile against (import names
  are resolved at link, not at compile).
- **The loader's refusals are `ReferenceError`s and never `SyntaxError`s**, for
  the detection rule above: a positionless `SyntaxError` would hand the report
  to the script compile. Each names the importing file and what to do.
- **A module compiled only to be checked is freed** by `CheckSource` and
  `Symbols` (fork patch 14): the engine keeps a module record until the context
  goes, and it was a megabyte a check of a large file.

**What the IDE makes of a module is stage 4** (fork patch 15 gives it the rows):
`completionPublished` in `Completion.js` is what a file puts in the shared scope
-- everything at its top level for a script, its exports for a module -- so a
module's private names are offered nowhere else, while `completionScopeNames`
still offers them, its classes and its imports inside the file; the outline adds
`export <name>` rows at the declarations (`Navigator.exportsOf`), in line order
because `follow` reads the rows as lines going down; F12 on an imported name
follows a path import to the file and the declaration (`Navigator.imported`,
before any class of the same name elsewhere -- the import is the file saying
whose it is; a library import is not followed); a rename of a name a module
declares and does not export touches that file only, and one two files declare
is refused (`Refactor.privateTo`); and `Names.ambiguous` says the runtime's
sentence where a name two modules export is used with no import, in the live
pass and the project check -- the sentence the runtime now refuses the load
with (patch 16), said while typing. `ambiguous` reads words, so a file that
declares a local of the name anywhere is skipped whole rather than guessed at;
the runtime's half reads the bytecode and has no such gap.

Three things a review of stages 2 to 4 found, each with a test in `Imports`:
**a library cannot be imported by name from one of its own files**, nor two
libraries import each other -- the library's module is registered only after
its files compile, so either recursed until `RangeError: Maximum call stack
size exceeded`, with no file and no line; `load_library` keeps the names it is
loading and refuses with a sentence (a file of a library imports another by
path). **A file is named by its path in the project** (`csv/Csv.js`), or
`<library>/<file>`, in every sentence about owners -- the basename made *'Parser'
is exported by Csv.js and Csv.js*; `shown_path` here and `shownPath` in
`Ide.Names`. And **an entry a module did not export** (`main`, `startup`) is
followed by the sentence that says to export it, since the engine's *Main is not
defined* says nothing of modules. The IDE counted a re-export as an owner too
(`completionPublished`'s `own` is what a module declares itself).

A second review, from adopting modules in `bintana-project` (23 files, 109
exports, 85 names made private), found two more. **A forgotten export** is
patch 18 above. And **a script that declares what a module already exported**
got the engine's bare *redeclaration of 'SHARED'*, naming neither file, while
the other order named the module: `bta_modules_explain` replaces that one error
with *Main.js declares 'SHARED' at its top level, which Mod.js already
exports*. It reported a third that is not one: a form class a module does not
export is **reachable from its own module** (`new Dialogs()` there finds
`Dialogs.form` by the class's name, measured), so an unexported form nobody
makes is dead code like any class nobody makes, and a use from another file is
the forgotten export above.

`tests/widgets`' `Imports` runs a child per rule (choosing by import and `as`,
once and unlisted, a re-export, a default, a cycle, a library, a task's
imports, and seven refusals), and `modulesDebugger(true)` stops in a file only
an import brought in.

`tests/widgets`' `Modules` runs a child per rule (the markdown probes, reach,
two owners, both collision orders, a runtime name, an `export default` that
no longer stops a load, a live binding, a task class in a module) plus
`CheckSource`/`Symbols` on a module and a module's top-level `await` (patch 13's half that needed a module), and
`modulesDebugger` stops in one. Taking the `export` off `lib/markdown` turns the
two markdown assertions red.
- **Every `ide/**/*.js` is a module, so a top-level name is its file's** --
  `Runner` reaches `MainForm`'s `SOURCE_LINK` and `Palette` `Chrome`'s
  `SELECT_COLOR` because both are exported, and two files may now declare the
  same private `const`. Two files *exporting* one name is the trap left: it
  loads, and a file using it with no `import` stops the IDE at startup, naming
  both (fork patch 16). Splitting a file means exporting what the other half
  uses, not copying it.
