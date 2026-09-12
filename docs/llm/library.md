# The library

Every name here is a global: ambient, always present, no import.

## Application

| | |
|---|---|
| `Name` | from `project.json` |
| `Version` | what the *project* calls its release; `""` when it declares none |
| `Directory` | the project directory, absolute |
| `ConfigDirectory` | `~/.config/bintana/<name>`, created at startup |
| `Executable` | the `bintana` binary, so a project can re-invoke it |
| `Arguments` | whatever followed the project directory on the command line |
| `HasIcon(name)` | whether that icon will actually **draw** something |
| `HasCommand(name)` | whether that program is on the PATH |
| `Icons([contains])` | every icon name available, sorted; narrowed by substring |
| `DecorationLayout` | how this desktop arranges a title bar |
| `CheckSource(text)` | `null` if the text is valid JavaScript, else `{ Message, Line, Column }` |
| `LibraryPath(name, [project])` | where a library by that name is, or `""` — the same six-place search the runtime does for `uses`. Published so a tool that opens *other* projects asks about theirs rather than keeping a second copy of the path |
| `Libraries([project])` | the names of every library those same six places offer, sorted, each one once. The other direction of the lookup: `LibraryPath` resolves a name you already know, this is what a dialog that offers a choice needs |
| `OnError` | assign `(message, stack) => …` to take over uncaught errors |
| `Quit(code)` | quit with that exit status |

`BTA_VERSION` is the **runtime's** version, and is not
`Application.Version`. Showing the wrong one is what an About box does until it
knows the difference.

`HasCommand` is the question that does not need an exception: `Exec` throws when
the program is not there.

## Environment

The context the program was started in.

`Get(name)` (or `null`), `Set(name, value)` (`null` removes; it is `export`, so
it affects everything started afterwards), `Variables`, `CurrentDirectory`
(assigning enters, and **throws** if there is no such directory), `HasDisplay`,
`ProcessId`, `ProcessorCount`, `HomeDirectory`, `TempDirectory`, `UserName`,
`HostName`, `OS`, `OSVersion`.

The command line is `Application.Arguments` and quitting is `Application.Quit`:
those belong to the application, not to the system.

## Message

`Message.Info(text, ...args)`, `Message.Warning(…)`, `Message.Error(…)`.

**They show and return.** They do not block and there is no answer. The first
argument is a text position, so it takes `{0}` holes and goes through the
catalogue — never a template literal there. With no display they print to
stderr.

```js
Message.Error("Cannot open {0}: {1}", path, e.message);
```

