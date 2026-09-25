/*
 * Database.Sqlite -- a driver, named for the library it is.
 *
 * ## Why the name says sqlite
 *
 * Half of what is in this file is **not portable**, and a class called
 * `Connection` with `Open()` on it would promise otherwise. Measured against
 * the two databases anybody would add next:
 *
 *   | | sqlite | PostgreSQL | MySQL |
 *   |---|---|---|---|
 *   | a parameter          | `?`                | `$1`                 | `?` |
 *   | the key just made    | `last_insert_rowid`| no such thing: `INSERT … RETURNING` | `LAST_INSERT_ID()` |
 *   | metadata             | `sqlite_master`, `PRAGMA` | `information_schema` | `information_schema` |
 *   | an exact decimal     | **none**           | `NUMERIC`            | `DECIMAL` |
 *   | quoting a name       | `"x"`              | `"x"`                | `` `x` `` |
 *
 * The decimal row is the one that settles it: **storing a decimal as text is a
 * decision about sqlite and not about this project.** PostgreSQL has an exact
 * numeric type and the right mapping there is the column, not text. Freezing
 * that into a generic name would make one database's limitation look like the
 * runtime's.
 *
 * So the split is: `Database.Sqlite(path)` is *this* driver, and what it answers
 * with is a `Connection` -- because a connection is a connection whichever
 * engine is underneath. What varies is how you get one and what its `Dialect`
 * says.
 *
 * ## What a second driver would have to provide
 *
 * `Table`, in `rad.js`, is the portable half: it builds the statements, maps a
 * `Record` onto a row and decides whether a save is an INSERT or an UPDATE. It
 * asks a connection for exactly this much, and a `Database.Postgres` written
 * later has to answer the same:
 *
 *   Query(sql, params) -> rows        Execute(sql, params) -> { Changes, ... }
 *   Transaction(fn)                   Columns(table) -> [{ Name, Type, Required, Key }]
 *   Tables                            Dialect -> { Placeholder, Quote, NewKey }
 *
 * `Dialect` carries the three facts that are known to differ, and three because
 * three is what can be named -- a fourth invented for symmetry would be a guess
 * about a database nobody has written yet. `Path` is not in the list: it is this
 * driver's own, and it means nothing to a database over a socket.
 *
 * ## This file is one driver
 *
 * Named `bta_sqlite.c` and not `bta_data.c` for the same reason the global is not
 * `Connection`: every other module here is named for what it *implements* --
 * `bta_decimal.c` is `Decimal`, `bta_day.c` is `Day` -- and a file named for a
 * category would be the only one. A `Database.Postgres` is a `bta_postgres.c`
 * beside this one, and it needs nothing from here.
 *
 * What the two would share is in [bta_database.c](bta_database.c), and it is
 * three lines' worth: the `Connection` base class, whose prototype `rad.js`
 * hangs `Table` on, and the `Database` object a driver adds its opener to.
 * Everything else -- every method on the prototype below -- is sqlite, which is
 * why the shared part is an interface and not a base implementation.
 *
 * So this driver does what any other would:
 *
 *   - a `JSClassID` of its own, so the opaque pointer on a connection is *this*
 *     struct and a handle from another driver cannot be mistaken for one;
 *   - a prototype built on `bta_connection_proto()`, which is what puts `Table`
 *     in the chain and makes `conn instanceof Connection` mean something;
 *   - `bta_database_driver()` to add `Sqlite` to `Database`.
 *
 * ## And deliberately nothing above it
 *
 * The C in the data story is this and no more: open a database, run a statement
 * with its values *bound*, hand back plain objects.  What a row means
 * -- which record it fills, which column is which field, whether a save is an
 * INSERT or an UPDATE -- is in `rad.js`, next to `Record`, and the reason is not
 * taste: a record's values live in a private bag, and JavaScript's private
 * fields are scoped to the class that declares them.  Nothing outside `Record`
 * can read what a record holds or what its file could not take, so the mapping
 * has to be written inside it.  See
 * [docs/plans/data-plan.md](../../docs/plans/data-plan.md).
 *
 * **Values are bound, never interpolated.** There is no way to ask this file to
 * paste a value into a statement, which is the same bargain every setter in this
 * runtime makes with a widget: the runtime does the escaping so no program has
 * to remember to.  The one place an identifier reaches SQL as text is
 * `Columns()`, and it goes through sqlite's own quoting.
 *
 * **SQL is the query language and it is not ours.** A filter is a string of SQL
 * because sqlite already parses it and already says what is wrong with it -- and
 * a grammar of our own inside a value is the thing `docs/plans/data-plan.md`
 * refused twice, for field metadata and for a scheme prefix in a source.
 *
 * ## Types, and the one that matters
 *
 * sqlite has five storage classes -- NULL, INTEGER, REAL, TEXT, BLOB -- and no
 * decimal.  A price in REAL is the missing cent that `Decimal` exists to
 * prevent, so **a Decimal goes in and comes out as TEXT**, exactly as it does in
 * a JSON file and for the same reason: text is the one road that never passes
 * through a double.  It is what sqlite's own `decimal.c` extension does.
 *
 * The cost is named where it is paid: `ORDER BY price` on such a column sorts
 * lexicographically (`'9.00' > '10.00'`) and `SUM(price)` goes through a double.
 * A collation and an aggregate built on `bta_decimal.c` are the answer and are
 * **not here yet**; until they are, order and total a decimal column in the
 * program and not in the statement.
 *
 * The other four need no conversion at all, and that is not luck --
 * `Field.Bool` already takes sqlite's `0`/`1` ("the two spellings a boolean
 * really has"), and `Field.Date` already holds `"YYYY-MM-DD"`, which is
 * sqlite's own date convention.  The field kinds were designed against SQL
 * before there was any SQL.
 *
 * BLOB is refused rather than mangled: there is no JS value here that carries
 * bytes, and handing one back as a string would corrupt it silently.
 *
 * ## Optional
 *
 * sqlite is an optional build dependency, the same way libsystemd is for
 * `Log.Target = "Journal"`.  Without it `Database.Sqlite` still exists and says
 * what is missing -- a `typeof Database` that answered `"undefined"` would send
 * whoever hit it looking for a spelling mistake, and `Connection` still exists
 * as a class so `rad.js` can hang `Table` on it either way.
 */

