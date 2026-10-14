# Keyring on every platform, and a floor under it

**Not started.** Nothing is built yet; what is left of this file when it is
built is the platform table that belongs in the page and the by-hand lists for
Windows and macOS. Asked for by the owner on 2026-10-14, after the question
*what does an application use to keep a token?* turned up the one capability in
the runtime a whole platform cannot run, and the one whose absence is decided
at **build** time even on the platform it has.

## What is there, counted

- `runtime/src/bta_keyring.c` is `#ifdef BTA_HAVE_LIBSECRET` from its include
  to its last line. With libsecret it is the freedesktop Secret Service; without
  it `Available` is `false` and the three verbs throw a sentence naming the
  package. The CMake comment beside the check says it in one line: *libsecret
  has no Windows port, so the `#else` half is what that build compiles*.
- **No caller in the tree.** `grep -rl Keyring ide lib examples tests` answers
  one file — `tests/widgets`, which asserts the refusals — so the surface is
  free to move today, and that is the plan's luck, not its argument: the first
  application that stores a token is the first caller, and it should not have
  to be Linux-only.
- The October audit lists **R5** (`Keyring` among what Windows is missing) and
  **R8** (`no symmetric encryption ... Keyring is secrets only`). This plan
  answers the first; the second is untouched and has its own trigger (an
  application that must read encrypted data back).
- The suite's rule is a constraint on every test below: **the suite never
  writes to the real vault** ([`docs/agents/media-desktop.md`](../agents/media-desktop.md)).
- CI: `windows` builds and runs `tests/api.sh`; `no-libsecret` hides the
  module, reads CMake's own line back, and **runs the widgets suite against
  that build** — which is where the floor gets its one real, automatic run.

## The shape

One global, always compiled, always answering. What changes per platform is
who protects the secret:

| platform | `Provider` | there when |
|---|---|---|
| Linux with the build half | `"SecretService"` | libsecret linked; the service must be answering |
| Linux without it | `"File"` | always — the floor |
| Windows | `"CredentialManager"` | always |
| macOS | `"Keychain"` | always |

- **The three verbs do not change**, and one contract survives all four
  providers: asynchronous, one answer, no second error argument. A provider
  whose call is synchronous answers through an idle, so the answer still lands
  on the loop and `bta_keyring_pending` still holds a console project open
  until it arrives.
- **`Available` goes; `Provider` arrives.** `Available` answers about the
  build, and its honest value would become a constant `true` — a member that
  cannot be false. What a caller decides with is *which* store is behind it,
  and a security-minded application branches on `Provider === "File"`. If the
  owner ever wants the old name, `Available` as `Provider !== "File"` is one
  line.
- **No runtime fallback.** Linux picks its provider at build time; Windows and
  macOS have the platform's. A call never straddles two stores — two stores are
  two answers to `Lookup`, and the one that is wrong is silent. A Secret
  Service that is not answering fails the call, exactly as it does today, and
  the page says so. (The reopening is written below.)

## The File provider, which is the floor

`Application.ConfigDirectory/secrets/<enc(service)>/<enc(key)>`: one file per
secret, the file's bytes are the value. `Application.ConfigDirectory` is
`~/.config/bintana/<name>`, created at startup, which is where anything an
application remembers already belongs.

- `enc` percent-encodes everything outside `[A-Za-z0-9._-]` plus `%` itself.
  A component longer than **255 bytes once encoded** is refused, and so are an
  empty service and an empty key — at the argument, with a sentence, the way
  every other argument is refused. A store whose name cannot be a file name is
  the caller's mistake and not a vault that is sick.
- Files `0600`, directories `0700`, written to a temporary beside the
  destination and renamed over it (the shape `File.Save` has), so a failed
  write leaves nothing. `Delete` removes the file, removes the service
  directory when it becomes empty, and answers `false` when there was nothing
  there.
- **Unencrypted, and the page says so in the same breath it says what it is
  for.** Its promise: the secret is not in `settings.json`, not in a file the
  project hands to somebody, and readable only by the user — what `gh`, `aws`
  and `git-credential-store` do on a machine with no vault, and as strong as
  the file's permissions and no stronger.
