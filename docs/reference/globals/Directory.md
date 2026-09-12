# Directory

What is in a folder, and making and removing them.

Three questions — the names, the files, the folders — each answered sorted, and
three verbs. Like [`File`](File.md), all of it is synchronous.

## Every member

| | | |
|---|---|---|
| `Copy(from, to)` | a whole tree, into a new place | [making and removing](#making-and-removing) |
| `Delete(path)` | an **empty** directory | [making and removing](#making-and-removing) |
| `DeleteTree(path)` | it and everything in it | [making and removing](#making-and-removing) |
| `Files(path, [pattern-or-options])` | → the **full paths** of the files, sorted | [what is in it](#what-is-in-it) |
| `Folders(path, [pattern-or-options])` | → the same for directories | [what is in it](#what-is-in-it) |
| `List(path, [pattern])` | → the **names** in one directory, sorted | [what is in it](#what-is-in-it) |
| `Make(path)` | creates it and any missing parent | [making and removing](#making-and-removing) |

## What is in it

| | |
|---|---|
| `List(path, [pattern])` | the **names**, sorted, with no `.` or `..` — what a tree of one folder shows |
| `Files(path, [pattern-or-options])` | the **full paths** of the files, sorted |
| `Folders(path, [pattern-or-options])` | the same for the directories |

```js
Directory.Files(dir)
Directory.Files(dir, "*.form")
Directory.Files(dir, { Pattern: "*.c", Recursive: true })
Directory.Folders(dir, { Recursive: true })
```

**Names or paths, and the difference is the point**: `List` answers what to draw
in a row, `Files` answers what to open. A program that joins `List`'s answer back
onto the folder is asking for `Files`.

**Sorted at each level and depth-first**, so two runs list the same tree the same
way — which is what makes a listing comparable, a test repeatable and a scan's
output stable in a diff. A symlinked directory is listed and **not entered**; a
symlink to a file is an ordinary file.

## Making and removing

| | |
|---|---|
| `Make(path)` | creates it **and any missing parent**, so there is no loop to write |
| `Copy(from, to)` | a whole tree |
| `Delete(path)` | an **empty** directory, as [`File.Delete`](File.md) is |
| `DeleteTree(path)` | it and everything under it — the one to be careful with, and the reason it has a name of its own rather than a flag |

[`File.Trash`](File.md#moving-and-removing) takes a folder whole and is
recoverable, which is the kinder verb wherever the user is the one deciding.

## What goes wrong

- **It threw instead of answering an empty list.** All three throw when the path
  is not a directory — `cannot list <path>` — because *there is nothing there*
  and *it is empty* are different answers and a program that confuses them
  deletes the wrong thing. Ask [`File.IsDir`](File.md#asking-about-one) first.
- **A folder in the middle of a recursive walk stopped everything.** It does not:
  a directory the walk finds and **cannot read** is skipped rather than ending
  the walk. What is refused is the path you asked about.
- **The order changed between runs.** It does not; something else is sorting.
- **A symlinked folder was not recursed into.** By design — that is how a walk
  avoids a loop.

## See also

[`File`](File.md) · [`Dialog`](Dialog.md), for asking the user which folder ·
[`Application`](Application.md), for where the project's own files are
