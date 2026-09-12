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

`for…in` is safe here — nothing can put anything on a prototype any more — and it
forgives an absent bag: reciting `undefined` is zero turns. Reach for
`Dictionary` when the answer is a **list** or a **number** rather than a loop.

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
