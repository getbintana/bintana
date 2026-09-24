# Bundles: a project as one `.bta` file, without its sources

**Status: plan.** Nothing here is built yet. Phase 0 is a spike with no
changes; if it fails, this plan is rewritten before anything else moves.

## What the application needed

JavaScript is what makes a project writable, and in an enterprise deployment
that is the problem: whoever can open the installed directory in an editor can
rewrite the program at their convenience — a validation relaxed, a control
re-enabled, a price changed. The ask is to hand over an application that runs
without its sources sitting beside it.

## Why not an obfuscator

Renaming is the wrong tool here **by design**, not by taste:

- Events dispatch by name: `BtnSave_Click` is looked up on the form from
  `widget.Name`. Rename the handler and the button silently calls nobody.
- `Widget.New("Stepper")`, `"type": "Stepper"` nodes in the `.form`,
  `startup: "MainForm"`, `Namespace("Ventas")` — all resolve by name at load.
  A renamer cannot tell which strings are live names and which are not.
- Even a locals-only obfuscator buys little: the business logic lives in class
  names, handlers and properties that are contract with the `.form` and the C,
  while legible stack traces are lost.

The answer is the compiler QuickJS already carries: `JS_Eval` with
`JS_EVAL_FLAG_COMPILE_ONLY`, `JS_WriteObject` with `JS_WRITE_OBJ_BYTECODE`,
and at load `JS_ReadObject` with `JS_READ_OBJ_BYTECODE` plus `JS_EvalFunction`.
The runtime already compiles in two steps under `--debug`; this reuses that
compiler instead of adding one.

## What this explicitly is not

Written down so nobody oversells it later:

- **Base64 is not security.** Reversible in seconds. It keeps honest people
  honest and nothing else.
- **Bytecode is not encryption.** Atoms and string literals travel as they are:
  SQL, URLs and messages are readable with `strings`. What leaves is the
  legible source and the trivial edit.
- **Nothing here stops writing.** Whoever can write into the installed
  directory can replace files. The real defence against modification is OS file
  permissions plus not shipping sources. This plan raises the cost from "open
  in gedit and change one line" to "needs the toolchain and knowing what you
  are doing".
- **A bundle is not portable the way a `.jar` is.** The bytecode is QuickJS's
  own, keyed by `BC_VERSION` and produced by *this* build: a bundle is
  recompiled whenever bintana is, and the version refusal is what says so.
  Whether one compiled on x86_64 loads on arm64 — and 32-bit against 64-bit —
  is a question Phase 0 answers rather than a promise made here. Until it is
  answered the rule is the narrow one, and the message on refusal says it: same
  bintana, same architecture.
- **QuickJS's own warning stands** (`quickjs.h`): only load bytecode from a
  trusted producer — the format is not hardened against a hostile one, and
  loading adversarial bytecode can corrupt memory. A bundle is compiled on the
  build machine and verified at origin; bytecode "contributed" by anyone else
  is never loaded.

## The bundle

`bintana compile <project> -o <app.bta>` produces **one uncompressed ustar
archive** (extension `.bta`), project root at the archive root:

| Source | In the bundle | How |
|---|---|---|
| every `.js` in `sources`, libraries `uses` vendored under `lib/<name>/` | `.jsc`, same path | compiled with the same flags loading uses (`GLOBAL \| STRICT`), `JS_WriteObject(BYTECODE \| STRIP_SOURCE)` with debug kept, so stacks still give file and line |
| every `.form`; **every** `project.json` — the project's and each vendored library's — rewritten so `sources` names the `.jsc` | same name, `BINTANA-FORM64\n` + base64 / `BINTANA-JSON64\n` + base64 | same filenames on purpose (below) |
| `po/`, `icons/`, `app.css` | as they are, in clear | not logic; `bta_locale.c` reads `.po` as text, and clear text allows a translation fix without recompiling |
| everything else in the tree: a `.db`, a `.png` outside `icons/`, a `.csv`, the `.so` a library carries (`docs/plugins.md`) | as it is, byte for byte, mode kept | **the table is not an allowlist.** A file nobody thought of is copied, never dropped, or a project loses data by being bundled — and a plugin's `.so` has to keep its bits, which is the one reason the ustar writer stores a mode at all |

**Every `project.json` in a bundle carries an explicit `sources` list**, the
project's and each vendored library's alike, because the fallback underneath is
a trap: with no list — or an empty one, or one that would not parse —
`collect_sources` and `lib_sources` fall through to `collect_js`
(`bta_runtime.c`), which globs `.js`, and a bundle has none. A project that runs
today without declaring its sources would be bundled into one that loads zero of
them and fails much later with `main function 'main' not found`, which says
nothing about what happened. So `compile` writes the list it compiled in the
order it compiled it, and `collect_js` learns `.jsc` as well, so the two halves
cannot drift apart. A project that ends up with no sources at all stops with a
sentence rather than running empty.

Keeping the `.form` and `project.json` names unchanged means `index_forms`
(`bta_form.c`, suffix match on `.form`) and the whole `form_path` /
namespace / ambiguity logic need no changes: the loader sniffs the magic
first line and decodes before parsing. No compression in v1 (`.jsc` and forms
are kilobytes; icons dominate); no new dependencies — a minimal ustar writer
and reader in C (~100 lines each, regular files only, no symlinks/sparse),
because **reading** a bundle must never depend on the target machine having
`tar` (the `Ide.Exporter` precedent of shelling out is fine for exporting a
developer tree, not for running an application).

