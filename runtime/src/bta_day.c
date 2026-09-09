/*
 * Day -- a calendar date, which is not a moment in time.
 *
 * JavaScript has one date type and it is an instant: a count of milliseconds
 * since an epoch, printed through a time zone.  A birthday, a due date and an
 * appointment are none of those things -- they have no hour, they are the same
 * date for everyone looking at them, and the arithmetic they want counts days
 * and not milliseconds.  Every bug this module exists to prevent comes from
 * borrowing the instant to stand for the date:
 *
 *     new Date("2026-03-08").getDate()      // 7 in Buenos Aires, 8 in Berlin
 *     (b - a) / 86400000                    // 6.958333 across a clock change
 *     new Date(iso).getDay()                // the wrong weekday, west of Greenwich
 *
 * The first is the spec, not a quirk: a date-only string is parsed as **UTC**
 * midnight, so everywhere west of Greenwich it is already the day before by the
 * time it is read back.  It is the same shape of bug as `0.1 + 0.2`, one type up:
 * a value forced through a representation that cannot hold it.
 *
 * ## What a date is here
 *
 * `"YYYY-MM-DD"`, the text, and nothing else -- which is what
 * [`DatePicker`](../../docs/widgets.md#datepicker) already answers with and what
 * a [`Field.Date`](../../docs/runtime-api.md#record-and-field) already holds.  So
 * there is no conversion at any edge, a date goes into a `.form` and into JSON as
 * itself, and `a < b` already orders two of them correctly, which is the one
 * thing ISO 8601 was designed for.
 *
 * A type of our own with the operators was the other way -- `date + 7` reads
 * better than `Day.Add(date, 7)` -- and it is not what this project's family
 * does: Gambas and Delphi, the two nearest relatives, both ship functions over a
 * date value (`DateAdd`/`DateDiff`, `IncDay`/`DaysBetween`), and Java, Go and
 * Temporal all ship methods rather than operators without anybody feeling the
 * loss.  Functions over the text everything already speaks is the smaller thing
 * that answers the whole question.
 *
 * ## Why `Day` and not `Calendar`
 *
 * Because `Calendar` is taken, and for something else: in Java it is the
 * superseded API, in .NET and PHP it is *which* calendar -- Gregorian, Hijri,
 * Japanese -- and in Python it is month grids and day-name tables.  What every
 * language that has this value calls it is a date **without a time**:
 * `LocalDate`, `DateOnly`, `PlainDate`.  `Day` is that in one word, and it is
 * what the values are.
 *
 * ## The implementation is GLib's
 *
 * `GDate` is a calendar date and `GDateTime` is an instant, and GLib has kept
 * them apart since before any of this: `g_date_add_days`, `g_date_days_between`,
 * `g_date_get_weekday`, `g_date_valid_dmy`.  So none of the arithmetic is
 * written here -- what is written here is the parsing, the refusals, and the
 * decision about what each answer means.
 */
#include "bta.h"

#include <math.h>
#include <string.h>
#include <time.h>

/*
 * The text into a GDate, or false.
 *
 * Strict on purpose, and `g_date_set_parse` is exactly what this must not use:
 * that one reads the *locale's* order, so `"03-08-2026"` is March on one desktop
 * and August on another, and a date in a file would mean two things.  This
 * format is the one ISO 8601 fixed and the one every caller already holds.
 */
static bool day_parse(const char *s, GDate *out)
{
    if (!s || strlen(s) != 10 || s[4] != '-' || s[7] != '-')
        return false;

    for (int i = 0; i < 10; i++) {
        if (i == 4 || i == 7)
            continue;
        if (s[i] < '0' || s[i] > '9')
            return false;
    }

    int year  = (s[0] - '0') * 1000 + (s[1] - '0') * 100 + (s[2] - '0') * 10 + (s[3] - '0');
    int month = (s[5] - '0') * 10 + (s[6] - '0');
    int day   = (s[8] - '0') * 10 + (s[9] - '0');

    /* The calendar's own answer, so 2026-02-30 is refused and 2024-02-29 is not.
     * GDate's year starts at 1, which is also where the Gregorian one does. */
    if (!g_date_valid_dmy(day, month, year))
        return false;

    g_date_set_dmy(out, day, month, year);
    return true;
}

/* And back. */
static JSValue day_text(JSContext *ctx, const GDate *d)
{
    char out[11];

    g_snprintf(out, sizeof out, "%04d-%02d-%02d",
               g_date_get_year(d), g_date_get_month(d), g_date_get_day(d));

    return JS_NewString(ctx, out);
}

