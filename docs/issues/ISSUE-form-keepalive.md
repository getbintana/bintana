# ISSUE: a shown `Form` has to be kept alive by hand

## What the application needed

To open a dialog and let it live until the user closes it. Nothing more than
that: `new AskForm().Show()`, and the window answers its buttons.

## What I wrote instead

A module-level array whose only job is to be a reference the collector can see,
in **sixteen** forms of the IDE:

```js
/* While it is open nothing else references it: without this the collector takes
 * it away and the window is left without its handlers. */
const openPrompts = [];
```

`AboutForm`, `AppForm`, `AskForm`, `ClassForm`, `ColumnForm`, `ConfirmForm`,
`IconForm`, `ImageForm`, `LaunchForm`, `MenuForm`, `NewProjectForm`,
`ProjectForm`, `QuickForm`, `StyleForm` and `SymbolForm` keep an array and
`splice` on close; `PoForm` keeps a `Map` and `delete`s. Sixteen forms doing one
thing two ways, which is the shape of a missing primitive rather than of a
convention.

## The code I wish I could have written

```js
new AskForm().Show();     // and that is the whole of it
```

## Why the existing words do not cover it

A widget's JavaScript wrapper is an ordinary object, so a form nothing points at
is collectable, and its window losing its handlers is what that looks like from
the outside -- a dialog that stops answering rather than an error. The runtime
already knows the two moments: `Show` and `Close`. It already does exactly this
for something else -- `AudioPlayer.Play` takes a reference for the length of a
sound, because a cue that is playing is doing something the collector must not
undo, and a window that is open is the same claim.

Nothing published lets an application say *this is doing something*: there is no
`Application.Keep`, and `WeakRef` is not installed (nor would it be the right
answer, which is the opposite one).

## Prior art

.NET `Form.Show` roots the form in the application's window list until it
closes. GTK does the same in C -- `gtk_window_present` on a `GtkApplicationWindow`
adds it to the application's windows, and the reference count reflects it. VB6
never surfaced the question at all, because a form was a global by name.

## How much it mattered

Sixteen copies, and the failure mode is the expensive kind: the dialog opens,
looks right, and stops responding at a moment that depends on when the collector
last ran -- so it reproduces on one machine and not another, and reads as a GTK
problem rather than a lifetime one. The comment is copied verbatim sixteen times
because whoever wrote the second one had already paid for it.
