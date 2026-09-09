/*
 * A chart, as a component: one class, and `Type` says which kind.
 *
 * It began as one chart end to end, written in Bintana over the runtime's
 * `DrawingArea` to find out what the surface was still missing -- the answer was
 * `ArcNegative` and nothing else -- and it is now the library a project reaches
 * with `uses: ["charts"]`. Five shapes, two axes,
 * stacking, monotone curves, and a window into a series too long to draw whole.
 * Still no animation and no radar. It draws bars, lines, areas and circles over a
 * category axis, and it draws them properly -- which is the part that turns out
 * to be the work.
 *
 * **What it publishes is documented like the runtime's own surface**, in
 * [docs/llm/charts.md](../../docs/llm/charts.md), and `tests/api.sh` fails when a
 * property here has no row there: a library that ships with the runtime is part
 * of the contract. A new property is two edits, not one.
 *
 * **The declaration is in the `.form`, not in a call.** That is the whole
 * argument of this environment applied to charts: `Type`, `Labels`, `Legend`,
 * `Grid`, `Title` and the y range are ordinary properties, so the designer edits
 * them, the serialiser keeps them and the catalogue translates the prose. Only
 * the numbers come from code:
 *
 *     this.Sales.Series = [{ Name: "2026", Values: rows.map((r) => r.Total) }];
 *
 * Three things in here are the ones a chart is actually made of, and each is a
 * place where "it draws something" and "it draws it right" come apart:
 *
 *   the axis      nice numbers, not the data's own range -- see `ticks()`
 *   the margins   measured from the widest label, not guessed -- see `plot()`
 *   decimation    more points than pixels is noise, and expensive -- `reduce()`
 */
"use strict";

/* The default series colours: a chart's own, not the theme's, and chosen to hold
 * up on a light ground and a dark one. `Series[].Color` overrides per series. */
const PALETTE = ["#3584e4", "#2ec27e", "#e5a50a", "#c061cb", "#e01b24",
                 "#986a44", "#33d17a", "#f6d32d"];

/* What a grid line and a label are worth, in the theme's ink. A drawing that
 * hard-codes grey is grey on a dark theme too, where it should be lighter than
 * the ground. */
const LEGEND_ROWS = 3;      /* past this a legend is the wrong control */
const GRID_ALPHA = 0.14;
const DIM_ALPHA  = 0.55;

class Chart extends Component {

    static Events         = ["Select", "Hover", "Range"];
    static Options        = { Type:   ["Bar", "Line", "Area", "Pie", "Doughnut"],
                              Legend: ["None", "Top", "Bottom"] };
    static TextProperties = ["Title", "Labels", "Series.Name"];

    /* ------------------------------------------------------------ properties
     *
     * Ordinary accessors, which is what makes them designable and serialisable;
     * every one of them ends in a redraw, because a chart whose data changed and
     * whose picture did not is the first bug anybody writes here.
     */

    get Type() { return this._type || "Bar"; }
    set Type(v) {
        const kinds = Chart.Options.Type;
        if (!kinds.includes(String(v)))
            throw new Error(`Type: '${v}' is not one of ${kinds.join(", ")}`);
        this._type = String(v);
        this.Refresh();
    }

    get Series() { return this._series || []; }
    set Series(v) {
        if (!Array.isArray(v)) throw new Error("Series expects an array");
        this._range = null;
        this._series = v.map((s, i) => ({
            Name:   String(s.Name === undefined ? `Series ${i + 1}` : s.Name),
            Values: (s.Values || []).map(Number),
            Color:  String(s.Color || ""),
            /* **Which axis it is measured against.** Two series in different
             * units -- pesos and per cent, requests and milliseconds -- cannot
             * share a scale, and putting them on one is the classic chart that
             * lies. `Right` gives that series its own range, its own ticks and
             * its own margin; everything else stays on `Left`. */
            Axis:   s.Axis === "Right" ? "Right" : "Left",
        }));
        this.Refresh();
    }

    /*
     * The category axis, as strings -- and **two axes hide in one property**,
     * which the first run of this component made obvious:
     *
     *   as many labels as values   a category axis: each label under its own bar
     *   fewer labels than values   marks spread evenly across the plot
     *
     * The second is the axis a series over time wants, and `Marks` below is the
     * third case: labels at positions the caller *says*, which is what a real
     * time axis is -- a reading every second for six hours has its hour marks at
     * 3600, 7200, ... and not at six equal fractions of however many readings
     * arrived.
     */
    get Labels() { return this._labels || []; }
    set Labels(v) {
        if (!Array.isArray(v)) throw new Error("Labels expects an array of strings");
        this._labels = v.map(String);
        this.Refresh();
    }

    /*
     * `Marks` places the labels itself: `[{ At, Text }]`, where `At` is an index
     * into the values.
     *
     * **This is the difference between evenly spread marks and a time axis.**
     * Spread marks assume the samples are evenly spaced and that the first and
     * last are the ends of the range -- true of a tidy series and false of every
     * real one, where readings are missing, arrive late, or start mid-hour. With
     * `Marks` the caller says where each label goes, because only the caller
     * knows what the index means.
     *
     * It replaces `Labels` for the x axis when it is set. Empty is the ordinary
     * state, and then `Labels` answers as before.
     */
    get Marks() { return this._marks || []; }
    set Marks(v) {
        if (!Array.isArray(v)) throw new Error("Marks expects an array of {At, Text}");
        this._marks = v.map((m) => ({ At: Number(m.At) || 0, Text: String(m.Text) }));
        this.Refresh();
    }

    get Legend() { return this._legend || "Bottom"; }
    set Legend(v) {
        const where = Chart.Options.Legend;
        if (!where.includes(String(v)))
            throw new Error(`Legend: '${v}' is not one of ${where.join(", ")}`);
        this._legend = String(v);
        this.Refresh();
    }

    get Grid() { return this._grid === undefined ? true : this._grid; }
    set Grid(v) { this._grid = !!v; this.Refresh(); }

