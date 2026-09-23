/*
 * Decimal -- exact arithmetic, with the operators.
 *
 * `precio * cantidad + iva`, and the result is right to the cent.  Which sounds
 * unremarkable until you notice that JavaScript cannot do it: there is one
 * numeric type and it is binary floating point, so `0.1` ten times is not `1`,
 * and `(1.005).toFixed(2)` is `"1.00"` -- not because the rounding is wrong but
 * because the double the literal `1.005` produces really is 1.00499999999999989.
 * The information is gone at the literal, before anything can round it.
 *
 * **A language for forms over data cannot have that**, and every language that
 * solved it did so the same way: an exact type with the ordinary operators.  VB
 * has `Currency`, Delphi has `Currency`, .NET has `decimal`, SQL has
 * `NUMERIC(p,s)`.  The ones without operator overloading -- Java, Go, plain
 * JavaScript -- ended up with `a.add(b)`, and that is the outcome this file
 * exists to avoid: `precio.Times(cantidad).Plus(iva)` in the click handler of an
 * invoice is not a RAD language.
 *
 * quickjs-ng removed both the operator overloading and the BigDecimal that
 * Bellard's quickjs had, so the operators come from a patch to the engine: one
 * callback (`JS_SetArithHandler`) that the arithmetic slow paths consult before
 * they reach ToPrimitive.  It is the second patch this repository carries
 * against quickjs -- the first was `strtod` reading the locale's decimal comma
 * and answering 0 for `JSON.parse("0.05")`.  Both are about the same thing: a
 * number is not allowed to be almost right.
 *
 * ## A fraction, not a scaled integer
 *
 * The obvious build is an int64 and a scale -- 1999 with scale 2 for 19.99,
 * which is what VB's `Currency` and Delphi's are.  This file was that, and it
 * was wrong for one reason:
 *
 *     (10 / 3) * 3   had to be 10, and it was 9.99
 *
 * A scaled integer has to *decide* what 10/3 is the moment it is asked, and
 * every decision is a rounding: 3.33, and three of those are 9.99.  What was
 * thrown away is not recoverable, so no amount of care further down puts the
 * cent back.
 *
 * So a value here is a **fraction**: a numerator and a denominator, both int64,
 * always reduced, denominator always positive.  Ten over three stays ten thirds;
 * multiply it by three and the threes cancel and it is 10, exactly.  It is what
 * Scheme, Ruby's `Rational` and Python's `fractions.Fraction` hold, and what
 * makes the arithmetic closed: **every operator answers exactly, and rounding
 * happens in one place only -- when the value is written down.**
 *
 * `0.1` is one tenth rather than an approximation of it, which is why a tenth
 * ten times is a one here and is not in binary floating point.  The same theorem
 * governs both, in different bases: a fraction terminates in base B exactly when
 * its reduced denominator's only prime factors are B's.  Ten is 2*5, so tenths
 * are exact here and thirds are not; two is 2, so tenths are not exact in a
 * double.  This type did not solve that -- it changed to the base money is
 * written in.
 *
 * ## The scale a value remembers
 *
 * A fraction has no decimal places of its own: 199/10 and 19.90 are the same
 * number, and a column of prices still has to line up.  So a value also carries
 * the scale it was *written* at, which is a fact about presentation and never
 * about arithmetic.  It rides along -- widest wins when adding, they add when
 * multiplying -- and only the writing reads it.
 *
 * A **non-terminating** value deliberately does not inflate it: ten thirds keeps
 * the zero places its operands had, so `(10/3) * 3` prints `10` and not
 * `10.000000000`.  The nine digits such a value shows come from the writing, not
 * from the value.
 *
 * ## What overflows
 *
 * Both halves are int64 and every product is checked in `__int128` before it is
 * accepted, so nothing wraps: what does not fit **throws**.  Reducing by the
 * greatest common divisor after every operation is what keeps that rare -- money
 * denominators are all powers of ten and cancel against each other, so an
 * invoice never approaches it.  Adding fractions with coprime denominators is
 * the case that grows: a third plus a seventh is a twenty-first, and a long
 * chain of those is the one thing this will refuse.  Loudly, which is the point.
 */
#include "bta.h"

#include <inttypes.h>
#include <stdlib.h>
#include <string.h>

/* The most decimal places anything here writes: what a non-terminating value is
 * shown at, and the ceiling on a declared scale. */
#define DEC_MAX_SCALE 9

typedef struct {
    int64_t num;     /* the value, reduced... */
    int64_t den;     /* ...over this, which is always positive */
    int     scale;   /* the places it was written at -- presentation only */
} BtaDecimal;

static JSClassID bta_decimal_class_id;

