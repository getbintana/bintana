/*
 * Database.Odbc -- a driver that reaches whatever server the machine has an
 * ODBC driver for: SQL Server, MySQL/MariaDB, PostgreSQL, Firebird, an Access
 * file. The design, what was measured and why it comes before a native
 * PostgreSQL driver are in docs/plans/odbc-plan.md; this file is built in its
 * stages, and says at the foot which ones it has.
 *
 * ## Three platforms, one file
 *
 * The C API is the same everywhere -- `sql.h`, `sqlext.h` -- and the driver
 * manager is the platform's: `odbc32.dll` on Windows, unixODBC on Linux and on
 * macOS. What differs is **the text**, and it is decided once, here:
 *
 *   - **unixODBC: the narrow API, in UTF-8.** Measured on unixODBC 2.3.14: the
 *     wide API is only as good as the driver's own `...W` entries, and a driver
 *     without them (Fedora's sqliteodbc has none) gets the statement converted
 *     down to ISO 8859-1 -- `'Año ñandú €'` was stored as `41 F1 6F ...`, the
 *     euro cut to `AC`. `IconvEncoding` is not honoured anywhere. Through the
 *     narrow API both sqliteodbc and psqlODBC round-trip UTF-8 exactly.
 *   - **Windows: the wide API, in UTF-16.** The narrow one there is the ANSI
 *     code page, and an `ñ` survives it only by luck.
 *
 * So `BtaOdbcChar` and `ODBC_API()` below are the whole of the difference:
 * every call goes through the macro, every string through `odbc_in` and
 * `odbc_out`, and nothing else in the file knows which platform it is on.
 * iODBC is not targeted -- its `SQLWCHAR` is a 4-byte `wchar_t`, and the drivers
 * a Mac user installs are built against unixODBC.
 *
 * ## Optional
 *
 * The sqlite mould: without a driver manager at build time `Database.Odbc`
 * exists and says which package is missing. On Windows the manager is part of
 * the system and the headers are MinGW-w64's, so it is always there.
 *
 * ## No dialog, ever
 *
 * `SQLDriverConnect` is always `SQL_DRIVER_NOPROMPT`: a driver missing a value
 * fails with its message instead of opening a window of its own.
 */

#include "bta.h"

#include <locale.h>
#include <math.h>
#include <stdint.h>
#include <string.h>

#ifdef BTA_HAVE_ODBC

#ifdef G_OS_WIN32
#include <windows.h>
#endif
#include <sql.h>
#include <sqlext.h>

/* ------------------------------------------------------- the text layer */

#ifdef G_OS_WIN32
typedef SQLWCHAR BtaOdbcChar;
#define ODBC_API(f) f##W
#else
typedef SQLCHAR  BtaOdbcChar;
#define ODBC_API(f) f
#endif

/* UTF-8 from JavaScript, in the manager's encoding; g_free it. NULL only on
 * Windows, for text that is not UTF-8 -- which a JS string never is not. */
static BtaOdbcChar *odbc_in(const char *utf8)
{
#ifdef G_OS_WIN32
    return (BtaOdbcChar *)g_utf8_to_utf16(utf8, -1, NULL, NULL, NULL);
#else
    return (BtaOdbcChar *)g_strdup(utf8);
#endif
}

/* The manager's text, `units` long (-1: terminated), as UTF-8; g_free it.
 * Never NULL: a driver that hands back bytes that are not UTF-8 gets them
 * repaired with U+FFFD rather than a string QuickJS would take on trust. */
static char *odbc_out(const BtaOdbcChar *s, gssize units)
{
    /* An empty value read in parts is an empty array, whose data is NULL. */
    if (!s || units == 0)
        return g_strdup("");
#ifdef G_OS_WIN32
    char *u = g_utf16_to_utf8((const gunichar2 *)s, units, NULL, NULL, NULL);
    return u ? u : g_strdup("");
#else
    return g_utf8_make_valid((const char *)s, units);
#endif
}

/* ----------------------------------------------------------- the handle */

static JSClassID bta_odbc_class_id;

typedef struct {
    SQLHENV env;         /* one per connection: no shared state to lock */
    SQLHDBC dbc;         /* NULL once closed */
    char   *dbms;        /* SQL_DBMS_NAME, read once at connect */
    char   *dbms_ver;    /* SQL_DBMS_VER */
    char   *driver;      /* SQL_DRIVER_NAME */
    char   *escape;      /* SQL_SEARCH_PATTERN_ESCAPE, "" when the driver has none */
    char   *quote;       /* SQL_IDENTIFIER_QUOTE_CHAR */
    SQLULEN stmt_secs;   /* SQL_ATTR_QUERY_TIMEOUT on every statement; 0 none */
    int     depth;       /* nested Transaction: 0 none, >0 a savepoint */
    int     reading;     /* Each() calls in progress: a statement is open */
    bool    sqlserver;   /* SAVE TRANSACTION rather than SAVEPOINT */
} BtaOdbc;

static void odbc_release(BtaOdbc *c)
{
    if (c->dbc) {
        /* Rolled back first: sqliteodbc refuses `SQLDisconnect` with a
         * transaction open (`25000`, measured) and keeps the connection,
         * which the next line would then free under it. psqlODBC rolls back
         * on its own; the explicit one is harmless there. */
        if (c->depth > 0)
            SQLEndTran(SQL_HANDLE_DBC, c->dbc, SQL_ROLLBACK);
        c->depth = 0;
        SQLDisconnect(c->dbc);
        SQLFreeHandle(SQL_HANDLE_DBC, c->dbc);
        c->dbc = NULL;
    }
    if (c->env) {
        SQLFreeHandle(SQL_HANDLE_ENV, c->env);
        c->env = NULL;
    }
}

static void odbc_finalizer(JSRuntime *rt, JSValue val)
{
    BtaOdbc *c = JS_GetOpaque(val, bta_odbc_class_id);

    if (!c)
        return;
    /* Closed here as well as by Close(): a program that never says so is the
     * ordinary case, and a server holds a session for every connection left
     * open. */
    odbc_release(c);
    g_free(c->dbms);
    g_free(c->dbms_ver);
    g_free(c->escape);
    g_free(c->quote);
    g_free(c->driver);
    g_free(c);
}

/* `OdbcConnection`, so a traceback says which driver it was. */
static JSClassDef odbc_class = {
    "OdbcConnection",
    .finalizer = odbc_finalizer,
};

/* ---------------------------------------------------------- diagnostics */

/* One diagnostic record, or false when there is none at `i`. The message is
 * read whole: a first call says how long it is when the buffer was short. */
static bool odbc_diag(SQLSMALLINT type, SQLHANDLE h, SQLSMALLINT i,
                      char state[6], SQLINTEGER *native, char **message)
{
    BtaOdbcChar st[6];
    BtaOdbcChar small[512];
    SQLSMALLINT len = 0;
    SQLRETURN   r = ODBC_API(SQLGetDiagRec)(type, h, i, st, native, small,
                                            G_N_ELEMENTS(small), &len);
    if (!SQL_SUCCEEDED(r))
        return false;

    char *s = odbc_out(st, 5);
    g_strlcpy(state, s, 6);
    g_free(s);

    if (len >= (SQLSMALLINT)G_N_ELEMENTS(small)) {
        BtaOdbcChar *big = g_new0(BtaOdbcChar, (gsize)len + 1);
        SQLSMALLINT  again = 0;

        if (SQL_SUCCEEDED(ODBC_API(SQLGetDiagRec)(type, h, i, st, native, big,
                                                  len + 1, &again))) {
            *message = odbc_out(big, MIN(again, len));
            g_free(big);
            return true;
        }
        g_free(big);
        len = G_N_ELEMENTS(small) - 1;
    }
    *message = odbc_out(small, len);
    return true;
}

/*
 * The driver's complaint, thrown: `message` is `what` and the first record's
 * text, `Code` its SQLSTATE and `Native` the engine's own number; the records
 * after it are `Details`, each `{ Code, Native, Message }`. A code is as good
 * as the driver -- sqliteodbc answers `HY000` for everything, measured.
 *
 * Built here rather than through `bta_throw_text`, which carries a message
 * alone; long for the same reason it exists -- a driver's sentence can quote a
 * host, a path and a server's own explanation, and nothing here cuts it.
 */
