# Randomness, HMAC and compression: a plan

**Part A is built, and Part B's stage 1 (`Gzip`) with it; zip (stages 2 and 3)
is waiting for a caller.** What the first draft guessed and the build corrected is
marked *built* where it happened, and the owner's five questions are answered at
the end as decisions. Two small families the runtime does not have, planned together
because they share the same frontier (pure computation over `Bytes`, no
callbacks, so both are legal in a `Task`) and the same hazard (a call that
*looks* like it did the job and silently did not). Stage 0 of each is a
measurement, and the plan is ordered so that the cheap, dependency-free half of
each ships first and the expensive half waits for a caller.

**Read this before the stages: nothing in this tree asks for either yet.**
`AGENTS.md` says the count of copies is the ticket, and here the count is
measured, not guessed:

| Wanted | Callers found in `ide/ lib/ examples/ tests/ runtime/js/` |
|---|---|
| a secure random | **0.** The only randomness is `Math.random` in `examples/charts` (fake chart data, where it is right) |
| an HMAC | **0** |
| gzip / deflate | **0.** |
| zip | **0.** `Ide.Exporter` shells out to `tar -cf` (uncompressed, and its one `Exec` is the precedent `bundle-plan.md` calls fine) |

So this is a plan for *capability an application author will hit*, not a
cleanup of copies — the opposite of how `lib/dialog` earned its place. The
argument for doing it anyway is the shape of the gap: every one of these is
"`Exec(["curl", …])` and say so out loud" (`library.md`'s own words), and a
secure token made from `Math.random` is not an inconvenience but a wrong answer
that looks right. If that argument does not carry, **stage 1 alone** is the part
worth building on spec; the rest waits for the first project that needs it.

## Part A — `Random`, `Hash.Hmac`

### What is missing, measured

`grep -rn "getrandom\|urandom\|g_random\|arc4random" runtime/src` answers
nothing: **the runtime has no entropy source at all**, so the only random a
program can reach is the language's `Math.random`, which is not one to make a
token, a session id or a nonce from. `Hash` is checksums only and says so
(*"There is no salt, no work factor and no `bcrypt` here"*); no keyed form
exists, so signing a webhook or verifying one (the `Http.Server` case) is a
child process.

### The design

```js
Random.Bytes(32)                       // Bytes, 32 of them, from the OS
Random.Int(1, 6)                       // an integer in [1, 6], inclusive, unbiased
Random.Uuid()                          // "3f1c…-4…-b…" a version 4
Hash.Hmac(key, message)                // hex, Sha256
Hash.Hmac(key, message, "Sha512")      // the algorithms Hash already has
```

- **`Random` is its own global and not a member of `Math`**, because `Math` is
  the language's and a second `random` beside the weak one is the wrong place
  to say *this is the secure one*. A name that says what it is: `Random.Bytes`
  is the primitive, and `Int` and `Uuid` are built on it in the same file.
- **The source is the operating system's**, never a generator of our own and
  never GLib's `g_random_*` (a Mersenne Twister: fine for shuffling a playlist,
  wrong for a token, and the one thing a reader would assume it was). Linux
  `getrandom(2)` in a loop (a call may return fewer bytes than asked),
  `BCryptGenRandom` on Windows, `arc4random_buf` on macOS. **The Windows and
  macOS branches cannot be compiled here** — the same rule as every platform
  guard in `AGENTS.md`: keep each as small as it can be and put the *why*
  beside it, since CI's log names a line and not a reason. A source that fails
  **throws** and never falls back to a weaker one; that is the one place a
  silent fallback is the bug.
- **`Int(lo, hi)` is rejection sampling**, not `r % span`, which is biased
  whenever the span does not divide the range — the mistake worth refusing by
  construction. It works in the range a JavaScript number holds exactly, so
  **a span past 2^53 is refused** with a sentence rather than rounded; `lo > hi`,
  NaN, Infinity and a non-integer are refused through `bta_to_number`/
  `bta_to_int`, naming the call — a bare `JS_ToInt32` would take `"abc"` for 0,
  which is the trap `AGENTS.md` records twenty-eight times.
