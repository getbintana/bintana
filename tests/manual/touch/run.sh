#!/usr/bin/env bash
# What a touch screen reaches GTK, and a Bintana window, as -- on Linux, with a
# virtual touch screen (uinput) instead of a finger.
#
#   tests/manual/touch/run.sh
#
# **This one opens two windows on the screen it is run from and plays touches
# on it**: it is for a person at the machine, and the mouse should be left
# alone while it runs.  Xvfb has no touch and `/dev/uinput` is root's, so the
# only thing run with `sudo` is `touchsim` (asks for the password once).
#
# Part 1 is `gtkprobe`: GTK's own gestures, no Bintana -- is the toolkit
# delivering a touch at all, and which gestures.  Part 2 is the TouchProbe
# project: what the runtime's mouse events see of the same touches.
#
#   BINTANA=<path>  another build            OUT=<dir>  where the logs are kept
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
BINTANA=${BINTANA:-$root/build/bintana}
OUT=${OUT:-/tmp/bintana-touch-$(date +%Y%m%d-%H%M%S)}

die() { echo "run.sh: $*" >&2; exit 1; }
for tool in gcc pkg-config xdotool sudo; do command -v "$tool" >/dev/null || die "missing: $tool"; done
pkg-config --exists gtk4 || die "missing: gtk4 development files"
[[ -n ${DISPLAY-} ]] || die "no DISPLAY: this needs the screen it will touch"
[[ -e /dev/uinput ]] || die "no /dev/uinput (modprobe uinput)"
[[ -x $BINTANA ]] || die "no build at $BINTANA -- cmake --build build"

mkdir -p "$OUT/bin" "$OUT/cfg"
gcc -O1 -o "$OUT/bin/touchsim" "$here/touchsim.c" -lm || die "touchsim did not build"
gcc -O1 -o "$OUT/bin/gtkprobe" "$here/gtkprobe.c" $(pkg-config --cflags --libs gtk4) -lm || die "gtkprobe did not build"

pids=()
cleanup() {
    [[ -n ${SIM_PID-} ]] && { echo quit >&"${SIM[1]}" 2>/dev/null; }
    for p in "${pids[@]}"; do kill "$p" 2>/dev/null; done
}
trap cleanup EXIT

read -r SW SH < <(xdotool getdisplaygeometry)
echo "screen ${SW}x${SH}; logs in $OUT"
sudo -v || die "sudo is needed for /dev/uinput"
coproc SIM { sudo "$OUT/bin/touchsim" "$SW" "$SH" 2>"$OUT/touchsim.err"; }
read -r -t 30 -u "${SIM[0]}" line && [[ $line == ready ]] || die "touchsim did not start: $(cat "$OUT/touchsim.err")"

drive() { echo "$*" >&"${SIM[1]}"; read -r -t 30 -u "${SIM[0]}" _ || die "touchsim stopped answering"; }

# Where does the server really put a touch?  A tap at a known point moves the
# pointer there (the touch is also a pointer to X), so measure the scale: on
# this machine a tap at x=403 arrived at x=805.
drive tap $((SW / 4)) $((SH / 2)); sleep 0.5
read -r px py < <(xdotool getmouselocation --shell | awk -F= '/^X=/{x=$2} /^Y=/{y=$2} END{print x, y}')
kx=$(awk -v p="$px" -v w="$SW" 'BEGIN{printf "%.4f", p / (w / 4)}')
ky=$(awk -v p="$py" -v h="$SH" 'BEGIN{printf "%.4f", p / (h / 2)}')
echo "  a tap at $((SW / 4)),$((SH / 2)) put the pointer at $px,$py: scale $kx x $ky"
if awk -v a="$kx" -v b="$ky" 'BEGIN{exit !(a < 0.98 || a > 1.02 || b < 0.98 || b > 1.02)}'; then
    drive scale "$kx" "$ky"
fi

# Start a program, return its window id, placed at a known corner.
open_window() {                     # <pid>
    local id n=0
    while (( n++ < 100 )); do
        for id in $(xdotool search --onlyvisible --pid "$1" 2>/dev/null); do
            eval "$(xdotool getwindowgeometry --shell "$id")"
            if (( WIDTH >= 300 && HEIGHT >= 200 )); then
                xdotool windowmove "$id" 80 80; sleep 0.5
                xdotool windowraise "$id" 2>/dev/null
                eval "$(xdotool getwindowgeometry --shell "$id")"
                echo "$id $X $Y $WIDTH $HEIGHT"; return 0
            fi
        done
        sleep 0.2
    done
    return 1
}

