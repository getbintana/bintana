/*
 * Vector: a sheet of paper and a list of paths, each one an object.
 *
 * **This is a vector editor and not a Paint.** What a stroke stores is a
 * record -- which tool, what colour, how wide, and where -- and a frame replays
 * the list; there are no pixels until `Save` or `Copy` rasterizes. Three
 * consequences follow, and they are the ones a bitmap editor would not have:
 * the bucket fills *a shape* because there are no pixel colours to flood, the
 * eraser strokes the paper because it cannot reveal what is under, and a fill
 * belongs to a record because there is no region. (`docs/plans/bitmap-plan.md`
 * is the plan for the runtime object that would change that.)
 *
 * What it is worth reading for:
 *
 *   - **A drawing is a list, and every frame replays it.** Each stroke is a
 *     record -- which tool, what colour, how wide, and where -- kept in
 *     `shapes`, and `Draw` walks the list. That gives Undo and Redo for a
 *     snapshot each, and `Save` for nothing: `DrawingArea.Save` runs this same
 *     handler against an image surface, so the PNG is the operations and not a
 *     screenshot -- with the screen's chrome left out, which is what
 *     `exporting` is for.
 *   - **The paper is painted in `Draw`, not set as the control's background.**
 *     A control paints no ground of its own, and a ground that is a property
 *     would be missing from the exported file -- the half nobody notices until
 *     the PNG is opened somewhere dark. The eraser is a stroke in the same
 *     colour, for the same reason.
 *   - **The sheet has a size, and the view scrolls it.** The canvas declares
 *     its size in the `.form`; the `Scroller` around it grows bars when the
 *     window is smaller, and the corner grip resizes the sheet. A resize is a
 *     step of the history like a stroke, so Undo takes it back -- which is why
 *     a step is the records *and* the size.
 *   - **`MouseMove` says where the pointer is and not whether a button is
 *     down**: its `button` argument is `0`. So the drag is the application's --
 *     `MouseDown` starts a record, `MouseMove` grows it, `MouseUp` files it --
 *     which is also what makes the shape tools, the marquee and the brush
 *     outline possible.
 *   - **A selection is pixels, taken with the painter that drew them.** The
 *     model has no pixels to cut, so Copy runs the same drawing again through
 *     `Drawing.ToPng` against a surface the size of the marquee and hands the
 *     bytes to the clipboard -- which is why the copy can be pasted into
 *     another program and a picture from another program can be pasted here.
 *   - **The bucket paints a shape, not a region.** A vector model has no pixel
 *     colours to flood, so the click finds the topmost closed record under it
 *     and fills *its interior* -- the outline keeps the colour it was drawn
 *     with, which is why a record carries a stroke and a fill separately.
 *   - **The tools are buttons, and their group is code.** A `ToggleButton` has
 *     no `Group`, so `choose` clears the rest -- and because assigning `Active`
 *     raises `Click`, it guards itself. The icons are the project's own, in
 *     `icons/`, so they are the same drawing on every desktop; the words are
 *     the tooltips, where they are translated.
 *   - **The Edit tool makes a record an object.** A click selects the topmost
 *     path under the pointer (by its box, so an unfilled shape can be caught),
 *     a drag moves it, a handle reshapes it, `Delete` removes it, and the
 *     style controls apply to it -- every one of those a record *replaced and
 *     committed*, so Undo covers an edit like a stroke. A drag of the opacity
 *     slider is one step and not fifty: the first change commits and the rest
 *     write over the same entry until something else commits.
 *   - **A line colour and a fill colour, and an opacity for both.** The record
 *     keeps `Color` for its outline and `FillColor` for its interior, so the
 *     bucket and the two swatches cannot repaint the wrong one; the slider is
 *     read when a stroke starts and stored as `Alpha`, so moving it later does
 *     not repaint what is drawn.
 *   - **The order is the array's, and it is editable.** The last record drawn
 *     is the one on top, so Raise and Lower are a swap in `shapes` -- and the
 *     selected index follows the record, or the handles would end up on the
 *     neighbour.
 *   - **A polyline is placed one click at a time and is not a record until it
 *     ends.** `polyline` is the one being clicked and `polyPreview` draws it;
 *     `Return`, a double click, or a click on the first point -- which closes
 *     it into a polygon -- is what pushes it. Because it is an ordinary
 *     `Points` record, it then moves, scales, restyles and is deleted like any
 *     other path.
 *
 * The shapes are drawn as they are described -- a rectangle is four corners, a
 * line is two points -- and the ellipse is sampled, which is also the simplest
 * way to say what it is: a circle with two different radii.
 */
"use strict";

/*
 * What a blank sheet is. A drawing is a document and documents are white --
 * `lib/report` pins its ink for the same reason. The eraser strokes in this
 * exact value, so the two are one constant and cannot drift apart.
 */
const PAPER = "#ffffff";

/* The sheet: how big the corner grip is, and the smallest a page may become.
 * The page's own size is declared by the canvas in the `.form` and read in
 * `Form_Open`, so there is one place it starts from. */
const GRIP     = 14;
const MIN_PAGE = 64;

/* The colour with an alpha on it, which is what the opacity slider buys.
 * `rgb(...)` is what the chooser answers with and `#rrggbb` is what a `.form`
 * writes, so both are read -- the pair `lib/charts` reads. */
