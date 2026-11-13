/*
 * The small shared helpers every part of the runtime needs, in a file that every
 * host links: two number conversions, and the line/column model `Text` and the
 * editor both answer with.
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
/* How many bytes the line separator starting at `p` takes, or 0 when there is
 * none.  These are the ones GTK breaks on, measured: `\n`, `\r\n` as one, a
 * lone `\r` and U+2029.  U+2028 does **not** break a buffer, although Pango
 * breaks it when it lays a paragraph out -- which is why `Text.Lines` and
 * `LineOf` can disagree on that one character, and why this one is the
 * editor's model: the line a `GotoLine` lands on is GTK's. */
static int line_break_len(const char *p)
{
    if (*p == '\n')
        return 1;
    if (*p == '\r')
        return p[1] == '\n' ? 2 : 1;
    if (g_utf8_get_char(p) == 0x2029)
        return (int)(g_utf8_next_char(p) - p);
    return 0;
}

/*
 * The line (1-based) a **JavaScript string index** falls on.
 *
 * **An index counts UTF-16 units and GTK counts characters, so the conversion
 * is not the identity.**  In `"🙂\nx"` the index 2 is the `\n` -- line 1 --
 * while the second *character* is the `x` -- line 2.  Asking GTK for
 * `get_iter_at_offset(2)` would answer line 2 and look right on every file
 * without astral characters, which is the shape of bug this walks to avoid.
 *
 * The walk advances while the character's whole width fits before the index,
 * which leaves an index inside a surrogate pair on the line of the character
 * holding it, and an index inside a `\r\n` on the line that break ends.
 * Clamped: below the start is line 1 and past the end is the last line.
 *
 * Shared with `Text.LineOf`, which runs it over the string it is handed --
 * one model, so the editor and a file scanner cannot answer differently.
 */
int bta_line_of_utf16(const char *s, int index)
{
    const char *p     = s;
    int         units = 0;
    int         line  = 1;

    while (*p) {
        int br = line_break_len(p);
        int n  = br ? br : (int)(g_utf8_next_char(p) - p);
        int u  = br == 2 ? 2 : (g_utf8_get_char(p) > 0xFFFF ? 2 : 1);

        /* The index falls inside this character, or before it: stop. */
        if (units + u > index)
            break;

        units += u;
        p     += n;
        if (br)
            line++;
    }
    return line;
}

/*
 * The character offset of a line/column, 1-based, clamped the way `GotoLine`
 * and `Select` clamp: a line past the last one answers as the last one, and a
 * column past the end of the line answers as the end of the line.
 *
 * `Text.OffsetAt` is this.  The editor does not use it: it has
 * `gtk_text_iter_set_line_offset`, and `Select` already clamps by the same
 * rule -- which the suite asserts rather than assumes.
 */
int bta_chars_at_position(const char *s, int line, int column)
{
    const char *p     = s;
    int         chars = 0;
    int         l     = 1;

    if (line < 1)   line   = 1;
    if (column < 1) column = 1;

    for (;;) {
        const char *end = p;
        int         len = 0;

        while (*end && !line_break_len(end)) {
            end = g_utf8_next_char(end);
            len++;
        }

        /* The text's last line answers for a line asked for beyond it. */
        if (l == line || !*end) {
            int take = column - 1;
            return chars + (take > len ? len : take);
        }

        int br = line_break_len(end);
        chars += len + (br == 2 ? 2 : 1);
        p      = end + br;
        l++;
    }
}

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
