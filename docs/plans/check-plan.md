# `bintana check`: the IDE's project check, from a shell

**Built in part, on 2026-10-30.** The command exists and works:

```sh
./build/bintana check examples/hello          # two accessibility warnings, exit 0
./build/bintana check --strict examples/hello # the same, exit 1
./build/bintana check --json <project>        # one JSON line per finding, then `Done`
```

The decision below (*the check moves to a library*, option B) stands, and what
is built is `lib/check` + `tools/check` + the `check` word in `main.c`, installed
with the runtime. **The IDE has not been migrated to the library yet**: it still
runs its own `ide/modules/Check.js` and company, so the two implementations can
drift until stage 2 finishes. That is the remaining work, not a design change.

## What is wanted

The IDE's *Project -> Check* (`ide/modules/Check.js`) finds what the runtime
accepts in silence: two controls of one name, a property the class lacks, a
source that does not compile, a `.js` that `sources` does not list, a handler
whose control was renamed, a name two modules export, a control a screen reader
cannot name. It reads files and opens no window, so it is exactly what a CI job,
a git hook or an agent writing a project with no IDE would run -- and today the
only way to see its answer is to open the IDE and read the Problems panel.

```sh
bintana check <project>            # text, one line per finding
bintana check --json <project>     # one JSON line per finding, and one at the end
bintana check --strict <project>   # warnings fail the run too
```

`bintana test` is the model: a subcommand of `main.c`, a console project behind
it, `--json` for a tool, and an exit code a CI reads.

## What was measured

- **`Check` asks the `ide` object for little**: `project` (6 uses),
  `classes.files` (2), `classes.formOf`, `names.tableOf` (2), `names.sampleFor`,
  `names.curated`, `names.check`, `names.ambiguous`, `problems.report` and
  `problems.clear`. Five files carry it: `Check.js` 336 lines, `Names.js` 470,
  `Accessibility.js` 154, `ProjectFile.js` 185 and `Classes.js` 913 -- 2058.
- **Two dependencies are heavier than the list suggests.**
  - `Names.sampleFor` has no answer for a `MenuItem` or an `Action` without a
    window: it **borrows a live control from the IDE's own menu bar**. Probed in
    a console project, `Widget.Member("MenuItem", "Text")` throws
    `MenuItem is not defined`, where a widget's class answers (`Button`: 44
    properties, 20 events, no control built). `Check.hasMember` already
    answers `null` for "nothing here can say", so skipping is possible; it is
    not what the IDE does.
  - `Names.ambiguous` takes the owners of every exported name from
    `Completion.declaredClasses()`, which reads **the open tabs' text**. A
    command line has no tabs.
- **`Classes.js` is two things.** What `Check` needs (`files`, `formOf`, the
  scan that skips `.git` and company) sits beside the project tree's machinery
  (`components`, `libraries`, `activeFile`, `log`, `ide.manifest.read`) in one
  913-line class that reads `this.ide.project` 11 times.
- **The stub road already exists in the tree**: `docs/agents/i18n.md` regenerates
  `ide.pot` from a terminal by loading `Strings.js` and `Translations.js` into a
  console project and handing them a hand-made `ide`. It works for two modules
  that ask for two things; it is what option A below would extend.

## The options, and why B

- **A. A stub host.** `tools/check` loads the real IDE modules and gives them a
  minimal `ide`. No change to the IDE, no copy to drift. Rejected, though cheap:
  the command line then depends on the IDE's sources being installed, and the
  rule of this repository points the other way -- **the IDE has no privileged
  API; what it needs becomes a runtime feature every application has**. A `check`
  that is something the IDE *has*, and the shell borrows, is the privilege the
  rule is written against.
- **B. A library, `lib/check`, that the IDE and the command line both use.**
  Chosen. Moves about two thousand lines and decouples two classes; the IDE
  does not change by one behaviour, and the suite that watches it (`tests/ide`,
  3524 assertions on 2026-10-29) is the net.
- **C. A reduced `check`** with only what needs neither `Classes` nor
  `Completion`: manifest, duplicate names, missing properties, unknown keys,
  syntax, unlisted `.js`, taken-away names. Rejected: it re-implements part of
  `Check`, so the two answer differently the first time one of them learns a
  rule, and it ships with less cover than the panel it is named after.

## Stages

Each one is shippable and leaves the IDE's behaviour as it was; stop after any.

0. **Make the runtime answer for `MenuItem` and `Action` without a window**
   (`Widget.Member`, `EventNames`, `PropertyNames`, `Methods`), the way it does
   for a widget. A C change with its descriptions, `api.json` and a
   `tests/widgets` assertion; and `Names.borrowedItem`/`borrowedAction` go, which
   is the IDE losing a privilege. **Without it the command line cannot check a
   menu item's or a command's members**, and parity with the panel is not
   reachable.
   **Built.** `bta_menu_class_value` gives the two classes a synthetic
   constructor, the class-level verbs see it, and the `ClassIntrospection` test
   holds it (123 assertions in that test, part of `tests/widgets`). The IDE's
   `Names` still borrows a live item; that goes with stage 2.
