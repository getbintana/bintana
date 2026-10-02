/*
 * Random -- numbers a program cannot predict.
 *
 *     Random.Bytes(32)        // 32 bytes from the operating system
 *     Random.Int(1, 6)        // 1..6, both ends included, no bias
 *     Random.Uuid()           // "3f1c0a9e-…-4…-b…", a version 4
 *
 * ## Why a global and not `Math.random`'s neighbour
 *
 * `Math.random` is the language's and is not a source for a token, a session
 * id or a nonce: it is a generator seeded once, whose next output follows from
 * the last. A second `random` in `Math` would make "the secure one" a thing
 * that only a footnote tells apart from the other; a name of its own says it.
 *
 * ## Where the bytes come from, and what is refused
 *
 * **The operating system's source and no other** -- `getrandom(2)` on Linux,
 * `arc4random_buf` on macOS, `RtlGenRandom` on Windows -- and when it fails the
 * call **throws**. There is deliberately no fallback to GLib's `g_random_*` (a
 * Mersenne Twister: right for shuffling a playlist, and exactly what a reader
 * would assume this was) or to the clock: a silent fallback here is not
 * robustness, it is the one bug this file exists to prevent.
 *
 * The Windows and macOS branches cannot be compiled on the machine this was
 * written on; `.github/workflows/ci.yml`'s `windows` job is the compiler for the
 * first. Each is as small as it can be and says why beside it.
 *
 * ## `Int` is rejection sampling
 *
 * `r % span` is biased whenever `span` does not divide 2^64 -- small, and the
 * mistake that every "pick a winner" gets wrong once. A draw below
 * `2^64 mod span` is thrown away and drawn again, which makes every value in the
 * range exactly as likely. It works in what a JavaScript number holds exactly:
 * a span past 2^53 is refused, not rounded.
 *
 * ## In a `Task`
 *
 * Nothing here calls back or keeps a list, so it is installed in a worker too
 * (bta_task.c) -- `Random` missing from there would be "not a function" at call
 * time and not at load.
 */

#include "bta.h"

#include <errno.h>
#include <math.h>
#include <string.h>

#ifdef G_OS_WIN32
#  include <windows.h>
#elif defined(__APPLE__)
#  include <stdlib.h>
#else
#  include <sys/random.h>
#endif

/* The most `Bytes` will hand out in one call. A megabyte is more than any
 * token, key or nonce and stops `Random.Bytes(1e9)` from being a way to freeze
 * the program for an answer nobody could use. */
#define RANDOM_MAX_BYTES (1024 * 1024)

/* Fills `buf` from the operating system. False, with `errno` or the platform's
 * answer in `*why`, when it cannot -- and never anything weaker. */
static bool random_fill(guint8 *buf, size_t n, const char **why)
{
#ifdef G_OS_WIN32
    /* `RtlGenRandom` is exported by advapi32 as `SystemFunction036`, and is
     * fetched at run time so that this needs nothing added to the link line --
     * which cannot be tried here. `BCryptGenRandom` is the documented
     * replacement and would want `bcrypt` linked. */
    typedef BOOLEAN (WINAPI *RtlGenRandomFn)(PVOID, ULONG);
    static RtlGenRandomFn fn;

    if (!fn) {
        HMODULE lib = LoadLibraryA("advapi32.dll");
        fn = lib ? (RtlGenRandomFn)(void *)GetProcAddress(lib, "SystemFunction036")
                 : NULL;
    }
    if (!fn) {
        *why = "RtlGenRandom is not available";
        return false;
    }
    while (n > 0) {
        ULONG chunk = n > 0x10000000 ? 0x10000000 : (ULONG)n;
        if (!fn(buf, chunk)) {
            *why = "RtlGenRandom failed";
            return false;
        }
        buf += chunk;
        n   -= chunk;
    }
    return true;
#elif defined(__APPLE__)
    arc4random_buf(buf, n);                    /* cannot fail, by its contract */
    (void)why;
    return true;
#else
    while (n > 0) {
        /* A call may return fewer bytes than asked, and a signal may cut it
         * short: both are the loop's business and neither is an error. */
        ssize_t got = getrandom(buf, n, 0);

        if (got < 0) {
            if (errno == EINTR)
                continue;
            *why = g_strerror(errno);
            return false;
        }
        buf += got;
        n   -= (size_t)got;
    }
    return true;
#endif
}

static JSValue random_throw(JSContext *ctx, const char *who, const char *why)
{
    return JS_ThrowInternalError(ctx, "%s: the operating system gave no "
                                      "randomness (%s), and nothing weaker is "
                                      "used in its place", who, why);
}

/* A uniformly drawn integer in [0, span), `span` >= 1. */
static bool random_below(uint64_t span, uint64_t *out, const char **why)
{
    /* The draws below `threshold` are the ones that would make the low values
     * more likely: 2^64 mod span, written so that no 65th bit is needed. */
    uint64_t threshold = (0 - span) % span;
    uint64_t r;

    do {
        if (!random_fill((guint8 *)&r, sizeof r, why))
            return false;
    } while (r < threshold);

    *out = r % span;
    return true;
}

