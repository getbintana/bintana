/*
 * `bintana.d.ts`: what this runtime has, written down where an editor can read
 * it.
 *
 * The IDE knows what a `Button` has because it asks one -- `PropertyNames()` on
 * a control the runtime built. Every other editor knows nothing, and worse than
 * nothing: TypeScript resolves `File` against the **DOM's** `File` and reports
 * `Property 'Exists' does not exist`, which reads as authoritative and is wrong.
 * This is the declaration that fixes that, and it is generated rather than
 * maintained: a property added in C is one line here and no lines anywhere else.
 *
 * **It is a form project and not a console one**, which was measured rather than
 * chosen: `Widget.New` refuses in a project with a `main` -- *"a project with a
 * `main` has no display, so it cannot make widgets"* -- and the whole method is
 * to ask a real control what it has. So it opens a window nobody sees, does its
 * work in `Form_Open` and quits, the way `tests/widgets` does.
 *
 * **Two sources, because one does not answer.** Measured, on a real Button:
 *
 *     PropertyNames()         40 names, its own and inherited -- exact
 *     EventNames()            14 -- exact
 *     Dictionary.Keys(button) []  -- a C method is not enumerable
 *     for (k in button)       9, and all nine are rad.js's own
 *     Dictionary.Keys(Locale) []  -- a table-built global is not either
 *
 * So the *shape* of every class comes from introspection, which is exact and
 * knows about inheritance, and the **names of the methods** come from the C
 * tables, read with the three patterns `tests/api` already reads them with.
 * Which of them a class has is settled by asking the sample --
 * `typeof control[name] === "function"` -- so nothing here has to know that a
 * `TreeView` has `ExpandNode` and a `Button` does not.
 *
 * `Widget` itself is not asked, because it is abstract: its surface is the
 * **intersection** of every class that can be built, which comes to 36
 * properties and is what every control really does share.
 *
 * Run it as `tests/typings.sh`, which is what regenerates the file and what
 * `tests/api.sh` then holds the file to.
 *
 * **And run `tsc` over what comes out**, by hand, when this file changes -- it
 * is the cheapest check there is and it found two duplicate identifiers nothing
 * else would have (`Record`, which is TypeScript's own generic, and `Marks`,
 * which is a property on one class and a method on another). TypeScript is not a
 * dependency of this repository and is not about to become one for a check that
 * runs when somebody edits a generator:
 *
 *     node <somewhere>/typescript/lib/tsc.js --noEmit --lib es2022 \
 *          tools/typings/bintana.d.ts
 */
"use strict";

/* The three shapes a member takes in C, read exactly as `tests/api` reads them
 * -- and for the same reason: the C is where they are declared, and anything
 * else is a second list to drift from it.
 *
 * The body is lazy to the `};` that ends a table and not `[^}]*`: a signature
 * comment declares an options object with braces in it -- `Search(text,
 * [{CaseSensitive, …}])` -- and a body that stopped at the first `}` would
 * silently lose every member of that table. */
const TABLE  = new Regex("static const JSCFunctionListEntry (\\w+)\\[\\]\\s*=\\s*\\{([\\s\\S]*?)\\n\\};");
const GETSET = new Regex("JS_CGETSET(?:_MAGIC)?_DEF\\(\\s*\"([A-Za-z_]\\w*)\"\\s*,\\s*([A-Za-z_]\\w*|NULL)\\s*,\\s*([A-Za-z_]\\w*|NULL)");
const CFUNC  = new Regex("JS_CFUNC(?:_MAGIC)?_DEF\\s*\\(\\s*\"([A-Za-z_]\\w*)\"\\s*,\\s*(\\d+)");

/*
 * The C tables that are **not** a widget's, and what each one is in the
 * language. `tests/api` keeps the same list against the heading each is
 * documented under; this one keeps it against the name a program writes, and
 * both exist for the reason that file gives: the same
 * `JS_SetPropertyStr(ctx, x, "Name", …)` shape builds the return value of half
 * the runtime, so a scan that guessed would declare a global for every one.
 */
const NOT_A_WIDGET = {
    dec_proto_funcs:    { name: "Decimal",     kind: "class" },
    bytes_proto_funcs:  { name: "Bytes",       kind: "class" },
    xml_doc_props:      { name: "XmlDocument", kind: "class" },
    xml_node_props:     { name: "XmlNode",     kind: "class" },
    day_props:          { name: "Day",         kind: "class" },
    conn_props:         { name: "Connection",  kind: "class" },
    http_client_props:  { name: "HttpClient",  kind: "class" },
    multipart_props:    { name: "Multipart",   kind: "class" },
    http_server_props:  { name: "HttpServer",  kind: "class" },
    http_request_props: { name: "HttpRequest", kind: "class" },
    audioplayer_props:  { name: "AudioPlayer", kind: "class" },
    task_props:        { name: "Task",        kind: "class" },
    lock_props:         { name: "Lock",        kind: "const" },
    menuitem_props:     { name: "MenuItem",    kind: "class" },
    action_props:       { name: "Action",      kind: "class" },
    locale_props:       { name: "Locale",      kind: "const" },
    log_props:          { name: "Logger",      kind: "const" },
    time_props:         { name: "Time",        kind: "const" },
    text_props:         { name: "Text",        kind: "const" },
    hash_props:         { name: "Hash",        kind: "const" },
    screen_props:       { name: "Screen",      kind: "const" },
    env_props:          { name: "Environment", kind: "const" },
    http_props:         { name: "Http",        kind: "const" },
    printer_props:      { name: "Printer",     kind: "const" },
    painter_props:      { name: "Painter",     kind: "class" },
};

/*
 * The globals built one `JS_SetPropertyStr` at a time rather than from a table.
 * Those *are* enumerable, so `Dictionary.Keys` answers for them and the C does
 * not have to be read -- which is why they are a list of names and not of
 * tables.
 */