#include "bta.h"

#include <limits.h>
#include <math.h>
#include <string.h>

#ifdef BTA_HAVE_SQLITE
#include <sqlite3.h>
#endif

#ifdef BTA_HAVE_SQLITE

static JSClassID bta_sqlite_class_id;

/* --------------------------------------------------------------- the handle */

typedef struct {
    sqlite3 *db;         /* NULL once closed: every method goes through db_of */
    char    *path;       /* for the messages, and for Path */
    int      depth;      /* nested Transaction: 0 is none, >0 is a savepoint */
} BtaConn;

static void conn_finalizer(JSRuntime *rt, JSValue val)
{
    BtaConn *c = JS_GetOpaque(val, bta_sqlite_class_id);

    if (!c)
        return;
    /* Closed here as well as by Close(), because a program that opens a
     * database and never says so is the ordinary case and sqlite holds a file
     * lock until somebody does. */
    if (c->db)
        sqlite3_close(c->db);
    g_free(c->path);
    g_free(c);
}

/* `SqliteConnection` and not `Connection`, which is the base in
 * bta_database.c: when there are two drivers a traceback saying which one it
 * was is worth the longer word. */
static JSClassDef conn_class = {
    "SqliteConnection",
    .finalizer = conn_finalizer,
};

/*
 * The handle, or a throw.  Everything below goes through here, so "used after
 * Close" is one sentence in one place rather than a segfault in whichever method
 * was called first.
 */
static BtaConn *conn_of(JSContext *ctx, JSValueConst this_val)
{
    BtaConn *c = JS_GetOpaque2(ctx, this_val, bta_sqlite_class_id);

    if (!c)
        return NULL;
    if (!c->db) {
        JS_ThrowTypeError(ctx, "this connection is closed");
        return NULL;
    }
    return c;
}

/* sqlite's complaint, with the statement that caused it -- a query that failed
 * is a query somebody has to read. Truncated, because a generated statement can
 * be long and the first line of it is what identifies it. */
static JSValue throw_sqlite(JSContext *ctx, BtaConn *c, const char *what,
                            const char *sql)
{
    const char *said = sqlite3_errmsg(c->db);

    if (!sql)
        return JS_ThrowInternalError(ctx, "%s: %s", what, said);

    char cut[161];
    g_strlcpy(cut, sql, sizeof cut);
    if (strlen(sql) >= sizeof cut)
        g_strlcpy(cut + sizeof cut - 4, "...", 4);

    return JS_ThrowInternalError(ctx, "%s: %s -- in: %s", what, said, cut);
}

/* ------------------------------------------------- decimals, inside sqlite */

/*
 * sqlite has no exact numeric type, so a decimal is TEXT -- and TEXT compares
 * byte by byte, which puts `'9.00'` after `'10.00'`.  Everything that orders,
 * compares or totals such a column is wrong by default, and *quietly*: the rows
 * come back, in the wrong order.
 *
 * The answer is the one sqlite's own `decimal.c` extension takes: a **collation**
 * for the comparing and a **function** for the arithmetic, both told the truth
 * by the runtime's own exact decimal.  `bta_decimal_from_text` is the parsing
 * half of `Decimal`, split out for exactly this and throwing nothing -- a
 * callback in the middle of a statement has nobody to hand an exception to.
 *
 * ## What the collation buys, which is more than ORDER BY
 *
 * A column declared `TEXT COLLATE DECIMAL` uses it for `ORDER BY`, for `MIN`
 * and `MAX`, for `<`/`>` against a literal, for `GROUP BY` and for `DISTINCT` --
 * sqlite applies a column's collation to all of them. So the schema saying it
 * once is what makes the ordinary statement correct, rather than every statement
 * having to remember a `COLLATE`.
 *
 * `SUM` and `AVG` are the exception, because they are arithmetic and not
 * comparison: `decimal_sum(x)` is the aggregate that adds without a double.
 */

/* Two decimals as text, ordered.  Text that is not a decimal is compared as
 * text and sorts after everything that is one -- an ordering has to be total and
 * it has to be consistent, and refusing here would be refusing to sort a table
 * because one row is wrong. */
static int decimal_order(const char *a, const char *b)
{
    int64_t ua, ub;
    int     sa, sb;
    bool    da = bta_decimal_from_text(a, &ua, &sa);
    bool    db = bta_decimal_from_text(b, &ub, &sb);

    if (!da || !db) {
        if (da != db)
            return da ? -1 : 1;
        int by_text = strcmp(a, b);
        return by_text < 0 ? -1 : by_text > 0 ? 1 : 0;
    }

    /*
     * Brought to a common place before comparing, in 128 bits so the widening
     * cannot overflow: 19.9 and 19.90 are the same number written two ways, and
     * a comparison that said otherwise would make a sort depend on how somebody
     * typed it.
     */
    int wide = sa > sb ? sa : sb;
    __int128 la = (__int128)ua;
    __int128 lb = (__int128)ub;

    for (int i = sa; i < wide; i++) la *= 10;
    for (int i = sb; i < wide; i++) lb *= 10;

    return la < lb ? -1 : la > lb ? 1 : 0;
}

