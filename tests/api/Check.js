/*
 * Does docs/llm/controls.md document the whole surface?
 *
 * The reference is meant to be complete: an application author -- a person or a
 * language model -- should never have to open the project tree to find out
 * whether a property exists. A claim like that is worth nothing unless something
 * fails when it stops being true, which is this.
 *
 * A console project (`"main"`, no display), because it reads C and Markdown off
 * the disk and asking GTK would tell it nothing. It parses rather than links, so
 * it works when the runtime does not build -- the same bargain `tests/icons` and
 * `tests/styles` make.
 *
 * **The globals are held to the same rule**, against `docs/llm/library.md`, and
 * they were not until this was written: their tables were exempted from
 * `controls.md` and *nothing* asked anything else, so forty-six members of
 * `Locale`, `Decimal`, `Connection`, `Log`, `Day` and `MenuItem` were documented
 * by hand or not at all. A whole global family (`Database`/`Connection`/`Table`)
 * was added while that was true and nothing would have failed had its reference
 * been wrong. It found three real gaps the day it was written --
 * `Application.LibraryPath`, which the IDE uses, and `Decimal`'s `toString` and
 * `toJSON`, which are why `${d}` and `JSON.stringify(d)` are exact.
 *
 * **The libraries that ship with the runtime are held to the same rule**, against
 * `docs/llm/<library>.md`. A library in `lib/` is not an example: a project says
 * `uses: ["charts"]` and gets its classes, which makes what they publish part of
 * the contract exactly as a control's properties are. The surface is read out of
 * the Bintana rather than out of C -- accessors with a capital initial, the
 * `static Events` declaration, and the arity of each `Emit` -- and the check is
 * the one that matters here: a property that exists and has no row.
 *
 * **And the whole surface is also `api.json`**, the manifest the documentation
 * repositories read. It is built by `tools/apijson/Catalog.js` -- sourced here,
 * so the file and the check cannot drift -- and held to the same tables, events
 * and types, because a repository that has only the file cannot ask it about
 * anything.
 */
"use strict";

/* JS_CGETSET_DEF("Name", getter, setter) and its _MAGIC_ variant. A NULL setter
 * is a read-only property, which the loader can never assign. */
const GETSET = new Regex(
    "JS_CGETSET(?:_MAGIC)?_DEF\\(\\s*\"([A-Za-z_]\\w*)\"\\s*,\\s*([A-Za-z_]\\w*|NULL)\\s*,\\s*([A-Za-z_]\\w*|NULL)");
/* JS_CFUNC_DEF("Name", nargs, fn) -- a method, with the arity C declares. */
const CFUNC  = new Regex("JS_CFUNC(?:_MAGIC)?_DEF\\s*\\(\\s*\"([A-Za-z_]\\w*)\"\\s*,\\s*(\\d+)");
/* The tables themselves, so a name outside one is not mistaken for a member.
 * The body is lazy to the `};` that ends a table and not `[^}]*`: a signature
 * comment declares an options object with braces in it -- `Search(text,
 * [{CaseSensitive, …}])` -- and a body that stopped at the first `}` would
 * silently lose every member of that table, which is a check that stops
 * checking without failing. */
const TABLE  = new Regex("static const JSCFunctionListEntry (\\w+)\\[\\]\\s*=\\s*\\{([\\s\\S]*?)\\n\\};");
/* bta_emit(w, "Change", 0, NULL) -- an event and how many arguments it carries.
 * `_ok` too: an exporter emits `Draw` through the variant that answers whether
 * the handler threw, and an event that stopped being scanned is an event whose
 * arity stops being checked -- silently, which is how three documents came to
 * say `MouseWheel(dx, dy, ctrl, shift)`.
 *
 * **The list of spellings is the load-bearing part**, and it has already been
 * short by one: `bta_emit_answer` arrived with `Paginate` and this pattern did
 * not know the name, so the event was raised by the runtime, handled by two
 * libraries, and counted by nothing. A suffix that is not here is a whole event
 * that is not checked. `\w*` rather than the three known suffixes now, so the
 * next one is scanned the day it is written. */
const EMIT   = new Regex("bta_emit\\w*\\s*\\(\\s*[^;\"]*\"([A-Z][A-Za-z]*)\"\\s*,\\s*(\\d+)");

/*
 * The one table that is not surface at all.
 *
 * `widget_notes` is what the runtime keeps *about* a widget -- `__declared`,
 * `__children`, `__menus`, `__actions` -- accessors on the root prototype so
 * that the values can live on the struct and not as own properties of the
 * control (`docs/plans/strict-plan.md`). Nothing outside the runtime may touch
 * them, so demanding a documented row for each would be demanding that they be
 * published, which is the opposite of what they are. Written down here rather
 * than hidden from the scan, so the exception is one line and visible.
 */
