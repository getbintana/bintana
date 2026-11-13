#!/usr/bin/env bash
# Database.Odbc through real drivers: sqliteodbc always, psqlODBC against a
# PostgreSQL in Docker when there is one.
#
#   tests/odbc.sh                    every check this machine can run
#   POSTGRES=0 tests/odbc.sh         sqliteodbc only
#   POSTGRES=1 tests/odbc.sh         PostgreSQL is required: fail without it
#   BINTANA=/other/bintana tests/odbc.sh
#
# **Nothing of the machine's ODBC configuration is read.** The script writes an
# odbcinst.ini and an odbc.ini of its own and points ODBCSYSINI and ODBCINI at
# them (unixODBC honours both, measured), so a DSN somebody configured in /etc
# or ~/.odbc.ini neither helps nor breaks a run.
#
# The drivers are looked for where Fedora, Debian/Ubuntu and Homebrew put them;
# BINTANA_ODBC_SQLITE_LIB and BINTANA_ODBC_PG_LIB name one elsewhere. Without
# sqliteodbc the run proved nothing and exits 2, naming the package. The
# PostgreSQL half uses the `postgres:16` image if it is already there -- it is
# never pulled silently -- and removes its container on the way out.
#
# Windows has its drivers in the registry and is stage 6 of the plan.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

export LANGUAGE=C

# **The graphical host**, though the project is a `main` and `Database.Odbc` is
# the core's too: two blocks write a `Connection` part's `.form` properties,
# and `FormPart.prototype.Serialize` is `forms.js`'s, which the core does not
# load. Everything else here passes under `bintana`.
export BINTANA=${BINTANA:-./build/bintana-gui}
if [[ ! -x $BINTANA ]]; then
    echo "no runtime at $BINTANA -- build first: cmake --build build" >&2
    exit 2
fi

first() {
    for f in "$@"; do
        [[ -n $f && -e $f ]] && { printf '%s\n' "$f"; return 0; }
    done
    return 1
}

sqlite_lib=$(first "${BINTANA_ODBC_SQLITE_LIB:-}" \
    /usr/lib64/libsqlite3odbc.so \
    /usr/lib/x86_64-linux-gnu/odbc/libsqlite3odbc.so \
    /usr/lib/aarch64-linux-gnu/odbc/libsqlite3odbc.so \
    /opt/homebrew/lib/libsqlite3odbc.dylib \
    /usr/local/lib/libsqlite3odbc.dylib) || sqlite_lib=""
pg_lib=$(first "${BINTANA_ODBC_PG_LIB:-}" \
    /usr/lib64/psqlodbcw.so \
    /usr/lib/x86_64-linux-gnu/odbc/psqlodbcw.so \
    /usr/lib/aarch64-linux-gnu/odbc/psqlodbcw.so \
    /opt/homebrew/lib/psqlodbcw.so \
    /usr/local/lib/psqlodbcw.so) || pg_lib=""

tmp=$(mktemp -d)
container=""
cleanup() {
    [[ -n $container ]] && docker rm -f "$container" >/dev/null 2>&1
    rm -rf "$tmp"
}
trap cleanup EXIT

mkdir -p "$tmp/ini" "$tmp/data"
{
    if [[ -n $sqlite_lib ]]; then
        printf '[BintanaSqlite]\nDriver=%s\nThreading=2\n\n' "$sqlite_lib"
    fi
    if [[ -n $pg_lib ]]; then
        printf '[BintanaPostgres]\nDriver=%s\n\n' "$pg_lib"
    fi
} > "$tmp/ini/odbcinst.ini"
printf '[BintanaTest]\nDriver=BintanaSqlite\nDatabase=%s\n' "$tmp/data/dsn.db" \
    > "$tmp/ini/odbc.ini"

export ODBCSYSINI="$tmp/ini"
export ODBCINI="$tmp/ini/odbc.ini"
export BINTANA_ODBC_DIR="$tmp/data"
export BINTANA_ODBC_DSN=BintanaTest
if [[ -n $sqlite_lib ]]; then
    export BINTANA_ODBC_SQLITE=BintanaSqlite
fi

# PostgreSQL, when it can be had without pulling anything.
want=${POSTGRES-auto}
why=""
if [[ $want == 0 ]]; then
    why="POSTGRES=0"
elif [[ -z $pg_lib ]]; then
    why="no psqlODBC driver (postgresql-odbc, odbc-postgresql, Homebrew's psqlodbc)"
elif ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
    why="no Docker to run a server in"
elif ! docker image inspect postgres:16 >/dev/null 2>&1; then
    why="no postgres:16 image -- docker pull postgres:16"
fi

if [[ -z $why ]]; then
    password='bintana;pass}word'
    container="bintana-odbc-$$"
    if docker run -d --rm --name "$container" -e POSTGRES_PASSWORD="$password" \
            -p 127.0.0.1:55433:5432 postgres:16 >/dev/null; then
        for _ in $(seq 1 60); do
            docker exec "$container" pg_isready -U postgres -h 127.0.0.1 \
                >/dev/null 2>&1 && break
            sleep 0.5
        done
        if docker exec "$container" pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1; then
            export BINTANA_ODBC_PG="Driver=BintanaPostgres;Server=127.0.0.1;Port=55433;Database=postgres"
            export BINTANA_ODBC_PG_PASSWORD="$password"
        else
            why="the server did not become ready"
        fi
    else
        container=""
        why="docker run failed (is port 55433 taken?)"
    fi
fi
if [[ -n $why ]]; then
    echo "odbc.sh: PostgreSQL skipped -- $why"
    if [[ $want == 1 ]]; then
        echo "odbc.sh: POSTGRES=1 and no server" >&2
        exit 1
    fi
fi

out=$(timeout "${TIMEOUT:-120}" "$BINTANA" tests/odbc 2>&1)
status=$?
printf '%s\n' "$out"

if grep -q '^ODBC=absent$' <<<"$out"; then
    echo "odbc.sh: this build has no ODBC -- it proved the refusal and nothing else" >&2
    exit 2
fi
if [[ -z $sqlite_lib ]]; then
    echo "odbc.sh: no sqliteodbc driver (sqliteodbc, libsqliteodbc, Homebrew's" \
         "sqliteodbc) -- the run proved nothing" >&2
    exit 2
fi

# examples/invoices, the same screen on each engine: its --selftest types two
# invoices, refuses a third mid-transaction, deletes one, and prints a line.
# It is a window, so it runs on a virtual display (tests/try.sh).
example() {
    local engine=$1; shift
    local got
    got=$(env "$@" timeout "${TIMEOUT:-60}" tests/try.sh examples/invoices --selftest 2>&1 \
          | grep '^invoices:')
    if [[ $got == "invoices: $engine, 2 issued, 1 refused, 1 left, total 2059.80" ]]; then
        echo "  ok    examples/invoices on $engine"
    else
        echo "  FAIL  examples/invoices on $engine -- ${got:-no answer}"
        status=1
    fi
}
if ! command -v xvfb-run >/dev/null 2>&1; then
    echo "  skip  examples/invoices -- no xvfb-run for its window"
else
    example SQLite INVOICES_ODBC="Driver=BintanaSqlite;Database=$tmp/data/invoices.db"
    if [[ -n ${BINTANA_ODBC_PG:-} ]]; then
        example PostgreSQL INVOICES_ODBC="$BINTANA_ODBC_PG" INVOICES_DB_USER=postgres \
                INVOICES_DB_PASSWORD="$BINTANA_ODBC_PG_PASSWORD"
    fi
fi
exit "$status"
