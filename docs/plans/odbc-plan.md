# ODBC: `Database.Odbc`, the driver that reaches the servers

**Status: stages 0 to 5 built, the IDE included (2026-11-11); stage 6, Windows natively, is left -- its list is below. Comes before
[`postgres-plan.md`](postgres-plan.md).** Designed for Linux, Windows and macOS
from the first line: the API is the same on all three, and what differs (the
driver manager, the text encoding, where the drivers live) is decided here,
not discovered on the second platform.

## Why ODBC before PostgreSQL

The audit's R1 ([`audit-2026-10.md`](../audit-2026-10.md)) is that a
client-server business application cannot be written: `Database` publishes
`Sqlite` alone. The PostgreSQL plan answers it for one server. ODBC answers it
for whatever server the office already runs — and since the runtime builds on
Windows ([`portability-plan.md`](portability-plan.md)), that is as likely to be
SQL Server, MySQL/MariaDB, Firebird or an Access file as PostgreSQL.

- **Windows carries the driver manager** (`odbc32.dll`), and MinGW-w64 carries
  `sql.h`/`sqlext.h`: there the driver costs nothing to link.
- **One C API on three platforms**: Windows' manager, and unixODBC on Linux and
  on macOS.
- **The catalogue is portable**: `SQLTables`, `SQLColumns` and
  `SQLPrimaryKeys` answer `Tables` and `Columns` with no SQL per engine
  (measured below), and `SQLGetDiagRec` hands over the SQLSTATE the PostgreSQL
  plan wanted as `Code`.
- **A parameter is always `?`**; the driver translates it.

