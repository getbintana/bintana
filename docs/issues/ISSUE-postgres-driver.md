# ISSUE: `Database` publishes `Sqlite` and no other engine

## What the application needed

A client-server application: the data lives in a PostgreSQL server the office
runs, and the program connects to it over the network with a host and a
database name. The concrete case was a billing application for a company of
forty people, where three of them edit the same invoices at the same time and
a file on one desktop cannot be that.

## What I wrote instead

Nothing — this part is not implemented. The application was delivered against
a local sqlite file with a one-machine user story, and the server side of the
business was left out of it rather than faked.

## The code I wish I could have written

```js
// a connection to the server, beside the one to the file:
const db = Database.Postgres("billing.internal", "invoices",
                             { User: "billing", Password: "…" });
// and it answers the same words the sqlite connection answers:
//   Query, Execute, Script, Transaction, Columns, Tables, Dialect, Close
```

## Why the existing words do not cover it

`Database` publishes one member and one: `Sqlite` (`api.json`, the `Database`
global). The extension point is there and unused by anyone else —
`bta_database_driver()` (`runtime/src/bta_database.c:71-81`) adds an opener to
the `Database` object the runtime publishes (`:106`), and the only call is
`bta_database_driver(ctx, "Sqlite", database_sqlite, 1)`
(`runtime/src/bta_sqlite.c:1254`). `Connection` itself is published as a
global (`:97-100`) and is the base a second driver would build on, and the
sqlite driver already answers everything a second one would have to:
`Dialect`, `Path`, `Open`, `Tables`, `Query`, `Execute`, `Script`,
`Transaction`, `Columns`, `Close` (`runtime/src/bta_sqlite.c:1180-1227`).
The runtime's own comments name the driver that is missing and say where it
would live — "a `Database.Postgres` is a `bta_postgres.c` beside this one"
(`runtime/src/bta_sqlite.c:50`, and `:33`), and "a `Database.Postgres` written
later changes nothing in this class" (`runtime/js/rad.js:3589`). What is not
there is the file and the library: there is no `bta_postgres.c`, and
`sqlite3` is the only database dependency the build asks for
(`CMakeLists.txt:60`).

## Prior art

Gambas `gb.db`, which drives PostgreSQL, MySQL and ODBC from one word.
Lazarus `Zeos` and `SQLdb`. Qt `QSqlDatabase` with its PostgreSQL plugin.
.NET `Npgsql` and `ADO.NET`. FireDAC. ODBC.

## How much it mattered

The application cannot be written: a client-server business application is the
niche this project is in, and this is the part of it that cannot be started.
