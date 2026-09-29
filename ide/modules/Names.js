/*
 * The two checks that read a name against what the `.form` beside it says, with
 * no editor in sight.
 *
 * They were `Ide.Live`'s, and they still run from there on every pause -- but
 * the *file on screen* is one file, and three of the mistakes they catch are
 * just as wrong in a file nobody has open. `Ide.Check` walks the project with
 * the same two, which is why they are here and not there: a second copy of
 * *does this control have this member* is a second answer to drift from the
 * first, and this project has said so about `Ide.Git`'s commands, about
 * `SOURCE_LINK` and about `Navigator.symbols` already.
 *
 * What they need is a **table** -- `[{ name, type }, …]`, everything one form
 * names, flattened -- and the text of the class beside it. `tableOf` is that
 * walk and it is the only one: `Ide.Live` gets its table from `Completion`,
 * which keeps one per form for the completion popup, and `Ide.Check` builds one
 * per file as it walks, and both of them go through here.
 *
 * **The third check here asks about no `.form` at all**, and that is deliberate
 * rather than a widening: it reads the language's own answer to *is this a name
 * this language has*, which is `Application.Replacements()` -- a table the
 * runtime builds from the very rows `close_hatches` deletes, so what was taken
 * and what to write instead cannot disagree. It is a method of its own and not
 * part of `check()` for the same reason the other two are not `Ide.Check`'s: it
 * needs the caret rule below, and a second copy of "is this under the cursor" is
 * a second answer to drift from the first. Both callers add it themselves, which
 * is what stops a form's class being told about it twice.
 *
 * **They did not, and all three had the same hole.** Each walked a `.form`'s
 * `children`, and `menus` and `actions` are not among them -- they are blocks of
 * their own, and the loader binds what they name on the form exactly as it binds
 * a control. So `this.MnuSave.` proposed nothing, `MnuSave_Clik()` went
 * unremarked, and a menu item called `Actions` was a collision nothing looked
 * for. Three copies of *what does this form have*, all drifted to the same wrong
 * answer -- which is the argument for having one, made over again.
 *
 * Neither check parses JavaScript, and that is what makes this possible at all:
 * a `.form` says what every control *is*, which is the type declaration an
 * editor for this language would otherwise have to infer.
 */
"use strict";

Namespace("Ide");

/* `this.Name.Member`, and a method that looks like a handler -- `Name_Event(` at
 * the start of a line, which is how every handler in every project of this
 * language is written. Compiled once and shared: a `Regex` remembers nothing
 * between calls, so one pass cannot resume where another stopped. */
const NAMES_MEMBER  = new Regex("\\bthis\\.([A-Za-z_$][\\w$]*)\\.([A-Za-z_$][\\w$]*)");
const NAMES_HANDLER = new Regex(
    "^[ \\t]*([A-Za-z_$][\\w$]*)_([A-Za-z_$][\\w$]*)[ \\t]*\\(", { Multiline: true });

/*
 * A call: the target, dotted or not, and the parenthesis. The guard in front
 * refuses a `.`, so `x.setTimeout(` is somebody else's member and not a name of
 * this language's. Anchored on a character class rather than a lookbehind, which
 * is a thing this dialect of `Regex` has and this tree uses elsewhere.
 */
const NAMES_CALL = new Regex(
    "(?:^|[^A-Za-z0-9_$.])([A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*)[ \\t]*\\(",
    { Multiline: true });

/* The words that make a call-shaped token a declaration rather than a call. A
 * project may define its own `setTimeout`, and the runtime's table knows nothing
 * about that -- so these are asked of the word in front and then ignored. */
const DECLARING  = /^(function|class|const|let|var)$/;
const WORD_BEFORE = /[A-Za-z_$][\w$]*[ \t]*$/;

