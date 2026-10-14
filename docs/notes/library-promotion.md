# A library is promoted by being the default, not by being asked for

**`lib/dialog` exists because this tree had seven hand-written question
dialogs, and one of them said why.** Four were plain copies and are gone:
`examples/notes/Confirm.js`, `examples/clients/Confirm.js` and
`examples/kanban/Confirm.js` (the second opens by saying it is *copied from* the
first), and `examples/notes/AskName.js`. `examples/clients/Confirm.js` carried
the sentence that settled it: *"Two applications wanting the same four widgets is
what a `lib/` library is for, and one of them is not enough to write one."*
There were three. **When a comment in an example says "a `lib/` library is for
this", the count of copies is the ticket**, and the third copy is not a reason to
wait for a fourth.

**And the count was four when it started.** Two more turned up while the library
was being written, and neither is in `lib/`:
- `ide/forms/AskForm.js` and `ide/forms/ConfirmForm.js` are the **IDE's own**,
  and they are still there. `AskForm` has a checkbox the shipped `AskText` grew
  out of, and it has eight call sites with assertions on it; converting the IDE
  is its own piece of work and not a side effect of shipping a library.
- `examples/kanban/ColumnDialog.js` is a prompt **with a validation error beside
  the field** — it refuses a name already in use. That is a shape neither shipped
  class has, and it is the answer to "when is a question not one of the two":
  adding an error line, a colour or a second field is a new question; a plain
  prompt with a different word on the button is not. `llm/forms.md` says so where
  somebody reading it decides.

**The verb is a capital, and that is not a style choice.** Every other library
publishes `Package.Write`, `QrCode.Encode`, `Nsis.Script`, `Chart.Refresh` — and
`Confirm.ask` was left out of every member list by the very convention this
repository documents (*a capital initial is public, a lower-case one is the class
talking to itself*), which is how a static verb that is really private gets
caught. It is `Confirm.Ask` and `AskText.Prompt`.

**What promotion actually is here: the new-project wizard, and nothing else.**
`NEW_FORM_USES` in `ide/forms/MainForm.js` is a list with `dialog` in it, and
`createProject` writes it into the manifest. The rule that makes it a *default*
rather than a requirement — it is an ordinary `ProjectFile` field, the libraries
dialog can drop it, `examples/clients` shows a project carrying it by choice, and
nothing checks that a project wants what it was given. **And it is a list so the
second library that earns it is a line**, because a special case per library is
the shape this file keeps warning about everywhere else. **A `main` project does
not get it**, and that is the half that is a decision: a `main` project never
initialises GTK, so it cannot make a widget at all and every class in the library
is a `Form`; a manifest naming it would be describing a window to a program with
no display. `tests/ide`'s `projects` phase asserts both halves, and the second
one only exists because a default nobody checked is a default that drifts.

**Two classes and not one with a flag, and the reason is a declaration in a
`.form`.** `Default` is what Enter means when the focus is somewhere else, so
making a destructive button the default is exactly the reflex to avoid —
`Confirm` has **nothing** `Default` and puts the focus on the button that says no,
while `AskText` is `Default` and its field is `ActivatesDefault`. Neither could
be a flag: a form cannot know which question it is being asked. **A test that
asserted `BtnCancel.Default === true` would have been asserting the opposite of
the design, and would have passed a wrong implementation** — the assertion that
catches one is `BtnCancel.Default || BtnAccept.Default` being `false`, plus the
focus, and both were put in after the first version got it backwards.

**A library's own prose has no msgid, and that is not fixable from where it
looks.** `static TextProperties = ["BtnAccept", "BtnCancel"]` puts the two labels
through the catalogue when the `.form` loads, and the extractor cannot reach
them: `Strings`' `projectFiles` walks from `this.ide.project`, so a `.form`
under `lib/` is invisible to it. **The answer is that a caller passes its own
words** — `{ Accept: "Delete" }` at the call site is a literal in the project's
own `.js`, which is exactly where the extractor looks. It is the same shape as the
one in *A prose position the runtime owns*: the declaration is half a promise
and the other half is a caller's to keep.

**And `api.sh` does not count a library whose whole API is `static`.** The
"published by `lib/`" figure comes from `LIB_GET`/`LIB_METHOD`, and `LIB_METHOD`
drops a `static` — the same rule the runtime's own class statics follow, and
reported in their own bucket (the "11 class statics"). So the number did not move
when `dialog` landed, and the two **classes** did: "76 top-level names in `lib/`"
went to 78. **When a library is added, that first number is the one that proves
it was seen**, and it is why `docs/issues/README.md`'s "a library with no page at
all is invisible to the check" has a companion worth remembering: a library whose
members are all statics is *counted* and not *checked*, and the reference pages
are what check it.