static JSValue random_bytes(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
    int32_t n;

    if (argc < 1)
        return JS_ThrowTypeError(ctx, "Random.Bytes(count) needs the number "
                                      "of bytes");
    if (!bta_to_int(ctx, argv[0], "Random.Bytes", &n))
        return JS_EXCEPTION;
    if (n < 0 || n > RANDOM_MAX_BYTES)
        return JS_ThrowRangeError(ctx, "Random.Bytes: %d is not between 0 and "
                                       "%d", n, RANDOM_MAX_BYTES);
    if (n == 0)
        return bta_bytes_new(ctx, NULL, 0);    /* an empty Bytes carries NULL */

    guint8     *buf = g_malloc((gsize)n);
    const char *why = "unknown";

    if (!random_fill(buf, (size_t)n, &why)) {
        g_free(buf);
        return random_throw(ctx, "Random.Bytes", why);
    }

    JSValue out = bta_bytes_new(ctx, buf, (size_t)n);
    g_free(buf);
    return out;
}

/* The largest span an integer-valued JavaScript number can be asked for: past
 * 2^53 consecutive integers are not all representable. */
#define RANDOM_MAX_SPAN 9007199254740992.0

static JSValue random_int(JSContext *ctx, JSValueConst this_val,
                          int argc, JSValueConst *argv)
{
    double lo, hi;

    if (argc < 2)
        return JS_ThrowTypeError(ctx, "Random.Int(min, max) needs both ends");
    if (!bta_to_number(ctx, argv[0], "Random.Int", &lo) ||
        !bta_to_number(ctx, argv[1], "Random.Int", &hi))
        return JS_EXCEPTION;

    if (lo != floor(lo) || hi != floor(hi) ||
        fabs(lo) > RANDOM_MAX_SPAN || fabs(hi) > RANDOM_MAX_SPAN)
        return JS_ThrowRangeError(ctx, "Random.Int: the ends are whole numbers "
                                       "a number holds exactly (within 2^53)");
    if (lo > hi)
        return JS_ThrowRangeError(ctx, "Random.Int: %.0f is above %.0f -- the "
                                       "smaller end comes first", lo, hi);
    if (hi - lo >= RANDOM_MAX_SPAN)
        return JS_ThrowRangeError(ctx, "Random.Int: the range is wider than 2^53 "
                                       "values, which a number cannot tell apart");

    uint64_t    span = (uint64_t)(hi - lo) + 1;
    uint64_t    pick;
    const char *why = "unknown";

    if (!random_below(span, &pick, &why))
        return random_throw(ctx, "Random.Int", why);

    return JS_NewFloat64(ctx, lo + (double)pick);
}

static JSValue random_uuid(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv)
{
    guint8      b[16];
    const char *why = "unknown";

    if (!random_fill(b, sizeof b, &why))
        return random_throw(ctx, "Random.Uuid", why);

    /* RFC 9562, version 4: the version nibble, then the variant `10xx`. Built
     * here from the bytes above rather than by `g_uuid_string_random`, because
     * where that one gets its bytes is exactly what this file refuses to
     * assume. */
    b[6] = (guint8)((b[6] & 0x0f) | 0x40);
    b[8] = (guint8)((b[8] & 0x3f) | 0x80);

    char text[37];
    g_snprintf(text, sizeof text,
               "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
               b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7],
               b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15]);
    return JS_NewString(ctx, text);
}

static const JSCFunctionListEntry random_props[] = {
    /* Bytes(count) -> Bytes
     *   `count` bytes from the operating system's source, 0 to 1,048,576. **The
     *   one to make a token, a key or a nonce from** -- `Math.random` is not.
     *   Throws, and never falls back to something weaker, if the system has no
     *   randomness to give
     */
    JS_CFUNC_DEF("Bytes", 1, random_bytes),
    /* Int(min, max) -> number
     *   a whole number from `min` to `max`, **both ends included**, every value
     *   exactly as likely. Throws for ends that are not whole numbers, for
     *   `min` above `max`, and for a range wider than 2^53
     */
    JS_CFUNC_DEF("Int", 2, random_int),
    /* Uuid() -> string
     *   a version 4 UUID in its lower-case 8-4-4-4-12 spelling, from the same
     *   source as `Bytes`. Random, so it does not sort by creation: as a
     *   database key it scatters an index
     */
    JS_CFUNC_DEF("Uuid", 0, random_uuid),
};

void bta_random_init(JSContext *ctx, JSValue global)
{
    JSValue random = JS_NewObject(ctx);

    JS_SetPropertyFunctionList(ctx, random, random_props, G_N_ELEMENTS(random_props));
    JS_SetPropertyStr(ctx, global, "Random", random);
}
