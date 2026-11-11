# PostgreSQL: `Database.Postgres`, the second driver

**Status: planned, not started (2026-11-09).** This is the answer to **R1** of
[the October audit](../audit-2026-10.md): `Database` publishes `Sqlite` alone,
so a client-server business application cannot be written. It takes the place of
the issue that was the report; the gap is now a design, and the report is
deleted. **Since 2026-11-11 it follows [`odbc-plan.md`](odbc-plan.md)**, which
reaches every server through one driver and designs the `Dialect` growth below
for N engines; this plan stays for what ODBC does not give -- no driver to
install, a Flatpak, a `timestamptz` with its offset, TLS named by the runtime.

## What the application needed

A billing application for a company of forty people, where three of them edit
the same invoices at the same time and a file on one desktop cannot be that.
The data lives in a PostgreSQL server the office runs, and the program connects
to it over the network with a host and a database name. The code the author
wished to write:

```js
const db = Database.Postgres("billing.internal", "invoices",
                             { User: "billing", Password: "…" });
// and it answers the same words the sqlite connection answers:
//   Query, Execute, Script, Transaction, Columns, Tables, Dialect, Close
```

The application was delivered against a local sqlite file with a one-machine
user story. The server half of the business was left out rather than faked.

## What already exists

`runtime/src/bta_database.c` owns the part that is not any one engine:

- `Connection`, a base class with an empty prototype, so `rad.js` can hang
  `Table` and `Cursor` on it and every driver gets them;
- `Database`, the object each driver adds its opener to;
- `bta_database_driver(ctx, name, open, nargs)`, the extension point.

`runtime/src/bta_sqlite.c` is the worked example: a `JSClassID` of its own, a
prototype built with `JS_NewObjectProto` on `bta_connection_proto()`, and one
call to `bta_database_driver`. It was completed as the model for this plan:
`Cursor`/`Each`, the language's order in a statement, an `Update` that writes
only what changed, and a `Dialect` whose comments already spell PostgreSQL's
`$%d` and `Returning`.

What `Table`, in `runtime/js/rad.js`, asks a connection for:

    Query(sql, params) -> rows        Execute(sql, params) -> { Changes }
    Each(sql, params, fn) -> count    Transaction(fn)
    Columns(table) -> [{ Name, Type, Required, Key }]
    Tables                            Dialect -> { Placeholder, Quote, NewKey }

and `ConnectionPart`/`Model` ask for `Script`, `Table` and `Dialect` on top.
The build pattern is sqlite's: an optional `pkg-config` module, and the name
exists in every build and says which package is missing when the library is not
there.

## The engine differences that matter

| | sqlite | PostgreSQL |
|---|---|---|
| a parameter | `?` | `$1` |
| the key just made | `last_insert_rowid` | `INSERT … RETURNING` |
| metadata | `sqlite_master`, `PRAGMA` | `information_schema`, `pg_catalog` |
| an exact decimal | none: `TEXT` plus a collation | `NUMERIC` |
| quoting a name | `"x"` | `"x"` |
| a boolean | `0`/`1` | `boolean`, `true`/`false` |
| a blob | `BLOB` | `bytea`, `\x…` |
| a date and time | text | `date`, `time`, `timestamp`, `timestamptz` |
| a parameter's type | dynamic | OIDs and a text format |
| a result | rows | rows or a command tag |
| a schema | one file | `search_path`, schemas |

That table is why the opener is `Database.Sqlite(path)` and not
`Database.Open(path)`, and why the second one is `Database.Postgres`, not a
scheme in a URI.

## The shape

### `Database.Postgres(host, database, [options])`

```js
const db = Database.Postgres("billing.internal", "invoices", {
    User: "billing",
    Password: Environment.Get("BILLING_DB_PASSWORD"),
    Tls: { Mode: "VerifyFull", Ca: "/etc/ssl/company-ca.pem" },
    Timeout: 10000,
    StatementTimeout: 30000,
});
```

`host` is a host name or address, a comma-separated list, or a Unix socket
directory; `""` leaves it to libpq's default. `database` is required.

