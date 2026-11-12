# Migrations: a schema that can change after the first release

**Status: design, not built (2026-11-12).** The first release of a Bintana
application can create its tables from its records; the second release has to
change them without losing the customer's rows. This plan argues the road:
**explicit, versioned migrations in JavaScript, a state table, a checksum, a
baseline for the database that already exists, and no automatic diff.**

## What the application needed

An invoicing application is installed at a company. The first release has
`invoices` and `lines`. Six months later the next release adds `due_date`, a
`status` and an index on the customer; the customer's database already holds
twelve thousand invoices. `Model.Ensure` creates a missing table and does
nothing to one that exists, so today that release either starts from an empty
database or asks the customer to run SQL by hand.

The code the author wished to write:

```js
// migrations/0002_invoice_due_date.js
Database.Migrate(project);          // or the IDE's Migrate command
```

and the migration itself, in the vocabulary of the data layer:

```js
export function up(db) {
    db.Schema("invoices").AddColumn("due_date", Field.Date());
    db.Execute("UPDATE invoices SET due_date = issued_at WHERE due_date IS NULL");
}
```

## What exists today

- `Record`/`Field` declare a shape; `Record.Shape` is its data form.
- `Table` and `Model` read and write rows; `Transaction` nests through
  `SAVEPOINT`; `Cursor` reads on demand.
- `Model.Ensure` asks `Tables`, and if the table is absent writes
  `CREATE TABLE IF NOT EXISTS` from the record's shape, using `Dialect.Types`,
  `Dialect.AutoKey` and `Dialect.Decimal`. It **creates; it does not migrate**.
- `Dialect` already carries the facts a second engine needs: `Placeholder`,
  `Quote`, `NewKey`, `KeyQuery`, `Page`, `Decimal`, `Types`, `AutoKey`.
- `Database.Sqlite`, `Database.Odbc` and the planned `Database.Postgres` all
  answer `Query`, `Execute`, `Script`, `Transaction`, `Columns`, `Tables` and
  `Dialect`.

## Why not diff the record against the table

It is the tempting road: compare `Record.Shape` with `Columns`, emit `ALTER`,
done. It fails on the cases that matter:

- **A rename and a drop-plus-add are the same diff.** `customer_name` becoming
  `customer` is either a rename (data kept) or a new empty column (data lost);
  only a person knows which.
- **A type change is not local.** `TEXT` to `INTEGER` needs a backfill, a
  failure path and a decision about the rows that do not parse.
- **A default is not the backfill.** `DEFAULT 0` is right for new rows and
  wrong for the twelve thousand old ones.
- **Every engine's DDL differs**, and SQLite's is the most limited; a generic
  emitter would be a second database abstraction to test.
- **It is destructive by construction.** The one road that cannot lose data is
  the one where a person wrote down what should happen.

Auto-creation from the shape stays for a fresh development database; it is not
the production road.

## The shape of a migration

**One file per change**, under `migrations/` in the project, named
`NNNN_<name>.js` (`0001_initial.js`, `0002_invoice_due_date.js`). The number is
the order and the identity; it is never reused, never renumbered, and a file
that has been applied is never edited.

The file is JavaScript, not SQL, and it is not in `sources`: it is a project
resource like a `.record` or a `.conn`, read and compiled when `Migrate` runs.
Why JavaScript:

- **One file per change across engines.** The `Schema` helper knows
  `Dialect.Types`/`Quote`/`AutoKey`; a SQL file would need one per engine or a
  dialect tag in every statement.
- **Data migrations are code**, not a sequence of statements with no types.
- **The raw escape hatch is one line**: `db.Execute("…")` for what the helper
  cannot express.

The alternative -- SQL files per dialect -- is more familiar to a DBA and easier
to review in a migration tool; it is rejected for v1 because it duplicates the
type map the data layer already has and makes the common case
(`AddColumn`) three files. A project that wants SQL can still call
`db.Execute` in its JS migration.

### The state table

```sql
CREATE TABLE _bintana_migrations (
    id         TEXT PRIMARY KEY,
    checksum   TEXT NOT NULL,
    applied_at TEXT NOT NULL
);
```

