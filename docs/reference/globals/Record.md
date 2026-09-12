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

**On the class**

| | |
|---|---|
| `static Fields` | the shape: a name and a `Field` for each |
| `static Naming` | how a field's name becomes a column: `same`, `lower` or `snake` |

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

## See also

[`Decimal`](Decimal.md) · [`Database`](Database.md), which maps a record onto a
table · [`File`](File.md) · [`examples/quote`](../../../examples/quote) ·
[data-plan.md](../../data-plan.md)
