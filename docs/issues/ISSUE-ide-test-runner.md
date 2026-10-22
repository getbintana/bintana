# ISSUE: no way to write, launch and read a user project's own tests

## What the application needed

A project that carries its own tests. Three concrete gestures: "New test" in
the menu creates the file and puts it in the project; "Run tests" launches
them; and a results panel says which test passed and which failed, with the
failure's message. The developer changes a function and asks "did I break
anything?", and the answer is on screen.

## What I wrote instead

Nothing — this part is not implemented. The IDE creates exactly three kinds of
thing: `ide/modules/FormFiles.js:136-146` (`newForm()`), `:256`
(`newModule()`) and `:342` (`newComponent()`), and the only source template is
`classSource()` at `:230-242` — `extends Form`, `extends Component`, or a
plain class. A test file is written by hand and added to `project.json` by
hand, and it is run by pressing F5 like any other program: it opens a window,
and whatever it prints is what the log shows. There is no results view to
read: the only `Results` widget in the IDE is the search-hits tree
(`ide/forms/SearchForm.js:379-404`), and the panels along the bottom are
Output and Problems (`ide/modules/Problems.js`, `ide/modules/Runner.js:331`).

## The code I wish I could have written

```js
// The results panel, as a `.form` fragment in the IDE's own words:
//   { "type": "TableView", "name": "Results",
//     "properties": { "Columns": [ { "Text": "Test" }, { "Text": "Result" },
//                                    { "Text": "Message" } ] } }
//
// and the run that fills it, in the IDE's own handler:
//   MnuRunTests_Click() {
//       this.Results.AddRows(this.ide.runTests(this.project.sources));
//   }
```

## Why the existing words do not cover it

The launch configuration (`ide/modules/LaunchConfig.js:41-85`) is a `Record`
with `Name`, `Arguments`, `Directory`, `Environment`, `Strict` and
`StopOnThrow` — it says how to start a program, not what to run as a test and
where the result goes. `FormFiles.js` offers three kinds of new file and none
of them is a test, and a failed assertion has nowhere to land but the log,
because the bottom panels are Output and Problems. What the runtime already
has is enough to write a test in: a project declares `startup` and runs a
`Form`, and `Application.Quit(code)` ends the process with a status.

## Prior art

Lazarus's unit-test IDE add-on. Delphi's DUnit and its code coverage. Visual
Studio's test explorer. Eclipse's JUnit integration. Qt Creator's test mode.
GTK4 has no notion of a test at all.

## How much it mattered

It works, but a part of it is noticeably worse: a user of the IDE writes a
test project by hand, with no template and no way to see it pass.