- `id` is the file's `NNNN_name`, without `.js`.
- `checksum` is SHA-256 of the file's bytes, through `Hash` (already built).
- `applied_at` is an ISO instant, in the connection's zone.

The table is the only thing `Migrate` writes outside a migration. It is
`_bintana_migrations` rather than a name a user's record might take; a record
whose table has that name is refused by `Model.Ensure`.

### The algorithm

1. Read the applied rows. If a row's id is not in the directory, **refuse**:
   a migration was removed after release.
2. Sort the files by number. Duplicate numbers, a gap that is not a deliberately
   empty migration, or a name outside `NNNN_<name>` is refused by `check`.
3. For each pending file, in order:
   - compile it; the top-level `up(db)` is the migration;
   - hash the bytes; if the id was applied with another checksum, **refuse**
     (somebody edited a released migration);
   - run `up(db)` in a transaction where the engine has transactional DDL;
   - insert `{id, checksum, applied_at}` in the same transaction;
   - commit. On a refusal, roll back and stop with the file and the engine's
     sentence.
4. A second run with nothing pending is a no-op: no writes, no `up`.

A migration is a **program**, not a list of statements: it may query, branch on
`db.Dialect`, and use `Transaction` itself for a data step. What it may not do is
change the state table.

### Baseline: the database that already exists

A customer's database was created by `Model.Ensure` and has tables but no
`_bintana_migrations`. Applying `0001_initial` again would fail, and silently
marking it applied would hide a shape that may not match.

`Migrate` therefore refuses that state with a sentence, and offers an explicit
baseline:

```js
Database.Migrate(project, { Baseline: true });   // 0001 already there
```

A baseline writes the checksum(s) of the migration(s) the current schema is
taken to represent, without running them, and then applies the rest. It is a
deliberate act, named in the call and in the log; it is never inferred from
"I did not see the state table".

For a **fresh** database `Baseline` is not used: `0001_initial` runs and creates
the tables, and `Model.Ensure` is not the road for that project any more.

### `Model.Ensure` after this

- No `migrations/` and no `migrations` key in `project.btp`: `Ensure` behaves
  exactly as today, so prototypes and examples do not change.
- With migrations declared: `Ensure` **refuses** to create or alter; the
  migrations own the schema. The refusal names the project and says to run
  `Migrate`, rather than letting a missing table fail later.
- A `Connection` part gets `Migrate: false` by default. Migration is an explicit
  act at `Form_Open` or in a `main`, never a side effect of opening a
  connection: a failed migration must stop the program, not hide inside it.

### Down, and why it is not the promise

Forward-only is the production rule: `up` is required, `down` is optional and
used by a developer on a scratch database. A `Rollback` without `down` refuses;
a `Rollback` with one only removes the last applied row after `down` succeeds.
The product does not promise a downgrade: a release that dropped a column
cannot restore its data. A backup (or, for SQLite, a copy of the file before
`Migrate`) is the real answer, and the plan says so.

### Dialects and the edges

- **SQLite**: DDL is transactional; `ADD COLUMN`, `RENAME COLUMN` and (from
  3.35) `DROP COLUMN` are available; a table rebuild is raw `Execute`.
- **PostgreSQL**: transactional DDL; `NUMERIC`, identity keys and
  `timestamptz` are the exact types `Dialect` already describes.
- **MySQL/ODBC**: DDL may implicitly commit, so a migration that fails halfway
  cannot roll back as a whole. The state row is written only after success; the
  migration is expected to be idempotent or split into small steps, and the
  plan records the difference rather than promising a rollback the engine does
  not have.
- **A Flatpak** sees no host ODBC driver; the migration tool has to run where
  the driver is, which is the same constraint `Database.Odbc` already has.

### The `Schema` helper, in stages

The first version is deliberately small:

| operation | v1 | later |
|---|---|---|
| `CreateTable` | yes | |
| `DropTable` | yes, explicit and logged | |
| `AddColumn` | yes | |
| `CreateIndex` / `DropIndex` | yes | |
| `RenameColumn` / `RenameTable` | raw `Execute` | yes, once each engine is tested |
| `DropColumn` | raw `Execute` | yes, with SQLite's rebuild |
| foreign keys, constraints, table rebuild | raw `Execute` | a builder if a caller needs it |