const NOT_PUBLISHED = ["widget_notes"];

/* Events built through a helper rather than a literal emit, and the arity the
 * helper passes. `emit_mouse` hands five to each of them. */
const HELPER_EVENTS = { MouseDown: 5, MouseUp: 5, MouseMove: 5, DblClick: 5 };

/*
 * Every library in `lib/`, against its page. A library with no page at all is a
 * failure of its own: it ships with the runtime, so somebody will use it.
 */
/* ------------------------------------------------------- one global scope
 *
 * **Two libraries may not declare the same top-level name.**
 *
 * A project's libraries are evaluated into the one global scope the project
 * itself runs in, so a `const` at the top of `lib/report/Report.js` and a
 * `const` of that name at the top of `lib/markdown/Markdown.js` are a
 * redeclaration -- and it is not a warning. A project that named both did not
 * start: `SyntaxError: redeclaration of 'PAPERS'`, on line 1 of a file its
 * author never wrote, with no way to tell from the message which two libraries
 * were arguing.
 *
 * **Nothing could have caught it**, which is why this is here rather than a
 * note: no project in this tree names two libraries, so the suite proved every
 * library works and never that any two work together. `PAPERS` was the same
 * three paper sizes written out twice; it is `Printer.Papers` now, and neither
 * library declares one.
 *
 * Only the top level counts -- what is inside a class or a function is that
 * scope's and collides with nothing.
 */
const TOP_LEVEL = new Regex("^(?:const|let|var|function|class)\\s+([A-Za-z_$][\\w$]*)",
                            { Multiline: true });

function checkLibraryScopes(root, problems) {
    const owners = {};        /* name -> the libraries that declare it */
    let   names  = 0;

    for (const dir of Directory.Folders(File.Join(root, "lib"))) {
        const lib  = File.Name(dir);
        const mine = new Set();

        for (const src of Directory.Files(dir, "*.js"))
            for (const m of TOP_LEVEL.Matches(File.Load(src)))
                mine.add(m.Group(1));

        for (const n of mine) {
            if (!owners[n]) owners[n] = [];
            owners[n].push(lib);
            names++;
        }
    }

    let clashes = 0;
    for (const n in owners) {
        if (owners[n].length > 1) {
            clashes++;
            problems.push(`${owners[n].join(" and ")} both declare a top-level ` +
                          `\`${n}\` -- a project naming both will not start`);
        }
    }
    return { names, clashes };
}

/*
 * The C this reads.
 *
 * **A name starting with a dot is not a source.** An editor open on a file
 * leaves a lock beside it -- Emacs writes `.#bta_sys.c`, a dangling symlink --
 * and `*.c` matches it, so the check died reading a file that was never there,
 * in the middle of somebody's editing session. It is the same class of thing as
 * a backup file, and none of them is what this is reading.
 */
function sources(root) {
    return Directory.Files(File.Join(root, "runtime/src"), "*.c")
                    .filter((path) => !File.Name(path).startsWith("."));
}

/* Every source the repositories' libraries are written in. The pages that
 * document them live in `bintana-docs` now and are checked there against
 * `api.json`; what is still here is their descriptions, which are JavaScript
 * and have nobody to be checked against but `checkDocs`. */
function librarySources(root) {
    const out = [];

    for (const lib of Directory.Folders(File.Join(root, "lib")))
        for (const f of Directory.Files(lib, "*.js").sort())
            out.push(File.Load(f));
    return out;
}

/* The names the C puts on the global object -- `JS_SetPropertyStr(ctx,
 * global, "X", ...)`.  A global built entirely in JavaScript (rad.js's
 * `Timer`, `Settings`) is not one of these and is answered by the class table,
 * so this is the set whose members are registered outside a class and are
 * asked about on their own. */
const GLOBAL_INSTALL = new Regex(
    "JS_SetPropertyStr\\(\\s*ctx,\\s*global,\\s*\"([A-Za-z_]\\w*)\"");

