/*
 * Go to the definition of whatever the cursor is on.
 *
 * The gesture every environment in this family has -- Shift+F2 in Visual Basic,
 * Ctrl+click in Gambas and Lazarus, F12 everywhere since -- and the one thing
 * this IDE could only answer with *Find in project*, which is a search and not
 * an answer: it finds the mentions and leaves the choosing to whoever asked.
 *
 * **The doctrine is `Completion`'s, word for word: table lookups, never
 * inference, and silence where nothing says what a name is.** A project's
 * classes are read out of its files, a form's controls out of the `.form`
 * beside the code, and a method out of the class body it is declared in. What
 * this deliberately does not do is follow a value: `const x = makeThing(); x.`
 * proposes nothing in the completion popup for the same reason it goes nowhere
 * here -- answering would mean writing a JavaScript analyser, and a wrong jump
 * is worse than none.
 *
 * The runtime's own names are not here either, and that is not a gap: `File`,
 * `TableView` and the rest have no definition in this project to go to, and F1
 * already opens their page. Two keys, two questions.
 */
"use strict";

Namespace("Ide");

/*
 * A method of a class: four spaces in, which is where a method of a class body
 * sits in this tree, and where `FormFiles.handlersIn` already looks for the
 * same reason -- `\b` alone would find a *call* and call it a declaration.
 *
 * `get`, `set`, `static`, `async` and a generator's star are all things that
 * can stand before the name, so they are skipped rather than listed as
 * alternatives to it.
 */
const SYMBOL = new Regex(
    "^ {4}(?:(?:static|async|get|set)\\s+|\\*\\s*)*([A-Za-z_$][\\w$]*)\\s*\\(",
    { Multiline: true });

/*
 * Where a class is declared, in the two spellings this tree uses:
 * `class MainForm extends Form {` and `Ide.Events = class Events {`.
 *
 * The namespaced one is what a module looks like, and its *name* is the one on
 * the left of the assignment -- `Ide.Events` is reached as `Events` from
 * anywhere inside the namespace, which is what makes it the half worth
 * capturing.
 */
const CLASS_AT = new Regex(
    "^\\s*(?:class\\s+([A-Za-z_$][\\w$]*)|" +
    "(?:[A-Za-z_$][\\w$]*\\.)+([A-Za-z_$][\\w$]*)\\s*=\\s*class)\\b",
    { Multiline: true });

