/*
 * The shapes, and the schema that has to agree with them.
 *
 * In their own file for the reason `examples/quote` gives: a shape is not a
 * detail of the window that shows it. Here there is a second reason, and it is
 * the interesting one -- **the schema is in here too**, right under the shape it
 * describes, so that the one thing this example is measuring is impossible to
 * miss.
 *
 * ## What the duplication costs, which is the measurement
 *
 * Read `Client.Fields` and `SCHEMA` together. Every fact is written twice:
 *
 *   Field.Text({ max: 80 })          TEXT NOT NULL
 *   Field.Decimal({ decimals: 2 })   TEXT             -- and *not* NUMERIC
 *   Field.Int({ key: true })         INTEGER PRIMARY KEY
 *   Naming = "snake"                 postal_code
 *
 * and nothing checks that the two agree except `Table`, on the first statement,
 * and only about the **names** -- it compares the shape against `Columns()` and
 * says so when a field has no column. It cannot say that `max: 80` and the
 * column disagree, because sqlite does not enforce a text length at all.
 *
 * `docs/data-plan.md` calls the answer *"a `.record` derived from a table"*, and
 * this file is the argument for the other direction as well: **the shape should
 * be able to write the `CREATE TABLE`.** The decimals are the case in point --
 * a `Field.Decimal` has to become `TEXT` and must not become `NUMERIC`, and the
 * *only* place those two facts are tied together is a person remembering.
 */
"use strict";

/*
 * A client.
 *
 * `Naming = "snake"` is the whole of what makes this a database shape rather
 * than a JSON one, and it was written for this years before there was any SQL.
 * `Id` is `Field.Int({ key: true })`: at 0 it is a row that was never saved,
 * which is how `Table.Save` tells an INSERT from an UPDATE with no flag.
 */
class Client extends Record {
    static Naming = "snake";
    static Fields = {
        Id:         Field.Int({ key: true }),
        Name:       Field.Text({ required: true, max: 80 }),
        Category:   Field.Enum(["Retail", "Wholesale", "Government"]),
        Balance:    Field.Decimal({ decimals: 2 }),
        /* `required` because of the *control* and not because of the domain:
         * a DatePicker has no empty state, so an optional date cannot come back
         * out of one. See measurement 7 in ClientsForm.js. */
        Since:      Field.Date({ required: true }),
        PostalCode: Field.Text({ max: 8 }),
        Active:     Field.Bool(true),
    };

    /* A field written by hand is a field, and the serialiser leaves it out --
     * so it is not a column and `Table` never asks about it. */
    get Label() { return `${this.Name} (${this.Category})`; }
}

/*
 * One order of one client.
 *
 * `ClientId` is an ordinary field and not a relation: `Record` has no idea that
 * a number in one shape names a row of another, which is the whole of what a
 * child collection would add. Until then the foreign key is a field like any
 * other and the join is a `Where`.
 */
class Order extends Record {
    static Naming = "snake";
    static Fields = {
        Id:       Field.Int({ key: true }),
        ClientId: Field.Int({ required: true }),
        Placed:   Field.Date({ required: true }),
        What:     Field.Text({ required: true, max: 60 }),
        Amount:   Field.Decimal({ decimals: 2, min: "0" }),

        /*
         * Pending until it is executed, and executing it is what moves the
         * client's balance.
         *
         * A `Field.Enum` and not a boolean, for the reason enums earn their keep
         * everywhere in this tree: the setter refuses a state nobody has, the
         * column shows the word rather than a `1`, and `PropertyOptions` would
         * fill a drop-down from the same list. `Pending` is the default because
         * an enum with no `def` takes its first value.
         */
        State:    Field.Enum(["Pending", "Executed"]),
    };
}

