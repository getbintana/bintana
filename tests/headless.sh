#!/usr/bin/env bash
# The Phase 1 metadata host, held to the runtime it describes.
#
#   ./tests/headless.sh
#
# It asks the same questions of the same classes twice -- once through
# `bintana`, whose class prototypes are the real ones, and once through
# `bintana-meta`, which compiles the class rows with stubs and links no toolkit
# -- and diffs the answers. It also reads the metadata host's `ldd`: a GTK,
# GtkSourceView or VTE entry there is the failure this target exists to prevent.
#
# `BINTANA=<path>` names the graphical build; `BINTANA_META` names the metadata
# one, and defaults to its sibling. No display is opened: both halves run a
# `main` project.
set -uo pipefail
cd "$(dirname "$0")/.."

BINTANA=${BINTANA:-./build/bintana}
if [[ ! -x $BINTANA ]]; then
    echo "no runtime at $BINTANA -- build first: cmake --build build" >&2
    exit 2
fi

BINTANA_META=${BINTANA_META:-$(dirname "$BINTANA")/bintana-meta}
if [[ ! -x $BINTANA_META ]]; then
    echo "no metadata host at $BINTANA_META -- build it: cmake --build build --target bintana-meta" >&2
    exit 2
fi

BINTANA_HEADLESS=${BINTANA_HEADLESS:-$(dirname "$BINTANA")/bintana-headless}
if [[ ! -x $BINTANA_HEADLESS ]]; then
    echo "no console host at $BINTANA_HEADLESS -- build it: cmake --build build --target bintana-headless" >&2
    exit 2
fi

tmp=$(mktemp -d "${TMPDIR:-/tmp}/bta-headless-XXXXXX")
trap 'rm -rf "$tmp"' EXIT

fail=0

if ! "$BINTANA_META" tests/headless/Main.js >"$tmp/meta.out" 2>"$tmp/meta.err"; then
    echo "the metadata host failed:" >&2
    cat "$tmp/meta.err" >&2
    exit 1
fi

if ! "$BINTANA" tests/headless >"$tmp/real.out" 2>"$tmp/real.err"; then
    echo "the runtime failed:" >&2
    cat "$tmp/real.err" >&2
    exit 1
fi

if diff -u "$tmp/real.out" "$tmp/meta.out" >"$tmp/diff"; then
    echo "the metadata host answers what the runtime answers"
else
    echo "the metadata host and the runtime disagree:" >&2
    cat "$tmp/diff" >&2
    fail=1
fi

# The whole point of the target: no toolkit in the closure. `ldd` is Linux's;
# a Windows or macOS build answers the same question with another tool, which
# this test does not pretend to have.
if command -v ldd >/dev/null; then
    if ldd "$BINTANA_META" | grep -Eiq 'libgtk|libgtksource|libvte'; then
        echo "the metadata host links a toolkit:" >&2
        ldd "$BINTANA_META" | grep -Ei 'libgtk|libgtksource|libvte' >&2
        fail=1
    else
        echo "the metadata host links no GTK, GtkSourceView or VTE"
    fi
else
    echo "no ldd: the toolkit-free closure was not checked"
fi

# The output is one line per question; these are the answers that would be
# silently empty if a class row stopped being read.
for wanted in '"Click"' '"Property"' '"Method"' '"Index"' 'true'; do
    if ! grep -qF -- "$wanted" "$tmp/meta.out"; then
        echo "the metadata host did not answer $wanted" >&2
        fail=1
    fi
done

# --- the console host --------------------------------------------------------
#
# `--version` is its own answer, and `check --json` is the same pass the
# graphical binary runs -- the same text, the same lines, the same exit status.
if "$BINTANA_HEADLESS" --version | grep -q '^bintana-headless '; then
    echo "the console host says its own version"
else
    echo "the console host did not answer --version" >&2
    fail=1
fi

if "$BINTANA_HEADLESS" check examples/hello >"$tmp/cli-hello.out" 2>"$tmp/cli-hello.err"; then
    echo "the console host checks a clean project"
else
    echo "the console host failed a clean project:" >&2
    cat "$tmp/cli-hello.err" >&2
    fail=1
fi

if "$BINTANA_HEADLESS" check --json tests/smoke >"$tmp/cli-smoke.out" 2>"$tmp/cli-smoke.err" &&
   "$BINTANA" check --json tests/smoke >"$tmp/gui-smoke.out" 2>"$tmp/gui-smoke.err"; then
    if diff -u "$tmp/gui-smoke.out" "$tmp/cli-smoke.out" >"$tmp/smoke.diff"; then
        echo "the console check answers what the runtime check answers"
    else
        echo "the console check and the runtime check disagree:" >&2
        cat "$tmp/smoke.diff" >&2
        fail=1
    fi