Ide.Navigator = class Navigator {

    /** @param {MainForm} ide */
    constructor(ide) {
        this.ide = ide;
    }

    /*
     * F12, on the word the caret is in.  Answers whether it went anywhere, and
     * says so in the log when it did not -- a key that silently does nothing is
     * indistinguishable from a key that is not bound.
     */
    go() {
        const word  = this.ide.wordAtCursor();
        const found = word ? this.find(word) : null;

        if (!found) {
            /* The newline is not the translator's business, so it is added
             * here rather than living inside the msgid. */
            this.ide.log(`${word
                ? Locale.Text("Nothing in this project declares {0}.", word)
                : Locale.Text("Put the cursor on a name first.")}\n`);
            return false;
        }
        return found.control ? this.showControl(found) : this.showCode(found);
    }

    /*
     * Where a name is declared, or `null`.
     *
     * Split out from the gesture because this is where the behaviour is: a test
     * drives it with a string and gets a file and a line, without a caret and
     * without a tab.
     */
    find(word) {
        if (!word || !this.ide.project) return null;

        /* `this.Something` is either a method of the class being edited or a
         * control of the form beside it -- and those are the only two things it
         * can be, which is what makes it the one prefix worth understanding. */
        if (word.startsWith("this.")) {
            const member = word.slice(5).split(".")[0];
            return this.inActiveFile(member) || this.controlNamed(member);
        }

        /* `Ide.Events` and `Events` are the same class; the tail is its name. */
        const tail = word.includes(".") ? word.slice(word.lastIndexOf(".") + 1)
                                        : word;

        return this.classNamed(tail) || this.inActiveFile(tail);
    }

    /* --- the three lookups ------------------------------------------------- */

    /* A method declared in the file that is open. */
    inActiveFile(name) {
        const file = this.ide.activeFile;
        if (!file || File.Extension(file).toLowerCase() !== "js") return null;

        const line = this.symbolLine(this.sourceOf(file), name);
        return line ? { file, line } : null;
    }

    /* A control of the `.form` beside the code being edited. */
    controlNamed(name) {
        const file = this.ide.activeFile;
        if (!file) return null;

        const form = `${file.slice(0, file.length - File.Extension(file).length)}form`;
        if (!File.Exists(File.Join(this.ide.project, form))) return null;

        return this.formHolds(form, name) ? { file: form, control: name } : null;
    }

    /*
     * A class of this project, wherever it is declared.
     *
     * **Read every time, and not kept.** An index would have to be thrown away
     * whenever a class is renamed, a file is added or a tab is edited, and
     * getting that wrong sends F12 to a line that no longer declares anything
     * -- a wrong jump, which is the one outcome worse than none. What it costs
     * instead is reading the project's `.js` files, which is what *Find in
     * project* does on every search: 40 files and 20 000 lines for the IDE's own
     * project, once per keypress, and it stops at the first declaration.
     *
     * The files are `Classes`'s listing, so a folder the project invented is
     * covered without this class knowing how a project is laid out -- the same
     * reason every other reader of the tree goes through that one.
     *
     * The first declaration wins: two classes of one name is a project that
     * will not run, and `warnDuplicateClasses` is what says so.
     */
    classNamed(name) {
        for (const file of this.ide.classes.files) {
            if (File.Extension(file).toLowerCase() !== "js") continue;

            const source = this.sourceOf(file);
            for (const found of CLASS_AT.Matches(source))
                if ((found.Group(1) || found.Group(2)) === name)
                    return { file, line: lineAt(source, found.Index) };
        }
        return null;
    }

    /* --- reading ----------------------------------------------------------- */

    /*
     * What a file of the project says **now**: the tab when one is open on it,
     * the file otherwise.  A method written a moment ago and not yet saved is
     * still a method, which is the same bargain `FormFiles.siblingSource` makes
     * and for the same reason.
     */
    sourceOf(name) {
        const state = this.ide.openTabs.get(name);
        if (state && state.editor) return state.editor.Text;

        const path = File.Join(this.ide.project, name);
        return File.Exists(path) ? File.Load(path) : "";
    }

    /* The line a method is declared on, or 0. */
    symbolLine(source, name) {
        for (const found of SYMBOL.Matches(source))
            if (found.Group(1) === name) return lineAt(source, found.Index);

        return 0;
    }

    /* Every method a `.js` declares, in the order they are written: what the
     * go-to-symbol list is made of. */
    symbols(source) {
        return SYMBOL.Matches(source)
                     .map((found) => ({ name: found.Group(1),
                                        line: lineAt(source, found.Index) }));
    }

    /* Whether a `.form` holds a control of that name, at any depth. */
    formHolds(form, name) {
        let tree;
        try {
            tree = File.LoadJson(File.Join(this.ide.project, form));
        } catch (e) {
            return false;                      /* unreadable is not an answer */
        }

        const walk = (node) => {
            if (!node) return false;
            if (node.name === name) return true;
            return (node.children || []).some(walk);
        };
        return (tree.children || []).some(walk);
    }

    /* --- going there ------------------------------------------------------- */

    showCode(at) {
        if (!this.ide.openInTab(at.file)) return false;
        if (!this.ide.Editor) return false;

        this.ide.Editor.GotoLine(at.line);
        this.ide.Editor.SetFocus();
        return true;
    }

    /*
     * A control is *selected*, not scrolled to: a `.form` opens in the designer
     * and a designer has no lines. Which is the same answer the project tree
     * gives for a `.form`, and the reason the two halves of a form being one
     * thing is worth anything at all.
     */
    showControl(at) {
        if (!this.ide.openInTab(at.file)) return false;
        if (!this.ide.designing) return false;

        const control = this.ide.designer.allControls()
                            .find((c) => c.Name === at.control);
        if (!control) return false;

        this.ide.designer.select(control);
        return true;
    }
};

/* The 1-based line a character index falls on. */
function lineAt(source, index) {
    return source.slice(0, index).split("\n").length;
}
