# ISSUE: no `File.Relative`, and an extension has to be case-folded by hand

## What the application needed

Two things a program that shows a project tree does constantly: say a path the
way the user thinks of it -- *relative to the project* -- and ask whether a file
is a `.js`.

## What I wrote instead

For the first, the same slice in eight places:

```js
const shown = p.startsWith(root + "/") ? p.slice(root.length + 1) : p;
```

`Runner.js:221` and `:321`, `Debugger.js:438`, `Git.js:149`, `Classes.js:769`,
`Document.js:169`, `Exporter.js:93`, and `examples/serve/Main.js:40` -- which
slices without asking `startsWith` at all, because in that one the answer is
known. `Git.js` is a whole boundary class built on getting this right, with the
`rev-parse --show-prefix` trap in `AGENTS.md` behind it.

For the second:

```js
File.Extension(f).toLowerCase() === "js"
```

**43 times** across `ide/`, `examples/` and `lib/` -- 46 counting `tests/` --
with `Classes.js` alone holding twelve.

## The code I wish I could have written

```js
const shown = File.Relative(p, root);      // and File.Within(p, root) to ask
if (File.IsExtension(f, "js")) { … }       // or File.Extension(f, { Fold: true })
```

## Why the existing words do not cover it

`File` publishes `Join`, `Absolute`, `Name`, `BaseName`, `Directory` and
`Extension` -- everything that takes a path apart, and nothing that relates two
paths. So the one operation that needs to know about *both* is the one an
application writes itself, and writes with a string comparison that is wrong in
the cases a path library exists for: a trailing slash, `.` components, a symlink,
a root that is not a prefix at all.

`Extension` answers the case that was on disk, which is right, and the question
almost every caller has is case-insensitive -- so the fold is correct and it is
also 43 chances to write one of them without it.

## Prior art

Python `os.path.relpath` and `PurePath.is_relative_to`. .NET
`Path.GetRelativePath`. Node's `path.relative`. GLib has `g_file_get_relative_path`
on `GFile`, which is what this would be built on. For the second,
`g_str_has_suffix` with a folded copy, or what .NET spells
`Path.GetExtension(f).Equals(".js", OrdinalIgnoreCase)`.

## How much it mattered

Nothing is broken; 43 of one idiom and eight of another is what a missing verb
looks like from the outside. The one with teeth is `Relative`: the hand-written
version is a prefix test, and a prefix test says yes to `/home/matias/proj2`
for a root of `/home/matias/proj`.