- **`Bytes(n)`'s `n` is capped** (1 MiB) and `0` answers an empty `Bytes`. An
  empty `Bytes` carries `NULL` on purpose, so the zero case goes through
  `bta_bytes_new(ctx, NULL, 0)` and **never a `memcpy` of a `NULL`** — the
  formal-UB note in `AGENTS.md`.
- **`Uuid()` is built from `Random.Bytes(16)` by hand** (version nibble 4,
  variant `10xx`), five lines. `g_uuid_string_random` exists, but where it
  gets its bytes is exactly the thing this part refuses to assume; verify
  against GLib's source before ever swapping it in. **A time-ordered v7 is not
  in v1**, though it is the better key for `Table` (a v4 scatters an index):
  it is an open question below, since it adds a clock to a function whose whole
  virtue is having none.
- **`Hash.Hmac(key, message, [algorithm])`** sits beside the digests and shares
  `HASHES`. `GHmac` takes the four the table has. Argument order is
  *(key, message)*, the order RFC 2104 and every language but PHP use, and the
  default is `"Sha256"`, as `File.Hash` has it. **Key and message are text
  (UTF-8) or `Bytes`**, exactly like `Hash.Sha256(v)`; the answer is hex, and
  `Bytes.FromHex` is the way to the raw bytes — no second return type.
- **A keyed digest has one famous footgun, which is the comparison.** Checking
  a signature with `===` leaks how many leading characters were right through
  timing. A `Hash.Equal(a, b)` that compares in constant time is the other half
  of the feature and **ships with it**, or the docs have to say *do not compare
  these*, which nobody reads. Its name is an open question (below): `Equal`
  invites using it for ordinary strings, where `===` is right.
- **Nothing here is password storage and the page says so again.** PBKDF2 over
  `GHmac` is thirty lines and a work factor, and **is deliberately not in this
  plan**: a function that stores passwords is a promise about the whole
  ceremony (salt, parameters stored beside the hash, upgrade path) that a
  single call cannot keep. It is written down with the trigger that reopens it
  — an application that stores a password — the way `Locale.Sort` and
  `decimal_avg` are.
- **Both are legal in a `Task`.** `task_delete` removes what *calls back* (five
  process-global lists) and none of these has a list or a callback — `Hash` is
  already there for the same reason. **Install `Random` in the worker's global
  too and assert it**, since a global missing from `bta_task.c`'s prelude is
  `not a function` at call time and not at load.

### Where it goes

`Hmac` beside `Hash` in `bta_sys.c`. `Random` is small enough to want a file of
its own (`bta_random.c`; `bta_sys.c` is past four thousand lines), which costs
two registrations that fail silently if forgotten: the file has to be in
`RUNTIME_C_SOURCES` **and** in what `tools/extract_signatures.cmake` reads, or
every `Random` member is "undescribed" and `tests/api.sh` goes red — which is
the check working, and a thing to remember when it does.

### Stages

**Built, in one commit: 1, below -- and every name in it.**

0. **Nothing to measure but the platform answers.** Confirm `getrandom` is in
   the floor this tree builds against (glibc 2.25, so yes on the CI's Ubuntu
   24.04 and this Fedora) and write the Windows/macOS branches blind.
1. **`Random.Bytes`, `Int`, `Uuid`, `Hash.Hmac`, and the constant-time compare
   once its name is settled.** One commit, one `bta_sys.c`/`bta_random.c`.
2. *Waiting for a caller:* `Uuid` v7, PBKDF2.

### Tests: known answers, not agreement