static JSValue throw_odbc(JSContext *ctx, SQLSMALLINT type, SQLHANDLE h,
                          const char *what)
{
    JSValue err = JS_NewError(ctx);
    if (JS_IsException(err))
        return JS_EXCEPTION;

    char       state[6];
    SQLINTEGER native = 0;
    char      *said = NULL;
    char      *text;

    if (h && odbc_diag(type, h, 1, state, &native, &said)) {
        text = g_strdup_printf("%s: %s", what, said);
        JS_DefinePropertyValueStr(ctx, err, "Code", JS_NewString(ctx, state),
                                  JS_PROP_C_W_E);
        JS_DefinePropertyValueStr(ctx, err, "Native", JS_NewInt32(ctx, native),
                                  JS_PROP_C_W_E);
        g_free(said);

        JSValue  details = JS_NewArray(ctx);
        uint32_t n = 0;
        for (SQLSMALLINT i = 2; i < 32767; i++) {
            if (!odbc_diag(type, h, i, state, &native, &said))
                break;
            JSValue d = JS_NewObject(ctx);
            JS_SetPropertyStr(ctx, d, "Code",    JS_NewString(ctx, state));
            JS_SetPropertyStr(ctx, d, "Native",  JS_NewInt32(ctx, native));
            JS_SetPropertyStr(ctx, d, "Message", JS_NewString(ctx, said));
            JS_SetPropertyUint32(ctx, details, n++, d);
            g_free(said);
        }
        JS_DefinePropertyValueStr(ctx, err, "Details", details, JS_PROP_C_W_E);
    } else {
        text = g_strdup_printf("%s, and the driver said nothing more", what);
    }

    JS_DefinePropertyValueStr(ctx, err, "message", JS_NewString(ctx, text),
                              JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
    g_free(text);
    return JS_Throw(ctx, err);
}

/* -------------------------------------------------------------- reading */

/* A text answer of SQLGetInfo, or "" when the driver has none. Its length is
 * in bytes for every encoding -- unlike the rest of the API, which counts
 * characters. */
static char *info_text(SQLHDBC dbc, SQLUSMALLINT what)
{
    BtaOdbcChar buf[256];
    SQLSMALLINT bytes = 0;

    if (!SQL_SUCCEEDED(ODBC_API(SQLGetInfo)(dbc, what, buf, sizeof buf, &bytes)))
        return g_strdup("");
    gssize units = bytes / (SQLSMALLINT)sizeof(BtaOdbcChar);
    if (units < 0 || units >= (gssize)G_N_ELEMENTS(buf))
        units = G_N_ELEMENTS(buf) - 1;
    return odbc_out(buf, units);
}

/* ---------------------------------------------------- the connection string */

/*
 * Whether the connection string already names one of `keys` (case does not
 * matter). Not a parser of the drivers' language -- every key but these is
 * passed through unread -- only enough of the grammar to find a key where one
 * starts: pairs split by `;`, and a value in braces may hold `;` and `}}`.
 */
static bool cs_names(const char *cs, const char *const *keys)
{
    const char *p = cs;

    while (*p) {
        while (*p == ';' || *p == ' ' || *p == '\t')
            p++;
        const char *k = p;
        while (*p && *p != '=' && *p != ';')
            p++;
        const char *ke = p;
        while (ke > k && (ke[-1] == ' ' || ke[-1] == '\t'))
            ke--;
        for (const char *const *q = keys; *q; q++)
            if ((size_t)(ke - k) == strlen(*q)
                && g_ascii_strncasecmp(k, *q, ke - k) == 0)
                return true;
        if (*p != '=')
            continue;
        p++;
        while (*p == ' ' || *p == '\t')
            p++;
        if (*p == '{') {
            for (p++; *p; p++)
                if (*p == '}') {
                    if (p[1] == '}') { p++; continue; }
                    p++;
                    break;
                }
        }
        while (*p && *p != ';')
            p++;
    }
    return false;
}

/*
 * `;KEY=value`, and braced -- `{…}` with `}` doubled -- **only when the value
 * needs it**: a `;`, a brace, or a space at either end, which would otherwise
 * end the value or add a key of its own. Measured with psqlODBC 16: it takes
 * braces off `PWD` (and undoubles `}}`) but not off `UID`, `Server` or
 * `Database`, where `{postgres}` was the user name, literally. Bracing every
 * value would break the ordinary case to protect the rare one.
 */
static void cs_append(GString *cs, const char *key, const char *value)
{
    size_t n = strlen(value);
    bool   brace = n == 0 || strpbrk(value, ";{}") != NULL
                || g_ascii_isspace(value[0]) || g_ascii_isspace(value[n - 1]);

    if (cs->len && cs->str[cs->len - 1] != ';')
        g_string_append_c(cs, ';');
    g_string_append_printf(cs, "%s=", key);
    if (!brace) {
        g_string_append(cs, value);
        return;
    }
    g_string_append_c(cs, '{');
    for (const char *p = value; *p; p++) {
        if (*p == '}')
            g_string_append_c(cs, '}');
        g_string_append_c(cs, *p);
    }
    g_string_append_c(cs, '}');
}

/* A string option as UTF-8, refused when it is not a string or holds a NUL --
 * which would end the value early inside the connection string. */
static char *option_text(JSContext *ctx, JSValueConst v, const char *key)
{
    if (!JS_IsString(v)) {
        JS_ThrowTypeError(ctx, "Database.Odbc: %s is a string", key);
        return NULL;
    }
    size_t      len;
    const char *s = JS_ToCStringLen(ctx, &len, v);
    if (!s)
        return NULL;
    if (strlen(s) != len) {
        JS_FreeCString(ctx, s);
        JS_ThrowTypeError(ctx, "Database.Odbc: %s holds a NUL character", key);
        return NULL;
    }
    char *out = g_strdup(s);
    JS_FreeCString(ctx, s);
    return out;
}

typedef struct {
    char  *user;
    char  *password;
    double timeout;      /* milliseconds */
    double statement;    /* milliseconds; 0 is no limit */
} OdbcOptions;

/* One of the two times, in milliseconds, left as it was when absent. */
static bool read_millis(JSContext *ctx, JSValueConst opts, const char *key,
                        double *out)
{
    JSValue v = JS_GetPropertyStr(ctx, opts, key);
    if (JS_IsException(v))
        return false;
    if (JS_IsUndefined(v))
        return true;

    char who[64];
    g_snprintf(who, sizeof who, "Database.Odbc: %s", key);
    bool ok = bta_to_number(ctx, v, who, out);
    JS_FreeValue(ctx, v);
    if (!ok)
        return false;
    if (!(*out > 0) || isinf(*out)) {
        JS_ThrowRangeError(ctx, "Database.Odbc: %s is a number of milliseconds "
                                "above zero", key);
        return false;
    }
    return true;
}

/* The options every driver shares, and nothing else: a key that is not one is
 * refused, since `{ Pasword: … }` quietly meaning no password is a misspelling
 * that costs nothing to catch. */
static bool read_options(JSContext *ctx, JSValueConst opts, OdbcOptions *o)
{
    static const char *const known[] = { "User", "Password", "Timeout",
                                         "StatementTimeout", NULL };

    o->user = o->password = NULL;
    o->timeout = 10000;
    o->statement = 0;

    if (JS_IsUndefined(opts) || JS_IsNull(opts))
        return true;
    if (!JS_IsObject(opts)) {
        JS_ThrowTypeError(ctx, "Database.Odbc: the options are an object -- "
                               "{ User, Password, Timeout, StatementTimeout }");
        return false;
    }

    JSPropertyEnum *tab;
    uint32_t        len;
    if (JS_GetOwnPropertyNames(ctx, &tab, &len, opts,
                               JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) < 0)
        return false;
    for (uint32_t i = 0; i < len; i++) {
        const char *name = JS_AtomToCString(ctx, tab[i].atom);
        bool        ok = false;
        for (const char *const *k = known; name && *k; k++)
            ok = ok || strcmp(name, *k) == 0;
        if (!ok) {
            JS_ThrowTypeError(ctx, "Database.Odbc: '%s' is not an option -- "
                                   "they are User, Password, Timeout and "
                                   "StatementTimeout; "
                                   "anything else is the driver's, and goes "
                                   "in the connection string",
                              name ? name : "?");
            JS_FreeCString(ctx, name);
            JS_FreePropertyEnum(ctx, tab, len);
            return false;
        }
        JS_FreeCString(ctx, name);
    }
    JS_FreePropertyEnum(ctx, tab, len);

    JSValue v = JS_GetPropertyStr(ctx, opts, "User");
    if (JS_IsException(v))
        return false;
    if (!JS_IsUndefined(v) && !(o->user = option_text(ctx, v, "User"))) {
        JS_FreeValue(ctx, v);
        return false;
    }
    JS_FreeValue(ctx, v);

    v = JS_GetPropertyStr(ctx, opts, "Password");
    if (JS_IsException(v))
        return false;
    if (!JS_IsUndefined(v) && !(o->password = option_text(ctx, v, "Password"))) {
        JS_FreeValue(ctx, v);
        return false;
    }
    JS_FreeValue(ctx, v);

    return read_millis(ctx, opts, "Timeout", &o->timeout)
        && read_millis(ctx, opts, "StatementTimeout", &o->statement);
}

/* Milliseconds as whole seconds, which is what both attributes take; rounded
 * up, so 500 ms is one second and not "no limit", which is what 0 means. */
static SQLULEN odbc_seconds(double ms)
{
    double secs = ceil(ms / 1000.0);
    return (SQLULEN)(secs > 86400 ? 86400 : secs);
}

/* ------------------------------------------------------------ the words */

static BtaOdbc *odbc_of(JSContext *ctx, JSValueConst this_val)
{
    return JS_GetOpaque2(ctx, this_val, bta_odbc_class_id);
}

static JSValue odbc_close(JSContext *ctx, JSValueConst this_val,
                          int argc, JSValueConst *argv)
{
    BtaOdbc *c = odbc_of(ctx, this_val);
    if (!c)
        return JS_EXCEPTION;
    /* Not while `Each` is reading: its statement handle belongs to the
     * connection, and freeing the connection would free it under the loop. */
    if (c->dbc && c->reading)
        return JS_ThrowTypeError(ctx, "this connection is reading rows in "
                                      "Each() -- close it after Each returns");
    /* Twice is not an error: it is what a handler that may run after another
     * one already closed it does. */
    odbc_release(c);
    return JS_UNDEFINED;
}

static JSValue odbc_get_open(JSContext *ctx, JSValueConst this_val)
{
    BtaOdbc *c = odbc_of(ctx, this_val);
    if (!c)
        return JS_EXCEPTION;
    return JS_NewBool(ctx, c->dbc != NULL);
}

/* Read once at connect, so they still answer after `Close` -- which is when a
 * message about the connection is usually written. */
static JSValue odbc_get_dbms(JSContext *ctx, JSValueConst this_val)
{
    BtaOdbc *c = odbc_of(ctx, this_val);
    return c ? JS_NewString(ctx, c->dbms) : JS_EXCEPTION;
}

static JSValue odbc_get_dbms_version(JSContext *ctx, JSValueConst this_val)
{
    BtaOdbc *c = odbc_of(ctx, this_val);
    return c ? JS_NewString(ctx, c->dbms_ver) : JS_EXCEPTION;
}

static JSValue odbc_get_driver(JSContext *ctx, JSValueConst this_val)
{
    BtaOdbc *c = odbc_of(ctx, this_val);
    return c ? JS_NewString(ctx, c->driver) : JS_EXCEPTION;
}

/* ------------------------------------------------------------ statements */

/*
 * **The driver is talked to in the C numeric locale.** GTK calls
 * `setlocale(LC_ALL, "")`, and psqlODBC formats a `NUMERIC` it hands back as
 * text with the process's `LC_NUMERIC`: on an es_AR desktop `12.30` arrived as
 * `12,30`, which no `Decimal` reads (measured; the bare C probe never saw it,
 * having never called `setlocale`). So the driver works with C numerics for
 * **this thread alone**, and only for as long as it is working -- the rest of
 * the program, and the program's own code inside `Each`, keep the desktop's.
 *
 *   - POSIX: `uselocale` with a locale that is the desktop's but for
 *     `LC_NUMERIC`.
 *   - Windows: `_configthreadlocale(_ENABLE_PER_THREAD_LOCALE)` and
 *     `setlocale(LC_NUMERIC, "C")` for the thread, put back after. The UCRT is
 *     one `ucrtbase.dll` for the program and an MSVC-built driver alike, so
 *     the desktop locale GTK set does reach a driver there too. **Written, not
 *     yet run on Windows** (docs/plans/odbc-plan.md, stage 6).
 *
 * `numeric_now` is the thread's innermost entry, so `Each` can step out to
 * the desktop's locale around its callback and back in after it.
 */
typedef struct OdbcNumeric {
    struct OdbcNumeric *outer;
#ifndef G_OS_WIN32
    locale_t was;
    bool     set;
#else
    int      mode;
    char    *saved;
#endif
} OdbcNumeric;

static _Thread_local OdbcNumeric *numeric_now;

#ifndef G_OS_WIN32
static locale_t odbc_c_numeric(void)
{
    static gsize once = 0;
    static locale_t loc;

    if (g_once_init_enter(&once)) {
        locale_t base = duplocale(LC_GLOBAL_LOCALE);
        loc = base ? newlocale(LC_NUMERIC_MASK, "C", base) : (locale_t)0;
        if (!loc && base)
            freelocale(base);
        g_once_init_leave(&once, 1);
    }
    return loc;
}
#endif

static void numeric_c(OdbcNumeric *s)
{
#ifndef G_OS_WIN32
    locale_t c = odbc_c_numeric();
    s->set = c != (locale_t)0;
    s->was = s->set ? uselocale(c) : (locale_t)0;
#else
    s->mode  = _configthreadlocale(_ENABLE_PER_THREAD_LOCALE);
    s->saved = g_strdup(setlocale(LC_NUMERIC, NULL));
    setlocale(LC_NUMERIC, "C");
#endif
}

static void numeric_back(OdbcNumeric *s)
{
#ifndef G_OS_WIN32
    if (s->set)
        uselocale(s->was);
#else
    if (s->saved)
        setlocale(LC_NUMERIC, s->saved);
    g_free(s->saved);
    s->saved = NULL;
    if (s->mode != -1)
        _configthreadlocale(s->mode);
#endif
}

static void numeric_enter(OdbcNumeric *s)
{
    s->outer = numeric_now;
    numeric_c(s);
    numeric_now = s;
}

static void numeric_leave(OdbcNumeric *s)
{
    numeric_back(s);
    numeric_now = s->outer;
}

/* The program's own code, called from inside the driver's work: in the
 * desktop's locale, and back to C numerics after it. */
static JSValue call_in_desktop_locale(JSContext *ctx, JSValueConst fn,
                                      JSValueConst arg)
{
    OdbcNumeric *s = numeric_now;
    if (s)
        numeric_leave(s);
    JSValue r = JS_Call(ctx, fn, JS_UNDEFINED, 1, &arg);
    if (s)
        numeric_enter(s);
    return r;
}


/* The handle, open, or a throw: "used after Close" is one sentence here
 * rather than whatever the driver manager says about a freed handle. */
static BtaOdbc *open_of(JSContext *ctx, JSValueConst this_val)
{
    BtaOdbc *c = odbc_of(ctx, this_val);

    if (c && !c->dbc) {
        JS_ThrowTypeError(ctx, "this connection is closed");
        return NULL;
    }
    return c;
}

/*
 * One bound value, converted **before** anything is bound, so a refusal
 * leaves no statement half-prepared. The buffer lives until the statement is
 * freed: ODBC reads it at `SQLExecute`, not at `SQLBindParameter`.
 */
typedef struct {
    SQLSMALLINT   c_type;
    SQLSMALLINT   sql_type;
    SQLULEN       size;
    SQLSMALLINT   digits;
    SQLPOINTER    buf;      /* points at one of the three below, or owns text */
    SQLLEN        len;
    SQLLEN        ind;
    int64_t       i;
    double        d;
    unsigned char bit;
    bool          owned;
} OdbcParam;

static void params_free(OdbcParam *p, uint32_t n)
{
    for (uint32_t k = 0; p && k < n; k++)
        if (p[k].owned)
            g_free(p[k].buf);
    g_free(p);
}

/* Text, in the manager's encoding, as a parameter. Past 4000 characters it is
 * a LONG type: SQL Server refuses a `VARCHAR` declared any longer. */
static bool param_text(JSContext *ctx, OdbcParam *p, JSValueConst v,
                       SQLSMALLINT as)
{
    size_t      len;
    const char *s = JS_ToCStringLen(ctx, &len, v);
    if (!s)
        return false;
#ifdef G_OS_WIN32
    glong     units = 0;
    gunichar2 *w = g_utf8_to_utf16(s, (glong)len, NULL, &units, NULL);
    JS_FreeCString(ctx, s);
    if (!w) {
        JS_ThrowTypeError(ctx, "a parameter is not text the driver can take");
        return false;
    }
    p->c_type   = SQL_C_WCHAR;
    p->sql_type = as ? as : units > 4000 ? SQL_WLONGVARCHAR : SQL_WVARCHAR;
    p->size     = units > 0 ? (SQLULEN)units : 1;
    p->buf      = w;
    p->len      = (SQLLEN)units * (SQLLEN)sizeof(gunichar2);
#else
    p->c_type   = SQL_C_CHAR;
    p->sql_type = as ? as : len > 4000 ? SQL_LONGVARCHAR : SQL_VARCHAR;
    p->size     = len > 0 ? (SQLULEN)len : 1;
    p->buf      = g_memdup2(s, len + 1);
    p->len      = (SQLLEN)len;
    JS_FreeCString(ctx, s);
#endif
    p->owned = true;
    p->ind   = p->len;
    return true;
}

/*
 * One value. The mapping is sqlite's, spelled in ODBC's types: nothing and
 * `undefined` are NULL (as an untyped `VARCHAR`, which psqlODBC sends as
 * unknown and every engine measured coerces), a boolean is `SQL_BIT`, a whole
 * number under 2^53 is `SQL_BIGINT` and anything else a `SQL_DOUBLE`, a
 * `Decimal` is its own text over `SQL_NUMERIC` -- never through a double --, a
 * `Bytes` is binary, and a string is text.
 */
static bool param_one(JSContext *ctx, OdbcParam *p, int at, JSValueConst v)
{
    if (JS_IsUndefined(v) || JS_IsNull(v)) {
        p->c_type = SQL_C_CHAR;  p->sql_type = SQL_VARCHAR;  p->size = 1;
        p->buf = &p->bit;        p->len = 0;  p->ind = SQL_NULL_DATA;
        return true;
    }
    if (JS_IsBool(v)) {
        p->bit = JS_ToBool(ctx, v) ? 1 : 0;
        p->c_type = SQL_C_BIT;   p->sql_type = SQL_BIT;  p->size = 1;
        p->buf = &p->bit;        p->len = 1;  p->ind = 1;
        return true;
    }

    size_t         blob_len = 0;
    const uint8_t *blob     = bta_bytes_get(v, &blob_len);
    if (blob) {
        if (blob_len > (size_t)INT32_MAX) {
            JS_ThrowRangeError(ctx, "parameter %d is too large to bind", at);
            return false;
        }
        p->c_type   = SQL_C_BINARY;
        p->sql_type = blob_len > 8000 ? SQL_LONGVARBINARY : SQL_VARBINARY;
        p->size     = blob_len > 0 ? blob_len : 1;
        p->buf      = g_memdup2(blob_len ? blob : (const uint8_t *)"", blob_len ? blob_len : 1);
        p->owned    = true;
        p->len      = p->ind = (SQLLEN)blob_len;
        return true;
    }

    int64_t units;
    int     scale;
    int     is_decimal = bta_decimal_parts(ctx, v, -1, &units, &scale);
    if (is_decimal < 0)
        return false;
    if (is_decimal > 0) {
        if (!param_text(ctx, p, v, SQL_NUMERIC))
            return false;
        /* The precision is the digits the text holds, the scale its own. */
        SQLULEN digits = 0;
#ifdef G_OS_WIN32
        for (const gunichar2 *q = p->buf; *q; q++)
#else
        for (const char *q = p->buf; *q; q++)
#endif
            if (*q >= '0' && *q <= '9')
                digits++;
        p->size   = digits > 0 ? digits : 1;
        p->digits = (SQLSMALLINT)scale;
        return true;
    }

    if (JS_IsString(v))
        return param_text(ctx, p, v, 0);

    if (JS_IsNumber(v)) {
        double d;
        if (JS_ToFloat64(ctx, &d, v))
            return false;
        if (isfinite(d) && d == trunc(d) && fabs(d) < 9007199254740992.0) {
            p->i = (int64_t)d;
            p->c_type = SQL_C_SBIGINT;  p->sql_type = SQL_BIGINT;  p->size = 19;
            p->buf = &p->i;
        } else {
            p->d = d;
            p->c_type = SQL_C_DOUBLE;   p->sql_type = SQL_DOUBLE;  p->size = 15;
            p->buf = &p->d;
        }
        p->len = p->ind = 0;
        return true;
    }

    JS_ThrowTypeError(ctx, "parameter %d is %s, and a column holds text, a "
                           "number, a boolean, a Decimal, a Bytes or nothing",
                      at, JS_IsArray(v) ? "a list" : "an object");
    return false;
}

/* The list, all converted, or NULL with a throw. Absent is none. */
static bool params_read(JSContext *ctx, JSValueConst params,
                        OdbcParam **out, uint32_t *count)
{
    *out   = NULL;
    *count = 0;
    if (JS_IsUndefined(params) || JS_IsNull(params))
        return true;
    if (!JS_IsArray(params)) {
        JS_ThrowTypeError(ctx, "the parameters are a list, one per `?` in the "
                               "statement");
        return false;
    }

    JSValue  lenv = JS_GetPropertyStr(ctx, params, "length");
    uint32_t n    = 0;
    JS_ToUint32(ctx, &n, lenv);
    JS_FreeValue(ctx, lenv);

    OdbcParam *p = g_new0(OdbcParam, n ? n : 1);
    for (uint32_t k = 0; k < n; k++) {
        JSValue v  = JS_GetPropertyUint32(ctx, params, k);
        bool    ok = !JS_IsException(v) && param_one(ctx, &p[k], (int)k + 1, v);
        JS_FreeValue(ctx, v);
        if (!ok) {
            params_free(p, n);
            return false;
        }
    }
    *out   = p;
    *count = n;
    return true;
}

/* A statement handle with the connection's statement timeout on it. */
static SQLHSTMT stmt_new(JSContext *ctx, BtaOdbc *c)
{
    SQLHSTMT st = SQL_NULL_HSTMT;

    if (!SQL_SUCCEEDED(SQLAllocHandle(SQL_HANDLE_STMT, c->dbc, &st))) {
        throw_odbc(ctx, SQL_HANDLE_DBC, c->dbc, "no statement handle");
        return SQL_NULL_HSTMT;
    }
    if (c->stmt_secs)
        SQLSetStmtAttr(st, SQL_ATTR_QUERY_TIMEOUT,
                       (SQLPOINTER)(uintptr_t)c->stmt_secs, 0);
    return st;
}

/* `SQL_NO_DATA` from an execute is not a failure: it is an `UPDATE` or a
 * `DELETE` that matched no row, measured on both drivers. */
static bool ran(SQLRETURN r)
{
    return SQL_SUCCEEDED(r) || r == SQL_NO_DATA;
}

/*
 * Prepared, counted, bound and executed. The count is the driver's
 * (`SQLNumParams`): three values for four `?` would run and answer about a
 * NULL, a wrong answer rather than an error. A driver that cannot count is
 * taken at its word.
 */
static bool stmt_run(JSContext *ctx, SQLHSTMT st, JSValueConst sqlv,
                     OdbcParam *p, uint32_t n)
{
    const char *sql = JS_ToCString(ctx, sqlv);
    if (!sql)
        return false;
    BtaOdbcChar *in = odbc_in(sql);
    JS_FreeCString(ctx, sql);

    SQLRETURN r = ODBC_API(SQLPrepare)(st, in, SQL_NTS);
    g_free(in);
    if (!SQL_SUCCEEDED(r)) {
        throw_odbc(ctx, SQL_HANDLE_STMT, st, "cannot run");
        return false;
    }

    SQLSMALLINT wants = 0;
    if (SQL_SUCCEEDED(SQLNumParams(st, &wants)) && wants != (SQLSMALLINT)n) {
        JS_ThrowRangeError(ctx, "the statement takes %d parameter%s and was "
                                "given %u", wants, wants == 1 ? "" : "s", n);
        return false;
    }
    for (uint32_t k = 0; k < n; k++) {
        r = SQLBindParameter(st, (SQLUSMALLINT)(k + 1), SQL_PARAM_INPUT,
                             p[k].c_type, p[k].sql_type, p[k].size,
                             p[k].digits, p[k].buf, p[k].len, &p[k].ind);
        if (!SQL_SUCCEEDED(r)) {
            char what[48];
            g_snprintf(what, sizeof what, "cannot bind parameter %u", k + 1);
            throw_odbc(ctx, SQL_HANDLE_STMT, st, what);
            return false;
        }
    }

    r = SQLExecute(st);
    if (!ran(r)) {
        throw_odbc(ctx, SQL_HANDLE_STMT, st, "cannot run");
        return false;
    }
    return true;
}

/* The results after the one that was read, run to the end: an error in a
 * later statement of the batch is still an error. */
static bool stmt_drain(JSContext *ctx, SQLHSTMT st)
{
    for (;;) {
        SQLRETURN r = SQLMoreResults(st);
        if (r == SQL_NO_DATA)
            return true;
        if (!SQL_SUCCEEDED(r)) {
            throw_odbc(ctx, SQL_HANDLE_STMT, st, "cannot run");
            return false;
        }
    }
}

/* ------------------------------------------------------------------- rows */

typedef struct {
    char       *name;
    SQLSMALLINT type;
} OdbcColumn;

static void columns_free(OdbcColumn *cols, SQLSMALLINT n)
{
    for (SQLSMALLINT k = 0; cols && k < n; k++)
        g_free(cols[k].name);
    g_free(cols);
}

static bool is_text_type(SQLSMALLINT t)
{
    return t == SQL_CHAR || t == SQL_VARCHAR || t == SQL_LONGVARCHAR
        || t == SQL_WCHAR || t == SQL_WVARCHAR || t == SQL_WLONGVARCHAR;
}

/*
 * Whether the engine's own name for a column's type is a boolean. psqlODBC
 * describes `boolean` as `SQL_VARCHAR` holding `"1"`/`"0"` unless the
 * connection string says `BoolsAsChar=0` (measured), and `Record` takes a
 * boolean as `true`/`false` or `0`/`1` -- so every boolean field would refuse
 * what the default driver hands it. The type name is the engine's and says
 * `bool` either way; such a column is read as `SQL_BIT`.
 */
static bool names_a_boolean(SQLHSTMT st, SQLUSMALLINT col)
{
    BtaOdbcChar buf[64];
    SQLSMALLINT bytes = 0;

    if (!SQL_SUCCEEDED(ODBC_API(SQLColAttribute)(st, col, SQL_DESC_TYPE_NAME,
                                                 buf, sizeof buf, &bytes, NULL)))
        return false;
    gssize units = bytes / (SQLSMALLINT)sizeof(BtaOdbcChar);
    if (units < 0 || units >= (gssize)G_N_ELEMENTS(buf))
        units = G_N_ELEMENTS(buf) - 1;
    char *name = odbc_out(buf, units);
    bool  yes  = g_ascii_strcasecmp(name, "bool") == 0
              || g_ascii_strcasecmp(name, "boolean") == 0;
    g_free(name);
    return yes;
}

static OdbcColumn *columns_read(JSContext *ctx, SQLHSTMT st, SQLSMALLINT n)
{
    OdbcColumn *cols = g_new0(OdbcColumn, n);

    for (SQLSMALLINT k = 0; k < n; k++) {
        BtaOdbcChar name[256];
        SQLSMALLINT len = 0, type = 0, digits = 0, nullable = 0;
        SQLULEN     size = 0;
        SQLRETURN   r = ODBC_API(SQLDescribeCol)(st, (SQLUSMALLINT)(k + 1), name,
                                                 G_N_ELEMENTS(name), &len, &type,
                                                 &size, &digits, &nullable);
        if (!SQL_SUCCEEDED(r)) {
            throw_odbc(ctx, SQL_HANDLE_STMT, st, "cannot read");
            columns_free(cols, n);
            return NULL;
        }
        if (len >= (SQLSMALLINT)G_N_ELEMENTS(name)) {
            BtaOdbcChar *big = g_new0(BtaOdbcChar, (gsize)len + 1);
            SQLSMALLINT  again = 0;
            ODBC_API(SQLDescribeCol)(st, (SQLUSMALLINT)(k + 1), big, len + 1,
                                     &again, &type, &size, &digits, &nullable);
            cols[k].name = odbc_out(big, MIN(again, len));
            g_free(big);
        } else {
            cols[k].name = odbc_out(name, len);
        }
        cols[k].type = is_text_type(type) && names_a_boolean(st, k + 1)
                     ? SQL_BIT : type;
    }
    return cols;
}

/*
 * A long value, in parts: `SQLGetData` answers `01004` while there is more,
 * and the part it wrote is the whole buffer -- less the terminator, for text.
 * `*null` says it was NULL; NULL with no `*null` is a throw.
 */
static GByteArray *get_long(JSContext *ctx, SQLHSTMT st, SQLUSMALLINT col,
                            SQLSMALLINT c_type, size_t unit, bool *null)
{
    GByteArray *all = g_byte_array_new();
    guint8      part[8192];
    size_t      room = c_type == SQL_C_BINARY ? sizeof part : sizeof part - unit;

    *null = false;
    for (;;) {
        SQLLEN    ind = 0;
        SQLRETURN r = SQLGetData(st, col, c_type, part, sizeof part, &ind);

        if (r == SQL_NO_DATA)
            break;
        if (!SQL_SUCCEEDED(r)) {
            throw_odbc(ctx, SQL_HANDLE_STMT, st, "cannot read");
            g_byte_array_unref(all);
            return NULL;
        }
        if (ind == SQL_NULL_DATA) {
            *null = true;
            g_byte_array_unref(all);
            return NULL;
        }
        size_t got = (r == SQL_SUCCESS_WITH_INFO
                      && (ind == SQL_NO_TOTAL || (size_t)ind > room))
                     ? room : (size_t)ind;
        g_byte_array_append(all, part, (guint)got);
        if (r == SQL_SUCCESS)
            break;
    }
    return all;
}

static JSValue column_text(JSContext *ctx, SQLHSTMT st, SQLUSMALLINT col)
{
    bool        null;
    GByteArray *all = get_long(ctx, st, col,
#ifdef G_OS_WIN32
                               SQL_C_WCHAR, sizeof(SQLWCHAR),
#else
                               SQL_C_CHAR, 1,
#endif
                               &null);
    if (!all)
        return null ? JS_NULL : JS_EXCEPTION;

    char *u = odbc_out((const BtaOdbcChar *)all->data,
                       (gssize)(all->len / sizeof(BtaOdbcChar)));
    g_byte_array_unref(all);
    JSValue v = JS_NewString(ctx, u);
    g_free(u);
    return v;
}

/* A fixed-size value: the call answers it whole, or NULL. */
static int get_fixed(JSContext *ctx, SQLHSTMT st, SQLUSMALLINT col,
                     SQLSMALLINT c_type, void *out, SQLLEN size)
{
    SQLLEN    ind = 0;
    SQLRETURN r = SQLGetData(st, col, c_type, out, size, &ind);

    if (!SQL_SUCCEEDED(r)) {
        throw_odbc(ctx, SQL_HANDLE_STMT, st, "cannot read");
        return -1;
    }
    return ind == SQL_NULL_DATA ? 0 : 1;
}

/* `HH:MM:SS` with a fraction only when there is one: a `datetime` field
 * refuses it, so it must be visible rather than rounded away. */
static void append_fraction(GString *s, SQLUINTEGER ns)
{
    if (!ns)
        return;
    char frac[16];
    g_snprintf(frac, sizeof frac, ".%09u", (unsigned)ns);
    size_t end = strlen(frac);
    while (end > 2 && frac[end - 1] == '0')
        frac[--end] = '\0';
    g_string_append(s, frac);
}

/*
 * One column's value, by the ODBC type the driver described -- the same for
 * every driver, which is what makes this table portable:
 *
 *   bit -> boolean; the integers -> number (Int64, as sqlite's); the floating
 *   types -> number; NUMERIC/DECIMAL -> the driver's text, exactly; date,
 *   time, timestamp -> `YYYY-MM-DD`, `HH:MM:SS`, `YYYY-MM-DDTHH:MM:SS[.f]`;
 *   the binary types -> Bytes; anything else -> text.
 */
static JSValue column_value(JSContext *ctx, SQLHSTMT st, SQLUSMALLINT col,
                            SQLSMALLINT type)
{
    int got;

    switch (type) {
    case SQL_BIT: {
        unsigned char b = 0;
        got = get_fixed(ctx, st, col, SQL_C_BIT, &b, sizeof b);
        return got < 0 ? JS_EXCEPTION : got ? JS_NewBool(ctx, b != 0) : JS_NULL;
    }
    case SQL_TINYINT: case SQL_SMALLINT: case SQL_INTEGER: case SQL_BIGINT: {
        int64_t i = 0;
        got = get_fixed(ctx, st, col, SQL_C_SBIGINT, &i, sizeof i);
        return got < 0 ? JS_EXCEPTION : got ? JS_NewInt64(ctx, i) : JS_NULL;
    }
    case SQL_REAL: case SQL_FLOAT: case SQL_DOUBLE: {
        double d = 0;
        got = get_fixed(ctx, st, col, SQL_C_DOUBLE, &d, sizeof d);
        return got < 0 ? JS_EXCEPTION : got ? JS_NewFloat64(ctx, d) : JS_NULL;
    }
    case SQL_TYPE_DATE: case SQL_DATE: {
        SQL_DATE_STRUCT t;
        got = get_fixed(ctx, st, col, SQL_C_TYPE_DATE, &t, sizeof t);
        if (got <= 0)
            return got < 0 ? JS_EXCEPTION : JS_NULL;
        char s[16];
        g_snprintf(s, sizeof s, "%04d-%02u-%02u", t.year, t.month, t.day);
        return JS_NewString(ctx, s);
    }
    case SQL_TYPE_TIME: case SQL_TIME: {
        SQL_TIME_STRUCT t;
        got = get_fixed(ctx, st, col, SQL_C_TYPE_TIME, &t, sizeof t);
        if (got <= 0)
            return got < 0 ? JS_EXCEPTION : JS_NULL;
        char s[16];
        g_snprintf(s, sizeof s, "%02u:%02u:%02u", t.hour, t.minute, t.second);
        return JS_NewString(ctx, s);
    }
    case SQL_TYPE_TIMESTAMP: case SQL_TIMESTAMP: {
        SQL_TIMESTAMP_STRUCT t;
        got = get_fixed(ctx, st, col, SQL_C_TYPE_TIMESTAMP, &t, sizeof t);
        if (got <= 0)
            return got < 0 ? JS_EXCEPTION : JS_NULL;
        GString *s = g_string_new(NULL);
        g_string_printf(s, "%04d-%02u-%02uT%02u:%02u:%02u", t.year, t.month,
                        t.day, t.hour, t.minute, t.second);
        append_fraction(s, t.fraction);
        JSValue v = JS_NewString(ctx, s->str);
        g_string_free(s, TRUE);
        return v;
    }
    case SQL_BINARY: case SQL_VARBINARY: case SQL_LONGVARBINARY: {
        bool        null;
        GByteArray *all = get_long(ctx, st, col, SQL_C_BINARY, 1, &null);
        if (!all)
            return null ? JS_NULL : JS_EXCEPTION;
        JSValue v = bta_bytes_new(ctx, all->data, all->len);
        g_byte_array_unref(all);
        return v;
    }
    default:
        return column_text(ctx, st, col);
    }
}

/* One row, as a plain object keyed by the column names -- as sqlite's: which
 * record a row fills is `rad.js`'s question. */
static JSValue row_object(JSContext *ctx, SQLHSTMT st, OdbcColumn *cols,
                          SQLSMALLINT n)
{
    JSValue row = JS_NewObject(ctx);

    for (SQLSMALLINT k = 0; k < n; k++) {
        JSValue v = column_value(ctx, st, (SQLUSMALLINT)(k + 1), cols[k].type);
        if (JS_IsException(v)) {
            JS_FreeValue(ctx, row);
            return JS_EXCEPTION;
        }
        JS_SetPropertyStr(ctx, row, cols[k].name, v);
    }
    return row;
}

/* ------------------------------------------------- Query, Execute, Script */

/*
 * Moved to the first result that has columns: a batch, or a driver that
 * reports a count before the rows (SQL Server without `SET NOCOUNT ON`), puts
 * results with none ahead of it. 1 found, 0 none at all, -1 a throw.
 */
static int first_rows(JSContext *ctx, SQLHSTMT st, SQLSMALLINT *ncol)
{
    for (;;) {
        if (!SQL_SUCCEEDED(SQLNumResultCols(st, ncol))) {
            throw_odbc(ctx, SQL_HANDLE_STMT, st, "cannot read");
            return -1;
        }
        if (*ncol > 0)
            return 1;
        SQLRETURN r = SQLMoreResults(st);
        if (r == SQL_NO_DATA)
            return 0;
        if (!SQL_SUCCEEDED(r)) {
            throw_odbc(ctx, SQL_HANDLE_STMT, st, "cannot run");
            return -1;
        }
    }
}

static JSValue query_body(JSContext *ctx, JSValueConst this_val,
                          int argc, JSValueConst *argv)
{
    BtaOdbc *c = open_of(ctx, this_val);
    if (!c)
        return JS_EXCEPTION;
    if (argc < 1 || !JS_IsString(argv[0]))
        return JS_ThrowTypeError(ctx, "this takes a statement");

    OdbcParam *p;
    uint32_t   n;
    if (!params_read(ctx, argc > 1 ? argv[1] : JS_UNDEFINED, &p, &n))
        return JS_EXCEPTION;

    SQLHSTMT    st   = stmt_new(ctx, c);
    JSValue     out  = JS_EXCEPTION;
    OdbcColumn *cols = NULL;
    SQLSMALLINT ncol = 0;

    if (!st || !stmt_run(ctx, st, argv[0], p, n))
        goto done;

    int found = first_rows(ctx, st, &ncol);
    if (found <= 0) {
        if (found == 0)
            out = JS_NewArray(ctx);
        goto done;
    }

    if (!(cols = columns_read(ctx, st, ncol)))
        goto done;

    JSValue  rows = JS_NewArray(ctx);
    uint32_t at   = 0;
    for (;;) {
        SQLRETURN r = SQLFetch(st);
        if (r == SQL_NO_DATA)
            break;
        if (!SQL_SUCCEEDED(r)) {
            throw_odbc(ctx, SQL_HANDLE_STMT, st, "cannot read");
            JS_FreeValue(ctx, rows);
            goto done;
        }
        JSValue row = row_object(ctx, st, cols, ncol);
        if (JS_IsException(row)) {
            JS_FreeValue(ctx, rows);
            goto done;
        }
        JS_SetPropertyUint32(ctx, rows, at++, row);
    }
    if (!stmt_drain(ctx, st)) {
        JS_FreeValue(ctx, rows);
        goto done;
    }
    out = rows;

done:
    columns_free(cols, ncol);
    if (st)
        SQLFreeHandle(SQL_HANDLE_STMT, st);
    params_free(p, n);
    return out;
}

static JSValue execute_body(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
    BtaOdbc *c = open_of(ctx, this_val);
    if (!c)
        return JS_EXCEPTION;
    if (argc < 1 || !JS_IsString(argv[0]))
        return JS_ThrowTypeError(ctx, "this takes a statement");

    OdbcParam *p;
    uint32_t   n;
    if (!params_read(ctx, argc > 1 ? argv[1] : JS_UNDEFINED, &p, &n))
        return JS_EXCEPTION;

    SQLHSTMT st  = stmt_new(ctx, c);
    JSValue  out = JS_EXCEPTION;

    if (!st || !stmt_run(ctx, st, argv[0], p, n))
        goto done;

    /* The count of the statement itself, before the batch moves on; `-1`
     * when the driver cannot say. Rows an `INSERT … RETURNING` answered are
     * run past -- `Query` is the word that reads them. */
    SQLLEN changes = -1;
    if (!SQL_SUCCEEDED(SQLRowCount(st, &changes)))
        changes = -1;
    if (!stmt_drain(ctx, st))
        goto done;

    out = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, out, "Changes", JS_NewInt64(ctx, changes));

done:
    if (st)
        SQLFreeHandle(SQL_HANDLE_STMT, st);
    params_free(p, n);
    return out;
}

