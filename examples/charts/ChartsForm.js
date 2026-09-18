/*
 * Four charts, one component, and what a chart set is actually made of.
 *
 * The `Chart` in `lib/charts` is the whole of the drawing; this form is what using
 * it looks like. It was written to find out what the drawing surface was missing
 * by writing the client it was built for -- the answer was one primitive,
 * `Painter.ArcNegative` -- and it is now the example of the library: what a chart
 * takes is in [docs/llm/charts.md](../../docs/llm/charts.md).
 *
 * **Five shapes, one property.** `Bar` grouped or stacked, `Line`, `Area`, `Pie`
 * and `Doughnut` -- one class and `Type` says which, the same answer
 * `CheckButton`/`Group` and `Panel`/`Arrangement` already gave this widget set. A
 * pie reads the first series and names its slices from `Labels`, which is the one
 * place the data means something different and is what every chart library does:
 * a pie of two series is two pies.
 *
 * **What a form declares and what code hands over.** `Type`, `Title`, `Labels`,
 * `Legend` and `Decimals` are in `ChartsForm.form`, where the designer can edit
 * them and the catalogue can translate them. Only the numbers are here, which is
 * the division this environment argues for everywhere else too:
 *
 *     this.Sales.Series = [{ Name: "2025", Values: [...] }];
 *
 * **And the long series is the interesting one.** `Load` holds 21,600 readings --
 * one a second for six hours -- against a plot some 800 pixels wide. Drawn point
 * for point that is 27 samples a pixel: invisible detail, and the shape
 * `examples/drawing` measured at 3 frames a second. `Decimate` is the answer and
 * `Measure` is how you check it, on this machine:
 *
 *      decimated      59.0 frames/s    3.5 ms in the handler
 *      every point    13.2 frames/s   46.6 ms
 *
 * The reduced line *looks the same*, because min and max per pixel column keep
 * the envelope -- both one-sample spikes in this data survive it.
 *
 * **What getting there taught is not about the surface.** The first working
 * version drew at 35 frames a second with 21 ms in the handler, and about one of
 * those milliseconds was drawing: the rest was decimating on every frame, and
 * computing the y range with `flatMap` and `Math.min(0, ...all)` over 21,600
 * values on every frame. Both are data operations over data that had not changed.
 * Cached on the array's identity, the same chart draws at 59. In an interpreter
 * the passes over the data dominate the painting, which is the thing a chart
 * author has to know and the surface's own numbers could never say.
 */
"use strict";

class ChartsForm extends Form {

    /*
     * **The guard, which is not optional.** A `.form` applies its properties
     * *before* `Form_Open` runs, and every assignment raises a real event: the
     * `Items` on the combo raised `Select`, and the two `Active`s raised `Click`,
     * against a form whose other controls did not exist yet -- three error
     * dialogs on the first run. `docs/plans/data-plan.md` records the same
     * thing happening to `examples/quote` against a record that was still null;
     * it is the cost of events being real, and one flag is the whole of the
     * fix.
     */
    ready = false;

    Form_Open() {
        /*
         * **Two units, two axes.** The third series is a percentage and the first
         * two are counts: on one scale the margin would be a flat line along the
         * bottom, which is the chart that lies by drawing honestly. `Axis:
         * "Right"` gives it its own range, its own ticks and its own margin.
         */
        this.Sales.Series = [
            { Name: Locale.Text("2025"), Values: [12, 19, 7, 15] },
            { Name: Locale.Text("2026"), Values: [15, 12, 21, 18] },
            { Name: Locale.Text("Margin %"), Values: [31, 28, 35, 33],
              Color: "#e5a50a", Axis: "Right" },
        ];

        this.Share.Labels = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                             "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        /* One reading a second for six hours: a walk with a couple of spikes in
         * it, because a spike one sample wide is what tells min/max decimation
         * apart from taking every n-th point. */
        const n = 6 * 60 * 60, load = [];
        let at = 40;
        for (let i = 0; i < n; i++) {
            at += (Math.random() - 0.5) * 3;
            at  = Math.max(2, Math.min(98, at));
            load.push(i === 9000 || i === 15000 ? 99 : at);
        }
        this.readings   = load;
        this.Load.Series = [{ Name: Locale.Text("CPU %"), Values: load }];

        /*
         * **A time axis, which is `Marks` and not `Labels`.** Six labels spread
         * evenly across the plot happen to be right here because the readings are
         * one a second and none is missing -- and that is exactly the assumption
         * that fails on real data. `Marks` puts each hour label at the reading it
         * belongs to, because only this form knows that index 3600 is one hour
         * in.
         */
        const marks = [];
        for (let h = 0; h * 3600 < n; h++)
            marks.push({ At: h * 3600, Text: Locale.Text("{0}h", String(h)) });
        this.Load.Marks = marks;

        /* The one series a pie reads, and the labels that name its slices. */
        this.Mix.Series = [{ Values: [38, 24, 18, 12, 8] }];

        /* The area chart stacks two series, which is the other half of `Stacked`:
         * bars and areas both do it, a line and a pie do not. */
        this.Share.Series = [
            { Name: Locale.Text("Retail"),    Color: "#2ec27e",
              Values: [31.5, 33.1, 32.8, 35.0, 36.2, 35.8,
                       37.4, 38.0, 37.1, 39.6, 41.2, 40.5] },
            { Name: Locale.Text("Wholesale"), Color: "#3584e4",
              Values: [12.0, 11.4, 13.2, 12.8, 14.1, 15.0,
                       14.4, 13.9, 15.6, 16.2, 15.8, 17.1] },
        ];
        this.Share.Stacked = true;
        this.Share.Legend  = "Bottom";

        this.CmbType.Text = "Bar";
        this.ready = true;
        this.say(Locale.Text("{0} readings in the bottom chart", String(n)));
    }