Ide.Names = class Names {

    /** @param {MainForm} ide */
    constructor(ide) {
        this.ide = ide;

        /* The runtime's class names, kept as a set: which types are answered by
         * class and which have to come from a sample is asked once per match,
         * and the class list does not change while the IDE runs. */
        this.widgets = new Set(Widget.Types());

        /*
         * The two classes this process cannot answer by class -- a `MenuItem`
         * and an `Action` -- borrowed from the window's own menu bar and kept,
         * so the walk over its menus happens once rather than per match.
         */
        this.samples = new Map();

        /*
         * The names this language took, read once: the runtime's own table, and
         * a set of its keys because the question is asked once per call-shaped
         * token in a file. `Ide.Check` builds the same table over the whole
         * project, and the alternative -- a list of taken names written here --
         * would be a second answer that goes stale the moment the runtime takes
         * one more, which is the mistake this whole module is arranged against.
         */
        this.replaced = Application.Replacements();
        this.retired  = new Set(Dictionary.Keys(this.replaced));
    }

    /*
     * Every problem the text has against that table.
     *
     * `caret` is an offset into the text, or `-1` for *nobody is typing in this*
     * -- which is what a project pass is. A match the caret is inside is never
     * reported: a diagnostic about the token the cursor is in is a diagnostic
     * about something still being typed.
     */
    check(text, controls, file, caret) {
        return [...this.members(text, controls, file, caret),
                ...this.handlers(text, controls, file, caret)];
    }

    /*
     * `setTimeout(fn, 100)` and `Object.assign(a, b)`: a name this language
     * has taken, said with the word to write instead.
     *
     * **It is asked of call targets and of nothing else, which is half of the
     * safety of it.** A bare-identifier scan would report a property
     * (`x.setTimeout`), a key (`{ setTimeout: 1 }`), a declaration
     * (`function setTimeout()`) and every mention inside a string or a comment --
     * and a check that says so is a check somebody switches off, which is what
     * `handlers()`'s paragraph is about. A call is the shape every one of these
     * takes when a person reaches for one:
     *
     *     NAMES_CALL  the guard refuses a `.` in front, so a method on somebody
     *             else's object is not ours to complain about -- and a dotted
     *             target is not in the table either, whose keys are a bare
     *             global or an `Object.` one, so `host.setTimeout(0)` cannot
     *             match a row whatever it is called
     *     DECLARING  the five words that make a call-shaped token a *declaration*
     *             instead: a project is allowed to define its own `setTimeout`,
     *             and the table knows nothing about that
     *
     * **And the other half is that the scan is run over `Ide.Lex.blank`ed
     * text.** The two guards above read the text, and text is where prose
     * lives: it reported `setTimeout(fn, 1)` out of a comment *and* out of a
     * string, out of the fixture written to prove it would not -- and the
     * assertion that said so was passing because the pass never looked at that
     * file, which is the `p_names` note there. Blanking costs one walk, keeps
     * every offset, and gives the two guards something they can be right about.
     *
     * An `""` replacement is reported too, and differently: there is no word for
     * that thing here, which is worth saying out loud rather than leaving as a
     * bare `ReferenceError` at the next run.
     */
    *curated(text, file, caret) {
        /* Blanked once and read twice: the match list and the word in front of
         * a name both come from the same text, and a `function` in a comment
         * must not be the one that saves a declaration. Offsets are the
         * original's, so `caret`, `m.Index` and `Text.LineOf` need no
         * translation -- that is the bargain `Ide.Lex.blank` makes. */
        const code = Ide.Lex.blank(text);

        for (const m of NAMES_CALL.Matches(code)) {
            if (underCaret(m, caret)) continue;

            const name = m.Group(1);
            if (!this.retired.has(name)) continue;

            /*
             * The word in front of the *name*, not of the match: the match starts
             * on its guard character, and at the start of a line that character
             * is the line break -- so asking the text before the match would read
             * `function` on the line above and miss the declaration, which is the
             * one shape that must not be reported. Both sides of that question
             * come from the blanked text: a `function` in a comment must not be
             * the one that saves a declaration.
             */
            if (DECLARING.test(wordBefore(code, m.Index + m.Value.indexOf(name))))
                continue;

            const use = this.replaced[name];
            yield {
                kind: "Warning",
                file,
                line: Text.LineOf(text, m.Index),
                text: use
                    ? `${name} is not part of this language: use ${use}`
                    : `${name} is not part of this language, and nothing here ` +
                      `replaces it`,
            };
        }
    }

    /*
     * `this.Btn.Txt`: a member the control's class does not have.
     *
     * The test is the `in` operator on a real control of that type, which is
     * exact where a list of property names would not be -- `Click` and
     * `SetFocus` are methods and are on the prototype, so `PropertyNames()`
     * would report every method call in the project as a mistake.
     */
    *members(text, controls, file, caret) {
        for (const m of NAMES_MEMBER.Matches(text)) {
            if (underCaret(m, caret)) continue;

            const type = typeOf(controls, m.Group(1));
            if (!type) continue;

            /*
             * A widget is asked **by class**, with no control built:
             * `Widget.Member` is the `in` this used to run on a disposable one.
             * A component of the project is not a class of *this* process, so
             * there is nothing here to ask and nothing is reported about it,
             * which is a refusal to guess rather than a gap.
             */
            if (this.widgets.has(type)) {
                if (Widget.Member(type, m.Group(2)) !== "") continue;
            } else {
                const sample = this.sampleFor(type);
                if (!sample || m.Group(2) in sample) continue;
            }

            yield {
                kind: "Warning",
                file,
                line: Text.LineOf(text, m.Index),
                text: `${type} has no ${m.Group(2)}: the assignment would be accepted ` +
                      `and do nothing`,
            };
        }
    }

    /*
     * `Btn_Clik()`: a handler for an event the control does not raise.
     *
     * Only where the name before the underscore **is** a control of this form:
     * `Btnn_Click` -- the control misspelled rather than the event -- is a
     * method this cannot tell from any other method with an underscore in it,
     * and warning about those is how a check gets switched off.
     *
     * This is the one that found two real ones in the IDE's own dialogs, where
     * a `ComboBox`'s handler was written `_Change` and a `ComboBox` raises
     * `Select`: loaded, never called, and nothing said so.
     */
    *handlers(text, controls, file, caret) {
        for (const m of NAMES_HANDLER.Matches(text)) {
            if (underCaret(m, caret)) continue;

            const type   = typeOf(controls, m.Group(1));
            const events = this.eventsOf(type);
            if (!events || events.includes(m.Group(2))) continue;

            yield {
                kind: "Warning",
                file,
                line: Text.LineOf(text, m.Index),
                text: `${type} does not raise ${m.Group(2)}: this method will never ` +
                      `be called`,
            };
        }
    }

    /* --- what a type really has ---------------------------------------------- */

    /*
     * A control of that type to ask, or nothing -- for the two classes that are
     * not widgets.
     *
     * A widget answers by class now (`Widget.Member`, `Widget.EventNames`), so
     * nothing is built for one. **A menu item and a command are neither**, and
     * the only thing that builds one is a `.form` loader reading a `menus` or
     * an `actions` block, so the sample is borrowed from the window this code is
     * running in -- the IDE has a menu bar and a set of commands, so both
     * classes are in this process already, and one of its own items answers for
     * every project's. Which is the same bargain `Widget.New` makes and not a
     * weaker one: what is asked is what the *class* has.
     */
    sampleFor(type) {
        if (type !== MENU_ITEM_TYPE && type !== ACTION_TYPE) return null;
        if (this.samples.has(type)) return this.samples.get(type);

        const made = type === MENU_ITEM_TYPE ? this.borrowedItem()
                                             : this.borrowedAction();
        this.samples.set(type, made);      /* null is an answer worth keeping too */
        return made;
    }

    /* The first named item of this window's own menu bar, whatever it is. Found
     * rather than named, so renaming a menu item in the IDE's `.form` cannot
     * quietly take the answer away. */
    borrowedItem() {
        const first = (nodes) => {
            for (const node of nodes || []) {
                if (node.name && this.ide[node.name]) return this.ide[node.name];

                const deeper = first(node.children);
                if (deeper) return deeper;
            }
            return null;
        };
        return first(this.ide.Menus);
    }

    /* The same for a command. */
    borrowedAction() {
        for (const node of this.ide.Actions || [])
            if (node.name && this.ide[node.name]) return this.ide[node.name];
        return null;
    }

    /* The events a control of that type raises, or null when it is not one this
     * process can build. A widget answers by class; a component answers from
     * what its class declares. */
    eventsOf(type) {
        if (!type) return null;
        if (this.widgets.has(type)) return Widget.EventNames(type);

        const sample = this.sampleFor(type);
        if (sample) return sample.EventNames();

        return this.ide.classes.componentEvents(type) || null;
    }

    /*
     * Every name a `.form` puts on its form, flattened, as the table these take.
     *
     * A control is addressed by name whatever it is nested in, because a handler
     * is `Name_Event` on the form and names are unique across it -- and the same
     * mistake two controls of one name is, `Ide.Check` reports from this list.
     *
     * **`children` is not the whole of it, and for three flatteners it was.** A
     * `.form` has three blocks that name something and bind it on the form by
     * that name -- `children`, `menus` (nested again through `children` of its
     * own) and `actions` -- and only the first was walked. So `this.MnuSave.`
     * proposed nothing, `MnuSave_Clik()` went unremarked, and a menu item
     * sharing a control's name was a collision nothing looked for. The other two
     * carry no `type` in the file because there is only one thing each can be,
     * which is what these two names say.
     */
    tableOf(root) {
        const out = [];
        const walk = (nodes, type) => {
            for (const node of nodes || []) {
                if (node.name) out.push({ name: node.name, type: type || node.type });
                walk(node.children, type);
            }
        };
        walk(root && root.children, "");
        walk(root && root.menus, MENU_ITEM_TYPE);
        walk(root && root.actions, ACTION_TYPE);
        return out;
    }
};