/*
 * ------------------------------------------------- every global, named once
 *
 * **The check above this one asks whether what is *declared* is documented. It
 * cannot ask whether what is *installed* is declared**, and that is a different
 * question with a worse failure: a global nobody listed is invisible to every
 * list here, so nothing fails, and its documentation is free to be absent or to
 * rot. Six were in that state when this was written -- `BTA_VERSION`, `Field`,
 * `Multipart`, `Namespace`, `Painter` and `Record` are installed and were not
 * named anywhere in this file.
 *
 * **The runtime answers it now.** `Application.Globals()` is what is installed
 * -- read off the global object rather than parsed out of the C and the
 * prelude, so a name added in either place is in it by construction -- and
 * `Widget.Members` says whether anything public hangs off it. What is left for
 * the manifest is the half that matters: every one of them must be in
 * `api.json`, because that is the only description the documentation
 * repositories can see. A name with **no** members is not part of the surface:
 * the language's builtins, the prelude's helpers and the scalars are names an
 * application cannot call, and deciding that by asking is what keeps this from
 * being a list the next intrinsic is missing from.
 */
function checkGlobalsListed(problems, catalog) {
    const listed  = new Set(catalog.Globals.map((g) => g.Name));
    const widgets = new Set(Widget.Types());
    const globals = new Set(Application.Globals());
    let   counted = 0;

    for (const name of Application.Globals()) {
        if (widgets.has(name) || LANGUAGE_GLOBALS.has(name))
            continue;
        let members = [];
        try { members = Widget.Members(name); } catch (e) { continue; }
        if (!members.length)
            continue;
        counted++;
        if (!listed.has(name))
            problems.push(`global ${name} has public members and is not in ` +
                          `api.json -- run tools/apijson.sh`);
    }
    for (const g of catalog.Globals)
        if (!globals.has(g.Name) && g.Name.indexOf(".") < 0)
            problems.push(`api.json names the global ${g.Name}, which the ` +
                          `runtime does not install`);
    return counted;
}

/* The first place two JSON values disagree, as a path: `api.json.Widgets[3].Members[7].Doc`. */
function firstDifference(a, b, path) {
    if (a === b)
        return path;
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length)
            return `${path}: ${a.length} entries against ${b.length}`;
        for (let i = 0; i < a.length; i++) {
            if (JSON.stringify(a[i]) === JSON.stringify(b[i]))
                continue;
            return firstDifference(a[i], b[i], `${path}[${i}]`);
        }
        return path;
    }
    if (a && b && typeof a === "object" && typeof b === "object") {
        const keys = [...new Set([...Dictionary.Keys(a), ...Dictionary.Keys(b)])].sort();

        for (const key of keys)
            if (JSON.stringify(a[key]) !== JSON.stringify(b[key]))
                return firstDifference(a[key], b[key], `${path}.${key}`);
        return path;
    }
    return `${path}: ${JSON.stringify(a)} against ${JSON.stringify(b)}`;
}

/*
 * **`api.json` against the runtime that answers and the C that declares.** The
 * file is the contract every documentation repository reads, so the two
 * questions that cannot be asked from there are asked here: that it is what
 * `Catalog.js` would write -- the same builder `tools/apijson.sh` uses, sourced
 * by this project too -- and that the answer agrees with the C. A repository
 * that only has the file can check a page against it; it cannot check the file
 * against the code, which is why the second half is not going anywhere.
 */