/* Several statements and no parameters, in the driver's own way: psqlODBC
 * runs a batch as one implicit transaction (a failing statement undoes the
 * ones before it, measured), and sqliteodbc refuses a second statement. */
static JSValue script_body(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv)
{
    BtaOdbc *c = open_of(ctx, this_val);
    if (!c)
        return JS_EXCEPTION;
    if (argc < 1 || !JS_IsString(argv[0]))
        return JS_ThrowTypeError(ctx, "this takes a statement");

    const char *sql = JS_ToCString(ctx, argv[0]);
    if (!sql)
        return JS_EXCEPTION;
    BtaOdbcChar *in = odbc_in(sql);
    JS_FreeCString(ctx, sql);

    SQLHSTMT st  = stmt_new(ctx, c);
    JSValue  out = JS_EXCEPTION;

    if (st) {
        SQLRETURN r = ODBC_API(SQLExecDirect)(st, in, SQL_NTS);
        if (!ran(r))
            throw_odbc(ctx, SQL_HANDLE_STMT, st, "cannot run the script");
        else if (stmt_drain(ctx, st))
            out = JS_UNDEFINED;
        SQLFreeHandle(SQL_HANDLE_STMT, st);
    }
    g_free(in);
    return out;
}

/* -------------------------------------------------------- the catalogue */

