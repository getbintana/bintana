# ISSUE: a regular expression does not say where it matched

## What the application needed

A scan that continues *from* a match. The concrete case was the IDE reading a
record's shape out of a class's own source: find the `static Fields` block and
walk its keys, counting the braces -- and the block's own values are braces
too (`Field.Text({ max: 80 })`), so the walk has to know where the block
starts.

## What I wrote instead

The position was found by other means, and the word for "where" was not needed:

```js
const at   = code.indexOf("static Fields");
const open = code.indexOf("{", at);
```

which is the same answer twice, and which cannot use a pattern at all -- the
declaration can be spelled with spaces around the `=`, and the text search is
the one that does not care.

## The code I wish I could have written

```js
const found = /static\s+Fields\s*=\s*\{/.exec(source);
// and then from where it matched:
for (let i = found.index; i < source.length; i++) { ... }
```

## Why the existing words do not cover it

`Regex.Match(source)` answers **what** it matched -- `Group(1)`, `Group(2)` --
and **not where**: a match carries no `index` and no `length`, and `Regex`
publishes `Escape`, `IsMatch`, `Match`, `Matches`, `Pattern`, `Replace` and
`Split` (`api.json`). So a walk that has to continue from a match cannot: it
has to find the position again by another road.

`Replace` and `Split` answer in the same words and hide the gap, because
neither needs the position; `Matches` answers with a list of what matched,
which is enough to count and not enough to locate.

## Prior art

JavaScript's `RegExp.prototype.exec` returns an array with `index` and
`input`, and `String.prototype.match`, `matchAll` and `replace` speak in the
same words. Python's `re.Match` carries `start()` and `end()`. .NET's `Match`
carries `Index` and `Length`. PCRE's `pcre2_match_data` carries the offsets.

## How much it mattered

It works, but a part of it is noticeably worse: a parser that has to walk a
source file from a match finds the position by hand, and finds it with a
search that cannot be a pattern.