- Linux only. Windows and macOS have a vault that is always there, and a
  second, weaker store on those platforms would be a choice nobody asked for.
- The cap that is *not* the file system's is stated once, in the front: a
  `value` longer than **2560 bytes** is refused at the argument, uniformly, on
  every provider. It is Windows' own Credential Manager limit
  (`CRED_MAX_CREDENTIAL_BLOB_SIZE`), and the floor is the platform's weakest
  cap so that one program stores the same secrets everywhere instead of
  finding out on one machine.

## Windows: the Credential Manager

- `CredWriteW` / `CredReadW` / `CredDeleteW` (`advapi32`, `wincred.h`), and
  MinGW UCRT64 has both — the `windows` job is what compiles this half, so the
  blind part is small.
- `CRED_TYPE_GENERIC`; `TargetName` is `bintana/` + the two encoded names, so
  a lookup constructs the exact string and never has to parse one back;
  `UserName` is the service, unencoded, because that is the half a browsing
  human reads; `Persist` is `CRED_PERSIST_LOCAL_MACHINE`; the blob is the
  value's UTF-8 bytes, and every wide string goes through
  `g_utf8_to_utf16`.
- `ERROR_NOT_FOUND` is `false` from `Delete` and `null` from `Lookup`; a
  written credential replaces the blob in place, which is what `Store` over a
  name that exists means. A value past the 2560 cap was already refused by the
  front.
- The link line gains `advapi32` under `if(WIN32)`. `Random`'s blind
  `GetProcAddress` stays exactly as it is — it was written that way to avoid a
  link change nobody could verify, and this one is verified by CI on every
  push.
- **By hand on a real Windows**, and R5's `Keyring` word leaves that audit line
  only then: Store → the entry is visible in *Control Panel → Credential
  Manager* under its `bintana/…` name → Lookup answers it → delete it from the
  panel → Lookup answers `null`.

## macOS: the Keychain

- `SecItemAdd` / `SecItemCopyMatching` / `SecItemUpdate` / `SecItemDelete`
  (`Security.framework`), `kSecClassGenericPassword`, `kSecAttrService` and
  `kSecAttrAccount` are the two names, `kSecValueData` the value,
  `kSecAttrAccessibleWhenUnlocked` the accessibility. A duplicate on add is an
  update; `errSecItemNotFound` is `null`/`false`.
- `-framework Security` under `if(APPLE)`. **This half compiles nowhere yet**:
  [`macos-plan.md`](macos-plan.md) has not started, so this is the plan's one
  written-blind provider, the same rule `Random`'s Windows and macOS branches
  were written under — as small as it can be, the why beside every line. The
  round trip goes on macos-plan's by-hand list the day that port runs.

## Where it goes

- **One file.** `bta_keyring.c` keeps the front — argument checking, the job
  list, `Provider`, the callbacks — and grows one section per provider behind
  its own guard. Past about eight hundred lines the providers split into
  `bta_keyring_<provider>.c`; `RUNTIME_C_SOURCES` and the signature extractor
  both glob `runtime/src/*.c`, so a new file costs no CMake edit and is not a
  silent member-less registration.
- CMake: `advapi32` under `if(WIN32)`, `Security` under `if(APPLE)`, and
  libsecret exactly as it is on Linux — optional, the sqlite mould. The
  `no-libsecret` message changes to say what now happens: the store falls back
  to the file under the config directory instead of refusing.
- **The description beside each member is the source**: `./tools/apijson.sh`,
  then `./tests/api.sh` — which also fails while `Available` is still
  documented anywhere. `Provider`'s own description lists its four values.

## Stages

1. **The front and the floor** (all of it verifiable on this machine): the
   provider dispatch, `Provider`, `Available` removed, the File provider, the
   uniform caps, `tests/widgets testKeyring` extended, `tests/keyring.sh` for
   what JavaScript cannot see, the `no-libsecret` job runs it, CMake messages,
   and every document below.