/*
 * sqlite hands a pointer and a length, and `bta_decimal_from_text` wants a
 * terminator, so the bytes are copied -- into a stack buffer when they fit,
 * which a decimal always does (twenty digits and a point at the very most), and
 * onto the heap when they do not.
 *
 * **Not truncated**, which is the part worth the buffer: a collation has to be a
 * consistent *total* order, since sqlite uses it to build and search indexes.
 * Two long strings cut to the same 63 bytes would compare equal, and an index
 * built on an order that is not one is corruption that surfaces as rows that
 * cannot be found.
 */
static char *sized_text(const void *bytes, int len, char *stack, size_t room)
{
    size_t n = len > 0 ? (size_t)len : 0;

    if (!bytes || n == 0) {
        stack[0] = 0;
        return stack;
    }
    if (n < room) {
        memcpy(stack, bytes, n);
        stack[n] = 0;
        return stack;
    }
    return g_strndup(bytes, n);
}

static int decimal_collation(void *unused, int na, const void *a,
                             int nb, const void *b)
{
    char  sa[48], sb[48];
    char *ta = sized_text(a, na, sa, sizeof sa);
    char *tb = sized_text(b, nb, sb, sizeof sb);
    int   r  = decimal_order(ta, tb);

    if (ta != sa) g_free(ta);
    if (tb != sb) g_free(tb);
    return r;
}

/* `decimal_cmp(a, b)` -- the same answer as a value, for a query that wants to
 * order by something computed rather than by a column. */
static void decimal_cmp_fn(sqlite3_context *c, int argc, sqlite3_value **argv)
{
    const char *a = (const char *)sqlite3_value_text(argv[0]);
    const char *b = (const char *)sqlite3_value_text(argv[1]);

    if (!a || !b) {
        sqlite3_result_null(c);
        return;
    }
    sqlite3_result_int(c, decimal_order(a, b));
}

/*
 * `decimal_sum(x)` -- a total that never passes through a double.
 *
 * Accumulated as an integer count of the widest place seen so far, in 128 bits.
 * The widest place is decided as the rows arrive rather than in advance, because
 * a column of `NUMERIC(12,2)` may still hold one row somebody wrote with three
 * places, and a total that dropped it would be short by a tenth of a cent
 * without saying so.
 *
 * **A window function and not only an aggregate.** Every one of sqlite's own
 * thirty-three aggregates is a window function -- `pragma_function_list` says
 * `type='w'` for all of them -- and the first version of this was registered
 * with `sqlite3_create_function`, which makes a plain aggregate: `decimal_sum(p)
 * OVER (ORDER BY p)` answered *"decimal_sum() may not be used as a window
 * function"*. A running total down a column of amounts is most of what a report
 * is, so it takes the four callbacks instead of two.
 *
 * `bad` is a count and not a flag for exactly that reason: a value that is not a
 * decimal may *leave* the frame again, and a flag could never be put back.
 */
typedef struct {
    __int128 units;
    int      scale;
    int      rows;     /* decimals in the frame */
    int      bad;      /* values in it that were not decimals */
} DecSum;

/* One value in or out of the frame.  `sign` is +1 to add and -1 to remove,
 * which is the whole of the difference between xStep and xInverse for a sum. */
static void decimal_sum_move(sqlite3_context *c, sqlite3_value *v, int sign)
{
    DecSum *acc = sqlite3_aggregate_context(c, sizeof *acc);
    if (!acc)
        return;

    if (sqlite3_value_type(v) == SQLITE_NULL)
        return;                       /* SUM ignores nulls, as SQL's does */

    const char *text = (const char *)sqlite3_value_text(v);
    int64_t     units;
    int         scale;

    if (!text || !bta_decimal_from_text(text, &units, &scale)) {
        acc->bad += sign;
        return;
    }

    /*
     * Brought to the accumulator's place, which only ever widens. So a value
     * leaving the frame is removed at the width the total is held at rather than
     * at its own -- exact either way, and it means a running total can be
     * written with more places than the rows currently in the frame have.
     */
    __int128 move = (__int128)units;
    if (scale > acc->scale) {
        for (int i = acc->scale; i < scale; i++) acc->units *= 10;
        acc->scale = scale;
    } else {
        for (int i = scale; i < acc->scale; i++) move *= 10;
    }
    acc->units += sign > 0 ? move : -move;
    acc->rows  += sign;
}

static void decimal_sum_step(sqlite3_context *c, int argc, sqlite3_value **argv)
{
    decimal_sum_move(c, argv[0], 1);
}

static void decimal_sum_inverse(sqlite3_context *c, int argc,
                                sqlite3_value **argv)
{
    decimal_sum_move(c, argv[0], -1);
}

/* The total as it stands.  Both xFinal and xValue: there is nothing to release,
 * since the accumulator is sqlite's own memory, so "the answer" and "the answer
 * so far" are the same function. */
static void decimal_sum_answer(sqlite3_context *c)
{
    DecSum *acc = sqlite3_aggregate_context(c, 0);

    /* Nothing in the frame at all: NULL, which is what SUM answers and not
     * zero -- "nothing was added up" and "the total is nothing" are different
     * things, and `total()` is sqlite's name for the other one. */
    if (!acc || (acc->rows == 0 && acc->bad == 0)) {
        sqlite3_result_null(c);
        return;
    }
    if (acc->bad) {
        sqlite3_result_error(c, "decimal_sum: a value in that column is not a "
                                "decimal", -1);
        return;
    }
    if (acc->units > (__int128)INT64_MAX || acc->units < (__int128)INT64_MIN) {
        sqlite3_result_error(c, "decimal_sum: the total does not fit in a "
                                "decimal", -1);
        return;
    }

    char *text = bta_decimal_to_text((int64_t)acc->units, acc->scale);
    sqlite3_result_text(c, text, -1, SQLITE_TRANSIENT);
    g_free(text);
}

