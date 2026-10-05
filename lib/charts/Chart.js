/*
 * A chart, as a component: one class, and `Type` says which kind.
 *
 * It began as one chart end to end, written in Bintana over the runtime's
 * `DrawingArea` to find out what the surface was still missing -- the answer was
 * `ArcNegative` and nothing else -- and it is now the library a project reaches
 * with `uses: ["charts"]`. Eight shapes, two axes,
 * stacking, monotone curves, bars and lines on one plot, horizontal thresholds,
 * a series that says how its numbers are written and whether it is a mirror,
 * and a window into a series too long to draw whole. Still no animation and no
 * radar. It draws bars, lines, areas and circles over a category axis, points
 * over two numeric axes, a grid of cells, and a dial -- and it draws them
 * properly, which is the part that turns out to be the work.
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

/* What a series' `Format` may say: `""` is the document's `Decimals` and
 * nothing else, and the other four are the words the application already
 * uses (`Dashboards.Format`), so a chart and the card beside it agree. */
const SERIES_FORMATS = ["", "Number", "Percent", "Duration", "Bits"];


/*
 * **The chart itself, with no control: `ChartDocument`.**
 *
 * The data, the type, the axes and the drawing of all of it, with nothing on a
 * screen -- what a `main` project draws a chart with, into a PNG or straight
 * onto a report's page, since that kind of project cannot make a widget. The
 * `Chart` control below holds one (`Chart.Document`) and adds what a screen
 * has: the pointer, the wheel, a drag, and the events they raise.
 *
 * What a frame leaves behind for the hit test -- the bars, the slices, the box
 * -- is kept here, because it is the drawing that knows where things went; the
 * control asks. So does the one piece of the pointer a drawing shows: `hover`,
 * which the control sets and `Paint` marks.
 */
class ChartDocument {

    /* What the properties keep. */
    _type; _series; _labels; _marks; _legend; _grid; _stacked; _showValues;
    _title; _ymin; _ymax; _decimals; _antialias; _curved; _reduced;
    _from; _count; _bands; _lines; _zoomable;

    /* What a frame leaves behind for the hit test to read, and the reduction
     * it can reuse when neither the data nor the column count moved. */
    _range; _reduction; _stackReduction; bars; slices; lastBox; drawn; frames;
    points; cells; dial; legendHits; _font; _size;

    /* The point the control's pointer is over, which a frame marks. */
    hover;

    /* The pointer between a `Press` and the `Release` that ends it: where the
     * drag started, how far it has moved, and whether that makes it a pan. */
    _press; _dragged;

    /* The control showing this chart, told to redraw when anything moves. */
    owner;

    /* ------------------------------------------------------------ properties
     *
     * Every one of them ends in `changed()`, which redraws the control showing
     * this chart if there is one, because a chart whose data changed and whose
     * picture did not is the first bug anybody writes here.
     */

    /**
     * `Bar` `Line` `Area` `Pie` `Doughnut` `Scatter` `Heatmap` `Gauge`.
     * Defaults to `"Bar"`.
     */
    get Type() { return this._type || "Bar"; }
    set Type(v) {
        const kinds = Chart.Options.Type;
        if (!kinds.includes(String(v)))
            throw new Error(`Type: '${v}' is not one of ${kinds.join(", ")}`);
        this._type = String(v);
        /* The range depends on the type -- a stacked `Bar` measures totals and a
         * `Line` does not -- so a cached one is stale the moment this moves. The
         * cache also checks the type, for the same reason seen from the reader. */
        this._range = null;
        this.changed();
    }

    /**
     * the data: `[{ Name, Values, Color, Colors, Axis, Type, X, Sizes,
     * Format, Unit, Mirror, Hidden }]` — see below. Defaults to `[]`.
     * Assigning it redraws
     */
    get Series() { return this._series || []; }
    set Series(v) {
        if (!Array.isArray(v)) throw new Error("Series expects an array");
        this._range = null;
        this._series = v.map((s, i) => {
            /* **A value that is not a number is a gap, not a zero.** `Number()`
             * alone made `null` and `""` a zero -- a reading that never arrived
             * drawn as a reading of nothing -- and made `undefined` and `"n/a"` a
             * NaN that reached the painter, which refuses it and loses the frame.
             * Every non-number is NaN here, and every drawing skips NaN: a line
             * stops at the gap and starts again after it. */
            const values = (s.Values || []).map(ChartDocument.numberOf);
            return {
                Name:   String(s.Name === undefined ? `Series ${i + 1}` : s.Name),
                /* **A mirrored series is drawn below the axis**, which is what
                 * a butterfly is: the entries one way and the exits the other,
                 * facing each other. The values are negated here, once, because
                 * everything below measures and draws what the series carries;
                 * the labels go through `text()`, which writes the absolute
                 * value, so an axis of a mirror never says "-1,80". */
                Values: s.Mirror ? values.map((n) => -n) : values,
                Color:  String(s.Color || ""),
                /* **A colour per value**, for the charts where a value is a shape
                 * of its own: a slice of a pie or a doughnut, and a bar. What a
                 * value's colour *means* -- a severity, a status -- is the
                 * caller's, and a palette by position cannot know it: Zabbix's
                 * *Disaster* is red because everybody reading the chart knows it
                 * is. An entry that is missing or `""` is the colour the chart
                 * would have chosen. */
                Colors: ChartDocument.colorsOf(s.Colors),
                /* **Which axis it is measured against.** Two series in different
                 * units -- pesos and per cent, requests and milliseconds -- cannot
                 * share a scale, and putting them on one is the classic chart that
                 * lies. `Right` gives that series its own range, its own ticks and
                 * its own margin; everything else stays on `Left`. */
                Axis:   s.Axis === "Right" ? "Right" : "Left",
                /* **Bars and lines on one plot.** A series may say how it is drawn,
                 * whatever the chart's `Type`: the counts as bars and the rate as a
                 * line over them, usually on its own axis. `""` is the chart's. */
                Type:   ChartDocument.kindOf(s.Type, i),
                /* A scatter's horizontal positions, one per value -- a number each,
                 * a gap otherwise -- and a bubble's sizes. Without `X` the points
                 * stand at their index. */
                X:      (s.X || []).map(ChartDocument.numberOf),
                Sizes:  (s.Sizes || []).map(ChartDocument.numberOf),
                /* How this series' numbers are written -- `""` is the document's
                 * `Decimals`, the rest are the words the application uses. The
                 * axis of a side takes its `Format`/`Unit`/`Mirror` from its
                 * first series, and a bar, a slice and a readout from their own. */
                Format: ChartDocument.formatOf(s.Format, i),
                /* A suffix with no unit of its own: `"GB"`, `"ms"`. `Percent`,
                 * `Duration` and `Bits` carry theirs. */
                Unit:   s.Unit === undefined || s.Unit === null ? "" : String(s.Unit),
                /* **A mirrored series is drawn below the axis** -- see `Values`. */
                Mirror: !!s.Mirror,
                /* **Out of the drawing and out of the range**, and still in the
                 * legend, where a click on it takes it out and puts it back. */
                Hidden: !!s.Hidden,
            };
        });
        this.changed();
    }

    static formatOf(v, i) {
        if (v === undefined || v === null) return "";
        const said = String(v);
        if (!SERIES_FORMATS.includes(said))
            throw new Error(`Series[${i}].Format: '${v}' is not one of ${SERIES_FORMATS.filter(Boolean).join(", ")}`);
        return said;
    }

    static kindOf(v, i) {
        if (v === undefined || v === null || v === "") return "";
        if (!["Bar", "Line", "Area"].includes(String(v)))
            throw new Error(`Series[${i}].Type: '${v}' is not one of Bar, Line, Area`);
        return String(v);
    }

    /*
     * A gauge's coloured ranges: each runs from where the one before ended (the
     * first from `YMin`) to its `To`, and the needle's arc takes the colour of
     * the range its value is in -- green, amber, red is what a dial means.
     */
    /**
     * a `Gauge`'s coloured ranges, `[{ To, Color, Name }]` in rising order: each
     * runs from the end of the one before (the first from `YMin`) to `To`, and
     * the value's arc takes the colour of the range it falls in. Other types
     * ignore it. Defaults to `[]`.
     */
    get Bands() { return this._bands || []; }
    set Bands(v) {
        if (!Array.isArray(v)) throw new Error("Bands expects an array of {To, Color}");
        this._bands = v.map((b, i) => {
            const to = ChartDocument.numberOf(b && b.To);
            if (!isFinite(to)) throw new Error(`Bands[${i}].To is not a number`);
            return { To: to, Color: String((b && b.Color) || ""), Name: String((b && b.Name) || "") };
        });
        this.changed();
    }

