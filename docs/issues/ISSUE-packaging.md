# ISSUE: no way to hand over an application without its project tree

## What the application needed

Something to give somebody who is not a developer: the program, runnable,
without the `.form` sources, the project directory and a runtime they had to
build first.

## What I wrote instead

*Project → Export project…* writes the whole directory as one `.tar` beside
it. That is the smaller question that comes before this one: handing a project
to somebody without either end needing the IDE. Running what it hands over
still wants the tree and the runtime.

## The code I wish I could have written

Nothing in this vocabulary — there is no declaration that says "this project,
as something to run elsewhere". Whatever answers it will not be a property of
a control.

## Why the existing words do not cover it

`Export project` archives the tree itself, which is what a developer receives.
`cmake --install` installs *this* runtime with *its* IDE and examples, not an
application of yours. Neither turns a project into a thing of its own.

## Prior art

Visual Basic had a setup wizard; Gambas produces an executable; .NET publishes
self-contained. GTK4 itself offers nothing here.

## How much it mattered

It works, and distribution is the missing half: everything up to handing the
program over exists.
