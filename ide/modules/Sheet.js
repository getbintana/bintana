/*
 * One class of `<project>/app.css`, read and written.
 *
 * A class is where an application's look belongs -- `Background` and its family
 * on a control are the exception, and `Style` is the rule -- so the IDE has to be
 * able to make one without anybody writing CSS by hand. What it must **not** do
 * is invent CSS: the units, the colour normalising and the three ways a font size
 * reaches a stylesheet wrong are written in C, and `Widget.StyleRule()` hands
 * them over. This file is the text half only: find a rule, read it back into
 * properties, put one in without disturbing the rest of the file.
 *
 * **A class we cannot reproduce is not ours to edit.** Rather than keep a list of
 * declarations we understand and hope it stays complete, the check is a round
 * trip: read the rule into properties, set them on a control nobody sees, ask the
 * runtime what CSS that comes to, and compare. Anything the file says that we did
 * not say back -- a gradient, a transition, a selector of somebody's own -- and
 * the answer is *edit it by hand*, which is the honest one and needs no list.
 */
"use strict";

Namespace("Ide");

/* What a class the editor owns can say: exactly the appearance a control can be
 * given by hand, which is exactly what `StyleRule()` writes. */
const SHEET_PROPS = ["Background", "Foreground", "Font", "FontScale", "Opacity",
                     "Border", "Radius", "Padding", "Shadow"];

/* Pango's names for the weights CSS writes as numbers. Only the ones it has a
 * word for: anything else fails the round trip and the class is left alone. */
const WEIGHTS = { 100: "Thin", 200: "Ultra-Light", 300: "Light", 400: "",
                  500: "Medium", 600: "Semi-Bold", 700: "Bold",
                  800: "Ultra-Bold", 900: "Heavy" };

/* A CSS class name, which is not the same as an identifier: a dash is legal and
 * common (`dim-label`), a leading digit is not. */
const CSS_CLASS_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;