function checkApiJson(root, problems, members, events) {
    const path = File.Join(root, "api.json");
    const none = { catalog: { Widgets: [], Globals: [], Types: [], Libraries: [] },
                   checked: 0, ok: false };

    if (!File.Exists(path)) {
        problems.push("api.json is missing -- run tools/apijson.sh");
        return none;
    }
    let onDisk = null;
    try { onDisk = File.LoadJson(path); }
    catch (e) {
        problems.push(`api.json: ${e.message}`);
        return none;
    }
    /* The file's own `Commit` is kept, so a checkout generated at a tag checks
     * green: the documentation repositories pin a ref and not a hash. */
    const catalog = apiCatalog(root, onDisk.Commit || "");

    if (JSON.stringify(onDisk) !== JSON.stringify(catalog)) {
        /* **Which piece differs, and not only that one does.** A CI log that
         * says *api.json is stale* sends the reader to regenerate a file that
         * may be right except for one list; naming the path makes the answer
         * the log. */
        problems.push("api.json is not what the runtime says -- " +
                      firstDifference(onDisk, catalog, "api.json") +
                      " -- run tools/apijson.sh");
    }

    /* **Every native member a registration table declares is in its class's
     * own list**, which is the one thing a page is written around and the one
     * thing the file could get quietly wrong. */
    const own = {};
    for (const w of catalog.Widgets) {
        own[w.Name] = {};
        for (const m of w.Members)
            own[w.Name][m.Name] = m.Kind;
    }
    const KIND = { "method": "Method", "property": "Property",
                   "read-only property": "ReadOnly" };
    const owner = tableClasses(root);
    let   checked = 0;

    for (const m of members) {
        const cls = owner[m.table];
        if (!cls || !own[cls])
            continue;
        checked++;
        if (own[cls][m.name] !== KIND[m.kind])
            problems.push(`api.json: ${cls}.${m.name} is a ${m.kind} in the C ` +
                          `and ${own[cls][m.name] || "nothing"} there`);
    }

    /* Every event the runtime raises is somewhere in it, and the names the C
     * gives a type or a nested global are in it too. */
    const raised = new Set();
    for (const w of catalog.Widgets)
        for (const e of w.Events) raised.add(e.Name);
    for (const l of catalog.Libraries)
        for (const c of l.Classes)
            for (const e of c.Events) raised.add(e.Name);
    for (const name in events)
        if (!raised.has(name))
            problems.push(`api.json: event ${name} is raised and nowhere in it`);

    const named = new Set();
    for (const c of sources(root))
        for (const m of NAMED_TYPE.Matches(File.Load(c))) named.add(m.Group(1));
    const types = new Set(catalog.Types.map((t) => t.Name));
    for (const n of named)
        if (!types.has(n))
            problems.push(`api.json: the type ${n} is declared and not in it`);

    /* **And whatever reached the manifest says what it is for**, whichever
     * road it came by. The checks above ask the owners they know how to find;
     * this asks the file every documentation page is written from, so an
     * owner none of them finds still cannot arrive in it blank. It is the
     * check that would have caught `Desktop.Entries`, `MenuItem`, `Action`
     * and `AudioPlayer`, thirty-seven members with no description at all, and
     * `Date.UTC`, which is the language's and not this runtime's. */
    for (const section of ["Widgets", "Globals", "Types"])
        for (const owner of catalog[section])
            for (const m of owner.Members || [])
                if (!String(m.Doc || "").trim())
                    problems.push(`api.json: ${owner.Name}.${m.Name} says nothing about what it is for`);
    for (const g of catalog.Globals)
        if (LANGUAGE_GLOBALS.has(g.Name))
            problems.push(`api.json: ${g.Name} is the language's, not this runtime's surface`);

    const namedGlobals = new Set(catalog.Globals.map((g) => g.Name));
    for (const v of NESTED_OWNERS)
        if (!namedGlobals.has(v))
            problems.push(`api.json: the nested global ${v} is not in it`);

    /* And the two objects a table describes and nothing owns -- a menu item
     * and a command, which the manifest carries so `forms.md`'s prose can be
     * held to the code. Their tables are named with a `type` line now, so the
     * manifest has them by the road every named type takes; this still holds
     * the C's entries to it, one by one. */
    const forms   = { menuitem_props: "MenuItem", action_props: "Action" };
    const ofType  = {};
    for (const t of catalog.Types)
        ofType[t.Name] = new Set(t.Members.map((m) => m.Name));

    for (const c of sources(root)) {
        const src = File.Load(c);

        for (const t of TABLE.Matches(src)) {
            const type = forms[t.Group(1)];
            if (!type)
                continue;
            checked++;
            for (const g of GETSET.Matches(t.Group(2)))
                if (!ofType[type] || !ofType[type].has(g.Group(1)))
                    problems.push(`api.json: ${type}.${g.Group(1)} is in the C ` +
                                  `and not in it`);
            for (const f of CFUNC.Matches(t.Group(2)))
                if (!ofType[type] || !ofType[type].has(f.Group(1)))
                    problems.push(`api.json: ${type}.${f.Group(1)} is in the C ` +
                                  `and not in it`);
        }
    }

    return { catalog: catalog, checked: checked, ok: true };
}

/*
 * ------------------------------------------------------------ the reference
 *
 * `docs/reference/widgets/<Class>.md` is the long form of one class: the same members as
 * `llm/controls.md`, each with a real explanation, for the person writing an
 * application rather than for a model writing a file. **The two references hold
 * the same rows and differ only in how much each cell says**, so the check is
 * the same check: a member that exists and has no row.
 *
 * Which members belong to which class is read out of the **class registration**
 * and not from a list kept here: `BTA_CLASS_ENUM_TEXT("TableView", "Control",
 * build_table, table_props, ...)` names the class and its table of members in
 * one line, which is the only place those two facts are already together. A
 * variant with no table (`BTA_CLASS_BARE`) names a boolean in that position and
 * simply matches nothing.
 *
 * The globals get the same treatment under `docs/reference/globals/`, by the
 * same rule and with a check of their own, when the first of them is written.
 *
 * **A class with no page is counted and not failed.** The pages are being
 * written one at a time, and a check that failed on the ones not written yet
 * would be a red suite for as long as that takes -- which is how a rule gets
 * turned off. What it must never allow is a page that is *there* and incomplete.
 */
