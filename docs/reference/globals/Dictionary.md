# Dictionary

What a bag of data holds.

`for…in` recites the keys of an object; this counts them, lists them and asks
about them — the five questions `Object.keys` and friends used to answer, which
are not part of this language.

## Every member

| | |
|---|---|
| `Count(bag)` | → how many keys |
| `Entries(bag)` | → `[{ Key, Value }, …]` |
| `Has(bag, key)` | → whether that key is there |
| `Keys(bag)` | → the keys |
| `Values(bag)` | → the values |

## When to reach for it

```js
for (const key in settings) applyOne(key, settings[key]);
Dictionary.Keys(bag).sort()
Dictionary.Count(bag)
```

`for…in` forgives an absent bag: reciting `undefined` is zero turns, and it does
not recite what an object inherits — `toString` and its siblings are
non-enumerable, which is the engine's doing rather than this language's. Reach
for `Dictionary` when the answer is a **list** or a **number** rather than a
loop.

**And reach for it when anything might have written to `Object.prototype`.** An
ordinary assignment there still works — `freeze`, `seal` and `preventExtensions`
went with the rest of `Object`'s statics, so nothing can lock it or ask whether
somebody already did — and from that moment `for…in` recites the addition over
every bag in the program. `Dictionary.Keys` does not: it is `Object.keys`, own
and enumerable, captured before the name was taken away. See
[`llm/language.md`](../../llm/language.md#reading-a-bag-of-properties).

**When the keys are numbers, use a `Map`**: an object's keys are strings, and a
bag keyed by id is a bag that turns `12` into `"12"` behind you.

**When the bag has a shape**, use a [`Record`](Record.md): fields that are
declared are fields that are checked, and a bag of unchecked keys is what that
type exists to replace.

## What goes wrong

- **`Object.keys` is not a function.** It is not part of the language; this is.
- **A numeric key came back as a string.** Objects do that: `Map`.
- **The order surprised somebody.** `Keys` answers in the object's own order;
  sort it if the order matters.

## See also

[`Record`](Record.md) · [language.md](../../llm/language.md), for what else is
deliberately not in the language
