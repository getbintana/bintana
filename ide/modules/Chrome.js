/*
 * What the designer draws *over* the form: the selection outline and its
 * handles, the form's own resize grips, the alignment guides, the border that
 * says how big the window will be, and the rubber band.
 *
 * All of it lives on `Glass`, the transparent layer above `Surface` -- so a
 * control can be outlined without touching the control, and a covered one is
 * still visible.  Nothing here decides anything: the designer works out *where*
 * something goes and asks for it to be drawn, which is what keeps the arithmetic
 * of a drag in one place and the panel-poking in another.
 *
 * One per designer, like the canvas it draws on: the chrome is about the
 * selection of *this* form, and every open form has one.
 */
"use strict";

Namespace("Ide");

/* Colours.  `SELECT_COLOR` is the selection's blue and is read from the palette
 * too, which marks the active tool in it: the same colour means the same thing. */
const SELECT_COLOR  = "#1c71d8";
/* A control that came out bigger than it asked for: amber, not the selection's
 * blue, because it is a statement about the control and not about the choosing. */
const OVERFLOW_COLOR = "#e5a50a";
const GUIDE_COLOR   = "#e01b24";
/* The form's grips: darker than a control's selection, so the two are telling
 * apart at a glance even when a control sits against the form's edge. */
const FORM_HANDLE_COLOR = "#26456e";
const BOUNDS_COLOR  = "#77767b";

const HANDLE = 8;               // side of the little resize square

/* How the chrome waits for a layout it did not cause: every SETTLE_MS, up to
 * SETTLE_TRIES times -- half a second in all, which is far longer than a frame
 * and far shorter than a person waits before deciding nothing happened. */
const SETTLE_MS    = 30;
const SETTLE_TRIES = 16;

/* Which edges each handle moves: [left, top, right, bottom].  Read by the
 * designer as well -- a drag on a handle is what the table is for. */
const HANDLES = {
    nw: [1, 1, 0, 0], n: [0, 1, 0, 0], ne: [0, 1, 1, 0],
    w:  [1, 0, 0, 0],                  e:  [0, 0, 1, 0],
    sw: [1, 0, 0, 1], s: [0, 0, 0, 1], se: [0, 0, 1, 1],
};

/* The form is resized from its far edges: right, bottom, and the corner that
 * is both.  No handles on the near edges -- the form's origin is 0,0 and
 * dragging the top-left would mean moving every control instead. */
const FORM_HANDLES = ["e", "s", "se"];