/*
 * One argument, read as a date, with the complaint naming the function.
 *
 * A date that cannot be read is refused rather than guessed at -- the bargain
 * every setter in this runtime makes, and the same one `DatePicker.Value` makes
 * about the string it is handed.
 */
static bool day_arg(JSContext *ctx, JSValueConst v, const char *who, GDate *out)
{
    const char *s = JS_ToCString(ctx, v);
    bool        ok = s && day_parse(s, out);

    if (!ok)
        JS_ThrowTypeError(ctx, "%s: %s is not a date -- YYYY-MM-DD is what this "
                               "takes, and the calendar has to have it",
                          who, s ? s : "nothing");
    if (s)
        JS_FreeCString(ctx, s);
    return ok;
}

/*
 * Day.Today -- the date it is here, now.
 *
 * A getter rather than a call, the way `Locale.Current` is one: it reads
 * something about the world rather than computing an answer from its arguments.
 *
 * **Local midnight and not UTC's**, which is the whole reason this is not
 * `new Date().toISOString().slice(0, 10)`: that spelling is yesterday for
 * everybody west of Greenwich for the first hours of their morning, and it is
 * the single most common way this bug reaches production.
 */
static JSValue js_day_get_today(JSContext *ctx, JSValueConst this_val)
{
    GDate d;

    g_date_clear(&d, 1);
    g_date_set_time_t(&d, time(NULL));   /* localtime, which is the point */

    return day_text(ctx, &d);
}

/*
 * Day.Add(date, days) -- days later, or earlier for a negative count.
 *
 * The month lengths and the leap years are `g_date_add_days`'s problem and it
 * has had them right for twenty years.  What is decided here is that the answer
 * is a date and not an instant, so nothing about hours or clock changes can
 * enter into it: adding a day to the date a country moves its clocks is the next
 * date, and the twenty-three-hour day it contains is a fact about time and not
 * about the calendar.
 */
static JSValue js_day_add(JSContext *ctx, JSValueConst this_val,
                          int argc, JSValueConst *argv)
{
    GDate d;

    if (argc < 2)
        return JS_ThrowTypeError(ctx, "Day.Add(date, days) needs a date and a count");
    if (!day_arg(ctx, argv[0], "Day.Add", &d))
        return JS_EXCEPTION;

    int32_t days;
    if (JS_ToInt32(ctx, &days, argv[1]))
        return JS_EXCEPTION;

    /*
     * The bounds are the ones this module's own text can hold: four digits of
     * year, so 0001-01-01 to 9999-12-31.  **Everything `Add` answers has to be
     * something `Weekday` accepts** -- a five-digit year would format to eleven
     * characters and be refused by the parser two lines later, which is a value
     * escaping through a door it cannot come back in.
     *
     * GDate itself reaches year 65535 and *asserts* rather than answering when
     * walked off either end, so this is also what keeps a caller who added a
     * million days getting a message instead of a crash inside a library.
     *
     * The far end is asked of GLib rather than worked out here: a constant would
     * be one more place for a leap-year rule to be got wrong by hand.
     */
    GDate last;
    g_date_clear(&last, 1);
    g_date_set_dmy(&last, 31, 12, 9999);

    int64_t julian = (int64_t)g_date_get_julian(&d) + days;

    if (julian < 1 || julian > (int64_t)g_date_get_julian(&last))
        return JS_ThrowRangeError(ctx,
            "Day.Add: %d days from %04d-%02d-%02d is outside the calendar",
            days, g_date_get_year(&d), g_date_get_month(&d), g_date_get_day(&d));

    if (days >= 0) g_date_add_days(&d, (guint)days);
    else           g_date_subtract_days(&d, (guint)(-days));

    return day_text(ctx, &d);
}

/*
 * Day.Between(from, to) -- whole days from one to the other, **signed**.
 *
 * `to` before `from` answers negative, which is the choice worth making on
 * purpose rather than letting it fall out: Java's `DAYS.between(a, b)` is signed
 * and this is its argument order, while Delphi's `DaysBetween` answers an
 * absolute value and loses which way round they were.  Signed is what lets one
 * call say *in three days* and *three days ago*.
 *
 * And it is **whole days**, because these are dates: the milliseconds spelling
 * of this question answers 6.958333 for a week that crosses a clock change, and
 * the `Math.round` that fixes it is the line nobody remembers to write.
 */