/*
 * Registered on every connection: a collation a schema may name, and the two
 * things the collation cannot cover.
 *
 * What it does **not** add, and each for a reason rather than an omission:
 *
 *   decimal_avg    an exact average of decimals is not a decimal -- 118.25 over
 *                  three has no text -- so it would have to round, and to how
 *                  many places is the caller's decision and not this function's.
 *                  `decimal_sum` and a `Decimal` division is the honest form.
 *   decimal_total  sqlite's `total()` is `sum()` answering 0 instead of NULL for
 *                  no rows. One `?? "0.00"` in the program says the same thing.
 *   median, percentile
 *                  sqlite's own refuse a text column outright (*"input to
 *                  median() is not numeric"*), which is a loud failure and not a
 *                  wrong answer -- so there is nothing here to rescue.
 */
static void install_decimal(sqlite3 *db)
{
    sqlite3_create_collation(db, "DECIMAL", SQLITE_UTF8, NULL,
                             decimal_collation);
    sqlite3_create_function(db, "decimal_cmp", 2,
                            SQLITE_UTF8 | SQLITE_DETERMINISTIC, NULL,
                            decimal_cmp_fn, NULL, NULL);
    sqlite3_create_window_function(db, "decimal_sum", 1,
                                   SQLITE_UTF8 | SQLITE_DETERMINISTIC, NULL,
                                   decimal_sum_step, decimal_sum_answer,
                                   decimal_sum_answer, decimal_sum_inverse,
                                   NULL);
}

/* ------------------------------------------------------------------ binding */

/*
 * One value into one parameter.
 *
 * The order of the tests is the whole of it: a Decimal is an object and would
 * otherwise be asked for a number, which is where the cent goes.
 *
 * A bind either lands or the statement must not run: sqlite leaves a failed
 * parameter NULL, which is a wrong answer rather than an error.
 */
static bool bind_ok(JSContext *ctx, sqlite3_stmt *st, int rc, int at)
{
    if (rc == SQLITE_OK)
        return true;
    JS_ThrowInternalError(ctx, "cannot bind parameter %d: %s", at,
                          sqlite3_errmsg(sqlite3_db_handle(st)));
    return false;
}

static bool bind_one(JSContext *ctx, sqlite3_stmt *st, int at, JSValueConst v)
{
    if (JS_IsUndefined(v) || JS_IsNull(v))
        return bind_ok(ctx, st, sqlite3_bind_null(st, at), at);
    if (JS_IsBool(v))
        return bind_ok(ctx, st,
                       sqlite3_bind_int(st, at, JS_ToBool(ctx, v) ? 1 : 0), at);

    /* A `Bytes` as a BLOB, which is the one storage class this driver used to
     * refuse in both directions -- there was no value to carry it. Before the
     * string test, because a Bytes is an object and `JS_ToCString` would answer
     * `Bytes(1234)` and store *that*. */
    size_t         blob_len = 0;
    const uint8_t *blob     = bta_bytes_get(v, &blob_len);

    if (blob) {
        /* The length a bind takes is an int: anything past it would truncate
         * into a shorter value, which is a wrong length rather than an error. */
        if (blob_len > (size_t)INT_MAX) {
            JS_ThrowRangeError(ctx, "parameter %d is too large to bind", at);
            return false;
        }
        return bind_ok(ctx, st,
                       sqlite3_bind_blob(st, at, blob, (int)blob_len,
                                         SQLITE_TRANSIENT),
                       at);
    }

    /* A Decimal as its own text, before anything can turn it into a double. */
    int64_t units;
    int     scale;
    int     is_decimal = bta_decimal_parts(ctx, v, -1, &units, &scale);

    if (is_decimal < 0)
        return false;                      /* an exception is already pending */
    if (is_decimal > 0) {
        const char *s = JS_ToCString(ctx, v);
        if (!s)
            return false;
        int rc = sqlite3_bind_text(st, at, s, -1, SQLITE_TRANSIENT);
        JS_FreeCString(ctx, s);
        return bind_ok(ctx, st, rc, at);
    }

    if (JS_IsString(v)) {
        const char *s = JS_ToCString(ctx, v);
        if (!s)
            return false;
        int rc = sqlite3_bind_text(st, at, s, -1, SQLITE_TRANSIENT);
        JS_FreeCString(ctx, s);
        return bind_ok(ctx, st, rc, at);
    }

    if (JS_IsNumber(v)) {
        double d;
        if (JS_ToFloat64(ctx, &d, v))
            return false;

        /*
         * A whole number binds as an INTEGER and not as a REAL, because
         * sqlite's two are different storage classes: a rowid written as `3.0`
         * is a REAL that no `WHERE id = 3` finds. 2^53 is where a double stops
         * being able to tell whole numbers apart, so past it the value is
         * already approximate and REAL is the honest column.
         */
        if (isfinite(d) && d == trunc(d) && fabs(d) < 9007199254740992.0)
            return bind_ok(ctx, st, sqlite3_bind_int64(st, at, (int64_t)d), at);
        return bind_ok(ctx, st, sqlite3_bind_double(st, at, d), at);
    }

    JS_ThrowTypeError(ctx, "parameter %d is %s, and a column holds text, a "
                           "number, a boolean, a Decimal, a Bytes or nothing",
                      at, JS_IsArray(v) ? "a list" : "an object");
    return false;
}

/* The parameters, as a list.  Absent is none, which is what a statement with no
 * `?` in it wants. */
static bool bind_params(JSContext *ctx, sqlite3_stmt *st, JSValueConst params,
                        const char *sql)
{
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

    /*
     * Counted before anything is bound. sqlite binds what it is given and
     * leaves the rest NULL, so three values into a statement with four `?`
     * runs and quietly answers about a NULL -- which is a wrong answer rather
     * than an error, and the worst kind of both.
     */
    int wants = sqlite3_bind_parameter_count(st);
    if ((int)n != wants) {
        JS_ThrowRangeError(ctx, "the statement takes %d parameter%s and was "
                                "given %u -- in: %s",
                           wants, wants == 1 ? "" : "s", n, sql);
        return false;
    }

    for (uint32_t i = 0; i < n; i++) {
        JSValue v  = JS_GetPropertyUint32(ctx, params, i);
        bool    ok = bind_one(ctx, st, (int)i + 1, v);
        JS_FreeValue(ctx, v);
        if (!ok)
            return false;
    }
    return true;
}

