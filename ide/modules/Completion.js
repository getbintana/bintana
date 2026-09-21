/*
 * What the editor proposes, when it is asked about Bintana rather than about
 * the words already in the file.
 *
 * `SourceEditor.Completion` offers the buffer's own words, which is the floor of
 * what an editor owes and the whole of what can be known without being told.
 * This is the telling: `Editor_Complete` is dispatched on every keystroke that
 * could start a completion, and what comes back is what the project *knows*.
 *
 * **Nothing here is inferred, and that is the whole reason it can exist.** A
 * completion engine for JavaScript normally needs a parser and a type
 * inferencer, because nothing in the language says what `x` is. Here the
 * runtime publishes what it knows about itself and the `.form` beside a class
 * says what every control on it is, so the completions worth having are table
 * lookups:
 *
 *     this.            everything this form names, and the methods in this file
 *     this.Btn1.       what a Button really has -- PropertyNames() on one
 *     this.MnuSave.    the same, on a MenuItem
 *     Btn1_            what a Button raises  -- EventNames(), most derived first
 *     File.            Dictionary.Keys(File)
 *     btn.             what `const btn = new Button()` says, read from the file
 *     this.ide.        what `@param {MainForm} ide` says, likewise
 *
 * A control of the project's own -- a component -- is answered the same way and
 * from a different place: its class is not one of this process, so what it
 * declares is read out of its source. Same question, same order, same rule that
 * nothing is inferred.
 *
 * **The last two are declarations written in the file, not inference.** Which is
 * what makes them a lookup like the others -- and why there are two of them and
 * not a general answer: measured over `ide/` and `examples/`, of 1916
 * declarations only 12 % state a type at all, and the largest bucket, 38 %, is
 * the return of a call, which nothing writes down. The JSDoc one is the one that
 * pays: `this.ide.` is 509 of the 1410 `this.<field>.` in this tree, it is a
 * constructor parameter, and no `new` names it. See
 * `docs/plans/completion-plan.md`.
 *
 * **And the limit is stated rather than papered over**: `const x = makeThing();
 * x.` proposes nothing, because nothing in the project says what `makeThing`
 * returns. Promising otherwise would mean writing a JavaScript analyser, which
 * is a different program. The words provider still offers the *spelling* of
 * anything in the file, which is most of what one wants from a local.
 *
 * The hard rule, from the plan and from where this runs: **a lookup and nothing
 * else**. The handler fires inside GTK's completion machinery, on the
 * keystroke, so anything slow here is a keystroke that stutters.
 */
"use strict";

Namespace("Ide");

/*
 * The globals worth completing, asked of the objects themselves.
 *
 * A table of *names* and not of members: `Dictionary.Keys` is what answers, so a
 * global that gains a member in C gains it here with nothing changed -- the
 * same bargain `EventNames()` made when it retired a hardcoded table of fifteen
 * widget types.
 */
const COMPLETION_GLOBALS = {
    Application, Environment, File, Directory, Dialog, Message, Locale,
    Clipboard, Settings, Timer, Logger, Widget, Record, Field,
};

/* `this.Btn1.` and `File.` both end in a path; this is what it looks like. */
const PATH_BEFORE_DOT = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.$/;

/*
 * `Btn1_` -- a handler being written.
 *
 * Matched against the **word** and not against the line before it: `_` is a word
 * character, so what arrives is `Ok_` whole, or `Ok_Cl` once two letters of the
 * event are in, while `before` holds only the indentation. Looking for it to the
 * left of the word is the mistake that made this case answer for exactly one
 * keystroke and then stop.
 */
const HANDLER_WORD = /^([A-Za-z_$][\w$]*)_[\w$]*$/;

/* A method of the class being edited: four spaces, a name, a bracket. The same
 * shape `FormFiles` writes and reads when it inserts a handler. */
