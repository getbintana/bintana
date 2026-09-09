/*
 * An agenda, a day at a time, and the point of it is that a date is not a moment.
 *
 * JavaScript has one date type and it is an **instant**: a count of milliseconds
 * since an epoch, read back through a time zone.  An appointment is not one of
 * those.  It has no hour of its own, it is the same date for everybody looking at
 * it, and the arithmetic it wants counts days.  Every line this file would
 * otherwise have got wrong comes from borrowing the instant to stand for the day:
 *
 *     new Date("2026-03-08").getDate()   // 7 in Buenos Aires, 8 in Berlin
 *     new Date(iso).getDay()             // the wrong weekday, west of Greenwich
 *     (b - a) / 86400000                 // 6.958333 across a clock change
 *     new Date().toISOString().slice(0, 10)   // yesterday, all morning, in Lima
 *
 * The first is the specification and not a quirk -- a date-only string is parsed
 * as **UTC** midnight -- which is what makes it so hard to see: it is right on the
 * machine of whoever wrote it if they live east of Greenwich, and off by one for
 * half the world.
 *
 * Bintana has [`Day`](../../docs/runtime-api.md#day), which is the calendar date
 * as the text everything here already holds -- `"YYYY-MM-DD"`, what a `DatePicker`
 * answers with and what a `Field.Date` keeps -- with the four operations that text
 * cannot do for itself:
 *
 *     Day.Today                     the date it is here, at local midnight
 *     Day.Add(date, days)           a date, days may be negative
 *     Day.Between(from, to)         whole days, signed
 *     Day.Weekday(date)             "Monday" ... "Sunday"
 *
 * So the whole of this window's arithmetic is four calls, and **there is not one
 * `new Date` in this file**.
 *
 * ## And an hour is a value too
 *
 * The entries carry a clock -- `"Time": "10:00"` -- and the ones that run for a
 * while carry an end: `"Ends": "11:00"`, the Tuesday planning meeting. That is
 * [`Time`](../../docs/runtime-api.md#time), the same argument one unit down: a
 * time of day is the text `"HH:MM"`, it is not an instant, and the three
 * operations text cannot do for itself are
 *
 *     Time.Now                      the time of day here, with seconds
 *     Time.Add(time, minutes)       minutes may be negative; wraps at midnight
 *     Time.Between(from, to)        whole minutes, signed
 *
 * The row shows the range, its tooltip is how long it runs (`Time.Between`, in
 * the words a person uses), and on *today's* page the entry that is happening
 * right now is marked -- `Time.Now` against the two ends, compared as the text
 * they are. The same string order that sorts the day does that comparison, which
 * is the whole reason a time of day is held this way.
 *
 * ## What is in the book
 *
 * Two kinds of entry, which between them are what an agenda actually holds and
 * neither of which ever goes stale:
 *
 *   - **weekly** — `"Weekday": "Tuesday"`, the standing appointments.  Matched with
 *     `Day.Weekday`, which is the operation `new Date(iso).getDay()` gets wrong.
 *   - **yearly** — `"On": "12-25"`, month and day with no year: a birthday, a
 *     holiday, an anniversary.  Matched against the tail of the ISO date, which is
 *     reading a field of a fixed format and not parsing a date.
 *
 * `Day.Weekday` answers `"Monday"` and not a number **on purpose**, and the file
 * says `"Tuesday"` for the same reason: there are four incompatible weekday
 * numberings in circulation — JavaScript and .NET count from Sunday as 0, ISO and
 * Java from Monday as 1, Python has both, PostgreSQL has both — so a bare integer
 * would mean the file and this code each had to remember which one this runtime
 * chose.  It is a key to test against, like `File.Info`'s `"image/png"`, and never
 * the word anybody reads.
 *
 * ## The heading, which is a catalogue and not a format
 *
 * *"domingo 8 de marzo de 2026"* is assembled here rather than asked of a format,
 * and that is deliberate — see the note in `bta_locale.c`.  glibc has no long-date
 * pattern, and `%A %d %B %Y` reads *"domingo 8 marzo 2026"* in Spanish: it is
 * missing the connector words, and which words those are and where they go is a
 * fact about the language, so it belongs in a `.po` and not in a format string.
 * `Locale.Date(day, "Weekday")` and `"Month"` are the two fields the locale does
 * define, and `Locale.Text` puts them in an order a translator can move:
 *
 *     msgid  "{0}, {1} {2} {3}"          ->  Sunday, 8 March 2026
 *     es.po  "{0} {1} de {2} de {3}"     ->  domingo 8 de marzo de 2026
 *
 * `po/es.po` in this project is that one line, and it is the whole demonstration.
 *
 * ## What else it is worth reading for
 *
 *   - the `DatePicker`'s `Value` **is** a `Day`: no conversion at that edge, or at
 *     the one where the date goes into JSON, because they are the same text.
 *   - `‹` and `›` are `Day.Add(shown, ±1)` and carry `<Alt>Left`/`<Alt>Right`
 *     as `Shortcut` — the desktop's own back-and-forward keys — so the keyboard is
 *     not a `Form_KeyPress` in this file, the same bargain `examples/calculator`
 *     makes with its keypad.  Not `Page_Up`/`Page_Down`, which the list
 *     underneath needs in order to scroll.
 *   - **Saturdays are empty**, which is not an oversight: an agenda has days with
 *     nothing on them, and a window that could never show that state would carry
 *     a branch nobody had ever seen.  A birthday landing on one fills it.
 *   - the line under the date is one `Day.Between`, and it is what makes *today*,
 *     *tomorrow*, *in 12 days* and *3 days ago* one calculation instead of four.
 *
 * Run it with `./build/bintana examples/agenda`, or `LANGUAGE=es ./build/bintana
 * examples/agenda` for the sentence the catalogue rewrites.
 */