lines() { wc -l <"$1" | tr -d ' '; }
# Wait until <file> has a line matching <pattern> after line <from>; print the last such line.
await() {
    local n=0 hit
    while (( n++ < 40 )); do
        hit=$(tail -n +$(($3 + 1)) "$1" | grep -E "$2" | tail -1)
        [[ -n $hit ]] && { echo "$hit"; return 0; }
        sleep 0.1
    done
    return 1
}
field() { sed -E "s/.*[[:space:]]$2=([-0-9.]+).*/\1/" <<<"$1"; }

results=()
verdict() { printf '  %-34s %s\n' "$1" "$2"; results+=("$1: $2"); }

# ---------------------------------------------------------------- part 1
echo; echo "== 1. GTK on its own"
"$OUT/bin/gtkprobe" >"$OUT/gtk.log" 2>"$OUT/gtk.err" &
gpid=$!; pids+=("$gpid")
read -r gid gx gy gw gh < <(open_window "$gpid") || die "gtkprobe has no window"
sleep 1

# Calibrate: where does the area really begin?  A tap at the guessed centre
# says where it landed in the area's own coordinates.
cx=$((gx + gw / 2)); cy=$((gy + gh / 2))
n=$(lines "$OUT/gtk.log")
echo "  window $gid at $gx,$gy ${gw}x${gh}; first tap at $cx,$cy"
hit=
for try in 1 2 3; do
    drive tap "$cx" "$cy"
    hit=$(await "$OUT/gtk.log" "click-press" "$n") && break
    echo "  tap $try: nothing yet"
done
if [[ -z $hit ]]; then
    {
        echo "window: $(xdotool getwindowgeometry $gid | tr '\n' ' ')"
        echo "active: $(xdotool getactivewindow getwindowname 2>&1)"
        echo "--- gtk.log"; cat "$OUT/gtk.log"
        echo "--- Xorg.0.log"; grep -i touchsim /var/log/Xorg.0.log ~/.local/share/xorg/Xorg.0.log 2>/dev/null | tail -20
    } >"$OUT/diagnosis.txt" 2>&1
    {
        echo "--- a tap, seen by libinput and by the pointer"
        ev=$(awk '/bintana-touchsim/{f=1} f&&/Handlers=/{for(i=1;i<=NF;i++)if($i~/^event/)print $i; exit}' /proc/bus/input/devices)
        echo "device: /dev/input/$ev; pointer before: $(xdotool getmouselocation)"
        sudo timeout 5 libinput debug-events --device "/dev/input/$ev" >"$OUT/libinput.txt" 2>&1 & lp=$!
        sleep 1.5; drive tap "$cx" "$cy"; sleep 1.5; wait "$lp"
        echo "pointer after: $(xdotool getmouselocation)"
        echo "libinput said:"; cat "$OUT/libinput.txt"
    } >>"$OUT/diagnosis.txt" 2>&1
    die "three taps reached GTK as nothing; see $OUT/diagnosis.txt (the server took the device, or the touches went elsewhere)"
fi
lx=$(field "$hit" x); ly=$(field "$hit" y)
ox=$(( cx - ${lx%.*} )); oy=$(( cy - ${ly%.*} ))
size=$(grep ' size ' "$OUT/gtk.log" | tail -1); aw=$(awk '{print $3}' <<<"$size"); ah=$(awk '{print $4}' <<<"$size")
ccx=$(( ox + aw / 2 )); ccy=$(( oy + ah / 2 ))
echo "  area origin ${ox},${oy}, size ${aw}x${ah}, centre ${ccx},${ccy}"

# Does the device map one to one?  A second tap 100 px away must land 100 px away.
n=$(lines "$OUT/gtk.log"); drive tap $((ccx + 100)) $((ccy + 80))
hit=$(await "$OUT/gtk.log" "click-press" "$n") || die "the second tap did not arrive"
dx=$(( $(field "$hit" x | cut -d. -f1) - (cx - ox) - 100 )); dy=$(( $(field "$hit" y | cut -d. -f1) - (cy - oy) - 80 ))
echo "  mapping error of a 100x80 offset: ${dx},${dy} px"

