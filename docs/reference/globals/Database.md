# Database

A [`Record`](Record.md) over a table.

`Database.Sqlite` is a **driver** in C; `Table` is the portable half in
`rad.js`. Nothing generic here carries the name of an implementation — the day
there is another engine, the `Table` above it does not move.

```js
class Client extends Record {
    static Naming = "snake";                      // the SQL spelling, once
    static Fields = {
        Id:         Field.Int({ key: true }),     // the identity
        Name:       Field.Text({ required: true, max: 80 }),
        Balance:    Field.Decimal({ decimals: 2 }),
        PostalCode: Field.Text({ max: 8 }),       // column postal_code
    };
}

const db      = Database.Sqlite("data/sales.db");   // ":memory:" also works
const clients = db.Table("clients", Client);

const c = clients.Save(new Client({ Name: "Ana" }));  // INSERT; fills c.Id
c.Balance = "1500.50";
clients.Save(c);                                      // UPDATE, by the key
```

## Every member

**On a connection**

| | |
|---|---|
| `Close()` | let it go |
| `Columns(table)` | → `[{ Name, Type, Required, Key }]` |
| `Dialect` (ro) | → `{ Placeholder, Quote, NewKey }` — what differs per engine |
| `Execute(sql, [params])` | → `{ Changes, LastId }`. **One** statement |
| `Open` (ro) | whether it is |
| `Path` | the file it is |
| `Query(sql, [params])` | → rows, as plain objects |
| `Script(sql)` | several statements, no parameters: a schema |
| `Table(name, RecordClass)` | → the typed half, below |
| `Tables` (ro) | → tables and views, ordered |
| `Transaction(fn)` | all of it or none; nests through savepoints |

**On a table**

| | |
|---|---|
| `All()` | → every row, as records |
| `Connection` (ro) | the connection it came from |
| `Count([sql], …params)` | → a number, building no records |
| `Delete(rec)` | DELETE by key; **throws** when it matched no row |
| `Find(…key)` | → one record or `null`; one value per key field, in declaration order |
| `Insert(rec)` | INSERT, and tells the record its new key |
| `Name` (ro) | the table's name |
| `Save(rec)` | `Insert` when the key is at its starting value, else `Update` |
| `Shape` (ro) | the record class it maps |
| `Update(rec)` | UPDATE by key; **throws** when it matched no row |
| `Where(sql, …params)` | → the rows matching, as records |

## The two halves

**The typed half is `Table`**, and it is where a program should live: it answers
records, checks values on the way in and knows the key. **The untyped half is the
connection**, for the query that is not a row of one shape — a report, a
`GROUP BY`, a schema migration.

`Where` takes **SQL**, and everything after the filter goes with it:

```js
clients.Where("balance > ? ORDER BY name LIMIT 50", 0)
```

**Values are bound, never interpolated**, and there is no way to ask for anything
else: `Where("name = ?", typed)` and never string concatenation. That is not a
warning about SQL injection so much as the shape making it unavailable.

## A row is a file

`Load` reads a row and `Serialize` writes one, so **nothing converts values on
the way**: a [`Decimal`](Decimal.md) is stored as **text**, exact — a REAL would
lose the cents — a `"YYYY-MM-DD"` date is text that already sorts, a
[`Bytes`](Bytes.md) is a BLOB, and a `Bool` is SQL's `0`/`1`.

All five of sqlite's storage classes are used. `Field.Record` and `Field.List`
are **refused**: a detail is its own table, which is a schema decision and not
something a mapper should make silently.

## The connection itself

| | |
|---|---|
| `Query(sql, [params])` | the rows a statement answers, as **plain objects** — for the report, the `GROUP BY`, the join that is not one shape |
| `Execute(sql, [params])` | **one** statement, answering `{ Changes, LastId }` |
| `Script(sql)` | several statements and **no parameters**: a schema, a migration |
| `Columns(table)` | `[{ Name, Type, Required, Key }]` — what is really in the table, which is how a program checks that a record's shape still fits |
| `Tables` (ro) | the tables and views, ordered |
| `Dialect` (ro) | `{ Placeholder, Quote, NewKey }` — **what differs per engine**, so the portable half above can build SQL without knowing which engine it is talking to |
| `Path` | the file this connection is |
| `Open` (ro) | whether it still is |
| `Close()` | let it go |
| `Table(name, RecordClass)` | the typed half, above |

## Transactions

| | |
|---|---|
| `Transaction(fn)` | everything in `fn` or nothing. **Nests**, through savepoints, so a function that wraps its own work in one is safe to call from inside another |

## What goes wrong

- **`Update` threw and the program stopped.** It matched no row — the record's
  key is wrong or the row is gone, which is a real failure and not a no-op.
- **A total was out by cents.** A `REAL` column somewhere, or a double that got
  in before the `Decimal` did.
- **A value was refused before any SQL ran.** The record checked it: the column
  is not where that check lives.
- **`Field.Record` was refused.** A detail is its own table, and its own
  `Table`.
- **Two connections to one file fought.** sqlite is a file: one connection per
  process, and a `Transaction` around anything that writes more than one row.
- **A query that is not this shape.** `Query`/`Execute` on the connection; they
  answer plain objects and take the same bound parameters.

## See also

[`Record`](Record.md) · [`Decimal`](Decimal.md) ·
[`examples/clients`](../../../examples/clients) · [../../plans/data-plan.md](../../plans/data-plan.md)
