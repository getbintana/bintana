# Hash

A checksum, of a string or of a file.

```js
Hash.Sha256("abc")                       // ba7816bf…f20015ad
File.Hash(path)                          // the same digest, over the file
```

## Every member

| | | |
|---|---|---|
| `Md5(v)` | the digest as lower-case hex | [the four](#the-four) |
| `Sha1(v)` | likewise | [the four](#the-four) |
| `Sha256(v)` | likewise — the one to reach for | [the four](#the-four) |
| `Sha512(v)` | likewise | [the four](#the-four) |

[`File.Hash(path, [algorithm])`](File.md#asking-about-one) is the file's digest
and lives there, with the rest of what a file answers.

## The four

| | |
|---|---|
| `Md5(v)` | the MD5 digest. Old and broken for anything adversarial; fine for a cache key or an etag somebody else chose |
| `Sha1(v)` | likewise, and likewise |
| `Sha256(v)` | **the one to reach for** unless something else decided |
| `Sha512(v)` | when what you are comparing against used it |

`v` is text — hashed as its **UTF-8** — or [`Bytes`](Bytes.md), hashed as the
bytes it is.

**What is hashed is the text's UTF-8 bytes**, which is what every other tool means
by the hash of a string: `Hash.Sha256("abc")` is what `sha256sum` says about a
file holding `abc`, and `Hash.Sha256("ñandú")` agrees too.

Something that is **not** text has to become text first — `JSON.stringify`, a
[`Decimal`](Decimal.md)'s own digits — and *which* text is part of what was
hashed, so that is the caller's decision and not a default this could pick.

## A hash is not a password

These are **checksums**: same input, same digest, as fast as the machine can go.
That is what makes them right for comparing a download against a published
digest, keying a cache, telling two files apart or noticing that a file changed —
and **wrong for storing what somebody typed**. There is no salt, no work factor,
and no `bcrypt` here.

## What goes wrong

- **The digest did not match `sha256sum`.** Something other than the UTF-8 of the
  text was hashed — a trailing newline the file has and the string does not, most
  often.
- **A JPEG hashed to the wrong thing.** `File.Load` answers a string; a file that
  is not text is [`File.Hash`](File.md#asking-about-one) or
  [`Bytes`](Bytes.md).
- **Hashing a video ate the memory.** It does not — `File.Hash` reads in blocks —
  but `Hash.Sha256(File.LoadBytes(path))` holds the whole thing.

## See also

[`File`](File.md) · [`Bytes`](Bytes.md)
