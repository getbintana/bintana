#!/usr/bin/env bash
# Asks questions of the screen instead of looking at it.
#
# A screenshot answers "is this right?" only by being looked at, which is
# expensive and not repeatable.  Most of what one wants from it is a number:
# what colour is that pixel, is that band empty, did anything change.  Those are
# answers a terminal can give.
#
#   tests/probe.sh shot   <window-name-regex> <out.png>   capture, print geometry
#   tests/probe.sh pixel  <png> <x> <y>                   the colour there
#   tests/probe.sh region <png> <w>x<h>+<x>+<y>           mean and spread
#   tests/probe.sh diff   <a.png> <b.png>                 pixels that differ
#
# A uniform region (spread ~0) is a blank one: that is how the empty band
# between the IDE's tabs and its designer was found, and how it stays found.
#
# What still needs eyes: whether an icon reads as what it is, whether a layout
# looks right.  For those, crop to the part in question -- a window is ten times
# the cost of the corner of it that matters.
set -uo pipefail

usage() { sed -n '2,20p' "$0" | sed 's/^# \?//' >&2; exit 2; }

case "${1:-}" in
shot)
    [[ $# -eq 3 ]] || usage
    wid=$(xdotool search --name "$2" | tail -1)
    if [[ -z $wid ]]; then echo "no window matching '$2'" >&2; exit 1; fi

    # Activated first: GTK draws an unfocused window greyed out (:backdrop), and
    # a click on one is eaten by the focus change.
    xdotool windowactivate --sync "$wid" 2>/dev/null
    sleep 0.3
    import -window "$wid" "$3"
    eval "$(xdotool getwindowgeometry --shell "$wid")"
    echo "window=$wid geometry=${WIDTH}x${HEIGHT}+${X}+${Y} file=$3"
    ;;
pixel)
    [[ $# -eq 4 ]] || usage
    magick "$2" -format "%[pixel:p{$3,$4}]\n" info:
    ;;
region)
    [[ $# -eq 3 ]] || usage
    magick "$2" -crop "$3" +repage \
        -format "mean=%[fx:mean] spread=%[fx:standard_deviation]\n" info:
    ;;
diff)
    [[ $# -eq 3 ]] || usage
    magick compare -metric AE "$2" "$3" null: 2>&1 | tail -1
    echo
    ;;
*)
    usage
    ;;
esac
