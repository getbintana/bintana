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
# `BINTANA=<path>` names the graphical host (`bintana-gui`), `BINTANA_CORE`
# the core one (`bintana`), and `BINTANA_META` the metadata generator; the two
# hosts default to siblings of `BINTANA`. No display is opened: the metadata
# half and the parity fixture run `main` projects.
set -uo pipefail
cd "$(dirname "$0")/.."

BINTANA=${BINTANA:-./build/bintana-gui}
if [[ ! -x $BINTANA ]]; then
    echo "no runtime at $BINTANA -- build first: cmake --build build" >&2
    exit 2
fi

BINTANA_META=${BINTANA_META:-$(dirname "$BINTANA")/bintana-meta}
if [[ ! -x $BINTANA_META ]]; then
    echo "no metadata host at $BINTANA_META -- build it: cmake --build build --target bintana-meta" >&2
    exit 2
fi

BINTANA_CORE=${BINTANA_CORE:-$(dirname "$BINTANA")/bintana}
if [[ ! -x $BINTANA_CORE ]]; then
    echo "no core host at $BINTANA_CORE -- build it: cmake --build build --target bintana" >&2
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

# --- the core host --------------------------------------------------------
#
# `--version` is its own answer, and `check --json` is the same pass the
# graphical binary runs -- the same text, the same lines, the same exit status.
if "$BINTANA_CORE" --version | grep -q '^bintana '; then
    echo "the core host says its own version"
else
    echo "the core host did not answer --version" >&2
    fail=1
fi

if "$BINTANA_CORE" check examples/hello >"$tmp/cli-hello.out" 2>"$tmp/cli-hello.err"; then
    echo "the core host checks a clean project"
else
    echo "the core host failed a clean project:" >&2
    cat "$tmp/cli-hello.err" >&2
    fail=1
fi

if "$BINTANA_CORE" check --json tests/smoke >"$tmp/cli-smoke.out" 2>"$tmp/cli-smoke.err" &&
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
if "$BINTANA_CORE" run tests/headless/projects/run one two \
        >"$tmp/headless-run.out" 2>"$tmp/headless-run.err"; then
    echo "the core host runs a project's main"
else
    echo "the core host failed a console project:" >&2
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

# A `main` project's tests run in the core, with no toolkit: `bintana test`
# is `runTests` over the project's `tests/` directory, as in `bintana-gui`.
if "$BINTANA_CORE" test tests/headless/projects/tested \
        >"$tmp/tested.out" 2>"$tmp/tested.err" &&
   grep -q "tests: 1 passed, 0 failed" "$tmp/tested.out"; then
    echo "the core host runs a console project's tests"
else
    echo "the core host failed a console project's tests:" >&2
    cat "$tmp/tested.out" "$tmp/tested.err" >&2
    fail=1
fi

if "$BINTANA_CORE" test --json tests/headless/projects/tested \
        >"$tmp/tested.json" 2>"$tmp/tested-json.err" &&
   grep -q '"Event":"Done","Passed":1,"Failed":0' "$tmp/tested.json"; then
    echo "and answers --json"
else
    echo "the core host's test --json is not the line the IDE reads:" >&2
    cat "$tmp/tested.json" "$tmp/tested-json.err" >&2
    fail=1
fi

# `lib/report` and `lib/charts` split their document from their control: the
# widget classes are not defined in the core, and `ReportDocument` still lays
# out pages and writes the PDF. The last two lines say which host it is.
if BINTANA_LIB_PATH="$PWD/lib" "$BINTANA_CORE" tests/headless/projects/report \
        >"$tmp/report-core.out" 2>"$tmp/report-core.err" &&
   BINTANA_LIB_PATH="$PWD/lib" "$BINTANA" tests/headless/projects/report \
        >"$tmp/report-gui.out" 2>"$tmp/report-gui.err"; then
    head -3 "$tmp/report-core.out" >"$tmp/report-core-stable"
    head -3 "$tmp/report-gui.out"  >"$tmp/report-gui-stable"
    if diff -u "$tmp/report-gui-stable" "$tmp/report-core-stable" \
            >"$tmp/report.diff" &&
       grep -qx "singleton undefined" "$tmp/report-core.out" &&
       grep -qx "chart undefined" "$tmp/report-core.out" &&
       grep -qx "singleton function" "$tmp/report-gui.out" &&
       grep -qx "chart function" "$tmp/report-gui.out"; then
        echo "a ReportDocument writes the PDF without the Report control"
    else
        echo "the report document differs between hosts:" >&2
        cat "$tmp/report.diff" "$tmp/report-core.out" "$tmp/report-gui.out" >&2
        fail=1
    fi
else
    echo "one of the hosts failed the report document:" >&2
    cat "$tmp/report-core.err" "$tmp/report-gui.err" >&2
    fail=1
fi

