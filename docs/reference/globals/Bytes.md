# Bytes

A file's contents, when they are not text.

What a [`File.Load`](File.md) cannot carry: a PNG, a PDF, a thumbnail in a
record, anything read to be written back out unchanged.

```js
const b = File.LoadBytes("logo.png");
b.Length                                  // 763
b.Slice(0, 8).ToHex()                     // "89504e470d0a1a0a" — the signature
File.SaveBytes("copy.png", b);
```

## Every member

| | | |
|---|---|---|
| `new Bytes([value])` | nothing, text, a list of numbers, or another `Bytes` | [making one](#making-one) |
| `Bytes.FromBase64(text)` | from base64, **refused** when the text is not that | [making one](#making-one) |
| `Bytes.FromHex(text)` | from hex, likewise | [making one](#making-one) |
| `At(index)` | → one byte, `0`–`255`. **Throws** past the end | [looking inside](#looking-inside) |
| `Concat(other, …)` | → a new one, end to end | [looking inside](#looking-inside) |
| `Equals(other)` | → byte for byte | [looking inside](#looking-inside) |
| `Length` (ro) | → how many bytes | [looking inside](#looking-inside) |
| `Slice(from, [count])` | → a new `Bytes`, clamped like a string's | [looking inside](#looking-inside) |
| `ToBase64()` | → as text | [leaving the type](#leaving-the-type) |
| `ToHex()` | → as text, lower-case | [leaving the type](#leaving-the-type) |
| `ToText()` | → the text it is, or a **throw** | [leaving the type](#leaving-the-type) |
| `toJSON()` | → base64, so a record carrying a file survives a save | [leaving the type](#leaving-the-type) |
| `toString()` | → `"Bytes(763)"` — a description, **not** the content | [leaving the type](#leaving-the-type) |

## Making one

| | |
|---|---|
| `new Bytes([value])` | nothing (empty), text (its **UTF-8**), a list of numbers `0`–`255`, or another `Bytes` (a copy) |
| `Bytes.FromBase64(text)`, `Bytes.FromHex(text)` | **refused, not guessed**, when the text is not that — a base64 string with a space in it is a mistake somebody should hear about |

Where they come from in practice: [`File.LoadBytes`](File.md),
[`Http`](Http.md)'s answer, and a [`Record`](Record.md) field that holds a
picture.

## Looking inside

| | |
|---|---|
| `Length` (ro) | how many bytes |
| `At(index)` | one byte as a number, `0`–`255`. **Throws** past the end rather than answering `undefined` |
| `Slice(from, [count])` | a new `Bytes`; **clamped** like a string's, and a negative `from` counts from the end |
| `Concat(other, …)` | a new one, end to end |
| `Equals(other)` | byte for byte. `==` compares two objects by identity, so **this is the only comparison there is** |

**It cannot be changed.** There is no `Set`, no resize, no writing into it: every
operation answers a new `Bytes`. That is what makes it safe to hand one to a
record, keep it, and hand it to somebody else — a string's bargain, and the
reason a thumbnail in a record cannot change under the record's feet.

## Leaving the type

| | |
|---|---|
| `ToText()` | the text it is, or a **throw** when it is not valid UTF-8 — never the replacement character, which is a corruption that travels |
| `ToBase64()` | as base64 text |
| `ToHex()` | as hex, lower-case, the way a digest is written |
| `toJSON()` | base64, so a record carrying a file survives `File.SaveJson` |
| `toString()` | `"Bytes(763)"` — **a description and not the content**, deliberately: a JPEG interpolated into a log line by accident is a megabyte of noise that reads as if it had worked |

**Text and bytes convert explicitly, in both directions**: `new Bytes(text)`
encodes UTF-8 and `ToText()` decodes it.

## What goes wrong

- **`${bytes}` printed `Bytes(763)`.** On purpose; `ToText()` or `ToHex()` is
  what was meant.
- **`a == b` was false for two identical files.** Identity, not content:
  `Equals`.
- **`ToText()` threw.** It is not UTF-8 — which usually means it is not text.
- **`FromBase64` refused.** The string has whitespace or padding trouble;
  guessing would be worse.

## What it does not do

- **No mutation, no `ArrayBuffer`, no typed arrays.** One class with the
  operations an application performs on a file, and no view/buffer distinction to
  learn.

## See also

[`File`](File.md) · [`Hash`](Hash.md) · [`Http`](Http.md) ·
[`Record`](Record.md)