const PLAIN_GLOBALS = {
    Application, Environment, File, Directory, Dialog, Message, Clipboard,
    Settings, Dictionary, Desktop, Xml,
};

/*
 * The globals that are a class one writes `new` in front of, and the ones whose
 * members no table and no key reports. `any` where nothing says better: a
 * declaration that is honest about what it does not know still stops
 * `File.Exists` being resolved against the web platform, which is the whole
 * reason this file exists.
 */
const EXTRA = `
/*
 * **Empty, and it used not to be.** The Timer class was declared here by hand,
 * because it lives in rad.js and nothing answered it: PropertyNames refuses a
 * class that is not a widget, and there was no other road. It went stale the way
 * a hand-written list does -- Timer.After was missing, so an editor reported that
 * it did not exist, on the verb the whole language story leans on for having
 * replaced setTimeout.
 *
 * The generator walks the libraries now, and Widget.Members answers for a class of
 * rad.js the same as for anything else, so this has nothing left to hold. It
 * stays as the place for a class that *still* cannot be reached -- two words is
 * cheaper than the next stale row.
 */
`;

class TypingsForm extends Form {

    Form_Open() {
        const root = Application.Arguments[0];
        if (!root || !File.IsDir(File.Join(root, "runtime/src"))) {
            print("typings: give me the repository root -- " +
                  "bintana tools/typings <root> [project...]");
            Application.Quit(2);
            return;
        }

        const members = this.readC(root);
        const own     = this.runtimeTypes(members);
        const libs    = this.libraryTypes(root, own);
        const runtime = own + libs;
        const path    = File.Join(root, "tools/typings/bintana.d.ts");

        File.Save(path, runtime);
        print(`typings: ${path}`);

        /* A class that could not be declared is **said out loud**, once per
         * run, with the reason. A declaration file is only useful while it is
         * complete: `tsc` reports what it does not have as *missing*, which
         * reads as authoritative and is worse than the `any` it replaces. So the
         * floor here is a class declared whole or not at all, and the one
         * library that is not gets named rather than quietly left out. */
        for (const line of this.skipped) print(`typings: skipped ${line}`);

        /* A project is the second half: a `.form` is a class whose controls are
         * typed fields, and nothing but the file says so. */
        for (const project of Application.Arguments.slice(1))
            this.project(root, project);

        Application.Quit(0);
    }

    /* --- what the C declares -------------------------------------------------- */

    /*
     * Every member of every table, by table. Only the names are wanted for a
     * widget -- which class has which is settled by asking a control -- but a
     * global has nothing to ask, so the kind is kept for those.
     */
    readC(root) {
        const out = {};

        for (const file of Directory.Files(File.Join(root, "runtime/src"), "*.c")) {
            const text = File.Load(file);

            for (const table of TABLE.Matches(text)) {
                const held = out[table.Group(1)] || (out[table.Group(1)] = []);
                const body = table.Group(2);

                for (const m of GETSET.Matches(body))
                    held.push({ name: m.Group(1), kind: "property",
                                readOnly: m.Group(3) === "NULL" });
                for (const m of CFUNC.Matches(body))
                    held.push({ name: m.Group(1), kind: "method" });
            }
        }
        return out;
    }

    /*
     * And every **read-only** property, which `PropertyNames()` does not report
     * and for a good reason: it answers *what can a property grid set*, and a
     * grid can set none of these.
     *
     * A declaration file has the opposite job. `tests/api.sh` found sixteen of
     * them missing the day it was pointed at this file -- `Children`, `Focused`,
     * `Line`, `Column`, `CanUndo`, `SelectedText`, `ScrollMaxX` -- every one of
     * them real, every one of them something an editor would have said does not
     * exist. So they come from the C, where the NULL setter is what says
     * read-only, and which class has which is settled by asking the class.
     */
    readOnlyProperties(members) {
        return this.candidates(members, (m) => m.kind === "property" && m.readOnly);
    }

    candidates(members, wanted) {
        const out = [];

        for (const table in members) {
            if (table in NOT_A_WIDGET) continue;
            /* `widget_notes` is what the runtime keeps *about* a widget and not
             * what a widget has -- `__declared`, `__children`, `__menus`,
             * `__actions`. Declaring them would be publishing them.
             * `tests/api` skips the same table, and says so. */
            if (table === "widget_notes") continue;
            for (const m of members[table])
                if (wanted(m) && !out.includes(m.name)) out.push(m.name);
        }
        return out.sort();
    }

