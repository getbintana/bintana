# Documenting a change

The traps and decisions of this area, each with what it cost and the rule it left. [`AGENTS.md`](../../AGENTS.md) states the rules that apply to every change; this file is the evidence behind them and the detail that only matters here.

## Where a change has to land

**Any change to the API, the runtime or the widgets is documented here in the same
change.** Not afterwards, not in a commit message, not only in `docs/`. If you
added a property, changed what a setter accepts, fixed a lifetime, moved a default
or made a container behave differently, this file gets the sentence that would
have saved the next agent the afternoon you just spent.

This is not bookkeeping. `AGENTS.md` is the first thing an agent reads, and it is
the only document written *for* the one doing the work rather than for the one
using the result — so a fact that lives anywhere else is a fact that gets
rediscovered. Measured, in this repository:
- `Arrangement` "must be set before a container has children" was false, and said
  so here and in two other documents, for as long as nobody measured it. The
  restriction had been removed on purpose and the note stayed.
- `MouseWheel` was written `(dx, dy, ctrl, shift)` in three documents and passes
  two.

**And it covers `lib/` too.** A library that ships with the runtime is part of the
contract -- a project writes `uses: ["charts"]` and gets its classes, so what they
publish is as public as a control's properties. The check reads the surface out of
the Bintana by the convention this tree already follows: a capital initial is
public (`get Type()`, `Refresh()`), a lower-case one is the class talking to
itself (`view()`, `reduce()`), an underscore is a handler. `static Events` gives
the names and each `Emit` gives the arity. The page is `docs/llm/<library>.md`,
and a library with no page at all is the first thing it reports.
- `run.sh` did not default to `HEADLESS=1` and `asan.sh` did; that asymmetry was
  walked into five times, most of them after being apologised for. It is gone —
  both default to the virtual display now — and it stayed a documented rule for
  four of those five times, which is the lesson rather than the fix.
- A `GtkGrid` had no removal branch, so a grid could be filled once and never
  rebuilt. Nothing said so anywhere, and it took an application written against
  `docs/llm/` to find it.

None of those was a hard bug to fix. Each was expensive because the knowledge
existed and was not written down where it is read.

**What to write.** Not a changelog entry — the repository has git for that. Write
the thing that is not derivable from the diff: what the trap is, what it looked
like when it bit, what you measured, and what the rule is now. A sentence naming
the failure beats a paragraph naming the fix.

**Where it also has to land**, because this file is the working notes and not the
reference. Three repositories, and a change crosses them in one direction:
- **`bintana`** (this one): the code, the descriptions beside each member, and
  `api.json` -- the public surface as data, built by `./tools/apijson.sh` and
  held to the C by `./tests/api.sh`. `llm.txt` and `llms-full.txt` index what
  is about *working on* the runtime.
- **`bintana-docs`**: the pages an application author reads -- the reference,
  the compact `llm/` contract, the formats, the designer. Its `check.sh` holds
  every page to `api.json`, and its `tools/docs.sh` writes the member rows from
  it. It reads the ref in its own `bintana-ref.txt`.
- **`bintana-llm`**: `llm.txt` and the step-by-step guide for writing an
  application with no IDE.

