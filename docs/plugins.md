# Native plugins

**A library may carry native code.**  `uses: ["taglib"]` resolves to a directory
over the six places in [formats.md](formats.md#libraries-uses); if that
directory also holds `taglib.so` -- the suffix is GModule's, so `.dll` on
Windows -- the runtime loads it before the library's `.js` and lets it install
globals with the table in `runtime/include/bta_plugin.h`.  The JavaScript half
of the library then wraps what the native half published, which is the whole
reason the two share a directory:

```
lib/taglib/
  taglib.so      the plugin: `TagLib.Read(path)`, `TagLib.Write(path, tags)`
  taglib.js      optional: `TagLib.ReadFolder(folder)`, and so on
```

The file is named after its directory the way the library itself is named by
`uses`: one name, no manifest, nothing to keep in step.  A directory with no
shared object is an ordinary JavaScript library and nothing about it changes.

**When not to write one.**  If it can be a `.js` library, it should be -- see
[extending.md](extending.md).  A plugin is for reaching a C library the runtime
does not carry and should not: a format parser, a database driver, a device.
TagLib is the worked example: a program that reads audio tags wants it, a
runtime that carries every possible parser is a runtime nobody can build.

## The contract

`bta_plugin.h` is the whole of it, and it is the **only thing a plugin
compiles against**: the plugin links neither the runtime nor QuickJS, and the
runtime exports no symbols for it.  The JavaScript it can touch is the table it
is handed, so the ABI is as big as that header and no bigger -- which is also
why nothing has to be linked with `-rdynamic` and why a plugin works the same
on Linux, macOS and Windows.

```c
#define BTA_PLUGIN_ABI 1

typedef struct BtaValue { uint64_t opaque[2]; } BtaValue;   /* opaque */

typedef BtaValue (*BtaPluginFn)(const BtaHost *host, void *user, int argc,
                                const BtaValue *argv);

typedef struct BtaPlugin {
    int abi;
    int  (*init)(const BtaHost *host, BtaValue global);
    void (*cleanup)(void);
} BtaPlugin;

#define BTA_PLUGIN_ENTRY bta_plugin
BTA_PLUGIN_EXPORT BtaPlugin BTA_PLUGIN_ENTRY = { BTA_PLUGIN_ABI, my_init, NULL };
```

The runtime looks for the one symbol `bta_plugin`; `bta_plugin.h` spells both
halves of that name so they cannot drift.  `init` runs once, before `rad.js`
and before any source of the project, with the global object -- **borrowed**,
so set properties on it.  `cleanup` runs once at teardown, after the JavaScript
context is gone: C resources only, and it must not call the host.

### The host table

| Verb | | |
|---|---|---|
| `undefined` `null` `boolean` `number` `string` | make a value; the caller owns it | |
| `object` `array` | an empty one, likewise | |
| `set(host, obj, key, value)` | adds a property, **taking the value over** | |
| `push(host, array, value)` | appends, likewise | |
| `get(host, obj, key)` | reads one; the caller owns it; `undefined` for a key that is not there | |
| `function(host, name, length, fn, user)` | a C function as a JavaScript one | |
| `kind(host, v)` | `BTA_KIND_UNDEFINED` `_NULL` `_BOOL` `_NUMBER` `_STRING` `_OBJECT` `_ERROR` | |
| `text(host, v)` | `String(v)`, **borrowed until the callback returns** | |
| `value(host, v)` | `Number(v)`, `NaN` when it does not convert | |
| `release(host, v)` | drop a value you decided not to use; safe on any value | |
| `fail(host, message)` | raise a JavaScript error, then return `undefined()` | |
| `log(host, text)` | a line for a person, at **Debug** level, through the runtime's logger | |
| `call(host, fn, this, argc, argv)` | invoke a JavaScript function; `this` and `argv` borrowed, the answer yours | |

`argc` in a callback is **at least the declared arity**: a missing argument
arrives as `undefined` and never as a short call, so a function declared with
two arguments can read both however JavaScript called it.  Extra arguments are
at the end, and `argc` says how many there were.

### Ownership, in one paragraph

Every value a host function returns is **the plugin's**.  Every value passed
into `set`, `push` or a callback's return is **handed over**: the host owns it
from then on, so do not release it afterwards.  A callback's `argv` and a
string from `text()` are **borrowed**: valid until the callback returns, never
released and never stored.  `release` exists for the value you decided not to
use, and is safe on `undefined`/`null`; leaking a value is the mistake the
rules are written against, and calling `release` on one already handed over is
a double free.

### Calling back into JavaScript

`call` is the other direction: a plugin that was handed a function -- an option
callback, a per-item handler -- invokes it.  `this` is what the call sees as
`this` (`undefined` is the usual answer), `argv` is borrowed for the length of
the call, and the answer is owned by the caller.

**An error the called function throws does not have to be handled.**  It stays
pending on the context, so the callback that called `call` can return
`undefined()` and the error surfaces at *its* caller, which is what a wrapper
wants.  What a plugin must not do is carry on as if nothing happened: while an
exception is pending every value answers `BTA_KIND_ERROR`, so the shape is

```c
BtaValue r = h->call(h, fn, h->undefined(h), 1, &value);
if (h->kind(h, r) == BTA_KIND_ERROR)
    return h->undefined(h);      /* the pending error propagates by itself */
```

**`call` was the first field appended to `BtaHost`**, and it needed no ABI bump:
a plugin compiled against the version-1 header never reads past `log` and keeps
working, which is the rule this file states now used once.  A capability
appended to the table comes with a `BTA_PLUGIN_HAS_<NAME>` macro as well, so
*source* that has to build against an older header can ask whether it is there
(the suite's golden `testplug-abi1` is the one in this tree that does).

### Errors

There is no return code.  Call `fail(message)` and return `undefined()`; the
runtime asks the engine after every callback and raises the error into
JavaScript, where an ordinary `try`/`catch` catches it.  `init` returning
non-zero is the same statement made once at startup, and it **stops the
program** -- see below.

### The ABI number

`BTA_PLUGIN_ABI` identifies the contract as a whole.  It goes up when
`BtaPlugin` or any signature changes, or when the semantics above do.  Adding a
function **to the end of** `BtaHost` does not bump it: a plugin compiled
against an older header reads only the prefix of the table it was handed.
Reordering or removing a field does bump it.  A plugin whose number differs is
refused by name, saying both numbers; the answer is to rebuild it against the
runtime it is for.

## Building one

`cmake --install` puts `include/bintana/bta_plugin.h` and a `bintana.pc` where a
compiler can find them, and **a `CMakeLists.txt` is the reference** — it is what
the TagLib example uses, what this runtime and most C libraries are built with,
and what a reader can copy:

```cmake
find_package(PkgConfig REQUIRED)
pkg_check_modules(BINTANA REQUIRED bintana)          # the header, and no library
pkg_check_modules(TAGLIB REQUIRED IMPORTED_TARGET taglib_c)

add_library(taglib MODULE taglib.c)
target_include_directories(taglib PRIVATE ${BINTANA_INCLUDE_DIRS})
target_link_libraries(taglib PRIVATE PkgConfig::TAGLIB)  # its library, not ours
set_target_properties(taglib PROPERTIES PREFIX "" OUTPUT_NAME "taglib")
```

Three things about that are the contract, not style.  It asks for
`BINTANA_INCLUDE_DIRS` and not `PkgConfig::BINTANA`, because there is nothing to
link and saying so in the target makes it visible.  The only `link_libraries` is
the C library the plugin wraps — so nothing needs `-rdynamic`, an export list or
an import library, on any platform, and `-Wl,-z,defs` must not be added: the
plugin has no undefined symbols of its own and the runtime is not one of them.
And `PREFIX ""` names the file after the library, because a plugin lives at
`<name>/<name>.<suffix>`.

By hand it is the same command line:

```sh
cc -shared -fPIC -O2 -o taglib.so taglib.c \
   $(pkg-config --cflags --libs taglib_c) $(pkg-config --cflags bintana)
```

**Where `bintana.pc` is found depends on whether the runtime is installed.**
After `cmake --install` it is under the prefix's `lib*/pkgconfig`; `/usr/local`
needs no path of its own on either distribution, and any other prefix needs
`PKG_CONFIG_PATH` pointing there ([installing.md](installing.md#install) has the
one Fedora detail, a wrapper that makes the obvious query answer wrongly).
Against a **checkout**, the build tree writes a pc of its own into
`<build>/pkgconfig`, describing the source paths, so nothing has to be installed
at all:

```sh
PKG_CONFIG_PATH=<bintana>/build/pkgconfig cmake -S . -B build
```

**Uninstalling** is the other half and it is small: a plugin installed to
`<data>/bintana/lib/<name>/<name>.so` is removed by taking that directory away.
Nothing else knows about it — the runtime reads the directory at startup and
holds no registry — so there is no state left behind, and a plugin that installs
with CMake can offer `--target uninstall` the way the runtime's own install
does ([installing.md](installing.md#uninstall)).

## A worked example: TagLib

The wrapper lives outside the runtime's tree, and this is its shape.  TagLib's
C binding hands out `char *` strings that are copied into JavaScript and then
freed **all at once**; the file handle is freed on every path out.

```c
#include "bta_plugin.h"
#include <taglib/tag_c.h>

static BtaValue text_of(const BtaHost *h, char *s)
{
    return h->string(h, s ? s : "");
}

static BtaValue read_fn(const BtaHost *h, void *user, int argc,
                        const BtaValue *argv)
{
    TagLib_File *file;
    TagLib_Tag  *tag;

    if (argc < 1 || h->kind(h, argv[0]) != BTA_KIND_STRING) {
        h->fail(h, "TagLib.Read(path) expects a path");
        return h->undefined(h);
    }

    file = taglib_file_new(h->text(h, argv[0]));
    if (!file || !taglib_file_is_valid(file)) {
        if (file)
            taglib_file_free(file);
        return h->null(h);          /* not audio: a data answer, not an error */
    }

    BtaValue out = h->object(h);
    tag = taglib_file_tag(file);
    if (tag) {
        h->set(h, out, "Title",  text_of(h, taglib_tag_title(tag)));
        h->set(h, out, "Artist", text_of(h, taglib_tag_artist(tag)));
        h->set(h, out, "Year",   h->number(h, taglib_tag_year(tag)));
    }

    taglib_tag_free_strings();
    taglib_file_free(file);
    return out;
}

static int taglib_init(const BtaHost *h, BtaValue global)
{
    BtaValue api = h->object(h);

    h->set(h, api, "Read", h->function(h, "Read", 1, read_fn, NULL));
    h->set(h, global, "TagLib", api);
    return 0;
}

BTA_PLUGIN_EXPORT BtaPlugin BTA_PLUGIN_ENTRY = {
    BTA_PLUGIN_ABI, taglib_init, NULL,
};
```

Writing is the same shape with `taglib_tag_set_title` and `taglib_file_save`,
and the rule that makes it useful in a dialog: **a field the request object
does not name is left alone** (`h->get` answers `undefined`), a `null` clears
it, and the answer is the tag as the file now holds it.  `h->kind(v)` is what
tells the two apart.

The library's `.js` may then add what the C did not:

```js
function ReadFolder(folder) {
    return Directory.Files(folder)
        .map((name) => ({ path: name, tags: TagLib.Read(name) }))
        .filter((t) => t.tags !== null);
}
```

## What a plugin cannot do

- **Add a widget class.**  The class table and `BtaWidget` are the runtime's
  implementation; freezing them into this contract would make every internal
  change a breaking one.  A widget a library ships is a `Component` its `.js`
  declares, which is ordinary Bintana code and works already.
  There is a second reason, and it is the designer: the IDE builds the controls
  of the project it is *drawing* inside its own process, and its palette reads
  the runtime's class table — so a class the runtime has not registered cannot
  be offered, and offering one would mean loading (and unloading) another
  project's plugins mid-process.  It is also why an optional engine is a
  build-time flag or a probe (`Terminal`, `Video`) rather than a plugin: the
  class has to be there for a `.form` to load, whether or not this machine can
  run it.
- **Appear in `bintana.d.ts`.**  Completion in an editor is generated from the
  runtime's own surface; a plugin's globals are the library's to document.
- **Use the runtime's helpers.**  `bta.h` is not installed and not part of the
  contract: a plugin has the table and the C library it wraps.
- **Be unloaded and reloaded.**  A plugin is loaded once per process, in
  `uses` order, before the project runs.

## How the runtime loads it

`bta_plugin.c`, from `install_globals`: for each library, `<dir>/<basename>.<suffix>`
if it is a regular file, opened with GModule in the local namespace.  A name
that resolves to a directory with no shared object is not a plugin and is
silent; a shared object that is there and cannot be used **stops the program**
with a message naming the file, exactly as a library that is not there stops it.
The message goes to stderr and, in a project with a window, into the same alert
a JavaScript error gets — a form project started from a menu has no terminal to
read, and the first version of this stopped the program with nothing on screen:

- `g_module_open` fails -- the loader's own message, usually a missing library;
- no `bta_plugin` symbol -- "exports no bta_plugin, so it is not a Bintana plugin";
- a different ABI -- "was built for ABI N, this runtime speaks M";
- `init` returns non-zero or raises -- the error is dumped and the program exits 2.

A plugin whose `cleanup` runs, a `.so` opened twice under two names, and the
order of `uses` are all asserted in `tests/widgets` (`Plugin`); the reference
implementation every verb is written from is `tests/plugins/testplug.c`, which
links nothing at all -- a capability reached through a symbol is a link error
there rather than something that happens to work.

**And the ABI number is held to its promise by a plugin built the old way.** The
same source is also compiled against `tests/plugins/abi1/bta_plugin.h`, a frozen
copy of the version-1 header, so the suite loads one plugin that calls the host
table by version 1's offsets. A field appended to `BtaHost` is fine -- an old
plugin reads the prefix -- while a field reordered without the number moving
calls the wrong slot and fails the suite, which is the one failure a plugin
recompiled from the current source can never see.