static const int64_t dec_pow10[DEC_MAX_SCALE + 1] = {
    1, 10, 100, 1000, 10000, 100000, 1000000, 10000000, 100000000, 1000000000,
};

/* ------------------------------------------------------------------ helpers */

static BtaDecimal *dec_of(JSValueConst v)
{
    return JS_GetOpaque(v, bta_decimal_class_id);
}

static bool dec_is(JSValueConst v)
{
    return JS_VALUE_GET_TAG(v) == JS_TAG_OBJECT && dec_of(v) != NULL;
}

static void dec_finalizer(JSRuntime *rt, JSValue val)
{
    BtaDecimal *d = JS_GetOpaque(val, bta_decimal_class_id);
    js_free_rt(rt, d);
}

static JSClassDef dec_class = {
    "Decimal",
    .finalizer = dec_finalizer,
};

/* An __int128 back down to an int64, or a complaint.  Every product in this file
 * goes through here, which is why none of them can wrap. */
static bool dec_fits(JSContext *ctx, __int128 v, int64_t *out)
{
    if (v > (__int128)INT64_MAX || v < -(__int128)INT64_MAX) {
        JS_ThrowRangeError(ctx, "Decimal: this does not fit in a decimal");
        return false;
    }
    *out = (int64_t)v;
    return true;
}

/*
 * Reduced, with the sign on the numerator.
 *
 * After every operation and not only when it looks needed: an unreduced
 * denominator is what makes the next multiplication overflow, so taking the
 * greatest common divisor out is the whole of what keeps a chain of money
 * arithmetic inside an int64.
 */
static bool dec_reduce(JSContext *ctx, __int128 num, __int128 den,
                       int scale, BtaDecimal *out)
{
    if (den == 0) {
        JS_ThrowRangeError(ctx, "Decimal: division by zero");
        return false;
    }
    if (den < 0) {
        num = -num;
        den = -den;
    }
    out->scale = scale > DEC_MAX_SCALE ? DEC_MAX_SCALE : (scale < 0 ? 0 : scale);

    if (num == 0) {
        out->num = 0;
        out->den = 1;
        return true;
    }

    /* Reduced in 128 bits first, so a product too big for an int64 still has its
     * common factor taken out before anybody asks whether it fits. */
    __int128 a = num < 0 ? -num : num, b = den;
    while (b) {
        __int128 t = a % b;
        a = b;
        b = t;
    }
    num /= a;
    den /= a;

    return dec_fits(ctx, num, &out->num) && dec_fits(ctx, den, &out->den);
}

/*
 * How many decimal places this value needs to be written exactly, or -1 when no
 * number of them would do.
 *
 * The test is the theorem: a reduced fraction terminates in base ten exactly
 * when its denominator is a product of twos and fives, and it needs however many
 * there are of the commoner one.  An eighth is three places because eight is
 * three twos; a third is none, because three is neither.
 */
static int dec_exact_places(const BtaDecimal *v)
{
    int64_t den  = v->den;
    int     twos = 0, fives = 0;

    while (den % 2 == 0) { den /= 2; twos++; }
    while (den % 5 == 0) { den /= 5; fives++; }

    if (den != 1)
        return -1;
    return twos > fives ? twos : fives;
}

/* ----------------------------------------------------------------- rounding */

/*
 * Rounding, by name.
 *
 * Five, and each is a rule somebody's accountant actually uses.  `Away` is what
 * a person means by *round*: a half goes away from zero, so 1.005 is 1.01 and
 * -1.005 is -1.01.  `Even` is banker's rounding -- a half goes to the even
 * neighbour -- which several tax authorities require precisely because `Away`
 * accumulates upward over a long column.  The other three do not look at the
 * half at all: `Zero` truncates, `Up` goes to +infinity, `Down` to -infinity.
 *
 * The default is `Away` because this is a language for invoices, and because it
 * is the one a reader guesses right.
 */
typedef enum { DEC_AWAY, DEC_EVEN, DEC_ZERO, DEC_UP, DEC_DOWN } DecRound;

static const char *const dec_round_names[] = {
    "Away", "Even", "Zero", "Up", "Down",
};

static bool dec_round_named(JSContext *ctx, JSValueConst v, DecRound *out)
{
    const char *asked = JS_ToCString(ctx, v);
    if (!asked)
        return false;

    for (unsigned i = 0; i < G_N_ELEMENTS(dec_round_names); i++) {
        if (g_str_equal(asked, dec_round_names[i])) {
            *out = (DecRound)i;
            JS_FreeCString(ctx, asked);
            return true;
        }
    }
    JS_ThrowRangeError(ctx, "Decimal: '%s' is not one of Away, Even, Zero, Up, Down",
                       asked);
    JS_FreeCString(ctx, asked);
    return false;
}

