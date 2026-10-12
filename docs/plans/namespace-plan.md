# Namespace: keep it, or let modules replace it

**Status: not started -- a decision to take later, written down so it is taken
once.** The modules plan built what made the question live: a file with
`export` keeps its own names (stages 2 to 4), and on 2026-10-12 the IDE, which
was the only program using `Namespace()`, became modules and stopped using it.
Nothing in this tree calls it now but its own tests.

## What `Namespace` is today

`GLOBAL.Namespace(path)` in `runtime/js/rad.js`: creates an ordinary object on
the global object at a dotted path (`Namespace("A.B")` makes both levels) and
remembers it in `namespaces`. A class is put there by assignment:

```js
Namespace("Widgets");
Widgets.Stepper = class Stepper extends Component { ... };
```

What reads it:

| Where | What it does with a namespace |
|---|---|
| `forms.js`, `Widget.TypeName` | writes a class into a `.form` as `Widgets.Stepper`, walking `namespaces` |
| `bta_lookup_global` | resolves a qualified `type`, `startup` or `Widget.New` name by walking properties |
| `bta_task.c`, `js_walk` | finds a task class as `Folder.Name` -- **by folder, not by `Namespace()`**, the one place a folder names anything |
| `ide/modules/Classes.js` | `readNamespaces`, `namespaceMembers`, `namespaceHere`, `qualifiedName`: what each file declares and puts where |
| `ide/modules/FormFiles.js` | `retargetNamespace`, and `writeForm`/`writeModule` writing `Namespace("X")` into a new file |
| `ide/modules/ProjectTree.js` | `addNamespaces`: one node per namespace in the project view |
| `ide/forms/MainForm.js` | the New form dialog offering the folder's namespace |
| `ide/modules/Completion.js`, `Navigator.js` | completing after `Widgets.`, and resolving a qualified name to its tail |
| `tests/widgets` | 27 `Namespace(` uses, a `Gadgets/Stepper.js` fixture |
| `tests/ide` | the `namespaces`, `prefixes`, `folders` and `tooldirs` phases (13 uses) |

And in the documents: `api.json` and its rows, `bintana-docs`' `formats.md`
(*Namespaces*), `runtime-api.md`, `reference/globals/Task.md`; `bintana-llm`'s
`guide/05-language.md`; outside the three, `bintana-book` chapter 8 and
`bintana-assistant/docs/language.md` teach it. No application known to use it:
`bintana-project`, `bintana-zabbix`, the examples and `lib/` do not.

## What a module already does instead

- **Privacy** -- what a namespace was used for in the IDE (its forty-five
  classes off the global scope) -- is a module's: a file keeps everything it does
  not export.
- **Two classes of one name** in two files both load; the name is refused where
  a file uses it with no `import` (patch 16), and an `import` with `as` chooses
  and renames in that file.

## The one thing a module cannot do

**A `.form` cannot import.** Its `type` is a name resolved globally, so with
two modules exporting `Stepper` there is no way for a `.form` to say which --
the getter refuses the ambiguous name and the form does not load. `"type": "Widgets.Stepper"` is
the only spelling today that lets two folders each have a `Stepper` *used from
a form*. The same holds for `startup` and `Task.Start(name)`. Everything else
`Namespace` offers, a module offers too.

How often that matters is the real question, and it has never come up: no
project here has two components of one name.

## Options

**A. Keep it as it is.** It costs nothing to run and little to maintain, and it
is the answer to the `.form` case above. The cost is two ways to group names,
one of which nobody uses, and the IDE carrying its namespace views, rename and
dialog code for them.

**B. Retire it.** In stages, so no program breaks without being told:

1. `Namespace()` keeps working and says once, on stderr, that it is deprecated
   and what to write instead (`export class`, and renaming a clash).
2. The IDE stops offering it: no namespace in a new form or module, no option in
   the New form dialog. Reading what a project already declares stays, so an
   old project still opens and draws right.
3. A release later, the global goes: `rad.js`, `Widget.TypeName`'s walk, the
   qualified half of `bta_lookup_global` (a dotted name stays for anything else
   that is reached by properties), the IDE's namespace code, the tests and the
   documents above, and `api.json`.

   `bta_task.c`'s folder prefix should be decided in the same change: it is a
   folder naming a class, which the rest of the runtime refuses to do.

**C. Retire it and give a `.form` a way to choose.** As B, plus a spelling for
a `type` that names a module -- for instance a path, `"type":
"widgets/Stepper.js:Stepper"`, resolved with the module loader that `import`
already uses. That answers the one case B gives up. It is a new format rule,
and the designer, the serialiser and the extractor would all have to learn it;
worth it only if a project actually hits two components of one name.

## Recommendation

**A for now, B when it gets in the way.** Nothing is broken, and retiring a
published global needs a deprecation that has nobody to warn today. Revisit
when one of these happens:

- the IDE's namespace code has to change for another reason (the project view,
  the New form dialog, a rename) -- that is when keeping it costs something;
- a project needs two components of one name in a `.form` -- then it is C, or A
  for good, and the argument is that project;
- a release is cut that can carry a deprecation notice.

Whatever is decided, the `bta_task.c` folder prefix is worth a look on its own:
it is the one place a folder names a class.