const CLASS_NAME = new Regex("BTA_CLASS(?:_\\w+)?\\s*\\(\\s*\"(\\w+)\"");
const CLASS_REG = new Regex(
    "BTA_CLASS(?:_\\w+)?\\s*\\(\\s*\"(\\w+)\"\\s*,\\s*(?:\"\\w+\"|NULL)\\s*,\\s*\\w+\\s*,\\s*(\\w+)");
const CLASS_PARENT = new Regex(
    "BTA_CLASS(?:_\\w+)?\\s*\\(\\s*\"(\\w+)\"\\s*,\\s*(?:\"(\\w+)\"|NULL)");

/*
 * table -> class, off the registrations: the only place those two facts are
 * already together.
 *
 * **One class does not name its table in the registration**: `Widget`'s members
 * are handed over by `bta_widget_base_props()` and arrive there as a local
 * called `base`, so the line says `base` where every other says `label_props`.
 * One alias, which is cheaper than either teaching this to follow a C function
 * or leaving the root class of the whole set unchecked.
 */
const TABLE_ALIAS = { base: "widget_props" };

function tableClasses(root) {
    const owner = {};

    for (const c of sources(root)) {
        const src = File.Load(c);
        for (const m of CLASS_REG.Matches(src))
            owner[TABLE_ALIAS[m.Group(2)] || m.Group(2)] = m.Group(1);
    }
    return owner;
}

/*
 * A subclass member that shadows one of its base's, and **says something
 * different**.
 *
 * The `Expand`/`ExpandNode` and `Remove`/`RemoveRow` traps: a method on a
 * subclass hides the base's on the prototype, and this check could not see it
 * because the base's row documents the name *somewhere* -- `api.sh` asks
 * whether a name is documented, not under which class.
 *
 * Two kinds are checkable, and the check is deliberately no wider than that:
 * a property answered by a method (or the reverse), and two methods declaring a
 * different number of parameters. **A property overridden by a property is
 * legitimate** -- `Split.Arrangement` narrows what its `Fixed` slot accepts on
 * purpose -- and a method overridden by a method with the same signature is an
 * override, not a shadow. What is left out is a subclass that redefines the
 * same name with the same shape and a different *meaning*, which no parser can
 * tell; the signature comments are what make even this much mechanical.
 */
/*
 * A shadow that is deliberate, named with the sentence that argues it.
 *
 * None today. The one it had was `Popover.Visible`, a read-only property over
 * `Widget`'s settable one, which existed because the popover was a control
 * whose open state a program could not be allowed to assign; the control went
 * and the verb that replaced it (`Popover.Show`) has no property to shadow. A
 * name that comes back here needs the same kind of argument -- a read-only
 * property over a settable one is a name a program will try to assign and
 * cannot -- which is why this is a list and not a rule.
 */
const SHADOW_INTENDED = [];

function checkShadows(root, members, problems) {
    const parent = {};
    const owner  = tableClasses(root);

    for (const c of sources(root)) {
        const src = File.Load(c);
        for (const m of CLASS_PARENT.Matches(src))
            parent[m.Group(1)] = m.Group(2) || null;
    }

    const mine = {};
    for (const m of members) {
        const cls = owner[m.table];
        if (!cls) continue;
        if (!mine[cls]) mine[cls] = [];
        if (!mine[cls].some((one) => one.name === m.name && one.kind === m.kind))
            mine[cls].push(m);
    }

    let checked = 0;

    for (const cls in mine) {
        for (let up = parent[cls]; up; up = parent[up]) {
            const base = mine[up];
            if (!base) continue;

            for (const m of mine[cls]) {
                const b = base.find((one) => one.name === m.name);
                if (!b) continue;
                if (SHADOW_INTENDED.includes(`${cls}.${m.name}`)) continue;

                checked++;
                if (b.kind !== m.kind) {
                    problems.push(`${cls}.${m.name} is a ${m.kind} and shadows ` +
                                  `${up}.${b.name}, a ${b.kind}`);
                    continue;
                }
                if (m.kind !== "method") continue;

                const a = Widget.Signature(cls, m.name);
                const z = Widget.Signature(up, b.name);

                if (a !== null && z !== null &&
                    signatureParams(a).length !== signatureParams(z).length)
                    problems.push(`${cls}.${m.name}${a} shadows ` +
                                  `${up}.${b.name}${z}`);
            }
        }
    }
    return checked;
}