# play <name> <pattern> <touchsim command...>: run, wait, grep what came after
play() {
    local name=$1 pattern=$2; shift 2
    local n; n=$(lines "$OUT/gtk.log")
    drive "$@"; sleep 1
    tail -n +$((n + 1)) "$OUT/gtk.log" >"$OUT/gtk.$name.log"
    if grep -Eq "$pattern" "$OUT/gtk.$name.log"; then
        verdict "$name" "delivered ($(grep -Ec "$pattern" "$OUT/gtk.$name.log") lines)"
    else
        verdict "$name" "NOT delivered"
    fi
}

play tap            'click-release'      tap "$ccx" "$ccy"
play longpress      'longpress x='       hold "$ccx" "$ccy" 1500
play swipe          'swipe vx='          swipe $((ccx - 150)) "$ccy" $((ccx + 150)) "$ccy" 120
play drag1          'drag1-update'       swipe $((ccx - 150)) "$ccy" $((ccx + 150)) "$ccy" 700
play pinch          'zoom scale='        pinch "$ccx" "$ccy" 40 140 700
play rotate         'rotate angle='      rotate "$ccx" "$ccy" 100 60 700
play pan2           'drag2-update'       pan2 $((ccx - 100)) "$ccy" $((ccx + 100)) "$ccy" 700

if grep -q 'src=touchscreen' "$OUT/gtk.log"; then
    verdict "touch source" "GTK sees a touchscreen"
else
    verdict "touch source" "no touchscreen events at all"
fi
echo "  last zoom:   $(grep 'zoom scale' "$OUT/gtk.pinch.log" | tail -1)   (expect about 3.5)"
echo "  last rotate: $(grep 'rotate angle' "$OUT/gtk.rotate.log" | tail -1)   (expect about 60)"
echo "  swipe:       $(grep 'swipe vx' "$OUT/gtk.swipe.log" | tail -1)"
kill "$gpid" 2>/dev/null

# ---------------------------------------------------------------- part 2
echo; echo "== 2. The same touches, through Bintana"
XDG_CONFIG_HOME="$OUT/cfg" "$BINTANA" "$here" >"$OUT/bintana.out" 2>&1 &
bpid=$!; pids+=("$bpid")
read -r bid bx by bw bh < <(open_window "$bpid") || die "TouchProbe has no window (see $OUT/bintana.out)"
sleep 2
probe=$(find "$OUT/cfg" -name probe.log | head -1)
[[ -n $probe ]] || die "TouchProbe wrote no probe.log"

# The probe's form coordinates of the area's centre are 260,308 (its own size is fixed).
bcx=$((bx + 260)); bcy=$((by + 308))
n=$(lines "$probe"); drive tap "$bcx" "$bcy"
hit=$(await "$probe" "form down" "$n") || die "the first tap did not reach the Bintana window (see $probe)"
fx=$(field "$hit" x | cut -d. -f1); fy=$(field "$hit" y | cut -d. -f1)
bcx=$((bcx + 260 - fx)); bcy=$((bcy + 308 - fy))

# bplay <name> <touchsim command...>: run, show what the runtime heard
bplay() {
    local name=$1; shift
    local n; n=$(lines "$probe")
    drive "$@"; sleep 1.2
    tail -n +$((n + 1)) "$probe" >"$OUT/bintana.$name.log"
    local down up b3 move wheel
    down=$(grep -c ' area down' "$OUT/bintana.$name.log")
    up=$(grep -c ' area up' "$OUT/bintana.$name.log")
    b3=$(grep -c 'button=3' "$OUT/bintana.$name.log")
    move=$(grep -c ' area move' "$OUT/bintana.$name.log")
    wheel=$(grep -c ' wheel' "$OUT/bintana.$name.log")
    verdict "bintana $name" "down=$down up=$up button3=$b3 move=$move wheel=$wheel"
}

bplay tap       tap "$bcx" "$bcy"
bplay longpress hold "$bcx" "$bcy" 1500
bplay swipe     swipe $((bcx - 150)) "$bcy" $((bcx + 150)) "$bcy" 300
bplay pinch     pinch "$bcx" "$bcy" 40 140 700
bplay pan2      pan2 $((bcx - 100)) "$bcy" $((bcx + 100)) "$bcy" 700

echo
echo "Done.  Send $OUT (gtk.log, gtk.*.log, bintana.*.log, probe.log) or the lines above."
printf '%s\n' "${results[@]}" >"$OUT/summary.txt"
