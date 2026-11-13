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

#include <errno.h>
#include <math.h>
#include <stdint.h>
#include <string.h>

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

/*
 * A `GError` said in words of ours.
 *
 * **GLib's own sentence is translated**, so an error a program catches says
 * "No existe el fichero o el directorio" on a Spanish desktop and "No such file
 * or directory" on an English one: it reads differently on each machine, cannot
 * be matched by a program, and does not paste into a report.  The domain and
 * the code do not move, so they are what a sentence is built from -- the pairs
 * below are the ones the runtime's own verbs meet.
 *
 * `NULL` -- no error at all, which the call sites used to answer by hand -- is
 * "unknown error".  A pair that is not in the table is named by its domain and
 * its code, which is still stable and still quotable.  That fallback lives in
 * one buffer per thread -- a `Task` worker can reach `File` too -- and every use
 * formats it into the sentence it belongs to before anything else runs.
 */
const char *bta_gerror_text(const GError *err)
{
    static _Thread_local char other[80];

    if (!err)
        return "unknown error";

    if (err->domain == G_FILE_ERROR) {
        switch ((GFileError)err->code) {
        case G_FILE_ERROR_EXIST:       return "it is already there";
        case G_FILE_ERROR_ISDIR:       return "it is a directory";
        case G_FILE_ERROR_ACCES:       return "permission denied";
        case G_FILE_ERROR_NAMETOOLONG: return "the name is too long";
        case G_FILE_ERROR_NOENT:       return "no such file or directory";
        case G_FILE_ERROR_NOTDIR:      return "a directory in the path is not one";
        case G_FILE_ERROR_NXIO:        return "the device is not there";
        case G_FILE_ERROR_NODEV:       return "it is not a device";
        case G_FILE_ERROR_ROFS:        return "the filesystem is read-only";
        case G_FILE_ERROR_TXTBSY:      return "it is in use as text";
        case G_FILE_ERROR_FAULT:       return "the address is not valid";
        case G_FILE_ERROR_LOOP:        return "too many symbolic links";
        case G_FILE_ERROR_NOSPC:       return "no space left";
        case G_FILE_ERROR_NOMEM:       return "there is not enough memory";
        case G_FILE_ERROR_MFILE:       return "the process holds too many files";
        case G_FILE_ERROR_NFILE:       return "too many open files";
        case G_FILE_ERROR_BADF:        return "the descriptor is not valid";
        case G_FILE_ERROR_INVAL:       return "invalid argument";
        case G_FILE_ERROR_PIPE:        return "the pipe is broken";
        case G_FILE_ERROR_AGAIN:       return "it would have waited";
        case G_FILE_ERROR_INTR:        return "the call was interrupted";
        case G_FILE_ERROR_IO:          return "the device failed";
        case G_FILE_ERROR_PERM:        return "permission denied";
        case G_FILE_ERROR_NOSYS:       return "it is not implemented";
        case G_FILE_ERROR_FAILED:      return "it failed";
        default: break;
        }
    } else if (err->domain == G_IO_ERROR) {
        switch ((GIOErrorEnum)err->code) {
        case G_IO_ERROR_FAILED:              return "it failed";
        case G_IO_ERROR_NOT_FOUND:           return "no such file or directory";
        case G_IO_ERROR_EXISTS:              return "it is already there";
        case G_IO_ERROR_IS_DIRECTORY:        return "it is a directory";
        case G_IO_ERROR_NOT_DIRECTORY:       return "it is not a directory";
        case G_IO_ERROR_NOT_EMPTY:           return "it is not empty";
        case G_IO_ERROR_NOT_REGULAR_FILE:    return "it is not a regular file";
        case G_IO_ERROR_NOT_SYMBOLIC_LINK:   return "it is not a symbolic link";
        case G_IO_ERROR_NOT_MOUNTABLE_FILE:  return "it cannot be mounted";
        case G_IO_ERROR_FILENAME_TOO_LONG:   return "the name is too long";
        case G_IO_ERROR_INVALID_FILENAME:    return "the name is not valid";
        case G_IO_ERROR_TOO_MANY_LINKS:      return "too many symbolic links";
        case G_IO_ERROR_NO_SPACE:            return "no space left";
        case G_IO_ERROR_INVALID_ARGUMENT:    return "invalid argument";
        case G_IO_ERROR_PERMISSION_DENIED:   return "permission denied";
        case G_IO_ERROR_NOT_SUPPORTED:       return "it is not supported here";
        case G_IO_ERROR_NOT_MOUNTED:         return "it is not mounted";
        case G_IO_ERROR_ALREADY_MOUNTED:     return "it is already mounted";
        case G_IO_ERROR_CLOSED:              return "it is closed";
        case G_IO_ERROR_CANCELLED:           return "the operation was cancelled";
        case G_IO_ERROR_PENDING:             return "another operation is still pending";
        case G_IO_ERROR_READ_ONLY:           return "it is read-only";
        case G_IO_ERROR_CANT_CREATE_BACKUP:  return "the backup could not be made";
        case G_IO_ERROR_WRONG_ETAG:          return "it changed while it was read";
        case G_IO_ERROR_TIMED_OUT:           return "it took too long";
        case G_IO_ERROR_WOULD_RECURSE:       return "it would recurse";
        case G_IO_ERROR_BUSY:                return "it is busy";
        case G_IO_ERROR_WOULD_BLOCK:         return "it would have waited";
        case G_IO_ERROR_HOST_NOT_FOUND:      return "the host was not found";
        case G_IO_ERROR_WOULD_MERGE:         return "it would merge";
        case G_IO_ERROR_TOO_MANY_OPEN_FILES: return "too many open files";
        case G_IO_ERROR_NOT_INITIALIZED:     return "it was not started";
        case G_IO_ERROR_ADDRESS_IN_USE:      return "the address is already in use";
        case G_IO_ERROR_PARTIAL_INPUT:       return "the input ended in the middle";
        case G_IO_ERROR_INVALID_DATA:        return "the data is not what it claims";
        case G_IO_ERROR_DBUS_ERROR:          return "the other service failed";
        case G_IO_ERROR_HOST_UNREACHABLE:    return "the host is unreachable";
        case G_IO_ERROR_NETWORK_UNREACHABLE: return "the network is unreachable";
        case G_IO_ERROR_CONNECTION_REFUSED:  return "the connection was refused";
        case G_IO_ERROR_PROXY_FAILED:        return "the proxy failed";
        case G_IO_ERROR_PROXY_AUTH_FAILED:   return "the proxy refused the credentials";
        case G_IO_ERROR_PROXY_NEED_AUTH:     return "the proxy wants credentials";
        case G_IO_ERROR_PROXY_NOT_ALLOWED:   return "the proxy is not allowed";
        case G_IO_ERROR_MESSAGE_TOO_LARGE:   return "the message is too large";
        case G_IO_ERROR_NO_SUCH_DEVICE:      return "the device is not there";
        case G_IO_ERROR_DESTINATION_UNSET:   return "the destination was not set";
        default: break;
        }
    } else if (err->domain == G_SPAWN_ERROR) {
        switch ((GSpawnError)err->code) {
        case G_SPAWN_ERROR_FORK:        return "the fork failed";
        case G_SPAWN_ERROR_READ:        return "the pipe could not be read";
        case G_SPAWN_ERROR_CHDIR:       return "the working directory cannot be entered";
        case G_SPAWN_ERROR_ACCES:       return "permission denied";
        case G_SPAWN_ERROR_PERM:        return "permission denied";
        case G_SPAWN_ERROR_TOO_BIG:     return "the arguments do not fit";
        case G_SPAWN_ERROR_NOEXEC:      return "it is not executable";
        case G_SPAWN_ERROR_NAMETOOLONG: return "the name is too long";
        case G_SPAWN_ERROR_NOENT:       return "no such file or directory";
        case G_SPAWN_ERROR_NOMEM:       return "there is not enough memory";
        case G_SPAWN_ERROR_NOTDIR:      return "a directory in the path is not one";
        case G_SPAWN_ERROR_LOOP:        return "too many symbolic links";
        case G_SPAWN_ERROR_TXTBUSY:     return "it is in use as text";
        case G_SPAWN_ERROR_IO:          return "the device failed";
        case G_SPAWN_ERROR_NFILE:       return "too many open files";
        case G_SPAWN_ERROR_MFILE:       return "the process holds too many files";
        case G_SPAWN_ERROR_INVAL:       return "invalid argument";
        case G_SPAWN_ERROR_ISDIR:       return "it is a directory";
        case G_SPAWN_ERROR_LIBBAD:      return "a library it needs is damaged";
        case G_SPAWN_ERROR_FAILED:      return "it could not be started";
        default: break;
        }
    } else if (err->domain == G_CONVERT_ERROR) {
        switch ((GConvertError)err->code) {
        case G_CONVERT_ERROR_NO_CONVERSION:     return "there is no such conversion";
        case G_CONVERT_ERROR_ILLEGAL_SEQUENCE:  return "the text is not valid for it";
        case G_CONVERT_ERROR_FAILED:            return "the conversion failed";
        case G_CONVERT_ERROR_PARTIAL_INPUT:     return "the input ended in the middle";
        case G_CONVERT_ERROR_BAD_URI:           return "the URI is not usable";
        case G_CONVERT_ERROR_NOT_ABSOLUTE_PATH: return "the path is not absolute";
        case G_CONVERT_ERROR_NO_MEMORY:         return "there is not enough memory";
        case G_CONVERT_ERROR_EMBEDDED_NUL:      return "the text has a NUL in it";
        default: break;
        }
    } else if (err->domain == G_TLS_ERROR) {
        switch ((GTlsError)err->code) {
        case G_TLS_ERROR_UNAVAILABLE:              return "TLS is not available";
        case G_TLS_ERROR_MISC:                     return "TLS failed";
        case G_TLS_ERROR_BAD_CERTIFICATE:          return "the certificate is not valid";
        case G_TLS_ERROR_NOT_TLS:                  return "the other side does not speak TLS";
        case G_TLS_ERROR_HANDSHAKE:                return "the handshake failed";
        case G_TLS_ERROR_CERTIFICATE_REQUIRED:     return "a certificate is required";
        case G_TLS_ERROR_EOF:                      return "the other side closed without saying goodbye";
        case G_TLS_ERROR_INAPPROPRIATE_FALLBACK:   return "the fallback was refused";
        case G_TLS_ERROR_BAD_CERTIFICATE_PASSWORD: return "the certificate's password is wrong";
        default: break;
        }
    } else if (err->domain == G_KEY_FILE_ERROR) {
        switch ((GKeyFileError)err->code) {
        case G_KEY_FILE_ERROR_UNKNOWN_ENCODING: return "it is not valid UTF-8";
        case G_KEY_FILE_ERROR_PARSE:            return "it is not a settings file";
        case G_KEY_FILE_ERROR_NOT_FOUND:        return "it was not found";
        case G_KEY_FILE_ERROR_KEY_NOT_FOUND:    return "there is no such key";
        case G_KEY_FILE_ERROR_GROUP_NOT_FOUND:  return "there is no such group";
        case G_KEY_FILE_ERROR_INVALID_VALUE:    return "the value is not valid";
        default: break;
        }
    } else if (err->domain == G_MARKUP_ERROR) {
        switch ((GMarkupError)err->code) {
        case G_MARKUP_ERROR_BAD_UTF8:          return "it is not valid UTF-8";
        case G_MARKUP_ERROR_EMPTY:             return "it is empty";
        case G_MARKUP_ERROR_PARSE:             return "it is not markup";
        case G_MARKUP_ERROR_UNKNOWN_ELEMENT:   return "it names an element that does not exist";
        case G_MARKUP_ERROR_UNKNOWN_ATTRIBUTE: return "it names an attribute that does not exist";
        case G_MARKUP_ERROR_INVALID_CONTENT:   return "an element holds what it cannot";
        case G_MARKUP_ERROR_MISSING_ATTRIBUTE: return "an element is missing an attribute it needs";
        default: break;
        }
    } else if (err->domain == G_RESOLVER_ERROR) {
        switch ((GResolverError)err->code) {
        case G_RESOLVER_ERROR_NOT_FOUND:         return "the host was not found";
        case G_RESOLVER_ERROR_TEMPORARY_FAILURE: return "the host could not be looked up now";
        case G_RESOLVER_ERROR_INTERNAL:          return "the lookup failed";
        default: break;
        }
    } else if (err->domain == G_REGEX_ERROR) {
        /* The match and the replacement have codes of their own; every
         * other code is one way a pattern fails to compile. */
        switch (err->code) {
        case G_REGEX_ERROR_REPLACE: return "the replacement is not valid";
        case G_REGEX_ERROR_MATCH:   return "the match failed";
        case G_REGEX_ERROR_INTERNAL: return "the pattern engine failed";
        default:                    return "the pattern is not a valid regular expression";
        }
#if !defined(BTA_HEADLESS) && !defined(BTA_META_ONLY)
    } else if (err->domain == GDK_TEXTURE_ERROR) {
        switch ((GdkTextureError)err->code) {
        case GDK_TEXTURE_ERROR_TOO_LARGE:           return "the image is too large";
        case GDK_TEXTURE_ERROR_CORRUPT_IMAGE:       return "the image is damaged";
        case GDK_TEXTURE_ERROR_UNSUPPORTED_CONTENT: return "the image holds what cannot be shown";
        case GDK_TEXTURE_ERROR_UNSUPPORTED_FORMAT:  return "the image format is not supported";
        default: break;
        }
#endif
    } else if (!strcmp(g_quark_to_string(err->domain), "soup-session-error-quark")) {
        /* Named, not included: this file builds without libsoup. The codes
         * are SoupSessionError's, in its order. */
        switch (err->code) {
        case 0: return "the response could not be parsed";
        case 1: return "the response's encoding is not understood";
        case 2: return "there were too many redirects";
        case 3: return "the request was restarted too many times";
        case 4: return "a redirect named no location";
        case 5: return "a redirect named an address that is not valid";
        case 6: return "the request is already being sent";
        default: break;
        }
    }

    g_snprintf(other, sizeof other, "%s %d", g_quark_to_string(err->domain),
               err->code);
    return other;
}

