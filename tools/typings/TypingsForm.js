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
 * else is a second list to drift from it. */
const TABLE  = new Regex("static const JSCFunctionListEntry (\\w+)\\[\\]\\s*=\\s*\\{([^}]*)\\n\\};");
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
    Settings, Dictionary, Desktop,
};

/*
 * The globals that are a class one writes `new` in front of, and the ones whose
 * members no table and no key reports. `any` where nothing says better: a
 * declaration that is honest about what it does not know still stops
 * `File.Exists` being resolved against the web platform, which is the whole
 * reason this file exists.
 */
const EXTRA = `
declare class Timer {
    constructor(milliseconds?: number, repeat?: boolean);
    Interval: number;
    Repeat: boolean;
    Enabled: boolean;
    Tick: any;
    Start(): void;
    Stop(): void;
}

declare class Stopwatch {
    constructor();
    Elapsed: number;
    Start(): void;
    Stop(): void;
    Reset(): void;
}

declare class Regex {
    constructor(pattern: string, options?: { IgnoreCase?: boolean; Multiline?: boolean; DotAll?: boolean });
    static Escape(text: string): string;
    IsMatch(text: string): boolean;
    Match(text: string): any;
    Matches(text: string): any[];
    Replace(text: string, by: string): string;
    Split(text: string): string[];
}

/*
 * A value and not a class, which is the one declaration here that is shaped by
 * TypeScript rather than by Bintana: \`Record<K, V>\` is a type alias in
 * \`lib.es5.d.ts\`, so \`declare class Record\` writes a *type* of that name too
 * and both files lose -- "Duplicate identifier 'Record'", measured. A const
 * with a construct signature declares the value alone, so \`new Record()\` is
 * this one and \`Record<string, number>\` stays TypeScript's.
 */
declare const Record: {
    new (fields?: any): any;
    prototype: any;
};

declare const Field: any;
declare const Database: any;
declare const Exec: any;
declare const Table: any;
declare const BTA_VERSION: string;

declare function Namespace(path: string): any;
declare function print(...values: any[]): void;
declare function monotonic(): number;
declare function setTimeout(fn: () => void, ms?: number): number;
declare function clearTimeout(id: number): void;
declare function setInterval(fn: () => void, ms?: number): number;
declare function clearInterval(id: number): void;
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
        const runtime = this.runtimeTypes(members);
        const path    = File.Join(root, "tools/typings/bintana.d.ts");

        File.Save(path, runtime);
        print(`typings: ${path}`);

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

    /* Every method name any widget class has, which is the candidate list a
     * control is then asked about. */
    widgetMethods(members) {
        return this.candidates(members, (m) => m.kind === "method");
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
     * read-only, and which class has which is settled by asking the control.
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

    /* --- the runtime, as TypeScript ------------------------------------------ */

    runtimeTypes(members) {
        const methods  = this.widgetMethods(members);
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
             * `for...in` as well as the C, because **rad.js's own methods are
             * not in a C table**: `PropertyNames`, `Serialize`, `Apply`,
             * `Declared`, `Fill` and four more are plain assignments onto
             * `Widget.prototype`, which makes them enumerable -- the one thing
             * a C method is not. Nine of them, and leaving them out is how a
             * declaration comes to say `Property 'PropertyNames' does not exist
             * on type 'Form'`.
             */
            const has = methods.filter((m) => typeof control[m] === "function");
            for (const key in control)
                if (typeof control[key] === "function" && !has.includes(key))
                    has.push(key);

            /*
             * `in` and not `PropertyNames()`: a read-only property is on the
             * prototype like any other, and is exactly what that method leaves
             * out.
             *
             * **And the two lists overlap**, because the candidate names come
             * from every widget table at once: `Text` is read-only on a
             * `TreeView` and settable on a `Label`, so a Label asked about it
             * says yes twice and the declaration came out with `Text` and
             * `readonly Text` on the same class -- which TypeScript reads as a
             * duplicate identifier. What the *class* can set wins.
             *
             * **And a name can be a property of one class and a method of
             * another**: `Marks` is a read-only property on a `Calendar` and a
             * method on a `SourceEditor`, so the editor came out with both. What
             * the control really holds settles it.
             */
            const settable = control.PropertyNames();
            const fixed    = readOnly.filter((name) => name in control &&
                                                       !settable.includes(name) &&
                                                       !this.isMethod(control, name));

            built.push(type);
            shape[type] = {
                properties: settable,
                readOnly:   fixed,
                methods:    has.sort(),
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
        for (const name of baseMethods) out.push(`    ${name}(...values: any[]): any;`);
        out.push("    static New(type: string): Widget;");
        out.push("    static Types(): string[];");
        out.push("    static Available(type: string): boolean;");
        out.push("    static TypeName(ctor: any): string;");
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
                out.push(`    ${name}(...values: any[]): any;`);
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
     * What a property holds, asked of the control rather than declared.
     *
     * A getter may refuse -- `MenuItem.Value` throws for an item that is not a
     * check -- and a refusal is not a type, so it is `any` and says so by saying
     * nothing.
     */
    /* Whether this control answers that name with a function, which is what
     * tells a method from a read-only property when both spellings exist in the
     * C. A getter that refuses is not a function and says so by throwing. */
    isMethod(sample, name) {
        try { return typeof sample[name] === "function"; } catch (e) { return false; }
    }

    typeOf(sample, name) {
        let value;
        try { value = sample[name]; } catch (e) { return "any"; }

        if (Array.isArray(value)) return "any[]";

        const t = typeof value;
        if (t === "string" || t === "number" || t === "boolean") return t;
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
