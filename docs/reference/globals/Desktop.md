# Desktop

The session this program is running in, and the entries a user installs for
themselves.

The XDG directories — where a user's own data, configuration and cache belong,
whatever the desktop calls them — and `Desktop.Entries`, the module that reads
and writes the `.desktop` files a program puts in the user's menu without root
and without a package.

```js
Desktop.DataDirectory                  // /home/ana/.local/share
Desktop.Entries.Directory              // /home/ana/.local/share/applications
Desktop.Entries.Installed()            // ["hello", "world"]
```

## Every member

| | | |
|---|---|---|
| `CacheDirectory` | where throwaway data belongs | [the directories](#the-directories) |
| `ConfigDirectory` | where settings belong, all of them | [the directories](#the-directories) |
| `DataDirectory` | where this user's data belongs | [the directories](#the-directories) |
| `Directory` | the user's applications directory | [where an entry lives](#where-an-entry-lives) |
| `Entries` | the desktop entries module | [desktop entries](#desktop-entries) |
| `Exec(argv)` | the `Exec=` value for a command | [the command line](#the-command-line) |
| `Install(id, entry)` | writes one, atomically | [installing](#installing) |
| `Write(path, entry)` | writes one at a path you name | [installing](#installing) |
| `Installed()` | the ids this user has | [what is installed](#what-is-installed) |
| `Read(id)` | one entry as data, or `null` | [reading](#reading) |
| `Uninstall(id)` | removes one | [installing](#installing) |

## The directories

| | |
|---|---|
| `DataDirectory` | `$XDG_DATA_HOME`, or `~/.local/share` when the desktop has not moved it. Application data that belongs to this user: a database, a saved document, an installed menu entry |
| `ConfigDirectory` | `$XDG_CONFIG_HOME`, or `~/.config`. Settings, kept apart from data because a backup or a sync usually wants one and not the other |
| `CacheDirectory` | `$XDG_CACHE_HOME`, or `~/.cache`. Anything that can be thrown away and rebuilt |

**Not `Application.ConfigDirectory`**, which is this *project's* own directory —
`~/.config/bintana/<name>` — and the place a program's settings go. These three
are the roots a desktop gives every application.

They are asked of GLib and never assembled from `HomeDirectory`: a machine whose
data home lives somewhere else is exactly the case the XDG variables exist for,
and a program that writes to the path it guessed writes where nothing reads.

## Desktop entries

A desktop entry is a `.desktop` file: the freedesktop *Desktop Entry
Specification*, which is a key file with groups, like an INI. A user's own
entries live in `Entries.Directory`; the system's live under
`/usr/share/applications` and are a packager's, not this object's.

The module is the read-and-write pair a program needs to offer *put this in my
menu*, and the format is GLib's and not ours: the escaping, the localized keys
(`Name[es]`) and the value syntax all come from `GKeyFile`, which is what every
desktop's own reader is built on.

### Where an entry lives

| | |
|---|---|
| `Directory` | `DataDirectory/applications`, created on first use. Write an entry there and the desktop's menu offers it; there is nothing to register and no index to update |

The **id** is the file's name without `.desktop` — `hello` is
`Directory/hello.desktop` — and it is what the specification calls the
application id. Letters, digits, `-`, `_` and `.` only: a separator would be a
path out of this directory, and a name ending in `.desktop` is a file name
somebody typed where an id belongs, which would install `hello.desktop.desktop`
and be impossible to find again. Both are refused by name.

### What is installed

| | |
|---|---|
| `Installed()` | the ids in `Directory`, sorted, `.desktop` removed. Only this user's: a system entry is never listed, and asking whether an entry is installed is one `includes` on this |
| `Read(id)` | one entry as data, exactly what `Install` takes, or `null` when there is no such file |

```js
Desktop.Entries.Installed()            // ["hello"]
Desktop.Entries.Read("hello")
// { "Desktop Entry": { Type: "Application", Name: "Hello", Exec: "\"/usr/bin/bintana\" \"/home/ana/hello\"" } }
```

Absent is an answer and not an error, both ways: `Read` answers `null` and
`Uninstall` answers `false` for an entry that is not there, because asking about
one that is already gone is how a caller finds out.

### Installing

| | |
|---|---|
| `Install(id, entry)` | writes `Directory/<id>.desktop` and answers the path. Atomic — a temporary beside it, renamed over — so a failure leaves whatever was there |
| `Write(path, entry)` | the same entry and the same checks at a path the caller names, **making the directory** when it is not there. For the entry a package installs, which is not one this user's menu has; answers nothing |
| `Uninstall(id)` | removes it, answering whether there was one. A file that is there and cannot be removed throws |

**`Write` is the half a packaging step needs.** `Install` addresses the one
directory a menu reads and names the file after an id; a package builds a tree
of its own and writes `<id>.desktop` into it before anything is installed, so
what it needs is the entry's format, its validation and its quoting at a path of
its choosing — which is what `Write` is, and why it is not a mode on `Install`:
one writes to this user's menu, the other to wherever the caller says.

```js
Desktop.Entries.Install("hello", {
    "Desktop Entry": {
        Type:    "Application",
        Name:    "Hello",
        Comment: "A greeting",
        Exec:    Desktop.Entries.Exec([Application.Executable, Application.Directory]),
        Icon:    "applications-development",
    },
});
```

**An entry that is not one is refused instead of written.** The `[Desktop Entry]`
group is required, with a `Type` and a `Name`; a `Type=Application` also needs an
`Exec`. Every desktop skips a file that breaks those rules, and it skips it in
silence — a menu item that is not there, with nothing anywhere saying why. Values
must be text: a `Terminal` of `false` is the string `"false"`, as the format
spells it.

An entry is installed **whole**: `Install` replaces whatever file has that id.
Comments and blank lines are not part of the shape `Read` answers and do not
survive the rewrite, which is the right trade for entries a program installs and
removes of its own and the wrong one for editing a packager's file.

### The command line

`Exec` is a command in a string, and the string has a quoting of its own — not
the shell's. An argument with a space in it is quoted; `"`, `` ` ``, `$` and `\`
are escaped inside those quotes; `%` is the format's field-code marker (`%f`,
`%u`), so a literal one is written twice. And all of that sits on top of the key
file's own escaping, which doubles every backslash again in the file.

That is three rules deep and none of them is worth remembering.

| | |
|---|---|
| `Exec(argv)` | the value for the `Exec` key: the arguments as an array — the shape `Exec` and `Terminal.Run` already take — quoted and escaped the format's way |

It is the whole of the answer, and what a program should use.

```js
Desktop.Entries.Exec(["/opt/My App/run", "--open", "100%"])
// "\"/opt/My App/run\" \"--open\" \"100%%\""
```

Measured against `gio launch` and `desktop-file-validate`, which are a real
`GDesktopAppInfo` and the specification's own checker: an argument containing a
space, a `"`, a `$`, a `\`, a `` ` ``, a `%` or an accent comes out the other side
exactly as it went in.

## See also

[`Application`](Application.md) · [`Environment`](Environment.md) ·
[`File`](File.md)
