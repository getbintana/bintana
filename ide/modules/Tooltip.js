Namespace("Ide");

/*
 * What the name under the pointer is, once the pointer rests on it.
 *
 * The completion popup answers *what can I write here* and the call hint *what
 * goes in this call*; this answers the third question, which is asked with the
 * pointer and not with the keyboard: **what is this**. It is the half a person
 * reaches for on a name that is already written and whose description they
 * have forgotten.
 *
 * **It is a dwell and not a popup per pixel.** `MouseMove` arrives for every
 * pixel, so the answer is armed 400 ms after the pointer stops and disarmed by
 * any movement, a leave, a click or a key -- which is what keeps a tooltip
 * from following the hand around a file. `Editor.PositionAt` says which
 * character is under the point, and `Ide.Completion.topic` says what it is;
 * nothing here parses anything.
 *
 * **`Autohide` is off, unlike most popovers**, because an autohide one takes
 * the keyboard: the pointer may be resting over a name while the person goes
 * on typing, and the whole point is that the editor keeps the keys.
 */
Ide.Tooltip = class Tooltip {
    constructor(ide) {
        this.ide   = ide;
        this.label = null;
        this.timer = null;
        this.at    = "";
    }

    get visible() { return !!(this.label && Popover.IsOpen(this.label)); }

    /* The pointer moved over `ed`: what was open goes away and the dwell
     * starts over. */
    hovered(ed, x, y) {
        this.close();
        if (!ed)
            return;
        this.timer = Timer.After(400, () => {
            this.timer = null;
            this.show(ed, x, y);
        });
    }

    /*
     * The pointer left the editor, and there are two of these.
     *
     * **The one that matters is the real one**: hover a word, walk out
     * quickly, and the dwell is still armed with the last point it saw --
     * without this it fires a moment later and a tooltip appears at the edge
     * for a pointer that is somewhere else. `close` stops the timer.
     *
     * **The other one is the popover's own opening.** It maps under the
     * pointer for an instant while GTK places it, the editor is sent a
     * `leave` for that instant, and a handler that closed on it killed the
     * tooltip in its own frame -- `Visible` true, 168 characters of label,
     * and nothing on screen. A real leave never arrives with the popover up:
     * any movement back over the editor closes it through `hovered` first.
     */
    left() {
        if (this.visible)
            return;
        this.close();
    }

    stop() {
        if (this.timer) {
            this.timer.Stop();
            this.timer = null;
        }
    }

    /* The identifier under that position, or `""`. The line is cut by code
     * points because `Column` counts characters, as an emoji being one. */
    wordUnder(ed, at) {
        const line  = (ed.Text.split("\n")[at.Line - 1] || "");
        const chars = Array.from(line);
        let   from  = Math.max(0, Math.min(chars.length, at.Column - 1));
        let   to    = from;
        const part  = (c) => /[\w.]/.test(c);

        while (from > 0 && part(chars[from - 1])) from--;
        while (to < chars.length && part(chars[to])) to++;

        return chars.slice(from, to).join("").replace(/^\.+|\.+$/g, "");
    }

    show(ed, x, y) {
        let at = null;
        try { at = ed.PositionAt(x, y); } catch (e) { at = null; }
        if (!at)
            return this.close();

        const word = this.wordUnder(ed, at);
        const info = word ? this.ide.completion.topic(word) : null;
        if (!info)
            return this.close();

        if (!this.label) {
            this.label = new Label();
            this.label.Markup = true;
            this.label.Wrap   = true;
            this.label.Width  = 360;
        }
        this.label.Text = this.markup(info);
        this.at = word;
        try {
            Popover.Show(this.label, ed, {
                Rect: { X: x, Y: y, Width: 1, Height: 1 },
                Position: "Top", Autohide: false,
            });
        } catch (e) {
            /* Not on screen -- a tab being switched, a window going: nothing
             * to point at and nothing to report. */
            this.close();
        }
    }

    /* The title and the signature in bold, the description as the words it
     * says -- the reference's own markdown is characters to this control, and
     * a tooltip that reads `**which is not a selection**` is worse than none. */
    markup(info) {
        const head = `<b>${Text.Escape(info.Title)}</b>` +
                     (info.Signature ? ` ${Text.Escape(info.Signature)}` : "");
        const doc  = (info.Doc || "")
                        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
                        .replace(/\*\*|`/g, "");
        if (!doc)
            return head;
        const lines = doc.split("\n").map((l) => Text.Escape(l.trim())).filter((l) => l);
        return `${head}\n${lines.join("<br/>")}`;
    }

    close() {
        this.stop();
        this.at = "";
        if (this.label && Popover.IsOpen(this.label))
            Popover.Close(this.label);
    }
};