/* One text column of a statement of our own, where a NULL is not expected but
 * `JS_NewString(NULL)` would be a dereference rather than a wrong answer.  A
 * column with no declared type is `''` and not NULL, which is the case this is
 * really about. */
static JSValue text_at(JSContext *ctx, sqlite3_stmt *st, int at)
{
    const unsigned char *s = sqlite3_column_text(st, at);
    return JS_NewString(ctx, s ? (const char *)s : "");
}

/* -------------------------------------------------------------------- rows */

/* One column's value. All five storage classes now: the BLOB used to be refused
 * because there was nothing to put it in. */
static JSValue column_value(JSContext *ctx, sqlite3_stmt *st, int i)
{
    switch (sqlite3_column_type(st, i)) {
    case SQLITE_NULL:
        return JS_NULL;

    case SQLITE_INTEGER:
        /* Int64, so a rowid past 2^31 is itself. QuickJS widens to a double
         * when it has to, which is the same ceiling JSON has. */
        return JS_NewInt64(ctx, sqlite3_column_int64(st, i));

    case SQLITE_FLOAT:
        return JS_NewFloat64(ctx, sqlite3_column_double(st, i));

    case SQLITE_TEXT: {
        const unsigned char *s = sqlite3_column_text(st, i);
        return JS_NewString(ctx, s ? (const char *)s : "");
    }

    default: {
        /*
         * A BLOB, as `Bytes`. It used to be refused rather than mangled -- a
         * BLOB handed back as a string is corruption that reads like success --
         * and refusing was right for exactly as long as there was no value to
         * hand back.
         *
         * **`sqlite3_column_blob` before `_bytes`**, which is sqlite's own
         * rule: the pointer has to be asked for first, or the length can be
         * answered for a converted value instead of the stored one. And the
         * bytes belong to the statement until the next `step`, which is why
         * `bta_bytes_new` copies.
         */
        const void *blob = sqlite3_column_blob(st, i);
        int         len  = sqlite3_column_bytes(st, i);

        return bta_bytes_new(ctx, blob, blob && len > 0 ? (size_t)len : 0);
    }
    }
}

/*
 * One row, as a plain object keyed by the column names the statement produced.
 *
 * Plain and not a record: which record a row fills is `rad.js`'s question, and
 * `SELECT count(*)` fills none.
 */
static JSValue row_object(JSContext *ctx, sqlite3_stmt *st, int cols)
{
    JSValue row = JS_NewObject(ctx);

    for (int i = 0; i < cols; i++) {
        JSValue v = column_value(ctx, st, i);

        if (JS_IsException(v)) {
            JS_FreeValue(ctx, row);
            return JS_EXCEPTION;
        }
        JS_SetPropertyStr(ctx, row, sqlite3_column_name(st, i), v);
    }
    return row;
}

/*
 * Prepared, and refusing a statement with another one behind it.
 *
 * sqlite compiles up to the first `;` and hands back the rest; running only the
 * head of what it was given and reporting success is the shape of bug this says
 * no to. A script is `Script()`, which says so in its name.
 */
static sqlite3_stmt *prepare_one(JSContext *ctx, BtaConn *c, const char *sql)
{
    sqlite3_stmt *st   = NULL;
    const char   *tail = NULL;

    if (sqlite3_prepare_v2(c->db, sql, -1, &st, &tail) != SQLITE_OK) {
        throw_sqlite(ctx, c, "cannot prepare", sql);
        return NULL;
    }
    if (!st) {
        JS_ThrowTypeError(ctx, "that is not a statement: %s", sql);
        return NULL;
    }
    while (tail && *tail && g_ascii_isspace(*tail))
        tail++;
    if (tail && *tail) {
        sqlite3_finalize(st);
        JS_ThrowTypeError(ctx, "one statement at a time here -- there is "
                               "another after it, and Script() is what runs "
                               "several");
        return NULL;
    }
    return st;
}

/* ----------------------------------------------------------------- Query */

static JSValue conn_query(JSContext *ctx, JSValueConst this_val,
                          int argc, JSValueConst *argv)
{
    BtaConn *c = conn_of(ctx, this_val);
    if (!c)
        return JS_EXCEPTION;

    /*
     * QuickJS pads argv up to the arity the table declares, so a missing
     * argument arrives as `undefined` and would reach sqlite as the literal
     * word -- `no such column: undefined`, which is a complaint about the
     * wrong thing.
     */
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "this takes a statement");

    const char *sql = JS_ToCString(ctx, argv[0]);
    if (!sql)
        return JS_EXCEPTION;

    sqlite3_stmt *st = prepare_one(ctx, c, sql);
    if (!st) {
        JS_FreeCString(ctx, sql);
        return JS_EXCEPTION;
    }
    if (!bind_params(ctx, st, argc > 1 ? argv[1] : JS_UNDEFINED, sql)) {
        sqlite3_finalize(st);
        JS_FreeCString(ctx, sql);
        return JS_EXCEPTION;
    }

    JSValue  out  = JS_NewArray(ctx);
    int      cols = sqlite3_column_count(st);
    uint32_t at   = 0;
    int      rc;

    while ((rc = sqlite3_step(st)) == SQLITE_ROW) {
        JSValue row = row_object(ctx, st, cols);

        if (JS_IsException(row)) {
            JS_FreeValue(ctx, out);
            sqlite3_finalize(st);
            JS_FreeCString(ctx, sql);
            return JS_EXCEPTION;
        }
        JS_SetPropertyUint32(ctx, out, at++, row);
    }

    if (rc != SQLITE_DONE) {
        JS_FreeValue(ctx, out);
        JSValue e = throw_sqlite(ctx, c, "cannot read", sql);
        sqlite3_finalize(st);
        JS_FreeCString(ctx, sql);
        return e;
    }

    sqlite3_finalize(st);
    JS_FreeCString(ctx, sql);
    return out;
}