"use strict";

class Agenda extends Form {

    /* The book as it was read: two lists, neither of them dated. */
    weekly = [];
    yearly = [];

    /* The day on screen, as a date. */
    shown = "";

    Form_Open() {
        const path = File.Join(Application.Directory, "agenda.json");

        try {
            const book = File.LoadJson(path);
            this.weekly = book.Weekly || [];
            this.yearly = book.Yearly || [];
        } catch (e) {
            Message.Error("Cannot read {0}: {1}", path, e.message);
            return;
        }

        /* A date on the command line, and today otherwise:
         * `./build/bintana examples/agenda 2026-12-25`. */
        this.go(Application.Arguments[0] || Day.Today);
    }

    /* --- moving about ------------------------------------------------------
     *
     * One way in, so the picker, the arrows and the button cannot disagree about
     * what is shown.
     */
    go(date) {
        try {
            /* Asked of `Day` rather than checked here: a date the calendar does
             * not have — a `2026-02-30` typed on the command line — is refused
             * with a message, and refusing it is the same act as reading it. */
            Day.Weekday(date);
        } catch (e) {
            Message.Error("{0}", e.message);
            return;
        }

        this.shown = date;

        /* The picker is where the date is *shown*, so it is set from here and
         * never read from — and assigning raises `Change`, which comes back to
         * this method with the same value.  `shown` is what stops that: the
         * second visit changes nothing and returns. */
        if (this.Picker.Value !== date)
            this.Picker.Value = date;

        this.fill();
    }

    Picker_Change()  { this.go(this.Picker.Value); }
    BtnPrev_Click()  { this.go(Day.Add(this.shown, -1)); }
    BtnNext_Click()  { this.go(Day.Add(this.shown,  1)); }
    BtnToday_Click() { this.go(Day.Today); }

    /* --- what is on that day -----------------------------------------------
     *
     * A weekly entry matches by the name of its weekday; a yearly one by the
     * `MM-DD` tail of the date, which for an ISO date is a field and not a parse.
     */
    entriesFor(date) {
        const weekday = Day.Weekday(date);
        const monthDay = date.slice(5);

        const found = this.weekly.filter((e) => e.Weekday === weekday)
                          .concat(this.yearly.filter((e) => e.On === monthDay));

        /*
         * By the clock, and the undated ones first: a birthday is a fact about
         * the day rather than an appointment at an hour, so it belongs at the top
         * and not sorted in among the nine o'clocks as if it were midnight.
         *
         * Plain `<` and **not** `Locale.Compare`, which is the other half of that
         * rule: `"09:00"` is a fixed format whose text already orders, the way an
         * ISO date does. `Locale.Compare` is for the names people read — see
         * `examples/contacts` — and asking a collation about a clock would be
         * asking the desktop a question that has nothing to do with it.
         */
        return found.sort((a, b) => {
            const x = a.Time || "", y = b.Time || "";
            return x < y ? -1 : x > y ? 1 : 0;
        });
    }

    fill() {
        const entries = this.entriesFor(this.shown);

        this.List.Clear();
        for (const entry of entries)
            this.List.Add(this.row(entry));

        this.List.Index = -1;
        this.showDay(entries.length);
    }