2. **Windows**: the Credential Manager section, the `advapi32` link, the
   `windows` job compiling it, and the by-hand list above. R5 shrinks when the
   round trip has been run on a real Windows desktop.
3. **macOS**: the Keychain section, the framework, and its round trip on
   macos-plan's list. Nothing to verify here.

## Tests

- **`tests/widgets`, `testKeyring`** — the argument refusals it has (types,
  the callback), plus the empty and over-long names and the 2560-byte value,
  plus `Provider` being one of the four names. Its `Available` branch is
  replaced by the provider branch: when `Provider` is `File`, a real round
  trip — `Store`, the file exists under `Application.ConfigDirectory`,
  `Lookup` answers it, `Delete`, `Lookup` answers `null`, `Delete` answers
  `false` — waited for with `until`, which is what the **`no-libsecret` job's
  `run.sh widgets`** then runs in CI. When the provider is a vault the test
  does not write to it, and the rule above is why.
- **`tests/keyring.sh` + `tests/keyring/`** (a `main` project, so the runner
  ignores it) — the half JavaScript cannot see: the `0600` mode and the `0700`
  directory, asserted with `stat`, and that a failed store leaves no temporary
  behind. Run by the same `no-libsecret` job, and where the build's provider
  is not `File` it says so and exits `2` — a run that proved nothing must not
  end well.
- Nothing asserts the vault's round trip on Linux or macOS by machine: a
  secret in the developer's keyring is a side effect the suite has no business
  causing, and the by-hand lists carry it.

## Documents this changes

- **bintana** — `bta_keyring.c`'s comments, `api.json` (regenerated),
  [`docs/agents/media-desktop.md`](../agents/media-desktop.md) (its Keyring
  section becomes the platform table, the File promise and these test rules),
  [`docs/testing.md`](../testing.md) (the tools list and any count it quotes),
  the `no-libsecret` job's comment, and this file's stage rows as they land.
- **bintana-docs** — `docs/reference/globals/Keyring.md` rewritten around the
  table, the File promise, the caps and the mixing rule (a secret is seen only
  by the provider that stored it); `docs/runtime-api.md` and
  `docs/llm/library.md` rows; `check/Check.js`'s section; `BINTANA_API=$PWD/api.json
  ./check.sh`.
- **bintana-llm** — `api.md`'s rows (`Available` out, `Provider` in) and its
  own check.

## What reopens what

- **A D-Bus client of our own** (drop libsecret): the Secret Service is a
  protocol on the session bus, and GLib's GDBus could speak it without the
  library — sessions, prompts and all. Worth a plan of its own and not a stage
  here: it is the industry's mock-service-on-a-private-bus test (the
  `Notification` machinery) or it is untested, and stage 1 makes it
  unnecessary for the capability. Reopened by a distribution that must not
  link libsecret, or a build on Linux with no optional half at all.
- **A runtime fallback to `File`**: reopened by an application that stores a
  token on machines where the vault is sometimes absent. It costs a precedence
  rule — which store answers when both could — and a story for the secret that
  was stored under the other one.
- **Encrypting the File**: there is no key to encrypt it with that is not
  beside it, and a secret under it is exactly as safe as the file's
  permissions. The reopening is a caller that must keep a secret from somebody
  who can read the user's own files, and that caller wants a vault (or
  `R8`'s encrypted store), not a second lock on the same door.
- **Migrating secrets between providers**: nobody to migrate — no caller in
  the tree — and the page's mixing rule is the answer until somebody's users
  exist.

## The owner's decisions, recorded

1. **No runtime fallback in version 1** — a provider per build; a Secret
   Service that is not answering fails the calls, as it always has.
2. **`Available` removed, `Provider` added.** (`Available` as
   `Provider !== "File"` is the one-line variant if it is ever missed.)
3. **macOS included blind**, marked unverified until the port runs.
4. **Windows uses the Credential Manager and not DPAPI over a file.** Per
   item, browsable, and delete semantics that match the other three; DPAPI
   would mean owning a file format to keep the same promise, on the platform
   that has a credential store already.
5. **`File` is a floor and not a choice**: only the Linux build without
   libsecret ever uses it.
