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
 */
"use strict";

/* JS_CGETSET_DEF("Name", getter, setter) and its _MAGIC_ variant. A NULL setter
 * is a read-only property, which the loader can never assign. */
const GETSET = new Regex(
    "JS_CGETSET(?:_MAGIC)?_DEF\\(\\s*\"([A-Za-z_]\\w*)\"\\s*,\\s*([A-Za-z_]\\w*|NULL)\\s*,\\s*([A-Za-z_]\\w*|NULL)");
/* JS_CFUNC_DEF("Name", nargs, fn) -- a method, with the arity C declares. */
const CFUNC  = new Regex("JS_CFUNC(?:_MAGIC)?_DEF\\s*\\(\\s*\"([A-Za-z_]\\w*)\"\\s*,\\s*(\\d+)");
/* The tables themselves, so a name outside one is not mistaken for a member. */
const TABLE  = new Regex("static const JSCFunctionListEntry (\\w+)\\[\\]\\s*=\\s*\\{([^}]*)\\n\\};");
/* bta_emit(w, "Change", 0, NULL) -- an event and how many arguments it carries.
 * `_ok` too: an exporter emits `Draw` through the variant that answers whether
 * the handler threw, and an event that stopped being scanned is an event whose
 * arity stops being checked -- silently, which is how three documents came to
 * say `MouseWheel(dx, dy, ctrl, shift)`. */
const EMIT   = new Regex("bta_emit(?:_on|_ok)?\\s*\\(\\s*[^;\"]*\"([A-Z][A-Za-z]*)\"\\s*,\\s*(\\d+)");

/*
 * The C surfaces that are a **global** rather than a widget class, and the
 * heading each is documented under in `llm/library.md`.
 *
 * Two shapes, because the runtime builds globals two ways: a
 * `JSCFunctionListEntry` table (`Locale`, `Decimal`, `Day`, ...) and a run of
 * `JS_SetPropertyStr` calls on a local (`File`, `Directory`, `Application`,
 * ...). Both are read; which is which is an implementation detail of the module
 * and not of the contract.
 *
 * **Explicit and not inferred**, which matters: the same
 * `JS_SetPropertyStr(ctx, x, "Name", JS_New…)` shape builds the *return values*
 * of half the runtime -- `Exec`'s handle, `File.Info`'s answer, a row, a
 * `Dialect` -- and a scan that guessed would demand a heading for every one of
 * them. Adding a global means adding a line here, and that is the point: the
 * line is what makes the reference's completeness checkable at all.
 */
const GLOBAL_TABLES = {
    dec_proto_funcs: "Decimal",
    bytes_proto_funcs: "Bytes",
    locale_props:    "Locale",
    log_props:       "Logger",
    day_props:       "Day",
    time_props:      "Time",
    text_props:      "Text",
    hash_props:      "Hash",
    screen_props:    "Screen",
    env_props:       "Environment",
    conn_props:      "Database and Table",
    http_props:      "Http",
    http_client_props: "Http",
    multipart_props: "Http",
    http_server_props: "Http Server",
    http_request_props: "Http Server",
    audioplayer_props: "AudioPlayer",
    /*
     * These two are documented with the **forms** and not with the globals,
     * which is where they belong: a menu item and a command are parts of a
     * `.form` and not things a program reaches for on its own. So they name
     * their file and their heading, because the heading is prose there rather
     * than a class name.
     */
    menuitem_props:  { file: "docs/llm/forms.md", heading: "Menus" },
    action_props:    { file: "docs/llm/forms.md",
                       heading: "Actions: one command in several places" },
};

const GLOBAL_VARS = {
    file:        "File",
    dir:         "Directory",
    application: "Application",
    env:         "Environment",
    dialog:      "Dialog",
};

/* `JS_SetPropertyStr(ctx, <var>, "Name", JS_New…)` -- a member of a global built
 * without a table. `JS_New` and not `JS_NewCFunction` alone, because a global
 * carries plain values too. */