/* A text column of a result as a C string (g_free it), NULL for NULL; `*err`
 * says a throw is pending. */
static char *text_c(JSContext *ctx, SQLHSTMT st, SQLUSMALLINT col, bool *err)
{
    bool        null;
    GByteArray *all = get_long(ctx, st, col,
#ifdef G_OS_WIN32
                               SQL_C_WCHAR, sizeof(SQLWCHAR),
#else
                               SQL_C_CHAR, 1,
#endif
                               &null);
    *err = !all && !null;
    if (!all)
        return NULL;
    char *u = odbc_out((const BtaOdbcChar *)all->data,
                       (gssize)(all->len / sizeof(BtaOdbcChar)));
    g_byte_array_unref(all);
    return u;
}

/*
 * A table name as the catalogue functions' *pattern*: `_` and `%` are
 * wildcards there, and `a_b` matched `axb` on both drivers measured. Escaped
 * with the driver's own character; the rows are also held to the exact name,
 * for a driver that has none.
 */
static BtaOdbcChar *catalog_pattern(BtaOdbc *c, const char *name)
{
    GString *s = g_string_new(NULL);
    char     esc = c->escape ? c->escape[0] : '\0';

    for (const char *p = name; *p; p++) {
        if (esc && (*p == '_' || *p == '%' || *p == esc))
            g_string_append_c(s, esc);
        g_string_append_c(s, *p);
    }
    BtaOdbcChar *out = odbc_in(s->str);
    g_string_free(s, TRUE);
    return out;
}