    /* `10:00 – 11:00`, or just the start where there is no end. The dash is an
     * en dash because that is what a range is written with; the times
     * themselves are never formatted, because `"HH:MM"` is already what a clock
     * reads. */
    clock(entry) {
        if (!entry.Time)  return "";
        if (!entry.Ends)  return entry.Time;
        return `${entry.Time} – ${entry.Ends}`;
    }

    /* How long it runs, in the words a person uses for it. `Time.Between` is
     * signed and in whole minutes, so an entry that ends before it starts is a
     * negative number -- a typo in the file, said out loud rather than shown as
     * "-30 min". */
    howLong(entry) {
        const minutes = Time.Between(entry.Time, entry.Ends);

        if (minutes <= 0)
            return Locale.Text("{0} ends before it starts", entry.What);
        if (minutes < 60)
            return Locale.Plural("{0} minute", "{0} minutes", minutes);
        if (minutes % 60 === 0)
            return Locale.Plural("{0} hour", "{0} hours", minutes / 60);
        return Locale.Text("{0} h {1}", String(Math.floor(minutes / 60)),
                           String(minutes % 60));
    }

    /* Between its two ends, on the day it is being shown. `Time.Now` carries
     * seconds and the entry does not, which costs nothing: `"10:00" <=
     * "10:30:07" < "11:00"` is true by the same character order that makes the
     * whole file's sorting work. */
    happeningNow(entry) {
        if (!entry.Time || !entry.Ends) return false;

        const now = Time.Now;
        return entry.Time <= now && now < entry.Ends;
    }

    row(entry) {
        const row = new Panel();
        row.Arrangement = "Horizontal";
        row.Spacing = 12;
        row.Margin  = 6;

        /*
         * **An hour is a value too, and it is `Time`.** An entry that ends says
         * so -- `"Time": "10:00", "Ends": "11:00"` -- and what is shown is the
         * range, with the length of it in the tooltip: `Time.Between` answers in
         * whole minutes, which is the same shape `Day.Between` answers in whole
         * days. There is no clock arithmetic in this file either.
         *
         * An undated entry keeps the column and leaves it empty, so the two
         * kinds of row line up instead of one of them starting further left.
         */
        const time = new Label();
        time.Text  = this.clock(entry);
        time.Width = 96;
        time.Style = entry.Time ? "heading" : "dim-label";
        if (entry.Ends)
            time.Tooltip = this.howLong(entry);
        row.Add(time);

        /* **What is happening right now**, and only on today's page: `Time.Now`
         * against the two ends of the range, compared as the text they are --
         * the same string order that sorts the day, which is the whole reason a
         * time of day is held as `"HH:MM"`. */
        if (this.shown === Day.Today && this.happeningNow(entry))
            time.Style = "accent";

        const what = new Label();
        what.Text      = entry.What;
        what.HExpand   = true;
        what.Ellipsize = true;
        row.Add(what);

        const who = new Label();
        who.Text      = entry.Who || "";
        who.Alignment = "Right";
        who.Width     = 170;
        who.Ellipsize = true;
        who.Style     = "dim-label";
        row.Add(who);

        return row;
    }

    /* --- what the day is called --------------------------------------------
     *
     * The two labels above the list, and between them every date question this
     * example exists for.
     */
    showDay(count) {
        const day = this.shown;

        /*
         * The day number without its leading zero, and the year, read straight
         * off the text.  That is not parsing: the format is fixed, so these are
         * fields at known offsets — and the *names* of the weekday and the month,
         * which are the parts that differ per desktop, are the locale's.
         */
        this.LblDay.Text = Locale.Text("{0}, {1} {2} {3}",
                                       Locale.Date(day, "Weekday"),
                                       Number(day.slice(8, 10)),
                                       Locale.Date(day, "Month"),
                                       day.slice(0, 4));

        this.LblWhen.Text = this.howFarOff(Day.Between(Day.Today, day));

        this.LblCount.Text = count
            ? Locale.Plural("{0} entry", "{0} entries", count)
            : Locale.Text("Nothing on this day.");
    }

    /*
     * One `Day.Between` and the four things it can mean.
     *
     * `Plural` for the two counted cases, because *in 1 day* is a sentence no
     * language writes and the near ones have words of their own — and the
     * catalogue is where a language that has *anteayer* and no single word for
     * *the day after tomorrow* gets to say so.
     */
    howFarOff(days) {
        if (days === 0)  return Locale.Text("Today");
        if (days === 1)  return Locale.Text("Tomorrow");
        if (days === -1) return Locale.Text("Yesterday");

        return days > 0 ? Locale.Plural("In {0} day", "In {0} days", days)
                        : Locale.Plural("{0} day ago", "{0} days ago", -days);
    }

}
