# Git: what was built, and the plan for the rest

**Stages 1 to 4 are built** (2026-09-13/14): status in the tree, the branch in
the status bar, the Changes window with the two lists and the side-by-side diff,
stage / unstage / discard / commit per file, and branches, switching and the
History window. `git init` came with them, because a project without a
repository is the one case where a menu of disabled items is a dead end. What is
left is [staging](#staging) 5 -- the remotes.

This document is the design as well as the record: what *is* settled is recorded
as settled, with the precedent or the measurement that settled it.

## Why this matters, and what the core is

The IDE already has a substitute for *running* git: the bottom panel's
`Terminal` tab is a real shell in the project's directory, kept for exactly
"git, a service, a file to move". What has no home is the one thing git is
for in daily work — **seeing the diff before committing**. Today that is
`git diff` in that terminal, read as monochrome text with no file list, no
staging and no way back to the editor. Every environment in this family shows
what is about to be committed where it can be read; this one shows it nowhere.

## What *complete* means

The list a design here is judged against:

1. status per file, in the project tree, kept with the listing
2. the branch in the status bar, with staged/unstaged counts
3. a side-by-side diff of each file **before** it is committed
4. stage, unstage, commit and discard per file, from that viewer
5. the log, and branches with checkout
6. pull, push and fetch against the configured remote
7. init and clone, for the project that has neither

## Settled: the scope

**IDE plus one helper, no C.** `Ide.Git` in `ide/modules/` answers every
question and every other file asks it — the `Translations`/`Exporter` shape.
The runtime already has everything this needs: `Exec` and `Exec.Wait` for the
child, `Application.HasCommand` for the guard, `File` for the worktree half,
`TreeView.SetText`/`SetIcon` for the indicators, and a `SourceEditor` whose
`Language` includes `diff`. Per the one rule, an integration that needed a
runtime feature would add it for every application; this one was checked and
needs none — except the [scroll gap](#the-one-gap-left-open), which is an
issue and not a prerequisite.

**The engine is the git CLI, not libgit2.** A binding is a new dependency for
what `msgmerge` and `tar` already prove the pattern for: ask with
`HasCommand`, say the sentence when it is missing, run the tool. `git status`
is even the documented example of what `Exec.Wait` is for
([async-plan.md](async-plan.md)).

**`Wait` for what ends in milliseconds, callbacks for the network.**
`rev-parse`, `status`, `branch`, `log`, `diff` and `show` block with a
`Timeout`; `pull`, `push`, `fetch` and `clone` are async `Exec` into the log
pane, cancellable with `Stop()` — the `Runner` mold, including signalling the
whole process group.

**`status --porcelain=v1 -z`, parsed on NUL.** The human output is locale and
the porcelain is a contract; `-z` is what survives spaces and accents in file
names. Renames (`R old -> new`) map to two paths.

**Mutating the worktree goes through the IDE's existing doors.**
`saveAllDirty()` before `checkout`/`pull` (the Run/Export precedent: never
operate on something other than what is on screen); `ConfirmForm` for discard,
checkout-with-dirty and branch delete; and disk changing under open tabs is
`ReloadBar` plus `Session`'s silent skip — reused, not reinvented, since
`git checkout` taking files away is the case those were written for.

**No authentication of its own.** Remotes use the system's credential helper;
a remote asking for a user is a log line pointing at it, plus the Terminal tab
that is already there. Secrets are never stored — the same refusal `Video`
makes with its RTSP password, which never reads back.

## The core: the diff viewer

A non-modal window of its own (`GitForm`), single instance raised rather than
stacked — the `SearchForm` precedent, since the point of a diff is to go back
to the editor behind it.

```
Split
  left:  TableView of changed files (file, state M/A/D/?/R), MultiSelect
  right: Switcher [Side by side | Unified]
           side by side: Split(Before: SourceEditor RO + After: SourceEditor RO)
           unified:      SourceEditor RO, Language="diff"
bottom: message TextEditor + Stage / Unstage / Discard / Commit
```

Where each half comes from, per position of the toggle:

| | Before | After |
|---|---|---|
| Unstaged | `git show :<path>` (the index; empty for untracked) | the worktree file via `File.Load` |
| Staged | `git show HEAD:<path>` | `git show :<path>` |

Side by side reads code in the file's own language — strictly better than a
unified hunk for answering *what am I about to commit*. The unified tab is the
net underneath: renames, binaries, and diffs past the line cap say so there
instead of filling two buffers with something unreadable. `diff` highlighting
costs nothing: it is a GtkSourceView id the machine already has, confirmed via
`PropertyOptions("Language")` rather than written down.

Going to a file is `Activate` (double click, Enter) and never selection — the
catalogue's reason word for word: selection walks with the arrow keys, and a
viewer reloading a `git show` per row walked through is unusable, besides
spawning N children for one look.

**Staging is per file in v1, on purpose.** Per-hunk stage needs a hunk parser
plus `git apply --cached`, which is a second feature wearing the first one's
name. The trigger to build it: file-level proving too coarse in use — said by
a caller, not guessed here.

## The chrome around it

A top-level `MnuGit` menu (between Project and Form: it is a whole area, the
way Form has its own), governed by `refresh()` like everything else —
`Enabled = open && available && isRepo`, except Init/Clone which want the
opposite. Accelerators avoid bare function keys: this desktop opens its finder
on `F3` and the key never arrives.

Tree indicators go through `SetText` (`name [M]`) with `SetIcon` behind
`HasCommand`'s sibling `HasIcon` — a name the theme lacks comes back empty and
the row simply has the suffix, the Button.Icon bargain. The branch and the
counts join `LblStatus`; every literal sits at the call site inside
`Locale.Text`, never in a `const`, so the extractor collects it.

## Staging

| | what lands | |
|---|---|---|
| **1** | `Ide.Git` readers (`available`, `isRepo`, `status`, `branch`, `show`, `diff`, `split`), menu Refresh, branch in the status bar, indicators in the tree | **built** |
| **2** | the viewer: side by side plus unified, caps and binaries | **built** |
| **3** | stage / unstage / commit / discard per file | **built**, plus `init` |
| **4** | log, branches, checkout | **built** |
| **5** | remotes async, clone | |
| **6** | catalogues, docs, and a `git` phase in `tests/ide` over a scratch repo (skip-green when git is missing, never red for the machine) | catalogues and docs done; the phase is not |

**What stage 1 needed and this document did not foresee: `Exec.Wait` stopped at
the first NUL.** It was built on `g_subprocess_communicate_utf8`, which hands
back a C string -- so `status --porcelain=v1 -z`, the very thing chosen here
*because* NUL is the one byte a file name cannot contain, read one record and
lost the rest. Silently. One file name with a space in it parsed fine and a list
of them parsed as a single entry, which is the shape of bug this plan's own
`-z` decision existed to avoid. It captures `GBytes` now; the note is in
`AGENTS.md` and the assertion in `tests/widgets`.

**And "cursor-follow" is gone from stage 2**, because the gap it worked around
was filled: an `Editor` answers `ScrollY` now, so the panes lock properly.

**Stage 4 chose `switch` over `checkout`**, which this document did not say and
should have: they overlap, and `git checkout <name>` moves to a branch *or*
throws away a file's changes depending on what the name turns out to be. That
ambiguity is what `switch` and `restore` were split out to end, and a branch
name that is also a path is not hypothetical in a project with folders called
`forms` and `modules`. The log is a **window** and not a page of the Changes
one, for the reason that window's own buttons give: it stages, discards and
commits, and a read-only history behind them would make each of them ask
whether it applies.

## What it costs outside the code

A section in [ide.md](ide.md); the row in the root README's *What is next*;
the strings through the extractor (literals at the call site, which the above
already requires); and the suite phase, which asserts the parse (`-z` with
spaces and accents), the before/after pairs, and the guards — never pixels.
No `tests/api.sh` surface changes: no runtime member is added. And the first
surprise gets its trap line in `AGENTS.md`, like everything else that bit.

## The gap that was open, and is not

Locked scrolling needed a scroll position on `Editor` and there was none:
`Line`/`Column`/`GotoLine` move the cursor, and a cursor is not a scroll. The
plan's v1 was going to build **cursor-follow** instead — `Cursor` on one pane
driving `GotoLine` on the other — which is honest but not a lock.

**It was filed and then filled** (`ISSUE-editor-scroll`, now deleted the way a
filled one is). An `Editor` publishes `ScrollX`, `ScrollY`, `ScrollMaxX`,
`ScrollMaxY` and a `Scroll(x, y)` event — `Scroller`'s own four names, because
an editor *builds* a GtkScrolledWindow around its view and it is the same thing
underneath. So the diff panes lock properly:

```js
Before_Scroll(x, y) { this.After.ScrollY = y; }
```

It does not loop: assigning a value an adjustment already has emits nothing, so
two panes pointed at each other settle after one event. Two things this plan
should know before it uses them, both measured and both on
[`Editor`](reference/widgets/Editor.md): a scroll **asked for** by `GotoLine`
lands on the next frame rather than on the next line of code, and `ScrollMaxY`
**grows** while GTK validates a long file, so a position is said as a fraction
of the maximum read in the same breath and never as a remembered number of
pixels.