    /* --- the shipped libraries, as TypeScript --------------------------------

     * **They were not declared at all until now, and `knownType` below used to
     * say so** -- *"a component out of a library does not: nothing here is going
     * to declare them"*. That was true, and it cost a project using `dialog`
     * the one thing this file exists for: an editor reporting `Property 'ask'
     * does not exist` about a call that runs.
     *
     * Every question here is **asked**, never parsed, and each one is asked of
     * the runtime's own introspection:
     *
     * - **Is it a widget class?** `Widget.PropertyNames(type)` refuses with
     *   *"'X' is not a widget class"*, and that refusal **is** the test. A
     *   `Component` or `Form` subclass resolves; a value class like `QrCode`
     *   and a static-only class like `Package` do not.
     * - **What does it have?** `PropertyNames`, `EventNames`,
     *   `PropertyOptions(type, name)` and `Member(type, name, kind)` -- the
     *   same four the runtime's own classes are declared from.
     * - **Which methods are statics?** `Widget.Methods(type)` walks the
     *   prototype, so it holds every **instance** method and no static, and the
     *   difference between the two sets is the answer. Nothing here reads a
     *   word of a `.js` to tell a static from a method.
     * - **What are their names?** `Application.Symbols` on the library's own
     *   source -- the parser, exact, and already the IDE's answer to this
     *   question. A method added in a `.js` is a line here and no lines
     *   anywhere else.
     *
     * **A lower-case name is the class talking to itself and is not declared.**
     * This repository's own convention -- a capital initial is public, a
     * lower-case one is not -- and the same one `Ide.Classes` applies to a
     * project's own components for the same reason: `Package` publishes `Write`
     * and does not publish `configOf`, and `Chart` publishes `Refresh` and does
     * not publish `plot`. Both are the convention being *used*, not a rule
     * written here; `Widget.Methods("Chart")` answers with 30 names of which
     * four are the class's business.
     *
     * **A class is declared whole or not at all.** `QrCode` is the one that
     * cannot be: it is not a widget, so nothing answers the properties it
     * carries, and a declaration that published `Encode` while omitting those
     * would report every *use* of the class as a missing property. A
     * declaration file is only useful while it is complete, so it is named on
     * the output and left out. The trigger that would bring it back is a class
     * query that answers for a non-widget -- the same shape of gap
     * `Widget.PropertyNames` itself was.
     *
     * **And no parameter list, because nothing can reach one.** `Widget` has no
     * static that resolves a name to a class (`Widget.Class`, `Widget.Resolve`,
     * `Widget.Lookup` are all `undefined`), and without the class there is no
     * way to read the `static Signatures` a library would declare its own
     * arity in -- the mechanism `completion-plan.md` describes and no shipped
     * library uses yet. So a method is declared with its name and no
     * parameters, which is the floor that plan measured for everything else
     * ("a constructor parameter is `any` for it too") and is a **truthful**
     * file where a guessed signature would not be. An editor still offers the
     * member and does not say it does not exist, which is the whole of what
     * was missing. The trigger to do better is a way to reach a class object. */

    libraryTypes(root, runtimeText) {
        this.root = root;
        this.skipped  = [];
        this.forms    = [];
        this.sources  = [];
        /* **Every name the runtime half already declared, read out of what it
         * wrote.** `Record` is the one that matters and it is a real trap: it is
         * a class in rad.js, so the prelude walk below would declare it a second
         * time -- and the runtime half declares it as a `const` on purpose,
         * because `declare class Record` writes a *type* of that name too and
         * TypeScript has one of its own. Declaring a name twice is the whole
         * error; reading the names off the text that already has them is exact
         * and needs no second list. */
        this.declared = [...(runtimeText.match(/^declare (?:class|const) (\w+)/gm) || [])]
                            .map((l) => l.replace(/^declare (?:class|const) /, ""));

        const out = [];
        out.push("");
        out.push("/* ------------------------------------------------------------------ *");
        out.push("/* The libraries that ship with the runtime, by the same introspection. */");
        out.push("/* A project reaches one through `uses` in its project.json.             */");
        out.push("/* Parameters are not declared: no way to reach a library class's own   */");
        out.push("/* signatures exists yet, and a name is worth more than a guess.        */");
        out.push("/* ------------------------------------------------------------------ */");

        /*
         * **The classes the curated language adds**, and they come from the
         * prelude's own text rather than from a list.
         *
         * The obvious source is `Application.Globals()`, and it is wrong: it
         * reports **164** names, `Map` and `Set` and `Date` and `BigInt` among
         * them, and declaring those puts a `Map` beside TypeScript's own -- four
         * `TS2300 Duplicate identifier` the first time it was run, which is the
         * failure mode `completion-plan.md` records finding in this file once
         * already. A class the runtime *installed* and a class the language
         * *declares* are different things, and the difference is exactly whether
         * a `.js` in `runtime/js` says `class`.
         *
         * So the parser is asked over those two files, which is the same road
         * the libraries below are asked over, and `Timer` -- the class that used
         * to be written by hand in a block above, missing its own `After` --
         * comes out of it. A class the prelude grows next is a line here and no
         * lines anywhere else.
         */
        for (const file of ["rad.js", "forms.js"]) {
            const path = File.Join(root, "runtime", "js", file);
            if (!File.Exists(path)) continue;
            const text = File.Load(path);
            this.sources.push(text);
            for (const sym of Application.Symbols(text)) {
                if (sym.Kind !== "Class") continue;
                if (this.declared.includes(sym.Name)) continue;
                this.declared.push(sym.Name);
                out.push(...this.libraryClass(sym.Name, "runtime/js", path));
            }
        }

        for (const dir of Directory.Folders(File.Join(root, "lib"))) {
            const lib = File.BaseName(dir);
            if (!Application.LibraryPath(lib)) {
                this.skipped.push(`lib/${lib}: not resolvable, so nothing in it is loaded`);
                continue;
            }

            /* **The library's `.form` files, once, for the same reason the IDE
             * reads them: a form's children are own properties of the instance,
             * so they are on no prototype chain and no class-table walk can see
             * them.** `Confirm.BtnAccept` exists -- the library's own code does
             * `dlg.BtnAccept.Text = ...` -- and without this it was declared
             * nowhere, which in an editor is *"Property does not exist"* on a
             * name that works. */
            for (const form of Directory.Files(dir, "*.form"))
                this.forms.push(File.Load(form));

            /* **The sources, handed to the verb as well as read here.** A class
             * this process *has loaded* is answered from the class table, which
             * knows the kinds and the C-declared signatures and not a parameter
             * name -- so `Confirm.Ask` was written as a count when its own source
             * said `Ask(message, onConfirm, options)` all along. Passing the text
             * costs nothing: the walk stops at the first base the sources do not
             * declare, which is `Form` or `Widget`, and those are answered by
             * the table exactly as before. */
            for (const file of Directory.Files(dir, "*.js")) {
                const text = File.Load(file);
                this.sources.push(text);
                for (const sym of Application.Symbols(text)) {
                    if (sym.Kind !== "Class") continue;
                    this.declared.push(sym.Name);
                    out.push(...this.libraryClass(sym.Name, lib, file));
                }
            }
        }
        return out.length > 7 ? out.join("\n") + "\n" : "";
    }