/* A parameter list split at its **top-level** commas, so `[{A, B}]` is one
 * argument and not three. */
function splitTop(text) {
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

/* The parameter names a declared signature has: `([container])` is
 * `container`, `(...args)` is `args`, and a `{…}` shape is `options`. */
function signatureParams(sig) {
    return splitTop(sig.slice(1, -1)).map((part) => {
        let arg = part;
        if (arg.startsWith("[") && arg.endsWith("]")) arg = arg.slice(1, -1);
        if (arg.startsWith("{")) return "options";
        return arg.startsWith("...") ? arg.slice(3) : arg;
    });
}

/*
 * ------------------------------------------------ what a class answers
 *
 * The questions a class answers by **name** -- `Widget.PropertyNames(type)`,
 * `Methods`, `EventNames`, `TextProperties`, `PropertyOptions`, `Member`, and
 * the `New`/`Types`/`Available` they joined -- are built by
 * `JS_SetPropertyStr` on the root constructor, which is in no
 * `JSCFunctionListEntry` table. So the scan above cannot see them: measured
 * when this was written, `New`, `Types` and `Available` were public and called
 * by the IDE, and nothing here would have failed had any of them lost its row.
 *
 * They are read from where they are installed and held to the same rule, with
 * the qualified spelling -- `` `Widget.Types(` `` -- because that is what tells
 * a static from the instance method of the same name.
 */
const WIDGET_STATIC = new Regex(
    "JS_SetPropertyStr\\(\\s*ctx,\\s*ctor,\\s*\"([A-Za-z_]\\w*)\"");

function checkWidgetStatics(root, problems) {
    const src = File.Load(File.Join(root, "runtime/src/bta_widget.c"));
    let   count = 0;

    /* **The row is the documentation repository's now.** `bintana-docs`'
     * `check/` holds every native static of every class to one, out of
     * `api.json`; what stays here is that they answer without a display and
     * that every method and event declares its parameters. */
    for (const m of WIDGET_STATIC.Matches(src))
        count++;

    /*
     * And it has to answer **here**, where there is no display at all: the
     * point of asking a class is that no control is built, and a query that
     * reached GTK would make this the project it cannot run in.
     */
    try {
        if (!Widget.EventNames("Button").includes("Click"))
            problems.push("Widget.EventNames(\"Button\") answers without Click");
    } catch (e) {
        problems.push(`Widget.EventNames("Button") failed in a project with ` +
                      `no display: ${e.message}`);
    }

    /*
     * **And every method and event declares its parameters.** A signature lives
     * beside the member -- a comment above its C entry, or a `static
     * Signatures` on a class of the project's own -- and one that is missing is
     * a method the IDE's completion cannot hint. Asked of
     * the runtime rather than of the comments, so it is the same answer a
     * caller gets.
     */
    for (const type of Widget.Types()) {
        for (const method of Widget.Methods(type))
            if (Widget.Signature(type, method) === null)
                problems.push(`${type}.${method} declares no signature -- a ` +
                              `comment above its entry, or static Signatures ` +
                              `on the class`);

        for (const event of Widget.EventNames(type))
            if (Widget.EventSignature(type, event) === null)
                problems.push(`${type}.${event} declares no signature -- a ` +
                              `comment above the class row that lists it`);
    }
    return count;
}

/*
 * ------------------------------------------ what a global's verbs are called
 *
 * **Every native verb of a global declares its parameters**, the rule the
 * widgets' methods have been held to -- and it was not, for the half of the
 * language a program uses most: `File.Load`, `Locale.Text`, `Widget.New` and
 * a hundred and sixty more are registered with `JS_SetPropertyStr` or in a
 * table no class row owns, and the extractor only read comments above a class
 * table's entries. So the completion popup said `(...)` for every one of them.
 *
 * Asked of the runtime, as `Widget.Members` answers the IDE: a `Method` or a
 * `Static` with no `Signature` is the failure. A verb written in JavaScript is
 * answered by the parser out of its own source and needs nothing written; one
 * written in C needs the one-line comment above its entry. Only the globals
 * the C installs are asked, because those are the ones whose parameters exist
 * nowhere else.
 */
const NAMED_TYPE = new Regex("^\\s*/\\*\\s*type\\s+([A-Za-z_][\\w.]*)\\s*\\*/", { Multiline: true });

function checkGlobalSignatures(root, problems) {
    /* And the owners hung off a global -- `Desktop.Entries` -- which no line
     * installs on the global object: the scan below cannot find them, and
     * that is how six verbs went without a signature or a word for as long
     * as they did. */
    const names = new Set(["Widget", ...NESTED_OWNERS]);
    for (const c of sources(root)) {
        const src = File.Load(c);
        for (const m of GLOBAL_INSTALL.Matches(src)) names.add(m.Group(1));
        /* A prototype no global holds, named where its table is, is asked the
         * same question: its table is the whole of what an editor knows. */
        for (const m of NAMED_TYPE.Matches(src)) names.add(m.Group(1));
    }

    let checked = 0;
    for (const name of [...names].sort()) {
        let members;
        try { members = Widget.Members(name); } catch (e) { continue; }
        for (const m of members) {
            if (m.Kind !== "Method" && m.Kind !== "Static") continue;
            checked++;
            if (!m.Signature)
                problems.push(`${name}.${m.Name} declares no signature -- a ` +
                              `one-line /* ${m.Name}(...) */ above the line that ` +
                              `installs it`);
        }
    }
    return checked;
}

/*
 * ------------------------------------------------ what a member is for
 *
 * **Every native member says what it is for, beside itself.** The description
 * is written once, in the comment above the member's C entry -- the lines after
 * its signature -- and everything else reads it: `Widget.Members` hands it to
 * the IDE's completion, and `tools/docs` writes it into the rows of `docs/llm`
 * and `docs/reference`. So a member with none is a hole in all three at once,
 * and this names it.
 *
 * Asked of the runtime, the way the IDE asks: the members of every widget
 * class, of every global the C installs and of every prototype a `type X`
 * comment names, and every event of every widget class -- and the members
 * written in JavaScript the same way: rad.js's and forms.js's, asked of the
 * same classes, and every class a library under `lib/` declares, asked through
 * its sources. Those say what they are for in the JSDoc comment above the
 * declaration, which the parser reads and `Doc` carries.
 *
 * A `<control>_<event>` method is a handler the class wrote for itself and
 * not something a caller writes, so it is not asked about.
 */
function checkDocs(root, problems) {
    const owners = new Set(["Widget", ...Widget.Types(), ...NESTED_OWNERS]);
    for (const c of sources(root)) {
        const src = File.Load(c);
        for (const m of GLOBAL_INSTALL.Matches(src)) owners.add(m.Group(1));
        for (const m of NAMED_TYPE.Matches(src)) owners.add(m.Group(1));
    }
    /* Counted once per description and not once per class: a control
     * inherits a hundred members, and each is one thing written once. */
    const libSources = librarySources(root);
    for (const src of libSources)
        for (const s of Application.Symbols(src))
            if (s.Kind === "Class") owners.add(s.Name);
    const written = new Set();
    const seen = new Set();
    for (const name of [...owners].sort()) {
        let members;
        try { members = Widget.Members(name, { Sources: libSources }); } catch (e) { continue; }
        for (const m of members) {
            if (m.Name.includes("_")) continue;
            const key = `${name}.${m.Name}`;
            if (seen.has(key)) continue;
            seen.add(key);
            if (!m.Doc)
                problems.push(`${key} says nothing about what it is for -- ` +
                              (m.Native ? `the lines after its signature comment`
                                        : `a JSDoc comment above its declaration`));
            else written.add(`${m.Name}\u0000${m.Doc}`);
        }
    }
    for (const type of Widget.Types()) {
        for (const ev of Widget.EventNames(type)) {
            const doc = Widget.EventDoc(type, ev);
            if (!doc)
                problems.push(`${type}.${ev} (event) says nothing about what it is ` +
                              `for -- the lines after its comment above the class row`);
            else written.add(`event ${ev}\u0000${doc}`);
        }
    }
    return written.size;
}

/* ------------------------------------------------------------------- links
 *
 * **Does every relative link in the documentation still land on a file?**
 * The other checks here ask whether what exists is written down; this one asks
 * whether what is written down still exists. It is the failure a reorganisation
 * leaves behind and nothing notices: `docs/issues/ISSUE-printing.md` was deleted
 * the day printing arrived, and two pages went on pointing at it -- still saying
 * there was no printer, in prose that read as current. The bookkeeping in
 * `docs/issues/README.md` was updated by hand and the two paragraphs were not,
 * which is the whole argument for this being a check and not a habit.
 *
 * **The documentation and not the examples.** `docs/` and the Markdown at the
 * root are the pages somebody reads by following links; a `.md` under
 * `examples/` is that project's own data -- `examples/markdown/Guide.md` points
 * at a picture that is deliberately not there, which is what the example is
 * demonstrating.
 *
 * **Code spans are not links.** `` `[text](href)` `` in a table of Markdown
 * syntax is prose about the format, and so is a regular expression with
 * brackets in it. Everything between backticks is taken out before the links
 * are read -- the same way the reader takes it.
 */
const LINK = new Regex("(!?)\\[[^\\]]*\\]\\(([^)\\s]+)\\)");
const CODE = new Regex("```[^]*?```|`[^`\\n]*`");

/* The path as the reader would name it: `docs/llm/markdown.md` and not the
 * whole of this machine, since the same basename is four files here. */
function relative(root, path) {
    return File.Relative(path, root);
}

function docFiles(root) {
    const out = Directory.Files(root, { Pattern: "*.md" });

    for (const f of Directory.Files(File.Join(root, "docs"),
                                    { Pattern: "*.md", Recursive: true }))
        out.push(f);
    return out;
}

function checkLinks(root, problems) {
    const files = docFiles(root);
    let   links = 0;

    for (const path of files) {
        const text = CODE.Replace(File.Load(path), "");
        const dir  = File.Directory(path);

        for (const m of LINK.Matches(text)) {
            /* The fragment is the heading and not the file; an address with a
             * scheme is somebody else's to keep, and a bare `#anchor` is this
             * page's own. */
            const target = m.Group(2).split("#")[0];

            if (target === "" || /^(?:https?|mailto):/.test(target))
                continue;

            links++;
            if (!File.Exists(File.Join(dir, target)))
                problems.push(`${relative(root, path)}: ` +
                              `${m.Group(1) ? "picture" : "link"} to ${target}, ` +
                              `which is not there`);
        }
    }
    return { links, pages: files.length };
}

function Main() {
    const root = Application.Arguments[0] || File.Directory(Application.Directory);
    const problems = [];
    const members  = [];          /* { name, kind, table } */
    const events   = {};          /* name -> arity */

    /*
     * The runtime's half of the surface check.
     *
     * The documentation's half -- pages against `api.json`, the rows, the
     * links between them -- lives in `bintana-docs`, where the pages are. What
     * is left here is what only the C and the prelude can answer: that every
     * member has a signature and a description beside it, that `api.json` is
     * what the runtime says and what the C declares, and that the pages which
     * stayed do not point at a file that is gone.
     */
    for (const c of sources(root)) {
        const src = File.Load(c);

        for (const t of TABLE.Matches(src)) {
            if (NOT_PUBLISHED.includes(t.Group(1))) continue;
            const body = t.Group(2);

            for (const g of GETSET.Matches(body))
                members.push({ name: g.Group(1), table: t.Group(1),
                               kind: g.Group(3) === "NULL" ? "read-only property" : "property" });
            for (const f of CFUNC.Matches(body))
                members.push({ name: f.Group(1), table: t.Group(1), kind: "method" });
        }
        for (const e of EMIT.Matches(src)) {
            const n = Number(e.Group(2));
            events[e.Group(1)] = Math.max(events[e.Group(1)] || 0, n);
        }
    }
    for (const name in HELPER_EVENTS)
        events[name] = Math.max(events[name] || 0, HELPER_EVENTS[name]);

    const statics = checkWidgetStatics(root, problems);
    const verbs   = checkGlobalSignatures(root, problems);
    const docs    = checkDocs(root, problems);
    const libs    = checkLibraryScopes(root, problems);
    const shadows = checkShadows(root, members, problems);
    const api     = checkApiJson(root, problems, members, events);
    const named   = api.ok ? checkGlobalsListed(problems, api.catalog) : 0;
    const links   = checkLinks(root, problems);

    for (const p of problems) print(`  ${p}`);
    print(problems.length
        ? `api: ${problems.length} wrong, of ${statics} class statics, ` +
          `${Dictionary.Count(events)} events, ${verbs} global verbs and ` +
          `${libs.names} names in lib/`
        : `api: ${statics} class statics, ${verbs} global verbs with their ` +
          `parameters named, ${docs} members and events saying what they are for, ` +
          `in C and in JavaScript, ${shadows} member${shadows === 1 ? "" : "s"} ` +
          `checked for shadowing a base one, ${api.checked} members held to ` +
          `api.json, ${libs.names} top-level names in lib/ with no two ` +
          `libraries claiming one, and all ${named} globals the runtime ` +
          `installs accounted for -- and ${links.links} link${links.links === 1 ? "" : "s"} ` +
          `over the ${links.pages} pages of docs/ that stayed land somewhere`);
    Application.Quit(problems.length ? 1 : 0);
}
