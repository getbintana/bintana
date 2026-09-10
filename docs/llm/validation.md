# Validating what you wrote

Nobody should have to open a window to find out whether your application works.
Everything below runs in a terminal and answers with text.

Run the checklist, then **report what you ran and what it said**. "It should
work" is not a result.

## 1. Run it, without a screen

```sh
tests/try.sh myapp                 # a window nobody sees
tests/try.sh myapp ~/some/arg      # arguments go through
BINTANA=/other/bintana tests/try.sh myapp  # a build other than ./build/bintana
```

`tests/try.sh` wraps the binary in `xvfb-run`. **`HEADLESS=1 ./build/bintana myapp`
does not do this** — the binary does not read that variable, so it opens a real
window on somebody's desktop. Use the script.

All three `tests/*.sh` scripts change to the repository root first, so a relative
project path is resolved from there; an absolute one always works.

What this catches, and it is most of what goes wrong: a `.form` that does not
parse, a class whose file was never listed in `sources`, a property name that
does not exist, an enumerated value that is not one of the accepted strings, a
handler that throws on `Form_Open`.

A project that is meant to end (`main`, or one that calls `Application.Quit`)
gives you an exit status to gate on. A project with a window does not end on its
own — read its output and stop it.

## 2. Make it check itself

The most valuable thing you can hand over with a form is a second project that
drives it. This is the idiom the runtime's own suite uses; there is no framework
to learn.

**A driving project has to bring the resources with it.** Listing
`"../MainForm.js"` in `sources` evaluates the class, and that is all it does:
a `.form` is looked for **under the project being run**, and
`Application.Directory` is that project's too. So the class loads, its handlers
run, and every `this.<control>` is `undefined` — silently, because a form with no
`.form` is legal and built from code. Symlink or copy what it needs:

```
selfcheck/
  project.json          "sources": ["../MainForm.js", "Test.js"]
  MainForm.form  ->  ../MainForm.form
  holidays.json  ->  ../holidays.json
```

A symlink is what the runtime's own `tests/ide` does, and for the same reason:
the two cannot drift.

**`Show()` runs `Form_Open` before it returns.** So a test may assert on whatever
that handler set, on the next line, with no waiting:

```js
this.fm = new MainForm();
this.fm.Show();
check("the data loaded", Dictionary.Count(this.fm.holidays) > 0);   /* no poll needed */
```

What does need a frame is anything that measures — see below. Those are two
different questions and only the second one waits.

```js
"use strict";

let passed = 0;
const failures = [];

function check(name, cond, detail) {
    if (cond) passed++;
    else failures.push(detail ? `${name}: ${detail}` : name);
}
function eq(name, got, want) {
    check(name, got === want, `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}
function throws(name, fn) {
    try { fn(); failures.push(`${name}: expected a throw, none happened`); }
    catch (e) { passed++; }
}

class TestForm extends Form {

    Form_Open() {
        /* Without this try, an unexpected throw aborts Form_Open before the
         * Quit and the run hangs until a timeout instead of failing. */
        try { this.runAll(); }
        catch (e) { failures.push(`uncaught: ${e.message}\n${e.stack || ""}`); }

        for (const f of failures) print(`  FAIL  ${f}`);
        print(`mytest: ${passed} passed, ${failures.length} failed`);
        Application.Quit(failures.length ? 1 : 0);
    }

    runAll() {
        this.TxtName.Text = "Ana";
        eq("the field took it", this.TxtName.Text, "Ana");
        check("assigning Text raised Change", this.changes === 1);

        this.BtnGreet.Click();
        eq("greeting was added", this.List.Count, 1);
        eq("the field was cleared", this.TxtName.Text, "");

        throws("a bad alignment is refused", () => { this.TxtName.HAlign = "Middle"; });
    }

