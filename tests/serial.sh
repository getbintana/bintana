#!/usr/bin/env bash
# SerialPort over a pseudo-terminal: termios configuration, line and byte
# modes, writes, refusals.
#
#   tests/serial.sh                    every check
#   BINTANA=/other/bintana tests/serial.sh   another build, to compare
#   TIMEOUT=300 tests/serial.sh        a slower machine
#
# `tests/serial` is a console project -- no display -- and the pty is made by
# `tests/serial/peer.c`, which is the other end of the wire. A pty is a tty,
# so it takes the same `tcgetattr`/`tcsetattr` path a USB adapter does; the
# modem lines it cannot exercise are a by-hand check.
set -uo pipefail
cd "$(dirname "$0")/.."

# The assertions and the refusal notes are English; a library's catalogue
# must not translate the suite's output under it.
export LANGUAGE=C

BINTANA=${BINTANA:-./build/bintana}
if [[ ! -x $BINTANA ]]; then
    echo "no runtime at $BINTANA -- build first: cmake --build build" >&2
    exit 2
fi

tmp=$(mktemp -d)
helper=""
cleanup() {
    if [[ -n $helper ]]; then
        kill "$helper" 2>/dev/null || true
        wait "$helper" 2>/dev/null || true
    fi
    rm -rf "$tmp"
}
trap cleanup EXIT

if ! cc -O2 -Wall -o "$tmp/peer" tests/serial/peer.c; then
    echo "cannot build tests/serial/peer.c" >&2
    exit 2
fi

"$tmp/peer" "$tmp/port" >"$tmp/helper.log" 2>&1 &
helper=$!

for _ in $(seq 1 100); do
    [[ -s $tmp/port ]] && break
    sleep 0.05
done
if [[ ! -s $tmp/port ]]; then
    echo "the pseudo-terminal helper did not start:" >&2
    cat "$tmp/helper.log" >&2
    exit 2
fi

export BINTANA_SERIAL_PORT
BINTANA_SERIAL_PORT=$(cat "$tmp/port")
export MALLOC_PERTURB_=${MALLOC_PERTURB_-165}

timeout "${TIMEOUT:-30}" "$BINTANA" tests/serial
status=$?

if (( status != 0 )); then
    echo "--- the helper's side ---" >&2
    cat "$tmp/helper.log" >&2
fi
exit "$status"
