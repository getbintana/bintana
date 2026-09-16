/*
 * The catalogues: the `.po` and `.pot` files, and what msgmerge does to them.
 *
 * **What it does not do, on purpose: merge.**  Keeping a translator's work while
 * strings come and go is `msgmerge`'s whole job, it is what every gettext
 * project already uses, and reimplementing it here would be a second, worse
 * copy.  So this writes the template and then asks msgmerge to update the
 * catalogues; with gettext-tools absent it says so and leaves the .pot, which is
 * exactly what Poedit's "update from POT file" wants.
 *
 * What goes *into* the template is [`Strings`](Strings.js)'s answer -- every
 * string the project shows, walked out of its `.form` files and its code. That
 * is a different subject and now a different class: this one is about the file
 * format, the plural rules, the header a translation must say for itself, and
 * the program the user edits a catalogue with. `update()` is where the two meet,
 * and it is the only place they do.
 */
"use strict";

/*
 * What a catalogue is edited with, best first.
 *
 * Chosen the way an icon is: the first name the desktop actually has wins, and
 * whoever picks the name is the only one who can choose a fallback --
 * `Application.HasCommand` is `HasIcon` for programs, and exists for this.
 *
 * `xdg-open` last, because "whatever this desktop associates with a .po" is a
 * real answer and usually a right one; it is not first, because a translation
 * editor is a better answer than a text editor when both are installed.
 */
const PO_EDITORS = ["poedit", "gtranslator", "lokalize", "virtaal", "xdg-open"];

/*
 * The plural rule a language wants in its header, by locale name.
 *
 * There is no working it out: how many forms a language has and which one a
 * number takes is a property of the language, and gettext's manual is where the
 * list comes from.  A catalogue started with the wrong rule has the wrong number
 * of `msgstr[n]` slots, so guessing later is not a fix.
 *
 * The exact name wins over its base, which is what tells `pt_BR` from `pt`.
 * Anything not here starts at the English rule and says so -- the header is the
 * first thing a translator edits, and a wrong count is visible immediately.
 */
const PLURAL_RULES = {
    /* One form: number does not change the noun. */
    ja: "nplurals=1; plural=0;", ko: "nplurals=1; plural=0;",
    zh: "nplurals=1; plural=0;", vi: "nplurals=1; plural=0;",
    th: "nplurals=1; plural=0;", id: "nplurals=1; plural=0;",
    ms: "nplurals=1; plural=0;",

    /* Two, and the singular covers 0 as well. */
    fr:    "nplurals=2; plural=(n > 1);",
    pt_BR: "nplurals=2; plural=(n > 1);",
    tl:    "nplurals=2; plural=(n > 1);",

    /* Three, the East Slavic shape. */
    ru: "nplurals=3; plural=(n%10==1 && n%100!=11 ? 0 : n%10>=2 && n%10<=4 && (n%100<10 || n%100>=20) ? 1 : 2);",
    uk: "nplurals=3; plural=(n%10==1 && n%100!=11 ? 0 : n%10>=2 && n%10<=4 && (n%100<10 || n%100>=20) ? 1 : 2);",
    be: "nplurals=3; plural=(n%10==1 && n%100!=11 ? 0 : n%10>=2 && n%10<=4 && (n%100<10 || n%100>=20) ? 1 : 2);",
    sr: "nplurals=3; plural=(n%10==1 && n%100!=11 ? 0 : n%10>=2 && n%10<=4 && (n%100<10 || n%100>=20) ? 1 : 2);",
    hr: "nplurals=3; plural=(n%10==1 && n%100!=11 ? 0 : n%10>=2 && n%10<=4 && (n%100<10 || n%100>=20) ? 1 : 2);",
    bs: "nplurals=3; plural=(n%10==1 && n%100!=11 ? 0 : n%10>=2 && n%10<=4 && (n%100<10 || n%100>=20) ? 1 : 2);",

    pl: "nplurals=3; plural=(n==1 ? 0 : n%10>=2 && n%10<=4 && (n%100<10 || n%100>=20) ? 1 : 2);",
    cs: "nplurals=3; plural=(n==1) ? 0 : (n>=2 && n<=4) ? 1 : 2;",
    sk: "nplurals=3; plural=(n==1) ? 0 : (n>=2 && n<=4) ? 1 : 2;",
    ro: "nplurals=3; plural=(n==1 ? 0 : (n==0 || (n%100 > 0 && n%100 < 20)) ? 1 : 2);",
    lt: "nplurals=3; plural=(n%10==1 && n%100!=11 ? 0 : n%10>=2 && (n%100<10 || n%100>=20) ? 1 : 2);",
    lv: "nplurals=3; plural=(n%10==1 && n%100!=11 ? 0 : n != 0 ? 1 : 2);",

    sl: "nplurals=4; plural=(n%100==1 ? 0 : n%100==2 ? 1 : n%100==3 || n%100==4 ? 2 : 3);",
    ga: "nplurals=5; plural=(n==1 ? 0 : n==2 ? 1 : n<7 ? 2 : n<11 ? 3 : 4);",
    ar: "nplurals=6; plural=(n==0 ? 0 : n==1 ? 1 : n==2 ? 2 : n%100>=3 && n%100<=10 ? 3 : n%100>=11 ? 4 : 5);",
};