    /* One `declare class`, or nothing and a line on the output.
     *
     * **Everything here is one call.** `Widget.Members` returns the properties,
     * the instance methods and the statics, each already filtered to the public
     * ones, and the three older verbs refused a class that is not a widget --
     * which is why this used to skip four of the ten and to declare a tenth by
     * hand. The names no longer come from a second reading of the source: the
     * verb's own capital-initial rule is the convention this repository
     * documents, applied where it is written down.
     */
    libraryClass(name, lib, file) {
        /* A class of the prelude is a **global**, and one of a library is a
         * library class, and the reference has a page under each -- pointing a
         * reader at the wrong one is a small mistake that costs a search. */
        const page = lib === "runtime/js"
            ? `docs/reference/globals/${name}.md`
            : `docs/reference/libraries/${name}.md`;
        const doc = File.Exists(File.Join(this.root, page)) ? page
                                                           : `docs/reference/globals/${name}.md`;

        let all;
        try {
            all = Widget.Members(name, { Forms: this.forms });
        } catch (e) {
            this.skipped.push(`${name} (lib/${lib}): ${e.message} -- see ${doc}`);
            return [];
        }

        /* **A name TypeScript declares a *type* of cannot be a class here.**
         * `declare class Record` writes a type called `Record` into the same file
         * as `lib.es5.d.ts`'s own `Record<K, V>`, and both lose: "Duplicate
         * identifier", measured. A `const` with a construct signature declares
         * the *value* alone, so `new Plain()` is this one and
         * `Record<string, number>` stays TypeScript's.
         *
         * **The list is one name long and it was measured, not remembered** --
         * `tsc` over what this file produces, with everything else compiling:
         *
         *     npx --package typescript@5 tsc --noEmit --lib es2022 \
         *          --target es2022 tools/typings/bintana.d.ts
         *
         * That is also what finds the *next* one, which is the whole argument for
         * running it: a new class of the prelude lands beside whatever TypeScript
         * has grown since, and the list is what makes it visible. */
        const valueOnly = ["Record"];
        const declared  = valueOnly.includes(name) ? "const" : "class";

        const of = (kind) => all.filter((m) => m.Kind === kind).map((m) => m.Name);
        const props   = of("Property");
        const roProps = of("ReadOnly");
        const methods = of("Method");
        const statics = of("Static");

        /* **A type is asked of a control that can be built**, which a class that
         * is not a widget cannot produce -- so a non-widget's properties are
         * declared without a type rather than not at all. They are half the
         * answer: `QrCode`'s `Version` and `Size` are its whole public surface
         * beside `Encode`, and a declaration that published the method and
         * omitted them would report every *use* as a missing property. */
        const isWidget = (() => { try { Widget.PropertyNames(name); return true; }
                                  catch (e) { return false; } })();
        const sample   = isWidget ? this.sampleOf(name) : null;

        const out = [];
        out.push("");
        out.push(`/** ${lib}/${name}. Every member: ${doc} */`);
        if (declared === "const") {
            /* The value and not the shape: a construct signature, so `new` works
             * and the members are not published as a type this file would then
             * own. */
            out.push(`declare const ${name}: {`);
            out.push("    new (...values: any[]): any;");
            for (const m of statics.concat(methods))
                out.push(`    ${m}(...values: any[]): any;`);
            out.push("};");
            return out;
        }
        out.push(`declare class ${name}${isWidget ? ` extends ${this.baseOf(props)}` : ""} {`);

        for (const p of props) {
            if (p === "__declared") continue;
            const values = this.valuesOf(name, p);
            const fresh  = sample ? sample[p] : undefined;
            let doc2 = values ? `One of ${values}.` : "";
            if (fresh !== undefined && fresh !== "" && fresh !== null)
                doc2 += ` \`${fresh}\` by default.`;
            out.push(`    /** ${doc2} */`);
            out.push(`    ${p}: ${this.typeOf(sample, p)} | null;`);
        }
        for (const p of roProps) {
            if (p === "__declared") continue;
            out.push(`    /** Read-only. */`);
            out.push(`    readonly ${p}: ${isWidget ? this.typeOf(sample, p) : "any"};`);
        }

        /* **The declared arity, and the rest form only where there is none.**
         *
         * The rest form and not empty parentheses is the whole difference
         * between a declaration that is true and one that is wrong:
         * `Ask(): any` says the member takes no arguments, so every correct call
         * is `Expected 0 arguments, but got 3`. The same failure the file
         * exists to prevent, pointed the other way.
         *
         * **And the rest form is now the exception rather than the rule**,
         * and the reason is the shape of the answer rather than a decision: a
         * library gets its argument counts because the engine knows them, not
         * because somebody wrote them down. See `sigOf`. */
        for (const m of methods.concat(statics)) {
            const when = statics.includes(m) ? "static " : "";
            out.push(`    ${when}${this.methodLine(m, this.sigOf(name, m),
                                              when ? "any" : "void").trim()}`);
        }

        out.push("}");
        return out;
    }

    /*
     * `Widget` and `Component` are declared in this same file, so a library
     * class may name either. Which one it is **asked**: `Modal` and `Maximize`
     * are on a `Form` and not on a `Component`, and `Text` is on both, so
     * ownership of `Text` is not the test.
     */
    baseOf(properties) {
        return (properties.includes("Modal") && properties.includes("Maximized"))
             ? "Form" : "Component";
    }

    /* The convention, applied: a capital initial is public. */
    publicMethods(file, name) {
        const out = [];
        for (const sym of Application.Symbols(File.Load(file))) {
            if (sym.Kind !== "Method" || sym.Parent !== name) continue;
            const first = sym.Name[0];
            if (first !== first.toUpperCase() || first === first.toLowerCase()) continue;
            if (!out.includes(sym.Name)) out.push(sym.Name);
        }
        return out;
    }

    kindOf(name, p) {
        try { return Widget.Member(name, p, "property"); } catch (e) { return "Property"; }
    }