/*
 * The value times 10^places, as a whole number, rounded.
 *
 * The one place in this file where anything is rounded at all, and both of its
 * callers are about *writing*: the text of a value, and the explicit `Round`.
 * Everything else is exact, which is what having a denominator buys.
 */
static bool dec_scaled(JSContext *ctx, const BtaDecimal *v, int places,
                       DecRound how, int64_t *out)
{
    if (places < 0 || places > DEC_MAX_SCALE) {
        JS_ThrowRangeError(ctx, "Decimal: %d decimal places is not between 0 and %d",
                           places, DEC_MAX_SCALE);
        return false;
    }

    __int128 lifted = (__int128)v->num * dec_pow10[places];
    __int128 q      = lifted / v->den;
    __int128 rest   = lifted % v->den;

    if (rest != 0) {
        int      sign = (v->num < 0) ? -1 : 1;
        __int128 half = rest < 0 ? -rest : rest;

        switch (how) {
        case DEC_AWAY:
            if (half * 2 >= v->den) q += sign;
            break;
        case DEC_EVEN:
            if (half * 2 > v->den || (half * 2 == v->den && (q % 2 != 0)))
                q += sign;
            break;
        case DEC_ZERO:
            break;
        case DEC_UP:
            if (rest > 0) q += 1;
            break;
        case DEC_DOWN:
            if (rest < 0) q -= 1;
            break;
        }
    }
    return dec_fits(ctx, q, out);
}

/* ------------------------------------------------------------------ reading */

/*
 * A decimal out of text, exactly.
 *
 * Digit by digit and never through a double, which is the whole point: `"1.005"`
 * has to become 1005/1000, and handing it to `strtod` first would make it
 * 1.00499999999999989 before this function ever saw it.
 *
 * A comma is a decimal point too.  Somebody typing into a form in a locale that
 * writes `19,99` is not making a mistake, and refusing them would push every
 * caller into a replace() that this can do once.
 */
/*
 * The scanning half, which throws nothing and says which way it failed.
 *
 * Split out of `dec_parse` because a **collation** needs it: sqlite orders and
 * compares a decimal column by asking a callback about two strings, and a
 * callback in the middle of a statement is the last place that may leave a JS
 * exception pending -- there is nobody to hand it to and the next thing to touch
 * the context would report it instead of its own trouble.  So the parsing is
 * here and the complaining is in the caller.
 *
 * A decimal written as text is always exactly `units` at `scale` places, which
 * is why this can answer in two integers where the type itself is a fraction:
 * `10/3` has no text.
 */
typedef enum {
    DEC_TEXT_OK,
    DEC_TEXT_NOT_A_NUMBER,
    DEC_TEXT_TOO_MANY_PLACES,
    DEC_TEXT_TOO_BIG,
} DecTextHow;

static DecTextHow dec_scan(const char *text, int64_t *out_units, int *out_scale)
{
    const char *p = text;
    bool    negative = false;
    int64_t units    = 0;
    int     scale    = 0;
    bool    any      = false, dot = false;

    while (*p == ' ' || *p == '\t')
        p++;
    if (*p == '+' || *p == '-') {
        negative = (*p == '-');
        p++;
    }

    for (; *p; p++) {
        if (*p == '.' || *p == ',') {
            if (dot)
                return DEC_TEXT_NOT_A_NUMBER;
            dot = true;
            continue;
        }
        if (*p == ' ' || *p == '\t') {
            while (*p == ' ' || *p == '\t')
                p++;
            if (*p)
                return DEC_TEXT_NOT_A_NUMBER;  /* trailing space is fine */
            break;
        }
        if (*p < '0' || *p > '9')
            return DEC_TEXT_NOT_A_NUMBER;

        if (dot && scale == DEC_MAX_SCALE)
            return DEC_TEXT_TOO_MANY_PLACES;
        if (units > (INT64_MAX - 9) / 10)
            return DEC_TEXT_TOO_BIG;

        units = units * 10 + (*p - '0');
        if (dot)
            scale++;
        any = true;
    }
    if (!any)
        return DEC_TEXT_NOT_A_NUMBER;

    *out_units = negative ? -units : units;
    *out_scale = scale;
    return DEC_TEXT_OK;
}

