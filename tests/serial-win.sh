#!/usr/bin/env bash
# SerialPort on Windows: termios' counterpart (CreateFileW/DCB), line and byte
# modes, writes, refusals.
#
#   BINTANA_SERIAL_PORT=COM3 BINTANA_SERIAL_LOOPBACK=1 ./tests/serial-win.sh
#   BINTANA_SERIAL_PORT=COM3 BINTANA_SERIAL_PEER=COM4 ./tests/serial-win.sh
#   BINTANA=/other/bintana.exe ./tests/serial-win.sh
#   TIMEOUT=300 ./tests/serial-win.sh
#
# The loopback is one adapter whose TX is tied to RX, or HHD's script port
# running the loopback sample.  The pair is two ends -- com0com, HHD's bridge,
# or two adapters cabled together -- and `peer.ps1` opens the other end with
# the .NET Framework's own SerialPort, so the two sides are different
# implementations.  The test opens the line and the bytes on two handles
# because HHD's driver blocks a second write on one; a real UART does not.
#
# `tests/serial` is a console project -- no display.  Without a port this
# script exits 2 and installs nothing.
set -uo pipefail
cd "$(dirname "$0")/.."

# The assertions and the refusal notes are English; a library's catalogue
# must not translate the suite's output under it.
export LANGUAGE=C

BINTANA=${BINTANA:-./build/bintana.exe}
if [[ ! -x $BINTANA ]]; then
    echo "no runtime at $BINTANA -- build first: cmake --build build" >&2
    exit 2
fi

port=${BINTANA_SERIAL_PORT:-}
loopback=${BINTANA_SERIAL_LOOPBACK:-}
peer=${BINTANA_SERIAL_PEER:-}

if [[ -z $port ]]; then
    echo "no port: set BINTANA_SERIAL_PORT to a COM port, for example COM3" >&2
    exit 2
fi

if [[ $loopback == "1" ]]; then
    BINTANA_SERIAL_PORT=$port BINTANA_SERIAL_LOOPBACK=1 "$BINTANA" tests/serial
    exit $?
fi

if [[ -z $peer ]]; then
    echo "no pair: set BINTANA_SERIAL_LOOPBACK=1 for a TX/RX loopback, or" >&2
    echo "BINTANA_SERIAL_PEER to the other end of a pair (COM4)" >&2
    exit 2
fi

work=$(mktemp -d)
ready=$work/ready
peer_pid=""

cleanup() {
    if [[ -n $peer_pid ]]; then
        kill "$peer_pid" 2>/dev/null
        wait "$peer_pid" 2>/dev/null
    fi
    rm -rf "$work"
}
trap cleanup EXIT

powershell.exe -NoProfile -ExecutionPolicy Bypass \
    -File tests/serial/peer.ps1 -Port "$peer" -Ready "$ready" &
peer_pid=$!

for _ in $(seq 1 100); do
    [[ -f $ready ]] && break
    sleep 0.1
done
if [[ ! -f $ready ]]; then
    echo "the peer did not open $peer" >&2
    exit 2
fi
rm -f "$ready"

BINTANA_SERIAL_PORT=$port "$BINTANA" tests/serial
status=$?

wait "$peer_pid"
peer_status=$?
peer_pid=""

if [[ $peer_status -ne 0 && $status -eq 0 ]]; then
    echo "the peer did not finish the exchange" >&2
    status=1
fi
exit "$status"