    /*
     * **A threshold is a line, a rule paints by value.** `Lines` is one
     * horizontal line per `Value` -- an SLO at 99.9, an alert level -- drawn
     * across the plot at its y with its text at the right edge. `Marks` is
     * vertical and by index, `Bands` is a gauge's ranges, and none of the
     * three is another: a rule that colours a reading is a property of the
     * caller's, which is why the application keeps its own list of those.
     */
    /**
     * horizontal reference lines, `[{ Value, Color, Text, Width }]`, drawn
     * across the plot at `yOf(Value)` with the text at the right edge. A
     * `Value` outside the axis is not drawn; `Width` defaults to `1.5`, and
     * `Color` to the chart's ink. Defaults to `[]`.
     */
    get Lines() { return this._lines || []; }
    set Lines(v) {
        if (!Array.isArray(v)) throw new Error("Lines expects an array of {Value, Color, Text, Width}");
        this._lines = v.map((l, i) => {
            const value = ChartDocument.numberOf(l && l.Value);
            if (!isFinite(value)) throw new Error(`Lines[${i}].Value is not a number`);
            const width = l && l.Width !== undefined && l.Width !== null && l.Width !== ""
                ? ChartDocument.numberOf(l.Width) : 1.5;
            if (!isFinite(width) || width <= 0) throw new Error(`Lines[${i}].Width is not a positive number`);
            return { Value: value, Color: String((l && l.Color) || ""),
                     Text: String((l && l.Text) || ""), Width: width };
        });
        this.changed();
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
    /**
     * the category axis, as strings. As many as there are values is a label per
     * bar; **fewer** is marks spread evenly across the plot; a pie names its
     * slices from them. Defaults to `[]`.
     */
    get Labels() { return this._labels || []; }
    set Labels(v) {
        if (!Array.isArray(v)) throw new Error("Labels expects an array of strings");
        this._labels = v.map(String);
        this.changed();
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
    /**
     * `[{ At, Text }]`, `At` being an index into the values — a **real** time
     * axis, where the caller says where each label goes. Replaces `Labels` on
     * the x axis while it is set. Defaults to `[]`.
     */
    get Marks() { return this._marks || []; }
    set Marks(v) {
        if (!Array.isArray(v)) throw new Error("Marks expects an array of {At, Text}");
        this._marks = v.map((m) => ({ At: Number(m.At) || 0, Text: String(m.Text) }));
        this.changed();
    }

    /**
     * `None` `Top` `Bottom`. It wraps to at most **three** rows and whatever
     * did not fit is not drawn: a legend of thirty series is the wrong control,
     * and eating the plot to hold one is worse. Defaults to `"Bottom"`.
     */
    get Legend() { return this._legend || "Bottom"; }
    set Legend(v) {
        const where = Chart.Options.Legend;
        if (!where.includes(String(v)))
            throw new Error(`Legend: '${v}' is not one of ${where.join(", ")}`);
        this._legend = String(v);
        this.changed();
    }

    /** the horizontal rules behind the data. Defaults to `true`. */
    get Grid() { return this._grid === undefined ? true : this._grid; }
    set Grid(v) { this._grid = !!v; this.changed(); }

    /*
     * **Stacked bars, and why this one is accepted everywhere rather than
     * refused.** A property a class can *never* honour refuses -- that is what
     * `Grid.Arrangement` does. This one the same class honours in one mode and
     * ignores in the others, and a `.form` may well set it before it sets `Type`,
     * so refusing on the strength of another property's current value would make
     * the order of two lines in a file matter. It is accepted, it applies to
     * `Bar`, and it says so here.
     */
    /**
     * series piled instead of side by side. Applies to `Bar` and `Area`; a line
     * and a pie **ignore** it rather than refusing, so the order of two lines
     * in a `.form` never matters. Defaults to `false`.
     */
    get Stacked() { return this._stacked === undefined ? false : this._stacked; }
    /* Bars and areas both stack; a line and a pie do not, and say so by ignoring
     * it -- see the note above. */
    set Stacked(v) { this._stacked = !!v; this._range = null; this.changed(); }

    /* The number on the bar or the percentage in the slice, drawn only where it
     * fits -- which is measured, not assumed. */
    /**
     * the number on the bar or the percentage in the slice, drawn only where it
     * measures as fitting. Defaults to `false`.
     */
    get ShowValues() { return this._showValues === undefined ? false : this._showValues; }
    set ShowValues(v) { this._showValues = !!v; this.changed(); }

    /* What one entry of `Values` means: a number, or a gap (NaN). */
    /* `Colors` is a list of colours or nothing. A string is refused rather
     * than read as one colour for every value -- that is `Color`, and the two
     * spelt alike are the mistake worth catching where it is written. */
    static colorsOf(v) {
        if (v === undefined || v === null) return [];
        if (!Array.isArray(v)) throw new Error("Series[].Colors expects an array, one colour per value");
        return v.map((c) => (c === undefined || c === null) ? "" : String(c));
    }

    static numberOf(v) {
        if (v === null || v === undefined || typeof v === "boolean") return NaN;
        if (typeof v === "string" && v.trim() === "") return NaN;
        const n = Number(v);
        return isFinite(n) ? n : NaN;
    }

    /* `YMin`/`YMax`: `""` is worked out, a finite number pins, and anything else
     * is refused here rather than stored as a NaN the axis arithmetic would turn
     * into no ticks -- and the frame into a throw. */
    static pinOf(name, v) {
        if (v === "" || v === null || v === undefined) return undefined;
        const n = typeof v === "string" && v.trim() === "" ? NaN : Number(v);
        if (!isFinite(n))
            throw new Error(`${name}: '${v}' is not a number -- "" works it out from the data`);
        return n;
    }

    /** above the plot. **Translated**. Defaults to `""`. */
    get Title() { return this._title || ""; }
    set Title(v) { this._title = String(v); this.changed(); }

    /* Empty means worked out from the data, which is what an axis is for. A
     * number pins that end of it. */
    /**
     * pins the bottom of the y axis; `""` (or `null`) works it out from the
     * data, on *nice* numbers rather than on the data's own extremes. A value
     * that is not a finite number is refused where it is assigned — stored, it
     * left the axis with no ticks and every frame threw. Defaults to `""`.
     */
    get YMin() { return this._ymin === undefined ? "" : this._ymin; }
    set YMin(v) { this._ymin = ChartDocument.pinOf("YMin", v); this.changed(); }

    /** likewise the top. Defaults to `""`. */
    get YMax() { return this._ymax === undefined ? "" : this._ymax; }
    set YMax(v) { this._ymax = ChartDocument.pinOf("YMax", v); this.changed(); }

    /**
     * how the numbers are written, `0` to `6`; goes through `Locale.Number`, so
     * the separators are the user's. Defaults to `0`.
     */
    get Decimals() { return this._decimals === undefined ? 0 : this._decimals; }
    set Decimals(v) {
        const n = Number(v);
        if (!(n >= 0 && n <= 6)) throw new Error(`Decimals: ${v} is not 0 to 6`);
        this._decimals = n;
        this.changed();
    }

    /* Antialiasing is exposed because the measurement says it is the one knob
     * worth having, and refused as a promise: `reduce()` below is what actually
     * keeps a long series cheap. Named after the `Painter` property it sets --
     * it was `Smooth`, which is what the *next* one is actually about. */
    /**
     * smooth edges. Off is faster and looks it; `Reduced` is the knob that
     * actually matters. Defaults to `true`.
     */
    get Antialias() { return this._antialias === undefined ? true : this._antialias; }
    set Antialias(v) { this._antialias = !!v; this.changed(); }

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
    /**
     * rounded lines for `Line` and `Area`, **monotone**: between two samples
     * the curve stays between their values and flattens at a peak instead of
     * inventing a taller one. Off by default because a curve says something
     * about values nobody measured. Defaults to `false`.
     */
    get Curved() { return this._curved === undefined ? false : this._curved; }
    set Curved(v) { this._curved = !!v; this.changed(); }

    /* On by default, and a property so the example can turn it off and measure
     * the difference -- which is the only way anybody believes it. */
    /**
     * more points than pixel columns are decimated to a min and a max per
     * column, which keeps the envelope — a one-sample spike survives it.
     * Defaults to `true`. On by default
     */
    get Reduced() { return this._reduced === undefined ? true : this._reduced; }
    set Reduced(v) { this._reduced = !!v; this.changed(); }

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
    /** the first value on screen. Defaults to `0`. */
    get From() { return this._from || 0; }
    set From(v) { this._from = Math.max(0, Math.round(Number(v) || 0)); this.changed(); }

    /** how many are on screen; `0` is all of them. Defaults to `0`. */
    get Count() { return this._count || 0; }
    set Count(v) {
        const n = Math.round(Number(v) || 0);
        this._count = n > 0 ? n : 0;
        this.changed();
    }

    /**
     * lets the wheel zoom and a drag pan — the arithmetic of it is
     * `ZoomAt`/`PanBy`/`Press`/`Move`/`Release`, so a drawing that forwards a
     * pointer gets the same window a `Chart` does. Off by default, so a chart
     * of four bars never steals a scroll from the `Scroller` around it.
     * Defaults to `false`.
     */
    get Zoomable() { return this._zoomable === undefined ? false : this._zoomable; }
    set Zoomable(v) { this._zoomable = !!v; this.changed(); }

    /* The window as it really is: clamped to the data, never fewer than two
     * slots -- unless there is only one, which is then the whole of it and sits
     * in the middle (forcing two put a lone bar or point a quarter of the way
     * across) -- and never hanging off the end. Everything that maps an index
     * to an x goes through this, so there is one place the arithmetic can be
     * wrong. */
    view() {
        const n     = this.slots();
        const count = Math.max(Math.min(2, n), Math.min(n, this._count || n));
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

    /* Two of the types are a circle rather than a plot, and enough of the
     * code below turns on that to be worth a word of its own. */
    get round() { return this.Type === "Pie" || this.Type === "Doughnut"; }

    /* How a series is drawn on a plot: its own `Type`, else the chart's. */
    kind(s) { return (s && s.Type) || (this.Type === "Area" || this.Type === "Line" ? this.Type : "Bar"); }

    /* The horizontal range of a scatter, on nice numbers like the vertical
     * one -- but **not through zero**: a scatter of response times between 200
     * and 900 ms is a cloud, and an axis from zero squeezes it into a corner. */
    xRange() {
        let lo = Infinity, hi = -Infinity;
        for (const s of this.Series) {
            if (s.Hidden) continue;
            s.Values.forEach((v, i) => {
                const x = s.X.length ? s.X[i] : i;
                if (!isFinite(x) || !isFinite(v)) return;
                if (x < lo) lo = x;
                if (x > hi) hi = x;
            });
        }
        if (!isFinite(lo)) { lo = 0; hi = 1; }
        if (hi === lo) { lo -= 1; hi += 1; }
        /* A twentieth of room at each end, so a point -- a bubble, above all
         * -- at the extreme value is not cut in half by the plot's edge. */
        const pad = (hi - lo) / 20;
        lo -= pad; hi += pad;
        const at = this.ticks(lo, hi);
        return { ticks: at, lo: Math.min(lo, at[0]), hi: Math.max(hi, at.at(-1)) };
    }

    /* The x of a scatter's value. */
    xAt(box, x) { return box.left + (x - box.x.lo) / (box.x.hi - box.x.lo) * (box.right - box.left); }

    /* The data or a property moved: the control showing it, if any, redraws. */
    changed() { if (this.owner) this.owner.Refresh(); }

    /**
     * the drawing to a PNG of any size. **No widget and no display**: it draws
     * through `Drawing`, so a `main` project has charts too
     */
    Save(path, width, height) {
        Drawing.Save(path, width, height, (p, w, h) => this.Paint(p, w, h));
    }

    /**
     * the same drawing as `Save`, answered as `Bytes` — a chart to attach or
     * put in a reply, with nothing on disk
     * @returns Bytes
     */
    ToPng(width, height) {
        return Drawing.ToPng(width, height, (p, w, h) => this.Paint(p, w, h));
    }

    /**
     * what the last `Paint` drew at a point, in the coordinates it drew in:
     * `{ Series, At, Value }` — the bar, the point or the slice a click there
     * means, `At` an index into that series' `Values` — or `null`. What a
     * drawing that holds a document of its own (a dashboard, a page) answers a
     * click with, since only a `Chart` hears the pointer. Nothing drawn yet
     * is `null`
     */
    HitTest(x, y) {
        if (!isFinite(x) || !isFinite(y)) return null;
        const hit = this.at(x, y);
        return hit ? { Series: hit.series, At: hit.at, Value: hit.value } : null;
    }

    /**
     * the legend entry at a point, in the same coordinates: `{ Series, At }` —
     * `Series` is the one to hide or show and `At` the entry that was hit (the
     * slice's index on a pie, the series' own on a plot) — or `null`. Nothing
     * when the legend is `None` or nothing has been drawn yet
     */
    LegendHit(x, y) {
        if (!isFinite(x) || !isFinite(y)) return null;
        for (let i = (this.legendHits || []).length - 1; i >= 0; i--) {
            const h = this.legendHits[i];
            if (x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h)
                return { Series: h.Series, At: h.At };
        }
        return null;
    }

    /**
     * what a tooltip would say at a point, in the coordinates of the last
     * `Paint`: `{ Text, X, Y, Width, Height }` — the label, the series and the
     * value under it, formatted with that series' `Format`, in a box measured
     * with the font the frame drew with — or `null` when nothing is there.
     * **The document does not draw it**: a drawing that keeps a document of
     * its own places the card with its own ink and its own theme, which is why
     * the box comes measured and placed beside the point
     */
    Tooltip(x, y) {
        const on = this.at(x, y);
        if (!on) return null;
        const s = this.Series[on.series];
        const spot = this.spotOf(on);
        if (!s || !spot) return null;

        const label = this.Labels[on.at] !== undefined ? this.Labels[on.at] : on.at;
        const text = this.Type === "Scatter"
            ? `${label}: ${this.text(spot.xv, s)}, ${this.text(on.value, s)}`
            : this.Series.length > 1 ? `${s.Name} — ${label}: ${this.text(on.value, s)}`
                                     : `${label}: ${this.text(on.value, s)}`;

        const font   = this._font || "";
        const width  = Text.Width(text, font) + 12;
        const height = Text.Height(text, font) + 10;
        const room   = this._size || { width: 0, height: 0 };
        return { Text: text,
                 X: Math.max(0, Math.min(spot.x + 10, Math.max(0, room.width - width))),
                 Y: Math.max(0, Math.min(spot.y - height - 6, Math.max(0, room.height - height))),
                 Width: width, Height: height };
    }

    /* Where a point of a hit was drawn -- the anchor a tooltip or a readout
     * sits beside. `null` for a hit whose drawing is not there. */
    spotOf(on) {
        if (this.Type === "Scatter") {
            const q = (this.points || []).find((p) => p.series === on.series && p.at === on.at);
            return q ? { x: q.x, y: q.y, xv: q.xv } : null;
        }
        if (this.Type === "Heatmap") {
            const c = (this.cells || []).find((p) => p.series === on.series && p.at === on.at);
            return c ? { x: c.x + c.w / 2, y: c.y + c.h / 2 } : null;
        }
        if (this.Type === "Gauge") {
            const d = this.dial;
            return d ? { x: d.cx, y: d.cy - d.r / 2 } : null;
        }
        if (this.round) {
            const sl = (this.slices || []).find((p) => p.at === on.at);
            if (!sl) return null;
            const mid = (sl.from + sl.to) / 2 * Math.PI / 180;
            const at  = sl.hole ? (sl.r + sl.hole) / 2 : sl.r * 0.62;
            return { x: sl.cx + at * Math.cos(mid), y: sl.cy + at * Math.sin(mid) };
        }
        const box = this.lastBox;
        if (!box || !box.view) return null;
        const s = this.Series[on.series];
        return { x: this.xOf(box, on.at),
                 y: this.yOf(box, this.stackedArea() ? this.stackTop(on.series, on.at) : on.value, s) };
    }

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
        /* **Never a step finer than the labels can write.** With no decimals,
         * counts of one or two got ticks at 0, 0.2, 0.4… written "0, 0, 0,
         * 1, 1": five labels and two numbers. The step is at least what
         * `Decimals` can tell apart. */
        const finest = Math.pow(10, -this.Decimals);
        const step = Math.max(finest, [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) || mag * 10);

        /* A span a double cannot step through -- one too small to divide, or a
         * `lo + 1` that rounded back to `lo` -- still gets an axis: its two
         * ends. No ticks at all is `Math.max()` of nothing, and a frame that
         * clips to minus infinity throws. */
        if (!(step > 0) || !isFinite(step) || !(lo + step > lo)) return [lo, hi];

        const from = Math.floor(lo / step) * step;
        const to   = Math.ceil(hi / step) * step;
        const out  = [];

        /* Counted rather than accumulated: adding a step repeatedly turns 0.1
         * into 0.30000000000000004 and puts that on the axis. */
        for (let i = 0; from + i * step <= to + step / 1e6 && i < 1000; i++)
            out.push(from + i * step);
        return out.length && out.every(isFinite) ? out : [lo, hi];
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
     * when there is something to put on the second one -- and a hidden one is
     * not something, so an axis whose only series went out of the legend goes
     * with it. */
    get twoAxes() {
        return !this.round && this.Series.some((s) => s.Axis === "Right" && !s.Hidden);
    }

    /* The series an axis takes its `Format`, `Unit` and `Mirror` from: the
     * first one measured on that side, which is also the one whose labels
     * describe the numbers on it. `null` when the side has nothing, and then
     * the document's own `Decimals` writes them. */
    axisSeries(side = "Left") {
        const mine = this.twoAxes ? this.Series.filter((s) => s.Axis === side) : this.Series;
        return mine.find((s) => !s.Hidden) || mine[0] || null;
    }

    range(side = "Left") {
        const cache = this._range && this._range[side];
        if (cache && cache.series === this._series && cache.stacked === this.Stacked &&
            cache.type === this.Type && cache.decimals === this.Decimals &&
            cache.ymin === this._ymin && cache.ymax === this._ymax)
            return cache.at;

        const mine = (this.twoAxes
            ? this.Series.filter((s) => s.Axis === side) : this.Series.slice())
            .filter((s) => !s.Hidden);

        let lo = 0, hi = 0, any = false;

        if (this.Stacked && (this.Type === "Bar" || this.Type === "Area")) {
            /* **A stacked axis measures the totals, not the tallest series.** The
             * first version reached the top of the largest single value and every
             * stack ran off the plot, which is the sort of thing that reads as a
             * clipping bug. Positives and negatives stack away from zero
             * separately, since a stack of both is two bars from the baseline.
             * A series drawn another way (a line over stacked bars) is not in
             * the stack: it is measured on its own, below. */
            const stacked = mine.filter((s) => this.kind(s) === this.Type);
            for (const s of mine) {
                if (stacked.includes(s)) continue;
                for (const v of s.Values) {
                    if (!isFinite(v)) continue;
                    if (v < lo) lo = v;
                    if (v > hi) hi = v;
                    any = true;
                }
            }
            for (let i = 0; i < this.slots(); i++) {
                let up = 0, down = 0;
                for (const s of stacked) {
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
        /* A scatter's points are circles: one at the top value would be cut in
         * half by the plot's edge, so the top gets a twentieth of room. */
        if (this.Type === "Scatter" && hi > lo) hi += (hi - lo) / 20;
        if (this._ymin !== undefined) lo = this._ymin;
        if (this._ymax !== undefined) hi = this._ymax;

        /* **A span wider than a double is a range with no arithmetic in it**:
         * `[1e308, -1e308]` is two finite values whose difference is infinity,
         * and every y worked out over it is NaN -- which the painter refuses,
         * losing the frame. Halved at each end until it fits; what is beyond it
         * is clipped, which is what a pinned axis does anyway. */
        const LIMIT = Number.MAX_VALUE / 4;
        if (!isFinite(hi - lo)) { lo = Math.max(lo, -LIMIT); hi = Math.min(hi, LIMIT); }

        const at   = this.ticks(lo, hi);
        const done = { ticks: at, lo: Math.min(lo, at[0]), hi: Math.max(hi, at.at(-1)) };

        if (!this._range) this._range = {};
        this._range[side] = { series: this._series, ymin: this._ymin,
                              ymax: this._ymax, stacked: this.Stacked,
                              type: this.Type, decimals: this.Decimals, at: done };
        return done;
    }

    /*
     * One number, as an axis, a bar, a slice or a readout writes it. The series
     * says how -- its `Format`, its `Unit` and whether it is a mirror -- and
     * without a series the document's own `Decimals` decides, which is what the
     * numbers that belong to no series use (a scatter's x ticks, a heatmap's
     * scale). A mirrored series writes the absolute value: the sign is the
     * drawing's, and the axis of a butterfly says `1,80` and not `-1,80`.
     */
    text(v, s) {
        const n = Number(v);
        if (!isFinite(n)) return String(v);
        const value  = s && s.Mirror ? Math.abs(n) : n;
        const format = (s && s.Format) || "";
        if (format === "Duration") return ChartDocument.duration(value);
        if (format === "Bits")     return ChartDocument.bits(value);
        const said = Locale.Number(value, this.Decimals);
        if (format === "Percent") return `${said} %`;
        return said + (s && s.Unit ? ` ${s.Unit}` : "");
    }

    /* Seconds as the application's cards write them: `45s`, `3m`, `2h 5m`,
     * `1d 2h 0m` -- whole units, the largest first. Shared vocabulary means
     * shared arithmetic: two formatters for one word drift the first time one
     * of them changes. */
    static duration(seconds) {
        let s = Math.max(0, Math.floor(Number(seconds) || 0));
        if (s < 60) return `${s}s`;
        const d = Math.floor(s / 86400); s -= d * 86400;
        const h = Math.floor(s / 3600);  s -= h * 3600;
        const m = Math.floor(s / 60);
        const parts = [];
        if (d) parts.push(`${d}d`);
        if (h || d) parts.push(`${h}h`);
        parts.push(`${m}m`);
        return parts.join(" ");
    }

    /* Bits per second in the unit that keeps the figure short. */
    static bits(v) {
        const n = Number(v);
        if (!isFinite(n)) return String(v);
        for (const [k, u] of [[1e9, "Gbps"], [1e6, "Mbps"], [1e3, "Kbps"]])
            if (Math.abs(n) >= k) return `${Locale.Number(n / k, 1)} ${u}`;
        return `${Locale.Number(n, 0)} bps`;
    }

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
        /* Each side's labels are measured with the format of *its* first
         * series: a GB axis is wider than its bare numbers, and measuring the
         * numbers alone is how the labels come out over the plot. */
        const left   = this.axisSeries("Left");
        const widest = Math.max(...at.ticks.map((v) => p.TextWidth(this.text(v, left))));
        /* The right margin is the right axis's widest label, measured the same
         * way the left one is -- or 8, when there is no second axis. */
        const other  = this.twoAxes ? this.range("Right") : null;
        const right  = this.twoAxes ? this.axisSeries("Right") : null;
        const wideR  = other
            ? Math.max(...other.ticks.map((v) => p.TextWidth(this.text(v, right)))) + 12 : 8;

        return {
            ...at,
            /* A scatter's horizontal axis, which is numbers and not slots. */
            x:      this.Type === "Scatter" ? this.xRange() : null,
            /* The window every index-to-x goes through, worked out once a frame. */
            view:   this.view(),
            left:   widest + 12,
            right:  width - wideR,
            /* The second axis's own range, so everything below can ask for the
             * one a series belongs to without working it out again -- and the
             * series each side writes its labels with. */
            other,
            leftSeries:  left,
            rightSeries: right,
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
            /* A column with no number in it is a gap, and it stays one: skipping
             * it would join the line across readings that never arrived. Kept
             * once, however many empty columns follow. */
            if (!isFinite(lo)) {
                if (out.length && isFinite(out[out.length - 1][1])) out.push([at, NaN]);
                continue;
            }
            /* In the order they occur, or the line zigzags where the data does
             * not. */
            if (loAt <= hiAt) { out.push([loAt, lo], [hiAt, hi]); }
            else              { out.push([hiAt, hi], [loAt, lo]); }
        }

        this._reduction = { values, columns, from, to, points: out };
        return out;
    }

    /* ---------------------------------------------------------------- drawing */

    /**
     * draws the chart with `p` into `width`×`height` — for a painter something
     * else opened: a `Drawing`, a report's page, a `DrawPage` of your own. The
     * ink is the painter's `Foreground`, so on paper it is black
     */
    Paint(p, width, height) {
        const watch = new Stopwatch().Start();
        this.frames = (this.frames || 0) + 1;

        p.Antialias = this.Antialias;
        const ink = p.Foreground;
        /* What the frame drew with, for the tooltip and the legend hit: they
         * are asked after the picture exists, and measuring a card in another
         * font is how the two disagree. */
        this._font   = p.Font || "";
        this._size   = { width, height };
        this.legendHits = [];

        /* A dial and a grid of cells have no category axis and no y axis:
         * each lays itself out. */
        if (this.Type === "Gauge" || this.Type === "Heatmap") {
            this.bars = []; this.slices = []; this.points = [];
            if (this.Title) {
                p.Color = ink;
                p.Text(this.Title, 8, 8);
            }
            if (this.Type === "Gauge") this.drawGauge(p, ink, width, height);
            else this.drawHeat(p, ink, width, height);
            this.drawn = watch.Elapsed;
            return;
        }

        const leg = this.legendLayout(p, width);
        const box = this.plot(p, width, height, leg);

        if (this.Title) {
            p.Color = ink;
            p.Text(this.Title, this.round ? 8 : box.left, 8);
        }

        /* A pie has no axes to draw and nothing to clip against: it is the one
         * shape here that is not a plot over a range, so it takes the whole of
         * the room the legend does not want and goes its own way. */
        if (this.round) {
            this.slices = [];
            /* A pie has no window, and the box still says where it was drawn:
             * the wheel and `LegendHit` ask a frame that exists. */
            this.lastBox = box;
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
        this.points  = [];
        this.lastBox = box;              /* what the hit test measures against */
        if (this.Type === "Scatter") this.drawPoints(p, box);
        else {
            /* Bars first, so a line drawn over them stays on top. */
            this.drawBars(p, box);
            this.drawLines(p, box);
        }
        /* A threshold is drawn **over** the data -- a reference line behind
         * the bars is one nobody can find -- and under the value labels. */
        this.drawThresholds(p, box, ink);
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
        /* Divided before it is multiplied: a span near the top of a double
         * times the plot's height is infinity, and a share of it is not. */
        return box.bottom - (v - on.lo) / (on.hi - on.lo) * (box.bottom - box.top);
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

    /*
     * The horizontal reference lines: one per `Lines` entry, at its own value,
     * across the whole plot, with its text at the right edge. **A value the
     * axis does not reach is omitted**, not clamped to the border -- a
     * threshold past `YMax` is a pinned axis saying it does not apply, and a
     * line drawn on the edge says the opposite.
     */
    drawThresholds(p, box, ink) {
        if (!this.Lines.length) return;

        for (const line of this.Lines) {
            if (!(line.Value >= box.lo && line.Value <= box.hi)) continue;
            const y     = this.yOf(box, line.Value);
            const colour = line.Color || this.alpha(ink, DIM_ALPHA);

            p.Color     = colour;
            p.LineWidth = line.Width;
            p.MoveTo(box.left, y);
            p.LineTo(box.right, y);
            p.Stroke();
            p.LineWidth = 1;

            if (line.Text) {
                const wide = p.TextWidth(line.Text);
                const left = Math.max(box.left, Math.min(box.right - wide, box.right - wide - 2));
                const top  = y - box.line - 2 >= box.top ? y - box.line - 2 : y + 2;
                p.Text(line.Text, left, Math.min(top, box.bottom - box.line));
            }
        }
    }

    axes(p, box, ink, width) {
        p.Color = this.alpha(ink, DIM_ALPHA);

        for (const v of box.ticks) {
            const said = this.text(v, box.leftSeries);
            p.Text(said, box.left - 8 - p.TextWidth(said),
                   this.yOf(box, v) - box.line / 2);
        }

        /* **And the right-hand axis, when a series asked for one.** Its ticks are
         * its own and its labels sit outside the plot on the other side; the grid
         * stays the left axis's, because two grids over one plot is a drawing
         * nobody can read a value off. */
        if (box.other)
            for (const v of box.other.ticks) {
                const y = this.yOf(box, v, { Axis: "Right" });

                p.Text(this.text(v, box.rightSeries), box.right + 8, y - box.line / 2);
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

        /* A scatter's x axis is numbers, at their own positions. */
        if (box.x) {
            const placed = box.x.ticks.map((v) => ({ said: this.text(v), at: this.xAt(box, v) }));
            const room = Math.max(...placed.map((m) => p.TextWidth(m.said)), 1) + 8;
            const apart = placed.length > 1 ? Math.abs(placed[1].at - placed[0].at) : room;
            const every = Math.max(1, Math.ceil(room / Math.max(apart, 1)));
            for (let i = 0; i < placed.length; i += every) {
                const { said, at } = placed[i];
                p.Text(said, Math.max(0, Math.min(at - p.TextWidth(said) / 2, width - p.TextWidth(said))), box.bottom + 4);
            }
            return;
        }

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
        const mine   = this.Series.filter((s) => !s.Hidden && this.kind(s) === "Bar");
        if (!mine.length) return;
        const step   = (box.right - box.left) / box.view.count;
        const groups = this.Stacked ? 1 : Math.max(1, mine.length);
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
            if (s.Hidden || this.kind(s) !== "Bar") return;
            /* Its place among the bars, not among every series: a line beside
             * two bar series leaves no empty third slot in each group. */
            const g = mine.indexOf(s);
            p.Color = this.colour(s, k);
            const own = s.Colors.length > 0;
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
                    x     += wide * g;
                    const y    = this.yOf(box, v, s);
                    const zero = zeroOf(s);
                    top    = Math.min(y, zero);
                    bottom = Math.max(y, zero);
                }

                /* A series with colours of its own fills bar by bar; one
                 * without fills once, as one path, which is the cheap case a
                 * twenty-thousand-sample window is. */
                if (own) p.Color = this.valueColour(s, k, i);
                p.Rectangle(x, top, wide - 1, Math.max(0, bottom - top));
                if (own) p.Fill();
                /* Where the pointer will land, kept as it is drawn: the hit test
                 * has no other way to know, and working it out twice is how the
                 * two answers drift apart. */
                this.bars.push({ x, y: top, w: wide - 1, h: Math.max(0, bottom - top),
                                 series: k, at: i, value: v });
            }
            if (!own) p.Fill();
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
            const said = this.text(b.value, this.Series[b.series]);
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

        /* **A stack is decimated on one set of indices, not one per series.**
         * Reduced separately, each series keeps its own min and max per column
         * -- different samples -- so the second band looked up `under[i]` at an
         * index the first never wrote, found nothing, and fell to the baseline.
         * The indices come from the totals, whose envelope is the stack's. */
        const shared = stack ? this.stackIndices(columns, box.view) : null;

        this.Series.forEach((s, k) => {
            if (s.Hidden || this.kind(s) === "Bar") return;
            const area = this.kind(s) === "Area";
            /* **The window is decimated, not the series.** Zoomed out, two points
             * a pixel column out of twenty thousand; zoomed in, every sample there
             * is -- which is the whole reason zooming a long series is worth
             * having, and it costs nothing because the reduction is per view. */
            const points = shared
                ? shared.map((i) => [i, s.Values[i]])
                : this.reduce(s.Values, columns, box.view);
            if (!points.length) return;

            /* **Runs, because a gap ends one.** Each run is a path of its own --
             * a line stops at a value that is not a number and starts again
             * after it, and an area closes each run against what it sits on. A
             * NaN handed to the painter is refused and the frame is lost with
             * it, so no NaN gets that far. */
            const runs = [];
            let flat = null, below = null;

            for (const [i, v] of points) {
                if (!isFinite(v)) { flat = null; continue; }
                if (!flat) { flat = []; below = []; runs.push({ flat, below }); }

                const x = this.xOf(box, i);

                if (stack) {
                    const from = under[i] || 0;
                    under[i] = from + v;
                    flat.push(x, this.yOf(box, under[i], s));
                    /* The band's floor, kept to walk back along: an area stacked
                     * on another is closed against *it* and not the baseline. */
                    below.unshift(x, this.yOf(box, from, s));
                } else {
                    flat.push(x, this.yOf(box, v, s));
                }
            }
            if (!runs.length) return;

            if (area) {
                p.Color = this.alpha(this.colour(s, k), 0.25);

                /* The same curve, then the way back: down to what it sits on,
                 * along it, and closed. A straight area could be one `Polygon`;
                 * a rounded one cannot, because a polygon has no curves in it --
                 * so both are built as a path and only this branch differs. */
                for (const run of runs) {
                    this.curveThrough(p, run.flat);
                    if (stack) this.curveThrough(p, run.below, true);
                    else {
                        p.LineTo(run.flat[run.flat.length - 2], box.bottom);
                        p.LineTo(run.flat[0], box.bottom);
                    }
                    p.ClosePath();
                }
                p.Fill();
            }

            p.Color     = this.colour(s, k);
            p.LineWidth = 2;
            p.LineJoin  = "Round";
            p.LineCap   = "Round";
            for (const run of runs) this.curveThrough(p, run.flat);
            p.Stroke();

            /* The dots, only when they are far enough apart to be dots rather
             * than a thicker line -- and where the line is: on a stack that is
             * the top of the band, not the series' own value. */
            if (points.length < (box.right - box.left) / 8)
                for (const run of runs)
                    for (let j = 0; j < run.flat.length; j += 2) {
                        p.Arc(run.flat[j], run.flat[j + 1], 2.5, 0, 360);
                        p.Fill();
                    }
        });
    }

    /*
     * A scatter: each value a point at (`X`, value), in its series' colour --
     * a bubble when the series has `Sizes`, scaled by area between the
     * smallest and the largest so a size twice as big *looks* twice as big.
     * Kept as drawn, for the hit test.
     */
    drawPoints(p, box) {
        this.Series.forEach((s, k) => {
            if (s.Hidden) return;
            const sizes = s.Sizes.filter(isFinite);
            const lo = sizes.length ? Math.min(...sizes) : 0, hi = sizes.length ? Math.max(...sizes) : 0;
            const own = s.Colors.length > 0;
            s.Values.forEach((v, i) => {
                const xv = s.X.length ? s.X[i] : i;
                if (!isFinite(v) || !isFinite(xv)) return;
                const x = this.xAt(box, xv), y = this.yOf(box, v, s);
                const size = s.Sizes[i];
                const r = isFinite(size) && hi > lo ? 3 + 11 * Math.sqrt((size - lo) / (hi - lo))
                        : isFinite(size) && sizes.length ? 8 : 3.5;
                p.Color = this.alpha(own ? this.valueColour(s, k, i) : this.colour(s, k), 0.75);
                p.Arc(x, y, r, 0, 360);
                p.Fill();
                this.points.push({ x, y, r, series: k, at: i, value: v, xv });
            });
        });
    }

    /*
     * A heatmap: each series a row, named by its `Name`; each slot a column,
     * named by `Labels`; each cell shaded by its value, from the ground to the
     * colour of the first series (or the palette's first) between the lowest
     * and the highest value -- or `YMin`/`YMax`, which pin the scale. A gap is
     * an empty cell, never the lowest shade: no reading is not a low one.
     */
    drawHeat(p, ink, width, height) {
        this.cells = [];
        const line = p.TextHeight("0");
        /* A hidden row leaves the drawing and the scale; the index it keeps is
         * the series' own, or a click on the row below answered for the wrong
         * one. */
        const rows = this.Series.filter((s) => !s.Hidden), cols = this.slots();
        if (!rows.length) return;
        let lo = Infinity, hi = -Infinity;
        for (const s of rows) for (const v of s.Values) if (isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
        if (this._ymin !== undefined) lo = this._ymin;
        if (this._ymax !== undefined) hi = this._ymax;
        if (!isFinite(lo)) { lo = 0; hi = 1; }
        const span = hi > lo ? hi - lo : 1;
        const base = (rows[0] && rows[0].Color) || PALETTE[0];
        const legend = this.Legend !== "None" ? line + 10 : 0;

        const left = Math.max(...rows.map((s) => p.TextWidth(s.Name)), 0) + 12;
        const top = 8 + (this.Title ? line + 8 : 0) + (this.Legend === "Top" ? legend : 0);
        const bottom = height - 8 - line - 4 - (this.Legend === "Bottom" ? legend : 0);
        const right = width - 8;
        const w = Math.max(1, (right - left) / cols), h = Math.max(1, (bottom - top) / rows.length);
        this.lastBox = { left, right, top, bottom, line };

        rows.forEach((s, k) => {
            const y = top + k * h;
            p.Color = this.alpha(ink, DIM_ALPHA);
            p.Text(s.Name, left - 8 - p.TextWidth(s.Name), y + (h - line) / 2);
            for (let i = 0; i < cols; i++) {
                const v = s.Values[i];
                if (!isFinite(v)) continue;
                const t = Math.max(0, Math.min(1, (v - lo) / span));
                const x = left + i * w;
                p.Color = this.alpha(base, 0.08 + 0.92 * t);
                p.Rectangle(x + 0.5, y + 0.5, Math.max(1, w - 1), Math.max(1, h - 1));
                p.Fill();
                this.cells.push({ x, y, w, h, series: this.Series.indexOf(s), at: i, value: v, t });
                if (this.ShowValues) {
                    const said = this.text(v, s);
                    if (p.TextWidth(said) + 4 <= w && line + 2 <= h) {
                        p.Color = t > 0.6 ? "#ffffff" : ink;
                        p.Text(said, x + (w - p.TextWidth(said)) / 2, y + (h - line) / 2);
                    }
                }
            }
        });

        /* The column labels, thinned until they fit, like a category axis. */
        p.Color = this.alpha(ink, DIM_ALPHA);
        const room = Math.max(...this.Labels.map((l) => p.TextWidth(l)), 1) + 8;
        const every = Math.max(1, Math.ceil(room / w));
        for (let i = 0; i < Math.min(cols, this.Labels.length); i += every) {
            const said = this.Labels[i];
            p.Text(said, left + i * w + (w - p.TextWidth(said)) / 2, bottom + 4);
        }

        /* The scale, in place of a legend: the shades from the lowest value to
         * the highest, each end named. */
        if (legend) {
            const ly = this.Legend === "Top" ? 8 + (this.Title ? line + 8 : 0) : height - legend + 2;
            const lw = Math.min(160, Math.max(40, right - left - 120));
            const lowText = this.text(lo, rows[0]), highText = this.text(hi, rows[0]);
            let x = left;
            p.Color = this.alpha(ink, DIM_ALPHA);
            p.Text(lowText, x, ly);
            x += p.TextWidth(lowText) + 6;
            for (let j = 0; j < 20; j++) {
                p.Color = this.alpha(base, 0.08 + 0.92 * j / 19);
                p.Rectangle(x + j * lw / 20, ly + 2, lw / 20 + 0.5, line - 4);
                p.Fill();
            }
            p.Color = this.alpha(ink, DIM_ALPHA);
            p.Text(highText, x + lw + 6, ly);
        }

        const on = this.hover && this.cells.find((c) => c.series === this.hover.series && c.at === this.hover.at);
        if (on) {
            p.Color = ink;
            p.LineWidth = 2;
            p.Rectangle(on.x + 1, on.y + 1, on.w - 2, on.h - 2);
            p.Stroke();
            p.LineWidth = 1;
        }
    }

    /*
     * A gauge: the first value of the first series on a half dial from `YMin`
     * (zero when not pinned) to `YMax` (the next nice number above the value
     * when not pinned). The track is grey, or the `Bands`' colours faintly; the
     * value's arc is solid, in the colour of the band it falls in -- or the
     * series' -- and the number is written in the middle, with `Labels[0]`
     * under it.
     */
    drawGauge(p, ink, width, height) {
        this.dial = null;
        this.lastBox = null;      /* no window to zoom or pan */
        const first = this.Series[0];
        const s = first && !first.Hidden ? first : null;
        const v = s ? s.Values.find((x) => isFinite(x)) : undefined;
        const line = p.TextHeight("0");
        const lo = this._ymin !== undefined ? this._ymin : Math.min(0, isFinite(v) ? v : 0);
        const hi = this._ymax !== undefined ? this._ymax
                 : this.ticks(lo, Math.max(isFinite(v) ? v : 1, lo + 1, ...this.Bands.map((b) => b.To))).at(-1);
        const span = hi > lo ? hi - lo : 1;
        const top = 8 + (this.Title ? line + 8 : 0);
        const room = height - top - 8 - line * 2 - 8;
        const r = Math.max(10, Math.min((width - 16) / 2, room));
        const cx = width / 2, cy = top + r;
        const inner = r * 0.72;
        const angle = (x) => 180 + 180 * Math.max(0, Math.min(1, (x - lo) / span));

        const ring = (from, to, colour) => {
            if (!(to > from)) return;
            const rad = from * Math.PI / 180;
            p.Color = colour;
            p.MoveTo(cx + inner * Math.cos(rad), cy + inner * Math.sin(rad));
            p.Arc(cx, cy, r, from, to);
            p.ArcNegative(cx, cy, inner, to, from);
            p.ClosePath();
            p.Fill();
        };

        ring(180, 360, this.alpha(ink, 0.12));
        let from = lo, colour = (s && s.Color) || PALETTE[0];
        for (const b of this.Bands) {
            ring(angle(from), angle(b.To), this.alpha(b.Color || ink, 0.3));
            if (isFinite(v) && v >= from && v <= b.To && b.Color) colour = b.Color;
            from = b.To;
        }
        if (isFinite(v)) ring(180, angle(v), colour);

        /* The number, as large as the hole lets it be -- written with the
         * series' own format, which is what makes an indicator say `%`. */
        const said = isFinite(v) ? this.text(v, s) : "—";
        const font = p.Font;
        const m = /(\d+(?:\.\d+)?)\s*$/.exec(font || "");
        if (m) {
            const size = Number(m[1]);
            const scale = Math.max(1, Math.min(4, inner * 0.8 / Math.max(1, p.TextWidth(said)), inner * 0.5 / line));
            p.Font = font.slice(0, m.index) + Math.round(size * scale * 10) / 10;
        }
        p.Color = ink;
        const big = p.TextHeight(said);
        p.Text(said, cx - p.TextWidth(said) / 2, cy - big);
        p.Font = font;
        p.Color = this.alpha(ink, DIM_ALPHA);
        const loText = this.text(lo, s), hiText = this.text(hi, s);
        p.Text(loText, cx - (r + inner) / 2 - p.TextWidth(loText) / 2, cy + 4);
        p.Text(hiText, cx + (r + inner) / 2 - p.TextWidth(hiText) / 2, cy + 4);
        if (this.Labels[0]) p.Text(this.Labels[0], cx - p.TextWidth(this.Labels[0]) / 2, cy + 4 + line);

        if (isFinite(v)) this.dial = { cx, cy, r, value: v };
    }

    /* The slots a stacked area draws: every one in the window when they fit,
     * and otherwise the min-and-max indices of the per-slot totals -- one list
     * for every series, cached like `reduce()` and on the same key. */
    stackIndices(columns, view) {
        const from = Math.max(0, view.from);
        const to   = Math.min(this.slots(), view.to);
        const many = to - from;
        const out  = [];

        if (many <= 0) return out;
        if (!this.Reduced || many <= columns * 2) {
            for (let i = from; i < to; i++) out.push(i);
            return out;
        }

        const cache = this._stackReduction;
        if (cache && cache.series === this._series && cache.columns === columns &&
            cache.from === from && cache.to === to)
            return cache.indices;

        /* The totals, with a slot no series has a number in left a gap -- so a
         * column of nothing stays a gap in every band. */
        const totals = [];
        for (let i = 0; i < to; i++) {
            if (i < from) { totals.push(NaN); continue; }
            let t = 0, any = false;
            for (const s of this.Series) {
                if (s.Hidden) continue;
                const v = s.Values[i];
                if (isFinite(v)) { t += v; any = true; }
            }
            totals.push(any ? t : NaN);
        }

        /* `reduce()` answers `[index, value]` in order; a gap marker keeps the
         * index of the column it stands for, which reads a NaN in every series
         * or a value -- either way the run is right. */
        const seen = new Set();
        for (const [i] of this.reduce(totals, columns, { from, to })) {
            if (!seen.has(i)) { seen.add(i); out.push(i); }
        }
        this._reduction = null;    /* that cache held the throwaway totals */
        this._stackReduction = { series: this._series, columns, from, to, indices: out };
        return out;
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

        /* A scatter's point is where it was drawn, and says both numbers. */
        if (this.Type === "Scatter") {
            const pt = (this.points || []).find((q) => q.series === on.series && q.at === on.at);
            if (!pt) return;
            p.Color = ink;
            p.LineWidth = 2;
            p.Arc(pt.x, pt.y, pt.r + 2, 0, 360);
            p.Stroke();
            p.LineWidth = 1;
            const said = `${this.Labels[on.at] || on.at}: ${this.text(pt.xv)}, ${this.text(pt.value, s)}`;
            const wide = p.TextWidth(said) + 10;
            const left = Math.min(pt.x + 8, box.right - wide);
            p.Color = this.alpha(p.Dark ? "rgb(0,0,0)" : "rgb(255,255,255)", 0.85);
            p.Rectangle(left, pt.y - box.line - 10, wide, box.line + 6);
            p.Fill();
            p.Color = ink;
            p.Text(said, left + 5, pt.y - box.line - 8);
            return;
        }

        const x = this.xOf(box, on.at);
        /* **On a stacked area the point is the top of its band**, not the
         * series' own value: a second band of 3 over a first of 5 is drawn at
         * 8, and a mark at 3 sat inside somebody else's band. The readout still
         * says 3, which is what `Hover` reports. */
        const y = this.yOf(box, this.stackedArea() ? this.stackTop(on.series, on.at)
                                                   : on.value, s);
        /* A gap has no point to mark, and an `Arc` at NaN would lose the frame. */
        if (!isFinite(x) || !isFinite(y)) return;

        if (this.kind(s) !== "Bar") {
            p.Color     = this.alpha(ink, 0.25);
            p.LineWidth = 1;
            p.MoveTo(x, box.top);
            p.LineTo(x, box.bottom);
            p.Stroke();
        }

        p.Color = ink;
        p.Arc(x, y, 3.5, 0, 360);
        p.Fill();

        const said = `${this.Labels[on.at] || on.at}: ${this.text(on.value, s)}`;
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

        /* **Only positive values are slices, and each keeps its own index.**
         * Filtering first renumbered them: a zero in the middle moved every
         * later slice's colour, label, `Select` and `Hover` index one along,
         * while the legend -- which names every value -- did not move. */
        const kept  = (v) => isFinite(v) && v > 0;
        const total = s.Values.reduce((a, v) => kept(v) ? a + v : a, 0);
        if (!total) return;

        const cx = (box.left + box.right) / 2;
        const cy = (box.top + box.bottom) / 2;
        const r  = Math.max(8, Math.min((box.right - box.left) / 2,
                                        (box.bottom - box.top) / 2) - 8);
        const hole = this.Type === "Doughnut" ? r * 0.55 : 0;
        let at = -90;                                     /* twelve o'clock */

        s.Values.forEach((v, i) => {
            if (!kept(v)) return;
            const sweep = v * 360 / total;
            const to    = at + sweep;

            p.Color = this.valueColour(s, 0, i);
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

        if (this.ShowValues) this.sliceValues(p, ink, total);
        this.highlightSlice(p, ink);
    }

    /* The value in the slice, written with the format of its own series, and
     * only where the slice is wide enough to hold it: measured against the
     * chord at the text's own radius. */
    sliceValues(p, ink, total) {
        p.Color = ink;
        const s = this.Series[0];

        for (const slice of this.slices) {
            const mid  = (slice.from + slice.to) / 2 * Math.PI / 180;
            const from = slice.hole ? (slice.r + slice.hole) / 2 : slice.r * 0.62;
            const said = this.text(slice.value, s);
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

        const said = `${this.Labels[on.at] || on.at}: ${this.text(on.value, this.Series[0])}`;
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
                  .map((v, i) => ({ Name: this.Labels[i] || String(i),
                                    Color: this.Series[0].Colors[i] || "" }))
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
            rows.at(-1).push({ item: s, k, x, w: need });
            x += need;
        });

        const used = rows.filter((r) => r.length);
        return { rows: used, height: used.length ? used.length * (line + 4) + 2 : 0 };
    }

    legend(p, box, ink, leg, width, height) {
        const top = this.Legend === "Top"
            ? 8 + (this.Title ? box.line + 8 : 0)
            : height - leg.height + 2;

        /* Where each entry was drawn, so `LegendHit` answers about the picture
         * instead of about the layout a second time. A plot's legend names
         * series and a pie's names slices, which is why the two indices differ:
         * `Series` is always the series to hide, `At` the entry that was hit. */
        this.legendHits = [];

        leg.rows.forEach((row, r) => {
            const y = top + r * (box.line + 4);

            for (const { item, k, x, w } of row) {
                const dim = !!(item && item.Hidden);
                p.Color = dim ? this.alpha(this.colour(item, k), 0.3) : this.colour(item, k);
                p.Rectangle(x, y + 3, 10, 10);
                p.Fill();

                p.Color = this.alpha(ink, dim ? 0.35 : DIM_ALPHA);
                p.Text(item.Name, x + 18, y);

                this.legendHits.push({ Series: this.round ? 0 : k, At: k,
                                       x, y, w, h: box.line + 4 });
            }
        });
    }

    colour(s, k) { return s.Color || PALETTE[k % PALETTE.length]; }

    /* The colour of value `i` of series `k`: its own from `Colors`, then the
     * series', then the palette's -- by series on a plot, by slice on a pie,
     * which is what the legend of each shows. */
    valueColour(s, k, i) {
        return (s.Colors && s.Colors[i]) || (this.round ? PALETTE[i % PALETTE.length] : this.colour(s, k));
    }

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

    clampView() {
        const v = this.view();
        this._from  = v.from;
        this._count = v.whole ? 0 : v.count;
    }

    /*
     * ------------------------------------------------------- the window, moved
     *
     * The wheel and the drag are arithmetic on `From`/`Count`, and it lives
     * here and not on the control because a drawing of its own -- a dashboard
     * of several documents on one `DrawingArea` -- forwards a pointer to the
     * document under it and wants exactly what a `Chart` does. The control
     * keeps the gesture state (what a press became, what to emit); the
     * document keeps what the window is.
     */

    /*
     * **A notch that moved nothing is not consumed**, and the caller decides
     * whether to raise `Range` on the answer: zooming out a view that already
     * shows everything is the ordinary case at the end of a scroll, and
     * answering `true` there steals the notch from a `Scroller` around the
     * chart. A wait that moved the origin and not the count is still a move.
     */
    /**
     * zooms the window about `x` — the datum under it stays under it, which
     * is what makes zooming feel like a lens — turning the wheel by `dy`.
     * Answers whether the window moved; a notch that moved nothing is `false`
     */
    ZoomAt(x, y, dy) {
        if (!this.Zoomable || !this.lastBox || !this.lastBox.view || !dy) return false;

        const box = this.lastBox;
        const v   = box.view;
        const at  = isFinite(x) ? this.indexAt(box, x) : v.from + v.count / 2;

        /* A notch is 1.0 on a wheel and a fraction on a touchpad, so the factor
         * follows the amount rather than its sign: a slow touchpad zooms slowly
         * instead of jumping a step per event. */
        const count = Math.max(Math.min(2, v.n), Math.min(v.n,
            Math.round(v.count * Math.pow(1.25, dy))));
        if (count === v.count) return false;

        const share = (at - v.from) / Math.max(1, v.count);
        const was   = [this._from, this._count];

        this._count = count >= v.n ? 0 : count;
        this._from  = Math.round(at - share * count);
        this.clampView();

        const now = this.view();
        if (now.from === v.from && now.count === v.count) {
            [this._from, this._count] = was;
            return false;
        }
        this.changed();
        return true;
    }

    /**
     * pans the window by `dx` pixels: positive moves the values left, the way
     * a drag does. Answers whether the window moved
     */
    PanBy(dx) {
        if (!this.Zoomable || !this.lastBox || !this.lastBox.view || !isFinite(dx) || !dx) return false;
        const box = this.lastBox;
        const v   = box.view;
        const per = v.count / Math.max(1, box.right - box.left);
        const was = this._from;
        this._from = v.from - dx * per;
        this.clampView();
        if (this._from === was) return false;
        this.changed();
        return true;
    }

    /**
     * the pointer down at (x, y): remembers where a drag would start and
     * answers whether this document can pan at all — `Zoomable`, a window
     * drawn, and something off it
     */
    Press(x, y) {
        const box = this.lastBox;
        const can = this.Zoomable && !!(box && box.view) && !this.view().whole;
        this._press   = can ? { x, from: this.view().from } : null;
        this._dragged = false;
        return can;
    }

    /**
     * the pointer at (x, y) after a `Press`: pans when it has dragged more
     * than three pixels, and otherwise marks `hover`. Answers `"pan"` (a
     * drag, whose window may or may not have moved), `"hover"` (a different
     * point is under the pointer now) or `""`
     */
    Move(x, y) {
        if (this._press) {
            const box = this.lastBox, v = box && box.view;
            if (v && (this._dragged || Math.abs(x - this._press.x) > 3)) {
                this._dragged = true;
                const per = v.count / Math.max(1, box.right - box.left);
                this._from = this._press.from - (x - this._press.x) * per;
                this.clampView();
                this.changed();
                return "pan";
            }
        }
        const was = this.hover;
        this.hover = this.at(x, y);
        return JSON.stringify(was) !== JSON.stringify(this.hover) ? "hover" : "";
    }

    /**
     * the pointer up: forgets the press and answers `true` when the gesture
     * never dragged — which is a click, and what raises `Select`
     */
    Release() {
        const click = !this._dragged;
        this._press   = null;
        this._dragged = false;
        return click;
    }

    /**
     * redraws now and forgets what the last frame measured, for when the
     * numbers changed **in place**: `doc.Series[k].Hidden = true` changes no
     * property, so nothing knows to recompute the range
     */
    Refresh() {
        this._range = null;
        this._reduction = null;
        this._stackReduction = null;
        this.changed();
    }


    stackedArea() { return this.Stacked && this.Type === "Area"; }

    /* Where series `k`'s band ends at a slot: its value on everything under it,
     * gaps counting as nothing -- the sum `drawLines` keeps in `under`. */
    stackTop(k, at) {
        let top = 0;
        for (let j = 0; j <= k && j < this.Series.length; j++) {
            if (this.Series[j].Hidden) continue;
            const v = (this.Series[j].Values || [])[at];
            if (isFinite(v)) top += v;
        }
        return top;
    }

    at(x, y) {
        if (this.Type === "Gauge") {
            const d = this.dial;
            if (!d) return null;
            const dx = x - d.cx, dy = y - d.cy;
            return dy <= 4 && Math.sqrt(dx * dx + dy * dy) <= d.r ? { series: 0, at: 0, value: d.value } : null;
        }
        if (this.Type === "Heatmap") {
            const c = (this.cells || []).find((q) => x >= q.x && x <= q.x + q.w && y >= q.y && y <= q.y + q.h);
            return c ? { series: c.series, at: c.at, value: c.value } : null;
        }
        if (this.Type === "Scatter") {
            /* The nearest point the pointer is on, the last drawn first. */
            let best = null, dist = Infinity;
            for (let i = (this.points || []).length - 1; i >= 0; i--) {
                const q = this.points[i];
                const d = Math.hypot(x - q.x, y - q.y);
                if (d <= q.r + 3 && d < dist) { best = q; dist = d; }
            }
            return best ? { series: best.series, at: best.at, value: best.value } : null;
        }
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

        /* Last drawn wins, which is what overlapping bars look like. */
        for (let i = (this.bars || []).length - 1; i >= 0; i--) {
            const b = this.bars[i];
            if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h)
                return { series: b.series, at: b.at, value: b.value };
        }
        /* With no line on the plot, a point off every bar is nothing. */
        const lines = this.Series.map((s, k) => k)
            .filter((k) => !this.Series[k].Hidden && this.kind(this.Series[k]) !== "Bar");
        if (!lines.length) return null;

        const box = this.lastBox;
        if (!box || x < box.left || x > box.right) return null;

        const at = this.indexAt(box, x);

        /* A stacked area is bands, so the pointer is on the band it is inside
         * -- the lowest one it is not above -- and the one on top when it is
         * above them all. Every other line is still its first series. */
        if (this.stackedArea()) {
            let hit = null;
            for (let k = 0; k < this.Series.length; k++) {
                if (this.Series[k].Hidden) continue;
                const v = (this.Series[k].Values || [])[at];
                if (!isFinite(v)) continue;
                hit = { series: k, at, value: v };
                if (y >= this.yOf(box, this.stackTop(k, at), this.Series[k])) break;
            }
            return hit;
        }

        /* The first line on the plot: the first series of a line chart, or the
         * line drawn over bars. */
        const first = lines[0];
        const s  = this.Series[first];

        /* A gap is nothing to hover or select: no value to report, and no
         * point to mark. */
        return s && at >= 0 && at < s.Values.length && isFinite(s.Values[at])
            ? { series: first, at, value: s.Values[at] } : null;
    }
}

/*
 * **The control: a chart on a screen.** What a chart is lives in its
 * `Document`; this shows it, and turns the pointer, the wheel and a drag into
 * `Hover`, `Select` and `Range`. Every property of the document is here too,
 * under the same name, so a `.form` that declares `Type` and `Title` on a
 * `Chart` goes on doing so.
 */
class Chart extends Component {

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
    static Options        = { Type:   ["Bar", "Line", "Area", "Pie", "Doughnut", "Scatter", "Heatmap", "Gauge"],
                              Legend: ["None", "Top", "Bottom"] };
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