    TxtName_Change() { this.changes = (this.changes || 0) + 1; }
}
```

Two rules make the difference between a test that proves something and one that
does not:

**Make the round trip.** Assigning `TextBox1.Text` has to reach GTK, come back
as a real `changed` signal and land on `TextBox1_Change`. Asserting that a
property remembers what you assigned to it proves nothing.

**Drive the UI, not the model.** `Btn.Click()`, `Mnu.Click()`, `List.Index = 2`,
`Canvas_MouseDown(x, y)` — the same handlers the runtime would dispatch. Calling
your own `save()` directly tests your method and not the button.

### Check that every handler is actually connected

**A handler whose control name is misspelled is silently dead.** Nothing is
registered, so nothing can fail to register: `GridDays_MouseDown` on a form whose
control is named `GrdDays` is an ordinary method the runtime never looks up, the
`.form` loads, the application runs, and clicking does nothing. This is the one
failure mode the naming convention buys, and it has reached a delivered
application.

**Calling the handler from a test does not catch it** — it is the mistake that
hides it. `this.fm.GridDays_MouseDown(x, y, 1)` passes on a form where the click
is dead, because you called the method yourself. That is what *drive the UI, not
the model* means here: the assertion has to go through the name the runtime uses.

The direct assertion is one line per handler you care about:

```js
check("the grid's click handler is wired",
      typeof this.fm[this.fm.GrdDays.Name + "_MouseDown"] === "function");
```

And the whole form can be checked at once, from the other side — every `.form`
name against every method the source defines:

```js
/* a console project: "main" in its manifest -- no window, no display */
const FORM_EXT = new Regex("\\.form$");
const HANDLER  = new Regex("^\\s+([A-Z]\\w*)_(\\w+)\\s*\\(", { Multiline: true });
const LITERAL  = new Regex("[\"']([A-Za-z_]\\w*)[\"']");

/* Every name a .form node declares: the control's own, the menu bar's items, and
 * the items of any context menu a control carries as its `Menu` property. */
function declaredNames(node) {
    const names = new Set(["Form"]);
    const walk = (n) => {
        if (n.name) names.add(n.name);
        for (const c of n.children || []) walk(c);
        for (const m of n.menus    || []) walk(m);
        for (const m of (n.properties && n.properties.Menu) || []) walk(m);
    };
    walk(node);
    return names;
}

function Main() {
    const dir = Application.Arguments[0] || Application.Directory;

    /* A control built in code was named by a string literal somewhere in the
     * project's own source. That is what tells "built at runtime" from "typo". */
    const built = new Set();
    for (const js of Directory.Files(dir, { Pattern: "*.js", Recursive: true }))
        for (const m of LITERAL.Matches(File.Load(js))) built.add(m.Group(1));

    let dead = 0, checked = 0, inCode = 0;

    for (const form of Directory.Files(dir, { Pattern: "*.form", Recursive: true })) {
        const js = FORM_EXT.Replace(form, ".js");
        if (!File.Exists(js)) continue;

        const names = declaredNames(File.LoadJson(form));
        checked++;
        for (const m of HANDLER.Matches(File.Load(js))) {
            const name = m.Group(1);
            if (names.has(name)) continue;
            if (built.has(name)) { inCode++; continue; }
            print(`${File.Name(js)}: ${name}_${m.Group(2)} -- no control named '${name}'`);
            dead++;
        }
    }
    const tail = inCode ? `  (${inCode} handler(s) for controls named in code, skipped)` : "";
    print(dead ? `${dead} dead handler(s) in ${checked} form(s)${tail}`
               : `${checked} form(s): every handler names a real control${tail}`);
    Application.Quit(dead ? 1 : 0);
}
```

It reads the `.form` as data and the `.js` as text, so it needs neither a display
nor the project's own classes:

```sh
./build/bintana handlercheck myapp
```

The last set is what keeps it honest. A control built in code was **named by a
string literal** somewhere in the project's source, and a typo never is — so
`Glass_MouseDown` on a designer that builds its own glass layer is counted and
skipped, while `GridDays_MouseDown` on a form whose control is `GrdDays` is
reported. Measured against every project in this repository: the IDE skips 15,
`tests/widgets` skips 27, and none of them reports a dead handler.

### Anything that measures needs a frame first

`Bounds()`, `OriginIn()`, `PickAt()` and an unset `Width`/`Height` read GTK's
allocation, and a widget just created has none until the main loop runs again.
`Form_Open` runs **before** the window is presented.

**One frame is not a promise** — GTK does not have to have allocated anything by
the next turn of the loop, and under load it often has not. Never count frames;
poll for the fact you need:

```js
Form_Open() { Timer.After(0, () => this.waitFor(() => this.List.Width > 0, 30)); }

