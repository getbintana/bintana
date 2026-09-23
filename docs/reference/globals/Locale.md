# Locale

The user's language, and their way of writing numbers, money, dates and names.

Two jobs in one object, and they are worth telling apart: **the catalogue**,
which is how the words of an application reach a person in their own language,
and **the conventions**, which are how a number, an amount, a date and an order
are written where they live.

## Every member

**The catalogue**

| | | |
|---|---|---|
| `Available` | the catalogue names this project ships, sorted | [the catalogue](#the-catalogue) |
| `Context(ctxt, msgid, …args)` | gettext's `msgctxt`: part of the key, never shown | [the catalogue](#the-catalogue) |
| `Current` | the catalogue in use, `""` for none | [the catalogue](#the-catalogue) |
| `Plural(one, many, n, …args)` | the form `n` takes by the catalogue's own rule | [the catalogue](#the-catalogue) |
| `Read(path)` | a catalogue as data, losing nothing | [the catalogue](#the-catalogue) |
| `Text(msgid, …args)` | the catalogue's version, `{0}` filled in | [the catalogue](#the-catalogue) |

**The conventions**

| | | |
|---|---|---|
| `Compare(a, b)` | `-1`/`0`/`1`, in this desktop's order for names | [order and search](#order-and-search) |
| `Currency(value, [decimals \| options])` | money, with the symbol where this desktop puts it | [numbers and money](#numbers-and-money) |
| `Date(when, [format])` | a date or a time, written the way it is written here | [dates](#dates) |
| `DecimalPoint` | the character this desktop writes a decimal with | [numbers and money](#numbers-and-money) |
| `Matches(text, needle)` | whether a search for `needle` should find `text` | [order and search](#order-and-search) |
| `Number(value, [decimals \| options])` | grouped, with the desktop's separators | [numbers and money](#numbers-and-money) |
| `Parse(text, [options])` | → the `Decimal` the text says, or `null` | [numbers and money](#numbers-and-money) |

## The catalogue

| | |
|---|---|
| `Text(msgid, …args)` | the catalogue's version of a string, with `{0}`, `{1}` filled in from the arguments. **The msgid itself when there is no entry**, so an application with no catalogue at all still reads correctly |
| `Plural(one, many, n, …args)` | the form `n` takes **by the catalogue's own rule** — which is not *one or many* in every language, and is why this is not an `if` you write yourself. `n` also fills `{0}` |
| `Context(ctxt, msgid, …args)` | gettext's `msgctxt`, for the word that is not translated the same way twice — *Open* the verb on a button and *Open* the state of a file. The context is part of the key and is never shown |
| `Current` | which catalogue is in use, `""` for none. **Assigning reloads it, and affects only what is built afterwards** — a form already on screen keeps the words it was built with |
| `Available` | the catalogue names this project ships, sorted — what a language menu is built from |
| `Read(path)` | a catalogue as data, losing nothing: entries, contexts, plurals, comments and the fuzzy flags. What a translation editor reads |

**Most text needs none of these calls.** What a `.form` declares — a caption, a
tooltip, a placeholder, the items of a list — goes through the catalogue by
itself, because the loader knows which properties hold prose. `Locale.Text` is
for the sentences a program *composes*, and
[`Fill`](../widgets/Widget.md#words-on-it) is for the declared one that needs a
number in it.

## Numbers and money

| | |
|---|---|
| `Number(value, [decimals \| options])` | grouped, with this desktop's separators. As many decimals as the value has, unless told |
| `Currency(value, [decimals \| options])` | money, with the symbol where this desktop puts it — which is before the number in some places and after it in others |
| `Parse(text, [options])` | → a [`Decimal`](Decimal.md), or `null` when the text is not a number. **`null` and not a throw**: a field being typed into is not an error |
| `DecimalPoint` | the character a decimal is written with here, for the rare case that has to parse one back |

```js
Locale.Number(1234567.891)        // 1.234.567,891
Locale.Number(1234567.891, 2)     // 1.234.567,89
Locale.Number(km, { Decimals: 1, Suffix: " km" })   // 12,5 km
Locale.Currency(v, { Symbol: "US$" })               // US$ 1.234,56
Locale.Parse("1.234,56")          // → 1234.56
Locale.Parse("12,5 kg", { Suffix: " kg" })
```

**The options object is the same format a [`DecimalBox`](../widgets/DecimalBox.md)
keeps**, so a label and a field spell an amount the same way:
`{ Decimals, Group, Prefix, Suffix, Symbol, Before, Space, Currency }`. A unit is
format and not prose — a suffix that has to be translated goes through
[`Locale.Text`](#the-catalogue) at the call site.

**`Symbol` is another currency, and the side it goes on is still this desktop's.**
`{ Symbol: "US$" }` writes `US$ 1.234,56` here and `$1,234.56` on a US desktop,
which is what a finance app handling several currencies needs — the symbol and
the places are the currency's, the separators and the placement are the locale's,
and there is no table of currencies in the runtime.

**Both take a [`Decimal`](Decimal.md) and write it from its own digits**, never
through a double — which is the other half of the exact-money story and the
reason a total on screen and a total in the database are the same number.

## Dates

| | |
|---|---|
| `Date(when, [format])` | `"Date"` `"Time"` `"DateTime"` `"ISO"` `"Weekday"` `"Month"`. `when` is a `Date` **or** a `"YYYY-MM-DD"` string |

```js
Locale.Date("2026-12-25")             // 25/12/26
Locale.Date("2026-12-25", "Weekday")  // viernes
Locale.Date(new Date(), "DateTime")   // lun 31 ago 2026 14:05:09
```

**It takes a calendar date as it stands**, so nothing a [`Day`](Day.md) or a
`Field.Date` holds ever needs converting. Reaching for `new Date(y, m, d, 12)` to
get a month or a weekday out of one is the mistake this saves you — the noon is
there to dodge the time zone that borrowing an instant introduced, and the string
never had one.

## Order and search

| | |
|---|---|
| `Compare(a, b)` | `-1`, `0` or `1`, in the order this desktop puts names in. `localeCompare` is **refused** and its message points here: it compares code units and puts `Álvarez` after `Zapata` |
| `Matches(text, needle)` | whether a search for `needle` should find `text`, **accents folded**: `cordoba` finds `Córdoba` and `ver` finds `Echeverría`. `toLowerCase().includes()` does neither |

```js
rows.sort((a, b) => Locale.Compare(a.Name, b.Name));
```

## What goes wrong

- **A sort put the accented names at the end.** A plain `<`, or a bare `sort()`
  with no comparator — `localeCompare` refuses now and says so, but the other
  two are silent and give the same wrong order.
- **A search box could not find a name with an accent in it.** `Matches`.
- **The window kept the old language after switching.** Assigning `Current`
  affects what is built afterwards: rebuild the form, or restart.
- **A number came out with a dot where the user expects a comma.** `String(n)`
  instead of `Locale.Number`.
- **A total was a cent out.** A double got in; see [`Decimal`](Decimal.md).
- **A translated sentence had `{0}` in it.** Nothing filled it: the arguments go
  to `Text`, or the control's own `Fill`.

## See also

[`Decimal`](Decimal.md) · [`Day`](Day.md) ·
[resources.md](../../resources.md), for catalogues and what goes in one ·
[`examples/i18n`](../../../examples/i18n)