| option | what it does |
|---|---|
| `Port` | 5432 unless told |
| `User` | the role; libpq's `PGUSER` when absent |
| `Password` | the secret; libpq's `.pgpass`/`PGPASSWORD` when absent |
| `Tls` | `{ Mode, Ca, Cert, Key }` — `Mode` is `"Disable"`, `"Allow"`, `"Prefer"`, `"Require"`, `"VerifyCa"` or `"VerifyFull"`, and the default is **`"Require"`** for TCP; a Unix socket has no TLS |
| `Timeout` | connect timeout in milliseconds; 10000 unless told |
| `StatementTimeout` | the server's `statement_timeout` in milliseconds; absent means none |
| `ApplicationName` | what `pg_stat_activity` shows; `"Bintana"` |
| `SearchPath` | set with `set_config('search_path', $1, false)`, never pasted into SQL |

It opens immediately, as `Database.Sqlite` does; a failed connection throws with
libpq's message. `Close` is idempotent. In a build without libpq,
`Database.Postgres` exists and refuses with a sentence naming the package, so
`typeof Database` is never `"undefined"`.

The password is never a `.form` property. `ConnectionPart` reads it in
`Form_Open` from `Keyring` or the environment, the way `SmtpClientPart` does.

### The connection's words

`Query(sql, params)`, `Each(sql, params, fn)`, `Execute(sql, params)`,
`Script(sql)`, `Transaction(fn)`, `Columns(table)`, `Tables`, `Dialect`,
`Close` and `Open`; read-only `Host`, `Port`, `Database`, `User` and
`ServerVersion`. No `Path`: a database over a socket has none.

- `Query` answers rows for a `SELECT` and for `INSERT … RETURNING`; a command
  with no rows answers `[]`.
- `Execute` answers `{ Changes }`. There is no `LastId`: PostgreSQL has no such
  thing. `Dialect.NewKey` says `"Returning"`, and `Table.Insert` asks with a
  `RETURNING` clause.
- `Script` is libpq's multi-statement string: no parameters, and one failing
  statement aborts the rest and throws.
- `Transaction(fn)` nests through `SAVEPOINT`, exactly as sqlite's does. A
  throw rolls back and is rethrown; a commit that fails is an error.

### `Dialect` grows the facts `Table` and `Model` need

The current three facts are not enough for a second engine. Add:

```js
{
  Placeholder: "$%d", Quote: "\"", NewKey: "Returning", Decimal: "Exact",
  Types: { text: "TEXT", enum: "TEXT", date: "DATE", time: "TIME",
           datetime: "TIMESTAMP(0)", decimal: "NUMERIC", int: "BIGINT",
           bool: "BOOLEAN", number: "DOUBLE PRECISION", bytes: "BYTEA" },
  AutoKey: "GENERATED BY DEFAULT AS IDENTITY",
}
```

sqlite adds `Decimal: "Text"`, its own `Types` and `AutoKey: ""`.

- `Table.#fit` reads `Decimal`: sqlite keeps its TEXT-affinity rule, and
  PostgreSQL refuses a decimal field over a `double precision` column instead
  of losing the cent in silence.
- `Model.Ensure` builds its `CREATE TABLE` from `Dialect.Types` and
  `Dialect.AutoKey`, so a form's `Model` creates a PostgreSQL table. `IF NOT
  EXISTS`, and no migration, the same as sqlite.
- `Table.Insert`, when `NewKey` is `"Returning"`, appends
  `RETURNING <quoted key>` and asks through `Query`, since the row is the
  answer; `LastId` stays sqlite's.
- `Table.#fit`'s "there is no table called …" message learns the connection's
  `Database` name, for a connection with no `Path`.

### Types, in and out

