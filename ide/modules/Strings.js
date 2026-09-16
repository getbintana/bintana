/*
 * Extraction: every string the project shows a person, gathered from its own
 * sources.
 *
 * In a RAD environment writing text in code is the exception, and the numbers
 * say so -- the IDE's own forms declare 130 strings against 63 in its code, and
 * it is the most code-heavy Bintana application there is.  So the half of this
 * that matters is the one no existing tool can do: walking the `.form` files.
 * `xgettext` reads JavaScript and knows nothing about a widget tree.
 *
 * Which properties hold prose is *asked of the runtime*, never matched against a
 * list of names here: `Widget.New(type).TextProperties()`.  A widget added to
 * the runtime in C is extracted with nothing changed in the IDE -- and a
 * SourceEditor's source text is never collected, because its class says that
 * string is not prose.
 *
 * **It knows nothing about `.po` files**, which is why it is not in
 * [`Translations`](Translations.js): what comes out of here is a list of
 * entries, and what a catalogue does with them -- the header, the plural rules,
 * the quoting, msgmerge -- is that file's subject and not this one's. The two
 * met in one class for a while and the seam showed: the lint below warns about a
 * template literal in `Message.Info`, which has nothing to do with a catalogue.
 */
"use strict";

Namespace("Ide");

/*
 * The calls whose Nth argument is a msgid.
 *
 * `Message.Info` and its two siblings are on the list because the first argument
 * of a message *is* a declared position for prose -- the runtime translates it
 * and interpolates `{0}` there, so a message needs no helper around it.  The
 * idea is the same one a property's `texts` carries: this position holds text a
 * person reads, and a position is a position whether it is a property or an
 * argument.
 *
 *   args   how many leading string literals to take
 *   ctxt   true when the first of them is a msgctxt rather than a msgid
 */
const CALLS = [
    { call: "Locale.Text",     args: 1, ctxt: false },
    { call: "Locale.Plural",   args: 2, ctxt: false },
    { call: "Locale.Context",  args: 2, ctxt: true  },
    { call: "Message.Info",    args: 1, ctxt: false },
    { call: "Message.Warning", args: 1, ctxt: false },
    { call: "Message.Error",   args: 1, ctxt: false },
];


/* One string literal, single or double quoted, with its escapes intact. */
const LITERAL = `(?:"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')`;

/* A JS string literal's value.  JSON.parse handles a double-quoted one, and a
 * single-quoted one becomes double-quoted first -- these are UI strings, not a
 * general-purpose parser's input. */
function literalValue(text) {
    try {
        if (text.startsWith("'")) {
            const inner = text.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"');
            return JSON.parse(`"${inner}"`);
        }
        return JSON.parse(text);
    } catch (e) {
        return null;
    }
}


