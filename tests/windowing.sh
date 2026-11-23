#!/usr/bin/env bash
# What a window does on a desktop with a window manager: activation, and the
# popovers that must not outlive it -- the half tests/widgets cannot see, on a
# bare Xvfb where no window is ever activated.
#
#   tests/windowing.sh
#   BINTANA=/other/bintana tests/windowing.sh
#
# Needs xvfb-run, xfwm4, xdotool and xprop (X11 only). Without them it says
# which is missing and exits 2: a run that proved nothing must not end well.
#
# The project is tests/windowing/app, one level down, so tests/run.sh -- which
# runs every window project directly under tests/, on a bare Xvfb -- does not
# run it where it cannot pass.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

BINTANA=${BINTANA:-./build/bintana}
if [[ ! -x $BINTANA ]]; then
    echo "no runtime at $BINTANA -- build first: cmake --build build" >&2
    exit 2
fi
for tool in xvfb-run xfwm4 xdotool xprop; do
    if ! command -v "$tool" >/dev/null; then
        echo "windowing.sh: no $tool -- nothing was checked" >&2
        exit 2
    fi
done

config=$(mktemp -d)
trap 'rm -rf "$config"' EXIT
export XDG_CONFIG_HOME=$config LANGUAGE=C

timeout "${TIMEOUT:-90}" xvfb-run -a sh -c \
    'xfwm4 >/dev/null 2>&1 & sleep 1.5; "$0" tests/windowing/app; s=$?; kill $! 2>/dev/null; exit $s' \
    "$BINTANA" 2>&1 | grep -v 'MESA\|DRI3\|Note: you can'
exit "${PIPESTATUS[0]}"
