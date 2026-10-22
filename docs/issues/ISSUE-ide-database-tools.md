# ISSUE: no schema browser, query console or query designer in the IDE

## What the application needed

An application that keeps its clients in a SQLite file, developed in the IDE.
The concrete screen: a tree of the database's tables and their columns beside
the project tree, double-clicking a table to see its rows, and a console
along the bottom where `SELECT * FROM client` is typed, run, and its rows
shown.

## What I wrote instead

Nothing — this part is not implemented. The runtime carries the whole data
layer (`Database.Sqlite`, `Table`, `Record`) and the IDE none of the surface
over it: the only mentions of `Database`, `Sqlite`, `schema` or `Query` under
`ide/` are comments in `ide/modules/Completion.js`, about completing
`db.Query(sql)`. The schema is learned by running the program and reading the
error, or by opening the `.db` in another program.

## The code I wish I could have written

```js
// A data tab in the IDE, in the runtime's own words: a tree of the schema,
// a table of rows, and a console over them.
class DataTab extends Component {
    Form_Open() {
        this.db = Database.Sqlite(this.ide.project.Path("clients.db"));
        for (const t of this.db.Tables) {
            this.Schema.Add(t, t);
            for (const c of this.db.Columns(t)) this.Schema.Add(`${t}.${c.Name}`, c.Type, t);
        }
        this.Rows.Columns = [{ Text: "id" }, { Text: "name" }];
    }
    BtnRun_Click() {
        this.Rows.Clear();
        this.Rows.AddRows(this.db.Query(this.Console.Text));
    }
}
```

## Why the existing words do not cover it

The runtime's data layer (`runtime/src/bta_database.c`, `runtime/src/bta_sqlite.c`,
`runtime/js/rad.js`) is complete enough to build a schema browser on:
`db.Tables`, `db.Columns(table)`, `db.Query(sql)`, `Table.Save`, `Table.Load`.
The IDE has no half of it: `ide/modules/ProjectTree.js:530-610` gives a project
its categories — modules, translations, images, sounds, documents, records and
other — and no data category among them. The nearest thing is
`ide/forms/RecordForm.js`, which edits a `.record` file, a JSON document of the
shape `{"format":"bta-record/1","class":"Client","naming":"snake","fields":{...}}`:
the shape of a class, not of a table.

## Prior art

Lazarus has the SQL builder, the Data Editor and a database browser. Delphi
has `Database Explorer` and `SQL Builder`. DBeaver and pgAdmin. Qt Creator has
an SQL editor. VS Code's database extensions.

## How much it mattered

It works, but a part of it is noticeably worse: an application that uses
SQLite is developed without any IDE support for it, and the schema is
something the program discovers at run time, by failing.