/* --------------------------------------------------------------- Execute */

static JSValue conn_execute(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
    BtaConn *c = conn_of(ctx, this_val);
    if (!c)
        return JS_EXCEPTION;

    /*
     * QuickJS pads argv up to the arity the table declares, so a missing
     * argument arrives as `undefined` and would reach sqlite as the literal
     * word -- `no such column: undefined`, which is a complaint about the
     * wrong thing.
     */
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "this takes a statement");

    const char *sql = JS_ToCString(ctx, argv[0]);
    if (!sql)
        return JS_EXCEPTION;

    sqlite3_stmt *st = prepare_one(ctx, c, sql);
    if (!st) {
        JS_FreeCString(ctx, sql);
        return JS_EXCEPTION;
    }
    if (!bind_params(ctx, st, argc > 1 ? argv[1] : JS_UNDEFINED, sql)) {
        sqlite3_finalize(st);
        JS_FreeCString(ctx, sql);
        return JS_EXCEPTION;
    }

    /* Stepped to the end even for a statement that returns rows: an
     * `INSERT ... RETURNING` is an Execute somebody wrote, and stopping at the
     * first row would leave the rest of the work undone. */
    int rc;
    while ((rc = sqlite3_step(st)) == SQLITE_ROW)
        ;

    if (rc != SQLITE_DONE) {
        JSValue e = throw_sqlite(ctx, c, "cannot run", sql);
        sqlite3_finalize(st);
        JS_FreeCString(ctx, sql);
        return e;
    }
    sqlite3_finalize(st);
    JS_FreeCString(ctx, sql);

    /*
     * What the caller cannot find out any other way. `Changes` is how a save
     * knows an UPDATE matched a row rather than silently touching none, and
     * `LastId` is the key an INSERT just made -- which is what a record whose
     * key was still at 0 has to be told.
     */
    JSValue out = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, out, "Changes",
                      JS_NewInt32(ctx, sqlite3_changes(c->db)));
    JS_SetPropertyStr(ctx, out, "LastId",
                      JS_NewInt64(ctx, sqlite3_last_insert_rowid(c->db)));
    return out;
}

/* ---------------------------------------------------------------- Script */

/*
 * Several statements and no parameters -- a schema, which is what this is for.
 * The two halves of `Execute` are deliberately not available at once: a
 * statement with values in it is bound, and a script has no values.
 */
static JSValue conn_script(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv)
{
    BtaConn *c = conn_of(ctx, this_val);
    if (!c)
        return JS_EXCEPTION;

    /*
     * QuickJS pads argv up to the arity the table declares, so a missing
     * argument arrives as `undefined` and would reach sqlite as the literal
     * word -- `no such column: undefined`, which is a complaint about the
     * wrong thing.
     */
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "this takes a statement");

    const char *sql = JS_ToCString(ctx, argv[0]);
    if (!sql)
        return JS_EXCEPTION;

    char *said = NULL;
    int   rc   = sqlite3_exec(c->db, sql, NULL, NULL, &said);

    if (rc != SQLITE_OK) {
        JSValue e = JS_ThrowInternalError(ctx, "cannot run the script: %s",
                                          said ? said : sqlite3_errmsg(c->db));
        sqlite3_free(said);
        JS_FreeCString(ctx, sql);
        return e;
    }
    sqlite3_free(said);
    JS_FreeCString(ctx, sql);
    return JS_UNDEFINED;
}

/* ----------------------------------------------------------- Transaction */

/*
 * A unit of work: everything, or nothing.
 *
 * Nested through savepoints rather than refused, because the caller who wants
 * one is rarely the caller who already has one -- a `Table.Save` that writes a
 * header and its lines is right to ask for a transaction whether or not the
 * program had already opened one, and refusing would make the inner call the
 * thing that has to know about the outer.
 */
static JSValue conn_transaction(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
    BtaConn *c = conn_of(ctx, this_val);
    if (!c)
        return JS_EXCEPTION;

    if (!JS_IsFunction(ctx, argv[0]))
        return JS_ThrowTypeError(ctx, "Transaction expects a function: what to "
                                      "do, all of it or none");

    bool  nested = c->depth > 0;
    char *begin  = nested ? g_strdup_printf("SAVEPOINT bta_%d", c->depth)
                          : g_strdup("BEGIN");
    char *ok     = nested ? g_strdup_printf("RELEASE bta_%d", c->depth)
                          : g_strdup("COMMIT");
    char *undo   = nested ? g_strdup_printf("ROLLBACK TO bta_%d", c->depth)
                          : g_strdup("ROLLBACK");

    if (sqlite3_exec(c->db, begin, NULL, NULL, NULL) != SQLITE_OK) {
        JSValue e = throw_sqlite(ctx, c, "cannot begin", NULL);
        g_free(begin); g_free(ok); g_free(undo);
        return e;
    }
    c->depth++;

    JSValue r = JS_Call(ctx, argv[0], JS_UNDEFINED, 0, NULL);

    c->depth--;

    /*
     * The callback may have closed the connection -- `Close()` inside a
     * transaction is odd and it is reachable, and finishing the unit of work on
     * a handle that is gone is a dereference of NULL rather than an error.
     * There is nothing left to commit or roll back: sqlite3_close on an open
     * transaction rolls it back itself.
     */
    if (!c->db) {
        g_free(begin); g_free(ok); g_free(undo);
        if (JS_IsException(r))
            return r;
        JS_FreeValue(ctx, r);
        return JS_ThrowTypeError(ctx, "the connection was closed inside its "
                                      "own transaction, so there was nothing "
                                      "left to commit");
    }

    if (JS_IsException(r)) {
        /*
         * The exception is kept and put back: rolling back runs SQL of its own,
         * and anything that touches the context can replace what is pending --
         * so the program would be told the rollback failed instead of what
         * actually went wrong.
         */
        JSValue held = JS_GetException(ctx);
        sqlite3_exec(c->db, undo, NULL, NULL, NULL);
        g_free(begin); g_free(ok); g_free(undo);
        return JS_Throw(ctx, held);
    }

    if (sqlite3_exec(c->db, ok, NULL, NULL, NULL) != SQLITE_OK) {
        JSValue e = throw_sqlite(ctx, c, "cannot commit", NULL);
        sqlite3_exec(c->db, undo, NULL, NULL, NULL);
        JS_FreeValue(ctx, r);
        g_free(begin); g_free(ok); g_free(undo);
        return e;
    }
    g_free(begin); g_free(ok); g_free(undo);
    return r;
}

