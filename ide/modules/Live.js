/*
 * The names a file uses, checked while it is being written.
 *
 * **This is not a live syntax check, and refusing to be one is the design.**
 * `TabSet.checkSyntax` runs on save and says why: *half a line is not a syntax
 * error, and an editor that says so while one is still typing it is an editor
 * nobody leaves switched on*. That argument is right and a debounce does not
 * answer it -- one pauses in the middle of an expression all day.
 *
 * What it does answer is a different question. `this.Lbl.Txt = "hola"` is not
 * half-written: it parses, it runs, the label never changes and **nothing says
 * so, ever** -- the assignment lands on the widget as an ordinary JavaScript
 * property and the runtime has no opinion about it. Measured, along with its
 * neighbours: an enum value is refused with a sentence naming the valid ones, a
 * number is refused by type, and a *name* is accepted in silence. The line
 * between them is exact. The runtime validates the value and never the name.
 *
 * So the one thing a caret-side check can be trusted with is names, and the
 * reason is that a name is a **finished fact** about a control the `.form` next
 * door already describes: nothing has to be inferred, parsed or guessed.
 *
 * Two checks, and both are lookups:
 *
 *     this.Btn.Txt       Btn is a Button, and a Button has no Txt
 *     Btn_Clik()         Btn is a Button, and a Button does not raise Clik
 *
 * **What is under the caret is never reported.** That is the whole answer to the
 * objection above, and it generalises past this class: a diagnostic about the
 * token the cursor is inside is a diagnostic about something still being typed.
 * `this.Lbl.Te` with the caret at the end is a word half written; the same text
 * with the caret on another line is a mistake.
 *
 * **Nothing here is inferred.** Every lookup is `Completion`'s -- `controls()`,
 * `typeOf()`, `sample()` -- which is the class that already answers *what is
 * this control and what does it really have*, once per form and cached. A
 * second copy of that would be a second answer to drift from the first.
 *
 * Prior art: this is the shape of what Visual Basic did with `Option Explicit`
 * and of what Delphi's compiler does for free, in a language that has no
 * compiler to do it. VS Code's TypeScript service does far more and needs a type
 * system to do it; this needs none, because the `.form` is the type declaration.
 */
"use strict";

Namespace("Ide");

/*
 * How long a pause means *stopped typing*.
 *
 * 400 ms is what editors converged on -- long enough that a burst of typing
 * costs one pass and not one per keystroke, short enough that the answer feels
 * like it was there already. The work is regular expressions over one file, so
 * the number is about the *feel* of it and not about the cost.
 */
const LIVE_PAUSE = 400;

/*
 * `this.Name.Member`, and a method that looks like a handler -- `Name_Event(`
 * at the start of a line, which is how every handler in every project of this
 * language is written.
 *
 * Sources and not `RegExp`s: a `g` pattern carries a `lastIndex`, and one shared
 * between two passes resumes the second where the first stopped. `Strings`
 * builds its own for the same reason.
 */
const LIVE_MEMBER  = "\\bthis\\.([A-Za-z_$][\\w$]*)\\.([A-Za-z_$][\\w$]*)";
const LIVE_HANDLER = "^[ \\t]*([A-Za-z_$][\\w$]*)_([A-Za-z_$][\\w$]*)[ \\t]*\\(";