function setPropOn(varName) {
    return new Regex("JS_SetPropertyStr\\(\\s*ctx,\\s*" + varName +
                     ",\\s*\"([A-Za-z_]\\w*)\"\\s*,\\s*JS_New");
}

/* Events built through a helper rather than a literal emit, and the arity the
 * helper passes. `emit_mouse` hands five to each of them. */
const HELPER_EVENTS = { MouseDown: 5, MouseUp: 5, MouseMove: 5, DblClick: 5 };

/*
 * A component's public surface, from its source. The convention this tree
 * already follows is the whole parser: what an application may touch has a
 * capital initial, what the class does to itself does not -- `get Type()` and
 * `Refresh()` against `view()`, `plot()` and `reduce()`. Handlers are named
 * `<Control>_<Event>` and are nobody's business but the component's, so an
 * underscore is a name to skip.
 */
const LIB_GET    = new Regex("^ {4}(get|set) ([A-Z]\\w*)\\s*\\(", { Multiline: true });
const LIB_METHOD = new Regex("^ {4}([A-Z][A-Za-z0-9]*)\\s*\\(", { Multiline: true });
const LIB_EVENTS = new Regex("static\\s+Events\\s*=\\s*\\[([^\\]]*)\\]");
const LIB_EMIT   = new Regex("Emit\\(\\s*\"([A-Z][A-Za-z]*)\"([^;]*)\\)");

/* How many arguments an `Emit` passes: the commas at depth zero of what follows
 * the event name. `Emit("Range", 0, this.slots())` passes two, and counting the
 * commas without minding the brackets would say three. */
function emitArity(rest) {
    let depth = 0, n = 0;

    for (const ch of rest) {
        if (ch === "(" || ch === "[" || ch === "{") depth++;
        else if (ch === ")" || ch === "]" || ch === "}") depth--;
        else if (ch === "," && depth === 0) n++;
    }
    return n;
}

/*
 * Every library in `lib/`, against its page. A library with no page at all is a
 * failure of its own: it ships with the runtime, so somebody will use it.
 */