A question that needs an answer is a form: [forms.md](forms.md#a-dialog-that-asks-something).

## Locale

| | |
|---|---|
| `Text(msgid, ...args)` | the catalogue's version, `{0}` filled in; the msgid itself when there is no entry |
| `Plural(one, many, n, ...args)` | the form `n` takes by the catalogue's own rule; `n` also fills `{0}` |
| `Context(ctxt, msgid, ...args)` | gettext's `msgctxt`: part of the key, never shown |
| `Current` | the catalogue in use, `""` for none. Assigning reloads, and affects only what is built afterwards |
| `Available` | the catalogue names this project ships, sorted |
| `Read(path)` | a catalogue as data, losing nothing |
| `Number(value, [decimals])` | grouped, with the desktop's separators. As many decimals as it has unless told |
| `Currency(value, [decimals])` | money, with the symbol where this desktop puts it |
| `Date(when, [format])` | `"Date"` `"Time"` `"DateTime"` `"ISO"` `"Weekday"` `"Month"`. `when` is a `Date` **or** a `"YYYY-MM-DD"` string |
| `Compare(a, b)` | `-1`/`0`/`1`, in the order this desktop puts names in |
| `Matches(text, needle)` | whether a search for `needle` should find `text`, accents folded |
| `DecimalPoint` | the character this desktop writes a decimal with |

```js
Locale.Number(1234567.891)        // 1.234.567,891
Locale.Number(1234567.891, 2)     // 1.234.567,89
Locale.Date(new Date())           // 31/08/26
Locale.Date(when, "DateTime")     // lun 31 ago 2026 14:05:09
Locale.Compare("Ñanculeo", "Ortiz")
Locale.Matches("Echeverría", "ver")   // true
```

**`Locale.Date` takes a calendar date as it stands**, so nothing a
[`Day`](#day) or a `Field.Date` holds ever needs converting:

```js
Locale.Date("2026-12-25")             // 25/12/26
Locale.Date("2026-12-25", "Weekday")  // viernes
Locale.Date("2026-12-25", "Month")    // diciembre
```

Reaching for `new Date(y, m, d, 12)` to get a month or a weekday out of one is the
mistake this saves you — the noon is there to dodge the time zone that borrowing an
instant introduced, and the string never had one.

**Use `Locale.Compare` and never `localeCompare`**, which here compares code
units and puts `Álvarez` after `Zapata`. `Locale.Matches` is its half for a
search field. `Locale.Number` and `Locale.Currency` take a `Decimal` and write
it from its own digits, never through a double.

Most text needs none of this: see
[forms.md](forms.md#text-a-person-reads).

## File

| | |
|---|---|
| `Load(path)` | the whole file as a string; throws if unreadable |
| `Save(path, text)` | **atomically** — a temporary beside it, renamed over, so a failed write leaves the old file intact |
| `LoadJson(path)` | parsed, and the error names the file |
| `SaveJson(path, value)` | one canonical shape: indented by two, one trailing newline |
| `Exists(path)`, `IsDir(path)` | |
| `Delete(path)` | a file, or an **empty** directory. Throws on failure |
| `Trash(path)` | to the desktop's trash, whole for a folder. Throws where there is no trash |
| `Rename(from, to)` | also moves; refuses to clobber |
| `LoadBytes(path)` | the whole file as [`Bytes`](#bytes), untouched — what `Load` cannot do, since it answers text |
| `SaveBytes(path, bytes)` | those bytes, exactly; the pair of `LoadBytes` |
| `Hash(path, [algorithm])` | the file's checksum as hex, `"Sha256"` unless told — see [Hash](#hash). Read in blocks, so a video costs 64 KB and not the video |
| `Copy(from, to)` | **byte for byte**, so it works on images; refuses to clobber |
| `Info(path)` | `{ Size, Modified, Type, Icon, IsDir }`, or `null` |
| `Watch(path, cb)` | `cb(event, path)` — `"Changed"` `"Created"` `"Deleted"`; answers something with `Stop()` |
| `Open(path)` | hands it to whatever the desktop opens that kind of file with |
| `Join(a, b, …)`, `Absolute(path)` | |
| `Name(path)` | `/a/b/c.js` → `c.js` |
| `Directory(path)` | `/a/b/c.js` → `/a/b` |
| `Extension(path)` | `js`, no dot, `""` if none |
| `BaseName(path)` | `c` |

**`Trash` is what *Delete* usually should mean.** A program that offers Delete
and means `unlink` is harsher than the desktop it runs on — and one that offers
the trash needs no confirmation dialog, because the answer is recoverable. It
throws where the filesystem has no trash (a stick, tmpfs, a share); that is the
one case worth a confirmation.

`Info().Type` is a content type you can test (`"image/png"`); `.Icon` is the
name the desktop draws for that kind of file; `.Modified` is a real `Date`, to
the millisecond. `.Icon` is the one field that needs a display — in a console
project (`main`) it answers `""` and the other four still work.

`Watch` reports only settled events — a save is a burst, and many editors write
a temporary and rename it over. Both roads arrive as one `"Changed"`. A watch may
be stopped from inside its own callback.

Text is UTF-8 throughout, which is why `Copy` exists: `Save(to, Load(from))` is
right for source and destroys a PNG.

## Directory

| | |
|---|---|
| `List(path, [pattern])` | the **names** in one directory, sorted, no `.` or `..` |
| `Files(path, [pattern-or-options])` | the **full paths** of the files, sorted |
| `Folders(path, [pattern-or-options])` | the same for directories |
| `Make(path)` | creates it and any missing parent |
| `Copy(from, to)`, `Delete(path)`, `DeleteTree(path)` | |

```js
Directory.Files(dir)
Directory.Files(dir, "*.form")
Directory.Files(dir, { Pattern: "*.c", Recursive: true })
Directory.Folders(dir, { Recursive: true })
```

Sorted at each level and depth-first, so two runs list the same tree the same
way. A symlinked directory is listed and not entered; a symlink to a file is an
ordinary file.

**All three throw when the path is not a directory** — `cannot list <path>` — and
do not answer an empty list. Ask `File.IsDir(path)` first. What *is* forgiven is a
directory the walk finds and cannot read: that one is skipped rather than ending
the walk.

## Exec

```js
Exec(["git", "status", "--short"],
     (line) => this.Log.Append(line + "\n"),
     (code) => this.done(code));
```

`argv` is an array, **never** a shell string: there is no shell to quote for, so
a file name with spaces cannot turn into a command. stdout and stderr are merged,
read asynchronously and split into lines. Both callbacks are optional.

**This plus a read-only [`TextEditor`](controls.md#texteditor) is a log pane**,
and it is what to reach for rather than a `Terminal`: `Append` writes at the end
and scrolls there whatever the cursor was doing, and it works with `ReadOnly` on.
A pty buys typing, colour and `less`; if the program does none of those, it is a
dependency paid for nothing. The IDE's own output pane is exactly this. The exit
callback runs only once **both pipes have seen EOF**, so everything the child
printed is already in the buffer when it does.

An options object may come between the argv and the callbacks:

| Option | |
|---|---|
| `Directory` | where to start the child |
| `Environment` | names to add or change; a `null` value **removes** one. A change, not a replacement |
| `Stderr` | `"separate"` keeps the streams apart — the line callback then gets `"out"`/`"err"` as its second argument. Merged is the default, and merging is what keeps the order |
| `Timeout` | milliseconds before the child is ended; absent waits forever |
| `KillAfter` | milliseconds between SIGTERM and SIGKILL, `5000` by default |

The handle: `ProcessId`, `Running`, `ExitCode` (`null` while it runs; `-1` for a
child stopped by a signal), `TimedOut`, `Stop()` (SIGTERM), `Kill()` (SIGKILL).
Both signal the child's whole process group, so a wrapper's children go too.

```js
const job = Exec(["make", "-j4"], { Directory: build, Timeout: 180000 },
                 (line) => print(line), (code) => print(`done ${code}`));
job.Stop();
```

### Exec.Wait

```js
const r = Exec.Wait(["msgfmt", "--check", po]);
r.ExitCode          // the status
r.Output            // everything it wrote
r.Errors            // only with { Stderr: "separate" }
r.TimedOut          // with a Timeout
```

The blocking spelling, for a tool that runs a command it knows ends, looks at
what happened, and goes on. Same options, **no callbacks**. It turns N children
in a row into an ordinary `for` loop.

**It freezes the window** — nothing paints and nothing responds until the child
exits, and that is also what makes it safe: no handler runs inside the wait.
Without a `Timeout` a command that never ends hangs the program. Use it for
`msgmerge`, `git status`, `tar`. For anything long, use the callback spelling;
for anything genuinely interactive, a [`Terminal`](controls.md#terminal) — which
this build may not have, so ask `Widget.Available("Terminal")` first.

## Dialog

- `Dialog.OpenFile(title, [options], cb)`
- `Dialog.SaveFile(title, [options], cb)`
- `Dialog.SelectFolder(title, [options], cb)`
- `Dialog.Color(title, current, cb)`

**The callback is required** — passing none throws — and it is **not called when
the user cancels**, so no caller has to tell *cancelled* from *chose nothing*.

| Option | |
|---|---|
| `Folder` | where the chooser opens |
| `Name` | the name it starts on |
| `Filters` | `[label, patterns]` pairs; patterns space separated. The first is the one it opens on |

```js
Dialog.SaveFile(Locale.Text("Save as"),
    { Folder: Application.Directory, Name: "note.txt",
      Filters: [[Locale.Text("Text"), "*.txt"], [Locale.Text("All files"), "*"]] },
    (path) => File.Save(path, this.Editor.Text));
```

A filter's label is prose you own: wrap it in `Locale.Text`. `Dialog.Color`
answers an `rgb(...)`/`rgba(...)` string, which is exactly what `Background`
takes.

## Settings

What the application remembers between runs — anything JSON carries, in
`Application.ConfigDirectory/settings.json`, written on every change.

`Get(key, fallback)`, `Set(key, value)`, `Has(key)`, `Delete(key)`, `Keys()`,
`Clear()`, `Path`.

```js
Settings.Set("recent", [dir, ...Settings.Get("recent", [])].slice(0, 8));
if (Settings.Get("showGrid", true)) …
```

The fallback matters: `Get("on", true)` tells a missing setting from one that is
`false`. Named after the project, so two projects never read each other's.

## Timer

```js
Timer.After(250, () => this.LblStatus.Text = "");     // once
const clock = Timer.Every(1000, () => this.tick());   // repeat
clock.Stop();
```

Both hand the `Timer` back, so what was started can be stopped. The full object:
`new Timer(delay, tick)`, `Delay`, `Tick`, `Enabled`, `Start([delay])`,
`Stop()`, `Once([delay])`.

This **is** scheduling here: `setTimeout` and `setInterval` are not part of the
language. `Timer.After(0, …)` is also how you let GTK have a frame before
measuring anything.

## Stopwatch

How long something took, which is the one question a `Date` cannot answer — a
wall clock is a setting, and NTP stepping it mid-measurement makes the answer
wrong or negative.

`Elapsed` (milliseconds, with the fraction, running or not), `Running`,
`Start()`, `Stop()`, `Reset()`. All three return the watch, so
`new Stopwatch().Start()` is one line.

**A tick decides when to repaint; what is painted comes from `Elapsed`.** Adding
100 per 100 ms tick falls behind and never catches up.

## Dictionary

What a bag of data holds. `for...in` recites, `Dictionary` counts.

`Keys(bag)`, `Values(bag)`, `Entries(bag)` (`[{ Key, Value }, …]`), `Count(bag)`,
`Has(bag, key)`. When the keys are numbers, use a `Map`.

## Hash

A checksum, of a string or of a file.

```js
Hash.Sha256("abc")                       // ba7816bf…f20015ad
File.Hash(path)                          // the same digest, over the file
File.Hash(path, "md5")
```

| | |
|---|---|
| `Md5(v)`, `Sha1(v)`, `Sha256(v)`, `Sha512(v)` | the digest as lower-case hex. `v` is text (hashed as its UTF-8) or a [`Bytes`](#bytes) (hashed as the bytes it is) |
| `File.Hash(path, [algorithm])` | the **file's** digest, `"Sha256"` unless told; the name is any of the four, and case does not matter |

**What is hashed is the text's UTF-8 bytes**, which is what every other tool
means by the hash of a string: `Hash.Sha256("abc")` is what `sha256sum` says
about a file holding `abc`, and `Hash.Sha256("ñandú")` agrees with it too.
Something that is not text has to become text first — `JSON.stringify`, a
`Decimal`'s own digits — and which text is part of what was hashed, so it is the
caller's decision and not a default.

`File.Hash` reads the file in blocks and never holds it: the digest of a video
costs 64 KB of memory. It is also the one to use for anything that is not text,
since `File.Load` answers a string and a JPEG is not one.

**A hash is not a password.** These are checksums — same input, same digest, as
fast as the machine can go, which is what makes them right for comparing a
download against a published digest, keying a cache, or telling two files apart,
and wrong for storing what somebody typed. There is no salt, no work factor and
no `bcrypt` here.

## Bytes

A file's contents, when they are not text. This is what a `File.Load` cannot
carry: a PNG, a PDF, a thumbnail in a record, anything read to be written back
out unchanged.

```js
const b = File.LoadBytes("logo.png");
b.Length                                  // 763
b.Slice(0, 8).ToHex()                     // "89504e470d0a1a0a" — the signature
File.SaveBytes("copy.png", b);
Hash.Sha256(b)                            // the file's digest
```

| | |
|---|---|
| `new Bytes([value])` | nothing (empty), text (its **UTF-8**), a list of numbers `0`–`255`, or another `Bytes` (a copy) |
| `Bytes.FromBase64(text)`, `Bytes.FromHex(text)` | refused, not guessed, when the text is not that |
| `Length` (ro) | how many bytes |
| `At(index)` | one byte, `0`–`255`. **Throws** past the end |
| `Slice(from, [count])` | a new `Bytes`; **clamped** like a string's, and a negative `from` counts from the end |
| `Concat(other, …)` | a new one, end to end |
| `Equals(other)` | byte for byte — `==` compares two objects by identity, so this is the only comparison there is |
| `ToText()` | the text it is, or a **throw** when it is not valid UTF-8 |
| `ToBase64()`, `ToHex()` | as text; hex is lower-case, the way a digest is written |
| `toString()` | `"Bytes(763)"` — a description, **not** the content |
| `toJSON()` | base64, so a record carrying a file survives `File.SaveJson` |

**It cannot be changed.** There is no `Set`, no resize, no writing into it: every
operation answers a new `Bytes`. That is what makes it safe to hand one to a
record, keep it, and hand it to somebody else — a string's bargain, and the
reason a thumbnail in a `Record` cannot change under the record's feet.

**Text and bytes convert explicitly, in both directions.** `new Bytes(text)`
encodes UTF-8, `ToText()` decodes it and refuses what is not valid UTF-8 rather
than answering the replacement character. And `${b}` is deliberately
`Bytes(763)`: a JPEG interpolated into a log line by accident is a megabyte of
noise that reads as if it had worked.

`ArrayBuffer` and the typed arrays stay off the language — see
[language.md](language.md). This is one class with the operations an application
performs on a file, and no view/buffer distinction to learn.

## Decimal

Exact base-10 arithmetic, **with the ordinary operators**. This is what money is.

```js
const price = new Decimal("19.99");
const total = price * qty + tax;             // exact, to the cent
```

| | |
|---|---|
| `new Decimal(value, [decimals])` | from text, a number or another decimal; `decimals` fixes the scale |
| `Round(decimals, [how])` | `"Away"` (default) `"Even"` `"Zero"` `"Up"` `"Down"` |
| `Trim()` | `2.50` → `2.5` |
| `Abs()`, `Scale`, `Sign`, `IsExact` | |
| `Number()` | the nearest double, asked for **by name** — for a chart, a width, a percentage |
| `Decimal.Split(total, parts)` | pieces that add back up to the total, exactly |
| `toString()`, `toJSON()` | its own text. Which is why `${d}` and `JSON.stringify(d)` are both exact, and why a decimal in a file reads back as itself |

`+ - * /`, `< > <= >=` and unary `-` all work, and mix with ordinary numbers and
strings: `price * 3`, `price - "0.99"`.

Construct from **text**, not from a literal: `0.1` and `1.005` are already the
wrong number before anything can round them. `JSON.stringify` writes a decimal's
text, because a JSON number would be a double again.

## Day

The calendar date, which is the value JavaScript does not have. **A date is the
text `"YYYY-MM-DD"`** — what a [`DatePicker`](controls.md#datepicker) answers
with, what a `Field.Date` holds, what goes into JSON as itself, and what `a < b`
already orders.

| | |
|---|---|
| `Today` | today's date, at local midnight |
| `Add(date, days)` | `days` may be negative; refuses to leave the calendar |
| `Between(from, to)` | whole days, signed |
| `Weekday(date)` | `"Monday"` … `"Sunday"` — a key to test against, never text to show |

Never borrow a `Date` for this. `new Date("2026-03-08").getDate()` is 7 in
Buenos Aires and 8 in Berlin; `new Date().toISOString().slice(0,10)` is
yesterday, all morning, in Lima.

## Text

What a string measures, asked where there is no [`Painter`](controls.md#painter)
— which is everywhere a layout is *decided* rather than drawn.

```js
Text.Width("Statement of account", "Bold 18")        // 178
Text.Size(description, "", { Width: 300 })           // { Width, Height, Lines }
Text.Lines(description, "", { Width: 300 })          // the lines it breaks into
Text.Size(markup, "", { Width: 300, Markup: true })   // a paragraph with bold in it
Text.Escape("a < b & c")                             // "a &lt; b &amp; c"
Text.IndexAt(paragraph, 40, 12, "", { Width: 300 })   // 37 -- the character there
Text.Bounds(paragraph, 10, 37, "", { Width: 300 })    // [{ X, Y, Width, Height }, …]
Text.Font                                            // "Cantarell 11"
```

| | |
|---|---|
| `Width(text, [font], [options])` | how wide it lays out, in pixels |
| `Height(text, [font], [options])` | how tall — one line's height, or the whole block's when it wraps |
| `Size(text, [font], [options])` | `{ Width, Height, Lines }` in one measurement, which is one layout instead of three |
| `Lines(text, [font], [options])` | the lines it breaks into, as an array. **Refused with `Markup`** — see below |
| `Escape(text)` | the text as markup that says exactly it: `&`, `<` and `>` escaped |
| `IndexAt(text, x, y, [font], [options])` | → which character is at that point, as an index into the text **as it was laid out** — a markup run's tags already consumed. Above it is `0` and below it is the end |
| `Bounds(text, from, to, [font], [options])` | → the rectangles covering those characters: `{ X, Y, Width, Height }`, one per line the range crosses and more than one on a line that changes direction |
| `Font` (ro) | the desktop's UI font, which is what a control draws with unless CSS says otherwise. `""` where there is no display to ask |

`font` is a Pango description (`"Cantarell Bold 10"`); `""` or nothing means
`Text.Font`. `options` is `{ Width, Markup, Align }`, the same three
[`Painter`](controls.md#painter) draws with: `Width` wraps to that many pixels,
which is what makes `Height` and `Lines` interesting; `Markup` says the string is
Pango markup; `Align` is what wrapped lines are aligned to inside `Width` and
means nothing to a measurement. A word wider than the box is **broken** rather
than left to overflow, so the measurement never promises a width the text will
not keep.

**`IndexAt` and `Bounds` are the two questions a selection asks**, and neither
can be answered by a caller: where the lines broke, which run is in which font
and which way the text runs are all the layout's, and none of it survives being
handed back as strings. They are a pair — a pointer becomes an offset, and an
offset becomes the rectangles to paint behind the words — and the offsets are
**JS string indices**, so `plain.slice(from, to)` is the text and a document with
an emoji in it still slices where it was clicked. Pass the same `font` and
`options` the text was measured and drawn with, or the answer is about a layout
nobody can see. `lib/markdown` selects with these two and nothing else.

**`Markup` is for the paragraph whose font changes halfway** — a bold word, a
name in italic, a code span. `Text.Lines` refuses it, and that is not a gap: the
lines of a styled paragraph are runs and not strings, so drawing them one by one
would draw a paragraph that had lost its bold. Measure it here and draw it with
`Painter.Text(markup, x, y, { Width, Markup: true })`, which is one layout for
both. Markup that does not parse **throws where it was written**, rather than
laying out nothing and warning on the console; `Escape` is how the `<` a document
actually contains gets in. `lib/markdown` is the library this was added for.

**The numbers are the ones a `Painter` gives**: the same fonts and the same
desktop resolution, so `Text.Width(s, f)` equals `p.TextWidth(s)` with
`p.Font = f`. `tests/widgets` asserts that rather than trusting it. Two caveats
worth knowing: a **vector** surface (`SavePdf`) can differ by a pixel, because
hinting is off there; and a drawing whose font an `app.css` changed is measured
here in the desktop's, not in that one — pass the font you set.

**Measure with the same call you will draw with.** A band that grows to fit its
text and the lines that land in it come from `Text.Size` and `Text.Lines` in
`lib/report`, and that is not tidiness: two different ways of breaking the same
string agree until the day they do not, and then the text is a line taller than
the box that was measured for it.

Before this existed the only measurement in the runtime was on a painter, and a
painter is valid only inside the `Draw` it came from — so nothing could size
itself to its own words before drawing them, and a band's height had to be
declared and hoped for.

## Screen

How big the desktop is, and how many pieces it is in.

```js
Screen.Width                    // the monitor the window is on, in pixels
Screen.Height
Screen.Scale                    // 2 on a HiDPI panel
Screen.Monitors()               // [{ X, Y, Width, Height, Scale, Name }, …]
```

| | |
|---|---|
| `Width`, `Height` (ro) | the monitor the application's active window is on; the first one the display lists before any window is shown, and `0` with no display at all |
| `Scale` (ro) | that monitor's scale factor, `1` unless the panel is HiDPI |
| `Monitors()` (ro) | every monitor: `X`/`Y` are where it sits in the desktop's coordinates, `Name` is the connector (`"HDMI-1"`, `"eDP-1"`) — a key to remember a choice by, not prose to show |

**The numbers are the same pixels a form's `Width` is** — logical ones, with the
scale answered separately — so `Screen.Width / 2` is a window width and not a
surprise on a HiDPI panel.

**There is no primary monitor and no work area, and both are GTK4 rather than a
choice.** GTK4 dropped `primary` because Wayland does not answer it, and dropped
the work area for the same reason: how much of the screen a panel or a dock has
taken is not something a client can ask. So `Width` means *where the user is
looking* — the monitor the active window is on — and a window meant to fill the
screen should be `Maximized`, which is a request the compositor honours, rather
than a size worked out from these numbers.

**Knowing the geometry is not being able to place a window.** `Form.Center()` is
already a no-op on Wayland: the compositor decides where windows go. These
numbers are for deciding *sizes* and *layouts* — a form that opens narrower on a
laptop, a drawing sized to the panel it will be shown on — and for remembering
which monitor a user had something on, by `Name`, so the *next* thing you ask for
matches.

## Time

The clock half of [`Day`](#day), and the same bargain: **a time of day is the
text `"HH:MM"`** — or `"HH:MM:SS"` — and nothing else.

| | |
|---|---|
| `Now` | the time of day now, with seconds (`"21:03:58"`) |
| `Add(time, minutes)` | `minutes` may be negative; **wraps at midnight**, because a time of day has no day to fall off |
| `Between(from, to)` | whole minutes, signed |
| `Seconds(time)` | seconds since midnight — the exact number, for anything finer than a minute |

```js
Time.Add("08:30", 40)              // "09:10"
Time.Add("23:50", 30)              // "00:20"
Time.Between("08:30", "19:00")     // 630
"09:30" < "17:00"                  // true, already
```

**It is not a `Date` with the date thrown away.** An instant carries a day and a
time zone; 08:30 has neither — a shop opens at half past eight in the shop's own
zone, on every day it is open. Borrowing an instant to stand for it is the bug
`Day` exists to prevent, one unit down.

**Seconds are optional and are kept when they are there.** `"08:30"` stays five
characters through `Add`; `"08:30:15"` keeps its seconds. `Now` always has them,
because the time *now* is a measurement and `.slice(0, 5)` is how a caller throws
away what it does not want — the other way round is not available.

The shape is strict: `"8:30"` is refused rather than guessed at, and so is
`"24:00"`, which is a duration of a day and not a time any clock shows. That
strictness is what makes `a < b` order two of them, which is the whole reason for
holding a time as text.

## Regex

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

Options: `IgnoreCase`, `Multiline`, `Singleline`, `IgnorePatternWhitespace`.
`Replace` replaces **all** unless a `count` says how many. There is no
`lastIndex`, so a `Regex` can be a `const`. A replacement function is handed the
`Match`.

`Regex.Escape` is the one that is easy to forget: any pattern built around a
name the program did not choose needs it.

## Logger

`Logger.Debug`, `Info`, `Warning`, `Error` — arguments joined with a space, like
`print`. Plus `Level`, `Target`, `Handler`. This is what `console` used to be.

## Clipboard

`Clipboard.Copy(text)` is immediate. `Clipboard.Paste(cb)` takes a callback —
the clipboard belongs to whoever owns the selection, so its contents arrive when
that application answers. `""` when there is nothing to paste, not an error.

## Record and Field

The shape data has, declared once — what a control's properties are to a
control. Use one instead of a bag of keys nobody checks.

```js
class Customer extends Record {
    static Naming = "same";                     // same | lower | snake
    static Fields = {
        Name:     Field.Text({ required: true, max: 80 }),
        Email:    Field.Text({ as: "email_address" }),
        Balance:  Field.Decimal({ decimals: 2, min: 0 }),
        Category: Field.Enum(["Retail", "Wholesale"]),
        Active:   Field.Bool(true),
        Since:    Field.Date(),
        Tags:     Field.List(Field.Text()),
    };

    /* A field written by hand is a field. Read-only, so it is not written back. */
    get Label() { return `${this.Name} (${this.Email})`; }
}
```

| Kind | Holds | Options beyond `as` and `def` |
|---|---|---|
| `Field.Text(o)` | a string | `required`, `max` (characters) |
| `Field.Int(o)` | a whole number | `required`, `min`, `max` |
| `Field.Number(o)` | a number | `required`, `min`, `max`, `decimals` |
| `Field.Bool(def, o)` | `true`/`false`, and SQL's `0`/`1` | |
| `Field.Date(o)` | `"YYYY-MM-DD"`, checked against the calendar | `required` |
| `Field.Time(o)` | `"HH:MM"` or `"HH:MM:SS"` — see [Time](#time) | `required`, `min`, `max` (compared as text, which is what the fixed shape is for) |
| `Field.Bytes(o)` | a [`Bytes`](#bytes) — a file in a record. Base64 in JSON, a BLOB in sqlite | `required`, `max` (bytes) |
| `Field.Enum(values, def, o)` | one of `values` | `required` |
| `Field.List(item, o)` | an array, each entry through `item` — a `Field`, or a `Record` class | `required`, `max` |
| `Field.Record(of, o)` | another record: the class, or `() => the class` for a shape that contains itself | `required` |
| `Field.Decimal(o)` | a `Decimal` at a fixed scale | `required`, `min`, `max`, `decimals` (2 by default) |

| On a record | |
|---|---|
| `new C({ Name: "Ana" })` | through the setters, so every value is checked |
| `Apply(values)` | the same, by property name |
| `Serialize([all])` | a plain object: what differs from the start, or everything |
| `toJSON()` | so `JSON.stringify` and `File.SaveJson` are the record |
| `Clone()` | a copy, for the dialog that edits one |
| `Validate()` | **the state**: what is wrong with what it holds now |
| `Problems` (ro) | **the report of one `Load`**: what the file said that could not be taken |
| `PropertyNames()`, `PropertyOptions(name)`, `Dump()` | as a widget answers them |
| `PropertyInfo(name)` | → `{ Kind, Column, Key }`: what a field *is*, for whoever maps it onto something else |
| `C.Load(json)` | a file, read **leniently** |

```js
const c = new Customer({ Name: "Ana" });
c.Balance = 10.567;                 // 10.57: rounded to what it holds
c.Category = "Other";               // throws, naming the two it accepts
File.SaveJson(path, c);

const read = Customer.Load(File.LoadJson(path));
if (read.Problems.length) Message.Warning("{0} problems in the file", read.Problems.length);
```

- **Assigning validates and throws; `Load` does not stop.** A row that no longer
  satisfies today's rules must still be readable or it can never be corrected —
  so a value `Load` cannot take leaves the field at its starting value and goes
  on `Problems`.
- **A key the record does not describe survives the round trip**, so an older
  program cannot delete a newer one's field by saving the file.
- **Money is `Field.Decimal({ decimals: 2 })`.** There is no `Money`. It
  serialises as text, because a JSON number would be a double again.
- `Naming` says how the *file* spells its keys, once; `as` is the exception for
  the field the rule does not fit.
- A wrong declaration is answered the first time the class is used.

### A record inside a record

Master–detail is **declared**, not assembled: a `Record` class is accepted
wherever a field is expected.

```js
class Quote extends Record {
    static Fields = {
        Customer: Field.Text({ required: true }),
        Lines:    Field.List(Line),               // write this, not Field.List(Field.Record(Line))
        Ship:     Field.Record(Address),          // starts at null
        Bill:     Field.Record(Address, { def: { City: "CABA" } }),
    };
}

const q = Quote.Load(File.LoadJson(path));        // lenient all the way down
q.Lines.push(new Line({ What: "Chapa", Price: "16500" }));
q.Ship = { Street: "Corrientes 1234" };           // one line, through the child's setters
q.Validate();     // ["Lines[2].Price: 0 at least, got -5", "Ship.City: 20 characters at most"]
File.SaveJson(path, q);                           // one object
```

- **A record field starts at `null` — absent, not empty**, which is what a file
  means by a key it does not have and what lets a shape contain itself. `def` is
  how a record that always has one says so: `{ def: {} }` empty, `{ def: { … } }`
  seeded. Never on a shape that contains itself.
- **A shape that contains itself needs a thunk**: inside a class body the class is
  not bound yet, so write `Children: Field.List(() => Node)`. `static get
  Fields()` is refused — it used to declare no fields at all, silently.
- **Naming a class in `static Fields` is a load-order dependency**, because the
  static field runs at declaration: `Lines: Field.List(Line)` needs `Line`'s file
  ahead of it in `project.json`'s `sources`, the same way `extends` does, or it is
  `ReferenceError: Line is not defined` at the declaration. The thunk removes the
  dependency (`Field.List(() => Line)`) — but writing the order down is better
  than deferring it.
- `Serialize` writes one object, each child in **its own** `Naming` and keeping
  its own unknown keys. `Clone` is deep. `Validate` and `Problems` answer for the
  whole tree at once, with the path in front of each complaint, by **property**
  name.
- **A null entry in a list of records is refused** — a list has fewer entries, not
  absent ones — where a null in a `Field.List(Field.Text())` becomes `""`.
- `push` goes around the setter, as it always has: a plain object pushed into a
  list of records is answered by `Validate` (`Lines[1] is not a Line`), not when
  it goes in. Push a constructed record.
- A record that really holds itself cannot be serialised: JSON cannot say it, so
  it is refused with `<Class> contains itself`.

## Database and Table

A record over a table. `Database.Sqlite` is a **driver** in C; `Table` is the
portable half in `rad.js`.

```js
class Client extends Record {
    static Naming = "snake";                      // the SQL spelling, once
    static Fields = {
        Id:         Field.Int({ key: true }),     // the identity
        Name:       Field.Text({ required: true, max: 80 }),
        Balance:    Field.Decimal({ decimals: 2 }),
        PostalCode: Field.Text({ max: 8 }),       // column postal_code
    };
}

const db      = Database.Sqlite("data/sales.db");   // ":memory:" also works
const clients = db.Table("clients", Client);

const c = clients.Save(new Client({ Name: "Ana" }));  // INSERT; fills c.Id
c.Balance = "1500.50";
clients.Save(c);                                      // UPDATE, by the key
```

| On a table | |
|---|---|
| `Find(...key)` | one record or `null`; one value per key field, in declaration order |
| `All()` | every row, as records |
| `Where(sql, ...params)` | the filter is **SQL**; anything after it (`ORDER BY`, `LIMIT`) goes too |
| `Count([sql], ...params)` | a number, building no records |
| `Save(rec)` | `Insert` when the key is at its starting value, else `Update` |
| `Insert(rec)` | INSERT, and tells the record its new key |
| `Update(rec)` | UPDATE by key; **throws** when it matched no row |
| `Delete(rec)` | DELETE by key; throws when it matched no row |
| `Name`, `Shape`, `Connection` (ro) | |

| On a connection | |
|---|---|
| `Query(sql, [params])` | rows, as plain objects |
| `Execute(sql, [params])` | `{ Changes, LastId }` — **one** statement |
| `Script(sql)` | several statements, no parameters: a schema |
| `Transaction(fn)` | all of it or none; nests through savepoints |
| `Columns(table)` | `[{ Name, Type, Required, Key }]` |
| `Tables` (ro) | tables and views, ordered |
| `Dialect` (ro) | `{ Placeholder, Quote, NewKey }` — what differs per engine |
| `Path`, `Open` (ro), `Close()` | this driver's own |

- **All five of sqlite's storage classes**: TEXT (`Field.Text`, `Enum`, `Date`,
  `Time`, `Decimal`), INTEGER (`Int`, `Bool`), REAL (`Number`), BLOB
  (`Field.Bytes`) and NULL. `Field.Record`/`Field.List` are still refused: a
  detail is its own table.
- **Values are bound, never interpolated.** There is no way to ask for anything
  else. Write `Where("name = ?", typed)`, never string concatenation.
- **A row is a file.** `Load` reads a row and `Serialize` writes one, so nothing
  converts values: a `Decimal` is stored as **text** (exact — a REAL would lose
  the cent), a boolean as sqlite's `0`/`1`, a date as `"YYYY-MM-DD"`.
- **A column the shape does not describe survives the round trip**, so saving a
  row does not empty a column this record says nothing about.
- **Reading is lenient**: a value today's rules refuse goes on `Problems` and
  costs that column only. Check `rec.Problems` right after a `Find` or a `Load`.
- **`Validate()` is the state; `Problems` is the report of one load.** Use
  `Validate()` for a Save button and for marking a field — `Problems` never
  clears, so validating with it refuses to save a record the user already fixed.
  Use `Problems` once, on opening, to say what the file lost. Want both? Say
  `rec.Problems.concat(rec.Validate())`.
- **`key: true` is on the shape, not the source.** An `int` key at 0 is a row
  never saved, which is how `Save` decides. A key the *program* chooses is never
  at 0 once filled, so `Save` would try to update a row that is not there — use
  `Insert` for that one.
- **The shape is checked against the table** on the first statement: a nested
  field, a missing column, a table that is not there, and a column spelled with
  another case — that last because SQL identifiers are case-insensitive, so
  `Code` against `code` would write perfectly and read *empty*.
- `Naming` must match the columns. `snake` for `CustomerName` → `customer_name`;
  `as: "..."` for the one field the rule does not fit.
- **Write `balance TEXT` for a decimal column.** Never
  `NUMERIC`/`DECIMAL(12,2)`/`INTEGER`: those are *affinities* and sqlite turns
  `'19.90'` into the double `19.9`, losing the scale and the exactness. `Table`
  refuses a decimal field over any column whose affinity is not TEXT.
- **sqlite cannot then order or total that column, and that is sqlite's
  limitation — do it in the program.** `ORDER BY balance` compares bytes
  (`'9.00'` after `'10.00'`) and `SUM(balance)` goes through a double. Load the
  rows and use `Decimal`'s own operators:
  `rows.sort((a, b) => a.Balance - b.Balance < 0 ? -1 : 1)` and
  `total = total + r.Balance`. This is the same thing text ordering needs
  anyway — see `Locale.Compare` below.
- **If an application's core is money, say so: sqlite may be the wrong engine.**
  A driver over one with a real `NUMERIC` maps the same field to a numeric column
  and every one of those statements works.
- **To order or filter a decimal in SQL, name the collation *in the statement*.**
  That works and keeps the file portable, because the schema stays plain `TEXT`:
  `ORDER BY money COLLATE DECIMAL`, `WHERE money > ? COLLATE DECIMAL`,
  `MIN(money COLLATE DECIMAL)`, and `decimal_sum(money)` for an exact total (a
  window function, so `OVER (ORDER BY id)` is a running total). Through a
  `Table`: `table.Where("money > ? COLLATE DECIMAL", "9.00")`.
- **What breaks compatibility is `COLLATE DECIMAL` in a `CREATE TABLE`**, not in
  a statement: every other client then fails with `no such collation sequence` on
  any `ORDER BY`, `MIN`, `MAX`, comparison or `CREATE INDEX` for that column.
  Never generate it; if a user asks for it, warn them in the same breath. The one
  thing per-statement collation cannot give is a useful index on that column.
- **A raw `Execute` binding a `Decimal` writes its exact text**, which is right
  for a TEXT column and becomes a double in a numeric one. A `Table` is the
  safe path.
- **Not built**: a detail saved with its master (a `Field.List` is refused), a
  cursor for a grid, and a `.conn` project resource. If one of those blocks the
  application you were asked for, that is an [ISSUE](issues.md).
- No lazy loading, no identity map, no session. A detail is loaded with its
  master or not at all.
- sqlite is optional at build time; without it `Database.Sqlite` says which
  package is missing.

## Http

A native HTTP client over libsoup3. `Http.Client(opts)` holds its own session;
`Http.Get/Post/...` are shorthands on a shared default client.

```js
const c = Http.Client({ BaseUrl: "https://api.example.com/v1", Timeout: 60000 });
c.Get("/users", {}, (r) => print(r.Body.ToText()), (e) => print(e.Message));
const r = Http.GetWait("https://example.com/", { Timeout: 5000 });
```

| | |
|---|---|
| `Client([opts])` | a client with its own session: `BaseUrl`, `Headers`, `Timeout` (ms, `0` waits forever), `FollowRedirects` (default `true`), `Language`, `UserAgent`, `Proxy`, `Auth`, `Cookies`, `IdleTimeout`, `MaxConns`, `MaxPerHost`. The options are an object — a bare URL is refused |
| `IdleTimeout` | ms a pooled connection idles before soup closes it (`0` is soup's own 60 s); soup counts seconds, so anything under one becomes one |
| `MaxConns`, `MaxPerHost` | constructor-only (`10`/`2` unless told): soup takes them once, so assigning later throws |
| `Request(method, url, [body], [opts], onDone, [onError])` | any verb: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`; anything else is refused, in the blocking spelling too |
| `Auth` | `{ User, Password }`, Basic and preemptive; reads back `null` when none is set. An explicit `Authorization` header wins over it, and an explicit `Content-Type` header wins over the one the body's shape implies |
| `Get(url, [opts], onDone, [onError])` | no body |
| `Post(url, body, [opts], onDone, [onError])` | `body` is text, `Bytes` or an object (canonical JSON, `application/json`) |
| `Put(url, body, [opts], onDone, [onError])`, `Patch(…)` | with body, like `Post` |
| `Delete(url, [opts], onDone, [onError])`, `Head(…)` | no body, like `Get` |
| `RequestWait(method, url, [body], [opts])` | the blocking spelling: answers with the record, **throws** on transport failure — and what it throws carries the same `Kind` and `Status` the callback would have been handed |
| `GetWait(url, [opts])`, `PostWait(url, body, [opts])` | same, per verb |
| `PutWait(url, body, [opts])`, `PatchWait(…)` | same, with body |
| `DeleteWait(url, [opts])`, `HeadWait(…)` | same, no body |
| `UserAgent` | sent as-is; `""` sends none — and some servers answer the nameless with an error |
| `Log` | `"none"` unless told: `"minimal"`, `"headers"` or `"body"` sends the traffic through `Logger` at `Debug` — so `Logger.Level = "Debug"` shows it and a `Handler` takes it; a `Wait`'s never reaches a `Handler`, since its context is private and its caller is blocked |
| `Cookies` | `false` unless told: `true` keeps a jar of the session's own, so a login answers the next request |
| `new Multipart()` | a file upload as a value: `Field(name, value)` and `File(name, filename, body, [contentType])` (body is text or `Bytes`, `application/octet-stream` unless told), both answering the upload for chaining; `Length` counts the parts. Sent as the body of a `Post`/`Put`/`Patch`, which sets its own `Content-Type` with soup's boundary — an explicit one beside it is refused |
| `Part(index)` | one part read back: `{ Name, Filename, Type, Data }`, `Data` as `Bytes`. Past the end is refused |
| `Server([opts])` | a listener of its own — see `Http Server` below |

`onDone({ Status, Reason, Headers, Body, Url })` — `4xx/5xx` come here, it is an
answer. `Headers` keys are lower-cased. `Body` is always `Bytes` (`ToText()` is
strict UTF-8). `onError({ Message, Kind, Status })` — `Kind` is one of
`Timeout`, `Dns`, `Tls`, `Refused`, `Cancelled`, `Redirect`, `Error`.
Both callbacks are handed the request's own **handle as a second argument**,
so a form with more than one request in the air can tell whose answer arrived:
`Stop()` asks rather than undoes, and a cancelled request still answers a turn
later. The handle answers `Running`, `TimedOut`, `Url`, `Method` and `Stop()`
(cancelling calls `onError` with `Kind: "Cancelled"`). Per-request `opts` carry
`Headers`, `Query: {k:v}` (appended escaped), `Body`, `ContentType`, `Timeout`,
`FollowRedirects`, `Auth` — and naming any of them is what makes an object
options rather than a JSON body. A repeated response header keeps the last of
them, `Set-Cookie` included, which is what `Cookies: true` is for. libsoup is optional at build time; without it `Http`
says which package is missing. `examples/http` (a console tool),
`examples/jokes` (a window on JokeAPI), `examples/session` (auth plus cookies
against httpbingo) and `examples/serve` (a static file server) are the whole
of it running.

## Http Server

Serving over the same transport, on the loop the application already runs.

```js
const srv = Http.Server({ Port: 0 });   // 0 is ephemeral: read it back
srv.Request = (req) => {
    if (req.Path === "/hi") req.Answer(200, "hola");
    else req.Answer(404, "nope");
};
srv.Start();
```

| | |
|---|---|
| `Server([opts])` | `Port` (`8080` unless told, `0` ephemeral), `Host` (`"local"` loopback only, `"any"` is an explicit word), `ServerName` (the `Server:` header, `""` for soup's own), `Tls`, `Allow`, `Auth`. The options are an object — a bare port is refused |
| `Tls` | `{ Cert, Key }` files, or nothing: `https` when set, `null` when not. Missing files fail at `Start`, naming them |
| `Allow` | a list of exact IPs, or nothing (open). Refused remotes get `403` before the handler runs. Exact means exact: on a dual-stack `"any"` server, `::1` is not `127.0.0.1` |
| `Auth` | `{ Realm, Users }`: Basic over the whole server, `401` with the realm until the right password. Nothing set is open, and reads back `null`. Like `Allow`, takes effect at once |
| `req.Multipart()` | the upload parsed: a `Multipart` to read with `Part(index)` (or re-post). Refused on a plain body |
| `Request` | assign `(req) => …`; required before `Start`, replaceable while running |
| `Start()` | listens; throws naming the reason (a busy port says which one). A second `Start` is refused |
| `Stop()` | `true` while something was listening, `false` after — like signalling a reaped child |
| `Running`, `Port`, `Url` | `Port` is declared until `Start`, actual after; `Url` is `""` until then, and empty again after `Stop` |
| `Answer(status, [body], [opts])` | on the request: `body` follows the client's rules (object serialises canonical), `opts` carries `Headers` and `ContentType`. The second argument is always the body, the third always the options |
| `req.Method`, `req.Path`, `req.Query`, `req.Headers`, `req.Body`, `req.Remote` | `Headers` lower-cased and `Body` always `Bytes`, like the client's answers; `Query` repeats keep one; `Remote` is the IP |
| second `Answer`, late `Answer` | refused: the request was already answered / already ended. A handler that returns without answering gets a `500` |

A listening server counts like a watch: a console project that returned from
`main` with one running stays for its requests. Dropping it without `Stop`
disconnects. **The handler answers before it returns**: there is no deferred
answer, so a route that must ask a database or another server first has nowhere
to wait — a `Wait` inside the handler freezes the loop the server answers on,
and returning to answer later gets the `500`. `examples/serve` is a static file
server in ten lines of handler; it carries no `".."` refusal because soup
normalizes dot-segments before the handler runs.

## AudioPlayer

Sound with no window: an alarm cue, a stream listened to, the audio half of
anything [`Video`](controls.md#video) shows. One playbin3 per player, with the
video branch switched off and never decoded — several may play at once.

```js
const cue = new AudioPlayer();
cue.Uri = "done.ogg";
cue.OnEnded = () => print("ding");
cue.OnError = (msg) => print(`no cue: ${msg}`);
cue.Play();
```

| | |
|---|---|
| `new AudioPlayer()` | a player of its own. Takes no arguments; everything below is assigned |
| `Uri` | what to play: a URI (`file://`, `http(s)://`, `rtsp://`) or a plain local path, which is turned into one |
| `User` | RTSP digest identity, applied to the source the playbin builds. `""` for none |
| `Password` | the secret beside it. **Write-only**: reads back `""`, so it is never written down anywhere |
| `Latency` | ms the RTSP jitterbuffer may hold. Default `2000`, the source's own. Read when the source is built, so a change lands on the next `Play` from a stopped player |
| `Volume` | `0`…`1`. Default `1` |
| `Muted` | silence without touching `Volume` |
| `Loop` | reseek instead of ending. A live stream cannot seek, so it ends anyway |
| `Buffering` (ro) | how full the buffer is, `0`…`100`; `100` is nothing to wait for, less is a stream refilling |
| `Position` (ro) | seconds in, `0` when unknown — which includes playing live |
| `Duration` (ro) | seconds long, `-1` while unknown — which is always, on a live stream |
| `Playing` (ro) | whether it is going: what `Play` asked for, until `Pause`, `Stop`, the end or an error |
| `Seekable` (ro) | whether `Seek` has anything to work on |
| `OnEnded` | assign `() => …`; `null` takes it off. Anything else is refused where assigned, not silently never called |
| `OnError` | assign `(message, kind) => …`. `message` names the player and the clip; `kind` is one of `NotFound`, `NotAuthorized`, `Unreachable`, `Decode`, `Error` |
| `Play()` | plays; replays from the top after the end. Refused with no `Uri` |
| `Pause()` | holds the position |
| `Stop()` | parks it: back to no state, position forgotten |
| `Seek(seconds)` | jumps there. Refused on a stream that cannot seek |

**A cue nobody keeps is still heard.** A playing player holds itself up, so
the shape a confirmation sound actually has works:

```js
function ding() {                        // nothing keeps the player
    const a = new AudioPlayer();
    a.Uri = "done.ogg";
    a.Play();
}
```

It is released at the end, at an error, or at `Pause`/`Stop` — so a paused
player is a deliberate hold that keeps nothing alive, and a console project
that returned from `main` with one playing stays for its end or its error
(with `Loop`, that is until something stops it). As with `Video`, `Play`
replays from the top after the end, setting `Uri` stops whatever was playing,
a stream that runs its buffer dry is held until it refills (`Buffering` says
how far along that is), and GStreamer is optional at build time — without it the constructor says which package is
missing.

## Others

`print(...)` — a line to stdout, arguments joined with a space.
`BTA_VERSION` — the runtime's version string.

There is no `Promise`, no `window`, no `document`, no `fetch`, no `require`.
`Http` above is the one that speaks to a network; anything else still goes through
a child process (`Exec(["curl", …])`), which is a choice you should say out loud
to whoever asked.
