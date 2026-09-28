/*
 * A QR code on a form: `Text` in, the symbol drawn, as big as the room allows.
 *
 *     { "type": "QrView", "name": "Qr",
 *       "properties": { "Ecc": "M", "Width": 180, "Height": 180 } }
 *
 *     this.Qr.Text = url;
 *
 * `QrCode` is the encoder and this is only the showing of one, so everything
 * a view can do -- a PNG, an SVG, a page of a report -- is also reachable
 * without a form, from the `QrCode` that `Code` answers.
 *
 * Three decisions that are easy to get the other way round:
 *
 *   Ink and Paper  black on white by default, **not the theme's colours**. A QR
 *                  drawn light on a dark ground is an inverted code, which
 *                  plenty of readers refuse, and a code that scans on one
 *                  desktop and not on another is the worst kind of bug to report
 *   whole pixels   on screen a module is a whole number of pixels, with the
 *                  symbol centred in what is left over. A module of 3.4 pixels
 *                  antialiases every edge into grey, which is what makes a
 *                  code on a screen hard to scan from a phone
 *   no event       the text is encoded in the setter, so `Problem` answers on
 *                  the next line -- and a setter raises nothing, because a
 *                  `.form` assigns it before the host's controls exist
 *                  (`AGENTS.md`, *an event emitted while a .form is being
 *                  applied*)
 */
"use strict";

class QrView extends Component {

    static Options = { Ecc: ["L", "M", "Q", "H"] };

    /* Declared, because a component is sealed under `--strict`. What each means
     * unset is in its getter. */
    _text; _ecc; _quiet; _ink; _paper; _code; _problem;

    /* ------------------------------------------------------------ properties */

    /* What is encoded. **Data, not prose**: the class declares no text
     * properties, so a catalogue never translates a URL into something else. */
    /**
     * what is encoded, a string. **Data, not prose**: the class declares no
     * text property, so no catalogue ever translates a URL into something else.
     * Defaults to `""`. Set it and the symbol is made on the spot, so `Code`
     * answers on the next line. `null` and `undefined` are `""`
     */
    get Text() { return this._text || ""; }
    set Text(v) {
        this._text = v === null || v === undefined ? "" : String(v);
        this.encode();
    }

    /**
     * `L` `M` `Q` `H`, an error correction level. `"M"`. Higher survives more
     * damage and holds less: the same text can need a higher version, and past
     * the text's limit it stops fitting at all. Defaults to `"M"`.
     */
    get Ecc() { return this._ecc || "M"; }
    set Ecc(v) {
        const levels = QrView.Options.Ecc;
        if (!levels.includes(String(v)))
            throw new Error(`Ecc: '${v}' is not one of ${levels.join(", ")}`);
        this._ecc = String(v);
        this.encode();
    }

    /* The light margin around the symbol, in modules. The standard asks for
     * four; a code on a form that already has white around it can take less. */
    /**
     * the light margin around the symbol, in modules, 0 to 16. `4`, which is
     * the standard's minimum. A code on a form that already has white around it
     * can take fewer; a code printed on a coloured ticket wants more. Defaults
     * to `4`.
     */
    get QuietZone() { return this._quiet === undefined ? 4 : this._quiet; }
    set QuietZone(v) {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0 || n > 16)
            throw new Error(`QuietZone: ${v} is not a whole number of modules from 0 to 16`);
        this._quiet = n;
        this.Refresh();
    }

    /** the colour of the dark modules. Defaults to `"#000000"`. */
    get Ink() { return this._ink || "#000000"; }
    set Ink(v) { this._ink = String(v); this.Refresh(); }

    /** the colour of the ground. Defaults to `"#ffffff"`. */
    get Paper() { return this._paper || "#ffffff"; }
    set Paper(v) { this._paper = String(v); this.Refresh(); }

    /* ------------------------------------------------------- what it holds */

    /* The encoded symbol, or `null` when `Text` is empty or did not fit. */
    /**
     * the encoded [`QrCode`](docs/reference/libraries/QrCode.md), or `null`
     * when there is nothing to show. Read-only
     */
    get Code() { return this._code || null; }

    /* Why there is no symbol, or `""`: text too long for version 40 at this
     * level is the one way an assignment can fail. */
    /**
     * why there is no symbol, or `""`: text too long for version 40 at this
     * level is the one way an assignment can fail. Read-only
     */
    get Problem() { return this._problem || ""; }

    /* --------------------------------------------------------------- verbs */

    /**
     * redraws. It exists for a property changed **in place**, which is not
     * possible here — assigning anything already redraws. Assigning any
     * property already does
     */
    Refresh() { if (this.Canvas) this.Canvas.Redraw(); }

    /* A PNG `side` pixels square, or the view's own size. */
    /**
     * a PNG of `side` pixels square, or of the view's own allocation. The file
     * goes through [`DrawingArea.Save`](docs/reference/widgets/DrawingArea.md),
     * so the same `Canvas_Draw` runs against an image surface, synchronously
     */
    Save(path, side) {
        const s = side === undefined ? this.side() : side;
        this.Canvas.Save(path, s, s);
    }

    /* The same, answered as `Bytes`. */
    /**
     * the same PNG answered as [`Bytes`](docs/reference/globals/Bytes.md), for
     * an upload or a database column, with no file in between
     */
    ToPng(side) {
        const s = side === undefined ? this.side() : side;
        return this.Canvas.ToPng(s, s);
    }

    /* The symbol as an SVG document, in this view's colours and quiet zone. */
    /**
     * the symbol as an SVG document, in this view's `Ink`, `Paper` and
     * `QuietZone`. It **refuses** when there is no symbol rather than writing
     * an empty file. Ask `Code` first, as the example does
     */
    ToSvg() {
        if (!this._code) throw new Error(`ToSvg: there is no symbol (${this.Problem || "no text"})`);
        return this._code.ToSvg({ QuietZone: this.QuietZone, Ink: this.Ink, Paper: this.Paper });
    }

    /* -------------------------------------------------------------- inside */

    encode() {
        this._code = null;
        this._problem = "";
        if (this.Text !== "") {
            try {
                this._code = QrCode.Encode(this.Text, { Ecc: this.Ecc });
            } catch (e) {
                this._problem = e.message;
            }
        }
        this.Refresh();
    }

    side() {
        const b = this.Canvas.Bounds();
        return Math.max(1, Math.min(b.Width, b.Height));
    }

    Canvas_Draw(p, width, height) {
        const side = Math.min(width, height);
        p.Color = this.Paper;
        p.Rectangle(0, 0, width, height);
        p.Fill();
        if (!this._code || side <= 0) return;

        /* Whole pixels a module when there is room for at least one, centred;
         * a view smaller than the symbol still draws, blurred, rather than
         * nothing. */
        const cells = this._code.Size + 2 * this.QuietZone;
        const unit  = Math.floor(side / cells);
        const drawn = unit >= 1 ? unit * cells : side;
        p.Antialias = unit < 1;
        this._code.Paint(p, Math.floor((width - drawn) / 2), Math.floor((height - drawn) / 2),
                         drawn, { QuietZone: this.QuietZone, Ink: this.Ink, Paper: this.Paper });
    }
}