    valuesOf(name, p) {
        try {
            const o = Widget.PropertyOptions(name, p);
            if (Array.isArray(o) && o.length) return o.map((v) => `"${v}"`).join(" | ");
        } catch (e) { /* not an enum */ }
        return "";
    }

    /*
     * One control per class, built wearing nothing, which is what makes its
     * values the *defaults* rather than values somebody chose: the serialiser
     * compares against a freshly constructed one to decide a property was never
     * set, so this is the same number by construction and not a second opinion.
     *
     * **It is one control for the class and not one per property**, and the
     * reason is the `typeOf` below: that takes a *sample* and a name and reads
     * the property off it, which is how the runtime's own classes are declared
     * too. A first version of this called it with the value and a missing
     * second argument, and every library property came out `any` -- while the
     * runtime's were untouched, because a class body with two `typeOf` takes
     * the *last* one and the last is the one that wanted two arguments. That is
     * this repository's own `MainForm` trap, met in the generator.
     */
    sampleOf(name) {
        if (!this._samples) this._samples = {};
        if (name in this._samples) return this._samples[name];

        let c = null;
        try { c = Widget.New(name); } catch (e) { c = null; }
        this._samples[name] = c;
        return c;
    }

    /* --- the runtime, as TypeScript ------------------------------------------ */

    runtimeTypes(members) {
        const readOnly = this.readOnlyProperties(members);
        const out      = [];

        out.push("/*");
        out.push(" * Bintana's own surface, for an editor that is not the Bintana IDE.");
        out.push(" *");
        out.push(" * GENERATED by tools/typings -- regenerate with tests/typings.sh and do");
        out.push(" * not edit. tests/api.sh fails when this file and the runtime disagree.");
        out.push(" */");
        out.push("");

        /* The abstract ones: the runtime refuses to build them, so their surface
         * is what every class that can be built has in common. */
        const built = [];
        const shape = {};

        for (const type of Widget.Types()) {
            let control = null;
            try { control = Widget.New(type); } catch (e) { continue; }

            /*
             * Methods, settable properties and read-only ones are the
             * **class's** to answer, with no control built: `Widget.Methods`
             * is the prototype's own function-valued data properties, and
             * `Widget.Member` says which of the names that are not settable is
             * read-only and which is a method.
             *
             * The control is still made, because a property's *type* is the
             * value it holds and nothing declares it -- the one question a
             * class cannot answer.
             */
            const has      = Widget.Methods(type).sort();
            const settable = Widget.PropertyNames(type);
            const fixed    = readOnly.filter((name) =>
                Widget.Member(type, name) === "ReadOnly");

            built.push(type);
            shape[type] = {
                properties: settable,
                readOnly:   fixed,
                methods:    has,
                sample:     control,
            };
        }

        let base = null;
        for (const type of built) {
            base = base === null
                ? shape[type].properties.slice()
                : base.filter((p) => shape[type].properties.includes(p));
        }
        let baseMethods = null;
        for (const type of built) {
            baseMethods = baseMethods === null
                ? shape[type].methods.slice()
                : baseMethods.filter((m) => shape[type].methods.includes(m));
        }
        let baseFixed = null;
        for (const type of built) {
            baseFixed = baseFixed === null
                ? shape[type].readOnly.slice()
                : baseFixed.filter((m) => shape[type].readOnly.includes(m));
        }

        /* `Widget` is the one class nothing can build, so it is the one written
         * from a measurement rather than from an answer. */
        out.push("declare class Widget {");
        for (const name of base)
            out.push(`    ${name}: ${this.typeOf(shape[built[0]].sample, name)};`);
        for (const name of baseFixed)
            out.push(`    readonly ${name}: ${this.typeOf(shape[built[0]].sample, name)};`);
        for (const name of baseMethods)
            out.push(this.methodLine(name, Widget.Signature("Widget", name)));
        out.push("    static New(type: string): Widget;");
        out.push("    static Types(): string[];");
        out.push("    static Available(type: string): boolean;");
        out.push("    static TypeName(ctor: any): string;");
        out.push("    static PropertyNames(type: string): string[];");
        out.push("    static Methods(type: string): string[];");
        out.push("    static EventNames(type: string): string[];");
        out.push("    static TextProperties(type: string): string[];");
        out.push("    static PropertyOptions(type: string, name: string): string[] | null;");
        out.push("    static Member(type: string, name: string): string;");
        /* The verb that answers for a class which is not a widget, and takes a
         * global object too -- so this is the one an editor asks for `File.` and
         * for `Timer.`, where `Methods` answers neither. */
        out.push("    static Members(type: string): "
                 + "{ Name: string; Kind: string }[];");
        out.push("    static Signature(type: string, name: string): string | null;");
        out.push("    static EventSignature(type: string, name: string): string | null;");
        out.push("}");
        out.push("");

        /* Abstract and so unaskable; declared so a `.d.ts` that names one still
         * resolves. `Widget` is the one already written. */
        for (const type of Widget.Types()) {
            if (built.includes(type) || type === "Widget") continue;
            out.push(`declare class ${type} extends Widget { }`);
        }
        out.push("");

        for (const type of built) {
            out.push(`declare class ${type} extends Widget {`);
            for (const name of shape[type].properties) {
                if (base.includes(name)) continue;
                out.push(`    ${name}: ${this.typeOf(shape[type].sample, name)};`);
            }
            for (const name of shape[type].readOnly) {
                if (baseFixed.includes(name)) continue;
                out.push(`    readonly ${name}: ${this.typeOf(shape[type].sample, name)};`);
            }
            for (const name of shape[type].methods) {
                if (baseMethods.includes(name)) continue;
                out.push(this.methodLine(name, Widget.Signature(type, name)));
            }
            out.push("}");
        }
        out.push("");

        /*
         * Everything that is not a widget, from both halves and **merged by
         * name**: `Environment` is built from a table *and* by a run of
         * `JS_SetPropertyStr`, so declaring each half where it was found would
         * write the name twice and TypeScript would take neither.
         */
        const others = {};
        const put    = (name, kind, member, isMethod) => {
            const held = others[name] || (others[name] = { kind, members: {} });
            held.members[member] = isMethod;
        };

        for (const table in NOT_A_WIDGET) {
            const what = NOT_A_WIDGET[table];
            for (const m of members[table] || [])
                put(what.name, what.kind, m.name, m.kind === "method");
        }
        for (const name in PLAIN_GLOBALS) {
            const held = PLAIN_GLOBALS[name];
            for (const key of Dictionary.Keys(held))
                put(name, "const", key, typeof held[key] === "function");
        }

        for (const name of Dictionary.Keys(others).sort()) {
            const what = others[name];

            out.push(what.kind === "class"
                ? `declare class ${name} {`
                : `declare const ${name}: {`);
            for (const member of Dictionary.Keys(what.members).sort()) {
                out.push(what.members[member]
                    ? `    ${member}(...values: any[]): any;`
                    : `    ${member}: any;`);
            }
            out.push(what.kind === "class" ? "}" : "};");
            out.push("");
        }

        out.push(EXTRA.trim());
        out.push("");
        return out.join("\n");
    }

