# Git for one author: what waits for the second one

**Status: deferred on purpose (2026-11-12).** The Git in the IDE is built for a
single author for now: one working copy, one branch being edited at a time, and
a remote used as a backup. Under that assumption the collaboration half --
merge and conflict resolution, rebase, blame, stash and per-hunk staging -- is
not on the daily road. This file records what is postponed, why, and the
trigger that reopens each piece. It is a decision, not a design to build yet.

## What is built

- **The Git tab is the diff**: side by side or unified, with icon navigation for
  the previous/next difference, jump to file and previous/next changed file.
  Its title is `diff: <file> (<branch>)` for a change and
  `Commit: <file> (<branch>)` for a commit.
- **History is a page of the side panel**, beside Changes: the commits, the
  files each touched, and the row that opens its diff in the tab.
- **Changes** keeps the list of ticks, the message and the Commit button; the
  side panel is the one list of changes, commits and staged state.
- **`Git.pull` is `--ff-only`.** A pull that would need a merge stops and says
  so in the log; it never starts a half-merge and never leaves a conflict the
  IDE does not know how to show.
- The engine is still the git CLI (`Git`), the test phase is `tests/ide`'s
  `git`, and the Terminal tab remains the escape hatch for anything the IDE
  does not own.

## The assumption, in the terms Git uses

- One person is the only writer of the branch.
- One working copy is edited at a time. A second machine or a second clone is
  the first thing that breaks the assumption, not a second author.
- The remote is for backup, visibility or a deploy, not for somebody else's
  commits to arrive between two pulls.
- A branch is short-lived enough that a fast-forward or a local rewrite in the
  Terminal is the whole of the integration.

That is not a claim that collaboration is unimportant. It is a statement about
the order: a merge editor and a conflict resolver are large, and a single
author pays for them every day while getting nothing back.

## What is postponed, and what reopens it

### Merge and conflict resolution -- the first thing a second author needs

Today `Git.pull` refuses a non-fast-forward and the log says why. A conflict
cannot exist in a repository the IDE is willing to pull into, so there is no
conflict list and no half-merged worktree to explain.

**Trigger:** a second author pushes to the branch, or the same author works from
two clones and both push. The first real non-fast-forward pull is the signal.

The first slice when it opens:

1. `Git.merging()`, `Git.conflicts()`, `Git.abortMerge()` and
   `Git.continueMerge()`, and a `pull` that merges instead of refusing.
2. A merge banner in Changes with **Abort** and **Continue**; conflicted files
   are `U` in the existing list, and Stage is what marks one resolved.
3. A test with two local branches that collide: pull, conflict, abort; repeat,
   resolve, continue, and check the merge commit.

A three-pane merge editor is a second slice, not the same one: the worktree file
with its conflict markers is already editable, and it is what a person uses
before a merge UI exists.

### Rebase

A single author can rewrite a private branch in the Terminal. The IDE should
not own a rebase before it can stop on a conflict and explain the state, so
rebase comes after merge and conflict resolution, never before.

**Trigger:** a branch policy that requires linear history, or a second author.

### Blame

Blame is archaeology: *who wrote this line, and in which change?* A single
author already knows the answer usually, and the Terminal's `git blame` is one
command away. A read-only view is useful and small, but it is not a
collaboration prerequisite.

**Trigger:** a line whose history matters more than the code around it -- a
regression, a copied block, a question about why a workaround exists.

### Stash

With one working copy, the common case is *I need to look at another branch
with work half done*. The IDE already offers to save the dirty tabs, and a
temporary commit or a WIP branch is a safer record than a stash: it is visible,
named, and survives a machine change.

**Trigger:** switching branches with uncommitted work often enough that a
temporary commit feels like noise.

### Staging per hunk

A commit that mixes two unrelated changes is a real quality problem, but a
single author can stage a file at a time and split the commit in the Terminal
with `git add -p`. The editor has no hunk model and `Diff` reads git's own
answer; per-hunk staging would be a second feature wearing the first one's name.

**Trigger:** a real commit that cannot be separated by file -- a fixed bug and a
refactor in the same file -- and a caller who wants it often enough.

### Amend

Small and solo-useful, but independent of the collaboration bundle. A typo in
the last commit can be fixed in the Terminal today; nothing about a team is
needed to add it later.

**Trigger:** a call for it from the day-to-day work, not from this plan.

## What a second author would see today

They would fetch and pull, the pull would refuse a non-fast-forward, and the
log would say so. They would open the Terminal tab, run `git pull`, resolve the
conflict there, and commit. Nothing is lost and nothing is silently wrong: the
IDE simply stops at the point where it would have to explain a merge, and the
Terminal is where that explanation lives for now.

## The order if the assumption stops holding

1. **Merge and conflicts**, with the banner and the abort/continue pair.
2. **A three-pane merge view** -- base, ours, theirs -- and per-file resolution.
3. **Rebase**, only on top of a conflict resolver.
4. **Blame, stash, hunk staging and amend** in any order, each on its own
   caller.

The order is not a roadmap for its own sake: the first item is the one that
blocks another person, the second is what makes the first comfortable, and the
rest are solo conveniences that can be picked up independently.

## Prior art

- **GitHub Desktop** puts Changes and History in the same side panel and shows
  a merge banner with abort/continue; this IDE already has that shape.
- **VS Code** has a three-pane merge editor after its conflict list; that is
  the second slice above.
- **GitKraken** and **IntelliJ** make blame and hunk staging first-class; both
  are useful, neither is what makes a second author possible.

## What is deliberately not built

- Auto-resolution, a merge strategy of the IDE's own, or a hidden `git pull`
  configuration.
- A rebase UI without a conflict resolver.
- A blame view, a stash list or a hunk parser before a caller asks.
- Any change to `Git`'s engine: it is the CLI, and these features would be more
  calls to it, not a binding.

## The trigger, in one line

When a second person (or a second clone) writes to the same branch, open
**merge and conflicts**; everything else in this file can wait for the work that
asks for it.
