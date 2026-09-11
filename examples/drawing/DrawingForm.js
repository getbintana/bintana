/*
 * The drawing surface, as three drawings and a measurement.
 *
 * A `DrawingArea` raises `Draw` and hands over a `Painter`; what the handler
 * paints is what is on the screen. There is nothing else to it, and this example
 * exists to show the three things that are not obvious from the property table:
 *
 *   - how a drawing follows the desktop's theme (`Foreground`, `Dark`) instead of
 *     hard-coding colours that are invisible on half of them;
 *   - how the pointer gets back to the datum -- `MouseMove` carries coordinates
 *     local to the surface, and the hit test is the application's;
 *   - what a frame actually costs, printed rather than assumed, because the one
 *     surprise in this whole feature is that the cost is in pixels covered and
 *     not in points.
 *
 * **That last one has to be hunted for, and the numbers say where.** Measured in
 * this form's own sparkline box (402x159 here), redrawing as fast as GTK will:
 *
 *      points   shape    antialias on   off
 *         120   either       60          60
 *         360   either       60          60
 *        1080   jagged       51          60
 *        3240   jagged       15          60
 *        9720   jagged        3          31
 *        9720   smooth       56          60
 *
 * So: **`Rougher`, then `More data` three times, then `Measure`** -- and again
 * with `Antialias` off. Anything gentler than that draws at 60 whatever it is
 * asked to do, which is the practical conclusion and worth saying as loudly as
 * the cliff: a chart of a thousand points costs nothing, and the shape of the
 * line matters more than how many points are in it.
 *
 * The chart set this surface was built for is a plan and not code yet:
 * `lib/charts` is where it lives, and `docs/llm/charts.md` documents it.
 */
"use strict";

/* The series colours. Not the theme's -- a chart's own -- and picked to hold up
 * against a light ground and a dark one, which is what `Painter.Dark` is for. */
const SERIES = ["#3584e4", "#2ec27e", "#e5a50a", "#c061cb", "#e01b24"];

class DrawingForm extends Form {

    Form_Open() {
        this.points  = 120;
        this.rough   = false;
        this.hover   = -1;
        this.slices  = [38, 24, 18, 12, 8];
        this.data    = this.series(this.points);
        /* After the first frame: the cost is what the last `Draw` measured, and
         * `Form_Open` runs before there has been one. */
        Timer.After(120, () => this.showCost());
    }

    /* Something to draw: a smooth walk, or a jagged one when asked. */
    series(n) {
        const out = [];
        for (let i = 0; i < n; i++)
            out.push(this.rough
                ? Math.sin(i * 2.3) * Math.cos(i * 7.7)
                : Math.sin(i / (n / 12)) + Math.sin(i / (n / 5)) * 0.4);
        return out;
    }

    /* ------------------------------------------------------------ sparkline
     *
     * `Polyline` takes a flat array and draws it in one call. The area under it
     * is the same points closed against the baseline -- `Polygon` -- filled with
     * the same colour at a quarter of its alpha, which is what an ordinary CSS
     * colour string already says.
     */
    Line_Draw(p, width, height) {
        const watch = new Stopwatch().Start();
        const n   = this.data.length;
        const pad = 6;
        /*
         * **The scale comes from the data**, which is the first thing a drawing
         * has to do for itself and the first thing this example got wrong: a
         * fixed range drew a curve that left the box at the bottom and came back
         * in, which reads as a bug in the surface and is a missing axis. A chart
         * component would own this arithmetic; here it is three lines, and they
         * are the three lines it is made of.
         */
        const lo = Math.min(...this.data), hi = Math.max(...this.data);
        const span = hi - lo || 1;
        const x = (i) => pad + i * (width - 2 * pad) / (n - 1);
        const y = (v) => height - pad - (v - lo) * (height - 2 * pad) / span;

        p.Antialias = this.ChkSmooth.Active;

        /* The grid, in the theme's ink at a fifth: a drawing that hard-codes grey
         * is grey on a dark theme too, where it should be lighter than the
         * ground. */
        p.Color    = p.Dark ? "rgba(255,255,255,0.18)" : "rgba(0,0,0,0.12)";
        p.LineDash = [2, 3];
        for (let i = 1; i < 4; i++) {
            p.MoveTo(pad, i * height / 4);
            p.LineTo(width - pad, i * height / 4);
        }
        p.Stroke();
        p.LineDash = [];

        const line = [];
        for (let i = 0; i < n; i++) line.push(x(i), y(this.data[i]));

        p.Color = SERIES[0] + "40";              /* the area: the same blue, faint */
        p.Polygon([...line, x(n - 1), height, x(0), height]);
        p.Fill();

        p.Color     = SERIES[0];
        p.LineWidth = 2;
        p.LineJoin  = "Round";
        p.Polyline(line);
        p.Stroke();

        /* The pointer, back to a datum: `MouseMove` gave us an index, and this is
         * the only place that knows where that index sits. */
        if (this.hover >= 0 && this.hover < n) {
            const hx = x(this.hover), hy = y(this.data[this.hover]);

            p.Color = p.Foreground;
            p.Arc(hx, hy, 3, 0, 360);
            p.Fill();

            const said = `#${this.hover}: ${this.data[this.hover].toFixed(2)}`;
            const w    = p.TextWidth(said);
            p.Text(said, Math.min(hx + 6, width - pad - w), Math.max(hy - 18, 0));
        }

        this.drawn    = (this.drawn || 0) + 1;
        this.lineCost = watch.Elapsed;
    }