    /*
     * The signature to declare a member with, in three tiers.
     *
     * **A declared one wins**: `static Signatures` says the parameter names and
     * the optionality, and there is nothing better than an answer somebody wrote
     * about their own class. It is **decoration, not the way a count is
     * obtained** -- which is the correction to what this generator assumed for
     * every library it ever declared, and the reason nobody had to write fifty
     * of them down.
     *
     * **Then the count, discovered.** `Widget.Members` reads `Function.length` --
     * the number of parameters before the first default -- so
     * `QrCode.Encode(text, opts)` is two arguments and the declaration says two.
     * Measured over the six libraries: `Encode` 2, `Nsis.Script` 2,
     * `Nsis.Stage` 3, `Chart.Save` 3, `Markdown.Load` 1, `Widget.On` 2, and
     * `Widget.Width` -1 because it is a property and not a call.
     *
     * **And then the floor.** `-1` is nobody knowing -- a property, or a method
     * read out of a source rather than built -- and the rest form is what that
     * gets. `a: any, b: any` instead of `message: string, options?: object` is a
     * weaker declaration and not a wrong one: the count is real, and the names
     * are not there to be had because ECMAScript discards them at parse time.
     *
     * **Every call here is guarded, and `Widget.Signature` is the one that
     * throws**: it refuses a class that is not a widget, which is right -- it
     * asks about a method -- and `Timer`, `QrCode` and `Nsis` are not one. The
     * first version of this asked it bare and the generator stopped with
     * *'Timer' is not a widget class* before writing a line of the file.
     */
    sigOf(type, name) {
        const member = this.membersOf(type).find((m) => m.Name === name);

        /* **The member's own signature first**: the parser's spelling, with the
         * real parameter names, for a class declared in a file the generator
         * would otherwise have to refuse. */
        if (member && typeof member.Signature === "string" && member.Signature)
            return member.Signature;

        try {
            const declared = Widget.Signature(type, name);
            if (typeof declared === "string" && declared) return declared;
        } catch (e) { /* not a widget class: the count below is the answer */ }

        if (member && typeof member.Params === "number" && member.Params > 0)
            return member.Params;          /* a count, not a spelling */
        return null;
    }

    /* One `Widget.Members` answer per class, asked once. */
    membersOf(type) {
        this._members = this._members || {};
        if (!(type in this._members)) {
            try { this._members[type] = Widget.Members(type, { Forms: this.forms,
                                                           Sources: this.sources }); }
            catch (e) { this._members[type] = []; }
        }
        return this._members[type];
    }

    /*
     * A method, with the parameters the class declares for it.
     *
     * A signature is the documentation's own spelling -- `([container])`,
     * `(event, ...args)` -- so the two brackets that carry meaning become
     * TypeScript's: `[x]` is an optional argument and `...x` a rest one. Every
     * type is `any`, which the runtime has none to offer and this file already
     * says. A method that declares nothing falls back to the permissive
     * spelling rather than claiming it takes none.
     */
    /*
     * A method line. **The return type is an argument and not a constant**, which
     * it was not while this only ever wrote the runtime's half: an instance
     * method returns `void` here and a static returns `any`, because a caller
     * that writes `const n = chart.Refresh()` is wrong and a caller that writes
     * `const c = Confirm.Ask(...)` is not, and the two spellings are the
     * difference between a declaration that helps and one that annoys.
     */
    /*
     * A method line, and **three shapes** rather than two.
     *
     * A declared signature gives the names, and `tsArgs` writes the types.
     *
     * A **count** gives a rest tuple with a variadic tail:
     * `(...values: [any, any, ...any[]])`.  That is measured, not argued:
     *
     *     .M(1, 2)        ok
     *     .M(1, 2, 3, 4)  ok
     *     .M(1)           Expected at least 2 arguments, but got 1
     *     .M()            Expected at least 2 arguments, but got 0
     *
     * **The tail is the whole reason, and it is a fact about `Function.length`:
     * it counts the parameters before the first default**, so a method
     * `Make(a, b = 1)` reports 1 and its second parameter is perfectly legal.
     * A fixed tuple without the tail would reject the correct call, and an
     * *empty* tuple would be worse than useless -- `length` of 0 does not mean
     * "takes nothing", it means "nothing required", so `(...values: [])` turns
     * `O.M(1)` into an error. A count of zero therefore gets the plain rest,
     * which checks nothing rather than something wrong.
     *
     * **And no `a1: any, a2: any`.**  The first version of this wrote
     * placeholder names for a count, and fifty-nine of them were in the
     * shipped declaration file across thirteen classes -- a generated file full
     * of `a1: any` is one a reader learns to skip, which is the opposite of
     * what it is for. The names are not there to be had, so the count says
     * only what it knows.
     */
    methodLine(name, sig, returns) {
        const tail = returns || "any";
        if (sig === null)
            return `    ${name}(...values: any[]): ${tail};`;
        if (typeof sig === "number") {
            const required = [];
            for (let i = 0; i < sig; i++) required.push("any");
            required.push("...any[]");
            return `    ${name}(...values: [${required.join(", ")}]): ${tail};`;
        }
        return `    ${name}(${this.tsArgs(sig)}): ${tail};`;
    }