| A change to | goes in |
|---|---|
| a widget's properties, methods or events | **its description in the comment above its C entry** (the lines after the signature, see *what a member is for* below) — and `./tools/apijson.sh` in the same change, since `api.json` carries it. The row belongs to `bintana-docs`' [`docs/llm/controls.md`](https://github.com/getbintana/bintana-docs/blob/main/docs/llm/controls.md), whose `tools/docs.sh` writes the text from the manifest and whose `check.sh` fails while a row is missing; [`docs/widgets.md`](https://github.com/getbintana/bintana-docs/blob/main/docs/widgets.md) is for the behaviour a table cannot state (`README.md` is presentation only and takes no API) |
| a component in `lib/` (the shipped libraries) | its page in `bintana-docs` ([`docs/llm/<library>.md`](https://github.com/getbintana/bintana-docs/blob/main/docs/llm/charts.md), held to the manifest by its check) **and** `api.json` via `./tools/apijson.sh`, which reads the library out of its sources |
| a global (`File`, `Exec`, `Locale`, `Record` …) | [`docs/runtime-api.md`](https://github.com/getbintana/bintana-docs/blob/main/docs/runtime-api.md) and [`docs/llm/library.md`](https://github.com/getbintana/bintana-docs/blob/main/docs/llm/library.md) in `bintana-docs` — **and `api.json`, which `tools/apijson.sh` rewrites and `tests/api.sh` fails on when it is stale**, since that file is the whole contract the documentation repositories read — and the section that documents it must be named in `bintana-docs`' `check/Check.js` (`GLOBAL_SECTIONS`), which is the one fact a manifest cannot carry, and its long page under `docs/reference/globals/<Name>.md` named in `GLOBAL_PAGE_OWNERS` |
| the `.form`, `project.json` or the serialiser | [`docs/formats.md`](https://github.com/getbintana/bintana-docs/blob/main/docs/formats.md) and [`docs/llm/forms.md`](https://github.com/getbintana/bintana-docs/blob/main/docs/llm/forms.md) in `bintana-docs` |
| what `cmake --install` lays down, or the `uninstall` target | [`docs/installing.md`](../installing.md) — and `tests/install.sh` must still pass, since it stages a real install, compiles a plugin against it and runs it |
| the language: an intrinsic installed or removed | [`docs/llm/language.md`](https://github.com/getbintana/bintana-llm/blob/main/docs/llm/language.md) in `bintana-llm` and `runtime-api.md`'s *language underneath* in `bintana-docs` |
| how a widget, property or event is added | [`docs/extending.md`](../extending.md) |
| the native plugin ABI or loader (`bta_plugin.h`, `bta_plugin.c`, a `.so` in a library) | [`docs/plugins.md`](../plugins.md), plus [`docs/formats.md`](https://github.com/getbintana/bintana-docs/blob/main/docs/formats.md) and [`docs/llm/forms.md`](https://github.com/getbintana/bintana-docs/blob/main/docs/llm/forms.md) for the `uses` half — and `tests/plugins/testplug.c` is the reference every verb is held to |
| **filling a gap `docs/issues/` reported** | **delete the issue file**, and the row for it in [`docs/issues/README.md`](../issues/README.md) and in [`docs/llm/issues.md`](../llm/issues.md)'s *what is known to be missing* — see below. `llm/issues.md` stays here, so an answer is one repository and one commit |
| anything a test now proves | [`docs/testing.md`](../testing.md), and the counts it quotes |

**An answered issue is deleted, not archived — and a refusal is an answer.** `docs/issues/` is the list of what
is *missing*; an issue kept past its answer is a second description of the same
feature, written by somebody who did not have it yet, sitting in the one
directory whose whole meaning is that nothing in it exists. Three went that way
when `Painter.Image`, `Text` and `SavePdf` landed. Completed plans go the same
way: `docs/http-plan.md` was deleted once its staging was built, with its one
live leftover (`Done` sequencing) already living in `docs/plans/async-plan.md` — a plan
kept past its building is the same second description. What the runtime can do is in
`bintana-docs`' `docs/llm/` and `bintana-llm`'s guide, which is where anybody
looks; git holds what the asking looked like.
A refusal goes the same way, with the argument written into *what is deliberately
not here* in `llm/controls.md` — an issue whose answer is *no* is not a gap
either, and leaving the file there is how it gets argued a second time. The one
exception is the worked example inside `llm/issues.md`, which is quoted there to
teach the form and says so.

**And the numbers in a document are part of it.** Assertion totals, phase lists,
class counts, per-test timings: every one of those was stale at some point in this
repository, and a stale number reads exactly as authoritative as a fresh one.
`./tests/run.sh` prints the three that matter.

Two rules of thumb for whether a change belongs here at all. If you had to *read
the C* to find something out, that is a candidate — the point of this file is that
the next agent does not. And if you were surprised, write it: being surprised is
the whole signal.

## What the checks can and cannot see

- **`docs/llm/` claims to be the whole public surface, and eight names were
  outside it**: `BigInt`, `WeakMap`, `WeakSet`, `Iterator`, `DisposableStack`,
  `queueMicrotask`, `escape` and `unescape` were all installed and in neither
  list -- neither *what is here* nor *what is not*. `tests/api.sh` could not catch
  this, because it compared the globals the runtime *registers* against
  `library.md`; a name QuickJS installs of its own accord is invisible to it.
  Three were removed and five documented. If you add an `JS_AddIntrinsic*` call,
  the names it brings are yours to list.
- **`tests/api.sh` asked whether what is *declared* is documented, and could not
  ask whether what is *installed* is declared.** Those are different questions
  and the second has the worse failure: a global nobody listed is invisible to
  every list in `Check.js`, so nothing fails and its documentation is free to be
  absent. Measured when the check was added: **six** were in that state --
  `BTA_VERSION`, `Field`, `Multipart`, `Namespace`, `Painter` and `Record` were
  installed and named nowhere in that file.
  **The runtime answers the installed half now**: `Application.Globals()` is
  what is on the global object -- so a name added in the C or the prelude is in
  it by construction -- and `Widget.Members` says whether anything public hangs
  off it. A global **with members** must be in `api.json`, and a name with none
  (the language's builtins, the prelude's helpers, `BTA_VERSION`) is not part of
  the surface and is demanded nowhere. That moved the count from 39 to 36 and
  retired the C parse, the prelude scan and `close_hatches`' `gone[]` from this
  check together -- three readings of the same set, each with its own way to be
  wrong, replaced by one the runtime already does.
  The general shape is worth keeping: **a completeness check that reads only its
  own list is a completeness check about its own list.** The same blind spot let
  eight QuickJS-installed names sit outside `llm/language.md` for as long as
  they did.
- **And it happened again, one level down: 37 members with no description, in
  the manifest every page is written from.** An external audit named seven
  (`Desktop.Entries`' six and `Date.UTC`); asking `api.json` itself found
  thirty more. `checkDocs` and `checkGlobalSignatures` ask the owners the
  scan finds -- a `JS_SetPropertyStr(ctx, global, …)` or a `/* type X */`
  line -- and three kinds were found by neither: **an object hung off a
  global** (`Desktop.Entries`, which `tools/apijson`'s `NESTED_OWNERS` listed
  and nothing checked), **a table `tools/apijson` added by hand**
  (`MenuItem`, `Action`, `AudioPlayer`, every description written empty by
  construction because the tables had no comments to write them from), and
  **a builtin of the language with a capital member** (`Date.UTC`, which is
  QuickJS's and has no comment of ours to describe it). The first two are
  described beside their entries and named with `type` lines now, so they
  take the road every named type does; `Date` is `LANGUAGE_GLOBALS` in
  `tools/apijson` and out of the surface. **And `tests/api` reads the
  manifest whole** -- no member of any section may be blank -- which is the
  check that does not depend on knowing where owners come from. Removing
  `Uninstall`'s comment turns three lines red, one per road.
- **The page check cannot see a class rename** (it was `tests/api.sh` and is
  `bintana-docs`' `check.sh` now). It checked that every member has a
  row *somewhere* in `docs/llm/controls.md`, not that the row is under the right
  class -- so moving `Language` from one class to another, or documenting it under
  a name the runtime no longer has, passes. It stayed green through this whole
  rename. What catches that is reading the reference, and the CSS-node table in
  `tests/widgets`, which does force a new class to be written down.
- **The page check matched a member name anywhere in `controls.md`, not under its
  own control** (when it was `tests/api.sh`; that check lives in `bintana-docs` now) -- deliberately, because inherited members are documented once
  under `Widget` or `Container` and a per-control check would have to know the
  hierarchy. Two consequences, and both have happened. It **misses** a member
  that exists on one control and is documented only for another. And it
  **catches**, by accident, a name that means two things: `AddNode` on a new
  `TableView` came back "documented" because `Container.AddNode(node)` -- *build
  a widget from a `.form` node* -- already had that row. That was the check
  doing the right thing for the wrong reason, and the name was wrong: a
  vocabulary this small is only worth having if a word means one thing. It became
  `Add(values, { Key, Parent })`, which is the options-object shape
  `Directory.Files` and `Exec` already use.
- **An emit the scanner cannot see is an event that stops being checked.**
  `tests/api.sh` finds events by matching `bta_emit(...)` and its arity in the C;
  adding the `bta_emit_ok` variant and using it for `Draw` dropped the event from
  the count -- 30 to 29 -- and with it the check that `Draw(painter, width,
  height)` is what the documentation says. Nothing failed; the total is the only
  place it showed. **The counts a check prints are part of the check**: read them
  when they move.
- **Widget-set-wide answers belong in the runtime, not in a list in the IDE.**
  `TextProperties()` and `Widget.Types()` both exist because the extractor needed
  them and a hand-written list of prose-bearing property names in `ide/` would drift
  from the widget table the first time a control was added. Both are ordinary
  published API, which is the one rule working as intended.
- **`tests/api.sh` covered the globals too, and it did not until a whole global
  family had been added without it.** The old `NOT_A_WIDGET` set exempted a
  table from the `controls.md` check and **nothing asked anything else**, so 46
  members of `Locale`, `Decimal`, `Connection`, `Log` and `Day` were documented by
  hand or not at all -- and `Database`/`Connection`/`Table` were written while
  that was true, with nothing that would have failed had the reference been wrong.
  It checked 85 members against `llm/library.md` -- the pages and that check
  are `bintana-docs`' now, and here `checkGlobalsListed` holds every global with
  members to `api.json` -- and it found three real gaps
  the day it was written: `Application.LibraryPath` (which the IDE calls) and
  `Decimal`'s `toString`/`toJSON` (which are why `${d}` and `JSON.stringify(d)`
  are exact).
- **A deleted document leaves its links behind, and the prose around them reads
  as current.** `docs/issues/ISSUE-printing.md` went the day printing arrived;
  `docs/llm/markdown.md` and `docs/reference/globals/Dialog.md` went on pointing
  at it and went on saying there was no printer, while the bookkeeping in
  `docs/issues/README.md` was updated by hand. `tests/api.sh` walks every
  relative link in `docs/` now -- the other three checks ask whether what exists
  is written down, and this one asks whether what is written down still exists.
- **`tests/api.sh` scans for `bta_emit*` by name, so a new spelling is a whole
  event nobody checks.** The pattern knew `bta_emit`, `_on` and `_ok`;
  `bta_emit_answer` arrived with `Paginate` and the event was raised by the
  runtime, handled by two libraries, and counted by nothing -- the check went on
  reporting green with one event missing from its own total. It is `bta_emit\w*`
  now. A scanner that lists what it knows about goes stale the first time
  somebody adds to what it scans.
