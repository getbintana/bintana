# Record

The shape data has, declared once.

What a control's properties are to a control. Use one instead of a bag of keys
nobody checks: the fields are named, the values are checked where they are set,
and the whole thing survives JSON, a form and a database as itself.

```js
class Customer extends Record {
    static Naming = "same";                     // same | lower | snake
    static Fields = {
        Name:     Field.Text({ required: true, max: 80 }),
        Email:    Field.Text({ as: "email_address" }),
        Balance:  Field.Decimal({ decimals: 2, min: 0 }),
        Category: Field.Enum(["Retail", "Wholesale"]),
        Active:   Field.Bool(true),
        Since:    Field.Date(),
        Tags:     Field.List(Field.Text()),
    };

    /* A field written by hand is a field. Read-only, so it is not written back. */
    get Label() { return `${this.Name} (${this.Email})`; }
}
```

## Every member

**On a record**

| | |
|---|---|
| `new C({ … })` | built through the setters, so every value is checked |
| `Apply(values)` | the same, by property name |
| `Clone()` | a copy — for the dialog that edits one |
| `Dump()` | prints what it holds |
| `Problems` (ro) | **the report of one `Load`**: what the file said that could not be taken |
| `PropertyInfo(name)` | → `{ Kind, Column, Key }`: what a field *is*, for whoever maps it onto something else |
| `PropertyNames()`, `PropertyOptions(name)` | as a widget answers them |
| `Serialize([all])` | a plain object: what differs from the start, or everything |
| `Validate()` | **the state**: what is wrong with what it holds now |
| `toJSON()` | so `JSON.stringify` and `File.SaveJson` are the record |
| `C.Load(json)` | a file, read **leniently** |
| `C.LoadXml(node)` | the same, from an XML document or element — see [XML](#xml) |
| `ToXml([all])` | → a new element, the `Serialize` of XML |
| `SaveXml(node)` | writes **into** that element, touching only what it models |

**On the class**

| | |
|---|---|
| `static Fields` | the shape: a name and a `Field` for each |
| `static Naming` | how a field's name becomes a column: `same`, `lower` or `snake` |
| `static Xml` | the element this record is: `{ Root, Namespace }` — see [XML](#xml) |

## The fields

| Kind | Holds | Options beyond `as` and `def` |
|---|---|---|
| `Field.Text(o)` | a string | `required`, `max` (characters) |
| `Field.Int(o)` | a whole number | `required`, `min`, `max` |
| `Field.Number(o)` | a number | `required`, `min`, `max`, `decimals` |
| `Field.Decimal(o)` | a [`Decimal`](Decimal.md) at a fixed scale | `required`, `min`, `max`, `decimals` (2 by default) |
| `Field.Bool(def, o)` | `true`/`false`, and SQL's `0`/`1` | |
| `Field.Date(o)` | `"YYYY-MM-DD"`, checked against the calendar | `required` |
| `Field.Time(o)` | `"HH:MM"` or `"HH:MM:SS"` | `required`, `min`, `max` |
| `Field.DateTime(o)` | `"YYYY-MM-DDTHH:MM"` or `"…:SS"` — a date and a time — with `Z` or `±HH:MM` when the moment has a zone, kept as written | `required`, `min`, `max` (local time only: a zoned value and a range are refused together, because a text order over moments is a wrong answer) |
| `Field.Bytes(o)` | a [`Bytes`](Bytes.md) — a file in a record | `required`, `max` (bytes) |
| `Field.Enum(values, def, o)` | one of `values` | `required` |
| `Field.List(item, o)` | an array, each entry through `item` — a `Field` or a `Record` class | `required`, `max` |
| `Field.Record(of, o)` | another record: the class, or `() => the class` for a shape that contains itself | `required` |

`as` is the column or key this field is called on the outside; `def` is what it
starts as.

**A field written by hand is a field**: an ordinary getter on the class is part of
what the record answers, and being read-only it is never written back.

## Setting a value

```js
const c = new Customer({ Name: "Ana" });
c.Balance = 10.567;                 // 10.57: rounded to what it holds
c.Category = "Other";               // throws, naming the two it accepts
```

**A value is checked where it is set**, which is the whole argument for the type:
the moment a bad value can exist is the moment to refuse it, and the message
names the field and what it accepts. `Field.Decimal` keeps the digits exact
through all of it — see [`Decimal`](Decimal.md).

## Reading a file

| | |
|---|---|
| `C.Load(json)` | a file, read **leniently**: what fits is taken and what does not is reported |
| `Problems` (ro) | what that `Load` could not take, as a list |
| `Validate()` | what is wrong with what the record holds **now** — a different question, and the one a form asks before saving |

```js
const read = Customer.Load(File.LoadJson(path));
if (read.Problems.length) Message.Warning("{0} problems in the file", read.Problems.length);
```

**A file is not a form.** A file written by an older version, by hand or by
another program should not stop a program from starting, so `Load` takes what it
can and says what it could not; a value being *set* is refused on the spot. The
two behaviours are deliberate and they are not the same call.

## Writing one out

| | |
|---|---|
| `Serialize([all])` | a plain object — **what differs from the start**, or everything with `true` |
| `toJSON()` | so `JSON.stringify(record)` and `File.SaveJson(path, record)` are the record itself, with a `Decimal` as its digits and a `Bytes` as base64 |
| `Clone()` | a copy, which is what a dialog edits so that Cancel costs nothing |

## XML

XML is a **document** and not a value — attributes, element order, namespaces
and mixed content have nowhere to go in a plain object — so a record maps onto
an element by declaring it. `static Xml` names the element; every field names
its own with `as`/`Naming`, and three options cover what XML adds:

| | |
|---|---|
| `attribute: true` | the field is an attribute of the element, not a child — `Field.Text({ attribute: true })` |
| `in: "Tasks"` | a list lives under that wrapper: `<Tasks><Task>…</Task></Tasks>` |
| `element: "Tag"` | the item name of a list of values — a record already knows its own, from its `Root` |

```js
class Task extends Record {
    static Xml = { Root: "Task" };
    static Fields = {
        UID:       Field.Int({ key: true }),
        Name:      Field.Text(),
        Start:     Field.DateTime(),
        Milestone: Field.Bool(),                 // written true/false; 0/1 read
        Links:     Field.List(Link),             // <PredecessorLink> repeated
    };
}

class Project extends Record {
    static Xml = { Root: "Project",
                   Namespace: ["http://schemas.microsoft.com/project",
                               "http://schemas.microsoft.com/project/2007"] };
    static Fields = {
        Author: Field.Text({ attribute: true }),
        Tasks:  Field.List(Task, { in: "Tasks" }),
    };
}

const p = Project.LoadXml(File.LoadXml("plan.xml"));   // lenient; Problems
p.Tasks[0].Name = "Analyse";
File.SaveXml("plan.xml", p.SaveXml(doc.Root));         // in place
const fresh = p.ToXml(true);                           // a new element, every field
```

**`toJSON` is `ToXml`, `Load` is `LoadXml`, and `SaveXml` is the pair neither
is.** `ToXml()` writes what differs from the field's start — a `key` excepted,
which is identity and is written either way, as `SaveXml` writes it —
`ToXml(true)` writes everything; `SaveXml(element)` writes into the tree it was
handed and touches **only** what the shape models, which is the road an
interchange file needs:

- unknown elements, foreign namespaces and comments stay exactly where they
  were, and a missing modelled element is inserted in declaration order among
  the modelled ones;
- a list is reconciled — an item is matched to an element by the record's
  `key` — key text for key text, a key at its starting value included, because
  `<UID>0</UID>` is a UID — or by position, unmatched elements are removed, new
  ones are added, and the array's order is the element order afterwards;
- a field at its starting value has its element removed rather than written —
  **except a `key`, which is identity and is written whatever it holds**, so
  the summary task's `UID 0` survives and the unmodelled children of the
  element it matched stay with it — and an empty list takes its wrapper with it
  when nothing else is in it.

`Table`'s *an int key of 0 is a row never saved* (`Save` inserts) is the
database's rule and does not reach XML: there is no INSERT here to assign one.

**LoadXml is lenient, like `Load`**, and reports what the shape does not model:
an unknown element or attribute goes on `Problems` with its path, a bad value
keeps the field at its start, and the root's name and namespace are checked —
`Namespace` as a string or a list, because an official schema and the files it
describes can disagree about the URI and both be right. What is reported is
never silently written back.

`static Xml` merges down the class chain the way `Fields` does. A class with no
`Root` is not an XML shape: `ToXml` and `SaveXml` refuse it, and `LoadXml` says
so in `Problems`. `Field.Bool` is written `true`/`false` (the XML Schema
spelling) and read from `true`/`false`/`1`/`0`; numbers are read with a dot and
never the desktop's comma.

## What goes wrong

- **A value was refused with a message naming the field.** That is the type
  working; the field says what it accepts.
- **A file half-loaded.** By design: read `Problems`.
- **`Validate()` was empty and saving still failed.** `Validate` is about what is
  held now; a database has its own constraints.
- **A `Decimal` came back as a number.** Something put a double in — through
  `JSON.parse` rather than `Load`, most likely.
- **A record inside a record recursed for ever.** `Field.Record(() => Class)` is
  the spelling for a shape that contains itself; a cycle in the *values* is
  refused rather than hung on.
- **`LoadXml` answered with `Problems` naming elements you do not know.** That
  is the shape saying what it does not model; the values it did take are there.
- **`SaveXml` refused with `<Other>` was expected.** It writes into an element
  of its own root, not into any element; `LoadXml` is the lenient one.
- **A list of values refused to be written.** `Field.List(Field.Text())` needs
  `{ element: "Name" }`: only a record knows its own element, from its `Root`.

## See also

[`Decimal`](Decimal.md) · [`Database`](Database.md), which maps a record onto a
table · [`File`](File.md) · [`examples/quote`](../../../examples/quote) ·
[../../plans/data-plan.md](../../plans/data-plan.md)
