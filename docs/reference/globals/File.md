# File

Reading and writing files, and the names of the paths they live at.

Everything here is **synchronous**, and that is a decision rather than an
oversight: a desktop application reads a project's files, a note, a settings file
— work that takes microseconds — and a callback for each of them would be a
ceremony around nothing. What is not synchronous is what genuinely waits:
[`Http`](Http.md), [`Exec`](Exec.md) and a file `Watch`.

## Every member

**Reading and writing**

| | | |
|---|---|---|
| `Load(path)` | → the whole file as a string | [text](#text) |
| `LoadBytes(path)` | → the whole file as [`Bytes`](Bytes.md) | [bytes](#bytes) |
| `LoadJson(path)` | → it, parsed | [json](#json) |
| `Save(path, text)` | writes it **atomically** | [text](#text) |
| `SaveBytes(path, bytes)` | those bytes, exactly | [bytes](#bytes) |
| `SaveJson(path, value)` | one canonical shape | [json](#json) |

**Files themselves**

| | | |
|---|---|---|
| `Copy(from, to)` | **byte for byte**; refuses to clobber | [moving and removing](#moving-and-removing) |
| `Delete(path)` | a file, or an **empty** directory | [moving and removing](#moving-and-removing) |
| `Exists(path)` | → whether there is something there | [asking about one](#asking-about-one) |
| `Hash(path, [algorithm])` | → the file's checksum as hex | [asking about one](#asking-about-one) |
| `Info(path)` | → `{ Size, Modified, Type, Icon, IsDir }`, or `null` | [asking about one](#asking-about-one) |
| `IsDir(path)` | → whether it is a directory | [asking about one](#asking-about-one) |
| `Open(path)` | hands it to the desktop | [the desktop](#the-desktop) |
| `Rename(from, to)` | also moves; refuses to clobber | [moving and removing](#moving-and-removing) |
| `Trash(path)` | to the desktop's trash, whole for a folder | [moving and removing](#moving-and-removing) |
| `Watch(path, cb)` | tells you when it changes | [watching](#watching) |

**Paths, as text**

| | | |
|---|---|---|
| `Absolute(path)` | → the path, resolved | [paths](#paths) |
| `BaseName(path)` | `/a/b/c.js` → `c` | [paths](#paths) |
| `Directory(path)` | `/a/b/c.js` → `/a/b` | [paths](#paths) |
| `Extension(path)` | → `js`, no dot, `""` if none | [paths](#paths) |
| `Join(a, b, …)` | → one path out of pieces | [paths](#paths) |
| `Name(path)` | `/a/b/c.js` → `c.js` | [paths](#paths) |

## Text

| | |
|---|---|
| `Load(path)` | the whole file as a string. **Throws if it cannot be read**, and the message names the file: there is no `null` to test for and no silent empty string |
| `Save(path, text)` | writes it **atomically** — a temporary beside it, renamed over — so a failed write leaves the old file intact and a reader never sees half a file |

**Text is UTF-8 throughout.** `Load` decodes and `Save` encodes, which is why
[`Copy`](#moving-and-removing) exists: `Save(to, Load(from))` is right for source
and destroys a PNG.

## JSON

| | |
|---|---|
| `LoadJson(path)` | the file, parsed. **The error names the file**, which is the whole reason to use it over `JSON.parse(File.Load(p))` — a syntax error in *something* is not an answer |
| `SaveJson(path, value)` | one canonical shape: indented by two, one trailing newline. Every `.form` and every `project.json` in this tree is written by it, which is why a file saved by the IDE and one written by hand look the same |

## Bytes

| | |
|---|---|
| `LoadBytes(path)` | the whole file as [`Bytes`](Bytes.md), untouched — what `Load` cannot do, since it answers text |
| `SaveBytes(path, bytes)` | those bytes, exactly |

For a picture, an archive, anything downloaded: what
[`Http`](Http.md) answers with and what
[`Image.LoadBytes`](../widgets/Image.md) takes.

## Asking about one

| | |
|---|---|
| `Exists(path)` | whether there is anything there |
| `IsDir(path)` | whether it is a directory — the question to ask before [`Directory`](Directory.md)'s three verbs, which throw on anything else |
| `Info(path)` | `{ Size, Modified, Type, Icon, IsDir }`, or `null`. `.Type` is a content type you can test (`"image/png"`), `.Icon` is the name the desktop draws for that kind of file, and `.Modified` is a real `Date`, to the millisecond |
| `Hash(path, [algorithm])` | the checksum as hex, `"Sha256"` unless told — see [`Hash`](Hash.md). **Read in blocks**, so a video costs 64 KB of memory and not the video |

`.Icon` is the one field that needs a display: in a console project it answers
`""` and the other four still work.

## Moving and removing

| | |
|---|---|
| `Copy(from, to)` | **byte for byte**, so it works on images; refuses to clobber |
| `Rename(from, to)` | also moves; refuses to clobber |
| `Delete(path)` | a file, or an **empty** directory. Throws on failure |
| `Trash(path)` | to the desktop's trash, whole for a folder. Throws where there is no trash |

**`Trash` is what *Delete* usually should mean.** A program that offers *Delete*
and means `unlink` is harsher than the desktop it runs on — and one that offers
the trash needs no confirmation dialog, because the answer is recoverable. It
throws where the filesystem has no trash (a stick, tmpfs, a share); that is the
one case worth confirming.

## Watching

| | |
|---|---|
| `Watch(path, cb)` | `cb(event, path)` — `"Changed"`, `"Created"`, `"Deleted"` — and answers something with a `Stop()` |

**Only settled events arrive.** A save is a burst, and many editors write a
temporary and rename it over; both roads arrive as one `"Changed"`. A watch may
be stopped from inside its own callback, which is what a *reload once* wants.

What a program does with it is the hard half: the IDE compares the bytes it last
wrote with what is on disk, because a watch that reported every write would put a
notice up after every save of its own.

## The desktop

| | |
|---|---|
| `Open(path)` | hands the file to whatever the desktop opens that kind with. **It answers before the file is open**: launching is asynchronous and the program that opens it is somebody else's, so what this promises is that the request was made. A file that is not there is refused *here*, which is the failure a caller can do something about |

A **web address** is not this: that is [`LinkButton`](../widgets/LinkButton.md),
and giving a file verb two meanings would be the wrong place to put it.

## Paths

| | |
|---|---|
| `Join(a, b, …)` | one path out of pieces, with the separator the platform uses |
| `Absolute(path)` | the path resolved against the working directory |
| `Name(path)` | `/a/b/c.js` → `c.js` |
| `BaseName(path)` | `/a/b/c.js` → `c` |
| `Directory(path)` | `/a/b/c.js` → `/a/b` |
| `Extension(path)` | `js` — no dot, `""` when there is none |

These are **string** operations and touch no disk: they answer about a path that
need not exist.

## What goes wrong

- **`Load` threw and the program stopped.** That is the design: a file that
  cannot be read is not an empty one. `Exists` first, or catch.
- **A half-written file was read by something else.** Not from `Save`, which is
  atomic — but `SaveBytes` of a large file and a reader racing it is a different
  story, and so is anything a child process writes.
- **`Copy` destroyed a PNG.** It does not; `Save(to, Load(from))` does.
- **`Delete` refused a folder.** It takes an *empty* one;
  [`Directory.DeleteTree`](Directory.md) is the other verb, and `Trash` is
  usually the kinder one.
- **A watch fired twice for one save.** Editors write and rename; both settle
  into `"Changed"`, but a handler still has to be idempotent.
- **`Info` answered `null`.** Nothing is there.

## See also

[`Directory`](Directory.md) · [`Bytes`](Bytes.md) · [`Hash`](Hash.md) ·
[`Dialog`](Dialog.md), for asking the user which file ·
[`Settings`](Settings.md), for what an application remembers