/* ------------------------------------------------------ what is in there */

static JSValue conn_get_tables(JSContext *ctx, JSValueConst this_val)
{
    BtaConn *c = conn_of(ctx, this_val);
    if (!c)
        return JS_EXCEPTION;

    /* Views included: a form over a view is a form over data, and which of the
     * two a name is is not something a query has to care about. sqlite's own
     * tables are not the application's. */
    const char *sql =
        "SELECT name FROM sqlite_master WHERE type IN ('table','view') "
        "AND name NOT LIKE 'sqlite_%' ORDER BY name";

    sqlite3_stmt *st = NULL;
    if (sqlite3_prepare_v2(c->db, sql, -1, &st, NULL) != SQLITE_OK)
        return throw_sqlite(ctx, c, "cannot list the tables", NULL);

    JSValue  out = JS_NewArray(ctx);
    uint32_t at  = 0;

    while (sqlite3_step(st) == SQLITE_ROW)
        JS_SetPropertyUint32(ctx, out, at++, text_at(ctx, st, 0));
    sqlite3_finalize(st);
    return out;
}

/*
 * A table's columns: `{ Name, Type, Required, Key }` each.
 *
 * This is the half of the plan that makes stage 2 pay -- a `.record` derived
 * from a table is a shape nobody had to write out -- so it answers in the words
 * a `Field` uses (`Required`, not `notnull`) rather than in `PRAGMA`'s.
 */
static JSValue conn_columns(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
    BtaConn *c = conn_of(ctx, this_val);
    if (!c)
        return JS_EXCEPTION;

    if (argc < 1)
        return JS_ThrowTypeError(ctx, "Columns expects the name of a table");

    const char *table = JS_ToCString(ctx, argv[0]);
    if (!table)
        return JS_EXCEPTION;

    /*
     * The one identifier that reaches SQL as text, because a PRAGMA takes no
     * parameters -- so it goes through sqlite's own quoting and not through
     * concatenation. `%Q` is the single-quoted literal form, escapes included.
     */
    char *sql = sqlite3_mprintf("PRAGMA table_info(%Q)", table);
    JS_FreeCString(ctx, table);
    if (!sql)
        return JS_ThrowOutOfMemory(ctx);

    sqlite3_stmt *st = NULL;
    if (sqlite3_prepare_v2(c->db, sql, -1, &st, NULL) != SQLITE_OK) {
        JSValue e = throw_sqlite(ctx, c, "cannot read the columns", NULL);
        sqlite3_free(sql);
        return e;
    }
    sqlite3_free(sql);

    JSValue  out = JS_NewArray(ctx);
    uint32_t at  = 0;

    while (sqlite3_step(st) == SQLITE_ROW) {
        JSValue col = JS_NewObject(ctx);
        /* PRAGMA table_info: cid, name, type, notnull, dflt_value, pk */
        JS_SetPropertyStr(ctx, col, "Name", text_at(ctx, st, 1));
        JS_SetPropertyStr(ctx, col, "Type", text_at(ctx, st, 2));
        JS_SetPropertyStr(ctx, col, "Required",
                          JS_NewBool(ctx, sqlite3_column_int(st, 3) != 0));
        /* `pk` is the position in the key and not a flag, so a compound key
         * says 1, 2, 3 -- and the order is part of the answer. */
        JS_SetPropertyStr(ctx, col, "Key",
                          JS_NewInt32(ctx, sqlite3_column_int(st, 5)));
        JS_SetPropertyUint32(ctx, out, at++, col);
    }
    sqlite3_finalize(st);
    return out;
}

/* ------------------------------------------------------------------ Close */

static JSValue conn_close(JSContext *ctx, JSValueConst this_val,
                          int argc, JSValueConst *argv)
{
    BtaConn *c = JS_GetOpaque2(ctx, this_val, bta_sqlite_class_id);
    if (!c)
        return JS_EXCEPTION;

    /* Closing twice is not an error: it is what a program does in a handler
     * that may run after another one already did. */
    if (c->db) {
        sqlite3_close(c->db);
        c->db    = NULL;
        c->depth = 0;
    }
    return JS_UNDEFINED;
}

/*
 * The three facts `Table` cannot hardcode, answered by the driver.
 *
 * `Placeholder` is what a bound value looks like in a statement; `%d` in it is
 * the one-based position, so sqlite's `?` ignores it and PostgreSQL's `$%d`
 * uses it.  `Quote` is what goes around an identifier.  `NewKey` is how the key
 * of a row that was just inserted comes back -- `"LastId"` when the driver
 * reports it (this one), `"Returning"` when the statement has to ask for it.
 *
 * Fresh each time rather than cached: it is read once per statement built, not
 * per row, and a frozen object handed out would be one a program could keep and
 * a driver could not change.
 */
