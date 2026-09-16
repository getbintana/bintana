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
 * language is written. Sources and not `RegExp`s: a `g` pattern carries a
 * `lastIndex`, and one shared between two passes resumes the second where the
 * first stopped. */
const NAMES_MEMBER  = "\\bthis\\.([A-Za-z_$][\\w$]*)\\.([A-Za-z_$][\\w$]*)";
const NAMES_HANDLER = "^[ \\t]*([A-Za-z_$][\\w$]*)_([A-Za-z_$][\\w$]*)[ \\t]*\\(";

Ide.Names = class Names {

    /** @param {MainForm} ide */
    constructor(ide) {
        this.ide = ide;

        /*
         * One control per *type*, kept.
         *
         * `Widget.New` builds a real GTK widget and this is asked once per match
         * and once per node, so the project pass over this IDE -- 311 nodes and
         * 886 KB of source -- was building a fresh `Button` for every
         * `this.Btn.Text` in it. A control is only ever asked what its class
         * has, which is the same answer for every one of them.
         *
         * **Measured, and it is a smaller win than it looks: 176 ms down to
         * 156.** Most of that pass is reading 886 KB and running two regular
         * expressions over it, which no cache helps. Kept because it is right
         * and free, and because `Ide.Live` asks the same question on every pause
         * over one file, where the matches repeat a type far more often.
         */
        this.samples = new Map();
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
     * `this.Btn.Txt`: a member the control's class does not have.
     *
     * The test is the `in` operator on a real control of that type, which is
     * exact where a list of property names would not be -- `Click` and
     * `SetFocus` are methods and are on the prototype, so `PropertyNames()`
     * would report every method call in the project as a mistake.
     */
    *members(text, controls, file, caret) {
        const re = new RegExp(NAMES_MEMBER, "g");
        let m;

        while ((m = re.exec(text)) !== null) {
            if (underCaret(m, caret)) continue;

            const type   = typeOf(controls, m[1]);
            const sample = this.sampleFor(type);
            if (!sample || m[2] in sample) continue;

            yield {
                kind: "Warning",
                file,
                line: lineOfIndex(text, m.index),
                text: `${type} has no ${m[2]}: the assignment would be accepted ` +
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
        const re = new RegExp(NAMES_HANDLER, "gm");
        let m;

        while ((m = re.exec(text)) !== null) {
            if (underCaret(m, caret)) continue;

            const type   = typeOf(controls, m[1]);
            const events = this.eventsOf(type);
            if (!events || events.includes(m[2])) continue;

            yield {
                kind: "Warning",
                file,
                line: lineOfIndex(text, m.index),
                text: `${type} does not raise ${m[2]}: this method will never ` +
                      `be called`,
            };
        }
    }

    /* --- what a type really has ---------------------------------------------- */

    /*
     * A control of that type to ask, or nothing.
     *
     * `Widget.New` is the same lookup the `.form` loader does. A component of
     * the project is not a class of *this* process -- the IDE never loads the
     * project's code -- so there is nothing here to ask and nothing is reported
     * about it, which is a refusal to guess rather than a gap.
     *
     * **A menu item and a command are neither**, and `Widget.New` cannot make
     * one: they are not widgets, and the only thing that builds one is a `.form`
     * loader reading a `menus` or an `actions` block. So the sample is borrowed
     * from the window this code is running in -- the IDE has a menu bar and a
     * set of commands, so both classes are in this process already, and one of
     * its own items answers for every project's. Which is the same bargain
     * `Widget.New` makes and not a weaker one: what is asked is what the
     * *class* has.
     */
    sampleFor(type) {
        if (!type) return null;
        if (this.samples.has(type)) return this.samples.get(type);

        let made = null;
        if (type === MENU_ITEM_TYPE)   made = this.borrowedItem();
        else if (type === ACTION_TYPE) made = this.borrowedAction();
        else try { made = Widget.New(type); } catch (e) { made = null; }

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
     * process can build. A component answers from what its class declares. */
    eventsOf(type) {
        if (!type) return null;

        const control = this.sampleFor(type);
        if (control) return control.EventNames();

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
    return caret >= 0 && caret >= m.index && caret <= m.index + m[0].length;
}

/* The 1-based line a character index falls on. */
function lineOfIndex(text, index) {
    return text.slice(0, index).split("\n").length;
}
