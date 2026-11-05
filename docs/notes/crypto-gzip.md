# Random, Hmac and Gzip: what was measured and what bit

**Designed in [`docs/plans/crypto-compress-plan.md`](../plans/crypto-compress-plan.md)**
(zip is the part of that plan still waiting for a caller). Five things were not
obvious and each cost something:
- **GIO's gzip decompressor answers the first member of a multi-member stream
  and reports success.** `cat a.gz b.gz` is valid gzip; `GZlibDecompressor`
  returned 6 bytes of 12 with no error, 26 of 52 input bytes consumed. A
  truncated stream *is* an error, but only if asked at the end of input.
  `bta_gzip.c` resets the converter at each member's end and goes on, and
  `testGzip` goes red on exactly the 6-of-12 answer with that line taken out --
  it was put back and watched, as the rule asks. Measured on the same probe:
  47 MB deflates in ~960 ms and inflates in ~90 ms, which is why the page sends
  big ones to a `Task` and why a worker has `Gzip`.
- **`Hmac` is stricter than `Hash.Sha256` on purpose.** `Sha256(v)` accepts
  whatever `JS_ToCString` converts, which is fine for a checksum; `Hmac(key,
  undefined)` would sign the word "undefined" and return a signature that looks
  valid and covers nothing. Key and message are text or `Bytes` and nothing else.
  `Hash.Verify` compares in constant time (`ct_equal`, `volatile` so the
  accumulation is not turned back into an early exit) -- **and no test can prove
  that**, since timing is not an assertion; the property is held by reading the C.
  What the tests *can* hold is the vectors (RFC 4231 cases 1, 2 and 6, RFC 2202),
  which is why they are not "agrees with itself".
- **`Random` throws and never falls back**, and the Windows and macOS entropy
  branches cannot be compiled here (`RtlGenRandom` is fetched with
  `GetProcAddress` so the link line did not have to change blind). `Random.Int` is
  rejection sampling; `r % span` is the bias to refuse by construction.

## Cipher, added later

**AES-256-GCM through GnuTLS, because GnuTLS was already the TLS library under
`libsoup`.** The headers are a separate package, so it is optional like sqlite:
`Cipher.Available` is false without it and the verbs refuse naming the package.

**The key is hashed with SHA-256, not padded.** A passphrase, an `Hash.Hmac`
digest and `Random.Bytes(32)` are all the same 32 bytes to the cipher, and none
of them has to be a particular length. That is a decision about the API, not
about the strength: a passphrase a person chose is as weak as the passphrase,
and a caller who cares stretches it before it gets here.

**The sealed value is `"BTA1"`, a fresh 12-byte nonce and the ciphertext with
its 16-byte tag.** The nonce is new every call, so two seals of one plaintext
differ; the marker is what `Decrypt` refuses by name when the value is not one
of ours. A wrong key, a changed byte, a truncated value or another marker is a
throw -- GCM authenticates, so there is no plausible-looking half answer. The
tests hold the round trip, two seals differing, a wrong key, one flipped byte,
a text key and an empty key; there is no fixed-nonce vector because the API does
not let a caller choose the nonce, which is the point.