| PostgreSQL | JavaScript |
|---|---|
| `boolean` | boolean |
| `int2`, `int4`, `int8` | number, `JS_NewInt64` for int8 |
| `float4`, `float8` | number |
| `numeric`, `decimal` | the server's text, exactly |
| `text`, `varchar`, `char`, `uuid`, `json`, `jsonb`, `interval` | string |
| `date` | `YYYY-MM-DD` |
| `time` | `HH:MM:SS` |
| `timetz` | string, zone included (a `time` field refuses it) |
| `timestamp` | `YYYY-MM-DDTHH:MM:SS`, no fraction |
| `timestamptz` | the same with `Z` or `±HH:MM` |
| `bytea` | `Bytes` |
| `NULL` | null |

`DateStyle=ISO, YMD`, `bytea_output=hex` and `client_encoding=UTF8` are set at
connect. `Record`'s `datetime` is whole seconds, so `Model.Ensure` declares
`TIMESTAMP(0)`; a column with microseconds read into a `datetime` throws with
the value, and a `text` field reads it. Intervals and arrays have no record kind
and are text.

Parameters are text format: a `Bytes` as `\x` hex with type OID 17, a boolean
as `true`/`false`, a number through `g_ascii_dtostr` (never the locale's
comma), a `Decimal` as its own text, NULL as NULL. Binary format is rejected
for this version.

### Errors

An `Error` with `message` (the server's primary message, never the generated
statement), `Code` (the five-character SQLSTATE), and `Detail`/`Hint` when the
server sent them. A connection failure has no code. Server `NOTICE`s are
dropped: a notice is not an answer.

### `Each` and `Cursor`

`PQsendQueryParams`, `PQsetSingleRowMode`, then `PQgetResult` until the end:
`PGRES_SINGLE_TUPLE` is one row, and `Cursor` works unchanged. One active
statement per connection; `Close` while `Each` is reading is refused, as
sqlite's is. A callback that returns `false` drains the remaining results and
answers how many rows were handed over.

### The `Connection` part

`ConnectionPart` grows `Driver` (`"Sqlite"` when absent, so every old `.form`
still loads), `Host`, `Port`, `Database`, `User` and `Tls`; `Path` stays for
sqlite. `Password` is **not** in `static Properties`: it is set in `Form_Open`,
the `SmtpClientPart` pattern. A form that gives both `Path` and `Host` is
refused rather than choosing one, and a `Model` over the connection creates its
table through `Dialect.Types`.

`Database.Postgres` is registered in `bta_task.c` too, so a `Task` opens its own
connection. A libpq connection belongs to the thread that opened it; the main
connection cannot be used inside a task.

### Blocking, and what is not async

`Query`, `Execute`, `Each`, `Script` and `Transaction` block, exactly as
sqlite's do. A slow query freezes the window; long work belongs in a `Task`
with its own connection. An event-loop/libpq-async API would either make
`Table`'s synchronous half impossible or duplicate the whole data layer, and
that is L2's question ([`async-plan.md`](async-plan.md)), not this plan.
`Timeout` bounds the connect and `StatementTimeout` bounds the server's work;
cancellation and `PQcancel` are later.

## Stages

0. **The build and the refusal.** CMake finds `libpq` with `pkg-config`
   (`BTA_HAVE_LIBPQ`), `bta_postgres.c` has its `#else` opener, and
   `bta_postgres_init` is called from `bta_runtime.c` and `bta_task.c`.
   `Database.Postgres` exists and says which package is missing. **Not started.**
1. **Connection, `Query`, `Execute`, `Script`, `Dialect`, types and errors.**
   A console project connects, creates a table, round-trips every type and
   reads a SQLSTATE. **Not started.**
2. **`Each`/`Cursor`** with single-row mode. **Not started.**
3. **`Columns`/`Tables`, `Table` and `Model`**: the extra `Dialect` facts,
   `Returning`, the decimal check, `Model.Ensure`, and a `Table` round trip
   over an existing schema. **Not started.**
4. **The `Connection` part**: `Driver`, credentials, `.form` round trip and a
   `Model` from a form. **Not started.**
5. **Tests, CI and documentation**: `tests/postgres.sh`, `tests/postgres`, the
   guarded widgets assertion, the `postgres` and `no-postgres` CI jobs,
   `api.json`, `bintana-docs`, `bintana-llm` and `docs/installing.md`.
   **Not started.**