const METHOD_LINE = /^ {4}(?:static\s+|get\s+|set\s+|async\s+)*([A-Za-z_$][\w$]*)\s*\(/gm;

/*
 * The two things written in a file that say what a name *is*.
 *
 * Measured over `ide/` and `examples/` before either was written, because the
 * shape of this language is not the shape one expects: of 1916 declarations only
 * 12 % state a type at all, and the largest bucket -- 38 % -- is the return of a
 * call, which nothing in the project writes down. So these are not a general
 * answer and are not offered as one. They are the two that are written:
 *
 *     new Foo()          a field or a local built here, 157 declarations
 *     @param {Foo} x     a constructor parameter, which nothing else can say
 *
 * The second is why it is worth having at all. `this.ide.` is 509 of the 1410
 * `this.<field>.` in this tree -- 36 % of every one of them -- and it is a
 * constructor parameter, so no `new` names it and TypeScript infers `any` for it
 * too. One JSDoc line fixes it there and here, and 32 of them cover the tree.
 *
 * Sources and not a `const` pattern: the name goes into the pattern, so one is
 * built per question -- and a `Regex` remembers nothing between calls, so the
 * one that is built is handed straight to `Match`.
 */
const BUILT_HERE = (name) =>
    new Regex(`(?:^|[;{}\\n]|\\bthis\\.)\\s*(?:const\\s+|let\\s+|var\\s+)?` +
              `${name}\\s*=\\s*new\\s+([A-Za-z_$][\\w$.]*)\\s*\\(`);

const DECLARED_JSDOC = (name) =>
    new Regex(`@param\\s*\\{\\s*([A-Za-z_$][\\w$.]*)\\s*\\}\\s*\\[?${name}\\b`);

/* `this.thing = thing` -- the line that ties a field to the parameter whose
 * JSDoc says what it is. Without it the JSDoc lookup would only answer for a
 * field whose name happens to be the parameter's, which is the habit here and
 * not a rule anybody has to keep. */
const FIELD_FROM_PARAM = (name) =>
    new Regex(`\\bthis\\.${name}\\s*=\\s*([A-Za-z_$][\\w$]*)\\s*[;\\n]`);

Ide.Completion = class Completion {

    /** @param {MainForm} ide */
    constructor(ide) {
        this.ide = ide;

        /* Two caches, because the handler runs on the keystroke.  Both are
         * dropped rather than kept in step: `forms` by whoever changes the
         * project's files, `methods` by the text it was taken from no longer
         * being the text in the editor. */
        this.forms   = new Map();
        this.methods = { names: [] };
        /* And a third, for a class of the project asked about from another
         * file: two reads per class, on the keystroke. Not `classes`, which is
         * `Ide.Classes` two characters away and would read as the same thing. */
        this.declared = new Map();
    }

    /* Called wherever the project's files change: a control renamed in the
     * designer is a different answer here. */
    forget() {
        this.forms.clear();
        this.declared.clear();
    }

    /*
     * The answer for where the cursor is, or nothing.
     *
     * `word` is what is being typed; `before` is the line up to where that word
     * *starts*, which is the stable half -- `this.Ok.` reads the same whether
     * two letters of the property have been typed or none. Narrowing the answer
     * to what has been typed is the runtime's, through GtkSourceView's own fuzzy
     * match, so every provider narrows the same way and this stays a lookup.
     */
    answer(word, line, column, before) {
        if (!this.ide.project || !this.ide.activeFile) return [];

        /* `Ok_`, `Ok_Cl`: a handler being written. A local called `my_thing`
         * matches the same shape, so it only answers when the name really is a
         * control -- and falls through to the paths below when it is not. */
        const handler = HANDLER_WORD.exec(word);
        if (handler) {
            const events = this.eventsOf(handler[1]);
            if (events.length) return events;
        }

        const path = PATH_BEFORE_DOT.exec(before);
        if (!path) return [];

        const parts = path[1].split(".");

        if (parts[0] === "this") {
            if (parts.length === 1) return this.membersOfForm(word);
            if (parts.length === 2) {
                /* A control of the form beside this file, which is the answer
                 * that costs nothing; a field this file *declares* otherwise. */
                const own = this.propertiesOf(parts[1]);
                return own.length ? own : this.membersOfDeclared(parts[1]);
            }
            return [];                  /* deeper than the .form can answer */
        }

        if (parts.length === 1 && parts[0] in COMPLETION_GLOBALS)
            return this.membersOf(COMPLETION_GLOBALS[parts[0]]);

        /* A namespace of this project: `Ide.` in the IDE's own sources, and
         * whatever the project declared in anybody else's. Read out of the code
         * rather than from an object, because the project is not loaded here. */
        if (parts.length === 1) {
            const members = this.ide.classes.namespaceMembers(parts[0]);
            if (members.length) return members.map((m) => ({ Text: m, Detail: "" }));

            /* A local this file built: `const btn = new Button(); btn.` */
            return this.membersOfDeclared(parts[0]);
        }

        /* A path this project says nothing about. The honest answer is nothing
         * at all, rather than a guess dressed as knowledge. */
        return [];
    }

    /* --- what the file itself declares --------------------------------------- */

    /*
     * The type of a name, out of the file on screen, or `""`.
     *
     * Two lookups and no inference: a `new` written here, and a JSDoc line. The
     * second is asked of the field's own name first and then of whatever the
     * constructor assigned to it, so `constructor(ide) { this.ide = ide; }` is
     * answered by `@param {MainForm} ide` whichever of the two names one writes.
     */
    declaredType(name) {
        const editor = this.ide.Editor;
        if (!editor) return "";

        const text  = editor.Text;
        const built = BUILT_HERE(name).Match(text);
        if (built) return built.Group(1);

        const said = DECLARED_JSDOC(name).Match(text);
        if (said) return said.Group(1);

        const from = FIELD_FROM_PARAM(name).Match(text);
        if (!from) return "";

        const param = DECLARED_JSDOC(from.Group(1)).Match(text);
        return param ? param.Group(1) : "";
    }

    /*
     * What a name of that type has, when the type is one this project wrote.
     *
     * A widget answers from the runtime, as everything else here does. A class
     * of the project answers from **its two files** -- the controls its `.form`
     * names and the methods its `.js` declares -- which is the same pair
     * `membersOfForm` reads about the file on screen, asked about another one.
     * Nothing is loaded and nothing is parsed: `Ide.Names` flattens the JSON and
     * the methods are the same four-spaces-name-bracket shape.
     */
    membersOfDeclared(name) {
        const type = this.declaredType(name);
        if (!type) return [];

        const control = this.sample(type);
        if (control)
            return control.PropertyNames().map((p) => ({ Text: p, Detail: type }));

        return this.membersOfClass(type);
    }

    /*
     * One class of the project, by name -- kept, because this reads two files
     * and runs on the keystroke. Dropped with the rest by `forget()`, which is
     * what every listing calls.
     */
    membersOfClass(type) {
        if (this.declared.has(type)) return this.declared.get(type);

        const out  = [];
        const seen = new Set();
        const add  = (text, detail) => {
            if (seen.has(text)) return;
            seen.add(text);
            out.push({ Text: text, Detail: detail });
        };

        const form = this.ide.classes.formOfClass(type);
        if (form) {
            try {
                for (const node of this.ide.names.tableOf(
                         File.LoadJson(File.Join(this.ide.project, form))))
                    add(node.name, node.type);
            } catch (e) {
                /* A form half written is not this feature's business to report. */
            }
        }

        const js = this.ide.classes.fileOfClass(type);
        if (js) {
            try {
                const text = File.Load(File.Join(this.ide.project, js));
                for (const m of text.matchAll(METHOD_LINE)) add(m[1], "method");
            } catch (e) {
                /* Likewise. */
            }
        }

        this.declared.set(type, out);
        return out;
    }

    /* --- what the sibling .form says ---------------------------------------- */

    /*
     * Everything the form beside this file names, flattened -- a control is
     * addressed by name whatever it is nested in, because a handler is
     * `Name_Event` on the form and names are unique across it.
     *
     * The walk is `Ide.Names`'s and not one of this file's own. It was one of
     * this file's own, and it read `children` alone, which is how three
     * flatteners came to agree that a menu item is not a thing a form has.
     */
    controls() {
        const form = this.ide.formOf(this.ide.activeFile);
        if (!form) return [];

        if (this.forms.has(form)) return this.forms.get(form);

        let out = [];
        try {
            out = this.ide.names.tableOf(
                File.LoadJson(File.Join(this.ide.project, form)));
        } catch (e) {
            /* A form half written is not this feature's business to report. */
        }

        this.forms.set(form, out);
        return out;
    }

    typeOf(name) {
        const found = this.controls().find((c) => c.name === name);
        return found ? found.type : "";
    }

    /*
     * A control of that type, or nothing.
     *
     * `Ide.Names` answers it -- one control per type, kept, and the two classes
     * a `.form` declares outside `children` borrowed from this window's own menu
     * bar. A component of the project is not a class of *this* process -- the
     * IDE never loads the project's code -- so there is nothing to ask for one,
     * and the two answers below fall through to what its class declares instead
     * (`Ide.Classes`, read from the source once per listing, so this stays a
     * lookup).
     */
    sample(type) {
        return this.ide.names.sampleFor(type);
    }

    /* --- the four answers ---------------------------------------------------- */

    membersOfForm(word) {
        const controls = this.controls().map((c) => ({
            Text: c.name, Detail: c.type,
        }));

        /* Plus what this file itself declares: the methods of the class being
         * edited are what `this.` most often means. */
        return controls.concat(this.methodsHere(word).map((m) => ({
            Text: m, Detail: "method",
        })));
    }

    propertiesOf(name) {
        const type    = this.typeOf(name);
        const control = this.sample(type);
        const props   = control ? control.PropertyNames()
                                : this.ide.classes.componentProperties(type);
        if (!props) return [];

        return props.map((p) => ({ Text: p, Detail: type }));
    }

    /* Most derived first, which is `EventNames()`'s own order: `Click` before
     * the mouse events every widget has -- and, for a component, whatever its
     * `static Events` names before either. */
    eventsOf(name) {
        const type    = this.typeOf(name);
        const control = this.sample(type);
        const events  = control ? control.EventNames()
                                : this.ide.classes.componentEvents(type);
        if (!events) return [];

        return events.map((e) => ({ Text: `${name}_${e}`, Detail: type }));
    }

    membersOf(global) {
        return Dictionary.Keys(global).sort().map((k) => ({
            Text: k, Detail: typeof global[k] === "function" ? "()" : "",
        }));
    }

    /*
     * The methods declared in the file on screen.
     *
     * Taken from the text and not from a class, because the IDE does not load
     * the project's code -- it edits it.
     *
     * **Scanned when the completion starts, and not again while it narrows**,
     * which is the difference between a feature and a stutter. Measured on the
     * IDE's own `MainForm.js` -- 1239 lines, 53 KB -- reading `Text` and running
     * the scan is **9.2 ms**, and this is called from inside GTK's completion
     * machinery on the keystroke. Keying the cache on the text, as this did at
     * first, is a cache that can never hit: the text is precisely what changes
     * with every character typed.
     *
     * An empty `word` is the start of a context -- the moment `this.` was typed
     * -- and while one narrows it with letters no method is being declared, so
     * the list from a moment ago is the right one. What it costs is a method
     * written in the last second not appearing until the next popover, against
     * nine milliseconds on every keystroke.
     */
    methodsHere(word) {
        const editor = this.ide.Editor;
        if (!editor) return [];

        if (word && this.methods.names.length) return this.methods.names;

        const names = [];
        for (const m of editor.Text.matchAll(METHOD_LINE))
            if (!names.includes(m[1])) names.push(m[1]);

        this.methods = { names };
        return names;
    }
};