const PLURAL_DEFAULT = "nplurals=2; plural=(n != 1);";

/* A locale name, which is what a catalogue's file name has to be for the runtime
 * to ever pick it: `es`, `pt_BR`, `zh_Hans`.  A file called `Español.po` is one
 * nothing will ever load, and saying so when it is typed beats never. */
const LOCALE_NAME = /^[a-z]{2,3}(_[A-Za-z]{2,4})?$/;

/* Where the chosen one is remembered.  `Settings` and not `project.json`: a path
 * to a program on this machine is not a property of the project, and putting it
 * in the manifest would commit one person's setup to everybody's checkout. */
const PO_EDITOR_KEY = "translationEditor";
/* A .po string, escaped and quoted. */
function poQuote(text) {
    return `"${String(text)
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\n/g, "\\n")
        .replace(/\t/g, "\\t")}"`;
}

/*
 * `keyword "value"`, or the multi-line spelling when the value has newlines in
 * it: `keyword ""` and then one quoted chunk per line.
 *
 * That second form is what msgfmt and xgettext write, and the header -- which is
 * one entry whose value is the whole metadata block -- is unreadable without it.
 */
function poLines(keyword, text) {
    const s = String(text);
    if (!s.includes("\n")) return [`${keyword} ${poQuote(s)}`];

    const ends  = s.endsWith("\n");
    const parts = s.split("\n");
    if (ends) parts.pop();

    return [`${keyword} ""`, ...parts.map((p, i) =>
        poQuote(i === parts.length - 1 && !ends ? p : `${p}\n`))];
}

