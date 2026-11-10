#!/usr/bin/env bash
# The File provider of Keyring: the half JavaScript cannot see.
#
#   tests/keyring.sh
#   BINTANA=/other/bintana tests/keyring.sh
#
# Run by the `no-libsecret` job, where the provider is `File`. A build whose
# provider is a vault says so and exits 2: a run that proved nothing must not
# end well.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

export LANGUAGE=C

BINTANA=${BINTANA:-./build/bintana}
if [[ ! -x $BINTANA ]]; then
    echo "no runtime at $BINTANA -- build first: cmake --build build" >&2
    exit 2
fi

tmp=$(mktemp -d)
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT

config="$tmp/config"
mkdir -p "$config"

out=$(XDG_CONFIG_HOME="$config" timeout "${TIMEOUT:-30}" "$BINTANA" tests/keyring 2>&1)
status=$?
printf '%s\n' "$out"

if ! grep -q '^Provider=File$' <<<"$out"; then
    echo "keyring.sh: this build does not use the File provider" >&2
    exit 2
fi
if (( status != 0 )) || ! grep -q '^STORE=true$' <<<"$out"; then
    echo "keyring.sh: the store failed" >&2
    exit 1
fi

file="$config/bintana/keyring/secrets/service/key"
secrets="$config/bintana/keyring/secrets"
service_dir="$secrets/service"

for path in "$file" "$secrets" "$service_dir"; do
    if [[ ! -e $path ]]; then
        echo "keyring.sh: missing $path" >&2
        exit 1
    fi
done

mode=$(stat -c %a "$file" 2>/dev/null || stat -f %Lp "$file")
[[ $mode == 600 ]] || { echo "keyring.sh: the secret is mode $mode, not 600" >&2; exit 1; }

for dir in "$secrets" "$service_dir"; do
    mode=$(stat -c %a "$dir" 2>/dev/null || stat -f %Lp "$dir")
    [[ $mode == 700 ]] || { echo "keyring.sh: $dir is mode $mode, not 700" >&2; exit 1; }
done

# A failed store must leave no temporary behind. Making `secrets` a regular
# file makes `g_mkdir_with_parents` fail before anything is written.
bad="$tmp/bad"
mkdir -p "$bad/bintana/keyring"
: > "$bad/bintana/keyring/secrets"

out2=$(XDG_CONFIG_HOME="$bad" timeout "${TIMEOUT:-30}" "$BINTANA" tests/keyring 2>&1)
printf '%s\n' "$out2"
grep -q '^Provider=File$' <<<"$out2" || { echo "keyring.sh: the bad run lost its provider" >&2; exit 1; }
grep -q '^STORE=false$' <<<"$out2" || { echo "keyring.sh: the failed store did not answer false" >&2; exit 1; }
if find "$bad" -name '*.tmp*' -print -quit | grep -q .; then
    echo "keyring.sh: a failed store left a temporary behind" >&2
    exit 1
fi

echo "keyring: the File provider stores 0600 under 0700 and leaves no temporary"