Running: `bintana <app.bta> [args...]` extracts to a temp dir
(`g_dir_make_tmp`, 0700 — verify at implementation), runs the project from
there through the existing code, and removes it recursively on exit, error
paths included. Arguments after the bundle reach the project as
`Application.Arguments`, exactly as with a directory. This is what makes the
single file cheap: form indexing, libraries, catalogues, styles and icons all
work untouched; only code sources (`.jsc`) and the JSON sniffing are new.

Two consequences of that temp dir, written down because a program can depend on
either. **`Application.Directory` is the temp dir**, not where the `.bta` sits:
whatever a project writes beside itself is written into something that is
removed on the way out. The place that survives is `Application.ConfigDirectory`
— named after `name` in project.json, created up front, and already the answer
for settings — so a bundled application keeps its state exactly where a source
one does. And **a `SIGKILL` leaves the directory behind**: the name carries a
fixed prefix so a later run can sweep what is more than a day old, because
nothing else is going to.

## Code changes

- **New `runtime/src/bta_bundle.c`**: minimal tar writer + reader. The reader
  refuses path traversal (nothing absolute, nothing with `..`, nothing
  escaping the destination); a corrupt byte is a clean failure, never a crash.
- **`main.c`**: a `compile` verb, which is **not** the `run` pattern — `run` is
  a word the argument loop skips, and `compile` takes an option (`-o`) that the
  same loop would reject as unknown before any project is seen. It is dispatched
  on `argv[1]`, ahead of the loop, parsing its own arguments. A first argument
  that is a `.bta` file takes the extract-and-run road.
- **`bta_runtime.c`**:
  - one helper, `bta_decode_if_b64()`, **declared in `bta.h`** because the
    three sites that parse JSON are not in one file: `bta_app_new`
    (project.json) and `lib_sources` are here, `bta_form_build` is in
    `bta_form.c`;
  - `bta_eval_file`: a `.jsc` path goes through `JS_ReadObject(BYTECODE)` +
    `JS_EvalFunction`, everything else as today (a source project runs
    byte-identically to now);
  - `--bytecode-only`: refuse `.js` sources; implied when running from `.bta`,
    which carries no `.js` at all;
  - wrap QuickJS's **two** refusals in sentences, because both reach whoever
    was handed the application and neither names a subject: the `BC_VERSION`
    mismatch becomes *"bundle compiled with another bintana — recompile"*, and
    the reader's `checksum error` becomes *"damaged bundle — the file did not
    arrive whole"*. That checksum is quickjs-ng's own, a `u32` over the blob
    written and verified by `JS_ReadObjectAtoms`, and it is what already makes a
    flipped byte a clean `SyntaxError` instead of a crash — the tamper test
    below asserts the sentence, not the mechanism.
- **`--debug` + bundle**: out of scope, refused with a clear message (the
  debugger needs the real sources).

## Phase 0: the spike (no changes)

Top-level classes must land in the **global lexical scope** through
`ReadObject` + `EvalFunction` exactly as through `Eval`, or `bta_lookup_global`
finds neither `startup` nor `main`.

**The probe is two files and not one.** What holds a project together is that a
class in one source extends a class in another — a project's over a library's,
which is the whole reason library sources are loaded first (`collect_sources`)
— and a scope that does not carry across separate `JS_EvalFunction` calls breaks
that long before anybody looks up an entry point. So the spike compiles two
sources, evaluates them in order, and constructs the derived class.

It also answers the architecture question: the same `.jsc`, compiled on the
Linux job and loaded on an `arm64` runner, either works or narrows the promise.
If either half fails, this plan is redesigned before the loader is touched.

## Tests

- Round trip: compile `examples/hello` to `.bta`, run headless, same behaviour;
  `tests/smoke` (which names all three shipped libraries) is the `uses`
  vendoring case.
- A project **without** a `sources` list: compile it, run it, and the list is
  there. This is the one failure that would otherwise be silent, which is why it
  is a test and not a review note.
- Tamper: one corrupt byte in a `.jsc` and in an encoded form → clean failure
  with the wrapped sentence, not QuickJS's; traversal entries (`../`, absolute)
  refused.
- Regression: the existing suite untouched (`./tests/run.sh`); `tests/api.sh`
  unaffected (no new API surface).
- Measure `compile` time on the IDE, the largest program there is, so the
  command does not become eternal.

## Docs, in the same change (the AGENTS.md rule)

- `docs/formats.md`: the `.bta` layout, what is encoded, what stays clear, why.
- `docs/issues/ISSUE-packaging.md` is **already gone**: the Flatpak plan
  answered the handing-over half — an application installed from a repository,
  without the developer's tree — and deleted it in the three places AGENTS.md
  asks for. What this plan is for is the half that issue did not ask: the
  installed application still carries its JavaScript, so whoever can open its
  directory can rewrite it. Whatever is left over when this is built (signing,
  an installer) becomes a new issue if it earns one.
- IDE support (*Export bundle…* on top of `Ide.Exporter`) is an explicit later
  phase, not part of this change.