/*
 * And the same for `errno`, because `g_strerror` is the C library's and it is
 * translated on each desktop too.  The numbers do not move, and these phrases
 * are word for word the ones the table above uses for the same conditions --
 * one wording whether a failure arrived as a `GError` or as a failed call.
 * An errno nobody here knows is `"errno N"`: still stable, still quotable.
 */
const char *bta_errno_text(int errnum)
{
    static _Thread_local char other[32];

    switch (errnum) {
    case EPERM:        return "permission denied";
    case ENOENT:       return "no such file or directory";
    case EINTR:        return "the call was interrupted";
    case EIO:          return "the device failed";
    case ENXIO:        return "the device is not there";
    case E2BIG:        return "the arguments do not fit";
    case ENOEXEC:      return "it is not executable";
    case EBADF:        return "the descriptor is not valid";
    case EAGAIN:       return "it would have waited";
    case ENOMEM:       return "there is not enough memory";
    case EACCES:       return "permission denied";
    case EFAULT:       return "the address is not valid";
    case EBUSY:        return "it is busy";
    case EEXIST:       return "it is already there";
    case EXDEV:        return "it would cross filesystems";
    case ENODEV:       return "it is not a device";
    case ENOTDIR:      return "a directory in the path is not one";
    case EISDIR:       return "it is a directory";
    case EINVAL:       return "invalid argument";
    case ENFILE:       return "too many open files";
    case EMFILE:       return "the process holds too many files";
    case EFBIG:        return "the file is too large";
    case ENOSPC:       return "no space left";
    case ESPIPE:       return "it cannot seek";
    case EROFS:        return "the filesystem is read-only";
    case EMLINK:       return "too many links";
    case EPIPE:        return "the pipe is broken";
    case ENAMETOOLONG: return "the name is too long";
    case ENOSYS:       return "it is not implemented";
    case ENOTEMPTY:    return "it is not empty";
    case ELOOP:        return "too many symbolic links";
    case ETXTBSY:      return "it is in use as text";
#ifdef ENOTSUP
    case ENOTSUP:      return "it is not supported here";
#endif
    case EADDRINUSE:   return "the address is already in use";
    case ENETUNREACH:  return "the network is unreachable";
    case ECONNREFUSED: return "the connection was refused";
    default: break;
    }

    g_snprintf(other, sizeof other, "errno %d", errnum);
    return other;
}