static JSValue js_day_between(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    GDate from, to;

    if (argc < 2)
        return JS_ThrowTypeError(ctx, "Day.Between(from, to) needs two dates");
    if (!day_arg(ctx, argv[0], "Day.Between", &from) ||
        !day_arg(ctx, argv[1], "Day.Between", &to))
        return JS_EXCEPTION;

    return JS_NewInt32(ctx, (int32_t)((int64_t)g_date_get_julian(&to) -
                                      (int64_t)g_date_get_julian(&from)));
}

/*
 * Day.Weekday(date) -- "Monday" ... "Sunday".
 *
 * **A name and not a number, and it is not a style choice.** There are at least
 * four incompatible numberings in use: JavaScript and .NET count from Sunday as
 * 0, ISO 8601 and Java from Monday as 1, Python offers `weekday()` at Monday 0
 * *and* `isoweekday()` at Monday 1, PostgreSQL has `DOW` and `ISODOW`. A bare
 * integer means the caller has to remember which of those this one is, and every
 * off-by-one it causes is silent. Java, C# and Go -- the typed languages in that
 * list -- all answer with an enum for exactly this reason.
 *
 * It is a **key to test against and never text to show**, the same bargain
 * `File.Info`'s `Type` makes by answering `"image/png"` rather than the
 * description GIO would have translated. What a person reads comes from
 * `Locale.Date(date, "Weekday")`, in their language.
 */
static const char * const WEEKDAYS[] = {
    "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"
};

static JSValue js_day_weekday(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    GDate d;

    if (argc < 1)
        return JS_ThrowTypeError(ctx, "Day.Weekday(date) needs a date");
    if (!day_arg(ctx, argv[0], "Day.Weekday", &d))
        return JS_EXCEPTION;

    /* GDateWeekday is Monday = 1, which is this array's own order. */
    return JS_NewString(ctx, WEEKDAYS[g_date_get_weekday(&d) - 1]);
}

/* ------------------------------------------------------------------ Time
 *
 * The clock half of the same argument `Day` makes, and the same answer: a time
 * of day is **the text `"HH:MM"`** (seconds optional, `"HH:MM:SS"`), which is
 * what a schedule holds, what SQL's TIME column is, what sorts correctly as a
 * string, and what goes into JSON as itself.
 *
 * It is not a `Date` with the date thrown away: an instant carries a time zone
 * and a day, and 08:30 has neither -- a shop opens at half past eight in
 * whatever zone the shop is in, on every day it is open. Borrowing an instant to
 * stand for it is the same class of bug `Day` exists to prevent, one unit down.
 *
 * What was there instead was minutes as an `Int` (`8 * 60 + 30`), formatted and
 * parsed by hand, and validated by whoever remembered to.
 */

/* `"HH:MM"` or `"HH:MM:SS"` into seconds since midnight, or -1.
 *
 * Strict about the shape, and that is the point of having a type at all: `"8:30"`
 * is refused rather than guessed at, because a value that is sometimes five
 * characters and sometimes four does not sort, and sorting is most of what a
 * time as text is for. */
static int time_parse(const char *s)
{
    if (!s)
        return -1;

    size_t len = strlen(s);
    if ((len != 5 && len != 8) || s[2] != ':' || (len == 8 && s[5] != ':'))
        return -1;

    for (size_t i = 0; i < len; i++) {
        if (i == 2 || i == 5)
            continue;
        if (s[i] < '0' || s[i] > '9')
            return -1;
    }

    int h = (s[0] - '0') * 10 + (s[1] - '0');
    int m = (s[3] - '0') * 10 + (s[4] - '0');
    int sec = len == 8 ? (s[6] - '0') * 10 + (s[7] - '0') : 0;

    /* 24:00 is refused: it is a *duration* of one day, not a time of day, and
     * accepting it would put a value in the field that no clock ever shows. */
    if (h > 23 || m > 59 || sec > 59)
        return -1;
    return h * 3600 + m * 60 + sec;
}

/* The seconds back as text, keeping seconds only when they are not zero: a
 * schedule written in minutes stays in minutes, and nothing grows `:00` for
 * having been through here. */
static JSValue time_text(JSContext *ctx, int seconds)
{
    char buf[9];

    if (seconds % 60)
        g_snprintf(buf, sizeof buf, "%02d:%02d:%02d",
                   seconds / 3600, (seconds / 60) % 60, seconds % 60);
    else
        g_snprintf(buf, sizeof buf, "%02d:%02d", seconds / 3600, (seconds / 60) % 60);
    return JS_NewString(ctx, buf);
}