# A native plugin in the core: `uses: ["testplug"]` finds the suite's reference
# shared object in a library directory and its `init` installs the global before
# `rad.js` runs. Copy it out of the build so the project has no `.so` of its own.
mkdir -p "$tmp/lib/testplug"
plugin_so=$(dirname "$BINTANA_CORE")/testlibs/testplug/testplug.so
if [[ ! -f $plugin_so ]]; then
    echo "no reference plugin at $plugin_so -- build the test plugins" >&2
    fail=1
elif cp "$plugin_so" "$tmp/lib/testplug/testplug.so" &&
     BINTANA_LIB_PATH="$tmp/lib" "$BINTANA_CORE" tests/headless/projects/plugin \
        >"$tmp/plugin.out" 2>"$tmp/plugin.err" &&
     grep -q "plugin:ok" "$tmp/plugin.out"; then
    echo "the core loads a native plugin a project's uses names"
else
    echo "the core did not run a native plugin:" >&2
    cat "$tmp/plugin.out" "$tmp/plugin.err" >&2
    fail=1
fi

# --- the drawing plugin spike ----------------------------------------------
#
# The same loop through a native plugin and through the linked `Drawing`. The
# plugin is built here, into a temporary library directory, and carries cairo
# itself; this is the measurement that says whether a `lib/drawing` plugin is
# worth extracting. The times are printed, not asserted.
drawlib="$tmp/lib/drawing"
mkdir -p "$drawlib"
if cc -shared -fPIC -O2 -I runtime/include -o "$drawlib/drawing.so" \
        tests/headless/drawing_plugin.c $(pkg-config --cflags --libs cairo) \
        >"$tmp/drawing-cc.out" 2>"$tmp/drawing-cc.err"; then
    if BINTANA_LIB_PATH="$tmp/lib" "$BINTANA_CORE" \
            tests/headless/projects/drawplugin >"$tmp/plugin-draw.out" \
            2>"$tmp/plugin-draw.err" &&
       grep -qx "plugin-ok" "$tmp/plugin-draw.out" &&
       grep -qx "pdf application/pdf" "$tmp/plugin-draw.out"; then
        plugin_ms=$(sed -n 's/^plugin-ms //p' "$tmp/plugin-draw.out")
        echo "a Drawing plugin draws a PDF (${plugin_ms} ms)"
    else
        echo "the drawing plugin did not draw a PDF:" >&2
        cat "$tmp/plugin-draw.out" "$tmp/plugin-draw.err" >&2
        fail=1
    fi
else
    echo "the drawing plugin did not compile:" >&2
    cat "$tmp/drawing-cc.err" >&2
    fail=1
fi

if "$BINTANA_CORE" tests/headless/projects/drawspeed \
        >"$tmp/native-draw.out" 2>"$tmp/native-draw.err" &&
   grep -qx "native-ok" "$tmp/native-draw.out"; then
    native_ms=$(sed -n 's/^native-ms //p' "$tmp/native-draw.out")
    echo "linked Drawing baseline: ${native_ms} ms"
else
    echo "the linked Drawing baseline failed:" >&2
    cat "$tmp/native-draw.out" "$tmp/native-draw.err" >&2
    fail=1
fi

# A UI library named by a `main` fails with a sentence that names the library
# and the display, not with `Component is not defined`.
if "$BINTANA_CORE" tests/headless/projects/uilibrary \
        >"$tmp/ui.out" 2>"$tmp/ui.err"; then
    echo "the core ran a main that needs a UI library" >&2
    fail=1
elif grep -q 'library "markdown" needs the graphical host' "$tmp/ui.err" &&
     grep -q 'no display' "$tmp/ui.err"; then
    echo "a UI library is refused by name and display"
else
    echo "a UI library failed without the sentence:" >&2
    cat "$tmp/ui.out" "$tmp/ui.err" >&2
    fail=1
fi

# Without `uses: ["drawing"]` the global is a stub that says what to add; the
# module is not loaded there.
if "$BINTANA_CORE" tests/headless/projects/nodraw         >"$tmp/nodraw.out" 2>"$tmp/nodraw.err"; then
    echo "the core drew without uses: drawing" >&2
    fail=1
elif grep -q 'does not use it: add "uses": \["drawing"\]' "$tmp/nodraw.err"; then
    echo "Drawing without uses says what to add"
else
    echo "Drawing without uses failed without the sentence:" >&2
    cat "$tmp/nodraw.out" "$tmp/nodraw.err" >&2
    fail=1
fi

# The example that uses all of it: CSV in, chart, report and PDF out, with no
# display. It is the CLI the core exists for.
ledger="$tmp/ledger.pdf"
if BINTANA_LIB_PATH="$PWD/lib" "$BINTANA_CORE" examples/ledger "$ledger" \
        >"$tmp/ledger.out" 2>"$tmp/ledger.err" &&
   [[ -s $ledger ]] && [[ $(head -c 4 "$ledger") == "%PDF" ]]; then
    if command -v pdftotext >/dev/null &&
       pdftotext "$ledger" - 2>/dev/null | grep -q "Train to Rosario"; then
        echo "the ledger example writes a PDF with the rows in it"
    else
        echo "the ledger example wrote a PDF, but its text was not read"
    fi
