Namespace("Ide");

/*
 * The parameters of the call being written, beside the cursor.
 *
 * `File.Save(p, |` shows `Save(path, **text**)`: which call the cursor is
 * inside, and which of its arguments. The completion popup answers *what can
 * go here*; this answers *what goes here*, and it is the half a person reaches
 * for once the name is typed and the popup has gone.
 *
 * **Nothing here knows a signature.** `Ide.Completion.callAt` finds the call
 * and asks the runtime -- the same `Signature` the popup shows, following a
 * chain the same way -- so a verb declared beside its C entry, a method of
 * rad.js read out of its own source and a library class read by the parser all
 * answer here with no second list.
 *
 * **Two runtime verbs, because a hint has to point at a place in a control**
 * and a `Popover` pointed at whole controls: `Editor.CursorBounds()` says where
 * the cursor is drawn, and `Popup(anchor, rect)` points at that rectangle.
 * Both are ordinary API, since the IDE has none of its own.
 *
 * The popover does not hide itself (`Autohide` off): an autohide one takes the
 * keyboard, and the whole point is that typing goes on underneath it. It is
 * built on first use and added to the form itself -- a surface, which is one of
 * the containers GTK presents a popover from.
 */
Ide.CallTip = class CallTip {
    constructor(ide) {
        this.ide   = ide;
        this.pop   = null;
        this.label = null;
        /* Escape put it away for this call; it stays away until the call does. */
        this.dismissed = null;
    }

    get visible() { return !!(this.pop && this.pop.Visible); }

    /* The text from the start of the file to the cursor, as JavaScript counts
     * it: `Line` and `Column` count characters, so the line is cut by code
     * points and not by index. Forty lines back is enough for any call a
     * person is in the middle of, and keeps a long file off the keystroke. */
    textBeforeCursor(ed) {
        const lines = ed.Text.split("\n");
        const line  = Math.max(1, Math.min(ed.Line, lines.length));
        const from  = Math.max(0, line - 40);
        const head  = lines.slice(from, line - 1);
        const here  = Array.from(lines[line - 1] || "").slice(0, Math.max(0, ed.Column - 1)).join("");
        return head.concat([here]).join("\n");
    }

    /* The signature with the argument the cursor is in made bold. A rest
     * parameter is every argument from where it stands. */
    markup(info) {
        const inner = info.Signature.replace(/^\(|\)$/g, "");
        const parts = Ide.CallTip.split(inner);
        let at = info.Index;
        if (at >= parts.length && parts.length && parts[parts.length - 1].startsWith("..."))
            at = parts.length - 1;
        const shown = parts.map((p, i) => i === at ? `<b>${Text.Escape(p)}</b>` : Text.Escape(p));
        return `${Text.Escape(info.Name)}(${shown.join(", ")})`;
    }

    /* A parameter list split at its top-level commas, so `[{ A, B }]` is one. */
    static split(text) {
        const out = [];
        let depth = 0, cur = "";
        for (const ch of text) {
            if (ch === "[" || ch === "{" || ch === "(") depth++;
            if (ch === "]" || ch === "}" || ch === ")") depth--;
            if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
            cur += ch;
        }
        if (cur.trim()) out.push(cur.trim());
        return out;
    }

    update() {
        const ide = this.ide;
        const ed  = ide.Editor;
        const state = ide.activeFile ? ide.openTabs.get(ide.activeFile) : null;
        if (!ed || !state || state.mode === "design" || !ide.activeFile.endsWith(".js"))
            return this.close();

        const info = ide.completion.callAt(this.textBeforeCursor(ed));
        if (!info || !info.Signature) return this.close();

        /* The same call Escape put away stays away; another call brings it. */
        const key = `${info.Name}${info.Signature}@${info.At}`;
        if (this.dismissed === key) return;
        this.dismissed = null;

        if (!this.pop) {
            this.pop = new Popover();
            this.pop.Autohide = false;
            this.pop.Position = "Top";
            this.label = new Label();
            this.label.Markup = true;
            this.pop.Add(this.label);
            ide.Add(this.pop);
        }
        this.label.Text = this.markup(info);
        this.key = key;
        try {
            this.pop.Popup(ed, ed.CursorBounds());
        } catch (e) {
            /* Not on screen -- a tab being switched, a window going: nothing to
             * point at, and nothing to report. */
            this.close();
        }
    }

    close(byHand) {
        if (byHand) this.dismissed = this.key || null;
        if (this.pop && this.pop.Visible) this.pop.Close();
    }
};