What it costs, and what keeps `Database.Postgres` worth writing afterwards:
the person at the machine installs and configures a driver per engine, a
Flatpak sees none of the host's drivers, and a driver is only as good as its
author (measured below: sqliteodbc reports every error as `HY000`, and
psqlODBC drops a `timestamptz`'s offset).

## What was measured

On Fedora 44: unixODBC 2.3.14, sqliteodbc 0.99991 (`SQLITE3`), psqlODBC
16.00 (`psqlodbcw.so`) against `postgres:16` in Docker. Probes in C, the
same calls the driver will make.

| question | answer |
|---|---|
| wide API (`SQLExecDirectW`) with sqliteodbc | **corrupts text**: `'Año ñandú €'` in the SQL is stored as `41 F1 6F 20 F1 …` — ISO 8859-1, `€` cut to `AC`. Fedora's sqliteodbc exports no `…W` function, so unixODBC converts down, and it does so to Latin-1 |
| does unixODBC 2.3.14 honour `IconvEncoding`? | no — not in `odbcinst.ini`, not in a DSN, not in the connection string; the string is not in `libodbc.so.2` |
| narrow API with UTF-8 | **exact** with both drivers: `length(s)` 11, the bytes `41 C3 B1 6F …`, read back identical; a bound `SQL_C_CHAR` parameter `"Pingüino €"` round-trips |
| wide API with `SQL_C_WCHAR` *parameters* on sqliteodbc | exact — only the statement text is converted down |
| `SQL_DBMS_NAME` | `"SQLite"`, `"PostgreSQL"` |
| `SQL_IDENTIFIER_QUOTE_CHAR` | `"` for both |
| `INSERT … RETURNING id` | psqlODBC: one row, `id` = 1. sqliteodbc: **`SQL_NO_DATA` and no columns**, although its sqlite (3.51) knows `RETURNING` |
| `NUMERIC(10,2)` | psqlODBC: `SQL_NUMERIC`, scale 2, `"12.30"`; `99999999.99 + 0.01` = `"100000000.00"` exact. sqliteodbc: `SQL_DOUBLE`, `"12.3"` (sqlite has no exact decimal) |
| `boolean` | psqlODBC: **`SQL_VARCHAR`** by default (`BoolsAsChar=1`), `SQL_BIT` with `BoolsAsChar=0`; `"1"` either way. sqliteodbc: `SQL_BIT` |
| `timestamptz` | psqlODBC: `SQL_TYPE_TIMESTAMP`, converted to the session's zone, **offset dropped** (`10:20:30-03` read as `13:20:30` in a UTC session) |
| `bytea` / `BLOB` | `SQL_LONGVARBINARY`, size 0 / `SQL_BINARY` |
| `int8` | `SQL_BIGINT`, `9007199254740993` exact as text |
| an error | psqlODBC: the SQLSTATE (`42703`, `22012`, `25P01`) and the server's message with `;\nError while executing the query` appended. sqliteodbc: `HY000` for everything, the message prefixed `[SQLite]` |
| a wrong password | `SQLDriverConnect` fails with `08001` and the server's sentence |
| `SAVEPOINT` with autocommit on | PostgreSQL refuses (`25P01`); a transaction is autocommit off and `SQLEndTran` |
| `SQLColumns` / `SQLPrimaryKeys` / `SQLTables` | both drivers: name, ODBC type, `TYPE_NAME` (`numeric`, `NUMERIC(10,2)`), nullability, the key; PostgreSQL's tables come with schema `public`, sqlite's with none |
| `ODBCSYSINI=<dir>` | honoured: a DSN defined only in a scratch `odbc.ini` connects, so the tests need no file in `/etc` |

## The decisions the platforms force

### Text: UTF-8 on unixODBC, UTF-16 on Windows

The measurement settles it for unixODBC: the wide API is only as good as the
driver's own wide entries, and a driver without them gets Latin-1. Every Unix
driver measured speaks UTF-8 through the narrow API. On Windows it is the
reverse: the narrow API is the ANSI code page, and only the wide one carries
an `ñ` everywhere.

So `bta_odbc.c` has one text layer — `odbc_text_in(JSContext*, JSValueConst)`
and `odbc_text_out(...)` with a `BtaOdbcChar` type — that is `SQLCHAR` and UTF-8
under unixODBC and `SQLWCHAR` and `g_utf8_to_utf16` under `G_OS_WIN32`. Each
`SQL…` call goes through a macro that picks `SQLExecDirect` or
`SQLExecDirectW`. Nothing else in the file knows which platform it is on.
**iODBC is not targeted**: its `SQLWCHAR` is a 4-byte `wchar_t`, and the drivers
a Mac user installs (Microsoft's `msodbcsql18`, Homebrew's `psqlodbc`) are built
against unixODBC.

### The build

| platform | driver manager | found by | development package |
|---|---|---|---|
| Linux | unixODBC | `pkg_check_modules(ODBC odbc)` | `unixODBC-devel` (Fedora), `unixodbc-dev` (Debian/Ubuntu) |
| macOS | unixODBC | `pkg_check_modules(ODBC odbc)` | `brew install unixodbc` |
| Windows | `odbc32.dll` | `if(WIN32)`, link `odbc32` | none: MinGW-w64 carries the headers |

`BTA_HAVE_ODBC`, the sqlite mould: without it `Database.Odbc` exists and says
which package is missing. On Windows it is always on. `docs/installing.md`,
`macos-plan.md`'s package list and `portability-plan.md`'s get their line.

### Where the drivers live

The runtime links the manager, never a driver. A driver is the machine's:
`odbcinst.ini` on Unix, the registry on Windows. **A Flatpak sees neither** —
the sandbox has its own `/etc` and no host libraries — so a packaged
application that needs ODBC carries unixODBC and the driver it needs as
modules of its manifest, which is `lib/package`'s question, not the runtime's.
The GNOME runtime does not ship unixODBC; that line goes in
[`flatpak-plan.md`](flatpak-plan.md) and the packaging docs, not a workaround.

## The shape

### `Database.Odbc(connection, [options])`

```js
const db = Database.Odbc("Driver={ODBC Driver 18 for SQL Server};" +
                         "Server=erp.internal;Database=Ventas;Encrypt=yes",
                         { User: "facturacion",
                           Password: Environment.Get("ERP_DB_PASSWORD"),
                           Timeout: 10000 });
const db2 = Database.Odbc("DSN=Ventas");     // configured by the administrator
```

`connection` is an ODBC connection string, passed as written: a `DSN=` or a
`Driver={…};…`. It is the driver's language, not ours, and the runtime does not
parse or validate its keys. `options` are the ones every driver shares:

| option | what it does |
|---|---|
| `User`, `Password` | appended as `UID=`/`PWD=`; braced, with `}` doubled, **only when the value needs it** (a `;`, a brace, a space at either end), so a password with `;` is one value. Measured: psqlODBC takes the braces off `PWD` but not off `UID`, where `{postgres}` was the user name, literally -- bracing every value broke the ordinary case. Given both here and in the string, refused rather than choosing one |
| `Timeout` | `SQL_ATTR_LOGIN_TIMEOUT`, milliseconds rounded up to seconds; 10000 unless told |
| `StatementTimeout` | `SQL_ATTR_QUERY_TIMEOUT` on every statement; absent means none. **Stage 1**: until there are statements it is not an option, and refused like any unknown key |

`SQLDriverConnect` with `SQL_DRIVER_NOPROMPT`, always: a driver never opens a
dialog of its own. It opens immediately, as `Database.Sqlite` does, and a
failure throws with the driver's message and `Code`. The completed connection
string is **not** published: it carries the password.

The password is never a `.form` property, the same rule as `SmtpClientPart`
and the PostgreSQL plan.

### The connection's words

The ones `Table`, `Cursor` and `Model` already ask for: `Query`, `Each`,
`Execute`, `Script`, `Transaction`, `Columns`, `Tables`, `Dialect`, `Close`,
`Open`. Read-only on top: `Dbms` (`SQL_DBMS_NAME`), `DbmsVersion`, `Driver`
(`SQL_DRIVER_NAME`). No `Path`.

- `Query` answers rows (`SQLNumResultCols` > 0) or `[]`.
- `Execute` answers `{ Changes }` from `SQLRowCount`, and `LastId` where the
  dialect has a way to ask (below).
- `Script` is `SQLExecDirect` over the whole string, then `SQLMoreResults`
  until the end. Whether a driver takes several statements is the driver's
  answer; a refusal is its error.
- `Transaction(fn)` turns autocommit off, runs `fn`, and `SQLEndTran`s commit
  or rollback; nested, it is a savepoint in the engine's spelling
  (`SAVEPOINT`/`RELEASE`/`ROLLBACK TO`, or `SAVE TRANSACTION` on SQL Server).
  An engine without savepoints refuses the nested call.
- One statement handle active at a time, as sqlite; `Close` while `Each` reads
  is refused.

### `Dialect`, from `SQL_DBMS_NAME`

ODBC makes the connection alike, not the SQL. The driver reads `SQL_DBMS_NAME`
once at connect and answers the facts for the engines it knows:

| `SQL_DBMS_NAME` | `NewKey` | how | nested transaction |
|---|---|---|---|
| `PostgreSQL` | `Returning` | `INSERT … RETURNING k` (measured) | `SAVEPOINT` |
| `Microsoft SQL Server` | `Output` | `INSERT … OUTPUT INSERTED.k VALUES …` | `SAVE TRANSACTION` |
| `MySQL`, `MariaDB` | `LastId` | `SELECT LAST_INSERT_ID()` after the insert | `SAVEPOINT` |
| `SQLite` | `LastId` | `SELECT last_insert_rowid()` (sqliteodbc drops `RETURNING`'s rows, measured) | `SAVEPOINT` |
| anything else | `None` | — | refused |

`Quote` comes from `SQL_IDENTIFIER_QUOTE_CHAR` (MySQL's backtick included),
`Placeholder` is `?`. The SQL Server and MySQL spellings are
**to be measured** before they are written: the names come from the drivers'
documentation, not from a probe.

`Table.Insert` learns `Returning` and `Output` here — the PostgreSQL plan needs
the first anyway — and `NewKey: "None"` is the refusal `rad.js` already words
(`Table.Insert`, "give it its key before inserting"). The rest of the
PostgreSQL plan's `Dialect` growth (`Types`, `AutoKey`, `Decimal`) is designed
**here, for N engines**, and `Model.Ensure` refuses an engine whose `Types` the
driver does not know rather than guessing a `CREATE TABLE`.

### Types, out

By the ODBC type `SQLDescribeCol` reports, the same for every driver:

| ODBC | JavaScript | read as |
|---|---|---|
| `SQL_BIT` | boolean | `SQL_C_BIT` |
| `SQL_TINYINT`, `SMALLINT`, `INTEGER` | number | `SQL_C_SBIGINT` |
| `SQL_BIGINT` | number, Int64 as the sqlite driver gives it (a double past 2^53) | `SQL_C_SBIGINT` |
| `SQL_REAL`, `FLOAT`, `DOUBLE` | number | `SQL_C_DOUBLE` |
| `SQL_NUMERIC`, `SQL_DECIMAL` | the driver's text, exactly | `SQL_C_CHAR` |
| `SQL_CHAR`, `VARCHAR`, `LONGVARCHAR` and the `W` ones, `SQL_GUID` | string | text, in parts |
| `SQL_TYPE_DATE` | `YYYY-MM-DD` | `SQL_DATE_STRUCT` |
| `SQL_TYPE_TIME` | `HH:MM:SS` | `SQL_TIME_STRUCT` |
| `SQL_TYPE_TIMESTAMP` | `YYYY-MM-DDTHH:MM:SS`, and `.f` when there is a fraction (trailing zeros dropped) -- kept visible so a `datetime` field refuses it, as in the PostgreSQL plan | `SQL_TIMESTAMP_STRUCT` |
| `SQL_BINARY`, `VARBINARY`, `LONGVARBINARY` | `Bytes` | `SQL_C_BINARY`, in parts |
| `SQL_NULL_DATA` | null | |

Long values are read with `SQLGetData` in parts until it stops answering
`01004`. psqlODBC's boolean as `SQL_VARCHAR` is the driver's choice; the
documentation says `BoolsAsChar=0`, and the test proves both answers. A
`timestamptz` through psqlODBC has no offset: that is the driver, and the
reason `Database.Postgres` is still worth writing.

Parameters, in: `SQLBindParameter` with text (`SQL_C_CHAR` or `SQL_C_WCHAR` by
platform), a number through `g_ascii_dtostr`, a `Decimal` as its text over
`SQL_NUMERIC`, a boolean as `SQL_BIT`, a `Bytes` as `SQL_C_BINARY`, `null` as
`SQL_NULL_DATA`. Converted entirely before the first bind, so a refusal leaves
the statement unexecuted.

### Errors

An `Error` with `message` (the first diagnostic's text), `Code` (its SQLSTATE)
and `Native` (the engine's number); further diagnostic records go in
`Details`. The runtime does not trim the driver's text — psqlODBC's trailing
"Error while executing the query" is psqlODBC's — and never quotes the SQL it
was given. A code is as good as the driver: sqliteodbc's is always `HY000`.

### Threads

Registered in `bta_task.c` beside sqlite, so a `Task` opens its own
connection. One environment handle per connection (no shared global state to
lock); a connection belongs to the thread that opened it, as sqlite's does.

### Blocking

Like sqlite and the PostgreSQL plan: `Query` and the rest block, long work is a
`Task`, `StatementTimeout` bounds the server. ODBC's asynchronous mode
(`SQL_ATTR_ASYNC_ENABLE`) is supported unevenly by drivers and would need the
event loop the async plan defers.

### The `Connection` part

`Driver: "Odbc"` with `ConnectionString` beside the PostgreSQL plan's
`Driver: "Postgres"`, `Path` staying sqlite's. `User` is a property, `Password`
is set in `Form_Open`. A form that gives two drivers' properties is refused.

## Stages

0. **The build and the refusal, on three platforms.** CMake as above,
   `bta_odbc.c` with the text layer and its `#else` opener, registered in
   `bta_runtime.c` and `bta_task.c`. The `windows` CI job compiles it (always
   on there); the `no-libxml` job installs no unixODBC and asserts that CMake
   decided so, and `testDatabaseOdbc` takes its refusing branch there.
   **Built on Linux.** The Windows half is written and will first compile in
   the `windows` CI job; nobody has built it on a Windows machine yet.
1. **Connect, `Query`, `Execute`, `Script`, types and errors**, through the
   text layer, against sqliteodbc and psqlODBC. **Built**: `Database.Odbc`
   with `User`/`Password`/`Timeout`/`StatementTimeout`, diagnostics as
   `Code`/`Native`/`Details`, `Open`, `Dbms`, `DbmsVersion`, `Driver`,
   `Close`, and `Query`/`Execute`/`Script`; `tests/odbc.sh` runs 85 checks (a
   path with `ñ` and `€` through the connection string, a password with `;`
   and `}`, `08001`, `IM002`, `42703`, `22012`, every type both ways, text and
   bytes longer than one read, an exact `NUMERIC` on an es_AR desktop, a batch
   psqlODBC undoes, `StatementTimeout` stopping `pg_sleep`, a `Task`).
   **Measured on the way: psqlODBC writes a `NUMERIC` with the process's
   `LC_NUMERIC`** -- `12,30` under GTK's `setlocale` -- so the three words run
   with `uselocale` set to C numerics for the thread, and the C probe that
   never called `setlocale` could not have seen it.
2. **`Each`/`Cursor`** over `SQLFetch`. **Built**: `false` stops, a throw in
   `fn` is the caller's, `Close` inside is refused, and `fn` runs in the
   desktop's locale while the driver keeps C numerics. `Cursor` needed
   `Dialect` and is tested with stage 4.
3. **`Transaction`**: autocommit, `SQLEndTran`, savepoints by engine.
   **Built**: the value of `fn`, a throw rolled back and rethrown as it was,
   nesting through `SAVEPOINT` (`SAVE TRANSACTION` on SQL Server, not yet run),
   autocommit back on after. Measured: psqlODBC rolls back only the statement
   that failed, so an error caught inside `fn` does not lose the rest; and
   sqliteodbc refuses `SQLDisconnect` inside a transaction (`25000`) and keeps
   the connection and its write lock, so `Close` rolls back first -- the test
   writes from a second connection, since a read could not tell a rollback
   from a leak.
4. **`Columns`/`Tables` and `Dialect`**: the catalogue functions, the engine
   table, `Table.Insert` with `Returning`/`Output`, `Model.Ensure` from
   `Dialect.Types`. **Built.** `Dialect` grew, on sqlite too, to `{ Placeholder,
   Quote, NewKey, KeyQuery, Page, Decimal, Types, AutoKey }`; `NewKey` is
   `"Returning"`, `"Output"`, `"Select"` (with `KeyQuery`: sqliteodbc and MySQL
   are asked right after the insert, so `Execute` pays nothing extra) or
   `"None"`. `Cursor` pages only where `Page` is `"Limit"` and refuses
   elsewhere (SQL Server, until it is run); its subquery got the `AS bta_page`
   PostgreSQL before 16 needs. `Model.Ensure` writes `Dialect.Types`, checks
   `Tables` instead of `IF NOT EXISTS`, and refuses an engine whose `Types` is
   null (SQL Server, MySQL: not run). `Tables` lists each name once outside the
   engine's schemas; `Columns` answers `Key` as the position in the key, as
   sqlite does. Measured on the way: **`_` is a wildcard** in the catalogue
   calls (`a_b` matched `axb` on both drivers), so the name is escaped with the
   driver's character and the rows held to it; psqlODBC's `boolean` arrives as
   `"1"` by default, which `Record` refuses, so a text column whose type name
   is `bool` is read as a boolean; an unset date serializes to `""`, which
   PostgreSQL refuses (`22007`), so a typed engine binds it as NULL; and
   **`Table` wrote a `Bytes` field as base64 text** -- sqlite kept the text in
   its BLOB column and read it back, which hid it; a `BYTEA` cannot -- so a
   bytes field is now bound as `Bytes`, on sqlite too, and base64 text written
   before still reads. One test, `modelChecks`, runs on `Database.Sqlite`,
   sqliteodbc and psqlODBC alike.
5. **The `Connection` part.** **Built**: `Driver` (`"Sqlite"` unless told, so
   every old `.form` loads unchanged), `Path` for sqlite, `ConnectionString` and
   `User` for ODBC, and `Password` set in code and never serialised. A part
   that carries the other driver's properties is refused when it opens. On the
   way: `ConnectionPart.Tables()` called the connection's `Tables` getter as a
   function and had always thrown -- the test that now covers it was the first
   to call it. **And the IDE**: a `.conn` is `{ "kind": "odbc", "connection",
   "user", "password_env" }` -- the password is never in the file, only the
   name of the variable that holds it, read alike by `rowsFrom` and the IDE;
   `ConnectionForm` edits that kind, refuses a `PWD` in the string, and
   connects only on its *Connect* button; the Data view lists, browses and
   queries an ODBC connection (a select read a row at a time up to what it
   shows), and the designer's table list asks a server at most every 30 s. A
   form's ODBC part opens in the IDE only when its DSN carries the password:
   its password is set in code the IDE cannot run. `tests/ide` (`p_data_odbc`)
   names sqliteodbc by its library's path, which unixODBC accepts in
   `Driver=`, and skips that half without it. **Built.**
   **`examples/invoices`** is the stages in use: three `Model`s on an ODBC
   `Connection`, an invoice and its lines in one `Transaction`, a `Cursor` behind
   an on-demand `TableView`, exact totals; its `--selftest` passes on sqliteodbc
   and on PostgreSQL, where `Model.Ensure` wrote `bigint` identity, `date` and
   `numeric`.
6. **Windows, natively** (another session). The code is written for it;
   nothing of it has been compiled or run there. What to do, in order:
   - **Build** under MSYS2 UCRT64: `odbc32` and MinGW's `sql.h` are linked
     unconditionally (`BTA_HAVE_ODBC` is always on). The wide half of
     `bta_odbc.c` is what is new to a compiler: `BtaOdbcChar` is `SQLWCHAR`,
     `ODBC_API(f)` is `f##W`, and the lengths differ per call --
     `SQLGetInfoW`/`SQLColAttributeW` count **bytes**, `SQLDriverConnectW`,
     `SQLGetDiagRecW` and `SQLDescribeColW` count **characters**, a
     `SQL_C_WCHAR` parameter's length is bytes and its column size characters.
   - **Install a driver with no prompt** and say which: the psqlODBC MSI
     (`PostgreSQL Unicode(x64)`), Werner's sqliteodbc (`SQLite3 ODBC Driver`),
     or SQL Server's own; `Driver={…}` by name, since `ODBCSYSINI` and a
     library path are unixODBC's.
   - **Run `tests/odbc` by hand** with `BINTANA_ODBC_SQLITE` set to the
     driver's name (and `BINTANA_ODBC_PG` for a server): the text layer
     through the wide API (`ñ`, `€`, a 4-byte character, a path with them in
     `Database=`), and every type both ways.
   - **The decimal comma**: with a Spanish regional format, does psqlODBC
     answer `12,30`? The guard is written (`_configthreadlocale` plus
     `setlocale(LC_NUMERIC, "C")`, on the reasoning that an MSVC-built driver
     shares `ucrtbase.dll` and so the locale GTK set) and has never run.
   - **SQL Server**, if one is at hand: `OUTPUT INSERTED`, `SAVE
     TRANSACTION`, `Cursor` refused, `Model.Ensure` refused -- the rows of
     the engine table that come from documentation.
   - A `tests/odbc-win.sh` beside `tests/serial-win.sh`, and the `windows` CI
     job running it if a driver installs there.

## How it will be tested

`tests/odbc.sh` writes its own `odbcinst.ini`/`odbc.ini` into a temporary
directory and points `ODBCSYSINI` and `ODBCINI` at them (measured to work), so nothing in
`/etc` or `~/.odbc.ini` is read or touched:

- **sqliteodbc**, no server: always runs where the driver is installed, and
  says which package it needs when it is not. It proves the text layer
  (accents, `€`, a 4-byte character), parameters, `LastId`, `Bytes` with a NUL,
  `Each` over more rows than `Window`, transactions and savepoints, the
  catalogue.
- **psqlODBC** against `postgres:16` in Docker, as the PostgreSQL plan's
  `tests/postgres.sh` will: a real SQLSTATE, a wrong password (`08001`),
  `NUMERIC` exact, `RETURNING`, both answers for a boolean, `Table` CRUD and
  `Model.Ensure`.
- **Windows**: the same project through the wide API. Which driver the runner
  installs silently (the psqlODBC MSI, Werner's sqliteodbc, SQL Server LocalDB
  if the image has it) is **not measured yet**, and is stage 6's first job.
- A `tests/widgets` assertion that `Database.Odbc` exists and either opens a
  sqlite file or refuses with the package's name.

## What is deliberately not here

- **Parsing the connection string.** It is the driver's language.
- **Driver installation or a DSN editor.** The system's administrator
  (`odbcad32`, `odbcinst`) does that; an IDE screen for it is a later question.
- **iODBC.** See the text layer.
- **ODBC's asynchronous mode, connection pooling** (`SQL_ATTR_CONNECTION_POOLING`
  is the manager's, off), **bulk fetch and array binding**: no caller yet.
- **A dialect guessed for an unknown engine.** `None`, and the refusal.
- **Bundling drivers in the runtime's Flatpak.**

## What changes elsewhere

- [`postgres-plan.md`](postgres-plan.md) no longer rejects ODBC: it follows this
  plan, reuses its `Dialect` growth, and is justified by what ODBC does not
  give — no driver to install, a sandbox, `timestamptz`'s offset, TLS options
  named by the runtime, and later `LISTEN`/`NOTIFY`.
- `bta_database.c`'s driver interface is unchanged.

## Prior art

Qt's `QODBC` plugin, pyodbc (whose `setencoding`/`setdecoding` exist because
the narrow/wide question has no single answer), Gambas `gb.db.odbc`, Lazarus
SQLdb's `TODBCConnection`, FireDAC, .NET's `System.Data.Odbc`. None of them
makes the engines alike; each keeps per-engine knowledge for keys and identity.