/* The schemas that are the engine's and not the program's. */
static bool system_schema(const char *s)
{
    static const char *const sys[] = { "information_schema", "pg_catalog",
                                       "pg_toast", "sys", "mysql",
                                       "performance_schema", NULL };
    for (const char *const *q = sys; s && *q; q++)
        if (g_ascii_strcasecmp(s, *q) == 0)
            return true;
    return false;
}

static int compare_names(gconstpointer a, gconstpointer b)
{
    return strcmp(*(char *const *)a, *(char *const *)b);
}

/*
 * `Tables` -- the tables and views, by name, ordered, each once. `SQLTables`
 * lists every schema (psqlODBC answered `other.a_b` beside `public.a_b`) while
 * `SQLColumns` resolves a bare name through the search path, so a name in two
 * schemas is one name here: it is what `Table(name)` will find. The engine's
 * own schemas are left out.
 */
static JSValue odbc_get_tables(JSContext *ctx, JSValueConst this_val)
{
    BtaOdbc *c = open_of(ctx, this_val);
    if (!c)
        return JS_EXCEPTION;

    SQLHSTMT st = stmt_new(ctx, c);
    if (!st)
        return JS_EXCEPTION;

    BtaOdbcChar *types = odbc_in("TABLE,VIEW");
    SQLRETURN    r = ODBC_API(SQLTables)(st, NULL, 0, NULL, 0, NULL, 0,
                                         types, SQL_NTS);
    g_free(types);
    if (!SQL_SUCCEEDED(r)) {
        throw_odbc(ctx, SQL_HANDLE_STMT, st, "cannot list the tables");
        SQLFreeHandle(SQL_HANDLE_STMT, st);
        return JS_EXCEPTION;
    }

    GHashTable *seen  = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, NULL);
    bool        err   = false;

    while (!err && SQL_SUCCEEDED(r = SQLFetch(st))) {
        char *schema = text_c(ctx, st, 2, &err);
        char *name   = err ? NULL : text_c(ctx, st, 3, &err);
        if (name && !system_schema(schema) && !g_hash_table_contains(seen, name))
            g_hash_table_add(seen, name);
        else
            g_free(name);
        g_free(schema);
    }
    if (!err && r != SQL_NO_DATA) {
        throw_odbc(ctx, SQL_HANDLE_STMT, st, "cannot list the tables");
        err = true;
    }
    SQLFreeHandle(SQL_HANDLE_STMT, st);

    JSValue out = JS_EXCEPTION;
    if (!err) {
        GPtrArray *names = g_hash_table_get_keys_as_ptr_array(seen);
        g_ptr_array_sort(names, compare_names);
        out = JS_NewArray(ctx);
        for (guint i = 0; i < names->len; i++)
            JS_SetPropertyUint32(ctx, out, i,
                                 JS_NewString(ctx, g_ptr_array_index(names, i)));
        g_ptr_array_unref(names);
    }
    g_hash_table_unref(seen);
    return out;
}

