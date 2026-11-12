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
