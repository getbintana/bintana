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
 * `File.Info(p).`, `db.Query(sql)[0].`, `this.Btn.Bounds().`: the expression a
 * dot follows, read **backwards** from the dot over names, dots, and calls and
 * indexes whose brackets balance -- and nothing else, so `x = File.Info(p).`
 * answers `File.Info(p)` and a space outside a bracket is where it starts.
 * What is inside a bracket is skipped and not understood: the arguments of a
 * call do not change what the call answers.
 */
function completionChain(before) {
    const text = before.endsWith(".") ? before.slice(0, -1) : before;
    let i = text.length, depth = 0;
    while (i > 0) {
        const c = text[i - 1];
        if (c === ")" || c === "]") { depth++; i--; continue; }
        if (c === "(" || c === "[") { if (depth === 0) break; depth--; i--; continue; }
        if (depth > 0 || /[\w$.]/.test(c)) { i--; continue; }
        break;
    }
    return depth === 0 ? text.slice(i) : "";
}

/* ...and the same expression as steps: a name, whether it was called, and an
 * index. `null` for anything that is not one of those three in a row. */
function completionSteps(expr) {
    const steps = [];
    let i = 0;
    const skip = (open, close) => {
        let depth = 0;
        for (; i < expr.length; i++) {
            if (expr[i] === open) depth++;
            else if (expr[i] === close && --depth === 0) { i++; return true; }
        }
        return false;
    };
    while (i < expr.length) {
        if (expr[i] === ".") { i++; continue; }
        const name = /^[A-Za-z_$][\w$]*/.exec(expr.slice(i));
        if (name) { steps.push({ name: name[0], call: false }); i += name[0].length; continue; }
        if (expr[i] === "(" && steps.length) {
            if (!skip("(", ")")) return null;
            steps[steps.length - 1].call = true;
            continue;
        }
        if (expr[i] === "[" && steps.length) {
            if (!skip("[", "]")) return null;
            steps.push({ index: true });
            continue;
        }
        return null;
    }
    return steps.length ? steps : null;
}

/*
 * The names a file puts in scope at a line, out of the parser's report: the
 * parameters of every function that contains the line (innermost first), the
 * variables declared inside those functions above it, and what the file
 * declares at its top level -- variables and functions -- anywhere, since a
 * top-level name is in scope before its line is reached as far as a function
 * called later is concerned.
 *
 * `Scope` is a function as the lines it spans and `Variable` a declared name
 * at its line; a variable belongs to the innermost scope that contains its
 * line, and is offered only when that scope contains the cursor too. Block
 * scope is not modelled -- a `let` inside an `if` above the cursor is offered
 * after the `if` has closed -- which is the wrong direction to be wrong in
 * only by a name the person can see.
 */
function completionScopeNames(symbols, line) {
    const scopes = symbols.filter((s) => s.Kind === "Scope");
    const inner  = (at) => {
        let best = null;
        for (const sc of scopes)
            if (sc.Line <= at && at <= sc.End &&
                (!best || sc.Line >= best.Line)) best = sc;
        return best;
    };
    const open = scopes.filter((sc) => sc.Line <= line && line <= sc.End)
                       .sort((a, b) => b.Line - a.Line);
    const out = [];
    const add = (name, detail) => {
        if (name && !out.some((e) => e.Text === name)) out.push({ Text: name, Detail: detail });
    };

    for (const sc of open)
        for (const p of (sc.Params || "").replace(/^\(|\)$/g, "").split(","))
            add(p.trim().replace(/^\[|\]$/g, "").replace(/^\.\.\./, ""), "parameter");

    for (const v of symbols) {
        if (v.Kind !== "Variable") continue;
        const home = inner(v.Line);
        if (!home) add(v.Name, "top level");
        else if (v.Line <= line && open.includes(home)) add(v.Name, "local");
    }
    for (const f of symbols)
        if (f.Kind === "Function") add(f.Name, "function");
    return out;
}