/*
 * `Columns(table)` -- `[{ Name, Type, Required, Key }]`, sqlite's shape:
 * `Type` is the engine's own name (`numeric`, `NUMERIC(12,2)`), `Required` a
 * column that refuses NULL, `Key` one in the primary key. `[]` when there is
 * no such table, which is how `Table` says so. One schema: the first row's,
 * for a driver that answers the name from several.
 */
static JSValue odbc_columns(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
    BtaOdbc *c = open_of(ctx, this_val);
    if (!c)
        return JS_EXCEPTION;
    if (argc < 1 || !JS_IsString(argv[0]))
        return JS_ThrowTypeError(ctx, "Columns expects the name of a table");

    const char *table = JS_ToCString(ctx, argv[0]);
    if (!table)
        return JS_EXCEPTION;

    SQLHSTMT st = stmt_new(ctx, c);
    if (!st) {
        JS_FreeCString(ctx, table);
        return JS_EXCEPTION;
    }

    JSValue      out     = JS_NewArray(ctx);
    uint32_t     at      = 0;
    char        *schema  = NULL;
    bool         have    = false;
    bool         err     = false;
    BtaOdbcChar *pattern = catalog_pattern(c, table);
    SQLRETURN    r = ODBC_API(SQLColumns)(st, NULL, 0, NULL, 0, pattern, SQL_NTS,
                                          NULL, 0);
    if (!SQL_SUCCEEDED(r)) {
        throw_odbc(ctx, SQL_HANDLE_STMT, st, "cannot read the columns");
        err = true;
    }
    while (!err && SQL_SUCCEEDED(r = SQLFetch(st))) {
        char *sch  = text_c(ctx, st, 2, &err);
        char *name = err ? NULL : text_c(ctx, st, 3, &err);
        char *col  = err ? NULL : text_c(ctx, st, 4, &err);
        char *type = err ? NULL : text_c(ctx, st, 6, &err);
        SQLSMALLINT nullable = SQL_NULLABLE_UNKNOWN;
        SQLLEN      ind = 0;
        if (!err)
            SQLGetData(st, 11, SQL_C_SSHORT, &nullable, sizeof nullable, &ind);

        bool mine = !err && name && col && strcmp(name, table) == 0
                 && (!have || g_strcmp0(sch, schema) == 0);
        if (mine) {
            if (!have) {
                schema = g_strdup(sch);
                have   = true;
            }
            JSValue o = JS_NewObject(ctx);
            JS_SetPropertyStr(ctx, o, "Name", JS_NewString(ctx, col));
            JS_SetPropertyStr(ctx, o, "Type", JS_NewString(ctx, type ? type : ""));
            JS_SetPropertyStr(ctx, o, "Required",
                              JS_NewBool(ctx, ind != SQL_NULL_DATA
                                              && nullable == SQL_NO_NULLS));
            /* sqlite's contract: the position in the key, 0 for none --
             * a compound key says 1, 2, 3 and the order is the answer. */
            JS_SetPropertyStr(ctx, o, "Key", JS_NewInt32(ctx, 0));
            JS_SetPropertyUint32(ctx, out, at++, o);
        }
        g_free(sch); g_free(name); g_free(col); g_free(type);
    }
    if (!err && r != SQL_NO_DATA) {
        throw_odbc(ctx, SQL_HANDLE_STMT, st, "cannot read the columns");
        err = true;
    }
    SQLFreeStmt(st, SQL_CLOSE);

    /* The key, from its own call, marked on the columns already read. */
    if (!err && at > 0) {
        BtaOdbcChar *sch = schema ? odbc_in(schema) : NULL;
        BtaOdbcChar *tab = odbc_in(table);
        r = ODBC_API(SQLPrimaryKeys)(st, NULL, 0, sch, sch ? SQL_NTS : 0,
                                     tab, SQL_NTS);
        g_free(sch);
        g_free(tab);
        while (!err && SQL_SUCCEEDED(r) && SQL_SUCCEEDED(r = SQLFetch(st))) {
            char *name = text_c(ctx, st, 3, &err);
            char *col  = err ? NULL : text_c(ctx, st, 4, &err);
            SQLSMALLINT seq = 0;
            SQLLEN      sind = 0;
            if (!err)
                SQLGetData(st, 5, SQL_C_SSHORT, &seq, sizeof seq, &sind);
            if (!err && name && col && strcmp(name, table) == 0)
                for (uint32_t i = 0; i < at; i++) {
                    JSValue o = JS_GetPropertyUint32(ctx, out, i);
                    JSValue n = JS_GetPropertyStr(ctx, o, "Name");
                    const char *s = JS_ToCString(ctx, n);
                    if (s && strcmp(s, col) == 0)
                        JS_SetPropertyStr(ctx, o, "Key",
                                          JS_NewInt32(ctx, sind == SQL_NULL_DATA ? 1 : seq));
                    JS_FreeCString(ctx, s);
                    JS_FreeValue(ctx, n);
                    JS_FreeValue(ctx, o);
                }
            g_free(name);
            g_free(col);
        }
        /* A driver without the call answers no key rather than failing the
         * columns it did read. */
    }

    SQLFreeHandle(SQL_HANDLE_STMT, st);
    g_free(schema);
    JS_FreeCString(ctx, table);
    if (err) {
        JS_FreeValue(ctx, out);
        return JS_EXCEPTION;
    }
    return out;
}

/* ------------------------------------------------------------ the dialect */

/*
 * What `Table`, `Cursor` and `Model` must not assume, per engine, keyed by
 * `SQL_DBMS_NAME`. ODBC makes the connection alike, not the SQL.
 *
 *   NewKey     how the key of a new row comes back: `"Returning"` (an
 *              `INSERT … RETURNING`, measured on psqlODBC), `"Output"` (SQL
 *              Server's `OUTPUT INSERTED`), `"Select"` (`KeyQuery` right after
 *              the insert: sqliteodbc drops `RETURNING`'s rows, measured), or
 *              `"None"`, which `Table.Insert` refuses
 *   Page       `"Limit"` when `LIMIT ? OFFSET ?` pages a `Cursor`; `""` and
 *              `Cursor` refuses (SQL Server, until it can be run)
 *   Decimal    `"Text"`: sqlite's rule, a decimal needs TEXT affinity;
 *              `"Exact"`: an exact numeric or text, never a float
 *   Types      the column type per field kind, for `Model.Ensure`; null for
 *              an engine nobody has run it on, and `Ensure` refuses
 *   AutoKey    what makes a single integer key generated; `""` is sqlite's
 *              `INTEGER PRIMARY KEY`
 *
 * The SQL Server and MySQL rows come from the drivers' documentation and have
 * not been run.
 */
typedef struct {
    const char        *dbms;
    const char        *newkey;
    const char        *keyquery;
    const char        *page;
    const char        *decimal;
    const char        *autokey;
    const char *const *types;     /* kind, type, … NULL; NULL for none */
} OdbcEngine;

static const char *const sqlite_types[] = {
    "text", "TEXT", "enum", "TEXT", "date", "TEXT", "time", "TEXT",
    "datetime", "TEXT", "decimal", "TEXT", "int", "INTEGER", "bool", "INTEGER",
    "number", "REAL", "bytes", "BLOB", NULL };

static const char *const postgres_types[] = {
    "text", "TEXT", "enum", "TEXT", "date", "DATE", "time", "TIME(0)",
    "datetime", "TIMESTAMP(0)", "decimal", "NUMERIC", "int", "BIGINT",
    "bool", "BOOLEAN", "number", "DOUBLE PRECISION", "bytes", "BYTEA", NULL };

static const OdbcEngine engines[] = {
    { "PostgreSQL", "Returning", NULL, "Limit", "Exact",
      "GENERATED BY DEFAULT AS IDENTITY", postgres_types },
    { "SQLite", "Select", "SELECT last_insert_rowid() AS id", "Limit", "Text",
      "", sqlite_types },
    { "Microsoft SQL Server", "Output", NULL, "", "Exact", NULL, NULL },
    { "MySQL", "Select", "SELECT LAST_INSERT_ID() AS id", "Limit", "Exact",
      NULL, NULL },
    { "MariaDB", "Select", "SELECT LAST_INSERT_ID() AS id", "Limit", "Exact",
      NULL, NULL },
};

static const OdbcEngine unknown_engine = { "", "None", NULL, "", "Exact",
                                           NULL, NULL };

static JSValue odbc_get_dialect(JSContext *ctx, JSValueConst this_val)
{
    BtaOdbc *c = odbc_of(ctx, this_val);
    if (!c)
        return JS_EXCEPTION;

    const OdbcEngine *e = &unknown_engine;
    for (size_t i = 0; i < G_N_ELEMENTS(engines); i++)
        if (c->dbms && strcmp(c->dbms, engines[i].dbms) == 0)
            e = &engines[i];

    JSValue d = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, d, "Placeholder", JS_NewString(ctx, "?"));
    /* The driver's own answer; a space is its way of saying "none". */
    const char *q = c->quote && *c->quote && strcmp(c->quote, " ") != 0
                  ? c->quote : "\"";
    JS_SetPropertyStr(ctx, d, "Quote",    JS_NewString(ctx, q));
    JS_SetPropertyStr(ctx, d, "NewKey",   JS_NewString(ctx, e->newkey));
    JS_SetPropertyStr(ctx, d, "KeyQuery",
                      e->keyquery ? JS_NewString(ctx, e->keyquery) : JS_NULL);
    JS_SetPropertyStr(ctx, d, "Page",     JS_NewString(ctx, e->page));
    JS_SetPropertyStr(ctx, d, "Decimal",  JS_NewString(ctx, e->decimal));
    JS_SetPropertyStr(ctx, d, "AutoKey",
                      e->autokey ? JS_NewString(ctx, e->autokey) : JS_NULL);
    if (e->types) {
        JSValue t = JS_NewObject(ctx);
        for (const char *const *p = e->types; *p; p += 2)
            JS_SetPropertyStr(ctx, t, p[0], JS_NewString(ctx, p[1]));
        JS_SetPropertyStr(ctx, d, "Types", t);
    } else {
        JS_SetPropertyStr(ctx, d, "Types", JS_NULL);
    }
    return d;
}