Ide.Chrome = class Chrome {

    /* Four thin bars for the outline and eight little squares for the handles,
     * created once and repositioned on every change. */
    constructor(designer) {
        this.designer = designer;
        this.glass    = designer.glass;

        this.outline = [];
        for (let i = 0; i < 4; i++) this.outline.push(this.bar(SELECT_COLOR));

        this.handles = {};
        for (const id in HANDLES) {
            const h = this.bar(SELECT_COLOR);
            h.Resize(HANDLE, HANDLE);
            this.handles[id] = h;
        }

        /*
         * The form's own resize grips, on the border `layoutBounds` already
         * draws.  In another colour than a control's, because they resize a
         * different thing and sitting on the same canvas they would otherwise
         * read as one more selection.
         */
        this.formHandles = {};
        for (const id of FORM_HANDLES) {
            const h = this.bar(FORM_HANDLE_COLOR);
            h.Resize(HANDLE, HANDLE);
            this.formHandles[id] = h;
        }

        /* Alignment guides: one vertical and one horizontal, in another colour
         * so they cannot be mistaken for the selection. */
        this.guides = { v: this.bar(GUIDE_COLOR), h: this.bar(GUIDE_COLOR) };

        /* The form's border and the shading of what falls outside it.  The
         * surface stretches with the window, so without this the declared size
         * is invisible and it is easy to leave controls outside the area the
         * window will really have. */
        this.bounds = [];
        for (let i = 0; i < 4; i++) this.bounds.push(this.bar(BOUNDS_COLOR));

        /* One set of four bars per secondary selection, made on demand. */
        this.extraOutlines = [];
        this.timer = null;
    }

    bar(colour) {
        const panel = new Panel();
        panel.Background = colour;
        panel.Visible    = false;
        this.glass.Add(panel);
        return panel;
    }

    /* --- the selection --------------------------------------------------- */

    show(on) {
        for (const bar of this.outline) bar.Visible = on;
        for (const id in this.handles) this.handles[id].Visible = on;
    }

    /*
     * The chrome is placed with OriginIn, which reads GTK's layout.  A control
     * just created, just moved or rebuilt by an undo has no layout yet, and
     * OriginIn answers (0,0): the outline would be drawn in the corner, the
     * right size but in the wrong place.
     *
     * So a second pass is always scheduled for the next frame.  The first keeps
     * the response immediate when nothing moved; the second fixes it when it
     * did.
     */
    /*
     * Re-draws it now, and again once the layout has landed.
     *
     * **The second pass used to be a single 30 ms guess, and a guess is what it
     * cannot be.** The outline is drawn from the control's *allocation*, and a
     * control that has just been created has none -- so the ring collapses to
     * nothing while the status bar and the property grid, which read the
     * selection itself, both say it is selected. Pasting is where that shows:
     * the control arrives in a clipboard callback and GTK gets round to
     * allocating it after the 30 ms had passed, so nothing ever drew it again
     * and the canvas looked like the paste had not selected anything.
     *
     * So it asks again until the selection has a size, which is the same
     * *wait for the thing, not for a number of frames* the test suite is built
     * on. Bounded, because a control really can be 0x0 -- a page of a notebook
     * that is not on screen has no allocation and never will while it is
     * hidden, and spinning on that would be a timer that never stops.
     */
    position(tries = SETTLE_TRIES) {
        this.layout();

        if (this.timer) this.timer.Stop();
        this.timer = Timer.After(SETTLE_MS, () => {
            this.timer = null;
            this.layout();

            if (tries > 0 && this.unsized()) this.position(tries - 1);
        });
    }

    /* Whether what is selected has no size yet -- which is not the same as
     * nothing being selected, and is the only case worth asking again about. */
    unsized() {
        const primary = this.designer.selected;
        if (!primary) return false;

        const rect = this.designer.rectOf(primary);
        return !rect || rect.w <= 0 || rect.h <= 0;
    }

    /*
     * An outline around every selected control, and handles only when there is
     * one: resizing several at once has no obvious meaning, and offering the
     * handles would suggest it does.
     */
    layout() {
        const d = this.designer;
        this.layoutBounds();

        const pool = this.outlinePool(Math.max(0, d.selection.length - 1));
        for (const bars of pool) for (const bar of bars) bar.Visible = false;

        const primary = d.selected;
        const rect    = primary && d.rectOf(primary);
        if (!rect) {
            this.show(false);
            return;
        }

        this.frameBars(this.outline, rect);

        /* The outline is what says it on the canvas: amber when the control came
         * out bigger than it asked for. */
        const colour = d.overflow(primary) ? OVERFLOW_COLOR : SELECT_COLOR;
        for (const bar of this.outline) {
            bar.Background = colour;
            bar.Visible    = true;
        }

        const single = d.selection.length === 1;
        const half   = HANDLE / 2;
        const at = {
            nw: [rect.x, rect.y],
            n:  [rect.x + rect.w / 2, rect.y],
            ne: [rect.x + rect.w, rect.y],
            w:  [rect.x, rect.y + rect.h / 2],
            e:  [rect.x + rect.w, rect.y + rect.h / 2],
            sw: [rect.x, rect.y + rect.h],
            s:  [rect.x + rect.w / 2, rect.y + rect.h],
            se: [rect.x + rect.w, rect.y + rect.h],
        };
        for (const id in at) {
            this.handles[id].Move(Math.round(at[id][0] - half),
                                  Math.round(at[id][1] - half));
            this.handles[id].Visible = single;
        }

        /* The secondaries, outline only -- and each says for itself whether it
         * fits, since that is a fact about the control and not about the set. */
        let i = 0;
        for (const control of d.selection) {
            if (control === primary) continue;
            const r = d.rectOf(control);
            if (r) {
                const own = d.overflow(control) ? OVERFLOW_COLOR : SELECT_COLOR;
                for (const bar of pool[i]) bar.Background = own;
                this.frameBars(pool[i], r);
            }
            i++;
        }
    }

    /* Which handle is under the pointer.  Only offered when a single control is
     * selected, which is the same rule `layout` draws by. */
    handleAt(x, y) {
        if (this.designer.selection.length !== 1) return null;
        for (const id in this.handles) {
            const h = this.handles[id];
            if (x >= h.X && x < h.X + HANDLE && y >= h.Y && y < h.Y + HANDLE) {
                return id;
            }
        }
        return null;
    }

    /* One set of four bars per secondary control, created on demand and reused
     * afterwards. */
    outlinePool(count) {
        while (this.extraOutlines.length < count) {
            const bars = [];
            for (let i = 0; i < 4; i++) bars.push(this.bar(SELECT_COLOR));
            this.extraOutlines.push(bars);
        }
        return this.extraOutlines;
    }

    frameBars(bars, r) {
        const at = [
            [r.x, r.y, r.w, 1],             // arriba
            [r.x, r.y + r.h - 1, r.w, 1],   // abajo
            [r.x, r.y, 1, r.h],             // izquierda
            [r.x + r.w - 1, r.y, 1, r.h],   // derecha
        ];
        for (let i = 0; i < 4; i++) {
            bars[i].Move(at[i][0], at[i][1]);
            bars[i].Resize(at[i][2], at[i][3]);
            bars[i].Visible = true;
        }
    }

    /* --- the form's border and its grips ---------------------------------- */

    layoutBounds() {
        const gw = this.glass.Width, gh = this.glass.Height;
        if (!this.designer.root || gw <= 0 || gh <= 0) {
            for (const b of this.bounds) b.Visible = false;
            for (const id of FORM_HANDLES) this.formHandles[id].Visible = false;
            return;
        }

        /* Only the border and its grips: what falls outside the form is the
         * scroller's background and needs no laying out.
         *
         * The **client** size and not the declared one: a form with menus has a
         * bar above this layer taking part of the window, so the border of the
         * board is where the canvas ends.  Drawn at the declared height, the
         * bottom edge and its two grips would land below the glass and could not
         * be grabbed at all.  What the grip *does* is unaffected -- a drag moves
         * the window's height, and the two differ by a constant. */
        const { w, h } = this.designer.clientSize();
        this.frameBars(this.bounds, { x: 0, y: 0, w, h });
        this.layoutFormHandles(w, h);
    }

    /* Straddling the border, so the grip is grabbable from either side of it. */
    layoutFormHandles(w, h) {
        const half = HANDLE / 2;
        const at   = { e:  [w, h / 2], s: [w / 2, h], se: [w, h] };

        for (const id of FORM_HANDLES) {
            this.formHandles[id].Move(Math.round(at[id][0] - half),
                                      Math.round(at[id][1] - half));
            this.formHandles[id].Visible = true;
        }
    }

    formHandleAt(x, y) {
        for (const id of FORM_HANDLES) {
            const h = this.formHandles[id];
            if (h.Visible && x >= h.X && x < h.X + HANDLE &&
                y >= h.Y && y < h.Y + HANDLE) {
                return id;
            }
        }
        return null;
    }

    /* --- guides ------------------------------------------------------------
     *
     * A line across the board, where the designer worked out that an edge lines
     * up with another control's -- or, in a box, where a dragged control would
     * land.  The same two bars serve both, which is what they are for: saying
     * where something is about to go.
     */
    showGuide(axis, at, span) {
        const g = this.guides[axis];
        if (axis === "v") { g.Move(Math.round(at), 0); g.Resize(1, span); }
        else              { g.Move(0, Math.round(at)); g.Resize(span, 1); }
        g.Visible = true;
    }

    hideGuide(axis) {
        this.guides[axis].Visible = false;
    }

    hideGuides() {
        this.guides.v.Visible = false;
        this.guides.h.Visible = false;
    }

    /* The boundary a control would be inserted at, drawn across the box. */
    insertionMark(horizontal, at, area) {
        const mark  = horizontal ? this.guides.v : this.guides.h;
        const other = horizontal ? this.guides.h : this.guides.v;

        other.Visible = false;
        if (horizontal) mark.Move(Math.round(at), area.y);
        else            mark.Move(area.x, Math.round(at));
        mark.Resize(horizontal ? 2 : area.w, horizontal ? area.h : 2);
        mark.Visible = true;
    }

    /* --- the rubber band ---------------------------------------------------
     *
     * Drawn with the first spare set of outline bars: a band and a selection
     * never show at the same time, so there is nothing to keep apart.
     */
    showBand(r) {
        this.frameBars(this.outlinePool(1)[0], r);
    }

    hideBand() {
        for (const bar of this.outlinePool(1)[0]) bar.Visible = false;
    }
};
