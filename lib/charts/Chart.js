/*
 * The `Chart` control: a `ChartDocument` on a screen.
 *
 * A module of its own, beside `ChartDocument.js`, because it is the half that
 * needs a display: it extends `Component`, which the console host does not
 * have. The library's manifest names this file under `display`, so a `main`
 * loads the document and skips the control, where the two used to share one
 * script and the control was declared behind `typeof Component`. What the
 * document is, and the conventions both halves keep, are in that file's head.
 */
/*
 * **The control: a chart on a screen.** What a chart is lives in its
 * `Document`; this shows it, and turns the pointer, the wheel and a drag into
 * `Hover`, `Select` and `Range`. Every property of the document is here too,
 * under the same name, so a `.form` that declares `Type` and `Title` on a
 * `Chart` goes on doing so.
 */
export class Chart extends Component {

    /* Select(series, at, value)
     *   a click on a bar, a point or a slice. `at` is the index into that
     *   series' `Values`
     */
    /* Hover(series, at, value)
     *   the pointer passing over one, **which is not a selection**: a chart
     *   that reported a click as a hover could not have a tooltip. On a line or
     *   an area it is the first series; on a **stacked** `Area` it is the band
     *   the pointer is inside (the top one above them all), `value` is that
     *   series' own value, and the mark is drawn at the top of its band
     */
    /* Range(from, count)
     *   the window changed — the wheel, a drag, or the double click that resets
     *   it
     */
    static Events         = ["Select", "Hover", "Range"];
    static Options        = ChartDocument.Options;
    static TextProperties = ["Title", "Labels", "Series.Name"];

    /* ---------------------------------------------------------------- fields
     *
     * **Declared, because a component is sealed once it is built** under
     * `--strict` (`docs/plans/strict-plan.md`): a field a chart only creates on
     * the first time a pointer crosses it is an attempt to add a name to a
     * sealed object and throws there.
     */
    _doc;

    /* Where the pointer was, for the wheel -- which does not carry it -- and
     * the flag that keeps the click of a double click from selecting. The
     * press and the drag live on the document, where the arithmetic is. */
    pointer; resetting;

    /**
     * the chart itself — a `ChartDocument`, which is what draws. Every
     * property below that is not about the pointer is a property of it
     */
    get Document() {
        if (!this._doc) {
            this._doc = new ChartDocument();
            this._doc.owner = this;
        }
        return this._doc;
    }

    /* ------------------------------------------------------------ properties
     *
     * The document's, under the same names: the designer edits them here, the
     * serialiser keeps them here, and the document redraws this control when
     * any of them moves.
     */

    /**
     * `Bar` `Line` `Area` `Pie` `Doughnut` `Scatter` `Heatmap` `Gauge`.
     * Defaults to `"Bar"`.
     */
    get Type() { return this.Document.Type; }
    set Type(v) { this.Document.Type = v; }

    /**
     * the data: `[{ Name, Values, Color, Colors, Axis, Type, X, Sizes }]` — see
     * below. Defaults to `[]`. Assigning it redraws
     */
    get Series() { return this.Document.Series; }
    set Series(v) { this.Document.Series = v; }

    /**
     * a `Gauge`'s coloured ranges, `[{ To, Color, Name }]` in rising order: each
     * runs from the end of the one before (the first from `YMin`) to `To`, and
     * the value's arc takes the colour of the range it falls in. Other types
     * ignore it. Defaults to `[]`.
     */
    get Bands() { return this.Document.Bands; }
    set Bands(v) { this.Document.Bands = v; }

    /**
     * horizontal reference lines, `[{ Value, Color, Text, Width }]`, drawn
     * across the plot at `yOf(Value)` with the text at the right edge. A
     * `Value` outside the axis is not drawn; `Width` defaults to `1.5`, and
     * `Color` to the chart's ink. Defaults to `[]`.
     */
    get Lines() { return this.Document.Lines; }
    set Lines(v) { this.Document.Lines = v; }