    /*
     * **Stacked bars, and why this one is accepted everywhere rather than
     * refused.** A property a class can *never* honour refuses -- that is what
     * `Grid.Arrangement` does. This one the same class honours in one mode and
     * ignores in the others, and a `.form` may well set it before it sets `Type`,
     * so refusing on the strength of another property's current value would make
     * the order of two lines in a file matter. It is accepted, it applies to
     * `Bar`, and it says so here.
     */
    get Stacked() { return this._stacked === undefined ? false : this._stacked; }
    /* Bars and areas both stack; a line and a pie do not, and say so by ignoring
     * it -- see the note above. */
    set Stacked(v) { this._stacked = !!v; this._range = null; this.Refresh(); }

    /* The number on the bar or the percentage in the slice, drawn only where it
     * fits -- which is measured, not assumed. */
    get ShowValues() { return this._showValues === undefined ? false : this._showValues; }
    set ShowValues(v) { this._showValues = !!v; this.Refresh(); }

    get Title() { return this._title || ""; }
    set Title(v) { this._title = String(v); this.Refresh(); }

    /* Empty means worked out from the data, which is what an axis is for. A
     * number pins that end of it. */
    get YMin() { return this._ymin === undefined ? "" : this._ymin; }
    set YMin(v) { this._ymin = v === "" ? undefined : Number(v); this.Refresh(); }

    get YMax() { return this._ymax === undefined ? "" : this._ymax; }
    set YMax(v) { this._ymax = v === "" ? undefined : Number(v); this.Refresh(); }

    get Decimals() { return this._decimals === undefined ? 0 : this._decimals; }
    set Decimals(v) {
        const n = Number(v);
        if (!(n >= 0 && n <= 6)) throw new Error(`Decimals: ${v} is not 0 to 6`);
        this._decimals = n;
        this.Refresh();
    }

    /* Antialiasing is exposed because the measurement says it is the one knob
     * worth having, and refused as a promise: `reduce()` below is what actually
     * keeps a long series cheap. Named after the `Painter` property it sets --
     * it was `Smooth`, which is what the *next* one is actually about. */
    get Antialias() { return this._antialias === undefined ? true : this._antialias; }
    set Antialias(v) { this._antialias = !!v; this.Refresh(); }

    /*
     * A rounded line instead of straight segments, for `Line` and `Area`.
     *
     * **Off by default, and that is a statement rather than caution.** A curve
     * through the samples draws values nobody measured: between two readings it
     * says something, and the naive spline says something *wrong* -- it
     * overshoots, so two points either side of a peak grow a taller peak between
     * them, and a series that never went below zero dips under the axis on the
     * way up. A chart that invents a number is worse than one that looks plain.
     *
     * So when it is on, the curve is **monotone** (Fritsch-Carlson): between two
     * samples it stays between their values, and it flattens at a local maximum
     * instead of sailing past it. It rounds the corners and adds nothing. See
     * `curveThrough`.
     */
    get Curved() { return this._curved === undefined ? false : this._curved; }
    set Curved(v) { this._curved = !!v; this.Refresh(); }

    /* On by default, and a property so the example can turn it off and measure
     * the difference -- which is the only way anybody believes it. */
    get Reduced() { return this._reduced === undefined ? true : this._reduced; }
    set Reduced(v) { this._reduced = !!v; this.Refresh(); }

    /*
     * ---------------------------------------------------------------------
     * **The window: which slots are on screen.**
     *
     * A series of 21,600 readings drawn whole is a shape, not a chart: you can
     * see the trend and no single value. `From` and `Count` are the window into
     * it -- an index and how many -- and they are ordinary properties, so a form
     * can declare a starting view, a scrollbar can drive them, and the two
     * gestures below are just another way of setting them.
     *
     * `Count = 0` means all of it, which is what a chart of four bars wants and
     * never has to say.
     */
    get From() { return this._from || 0; }
    set From(v) { this._from = Math.max(0, Math.round(Number(v) || 0)); this.Refresh(); }

    get Count() { return this._count || 0; }
    set Count(v) {
        const n = Math.round(Number(v) || 0);
        this._count = n > 0 ? n : 0;
        this.Refresh();
    }

    /*
     * **The wheel zooms and a drag pans -- off by default.**
     *
     * A chart of four bars has nothing to zoom, and a wheel that zooms is a wheel
     * the `Scroller` around it does not get: this consumes the notch only when it
     * actually changed the view, which is the runtime's own rule for
     * `MouseWheel`. Off, so a chart that has no use for it never steals a scroll.
     */
    get Zoomable() { return this._zoomable === undefined ? false : this._zoomable; }
    set Zoomable(v) { this._zoomable = !!v; }

    /* The window as it really is: clamped to the data, never fewer than two
     * slots, and never hanging off the end. Everything that maps an index to an x
     * goes through this, so there is one place the arithmetic can be wrong. */
    view() {
        const n     = this.slots();
        const count = Math.max(2, Math.min(n, this._count || n));
        const from  = Math.max(0, Math.min(n - count, Math.round(this._from || 0)));

        return { from, count, to: from + count, n, whole: count >= n };
    }

    /* The x of a slot, and the slot at an x: the two halves of the same map, so
     * that a hit test cannot disagree with what was drawn. */
    xOf(box, i) {
        const v = box.view;
        return box.left + (box.right - box.left) * (i - v.from + 0.5) / v.count;
    }

    indexAt(box, x) {
        const v = box.view;
        return Math.round(v.from +
            (x - box.left) * v.count / Math.max(1, box.right - box.left) - 0.5);
    }

    /* Two of the five types are a circle rather than a plot, and enough of the
     * code below turns on that to be worth a word of its own. */
    get round() { return this.Type === "Pie" || this.Type === "Doughnut"; }

    Refresh() { if (this.Canvas) this.Canvas.Redraw(); }

    /* Where a `Save()` on the chart goes, so a report can have one. */
    Save(path, width, height) { this.Canvas.Save(path, width, height); }

    /* ------------------------------------------------------------- the axis
     *
     * **Nice numbers, not the data's.** A y axis that runs 0..37.4 in five steps
     * of 7.48 is arithmetically correct and unreadable; every plotting library
     * ends up with this same routine, which rounds the step to 1, 2 or 5 times a
     * power of ten and then grows the range out to it.
     */
    ticks(lo, hi, want = 5) {
        if (!(hi > lo)) { hi = lo + 1; }

        const raw  = (hi - lo) / want;
        const mag  = Math.pow(10, Math.floor(Math.log10(raw)));
        const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) || mag * 10;

