# Settings

What the application remembers between runs.

Anything JSON carries, kept in
`Application.ConfigDirectory/settings.json` and **written on every change** — so
there is nothing to flush and nothing lost when a program ends badly.

## Every member

| | | |
|---|---|---|
| `Clear()` | forgets everything | [reading and writing](#reading-and-writing) |
| `Delete(key)` | forgets one | [reading and writing](#reading-and-writing) |
| `Get(key, fallback)` | → what was remembered, or the fallback | [reading and writing](#reading-and-writing) |
| `Has(key)` | → whether there is anything under that name | [reading and writing](#reading-and-writing) |
| `Keys()` | → every name | [reading and writing](#reading-and-writing) |
| `Path` | the file it is kept in | [where it lives](#where-it-lives) |
| `Set(key, value)` | remembers it | [reading and writing](#reading-and-writing) |

## Reading and writing

```js
Settings.Set("recent", [dir, ...Settings.Get("recent", [])].slice(0, 8));
if (Settings.Get("showGrid", true)) …
```

**The fallback is the part to get right**: `Get("on", true)` tells a missing
setting from one that is `false`, which two lines of `if (Settings.Has(…))` say
worse.

A key is a name you choose. Dotting them — `tree.view`, `session.window` — is
what this tree does, because a settings file is something a person may open and a
prefix is how the entries of one subject stay together.

## Where it lives

| | |
|---|---|
| `Path` | the file, for an application that wants to show it or open its folder |

Named after the project, so **two projects never read each other's**, and in the
config directory rather than beside the project — a project is a thing people
hand to each other, and where somebody's divider sits is not part of it.

## What belongs here

The furniture: window size, divider positions, the recent list, which view a tree
was in, whether a pane was open. **Not the work** — that is a file the user knows
about — and not anything secret, since a settings file is plain JSON in the
user's home.

## What goes wrong

- **A `false` setting read as missing.** `Get(key, true)` with no fallback
  thought.
- **The file grew without end.** Nothing prunes it: a map keyed by project or by
  file has to be trimmed to something — the recent list, in this tree's case.
- **Two projects shared a setting.** They cannot; the file is named after the
  project.
- **A value came back as a plain object.** JSON is what it carries: a `Decimal`,
  a `Date` or a class instance goes in as its JSON and comes back as that.

## See also

[`Application`](Application.md) · [`File`](File.md) ·
[ide.md](../../ide.md), whose window and per-project sessions are kept this way
