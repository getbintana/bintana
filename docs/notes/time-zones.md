# `Zone`: why the runtime reads the time zone database itself

`Zone` is the third of `Day` and `Time`: an instant is a `Date`, a place reads
it as a `Day` and a `Time`, and the zone is what turns one into the other. This
note is what was measured before choosing how, on 2026-11-22.

## What there was

- **QuickJS has no `Intl`.** `typeof Intl` is `"undefined"`, and
  `new Date(...).toLocaleString("en-US", { timeZone: "Asia/Tokyo" })` answers
  the *local* time without a word -- the option is ignored, not refused.
- **The runtime had no zone at all**: `Day.Today`, `Time.Now` and
  `Locale.Date` are local time, by design.

## The candidates, measured on Windows 11 (26H2, build 10.0.26300)

| mechanism | the 10 reference instants | 4 zones changed after 2022 | transitions | IANA abbreviation |
|---|---|---|---|---|
| GLib 2.90.1 `GTimeZone`, IANA id | 0/10: `g_time_zone_new_identifier` is `NULL` | -- | -- | -- |
| GLib, registry name (`"Tokyo Standard Time"`) | 10/10 offsets | 3/4 | only by sweeping `find_interval` | no: a long name, translated |
| `icu.dll` 72.1 in System32 | 10/10 | **1/4** | `ucal_getTimeZoneTransitionDate` | no: `GMT+9` |
| TZif files + our reader | 10/10 | 4/4 | yes | yes |

- **GLib cannot do it on Windows without a patch**: in `gtimezone.c` the TZif
  reader, the `TZDIR` lookup and the absolute-path form are all under
  `#ifdef G_OS_UNIX`. On Windows an identifier is a registry key or a POSIX
  rule. Giving it a zoneinfo directory changes nothing.
- **Windows' ICU is frozen at tzdata 2022g** (`ucal_getTZDataVersion()`), on a
  machine updated in November 2026: Windows Update refreshes the registry's
  zones, not ICU's data. Cairo, Almaty and Nuuk read wrong through it, and
  Asunción reads right by accident while announcing a transition that no
  longer exists. An unknown id is not an error there either: it is
  `Etc/Unknown` at offset 0 with `U_ZERO_ERROR`.
- **MSYS2 packages tzdata** (`mingw-w64-ucrt-x86_64-tzdata`, 2026f at the
  time) with `zone.tab`, `zone1970.tab`, `iso3166.tab` and `tzdata.zi`. Without
  `posix/` and `right/` it is 607 files, 865 KB, 242 KB compressed.

The reference values for the four changed zones came from `date` with
`TZ=/usr/share/zoneinfo/<zone>` on tzdata 2026f.

## What was chosen

One reader for every platform, in `rad.js`: a TZif file (RFC 8536) is a header,
the transitions, the local time types and, from version 2, a POSIX TZ rule that
carries the zone past its last stored transition. Linux and macOS read the
system's database (the distribution updates it); Windows reads the copy the
portable tree and the setup carry in `share/zoneinfo`. Only what JavaScript
cannot ask is C (`bta_zone.c`): where the database is, which zone the machine
is in (`/etc/localtime`'s link, or the registry's key through CLDR's table),
and which release is installed.

`tzdata.zi` -- the database as one 105 KB text file -- was the smaller thing to
ship and was not chosen: reading it is reimplementing `zic` (rules, `UNTIL`
lines, the history), far more code than reading what `zic` already compiled.

## How it was checked

A console project ran `Zone.At`, `Zone.Next` and a `Zone.Instant` round trip
over every zone in `zone.tab` and `zone1970.tab` (418), at 400 random instants
between 1850 and 2099 plus the second before and the second of every
transition `zdump -v` lists, against Python's `zoneinfo` (offset and
abbreviation) and `zdump` (the next change of offset): 167,520 instants, no
difference, with Fedora's fat TZif files and with slim ones built from the same
`tzdata.zi` by `zic -b slim`.

**The slim files found the one bug** the first reader had: asked for the next
change from an instant before the last stored transition, with no stored change
of offset after it, it computed the footer's rule from the instant's own year
-- inventing a change in years the file describes. Fat files hide it, because
they store every transition up to 2037. `tests/widgets`' `testZone` builds such
a zone byte by byte (an abbreviation-only change, then a footer) and fails on
the old code with `2005-11-06T04:00:00.000Z STX>STX`.

## What is not here

- Formatting. `Locale.Date(Zone.Day(id, when), "Weekday")` names the day in the
  reader's language; nothing in `Zone` writes words.
- Where the sun is. The coordinates are in `Zone.Info`; sunrise is astronomy,
  not a zone's business.
- A `Date` that carries a zone. The values stay what they are: an instant, a
  `Day`, a `Time`.