    /* What the chart says back. `Select` is a click, `Hover` is the pointer
     * passing: two events, because a chart that reports a click as a selection is
     * a chart that cannot have a tooltip. */
    Sales_Select(series, at, value) {
        this.say(Locale.Text("Clicked {0} in {1}: {2}",
                             this.Sales.Labels[at] || String(at),
                             this.Sales.Series[series].Name,
                             Locale.Number(value)));
    }

    Load_Select(series, at, value) {
        this.say(Locale.Text("Reading {0} of {1}: {2}",
                             String(at), String(this.readings.length),
                             Locale.Number(value, 1)));
    }

    /*
     * One property, five shapes. The bottom chart stays a plot whatever the combo
     * says -- 21,600 readings as a pie is not a chart -- which is the sort of
     * judgement a form makes and a component should not.
     */
    CmbType_Select() {
        if (!this.ready) return;

        const want = this.CmbType.Text;
        this.Sales.Type = want;
        this.Load.Type  = ["Pie", "Doughnut", "Bar"].includes(want) ? "Line" : want;
    }

    Mix_Select(series, at, value) {
        this.say(Locale.Text("{0}: {1} of {2}", this.Mix.Labels[at],
                             Locale.Number(value),
                             Locale.Number(this.Mix.Series[0].Values
                                               .reduce((a, b) => a + b, 0))));
    }

    ChkStack_Click() {
        if (!this.ready) return;
        this.Sales.Stacked    = this.ChkStack.Active;
        this.Sales.ShowValues = this.ChkStack.Active;
    }

    /*
     * Rounded lines, which is a choice about honesty as much as about looks: a
     * curve says something between two samples, so the one this draws is monotone
     * -- it stays between their values and flattens at a peak instead of
     * inventing a taller one. See `curveThrough` in the library.
     */
    ChkCurve_Click() {
        if (!this.ready) return;
        for (const c of [this.Share, this.Load]) c.Curved = this.ChkCurve.Active;
    }

    ChkGrid_Click() {
        if (!this.ready) return;
        for (const c of [this.Sales, this.Share, this.Load])
            c.Grid = this.ChkGrid.Active;
    }

    /*
     * Decimation on and off, which is the measurement this example exists for.
     * Off, the chart is handed every one of the 21,600 readings; on, it reduces
     * them to two per pixel column -- min and max, so the two spikes survive.
     */
    ChkReduce_Click() {
        if (!this.ready) return;
        this.Load.Reduced = this.ChkReduce.Active;
        this.Load.Refresh();
    }

    /*
     * What the window is, said in words: a chart that can be zoomed has to be
     * able to say where you are, or the axis marks are the only clue and they run
     * out at the second turn of the wheel.
     */
    Load_Range(from, count) {
        const at = (i) => {
            const h = Math.floor(i / 3600), m = Math.floor((i % 3600) / 60);
            return `${h}:${String(m).padStart(2, "0")}`;
        };
        this.say(count >= this.readings.length
            ? Locale.Text("all {0} readings", String(this.readings.length))
            : Locale.Text("{0} readings, {1} to {2}", String(count),
                          at(from), at(from + count)));
    }

    BtnMeasure_Click() {
        const watch = new Stopwatch().Start();
        const from  = this.Load.frames || 0;

        this.BtnMeasure.Enabled = false;
        const tick = Timer.Every(4, () => this.Load.Refresh());

        Timer.After(1000, () => {
            tick.Stop();
            const fps = (this.Load.frames - from) / (watch.Elapsed / 1000);
            this.BtnMeasure.Enabled = true;
            this.say(Locale.Text("{0} readings, {1} — {2} frames/s, {3} ms drawn",
                                 String(this.readings.length),
                                 this.ChkReduce.Active ? Locale.Text("decimated")
                                                       : Locale.Text("every point"),
                                 fps.toFixed(1), (this.Load.drawn || 0).toFixed(1)));
        });
    }

    BtnSave_Click() {
        const path = File.Join(Application.ConfigDirectory, "sales.png");

        this.Sales.Save(path, 800, 400);
        this.say(Locale.Text("Saved {0}", path));
    }

    say(text) { this.LblSaid.Text = text; }
}