/*
 * The schema, by hand.
 *
 * `IF NOT EXISTS` because this runs on every start: an application that owns its
 * own database file has to create it the first time and leave it alone
 * afterwards, and there is no migration story here -- `docs/data-plan.md` says
 * why there is not going to be one either.
 *
 * **The two money columns are plain `TEXT`, and that is sqlite's standard type
 * for a value it has no exact numeric type for.** `NUMERIC` and
 * `DECIMAL(12,2)` are *affinities*: a column declared either turns `'19.90'`
 * into the double `19.9`, which is the one thing `Decimal` exists to prevent,
 * and it is what most ORMs declaring a `decimal` column actually get.
 *
 * **So sqlite cannot order or total these two columns**, because text compares
 * byte by byte and `'9.00'` follows `'10.00'`. That is a limitation of sqlite,
 * not of this runtime, and it is not papered over: the file uses standard types
 * and **the program does the ordering and the totalling** -- see `fill()` and
 * `executed()` in `ClientsForm.js`.
 *
 * The alternative was tried and rejected out loud: a `COLLATE DECIMAL` of ours
 * in these two lines makes the database correct for us and **unreadable by
 * everybody else** -- `no such collation sequence` on every `ORDER BY`, `MIN`,
 * `MAX`, comparison and `CREATE INDEX`, verified from another client against a
 * file this runtime had written. A `.db` only one program can query is not a
 * `.db`. The collation exists, opt-in, for a program that decides otherwise.
 *
 * The foreign key is declared and enforced, because the driver turns
 * `foreign_keys` on: deleting a client takes its orders with it rather than
 * leaving rows nobody can reach.
 */
const SCHEMA = `
    CREATE TABLE IF NOT EXISTS clients (
        id          INTEGER PRIMARY KEY,
        name        TEXT NOT NULL,
        category    TEXT,
        balance     TEXT,
        since       TEXT,
        postal_code TEXT,
        active      INTEGER
    );

    CREATE TABLE IF NOT EXISTS orders (
        id        INTEGER PRIMARY KEY,
        client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
        placed    TEXT NOT NULL,
        what      TEXT NOT NULL,
        amount    TEXT,
        state     TEXT NOT NULL DEFAULT 'Pending'
    );

    CREATE INDEX IF NOT EXISTS orders_by_client ON orders (client_id);
`;

/*
 * Something to look at on a first run.  An application with an empty first
 * screen is one nobody can tell from a broken one, and one with rows but no
 * detail is one where half the window looks broken instead.
 *
 * **No balance is written here**, and that is the point: a client's balance is
 * the total of the orders that were *executed*, so `ClientsForm.open()` works
 * each one out from its own orders with the same `decimal_sum` the running
 * application uses. A seed that carried its own balances could disagree with its
 * own orders on the very first screen.
 */
const SEED = [
    { Client: { Name: "Ñanculeo, Ayelén", Category: "Retail",
                Since: "2024-03-11", PostalCode: "8300", Active: true },
      Orders: [
          { Placed: "2026-07-14", What: "Design of the catalogue",
            Amount: "75600.00", State: "Executed" },
          { Placed: "2026-08-02", What: "Photography, three sessions",
            Amount: "49500.00", State: "Executed" },
          { Placed: "2026-08-28", What: "Printing, 500 copies",
            Amount: "87400.00", State: "Pending" },
      ] },

    { Client: { Name: "Talleres Andrade", Category: "Wholesale",
                Since: "2019-07-02", PostalCode: "1425", Active: true },
      Orders: [
          { Placed: "2026-06-30", What: "Sheet metal, 40 units",
            Amount: "168000.00", State: "Executed" },
          { Placed: "2026-08-19", What: "Welding, per hour",
            Amount: "9.00", State: "Executed" },
          { Placed: "2026-09-01", What: "Delivery to the workshop",
            Amount: "12750.50", State: "Pending" },
      ] },

    { Client: { Name: "Municipalidad", Category: "Government",
                Since: "2021-11-30", PostalCode: "5000", Active: false },
      Orders: [
          { Placed: "2026-05-21", What: "Signage, plaza San Martín",
            Amount: "100.50", State: "Executed" },
          { Placed: "2026-08-11", What: "Signage, second stage",
            Amount: "980000.00", State: "Pending" },
      ] },

    /* Nothing executed, so this one's balance works out to zero -- which is a
     * different thing from a client with no orders, and worth having one of. */
    { Client: { Name: "Vega e hijos", Category: "Retail",
                Since: "2026-01-15", PostalCode: "2000", Active: true },
      Orders: [
          { Placed: "2026-08-30", What: "Two pallets, on account",
            Amount: "43125.75", State: "Pending" },
      ] },

    /* And one with none at all. */
    { Client: { Name: "Sin movimientos", Category: "Retail",
                Since: "2026-09-01", PostalCode: "9410", Active: true },
      Orders: [] },
];
