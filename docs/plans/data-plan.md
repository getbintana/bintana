# Data: a plan, not a feature

**No binding in this document is implemented.** It is the design for binding
records to forms and for reading them out of a database, written down at the point
where it was **deliberately deferred**: the machinery it needs is large and what it
would deliver on its own — a form showing one record at a time — is small. The
reasoning is here so that whoever picks it up does not have to have the
conversation again, and so that the parts of it that *are* already in the tree are
not mistaken for loose ends.

**Everything under the binding has since been built**, each piece on its own
account rather than as a first step of it: a record **holds a list of records**, so
master–detail is a shape a program can declare; and `Database.Sqlite` + `Table`
read and write a table, with `snake` finally in use and `key: true` as the
identity ([reference](../runtime-api.md#database-and-table)). What is left, and where
it stands, is [at the end](#where-it-stands).

What exists today is the bottom half: [`Record` and
`Field`](../runtime-api.md#record-and-field), and three consumers of them —
[`project.json`](../ide.md#projectjson-as-a-record) and **two forms over data
written by hand**, on purpose, to find out what that costs.
[`examples/quote`](../../examples/quote) is one over a JSON file and
[`examples/clients`](../../examples/clients) is one over a sqlite table. What they
found is [here](#what-writing-one-by-hand-measured) and
[here](#what-a-screen-over-a-table-measured), and between them they are the only
evidence this document has that is not reasoning.

## What it would be for

A RAD environment is mostly forms over data. Today a Bintana application can
declare the *shape* of its data and be told what is wrong with a value, but it
cannot *show* one: filling controls from a record and reading them back is a loop
every program writes again, and nothing in the designer knows that a `TextBox` has
anything to do with a customer's name.

The end state is the one every tool in this family arrived at: a form declares
which record it edits, a control declares which field it shows, and where the rows
come from is a resource of the project rather than a line of code.

## What already exists toward it

| Already there | Waiting for this plan |
|---|---|
| `Record` with fields as ordinary accessors, discovered like a widget's | — |
| `Field.Text/Int/Number/Bool/Date/Enum/List`, with the checks in the setters | — |
| `Record.Load`, lenient and reporting, for reading a file | it is also how a database row would arrive |
| `Record.Validate`, all complaints at once and recomputed | the form would show them beside the field. **`Problems` is not this** -- it is the report of one `Load` and never clears, so validating with it marks a field the user has already fixed |
| `Record.Clone`, for a dialog editing a copy | — |
| `PropertyNames` / `PropertyOptions` on a record | a property grid could edit one already |
| `Naming = "snake"` | **unused today**, and on purpose: it is the SQL spelling |
| `index_forms` in `bta_form.c`: class name → file, anywhere in the tree | the same walk would index `.record` files |
| `GotFocus`/`LostFocus`/`Focused` on every widget | when a bound control would write its value back |
| The grid's `Style` drop-down, built from the project rather than the runtime | the same trick for `DataField` and `Source` |
| `TableView`, with rows held or answered on demand through `Data` | **the widget stage 3 was waiting for**, and it arrived after this plan was written -- see the note at the end |
| `Field.Record` / `Field.List(Class)`: a record inside a record, to any depth | **the wall this plan was waiting on**, built after it was written -- master--detail is a declaration now |
| `Database.Sqlite` + `Table`: `Find`/`Where`/`Save`/`Delete` over a table | **the reading and writing half of stage 2**, built after this was written. What is left of that stage is the *declarative* half: the connection as a resource, and `Form.Source` |
| `key: true` on a field, and `PropertyInfo` beside `PropertyOptions` | the identity, and the one member a mapper needed that `Record` did not expose |
| `Naming = "snake"` -- **no longer unused** | it is what a `Table` spells a column with, and it needed no change at all |

The `snake` naming rule and the absence of change tracking (`#o`) are the two
places where the shipped code is deliberately short of what this plan needs. Both
are noted where they live.

## What writing one by hand measured

The claim above — *filling controls from a record and reading them back is a loop
every program writes again* — was written without one to look at.
`examples/quote` is that loop, and these are the numbers and the two surprises.

**The loop is eleven lines**, five out and six back, for a five-field record over
five controls. That is the whole of what a binding in the `.form` would save on
this form, and it is worth saying plainly: it is not much. What would justify the
binding is not the typing, it is the two things underneath it.

**The first is that the loop is not the whole cost — the guard beside it is.**
Every assignment to a control raises a real `Change`, so a form that shows a
record immediately reads it back; `examples/quote` carries a `showing` flag and
`show()` sets it around everything it writes. Worse, and it cost two error
dialogs on the first run: a `.form` applies its properties *before* `Form_Open`,
so a `"Value": 1` on a spin raised `Change` against a record that was still
`null`. **Every hand-written binding needs both guards**, neither is discoverable,
and a binding declared in the file would own that problem once instead of once per
form.

**The second was a wall rather than a cost, and it is the one thing this plan
has since spent: a `Record` could not hold a list of records.** `Field.List` took
a *field* for its entries and a `Record` was not one, so a quote could not contain
its own lines; `examples/quote` kept two objects side by side and a file with two
halves. **Master–detail is most of what forms over data are**, and the plan above
quietly assumes it: a form bound to a record, a grid bound to its rows.

It is built. `Field.Record(Class)` is a field kind, so `Field.List(Line)` — the
class where a field is expected — is a detail, and the serialising, the
validating and the `Problems` reporting all reach through it with the path in
front of each complaint (`Lines[2].Price: 0 at least`). `examples/quote` is one
object now, and the assertion in `tests/widgets` that used to hold the wall in
place holds the opposite. The reference is
[runtime-api.md](../runtime-api.md#a-record-inside-a-record).

Three things fell out of building it that the plan had not predicted, and the
first is the one that matters:

- **The first customers were not databases.** They are already in the tree, and
  all three are read and written by hand: `TableView.Columns` is a list of
  records validated by hand in C (`bta_table.c`, which builds `Columns[2]` into
  a buffer to say where a complaint is — this plan's path prefixes, written once
  for one property), a form's `menus` are recursive, and a `.form` node holds
  `.form` nodes. **A shape that contains itself is the main case, not the exotic
  one**, which is why a record field starts at `null` and why the recursive
  spelling needs a thunk (`Field.List(() => Node)`).
- **`.form` still does not fit**, and it is worth knowing why: a node's
  `properties` is an *open bag* whose keys depend on the widget's `type`, and a
  record whose whole content is unknown keys declares nothing. That wants a
  `Field.Map` — a mapping of free keys to values of one shape — which is a
  separate word with one customer today.
- **A `Fields` getter declared nothing, silently.** It is the tempting way to
  write a recursive shape, and a getter's descriptor has no `value`, so the merge
  loop ran over `undefined`. It is refused out loud now.

**Two smaller things worth keeping.** `Field.Int({ min: 1 })` starts at 0 and the
class refuses to be used at all until a `def` is given — which is the check
working, and is also the first thing anybody writing a record hits. And
`PropertyOptions` filling a `ComboBox` from `Field.Enum` is the one place where
the shape already reaches the interface: the VAT rates are declared once and the
drop-down cannot drift from what the setter accepts. That is the whole plan, in
miniature, on one control.

## What a screen over a table measured

`examples/quote` measured the binding against a JSON file and found the loop
small and the guards expensive. [`examples/clients`](../../examples/clients) is the
same move one layer down — a `TableView` of clients, a detail form beside it, and
each client's orders in a second table — written by hand against
`Database.Sqlite` and `Table`. Eight findings, and three of them change this
document.

**The loop is small again, and the guards were rediscovered the same way.**
`show()` and `read()` are fourteen lines for seven fields. And `showing` is there
because this window, like `examples/quote` before it, **opened behind an error
about a value nobody had typed** — every assignment to a control raises a real
`Change`. Two programs, two independent discoveries, no help from any document.
That is as close to *always* as two data points get.

**The largest thing is not the loop — it is keeping a list and its records in
step.** `rows[]` holds the records the `TableView` is showing, parallel to it by
index, and four places maintain both: an insert appends to each, a save repaints
three cells with `SetCell`, a delete removes from each, a filter rebuilds both.
Refilling the list instead would be one line and would **take the selection
away**, which is the row being edited. This plan does not mention it anywhere and
it is the single biggest thing a bound grid would own.

**`Save` deciding INSERT or UPDATE is not quite enough for a screen.** The record
knows — a key at what the field starts from is a row never saved — but the
*window* needs the same answer, because an insert appends a row to the list and
an update repaints one. So the handler reads `Id === 0` before calling `Save`:
the same question, asked a second time in a second place, which a binding would
answer once.

**Marking the field that refused is cheaper than this document promised.**
`Validate()` puts the property name in front of each sentence and a `TextBox`
already has `Icon` and `Tooltip`, so the whole form's error marking is nine
lines. The only reason it is not free is the lookup from a field name to a
control — which is exactly what `DataField` would have declared.

**And the same loop is written twice in one window**, once for the client and
once for the selected order. Nothing in the second copy says anything the first
did not.

**One finding was not about data at all.** The window was drawn in coordinates
first — 27 controls, 117 numbers, 54 of them an X or a Y — and it broke on a
resize, because on a drawing surface `HAlign`/`VAlign` are what a control does
with the slack and the default is *stay where you were drawn*. As boxes it is 17
numbers and no coordinates. That belongs to
[widgets.md](../widgets.md#which-of-the-two-models-a-form-should-use), which had
explained both models and not said when to use which.

**The first thing that was not CRUD needed nothing new.** Executing an order
moves two rows in two tables — the order becomes `Executed`, the client's
balance grows by its amount — and `Transaction` plus `c.Balance + o.Amount` is
the whole of it: the arithmetic exact with the ordinary operator, the unit of
work reading as one paragraph, and a throw inside coming back out as itself.
What it wanted was the list problem one notch worse: **two lists to repaint from
one operation**, with the master's row reached from the detail's handler.

**And a rollback undoes the rows and not the objects**, which is obvious once
written down and was not before: after a failed transaction the records in memory
are ahead of the database, so the handler reads them back rather than guessing.

### The three that change the plan

**1. Master–detail over a database does not need the cascade save this document
puts in stage 2.** In `examples/quote` a quote and its lines are one JSON file,
so they are written whole or not at all. Here an order is its own row:
`orders.Save(o)` writes it the moment it is valid, `ON DELETE CASCADE` removes
them with their client, and there is never a half-written client. The cost of
having no cascade is **one disabled button** — an order cannot be added to a
client that has never been saved, because there is no key to point at.

That does not make cascade save useless; it makes it a choice about the *screen*.
A form you can cancel — edit the header and the lines, then one Save — needs it.
A form that saves each row as it is finished, which is the natural shape over a
database, needs none of it. So `#o` and the delete-diff are not a prerequisite of
anything here, and the staging below says so now.

**2. The shape should be able to write the `CREATE TABLE`.** This document has
"a `.record` derived from a table" and not the other direction, and the schema in
`examples/clients/Client.js` is the argument for it: every fact is written twice,
and the decimals are the case in point — a `Field.Decimal` has to become `TEXT`
and must **not** become `NUMERIC`, or sqlite turns `'19.90'` into a double, and
the only thing tying those two facts together is a person remembering. `Table`
now refuses that particular mismatch on the first statement; what it cannot do is
write the line in the first place.

**3. Two widget limits leak into the shape, and neither is in this document.** A
`ComboBox` has no empty text (`""` is refused: the text is one of the items, and
nothing is `Index = -1`), and a `DatePicker` had no empty state at all — its
default is today, so an optional `Field.Date` could not round-trip through one
and `Client.Since` was declared `required` **because of the control rather than
because of the domain**.

**The date half is fixed**: `DatePicker.Value = ""` is no date, spelled the way
`Field.Date` already spelled it, with a `Placeholder` for what the button reads
while it is empty (see [widgets.md](../widgets.md#datepicker)). The `ComboBox` half
stands. A binding that writes a value into a control still has to have an answer
for what it does with a field that is empty and a control that cannot be — there
is just one control fewer in that set.

### And two things a shape cannot say at all

Both turned up keeping the balance true, and neither is a gap in the *binding* —
they are gaps in `Record`, so they belong here rather than in the staging:

**A field cannot be declared derived.** `Balance` is the total of the orders that
were executed. Storing it is what makes a list of clients one query instead of
ten thousand — which is the same N+1 this document refuses lazy loading over — and
the price is that it can drift. `Record` has no way to say *this value is that
sum*, so `examples/clients` keeps the invariant in code and adds a `drift()` that
asks the database whether any balance still agrees with its own orders. A stored
total with no way to check it is a stored total that is wrong and nobody knows.

**And a rule about a *state* cannot be declared either.** An executed order may
not be edited or removed, because the balance already counts it. `Field` says
what a value may *be*; nothing says what may be *done* to a row in which state.
Worth knowing before anyone proposes that a `.record` file could hold the
business rules as well as the shape: these two are the first ones a real screen
wanted, and neither is about a value.

### And the one thing that will have to be answered for the cursor

**`ORDER BY name` in sqlite compares bytes, so it is not the language's order.**
It puts `Ñanculeo` after `Zapata` and `Álvarez` last — the mistake
[`examples/contacts`](../../examples/contacts) exists to demonstrate, arriving from
the database this time instead of from `localeCompare`. `examples/clients` sorts
with `Locale.Compare` in the program, which is the rule for decimals applied to
text and is the right answer for a screenful of rows.

It stops being an answer at **stage 3's cursor**: `LIMIT`/`OFFSET` over rows the
program has not seen cannot be reordered afterwards, so the ordering has to be in
the statement. And a collation of ours in the schema is the trade the decimals
just refused. So the cursor's ordering is an open question with two candidates —
a collation named *per statement*, or a collation-key column indexed as plain
bytes (`g_utf8_collate_key`, which glib has for exactly this) — and it is worth
settling before the cursor rather than during it.

## The shape it would take

### A record would be a file

`Customer.record` beside an optional `Customer.js`, which is the pairing the whole
IDE is already built around:

```js
class Customer extends Record { }            /* no static Fields */
```

```json
{ "format": "bta-record/1", "class": "Customer", "naming": "snake",
  "fields": {
    "Name":     { "kind": "text",   "required": true, "max": 80 },
    "Balance":  { "kind": "number", "decimals": 2, "min": 0 },
    "Category": { "kind": "enum",   "values": ["Retail", "Wholesale"] }
  } }
```

The `static Fields` block that exists today stays as the **code-only path**,
exactly as a form with no `.form` is legal and built from code. What the file buys
is what a `.form` buys: the tree groups it, a dialog edits it, and there is one
place the shape lives.

The runtime would find it the way it finds a form — `index_forms` already maps a
class name, qualified by the folders above it, to a file anywhere in the project,
and it is parameterised by depth and namespace prefix. A second extension is a
small change there, not a new mechanism.

### The form would name the record; a control would name the field

```json
{ "format": "bintana-form/1", "class": "CustomerForm",
  "properties": { "Record": "Customer", "Source": "sales.customers" },
  "children": [
    { "type": "TextBox", "name": "TxtName",
      "properties": { "DataField": "Name", "X": 120, "Y": 20, "Width": 300 } }
  ] }
```

Two ordinary properties, so both are designable, serialisable and editable with no
other change — which is the invariant the runtime rests on. `DataField` and not
`Field`, because `Field` is the global that *declares* one and the two would read
as the same thing on the same page.

`Record` on the form earns its place before any of the rest exists: it is what
turns `DataField` into a drop-down of that record's fields instead of a free-text
box, and what lets the designer say that a control points at a field that is not
there — an error that today would wait until the program ran.

### The source would be a project resource

`sales.conn`, a file in the tree with its own category, icon and dialog — declared
the way `app.css` is, found by name, referenced by name. Not a section of
`project.json`: that file says *what to run*, and a connection is a resource with
an editor of its own, of which there can be several.

**`Record` and `Source` are orthogonal on purpose.** The shape says what a customer
is; the source says which customers. The same `Customer` has to be readable from a
JSON file (an import), from a table (the application) and later from a reply over
HTTP — and two screens over the same record (all of them, and the ones who owe
money) are two sources and one shape. Putting the source inside the `.record` kills
all of that, and kills the staging below with it.

**How the runtime would tell a table from a file: by looking, not by parsing.** A
scheme inside the string (`"json:data/customers.json"`) is a small language inside
a value, which is exactly what was refused for Go-style field tags; it would be
incoherent to accept it here. Instead:

1. a declared connection by that name — then `sales.customers` is a table in it;
2. failing that, a file in the project — then `customers.json` is the file;
3. failing both, an error naming **both places it looked**.

That is the shape of resolution the runtime already uses twice:
`bta_lookup_global` resolves a bare name in the lexical scope and a qualified one
by walking properties, and the form index resolves a class name to a file in any
folder. And in the designer the ambiguity mostly evaporates, because the value is
*picked*: the grid would offer the tables of the declared connections and the
project's `.json` files as one computed list, the way the `Style` row already
offers the project's own classes.

## When the value would move

This is the fork that decides whether the thing is usable, and the answer is not
the obvious one.

**Not on every keystroke.** A `TextBox` bound to `Field.Text({ max: 80 })` would
throw in the middle of a word, and a `Field.Date()` would throw at every
intermediate state of a date being typed. There is direct evidence of this shape
of bug in this codebase already: the find bar had to stop treating a half-typed
regular expression as an error, because `(` is a pattern nobody has finished.

So the value moves **when the control is done being edited** — on `Activate`
(Enter) and on losing the focus, which is what WinForms calls `OnValidation` and
what Delphi's data-aware controls do.

That used to be the one hard prerequisite, because the runtime had no focus events
at all: at `Widget` level there was `MouseDown`, `MouseMove`, `MouseUp`,
`DblClick`, `KeyPress` and `Drop`, and nothing else, so "when the control loses the
focus" could not be said. **`GotFocus`/`LostFocus` and `Focused` now exist**, built
separately from this plan because they are worth having on their own account —
which is what the rest of it is waiting on nothing else for.

**One direction, to start.** A control showing a record is easy; `record.Name = x`
updating the control needs the record to *announce* the change — dataset events in
Delphi, `INotifyPropertyChanged` in WPF. `Record` does not announce anything, and
the first version does not need it: a `Refresh()` is honest and one line. That is
also where the `#o` bag comes in, since a record that can say what changed is a
record that can be written back with an `UPDATE` that touches only those columns.

**Errors beside the field.** The setter already produces the sentence; `TextBox`
already has a clickable `Icon`. Marking the field that refused is nearly free, and
it is what Django, Rails and WinForms' `ErrorProvider` all do. An exception dialog,
which is what Delphi does, is the wrong answer for a form with twelve fields.

## What was rejected, and why

| Rejected | Why |
|---|---|
| Field metadata as tags in a string (`"name,notnull,size:80"`, Go's shape) | A grammar inside a value that nothing checks until it runs, in a project whose premise is that the runtime validates and says what was wrong. It also cannot generate accessors, so the boilerplate stays underneath it |
| A separate family of data-aware controls (`TDBEdit`, Delphi's shape) | It doubles the widget table and every new control has to be written twice. A property on the ordinary control is what VB6, Gambas and Access all chose, and it is what "add a property in C and it becomes designable" already gives |
| A non-visual `DataSource` component on the form (Gambas' shape) | The children of a `.form` are widgets; a non-visual child is a concept the runtime does not have — `Timer` is constructed in code precisely because there is nowhere to declare it. Access solves the same problem with two declared properties and no new object |
| The source inside the `.record` | Kills reuse of a shape across sources, and kills the JSON-first staging |
| A scheme prefix in `Source` | The same small-language-in-a-string that was refused for tags |
| GTK's own `g_object_bind_property` / `GtkExpression` | They bind GObject properties to GObject properties. A record's fields are JS accessors: there is nothing on the record side for GTK to bind to. The binding has to be in `rad.js` |
| Two-way binding with change notification, for now | Needed only once something other than the form writes to the record |
| WPF's paths, converters and validation rules | Machinery for a language where a hand-written accessor already covers the awkward case |
| A decimal column as `TEXT COLLATE DECIMAL` | Correct for this runtime and **unreadable by every other client**: measured, `ORDER BY`, `MIN`, `MAX`, a comparison and `CREATE INDEX` all fail with `no such collation sequence`. A `.db` only one program can query is not a `.db` |
| A decimal column as an integer of the field's units | Portable, and an **invented storage format**. The rule that replaced both: a `Table` uses sqlite's standard types, what sqlite cannot do is said as sqlite's limitation, and the program filters and orders |
| A `LOCALE` collation, so SQL orders text by the language | The first of those two again. `Locale.Compare` in the program is the answer for a screenful of rows; for a cursor it is [an open question](#and-the-one-thing-that-will-have-to-be-answered-for-the-cursor) |

## Prior art worth reading first

| | What it contributes |
|---|---|
| **Delphi / Lazarus** | The most refined version: `TDataSet` + `TDataSource` + data-aware controls, and **persistent `TField` objects** carrying `Required`, `Size` and a display label that the controls *and* the grid read. That is `Record`/`Field`, arrived at independently twenty-five years earlier |
| **Gambas** | `Connection` as a **resource of the project**, in the tree, edited by a dialog; `DataSource` on the form, `DataControl` with a `Field`. The reason this plan is declarative rather than a `Bind()` call in code |
| **VB6** | The `Data` control on the form, `DataSource`/`DataField` on each bound control |
| **MS Access** | `RecordSource` on the form and `ControlSource` on the control: the same chain with no extra object, which is the shape taken here |
| **Qt** | `QDataWidgetMapper.addMapping(widget, column)`, and an explicit submit policy |
| **WinForms** | `BindingSource`, `DataSourceUpdateMode.OnValidation`, and `ErrorProvider` beside the control |
| **WPF, and the web's `v-model`** | What binding looks like when taken all the way, and the machinery that costs |

## Staging

1. **`Customer.record`, `Form.Record`, `Control.DataField`, `Bind()`** — one record
   at a time, over JSON, with a field editor in the IDE. No database at all, so the
   declarative machinery is proven before a dependency arrives. Everything it
   needed exists: the focus events, and the nesting, so a bound form and a bound
   grid over its detail are one shape rather than two. The `.record` file needs one
   thing the code path does not, and it is where the recursive spelling goes:
   `{ "kind": "record", "of": "MenuItem" }` names a class the way a `.form` names a
   `"type"`.
2. **`sales.conn` and sqlite** — **half built.** `Database.Sqlite` and `Table` are
   there and tested: a record reads and writes a table, and `snake` stopped being
   unused. What is left is the declarative half, which is
   [below](#where-it-stands). Still missing underneath: `#o`, so an `UPDATE` touches
   only what changed — which matters for two windows editing different fields of
   one row, since today the last writer replaces every column. **Cascade save is no
   longer a prerequisite**, and the storage format is settled: see the two rows
   about it in [what was rejected](#what-was-rejected-and-why).
3. **Many records** — navigation, or the grid. What it needs from stage 2 is a
   **cursor**: a `COUNT(*)` and a window refilled with `LIMIT`/`OFFSET`, because
   `Data(row, col)` runs while the row is being drawn and has to be a lookup. Two
   things to write down before anybody starts it: `LIMIT`/`OFFSET` without an
   `ORDER BY` is undefined, so a cursor with no order asked for gets one; and on a
   local sqlite file a few-hundred-row refill inside the draw path is honest, which
   is exactly the place that has to become asynchronous the day a source is remote.

A note on credentials, which every tool in this family gets wrong: a password in a
file in the project tree is a password in version control. For sqlite the question
does not arise (a connection is a path). For anything remote it has to be answered
before the feature ships, not after.

## Where it stands

**Everything this document named as a prerequisite is built, tested, and was
built for its own reasons rather than by the binding.** Focus events, because a
control that cannot say when it lost the keyboard is missing something on its own
account. `TableView` with the on-demand mode a bound grid over a query wants. A
record that holds a list of records, so master–detail is a declaration. And
`Database.Sqlite` + `Table`, so a record reads and writes a table.

So what is left is **only the declarative half**, and it is now small enough to
list:

| | |
|---|---|
| `Customer.record` | the shape as a file, so the tree groups it and a dialog edits it — with `{ "kind": "record", "of": "Line" }` as the file's spelling of a nested one |
| `sales.conn` | the connection as a project resource, with a category, an icon and a dialog. Not a section of `project.json` |
| `Form.Record` / `Form.Source` / `Control.DataField` | three ordinary properties, so all three are designable and serialisable with no other change — the invariant the runtime rests on |
| the drop-downs | `DataField` from the record's fields, `Source` from the declared connections' tables and the project's `.json` files, computed the way the grid's `Style` row already is |
| the write-back | on `Activate` and `LostFocus`, with the error marked beside the field. It asks **`Validate()`** and never `Problems`, which is the report of a load and never clears |

And two things the binding will have to answer that this document did not
foresee, both found by writing the screens by hand: **a guard**, because
assigning to a control raises a real `Change` and a form that shows a record
reads it straight back — the thing a declaration would own once instead of once
per form; and **a control with no empty state**, since a `ComboBox` has no empty
text — the `DatePicker` half of that pair is done, and an optional `Field.Date`
round-trips through one now.

**Wanted, and waiting for a caller** — which is the same reason every other
deferral in this tree gives, and the reason it is not any of the usual ones. Not a
missing prerequisite: they are all built. Not a doubt about the design: it is
written out above and two hand-written screens have already corrected it. Simply
that nothing in the tree needs it yet, and `Database.Sqlite` + `Table` are useful
with no binding at all — which is why they were built that way, and why an
application over this can be written today, in code.

That is also how the next correction will arrive. The thirteen findings above came
from two programs written by hand; not one came from reasoning about the design.
So the thing to do while this waits is **write applications on what exists**, and
the day one of them makes the same declaration for the fourth time, the caller has
arrived.

It was a good plan waiting for a reason, which is a better position than a
half-built feature waiting for a plan. It is now a plan with its foundations
poured and measured, which is better than either.