else
    echo "the ledger example did not write a PDF:" >&2
    cat "$tmp/ledger.out" "$tmp/ledger.err" >&2
    fail=1
fi

# `Drawing` is the document half of `DrawingArea`: a PNG and a PDF with no
# control and no display, through Painter, Metrics and Bitmap. Both hosts draw
# the same document; the fixture prints only what is stable across them.
if "$BINTANA_CORE" tests/headless/projects/draw \
        >"$tmp/draw-core.out" 2>"$tmp/draw-core.err" &&
   "$BINTANA" tests/headless/projects/draw \
        >"$tmp/draw-gui.out" 2>"$tmp/draw-gui.err"; then
    if diff -u "$tmp/draw-gui.out" "$tmp/draw-core.out" >"$tmp/draw.diff"; then
        echo "a Drawing document is the same with and without the toolkit"
    else
        echo "the core's Drawing and the graphical one disagree:" >&2
        cat "$tmp/draw.diff" >&2
        fail=1
    fi
else
    echo "one of the hosts failed the Drawing fixture:" >&2
    cat "$tmp/draw-core.err" "$tmp/draw-gui.err" >&2
    fail=1
fi

# The binary links no widget file, and the metadata document is loaded only for
# `check`: a `main` gets the language's own answer for `Widget`.
if out=$("$BINTANA_CORE" tests/headless/projects/bare 2>"$tmp/bare.err") &&
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
    "$BINTANA_CORE" run --theme dark tests/headless/projects/window one two \
    >"$tmp/gui.out" 2>"$tmp/gui.err"
gui_status=$?
printf '%s\n' --theme dark tests/headless/projects/window one two \
    >"$tmp/gui-want"

if [[ $gui_status -eq 7 ]] && diff -u "$tmp/gui-want" "$tmp/gui-args" \
        >"$tmp/gui.diff"; then
    echo "a window project is exec'd as the graphical host"
else
    echo "the core host did not exec the graphical host: exit " \
         "$gui_status" >&2
    cat "$tmp/gui.diff" "$tmp/gui.err" >&2
    fail=1
fi

# The other half of the dispatch: a `main` must not load the toolkit.
BINTANA_GUI="$gui" BINTANA_TEST_GUI_ARGS="$tmp/gui-args-main" \
    "$BINTANA_CORE" tests/headless/projects/run \
    >/dev/null 2>"$tmp/gui-main.err"
if [[ ! -e "$tmp/gui-args-main" ]]; then
    echo "a main project does not dispatch"
else
    echo "the core host dispatched a main project to the toolkit" >&2
    fail=1
fi

# `test` takes the same road: a `startup` project's tests belong to the host
# that can build its widgets, and the words (including `test`) travel whole.
BINTANA_GUI="$gui" BINTANA_TEST_GUI_ARGS="$tmp/gui-test-args" \
    "$BINTANA_CORE" test --json tests/headless/projects/window \
    >/dev/null 2>"$tmp/gui-test.err"
test_status=$?
printf '%s\n' test --json tests/headless/projects/window \
    >"$tmp/gui-test-want"

if [[ $test_status -eq 7 ]] && diff -u "$tmp/gui-test-want" \
        "$tmp/gui-test-args" >"$tmp/gui-test.diff"; then
    echo "a window project's tests are exec'd as the graphical host"
else
    echo "the core did not dispatch a window project's tests: exit " \
         "$test_status" >&2
    cat "$tmp/gui-test.diff" "$tmp/gui-test.err" >&2
    fail=1
fi

if BINTANA_GUI="$gui" BINTANA_TEST_GUI_ARGS="$tmp/gui-test-main" \
        "$BINTANA_CORE" test tests/headless/projects/tested >/dev/null 2>&1 &&
   [[ ! -e "$tmp/gui-test-main" ]]; then
    echo "a console project's tests do not dispatch"
else
    echo "the core dispatched a console project's tests" >&2
    fail=1
fi

if BINTANA_GUI=/nonexistent/host "$BINTANA_CORE" \
        tests/headless/projects/window >/dev/null 2>"$tmp/gui-fail.err"; then
    echo "the core host claimed to run a missing graphical host" >&2
    fail=1
elif grep -q "cannot run the graphical host" "$tmp/gui-fail.err"; then
    echo "a missing graphical host is a sentence"
else
    echo "a missing graphical host said nothing useful:" >&2
    cat "$tmp/gui-fail.err" >&2
    fail=1
fi

if command -v ldd >/dev/null; then
    if ldd "$BINTANA_CORE" | grep -Eiq 'libgtk|libgtksource|libvte'; then
        echo "the core host links a toolkit:" >&2
        ldd "$BINTANA_CORE" | grep -Ei 'libgtk|libgtksource|libvte' >&2
        fail=1
    else
        echo "the core host links no GTK, GtkSourceView or VTE"
    fi
fi

exit "$fail"