    /**
     * the category axis, as strings. As many as there are values is a label per
     * bar; **fewer** is marks spread evenly across the plot; a pie names its
     * slices from them. Defaults to `[]`.
     */
    get Labels() { return this.Document.Labels; }
    set Labels(v) { this.Document.Labels = v; }

    /**
     * `[{ At, Text }]`, `At` being an index into the values — a **real** time
     * axis, where the caller says where each label goes. Replaces `Labels` on
     * the x axis while it is set. Defaults to `[]`.
     */
    get Marks() { return this.Document.Marks; }
    set Marks(v) { this.Document.Marks = v; }

    /**
     * `None` `Top` `Bottom`. It wraps to at most **three** rows and whatever
     * did not fit is not drawn: a legend of thirty series is the wrong control,
     * and eating the plot to hold one is worse. Defaults to `"Bottom"`.
     */
    get Legend() { return this.Document.Legend; }
    set Legend(v) { this.Document.Legend = v; }

    /** the horizontal rules behind the data. Defaults to `true`. */
    get Grid() { return this.Document.Grid; }
    set Grid(v) { this.Document.Grid = v; }

    /**
     * series piled instead of side by side. Applies to `Bar` and `Area`; a line
     * and a pie **ignore** it rather than refusing, so the order of two lines
     * in a `.form` never matters. Defaults to `false`.
     */
    get Stacked() { return this.Document.Stacked; }
    set Stacked(v) { this.Document.Stacked = v; }

    /**
     * the number on the bar or the percentage in the slice, drawn only where it
     * measures as fitting. Defaults to `false`.
     */
    get ShowValues() { return this.Document.ShowValues; }
    set ShowValues(v) { this.Document.ShowValues = v; }

    /** above the plot. **Translated**. Defaults to `""`. */
    get Title() { return this.Document.Title; }
    set Title(v) { this.Document.Title = v; }

    /**
     * pins the bottom of the y axis; `""` (or `null`) works it out from the
     * data, on *nice* numbers rather than on the data's own extremes. A value
     * that is not a finite number is refused where it is assigned — stored, it
     * left the axis with no ticks and every frame threw. Defaults to `""`.
     */
    get YMin() { return this.Document.YMin; }
    set YMin(v) { this.Document.YMin = v; }

    /** likewise the top. Defaults to `""`. */
    get YMax() { return this.Document.YMax; }
    set YMax(v) { this.Document.YMax = v; }

    /**
     * how the numbers are written, `0` to `6`; goes through `Locale.Number`, so
     * the separators are the user's. Defaults to `0`.
     */
    get Decimals() { return this.Document.Decimals; }
    set Decimals(v) { this.Document.Decimals = v; }

    /**
     * smooth edges. Off is faster and looks it; `Reduced` is the knob that
     * actually matters. Defaults to `true`.
     */
    get Antialias() { return this.Document.Antialias; }
    set Antialias(v) { this.Document.Antialias = v; }

    /**
     * rounded lines for `Line` and `Area`, **monotone**: between two samples
     * the curve stays between their values and flattens at a peak instead of
     * inventing a taller one. Off by default because a curve says something
     * about values nobody measured. Defaults to `false`.
     */
    get Curved() { return this.Document.Curved; }
    set Curved(v) { this.Document.Curved = v; }

    /**
     * more points than pixel columns are decimated to a min and a max per
     * column, which keeps the envelope — a one-sample spike survives it.
     * Defaults to `true`. On by default
     */
    get Reduced() { return this.Document.Reduced; }
    set Reduced(v) { this.Document.Reduced = v; }

    /** the first value on screen. Defaults to `0`. */
    get From() { return this.Document.From; }
    set From(v) { this.Document.From = v; }

    /** how many are on screen; `0` is all of them. Defaults to `0`. */
    get Count() { return this.Document.Count; }
    set Count(v) { this.Document.Count = v; }