Ide.Live = class Live {

    constructor(ide) {
        this.ide   = ide;
        this.timer = null;
    }

    /* --- when it runs -------------------------------------------------------- */

    /*
     * A keystroke. The pass is put off rather than run, and a pass already put
     * off is put off again: what is wanted is the pause, not the keystroke.
     */
    typed() {
        if (this.timer) this.timer.Stop();
        this.timer = Timer.After(LIVE_PAUSE, () => this.pass());
    }

    /*
     * A tab was left. Its rows stay -- that is what a panel is for, and a file
     * with a name that does not exist has the same problem whether it is on
     * screen or not -- but the pending pass is dropped, because by the time it
     * fired it would be reading a different file.
     */
    left() {
        if (this.timer) this.timer.Stop();
        this.timer = null;
    }

    /* Everything this class has said about a file, taken back: what a closed or
     * deleted file has to answer for is nothing. */
    forget(name) {
        this.ide.problems.clear(`names:${name}`);
    }

    /* --- the pass ------------------------------------------------------------ */

    pass() {
        this.timer = null;

        const ide  = this.ide;
        const name = ide.activeFile;
        if (!name || File.Extension(name).toLowerCase() !== "js") return;
        if (!ide.Editor) return;

        /* One pause means one pass over the file, however many readers it has.
         * The outline is the other one, and it wants every `.js` -- including
         * the ones with no form beside them, which the check below returns on. */
        ide.outline.refresh();

        /* A file with no form beside it has no control to check a name against,
         * and a module is most of those: say nothing rather than guess. */
        if (!ide.formOf(name)) {
            this.forget(name);
            return;
        }

        /* Read once and handed down. `Text` copies the whole buffer out of GTK
         * -- 5 ms for the largest file in this repository, measured -- and this
         * used to ask for it three times in four lines. */
        const text  = ide.Editor.Text;
        const found = this.check(text, this.caret(ide.Editor, text), name);

        ide.problems.report(`names:${name}`, found);
        this.mark(ide.Editor, found);
    }

    /* The cursor as an offset into the text, which is what a match's index can
     * be compared against. `Line` and `Column` are 1-based. */
    caret(editor, text) {
        const lines = text.split("\n");
        let at = 0;

        for (let i = 0; i < editor.Line - 1 && i < lines.length; i++)
            at += lines[i].length + 1;

        return at + editor.Column - 1;
    }

    /*
     * The gutter, which is the half of this that is about the file on screen.
     *
     * `Warning` and not `Error`: the file compiles and will run, and what it
     * does is the wrong thing rather than nothing. The save's syntax error keeps
     * `Error` to itself, so a line carrying both says both.
     */
    mark(editor, found) {
        editor.ClearMarks("Warning");
        for (const p of found)
            if (p.line > 0) editor.Mark(p.line, "Warning", p.text);
    }

    /* --- the two checks ------------------------------------------------------ */

    check(text, caret, name) {
        return [...this.members(text, caret, name),
                ...this.handlers(text, caret, name)];
    }

    /*
     * `this.Btn.Txt`: a member the control's class does not have.
     *
     * The test is the `in` operator on a real control of that type, which is
     * exact where a list of property names would not be -- `Click` and
     * `SetFocus` are methods and are on the prototype, so `PropertyNames()`
     * would report every method call in the project as a mistake.
     *
     * A control whose class this process does not have -- a component of the
     * project, which the IDE never loads -- is skipped rather than guessed at.
     */
    *members(text, caret, file) {
        const re = new RegExp(LIVE_MEMBER, "g");
        let m;

        while ((m = re.exec(text)) !== null) {
            if (this.underCaret(m, caret)) continue;

            const sample = this.sampleFor(m[1]);
            if (!sample || m[2] in sample) continue;

            yield {
                kind: "Warning",
                file,
                line: this.lineAt(text, m.index),
                text: `${this.ide.completion.typeOf(m[1])} has no ${m[2]}: the ` +
                      `assignment would be accepted and do nothing`,
            };
        }
    }

    /*
     * `Btn_Clik()`: a handler for an event the control does not raise.
     *
     * Only where the name before the underscore **is** a control of this form:
     * `Btnn_Click` -- the control misspelled rather than the event -- is a
     * method this class cannot tell from any other method with an underscore in
     * it, and warning about those is how a check gets switched off.
     */
    *handlers(text, caret, file) {
        const re = new RegExp(LIVE_HANDLER, "gm");
        let m;

        while ((m = re.exec(text)) !== null) {
            if (this.underCaret(m, caret)) continue;

            const events = this.eventsOf(m[1]);
            if (!events || events.includes(m[2])) continue;

            yield {
                kind: "Warning",
                file,
                line: this.lineAt(text, m.index),
                text: `${this.ide.completion.typeOf(m[1])} does not raise ` +
                      `${m[2]}: this method will never be called`,
            };
        }
    }

    /* --- what the form says -------------------------------------------------- */

    /* A control of that type to ask, or nothing when the name is not a control
     * of this form at all. `Completion`'s lookups, which are cached per form. */
    sampleFor(name) {
        const completion = this.ide.completion;
        const type       = completion.typeOf(name);
        if (!type) return null;

        return completion.sample(type);
    }

    /* The events a control of that name raises, or null when it is not one. */
    eventsOf(name) {
        const completion = this.ide.completion;
        const type       = completion.typeOf(name);
        if (!type) return null;

        const control = completion.sample(type);
        if (control) return control.EventNames();

        return this.ide.classes.componentEvents(type) || null;
    }

    /* Whether the cursor is inside this match, which is what says *still being
     * typed*. One past the end counts: the caret sits there while the last
     * character of a word is the one just pressed. */
    underCaret(m, caret) {
        return caret >= m.index && caret <= m.index + m[0].length;
    }

    /* The 1-based line a character index falls on. A method and not a function
     * beside the class: `Navigator` already declares a `lineAt` at the top level
     * of its own file, and a second one would be the same name twice in one
     * lexical scope -- which is the trap this project's own namespaces exist to
     * close. */
    lineAt(text, index) {
        return text.slice(0, index).split("\n").length;
    }
};