/* What the two blocks a `.form` declares beside its controls are made of. Not a
 * `type` anybody writes: `menus` holds menu items and `actions` holds commands,
 * and there is nothing else either could hold. */
const MENU_ITEM_TYPE = "MenuItem";
const ACTION_TYPE    = "Action";

/* The type of the control with that name, or `""` when the form has none. */
function typeOf(controls, name) {
    const found = controls.find((c) => c.name === name);
    return found ? found.type : "";
}

/* Whether the cursor is inside this match, which is what says *still being
 * typed*. One past the end counts: the caret sits there while the last character
 * of a word is the one just pressed. A `caret` of -1 is inside nothing. */
function underCaret(m, caret) {
    return caret >= 0 && caret >= m.Index && caret <= m.Index + m.Value.length;
}

/* The word ending where a match begins, or `""` -- which is how a declaration is
 * told from a call without re-running a pattern over the file.
 *
 * **Trimmed**, because the pattern takes the space between a word and its
 * subject and `DECLARING` is anchored at both ends: `function setTimeout(fn)`
 * answered `"function "`, which is not one of the five words and left the
 * declaration reported as a call. The bug was older than the check that found
 * it -- the assertion that should have caught it was passing against a file the
 * pass never read. */
function wordBefore(text, index) {
    return (text.slice(0, index).match(WORD_BEFORE) || [""])[0].trim();
}