**An oracle that shares its source with the thing it checks agrees with it, bugs
included** (the eighth patch's lesson). So no test of the form *`Hmac(k, m)`
equals what `Hmac` returned yesterday*.

- **HMAC against published vectors:** RFC 4231 test cases 1, 2 and **6** (a key
  longer than the block size, the case an implementation gets wrong) for Sha256
  and Sha512, and RFC 2202 for Sha1 and Md5. An empty key and an empty message
  are cases of their own. A `Bytes` key and the same key as text agree.
- **Random can only be tested by what it must never do:** length exact, 0 gives
  empty, two calls differ (32 bytes colliding is 2^-256), a cap refusal, a
  non-integer refusal. `Int(5, 5)` is 5, and `Int` over a span of two covers
  both ends within a few hundred draws — a bound, never a distribution
  assertion, which would be the flaky kind. `Uuid()` matches
  `/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/`
  and a thousand of them are distinct.
- **In a `Task`:** the same three calls from inside a worker.
- **Under `tests/asan.sh`:** worth the run, with the usual caveat that a short
  `JSValue` string is invisible to it — read the C.

### Documents this touches

`library.md`'s `Hash` section and a new `Random` section in `bintana-docs`;
`docs/reference/globals/Random.md` and `Hash.md`; `GLOBAL_SECTIONS` and
`GLOBAL_PAGE_OWNERS` in `bintana-docs/check/Check.js` for the new global;
`./tools/apijson.sh`; and an `AGENTS.md` note on whatever the build taught.

## Part B — compression

### Two corrections to the pitch

The first draft of this plan said compression "unblocks `bundle-plan`". **It
does not**: `bundle-plan.md` specifies *one uncompressed ustar* with a minimal
writer in its own `bta_bundle.c` and says *no compression in v1* — `.jsc` and
forms are kilobytes, the icons dominate. And `Ide.Exporter`'s `tar` is the
precedent that shelling out for an export is fine. So the honest callers are
**formats that are zip** — `.docx`, `.xlsx`, `.odt`, `.epub`, `.jar` — and
**`.gz` files and bodies**, read by an application that already has `Xml`.

### What the engine already has, measured

Probed with a 60-line C program over `gio` on this machine, a 47 MB file of
numbers (12.7 MB gzipped):

| | |
|---|---|
| `GZlibCompressor` (gzip, level 6) | 47 MB in **~960 ms** (~49 MB/s); the system `gzip -6` takes 1060 ms |
| `GZlibDecompressor` | the same 47 MB in **~90 ms** (~500 MB/s) |
| a **truncated** gzip | *error* (`Need more input`) — correct |
| **two members concatenated** (`cat a.gz b.gz`, which is valid gzip and what `gzip -c >>` makes) | **decompressed only the first**: 6 bytes out of 12, *no error*, 26 of 52 input bytes consumed |
| `libz` | linked into `gio` already — **no new dependency, no new `pkg_check_modules`, no CI job** |
| `libarchive`, `libzip` | **neither installed here** (`pkg-config` says so) |

Three things fall out, in order of how much they matter:

1. **The multi-member result is the whole stage-0 finding.** A decompressor that
   returns half the data and success is the exact failure this repository keeps
   recording (*a refusal that nothing reads is a feature that is quietly not
   there*; `Exec.Wait` stopping at the first NUL). `Gzip.Decompress` must
   **loop until the input is consumed** and throw if bytes remain that are not a
   member, and a test holds both. The other direction is exactly as bad:
   returning what was decoded of a truncated stream. It throws, naming how far
   it got.
2. **The dependency question answers itself for gzip and not for zip.** GIO has
   no zip, and the two libraries that do are not on this machine — which makes an
   optional-dependency build a branch **nobody here can compile**, the
   Windows-port problem again. Hence stage 2 below is our own reader, and the
   decision is argued there rather than assumed.
3. **Speed says what is a main-thread call.** Decompressing 47 MB is 90 ms;
   compressing it is a second. Fine for a settings file, a freeze for a
   document. The page says so and points at `Task`, which can run these because
   they have no callbacks.

### The design

```js
const z = Gzip.Compress(bytesOrText)           // Bytes
Gzip.Compress(text, { Level: 9 })              // 1..9, default 6
const b = Gzip.Decompress(bytes)               // Bytes
Gzip.Decompress(bytes, { MaxSize: 1 << 30 })   // refuses to grow past it

Gzip.CompressFile(src, dst)                    // streams, 64 KB at a time
Gzip.DecompressFile(src, dst)
```

- **A value in, a value out**, like `File.Load` and `Bytes`: the language has no
  stream type and this is not the place to invent one. The file verbs exist
  because the value verbs cannot take a video — `File.Hash` is the model, read
  in blocks so the cost is 64 KB and not the file.
- **`MaxSize` has a default, and the default is the point.** A few kilobytes of
  gzip expand to gigabytes; `Decompress` on bytes that came off the network is
  the textbook way to end a process. The default is a number this plan picks
  from the measurement and writes down (256 MiB), the option raises it, and a
  refusal says *how much it had produced when it stopped*. `DecompressFile` has
  the same cap, since a file is as untrusted as a body.
- **`Gzip` only; zlib and raw deflate are not published.** Three framings of
  one algorithm are three globals nobody asked for. Raw deflate is needed
  *inside* zip and stays inside it. **A key that changes what the call is is
  another call** (the `Printer.Send`/`ToFile` lesson), so if a caller ever wants
  zlib framing it is `Zlib.*`, not a `Format` option.
- **Text in is its UTF-8; text out is `Bytes.ToText()`** — no `DecompressText`.
  One conversion, in one place, where it can throw on bytes that are not text.
- **Errors name the thing**: *`Gzip.Decompress: not gzip data (no magic bytes)`*,
  *`… truncated after 1,204 of … bytes`*, *`… output exceeds MaxSize`* — and
  every conversion of an argument is done **before** anything is written, so a
  refused `CompressFile` leaves no partial destination. **Writing progressively
  is the PDF trap**: a half-written `.gz` looks like an export that worked, so
  the file verbs write a temporary beside the destination and rename over it,
  as `File.Save` does, and remove it on failure.
- **Every conversion failure is a refusal, not a skipped entry** — an
  `Options` object with a `Level` that is not a number throws rather than
  meaning 6.

### Zip: the expensive half, and why it is its own stage

A zip is not a stream but a directory at the *end* of the file plus entries that
may disagree with it, so reading one is parsing, and a hostile one is the
classic attack surface (**zip-slip**: an entry named `../../.ssh/authorized_keys`).
Writing one by hand is a few hundred lines of C. The two honest options:

| | Our own reader/writer over `GZlibCompressor` RAW | optional `libzip` |
|---|---|---|
| New dependency | none | an optional one, **not installed here** |
| Can this machine compile and test it | yes | **no** — the `no-vte`/`no-libxml` shape: a CI job nobody can reproduce locally |
| Windows, macOS | identical | one more package per platform |
| Corners | ours to get right: zip64, data descriptors, encryption, names | the library's |
| CRC-32 | 15 lines (`GZlibCompressor` does not expose it); check against `"123456789"` = `0xCBF43926` | the library's |

**Recommendation: our own, with the corner list written down as refusals**,
because the doctrine here is *standard formats, invent none* (zip is one) and
*an oracle nobody can run is a claim*. Both halves can be checked against tools
that **are** on this machine — `zip`, `unzip`, `zipinfo` — which is a real
external oracle, unlike a round trip through our own code.

- **The reader trusts the central directory and nothing else.** Local headers
  and data descriptors are read only to find the data; sizes and the CRC come
  from the directory, and **the CRC is verified on every `Read`** — an entry
  whose bytes do not match is a throw, not a wrong answer.
- **Refused in v1, with a sentence each that names the feature**: encryption
  (traditional and AES), zip64 (past 4 GiB or 65,535 entries), multi-disk
  archives, and any method other than *stored* and *deflate*. A refusal is a
  deadline that states its expiry (the `Task` writes lesson), so each names what
  reopens it.
- **Zip-slip is refused at the verb, and the road is `File.Within`**, which this
  tree already has: `Extract` and `ExtractAll` resolve every name under the
  destination and refuse one that leaves it, an absolute path, a drive letter,
  and a backslash that Windows would read as a separator. **Names are never
  passed to the disk unexamined, in either direction.**
- **A total-size cap on `ExtractAll`**, as `MaxSize` is on one gzip: the bomb
  is the same and a zip is the more usual carrier of it.
- **Names are UTF-8 when bit 11 is set and CP437 when it is not.** v1 reads the
  first as UTF-8 and the second **as UTF-8 too**, and says so; a table of code
  pages is a second parser for a minority of files. Reopened by a file that
  shows it.

```js
const zip = Zip.Open(path)                  // reads the directory; the data is mapped, not loaded
zip.Entries                                 // [{ Name, Size, Compressed, Modified, IsDir }]
zip.Read("word/document.xml")               // Bytes, CRC checked
zip.Extract("media/a.png", "/tmp/a.png")    // one file, under Within's rules
zip.ExtractAll(dir, { MaxSize })            // the whole archive, same
zip.Close()

const out = Zip.Create(path)
out.Add("hello.txt", "text or Bytes", { Store: true })
out.AddFile("data/a.png", "/some/a.png")    // streamed
out.Finish()                                // only now does the file exist
```

- **`Open` holds a `GMappedFile` released by the wrapper's finaliser**, which is
  the *wrapper-with-an-opaque-struct* shape (`Xml`, `HttpClient`), **not** one of
  the nine async job shapes — nothing is owed an answer. It still gets the
  usual audit question, *which exit path forgets to release*, and the entries
  it hands back are copies so a held `Entries` array outlives `Close()`.
  `Read` after `Close()` throws a sentence, as a removed `Xml` node does.
- **`Create` writes to a temporary and `Finish()` renames it into place.** A
  writer dropped without `Finish()` deletes its temporary — the unfinished zip
  must not be a file that opens. Entry names are checked on `Add` by the same
  rule as on extract, so the archive this runtime writes is one it would read.
- **Modified time is stored** in the DOS fields zip carries (two-second
  resolution, local time and no zone — a fact to state in the reference and to
  test across a day boundary), and **a mode is not**: `Extract` writes
  ordinary files, and the one case that needs the bit (an executable) is
  `File`'s business. Said now so it is not rediscovered as a bug.
- **Both are legal in a `Task`** (no callbacks, no lists), and that is where an
  archive of any size belongs. `Zip.Open` returning a wrapper means the handle
  stays inside the thread that made it; asserted, not assumed.

### Stages

**Stage 1 is built; 2 and 3 are not, and wait for the first application that reads or writes a zip** -- which is what the examples are for.

0. **Spike: gzip's two failure shapes.** Done in this plan (the table above);
   stage 1 turns the multi-member case into an assertion before any other test.
   For zip, build the corpus **before the reader**: files made by `zip`
   (deflate, stored, a directory entry, an empty file, UTF-8 names, a data
   descriptor from `zip -fd`/streamed `zip -`), plus a hand-corrupted one per
   refusal — flipped CRC, `../` name, truncated directory, a zip bomb of a few
   hundred bytes. Keep them small and in the test project, with the command that
   made each in a comment.
1. **`Gzip`** (the value verbs and the two file verbs). No new dependency, no CI
   change. **Ship it alone** — it is the half with a clean argument.
2. **`Zip.Open`, `Entries`, `Read`, `Extract`, `ExtractAll`** against the corpus
   and `unzip -t`.
3. **`Zip.Create`**, held to `unzip -t` and `zipinfo` on what it writes — and,
   because the ecosystem is hostile to a *mostly* correct zip, to opening the
   result in a real consumer once by hand (`.docx` in a word processor is the
   usual one).
4. *Waiting for a caller:* zip64, encryption, CP437.

Stage 1 is the only one that should be done without a caller; 2 and 3 want an
application that reads or writes one, and the first such application is also the
test of the API's shape. **`Ide.Exporter` is not that caller** and should not be
rewritten onto this: its `tar` is documented, tested and the project's chosen
precedent.

### Tests

- **gzip against the system's:** bytes made by `gzip` embedded in the test
  (base64, with the command in a comment) decompress to the known text; what
  `Compress` writes is decompressed by `gzip -dc` in an `Exec` (gated on
  `Application.HasCommand`) — the external oracle in each direction.
- **The three refusals:** multi-member returns **all** of it, a truncated stream
  throws and names the offset, trailing garbage throws, and a 100-byte bomb
  stops at `MaxSize` having produced no more than that.
- **Empty input** both ways, and `Compress("")` decompressing to an empty
  `Bytes` (the `NULL` pointer again).
- **Argument refusals** (`Level: "high"`, `Level: 0`, `Level: 10`, a number for
  the data) — a sample of each family in `testArgumentRefusals`'s style.
- **A refused file verb leaves nothing:** no destination, no temporary.
- **Zip:** the corpus above; every refusal asserted by its message; **zip-slip
  asserted with a real `../` entry** and the destination directory checked to be
  untouched outside itself; and the CRC test with one flipped byte.
- **`tests/asan.sh` over the zip reader**, with the standing caveat — and add the
  corrupt corpus to a run, since an out-of-bounds read on a hand-made directory
  is exactly what the sanitizer *can* see (a `GMappedFile` is a real mapping,
  unlike a short `JSValue` string).

### Documents this touches

`library.md` (two new sections: `Gzip`, `Zip`) and their reference pages under
`docs/reference/globals/`; `GLOBAL_SECTIONS` and `GLOBAL_PAGE_OWNERS` in
`bintana-docs/check/Check.js`; `llm/controls.md`'s *deliberately not here* gains
**"a streaming compressor"** with the argument (the language has no stream, and
a value or a file covers every caller measured); `./tools/apijson.sh`;
`docs/testing.md` for the counts; and an `AGENTS.md` note on whatever the
corpus teaches — a zip reader is where that note will be written.

## What is deliberately not here

- **A stream type.** Not for gzip, not for zip. A value, or a file path read in
  blocks, covered every caller measured; a stream would be a new concept in a
  language curated to have few.
- **`tar` and `.tar.gz`.** `bundle-plan.md` writes its own ustar, `Exporter`
  shells out, and tar is a framing of files with no compression in it — the
  `Gzip` verbs already compose with it where someone writes one.
- **zlib framing, raw deflate, brotli, zstd, xz, bzip2.** One name per
  published format, and a name is published when something needs one.
- **Password storage** (see Part A). A single call cannot keep that promise.
- **Our own random generator**, GLib's `g_random`, or any fallback when the OS
  source fails.
- **Optional `libzip` or `libarchive`.** Revisit if the reader's corner list
  grows past what can be listed as refusals — which is the signal that the
  format is bigger than a plan for a small reader.

## Decisions taken

Taken by the default each question carried, since the owner's instruction was to
build it; any of them is a rename away from being reopened.

1. **Stage 1 of each part now, the rest on a caller.** Built: `Random.Bytes`,
   `Int`, `Uuid`, `Hash.Hmac`, `Hash.Verify`, `Gzip.Compress`/`Decompress` and the
   two file verbs. Zip and the rest of Part B wait.
2. **The comparison is `Hash.Verify(key, message, signature, [algorithm])`**, not
   `Hash.Equal`: it does the whole check, so there is no step to do in the wrong
   order, and a name that says *verify* is not reached for to compare two ordinary
   strings. It answers `false` for text that is not a signature and throws only for
   a call that is itself wrong (no signature at all).
3. **`Uuid` is v4 only.** A time-ordered v7 adds a clock to a function whose virtue
   is having none; it waits for a `Table` that wants one as its key.
4. **`MaxSize` defaults to 256 MiB** and `Infinity` is spelt out for none.
5. **The Windows and macOS entropy branches ship blind**, as every platform guard
   here does; `.github/workflows/ci.yml`'s `windows` job is the compiler for the
   first.

Two things the build found that the plan had not: the decompressor's message is
translated and is never quoted (the sentence is ours), and `Hmac` had to be
stricter than `Hash.Sha256` about what it accepts. Both are in `AGENTS.md`.
