/*
 * A stopwatch, and the point of it is that the number on screen is the truth.
 *
 * There are two ways to write this window wrong, and both of them look right on
 * the machine of whoever wrote them.
 *
 * **Counting the ticks.**  A timer asked for 50 ms does not fire every 50 ms —
 * it fires a little late, every time, because the main loop had something else
 * to do first.  A display that adds 50 to a counter is therefore always behind,
 * the gap only grows, and it never comes back: twenty ticks of 100 ms measured
 * 2003 ms of real time here, so a minute counted that way is short by most of a
 * second, and an hour by most of a minute.
 *
 * **Reading the wall clock.**  `Date.now()` is not a measurement, it is a
 * *setting*: NTP steps it, a timezone change moves it, somebody corrects it by
 * hand.  Any of those in the middle of a lap makes the answer wrong, and a step
 * backwards makes it **negative** — a lap that took minus four seconds, on a
 * machine that did nothing but sit there.
 *
 * Bintana has [`Stopwatch`](../../docs/runtime-api.md#stopwatch), which reads
 * the clock that only goes forward — the one GLib already schedules every
 * `Timer` against:
 *
 *     const watch = new Stopwatch();
 *     watch.Start();  watch.Stop();  watch.Reset();
 *     watch.Elapsed                  // milliseconds, running or not
 *
 * So the tick in this file decides **when to repaint** and nothing else, and
 * what gets painted comes from `Elapsed`.  That separation is the whole design,
 * and it has a test anybody can run: change `REPAINT` below from 50 to 1000 and
 * the reading stays exact — it just moves once a second instead of twenty times.
 * A stopwatch that counted ticks would lose twenty times as much.
 *
 * ## What else it is worth reading for
 *
 *   - **the lap times are subtractions, not their own watches.**  One clock
 *     runs, and a lap is the difference between two readings of it, so the laps
 *     always add up to the total exactly — for the same reason the quote's
 *     instalments do.  Two stopwatches would drift apart.
 *   - the buttons are `Focusable: false` and carry their keys as `Shortcut`, so
 *     there is no `Form_KeyPress` here.  Without that, space would both press
 *     the focused button and fire the shortcut, and the watch would start and
 *     stop on one keystroke — which is the same trap `examples/calculator`
 *     avoids with `=` and Enter.
 *   - the timer only runs while the watch does.  A window sitting stopped at
 *     `12:04,71` is not repainting twenty times a second to draw the same thing.
 *
 * Run it with `./build/bintana examples/stopwatch`.
 */
"use strict";

/*
 * How often the display is redrawn, in milliseconds — **not** how the time is
 * measured, which is the distinction this whole file is about.  Twenty a second
 * is what makes hundredths look like they are moving rather than flickering.
 */
const REPAINT = 50;

/*
 * The form is `StopwatchForm` and not `Stopwatch`, and that is not a style
 * choice: a top-level `class Stopwatch` would win over the runtime's own
 * `Stopwatch` in this file's lexical scope, silently, and `new Stopwatch()`
 * below would build a form.  It is the trap `AGENTS.md` records about generic
 * class names, and the `Form` suffix is what the IDE's own forms use for it.
 */
class StopwatchForm extends Form {

    /* The one clock. Everything on screen is a reading of it. */
    watch = new Stopwatch();

    /* What repaints the display, and only while there is something to repaint. */
    paint = null;

    /* The reading at each lap, so a split is one subtraction. */
    laps = [];

    /* --- the buttons -------------------------------------------------------- */

    BtnStart_Click() {
        if (this.watch.Running) {
            this.watch.Stop();
            this.paint.Stop();
            this.paint = null;
            this.show();                 /* the frame the timer will not draw */
        } else {
            this.watch.Start();
            this.paint = Timer.Every(REPAINT, () => this.show());
        }
        this.buttons();
    }

    /*
     * A lap is where the watch was, written down. The split is the difference
     * from the one before it, so the column adds up to the total by
     * construction rather than by rounding luck.
     */
    BtnLap_Click() {
        const at   = this.watch.Elapsed;
        const from = this.laps.length ? this.laps[this.laps.length - 1] : 0;

        this.laps.push(at);
        this.List.Add(this.row(this.laps.length, at - from, at));

        /* And repaint now rather than waiting for the tick: the row is read off
         * the watch exactly, so without this the display can still be showing
         * the reading from up to `REPAINT` ago and disagree with the line that
         * just appeared under it. */
        this.show();
    }

    BtnReset_Click() {
        if (this.paint) { this.paint.Stop(); this.paint = null; }

        this.watch.Reset();
        this.laps = [];
        this.List.Clear();

        this.show();
        this.buttons();
    }

    /* One place decides what each button says and whether it can be pressed, so
     * the three cannot disagree about which of them the watch is in. */
    buttons() {
        const running = this.watch.Running;

        this.BtnStart.Text    = running ? Locale.Text("Stop") : Locale.Text("Start");
        this.BtnStart.Style   = running ? "destructive-action" : "suggested-action";
        this.BtnLap.Enabled   = running;
        this.BtnReset.Enabled = !running && this.watch.Elapsed > 0;
    }

    /* --- what is on screen -------------------------------------------------- */

    show() {
        this.LblTime.Text = clock(this.watch.Elapsed);
    }

    row(number, split, total) {
        const row = new Panel();
        row.Arrangement = "Horizontal";
        row.Spacing = 10;
        row.Margin  = 6;

        const which = new Label();
        which.Text  = `${number}`;
        which.Width = 30;
        which.Style = "dim-label";
        row.Add(which);

        const lap = new Label();
        lap.Text      = clock(split);
        lap.Alignment = "Right";
        lap.HExpand   = true;
        row.Add(lap);

        const at = new Label();
        at.Text      = clock(total);
        at.Alignment = "Right";
        at.Width     = 110;
        at.Style     = "dim-label";
        row.Add(at);

        return row;
    }

}

/*
 * Milliseconds as a person reads a stopwatch: `9,84`, `1:07,20`, `2:15:00,05`.
 *
 * **Written here and not asked of `Locale`, on purpose.**  A duration is not a
 * time of day — `Locale.Date(x, "Time")` would answer *what o'clock*, which is a
 * different question with a different answer for the same number — and the
 * colons and the leading zeros of a stopwatch are the same in every language.
 * The one part that is *not* is the mark before the hundredths, which is the
 * decimal separator this desktop writes: a comma here, a period elsewhere. That
 * one comes from `Locale`, and it is the whole of what a locale has to say about
 * this string.
 *
 * The unit that is dropped when it is zero is the hour and never the minute:
 * `0:09,84` reads as a stopwatch and `9,84` reads as a number.
 */
function clock(ms) {
    const total    = Math.max(0, Math.floor(ms / 10));   /* hundredths */
    const hundreds = total % 100;
    const seconds  = Math.floor(total / 100) % 60;
    const minutes  = Math.floor(total / 6000) % 60;
    const hours    = Math.floor(total / 360000);

    const two  = (n) => `${n}`.padStart(2, "0");
    const mark = Locale.DecimalPoint;

    return hours
        ? `${hours}:${two(minutes)}:${two(seconds)}${mark}${two(hundreds)}`
        : `${minutes}:${two(seconds)}${mark}${two(hundreds)}`;
}