static JSValue conn_get_dialect(JSContext *ctx, JSValueConst this_val)
{
    JSValue d = JS_NewObject(ctx);

    JS_SetPropertyStr(ctx, d, "Placeholder", JS_NewString(ctx, "?"));
    JS_SetPropertyStr(ctx, d, "Quote",       JS_NewString(ctx, "\""));
    JS_SetPropertyStr(ctx, d, "NewKey",      JS_NewString(ctx, "LastId"));
    return d;
}

/* This driver's own, and not part of what a driver has to answer: a database
 * reached over a socket has no path. */
static JSValue conn_get_path(JSContext *ctx, JSValueConst this_val)
{
    BtaConn *c = JS_GetOpaque2(ctx, this_val, bta_sqlite_class_id);
    if (!c)
        return JS_EXCEPTION;
    return JS_NewString(ctx, c->path ? c->path : "");
}

static JSValue conn_get_open(JSContext *ctx, JSValueConst this_val)
{
    BtaConn *c = JS_GetOpaque2(ctx, this_val, bta_sqlite_class_id);
    if (!c)
        return JS_EXCEPTION;
    return JS_NewBool(ctx, c->db != NULL);
}

/* --------------------------------------------------------- Database.Sqlite */

static JSValue database_sqlite(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv)
{
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "Database.Sqlite expects a path -- or "
                                      "\":memory:\" for a database that lasts "
                                      "as long as the program");

    const char *path = bta_file_path(ctx, argv[0], "Database.Sqlite");
    if (!path)
        return JS_EXCEPTION;

    sqlite3 *db = NULL;
    /*
     * Created when it is not there, which is sqlite's own behaviour and what an
     * application wants the first time it runs. The cost is that a mistyped
     * path is an empty database rather than a complaint, and the message that
     * follows is `no such table` -- worth knowing when that is what you get.
     */
    int rc = sqlite3_open_v2(path, &db,
                             SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, NULL);

    if (rc != SQLITE_OK) {
        JSValue e = JS_ThrowInternalError(ctx, "cannot open %s: %s", path,
                                          db ? sqlite3_errmsg(db)
                                             : sqlite3_errstr(rc));
        sqlite3_close(db);
        JS_FreeCString(ctx, path);
        return e;
    }

    /* On, because the whole point of declaring a shape is that something
     * enforces it, and sqlite leaves foreign keys off for compatibility with
     * files written before it had them. */
    sqlite3_exec(db, "PRAGMA foreign_keys = ON", NULL, NULL, NULL);

    /*
     * Five seconds of retrying a locked file instead of failing on the first
     * attempt. Two windows of the same application over one file is the
     * ordinary case, and without this the second one's write is an immediate
     * `database is locked`.
     */
    sqlite3_busy_timeout(db, 5000);

    /* Before anything can be asked of the database, so no statement is ever
     * compiled against a connection that does not know how to order a
     * decimal. */
    install_decimal(db);

    BtaConn *c = g_new0(BtaConn, 1);
    c->db   = db;
    c->path = g_strdup(path);
    JS_FreeCString(ctx, path);

    JSValue proto = JS_GetClassProto(ctx, bta_sqlite_class_id);
    JSValue obj   = JS_NewObjectProtoClass(ctx, proto, bta_sqlite_class_id);
    JS_FreeValue(ctx, proto);

    if (JS_IsException(obj)) {
        sqlite3_close(c->db);
        g_free(c->path);
        g_free(c);
        return obj;
    }
    JS_SetOpaque(obj, c);
    return obj;
}

static const JSCFunctionListEntry conn_props[] = {
    JS_CGETSET_DEF("Dialect", conn_get_dialect, NULL),
    JS_CGETSET_DEF("Path",    conn_get_path,    NULL),
    JS_CGETSET_DEF("Open",    conn_get_open,    NULL),
    JS_CGETSET_DEF("Tables",  conn_get_tables,  NULL),
    JS_CFUNC_DEF("Query",       2, conn_query),
    JS_CFUNC_DEF("Execute",     2, conn_execute),
    JS_CFUNC_DEF("Script",      1, conn_script),
    JS_CFUNC_DEF("Transaction", 1, conn_transaction),
    JS_CFUNC_DEF("Columns",     1, conn_columns),
    JS_CFUNC_DEF("Close",       0, conn_close),
};

void bta_sqlite_init(JSContext *ctx, JSValue global)
{
    JSRuntime *rt = JS_GetRuntime(ctx);

    JS_NewClassID(rt, &bta_sqlite_class_id);
    JS_NewClass(rt, bta_sqlite_class_id, &conn_class);

    /*
     * Built **on** the base prototype rather than beside it: that is the one
     * line that puts `rad.js`'s `Table` in this driver's chain and makes
     * `conn instanceof Connection` true of a sqlite connection.
     */
    JSValue base  = bta_connection_proto(ctx);
    JSValue proto = JS_NewObjectProto(ctx, base);
    JS_FreeValue(ctx, base);

    JS_SetPropertyFunctionList(ctx, proto, conn_props,
                               G_N_ELEMENTS(conn_props));
    JS_SetClassProto(ctx, bta_sqlite_class_id, proto);

    bta_database_driver(ctx, "Sqlite", database_sqlite, 1);
}

#else  /* no sqlite at build time */

static JSValue database_sqlite(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv)
{
    return JS_ThrowInternalError(ctx,
        "this runtime was built without sqlite, so there is no database to "
        "open. Install sqlite3's development package and build again -- CMake "
        "finds it with pkg-config and prints which it found");
}

/*
 * The whole of the driver, absent.  `Connection` and `Database` are there
 * either way -- they are bta_database.c's -- so `rad.js` hangs `Table` on the
 * one prototype with nothing to know about this, and the failure lands where a
 * database is opened rather than where the prelude loads.
 */
void bta_sqlite_init(JSContext *ctx, JSValue global)
{
    bta_database_driver(ctx, "Sqlite", database_sqlite, 1);
}

#endif
