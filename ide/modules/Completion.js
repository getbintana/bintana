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
 *     this.Btn1.       what a Button really has -- its class answers, with no
 *                      control built
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
/*
 * **There is no list here, and that is the whole change.**
 *
 * It used to be a table of fourteen global names written by hand, and it was
 * wrong in the way a hand-written list is always wrong: it was missing about
 * eighteen (`Printer`, `Hash`, `Text`, `Desktop`, `Exec`, `Http`, `Xml`,
 * `Database`, `Bytes`, `Decimal`, `Day`, `Time`, `Regex`, `Task`, `Lock`,
 * `Stopwatch`, `Dictionary`, `AudioPlayer`), so `Printer.` and `Http.` completed
 * nothing, and nothing would have said so. Worse, **the names in it were not
 * enough even when they were right**: `Timer` was listed, and `Timer.` still
 * answered **zero entries**, because `Dictionary.Keys` on a class is empty -- a
 * static is a property of the class and not of an object.
 *
 * Both halves are now asked of the runtime, which is where the answers live:
 * `Application.Globals()` for what is installed, and `Widget.Members(type)` for
 * what a class has, which is the verb that answers for a class that is not a
 * widget. A global's own members still come from `Dictionary.Keys`, and that is
 * not a second implementation: a global is an object and its keys are its keys.
 */

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