/*
 * `Text.LineOf(text, index)`: the line a JavaScript string index falls on,
 * over `bta_line_of_utf16`. Here and not in bta_paint.c because the core
 * answers it for `check` without the drawing module, and the core's copy and
 * the graphical one both read the index with a bare `JS_ToInt32` -- so
 * `LineOf(src, "abc")` answered line 1. The index goes through `bta_to_int`
 * now, which refuses what is not a number.
 */
JSValue bta_text_line_of(JSContext *ctx, JSValueConst this_val,
                         int argc, JSValueConst *argv)
{
    (void)this_val;
    if (argc < 2)
        return JS_ThrowTypeError(ctx, "Text.LineOf(text, index) needs the text "
                                      "and an index");

    int32_t index = 0;
    if (!bta_to_int(ctx, argv[1], "Text.LineOf", &index))
        return JS_EXCEPTION;

    const char *s = JS_ToCString(ctx, argv[0]);
    if (!s)
        return JS_EXCEPTION;

    int line = bta_line_of_utf16(s, index);
    JS_FreeCString(ctx, s);
    return JS_NewInt32(ctx, line);
}

/* ------------------------------------------------------- files and jobs */

/* A file's whole contents, or NULL. Both hosts and the metadata host read
 * their sources through it. */
char *bta_read_file(const char *path, size_t *len)
{
    char  *data = NULL;
    gsize  n    = 0;

    if (!g_file_get_contents(path, &data, &n, NULL))
        return NULL;
    if (len)
        *len = n;
    return data;
}