function withAlpha(colour, a) {
    const rgb = colour.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (rgb) return `rgba(${rgb[1]},${rgb[2]},${rgb[3]},${a})`;

    const hex = colour.match(/^#([0-9a-f]{6})$/i);
    if (hex) {
        const n = parseInt(hex[1], 16);
        return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
    }
    return colour;
}

/* The tools, in the order the buttons stand and the digits pick them: the
 * control's name and the key the code speaks. The words are the buttons'
 * tooltips, in the `.form`, where they are translated. */
const TOOLS = [
    ["BtnEdit",    "edit"],
    ["BtnPencil",  "pencil"],
    ["BtnEraser",  "eraser"],
    ["BtnLine",    "line"],
    ["BtnPoly",    "polyline"],
    ["BtnRect",    "rectangle"],
    ["BtnEllipse", "ellipse"],
    ["BtnBucket",  "bucket"],
    ["BtnSelect",  "select"],
];

/* An ellipse inside a box, as the flat `[x, y, …]` array `Polygon`/`Polyline`
 * take. Four degrees is ninety points, which is smooth at any size a drawing
 * reaches; the alternative is a circle under a non-uniform scale, and the pen
 * would be scaled with it. */
function ellipsePoints(x, y, w, h) {
    const cx = x + w / 2, cy = y + h / 2;
    const rx = w / 2, ry = h / 2;
    const out = [];

    for (let a = 0; a < 360; a += 4) {
        const r = a * Math.PI / 180;
        out.push(cx + rx * Math.cos(r), cy + ry * Math.sin(r));
    }
    return out;
}

/* The bucket's question: is this point inside that closed record? A rectangle
 * and a sampled ellipse are boxes; a closed polyline is a polygon. */
function inside(s, x, y) {
    if (s.Kind === "polyline")
        return s.Closed ? insidePolygon(s.Points, x, y) : false;

    const x0 = Math.min(s.X0, s.X1), y0 = Math.min(s.Y0, s.Y1);
    const w = Math.abs(s.X1 - s.X0), h = Math.abs(s.Y1 - s.Y0);

    if (w < 1 || h < 1) return false;
    if (s.Kind === "rectangle")
        return x >= x0 && x <= x0 + w && y >= y0 && y <= y0 + h;

    const dx = (x - (x0 + w / 2)) / (w / 2);
    const dy = (y - (y0 + h / 2)) / (h / 2);
    return dx * dx + dy * dy <= 1;
}

/* The even-odd rule, one ray to the right. */
function insidePolygon(p, x, y) {
    let hit = false;

    for (let i = 0, j = p.length - 2; i < p.length; i += 2) {
        if ((p[i + 1] > y) !== (p[j + 1] > y) &&
            x < (p[j] - p[i]) * (y - p[i + 1]) / (p[j + 1] - p[i + 1]) + p[i])
            hit = !hit;
        j = i;
    }
    return hit;
}

class VectorForm extends Form {

    shapes    = [];      /* the records, oldest first */
    history   = [];      /* the page at each step: {Shapes, W, H} */
    at        = 0;
    pageW     = 0;       /* the sheet's size, which the canvas is */
    pageH     = 0;
    drag      = null;    /* the stroke still under the pointer */
    marquee   = null;    /* the selection being dragged */
    selection = null;    /* {X, Y, W, H}, in canvas coordinates */
    floating  = null;    /* a pasted picture, until a click lands it */
    resizing  = null;    /* the size a corner drag started from */
    pointer   = null;    /* where the pointer is, for the brush outline */
    exporting = false;   /* a frame being written, not shown */
    toolKey   = "pencil";/* which tool the buttons have in */
    picks     = [];      /* [{Button, Key}], the tool row */
    choosing  = false;   /* a tool being set: assigning Active raises Click */
    edited    = null;    /* the index the Edit tool has, or null */
    editing   = null;    /* the drag under way on it */
    restyling = false;   /* a style change already made this history step */
    polyline  = null;    /* the polyline being clicked, before it is a record */

    Form_Open() {
        /* One button per tool, and one of them in at a time: a `ToggleButton`
         * has no group, so the group is this loop. `choosing` is the other
         * half -- assigning `Active` raises `Click`, which comes back here --
         * and it is what keeps picking a tool from being a loop. */
        for (const [name, key] of TOOLS) {
            const button = this[name];

            button.On("Click", () => this.choose(key));
            this.picks.push({ Button: button, Key: key });
        }
        this.choose("pencil");

        /* The style controls apply to the path the Edit tool has, live. */
        this.Colour.On("Change",     () => this.restyle());
        this.FillColour.On("Change", () => this.restyle());
        this.Alpha.On("Change",      () => this.restyle());
        this.Brush.On("Change",      () => this.restyle());
        this.ChkFill.On("Click",     () => this.restyle());

        /* The order of the selected path. */
        this.BtnRaise.On("Click", () => this.raiseEdited());
        this.BtnLower.On("Click", () => this.lowerEdited());

        /* The sheet's size is the canvas' declaration in the `.form`, read here
         * so the two cannot drift -- and the blank page is the first step of
         * the history, size included. */
        this.pageW   = this.Canvas.Width;
        this.pageH   = this.Canvas.Height;
        this.history = [{ Shapes: [], W: this.pageW, H: this.pageH }];
        this.at      = 0;

        this.restack();

        /* A picture named on the command line is placed behind the empty
         * drawing, the same road the button and the drop take. */
        const given = Application.Arguments[0];
        if (given) this.place(given);
    }

    /* ------------------------------------------------------------ the frame */

    Canvas_Draw(p, width, height) {
        this.paintPage(p, 0, 0, width, height);

        /*
         * The chrome -- the pasted float, the stroke under the pointer, the
         * brush ring, the marquee and the corner grip -- is the screen's and
         * not the page's.
         *
         * `Save` runs this same handler against an image surface, so the frame
         * it makes would carry the grip in its corner and the marquee over the
         * drawing. `exporting` is what tells the two apart: raised for the
         * length of the call, and the page alone is what is written.
         */
        if (this.exporting) return;

        /* What is not part of the page yet: the pasted picture, and the stroke
         * still under the pointer -- or, with no button down, where the brush
         * would land. */
        if (this.floating) this.paint(p, this.floating);
        if (this.polyline) this.polyPreview(p);
        if (this.drag) this.paint(p, this.drag);
        else if (this.pointer && !this.floating && !this.marquee && !this.polyline)
            this.brushRing(p);

        const m = this.marquee;
        if (m) this.marqueeRect(p, m.X0, m.Y0, m.X1, m.Y1);
        else if (this.selection) this.marqueeRect(p, this.selection.X, this.selection.Y,
                                                  this.selection.X + this.selection.W,
                                                  this.selection.Y + this.selection.H);

        this.pageGrip(p);

        if (this.edited !== null && this.edited < this.shapes.length)
            this.editMarks(p, this.shapes[this.edited]);
    }

    /* The page itself -- the part a copy takes with it. */
    paintPage(p, x, y, w, h) {
        p.Antialias = true;
        p.Color = PAPER;
        p.Rectangle(x, y, w, h);
        p.Fill();

        for (const s of this.shapes) this.paint(p, s);
    }

    /* One record, however it was made. Every field the painter keeps is set on
     * every frame rather than once, because there is one painter per control
     * and it outlives the frame. */
    paint(p, s) {
        if (s.Kind === "image") {
            /* A path decodes once and is cached by it; bytes decode on every
             * frame, because a pointer can be freed and reused and a cache
             * keyed on one would eventually paint the wrong picture. A pasted
             * selection is repainted per frame and pays that, which is what
             * having no file for it costs. */
            p.Image(s.Source, s.X0, s.Y0, s.W, s.H);
            return;
        }

        p.Antialias = true;
        p.LineDash  = [];            /* the marquee leaves it dashed */
        p.Color     = withAlpha(s.Color, s.Alpha === undefined ? 1 : s.Alpha);
        p.LineWidth = s.Width;
        p.LineCap   = "Round";       /* so a click is a dot and not nothing */
        p.LineJoin  = "Round";
        const stroke = p.Color;

        if (s.Points.length) {       /* pencil, eraser and polyline: a run of points */
            if (s.Closed && s.Fill) {
                p.Color = withAlpha(s.FillColor || s.Color,
                                    s.FillAlpha === undefined ? 1 : s.FillAlpha);
                p.Polygon(s.Points);
                p.Fill();
                p.Color = stroke;
            }
            p.Polyline(s.Points);
            if (s.Closed) p.ClosePath();
            p.Stroke();
            return;
        }

        const x = Math.min(s.X0, s.X1), y = Math.min(s.Y0, s.Y1);
        const w = Math.abs(s.X1 - s.X0), h = Math.abs(s.Y1 - s.Y0);

        if (s.Kind === "line") {
            p.MoveTo(s.X0, s.Y0);
            p.LineTo(s.X1, s.Y1);
            p.Stroke();
            return;
        }

        const box = s.Kind === "rectangle"
                  ? [x, y, x + w, y, x + w, y + h, x, y + h]
                  : ellipsePoints(x, y, w, h);

        if (s.Fill) {
            /* The interior is its own colour: the bucket paints the fill and
             * leaves the outline the one it was drawn with. */
            p.Color = withAlpha(s.FillColor || s.Color,
                                s.FillAlpha === undefined ? 1 : s.FillAlpha);
            p.Polygon(box);
            p.Fill();                /* clears the path, so it is built again */
            p.Color = stroke;
        }
        p.Polygon(box);
        p.Stroke();
    }

    /* A ring the size of what the next stroke covers, drawn in a light and a
     * dark hairline so it reads over the paper and over a placed picture. */
    brushRing(p) {
        const r = Math.max(2, this.brushWidth(this.tool()) / 2);

        p.LineDash  = [];
        p.LineWidth = 1;
        p.Color = "rgba(255,255,255,0.8)";
        p.Arc(this.pointer.X, this.pointer.Y, r + 1, 0, 360);
        p.Stroke();

        p.Color = "rgba(0,0,0,0.6)";
        p.Arc(this.pointer.X, this.pointer.Y, r, 0, 360);
        p.Stroke();
    }

    /* A polyline being clicked: the segments placed so far, the one still
     * under the pointer in a fainter ink, and the first point -- the one a
     * click closes it on. */
    polyPreview(p) {
        const s      = this.polyline;
        const points = s.Points;

        p.Antialias = true;
        p.LineDash  = [];
        p.LineCap   = "Round";
        p.LineJoin  = "Round";

        if (this.pointer) {
            p.Color     = withAlpha(s.Color, Math.max(0.15, s.Alpha * 0.35));
            p.LineWidth = s.Width;
            p.MoveTo(points[points.length - 2], points[points.length - 1]);
            p.LineTo(this.pointer.X, this.pointer.Y);
            p.Stroke();
        }

        p.Color     = withAlpha(s.Color, s.Alpha);
        p.LineWidth = s.Width;
        p.Polyline(points);
        p.Stroke();

        p.Color = "rgba(255,255,255,0.95)";
        p.Rectangle(points[0] - 3, points[1] - 3, 6, 6);
        p.Fill();

        p.Color = "rgba(0,0,0,0.85)";
        p.Rectangle(points[0] - 3, points[1] - 3, 6, 6);
        p.Stroke();
    }

    /* The marching ants, standing still: a white hairline under a black dashed
     * one reads over the paper and over a picture alike. */
    marqueeRect(p, x0, y0, x1, y1) {
        const x = Math.min(x0, x1), y = Math.min(y0, y1);
        const w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);

        p.LineCap   = "Butt";
        p.LineWidth = 1;

        p.LineDash = [];
        p.Color = "rgba(255,255,255,0.9)";
        p.Rectangle(x, y, w, h);
        p.Stroke();

        p.LineDash = [4, 4];
        p.Color = "rgba(0,0,0,0.85)";
        p.Rectangle(x, y, w, h);
        p.Stroke();
        p.LineDash = [];
    }

    /* The sheet's corner resizes it: the one place on the page that is never a
     * place to draw, and the grip every window has. Drawn as three diagonals,
     * in a light and a dark hairline so it reads over the paper and over a
     * placed picture. */
    nearGrip(x, y) {
        return x >= this.pageW - GRIP && y >= this.pageH - GRIP;
    }

    pageGrip(p) {
        p.LineDash  = [];
        p.LineWidth = 1;

        for (let i = 0; i < 3; i++) {
            const d = 5 + i * 5;

            p.Color = "rgba(255,255,255,0.8)";
            p.MoveTo(this.pageW - d - 1, this.pageH - 1);
            p.LineTo(this.pageW - 1, this.pageH - d - 1);
            p.Stroke();

            p.Color = "rgba(0,0,0,0.45)";
            p.MoveTo(this.pageW - d, this.pageH - 1);
            p.LineTo(this.pageW - 1, this.pageH - d);
            p.Stroke();
        }
    }

    /* ------------------------------------------------------------- editing
     *
     * The Edit tool turns a record into an object: `edited` is the index it
     * has and `editing` the drag under way on it. Every change replaces the
     * record -- the history's snapshots hold the same objects, so a field
     * written in place would rewrite the past -- and commits once, on release.
     */

    /* The box a record occupies. A click selects by it, because an unfilled
     * shape has no interior to hit and its outline is a couple of pixels. */
    boundsOf(s) {
        if (s.Kind === "image")
            return { X: s.X0, Y: s.Y0, W: s.W, H: s.H };

        if (s.Points.length) {
            let x0 = s.Points[0], y0 = s.Points[1];
            let x1 = x0, y1 = y0;

            for (let i = 2; i < s.Points.length; i += 2) {
                x0 = Math.min(x0, s.Points[i]);
                y0 = Math.min(y0, s.Points[i + 1]);
                x1 = Math.max(x1, s.Points[i]);
                y1 = Math.max(y1, s.Points[i + 1]);
            }
            return { X: x0, Y: y0, W: x1 - x0, H: y1 - y0 };
        }

        return { X: Math.min(s.X0, s.X1), Y: Math.min(s.Y0, s.Y1),
                 W: Math.abs(s.X1 - s.X0), H: Math.abs(s.Y1 - s.Y0) };
    }

    /* Topmost first: what a click lands on is the last path drawn over it. */
    hitShape(x, y) {
        for (let i = this.shapes.length - 1; i >= 0; i--) {
            const b = this.boundsOf(this.shapes[i]);

            if (x >= b.X - 3 && x <= b.X + b.W + 3 &&
                y >= b.Y - 3 && y <= b.Y + b.H + 3)
                return i;
        }
        return -1;
    }

    /* A path's own control points: a line's ends, a rectangle's or an
     * ellipse's two corners, a picture's size, a polyline's vertices -- each
     * dragged on its own -- and a stroke's box, which is what scales it: a
     * pencil's points are samples of a hand and not nodes to aim at. */
    handlesOf(s) {
        if (s.Kind === "image")
            return [{ X: s.X0, Y: s.Y0 }, { X: s.X0 + s.W, Y: s.Y0 + s.H }];

        if (s.Points.length) {
            if (s.Kind === "polyline") {
                const points = [];

                for (let i = 0; i < s.Points.length; i += 2)
                    points.push({ X: s.Points[i], Y: s.Points[i + 1] });
                return points;
            }

            const b = this.boundsOf(s);

            return [{ X: b.X, Y: b.Y }, { X: b.X + b.W, Y: b.Y },
                    { X: b.X + b.W, Y: b.Y + b.H }, { X: b.X, Y: b.Y + b.H }];
        }

        return [{ X: s.X0, Y: s.Y0 }, { X: s.X1, Y: s.Y1 }];
    }

    handleAt(s, x, y) {
        const points = this.handlesOf(s);

        for (let i = 0; i < points.length; i++)
            if (Math.abs(x - points[i].X) <= 7 && Math.abs(y - points[i].Y) <= 7)
                return i;
        return -1;
    }

    movedShape(s, dx, dy) {
        if (s.Kind === "image")
            return { ...s, X0: s.X0 + dx, Y0: s.Y0 + dy };

        if (s.Points.length) {
            const points = [];

            for (let i = 0; i < s.Points.length; i += 2)
                points.push(s.Points[i] + dx, s.Points[i + 1] + dy);
            return { ...s, Points: points };
        }

        return { ...s, X0: s.X0 + dx, Y0: s.Y0 + dy,
                        X1: s.X1 + dx, Y1: s.Y1 + dy };
    }

    /* A handle dragged, against the record **as it was when the drag started**:
     * a polyline's handle is one of its vertices and moves only that point,
     * and a stroke scales its samples from its box -- both from the start, so
     * a rounding never accumulates event by event. */
    resizedShape(start, at, x, y) {
        if (start.Kind === "image") {
            if (at === 0)
                return { ...start, X0: x, Y0: y,
                         W: Math.max(4, start.W + (start.X0 - x)),
                         H: Math.max(4, start.H + (start.Y0 - y)) };

            return { ...start, W: Math.max(4, x - start.X0),
                               H: Math.max(4, y - start.Y0) };
        }

        if (!start.Points.length)
            return at === 0 ? { ...start, X0: x, Y0: y }
                            : { ...start, X1: x, Y1: y };

        /* A polyline's handle is one of its vertices: only that point moves,
         * and the segments beside it follow. */
        if (start.Kind === "polyline") {
            const points = start.Points.slice();

            points[at * 2]     = x;
            points[at * 2 + 1] = y;
            return { ...start, Points: points };
        }

        const was   = this.boundsOf(start);
        const right = was.X + was.W, bottom = was.Y + was.H;
        let   box;

        if      (at === 0) box = { X: x, Y: y, W: right - x, H: bottom - y };
        else if (at === 1) box = { X: was.X, Y: y, W: x - was.X, H: bottom - y };
        else if (at === 2) box = { X: was.X, Y: was.Y, W: x - was.X, H: y - was.Y };
        else               box = { X: x, Y: was.Y, W: right - x, H: y - was.Y };

        const sx = was.W > 0.5 ? Math.max(0.01, box.W) / was.W : 1;
        const sy = was.H > 0.5 ? Math.max(0.01, box.H) / was.H : 1;
        const points = [];

        for (let i = 0; i < start.Points.length; i += 2)
            points.push(box.X + (start.Points[i] - was.X) * sx,
                        box.Y + (start.Points[i + 1] - was.Y) * sy);

        return { ...start, Points: points };
    }

    /* What the Edit tool shows: the box it selected and the handles that
     * reshape it, drawn last so they are on top of everything. */
    editMarks(p, s) {
        const b = this.boundsOf(s);

        this.marqueeRect(p, b.X, b.Y, b.X + b.W, b.Y + b.H);

        p.LineDash  = [];
        p.LineWidth = 1;

        for (const h of this.handlesOf(s)) {
            p.Color = "rgba(255,255,255,0.95)";
            p.Rectangle(h.X - 3, h.Y - 3, 6, 6);
            p.Fill();

            p.Color = "rgba(0,0,0,0.85)";
            p.Rectangle(h.X - 3, h.Y - 3, 6, 6);
            p.Stroke();
        }
    }

    editDown(x, y) {
        const at = this.edited;

        /* A handle first: the points sit on top of the path they shape. */
        if (at !== null && at < this.shapes.length) {
            const handle = this.handleAt(this.shapes[at], x, y);

            if (handle >= 0) {
                this.editing = { At: at, Handle: handle,
                                 Start: this.shapes[at], X: x, Y: y, Moved: false };
                return;
            }
        }

        const hit = this.hitShape(x, y);

        this.edited = hit >= 0 ? hit : null;

        /* A handle under the click works on the first press too, so a vertex
         * is grabbed where it is and not only after the path was selected. */
        const handle = hit >= 0 ? this.handleAt(this.shapes[hit], x, y) : -1;

        this.editing = hit >= 0
                     ? { At: hit, Handle: handle, Start: this.shapes[hit],
                         X: x, Y: y, Moved: false }
                     : null;
        this.restack();
    }

    /* The style controls, applied to the path being edited. The first change
     * opens a history step and the rest of the adjustment writes over it, so
     * a drag of the opacity slider is one Undo and not fifty. */
    restyle() {
        if (this.edited === null || this.edited >= this.shapes.length) return;

        const s = this.shapes[this.edited];
        if (s.Kind === "image") return;      /* a picture has no colour of its own */

        const line  = this.Colour.Value || "#000000";
        const alpha = this.alpha();

        this.shapes[this.edited] = { ...s, Color: line, Alpha: alpha,
                                     Width: this.Brush.Value,
                                     Fill: this.ChkFill.Active,
                                     FillColor: this.FillColour.Value || line,
                                     FillAlpha: alpha };

        if (this.restyling) {
            this.history[this.at] = { Shapes: this.shapes.slice(),
                                      W: this.pageW, H: this.pageH };
            this.Canvas.Redraw();
        } else {
            this.commit();               /* clears the flag... */
            this.restyling = true;       /* ...and the adjustment rides it */
        }
    }

    deleteEdited() {
        if (this.edited === null) return;

        this.shapes.splice(this.edited, 1);
        this.edited  = null;
        this.editing = null;
        this.commit();
        this.say(Locale.Text("Deleted"));
    }

    /* The selected path one place up or down the pile: the last one drawn is
     * the one on top, so the order is the array's. */
    raiseEdited() {
        const at = this.edited;
        if (at === null || at >= this.shapes.length - 1) return;

        const s = this.shapes[at];
        this.shapes[at]     = this.shapes[at + 1];
        this.shapes[at + 1] = s;
        this.edited = at + 1;
        this.commit();
        this.say(Locale.Text("Raised"));
    }

    lowerEdited() {
        const at = this.edited;
        if (at === null || at <= 0) return;

        const s = this.shapes[at];
        this.shapes[at]     = this.shapes[at - 1];
        this.shapes[at - 1] = s;
        this.edited = at - 1;
        this.commit();
        this.say(Locale.Text("Lowered"));
    }

    /* ----------------------------------------------------------- the polyline
     *
     * A polyline is placed one click at a time, so it is not a record until it
     * ends: `polyline` is the one being clicked, drawn as a preview, and the
     * end -- Return, a double click, or a click on the first point, which
     * closes it into a polygon -- is what pushes it and commits.
     */

    polyDown(x, y) {
        const line  = this.Colour.Value || "#000000";
        const alpha = this.alpha();

        if (!this.polyline) {
            this.polyline = {
                Kind: "polyline", Points: [x, y], Closed: false,
                Color: line, Alpha: alpha, Width: this.Brush.Value,
                Fill: this.ChkFill.Active,
                FillColor: this.FillColour.Value || line, FillAlpha: alpha,
            };
            this.Canvas.Redraw();
            return;
        }

        const first = this.polyline.Points;

        /* A click on the first point closes it, which needs a triangle at
         * least: three points are six numbers. */
        if (first.length >= 6 &&
            Math.abs(x - first[0]) <= 8 && Math.abs(y - first[1]) <= 8) {
            this.polyline.Closed = true;
            this.finishPolyline();
            return;
        }

        first.push(x, y);
        this.Canvas.Redraw();
    }

    finishPolyline() {
        if (!this.polyline) return;

        const s = this.polyline;
        this.polyline = null;

        if (s.Points.length < 4) {            /* a click that made no line */
            this.Canvas.Redraw();
            return;
        }

        /* A double click places a point and then ends the path: the duplicate
         * is dropped so the record does not carry it. */
        const n = s.Points.length;
        if (n >= 4 && s.Points[n - 2] === s.Points[n - 4] &&
                      s.Points[n - 1] === s.Points[n - 3])
            s.Points.length -= 2;

        this.shapes.push(s);
        this.commit();
        this.say(Locale.Text("Polyline: {0} points", s.Points.length / 2));
    }

    /* ------------------------------------------------------------ the pointer */

    Canvas_MouseDown(x, y, button) {
        if (button !== 1) return;

        if (this.floating) {                  /* a pasted picture lands here */
            this.floating.X0 = x - this.floating.W / 2;
            this.floating.Y0 = y - this.floating.H / 2;
            this.shapes.push(this.floating);
            this.floating = null;
            this.commit();
            this.say(Locale.Text("Pasted"));
            return;
        }

        /* The corner grip resizes the sheet whatever tool is chosen, because
         * that corner is chrome and not paper. */
        if (this.nearGrip(x, y)) {
            this.resizing = { W: this.pageW, H: this.pageH };
            return;
        }

        const kind = this.tool();

        if (kind === "edit") {
            this.editDown(x, y);
            return;
        }

        if (kind === "select") {
            this.marquee = { X0: x, Y0: y, X1: x, Y1: y };
            this.Canvas.Redraw();
            return;
        }

        if (kind === "polyline") {
            this.polyDown(x, y);
            return;
        }

        this.selection = null;                /* a tool that draws drops the marquee */

        if (kind === "bucket") {
            this.bucket(x, y);
            return;
        }

        const inked = kind === "eraser" ? PAPER : (this.Colour.Value || "#000000");
        const alpha = kind === "eraser" ? 1 : this.alpha();

        /* The settings are taken once, when the stroke starts: changing the
         * colours, the opacity or the width must not repaint what is already
         * drawn. The eraser is paper and opaque whatever the slider says. */
        this.drag = {
            Kind:      kind,
            Color:     inked,
            Alpha:     alpha,
            Fill:      this.ChkFill.Active,
            FillColor: this.FillColour.Value || inked,
            FillAlpha: alpha,
            Width:     this.brushWidth(kind),
            Points:    kind === "pencil" || kind === "eraser" ? [x, y] : [],
            X0: x, Y0: y, X1: x, Y1: y,
        };
        this.Canvas.Redraw();
    }

    Canvas_MouseMove(x, y) {
        if (this.resizing) {                  /* the corner follows the pointer */
            this.pageW = Math.max(MIN_PAGE, Math.round(x));
            this.pageH = Math.max(MIN_PAGE, Math.round(y));
            this.Canvas.Resize(this.pageW, this.pageH);
            this.showSize();
            this.Canvas.Redraw();
            return;
        }

        if (this.editing) {                   /* a path moved or a handle dragged */
            const e = this.editing;
            const s = e.Handle >= 0
                    ? this.resizedShape(e.Start, e.Handle, x, y)
                    : this.movedShape(e.Start, x - e.X, y - e.Y);

            e.Moved = true;
            this.shapes[e.At] = s;
            this.Canvas.Redraw();
            return;
        }

        if (this.floating) {                  /* it follows the pointer, centred */
            this.floating.X0 = x - this.floating.W / 2;
            this.floating.Y0 = y - this.floating.H / 2;
            this.Canvas.Redraw();
            return;
        }

        if (this.marquee) {
            this.marquee.X1 = x;
            this.marquee.Y1 = y;
            this.Canvas.Redraw();
            return;
        }

        const s = this.drag;
        if (!s) {                             /* no button: the outline follows */
            this.pointer = { X: x, Y: y };
            this.Canvas.Redraw();
            return;
        }

        if (s.Points.length) s.Points.push(x, y);
        s.X1 = x;
        s.Y1 = y;
        this.Canvas.Redraw();
    }

    Canvas_MouseLeave() {
        this.pointer = null;
        this.Canvas.Redraw();
    }

    Canvas_MouseUp(x, y) {
        if (this.resizing) {
            const was = this.resizing;

            this.resizing = null;
            if (was.W !== this.pageW || was.H !== this.pageH) {
                this.commit();                /* a resize is one step */
                this.say(Locale.Text("Page {0} x {1}", this.pageW, this.pageH));
            } else {
                this.hint();
            }
            return;
        }

        if (this.editing) {
            const e = this.editing;

            this.editing = null;
            if (e.Moved) this.commit();
            else this.Canvas.Redraw();
            return;
        }

        if (this.marquee) {
            const m = this.marquee;
            const X = Math.min(m.X0, m.X1), Y = Math.min(m.Y0, m.Y1);
            const W = Math.abs(m.X1 - m.X0), H = Math.abs(m.Y1 - m.Y0);

            this.marquee   = null;
            this.selection = W >= 2 && H >= 2 ? { X: X, Y: Y, W: W, H: H } : null;
            this.restack();
            this.say(this.selection
                ? Locale.Text("Selected {0} x {1} · Ctrl+C copies",
                              Math.round(W), Math.round(H))
                : Locale.Text("Nothing selected"));
            return;
        }

        const s = this.drag;
        if (!s) return;

        s.X1 = x;
        s.Y1 = y;
        this.shapes.push(s);
        this.drag = null;
        this.commit();
    }

    /* A double click ends the polyline, the point it landed having already
     * been placed by the second press -- `finishPolyline` drops the
     * duplicate. */
    Canvas_DblClick() {
        if (this.polyline) this.finishPolyline();
    }

    tool() { return this.toolKey; }

    /* Picking one clears the rest. The guard is not a nicety: assigning
     * `Active` raises `Click`, so clearing the others would call this again
     * for each of them. */
    choose(key) {
        if (this.choosing) return;

        this.choosing = true;
        this.toolKey  = key;
        for (const p of this.picks) p.Button.Active = (p.Key === key);
        this.choosing = false;

        /* A tool that draws does not want the handles standing over the paper,
         * and leaving the polyline tool ends the one being clicked. */
        if (key !== "edit") {
            this.edited  = null;
            this.editing = null;
        }
        if (key !== "polyline") this.finishPolyline();

        this.Canvas.Redraw();           /* the ring is the tool's size */
    }

    /* The opacity slider, as the 0..1 an `rgba()` colour takes. */
    alpha() {
        return Math.max(0, Math.min(1, this.Alpha.Value / 100));
    }

    brushWidth(kind) {
        return kind === "eraser" ? Math.max(12, this.Brush.Value * 4)
                                 : this.Brush.Value;
    }

    /* ---------------------------------------------------------------- the model
     *
     * Undo and Redo are snapshots of the page and not a stack of records,
     * because a record can be *edited* -- the bucket recolours one -- and an
     * inverse for every kind of edit is an operation log this program does not
     * need. A snapshot is a shallow copy: records are never mutated once they
     * are in the list, which is what makes sharing them safe.
     *
     * The sheet's size is part of a step, because a resize is one.
     */
    commit() {
        this.history.length = this.at + 1;    /* a new step forgets the redo */
        this.history.push({ Shapes: this.shapes.slice(),
                            W: this.pageW, H: this.pageH });
        this.at = this.history.length - 1;
        this.restyling = false;               /* the next style change is its own */
        this.restack();
    }

    restore(state) {
        this.shapes = state.Shapes.slice();
        this.pageW  = state.W;
        this.pageH  = state.H;
        this.Canvas.Resize(this.pageW, this.pageH);
        this.selection = null;
        this.edited    = null;                /* the index may mean another path now */
        this.editing   = null;
        this.polyline  = null;
        this.restack();
    }

    undo() {
        if (this.at <= 0) return;

        this.at--;
        this.restore(this.history[this.at]);
    }

    redo() {
        if (this.at >= this.history.length - 1) return;

        this.at++;
        this.restore(this.history[this.at]);
    }

    /* One place that answers the buttons and the frame, so a way in that
     * forgets one of them cannot leave the bar lying about it. */
    restack() {
        this.BtnUndo.Enabled  = this.at > 0;
        this.BtnRedo.Enabled  = this.at < this.history.length - 1;
        this.BtnCopy.Enabled  = this.selection !== null;
        this.BtnRaise.Enabled = this.edited !== null &&
                                this.edited < this.shapes.length - 1;
        this.BtnLower.Enabled = this.edited !== null && this.edited > 0;
        this.Canvas.Redraw();
    }

    /* ------------------------------------------------------------------ tools */

    /*
     * The bucket: the topmost closed record under the click takes the colour
     * **in its interior**. The outline is the shape's own stroke colour and
     * stays as it was drawn -- repainting it is the one thing a bucket must
     * not do, since the line is what the fill is bounded by.
     *
     * A vector model has no pixel colours, so "fill the region" is not a
     * question it can answer -- what it can answer is "which shape did you
     * click", and that is the useful half.
     *
     * The record is **replaced, not changed**: the history's snapshots hold the
     * same objects, so a field written in place would rewrite the past.
     */
    bucket(x, y) {
        const ink = this.FillColour.Value || this.Colour.Value || "#000000";

        for (let i = this.shapes.length - 1; i >= 0; i--) {
            const s = this.shapes[i];
            if ((s.Kind !== "rectangle" && s.Kind !== "ellipse") || !inside(s, x, y))
                continue;

            this.shapes[i] = { ...s, Fill: true,
                               FillColor: ink, FillAlpha: this.alpha() };
            this.commit();
            this.say(Locale.Text("Painted"));
            return;
        }

        this.restack();                       /* the marquee went, if one was up */
        this.say(Locale.Text("Nothing closed to paint there"));
    }

    /* ------------------------------------------------------------------ the bar */

    BtnUndo_Click() {
        if (this.at <= 0) return;

        this.undo();
        this.say(Locale.Text("Undone"));
    }

    BtnRedo_Click() {
        if (this.at >= this.history.length - 1) return;

        this.redo();
        this.say(Locale.Text("Redone"));
    }

    BtnClear_Click() {
        this.shapes    = [];
        this.drag      = null;
        this.floating  = null;
        this.selection = null;
        this.edited    = null;
        this.editing   = null;
        this.polyline  = null;
        this.commit();                        /* clearing is undoable now */
        this.say(Locale.Text("Blank again"));
    }

    /*
     * A picture goes **under** the drawing, as the first record: a paint
     * program's photo is the page one paints on, and as a record it takes part
     * in Undo, Redo and the export like everything else.
     *
     * `Probe.Image` reads the header first, so a file that is not a picture is
     * refused here, with a sentence, instead of throwing in the middle of a
     * frame -- where a throw ends the frame and the canvas goes on showing the
     * last one.
     */
    place(path) {
        const size = Probe.Image(path);

        if (!size) {
            Message.Error(Locale.Text("{0} is not a picture this can read",
                                      File.Name(path)));
            return;
        }

        /* A picture bigger than the sheet makes the sheet bigger: the page is
         * what one paints on, and half a photo is not a page. */
        if (size.Width > this.pageW || size.Height > this.pageH) {
            this.pageW = Math.max(this.pageW, size.Width);
            this.pageH = Math.max(this.pageH, size.Height);
            this.Canvas.Resize(this.pageW, this.pageH);
        }

        this.shapes.unshift({
            Kind: "image", Source: path, X0: 0, Y0: 0,
            W: size.Width, H: size.Height,
        });
        this.edited   = null;                 /* every index moved down one */
        this.editing  = null;
        this.polyline = null;
        this.commit();
        this.say(Locale.Text("Placed {0} ({1} x {2})",
                             File.Name(path), size.Width, size.Height));
    }

    BtnPhoto_Click() {
        Dialog.OpenFile(Locale.Text("Place a picture"),
            { Folder: Application.Directory,
              Filters: [[Locale.Text("Images"),
                         "*.png *.jpg *.jpeg *.webp *.bmp *.tif *.tiff"],
                        [Locale.Text("All files"), "*"]] },
            (path) => this.place(path));
    }

    /* A picture dropped on the window, which is the gesture people try first. */
    Form_FileDrop(paths) {
        if (paths.length) this.place(paths[0]);
    }

    /*
     * The copy is pixels and the model has none: the same drawing is run again
     * through `Drawing.ToPng` against a surface the size of the marquee, with
     * the origin moved so the region lands at (0,0). That is why the bytes can
     * go to another program, and why a picture from another program can come
     * back through `Paste` -- both are just a PNG.
     *
     * The page is painted into the copy, so what is copied is what is seen:
     * opaque paper with the records over it. A float is not: it is not on the
     * page until it is dropped.
     */
    capture(s) {
        return Drawing.ToPng(s.W, s.H, (p) => {
            p.Translate(-s.X, -s.Y);
            this.paintPage(p, s.X, s.Y, s.W, s.H);
        });
    }

    BtnCopy_Click() {
        const s = this.selection;
        if (!s) {
            this.say(Locale.Text("Select a region first"));
            return;
        }

        try {
            Clipboard.CopyImage(this.capture(s));
        } catch (e) {
            Message.Error(Locale.Text("Cannot copy: {0}", e.message));
            return;
        }
        this.say(Locale.Text("Copied {0} x {1}", Math.round(s.W), Math.round(s.H)));
    }

    /*
     * A paste is a float until a click lands it, which is what makes it
     * posable: it follows the pointer by its middle and Escape dismisses it.
     *
     * `PasteImage` hands back bytes, and bytes are not asked how big they
     * themselves are -- so a `Picture` decodes them for one question, the same
     * `LoadBytes` an application would use. The decoded size is kept on the
     * record and handed to `Painter.Image`, which also decodes on every frame
     * (its cache is a path's): a pasted selection has no file and that is the
     * price.
     */
    BtnPaste_Click() {
        Clipboard.PasteImage((bytes) => {
            if (!bytes) {
                this.say(Locale.Text("The clipboard holds no image"));
                return;
            }

            const probe = new Picture();
            try {
                probe.LoadBytes(bytes);
            } catch (e) {
                Message.Error(Locale.Text("The clipboard image cannot be read: {0}",
                                          e.message));
                return;
            }

            const w = probe.SourceWidth, h = probe.SourceHeight;
            const box = this.Canvas.Bounds();
            const at  = this.pointer || { X: box.Width / 2, Y: box.Height / 2 };

            this.floating = {
                Kind: "image", Source: bytes,
                X0: at.X - w / 2, Y0: at.Y - h / 2, W: w, H: h,
            };
            this.selection = null;
            this.restack();
            this.say(Locale.Text("Click to drop it · Escape cancels"));
        });
    }

    BtnSave_Click() {
        Dialog.SaveFile(Locale.Text("Save the drawing"),
            { Name: "drawing.png" },
            (path) => this.write(path));
    }

    /* The page alone, written: the chrome the screen adds is not part of the
     * file, and `exporting` is what keeps the handler from adding it. */
    write(path) {
        const box = this.Canvas.Bounds();

        try {
            this.exporting = true;
            this.Canvas.Save(path, box.Width, box.Height);
        } catch (e) {
            Message.Error(Locale.Text("Cannot save {0}: {1}", path, e.message));
            return;
        } finally {
            this.exporting = false;      /* every road out, the throw included */
        }
        this.say(Locale.Text("Saved {0}", path));
    }

    /* 1 to 8 pick a tool, in the order the buttons stand; Delete takes the
     * path the Edit tool has; Escape puts down what nothing has landed -- the
     * float, then the marquee, then the edit. */
    Form_KeyPress(key) {
        const at = "123456789".indexOf(key);
        if (at >= 0) {
            this.choose(TOOLS[at][1]);
            return true;
        }

        if ((key === "Return" || key === "KP_Enter") && this.polyline) {
            this.finishPolyline();
            return true;
        }

        if ((key === "Delete" || key === "BackSpace") && this.edited !== null) {
            this.deleteEdited();
            return true;
        }

        if (key === "Escape" && this.polyline) {
            this.polyline = null;
            this.Canvas.Redraw();
            return true;
        }
        if (key === "Escape" && this.floating) {
            this.floating = null;
            this.restack();
            this.say(Locale.Text("Paste cancelled"));
            return true;
        }
        if (key === "Escape" && this.selection) {
            this.selection = null;
            this.restack();
            return true;
        }
        if (key === "Escape" && this.edited !== null) {
            this.edited  = null;
            this.editing = null;
            this.restack();
            return true;
        }
        return false;
    }

    /* One status line for the buttons: what just happened, and then the
     * reminder back, because a hint that disappears after the first save is a
     * hint the next person does not get. */
    say(text) {
        this.LblHint.Text = text;
        Timer.After(3000, () => this.hint());
    }

    /* The size, live, while the corner is being dragged: the label is the one
     * place the page's measurements are told. */
    showSize() {
        this.LblHint.Text = Locale.Text("Page {0} x {1}", this.pageW, this.pageH);
    }

    hint() {
        this.LblHint.Text = Locale.Text(
            "Page {0} x {1} · 1–9 pick a tool · the corner resizes the page",
            this.pageW, this.pageH);
    }
}