    /* The index under the pointer, and a redraw only when it changed: a chart
     * that redraws on every motion event is a chart that redraws sixty times
     * while nothing moves.
     *
     * The pointer says so before it is moved: this surface is the only one of
     * the three that answers the mouse, and its `Cursor` is `Crosshair` in the
     * `.form` -- which is the whole of telling the user that this one can be
     * read and the other two only looked at. */
    Line_MouseMove(x, y) {
        const n   = this.data.length;
        const pad = 6;
        const at  = Math.round((x - pad) * (n - 1) / Math.max(1, this.Line.Bounds().Width - 2 * pad));
        const was = this.hover;

        this.hover = at >= 0 && at < n ? at : -1;
        if (this.hover !== was) {
            this.Line.Redraw();
            this.showCost();
        }
    }

    Line_MouseLeave() {
        if (this.hover !== -1) { this.hover = -1; this.Line.Redraw(); }
    }

    /* ---------------------------------------------------------------- gauge
     *
     * Arcs, in degrees, which is the whole reason they are in degrees: a dial
     * that sweeps 240 degrees from -210 is written the way it is described.
     */
    Gauge_Draw(p, width, height) {
        const cx = width / 2, cy = height * 0.62;
        const r  = Math.min(width / 2, cy) - 14;
        const value = (this.data.at(-1) + 1.4) / 2.8;       /* 0..1, roughly */
        const from = -210, sweep = 240;

        p.LineWidth = 12;
        p.LineCap   = "Round";

        p.Color = p.Dark ? "rgba(255,255,255,0.15)" : "rgba(0,0,0,0.10)";
        p.Arc(cx, cy, r, from, from + sweep);
        p.Stroke();

        p.Color = SERIES[1];
        p.Arc(cx, cy, r, from, from + sweep * Math.max(0, Math.min(1, value)));
        p.Stroke();

        p.Color = p.Foreground;
        p.Font  = "Bold 16";
        const said = `${Math.round(value * 100)}%`;
        p.Text(said, cx - p.TextWidth(said) / 2, cy - p.TextHeight(said) / 2);
    }

    /* ------------------------------------------------------------------ pie
     *
     * A slice is `MoveTo` the centre, `Arc`, `ClosePath`, `Fill` -- which is why
     * `Arc` appends to the path instead of starting one. The labels are placed
     * with `TextWidth`, since a drawing has no layout but the one it computes.
     */
    Pie_Draw(p, width, height) {
        const total = this.slices.reduce((a, b) => a + b, 0);
        const cx = width * 0.28, cy = height / 2;
        const r  = Math.min(cx, cy) - 10;
        let at   = -90;                                  /* twelve o'clock */

        this.slices.forEach((v, i) => {
            const sweep = v * 360 / total;

            p.Color = SERIES[i % SERIES.length];
            p.MoveTo(cx, cy);
            p.Arc(cx, cy, r, at, at + sweep);
            p.ClosePath();
            p.Fill();
            at += sweep;
        });

        /* A legend, which is rows of a swatch and a word: the arithmetic a chart
         * component would own, done by hand here to show what it is -- including
         * the part that is easy to forget, which is that it has to fit. */
        const line = Math.min(p.TextHeight("0") + 8,
                              (height - 8) / this.slices.length);
        let y = Math.max(4, cy - this.slices.length * line / 2);

        this.slices.forEach((v, i) => {
            p.Color = SERIES[i % SERIES.length];
            p.Rectangle(width * 0.56, y + 3, 10, 10);
            p.Fill();

            p.Color = p.Foreground;
            p.Text(`Series ${i + 1} — ${Math.round(v * 100 / total)}%`,
                   width * 0.56 + 18, y);
            y += line;
        });
    }