static bool dec_parse(JSContext *ctx, const char *text, BtaDecimal *out)
{
    int64_t    units;
    int        scale;
    DecTextHow how = dec_scan(text, &units, &scale);

    switch (how) {
    case DEC_TEXT_OK:
        return dec_reduce(ctx, units, dec_pow10[scale], scale, out);
    case DEC_TEXT_TOO_MANY_PLACES:
        JS_ThrowRangeError(ctx, "Decimal: '%s' has more than %d decimal places",
                           text, DEC_MAX_SCALE);
        return false;
    case DEC_TEXT_TOO_BIG:
        JS_ThrowRangeError(ctx, "Decimal: '%s' does not fit in a decimal", text);
        return false;
    default:
        JS_ThrowRangeError(ctx, "Decimal: '%s' is not a number", text);
        return false;
    }
}

/*
 * Whatever was handed over, as a decimal -- or false with an exception pending.
 *
 * A **number** is read through its own shortest text, which is the honest way to
 * convert one: `Decimal(0.1)` is one tenth because that is what the literal says
 * and what `0.1` prints as, not the seventeen digits the double actually holds.
 * A caller who means those digits has a double and does not need this.
 */
static bool dec_from(JSContext *ctx, JSValueConst v, BtaDecimal *out)
{
    if (dec_is(v)) {
        *out = *dec_of(v);
        return true;
    }
    if (JS_IsString(v)) {
        const char *text = JS_ToCString(ctx, v);
        if (!text)
            return false;
        bool ok = dec_parse(ctx, text, out);
        JS_FreeCString(ctx, text);
        return ok;
    }
    if (JS_IsNumber(v)) {
        double d = 0;
        char   buf[64];

        JS_ToFloat64(ctx, &d, v);
        if (!isfinite(d)) {
            JS_ThrowRangeError(ctx, "Decimal: %s is not a number that can be exact",
                               isnan(d) ? "NaN" : "an infinity");
            return false;
        }
        /* The C locale on purpose: this is machine text on its way through, and
         * g_ascii_dtostr writes the shortest form that reads back the same. */
        g_ascii_dtostr(buf, sizeof buf, d);
        return dec_parse(ctx, buf, out);
    }
    JS_ThrowTypeError(ctx, "Decimal: expected text, a number or a Decimal");
    return false;
}

/* ------------------------------------------------------------------ writing */

/* The places this value is written at: its own scale, or however many it needs
 * to be exact when that is more -- and the ceiling when no number of them would
 * do.  `1/8` shows three places nobody declared; `19.90` shows the two that were
 * declared over the one it needs. */
static int dec_places(const BtaDecimal *d)
{
    int exact = dec_exact_places(d);

    if (exact < 0)
        return DEC_MAX_SCALE;
    return exact > d->scale ? exact : d->scale;
}

/*
 * The value as text.
 *
 * A value that **terminates** is written exactly.  One that does not -- a third,
 * a seventh -- has no exact decimal at any length, so it is written at nine
 * places, rounded.  That rounding is the only one here nobody asked for, and it
 * changes the text and never the value: the thirds are still in there, which is
 * why multiplying by three afterwards gives a whole ten.
 */
static char *dec_text(JSContext *ctx, const BtaDecimal *d)
{
    int     places = dec_places(d);
    int64_t units;

    if (!dec_scaled(ctx, d, places, DEC_AWAY, &units))
        return NULL;

    if (places == 0)
        return g_strdup_printf("%" PRId64, units);

    bool    neg   = units < 0;
    int64_t scale = dec_pow10[places];
    /* Split on the halves rather than the whole, so -0.5 does not come out
     * "-0.-5". */
    int64_t whole = units / scale;
    int64_t frac  = units % scale;

    if (frac < 0)  frac  = -frac;
    if (whole < 0) whole = -whole;

    return g_strdup_printf("%s%" PRId64 ".%0*" PRId64,
                           neg ? "-" : "", whole, places, frac);
}

/*
 * Text in, an exact count of its own smallest place out -- and nothing thrown.
 *
 * For whoever has to order, compare or total a decimal held as text in a place
 * where there is no JS context to complain to: sqlite has no exact numeric type,
 * so a decimal column is TEXT, and TEXT sorts `'9.00'` after `'10.00'` unless
 * something answers the question properly.  See `bta_sqlite.c`.
 */
bool bta_decimal_from_text(const char *text, int64_t *units, int *scale)
{
    return text && dec_scan(text, units, scale) == DEC_TEXT_OK;
}

/*
 * And back: `199` at 2 places is `"1.99"`.  A fresh string, `g_free`d by the
 * caller.
 *
 * The same halves-not-whole split `dec_text` makes, and for the same reason:
 * `-0.5` written from the whole would come out `"-0.-5"`.
 */
char *bta_decimal_to_text(int64_t units, int scale)
{
    if (scale <= 0 || scale > DEC_MAX_SCALE)
        return g_strdup_printf("%" PRId64, units);

    bool    neg   = units < 0;
    int64_t pow   = dec_pow10[scale];
    int64_t whole = units / pow;
    int64_t frac  = units % pow;

    if (frac < 0)  frac  = -frac;
    if (whole < 0) whole = -whole;

    return g_strdup_printf("%s%" PRId64 ".%0*" PRId64,
                           neg ? "-" : "", whole, scale, frac);
}