/*
 * **The provider is called from inside GTK, so its arguments arrive the way GTK
 * builds them and not the way a test would like them** -- and this module already
 * said the half that matters: `before` is the line *up to where the word starts*.
 * A bare name inside an ordinary line therefore arrives with that line's own
 * punctuation on the end of it, and a test that passes `""` proves nothing about
 * the editor.
 *
 * **This has now cost the same bug twice.** The first was `Btn1_`, a
 * handler-shaped word matched against a line-start pattern, which answered for
 * exactly one keystroke. The second was a guard that refused a bare name whose
 * `before` ended in whitespace -- so `const t = Tim`, with `before` of
 * `"    const t = "`, offered nothing, **and the suite was green throughout**
 * because the test invented its arguments.
 *
 * The rule that covers both: **ask the arguments the way GTK builds them, or the
 * assertion is a property of the test.** So every case added here is asked the
 * way the editor asks it, and the correction was checked by putting the old code
 * back and watching three of the four fail -- which is the only half of "this is
 * a test" that is not a claim.
 */

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

        /* Which type names the runtime answers by class, worked out once: the
         * class list does not change while the IDE runs. */
        this.widgets = new Set(Widget.Types());
    }

    /* Called wherever the project's files change: a control renamed in the
     * designer is a different answer here. */
    forget() {
        this.forms.clear();
        this.declared.clear();
        this._globals = null;
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

        /* GTK can hand either of these as nothing: `before` is the text left of
         * the word and is absent when the word is the first thing on the line,
         * which is the ordinary case for a bare name. Guarded here rather than
         * at the one call that noticed, because the next `before` is whatever
         * GTK sends. */
        word  = word  || "";
        before = before || "";

        /* `Ok_`, `Ok_Cl`: a handler being written. A local called `my_thing`
         * matches the same shape, so it only answers when the name really is a
         * control -- and falls through to the paths below when it is not. */
        const handler = HANDLER_WORD.exec(word);
        if (handler) {
            const events = this.eventsOf(handler[1]);
            if (events.length) return events;
        }

        const path = PATH_BEFORE_DOT.exec(before);
        if (!path) {
            /* **No dot: the name itself, and the guard is only that it is a
             * name.** A handler-shaped word was taken above, and a member
             * access is the case that does not land here, so what is left is
             * exactly the ordinary case: `Timer`, `File`, `Confirm` at the start
             * of an expression, after a space, after `=`, inside a call.
             *
             * **Nothing is asked of `before`, and that is the correction.** The
             * first version refused a word whose `before` ended in whitespace,
             * on the theory that it was somebody's business -- and `before` is
             * the line up to where the word *starts*, so `const t = Tim` sends
             * `"    const t = "` and the most ordinary line in the language was
             * the one that answered nothing. The test passed throughout,
             * **because it called `Editor_Complete` with an empty `before`**,
             * which is precisely the mistake this module's own comment warns
             * about: made-up arguments are how the `Btn1_` case first passed and
             * answered nothing in the editor. */
            /* **One shape is still somebody else's business, and it is decided on
             * the word rather than on `before`.** `HANDLER_WORD` is a name with
             * an underscore in it, which is what a handler looks like halfway --
             * `Btn1_`, `Ok_Cl`. Those fall through to here only when no control
             * answers, and they must not come back as 287 globals: `my_thing` is
             * a local being written, and offering every name in the language for
             * it is noise where a person asked for nothing. So the underscore is
             * the test, and `before` is not asked at all.
             *
             * **And that is an assertion the fix above broke**, which is the
             * shape of it: making the no-dot case answer everything is what a
             * name needs and is wrong for a handler, so the two have to be told
             * apart on the one piece of evidence that distinguishes them. */
            if (!/[\w$]/.test(word)) return [];
            if (HANDLER_WORD.test(word)) return [];
            return this.globals(word);
        }

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

        /*
         * One name, four things it can be, and the order is the order of how
         * sure we are -- which is the whole of the design of this function.
         *
         * **A class or a global first, and both through one verb.**
         * `Widget.Members` answers for a class that is not a widget (`Timer`,
         * `Package`, `QrCode`) and for a global that is a bag of functions
         * (`File`, `Locale`, `Printer`), so there is one road and not two, and a
         * name that is neither falls through to the two below. It had to be that
         * verb and not `Dictionary.Keys`: **`Dictionary.Keys` on a class is
         * empty**, because a static is a property of the class and not of an
         * object -- so `Timer.` offered nothing at all while `Timer` sat in the
         * hand-written table of globals, known and useless.
         *
         * **Then a namespace of this project**, read out of the code rather than
         * from an object, because the project is not loaded here. **Then a local
         * this file built**: `const btn = new Button(); btn.`
         */
        if (parts.length === 1) {
            const members = this.membersOfClass2(parts[0]);
            if (members.length) return members;

            const ns = this.ide.classes.namespaceMembers(parts[0]);
            if (ns.length) return ns.map((m) => ({ Text: m, Detail: "" }));

            return this.membersOfDeclared(parts[0]);
        }

        /* A path this project says nothing about. The honest answer is nothing
         * at all, rather than a guess dressed as knowledge. */
        return [];
    }

    /*
     * A bare name: what a program may write at the top level.
     *
     * **This is the case that was missing entirely**, and it is the ordinary
     * one: a file whose first line is `const timer = Timer.After(300, ...);` got
     * nothing for `Timer`, and the engine was dot-driven, so every name in a
     * program was invisible until a `.` was typed. Nothing about a RAD suggests
     * that -- the whole language is `Control_Event` methods and bare calls to
     * `File`, `Locale` and `Message`.
     *
     * Four answers, and none of them a list kept here:
     *
     * - **What the runtime installed**, from `Application.Globals()`. That
     *   includes the JavaScript builtins -- `Math`, `JSON`, `Date`, `Map` --
     *   which is right: they are what a program may write, and a curated subset
     *   would be the hand-written list this replaced.
     * - **The widget classes**, from `Widget.Types()`.
     * - **The classes of the libraries the project `uses`**, and of the project
     *   itself, out of `Application.Symbols` over the sources. **A top-level
     *   `class` is a lexical binding and not a property of the global object**,
     *   so `Globals()` cannot see `Confirm` however the library is loaded -- read
     *   and asked, which is the same road `Ide.Classes` already walks.
     *
     * **Scanned once per project, not once per word.** The list cannot change
     * while a word is being typed, and the walk is a project tree plus every
     * library's sources -- so keying the cache on the word rebuilt it once per
     * new word, on the path GTK runs on every keystroke. `forget()` is the hook
     * a project change already goes through, which is the right lifetime for a
     * question whose answer is a property of the project.
     */
    globals(word) {
        if (!this._globals) this._globals = this.collectGlobals();
        const out = [];
        for (const name of this._globals)
            if (name !== word) out.push({ Text: name, Detail: "global" });
        return out;
    }

    collectGlobals() {
        const out = [];
        for (const name of Application.Globals()) if (!out.includes(name)) out.push(name);
        for (const name of Widget.Types())          if (!out.includes(name)) out.push(name);
        for (const name of this.classNames())      if (!out.includes(name)) out.push(name);
        return out.sort();
    }

    /* Every class the project declares and every class of every library it
     * `uses`, read out of the sources with the parser. */
    classNames() {
        const out = [];
        const take = (src) => {
            for (const sym of Application.Symbols(src))
                if (sym.Kind === "Class" && !out.includes(sym.Name)) out.push(sym.Name);
        };

        const root = this.ide.project;
        if (root) {
            for (const name of Directory.List(root)) {
                if (name.startsWith(".")) continue;
                const path = File.Join(root, name);
                if (File.IsDir(path)) {
                    const walk = (dir) => {
                        for (const f of Directory.List(dir)) {
                            if (f.startsWith(".")) continue;
                            const p = File.Join(dir, f);
                            if (File.IsDir(p)) walk(p);
                            else if (f.endsWith(".js")) take(File.Load(p));
                        }
                    };
                    walk(path);
                } else if (name.endsWith(".js")) {
                    take(File.Load(path));
                }
            }
        }

        /* **Only the libraries this project `uses`, and the walk is not written
         * here.** The first version asked `Application.Libraries()` -- every
         * library installed on the machine -- so a project that names one
         * library was offered every class of all seven: `QrView` in a program
         * that has no `qr` anywhere in it, which is not a completion list, it is
         * a list of what someone else has on their disk.
         *
         * And the answer to *which* libraries is not a new walk either:
         * `Ide.Classes.resolveLibraries()` already reads the manifest and
         * resolves each name, and the rule this file keeps re-learning is that a
         * second copy of a search in JavaScript is the copy that goes stale --
         * the runtime's `LibraryPath` is what a program actually loads, and this
         * would have been a third answer to "where is a library" beside it.
         *
         * **And it is `Ide.Classes`' own cache, not a call to
         * `resolveLibraries()`.** That is a manifest read and a filesystem
         * search per library, and the cache is already there, already invalidated
         * when the project changes -- which is the same lifetime the answer has. */
        for (const { dir } of this.ide.classes.libraries || []) {
            for (const f of Directory.List(dir)) {
                if (f.endsWith(".js")) take(File.Load(File.Join(dir, f)));
            }
        }
        return out;
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
     * A widget's class answers -- properties *and* methods, with no control
     * built. A class of the project answers from **its two files** -- the
     * controls its `.form` names and the methods its `.js` declares -- which is
     * the same pair `membersOfForm` reads about the file on screen, asked about
     * another one. Nothing is loaded and nothing is parsed: `Ide.Names`
     * flattens the JSON and the methods are the same four-spaces-name-bracket
     * shape.
     */
    membersOfDeclared(name) {
        const type = this.declaredType(name);
        if (!type) return [];

        if (this.widgets.has(type)) return this.membersOfType(type);

        /* A menu item or a command answers from the sample this window lends;
         * the two of them are not widgets, so their class cannot be asked. */
        const sample = this.ide.names.sampleFor(type);
        if (sample)
            return sample.PropertyNames().map((p) => ({ Text: p, Detail: type }));

        return this.membersOfClass(type);
    }

    /* A control's vocabulary: what its class can be set to, and what it can be
     * asked to do. Most of the popup after `this.Btn.` is the first list, and
     * a method that never showed up there was half the class missing. A method
     * carries its **parameters** -- declared beside it in C, or in the class's
     * `static Signatures` -- which is the hint a name alone cannot give. */
    membersOfType(type) {
        const out = Widget.PropertyNames(type)
                          .map((p) => ({ Text: p, Detail: type }));

        for (const method of Widget.Methods(type)) {
            const sig = Widget.Signature(type, method);
            out.push({ Text: method,
                       Detail: sig ? `${method}${sig}` : type });
        }
        return out;
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

    /*
     * `this.Btn.` -- what a control of that type has.
     *
     * The class answers, so a widget's properties and methods both arrive with
     * no control built. A component of the project is not a class of *this*
     * process -- the IDE never loads the project's code -- so there is nothing
     * to ask for one, and the answer falls through to what its class declares
     * (`Ide.Classes`, read from the source once per listing, so this stays a
     * lookup).
     */
    propertiesOf(name) {
        const type = this.typeOf(name);
        if (!type) return [];

        if (this.widgets.has(type)) return this.membersOfType(type);

        const sample = this.ide.names.sampleFor(type);
        if (sample)
            return sample.PropertyNames().map((p) => ({ Text: p, Detail: type }));

        const props = this.ide.classes.componentProperties(type);
        if (!props) return [];

        return props.map((p) => ({ Text: p, Detail: type }));
    }

    /* Most derived first, which is `EventNames()`'s own order: `Click` before
     * the mouse events every widget has -- and, for a component, whatever its
     * `static Events` names before either. */
    eventsOf(name) {
        const type = this.typeOf(name);
        if (!type) return [];

        let events;
        if (this.widgets.has(type)) {
            events = Widget.EventNames(type);
        } else {
            const sample = this.ide.names.sampleFor(type);
            events = sample ? sample.EventNames()
                            : this.ide.classes.componentEvents(type);
        }
        if (!events) return [];

        return events.map((e) => ({ Text: `${name}_${e}`, Detail: type }));
    }

    /*
     * The members of a **class**, asked of the runtime.
     *
     * `Widget.Members(type)` answers for any class a name resolves to -- a
     * widget, a class of rad.js like `Timer`, a class of a library, a class of
     * the project -- and gives each one a kind, which is what the popover shows
     * in its right-hand column. `Widget.Methods` was the wrong verb here for a
     * reason worth keeping: it walks the prototype, so it holds instance methods
     * and **no static**, and every library verb of any consequence is a static.
     *
     * Cached per name for the length of one popover, and reset by the same
     * narrow-to-wider rule the method scan uses.
     */
    membersOfClass2(name) {
        if (!this._members || this._membersFor !== name) {
            this._membersFor = name;
            this._members    = [];

            let found = null;
            try { found = Widget.Members(name); } catch (e) { found = null; }
            for (const m of found || []) {
                const kind = m.Kind;
                this._members.push({
                    Text: kind === "Method" || kind === "Static" ? m.Name : m.Name,
                    Detail: kind === "Method" ? "()" : (kind === "Static" ? "static" : ""),
                });
            }
        }
        return this._members;
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
