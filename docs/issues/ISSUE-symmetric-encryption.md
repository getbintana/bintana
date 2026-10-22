# ISSUE: there is no cipher to encrypt anything with

## What the application needed

A client's records encrypted on disk with a key the office holds, and a
report that leaves the building encrypted rather than as a plain PDF. The
concrete case was a fleet of twelve laptops and a database file that holds
every customer's personal data: the application has to be able to write a
file that nobody without the key can read, and read it back itself.

## What I wrote instead

GnuPG through `Exec`: the program builds a command line, pipes the bytes
through `gpg`, and keeps the passphrase out of the file. It costs an
external program that has to be installed on every machine, a subprocess per
file, a passphrase on a command line, and a format the application has to
hand-roll on top of it.

## The code I wish I could have written

```js
// a cipher, beside `Hash` and `Random`:
const key   = Hash.Hmac(passphrase, "bintana-file-key");
const bytes = File.LoadBytes(path);
const sealed = Cipher.Encrypt(bytes, key);      // Bytes
const opened = Cipher.Decrypt(sealed, key);      // Bytes
```

## Why the existing words do not cover it

The runtime has the pieces either side of a cipher and not the middle.
`Hash.Hmac` (`runtime/src/bta_sys.c:3818-3826`) is a keyed digest: it proves
a message was not changed and it cannot be undone. `Random` has `Bytes`,
`Int` and `Uuid`, and `Gzip` compresses (`docs/notes/crypto-gzip.md`) —
none of which hides anything. There is no cipher in the runtime at all: the
only match for "symmetric" under `runtime/src` is a comment about a worker's
pack and unpack (`runtime/src/bta_task.c:602`). `Keyring` is for the
secrets the desktop keeps — a token, a password — and not for a file or a
database (`docs/plans/keyring-plan.md`), so the key is something the
application would have to carry itself.

## Prior art

.NET `System.Security.Cryptography.Aes` and `ProtectedData`. Java
`javax.crypto.Cipher`. Python's `cryptography`. GNOME `libsecret`, which is
secrets only. SQLite needs SQLCipher, an external patch, for an encrypted
database. GnuPG through `Exec` is what an application does today.

## How much it mattered

The application cannot be written: encryption at rest is a requirement and
not a nicety, and it is what a business desktop application is asked for.
