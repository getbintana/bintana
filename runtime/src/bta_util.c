/*
 * Two conversions every part of the runtime needs, in a file that every host
 * links.
 *
 * They used to live in `bta_widget.c`, which was the file with the most numeric
 * setters and not the file they belong to: `bta_network.c` and `bta_xml.c` use
 * both, and so does the console host, which links neither widget file. Keeping
 * them here is what lets `bintana` and `bintana-gui` share one definition
 * instead of two copies that can drift apart.
 */
#include "bta.h"

#include <math.h>
#include <stdint.h>

/*
 * A number, or a refusal that names what arrived.
 *
 * `JS_ToInt32` is why `Margin = "0 0 0 12"` was a silent zero. ToNumber on a
 * string that is not a number answers NaN, ToInt32(NaN) is 0, and nothing along
 * that road fails -- so every numeric property in this runtime took whatever it
 * was handed, and a gap that never appeared was the only symptom. Found in a
 * delivered application whose month label asked for a margin the way `Padding`
 * is written, four sizes in a string.
 *
 * Every other setter here refuses what it cannot use and says what the value
 * was. This is that, once, for all of them -- the alternative being the same
 * check written twenty-eight times, which is twenty-eight chances to leave one
 * out.
 *
 * `""` and `null` are 0 and not a refusal: that is what ToNumber says they are,
 * and a property grid clearing a field means nothing-was-asked-for. What is
 * refused is a value with no numeric reading at all.
 */
bool bta_to_number(JSContext *ctx, JSValueConst val, const char *name, double *out)
{
    double n;

    if (JS_ToFloat64(ctx, &n, val))
        return false;                      /* it threw on the way; that stands */
    if (isnan(n)) {
        const char *had = JS_ToCString(ctx, val);

        JS_ThrowTypeError(ctx, "%s: %s%s%s is not a number", name,
                          JS_IsString(val) ? "\"" : "", had ? had : "?",
                          JS_IsString(val) ? "\"" : "");
        if (had)
            JS_FreeCString(ctx, had);
        return false;
    }
    *out = n;
    return true;
}

bool bta_to_int(JSContext *ctx, JSValueConst val, const char *name, int32_t *out)
{
    double n;

    if (!bta_to_number(ctx, val, name, &n))
        return false;

    /* A cast past what an `int32_t` holds is undefined in C and answers
     * differently per machine -- 1e12 came out INT32_MIN on this one -- which
     * is exactly the "accepted and quietly wrong" the helper exists to stop.
     * Infinity lands here too: `bta_to_number` refuses NaN and not it. */
    if (n < (double)INT32_MIN || n > (double)INT32_MAX) {
        char buf[G_ASCII_DTOSTR_BUF_SIZE];

        JS_ThrowRangeError(ctx, "%s: %s is outside the range of an integer",
                           name, g_ascii_formatd(buf, sizeof buf, "%g", n));
        return false;
    }

    /* Truncated the way ToInt32 truncates, so a value that was already legal
     * stays legal: 8.7 is 8 here as it was before. */
    *out = (int32_t)n;
    return true;
}