static JSValue dec_to_string(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    BtaDecimal *d = dec_of(this_val);
    if (!d)
        return JS_ThrowTypeError(ctx, "not a Decimal");

    char *text = dec_text(ctx, d);
    if (!text)
        return JS_EXCEPTION;

    JSValue out = JS_NewString(ctx, text);
    g_free(text);
    return out;
}

/* ------------------------------------------------------------ construction */

static JSValue dec_new(JSContext *ctx, const BtaDecimal *v)
{
    JSValue obj = JS_NewObjectClass(ctx, bta_decimal_class_id);
    if (JS_IsException(obj))
        return obj;

    BtaDecimal *d = js_mallocz(ctx, sizeof *d);
    if (!d) {
        JS_FreeValue(ctx, obj);
        return JS_EXCEPTION;
    }
    *d = *v;
    JS_SetOpaque(obj, d);
    return obj;
}

/* The value rounded to `places`, and remembering them. */
static bool dec_at_scale(JSContext *ctx, BtaDecimal *v, int places, DecRound how)
{
    int64_t units;

    if (!dec_scaled(ctx, v, places, how, &units))
        return false;
    return dec_reduce(ctx, units, dec_pow10[places], places, v);
}

static JSValue dec_construct(JSContext *ctx, JSValueConst new_target,
                             int argc, JSValueConst *argv)
{
    BtaDecimal v = { 0, 1, 0 };

    if (argc > 0 && !dec_from(ctx, argv[0], &v))
        return JS_EXCEPTION;

    /* A second argument fixes the scale: Decimal("19.9", 2) is 19.90, which is
     * what a money column means by two places.  Away, which is what a person
     * means by rounding money; `Round` is where another rule is asked for. */
    if (argc > 1 && !JS_IsUndefined(argv[1])) {
        int32_t want = 0;
        if (JS_ToInt32(ctx, &want, argv[1]))
            return JS_EXCEPTION;
        if (!dec_at_scale(ctx, &v, want, DEC_AWAY))
            return JS_EXCEPTION;
    }
    return dec_new(ctx, &v);
}

/* ------------------------------------------------------------ the operators */

/*
 * What the engine calls when either side of an operator is an object.
 *
 * Answering JS_ARITH_OTHER for anything that is not a Decimal is what keeps the
 * patch invisible: every other object goes on to ToPrimitive exactly as it did
 * before this file existed.
 */