1. **Decouple the two classes.**
   - `Classes`: the project's *files and pairing* (scan, `formOf`,
     `formOfClass`) apart from the tree and the component list, taking a root
     path and a manifest reader instead of `this.ide`.
   - `Completion.declaredClasses`: the per-file reading of what a file exports
     becomes a function over a list of `{ path, text }`, and the IDE feeds it
     the open tabs' text where it has them and the file's own where it has not.
     **This is the stage that can change a behaviour**, and it is guarded by
     the `completion` and `modules` phases of `tests/ide`.
   **Standalone in the library, pending in the IDE.** `lib/check/ProjectFiles.js`
   is the scan and pairing, and `lib/check/Owners.js` builds the export-owner
   map from `Application.Symbols` over a list of `{ path, text }`. The IDE's
   `Classes` and `Completion` are untouched, so the decoupling has not been
   proven against the tabs yet.
2. **Move the five files into `lib/check`**, with `ide` replaced by a small host
   contract (`project`, `files`, `formOf`, a place to put findings). A project
   names it in `uses`; the IDE does, and both of its source lists change:
   `ide/project.json` and `tests/ide/project.json` (the suite compares them).
   **Half built.** `lib/check` exists with `Check`, `Names`, `Accessibility`,
   `ProjectFile`, `LaunchConfig`, `Lex`, `ProjectFiles` and `Owners`; the host
   contract is `{ project, classes: { files, formOf }, names, problems }`, and
   `tools/check` supplies it. **The IDE still uses its own copies**, so this is
   what remains: change `ide/project.json` and `tests/ide/project.json`, delete
   the duplicates, and run the `completion`/`modules` phases.
3. **The console project and the subcommand.** `tools/check` behind a `check`
   word in `main.c`, as `test` is, and installed with the runtime
   (`cmake --install`, `tests/install.sh`).
   **Built.** `bintana check [--json] [--strict] <project>`; the tool is found
   one hop from the binary (`<bin>/../share/bintana/tools/check` installed,
   `<build>/../tools/check` in the tree), installed by `CMakeLists.txt`, exercised
   by `tests/smoke`'s `testCheck` and by `tests/install`.
4. **Documentation**, in the same change as each stage and not after: `--help`
   in `main.c`; `bintana-docs` (`llm/check.md` and the runtime page);
   `api.json` through `./tools/apijson.sh`; `docs/installing.md`; the IDE's
   `ide.pot` and `es.po` (the findings' sentences are already `Locale.Text`);
   and `bintana-llm`, whose guide is for writing a project with no IDE and
   should end with *then run `bintana check`*.
   **Partly built.** `--help` lists the subcommand, `api.json` carries the
   library, and `docs/installing.md` mentions the command. The pages in
   `bintana-docs` and the closing line in `bintana-llm` live in those
   repositories and are still pending; so do `ide.pot`/`es.po`, which only
   matter once the IDE loads the library.

## Decisions already taken

- **Output**: `file:line: warning|error: message`, which editors and CI parse,
  and `--json` as `bintana test` has it.
- **Exit code**: 1 on an error, and 0 on warnings, unless `--strict`. A project
  that already has warnings (the accessibility ones are `warning` by default,
  and `examples/kanban` has eight) must not start failing; `"accessibility"` in
  `project.json` keeps choosing its own level.
- **No `bintana new`, no project metrics**: both were considered and declined.

## Open questions

- **What is public — answered.** `lib/check` exports nine top-level names:
  `Check`, `Names`, `Accessibility`, `ProjectFile`, `Kind`, `LaunchConfig`,
  `Lex`, `ProjectFiles` and `Owners`. `tests/api.sh` holds them to `api.json`
  and describes each beside its declaration; the IDE, once migrated, uses the
  same nine. The findings' sentences stay in the code that raises them, as the
  panel's do; only `Accessibility`'s were ever translated.
- **Where the console project lives once installed — answered.** Under
  `${BTA_DATADIR}/tools/check`, found by the same one-hop rule the library
  search uses: `<bin>/../share/bintana/tools/check` installed,
  `<build>/../tools/check` in the source tree, `/usr/share/bintana/...` as the
  distribution fallback. No path is written down at configure time.
- **Whether `check` runs `Application.CheckSource` on every `.js` — answered by
  the measurement already in `Check.code`.** It does, on every file the walk
  finds: 610 us a file, 39 ms for this repository's 63 `.js` and 1.07 MB of
  `ide/`. A project of four hundred small modules costs less than one large
  form, and the check runs only when asked.

## What would change this

- If stage 0 turns out to be refused (the runtime should not answer for these
  two classes), option A's stub stays the only road to a `check` with the same
  coverage as the panel, and the rule it breaks is the price.
- If stage 1 cannot keep `declaredClasses` identical for the open tabs, stop
  there: a `check` that disagrees with the panel about which names collide is
  worse than none.