/*
 * `Each(sql, [params], fn)` -- the rows one at a time, never all at once, as
 * sqlite's: `fn(row)` for each, `false` stops, the answer is how many were
 * handed over, a throw in `fn` is the caller's. Whether `fn` may run another
 * statement on this connection while the rows are open is the driver's
 * (psqlODBC reads the whole result at execute; SQL Server needs MARS).
 *
 * `fn` is the program's code, so it runs in the desktop's locale: the C
 * numerics the driver needs are put back only around the driver.
 */
static JSValue each_body(JSContext *ctx, JSValueConst this_val,
                         int argc, JSValueConst *argv)
{
    BtaOdbc *c = open_of(ctx, this_val);
    if (!c)
        return JS_EXCEPTION;

    JSValueConst params = argc > 2 ? argv[1] : JS_UNDEFINED;
    JSValueConst fn     = argc > 2 ? argv[2] : (argc > 1 ? argv[1] : JS_UNDEFINED);
    if (argc < 2 || !JS_IsString(argv[0]) || !JS_IsFunction(ctx, fn))
        return JS_ThrowTypeError(ctx, "Each(sql, [params], fn): fn is called "
                                      "with each row");

    OdbcParam *p;
    uint32_t   n;
    if (!params_read(ctx, params, &p, &n))
        return JS_EXCEPTION;

    SQLHSTMT    st   = stmt_new(ctx, c);
    JSValue     out  = JS_EXCEPTION;
    OdbcColumn *cols = NULL;
    SQLSMALLINT ncol = 0;
    /* Held: `fn` may drop the last reference to itself or to the connection. */
    JSValue     call = JS_DupValue(ctx, fn);
    JSValue     self = JS_DupValue(ctx, this_val);
    int64_t     seen = 0;
    bool        stopped = false;

    if (!st || !stmt_run(ctx, st, argv[0], p, n))
        goto done;
    int found = first_rows(ctx, st, &ncol);
    if (found <= 0) {
        if (found == 0)
            out = JS_NewInt64(ctx, 0);
        goto done;
    }
    if (!(cols = columns_read(ctx, st, ncol)))
        goto done;

    c->reading++;
    for (;;) {
        SQLRETURN r = SQLFetch(st);
        if (r == SQL_NO_DATA)
            break;
        if (!SQL_SUCCEEDED(r)) {
            throw_odbc(ctx, SQL_HANDLE_STMT, st, "cannot read");
            break;
        }
        JSValue row = row_object(ctx, st, cols, ncol);
        if (JS_IsException(row))
            break;
        seen++;

        JSValue res = call_in_desktop_locale(ctx, call, row);
        JS_FreeValue(ctx, row);
        if (JS_IsException(res))
            break;
        stopped = JS_IsBool(res) && !JS_ToBool(ctx, res);
        JS_FreeValue(ctx, res);
        if (stopped)
            break;
    }
    c->reading--;

    if (!JS_HasException(ctx) && (stopped || stmt_drain(ctx, st)))
        out = JS_NewInt64(ctx, seen);

done:
    columns_free(cols, ncol);
    if (st)
        SQLFreeHandle(SQL_HANDLE_STMT, st);
    params_free(p, n);
    JS_FreeValue(ctx, call);
    JS_FreeValue(ctx, self);
    return out;
}

/* One statement of our own, no parameters, its results run past. `quiet`
 * leaves any exception it would raise unraised, for the rollback that must
 * not replace the error that caused it. */
static bool exec_text(JSContext *ctx, BtaOdbc *c, const char *sql,
                      const char *what, bool quiet)
{
    SQLHSTMT st = SQL_NULL_HSTMT;

    if (!SQL_SUCCEEDED(SQLAllocHandle(SQL_HANDLE_STMT, c->dbc, &st))) {
        if (!quiet)
            throw_odbc(ctx, SQL_HANDLE_DBC, c->dbc, what);
        return false;
    }
    BtaOdbcChar *in = odbc_in(sql);
    SQLRETURN    r  = ODBC_API(SQLExecDirect)(st, in, SQL_NTS);
    g_free(in);

    bool ok = ran(r);
    if (ok)
        while ((r = SQLMoreResults(st)) != SQL_NO_DATA)
            if (!SQL_SUCCEEDED(r)) {
                ok = false;
                break;
            }
    if (!ok && !quiet)
        throw_odbc(ctx, SQL_HANDLE_STMT, st, what);
    SQLFreeHandle(SQL_HANDLE_STMT, st);
    return ok;
}

/* The outermost unit ends: committed or rolled back, and autocommit back on
 * either way, so the statements after it are their own again. */
static bool end_outer(JSContext *ctx, BtaOdbc *c, SQLSMALLINT how, bool quiet)
{
    SQLRETURN r  = SQLEndTran(SQL_HANDLE_DBC, c->dbc, how);
    bool      ok = SQL_SUCCEEDED(r);

    if (!ok && !quiet)
        throw_odbc(ctx, SQL_HANDLE_DBC, c->dbc,
                   how == SQL_COMMIT ? "cannot commit" : "cannot roll back");
    if (!ok && how == SQL_COMMIT)
        SQLEndTran(SQL_HANDLE_DBC, c->dbc, SQL_ROLLBACK);
    SQLSetConnectAttr(c->dbc, SQL_ATTR_AUTOCOMMIT,
                      (SQLPOINTER)(uintptr_t)SQL_AUTOCOMMIT_ON, 0);
    return ok;
}

/*
 * A unit of work: everything, or nothing -- sqlite's contract. The outermost
 * is ODBC's own (autocommit off, `SQLEndTran`); a nested one is a savepoint,
 * in the engine's spelling: `SAVE TRANSACTION`/`ROLLBACK TRANSACTION` on SQL
 * Server, which has no release, and the standard's everywhere else. An
 * engine without savepoints refuses the nested call with its own error.
 *
 * Measured: psqlODBC rolls back only the statement that failed, so a program
 * that catches an error inside `fn` and carries on commits the rest -- it is
 * not PostgreSQL's aborted transaction that a bare libpq client meets.
 */
static JSValue odbc_transaction(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
    BtaOdbc *c = open_of(ctx, this_val);
    if (!c)
        return JS_EXCEPTION;
    if (argc < 1 || !JS_IsFunction(ctx, argv[0]))
        return JS_ThrowTypeError(ctx, "Transaction expects a function: what to "
                                      "do, all of it or none");

    bool  nested = c->depth > 0;
    char *begin = NULL, *ok = NULL, *undo = NULL;

    if (nested) {
        int d = c->depth;
        begin = c->sqlserver ? g_strdup_printf("SAVE TRANSACTION bta_%d", d)
                             : g_strdup_printf("SAVEPOINT bta_%d", d);
        ok    = c->sqlserver ? NULL
                             : g_strdup_printf("RELEASE SAVEPOINT bta_%d", d);
        undo  = c->sqlserver ? g_strdup_printf("ROLLBACK TRANSACTION bta_%d", d)
                             : g_strdup_printf("ROLLBACK TO SAVEPOINT bta_%d", d);
        if (!exec_text(ctx, c, begin, "cannot begin a nested transaction", false)) {
            g_free(begin); g_free(ok); g_free(undo);
            return JS_EXCEPTION;
        }
    } else if (!SQL_SUCCEEDED(SQLSetConnectAttr(c->dbc, SQL_ATTR_AUTOCOMMIT,
                    (SQLPOINTER)(uintptr_t)SQL_AUTOCOMMIT_OFF, 0))) {
        return throw_odbc(ctx, SQL_HANDLE_DBC, c->dbc, "cannot begin");
    }

    JSValue self = JS_DupValue(ctx, this_val);
    c->depth++;
    JSValue r = JS_Call(ctx, argv[0], JS_UNDEFINED, 0, NULL);
    c->depth--;

    JSValue out;
    if (!c->dbc) {
        /* Closed inside its own transaction: `odbc_release` rolled it back. */
        if (JS_IsException(r))
            out = r;
        else {
            JS_FreeValue(ctx, r);
            out = JS_ThrowTypeError(ctx, "the connection was closed inside its "
                                         "own transaction, so there was nothing "
                                         "left to commit");
        }
    } else if (JS_IsException(r)) {
        /* The exception is kept and put back: the rollback runs SQL of its
         * own, and the program must hear what went wrong, not how undoing it
         * went. */
        JSValue held = JS_GetException(ctx);
        if (nested)
            exec_text(ctx, c, undo, "", true);
        else
            end_outer(ctx, c, SQL_ROLLBACK, true);
        out = JS_Throw(ctx, held);
    } else if (nested) {
        if (ok && !exec_text(ctx, c, ok, "cannot release a nested transaction",
                             false)) {
            JSValue held = JS_GetException(ctx);
            exec_text(ctx, c, undo, "", true);
            JS_FreeValue(ctx, r);
            out = JS_Throw(ctx, held);
        } else {
            out = r;
        }
    } else if (!end_outer(ctx, c, SQL_COMMIT, false)) {
        JS_FreeValue(ctx, r);
        out = JS_EXCEPTION;
    } else {
        out = r;
    }

    JS_FreeValue(ctx, self);
    g_free(begin); g_free(ok); g_free(undo);
    return out;
}

typedef JSValue OdbcWord(JSContext *, JSValueConst, int, JSValueConst *);

static JSValue in_c_numeric(OdbcWord *word, JSContext *ctx,
                            JSValueConst this_val, int argc, JSValueConst *argv)
{
    OdbcNumeric s;
    numeric_enter(&s);
    JSValue out = word(ctx, this_val, argc, argv);
    numeric_leave(&s);
    return out;
}

static JSValue odbc_query(JSContext *ctx, JSValueConst this_val,
                          int argc, JSValueConst *argv)
{
    return in_c_numeric(query_body, ctx, this_val, argc, argv);
}

static JSValue odbc_execute(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
    return in_c_numeric(execute_body, ctx, this_val, argc, argv);
}

static JSValue odbc_script(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv)
{
    return in_c_numeric(script_body, ctx, this_val, argc, argv);
}

static JSValue odbc_each(JSContext *ctx, JSValueConst this_val,
                         int argc, JSValueConst *argv)
{
    return in_c_numeric(each_body, ctx, this_val, argc, argv);
}

/* ---------------------------------------------------------- Database.Odbc */