    tsArgs(sig) {
        if (sig === "()") return "";

        return this.splitArgs(sig.slice(1, -1)).map((part) => {
            let arg = part;
            let optional = false;

            if (arg.startsWith("[") && arg.endsWith("]")) {
                optional = true;
                arg = arg.slice(1, -1).trim();
            }

            if (arg.startsWith("..."))
                return `...${arg.slice(3)}: any[]`;

            /* `{CaseSensitive, WholeWord, Regex}` is the *shape* of an options
             * object and not a name, so it becomes one -- `options`, which is
             * what the summary lines already call it. */
            if (arg.startsWith("{")) {
                const members = this.splitArgs(arg.slice(1, -1))
                                    .map((m) => `${m}?: any`).join("; ");
                return `options${optional ? "?" : ""}: { ${members} }`;
            }
            return `${this.argName(arg)}${optional ? "?" : ""}: any`;
        }).join(", ");
    }

    /*
     * A parameter name that TypeScript will not accept.
     *
     * **A `.d.ts` is strict mode, and an identifier that is legal C is not
     * always legal there.** `Editor.Replace`'s signature comment said
     * `/* Replace(with) *\/` and that became a parameter called `with`, which is
     * a reserved word -- so the file had **six syntax errors** and `tsc`
     * answered nothing else at all, which is worse than looking wrong: a program
     * that does not check is not a program whose types were read. The word is
     * gone from the C now, because the runtime's own refusal already called it
     * `text` ("`Replace(text) needs the replacement text`") and three documents
     * disagreed with it.
     *
     * **The list is here anyway, because the next one is a comment somebody
     * writes.** Renaming in the output is free -- a parameter's name only shows
     * in a hover and in signature help -- and a trailing underscore is the
     * convention for a word that cannot be spelled.
     */
    argName(name) {
        /* **Exactly the words a strict-mode binding cannot carry, and no
         * others.** A first version of this list was written by feel and
         * included the contextual keywords -- `of` among them -- which renamed
         * `Widget.SetItem(of, count)` to `of_` and made a *correct* declaration
         * disagree with the runtime, which `api.sh` caught by name. `of` is
         * legal as a parameter and so are `as`, `from`, `get`, `set`, `any`,
         * `async`, `await` and `yield` in a non-generator position; the words
         * below are the ones ECMAScript reserves in strict mode, which a
         * `.d.ts` always is, plus `eval` and `arguments`.
         *
         * The shape of the mistake is the one this file keeps warning about: a
         * list written from memory rather than measured is a list that is wrong
         * in both directions, and the check that catches it is the one that
         * compares the output against the source. */
        const RESERVED = [
            /* strict-mode reserved */
            "implements", "interface", "let", "package", "private",
            "protected", "public", "static", "yield",
            /* and the always-reserved half */
            "await_", "break", "case", "catch", "class", "const", "continue",
            "debugger", "default", "delete", "do", "else", "enum", "export",
            "extends", "false", "finally", "for", "function", "if", "import",
            "in", "new", "null", "return", "super", "switch", "this", "throw",
            "true", "try", "typeof", "var", "void", "while", "with",
            /* and the two a binding may not be named */
            "eval", "arguments",
        ];
        return RESERVED.includes(name) ? `${name}_` : name;
    }

    /* A parameter list split at its **top-level** commas, so `[{A, B}]` is one
     * argument and not three. */
    splitArgs(text) {
        const out = [];
        let   depth = 0;
        let   cur   = "";

        for (const ch of text) {
            if (ch === "[" || ch === "{" || ch === "(") depth++;
            if (ch === "]" || ch === "}" || ch === ")") depth--;
            if (ch === "," && depth === 0) {
                out.push(cur.trim());
                cur = "";
                continue;
            }
            cur += ch;
        }
        if (cur.trim()) out.push(cur.trim());
        return out;
    }

    /*
     * What a property holds, asked of the control rather than declared.
     *
     * A getter may refuse -- `MenuItem.Value` throws for an item that is not a
     * check -- and a refusal is not a type, so it is `any` and says so by saying
     * nothing.
     */
    typeOf(sample, name) {
        let value;
        try { value = sample[name]; } catch (e) { return "any"; }

        if (Array.isArray(value)) return "any[]";

        const t = typeof value;
        if (t === "string" || t === "number" || t === "boolean") return t;

        /* **A control is a declared class and not `any`.** `Confirm.BtnAccept` is
         * a `Button`, and every widget class is declared in this same file, so
         * writing `any` for it makes `BtnAccept.Text` -- the one thing anybody
         * does with a dialog -- type-check against nothing. A value that is not
         * a control is still `any`: a class name the file does not declare would
         * be a *worse* answer than `any`, because `tsc` reports an unknown type
         * as an error and says nothing about the value. */
        try {
            /* **A static, and it takes a constructor** -- `Widget.TypeName` is
             * how the serialiser and the loader ask a node's own type
             * (`forms.js`: `Widget.TypeName(this.constructor)`), and reading it
             * off the instance answers `undefined`, which is what the first
             * version did and why every child came out `any`. */
            const control = Widget.TypeName(value.constructor);
            if (control) return control;
        } catch (e) { /* not a control */ }
        return "any";
    }