        const from = Math.floor(lo / step) * step;
        const to   = Math.ceil(hi / step) * step;
        const out  = [];

        /* Counted rather than accumulated: adding a step repeatedly turns 0.1
         * into 0.30000000000000004 and puts that on the axis. */
        for (let i = 0; from + i * step <= to + step / 1e6; i++)
            out.push(from + i * step);
        return out;
    }

    /*
     * The range the axis really covers, which is the ticks' and not the data's --
     * pinned by YMin/YMax where those were given.
     *
     * **A plain loop, and cached, and both of those are measurements.** This was
     * `Series.flatMap(s => s.Values).filter(isFinite)` with `Math.min(0, ...all)`
     * over the result: a copy of 21,600 numbers, a second copy, and two spreads
     * of twenty thousand arguments -- **on every frame**, for an answer that only
     * changes when the data does. It cost more than drawing the chart did (16 ms
     * against about 2), and a spread that size is a stack overflow waiting for a
     * longer series.
     *
     * In an interpreter the data passes dominate the drawing, which is the one
     * thing writing this chart taught that the surface's own numbers could not:
     * `Polyline` is cheap and `flatMap` is not.
     */
    /* Whether any series asked for the right-hand axis: two axes are drawn only
     * when there is something to put on the second one. */
    get twoAxes() {
        return !this.round && this.Series.some((s) => s.Axis === "Right");
    }

    range(side = "Left") {
        const cache = this._range && this._range[side];
        if (cache && cache.series === this._series && cache.stacked === this.Stacked &&
            cache.ymin === this._ymin && cache.ymax === this._ymax)
            return cache.at;

        const mine = this.twoAxes
            ? this.Series.filter((s) => s.Axis === side) : this.Series;

        let lo = 0, hi = 0, any = false;

        if (this.Stacked && (this.Type === "Bar" || this.Type === "Area")) {
            /* **A stacked axis measures the totals, not the tallest series.** The
             * first version reached the top of the largest single value and every
             * stack ran off the plot, which is the sort of thing that reads as a
             * clipping bug. Positives and negatives stack away from zero
             * separately, since a stack of both is two bars from the baseline. */
            for (let i = 0; i < this.slots(); i++) {
                let up = 0, down = 0;
                for (const s of mine) {
                    const v = s.Values[i];
                    if (!isFinite(v)) continue;
                    if (v >= 0) up += v; else down += v;
                    any = true;
                }
                if (up   > hi) hi = up;
                if (down < lo) lo = down;
            }
        } else {
            for (const s of mine)
                for (const v of s.Values) {
                    if (!isFinite(v)) continue;
                    if (!any) { lo = Math.min(0, v); hi = Math.max(0, v); any = true; }
                    else      { if (v < lo) lo = v; if (v > hi) hi = v; }
                }
        }

        if (!any) { lo = 0; hi = 1; }
        if (this._ymin !== undefined) lo = this._ymin;
        if (this._ymax !== undefined) hi = this._ymax;

        const at   = this.ticks(lo, hi);
        const done = { ticks: at, lo: Math.min(lo, at[0]), hi: Math.max(hi, at.at(-1)) };

        if (!this._range) this._range = {};
        this._range[side] = { series: this._series, ymin: this._ymin,
                              ymax: this._ymax, stacked: this.Stacked, at: done };
        return done;
    }

    text(v) { return Locale.Number(v, this.Decimals); }

    /* --------------------------------------------------------- the margins
     *
     * Measured, not guessed: the left margin is the widest y label and the bottom
     * is the label row plus the legend if there is one. A guess is wrong the
     * first time somebody's numbers reach five digits, and wrong in the
     * expensive direction -- labels drawn over the plot.
     */
    plot(p, width, height, leg) {
        const line = p.TextHeight("0");
        const below = this.Legend === "Bottom" ? leg.height : 0;
        const above = this.Legend === "Top"    ? leg.height : 0;

        /* No ticks to measure a margin from, and asking for them would run the
         * axis arithmetic over data that has no axis. */
        if (this.round)
            return { ticks: [], lo: 0, hi: 1, left: 8, right: width - 8,
                     top: 8 + (this.Title ? line + 8 : 0) + above,
                     bottom: height - 8 - below, line };

        const at     = this.range();
        const widest = Math.max(...at.ticks.map((v) => p.TextWidth(this.text(v))));
        /* The right margin is the right axis's widest label, measured the same
         * way the left one is -- or 8, when there is no second axis. */
        const other  = this.twoAxes ? this.range("Right") : null;
        const wideR  = other
            ? Math.max(...other.ticks.map((v) => p.TextWidth(this.text(v)))) + 12 : 8;

        return {
            ...at,
            /* The window every index-to-x goes through, worked out once a frame. */
            view:   this.view(),
            left:   widest + 12,
            right:  width - wideR,
            /* The second axis's own range, so everything below can ask for the
             * one a series belongs to without working it out again. */
            other,
            top:    8 + (this.Title ? line + 8 : 0) + above,
            bottom: height - 8 - line - 4 - below,
            line,
        };
    }

    /* ------------------------------------------------------------ decimation
     *
     * **More points than pixels is noise, and it is what makes a drawing slow.**
     * Measured in `examples/drawing`: a jagged 9,720-point line in a 400px box
     * draws at 3 frames a second antialiased, against 60 for the same series
     * reduced to the width it is drawn in -- and the reduced one *looks the
     * same*, because six points to the pixel were never visible.
     *
     * Min and max per column, in order, which is the rule every serious plotting
     * library uses: it keeps the envelope -- a spike one sample wide survives --
     * where taking every n-th point drops it.
     */
    reduce(values, columns, view) {
        const from = view ? Math.max(0, view.from) : 0;
        const to   = view ? Math.min(values.length, view.to) : values.length;
        const many = to - from;

        if (many <= 0) return [];
        /* Few enough to draw as they are: every sample, with its own index --
         * which is what zooming in is for. */
        if (!this.Reduced || many <= columns * 2) {
            const out = [];
            for (let i = from; i < to; i++) out.push([i, values[i]]);
            return out;
        }

        /*
         * **Cached, because decimation is a data operation and not a drawing
         * one** -- and this is the measurement that made the point. Recomputed
         * every frame, the 21,600-reading series drew at 35 frames a second with
         * 21 ms of the handler's time spent reducing; drawing the reduced points
         * is about one of those milliseconds. The rest was a QuickJS loop over
         * 21,600 values, sixty times a second, over data that had not changed.
         *
         * The key is the array's identity and the width it was reduced for: a new
         * `Series`, or a window resized past a pixel, and it is computed again.
         * Nothing else can invalidate it, because nothing else changes what the
         * answer is.
         */
        const cache = this._reduction;
        if (cache && cache.values === values && cache.columns === columns &&
            cache.from === from && cache.to === to)
            return cache.points;

        const out = [];
        const per = many / columns;

        for (let c = 0; c < columns; c++) {
            const at   = from + Math.floor(c * per);
            const stop = Math.min(to, from + Math.floor((c + 1) * per));
            let lo = Infinity, hi = -Infinity, loAt = at, hiAt = at;

            for (let i = at; i < stop; i++) {
                if (values[i] < lo) { lo = values[i]; loAt = i; }
                if (values[i] > hi) { hi = values[i]; hiAt = i; }
            }
            if (!isFinite(lo)) continue;
            /* In the order they occur, or the line zigzags where the data does
             * not. */
            if (loAt <= hiAt) { out.push([loAt, lo], [hiAt, hi]); }
            else              { out.push([hiAt, hi], [loAt, lo]); }
        }

        this._reduction = { values, columns, from, to, points: out };
        return out;
    }

    /* ---------------------------------------------------------------- drawing */

    Canvas_Draw(p, width, height) {
        const watch = new Stopwatch().Start();
        this.frames = (this.frames || 0) + 1;

        p.Antialias = this.Antialias;
        const leg = this.legendLayout(p, width);
        const box = this.plot(p, width, height, leg);
        const ink = p.Foreground;

        if (this.Title) {
            p.Color = ink;
            p.Text(this.Title, this.round ? 8 : box.left, 8);
        }

        /* A pie has no axes to draw and nothing to clip against: it is the one
         * shape here that is not a plot over a range, so it takes the whole of
         * the room the legend does not want and goes its own way. */
        if (this.round) {
            this.slices = [];
            this.drawRound(p, box, ink, width, height);
            if (this.Legend !== "None") this.legend(p, box, ink, leg, width, height);
            this.drawn = watch.Elapsed;
            return;
        }

        this.grid(p, box, ink);
        this.axes(p, box, ink, width);

        /* Everything a series draws is clipped to the plot, so a value past a
         * pinned YMax is cut off at the axis instead of drawn over the labels. */
        p.Push();
        p.ClipRectangle(box.left, box.top,
                        box.right - box.left, box.bottom - box.top);

        this.bars    = [];
        this.lastBox = box;              /* what the hit test measures against */
        if (this.Type === "Bar") this.drawBars(p, box);
        else                     this.drawLines(p, box);
        if (this.ShowValues)     this.values(p, box, ink);
        this.highlight(p, box, ink);

        p.Pop();

        if (this.Legend !== "None") this.legend(p, box, ink, leg, width, height);
        this.drawn = watch.Elapsed;
    }

    /*
     * The y position of a value **on a given axis**. Everything that draws a
     * value passes the series it came from, because a value means nothing without
     * knowing what it is measured against -- which is the whole point of the
     * second axis and the one place it could go quietly wrong.
     */
    yOf(box, v, series) {
        const on = series && series.Axis === "Right" && box.other ? box.other : box;
        return box.bottom - (v - on.lo) * (box.bottom - box.top) / (on.hi - on.lo);
    }

    /* No spread here either: `Math.max(...)` over a mapped array is cheap for
     * three series and free to write as a loop. */
    slots() {
        let n = this.Labels.length;
        for (const s of this.Series) n = Math.max(n, s.Values.length);
        return Math.max(1, n);
    }

    grid(p, box, ink) {
        if (!this.Grid) return;

        p.Color    = this.alpha(ink, GRID_ALPHA);
        p.LineDash = [2, 3];
        for (const v of box.ticks) {
            const y = Math.round(this.yOf(box, v)) + 0.5;
            p.MoveTo(box.left, y);
            p.LineTo(box.right, y);
        }
        p.Stroke();
        p.LineDash = [];
    }

    axes(p, box, ink, width) {
        p.Color = this.alpha(ink, DIM_ALPHA);

        for (const v of box.ticks) {
            const said = this.text(v);
            p.Text(said, box.left - 8 - p.TextWidth(said),
                   this.yOf(box, v) - box.line / 2);
        }

        /* **And the right-hand axis, when a series asked for one.** Its ticks are
         * its own and its labels sit outside the plot on the other side; the grid
         * stays the left axis's, because two grids over one plot is a drawing
         * nobody can read a value off. */
        if (box.other)
            for (const v of box.other.ticks) {
                const y = box.bottom -
                    (v - box.other.lo) * (box.bottom - box.top) /
                    (box.other.hi - box.other.lo);

                p.Text(this.text(v), box.right + 8, y - box.line / 2);
            }

        /*
         * **The x labels, and the two things `Labels` can mean.**
         *
         * One per slot is a category axis: four quarters, twelve months, and each
         * label sits under its own bar. *Fewer* labels than there are values is
         * the other axis anybody wants -- six marks across six hours of readings
         * -- and they belong spread evenly across the plot, not crowded into the
         * first six slots.
         *
         * This came out of the first run: the bottom chart had 21,600 readings
         * and six labels, and the category rule put all six inside the leftmost
         * pixel and then thinned five of them away for overlapping. One rule
         * cannot serve both, so the component asks which it is looking at -- and
         * that is a question the drawing surface could never answer for it.
         */
        const n = this.slots();
        const step = (box.right - box.left) / n;

        /*
         * Three axes, one loop. `Marks` says where each label goes; `Labels` with
         * one per value is a category axis; `Labels` with fewer is spread evenly.
         * What they have in common is that they are thinned until they fit --
         * measured, and every k-th drawn where k is what stops them overlapping.
         */
        const placed = this.Marks.length
            ? this.Marks.map((m) => ({ said: m.Text, at: this.xOf(box, m.At) }))
            : (() => {
                  const count  = this.Labels.length;
                  const spread = count > 1 && count < n / 2;

                  /* Spread marks are positions in the *whole* series, so they
                   * are turned into indices before the window maps them --
                   * otherwise zooming would move the data and leave the labels
                   * where they were. */
                  return this.Labels.map((said, i) => ({
                      said,
                      at: spread ? this.xOf(box, (n - 1) * i / (count - 1))
                                 : this.xOf(box, i),
                  }));
              })();

        const room  = Math.max(...placed.map((m) => p.TextWidth(m.said)), 1) + 8;
        const apart = placed.length > 1
            ? Math.abs(placed[1].at - placed[0].at) : room;
        const every = Math.max(1, Math.ceil(room / Math.max(apart, 1)));

        for (let i = 0; i < placed.length; i += every) {
            const { said, at } = placed[i];
            if (!said || at < box.left - 1 || at > box.right + 1) continue;

            const x = at - p.TextWidth(said) / 2;
            p.Text(said, Math.max(0, Math.min(x, width - p.TextWidth(said))),
                   box.bottom + 4);
        }
    }

    /*
     * Bars, grouped or stacked.
     *
     * **Grouped and stacked are the same loop with two lines different**, which is
     * worth noticing rather than writing twice: grouped moves each series along x
     * and starts every bar at zero, stacked keeps x and starts each bar where the
     * last one ended. What differs beyond that is the axis, and that belongs to
     * `range()`.
     */
    drawBars(p, box) {
        const step   = (box.right - box.left) / box.view.count;
        const groups = this.Stacked ? 1 : Math.max(1, this.Series.length);
        const gap    = Math.min(6, step * 0.15);
        const wide   = Math.max(1, (step - gap) / groups);
        /* The baseline of each axis: zero where the range crosses it, and the
         * nearest end where it does not. */
        const zeroOf = (s) => {
            const on = s && s.Axis === "Right" && box.other ? box.other : box;
            return this.yOf(box, Math.max(on.lo, Math.min(0, on.hi)), s);
        };

        /* Where the next segment of each stack starts, in values and not pixels:
         * pixels would accumulate the rounding and leave hairlines between the
         * segments. */
        const up = {}, down = {};

        this.Series.forEach((s, k) => {
            p.Color = this.colour(s, k);
            /* Only the slots on screen: a window of forty bars out of twenty
             * thousand draws forty rectangles, not twenty thousand clipped ones. */
            for (let i = box.view.from; i < Math.min(s.Values.length, box.view.to); i++) {
                const v = s.Values[i];
                if (!isFinite(v)) continue;

                let x = this.xOf(box, i) - step / 2 + gap / 2, top, bottom;

                if (this.Stacked) {
                    const from = (v >= 0 ? up[i] : down[i]) || 0;
                    const to   = from + v;
                    if (v >= 0) up[i] = to; else down[i] = to;
                    top    = this.yOf(box, Math.max(from, to), s);
                    bottom = this.yOf(box, Math.min(from, to), s);
                } else {
                    x     += wide * k;
                    const y    = this.yOf(box, v, s);
                    const zero = zeroOf(s);
                    top    = Math.min(y, zero);
                    bottom = Math.max(y, zero);
                }

                p.Rectangle(x, top, wide - 1, Math.max(0, bottom - top));
                /* Where the pointer will land, kept as it is drawn: the hit test
                 * has no other way to know, and working it out twice is how the
                 * two answers drift apart. */
                this.bars.push({ x, y: top, w: wide - 1, h: Math.max(0, bottom - top),
                                 series: k, at: i, value: v });
            }
            p.Fill();
        });
    }

    /*
     * The number on the bar, where it fits.
     *
     * Every one of those three words is a measurement: `TextWidth` against the
     * bar's own width, `TextHeight` against the room above it, and the value
     * skipped rather than drawn over its neighbour. A chart that writes numbers
     * it cannot fit is worse than one that writes none.
     */
    values(p, box, ink) {
        p.Color = ink;

        for (const b of this.bars) {
            const said = this.text(b.value);
            const wide = p.TextWidth(said);
            if (wide > b.w - 2) continue;

            const above = b.y - box.line - 2;
            const y     = above >= box.top ? above : b.y + 2;
            if (y + box.line > box.bottom) continue;

            p.Text(said, b.x + (b.w - wide) / 2, y);
        }
    }

    /*
     * The path through a flat `[x, y, …]`, straight or rounded, emitted into the
     * painter rather than returned: an area needs the same curve *and* two lines
     * down to the baseline, so what is shared is the path and not an array.
     *
     * **The tangents are monotone**, which is the whole reason this is twenty
     * lines instead of five. A Catmull-Rom spline takes each point's tangent from
     * its neighbours and overshoots: a peak between two rising samples, a dip
     * below zero between two positive ones -- values the data does not contain,
     * drawn as confidently as the ones it does. Fritsch-Carlson clamps each
     * tangent to three times the smaller neighbouring slope and zeroes it where
     * the slope changes sign, and the result cannot leave the box its two samples
     * make. It is the interpolation every plotting library ends up at for the
     * same reason.
     */
    curveThrough(p, flat, continuing = false) {
        const n = flat.length / 2;

        /* **`LineTo` and not `MoveTo` when the path is already going**: a stacked
         * band is the curve out along its top and back along its floor, one path
         * -- and a `MoveTo` in the middle of it would start a second subpath, so
         * the fill would run the winding rule between the two and cut the band
         * open. The same trap `Painter.ArcNegative` exists for. */
        if (continuing) p.LineTo(flat[0], flat[1]);
        else            p.MoveTo(flat[0], flat[1]);

        if (n < 3 || !this.Curved) {
            for (let i = 1; i < n; i++) p.LineTo(flat[i * 2], flat[i * 2 + 1]);
            return;
        }

        /* The slope of each segment, and a tangent per point from them. */
        const slope = [], tan = [];
        for (let i = 0; i < n - 1; i++) {
            const dx = flat[(i + 1) * 2] - flat[i * 2];
            slope.push(dx === 0 ? 0 : (flat[(i + 1) * 2 + 1] - flat[i * 2 + 1]) / dx);
        }

        tan[0] = slope[0];
        tan[n - 1] = slope[n - 2];
        for (let i = 1; i < n - 1; i++) {
            /* A turning point gets a flat tangent: that is what stops the curve
             * from carrying on past a peak the data stopped at. */
            tan[i] = slope[i - 1] * slope[i] <= 0
                ? 0 : (slope[i - 1] + slope[i]) / 2;
        }
        for (let i = 0; i < n - 1; i++) {
            if (slope[i] === 0) { tan[i] = 0; tan[i + 1] = 0; continue; }

            const a = tan[i] / slope[i], b = tan[i + 1] / slope[i];
            const h = Math.hypot(a, b);
            if (h > 3) {                          /* the Fritsch-Carlson bound */
                tan[i]     = (3 / h) * a * slope[i];
                tan[i + 1] = (3 / h) * b * slope[i];
            }
        }

        for (let i = 0; i < n - 1; i++) {
            const x0 = flat[i * 2],       y0 = flat[i * 2 + 1];
            const x1 = flat[(i + 1) * 2], y1 = flat[(i + 1) * 2 + 1];
            const dx = (x1 - x0) / 3;

            p.CurveTo(x0 + dx, y0 + tan[i] * dx,
                      x1 - dx, y1 - tan[i + 1] * dx, x1, y1);
        }
    }

    drawLines(p, box) {
        const columns = Math.max(2, Math.round(box.right - box.left));
        const stack   = this.Stacked && this.Type === "Area";

        /* What is under each slot already, in values: a stacked area is the same
         * loop as a stacked bar, and for the same reason the running total is
         * kept in values and not in pixels. */
        const under = stack ? {} : null;

        this.Series.forEach((s, k) => {
            /* **The window is decimated, not the series.** Zoomed out, two points
             * a pixel column out of twenty thousand; zoomed in, every sample there
             * is -- which is the whole reason zooming a long series is worth
             * having, and it costs nothing because the reduction is per view. */
            const points = this.reduce(s.Values, columns, box.view);
            if (!points.length) return;

            const flat = [], below = [];

            for (const [i, v] of points) {
                const x = this.xOf(box, i);

                if (stack) {
                    const from = under[i] || 0;
                    under[i] = from + (isFinite(v) ? v : 0);
                    flat.push(x, this.yOf(box, under[i], s));
                    /* The band's floor, kept to walk back along: an area stacked
                     * on another is closed against *it* and not the baseline. */
                    below.unshift(x, this.yOf(box, from, s));
                } else {
                    flat.push(x, this.yOf(box, v, s));
                }
            }

            if (this.Type === "Area") {
                p.Color = this.alpha(this.colour(s, k), 0.25);

                /* The same curve, then the way back: down to what it sits on,
                 * along it, and closed. A straight area could be one `Polygon`;
                 * a rounded one cannot, because a polygon has no curves in it --
                 * so both are built as a path and only this branch differs. */
                this.curveThrough(p, flat);
                if (stack) this.curveThrough(p, below, true);
                else {
                    p.LineTo(flat[flat.length - 2], box.bottom);
                    p.LineTo(flat[0], box.bottom);
                }
                p.ClosePath();
                p.Fill();
            }

            p.Color     = this.colour(s, k);
            p.LineWidth = 2;
            p.LineJoin  = "Round";
            p.LineCap   = "Round";
            this.curveThrough(p, flat);
            p.Stroke();

            /* The dots, only when they are far enough apart to be dots rather
             * than a thicker line. */
            if (points.length < (box.right - box.left) / 8)
                for (const [i, v] of points) {
                    p.Arc(this.xOf(box, i), this.yOf(box, v, s), 2.5, 0, 360);
                    p.Fill();
                }
        });
    }

    /*
     * What the pointer is on, drawn inside the same clip as the data. A readout
     * beside the point rather than a popover: a tooltip is a window, and a window
     * that follows the mouse is a different feature from a chart.
     */
    highlight(p, box, ink) {
        const on = this.hover;
        if (!on) return;

        const s = this.Series[on.series];
        if (!s) return;

        const x = this.xOf(box, on.at);
        const y = this.yOf(box, on.value, s);

        if (this.Type !== "Bar") {
            p.Color     = this.alpha(ink, 0.25);
            p.LineWidth = 1;
            p.MoveTo(x, box.top);
            p.LineTo(x, box.bottom);
            p.Stroke();
        }

        p.Color = ink;
        p.Arc(x, y, 3.5, 0, 360);
        p.Fill();

        const said = `${this.Labels[on.at] || on.at}: ${this.text(on.value)}`;
        const wide = p.TextWidth(said) + 10;
        const left = Math.min(x + 8, box.right - wide);

        /* A plate under it, or the readout is unreadable over the data. */
        p.Color = this.alpha(p.Dark ? "rgb(0,0,0)" : "rgb(255,255,255)", 0.85);
        p.Rectangle(left, y - box.line - 10, wide, box.line + 6);
        p.Fill();

        p.Color = ink;
        p.Text(said, left + 5, y - box.line - 8);
    }

    /*
     * A pie, and a doughnut which is a pie with the middle taken out.
     *
     * **The slices are the first series' values and the `Labels` name them**,
     * which is the one place this component reads its data differently -- and it
     * is what every chart library does, because a pie of two series is two pies.
     * A form that hands it more is drawing the first one; saying so is cheaper
     * than a refusal that would depend on the order two properties were set in.
     *
     * A slice is `MoveTo` the centre, `Arc`, `ClosePath`, `Fill` -- which is why
     * `Arc` appends to the path instead of starting one.
     *
     * **A ring segment is the reason `Painter.ArcNegative` exists.** It is the
     * inner start, out to the outer radius, the outer arc forwards, in again, and
     * the inner arc *backwards* -- one path, closed once. Written with a `MoveTo`
     * for the way back it becomes two subpaths, and filling two subpaths runs the
     * winding rule between them: the first doughnut this component drew had white
     * wedges cut through it. That was the one primitive the whole chart turned out
     * to need and the surface did not have.
     */
    drawRound(p, box, ink, width, height) {
        const s = this.Series[0];
        if (!s || !s.Values.length) return;

        const values = s.Values.filter((v) => isFinite(v) && v > 0);
        const total  = values.reduce((a, b) => a + b, 0);
        if (!total) return;

        const cx = (box.left + box.right) / 2;
        const cy = (box.top + box.bottom) / 2;
        const r  = Math.max(8, Math.min((box.right - box.left) / 2,
                                        (box.bottom - box.top) / 2) - 8);
        const hole = this.Type === "Doughnut" ? r * 0.55 : 0;
        let at = -90;                                     /* twelve o'clock */

        values.forEach((v, i) => {
            const sweep = v * 360 / total;
            const to    = at + sweep;

            p.Color = this.colour({ Color: "" }, i);
            if (hole) {
                const rad = at * Math.PI / 180;
                p.MoveTo(cx + hole * Math.cos(rad), cy + hole * Math.sin(rad));
                p.Arc(cx, cy, r, at, to);
                p.ArcNegative(cx, cy, hole, to, at);
            } else {
                p.MoveTo(cx, cy);
                p.Arc(cx, cy, r, at, to);
            }
            p.ClosePath();
            p.Fill();

            this.slices.push({ from: at, to, at: i, value: v,
                               cx, cy, r, hole, series: 0 });
            at = to;
        });

        if (this.ShowValues) this.percents(p, ink, total);
        this.highlightSlice(p, ink);
    }

    /* The percentage in the slice, and only where the slice is wide enough to
     * hold it: measured against the chord at the text's own radius. */
    percents(p, ink, total) {
        p.Color = ink;

        for (const slice of this.slices) {
            const mid  = (slice.from + slice.to) / 2 * Math.PI / 180;
            const from = slice.hole ? (slice.r + slice.hole) / 2 : slice.r * 0.62;
            const said = `${Math.round(slice.value * 100 / total)}%`;
            const wide = p.TextWidth(said);
            const room = 2 * from * Math.sin((slice.to - slice.from) / 2 * Math.PI / 180);

            if (room < wide + 4) continue;
            p.Text(said, slice.cx + from * Math.cos(mid) - wide / 2,
                         slice.cy + from * Math.sin(mid) - p.TextHeight(said) / 2);
        }
    }

    /* The slice under the pointer, pulled out a little -- which is the one
     * affordance a pie has, and it is a translate rather than a redraw of the
     * geometry. */
    highlightSlice(p, ink) {
        const on = this.hover;
        if (!on) return;

        const slice = (this.slices || []).find((x) => x.at === on.at);
        if (!slice) return;

        const mid = (slice.from + slice.to) / 2 * Math.PI / 180;

        p.Push();
        p.Translate(Math.cos(mid) * 6, Math.sin(mid) * 6);
        p.Color = this.alpha(ink, 0.18);
        p.MoveTo(slice.cx, slice.cy);
        p.Arc(slice.cx, slice.cy, slice.r, slice.from, slice.to);
        p.ClosePath();
        p.Fill();
        p.Pop();

        const said = `${this.Labels[on.at] || on.at}: ${this.text(on.value)}`;
        p.Color = ink;
        p.Text(said, slice.cx - p.TextWidth(said) / 2, slice.cy + slice.r + 6);
    }

    /*
     * **The legend is laid out before the plot is, because it decides how much
     * room the plot has left.** Two rows of five series is two rows the chart
     * cannot draw in, and a layout that discovers that after choosing its margins
     * either overlaps or lies.
     *
     * It wraps, which is the fix for what the first doughnut did: five slices in a
     * 260px chart fitted three, and the other two were silently dropped -- a
     * legend that leaves entries out is worse than one that takes a second row.
     * Past `LEGEND_ROWS` rows it does drop them, and that is a judgement rather
     * than an oversight: a chart with thirty series wants a table, not a legend.
     *
     * **A pie's legend is its labels and a plot's is its series**, because a pie
     * has one series and as many colours as it has slices. Same rows, different
     * list.
     */
    legendLayout(p, width) {
        if (this.Legend === "None") return { rows: [], height: 0 };

        const line  = p.TextHeight("0");
        const items = this.round
            ? (this.Series[0] ? this.Series[0].Values : [])
                  .map((v, i) => ({ Name: this.Labels[i] || String(i), Color: "" }))
            : this.Series;

        const rows = [[]];
        let x = 8;

        items.forEach((s, k) => {
            const need = 12 + 6 + p.TextWidth(s.Name) + 14;

            if (x + need > width - 4 && rows.at(-1).length) {
                if (rows.length >= LEGEND_ROWS) return;
                rows.push([]);
                x = 8;
            }
            rows.at(-1).push({ item: s, k, x });
            x += need;
        });

        const used = rows.filter((r) => r.length);
        return { rows: used, height: used.length ? used.length * (line + 4) + 2 : 0 };
    }

    legend(p, box, ink, leg, width, height) {
        const top = this.Legend === "Top"
            ? 8 + (this.Title ? box.line + 8 : 0)
            : height - leg.height + 2;

        leg.rows.forEach((row, r) => {
            const y = top + r * (box.line + 4);

            for (const { item, k, x } of row) {
                p.Color = this.colour(item, k);
                p.Rectangle(x, y + 3, 10, 10);
                p.Fill();

                p.Color = this.alpha(ink, DIM_ALPHA);
                p.Text(item.Name, x + 18, y);
            }
        });
    }

    colour(s, k) { return s.Color || PALETTE[k % PALETTE.length]; }

    /* A CSS colour with an alpha put on it. `rgb(...)` is what the painter
     * answers with, and `#rrggbb` is what a form writes, so both. */
    alpha(colour, a) {
        const rgb = colour.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (rgb) return `rgba(${rgb[1]},${rgb[2]},${rgb[3]},${a})`;

        const hex = colour.match(/^#([0-9a-f]{6})$/i);
        if (hex) {
            const n = parseInt(hex[1], 16);
            return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
        }
        return colour;
    }

    /* ------------------------------------------------------------ the pointer
     *
     * The coordinates arrive local to the surface, so the hit test is arithmetic
     * the chart already did once: for bars, the rectangles it kept while drawing;
     * for a line, the nearest category slot.
     */
    /*
     * ------------------------------------------------------------ the gestures
     *
     * **The wheel zooms about the pointer and a drag pans.** Both only set `From`
     * and `Count`, so everything a form can do by hand a hand can do by mouse and
     * there is one shape of state to reason about.
     *
     * `MouseWheel` carries how far it turned and **not where the pointer is** --
     * two arguments, which is a thing worth knowing before writing this -- so the
     * position comes from the last `MouseMove`, which a hovering chart is already
     * tracking. Without one (wheeled the instant the pointer arrived) it zooms
     * about the middle, which is the only honest guess.
     */
    Canvas_MouseWheel(dx, dy) {
        if (!this.Zoomable || !this.lastBox || !dy) return false;

        const box = this.lastBox;
        const v   = box.view;
        const at  = this.pointer !== undefined
            ? this.indexAt(box, this.pointer) : v.from + v.count / 2;

        /* A notch is 1.0 on a wheel and a fraction on a touchpad, so the factor
         * follows the amount rather than its sign: a slow touchpad zooms slowly
         * instead of jumping a step per event. */
        const count = Math.max(2, Math.min(v.n,
            Math.round(v.count * Math.pow(1.25, dy))));
        if (count === v.count && !v.whole) return false;

        /* **The datum under the pointer stays under the pointer**, which is what
         * makes zooming feel like moving a lens rather than jumping. */
        const share = (at - v.from) / Math.max(1, v.count);

        this._count = count >= v.n ? 0 : count;
        this._from  = Math.round(at - share * count);
        this.clampView();
        this.Refresh();
        this.Emit("Range", this.view().from, this.view().count);
        return true;                 /* consumed: the scroller must not also move */
    }

    /* Panning is a drag, and a drag is a press that moved: a chart that took
     * every press as the start of one could never report a click, and `Select` is
     * the reason anybody clicks a bar. Three pixels is the threshold. */
    clampView() {
        const v = this.view();
        this._from  = v.from;
        this._count = v.whole ? 0 : v.count;
    }

    Canvas_MouseMove(x, y) {
        this.pointer = x;

        if (this.dragging) {
            const box = this.lastBox, v = box.view;
            const per = v.count / Math.max(1, box.right - box.left);

            if (!this.dragged && Math.abs(x - this.pressed.x) > 3) this.dragged = true;
            if (this.dragged) {
                this._from = Math.round(this.pressed.from - (x - this.pressed.x) * per);
                this.clampView();
                this.Refresh();
                this.Emit("Range", this.view().from, this.view().count);
                return;
            }
        }

        const was = this.hover;
        this.hover = this.at(x, y);

        if (JSON.stringify(was) !== JSON.stringify(this.hover)) {
            this.Refresh();
            if (this.hover)
                this.Emit("Hover", this.hover.series, this.hover.at, this.hover.value);
        }
    }

    Canvas_MouseLeave() {
        this.pointer  = undefined;
        this.dragging = false;
        if (this.hover) { this.hover = null; this.Refresh(); }
    }

    /*
     * **A press is not a click yet.** `Select` used to fire on `MouseDown`, and
     * with panning that would report a selection at the start of every drag. So
     * the press is remembered, the move decides which gesture it was, and the
     * release reports the click -- only if nothing moved.
     */
    Canvas_MouseDown(x, y) {
        this.pressed  = { x, y, from: this.view().from };
        this.dragging = this.Zoomable && !this.view().whole;
        this.dragged  = false;

        if (!this.dragging) {
            const hit = this.at(x, y);
            if (hit) this.Emit("Select", hit.series, hit.at, hit.value);
        }
    }

    Canvas_MouseUp(x, y) {
        const quiet = this.dragged || this.resetting;

        this.dragging  = false;
        this.dragged   = false;
        this.resetting = false;
        if (quiet || !this.pressed) return;

        const hit = this.at(x, y);
        if (hit) this.Emit("Select", hit.series, hit.at, hit.value);
    }

    /* Back to the whole series, which is the one gesture a zoomed chart needs and
     * nobody thinks to look for a button for. */
    Canvas_DblClick(x, y) {
        if (!this.Zoomable || this.view().whole) return;

        /* **And the click that made it a double one is not a selection.** The
         * gesture arrives between the second press and its release, so a flag
         * here is what keeps `Select` from firing for a gesture that meant
         * *show me everything*. Measured rather than assumed: without it the
         * status line reported a reading right after the reset. */
        this.resetting = true;
        this._from  = 0;
        this._count = 0;
        this.Refresh();
        this.Emit("Range", 0, this.slots());
    }

    at(x, y) {
        if (this.round) {
            /* Angle and radius, which is the pie's whole hit test -- and the
             * hole has to count, or the middle of a doughnut answers for whatever
             * slice happens to be behind it. */
            for (const slice of this.slices || []) {
                const dx = x - slice.cx, dy = y - slice.cy;
                const away = Math.sqrt(dx * dx + dy * dy);
                if (away > slice.r || away < slice.hole) continue;

                let a = Math.atan2(dy, dx) * 180 / Math.PI;
                while (a < slice.from) a += 360;
                if (a <= slice.to)
                    return { series: 0, at: slice.at, value: slice.value };
            }
            return null;
        }

        if (this.Type === "Bar") {
            /* Last drawn wins, which is what overlapping bars look like. */
            for (let i = (this.bars || []).length - 1; i >= 0; i--) {
                const b = this.bars[i];
                if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h)
                    return { series: b.series, at: b.at, value: b.value };
            }
            return null;
        }

        const box = this.lastBox;
        if (!box || x < box.left || x > box.right) return null;

        const at = this.indexAt(box, x);
        const s  = this.Series[0];

        return s && at >= 0 && at < s.Values.length
            ? { series: 0, at, value: s.Values[at] } : null;
    }
}