    /* --------------------------------------------------------------- the bar */

    BtnMore_Click() {
        this.points = this.points >= 8000 ? 120 : this.points * 3;
        this.data   = this.series(this.points);
        this.redrawAll();
    }

    /*
     * The measurement this example is really about: the same number of points,
     * drawn as a line that crosses its own height on every segment.
     *
     * It needs enough of them to show. At 9,720 points in this form's sparkline
     * box that is **3 frames a second against 31**, for the same points and the
     * same calls; at 1,080 it is 51 against 60, which is to say invisible. The
     * cost is in pixels covered, so it goes with the box as much as with the
     * data -- the same 5,000 points in an 800x400 area are 4 frames a second
     * against 58.
     */
    BtnRough_Click() {
        this.rough = !this.rough;
        this.data  = this.series(this.points);
        this.redrawAll();
    }

    ChkSmooth_Click() { this.redrawAll(); }

    /* The same `Draw`, against an image surface. A chart in a report is this
     * call, and so is a chart in a bug report. */
    BtnSave_Click() {
        const path = File.Join(Application.ConfigDirectory, "sparkline.png");

        this.Line.Save(path, 800, 240);
        this.LblCost.Text = Locale.Text("Saved {0}", path);
    }

    /*
     * **What the handler measures is not what the frame costs.**
     *
     * Inside a `Draw` on screen, cairo is *recording*: GTK4 gives the draw
     * function a context over a node, and the rasterising happens afterwards in
     * the renderer. So a stopwatch around the drawing answers about the recording
     * and cannot see the expensive half -- measured, and worth knowing before
     * trusting a number: the jagged 5,000-point line records in 8 ms either way
     * and reaches 4 frames a second antialiased against 58 without.
     *
     * The only honest way to ask *is this smooth* is to count frames, which is
     * what this does: redraw for a second and see how many arrived. (`Save()` is
     * the other side -- an image surface rasterises inside the call, so there the
     * handler's own time is the real one, ten times larger.)
     */
    BtnMeasure_Click() {
        const watch = new Stopwatch().Start();
        const from  = this.drawn || 0;

        this.BtnMeasure.Enabled = false;
        const tick = Timer.Every(4, () => this.Line.Redraw());

        Timer.After(1000, () => {
            tick.Stop();
            this.rate = (this.drawn - from) / (watch.Elapsed / 1000);
            this.BtnMeasure.Enabled = true;
            this.showCost();
        });
    }

    redrawAll() {
        this.rate = 0;
        for (const area of [this.Line, this.Gauge, this.Pie]) area.Redraw();
        Timer.After(30, () => this.showCost());
    }

    showCost() {
        /* Short on purpose: this sits in a 34px bar next to five buttons, and a
         * sentence that does not fit is a number nobody can read. */
        const said = Locale.Text("{0} {1} · antialias {2} · {3} ms drawn",
            String(this.points),
            this.rough ? Locale.Text("jagged") : Locale.Text("smooth"),
            this.ChkSmooth.Active ? Locale.Text("on") : Locale.Text("off"),
            (this.lineCost || 0).toFixed(2));

        if (!this.rate) { this.LblCost.Text = said; return; }

        /* A measurement that says 60 has measured nothing interesting, and
         * saying so is the difference between an example and a demo. */
        const hint = this.rate > 45 && !(this.rough && this.points >= 3240)
            ? Locale.Text(" — try Rougher + More data ×3")
            : "";

        this.LblCost.Text = Locale.Text("{0} · {1} frames/s{2}",
                                        said, this.rate.toFixed(1), hint);
    }
}