    /*
     * **The wheel zooms and a drag pans -- off by default.**
     *
     * A chart of four bars has nothing to zoom, and a wheel that zooms is a wheel
     * the `Scroller` around it does not get: this consumes the notch only when it
     * actually changed the view, which is the runtime's own rule for
     * `MouseWheel`. Off, so a chart that has no use for it never steals a scroll.
     */
    /**
     * lets the wheel zoom and a drag pan — see [what the pointer
     * does](docs/reference/libraries/Chart.md#what-the-pointer-does). Off by
     * default, so a chart of four bars never steals a scroll from the
     * `Scroller` around it. Defaults to `false`.
     */
    get Zoomable() { return this.Document.Zoomable; }
    set Zoomable(v) { this.Document.Zoomable = v; }

    /**
     * redraws now. **Assigning any property already does**, so this is for the
     * case where the numbers changed **in place**
     */
    Refresh() { if (this.Canvas) this.Canvas.Redraw(); }

    /* Where a `Save()` on the chart goes, so a report can have one. */
    /**
     * the same drawing to a PNG of any size — a chart in a report, or in a bug
     * report
     */
    Save(path, width, height) { this.Canvas.Save(path, width, height); }

    /* ---------------------------------------------------------------- drawing */

    Canvas_Draw(p, width, height) { this.Document.Paint(p, width, height); }

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
        if (!this.Document.ZoomAt(this.pointer, NaN, dy)) return false;
        this.Emit("Range", this.Document.view().from, this.Document.view().count);
        return true;                 /* consumed: the scroller must not also move */
    }

    /* Panning is a drag, and a drag is a press that moved: a chart that took
     * every press as the start of one could never report a click, and `Select` is
     * the reason anybody clicks a bar. Three pixels is the threshold, and it
     * lives with the arithmetic on the document. */
    Canvas_MouseMove(x, y) {
        this.pointer = x;

        const did = this.Document.Move(x, y);
        if (did === "pan") {
            this.Emit("Range", this.Document.view().from, this.Document.view().count);
            return;
        }
        if (did === "hover") {
            this.Refresh();
            if (this.Document.hover)
                this.Emit("Hover", this.Document.hover.series, this.Document.hover.at, this.Document.hover.value);
        }
    }

    Canvas_MouseLeave() {
        this.pointer = undefined;
        this.Document.Release();
        if (this.Document.hover) { this.Document.hover = null; this.Refresh(); }
    }

    /*
     * **A press is not a click yet.** `Select` used to fire on `MouseDown`, and
     * with panning that would report a selection at the start of every drag. So
     * the press is remembered, the move decides which gesture it was, and the
     * release reports the click -- only if nothing moved.
     *
     * **A click on the legend is not a data click either**: it takes the series
     * out of the drawing and the axis, and puts it back, without a `Select` --
     * which the app's drawing does through `LegendHit` itself.
     */
    Canvas_MouseDown(x, y) {
        const legend = this.Document.LegendHit(x, y);
        if (legend) {
            const s = this.Document.Series[legend.Series];
            if (s) { s.Hidden = !s.Hidden; this.Document.Refresh(); }
            return;
        }

        if (!this.Document.Press(x, y)) {
            const hit = this.Document.at(x, y);
            if (hit) this.Emit("Select", hit.series, hit.at, hit.value);
        }
    }

    Canvas_MouseUp(x, y) {
        const click = this.Document.Release();
        const quiet = this.resetting;
        this.resetting = false;
        if (quiet || !click) return;

        const hit = this.Document.at(x, y);
        if (hit) this.Emit("Select", hit.series, hit.at, hit.value);
    }

    /* Back to the whole series, which is the one gesture a zoomed chart needs and
     * nobody thinks to look for a button for. */
    Canvas_DblClick(x, y) {
        if (!this.Zoomable || this.Document.view().whole) return;

        /* **And the click that made it a double one is not a selection.** The
         * gesture arrives between the second press and its release, so a flag
         * here is what keeps `Select` from firing for a gesture that meant
         * *show me everything*. Measured rather than assumed: without it the
         * status line reported a reading right after the reset. */
        this.resetting = true;
        this.Document._from  = 0;
        this.Document._count = 0;
        this.Refresh();
        this.Emit("Range", 0, this.Document.slots());
    }

}