waitFor(cond, tries) {
    if (cond()) return this.measure();
    if (tries <= 0) return this.fail("the list never got a size");
    Timer.After(16, () => this.waitFor(cond, tries - 1));
}
```

A generator with a `yield` per frame is how the runtime's own suite spells this;
see [`docs/testing.md`](../testing.md) if you are writing a long one.

## 3. Ask the runtime instead of trusting this documentation

[controls.md](controls.md) is the complete surface and `tests/api.sh` fails if it
stops being — so you should not need this. It is here for the two things a
document cannot tell you: what a value is *right now*, and what a machine other
than this one offers.

```sh
tests/api.sh          # does controls.md still document every member? (no display)
```

Every name can also be asked of a live control:

```js
Widget.Types()                       // every class the runtime has
Widget.Available("Terminal")         // ...and whether this build can run one
w.PropertyNames()                    // every settable property, along the chain
w.PropertyOptions("HAlign")          // exactly what that property accepts
w.EventNames()                       // what it raises, most derived first
w.TextProperties()                   // which of its strings go through the catalogue
w.Serialize()                         // this widget as a .form node
w.Dump()                             // the whole subtree, with real geometry
```

`w.Dump()` is what to reach for instead of a screenshot: it prints the tree with
the sizes and positions GTK really allocated. `Bounds([container])` is the same
numbers for one widget, as `{ X, Y, Width, Height }`. If you were about to ask for a
screenshot to check a layout, print this instead.

`Application.CheckSource(text)` answers whether a text is valid JavaScript
without running it — `null`, or `{ Message, Line, Column }`. That is the only
honest way to claim a `.js` you generated still compiles.

## 4. Icons

Every `Icon` you declared is a name this desktop may not have, and **a name it
cannot draw is dropped in silence**: the control comes out empty and nothing is
logged.

```sh
tests/icons.sh myapp
```

It reads the theme off the disk, adds the symbolic set GTK embeds, adds whatever
the project ships in `icons/`, and tells you which declared names are missing or
render to nothing. Four of nine "universal" desktop names failed on the machine
this was written on, so this is not a formality.

In code, `Application.HasIcon(name)` is the same question, and
`Application.Icons("folder")` lists what is actually there.

## 5. Style classes

A `Style` naming a class no theme declares is not an error — it does nothing,
which looks exactly like a theme that ignores it.

```sh
tests/styles.sh              # what this GTK's own theme defines
tests/styles.sh --all        # every class in it, by how much it is used
```

Check every class you did not write into `app.css` yourself. `pill` and `card`
are libadwaita's, not GTK's, and do nothing here.

## 6. Text that can be translated

Two mistakes, both silent at runtime:

- A template literal in a text position — a backtick string handed to
  `Message.Info` — has a msgid that no catalogue can ever match.
- A caption assigned from code that was already declared in the `.form` loses the
  translation the loader had applied.

Grep your own `.js` for a backtick inside `Locale.Text(`, `Message.`,
`Locale.Plural(` or `Locale.Context(`. If the project has a `po/`, run it with
`LANGUAGE=<lang> tests/try.sh myapp` and check that what you expected to change
did.

## 7. What cannot be checked without eyes

Be honest about the line. These need a person:

- whether an icon reads as the thing it stands for;
- whether a layout looks right — as opposed to whether the numbers are what you
  intended, which `Dump()` answers;
- whether prose says what it should.

For those, say what you would like looked at and why, and keep it to the part
that matters. Do not open a window on somebody's screen to find out something a
`Dump()` would have told you.

## The checklist

```
[ ] tests/try.sh myapp            — it starts, and says nothing unexpected
[ ] every .form parses            — the run above proves it
[ ] every handler names a control that exists, spelled exactly — checked, not read
[ ] a self-check project has the .form and the data files it drives
[ ] tests/icons.sh myapp          — no missing icon
[ ] tests/styles.sh               — every Style class exists, or is in app.css
[ ] every property, event and method you used is in controls.md — if one is not,
    it does not exist, and the fix is not to go looking in the runtime's source
[ ] no template literal in a Locale/Message position
[ ] no setTimeout, Object.keys, async, await, import, console, fetch
[ ] Min/Max declared before Value; Arrangement written first
[ ] a self-check project, if the application has behaviour worth asserting
```