    /* --- one project ---------------------------------------------------------- */

    /*
     * A `.form` is a class whose controls are typed fields, which is exactly
     * what an editor cannot work out for itself: the `.js` beside it says
     * `this.BtnRun` and nothing in the file says what that is.
     *
     * **All three blocks the file names something in** -- `children`, `menus`
     * and `actions` -- because a menu item is bound on the form by name like any
     * control, and reading `children` alone is the hole three flatteners in the
     * IDE had. A nested control is a field of the form and not of its container,
     * for the same reason a handler is `Name_Event` on the form.
     */
    project(root, dir) {
        const where = File.Absolute(File.Join(root, dir));
        if (!File.IsDir(where)) {
            print(`typings: ${dir} is not a directory`);
            return;
        }

        const out = [];
        out.push("/*");
        out.push(` * The forms of ${File.Name(where)}, as classes with their controls.`);
        out.push(" *");
        out.push(" * GENERATED by tools/typings -- regenerate with tests/typings.sh.");
        out.push(" */");
        out.push("");

        /* Every class the project itself declares, so a control whose type is
         * one of its own components is typed as that and not as `any`. */
        const files = this.formsUnder(where);
        const mine  = [];
        for (const file of files) {
            try { mine.push(String(File.LoadJson(file).class || File.BaseName(file))); }
            catch (e) { /* half written */ }
        }

        let forms = 0;
        for (const file of files) {
            let spec;
            try { spec = File.LoadJson(file); } catch (e) { continue; }

            const name = String(spec.class || File.BaseName(file));

            /*
             * An `interface` and not a `declare class`, which is the whole of
             * why this works at all: the project's own `.js` already declares
             * `class MainForm extends Form`, so a second declaration is
             * "Duplicate identifier" and TypeScript keeps the one with no
             * controls on it -- measured, 19 forms and 922 errors. An interface
             * of the same name **merges** into the class instead, which is
             * exactly what the `.form` is: more members for a class that is
             * declared elsewhere.
             */
            out.push(`interface ${name} {`);
            for (const node of this.namesIn(spec))
                out.push(`    ${node.name}: ${this.knownType(node.type, mine)};`);
            out.push("}");
            out.push("");
            forms++;
        }

        const path = File.Join(where, "forms.d.ts");
        File.Save(path, out.join("\n"));
        print(`typings: ${path} (${forms} forms)`);

        this.tsconfig(root, where);
    }

    /*
     * `"lib": ["es2022"]`, and it is the knob that matters.
     *
     * Measured over one of the IDE's own modules: the default gives 9 errors of
     * which 2 are the DOM answering for `File`; `"lib": ["es2022"]` gives 9 and
     * none of them the DOM; `noLib: true` -- the obvious thing to reach for --
     * gives 8, **all** of them `Cannot find global type`, for `Array`, `Object`,
     * `String` and five more that this runtime has. `noLib` throws away the
     * language, not the web.
     */
    tsconfig(root, where) {
        const path = File.Join(where, "tsconfig.json");
        const to   = relativeTo(where, File.Join(root, "tools/typings/bintana.d.ts"));

        File.SaveJson(path, {
            compilerOptions: {
                target: "es2022",
                lib: ["es2022"],
                module: "none",
                /*
                 * Off, and measured rather than chosen: with it on, the IDE's
                 * own sources give **387 errors over 41 files**, and 359 of
                 * them are one thing -- a field assigned to a form from
                 * outside its class body, which is ordinary JavaScript and
                 * what every dialog here does (`dlg.onAccept = …`). What is
                 * left with it off is completion, go to definition and hover,
                 * which is the whole of what this file was generated for.
                 * Turning it on is one word, and worth it for a new project
                 * that declares its fields.
                 */
                checkJs: false,
                allowJs: true,
                noEmit: true,
                strict: false,
            },
            include: ["**/*.js", "forms.d.ts", to],
        });
        print(`typings: ${path}`);
    }

    formsUnder(where) {
        const out = [];
        const walk = (folder) => {
            for (const file of Directory.Files(folder, "*.form")) out.push(file);
            for (const sub of Directory.Folders(folder)) walk(sub);
        };
        walk(where);
        return out.sort();
    }

    /*
     * The type to write for a control, or `any`.
     *
     * A widget is one of the runtime's, and a component of the project is a
     * class its own `.js` declares -- both resolve. A component out of a
     * **library** does not: its sources are not in this project and nothing here
     * is going to declare them, so it is `any` and says so. A type written as
     * `any` still lets the field exist, which is the half that matters: the
     * mistake this catches is `this.Btn.Txt`, and for that the field has to be
     * there at all.
     */
    knownType(type, mine) {
        if (!type) return "Widget";
        if (type === "MenuItem" || type === "Action") return type;
        if (Widget.Types().includes(type)) return type;
        if (mine.includes(type) && !type.includes(".")) return type;
        return "any";
    }

    /* The same three blocks `Ide.Names.tableOf` walks, and for the same reason:
     * every one of them binds what it names on the form. */
    namesIn(root) {
        const out  = [];
        const walk = (nodes, type) => {
            for (const node of nodes || []) {
                if (node.name) out.push({ name: node.name, type: type || node.type });
                walk(node.children, type);
            }
        };
        walk(root && root.children, "");
        walk(root && root.menus, "MenuItem");
        walk(root && root.actions, "Action");
        return out;
    }
}

/*
 * One path against another, which the runtime does not answer and this needs
 * once: a `tsconfig.json` names the declaration file, and naming it absolutely
 * would make the file mean this machine.
 */
function relativeTo(from, to) {
    const here  = File.Absolute(from).split("/");
    const there = File.Absolute(to).split("/");

    let same = 0;
    while (same < here.length && same < there.length && here[same] === there[same])
        same++;

    const up = [];
    for (let i = same; i < here.length; i++) up.push("..");
    return up.concat(there.slice(same)).join("/");
}
