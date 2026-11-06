/*
 * What a save means to a program that is running under the debugger.
 *
 * **Edit and continue, the half of it that can be honest.** A class's method,
 * getter, setter or static, edited and saved while the program runs, is sent to
 * the runtime (`{"do":"replace"}`), which compiles it onto the running class:
 * the next call runs the new text. This file decides *what* is sent -- by
 * comparing the text the program was started with against the text just
 * saved -- and *what is not and why*, since the rule of this debugger is that
 * nothing is accepted in silence.
 *
 * **A member is its own lines**, from the line the parser reports it on to the
 * end of the function that starts there (`Application.Symbols`: the member row
 * and the `Scope` beside it). Everything else in the file is its **skeleton**:
 * fields, the constructor, the class's heading, imports, top-level code, and
 * two members that share a line (they cannot be told apart by lines). A change
 * there is not something a running program can take -- a field's initializer
 * ran when each object was made, the constructor *is* the class every object
 * points to, top-level code ran once -- so it is refused, naming the line,
 * and the program keeps the text it has until it is started again.
 *
 * The skeleton is compared **blanked** (`Lex.blank`) and without blank lines or
 * indentation, so a comment or a spacing change outside a method is not
 * mistaken for a change the program cannot take.
 *
 * Two refusals are this side's and not the runtime's: the skeleton, and a
 * member that uses a private field (`#x`) -- measured in QuickJS, a method
 * compiled on another class throws on an object of the running class, whose
 * private brand it does not carry. Everything else the runtime decides, with
 * its own reason: a class it cannot reach by name, a name a module keeps to
 * itself, a text that does not compile.
 */
"use strict";

/* The member kinds that are a function on the class, and can be put there. */
const SWAPPABLE = new Set(["Method", "Static", "Getter", "Setter",
                           "StaticGetter", "StaticSetter"]);

export class HotSwap {

    /**
     * The members of a text that can be replaced on their own, by
     * `Class.Kind.Name`, each `{ cls, name, kind, line, end, text }` -- the
     * lines it spans and its source. Null when the text has no symbols.
     * @param {string} text
     * @returns {Map<string, object>|null}
     */
    static Members(text) {
        let syms;
        try { syms = Application.Symbols(text); } catch (e) { return null; }

        const lines  = text.split("\n");
        const rows   = syms.filter((s) => SWAPPABLE.has(s.Kind) && s.Parent && s.Name !== "constructor");
        const onLine = new Map();
        for (const r of syms)
            if (s_isMember(r)) onLine.set(r.Line, (onLine.get(r.Line) || 0) + 1);

        const out = new Map();
        for (const r of rows) {
            if (onLine.get(r.Line) > 1) continue;          /* two on one line */
            const spans = syms.filter((s) => s.Kind === "Scope" && s.Line === r.Line);
            if (!spans.length) continue;
            const end = Math.max(...spans.map((s) => s.End));
            out.set(`${r.Parent}.${r.Kind}.${r.Name}`, {
                cls: r.Parent, name: r.Name, kind: r.Kind, line: r.Line, end,
                text: lines.slice(r.Line - 1, end).join("\n"),
            });
        }
        return out;
    }

    /**
     * What the program can take of a save: the members to replace and to take
     * away, and what it cannot, each `{ line, why }` on the line of the saved
     * text it is about.
     * @param {string} before the text the program is running
     * @param {string} after the text just saved
     * @returns {{ replace: object[], remove: object[], refused: object[] }}
     */
    static Plan(before, after) {
        const out = { replace: [], remove: [], refused: [] };
        if (before === after) return out;

        const bad = Application.CheckSource(after);
        if (bad) {
            out.refused.push({ line: bad.Line,
                               why: Locale.Text("It does not compile, so nothing of it was applied: {0}",
                                                bad.Message) });
            return out;
        }

        const was = HotSwap.Members(before);
        const now = HotSwap.Members(after);
        if (!was || !now) return out;

        /* Outside every member: compared line by line, so the first that
         * differs is the one named. */
        const a = HotSwap.skeleton(before, was);
        const b = HotSwap.skeleton(after, now);
        const n = Math.min(a.length, b.length);
        let at = -1;
        for (let i = 0; i < n && at < 0; i++) if (a[i].text !== b[i].text) at = i;
        if (at < 0 && a.length !== b.length) at = n;
        if (at >= 0) {
            const line = at < b.length ? b[at].line : (b.length ? b[b.length - 1].line : 1);
            out.refused.push({ line, why: Locale.Text("A change outside a method's body -- a field, the constructor, a class's heading, top-level code -- is not taken by a running program; start it again to use it") });
        }

        for (const [key, m] of now) {
            const old = was.get(key);
            if (old && old.text === m.text) continue;
            if (Lex.blank(m.text).includes("#")) {
                out.refused.push({ line: m.line, why: Locale.Text("{0} uses a private field (#), which belongs to the class the program started with; start it again to use it", m.name) });
                continue;
            }
            out.replace.push(m);
        }
        for (const [key, m] of was)
            if (!now.has(key)) out.remove.push(m);
        return out;
    }

    /* The text outside the replaceable members, blanked and with blank lines
     * and indentation gone: `[{ line, text }]`, the line the saved file has. */
    static skeleton(text, members) {
        const code  = Lex.blank(text).split("\n");
        const taken = new Set();
        for (const m of members.values())
            for (let l = m.line; l <= m.end; l++) taken.add(l);

        const out = [];
        for (let i = 0; i < code.length; i++) {
            if (taken.has(i + 1)) continue;
            const t = code[i].trim();
            if (t) out.push({ line: i + 1, text: t });
        }
        return out;
    }
}

/* Every member row, replaceable or not, counted per line: two on one line
 * cannot be cut apart by lines. */
function s_isMember(s) {
    return s.Parent && (SWAPPABLE.has(s.Kind) || s.Kind === "Field");
}