static int dec_arith(JSContext *ctx, JSValue *sp, JSArithOp op)
{
    bool unary = (op == JS_ARITH_NEG || op == JS_ARITH_POS ||
                  op == JS_ARITH_INC || op == JS_ARITH_DEC);
    JSValueConst a = unary ? sp[-1] : sp[-2];
    JSValueConst b = unary ? JS_UNDEFINED : sp[-1];

    if (!dec_is(a) && !(!unary && dec_is(b)))
        return JS_ARITH_OTHER;

    /*
     * `+` with a text on either side is **concatenation**, as it is everywhere
     * else in JavaScript, and this exception is not a compromise -- it is the
     * only reading that lets `"Total: " + precio` work.  Without it that threw,
     * because the left side is not a number and this handler had already claimed
     * the operation: building a message out of a decimal, which is the second
     * thing anybody does with one, failed with a RangeError.
     *
     * The other operators keep the decimal reading, because `-` `*` `/` on a
     * string already mean *convert it to a number* in JavaScript, and converting
     * it to an exact decimal instead loses nothing.
     */
    if (op == JS_ARITH_ADD && (JS_IsString(a) || JS_IsString(b)))
        return JS_ARITH_OTHER;

    BtaDecimal x = { 0, 1, 0 }, y = { 1, 1, 0 };

    if (!dec_from(ctx, a, &x))
        return JS_ARITH_ERROR;
    if (!unary && !dec_from(ctx, b, &y))
        return JS_ARITH_ERROR;

    if (unary) {
        switch (op) {
        case JS_ARITH_NEG: x.num = -x.num;    break;
        case JS_ARITH_POS:                    break;
        case JS_ARITH_INC: op = JS_ARITH_ADD; break;   /* y is already one */
        case JS_ARITH_DEC: op = JS_ARITH_SUB; break;
        default: return JS_ARITH_OTHER;
        }
        if (op == JS_ARITH_NEG || op == JS_ARITH_POS) {
            JSValue r = dec_new(ctx, &x);
            if (JS_IsException(r))
                return JS_ARITH_ERROR;
            JS_FreeValue(ctx, sp[-1]);
            sp[-1] = r;
            return JS_ARITH_DONE;
        }
    }

    /*
     * The remembered scale, carried along.  Widest wins for a sum, they add for
     * a product -- which is what the places of a decimal do -- and it is *only*
     * ever about how the answer gets written.
     */
    int wide = x.scale > y.scale ? x.scale : y.scale;
    int sum  = x.scale + y.scale;
    BtaDecimal r;

    switch (op) {
    case JS_ARITH_ADD:
        if (!dec_reduce(ctx, (__int128)x.num * y.den + (__int128)y.num * x.den,
                        (__int128)x.den * y.den, wide, &r))
            return JS_ARITH_ERROR;
        break;

    case JS_ARITH_SUB:
        if (!dec_reduce(ctx, (__int128)x.num * y.den - (__int128)y.num * x.den,
                        (__int128)x.den * y.den, wide, &r))
            return JS_ARITH_ERROR;
        break;

    case JS_ARITH_MUL:
        if (!dec_reduce(ctx, (__int128)x.num * y.num, (__int128)x.den * y.den,
                        sum, &r))
            return JS_ARITH_ERROR;
        break;

    case JS_ARITH_DIV:
        /*
         * And here is the whole argument for a fraction.  Ten over three is ten
         * thirds -- not 3.33, not 3.333333333, but the number itself -- so
         * multiplying it by three cancels the threes and gives a whole ten.  A
         * scaled integer had to pick a length here, and whatever it picked was a
         * rounding nothing downstream could undo.
         *
         * The remembered scale is the operands' widest and is **not** inflated
         * when the quotient does not terminate: ten thirds keeps zero places, so
         * that whole ten prints as `10` and not as `10.000000000`.
         */
        if (y.num == 0) {
            JS_ThrowRangeError(ctx, "Decimal: division by zero");
            return JS_ARITH_ERROR;
        }
        if (!dec_reduce(ctx, (__int128)x.num * y.den, (__int128)x.den * y.num,
                        wide, &r))
            return JS_ARITH_ERROR;
        break;

    case JS_ARITH_LT: case JS_ARITH_LTE:
    case JS_ARITH_GT: case JS_ARITH_GTE: {
        /* Cross-multiplied, in 128 bits, and both denominators are positive so
         * the inequality does not turn over. */
        __int128 left  = (__int128)x.num * y.den;
        __int128 right = (__int128)y.num * x.den;

        bool res = (op == JS_ARITH_LT)  ? left <  right :
                   (op == JS_ARITH_LTE) ? left <= right :
                   (op == JS_ARITH_GT)  ? left >  right : left >= right;

        JS_FreeValue(ctx, sp[-2]);
        JS_FreeValue(ctx, sp[-1]);
        sp[-2] = JS_NewBool(ctx, res);
        return JS_ARITH_DONE;
    }

    case JS_ARITH_MOD:
    case JS_ARITH_POW:
        /*
         * Refused rather than let through.  Falling through would reach
         * ToPrimitive, which reads the decimal's own text back as a **double**
         * -- so `precio ** 2` would quietly answer with the floating point this
         * type exists to avoid, and nothing would say so.
         */
        JS_ThrowTypeError(ctx, "Decimal: %s is not defined on a decimal",
                          op == JS_ARITH_MOD ? "%" : "**");
        return JS_ARITH_ERROR;

    default:
        return JS_ARITH_OTHER;
    }

    JSValue result = dec_new(ctx, &r);
    if (JS_IsException(result))
        return JS_ARITH_ERROR;

    JS_FreeValue(ctx, sp[-2]);
    JS_FreeValue(ctx, sp[-1]);
    sp[-2] = result;
    return JS_ARITH_DONE;
}

/* ------------------------------------------------------------------ the API */

/*
 * Decimal.Round(decimals, [how]) -- the value at that many places.
 *
 * The one operation that deliberately **loses** something, which is why it is
 * asked for by name: a third rounded to two places is 3.33 and is no longer a
 * third, so multiplying it back by three gives 9.99.  Everything else here is
 * exact; this is where a program says it is done being exact.
 */
static JSValue dec_round(JSContext *ctx, JSValueConst this_val,
                         int argc, JSValueConst *argv)
{
    BtaDecimal *d = dec_of(this_val);
    if (!d)
        return JS_ThrowTypeError(ctx, "not a Decimal");

    int32_t want = 0;
    if (argc < 1 || JS_ToInt32(ctx, &want, argv[0]))
        return JS_ThrowTypeError(ctx, "Decimal.Round(decimals, [how]) needs a number");

    DecRound how = DEC_AWAY;
    if (argc > 1 && !JS_IsUndefined(argv[1]) && !dec_round_named(ctx, argv[1], &how))
        return JS_EXCEPTION;

    BtaDecimal v = *d;
    if (!dec_at_scale(ctx, &v, want, how))
        return JS_EXCEPTION;

    return dec_new(ctx, &v);
}

