# DecimalBox

A number with a fixed number of places, held **exactly**.

A [`SpinBox`](SpinBox.md) holds a double, which is the right tool for a quantity
that is only ever compared with itself. This one holds a
[`Decimal`](../../llm/library.md#decimal), which is what money is, and what a
duration, a weight or a rate is when the program totals them: `19.99 * 3` is
`59.97` and not `59.97000000000001`. It shows the number with this desktop's
separators, a unit and, when asked, a currency.

It is a `Widget` and a control like any other, so everything on
[Widget](Widget.md) is on it too; what follows is what is its own.

## Every member

| | | |
|---|---|---|
| `Currency` | the symbol when `Format` is `"Currency"` | [money, and units](#money-and-units) |
| `Decimals` | places shown **and held**. Default `2` | [the value](#the-value) |
| `Format` | `Number` or `Currency`. Default `"Number"` | [money, and units](#money-and-units) |
| `Group` | thousands separators, this desktop's rule. Default `false` | [the value](#the-value) |
| `Max` | the ceiling, a `Decimal` | [the range](#the-range) |
| `Min` | the floor, likewise | [the range](#the-range) |
| `Prefix` | text outside the number | [money, and units](#money-and-units) |
| `Step` | what one press of an arrow moves, a `Decimal`. Default `1` | [the range](#the-range) |
| `Suffix` | text outside it | [money, and units](#money-and-units) |
| `Text` (ro) | what the field says, formatted | [the value](#the-value) |
| `Value` | the number, a `Decimal` | [the value](#the-value) |
| `Wrap` | past `Max` it comes back to `Min` | [the range](#the-range) |
| **event** `Activate()` | Enter in the field | [the value](#the-value) |
| **event** `Change()` | the value changed, **including from code** | [the value](#the-value) |

## When it is not a `DecimalBox`

- **The number is a measurement and never totalised** — a temperature, a
  position, a zoom: [`SpinBox`](SpinBox.md), which is the same control over a
  double and slightly cheaper.
- **The number is chosen by feel** — [`Slider`](Slider.md).
- **The value is a date or a time of day** — [`DatePicker`](DatePicker.md), or a
  `Time` in a [`TextBox`](TextBox.md).
- **The unit is a word that must be translated** — still this control, with the
  unit assigned from code: see below.

## The value

| | |
|---|---|
| `Value` | the number, a `Decimal`. Assigning a `Decimal`, a number or text; **machine text first** (`"1234.567"`, which is what a `.form` and `Decimal.toJSON()` carry) and this desktop's spelling second (`"1.234,56"`) |
| `Text` (ro) | what the field says, with the separators, the grouping and the unit |
| `Decimals` | the scale: places shown **and held**. `0` is whole numbers, up to `9` |
| `Group` | thousands separators. **Off by default**, because a separator appearing while a number is typed is in the way |
| **event** `Change()` | the value changed — stepped, typed, or **assigned from code** |
| **event** `Activate()` | Enter in the field |

**What it holds is what it shows.** Assigning `19.995` to a box with `Decimals:
2` holds `20.00`: the field's scale is the value's, and a program that needs to
keep more precision than it can display keeps it outside the field. That is also
what keeps a step honest — an arrow moves by `Step` and the result is a value at
the field's own scale.

**A word is refused.** `Value = "hola"` throws and leaves the value it had, the
way every setter here does.

## Money, and units

| | |
|---|---|
| `Format` | `"Number"` or `"Currency"` |
| `Currency` | the symbol. `""` is **this desktop's** currency, with the side and the places `localeconv` says; `"US$"` is another one, and where it goes is still this desktop's rule — `US$ 1.234,56` here, `$1,234.56` there, and the program says neither |
| `Prefix` | text before the number: `"aprox. "` |
| `Suffix` | text after it: `" kg"`, `" h"`, `" km/h"` |
| `Decimals` | with `Currency` and no `Decimals`, the currency's own places: two nearly everywhere, zero for yen |

```js
Total.Format   = "Currency";            // the desktop's money
Price.Currency = "US$";                 // another one, placed the same way
Weight.Suffix  = " kg";                 // a unit
Lap.Suffix     = " h"; Lap.Decimals = 1;
```

**A finance app with several currencies sets the symbol and nothing else.** The
separators, the grouping and the side a symbol goes on are this desktop's; the
symbol and the number of places are the currency's, and there is no table of
currencies in the runtime — the program has the business rules anyway, and
[`Locale.Number`](../../llm/library.md#locale) with an options object is how the
same amount is written in a label or a report.

**A unit is not prose.** `Suffix` is format, like `Style` or `Font`, and the
loader does not put it through a catalogue: if the word has to be translated,
assign it from code — `this.Weight.Suffix = Locale.Text(" kg")` — and it is
collected and translated like any other caption. Declaring it prose would put
`kg`, `€` and `%` in front of a translator and let a msgid collision translate
one of them.

**A unit that changes with the number is the same thing with a signal, and the
signal is `Change`.** One pear is not three pears, so the suffix is set where the
value changes — and both forms go through
[`Locale.Plural`](../../llm/library.md#locale), which means the catalogue's own
`Plural-Forms` rule picks one, the extractor collects both, and no new API was
needed:

```js
Qty_Change() {
    if (!this.Qty) return;      // Change fires while the .form is loading
    this.Qty.Suffix = Locale.Plural(" pera", " peras", this.Qty.Value);
}
```

The guard is not a precaution: a `Value` declared in the `.form` raises `Change`
before the form's controls are bound, which is the trap every `.form` property
event has, and `this.Qty` is still `undefined` there.

**What the field cannot do is display arbitrary prose, and that is on purpose.**
A handler that returned the whole text — `"3 peras"` — would have nothing to read
a typed value back with, so a `Format` event would need a `Parse` event beside it
and the program would own both directions of a format the locale knows. A suffix
set from `Change` is the plural case with neither, and a value that is only ever
*shown* and never edited is a [`Label`](Label.md).

## The range

| | |
|---|---|
| `Min` | the floor, as a `Decimal`. Default `-1000000000000000` |
| `Max` | the ceiling, likewise. Default `1000000000000000` |
| `Step` | what one press of an arrow moves. Default `1` |
| `Wrap` | past `Max` comes back to `Min` |

**The order matters, as it does on a `SpinBox`**: a `.form` applies properties in
the order it lists them, so `Min`/`Max` declared after `Value` clamp the number
that was already set. Declaring them first is the habit.

## What goes wrong

- **The number came back with the wrong places.** `Decimals` is the field's
  scale: `19.995` at `2` is `20.00`.
- **The separator appeared while typing.** `Group`, or the locale's own rule
  reading a number you meant as machine text: a `.form` carries `"1234.567"`, and
  only text that is not machine-readable falls through to the locale parser.
- **`Currency = "USD"` printed `USD`.** The property is the **symbol**, not the
  ISO code: there is no currency table in the runtime, and `Money.Symbol("USD")`
  is the program's own — see [money, and units](#money-and-units).
- **The unit is in English in every language.** `Suffix` is not prose; assign
  `Locale.Text` from code — or `Locale.Plural` from `Change` when it changes with
  the number.

## What it does not do

- **No arbitrary masks.** A phone number or an account number is a
  [`TextBox`](TextBox.md): those are text that happens to be digits.
- **No hidden precision.** What it holds is what it shows.

## See also

[`SpinBox`](SpinBox.md) · [`Slider`](Slider.md) · [`TextBox`](TextBox.md) ·
[`Decimal`](../../llm/library.md#decimal) · [`Locale`](../../llm/library.md#locale)