/* Promise callbacks and other microtasks only run when we pump them. */
void bta_drain_jobs(JSRuntime *rt)
{
    JSContext *cctx;
    for (;;) {
        int rc = JS_ExecutePendingJob(rt, &cctx);
        if (rc <= 0) {
            if (rc < 0)
                bta_dump_error(cctx);
            break;
        }
    }
}

/* An ASCII identifier: what a class path is made of, and what a `.form`
 * names a control with. Here because every host -- the metadata host too --
 * validates a class name before it looks one up (bta_language.c). */
bool bta_is_identifier(const char *s)
{
    if (!s || !*s || (!g_ascii_isalpha(*s) && *s != '_' && *s != '$'))
        return false;
    for (const char *p = s; *p; p++)
        if (!g_ascii_isalnum(*p) && *p != '_' && *p != '$')
            return false;
    return true;
}

/*
 * `Printer.Papers`: the sheets a document lays itself out on, in whole points,
 * the same table in both hosts.
 *
 * It was asked of GTK (`gtk_paper_size_get_width`), which the console host
 * does not have, so `lib/report` kept a copy of its own to paginate a
 * `ReportDocument` with no display -- the table this was made to stop being
 * written twice. The three are standard sizes and need no toolkit: A4 and A5
 * are ISO millimetres, Letter is inches, and 72 points to the inch is a PDF
 * page's unit. Rounded to whole points, as the GTK answer was, because a
 * quarter of a point is the noise of the millimetre conversion and not a
 * size anybody lays out to. tests/headless.sh holds both hosts to 595x842,
 * 612x792 and 420x595, which is what GTK answered.
 */
JSValue bta_papers_new(JSContext *ctx)
{
    static const struct { const char *name; double w_mm, h_mm; } sheets[] = {
        { "A4",     210.0, 297.0 },
        { "Letter", 215.9, 279.4 },   /* 8.5 x 11 in */
        { "A5",     148.0, 210.0 },
    };
    JSValue out = JS_NewObject(ctx);

    for (size_t i = 0; i < G_N_ELEMENTS(sheets); i++) {
        JSValue sheet = JS_NewObject(ctx);

        JS_SetPropertyStr(ctx, sheet, "Width",
                          JS_NewInt32(ctx, (int)(sheets[i].w_mm * 72.0 / 25.4 + 0.5)));
        JS_SetPropertyStr(ctx, sheet, "Height",
                          JS_NewInt32(ctx, (int)(sheets[i].h_mm * 72.0 / 25.4 + 0.5)));
        JS_SetPropertyStr(ctx, out, sheets[i].name, sheet);
    }
    return out;
}