Ide.Translations = class Translations {

    /** @param {MainForm} ide */
    constructor(ide) {
        this.ide = ide;
    }

    get dir() { return File.Join(this.ide.project, "po"); }

    /* ------------------------------------------------------ reading, writing */

    /*
     * A catalogue as entries, and the number of plural forms its header declares.
     *
     * `Locale.Read` loses nothing -- comments, flags, the `#~` tail -- which is
     * the whole reason an editor can write the file back without destroying what
     * it does not model.  `nplurals` is read out of the header entry rather than
     * asked of the runtime, because the header is just entry zero.
     */
    read(path) {
        const entries  = Locale.Read(path);
        const header   = entries.find((e) => e.msgid === "");
        const declared = header && /nplurals\s*=\s*(\d+)/.exec(header.forms[0] || "");

        return { entries, nplurals: declared ? Number(declared[1]) : 2 };
    }

    /*
     * The file, back.  One loop and no special cases: the header is an ordinary
     * entry whose msgid is "", and a block that is only comments -- the `#~` tail
     * a merge leaves behind -- is one whose msgid is null.
     *
     * Everything not modelled is written out exactly as it came in, which is what
     * makes saving safe on a file this IDE only half understands.
     */
    write(path, entries) {
        const out = [];

        for (const e of entries) {
            for (const c of e.comments || []) out.push(c);
            if (e.flags && e.flags.length) out.push(`#, ${e.flags.join(", ")}`);

            if (e.msgid !== null && e.msgid !== undefined) {
                if (e.ctxt !== undefined) out.push(...poLines("msgctxt", e.ctxt));
                out.push(...poLines("msgid", e.msgid));

                if (e.plural !== undefined) {
                    out.push(...poLines("msgid_plural", e.plural));
                    for (let i = 0; i < Math.max(1, e.forms.length); i++)
                        out.push(...poLines(`msgstr[${i}]`, e.forms[i] || ""));
                } else {
                    out.push(...poLines("msgstr", e.forms[0] || ""));
                }
            }
            out.push("");
        }

        /* One trailing newline, like every other file this runtime writes. */
        File.Save(path, `${out.join("\n").replace(/\n+$/, "")}\n`);
    }

    /* ------------------------------------------------------ what a file is */

    /* Is this file one of the catalogues? */
    static isCatalogue(file) {
        const ext = File.Extension(file || "").toLowerCase();
        return ext === "po" || ext === "pot";
    }

    /* ...and is it the template rather than a translation?  A `.pot` has no
     * translations in it by definition, so editing one is not a thing to offer:
     * what it is for is starting a `.po`. */
    static isTemplate(file) {
        return File.Extension(file || "").toLowerCase() === "pot";
    }

    /* ------------------------------------------------- starting a catalogue */

    /* The template this project has, or "" -- there is one, written by
     * `update()` and named after the project. */
    templateFile() {
        if (!this.ide.project || !File.IsDir(this.dir)) return "";
        const found = Directory.List(this.dir, "*.pot");
        return found.length ? File.Join("po", found[0]) : "";
    }

    /*
     * A catalogue's header, for a language.
     *
     * Everything the template said is kept; `Language` and `Plural-Forms` are the
     * two a translation must say for itself, and they are replaced where they are
     * rather than appended, so the header keeps the order a tool wrote it in.
     */
    header(text, lang) {
        const rule = PLURAL_RULES[lang] ||
                     PLURAL_RULES[lang.split("_")[0]] || PLURAL_DEFAULT;

        const out = [];
        let hasLang = false, hasPlural = false;

        for (const line of String(text).split("\n")) {
            if (line === "") continue;
            if (/^Language\s*:/i.test(line)) {
                out.push(`Language: ${lang}`);
                hasLang = true;
            } else if (/^Plural-Forms\s*:/i.test(line)) {
                out.push(`Plural-Forms: ${rule}`);
                hasPlural = true;
            } else {
                out.push(line);
            }
        }
        if (!hasLang)   out.push(`Language: ${lang}`);
        if (!hasPlural) out.push(`Plural-Forms: ${rule}`);

        return out.map((l) => `${l}\n`).join("");
    }

    /* How many forms that header declares, which is how many `msgstr[n]` slots a
     * plural entry needs.  Getting this wrong is not cosmetic: a language with
     * three forms and two slots cannot say the third. */
    formCount(headerText) {
        const m = /nplurals\s*=\s*(\d+)/.exec(headerText);
        return m ? Math.max(1, Number(m[1])) : 2;
    }

    /*
     * A new `po/<lang>.po` from the template.
     *
     * This is what makes the first translation possible without another program
     * -- and the first one is exactly when a project has no translation tool
     * habit yet.  Everything is copied except the translations themselves: a
     * template's entries are empty already, and blanking them is what makes this
     * predictable if one ever is not.
     */
    createFrom(template, then) {
        const have = Directory.List(this.dir, "*.po").map((n) => File.BaseName(n));
        const hint = have.length ? ` Already here: ${have.join(", ")}.` : "";

        AskForm.prompt("New translation",
                       `Locale for the new catalogue, like es, pt_BR or de.${hint}`,
                       "", (value) => {
            const lang = String(value).trim();

            if (!LOCALE_NAME.test(lang)) {
                Message.Error("{0} is not a locale name. Use a code like es, pt_BR or zh_Hans -- it is what the file is named after, and what the desktop is matched against.", lang);
                return;
            }
            const path = File.Join(this.dir, `${lang}.po`);
            if (File.Exists(path)) {
                Message.Error("This project already has {0}.po.", lang);
                return;
            }

            let entries;
            try {
                entries = Locale.Read(File.Join(this.ide.project, template));
            } catch (e) {
                Message.Error("Cannot read {0}: {1}", template, e.message);
                return;
            }

            /* The header first and on its own, because every entry after it is
             * sized by what it says -- a loop that met it halfway through would
             * give the entries before it the wrong number of slots. */
            const head = entries.find((e) => e.msgid === "");
            if (head) head.forms = [this.header(head.forms[0] || "", lang)];
            const forms = this.formCount(head ? head.forms[0] : "");

            for (const entry of entries) {
                if (entry.msgid === "" || entry.msgid === null) continue;

                /* Nothing is translated yet, and a plural entry gets one slot per
                 * form *this* language has -- not the template's. */
                const want = entry.plural !== undefined ? forms : 1;
                entry.forms = new Array(want).fill("");
                entry.flags = (entry.flags || []).filter((f) => f !== "fuzzy");
            }

            this.write(path, entries);
            Logger.Info(`new catalogue: po/${lang}.po`);
            if (then) then(File.Join("po", `${lang}.po`));
        });
    }

    /* ------------------------------------------------- the external editor */

    /*
     * The command to hand a catalogue to: what was configured if it is still
     * installed, otherwise the best one that is.  `""` when the machine has
     * none, which is a thing to say rather than a failure to hide.
     *
     * A configured command that has since been uninstalled falls back rather
     * than failing: the setting is a preference, not a promise about the disk.
     */
    editor() {
        const chosen = Settings.Get(PO_EDITOR_KEY, "");
        if (chosen && Application.HasCommand(chosen)) return chosen;

        return PO_EDITORS.find((c) => Application.HasCommand(c)) || "";
    }

    /*
     * Hands one to it.  Fire and forget: a translation editor is a window of its
     * own with its own lifetime, and the IDE has no business waiting for it.
     *
     * `Exec` throws when the program is not there, which is why `editor()` asks
     * first -- but the check and the launch are not one instant, so the throw is
     * still caught.
     */
    open(file) {
        const cmd = this.editor();
        if (!cmd) {
            this.askEditor(() => this.open(file));
            return;
        }

        const path = File.Join(this.ide.project, file);
        try {
            Exec([cmd, path]);
            Logger.Info(`${cmd} ${path}`);
        } catch (e) {
            Message.Error("Cannot run {0}: {1}", cmd, e.message);
        }
    }

    /*
     * Asks which program to use, and remembers it.
     *
     * A form and not a runtime primitive, and a plain text field and not a file
     * chooser: what goes here is usually a command name on the PATH, and a
     * chooser would ask for a path to somewhere the user does not know.  An
     * absolute path still works -- `HasCommand` answers about both.
     */
    askEditor(then) {
        const installed = PO_EDITORS.filter((c) => Application.HasCommand(c));
        const hint = installed.length
            ? `Installed here: ${installed.join(", ")}.`
            : "None of the usual ones is installed here (poedit, gtranslator, lokalize).";

        AskForm.prompt("Translation editor",
                       `Command to open a .po with. ${hint}`,
                       Settings.Get(PO_EDITOR_KEY, "") || installed[0] || "poedit",
                       (value) => {
            const cmd = String(value).trim();

            if (cmd && !Application.HasCommand(cmd)) {
                Message.Error("{0} is not installed, or not on the PATH.", cmd);
                return;
            }
            Settings.Set(PO_EDITOR_KEY, cmd);
            if (then) then();
        });
    }

    /* ------------------------------------------------- the template, and merging */

    /*
     * The template, and then msgmerge over whatever catalogues exist.
     *
     * Reported rather than silent: how many strings, which catalogues were
     * updated, and every warning the lint found.  A translation pass that says
     * nothing is one nobody trusts.
     */
    update() {
        if (!this.ide.project) return;

        /*
         * msgmerge rewrites these files, and doing that underneath an open
         * editor is how the work in it gets lost: the editor holds the entries
         * it read and saving would put the old ones back over the merge.
         */
        if (PoForm.busy) {
            Message.Info("Close the translation editor first: {0}",
                         PoForm.openFiles.join(", "));
            return;
        }

        /* The one place the two subjects meet: what the project says is
         * `Strings`'s answer, and what a catalogue is made of is this file's. */
        const found = this.ide.strings.collect();
        if (!found.length) {
            Message.Info("Nothing to translate: no declared text found.");
            return;
        }

        Directory.Make(this.dir);
        const pot = File.Join(this.dir, `${File.Name(this.ide.project)}.pot`);
        File.Save(pot, this.template(found));

        for (const line of this.ide.strings.warnings) Logger.Warning(line);

        /* And where somebody will actually see them: `Logger.Warning` is the
         * terminal the IDE was launched from, which nobody who started it from a
         * desktop menu has. The console is what the lint had; the panel is what
         * it never did. */
        this.ide.problems.report("strings", this.ide.strings.found);
        Logger.Info(`translations: ${found.length} strings -> ${pot}`);

        const cats = Directory.List(this.dir, "*.po");

        /* Asked before trying rather than after failing, so "gettext-tools is
         * not installed" is a sentence and not three error lines. */
        if (!cats.length || !Application.HasCommand("msgmerge")) {
            this.report(found, [], pot);
            return;
        }

        /*
         * msgmerge, one catalogue at a time.  Asynchronous, so the report waits
         * for the last of them -- reporting before they finish would say the
         * work was done while it was still running.
         */
        const done = [];
        const next = (i) => {
            if (i >= cats.length) {
                this.report(found, done, pot);
                return;
            }
            const po = File.Join(this.dir, cats[i]);
            Exec(["msgmerge", "--update", "--backup=none", "--quiet", po, pot],
                 (line) => Logger.Info(`msgmerge: ${line}`),
                 (code) => {
                     if (code === 0) done.push(cats[i]);
                     else Logger.Warning(`msgmerge failed on ${cats[i]} (${code})`);
                     next(i + 1);
                 });
        };
        next(0);
    }

    report(found, merged, pot) {
        const lines = [`${found.length} strings extracted.`];

        if (merged.length) lines.push(`Updated: ${merged.join(", ")}.`);
        else               lines.push(`Template written to ${File.Name(pot)}.`);

        /* When msgmerge is missing there is nothing broken -- the template is
         * what a translation tool wants anyway -- so this is a note and not an
         * error. */
        if (!merged.length && Directory.List(this.dir, "*.po").length) {
            lines.push("msgmerge is not installed, so no catalogue was updated;" +
                       " a translation tool can update them from the template.");
        }
        /* With no catalogue at all, the next step is the one nothing says out
         * loud. */
        if (!Directory.List(this.dir, "*.po").length) {
            lines.push("There is no catalogue yet: Project > New translation" +
                       " starts one from this template.");
        }
        const warnings = this.ide.strings.warnings;
        if (warnings.length) {
            lines.push(`${warnings.length} warning(s), listed under Problems.`);
        }
        Message.Info(lines.join("\n"));
    }

    /* The .pot itself: a header with no charset surprises, then every entry with
     * the places it came from. */
    template(found) {
        const out = [
            "# Translation template for this project.",
            "# Written by the Bintana IDE: Project > Update translations.",
            "#",
            'msgid ""',
            'msgstr ""',
            `"Project-Id-Version: ${File.Name(this.ide.project)}\\n"`,
            '"MIME-Version: 1.0\\n"',
            '"Content-Type: text/plain; charset=UTF-8\\n"',
            '"Content-Transfer-Encoding: 8bit\\n"',
            '"Plural-Forms: nplurals=2; plural=(n != 1);\\n"',
            "",
        ];

        for (const entry of found) {
            for (const where of entry.where) out.push(`#: ${where}`);
            if (entry.ctxt) out.push(`msgctxt ${poQuote(entry.ctxt)}`);

            out.push(`msgid ${poQuote(entry.msgid)}`);
            if (entry.plural) {
                out.push(`msgid_plural ${poQuote(entry.plural)}`);
                out.push('msgstr[0] ""');
                out.push('msgstr[1] ""');
            } else {
                out.push('msgstr ""');
            }
            out.push("");
        }
        return out.join("\n");
    }
};