## How it will be tested

`tests/postgres.sh` is the suite's optional-server door, the way
`tests/media.sh` is GStreamer's:

- it starts `postgres:16` in Docker on `127.0.0.1:55432` with a throwaway
  password, waits through `docker exec … pg_isready`, and removes the container
  in a `trap`;
- it runs `tests/postgres`, a console project, with the connection in the
  environment;
- a `Postgres` assertion in `tests/widgets` runs for real only when `BINTANA_PG`
  is set, and reports one skipped assertion otherwise, so `./tests/run.sh`
  stays serverless;
- it says which image it needs rather than pulling one silently.

What the tests prove: a refused connection and a wrong password; a SQLSTATE and
its `Code`; every type, NULL, a numeric with two places exactly; `bytea` with a
NUL; a `timestamptz` with an offset; `RETURNING` a generated key; `Columns` and
`Tables` in `search_path`; a transaction that rolls back and one that nests;
`Each` over more rows than `Window`; `Cursor.Count`/`Row`; `Table` CRUD, a key
that is not an integer, and a decimal over `double precision` refused;
`Model.Ensure`; a `.form` with a `Connection` and a `Model`; `Close` twice and a
query after it.

CI gets a `postgres` job with `libpq-dev` and the container, and a
`no-postgres` job whose only assertion is the refusal sentence — the shape
`no-libxml` and `no-gst` already have.

## What is deliberately not here

- **MySQL and a generic `Database.Open(uri)`.** A URI would hide the dialect
  differences the engine names make visible. ODBC is no longer here: it is
  [`odbc-plan.md`](odbc-plan.md), built first.
- **Connection pooling.** One `PGconn` per object; a pool belongs to the
  application or a later plan.
- **Async queries.** See above: `Task` is the road.
- **`LISTEN`/`NOTIFY`, `COPY`, server-side cursors and a prepared-statement
  cache.** No caller yet; `Each`'s single-row mode is the cursor.
- **Binary result and parameter format.** Text is exact for numeric,
  debuggable, and one codec; binary is a later optimisation.
- **Arrays, ranges, composite types, `hstore`.** No record kind; text.
- **Automatic migration.** `Model.Ensure` creates, as sqlite's does; a
  migration is a program.
- **Cancellation and `PQcancel`.** Later, with the `Cancellable` question.
- **A password in a `.form`.** Never.

## What was rejected, and why

- **A `Connection` base with `Open`.** Opening belongs to the driver;
  `bta_database.c` already says why.
- **A generic `Database.Open` with a scheme.** It would make one database's
  limitation look like the runtime's, which is the argument for the names
  `Sqlite` and `Postgres`.
- **An asynchronous `Query` with events.** `Table` is synchronous; a second
  data layer is worse than a `Task`.
- **A separate `PostgresConnection` part.** The form already names one
  `Connection`; a `Driver` property is one property and old forms default to
  sqlite, while a second class would duplicate the table and model wiring.
- **libpq's binary format for the first version.** Text is what `Record`
  already speaks, and numeric stays exact as text.
- **`locale_key`/`COLLATE LOCALE` on PostgreSQL.** Those are sqlite's
  functions. A server database has the schema's collation, and that is the
  order an index can use; the plan documents the difference instead of
  pretending the desktop's order travels.

## Prior art

Gambas `gb.db`, Lazarus Zeos and SQLdb, Qt's `QSqlDatabase` with its PostgreSQL
plugin, .NET's Npgsql and ADO.NET, FireDAC and ODBC. The common shape is one
connection object and a dialect: a driver per engine, and no attempt to make
the engines the same.

## Where it stands

Not started, and after [`odbc-plan.md`](odbc-plan.md). Its stage 0 needs `libpq`'s development package
(`libpq-devel` on Fedora, `libpq-dev` on Debian/Ubuntu) and a server for the
tests; `postgres:16` is the image `tests/postgres.sh` will ask for. A build
without `libpq` compiles, and `Database.Postgres` says what is missing.
