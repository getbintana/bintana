# Regex

A pattern, with nothing remembered between questions.

```js
const pair = new Regex("(?<key>\\w+)\\s*=\\s*(\\d+)");

pair.IsMatch(text)
const m = pair.Match(text);           // the first, or null
m.Value; m.Index; m.Length; m.Group("key"); m.Group(1); m.Groups[0]
for (const m of pair.Matches(text)) …
pair.Replace(text, "${key}")          // .NET substitution: $1, ${name}, $&, $$
pair.Split(text)
Regex.Escape(name)                    // a name as a literal inside a pattern
```

## Every member

| | |
|---|---|
| `new Regex(pattern, [options])` | a pattern. `options` is `{ IgnoreCase, Multiline, Singleline, Unicode, IgnorePatternWhitespace }` |
| `IsMatch(text)` | → whether it matches at all |
| `Match(text, [start])` | → the first match at or after `start`, or `null` |
| `Matches(text)` | → every match, for a `for…of` |
| `Replace(text, with, [count])` | → the text with the matches replaced. **All of them** unless a count says how many |
| `Split(text)` | → the pieces between the matches |
| `Regex.Escape(text)` | → the text as a **literal** inside a pattern |

**On a match**: `Value`, `Index`, `Length`, `Groups`, and `Group(n)` or
`Group("name")`.

## No `lastIndex`

**Nothing is remembered between questions**, which is why a `Regex` can be a
`const` at the top of a file and used from anywhere. A JavaScript `RegExp` with
`/g` carries a cursor, and the bug that comes of it — every second call failing,
or a loop that never ends — is a rite of passage this type does not have.

## Unicode

`Unicode` is JavaScript's `u`, and it is worth asking for: without it `\p{L}`
does **not** fail — it compiles and matches the literal text `p{L}` — and `.`
counts one UTF-16 unit, so an emoji is two matches rather than one.

```js
new Regex("\\p{L}+").IsMatch("ñ")                     // false, and silently
new Regex("\\p{L}+", { Unicode: true }).IsMatch("ñ")  // true
new Regex(".").Matches("🙂").length                    // 2
new Regex(".", { Unicode: true }).Matches("🙂").length // 1
```

## The engine, and the name that is gone

`RegExp` is **not in the language**: `close_hatches` takes the name, and
`RegExp.prototype.constructor` with it so `(/(?:)/).constructor` cannot hand the
function back. `/x/g` is syntax, so a literal still works and is the right way to
write a pattern that does not change; a pattern **built from a string** has one
spelling, and it is this one. `rad.js` captured the constructor before the name
went, which is what `Regex` is built on — see
[language.md](../../llm/language.md#what-is-not-installed).

## Replacing

`Replace` uses the .NET substitution syntax: `$1`, `${name}`, `$&` for the whole
match, `$$` for a dollar. A **function** may be given instead, and it is handed
the `Match` — which is how a replacement that has to look something up is
written.

## `Regex.Escape`

**The one that is easy to forget**: any pattern built around a name the program
did not choose needs it. A file called `a.b` matches `a?b` as a pattern and only
`a.b` as a literal, and a search box where somebody typed `(` is an exception
waiting to happen.

## What goes wrong

- **Every second call failed.** That is a `/g` `RegExp` kept between calls — a literal one, since the name is gone — and not this.
- **A user's search text threw.** `Regex.Escape`.
- **`\p{L}` matched nothing.** `Unicode` was not asked for, and the pattern meant the literal `p{L}`.
- **Only the first match was replaced.** It replaces all — unless a `count` said
  otherwise, or what was used was `String.replace` with a plain string.
- **A named group came back `undefined`.** It did not participate in that match;
  groups are per match.

## See also

[`Text`](Text.md) · [`Locale`](Locale.md), whose `Matches` is what a search box
usually wants instead