function checkLibraries(root, problems) {
    let counted = 0;

    for (const dir of Directory.Folders(File.Join(root, "lib"))) {
        const name = File.Name(dir);
        const doc  = File.Join(root, `docs/llm/${name}.md`);

        if (!File.Exists(doc)) {
            problems.push(`library ${name} has no reference at docs/llm/${name}.md`);
            continue;
        }
        const text = File.Load(doc);

        for (const src of Directory.Files(dir, "*.js")) {
            const code   = File.Load(src);
            const seen   = new Set();
            const events = {};

            for (const m of LIB_GET.Matches(code))    seen.add(m.Group(2));
            for (const m of LIB_METHOD.Matches(code)) {
                const w = m.Group(1);
                if (w !== "get" && w !== "set" && w !== "static") seen.add(w + "()");
            }
            for (const m of LIB_EVENTS.Matches(code)) {
                for (const q of m.Group(1).split(","))
                    if (q.trim()) events[q.trim().replace(/["' ]/g, "")] = 0;
            }
            for (const m of LIB_EMIT.Matches(code)) {
                const n = emitArity(m.Group(2));
                if (m.Group(1) in events)
                    events[m.Group(1)] = Math.max(events[m.Group(1)], n);
            }

            for (const member of seen) {
                if (member in events) continue;
                const row = member.endsWith("()")
                    ? new Regex("^\\|\\s*`" + Regex.Escape(member.slice(0, -2)) + "\\(",
                                { Multiline: true })
                    : new Regex("^\\|\\s*`" + Regex.Escape(member) + "`", { Multiline: true });

                if (!row.IsMatch(text))
                    problems.push(`${name}: ${File.Name(src)} publishes ${member} ` +
                                  `and ${name}.md has no row for it`);
                counted++;
            }
            for (const e in events) {
                const sig = new Regex("\\*\\*event\\*\\* `" + Regex.Escape(e) + "\\(([^)]*)\\)`");
                const m   = sig.Match(text);

                if (!m) {
                    problems.push(`${name}: event ${e} has no signature in ${name}.md`);
                    continue;
                }
                const args = m.Group(1).trim();
                const n    = args === "" ? 0 : args.split(",").length;

                if (n !== events[e])
                    problems.push(`${name}: event ${e} is documented with ${n} ` +
                                  `argument(s), the component emits ${events[e]}`);
                counted++;
            }
        }
    }
    return counted;
}

/*
 * Every global's members, against `docs/llm/library.md`.
 *
 * A member counts as documented when its name appears **inside its own global's
 * section** -- `## File` up to the next `## ` -- in backticks, bare or qualified:
 * `` `Load( ``, `` `Load` ``, `` `Dialog.OpenFile( ``, `` `Logger.Debug` ``. Its
 * own section and not the whole file, because `Load` belongs to `File` and to
 * `Locale` and a file-wide search would let either one cover the other.
 *
 * **Looser than the widget check on purpose**, which demands a table row: these
 * sections are not all tables. `File` is one, `Dialog` is a bullet list and
 * `Logger` is a sentence, and each is the right shape for what it describes. The
 * claim being checked is the one that matters either way -- a member that exists
 * and is not written down anywhere near its own heading.
 */
function checkGlobals(root, problems) {
    /*
     * The sections of one reference, by heading. Plain bags, which is what
     * `Dictionary` counts: it is a set of statics over an ordinary object and
     * not a class.
     */
    const sectionsOf = (file) => {
        const path = File.Join(root, file);

        if (!File.Exists(path)) {
            problems.push(`no reference at ${file}`);
            return null;
        }
        const text  = File.Load(path);
        const out   = {};
        const heads = new Regex("^## (.+)$", { Multiline: true }).Matches(text);

        for (let i = 0; i < heads.length; i++) {
            const from = heads[i].Index + heads[i].Length;
            const to   = i + 1 < heads.length ? heads[i + 1].Index : text.length;
            out[heads[i].Group(1).trim()] = text.slice(from, to);
        }
        return out;
    };

    const sections = { "docs/llm/library.md": sectionsOf("docs/llm/library.md") };
    const section  = (file, heading) => {
        if (!(file in sections)) sections[file] = sectionsOf(file);
        return sections[file] ? sections[file][heading] : undefined;
    };

    /*
     * What the runtime publishes, by global -- and where each is written down.
     * A `where` is either a heading in `library.md` or a file and a heading of
     * its own; both end up as the same pair here.
     */
    const members = {};
    const add = (where, name) => {
        if (!where) return;
        const file    = typeof where === "string" ? "docs/llm/library.md" : where.file;
        const heading = typeof where === "string" ? where : where.heading;
        const at      = `${file}#${heading}`;

        if (!members[at]) members[at] = { file, heading, names: [] };
        members[at].names.push(name);
    };

    for (const c of sources(root)) {
        const src = File.Load(c);

        for (const t of TABLE.Matches(src)) {
            const where = GLOBAL_TABLES[t.Group(1)];
            if (where === undefined) continue;
            for (const g of GETSET.Matches(t.Group(2))) add(where, g.Group(1));
            for (const f of CFUNC.Matches(t.Group(2)))  add(where, f.Group(1));
        }
        for (const v in GLOBAL_VARS)
            for (const m of setPropOn(v).Matches(src))
                add(GLOBAL_VARS[v], m.Group(1));
    }

    let counted = 0;
    for (const at of Dictionary.Keys(members)) {
        const { file, heading, names } = members[at];
        const where = section(file, heading);

        if (where === undefined) {
            problems.push(`${file} has no "## ${heading}" section`);
            continue;
        }
        const seen = new Set();

        for (const name of names) {
            if (seen.has(name)) continue;
            seen.add(name);
            counted++;

            /* Bare or qualified, since a section may spell either -- `Debug`
             * inside `Logger.Debug`, or `Load(path)` on its own. Qualified by
             * the heading's first word, which is the object's name where the
             * heading is prose. */
            const object = heading.split(/[ :]/)[0];
            const spelt  = [`\`${name}(`, `\`${name}\``,
                            `\`${object}.${name}(`, `\`${object}.${name}\``];

            if (!spelt.some((form) => where.includes(form)))
                problems.push(`${object}.${name} is not written down under ` +
                              `"## ${heading}" in ${file}`);
        }
    }
    return counted;
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

function checkReference(root, members, events, problems) {
    const dir = File.Join(root, "docs/reference/widgets");
    if (!File.IsDir(dir)) return { checked: 0, pages: 0, missing: 0 };

    /*
     * table -> class, off the registrations.
     *
     * **One class does not name its table in the registration**: `Widget`'s
     * members are handed over by `bta_widget_base_props()` and arrive there as a
     * local called `base`, so the line says `base` where every other says
     * `label_props`. One alias, which is cheaper than either teaching this to
     * follow a C function or leaving the root class of the whole set unchecked.
     */
    const ALIAS = { base: "widget_props" };
    const owner = {};
    const known = {};

    for (const c of sources(root)) {
        const src = File.Load(c);

        for (const m of CLASS_REG.Matches(src))
            owner[ALIAS[m.Group(2)] || m.Group(2)] = m.Group(1);
        /* Every registered class, whatever it publishes. **A class with no
         * members of its own is still a class somebody places** -- `Panel` is
         * the commonest container in this tree and declares nothing beyond what
         * it inherits -- so its page is about which container to reach for, and
         * it has nothing to be held to but the heading. */
        for (const m of CLASS_NAME.Matches(src))
            known[m.Group(1)] = true;
    }

    /* class -> its own members, which is what its page has to document: what it
     * inherits is on the page of the class it inherits from. */
    const mine = {};
    for (const m of members) {
        const cls = owner[m.table];
        if (!cls) continue;
        if (!mine[cls]) mine[cls] = [];
        if (!mine[cls].some((one) => one.name === m.name && one.kind === m.kind))
            mine[cls].push(m);
    }

    let checked = 0, pages = 0, counted = 0;

    for (const path of Directory.Files(dir, "*.md")) {
        const name = File.BaseName(path);
        if (name === "README") continue;
        pages++;

        if (!known[name]) {
            problems.push(`docs/reference/widgets/${name}.md documents ` +
                          `${name}, which the runtime does not register`);
            continue;
        }
        if (mine[name]) counted++;      /* a page whose class has members to check */

        const text = File.Load(path);

        /*
         * **Twice, and that is the point.** A page opens with `## Every member`
         * -- the whole surface at a glance, so a name can be found by eye -- and
         * explains each of them further down under the task it belongs to. A
         * member listed in the summary and explained nowhere is the failure this
         * split catches; without it, the summary alone would satisfy the check
         * and the long page would quietly become a short one.
         */
        const at   = text.indexOf("\n## Every member");
        const ends = at < 0 ? -1 : text.indexOf("\n## ", at + 4);

        if (at < 0) {
            problems.push(`${name}.md has no "## Every member" section`);
            continue;
        }
        const summary = text.slice(at, ends < 0 ? text.length : ends);
        const body    = text.slice(0, at) + (ends < 0 ? "" : text.slice(ends));

        for (const m of mine[name] || []) {
            const row = m.kind === "method"
                ? new Regex("^\\|\\s*`" + Regex.Escape(m.name) + "\\(", { Multiline: true })
                : new Regex("^\\|\\s*`" + Regex.Escape(m.name) + "`", { Multiline: true });

            if (!row.IsMatch(summary))
                problems.push(`${name}.md: ${m.kind} ${m.name} is not in "Every member"`);
            else if (!row.IsMatch(body))
                problems.push(`${name}.md: ${m.kind} ${m.name} is listed and never explained`);
            checked++;
        }

        /* And an event documented here is documented with its arguments, the
         * same rule `controls.md` is held to -- a signature that is confidently
         * wrong reads as authoritative. */
        for (const m of new Regex("\\*\\*event\\*\\* `(\\w+)\\(([^)]*)\\)`").Matches(text)) {
            const event = m.Group(1);
            if (!(event in events)) {
                problems.push(`${name}.md: event ${event} is not one the runtime raises`);
                continue;
            }
            const args = m.Group(2).trim();
            const n    = args === "" ? 0 : args.split(",").length;

            if (n !== events[event])
                problems.push(`${name}.md: event ${event} is documented with ${n} ` +
                              `argument(s), the runtime passes ${events[event]}`);
            checked++;
        }
    }
    return { checked, pages, missing: Dictionary.Count(mine) - counted };
}

function Main() {
    const root = Application.Arguments[0] || File.Directory(Application.Directory);
    const doc  = File.Join(root, "docs/llm/controls.md");

    if (!File.Exists(doc)) {
        print(`api: no reference at ${doc}`);
        Application.Quit(2);
        return;
    }
    const text = File.Load(doc);

    const members = [];          /* { name, kind, table } */
    const events  = {};          /* name -> arity */

    for (const c of sources(root)) {
        const src = File.Load(c);

        for (const t of TABLE.Matches(src)) {
            if (t.Group(1) in GLOBAL_TABLES) continue;
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

    /* A member counts as documented when its name appears in a table row of the
     * reference: `Name` for a property, `Name(` for a method. Prose mentioning it
     * is not enough -- what this is checking is that the row is there. */
    const problems = [];
    const seen     = new Set();

    for (const m of members) {
        if (seen.has(m.kind + " " + m.name)) continue;
        seen.add(m.kind + " " + m.name);

        const row = m.kind === "method"
            ? new Regex("^\\|\\s*`" + Regex.Escape(m.name) + "\\(", { Multiline: true })
            : new Regex("^\\|\\s*`" + Regex.Escape(m.name) + "`", { Multiline: true });

        if (!row.IsMatch(text))
            problems.push(`${m.kind} ${m.name} (${m.table}) has no row in controls.md`);
    }

    /* An event has to be documented **with its arguments**: a signature with the
     * wrong count is worse than none, because it reads as authoritative. The
     * count the runtime passes is the count the handler receives. */
    for (const name in events) {
        const sig = new Regex("\\*\\*event\\*\\* `" + Regex.Escape(name) + "\\(([^)]*)\\)`");
        const m   = sig.Match(text);

        if (!m) {
            problems.push(`event ${name} has no signature in controls.md`);
            continue;
        }
        const args = m.Group(1).trim();
        const n    = args === "" ? 0 : args.split(",").length;

        if (n !== events[name])
            problems.push(`event ${name} is documented with ${n} argument(s), ` +
                          `the runtime passes ${events[name]}`);
    }

    const lib     = checkLibraries(root, problems);
    const globals = checkGlobals(root, problems);
    const ref     = checkReference(root, members, events, problems);

    for (const p of problems) print(`  ${p}`);
    print(problems.length
        ? `api: ${problems.length} undocumented or wrong, of ${seen.size} widget ` +
          `members, ${Dictionary.Count(events)} events, ${globals} on globals ` +
          `and ${lib} in lib/`
        : `api: ${seen.size} widget members and ${Dictionary.Count(events)} events, ` +
          `plus ${globals} on the globals and ${lib} published by lib/, ` +
          `all documented -- and ${ref.checked} of them again in the ${ref.pages} ` +
          `long page${ref.pages === 1 ? "" : "s"} of docs/reference/widgets, ` +
          `${ref.missing} more with members of their own still to write`);
    Application.Quit(problems.length ? 1 : 0);
}