/*
 * A member's description as the popup shows it: its first sentence, in plain
 * text. The description is written once, beside the member, in the Markdown
 * the documentation is made of -- so the backticks, the bold and a link's
 * target come off here, and the rest is the documentation's own words.
 */
function completionSummary(doc) {
    if (!doc) return "";
    let t = doc.split("\n")[0]
               .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
               .replace(/\*\*|`/g, "");
    const end = /[.:;](?=\s+[A-Z(`"*]|\s*$)/.exec(t);
    /* The same cut `tools/docs` makes for an index row, so the popup and the
     * reference say the same first sentence. */
    if (end) t = t.slice(0, end.index);
    return t.trim();
}

/*
 * What a declared answer means as a thing to complete after: the text after the
 * arrow in a signature comment (`-> Bytes`, `-> string[]`, `-> { X, Y }`).
 * `null` is "nothing to offer" -- a boolean, `any`, or nothing declared.
 */
function completionType(ret) {
    const t = (ret || "").trim();
    if (!t) return null;
    if (t.endsWith("[]")) {
        const of = completionType(t.slice(0, -2));
        return { k: "array", of };
    }
    if (t.startsWith("{")) {
        const fields = t.replace(/^\{|\}$/g, "").split(",")
                        .map((f) => f.trim()).filter((f) => /^[A-Za-z_$][\w$]*$/.test(f));
        return { k: "shape", fields };
    }
    if (t === "string") return { k: "builtin", name: "String" };
    if (t === "number") return { k: "builtin", name: "Number" };
    if (t === "boolean" || t === "any" || t === "void") return null;
    return { k: "inst", name: t };
}

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
        this._declared = null;
        this._disk = null;
        this._parsed = null;
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

        /* After a call or an index -- `File.Info(p).` -- the path pattern sees
         * nothing, and before this the line fell through to the bare-name case
         * and offered every global after a dot. */
        if (/[)\]]\.$/.test(before))
            return this.chainAnswer(completionChain(before));

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
            return this.inScope(word, line).concat(
                this.globals(word).filter((g) => !this._scopeNames.has(g.Text)));
        }

        const parts = path[1].split(".");

        if (parts[0] === "this") {
            if (parts.length === 1) return this.membersOfForm(word);
            if (parts.length === 2) {
                /* A control of the form beside this file, which is the answer
                 * that costs nothing; a field this file *declares* otherwise. */
                const own = this.propertiesOf(parts[1]);
                if (own.length) return own;
                const declared = this.membersOfDeclared(parts[1]);
                return declared.length ? declared : this.chainAnswer(path[1]);
            }
            return this.chainAnswer(path[1]);  /* deeper: follow what each step answers */
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
            const members = this.membersOfName(parts[0]);
            if (members.length) return members;

            const ns = this.ide.classes.namespaceMembers(parts[0]);
            if (ns.length) return ns.map((m) => ({ Text: m, Detail: "" }));

            const declared = this.membersOfDeclared(parts[0]);
            return declared.length ? declared : this.chainAnswer(path[1]);
        }

        /* Deeper than one name: follow what each step declares it answers, and
         * a path nothing declares answers nothing -- no guess dressed as
         * knowledge. */
        return this.chainAnswer(path[1]);
    }

    /* --- the call the cursor is in ------------------------------------------ */

    /*
     * `{ Name, Signature, Index, At }` for the innermost call the text ends
     * inside, or null: which function, what it declares, which argument the
     * cursor is in (counted from zero), and where its bracket opened, which is
     * what tells two calls of one name apart.
     *
     * **Read forwards, because a comma is only an argument separator outside a
     * string, a comment and a nested bracket**, and only a forward read knows
     * which of those it is in -- `File.Load("a, b` is the first argument. The
     * callee is the chain before the bracket, resolved the way the popup
     * resolves a dot: `File.Save(`, `this.Btn.Move(`, `db.Query(` all answer
     * what the member declares. `this.go(` is a method of the file on screen,
     * read by the parser. A bracket that is not a call -- `if (`, a function's
     * own parameter list -- resolves to nothing and shows nothing.
     */
    callAt(text) {
        const stack = [];
        let quote = null;
        for (let i = 0; i < text.length; i++) {
            const c = text[i];
            if (quote) {
                if (c === "\\") i++;
                else if (c === quote) quote = null;
                continue;
            }
            if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
            if (c === "/" && text[i + 1] === "/") {
                const nl = text.indexOf("\n", i);
                if (nl < 0) return null;            /* the cursor is in a comment */
                i = nl;
                continue;
            }
            if (c === "/" && text[i + 1] === "*") {
                const end = text.indexOf("*/", i + 2);
                if (end < 0) return null;
                i = end + 1;
                continue;
            }
            if (c === "(" || c === "[" || c === "{") stack.push({ c, at: i, commas: 0 });
            else if (c === ")" || c === "]" || c === "}") stack.pop();
            else if (c === "," && stack.length) stack[stack.length - 1].commas++;
        }

        /* The innermost call: an object or a list being written inside one is
         * still that call's argument. */
        let call = null;
        for (let k = stack.length - 1; k >= 0; k--)
            if (stack[k].c === "(") { call = stack[k]; break; }
        if (!call) return null;

        const expr  = completionChain(text.slice(0, call.at) + ".");
        const steps = completionSteps(expr);
        if (!steps) return null;
        const last = steps[steps.length - 1];
        if (last.index || last.call) return null;

        const found = (sig) => sig
            ? { Name: last.name, Signature: sig, Index: call.commas, At: call.at } : null;

        /* `this.go(`: a method of the class being edited, named by the parser. */
        if (steps.length === 2 && steps[0].name === "this") {
            const editor = this.ide.Editor;
            let own = null;
            try {
                own = Application.Symbols(editor ? editor.Text : "")
                        .find((x) => x.Name === last.name && x.Kind === "Method");
            } catch (e) { own = null; }
            if (own) return found(own.Params || "()");
        }
        if (steps.length < 2) return null;

        const owner = expr.slice(0, expr.length - last.name.length).replace(/\.$/, "");
        const t = this.resolveChain(owner, 0);
        if (!t) return null;
        const m = this.membersOfTypeRaw(t).find((x) => x.Name === last.name &&
                                                 (x.Kind === "Method" || x.Kind === "Static"));
        return m ? found(m.Signature) : null;
    }

    /*
     * --- what a name is, for the tooltip and the help window ----------------
     *
     * `topic(word)` answers the two questions a pointer resting on an
     * identifier asks: what is this, and what does it declare. The name is
     * resolved the way a completion after a dot is -- `resolveChain`, so a
     * control's type, a field's `new`, a local assigned from a call and a
     * library class read by the parser all answer with no second reader -- and
     * a handler name (`Btn_Click`) is resolved to the event it answers.
     */
    topic(word) {
        const name = (word || "").replace(/^\.+|\.+$/g, "");
        if (!name)
            return null;

        if (name.indexOf(".") < 0 && name.indexOf("_") > 0) {
            const cut   = name.indexOf("_");
            const owner = name.slice(0, cut);
            const type  = this.typeOf(owner) || (this.widgets.has(owner) ? owner : "");
            const info  = type ? this.eventInfo(type, name.slice(cut + 1)) : null;
            return info ? { Title: name, Signature: info.Signature, Doc: info.Doc } : null;
        }
        if (name.indexOf(".") < 0)
            return null;

        const expr  = completionChain(name + ".");
        const steps = expr ? completionSteps(expr) : null;
        if (!steps || steps.length < 2)
            return null;

        const last = steps[steps.length - 1];
        if (last.index || last.call)
            return null;

        /* `this.go`: a method of the file being edited, named by the parser. */
        if (steps.length === 2 && steps[0].name === "this") {
            const editor = this.ide.Editor;
            let   own    = null;
            try {
                own = Application.Symbols(editor ? editor.Text : "")
                        .find((x) => x.Name === last.name && x.Kind === "Method");
            } catch (e) { own = null; }
            if (own)
                return { Title: `this.${last.name}`, Signature: own.Params || "()",
                         Doc: own.Doc || "", Returns: own.Returns || "" };
        }

        const owner = expr.slice(0, expr.length - last.name.length).replace(/\.$/, "");
        const t     = this.resolveChain(owner, 0);
        if (!t)
            return null;
        const m = this.membersOfTypeRaw(t).find((x) => x.Name === last.name);
        return m ? { Title: `${owner}.${last.name}`, Signature: m.Signature || "",
                     Doc: m.Doc || "", Returns: m.Returns || "" } : null;
    }

    /*
     * An event's signature and description for a class this process may never
     * have run. The runtime answers out of the sources -- the comment above
     * the `static Events` line that declares it -- and an event the sources do
     * not name is asked of the class every component inherits, which is where
     * `MouseDown` comes from.
     */
    eventInfo(type, event) {
        const sources = [...new Set(this.declaredClasses().sources.values())];
        const ask = (t, options) => {
            try {
                const sig = Widget.EventSignature(t, event, options);
                const doc = Widget.EventDoc(t, event, options);
                if (sig || doc)
                    return { Signature: sig || "", Doc: doc || "" };
            } catch (e) { /* not a class, or no such event */ }
            return null;
        };
        if (this.widgets.has(type))
            return ask(type);
        return ask(type, { Sources: sources }) || ask("Component");
    }

    /*
     * A class as a Markdown page, for an installation with no reference
     * package: the help has to work with only the runtime installed, and the
     * members and descriptions are all in it. `MainForm` hands the answer to
     * `HelpForm.openTopic`, which is the same window a page opens in.
     */
    reference(name, member) {
        let members = [];
        try { members = this.rawMembers(name); } catch (e) { members = []; }
        if (!members.length)
            return null;

        const lines = [`# ${name}`, ""];

        if (member && member.indexOf("_") > 0) {
            const cut  = member.indexOf("_");
            const info = this.eventInfo(name, member.slice(cut + 1));
            if (info) {
                lines.push(`## ${member}`, "", "```js",
                           `${member}${info.Signature || "()"}`, "```", "");
                if (info.Doc)
                    lines.push(info.Doc, "");
                return this.topicPage(name, member, lines);
            }
        }

        lines.push("## Every member", "", "| Member | |", "|---|---|");
        for (const m of members) {
            const sig = (m.Kind === "Method" || m.Kind === "Static")
                        ? (m.Signature || "(...)") : "";
            const doc = (m.Doc || "").replace(/\|/g, "\\|").replace(/\n+/g, " ");
            lines.push(`| \`${m.Name}${sig}\` | ${doc} |`);
        }
        return this.topicPage(name, member, lines);
    }

    topicPage(name, member, lines) {
        const where = this.whereFor(name);
        lines.push("", `[More detail](${where})`);
        return { Name: name, Member: member || "", Text: lines.join("\n"), Where: where };
    }

    /* Which page of the reference to point at, guessed from which list the
     * name is in -- widgets first, then the globals, then a library's class. */
    whereFor(name) {
        const section = this.widgets.has(name) ? "widgets"
                      : Application.Globals().includes(name) ? "globals"
                      : "libraries";
        return `https://github.com/getbintana/bintana-docs/blob/main/docs/reference/${section}/${name}.md`;
    }

    /* --- following a chain -------------------------------------------------- */

    /*
     * `File.Info(p).`, `this.Btn.Bounds().`, `db.Query(sql)[0].`, and a local
     * assigned from one of those: **each step asks what the previous one
     * answers**, and the answer is what the runtime publishes -- the `Returns`
     * of a member, read off the arrow in its signature comment -- so nothing
     * here is inferred and nothing is a table of this module's own.
     */
    chainAnswer(expr) {
        const t = this.resolveChain(expr, 0);
        return t ? this.listFor(t) : [];
    }

    resolveChain(expr, depth) {
        if (depth > 4) return null;             /* a local assigned from itself */
        const steps = completionSteps(expr);
        if (!steps || steps[0].index) return null;

        let t = null, at = 1;
        const first = steps[0];
        if (first.name === "this") {
            /* `this.X`: a control of the form beside this file, or a field
             * this file declares. */
            const second = steps[1];
            if (!second || second.index || second.call) return null;
            const control = this.typeOf(second.name);
            const type = control || this.declaredType(second.name);
            t = type ? { k: "inst", name: type } : this.typeOfLocal(second.name, depth);
            at = 2;
        } else {
            t = this.startType(first, depth);
        }

        for (; t && at < steps.length; at++) t = this.stepType(t, steps[at]);
        return t;
    }

    /* The first name: a local, a class or a global. A class **called** is an
     * instance of it (`Button()` after a `new`, which the chain reader leaves
     * out); a global called is a function, and nothing declares what one
     * answers. */
    startType(step, depth) {
        const local = this.typeOfLocal(step.name, depth);
        if (local) return step.call ? null : local;

        const known = this.widgets.has(step.name) ||
                      this.declaredClasses().sources.has(step.name) ||
                      this.rawMembers(step.name).length > 0;
        if (!known) return null;
        return step.call ? { k: "inst", name: step.name } : { k: "static", name: step.name };
    }

    /* A local, or a field of `this`, and what it holds: a `new`, a JSDoc line,
     * or -- what the arrow made possible -- a call whose answer is declared:
     * `const info = File.Info(p);`. The right-hand side has to be a chain and
     * nothing else, or it says nothing about the type. */
    typeOfLocal(name, depth) {
        const built = this.declaredType(name);
        if (built) return { k: "inst", name: built };

        const editor = this.ide.Editor;
        if (!editor) return null;
        const m = new Regex(`(?:\\b(?:const|let|var)\\s+|\\bthis\\.)${name}\\s*=\\s*([^;\\n]+)`)
                      .Match(editor.Text);
        if (!m) return null;
        const rhs = m.Group(1).trim();
        if (completionChain(rhs + ".") !== rhs) return null;
        return this.resolveChain(rhs, depth + 1);
    }

    /* One step along: a member called, a member read, or an index into a list. */
    stepType(t, step) {
        if (step.index) return t.k === "array" ? t.of : null;

        const m = this.membersOfTypeRaw(t).find((x) => x.Name === step.name);
        if (!m) return null;
        const method = m.Kind === "Method" || m.Kind === "Static";
        if (method !== step.call) return null;
        return completionType(m.Returns);
    }

    /* What a type has, raw -- `{ Name, Kind, Signature, Returns }` each. An
     * instance leaves out its class's statics; a shape is its fields; a
     * builtin and a list are asked with `All`, because what a string has is
     * `split` and `includes`, which the capital convention would hide. */
    membersOfTypeRaw(t) {
        const field = (f) => ({ Name: f, Kind: "Property", Signature: "", Returns: "" });
        switch (t.k) {
        case "static":  return this.rawMembers(t.name);
        case "inst":    return this.rawMembers(t.name).filter((m) => m.Kind !== "Static");
        case "shape":   return t.fields.map(field);
        case "builtin": return [field("length")].concat(
                            this.rawMembers(t.name, true).filter((m) => m.Kind !== "Static"));
        case "array":   return [field("length")].concat(
                            this.rawMembers("Array", true).filter((m) => m.Kind !== "Static"));
        }
        return [];
    }

    listFor(t) {
        if (t.k === "static") return this.membersOfName(t.name);
        return this.membersOfTypeRaw(t).map((m) => ({ Text: m.Name, Detail: this.detailOf(t.name || "", m),
                                                      Doc: completionSummary(m.Doc) }));
    }

    /* `Widget.Members` for a name, with the project's sources and forms, kept
     * for as long as nothing moved (`generation`). */
    rawMembers(name, all) {
        const found = this.declaredClasses();
        this._raw = this._raw && this._rawAt === this.generation ? this._raw : new Map();
        this._rawAt = this.generation;
        const key = (all ? "*" : "") + name;
        if (this._raw.has(key)) return this._raw.get(key);

        const list = [...new Set(found.sources.values())];
        let got = [];
        try {
            got = Widget.Members(name, { Sources: list, Forms: found.forms, All: !!all });
        } catch (e) {
            got = [];
        }
        this._raw.set(key, got);
        return got;
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
     * **Not keyed on the word.** The first version rebuilt the list once per
     * new word, on the path GTK runs on every keystroke. It is rebuilt when a
     * file's classes move instead (`generation`, which `declaredClasses`
     * advances), and the disk half of that is walked once per project.
     */
    globals(word) {
        /* Recomputed when a file's classes moved: a class typed into a tab and
         * not saved is a bare name to offer like any other. */
        this.declaredClasses();
        if (!this._globals || this._globalsAt !== this.generation) {
            this._globals   = this.collectGlobals();
            this._globalsAt = this.generation;
        }
        const out = [];
        for (const name of this._globals)
            if (name !== word) out.push({ Text: name, Detail: "global" });
        return out;
    }

    /*
     * The parameters and locals where the cursor is, asked of the parser over
     * the text on screen -- before the globals, since they are what a person
     * inside a function reaches for first, and they were offered only as the
     * words provider's spellings: any word in the file, a comment's included,
     * with nothing to say which were in scope. Parsed again only when the text
     * moved.
     */
    inScope(word, line) {
        this._scopeNames = new Set();
        const editor = this.ide.Editor;
        if (!editor) return [];
        const text = editor.Text;
        if (!this._here || this._here.text !== text) {
            let syms = [];
            try { syms = Application.Symbols(text); } catch (e) { syms = []; }
            this._here = { text, syms };
        }
        const out = completionScopeNames(this._here.syms, line || editor.Line)
                        .filter((e) => e.Text !== word);
        for (const e of out) this._scopeNames.add(e.Text);
        return out;
    }

    collectGlobals() {
        const out = [];
        for (const name of Application.Globals()) if (!out.includes(name)) out.push(name);
        for (const name of Widget.Types())          if (!out.includes(name)) out.push(name);
        for (const name of this.classNames())      if (!out.includes(name)) out.push(name);
        for (const name of this.declaredClasses().tops)
            if (!out.includes(name)) out.push(name);
        return out.sort();
    }

    /* Every class the project declares and every class of every library it
     * `uses`, read out of the sources with the parser. */
    classNames() {
        return this.declaredClasses().names;
    }

    /*
     * Every class the project and its libraries declare, **with the source that
     * declared it**, and the `.form` texts beside them.
     *
     * The source is kept because a bare name is only half of what a person
     * types: `Confirm` is a *lexical* binding in a file the IDE never runs, so
     * the runtime cannot resolve it and `Widget.Members("Confirm")` refuses
     * without the text -- and the names in a `.js` are all the parser has to
     * give, through the same `Application.Symbols` the outline asks.
     *
     * **Two layers, because the disk is the slow half and not the true one.**
     * The files are walked once per project (`diskFiles`) and kept; over them
     * go the open tabs, read **live** every time -- the editor's text, or a
     * designer's tree serialised -- because what is typed and not saved is what
     * a person is completing against. Before this the answer was the disk's, so
     * a class written in a tab and not saved did not exist, and a method added
     * to a class in another tab was not offered until that tab was saved.
     *
     * Reading the tabs is cheap; parsing them is not, so each file's classes are
     * kept beside the text they were read from and parsed again only when that
     * text changed. `generation` moves whenever any file's text does, which is
     * what the member cache below keys on.
     */
    declaredClasses() {
        const disk = this.diskFiles();
        const live = new Map(disk.sources);
        const forms = new Map(disk.forms);
        const tabs = this.ide.tabs ? this.ide.tabs.openTabs : null;

        if (tabs) {
            for (const name of tabs.keys()) {
                let now = null;
                try { now = this.ide.tabs.contentOf(name); } catch (e) { now = null; }
                if (!now) continue;
                if (now.mode === "edit" && name.endsWith(".js") &&
                    typeof now.text === "string")
                    live.set(name, now.text);
                else if (now.mode === "design" && now.root)
                    forms.set(name, typeof now.root === "string"
                                    ? now.root : JSON.stringify(now.root));
            }
        }

        /* The classes of each file, re-read only where the text moved. */
        this._parsed = this._parsed || new Map();
        let changed = !this._declared;
        const names = [];
        const sources = new Map();
        const tops = [];

        for (const [path, text] of live) {
            let cached = this._parsed.get(path);
            if (!cached || cached.text !== text) {
                const classes = [];
                const tops = [];
                try {
                    const syms = Application.Symbols(text);
                    for (const sym of syms)
                        if (sym.Kind === "Class") classes.push(sym.Name);
                    /* What the file declares at its top level is a name every
                     * other file of the project can write: they are evaluated
                     * into one global scope. */
                    for (const e of completionScopeNames(syms, 0))
                        if (e.Detail === "top level" || e.Detail === "function")
                            tops.push(e.Text);
                } catch (e) { /* half a file is still a file */ }
                cached = { text, classes, tops };
                this._parsed.set(path, cached);
                changed = true;
            }
            for (const c of cached.classes)
                if (!sources.has(c)) { sources.set(c, text); names.push(c); }
            for (const t of cached.tops) if (!tops.includes(t)) tops.push(t);
        }

        const formList = [...forms.values()];
        if (!changed && this._declared &&
            this._declared.forms.length === formList.length &&
            this._declared.forms.every((f, i) => f === formList[i]))
            return this._declared;

        this.generation = (this.generation || 0) + 1;
        this._declared = { names, sources, forms: formList, tops };
        return this._declared;
    }

    /*
     * The disk's half, walked once per project: every `.js` and `.form` of the
     * project, and of the libraries it `uses`.
     *
     * **Only the libraries this project `uses`, and the walk is not written
     * here.** The first version asked `Application.Libraries()` -- every library
     * installed on the machine -- so a project that names one library was
     * offered every class of all seven. `Ide.Classes`' own `libraries` cache
     * already reads the manifest and resolves each name, and is invalidated when
     * the project changes, which is the lifetime this answer has too.
     *
     * Keyed by the name a tab uses -- the project-relative path -- so a tab
     * open on a file replaces exactly that file; a library's file is keyed by
     * its absolute path and is never a tab.
     */
    diskFiles() {
        if (this._disk) return this._disk;

        const sources = new Map();
        const forms   = new Map();
        const root    = this.ide.project;
        const rel     = (p) => root && p.startsWith(root + "/") ? p.slice(root.length + 1) : p;
        const walk    = (dir, into) => {
            for (const f of Directory.List(dir)) {
                if (f.startsWith(".")) continue;
                const p = File.Join(dir, f);
                if (File.IsDir(p)) walk(p, into);
                else if (f.endsWith(".js")) sources.set(rel(p), File.Load(p));
                else if (f.endsWith(".form")) forms.set(rel(p), File.Load(p));
            }
        };

        if (root) walk(root);
        for (const { dir } of this.ide.classes.libraries || []) walk(dir);

        this._disk = { sources, forms };
        return this._disk;
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
     * What the popup says after the name, and **the answer is the runtime's**.
     *
     * `Widget.Members` hands each member its `Signature`, from the first of
     * three places that has one: the comment beside its C entry (for a control,
     * a class static and a global's verb alike), a class's `static Signatures`,
     * or the parser -- over the member's own source for a function written in
     * JavaScript, and over a library's file for a class this process never ran.
     * So this module asks nothing else; a second question here would be a
     * second answer to disagree with the first.
     *
     * **A property says nothing and a method says its parameters.** What is
     * left with no signature is a native function registered in a shape the
     * extractor does not read, and it says **`(...)`**, not `()`: `()` claims
     * the member takes no arguments, which for a verb that takes one is a false
     * claim a test once asserted, and `(...)` is a gap that reads as one. No
     * name is made up from the count -- `Load(a1)` was tried, and reads as
     * though `a1` were the parameter.
     */
    detailOf(className, member) {
        const kind = member.Kind;
        if (kind !== "Method" && kind !== "Static") return "";

        const sig = (typeof member.Signature === "string" && member.Signature)
                    ? member.Signature : "(...)";
        return kind === "Static" ? "static " + sig : sig;
    }

    /*
     * The members of a class, and **one question asked once**.
     *
     * `Widget.Members` answers for everything this process can resolve -- a
     * widget, a class of `rad.js` like `Timer`, a global that is a bag of
     * functions like `File`. What it could not answer for was a class of a
     * library the IDE *reads* and never runs: `Confirm` is a lexical binding
     * with no class behind it in this process, so the list after the dot was
     * empty.
     *
     * **The fix is the `Sources` option, and it is in the runtime rather than
     * here for the reason everything else in this module is.** A second reader
     * in JavaScript means a second answer to "what does this class have", and
     * the two disagree at the edges: the first version here filtered nothing
     * and offered `Dial.turn`, which the runtime hides, so the same class had a
     * different surface depending on which reader found it. The runtime reads
     * the sources with the parser `Application.Symbols` already uses, follows
     * the `extends` chain, and hands the walk back to its own class table at
     * the first base the sources do not declare -- which is `Form`, and a
     * hundred names this module had no way to produce at all.
     *
     * `Widget.Methods` would be the wrong verb for the half it can answer: it
     * walks the prototype, so it holds instance methods and **no static**, and
     * every library verb of any consequence is a static.
     *
     * **The sources are the project's and the libraries it `uses`**, read once
     * by `declaredClasses` and kept, because a popover is built on every
     * keystroke and a walk of every library is not something to do there.
     */
    membersOfName(name) {
        const found = this.declaredClasses();
        if (!this._members || this._membersFor !== name ||
            this._membersAt !== this.generation) {
            this._membersFor = name;
            this._membersAt  = this.generation;
            this._members    = [];

            /* One text per *file*: `sources` maps each class to the file that
             * declared it, so a file of three classes would be parsed three
             * times on every name asked. */
            const list  = [...new Set(found.sources.values())];

            /* **A refusal is caught and answered as nothing, always.** The verb
             * refuses with a name because a caller that wants to know should be
             * told; a completion wants a list, and a name this project does not
             * declare is a name the popover has no business answering. The
             * first version re-threw when sources were present and one test
             * caught an uncaught error where a class from a library this project
             * does not use was asked about. */
            let got = null;
            try {
                got = Widget.Members(name, { Sources: list, Forms: found.forms });
            } catch (e) {
                if (!list.length) {
                    try { got = Widget.Members(name); } catch (e2) { got = null; }
                }
            }

            for (const m of got || []) {
                this._members.push({
                    Text: m.Name,
                    Detail: this.detailOf(name, m),
                    Doc: completionSummary(m.Doc),
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
