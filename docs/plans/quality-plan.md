# Quality: the gate a release has to pass

**Status: baseline, not a feature (2026-11-12).** The suite is large -- seven
projects, 11,415 assertions, plus `api`, `check`, `asan`, `formfuzz`, `pack`,
`install`, `odbc`, `serial`, `media` and `keyring` -- and one full run found one
failure in a focus test that passes alone. That is the shape this plan is for:
the suite is not a number to grow, it is a gate that has to be green on purpose,
on every platform, before a release is handed to somebody else.

## What exists

- `./tests/run.sh`: the seven windowed projects, 11,415 assertions, a per-project
  timeout, `HEADLESS=1` by default.
- `./tests/alone.sh`: every widget test in its own process; the claim that the
  suite's shared state is not what makes a test pass.
- `./tests/asan.sh`: the suite under AddressSanitizer; `./tests/lsan.supp`.
- `./tests/api.sh`: the public surface against `api.json` and the descriptions
  beside the C/JS members; 292 links over 79 pages of `docs/`.
- `./tests/check.sh`: every project's `bintana check`, no window.
- `./tests/formfuzz.sh`: mutations of `.form` through the loader and `check`.
- `./tests/pack.sh`, `./tests/install.sh`, `./tests/odbc.sh`,
  `./tests/serial.sh`, `./tests/serial-win.sh`, `./tests/keyring.sh`,
  `./tests/media.sh`, `./tests/icons.sh`, `./tests/styles.sh`.
- CI: Linux full + no-optional-dependency jobs; Windows builds, project pass
  and smoke; no macOS job.
- `docs/testing.md` says what each project proves and what is by hand.

## The last full run (2026-11-12)

- `ide`: 3,875 passed with the navigation checks (the last full run before
  them was 3,869).
- `markdown` 172, `qr` 120, `report` 265, `smoke` 174, `widgets` 6,751 with
  **one failure** (`a closed popover is not where Tab stops`), `xlsx` 57.
- The failing test passes alone (`./tests/run.sh widgets Popover` 252/0), so it
  is an interaction between tests, not a broken popover. It is still a red gate.
- A second full `widgets` run later hung in a glycin image loader; that is the
  environment, and it is why the plan measures time and not only pass/fail.

## The gates

### 1. The suite is deterministic

A release requires **three consecutive full runs, all green**, on the release
machine. A failure is a bug in either the code or the test; `alone.sh` is the
first separator (a test that passes alone but fails in the suite is a shared
state or focus bug, not a flake to ignore).

The popover failure is the first job:

- the test owns the focus it walks (`Form.FocusNext` from the panel, not from
  wherever the previous test left it);
- it waits for the popover to be unmapped, not only for `Closed`;
- it re-grabs the focus in the tail, the rule `docs/agents/testing.md` already
  writes down for a focus walk.

A quarantined test is the last resort, and it gets a date and an owner. There is
no "known flake" list.

### 2. The `.form` layer is fuzzed where the suite only round-trips

`form-fuzz-plan.md` already covers the loader and `bintana check`; the missing
half is `Serialize` and the designer's `BuildChildren`. A malformed saved
snapshot is the risk:

- a mutation of a valid form through `Serialize` -> `Load` -> `Serialize`;
- structural equality, not byte equality, with properties that a node did not
  declare left out;
- no crash, no dropped unknown property, no control added twice (the 38 -> 44
  regression the designer already paid for);
- under ASan, with a seed corpus from `examples/` and `tests/ide/forms/`.

### 3. The platform matrix is honest

- **Linux**: full suite, no-optional-dependency builds, ASan.
- **Windows**: the project pass and smoke already run; the windowed suite has to
  run on a real desktop, or the plan says exactly which projects do not and why.
- **macOS**: `macos-plan.md` Stage 0 in CI; before that the row says *not
  tested*, not *works*.
- **Flatpak**: the BaseApp build and the example, not the full suite.
- **No GTK**: the headless plan's acceptance is a machine without GTK; until it
  exists, `--version` and `check` are the only claims.

### 4. The numbers are published

A release page says, in the same table:

- package size (Flatpak, tarball, Windows installer), installed size;
- startup to the IDE window and to a form;
- RSS after startup, after opening a form, after opening the IDE;
- the interpreter benchmark (`tests/bench.sh`) and the suite time.

Measured on `RelWithDebInfo` (an unset `CMAKE_BUILD_TYPE` is `Debug` and four
times slower), on the same machine, with the command that produced each number.
Against Electron/Tauri and Gambas, the argument is weight and nativeness; it
needs the weights.

### 5. The contract is a contract

- `api.json` is generated and `tests/api.sh` holds it; a new member without a
  description fails.
- `docs/testing.md` counts and `llms-full.txt` are regenerated, not trusted.
- A 1.0 release has a **deprecation policy**: a removed or renamed public member
  goes through a release with a sentence, not a silent break.
- The `.form`, `.record`, `.conn` and `project.btp` formats have a version and a
  migration note when they change.

### 6. The release checklist is one page

- full suite three times, `alone`, `asan`, `api`, `check`, `pack`, `install`;
- the platform matrix above;
- the numbers above;
- changelog, version in `CMakeLists.txt`, `tests/pack.sh` agreeing with it;
- a clean checkout builds the tarball and the IDE opens an example;
- the tag is made by the owner, and the release page carries the checksums.

## Stages

0. **Baseline** (1 day): run the full suite three times, record time, failures
   and the machine; run `alone.sh` and `asan.sh` once.
1. **The popover failure and the focus rule** (1-2 days): reproduce in the
   suite, fix the test or the code, put the fix back once to see it red.
2. **The serializer fuzzer** (3-5 days): `Serialize`/`BuildChildren`, seed
   corpus, ASan; the plan in `form-fuzz-plan.md` is the design.
3. **The matrix** (parallel with 1-2): Windows windowed, macOS Stage 0, no-GTK
   when the headless host exists.
4. **The numbers** (1-2 days): a `tests/footprint.sh` or a documented command
   set; the table on the release page.
5. **1.0 gate**: the checklist above, once, on the release commit.

## What this plan deliberately does not do

- Chase a coverage percentage; the suite's value is the failures it catches, not
  the lines it touches.
- Add a test project because a feature exists; a project appears when it proves
  a class of application (the seven already do).
- Treat `asan` as proof for `JSValue`s and `GBytes`: the plan repeats the
  repository's rule that the C has to be read, and the sanitizer is a second
  opinion.
- Freeze the API before 1.0 by guessing; the freeze is a release decision, and
  the deprecation policy is what follows it.
- Make the CI run the suite on a real user's display.

## Prior art

- **Flyway's** red/green migration gate is the shape of a release gate: the
  suite is the thing that says no, and the version is not cut until it does.
- **Rust's crater** and **CPython's buildbot** are the large version of the
  platform matrix; this project needs the honest small version, not a fleet.
- **The repository's own `docs/agents/testing.md`** is the prior art for the
  rules: assert the effect, put the bug back, never count frames, own the focus.