/*
 * Decimal.Trim() -- the same value, remembering no more places than it needs.
 *
 * `2.50` becomes `2.5` and `5.00` becomes `5`, and **the value does not change**:
 * only the scale it was written at does.  A calculator wants it and a money
 * column does not, which is why it is a call and not a rule.
 */
static JSValue dec_trim(JSContext *ctx, JSValueConst this_val,
                        int argc, JSValueConst *argv)
{
    BtaDecimal *d = dec_of(this_val);
    if (!d)
        return JS_ThrowTypeError(ctx, "not a Decimal");

    int        exact = dec_exact_places(d);
    BtaDecimal v     = *d;

    v.scale = exact < 0 ? 0 : exact;
    return dec_new(ctx, &v);
}

/*
 * Decimal.Split(total, parts) -- `parts` pieces that add back up to `total`.
 *
 * The problem no numeric type solves and every program with money has: ten
 * between three is 3.33 each and one cent left over, and rounding each share
 * separately gives 9.99.  So the remainder is *handed out* -- one extra unit to
 * the first shares until it is gone -- which is the largest-remainder rule, and
 * the only property that matters is asserted rather than described: **the pieces
 * sum to the total, exactly.**
 *
 * It works in whole units of the total's scale rather than in fractions, and
 * that is the point of it and not a shortcut.  Dividing would answer with exact
 * thirds, which do add back up -- but a share has to be an amount somebody can
 * be paid, and a third of a cent is not one.
 */
static JSValue dec_split(JSContext *ctx, JSValueConst this_val,
                         int argc, JSValueConst *argv)
{
    BtaDecimal total = { 0, 1, 0 };

    if (argc < 2)
        return JS_ThrowTypeError(ctx, "Decimal.Split(total, parts) needs both");
    if (!dec_from(ctx, argv[0], &total))
        return JS_EXCEPTION;

    int32_t parts = 0;
    if (JS_ToInt32(ctx, &parts, argv[1]))
        return JS_EXCEPTION;
    if (parts < 1)
        return JS_ThrowRangeError(ctx, "Decimal.Split: %d is not a number of parts",
                                  parts);

    int     places = dec_places(&total);
    int64_t units;

    if (!dec_scaled(ctx, &total, places, DEC_AWAY, &units))
        return JS_EXCEPTION;

    int64_t base = units / parts;
    int64_t rest = units % parts;
    int     sign = rest < 0 ? -1 : 1;
    int64_t over = rest < 0 ? -rest : rest;

    JSValue out = JS_NewArray(ctx);
    if (JS_IsException(out))
        return out;

    for (int32_t i = 0; i < parts; i++) {
        BtaDecimal share;

        if (!dec_reduce(ctx, base + (i < over ? sign : 0), dec_pow10[places],
                        places, &share)) {
            JS_FreeValue(ctx, out);
            return JS_EXCEPTION;
        }
        JSValue piece = dec_new(ctx, &share);
        if (JS_IsException(piece)) {
            JS_FreeValue(ctx, out);
            return JS_EXCEPTION;
        }
        JS_SetPropertyUint32(ctx, out, (uint32_t)i, piece);
    }
    return out;
}

/* The sign, as the three answers a comparison has: -1, 0 or 1. */
static JSValue dec_sign(JSContext *ctx, JSValueConst this_val)
{
    BtaDecimal *d = dec_of(this_val);
    if (!d)
        return JS_ThrowTypeError(ctx, "not a Decimal");
    return JS_NewInt32(ctx, d->num > 0 ? 1 : d->num < 0 ? -1 : 0);
}

/* The places it will be written at.  Presentation and not arithmetic: 199/10 and
 * 19.90 are the same number, and answer 1 and 2. */
static JSValue dec_get_scale(JSContext *ctx, JSValueConst this_val)
{
    BtaDecimal *d = dec_of(this_val);
    return d ? JS_NewInt32(ctx, dec_places(d))
             : JS_ThrowTypeError(ctx, "not a Decimal");
}

/*
 * Whether it has an exact decimal form at all.
 *
 * True for anything money can be, false for a third or a seventh -- and the
 * distinction is worth a name, because it is the difference between a value that
 * is written exactly and one that is rounded to nine places on the way out.  The
 * value itself is exact either way, which is why `(10/3) * 3` is ten.
 */