`Schema` uses the same `Dialect` facts `Model.Ensure` uses, so a column added by
a migration and a table created by `Ensure` cannot disagree about `TEXT` versus
`NUMERIC`.

### Where it runs

- **Runtime**: `Database.Migrate(project, [options])`, a blocking call like
  `Query`; long migrations belong in a `Task` with the same connection
  discipline? No -- a migration holds one connection and a transaction, and a
  worker thread with its own connection is the only safe place for a long one.
  The first version blocks and says so.
- **CLI**: a `tools/migrate` console project (no GTK) that reads
  `project.btp`, resolves the connection and applies; the same code as the
  runtime call.
- **IDE**: a Migrations category in the tree, *New migration* (next number,
  name), *Plan* (the pending list and the checksums) and *Apply*. The IDE never
  applies on open.

### Tests

- **SQLite, fresh**: `0001_initial` and `0002` create and alter; the rows written
  between them survive; a second run is a no-op.
- **Upgrade from v1**: a database with the old shape gets the new column, the
  backfill and the index; values are checked, not just the schema.
- **Refusals**: an applied migration edited, an id missing from the directory, a
  duplicate number, a malformed name, a file that throws. Each leaves the state
  table and the data as they were (where the engine can roll back).
- **Baseline**: an `Ensure`-created database refuses without `Baseline`, accepts
  with it, and the next migration applies.
- **Ensure**: a project with migrations refuses to create; a project without
  them is unchanged.
- **Postgres and ODBC**: the same migration through `tests/odbc.sh` and the
  planned `tests/postgres.sh`; MySQL's implicit commit is asserted as the
  documented difference, not as a rollback.
- **The checker**: `bintana check` reports a bad name, a duplicate id and a gap,
  without a database.
- **The IDE**: New migration writes the next number; Plan lists only pending;
  Apply works against a scratch database; Cancel writes nothing.

### Prior art

- **Flyway** and **Liquibase**: a version table, ordered migrations, a checksum,
  a baseline command.
- **Rails** and **Django**: one file per change, generated, applied in order;
  Django's `makemigrations` is the auto-diff this plan deliberately does not
  adopt for the destructive half.
- **EF Core**: model diff plus explicit migrations, which is the closest shape
  to a RAD tool; the lesson is that the explicit file is what a person reviews.

### Open questions for the owner

1. **JavaScript migrations or SQL files?** This plan recommends JavaScript with
   a `Schema` helper and `Execute` as the escape hatch. A SQL-first project
   would reverse that.
2. **Forward-only or `down` as a promise?** This plan recommends forward-only,
   with `down` as a development convenience.
3. **Baseline syntax**: `Migrate(project, { Baseline: true })` versus a separate
   `Baseline` verb. The first is one call; the second is harder to do by
   accident.
4. **Where the version table lives** if a project uses more than one connection:
   one table per database, named the same; `Migrate` takes the connection.
5. **Does `migrations/` become a project category in the tree**, with the
   designer's file list and the IDE's New migration dialog, or is it a plain
   folder until the next release?

### Stages

0. **Spike**: read one JS migration, compile it, run it against SQLite, write the
   state table, hash the file. No public API.
1. **Runtime** `Database.Migrate`, state, checksum, baseline, refusals; SQLite
   and psqlODBC tests.
2. **`Schema` v1**, sharing `Dialect` with `Model.Ensure`; `Ensure` refusal when
   migrations exist.
3. **CLI and IDE**: `tools/migrate`, the Migrations category, Plan/Apply/New.
4. **Postgres** once its driver is built; the same migration through libpq.

### What not to do

- A destructive auto-diff, or a `Rename` guessed from a column name.
- Applying on `Connection.Open`, or on every application start without a
  sentence.
- Editing a migration that has been applied; the checksum is there to refuse it.
- A silent baseline: "the state table was missing" is not consent.
- Promising a downgrade the engine cannot perform.
- A `Schema` builder for every DDL in v1; raw `Execute` is honest until each
  engine's edge is tested.
