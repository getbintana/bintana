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
} BtaOdbc;

static void odbc_release(BtaOdbc *c)
{
    if (c->dbc) {
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
} OdbcOptions;

/* The options every driver shares, and nothing else: a key that is not one is
 * refused, since `{ Pasword: … }` quietly meaning no password is a misspelling
 * that costs nothing to catch. */
static bool read_options(JSContext *ctx, JSValueConst opts, OdbcOptions *o)
{
    static const char *const known[] = { "User", "Password", "Timeout", NULL };

    o->user = o->password = NULL;
    o->timeout = 10000;

    if (JS_IsUndefined(opts) || JS_IsNull(opts))
        return true;
    if (!JS_IsObject(opts)) {
        JS_ThrowTypeError(ctx, "Database.Odbc: the options are an object -- "
                               "{ User, Password, Timeout }");
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
                                   "they are User, Password and Timeout; "
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

    v = JS_GetPropertyStr(ctx, opts, "Timeout");
    if (JS_IsException(v))
        return false;
    if (!JS_IsUndefined(v)) {
        bool ok = bta_to_number(ctx, v, "Database.Odbc: Timeout", &o->timeout);
        JS_FreeValue(ctx, v);
        if (!ok)
            return false;
        if (!(o->timeout > 0) || isinf(o->timeout)) {
            JS_ThrowRangeError(ctx, "Database.Odbc: Timeout is a number of "
                                    "milliseconds above zero");
            return false;
        }
    }
    return true;
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

    /* Whole seconds is what the attribute takes; rounded up, so 500 ms is one
     * second and not "no limit", which is what 0 means here. */
    double secs = ceil(o.timeout / 1000.0);
    SQLSetConnectAttr(c->dbc, SQL_ATTR_LOGIN_TIMEOUT,
                      (SQLPOINTER)(uintptr_t)(secs > 86400 ? 86400 : secs), 0);

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
    c->dbms_ver = info_text(c->dbc, SQL_DBMS_VER);
    c->driver   = info_text(c->dbc, SQL_DRIVER_NAME);

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
 * Stage 0 of docs/plans/odbc-plan.md, and the connect of stage 1: the build on
 * three platforms, the text layer, `Database.Odbc` connecting and refusing,
 * diagnostics as `Code`/`Native`/`Details`, and `Open`, `Dbms`, `DbmsVersion`,
 * `Driver`, `Close`. `Query`, `Execute` and the rest of what `Table` asks for
 * are the stages after it; until then an `OdbcConnection` has none of them.
 */
