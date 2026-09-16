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
 * What they need is a **table** -- `[{ name, type }, …]`, every control of one
 * form, flattened -- and the text of the class beside it. `Ide.Live` gets its
 * table from `Completion`, which keeps one per form for the completion popup;
 * `Ide.Check` builds one per file as it walks. Neither of them parses
 * JavaScript, and that is what makes this possible at all: a `.form` says what
 * every control *is*, which is the type declaration an editor for this language
 * would otherwise have to infer.
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
     */
    sampleFor(type) {
        if (!type) return null;
        if (this.samples.has(type)) return this.samples.get(type);

        let made = null;
        try { made = Widget.New(type); } catch (e) { made = null; }

        this.samples.set(type, made);      /* null is an answer worth keeping too */
        return made;
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
     * Every control of a `.form`, flattened, as the table these take.
     *
     * A control is addressed by name whatever it is nested in, because a handler
     * is `Name_Event` on the form and names are unique across it -- which is the
     * same reason `Completion` flattens, and the same reason two controls of one
     * name is a problem `Ide.Check` reports.
     */
    tableOf(root) {
        const out = [];
        const walk = (nodes) => {
            for (const node of nodes || []) {
                if (node.name) out.push({ name: node.name, type: node.type });
                walk(node.children);
            }
        };
        walk(root && root.children);
        return out;
    }
};

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