static JSValue dec_is_exact(JSContext *ctx, JSValueConst this_val)
{
    BtaDecimal *d = dec_of(this_val);
    if (!d)
        return JS_ThrowTypeError(ctx, "not a Decimal");
    return JS_NewBool(ctx, dec_exact_places(d) >= 0);
}

static JSValue dec_abs(JSContext *ctx, JSValueConst this_val,
                       int argc, JSValueConst *argv)
{
    BtaDecimal *d = dec_of(this_val);
    if (!d)
        return JS_ThrowTypeError(ctx, "not a Decimal");

    BtaDecimal v = *d;
    if (v.num < 0)
        v.num = -v.num;
    return dec_new(ctx, &v);
}

/* The double it is closest to, for the places that genuinely want one -- a
 * chart, a width, a percentage of a window.  Named rather than a valueOf, so
 * that going back to floating point is something a reader can see. */
static JSValue dec_number(JSContext *ctx, JSValueConst this_val,
                          int argc, JSValueConst *argv)
{
    BtaDecimal *d = dec_of(this_val);
    if (!d)
        return JS_ThrowTypeError(ctx, "not a Decimal");
    return JS_NewFloat64(ctx, (double)d->num / (double)d->den);
}

/* So JSON.stringify and File.SaveJson write a decimal as its own text rather
 * than as an empty object.  A string and not a number, because a number is where
 * the exactness would be lost again on the way back in. */
static JSValue dec_to_json(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv)
{
    return dec_to_string(ctx, this_val, 0, NULL);
}

static const JSCFunctionListEntry dec_proto_funcs[] = {
    JS_CFUNC_DEF("toString", 0, dec_to_string),
    JS_CFUNC_DEF("toJSON",   0, dec_to_json),
    JS_CFUNC_DEF("Round",    2, dec_round),
    JS_CFUNC_DEF("Trim",     0, dec_trim),
    JS_CFUNC_DEF("Abs",      0, dec_abs),
    JS_CFUNC_DEF("Number",   0, dec_number),
    JS_CGETSET_DEF("Scale",   dec_get_scale, NULL),
    JS_CGETSET_DEF("Sign",    dec_sign, NULL),
    JS_CGETSET_DEF("IsExact", dec_is_exact, NULL),
};

/*
 * The digits, for Locale.
 *
 * Published so a formatter never has to go through a double to write a decimal.
 * It answers in whole units at `places` -- or at the value's own when that is
 * -1 -- rounding there if the value has no exact decimal, which is the same
 * bargain the text makes and the only shape a fraction can reach a label in.
 * See bta.h for why it has three answers rather than two.
 */
int bta_decimal_parts(JSContext *ctx, JSValueConst v, int want,
                      int64_t *units, int *scale)
{
    BtaDecimal *d = dec_is(v) ? dec_of(v) : NULL;
    if (!d)
        return 0;

    int places = want >= 0 ? want : dec_places(d);

    if (!dec_scaled(ctx, d, places, DEC_AWAY, units))
        return -1;
    *scale = places;
    return 1;
}

/*
 * A decimal from whole units at a scale, which is what a C caller has: the
 * `DecimalBox` builds its value from digits it parsed and never from a double.
 * An exception is pending on failure, like every other constructor here.
 */
JSValue bta_decimal_new(JSContext *ctx, int64_t units, int scale)
{
    BtaDecimal v;

    if (!dec_reduce(ctx, units, dec_pow10[scale > DEC_MAX_SCALE ? DEC_MAX_SCALE
                                                               : (scale < 0 ? 0 : scale)],
                    scale, &v))
        return JS_EXCEPTION;
    return dec_new(ctx, &v);
}

void bta_decimal_init(JSContext *ctx, JSValue global)
{
    JSRuntime *rt = JS_GetRuntime(ctx);

    JS_NewClassID(rt, &bta_decimal_class_id);
    JS_NewClass(rt, bta_decimal_class_id, &dec_class);

    JSValue proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, proto, dec_proto_funcs,
                               G_N_ELEMENTS(dec_proto_funcs));
    JS_SetClassProto(ctx, bta_decimal_class_id, proto);

    JSValue ctor = JS_NewCFunction2(ctx, dec_construct, "Decimal", 2,
                                    JS_CFUNC_constructor, 0);
    JS_SetPropertyStr(ctx, ctor, "Split",
                      JS_NewCFunction(ctx, dec_split, "Split", 2));
    JS_SetConstructor(ctx, ctor, proto);
    JS_SetPropertyStr(ctx, global, "Decimal", ctor);

    /* The patch, armed.  Everything that is not a Decimal is untouched. */
    JS_SetArithHandler(rt, dec_arith);
}
