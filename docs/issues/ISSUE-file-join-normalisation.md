# ISSUE: `File.Join` does not normalise

## What the application needed

A screen that opens a file the user names inside a folder the application
chose: the folder is the working directory the user picked with
`Dialog.SelectFolder`, the name comes out of a record, and the path is built
with `File.Join(folder, name)`. The name is data, and data can carry `..`.

## What I wrote instead

`File.Within(path, folder)` after the join, as a second call: the join
concatenates, so `File.Join("/srv/root", "../../etc/passwd")` leaves the folder
the caller named, and the check afterwards is the only thing between the two.
It is a footgun that has to be remembered, and nothing in the join itself
says that one of its parts is data.

## The code I wish I could have written

```js
// the join that resolves ".." before it answers:
const path = File.Join(root, name)   // "/srv/root" + "../../etc/x" -> "/etc/x"
```

## Why the existing words do not cover it

`File.Join` concatenates — `g_build_filenamev` and nothing else
(runtime/src/bta_sys.c:445) — so `..` survives into the answer. `File.Absolute`
canonicalises a path, but it also resolves it against the working directory,
so it is not a join and the two halves cannot be made one call. `File.Within`
is the question, `File.Relative` is the spelling of the answer, and
`File.IsExtension` is the case-folded extension question; none of them is the
join. The pieces are there and the default is not.

## Prior art

Node's `path.join`, which normalises, and `path.resolve`, which normalises
and resolves. Python's `os.path.normpath`. .NET `Path.GetFullPath`. Go's
`filepath.Clean`. Rust's `Path::canonicalize`.

## How much it mattered

It works, but a part of it is noticeably worse: a footgun that has to be
remembered, because the safe question (`File.Within`) is a separate call the
caller must remember to make.
