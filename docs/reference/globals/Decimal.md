# Decimal

Exact base-10 arithmetic, with the ordinary operators. **This is what money is.**

```js
const price = new Decimal("19.99");
const total = price * qty + tax;             // exact, to the cent
```

A double cannot hold `19.99`, and three of them added up are a cent out often
enough to be noticed by the one person whose invoice it happened to. This type
holds the digits somebody wrote and does arithmetic on them.

## Every member

| | | |
|---|---|---|
| `new Decimal(value, [decimals])` | from text, a number or another decimal | [making one](#making-one) |
| `Abs()` | → its magnitude | [asking about one](#asking-about-one) |
| `IsExact` | whether it is what it says it is | [asking about one](#asking-about-one) |
| `Number()` | → the nearest double, **by name** | [leaving the type](#leaving-the-type) |
| `Round(decimals, [how])` | `"Away"` (default) `"Even"` `"Zero"` `"Up"` `"Down"` | [rounding](#rounding) |
| `Scale` | how many decimal places it carries | [asking about one](#asking-about-one) |
| `Sign` | `-1`, `0` or `1` | [asking about one](#asking-about-one) |
| `Trim()` | `2.50` → `2.5` | [rounding](#rounding) |
| `toJSON()` | its own text, so a file reads back as itself | [leaving the type](#leaving-the-type) |
| `toString()` | its own text, so `${d}` is exact | [leaving the type](#leaving-the-type) |
| `Decimal.Split(total, parts)` | pieces that add back up to the total, **exactly** | [splitting](#splitting) |

## Making one

| | |
|---|---|
| `new Decimal(value, [decimals])` | from **text**, a number or another decimal. `decimals` fixes the scale |

**Construct from text, not from a literal.** `new Decimal(0.1)` is already the
wrong number before anything can round it, and so is `1.005`: the double was
wrong when the source file was parsed. Everything that arrives as text — a field,
a JSON file, a database column — should stay text until it is a `Decimal`.

## The operators

`+ - * /`, `< > <= >=` and unary `-` all work, and they mix with ordinary numbers
and strings: `price * 3`, `price - "0.99"`. That is the whole reason this type is
worth having rather than a library of `add(a, b)` calls — the arithmetic in a
program reads like arithmetic.

## Rounding

| | |
|---|---|
| `Round(decimals, [how])` | `"Away"` (the default — the half goes away from zero, which is what an invoice does), `"Even"` (banker's), `"Zero"`, `"Up"`, `"Down"` |
| `Trim()` | drops trailing zeros: `2.50` → `2.5` |

**Round where the money is decided and not on the way to the screen**: a total
rounded for display and stored unrounded is a total that disagrees with itself
the next time it is added up.

## Asking about one

| | |
|---|---|
| `Scale` | how many decimal places it carries — `2` for money that came from `"19.99"` |
| `Sign` | `-1`, `0` or `1` |
| `Abs()` | its magnitude |
| `IsExact` | whether the value is exactly what its digits say, which a division may make false |

## Leaving the type

| | |
|---|---|
| `toString()` | its own text — which is why `${d}` in a template is exact and never a double's spelling |
| `toJSON()` | the same, so `JSON.stringify` writes the digits and **a decimal in a file reads back as itself**. A JSON *number* would be a double again |
| `Number()` | the nearest double, asked for **by name**: for a chart, a width, a percentage — anywhere the value stops being money |

The naming is the safety: nothing turns a decimal into a double by accident, and
the one place that does it says so.

## Splitting

| | |
|---|---|
| `Decimal.Split(total, parts)` | pieces that add back up to the total, **exactly** |

Three ways of 10.00 is not 3.33 three times, and the cent that is left over has
to go somewhere; this decides, so that the pieces and the total agree.

## What goes wrong

- **A total is a cent out.** A double got in: a literal, a `Number()`, a `+`
  with something already double.
- **`JSON.parse` gave back a number.** JSON has no decimal type; read the field
  as text and construct one — which is what a [`Record`](Record.md)'s
  `Field.Decimal` does for you.
- **A sum came out with four decimal places.** Multiplication adds scales;
  `Round(2)` where the money is decided.
- **A comparison with a string failed.** It should not: `price > "20"` works.
  A comparison with `NaN` is another matter, and that came from a double.

## See also

[`Locale`](Locale.md), which writes one for the user ·
[`Record`](Record.md), whose `Field.Decimal` keeps the type through a form ·
[`Database`](Database.md), which stores the digits ·
[`examples/quote`](../../../examples/quote)