Ide.Strings = class Strings {

    constructor(ide) {
        this.ide = ide;

        /* What the last collection found, and what it could not: read by
         * whoever asked for it -- the console, and the report `Translations`
         * shows when the pass is over. */
        this.entries  = new Map();
        this.warnings = [];

        /* The same warnings as places rather than as prose, for the Problems
         * panel. Two lists filled by one `warn` and never by hand: a panel that
         * parsed `file:line: text` back out of the sentence above would be
         * reading what this class had just finished writing. */
        this.found    = [];
    }

    /*
     * Every declared string, keyed the way a catalogue keys it, in the order
     * found -- plus where each one came from, which is what a translator reads
     * to know what they are translating.
     */
    collect() {
        this.entries  = new Map();      /* key -> { ctxt, msgid, plural, where } */
        this.warnings = [];             /* all of it starts over: a fresh scan */
        this.found    = [];

        for (const path of this.projectFiles(".form")) this.fromForm(path);
        for (const path of this.projectFiles(".js"))   this.fromSource(path);

        return [...this.entries.values()];
    }

    /* Every file of one extension under the project, sorted, skipping what a
     * project keeps to itself. */
    projectFiles(ext, dir = this.ide.project, out = []) {
        for (const name of Directory.List(dir)) {
            if (name.startsWith(".")) continue;

            const path = File.Join(dir, name);
            if (File.IsDir(path)) this.projectFiles(ext, path, out);
            else if (name.endsWith(ext)) out.push(path);
        }
        return out.sort();
    }

    add(msgid, where, ctxt, plural) {
        if (msgid === undefined || msgid === null || msgid === "") return;

        const key  = ctxt ? `${ctxt}${msgid}` : msgid;
        const have = this.entries.get(key);

        if (have) {
            if (!have.where.includes(where)) have.where.push(where);
            if (plural && !have.plural) have.plural = plural;
            return;
        }
        this.entries.set(key, { ctxt, msgid, plural, where: [where] });
    }

    /* --- the declarative half, which is most of it ----------------------- */

    fromForm(path) {
        const rel = path.slice(this.ide.project.length + 1);
        let   root;

        try {
            root = File.LoadJson(path);
        } catch (e) {
            this.warn(rel, 0, e.message);
            return;
        }

        /* A form's own properties are the window's; its class answers for them. */
        this.fromNode({ type: root.class, properties: root.properties }, rel, true);
        for (const item of root.menus || []) this.fromMenu(item, rel);
        for (const child of root.children || []) this.fromNode(child, rel);
    }

    /*
     * One node.  What counts as prose is the *class's* answer, so this walk knows
     * nothing about Text or Tooltip or Items.
     *
     * The `design` block is deliberately not collected: a design value is what
     * the designer shows and never reaches a running application, so putting it
     * in front of a translator would be asking for work nobody will ever read.
     */
    fromNode(node, rel, isRoot = false) {
        const props = node.properties || {};
        const texts = this.textPropertiesOf(node.type, isRoot);

        if (texts) {
            for (const declared of texts) {
                /*
                 * A declaration is usually a property name, and may name a
                 * *member* of one: `TableView` says `"Columns.Text"`, because a
                 * column carries a heading, a width and an alignment and only
                 * the first is prose. The runtime decides which -- never this
                 * file, and never the spelling of the key: a rule that collected
                 * every string in an object would put `"Right"` in the
                 * catalogue, and a translator would change what a keyword means.
                 */
                const dot   = declared.indexOf(".");
                const key   = dot < 0 ? declared : declared.slice(0, dot);
                const field = dot < 0 ? null     : declared.slice(dot + 1);

                const value = props[key];
                const where = `${rel}: ${node.name || node.type}.${declared}`;
                const take  = (v) => {
                    if (field) {
                        if (v && typeof v[field] === "string") this.add(v[field], where);
                    } else if (typeof v === "string") {
                        this.add(v, where);
                    }
                };

                if (Array.isArray(value)) value.forEach(take);
                else                      take(value);
            }
        }
        for (const child of node.children || []) this.fromNode(child, rel);
    }

    /*
     * What the runtime says this type's prose is.
     *
     * A project's own component cannot be *built* here: its class belongs to the
     * project and the IDE runs in its own process, exactly as the designer
     * cannot build one.  What it declares can still be read -- `static
     * TextProperties`, out of its source -- and that is the only thing that
     * makes a caption the component exposes to the form holding it reachable:
     * the string sits in the *host's* .form, where nothing else says it is
     * prose.  What the component declares inside its own .form this walk reached
     * all along.
     *
     * A class that declares none still answers nothing, which is what it did
     * before there was a way to declare any: collecting every string of a type
     * nobody has vouched for is how `"Right"` ends up in front of a translator.
     */
    textPropertiesOf(type, isRoot) {
        if (isRoot) return new Form().TextProperties();
        if (!type) return null;

        if (!this.probes) this.probes = new Map();
        if (this.probes.has(type)) return this.probes.get(type);

        let answer;
        try {
            answer = Widget.New(type).TextProperties();
        } catch (e) {
            /* Not cached with the rest: what a widget of this process answers
             * cannot change while the IDE runs, and what a component declares
             * changes every time its source is saved. */
            return this.ide.classes.componentTextProperties(type);
        }
        this.probes.set(type, answer);
        return answer;
    }

    fromMenu(item, rel) {
        /* A menu label is prose declared in the .form, and the runtime looks it
         * up when it builds the bar -- but it is not a property, so no class
         * declares it and this has to know the key by name. */
        if (typeof item.text === "string")
            this.add(item.text, `${rel}: menu ${item.name || item.text}`);

        for (const child of item.children || []) this.fromMenu(child, rel);
    }

    /* --- the code half, which is the exception -------------------------- */

    fromSource(path) {
        const rel = path.slice(this.ide.project.length + 1);
        const src = File.Load(path);

        for (const spec of CALLS) this.fromCalls(src, rel, spec);
        this.lint(src, rel);
    }

    fromCalls(src, rel, spec) {
        const head = spec.call.replace(".", "\\.");
        const one  = `\\s*${LITERAL}\\s*`;
        const tail = spec.args === 2 ? `,${one}` : "";
        const re   = new RegExp(`${head}\\(${one}${tail}`, "g");

        let m;
        while ((m = re.exec(src)) !== null) {
            const parts = m[0].match(new RegExp(LITERAL, "g")) || [];
            const line  = src.slice(0, m.index).split("\n").length;
            const where = `${rel}:${line}`;

            const first  = literalValue(parts[0]);
            const second = parts[1] !== undefined ? literalValue(parts[1]) : undefined;

            if (spec.ctxt) this.add(second, where, first);
            else           this.add(first, where, undefined, second);
        }
    }

    /*
     * One warning, said twice: as the sentence the console and the translation
     * report print, and as the place the Problems panel lists. `line` is 0 for
     * a warning about the whole file.
     */
    warn(rel, line, text) {
        this.warnings.push(line ? `${rel}:${line}: ${text}` : `${rel}: ${text}`);
        this.found.push({ kind: "Warning", file: rel, line, text });
    }

    /*
     * The lint: strings that will never reach a translator, and the IDE is the
     * only thing in a position to notice.
     *
     * Both of these are silent failures -- the application works, in one
     * language, forever -- which is the kind this project answers by *finding*
     * rather than by making impossible.  The same shape as the walk over every
     * declared `Icon` in tests/ide.
     */
    lint(src, rel) {
        /*
         * A template literal in a position that holds prose.  This is the one
         * mistake worth catching above all others: the msgid would arrive already
         * interpolated, so no catalogue could ever match it, and nothing says so
         * at runtime.
         *
         * ...but only when the literal parts have letters in them.  `${key}:
         * ${e.message}` is punctuation around two values and has nothing to
         * translate; warning about it is how a lint gets switched off.
         */
        for (const spec of CALLS) {
            const re = new RegExp(`${spec.call.replace(".", "\\.")}\\(\\s*\`([^\`]*)\``, "g");
            let m;
            while ((m = re.exec(src)) !== null) {
                const prose = m[1].replace(/\$\{[^}]*\}/g, "");
                if (!/\p{L}/u.test(prose)) continue;

                const line = src.slice(0, m.index).split("\n").length;
                this.warn(rel, line,
                    `a template literal in ${spec.call} cannot be translated -- ` +
                    `the msgid arrives already filled in. Give ${spec.call} the ` +
                    `text as one literal with {0} placeholders, and pass the ` +
                    `values after it.`);
            }
        }

        /*
         * A msgid built by joining literals, which is **worse than a template
         * literal**: only the first piece is extracted, so the catalogue gets an
         * entry that looks perfectly valid, a translator translates it, and it
         * never matches anything at runtime. A template literal at least looks
         * wrong in the .pot.
         *
         * Found by running the extractor over this IDE, which had three.
         */
        for (const spec of CALLS) {
            const head = spec.call.replace(".", "\\.");
            const re   = new RegExp(`${head}\\(\\s*${LITERAL}\\s*\\+`, "g");
            let m;
            while ((m = re.exec(src)) !== null) {
                const line = src.slice(0, m.index).split("\n").length;
                this.warn(rel, line,
                    `the text in ${spec.call} is two literals joined, so only ` +
                    `the first is extracted. Write it as one string, however long.`);
            }
        }

        /*
         * A literal assigned to a property that holds prose.  In a RAD project
         * this is a caption that escaped the designer: it is in no .form, so no
         * translator sees it and the property grid cannot show it either.
         */
        for (const key of this.proseNames()) {
            const re = new RegExp(`\\.${key}\\s*=\\s*(${LITERAL})`, "g");
            let m;
            while ((m = re.exec(src)) !== null) {
                const value = literalValue(m[1]);
                if (!value || !/\p{L}/u.test(value)) continue;

                const line = src.slice(0, m.index).split("\n").length;
                this.warn(rel, line,
                    `${JSON.stringify(value)} is assigned to .${key} from code, ` +
                    `so nothing extracts it. Declare it in the .form, or wrap it ` +
                    `in Locale.Text.`);
            }

            /*
             * ...and the same assignment with a **template**, which hides better
             * and is the one that got the IDE's own window title. It reads as
             * composed text, so nothing looks odd about it, and the string is in
             * no .form and in no call an extractor knows.
             *
             * Found by translating this IDE: every menu came out in Spanish and
             * the title stayed in English.
             */
            const tmpl = new RegExp(`\\.${key}\\s*=\\s*\`([^\`]*)\``, "g");
            while ((m = tmpl.exec(src)) !== null) {
                const prose = m[1].replace(/\$\{[^}]*\}/g, "");
                if (!/\p{L}/u.test(prose)) continue;

                const line = src.slice(0, m.index).split("\n").length;
                this.warn(rel, line,
                    `a template literal is assigned to .${key}, so nothing ` +
                    `extracts it. Wrap it in Locale.Text with {0} placeholders, or ` +
                    `declare the template in the .form and call Fill().`);
            }
        }
    }

    /* Every property name the widget set treats as prose -- the union over the
     * classes, asked once. */
    proseNames() {
        if (this.prose) return this.prose;

        const names = new Set();
        for (const type of Widget.Types()) {
            const answer = this.textPropertiesOf(type);
            for (const name of answer || []) names.add(name);
        }
        this.prose = [...names];
        return this.prose;
    }
};