static JSValue database_odbc(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    if (argc < 1 || !JS_IsString(argv[0]))
        return JS_ThrowTypeError(ctx, "Database.Odbc expects a connection "
                                      "string -- \"DSN=name\" or "
                                      "\"Driver={…};Server=…;Database=…\"");

    char *given = option_text(ctx, argv[0], "the connection string");
    if (!given)
        return JS_EXCEPTION;
    if (!*g_strstrip(given)) {
        g_free(given);
        return JS_ThrowTypeError(ctx, "Database.Odbc: the connection string is "
                                      "empty -- name a DSN or a driver");
    }

    OdbcOptions o;
    if (!read_options(ctx, argc >= 2 ? argv[1] : JS_UNDEFINED, &o)) {
        g_free(given);
        g_free(o.user);
        g_free(o.password);
        return JS_EXCEPTION;
    }

    /* Given twice is refused rather than choosing one: which wins is the
     * driver's rule, and not every driver has the same. */
    static const char *const user_keys[] = { "UID", "User", "User ID", NULL };
    static const char *const pwd_keys[]  = { "PWD", "Password", NULL };
    const char *twice = (o.user && cs_names(given, user_keys)) ? "User"
                      : (o.password && cs_names(given, pwd_keys)) ? "Password"
                      : NULL;
    if (twice) {
        g_free(given);
        g_free(o.user);
        g_free(o.password);
        return JS_ThrowTypeError(ctx, "Database.Odbc: %s is given both in the "
                                      "options and in the connection string -- "
                                      "say it once", twice);
    }

    GString *cs = g_string_new(given);
    g_free(given);
    if (o.user)
        cs_append(cs, "UID", o.user);
    if (o.password)
        cs_append(cs, "PWD", o.password);
    g_free(o.user);
    if (o.password) {
        memset(o.password, 0, strlen(o.password));
        g_free(o.password);
    }

    BtaOdbc *c = g_new0(BtaOdbc, 1);
    JSValue  result = JS_UNDEFINED;

    if (!SQL_SUCCEEDED(SQLAllocHandle(SQL_HANDLE_ENV, SQL_NULL_HANDLE, &c->env))) {
        c->env = NULL;
        result = JS_ThrowPlainError(ctx, "Database.Odbc: the driver manager "
                                         "could not start");
        goto out;
    }
    if (!SQL_SUCCEEDED(SQLSetEnvAttr(c->env, SQL_ATTR_ODBC_VERSION,
                                     (SQLPOINTER)(uintptr_t)SQL_OV_ODBC3, 0))) {
        result = throw_odbc(ctx, SQL_HANDLE_ENV, c->env,
                            "Database.Odbc: the driver manager refused ODBC 3");
        goto out;
    }
    if (!SQL_SUCCEEDED(SQLAllocHandle(SQL_HANDLE_DBC, c->env, &c->dbc))) {
        c->dbc = NULL;
        result = throw_odbc(ctx, SQL_HANDLE_ENV, c->env,
                            "Database.Odbc: no connection handle");
        goto out;
    }

    SQLSetConnectAttr(c->dbc, SQL_ATTR_LOGIN_TIMEOUT,
                      (SQLPOINTER)(uintptr_t)odbc_seconds(o.timeout), 0);
    c->stmt_secs = o.statement > 0 ? odbc_seconds(o.statement) : 0;

    BtaOdbcChar *in = odbc_in(cs->str);
    SQLRETURN    r  = ODBC_API(SQLDriverConnect)(c->dbc, NULL, in, SQL_NTS,
                                                 NULL, 0, NULL,
                                                 SQL_DRIVER_NOPROMPT);
    /* The completed string is never asked for: it carries the password. */
    memset(cs->str, 0, cs->len);
    g_free(in);

    if (!SQL_SUCCEEDED(r)) {
        result = throw_odbc(ctx, SQL_HANDLE_DBC, c->dbc,
                            "Database.Odbc: cannot connect");
        SQLFreeHandle(SQL_HANDLE_DBC, c->dbc);
        c->dbc = NULL;
        goto out;
    }

    c->dbms     = info_text(c->dbc, SQL_DBMS_NAME);
    c->sqlserver = strcmp(c->dbms, "Microsoft SQL Server") == 0;
    c->dbms_ver = info_text(c->dbc, SQL_DBMS_VER);
    c->driver   = info_text(c->dbc, SQL_DRIVER_NAME);
    c->escape   = info_text(c->dbc, SQL_SEARCH_PATTERN_ESCAPE);
    c->quote    = info_text(c->dbc, SQL_IDENTIFIER_QUOTE_CHAR);

    result = JS_NewObjectClass(ctx, bta_odbc_class_id);
    if (!JS_IsException(result)) {
        JS_SetOpaque(result, c);
        c = NULL;
    }

out:
    g_string_free(cs, TRUE);
    if (c) {
        odbc_release(c);
        g_free(c->dbms);
        g_free(c->dbms_ver);
        g_free(c->escape);
        g_free(c->quote);
        g_free(c->driver);
        g_free(c);
    }
    return result;
}

/* type OdbcConnection */
static const JSCFunctionListEntry odbc_props[] = {
    /* Open -> boolean
     *   whether it still is
     */
    JS_CGETSET_DEF("Open",        odbc_get_open,         NULL),
    /* Dbms -> string
     *   the engine, as the driver names it: `"PostgreSQL"`, `"SQLite"`,
     *   `"Microsoft SQL Server"`. Still answers after `Close`
     */
    JS_CGETSET_DEF("Dbms",        odbc_get_dbms,         NULL),
    /* DbmsVersion -> string
     *   the engine's version, as the driver writes it
     */
    JS_CGETSET_DEF("DbmsVersion", odbc_get_dbms_version, NULL),
    /* Driver -> string
     *   the driver's own file name: `"psqlodbcw.so"`, `"msodbcsql18.dll"`
     */
    JS_CGETSET_DEF("Driver",      odbc_get_driver,       NULL),
    /* Query(sql, [params]) -> any[]
     *   the rows of the first result that has any, as **plain objects**;
     *   `[]` for a statement with none. Values are bound to `?`, never
     *   pasted: text, a number, a boolean, a `Decimal`, a `Bytes` or null
     */
    JS_CFUNC_DEF("Query",         2, odbc_query),
    /* Execute(sql, [params]) -> { Changes }
     *   **one** statement, answering `{ Changes }` -- the rows it touched,
     *   `-1` when the driver cannot say. An `UPDATE` that matched nothing is
     *   `0`, not an error
     */
    JS_CFUNC_DEF("Execute",       2, odbc_execute),
    /* Script(sql)
     *   several statements and **no parameters**, as the driver runs a batch:
     *   psqlODBC takes one, sqliteodbc refuses a second statement
     */
    JS_CFUNC_DEF("Script",        1, odbc_script),
    /* Each(sql, [params], fn) -> number
     *   the rows **one at a time**: `fn(row)` for each, never an array of all
     *   of them. `fn` returning `false` stops; the answer is how many rows were
     *   handed over. `Close()` is refused while it reads
     */
    JS_CFUNC_DEF("Each",          3, odbc_each),
    /* Transaction(fn)
     *   everything in `fn` or nothing, and what `fn` returns. **Nests**,
     *   through savepoints in the engine's spelling. A throw rolls back and
     *   is rethrown
     */
    JS_CFUNC_DEF("Transaction",   1, odbc_transaction),
    /* Columns(table) -> { Name, Type, Required, Key }[]
     *   what is really in the table, from the driver's catalogue: `Type` is
     *   the engine's own name for it, `Key` the position in the primary key
     *   (0 for none); `[]` when there is no such table
     */
    JS_CFUNC_DEF("Columns",       1, odbc_columns),
    /* Tables -> string[]
     *   the tables and views, ordered, each name once whatever schema it is
     *   in; the engine's own schemas are left out
     */
    JS_CGETSET_DEF("Tables",      odbc_get_tables,       NULL),
    /* Dialect -> object
     *   what differs per engine, from `Dbms`: `Placeholder`, `Quote`,
     *   `NewKey` (`"Returning"`, `"Output"`, `"Select"` with `KeyQuery`, or
     *   `"None"`), `Page`, `Decimal`, `Types` and `AutoKey` -- what `Table`,
     *   `Cursor` and `Model` read instead of assuming sqlite
     */
    JS_CGETSET_DEF("Dialect",     odbc_get_dialect,      NULL),
    /* Close()
     *   let it go; twice is not an error
     */
    JS_CFUNC_DEF("Close",         0, odbc_close),
};

void bta_odbc_init(JSContext *ctx, JSValue global)
{
    JSRuntime *rt = JS_GetRuntime(ctx);

    JS_NewClassID(rt, &bta_odbc_class_id);
    JS_NewClass(rt, bta_odbc_class_id, &odbc_class);

    /* On the base prototype, as sqlite's: `conn instanceof Connection`. */
    JSValue base  = bta_connection_proto(ctx);
    JSValue proto = JS_NewObjectProto(ctx, base);
    JS_FreeValue(ctx, base);

    JS_SetPropertyFunctionList(ctx, proto, odbc_props, G_N_ELEMENTS(odbc_props));
    JS_SetClassProto(ctx, bta_odbc_class_id, proto);

    /* Odbc(connection, [options]) -> OdbcConnection
     *   connects through an ODBC driver: `connection` is the driver's own
     *   string, `"DSN=name"` or `"Driver={…};Server=…;Database=…"`, passed as
     *   written; `options` are `{ User, Password, Timeout }` (milliseconds, 10000
     *   unless told). Never opens a dialog. A failure throws with the driver's
     *   message, its SQLSTATE in `Code` and the engine's number in `Native`. A
     *   build without a driver manager has the name and refuses, naming the
     *   package
     */
    bta_database_driver(ctx, "Odbc", database_odbc, 2);
}

#else  /* no driver manager at build time */

static JSValue database_odbc(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    return JS_ThrowPlainError(ctx,
        "this runtime was built without ODBC, so there is no driver manager to "
        "connect through. Install unixODBC's development package "
        "(unixODBC-devel, unixodbc-dev, or Homebrew's unixodbc) and build "
        "again -- CMake finds it with pkg-config and prints which it found");
}

void bta_odbc_init(JSContext *ctx, JSValue global)
{
    /* Odbc(connection, [options]) -> OdbcConnection
     *   connects through an ODBC driver: `connection` is the driver's own
     *   string, `"DSN=name"` or `"Driver={…};Server=…;Database=…"`, passed as
     *   written; `options` are `{ User, Password, Timeout }` (milliseconds, 10000
     *   unless told). Never opens a dialog. A failure throws with the driver's
     *   message, its SQLSTATE in `Code` and the engine's number in `Native`. A
     *   build without a driver manager has the name and refuses, naming the
     *   package
     */
    bta_database_driver(ctx, "Odbc", database_odbc, 2);
}

#endif

/*
 * ## Where it stands
 *
 * Stages 0 to 5 of docs/plans/odbc-plan.md: the build on three platforms,
 * the text layer, `Database.Odbc` connecting and refusing, diagnostics as
 * `Code`/`Native`/`Details`, `Open`, `Dbms`, `DbmsVersion`, `Driver`, `Close`,
 * `Query`, `Execute` and `Script` with every type both ways, `Each` and
 * `Transaction`, and `Columns`, `Tables` and `Dialect` -- everything `Table`,
 * `Cursor` and `Model` ask for (stages 2 to 4). A form's `Connection` part
 * opens one with `Driver: "Odbc"` (stage 5, in rad.js).
 */