else
    echo "one of the two checks failed to run" >&2
    cat "$tmp/cli-smoke.err" "$tmp/gui-smoke.err" >&2
    fail=1
fi

# --- the project runner ------------------------------------------------------
#
# A project that declares `main` runs here, and the answer is the graphical
# runtime's: the same library first, the same sources, the same words after the
# project in `Application.Arguments`. The console host has no window, so a
# project that declares `startup` is refused by naming the form.
if "$BINTANA_HEADLESS" run tests/headless/projects/run one two \
        >"$tmp/headless-run.out" 2>"$tmp/headless-run.err"; then
    echo "the console host runs a project's main"
else
    echo "the console host failed a console project:" >&2
    cat "$tmp/headless-run.err" >&2
    fail=1
fi

if "$BINTANA" tests/headless/projects/run one two \
        >"$tmp/gui-run.out" 2>"$tmp/gui-run.err"; then
    if diff -u "$tmp/gui-run.out" "$tmp/headless-run.out" >"$tmp/run.diff"; then
        echo "the console run answers what the runtime run answers"
    else
        echo "the console run and the runtime run disagree:" >&2
        cat "$tmp/run.diff" >&2
        fail=1
    fi
else
    echo "the runtime failed the fixture project:" >&2
    cat "$tmp/gui-run.err" >&2
    fail=1
fi

# The binary links no widget file, and the metadata document is loaded only for
# `check`: a `main` gets the language's own answer for `Widget`.
if out=$("$BINTANA_HEADLESS" tests/headless/projects/bare 2>"$tmp/bare.err") &&
   [[ $out == undefined ]]; then
    echo "the bare host has no Widget for a main"
else
    echo "the bare host answered '$out' about Widget" >&2
    cat "$tmp/bare.err" >&2
    fail=1
fi

# A project that declares `startup` belongs to the graphical host: this process
# execs it, every word and descriptor unchanged, and its exit status is the
# host's. `BINTANA_GUI` is the seam that lets the test watch the exec without
# opening a window.
gui="$tmp/gui-host"
cat >"$gui" <<'GUI'
#!/bin/sh
: > "$BINTANA_TEST_GUI_ARGS"
for word in "$@"; do printf '%s\n' "$word" >> "$BINTANA_TEST_GUI_ARGS"; done
exit 7
GUI
chmod +x "$gui"

BINTANA_GUI="$gui" BINTANA_TEST_GUI_ARGS="$tmp/gui-args" \
    "$BINTANA_HEADLESS" run --theme dark tests/headless/projects/window one two \
    >"$tmp/gui.out" 2>"$tmp/gui.err"
gui_status=$?
printf '%s\n' --theme dark tests/headless/projects/window one two \
    >"$tmp/gui-want"

if [[ $gui_status -eq 7 ]] && diff -u "$tmp/gui-want" "$tmp/gui-args" \
        >"$tmp/gui.diff"; then
    echo "a window project is exec'd as the graphical host"
else
    echo "the console host did not exec the graphical host: exit " \
         "$gui_status" >&2
    cat "$tmp/gui.diff" "$tmp/gui.err" >&2
    fail=1
fi

# The other half of the dispatch: a `main` must not load the toolkit.
BINTANA_GUI="$gui" BINTANA_TEST_GUI_ARGS="$tmp/gui-args-main" \
    "$BINTANA_HEADLESS" tests/headless/projects/run \
    >/dev/null 2>"$tmp/gui-main.err"
if [[ ! -e "$tmp/gui-args-main" ]]; then
    echo "a main project does not dispatch"
else
    echo "the console host dispatched a main project to the toolkit" >&2
    fail=1
fi

if BINTANA_GUI=/nonexistent/host "$BINTANA_HEADLESS" \
        tests/headless/projects/window >/dev/null 2>"$tmp/gui-fail.err"; then
    echo "the console host claimed to run a missing graphical host" >&2
    fail=1
elif grep -q "cannot run the graphical host" "$tmp/gui-fail.err"; then
    echo "a missing graphical host is a sentence"
else
    echo "a missing graphical host said nothing useful:" >&2
    cat "$tmp/gui-fail.err" >&2
    fail=1
fi

if command -v ldd >/dev/null; then
    if ldd "$BINTANA_HEADLESS" | grep -Eiq 'libgtk|libgtksource|libvte'; then
        echo "the console host links a toolkit:" >&2
        ldd "$BINTANA_HEADLESS" | grep -Ei 'libgtk|libgtksource|libvte' >&2
        fail=1
    else
        echo "the console host links no GTK, GtkSourceView or VTE"
    fi
fi

exit "$fail"