Ide.Sheet = class Sheet {

    static get props() { return SHEET_PROPS; }

    static isName(name) { return CSS_CLASS_NAME.test(String(name || "")); }

    /*
     * The top-level rules of a stylesheet, with where each one starts and ends.
     *
     * Scanned rather than matched with a regular expression, and that is not
     * fussiness: the first version anchored a rule to the `}` before it, so a
     * comment at the top of the file hid the first class, and `put` appended a
     * second copy of a class it had failed to find. A stylesheet has comments,
     * strings and `@media` blocks in it; walking it is twenty lines and cannot be
     * surprised by any of them.
     *
     * Offsets, because a rule is replaced **in place**: a file is somebody's, and
     * a tool that reformats it on the way past is one nobody trusts with theirs.
     */
    static rules(text) {
        const css = String(text || "");
        const out = [];

        let i = 0, depth = 0, start = 0;

        while (i < css.length) {
            const two = css.slice(i, i + 2);

            if (two === "/*") {                       /* a comment is not code */
                const end = css.indexOf("*/", i + 2);
                i = end < 0 ? css.length : end + 2;
                continue;
            }
            const c = css[i];

            if (c === '"' || c === "'") {             /* nor is a string */
                let j = i + 1;
                while (j < css.length && css[j] !== c) j += css[j] === "\\" ? 2 : 1;
                i = j + 1;
                continue;
            }
            if (c === "{") {
                if (depth === 0) {
                    /* A comment before the selector is not part of it -- and a
                     * file that opens with one is the common case, which is how
                     * the first class in a sheet came to be invisible. */
                    const selector = css.slice(start, i)
                        .replace(/\/\*[\s\S]*?\*\//g, "").trim();
                    const body     = Sheet.blockAt(css, i);

                    if (body) {
                        out.push({ selector, body: body.text, start, end: body.end });
                        i = body.end;
                        start = i;
                        continue;
                    }
                }
                depth++;
            } else if (c === "}") {
                depth = Math.max(0, depth - 1);
                if (depth === 0) start = i + 1;
            }
            i++;
        }
        return out;
    }

    /* The `{ ... }` that begins at `at`, skipping what is nested inside it, or
     * null when the file ends first. */
    static blockAt(css, at) {
        let depth = 0;

        for (let i = at; i < css.length; i++) {
            if (css[i] === "{") depth++;
            else if (css[i] === "}" && --depth === 0) {
                return { text: css.slice(at + 1, i).trim(), end: i + 1 };
            }
        }
        return null;
    }

    /* The rule for `.name` and nothing else: a `.name > row` or a
     * `button.name` belongs to whoever wrote it. */
    static ruleFor(text, name) {
        if (!Sheet.isName(name)) return null;
        return Sheet.rules(text).find((r) => r.selector === `.${name}`) || null;
    }

    /* Every class the sheet declares as a rule of its own. */
    static classes(text) {
        const out = [];

        for (const rule of Sheet.rules(text)) {
            const m = /^\.([A-Za-z_][A-Za-z0-9_-]*)$/.exec(rule.selector);
            if (m && !out.includes(m[1])) out.push(m[1]);
        }
        return out;
    }

    /* The body of `.name { ... }`, or null when there is no such rule. */
    static body(text, name) {
        const rule = Sheet.ruleFor(text, name);
        return rule ? rule.body : null;
    }

    /* `k: v;` pairs, in order, ignoring what is empty. */
    static declarations(body) {
        return String(body || "").split(";")
            .map((d) => d.trim())
            .filter(Boolean)
            .map((d) => {
                const at = d.indexOf(":");
                return at < 0 ? null
                              : [d.slice(0, at).trim().toLowerCase(),
                                 d.slice(at + 1).trim()];
            })
            .filter(Boolean);
    }

    /*
     * The properties a body comes to, or null when it says something we cannot
     * say back. The round trip is the test: see the header.
     */
    static read(body) {
        const props = {};
        const font  = {};

        for (const [key, value] of Sheet.declarations(body)) {
            switch (key) {
            case "background-color": props.Background = value; break;
            case "color":            props.Foreground = value; break;
            case "border-radius":    props.Radius  = Sheet.unpx(value); break;
            case "padding":          props.Padding = Sheet.unpx(value); break;
            case "border":           props.Border  = Sheet.unpx(value); break;
            case "box-shadow":       props.Shadow  = Sheet.unpx(value); break;
            case "opacity":          props.Opacity = Number(value); break;
            case "background-image": break;          /* ours, and always `none` */
            case "font-family":      font.family = value.replace(/^"|"$/g, ""); break;
            case "font-size":
                /* Per cent is the relative size a class usually wants -- it is
                 * how every one of the theme's own headings is written -- and it
                 * is a factor here, not part of the font. */
                if (value.endsWith("%")) props.FontScale = parseFloat(value) / 100;
                else                     font.size = value;
                break;
            case "font-weight":      font.weight = value; break;
            case "font-style":       font.style  = value; break;
            default:                 return null;    /* not something we write */
            }
        }

        /* Any of the four, not just a family or a size: a class of the theme's
         * shape is a *weight* and nothing else, and one that read back as
         * nothing would fail its own round trip and be called hand-written. */
        if (font.family || font.size || font.weight || font.style) {
            const weight = WEIGHTS[parseInt(font.weight, 10)] || "";
            const italic = font.style === "italic" ? "Italic" : "";
            const size   = String(font.size || "").replace("pt", "");

            props.Font = [font.family || "", weight, italic, size]
                .filter(Boolean).join(" ");
        }
        return props;
    }

    /* `4px 8px` -> `4 8`, which is the shape the properties take: the units are
     * added on the way out, in C, and never stored. */
    static unpx(value) {
        return String(value).replace(/(\d)px\b/g, "$1");
    }

    /*
     * What those properties come to, asked of the runtime.
     *
     * A control nobody sees: setting them is also what validates them, since a
     * value the runtime refuses throws here rather than reaching the file.
     */
    static rule(props) {
        const probe = new Label();
        try {
            for (const key of SHEET_PROPS) {
                if (props[key] !== undefined && props[key] !== "") {
                    probe[key] = props[key];
                }
            }
            return probe.StyleRule();
        } finally {
            probe.Delete();
        }
    }

    /* Two bodies saying the same thing, whatever the order and the spacing. */
    static same(a, b) {
        const norm = (body) => Sheet.declarations(body)
            .map(([k, v]) => `${k}:${v.replace(/\s+/g, " ")}`)
            .sort().join(";");

        return norm(a) === norm(b);
    }

    /*
     * The properties of a class the editor can own, or null for one it cannot --
     * because the rule says something this does not write. That class is edited
     * in `app.css` like the text it is.
     */
    static owned(text, name) {
        const body = Sheet.body(text, name);
        if (body === null) return null;

        let props;
        try {
            props = Sheet.read(body);
        } catch (e) {
            return null;
        }
        if (!props) return null;

        let back;
        try {
            back = Sheet.rule(props);
        } catch (e) {
            return null;                 /* a value the runtime refuses */
        }
        return Sheet.same(body, back) ? props : null;
    }

    /*
     * The sheet with `.name { body }` in it: replacing that rule where there is
     * one, appended where there is not, and **everything else left exactly as it
     * was**. A file is somebody's, and a tool that reformats it on the way past
     * is a tool nobody trusts with theirs.
     */
    static put(text, name, body) {
        const sheet   = String(text || "");
        const written = `.${name} {\n    ${body.replace(/;\s*/g, ";\n    ").trim()}\n}`;
        const rule    = Sheet.ruleFor(sheet, name);

        if (rule) {
            return sheet.slice(0, rule.start) + written + sheet.slice(rule.end);
        }

        const gap = !sheet ? "" : (sheet.endsWith("\n\n") ? "" :
                                   sheet.endsWith("\n") ? "\n" : "\n\n");
        return sheet + gap + written + "\n";
    }

    /* And without it: what *remove* means for a class nobody wears. */
    static drop(text, name) {
        const sheet = String(text || "");
        const rule  = Sheet.ruleFor(sheet, name);
        if (!rule) return sheet;

        const after = sheet.slice(rule.end).replace(/^\n{1,2}/, "\n");
        return sheet.slice(0, rule.start) + after;
    }
};