static bool time_arg(JSContext *ctx, JSValueConst v, const char *who, int *out)
{
    const char *s = JS_ToCString(ctx, v);
    if (!s)
        return false;

    int secs = time_parse(s);
    if (secs < 0) {
        JS_ThrowTypeError(ctx, "%s: '%s' is not a time (expected HH:MM or HH:MM:SS)",
                          who, s);
        JS_FreeCString(ctx, s);
        return false;
    }
    JS_FreeCString(ctx, s);
    *out = secs;
    return true;
}

static JSValue js_time_get_now(JSContext *ctx, JSValueConst this_val)
{
    GDateTime *now = g_date_time_new_now_local();
    int        s   = g_date_time_get_hour(now) * 3600 +
                     g_date_time_get_minute(now) * 60 +
                     g_date_time_get_second(now);

    g_date_time_unref(now);

    /* With the seconds, always: the time *now* is a measurement, and a caller
     * that wants the minute has `.slice(0, 5)` while one that needs the second
     * cannot get it back. `Day.Today` has nothing below its unit to lose. */
    char buf[9];
    g_snprintf(buf, sizeof buf, "%02d:%02d:%02d", s / 3600, (s / 60) % 60, s % 60);
    return JS_NewString(ctx, buf);
}

/*
 * `Time.Add(time, minutes)` -- **and it wraps at midnight**.
 *
 * `Day.Add` refuses to leave the calendar because a date past the end of it is
 * a mistake; a time has no end to fall off. Twenty minutes after 23:50 is 00:10
 * on a clock, and the day it belongs to is not this value's business -- that is
 * precisely what a time of day does not carry. A caller that needs the day too
 * is holding two values and has to add them itself.
 */
static JSValue js_time_add(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv)
{
    int at = 0;
    if (argc < 2)
        return JS_ThrowTypeError(ctx, "Time.Add(time, minutes) needs both");
    if (!time_arg(ctx, argv[0], "Time.Add", &at))
        return JS_EXCEPTION;

    double minutes;
    if (JS_ToFloat64(ctx, &minutes, argv[1]))
        return JS_EXCEPTION;
    if (!isfinite(minutes))
        return JS_ThrowRangeError(ctx, "Time.Add: %g is not a number of minutes",
                                  minutes);

    long long moved = (long long)at + (long long)(minutes * 60);
    long long day   = 24 * 3600;

    moved %= day;
    if (moved < 0)
        moved += day;
    return time_text(ctx, (int)moved);
}

/* Whole minutes from one to the other, signed, truncated: the same shape
 * `Day.Between` has in days. `Time.Seconds` is where anything finer lives. */
static JSValue js_time_between(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv)
{
    int from = 0, to = 0;

    if (argc < 2)
        return JS_ThrowTypeError(ctx, "Time.Between(from, to) needs both");
    if (!time_arg(ctx, argv[0], "Time.Between", &from) ||
        !time_arg(ctx, argv[1], "Time.Between", &to))
        return JS_EXCEPTION;

    return JS_NewInt32(ctx, (to - from) / 60);
}

/* Seconds since midnight: the exact number, and the key anything sorts or
 * arithmetics by when minutes are not enough. */
static JSValue js_time_seconds(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv)
{
    int at = 0;

    if (argc < 1)
        return JS_ThrowTypeError(ctx, "Time.Seconds(time) needs a time");
    if (!time_arg(ctx, argv[0], "Time.Seconds", &at))
        return JS_EXCEPTION;
    return JS_NewInt32(ctx, at);
}

static const JSCFunctionListEntry time_props[] = {
    JS_CFUNC_DEF("Add",     2, js_time_add),
    JS_CFUNC_DEF("Between", 2, js_time_between),
    JS_CFUNC_DEF("Seconds", 1, js_time_seconds),
    JS_CGETSET_DEF("Now", js_time_get_now, NULL),
};

static const JSCFunctionListEntry day_props[] = {
    JS_CFUNC_DEF("Add",     2, js_day_add),
    JS_CFUNC_DEF("Between", 2, js_day_between),
    JS_CFUNC_DEF("Weekday", 1, js_day_weekday),
    JS_CGETSET_DEF("Today", js_day_get_today, NULL),
};

void bta_day_init(JSContext *ctx, JSValue global)
{
    JSValue day = JS_NewObject(ctx);

    JS_SetPropertyFunctionList(ctx, day, day_props, G_N_ELEMENTS(day_props));
    JS_SetPropertyStr(ctx, global, "Day", day);

    JSValue time = JS_NewObject(ctx);

    JS_SetPropertyFunctionList(ctx, time, time_props, G_N_ELEMENTS(time_props));
    JS_SetPropertyStr(ctx, global, "Time", time);
}
