/*
 * The debugger, on this side of the engine.
 *
 * `vendor/quickjs` gained four calls and a field (see `JS_SetDebugHandler` in
 * `quickjs.h`); everything that decides anything is here, which is the split
 * the arithmetic patch already demonstrates: the least possible inside the
 * vendor, and the rest as the project's own code.
 *
 * **The program stops by blocking.** The handler writes what happened to the
 * control channel and then sits in a read until it is told to carry on. The
 * window freezes, which is what Visual Basic, Delphi and Gambas all do -- and
 * it is why stopping cannot be a nested main loop: that would re-enter the very
 * program that is stopped. The IDE stays responsive because it is another
 * process.
 *
 * **The channel is two halves of a pipe and not one.** Events go out on
 * descriptor 3, opened by whoever spawned us; commands come in on stdin.
 * stdout is taken -- the program being debugged prints, and that is what the
 * IDE's output pane shows -- and marking protocol lines with a prefix would
 * mean a program that prints the prefix breaks the debugger, silently. A
 * descriptor of its own is the only spelling with no failure mode.
 *
 * **What it costs when nothing is armed.** The handler returns on its first
 * line whenever there is nothing to look for: no breakpoints, not stepping, no
 * pause asked for. Only past that does it work out which line it is on, which
 * is the expensive part -- `find_line_num` walks the function's pc2line table.
 * That is the shape to keep if this is ever made cheaper: the decision to look
 * is free, and looking is not.
 *
 * The protocol is one JSON object per line, in both directions, and is written
 * out in docs/plans/debug-plan.md.
 */

#include "bta.h"

#include <errno.h>
#include <string.h>
#include <unistd.h>

/*
 * `poll` is POSIX and MinGW has no `poll.h` at all.  It is here for one
 * question -- has the IDE said anything while the program ran -- and the whole
 * channel it asks about is Unix: descriptor 3 is opened by the parent and
 * `Exec`'s `Control` is refused on Windows for exactly that reason.  So the
 * question is asked where it can be answered, and `bta_debug_start` says out
 * loud that `--debug` is not available there.
 */
#ifndef G_OS_WIN32
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#endif

/* Where events go.  Descriptor 3 by convention: 0, 1 and 2 are spoken for. */
#define CONTROL_FD 3

/* What the program is doing between stops. */
typedef enum {
    RUN,                /* until something armed says otherwise */
    STEP_INTO,          /* the next line, wherever it is */
    STEP_OVER,          /* the next line at this depth or above */
    STEP_OUT,           /* the next line above this depth */
    PAUSE,              /* the next line at all */
} BtaRunMode;

struct BtaBreakStruct {
    char *file;         /* as the project sees it, which is what a `.js` was loaded as */
    int   asked;        /* the line the programmer clicked */
    int   line;         /* where it really stops: the first one at or after it */
    int   id;           /* the IDE's, echoed back so it can tell them apart */
    char *when;         /* a condition, or NULL */
    char *log;          /* an expression to record and not stop on, or NULL */
    bool  one_shot;     /* run-to-cursor: takes itself out when it is reached */
    int   hits;         /* passes so far that met the condition */
    char  hit_op;       /* '=' the nth only, '>' from the nth on, '%' every nth; 0 none */
    int   hit_n;
};

static struct {
    bool        on;             /* --debug was given */
    bool        attached;       /* the channel is open */
    JSContext  *ctx;
    GPtrArray  *breaks;         /* BtaBreak* */
    GHashTable *lines;          /* a project file -> the lines it can stop on */
    bool        stop_on_throw;
} dbg;

/*
 * **What belongs to one thread.** The main context and every `Task` worker run
 * JavaScript on threads of their own, each with its own runtime and its own
 * hook, so how a thread is stepping is that thread's -- a step over in a
 * worker says nothing about the window -- and so is whether the debugger is
 * running an expression of its own on it.
 */
typedef struct {
    JSContext  *ctx;            /* the context this thread runs, set by its hook */
    BtaRunMode  mode;
    int         depth;          /* the stack depth a step began at */
    /*
     * True while the debugger is running JavaScript of its own -- an expression
     * from the immediate box, a watch, a breakpoint's condition. Without it the
     * hook fires *inside* that expression and the debugger stops itself, which
     * is a hang with the program's own stack underneath it.
     */
    bool        evaluating;
    gint64      polled;         /* when the channel was last asked, monotonic µs */
    const char *name;           /* a worker's class, said with its stops; NULL on main */
} BtaThread;

static _Thread_local BtaThread here;

/*
 * **One stop at a time, and the stopped thread owns the channel.** A worker
 * that reaches a breakpoint takes `channel_lock`, says where it stopped and
 * reads the IDE's orders itself -- the window keeps running, because its
 * thread never stopped. A second thread that stops meanwhile waits for the
 * first to be continued, so every order the IDE sends is about the last stop
 * it was told of. Recursive, because the owner re-enters it (the orders it
 * reads while stopped, `take_messages` on the main thread).
 *
 * `breaks_lock` is the list of breakpoints and each one's counters: the owner
 * of the channel changes the list while the other threads' hooks read it.
 * `emit_lock` keeps two threads' lines whole on descriptor 3.
 */
static GRecMutex channel_lock;
static GRecMutex breaks_lock;
static GMutex    emit_lock;

/*
 * **Workers alive under the debugger, and why the main thread reads the list
 * without its lock when there are none.** A lock per new line cost 8% of a
 * tight loop with a breakpoint armed elsewhere (`Debug`, 800 -> 865 ms over
 * three million turns, measured), paid by every program whether it has a
 * `Task` or not. The list is changed only by the thread that owns the channel,
 * and with no worker that is the main thread itself; a worker can become the
 * owner only after it exists, compiles, stops and is sent an order -- which
 * takes the IDE a round trip, against the nanoseconds of one unlocked read.
 * The workers always take it.
 */
static gint debug_workers;


/*
 * How often a running program asks the IDE whether it said anything. Asking at
 * every new line was a `poll` per line: half of what a loop paid under the IDE
 * with nothing armed (14 -> 423 ms, measured; see docs/agents/profiling.md). A
 * *Pause* that waits 5 ms is one nobody can see.
 */
#define POLL_EVERY_US 5000

/* Declared here because `bta_debug_compiled` is the entry point and reads like
 * one: what a file just compiled means for the breakpoints already armed is the
 * first thing to read, and the machinery it uses is below it. */
static int  bta_cmp_int(const void *a, const void *b);
static void free_break(gpointer p);
static int  resolve_line(const char *file, int line);
static bool path_is(const char *path, const char *file);
static void emit_object(JSContext *ctx, JSValue object);
typedef struct BtaBreakStruct BtaBreak;
static void say_armed(JSContext *ctx, BtaBreak *bp);
static void say_refused(JSContext *ctx, BtaBreak *bp);

/* --------------------------------------------------------- what can be hit */

/*
 * The lines a file can stop on, learnt as it is compiled.
 *
 * QuickJS emits a pc2line entry where the line *changes*, so two statements it
 * runs together share one and `let total = 0;` right under `function Main() {`
 * has none of its own. A breakpoint there would arm and never fire, silently --
 * which is the one failure a debugger must not have. Knowing the set is what
 * lets a breakpoint be **moved to the next line that exists**, the way every
 * editor does, and what lets the IDE be told where it really went.
 */
void bta_debug_compiled(JSContext *ctx, const char *path, JSValueConst compiled)
{
    JSValue  lines;
    GArray  *set;
    uint32_t i, n = 0;
    JSValue  len;

    /* The main context's compiles only: a worker compiles the files the main
     * thread already did (the task's class is a project file), and this table
     * is not the worker's to write while the main hook reads it. */
    if (!dbg.on || ctx != dbg.ctx)
        return;

    lines = JS_DebugLines(ctx, compiled);
    len   = JS_GetPropertyStr(ctx, lines, "length");
    JS_ToUint32(ctx, &n, len);
    JS_FreeValue(ctx, len);

    set = g_array_new(FALSE, FALSE, sizeof(int));
    for (i = 0; i < n; i++) {
        JSValue v = JS_GetPropertyUint32(ctx, lines, i);
        int32_t line = 0;

        JS_ToInt32(ctx, &line, v);
        JS_FreeValue(ctx, v);
        if (line > 0)
            g_array_append_val(set, line);
    }
    JS_FreeValue(ctx, lines);

    g_array_sort(set, (GCompareFunc)bta_cmp_int);
    g_hash_table_insert(dbg.lines, g_strdup(path), set);

    /* Whatever was armed against this file before it existed. */
    g_rec_mutex_lock(&breaks_lock);
    for (guint k = 0; k < dbg.breaks->len; ) {
        BtaBreak *bp = g_ptr_array_index(dbg.breaks, k);
        int       at;

        if (bp->line != bp->asked || !path_is(path, bp->file)) {
            k++;
            continue;
        }
        at = resolve_line(bp->file, bp->asked);
        if (at <= 0) {
            say_refused(ctx, bp);
            g_ptr_array_remove_index(dbg.breaks, k);   /* nowhere to stop */
            continue;
        }
        bp->line = at;
        if (!bp->one_shot)
            say_armed(ctx, bp);
        k++;
    }
    g_rec_mutex_unlock(&breaks_lock);
}

/* ----------------------------------------------------- the functions' spans */

/*
 * Where each function of a file begins and ends, as the parser reports it
 * (fork patch 9's `JS_SYMBOL_SCOPE`): what keeps a breakpoint inside the
 * function it was asked for. The bytecode cannot say it -- the closing brace of
 * a function has no opcode, and the next line that has one is often the next
 * function's own `function b() {` -- so a breakpoint on a closing brace used to
 * arm in the function below.
 *
 * Collected around each compile (`bta_compile` calls the two halves below) and
 * kept per file. **A stack**, because a module compiles the files it imports
 * inside its own compile; and only for the main context, because a `Task`
 * compiles on its own thread and this state is not shared with it.
 */
typedef struct { int first, last; } BtaSpan;

static GPtrArray  *spans_stack;     /* GArray of BtaSpan, one per compile in flight */
static GHashTable *spans;           /* a file -> GArray of BtaSpan */

static void span_seen(void *opaque, JSSymbolKind kind, const char *name,
                      const char *parent, const char *supertype,
                      const char *params, int line, int end_line, const char *doc)
{
    (void)opaque; (void)name; (void)parent; (void)supertype; (void)params; (void)doc;

    if (kind != JS_SYMBOL_SCOPE || end_line < line || !spans_stack || !spans_stack->len)
        return;
    BtaSpan s = { line, end_line };
    g_array_append_val(g_ptr_array_index(spans_stack, spans_stack->len - 1), s);
}

void bta_debug_compile_begin(JSContext *ctx)
{
    if (!dbg.on || ctx != dbg.ctx)
        return;
    if (!spans_stack)
        spans_stack = g_ptr_array_new();
    g_ptr_array_add(spans_stack, g_array_new(FALSE, FALSE, sizeof(BtaSpan)));
    JS_SetSymbolHandler(JS_GetRuntime(ctx), span_seen, NULL);
}

/* A script compile that failed and is about to be tried as a module: what it
 * reported is a parse that broke partway, and spans that end where it broke. */
void bta_debug_compile_retry(JSContext *ctx)
{
    if (!dbg.on || ctx != dbg.ctx || !spans_stack || !spans_stack->len)
        return;
    g_array_set_size(g_ptr_array_index(spans_stack, spans_stack->len - 1), 0);
}

void bta_debug_compile_end(JSContext *ctx, const char *path)
{
    GArray *got;

    if (!dbg.on || ctx != dbg.ctx || !spans_stack || !spans_stack->len)
        return;

    got = g_ptr_array_steal_index(spans_stack, spans_stack->len - 1);
    if (!spans_stack->len)
        JS_SetSymbolHandler(JS_GetRuntime(ctx), NULL, NULL);
    if (!spans)
        spans = g_hash_table_new_full(g_str_hash, g_str_equal, g_free,
                                      (GDestroyNotify)g_array_unref);
    g_hash_table_insert(spans, g_strdup(path), got);
}

/* The innermost function around a line of a file, or NULL. */
static const BtaSpan *span_around(const char *file, int line)
{
    GHashTableIter it;
    gpointer       key, value;
    const BtaSpan *best = NULL;

    if (!spans)
        return NULL;
    g_hash_table_iter_init(&it, spans);
    while (g_hash_table_iter_next(&it, &key, &value)) {
        GArray *set = value;

        if (!path_is(key, file))
            continue;
        for (guint i = 0; i < set->len; i++) {
            const BtaSpan *s = &g_array_index(set, BtaSpan, i);

            if (s->first <= line && line <= s->last &&
                (!best || s->first > best->first ||
                 (s->first == best->first && s->last < best->last)))
                best = s;
        }
        break;
    }
    return best;
}

/*
 * **Whether the engine's path is the file the IDE named: a tail that starts at
 * a path separator, not any tail.** The IDE names a file the way the project
 * does and the engine the way it was loaded, so one is a tail of the other --
 * but a bare suffix made a breakpoint on `Form1.js` stop in `MyForm1.js`, and
 * an empty name match every file there is.
 */
static bool path_is(const char *path, const char *file)
{
    size_t pl = strlen(path), fl = strlen(file);

    if (!fl || fl > pl || strcmp(path + pl - fl, file))
        return false;
    return pl == fl || path[pl - fl - 1] == '/' || path[pl - fl - 1] == '\\';
}

static int bta_cmp_int(const void *a, const void *b)
{
    return *(const int *)a - *(const int *)b;
}

/*
 * Where a breakpoint asked for at `file:line` will really stop.
 *
 * The first line at or after the one asked for, which is what an editor does
 * with a click on a blank line, a comment, or a statement the compiler ran
 * together with the one above it.  `-1` when this file has not been compiled
 * yet, which is the ordinary case: the IDE arms its breakpoints while the
 * program is still stopped at `ready`, before a line of it has been read.
 * Those stay **pending** and are resolved as each file arrives.
 */
static int resolve_line(const char *file, int line)
{
    GHashTableIter it;
    gpointer       key, value;

    g_hash_table_iter_init(&it, dbg.lines);
    while (g_hash_table_iter_next(&it, &key, &value)) {
        const char *path = key;
        GArray     *set  = value;

        /* The IDE names a file the way the project does and the engine names it
           the way it was loaded, so one has to be a tail of the other. */
        if (!path_is(path, file))
            continue;

        /*
         * **Not out of the function it was asked in.** A line past the last
         * one of its function that can stop -- the closing brace, most of all
         * -- goes back to that last one, and is said to have moved like any
         * other -- and the line a function is declared on is one of its own, its
         * first, which is all a one-statement function has. A file with no
         * line that can stop at or after the one asked, outside any function,
         * is a breakpoint with nowhere to go, and is said to be (`refused`).
         */
        const BtaSpan *around = span_around(file, line);
        int            before = 0;

        for (guint i = 0; i < set->len; i++) {
            int at = g_array_index(set, int, i);

            if (at >= line) {
                if (!around || at <= around->last)
                    return at;
                break;
            }
            if (around && at >= around->first)
                before = at;
        }
        if (around)
            return before;      /* 0: nothing in that function can stop */
        return 0;               /* past the last line that can stop */
    }
    return -1;                  /* not compiled yet */
}

static void say_armed(JSContext *ctx, BtaBreak *bp)
{
    JSValue said = JS_NewObject(ctx);

    JS_SetPropertyStr(ctx, said, "event", JS_NewString(ctx, "armed"));
    JS_SetPropertyStr(ctx, said, "id", JS_NewInt32(ctx, bp->id));
    JS_SetPropertyStr(ctx, said, "file", JS_NewString(ctx, bp->file));
    JS_SetPropertyStr(ctx, said, "line", JS_NewInt32(ctx, bp->line));
    JS_SetPropertyStr(ctx, said, "pending", JS_NewBool(ctx, bp->line != bp->asked));
    emit_object(ctx, said);
}

/*
 * A breakpoint with nowhere to stop: past the last line of its file that can,
 * or in a function with no line that can at or before it. Said, because the
 * IDE drew a mark for it -- and a mark beside a line that will never stop is
 * the lie `armed` exists to prevent. It used to be dropped without a word.
 */
static void say_refused_why(JSContext *ctx, BtaBreak *bp, const char *why)
{
    JSValue said = JS_NewObject(ctx);

    JS_SetPropertyStr(ctx, said, "event", JS_NewString(ctx, "refused"));
    JS_SetPropertyStr(ctx, said, "id", JS_NewInt32(ctx, bp->id));
    JS_SetPropertyStr(ctx, said, "file", JS_NewString(ctx, bp->file));
    JS_SetPropertyStr(ctx, said, "line", JS_NewInt32(ctx, bp->asked));
    if (why)
        JS_SetPropertyStr(ctx, said, "why", JS_NewString(ctx, why));
    emit_object(ctx, said);
}

static void say_refused(JSContext *ctx, BtaBreak *bp)
{
    say_refused_why(ctx, bp, NULL);
}

/*
 * A hit count, in the words Visual Studio taught everybody: `5` or `== 5` is
 * the fifth pass only, `>= 5` the fifth and every one after, `% 10` every
 * tenth. Whitespace anywhere, a count of at least one, nothing after it. False
 * for anything else -- which is refused with a sentence, never armed as a
 * breakpoint that silently stops every time.
 */
static bool parse_hits(const char *text, char *op, int *n)
{
    const char *p = text;
    char       *end;
    long        v;

    while (g_ascii_isspace(*p)) p++;
    if (p[0] == '=' && p[1] == '=')      { *op = '='; p += 2; }
    else if (p[0] == '>' && p[1] == '=') { *op = '>'; p += 2; }
    else if (p[0] == '%')                { *op = '%'; p += 1; }
    else                                 { *op = '='; }
    while (g_ascii_isspace(*p)) p++;
    if (!g_ascii_isdigit(*p))
        return false;
    v = strtol(p, &end, 10);
    while (g_ascii_isspace(*end)) end++;
    if (*end || v < 1 || v > G_MAXINT)
        return false;
    *n = (int)v;
    return true;
}

/* Whether this pass -- already counted -- is one the hit count stops on. */
static bool hits_match(const BtaBreak *bp)
{
    switch (bp->hit_op) {
    case '=': return bp->hits == bp->hit_n;
    case '>': return bp->hits >= bp->hit_n;
    case '%': return bp->hits % bp->hit_n == 0;
    default:  return true;
    }
}

/* ------------------------------------------------------------------ writing */

/*
 * **The IDE went away: let the program go, for good.** End of input used to
 * set RUN and leave every breakpoint armed and stop-on-throw on, so the next
 * breakpoint stopped again, tried to say so down a pipe nobody reads, and --
 * with SIGPIPE at its default -- killed the program with signal 13, the code
 * after the breakpoint never run. Measured: a breakpoint in a function called
 * three times, both pipes closed at the first stop. Detached, nothing is armed
 * and nothing is said.
 */
static void unwatch_all(JSContext *ctx);

static void detach(JSContext *ctx)
{
    dbg.attached = false;
    here.mode     = RUN;
    g_rec_mutex_lock(&breaks_lock);
    if (dbg.breaks)
        g_ptr_array_set_size(dbg.breaks, 0);
    g_rec_mutex_unlock(&breaks_lock);
    /* The watched fields are the main context's objects: a worker that found
     * the IDE gone leaves them to the main thread, which finds it gone too. */
    if (ctx == dbg.ctx)
        unwatch_all(ctx);
    if (dbg.stop_on_throw) {
        dbg.stop_on_throw = false;
        JS_DebugStopOnThrow(JS_GetRuntime(ctx), false);
    }
}

/* One order, run as the debugger's own work: `obey` parses JSON and `locals`
 * runs getters, and with stop-on-throw on either one throwing stopped the
 * program *inside the debugger* -- a nested stop, with the reply held back and
 * frame 0 the getter. Measured with a malformed line and with a getter that
 * throws. */
static bool obey(JSContext *ctx, const char *line, int depth_now);

static bool obey_as_debugger(JSContext *ctx, const char *line, int depth_now)
{
    bool was = here.evaluating;

    here.evaluating = true;
    bool done = obey(ctx, line, depth_now);
    here.evaluating = was;
    return done;
}

/*
 * One line out, and a failure that is not fatal.
 *
 * A program run with `--debug` and no channel -- somebody trying it by hand --
 * gets its events on stderr rather than a crash, which is also how a session
 * can be read without an IDE.
 */
static void emit(const char *json)
{
    size_t      len = strlen(json);
    const char *nl  = "\n";

    /*
     * SIGPIPE is held off for these two writes and not ignored for the
     * process: an ignored signal is inherited across `exec`, so every child an
     * `Exec` started under `--debug` would have run with it ignored. Blocked,
     * a write to a closed reader answers EPIPE, the pending signal is taken
     * off the queue, and the mask goes back as it was.
     */
#ifndef G_OS_WIN32
    sigset_t pipe_set, was_set;

    sigemptyset(&pipe_set);
    sigaddset(&pipe_set, SIGPIPE);
    pthread_sigmask(SIG_BLOCK, &pipe_set, &was_set);
#endif
    g_mutex_lock(&emit_lock);
    bool failed = write(CONTROL_FD, json, len) < 0 || write(CONTROL_FD, nl, 1) < 0;
    int  why    = errno;
    g_mutex_unlock(&emit_lock);
#ifndef G_OS_WIN32
    if (failed && why == EPIPE) {
        struct timespec now = { 0, 0 };
        sigtimedwait(&pipe_set, NULL, &now);
    }
    pthread_sigmask(SIG_SETMASK, &was_set, NULL);
#endif
    errno = why;

    if (failed) {
        if (errno == EBADF) {
            fprintf(stderr, "bintana debug: %s\n", json);
            return;
        }
        /* The reader closed its end: the same as end of input, and said the
         * only way left -- the signal was held off above, so this is where it
         * arrives instead. */
        if (errno == EPIPE && (here.ctx || dbg.ctx))
            detach(here.ctx ? here.ctx : dbg.ctx);
    }
}

/* How much of an object is worth putting on one line before it stops being a
 * value and starts being a wall. */
#define RENDER_FIELDS 6
#define RENDER_WIDTH  120

/*
 * A JS value as the one string a debugger can always show.
 *
 * **An object is shown by what is in it**, one level deep, because
 * `[object Object]` is what a debugger shows when it has given up: the whole
 * question at a breakpoint is usually *what is in this thing*. One level and a
 * handful of fields, since a row is one line -- and what is past that is the
 * tree: `openable` says a value has fields, and `say_expand` answers them.
 */
static char *render(JSContext *ctx, JSValueConst value)
{
    const char *s;
    char       *out;

    if (JS_IsString(value)) {
        s   = JS_ToCString(ctx, value);
        out = g_strdup_printf("\"%s\"", s ? s : "");
        JS_FreeCString(ctx, s);
        return out;
    }

    if (JS_IsArray(value)) {
        JSValue  lv = JS_GetPropertyStr(ctx, value, "length");
        uint32_t n = 0, i;
        GString *b;

        JS_ToUint32(ctx, &n, lv);
        JS_FreeValue(ctx, lv);

        b = g_string_new("[");
        for (i = 0; i < n && i < RENDER_FIELDS; i++) {
            JSValue item = JS_GetPropertyUint32(ctx, value, i);
            char   *text = render(ctx, item);

            if (i)
                g_string_append(b, ", ");
            g_string_append(b, text);
            g_free(text);
            JS_FreeValue(ctx, item);
        }
        if (n > RENDER_FIELDS)
            g_string_append_printf(b, ", … %u more", n - RENDER_FIELDS);
        g_string_append_c(b, ']');
        return g_string_free(b, FALSE);
    }

    if (JS_IsFunction(ctx, value)) {
        JSValue nv   = JS_GetPropertyStr(ctx, value, "name");
        const char *n = JS_ToCString(ctx, nv);

        out = g_strdup_printf("function %s()", n && *n ? n : "");
        JS_FreeCString(ctx, n);
        JS_FreeValue(ctx, nv);
        return out;
    }

    /* A plain object, by its own fields. A control or a Record answers here
     * too, which is the case that matters: `{ Name: "Ana", Age: 31 }` rather
     * than the name of its class and nothing else. */
    if (JS_IsObject(value)) {
        JSPropertyEnum *keys = NULL;
        uint32_t        n = 0, i;
        GString        *b;

        if (JS_GetOwnPropertyNames(ctx, &keys, &n, value, JS_GPN_STRING_MASK |
                                   JS_GPN_ENUM_ONLY) < 0) {
            JS_FreeValue(ctx, JS_GetException(ctx));
            keys = NULL;
            n    = 0;
        }

        b = g_string_new("{ ");
        for (i = 0; i < n && i < RENDER_FIELDS; i++) {
            JSValue     item = JS_GetProperty(ctx, value, keys[i].atom);
            const char *name = JS_AtomToCString(ctx, keys[i].atom);
            char       *text;

            if (JS_IsException(item)) {
                JS_FreeValue(ctx, JS_GetException(ctx));
                item = JS_UNDEFINED;
            }
            /* One level: a field that is an object is named and not opened, or
             * a cycle would be a hang rather than a value. */
            text = JS_IsObject(item) && !JS_IsFunction(ctx, item)
                 ? g_strdup(JS_IsArray(item) ? "[…]" : "{…}")
                 : render(ctx, item);

            if (i)
                g_string_append(b, ", ");
            g_string_append_printf(b, "%s: %s", name ? name : "?", text);
            g_free(text);
            JS_FreeCString(ctx, name);
            JS_FreeValue(ctx, item);
        }
        if (n > RENDER_FIELDS)
            g_string_append_printf(b, ", … %u more", n - RENDER_FIELDS);
        g_string_append(b, " }");

        JS_FreePropertyEnum(ctx, keys, n);

        if (b->len > RENDER_WIDTH)
            g_string_truncate(b, RENDER_WIDTH);
        return g_string_free(b, FALSE);
    }

    /* An object's own `toString` can throw, and a debugger asking a question
       must never leave an exception behind for the program to find. */
    JSValue pending = JS_GetException(ctx);
    s   = JS_ToCString(ctx, value);
    out = g_strdup(s ? s : "?");
    JS_FreeCString(ctx, s);
    JS_FreeValue(ctx, JS_GetException(ctx));
    JS_Throw(ctx, pending);
    return out;
}

/*
 * Whether a value has anything in it to open: what puts a triangle beside a
 * row. The fields are the ones `render` shows -- own, enumerable, named by a
 * string -- so a row that opens onto nothing cannot happen. An array is asked
 * its length rather than its names, which for a big one would be every index.
 */
static bool openable(JSContext *ctx, JSValueConst value)
{
    JSPropertyEnum *keys = NULL;
    uint32_t        n = 0;

    if (!JS_IsObject(value) || JS_IsFunction(ctx, value))
        return false;

    if (JS_IsArray(value)) {
        JSValue lv = JS_GetPropertyStr(ctx, value, "length");

        if (JS_ToUint32(ctx, &n, lv))
            JS_FreeValue(ctx, JS_GetException(ctx));
        JS_FreeValue(ctx, lv);
        return n > 0;
    }

    if (JS_GetOwnPropertyNames(ctx, &keys, &n, value, JS_GPN_STRING_MASK |
                               JS_GPN_ENUM_ONLY) < 0) {
        JS_FreeValue(ctx, JS_GetException(ctx));
        return false;
    }
    JS_FreePropertyEnum(ctx, keys, n);
    return n > 0;
}

/* JSON, built the way the rest of this runtime builds it: through QuickJS. */
static char *to_json(JSContext *ctx, JSValue value)
{
    JSValue     text = JS_JSONStringify(ctx, value, JS_UNDEFINED, JS_UNDEFINED);
    const char *s    = JS_ToCString(ctx, text);
    char       *out  = g_strdup(s ? s : "{}");

    JS_FreeCString(ctx, s);
    JS_FreeValue(ctx, text);
    JS_FreeValue(ctx, value);
    return out;
}

static void emit_object(JSContext *ctx, JSValue object)
{
    char *json = to_json(ctx, object);
    emit(json);
    g_free(json);
}

/*
 * An expression, evaluated where the program is standing: its value, or
 * JS_EXCEPTION with nothing left pending and the message in `*error`.
 *
 * Two things it must not do, and both were real. It must not let the hook fire
 * inside itself -- the debugger would stop in its own expression, with the
 * program's stack underneath. And it must not leave an exception behind: a
 * question asked by a debugger is not something the program should then find
 * itself handling. What a throwing expression answers is the message, which is
 * what a person typing in an immediate box wants to see anyway.
 */
static JSValue evaluate_value(JSContext *ctx, int frame, const char *expr,
                              char **error)
{
    JSValue out;
    bool    was = here.evaluating;

    here.evaluating = true;
    out = JS_DebugEval(ctx, frame, expr);
    here.evaluating = was;

    if (JS_IsException(out)) {
        JSValue      err = JS_GetException(ctx);
        const char  *msg = JS_ToCString(ctx, err);

        *error = g_strdup(msg ? msg : "error");
        JS_FreeCString(ctx, msg);
        JS_FreeValue(ctx, err);
    }
    return out;
}

/*
 * The same, rendered: what a watch, a logpoint and the immediate box show.
 *
 * `message` is a logpoint's half: a string that comes back **is** the line to
 * write, unquoted, because `"i=" + i` is a sentence somebody wrote to read.
 * Everything else -- the immediate box, a value in the panel -- quotes a string
 * so that `"Ana"` is told apart from a name, which is the same answer
 * `JSON.stringify` gives.
 */
static char *evaluate(JSContext *ctx, int frame, const char *expr, bool *failed,
                      bool message)
{
    JSValue out;
    char   *text = NULL;

    out = evaluate_value(ctx, frame, expr, &text);
    if (JS_IsException(out)) {
        if (failed)
            *failed = true;
        return text;
    }

    if (message && JS_IsString(out)) {
        const char *s = JS_ToCString(ctx, out);

        text = g_strdup(s ? s : "");
        JS_FreeCString(ctx, s);
    } else {
        text = render(ctx, out);
    }
    JS_FreeValue(ctx, out);
    if (failed)
        *failed = false;
    return text;
}

/* Whether an expression is true where the program is standing. A condition that
 * throws does **not** stop: a breakpoint whose test is broken should be a line
 * in the log and not a stop on every pass. */
static bool condition_holds(JSContext *ctx, const char *expr)
{
    JSValue out;
    bool    yes, was = here.evaluating;

    here.evaluating = true;
    out = JS_DebugEval(ctx, 0, expr);
    here.evaluating = was;

    if (JS_IsException(out)) {
        JS_FreeValue(ctx, JS_GetException(ctx));
        return false;
    }
    yes = JS_ToBool(ctx, out);
    JS_FreeValue(ctx, out);
    return yes;
}

/* ------------------------------------------------------------- the stop */

static JSValue frames_of(JSContext *ctx, const uint8_t *pc)
{
    return JS_DebugBacktrace(ctx, pc);
}

static void say_stopped(JSContext *ctx, const uint8_t *pc, const char *reason,
                        const BtaBreak *bp)
{
    JSValue event = JS_NewObject(ctx);

    JS_SetPropertyStr(ctx, event, "event", JS_NewString(ctx, "stopped"));
    JS_SetPropertyStr(ctx, event, "reason", JS_NewString(ctx, reason));
    /* Stopped in a `Task`: the worker's class, so the IDE can say whose stack
     * this is. The main thread's stops carry nothing, as they always did. */
    if (here.name)
        JS_SetPropertyStr(ctx, event, "thread", JS_NewString(ctx, here.name));
    /* Which breakpoint, and how many times it has been reached: the pass a
     * hit count stopped on is the number the programmer asked about. */
    if (bp) {
        JS_SetPropertyStr(ctx, event, "id", JS_NewInt32(ctx, bp->id));
        JS_SetPropertyStr(ctx, event, "hits", JS_NewInt32(ctx, bp->hits));
    }
    JS_SetPropertyStr(ctx, event, "frames", frames_of(ctx, pc));
    emit_object(ctx, event);
}

/*
 * A logpoint: what an expression came to where the program is standing, sent
 * and **not** stopped on. The message is the expression's own answer, rendered
 * the way a watch is, so `n` records the value and `"total: " + total` records
 * a sentence. An expression that throws records its message and the program
 * carries on, which is the rule a broken condition already follows.
 */
static void say_log(JSContext *ctx, BtaBreak *bp, const char *text, bool failed)
{
    JSValue event = JS_NewObject(ctx);

    JS_SetPropertyStr(ctx, event, "event", JS_NewString(ctx, "log"));
    JS_SetPropertyStr(ctx, event, "file", JS_NewString(ctx, bp->file));
    JS_SetPropertyStr(ctx, event, "line", JS_NewInt32(ctx, bp->line));
    JS_SetPropertyStr(ctx, event, "text", JS_NewString(ctx, text));
    JS_SetPropertyStr(ctx, event, "failed", JS_NewBool(ctx, failed));
    JS_SetPropertyStr(ctx, event, "hits", JS_NewInt32(ctx, bp->hits));
    emit_object(ctx, event);
}

/* The locals of one frame, rendered. */
static void say_locals(JSContext *ctx, int frame)
{
    JSValue  raw = JS_DebugLocals(ctx, frame);
    JSValue  out = JS_NewObject(ctx);
    JSValue  items = JS_NewArray(ctx);
    uint32_t i, n = 0;

    JSValue lenv = JS_GetPropertyStr(ctx, raw, "length");
    /* The temporary is freed on every path: on failure n stays 0 with the
     * exception still pending, as before, minus the leak. */
    if (JS_ToUint32(ctx, &n, lenv))
        n = 0;
    JS_FreeValue(ctx, lenv);

    /*
     * **`this` once.** A method of a derived class keeps `this` in a local of
     * that name -- it is in its dead zone until `super()` -- and the frame's
     * own `this` is reported beside it, so every method of every `extends`
     * class listed it twice (measured: `this, this` in K2.m2, once in K.m).
     * The first is kept; a second row of that name is the same value. Only
     * `this`: two `let x` in two blocks are two variables, and both are shown.
     */
    bool     seen_this = false;
    uint32_t out_n     = 0;

    for (i = 0; i < n; i++) {
        JSValue row   = JS_GetPropertyUint32(ctx, raw, i);
        JSValue name  = JS_GetPropertyStr(ctx, row, "Name");
        const char *nm = JS_ToCString(ctx, name);
        bool    is_this = nm && !strcmp(nm, "this");

        JS_FreeCString(ctx, nm);
        JS_FreeValue(ctx, name);
        if (is_this && seen_this) {
            JS_FreeValue(ctx, row);
            continue;
        }
        seen_this = seen_this || is_this;

        JSValue value = JS_GetPropertyStr(ctx, row, "Value");
        char   *text  = render(ctx, value);
        JSValue item  = JS_NewObject(ctx);

        JS_SetPropertyStr(ctx, item, "Name", JS_GetPropertyStr(ctx, row, "Name"));
        JS_SetPropertyStr(ctx, item, "Value", JS_NewString(ctx, text));
        JS_SetPropertyStr(ctx, item, "Argument",
                          JS_GetPropertyStr(ctx, row, "Argument"));
        JS_SetPropertyStr(ctx, item, "Children",
                          JS_NewBool(ctx, openable(ctx, value)));
        JS_SetPropertyUint32(ctx, items, out_n++, item);

        g_free(text);
        JS_FreeValue(ctx, value);
        JS_FreeValue(ctx, row);
    }
    JS_FreeValue(ctx, raw);

    JS_SetPropertyStr(ctx, out, "reply", JS_NewString(ctx, "locals"));
    JS_SetPropertyStr(ctx, out, "frame", JS_NewInt32(ctx, frame));
    JS_SetPropertyStr(ctx, out, "items", items);
    emit_object(ctx, out);
}

/* How many fields of one value are sent when it is opened; the rest are
 * counted in `more`. An array of a million is opened onto its first ones. */
#define EXPAND_FIELDS 200

/* One field of an opened value, read with the hook held off: a getter is
 * JavaScript, and the debugger must not stop inside its own question. */
static JSValue expand_item(JSContext *ctx, JSValueConst owner, JSAtom atom,
                           uint32_t index, bool by_index)
{
    JSValue item  = JS_NewObject(ctx);
    bool    was   = here.evaluating;
    JSValue value;
    char   *text;

    here.evaluating = true;
    value = by_index ? JS_GetPropertyUint32(ctx, owner, index)
                     : JS_GetProperty(ctx, owner, atom);
    here.evaluating = was;

    if (by_index) {
        char name[16];

        g_snprintf(name, sizeof name, "%u", index);
        JS_SetPropertyStr(ctx, item, "Name", JS_NewString(ctx, name));
    } else {
        JS_SetPropertyStr(ctx, item, "Name", JS_AtomToString(ctx, atom));
    }

    /* A getter that throws answers its message, the way a watch does. */
    if (JS_IsException(value)) {
        JSValue     err = JS_GetException(ctx);
        const char *msg = JS_ToCString(ctx, err);

        JS_SetPropertyStr(ctx, item, "Value", JS_NewString(ctx, msg ? msg : "error"));
        JS_SetPropertyStr(ctx, item, "Failed", JS_TRUE);
        JS_SetPropertyStr(ctx, item, "Children", JS_FALSE);
        JS_FreeCString(ctx, msg);
        JS_FreeValue(ctx, err);
        return item;
    }

    text = render(ctx, value);
    JS_SetPropertyStr(ctx, item, "Value", JS_NewString(ctx, text));
    JS_SetPropertyStr(ctx, item, "Children", JS_NewBool(ctx, openable(ctx, value)));
    g_free(text);
    JS_FreeValue(ctx, value);
    return item;
}

/*
 * What is inside a value: the panel's tree, one level at a time.
 *
 * **Addressed by the expression, not by a handle.** The IDE asks for
 * `client.address` and the runtime evaluates it where the frame stands, exactly
 * as a watch is evaluated -- so nothing is held here between two questions, and
 * nothing can outlive a resume and answer for a program that has moved on, which
 * is what `debug-plan.md` asks of whatever does this. The cost is that an
 * expression with a side effect runs again; a path of names has none.
 */
static void say_expand(JSContext *ctx, int frame, const char *text)
{
    JSValue  out   = JS_NewObject(ctx);
    JSValue  items = JS_NewArray(ctx);
    char    *error = NULL;
    JSValue  value = evaluate_value(ctx, frame, text, &error);
    uint32_t n = 0, i, shown = 0;

    JS_SetPropertyStr(ctx, out, "reply", JS_NewString(ctx, "expand"));
    JS_SetPropertyStr(ctx, out, "frame", JS_NewInt32(ctx, frame));
    JS_SetPropertyStr(ctx, out, "text", JS_NewString(ctx, text));

    if (JS_IsException(value)) {
        JS_SetPropertyStr(ctx, out, "failed", JS_TRUE);
        JS_SetPropertyStr(ctx, out, "value", JS_NewString(ctx, error));
        g_free(error);
    } else if (JS_IsArray(value)) {
        JSValue lv = JS_GetPropertyStr(ctx, value, "length");

        if (JS_ToUint32(ctx, &n, lv))
            JS_FreeValue(ctx, JS_GetException(ctx));
        JS_FreeValue(ctx, lv);
        for (i = 0; i < n && i < EXPAND_FIELDS; i++)
            JS_SetPropertyUint32(ctx, items, shown++,
                                 expand_item(ctx, value, JS_ATOM_NULL, i, true));
    } else if (JS_IsObject(value) && !JS_IsFunction(ctx, value)) {
        JSPropertyEnum *keys = NULL;

        if (JS_GetOwnPropertyNames(ctx, &keys, &n, value, JS_GPN_STRING_MASK |
                                   JS_GPN_ENUM_ONLY) < 0) {
            JS_FreeValue(ctx, JS_GetException(ctx));
            keys = NULL;
            n    = 0;
        }
        for (i = 0; i < n && i < EXPAND_FIELDS; i++)
            JS_SetPropertyUint32(ctx, items, shown++,
                                 expand_item(ctx, value, keys[i].atom, 0, false));
        JS_FreePropertyEnum(ctx, keys, n);
    }

    JS_SetPropertyStr(ctx, out, "items", items);
    JS_SetPropertyStr(ctx, out, "more", JS_NewInt32(ctx, (int32_t)(n - shown)));
    JS_FreeValue(ctx, value);
    emit_object(ctx, out);
}

/* ---------------------------------------------------- stopping on a change */

/*
 * A data breakpoint: stop where a field of one object is changed.
 *
 * **The field is turned into an accessor pair** -- the way a debugger with no
 * hardware watchpoints emulates one in JavaScript -- whose setter stops the
 * program *inside the assignment*: the frame running code at the top of the
 * stack is the function that wrote it, which is the line the person was
 * looking for. Nothing per opcode, nothing in the interpreter: a program with a
 * field watched pays only at that field.
 *
 * It is about **one object**, not about an expression: `client.balance` is
 * evaluated once, when it is armed, and what is watched is the object that
 * `client` was then. That is what a watchpoint is everywhere, and the other
 * meaning -- re-evaluate the text at every line -- would stop on a different
 * client the moment `client` named another one.
 *
 * The pair share a cell (`[value]`) that holds the field's value; the getter
 * reads it, the setter writes it. The C side holds the object and the cell
 * until the watch is taken off, the IDE goes or the program ends, and every one
 * of those puts the data property back with its value and its flags -- an
 * object a debugger once looked at must not be left different.
 */
typedef struct {
    int     id;
    char   *text;       /* `owner.name`, for the stop and the log */
    JSValue owner;      /* held: the object watched */
    JSAtom  name;
    int     flags;      /* the data property's own, to put back */
    JSValue cell;       /* held: [value], shared by the getter and the setter */
} BtaWatch;

static GPtrArray *watches;   /* BtaWatch*, only while there are any */

static void wait_for_orders(JSContext *ctx, int depth_now);

static JSValue watch_get(JSContext *ctx, JSValueConst this_val, int argc,
                         JSValueConst *argv, int magic, JSValue *data)
{
    (void)this_val; (void)argc; (void)argv; (void)magic;
    return JS_GetPropertyUint32(ctx, data[0], 0);
}

/* data: [cell, id, owner, name as a string] */
static JSValue watch_set(JSContext *ctx, JSValueConst this_val, int argc,
                         JSValueConst *argv, int magic, JSValue *data)
{
    JSValue value = argc > 0 ? argv[0] : JS_UNDEFINED;
    JSValue old;
    bool    changed;
    int32_t id = 0;

    (void)magic;

    /* Written through an object that inherits from the watched one: a data
     * property would have become that object's own, so it does. */
    if (!JS_IsSameValue(ctx, this_val, data[2])) {
        JSAtom atom = JS_ValueToAtom(ctx, data[3]);
        int    ok   = JS_DefinePropertyValue(ctx, this_val, atom, JS_DupValue(ctx, value),
                                             JS_PROP_C_W_E);

        JS_FreeAtom(ctx, atom);
        return ok < 0 ? JS_EXCEPTION : JS_UNDEFINED;
    }

    old     = JS_GetPropertyUint32(ctx, data[0], 0);
    changed = !JS_IsSameValue(ctx, old, value);
    JS_SetPropertyUint32(ctx, data[0], 0, JS_DupValue(ctx, value));

    /* The debugger's own writes -- `set`, an immediate -- are not the program
     * changing it, and a detached debugger stops nothing. */
    if (changed && !here.evaluating && dbg.attached) {
        JSValue event = JS_NewObject(ctx);
        char   *was   = render(ctx, old);
        char   *now   = render(ctx, value);
        const char *text = NULL;

        JS_ToInt32(ctx, &id, data[1]);
        for (guint i = 0; watches && i < watches->len; i++) {
            BtaWatch *w = g_ptr_array_index(watches, i);
            if (w->id == id)
                text = w->text;
        }

        JS_SetPropertyStr(ctx, event, "event", JS_NewString(ctx, "stopped"));
        JS_SetPropertyStr(ctx, event, "reason", JS_NewString(ctx, "watch"));
        JS_SetPropertyStr(ctx, event, "id", JS_NewInt32(ctx, id));
        JS_SetPropertyStr(ctx, event, "text", JS_NewString(ctx, text ? text : ""));
        JS_SetPropertyStr(ctx, event, "old", JS_NewString(ctx, was));
        JS_SetPropertyStr(ctx, event, "new", JS_NewString(ctx, now));
        /* No pc: each frame's own, and frame 0 is the one that assigned --
         * this setter is native, and native frames at the top are skipped. */
        JS_SetPropertyStr(ctx, event, "frames", frames_of(ctx, NULL));
        g_free(was);
        g_free(now);

        here.mode = RUN;
        g_rec_mutex_lock(&channel_lock);
        emit_object(ctx, event);
        wait_for_orders(ctx, JS_DebugDepth(JS_GetRuntime(ctx)));
        g_rec_mutex_unlock(&channel_lock);
    }
    JS_FreeValue(ctx, old);
    return JS_UNDEFINED;
}

/* Put the data property back, with whatever it holds now, and let go. */
static void unwatch_one(JSContext *ctx, BtaWatch *w)
{
    JSValue value = JS_GetPropertyUint32(ctx, w->cell, 0);

    if (JS_DefinePropertyValue(ctx, w->owner, w->name, value, w->flags) < 0)
        JS_FreeValue(ctx, JS_GetException(ctx));
    JS_FreeValue(ctx, w->owner);
    JS_FreeValue(ctx, w->cell);
    JS_FreeAtom(ctx, w->name);
    g_free(w->text);
    g_free(w);
}

static void unwatch_all(JSContext *ctx)
{
    if (!watches)
        return;
    for (guint i = 0; i < watches->len; i++)
        unwatch_one(ctx, g_ptr_array_index(watches, i));
    g_ptr_array_free(watches, TRUE);
    watches = NULL;
}

static void say_watch(JSContext *ctx, int id, const char *text, const char *why)
{
    JSValue out = JS_NewObject(ctx);

    JS_SetPropertyStr(ctx, out, "reply", JS_NewString(ctx, "watch"));
    JS_SetPropertyStr(ctx, out, "id", JS_NewInt32(ctx, id));
    JS_SetPropertyStr(ctx, out, "text", JS_NewString(ctx, text));
    JS_SetPropertyStr(ctx, out, "armed", JS_NewBool(ctx, why == NULL));
    if (why)
        JS_SetPropertyStr(ctx, out, "why", JS_NewString(ctx, why));
    emit_object(ctx, out);
}

/*
 * Arm one: `owner` is evaluated where the frame stands, and `name` must be an
 * own data property of what it came to that can be redefined. Each refusal is
 * a sentence, since the IDE shows it to somebody who asked for something.
 */
static void watch_field(JSContext *ctx, int id, int frame, const char *owner,
                        const char *name)
{
    char                *text  = g_strdup_printf("%s.%s", owner, name);
    char                *error = NULL;
    JSValue              obj   = evaluate_value(ctx, frame, owner, &error);
    JSPropertyDescriptor desc;
    JSAtom               atom;
    int                  has;

    if (JS_IsException(obj)) {
        say_watch(ctx, id, text, error);
        g_free(error);
        g_free(text);
        return;
    }
    if (!JS_IsObject(obj)) {
        say_watch(ctx, id, text, "only a field of an object can be watched");
        JS_FreeValue(ctx, obj);
        g_free(text);
        return;
    }

    atom = JS_NewAtom(ctx, name);
    has  = JS_GetOwnProperty(ctx, &desc, obj, atom);
    if (has < 0)
        JS_FreeValue(ctx, JS_GetException(ctx));

    /* Asked first: a field already watched is a getter by now. */
    const char *why = NULL;
    for (guint i = 0; watches && i < watches->len; i++) {
        BtaWatch *w = g_ptr_array_index(watches, i);
        if (w->name == atom && JS_IsSameValue(ctx, w->owner, obj))
            why = "it is already watched";
    }
    if (!why)
        why = has <= 0 ? "it is not a field of that object's own"
            : (desc.flags & JS_PROP_GETSET) ? "it is a getter, not a value"
            : !(desc.flags & JS_PROP_CONFIGURABLE) ? "it cannot be redefined"
            : NULL;

    if (why) {
        say_watch(ctx, id, text, why);
    } else {
        BtaWatch *w    = g_new0(BtaWatch, 1);
        JSValue   cell = JS_NewArray(ctx);
        JSValue   data[4];
        JSValue   getter, setter;

        JS_SetPropertyUint32(ctx, cell, 0, JS_DupValue(ctx, desc.value));
        data[0] = cell;
        data[1] = JS_NewInt32(ctx, id);
        data[2] = obj;
        data[3] = JS_NewString(ctx, name);
        getter = JS_NewCFunctionData(ctx, watch_get, 0, 0, 1, data);
        setter = JS_NewCFunctionData(ctx, watch_set, 1, 0, 4, data);
        JS_FreeValue(ctx, data[3]);

        JS_DefineProperty(ctx, obj, atom, JS_UNDEFINED, getter, setter,
                          JS_PROP_HAS_GET | JS_PROP_HAS_SET |
                          JS_PROP_HAS_CONFIGURABLE | JS_PROP_CONFIGURABLE |
                          JS_PROP_HAS_ENUMERABLE |
                          (desc.flags & JS_PROP_ENUMERABLE));
        JS_FreeValue(ctx, getter);
        JS_FreeValue(ctx, setter);

        w->id    = id;
        w->text  = g_strdup(text);
        w->owner = JS_DupValue(ctx, obj);
        w->name  = JS_DupAtom(ctx, atom);
        w->flags = desc.flags & (JS_PROP_CONFIGURABLE | JS_PROP_WRITABLE |
                                 JS_PROP_ENUMERABLE);
        w->cell  = cell;                      /* the array's own reference */
        if (!watches)
            watches = g_ptr_array_new();
        g_ptr_array_add(watches, w);
        say_watch(ctx, id, text, NULL);
    }

    if (has > 0) {
        JS_FreeValue(ctx, desc.value);
        JS_FreeValue(ctx, desc.getter);
        JS_FreeValue(ctx, desc.setter);
    }
    JS_FreeAtom(ctx, atom);
    JS_FreeValue(ctx, obj);
    g_free(text);
}

static void unwatch_id(JSContext *ctx, int id)
{
    for (guint i = 0; watches && i < watches->len; i++) {
        BtaWatch *w = g_ptr_array_index(watches, i);

        if (w->id == id) {
            g_ptr_array_remove_index(watches, i);
            unwatch_one(ctx, w);
            return;
        }
    }
}

/* ------------------------------------------------------- reading commands */

static void set_break(JSContext *ctx, JSValue cmd, bool one_shot)
{
    BtaBreak   *bp = g_new0(BtaBreak, 1);
    const char *file = NULL, *when = NULL, *log = NULL;
    JSValue     v;

    bp->one_shot = one_shot;

    v = JS_GetPropertyStr(ctx, cmd, "file");
    file = JS_ToCString(ctx, v);
    bp->file = g_strdup(file ? file : "");
    JS_FreeCString(ctx, file);
    JS_FreeValue(ctx, v);

    v = JS_GetPropertyStr(ctx, cmd, "line");
    JS_ToInt32(ctx, &bp->line, v);
    JS_FreeValue(ctx, v);

    v = JS_GetPropertyStr(ctx, cmd, "id");
    JS_ToInt32(ctx, &bp->id, v);
    JS_FreeValue(ctx, v);

    v = JS_GetPropertyStr(ctx, cmd, "when");
    if (JS_IsString(v)) {
        when = JS_ToCString(ctx, v);
        if (when && *when)
            bp->when = g_strdup(when);
        JS_FreeCString(ctx, when);
    }
    JS_FreeValue(ctx, v);

    v = JS_GetPropertyStr(ctx, cmd, "log");
    if (JS_IsString(v)) {
        log = JS_ToCString(ctx, v);
        if (log && *log)
            bp->log = g_strdup(log);
        JS_FreeCString(ctx, log);
    }
    JS_FreeValue(ctx, v);

    v = JS_GetPropertyStr(ctx, cmd, "hits");
    if (JS_IsString(v)) {
        const char *hits = JS_ToCString(ctx, v);
        bool        ok   = !hits || !*hits || parse_hits(hits, &bp->hit_op, &bp->hit_n);

        JS_FreeCString(ctx, hits);
        JS_FreeValue(ctx, v);
        if (!ok) {
            bp->asked = bp->line;
            say_refused_why(ctx, bp, "a hit count is a number, == n, >= n or % n");
            free_break(bp);
            return;
        }
    } else {
        JS_FreeValue(ctx, v);
    }

    /*
     * Moved to a line that exists, and the IDE is told where it went: a mark in
     * the gutter beside a line that can never stop is a lie the programmer then
     * acts on.  A file not compiled yet keeps the line it was given and is
     * resolved by `bta_debug_compiled` when it arrives.
     */
    bp->asked = bp->line;
    int at = resolve_line(bp->file, bp->line);

    if (at == 0) {                      /* nowhere to stop */
        say_refused(ctx, bp);
        free_break(bp);
        return;
    }
    g_rec_mutex_lock(&breaks_lock);
    if (at > 0) {
        bp->line = at;
        g_ptr_array_add(dbg.breaks, bp);
        if (!one_shot)
            say_armed(ctx, bp);
    } else {
        g_ptr_array_add(dbg.breaks, bp);    /* pending */
    }
    g_rec_mutex_unlock(&breaks_lock);
}

/* One run-to-cursor at a time: arming a second one takes the first out, since
 * what it was going to stop at is no longer where the caret is. */
static void drop_one_shots(void)
{
    g_rec_mutex_lock(&breaks_lock);
    for (guint i = 0; i < dbg.breaks->len; ) {
        BtaBreak *bp = g_ptr_array_index(dbg.breaks, i);

        if (bp->one_shot)
            g_ptr_array_remove_index(dbg.breaks, i);
        else
            i++;
    }
    g_rec_mutex_unlock(&breaks_lock);
}

/* The one that was just reached. */
static void remove_one_shot(BtaBreak *bp)
{
    for (guint i = 0; i < dbg.breaks->len; i++) {
        if (g_ptr_array_index(dbg.breaks, i) == bp) {
            g_ptr_array_remove_index(dbg.breaks, i);
            return;
        }
    }
}

static void free_break(gpointer p)
{
    BtaBreak *bp = p;
    g_free(bp->file);
    g_free(bp->when);
    g_free(bp->log);
    g_free(bp);
}

static void clear_break(JSContext *ctx, JSValue cmd)
{
    JSValue v  = JS_GetPropertyStr(ctx, cmd, "id");
    int     id = 0;

    JS_ToInt32(ctx, &id, v);
    JS_FreeValue(ctx, v);

    g_rec_mutex_lock(&breaks_lock);
    for (guint i = 0; i < dbg.breaks->len; i++) {
        BtaBreak *bp = g_ptr_array_index(dbg.breaks, i);
        if (bp->id == id) {
            g_ptr_array_remove_index(dbg.breaks, i);
            break;
        }
    }
    g_rec_mutex_unlock(&breaks_lock);
}

/* A command, answered.  True when the program is to carry on. */
static bool obey(JSContext *ctx, const char *line, int depth_now)
{
    JSValue cmd = JS_ParseJSON(ctx, line, strlen(line), "<debug>");
    JSValue v;
    const char *verb;
    bool    go = false;

    if (JS_IsException(cmd)) {
        JS_FreeValue(ctx, JS_GetException(ctx));
        return false;           /* nonsense is not a reason to run on */
    }

    v    = JS_GetPropertyStr(ctx, cmd, "do");
    verb = JS_ToCString(ctx, v);
    JS_FreeValue(ctx, v);

    if (!verb) {
        JS_FreeValue(ctx, cmd);
        return false;
    }

    if (!strcmp(verb, "break")) {
        set_break(ctx, cmd, false);
    } else if (!strcmp(verb, "runto")) {
        /* A breakpoint that takes itself out when it is reached, and letting the
           program go: the next stop is the line the caret is on. One at a time,
           because a second one means the caret moved. */
        drop_one_shots();
        set_break(ctx, cmd, true);
        here.mode = RUN;
        go = true;
    } else if (!strcmp(verb, "clear")) {
        clear_break(ctx, cmd);
    } else if (!strcmp(verb, "continue")) {
        here.mode = RUN;
        go = true;
    } else if (!strcmp(verb, "step")) {
        JSValue kv = JS_GetPropertyStr(ctx, cmd, "kind");
        const char *kind = JS_ToCString(ctx, kv);

        here.mode  = !kind             ? STEP_INTO
                  : !strcmp(kind, "over") ? STEP_OVER
                  : !strcmp(kind, "out")  ? STEP_OUT
                  : STEP_INTO;
        here.depth = depth_now;
        JS_FreeCString(ctx, kind);
        JS_FreeValue(ctx, kv);
        go = true;
    } else if (!strcmp(verb, "locals")) {
        JSValue fv = JS_GetPropertyStr(ctx, cmd, "frame");
        int     frame = 0;
        JS_ToInt32(ctx, &frame, fv);
        JS_FreeValue(ctx, fv);
        say_locals(ctx, frame);
    } else if (!strcmp(verb, "eval")) {
        JSValue     fv   = JS_GetPropertyStr(ctx, cmd, "frame");
        JSValue     tv   = JS_GetPropertyStr(ctx, cmd, "text");
        const char *text = JS_ToCString(ctx, tv);
        int         frame = 0;
        bool        failed = false;

        JS_ToInt32(ctx, &frame, fv);
        if (text) {
            char   *answer = NULL;
            JSValue value  = evaluate_value(ctx, frame, text, &answer);
            JSValue out    = JS_NewObject(ctx);

            failed = JS_IsException(value);
            if (!failed)
                answer = render(ctx, value);

            JS_SetPropertyStr(ctx, out, "reply", JS_NewString(ctx, "eval"));
            JS_SetPropertyStr(ctx, out, "frame", JS_NewInt32(ctx, frame));
            JS_SetPropertyStr(ctx, out, "text", JS_NewString(ctx, text));
            JS_SetPropertyStr(ctx, out, "value", JS_NewString(ctx, answer));
            JS_SetPropertyStr(ctx, out, "failed", JS_NewBool(ctx, failed));
            /* A watch that holds an object opens like a local does. */
            JS_SetPropertyStr(ctx, out, "children",
                              JS_NewBool(ctx, !failed && openable(ctx, value)));
            emit_object(ctx, out);
            g_free(answer);
            JS_FreeValue(ctx, value);
        }
        JS_FreeCString(ctx, text);
        JS_FreeValue(ctx, tv);
        JS_FreeValue(ctx, fv);
    } else if (!strcmp(verb, "expand")) {
        JSValue     fv   = JS_GetPropertyStr(ctx, cmd, "frame");
        JSValue     tv   = JS_GetPropertyStr(ctx, cmd, "text");
        const char *text = JS_ToCString(ctx, tv);
        int         frame = 0;

        JS_ToInt32(ctx, &frame, fv);
        if (text)
            say_expand(ctx, frame, text);
        JS_FreeCString(ctx, text);
        JS_FreeValue(ctx, tv);
        JS_FreeValue(ctx, fv);
    } else if (!strcmp(verb, "set")) {
        /* A value changed from the debugger, which is the half of an immediate
           window that is not a question. The new value is an *expression*, so
           `n + 1` and `this.Ok` work and not only literals. */
        JSValue     fv   = JS_GetPropertyStr(ctx, cmd, "frame");
        JSValue     nv   = JS_GetPropertyStr(ctx, cmd, "name");
        JSValue     tv   = JS_GetPropertyStr(ctx, cmd, "text");
        const char *name = JS_ToCString(ctx, nv);
        const char *text = JS_ToCString(ctx, tv);
        int         frame = 0;

        JS_ToInt32(ctx, &frame, fv);
        if (name && text) {
            JSValue value;
            bool    was = here.evaluating;

            here.evaluating = true;
            value = JS_DebugEval(ctx, frame, text);
            here.evaluating = was;

            if (JS_IsException(value)) {
                JS_FreeValue(ctx, JS_GetException(ctx));
            } else if (JS_DebugSetLocal(ctx, frame, name, value)) {
                say_locals(ctx, frame);       /* the panel, brought up to date */
            }
        }
        JS_FreeCString(ctx, name);
        JS_FreeCString(ctx, text);
        JS_FreeValue(ctx, tv);
        JS_FreeValue(ctx, nv);
        JS_FreeValue(ctx, fv);
    } else if (!strcmp(verb, "stopOnThrow")) {
        JSValue bv = JS_GetPropertyStr(ctx, cmd, "value");

        dbg.stop_on_throw = JS_ToBool(ctx, bv);
        JS_DebugStopOnThrow(JS_GetRuntime(ctx), dbg.stop_on_throw);
        JS_FreeValue(ctx, bv);
    } else if (!strcmp(verb, "pause")) {
        /* Not a stop of its own: the mode says *the next line, wherever it is*,
           and the stop happens where the program actually is. Asking twice, or
           asking one that is already stopped, changes nothing. */
        here.mode = PAUSE;
    } else if (!strcmp(verb, "watch")) {
        /* A data breakpoint: `owner` evaluated in the frame, `name` one of its
         * own fields. Answered with `armed`, or with why it could not be. */
        JSValue     iv = JS_GetPropertyStr(ctx, cmd, "id");
        JSValue     fv = JS_GetPropertyStr(ctx, cmd, "frame");
        JSValue     ov = JS_GetPropertyStr(ctx, cmd, "owner");
        JSValue     nv = JS_GetPropertyStr(ctx, cmd, "name");
        const char *owner = JS_ToCString(ctx, ov);
        const char *name  = JS_ToCString(ctx, nv);
        int         id = 0, frame = 0;

        JS_ToInt32(ctx, &id, iv);
        JS_ToInt32(ctx, &frame, fv);
        /* A field of a worker's object lives in the worker's runtime, which
         * ends with the task -- and the cell a watch holds from C would end
         * with it, mid-watch. Refused, with the reason, until that is built. */
        if (owner && name && ctx != dbg.ctx) {
            char *text = g_strdup_printf("%s.%s", owner, name);
            say_watch(ctx, id, text, "a field cannot be watched inside a Task yet");
            g_free(text);
        } else if (owner && name) {
            watch_field(ctx, id, frame, owner, name);
        }
        JS_FreeCString(ctx, owner);
        JS_FreeCString(ctx, name);
        JS_FreeValue(ctx, nv);
        JS_FreeValue(ctx, ov);
        JS_FreeValue(ctx, fv);
        JS_FreeValue(ctx, iv);
    } else if (!strcmp(verb, "hits")) {
        /* How often each breakpoint has been reached, asked at any time --
           running or stopped -- which is what a count-only breakpoint is read
           with: a hit count no pass matches never stops, and this says how
           many went by. One-shots are the caret's and are not listed. */
        JSValue reply = JS_NewObject(ctx);
        JSValue items = JS_NewArray(ctx);
        uint32_t n = 0;

        g_rec_mutex_lock(&breaks_lock);
        for (guint i = 0; i < dbg.breaks->len; i++) {
            BtaBreak *bp = g_ptr_array_index(dbg.breaks, i);
            if (bp->one_shot)
                continue;
            JSValue row = JS_NewObject(ctx);
            JS_SetPropertyStr(ctx, row, "id", JS_NewInt32(ctx, bp->id));
            JS_SetPropertyStr(ctx, row, "hits", JS_NewInt32(ctx, bp->hits));
            JS_SetPropertyUint32(ctx, items, n++, row);
        }
        g_rec_mutex_unlock(&breaks_lock);
        JS_SetPropertyStr(ctx, reply, "reply", JS_NewString(ctx, "hits"));
        JS_SetPropertyStr(ctx, reply, "items", items);
        emit_object(ctx, reply);
    } else if (!strcmp(verb, "unwatch")) {
        JSValue iv = JS_GetPropertyStr(ctx, cmd, "id");
        int     id = 0;

        JS_ToInt32(ctx, &id, iv);
        unwatch_id(ctx, id);
        JS_FreeValue(ctx, iv);
    }
    /*
     * Anything else is ignored, deliberately: a newer IDE may speak a verb this
     * runtime does not have, and a debugger that died on one would make every
     * IDE incompatible with every older runtime. What it must not do is *accept*
     * one and do nothing, which is why a verb is listed above only once it
     * works -- and why `runto`, which armed a breakpoint and looked like it
     * worked while nothing stopped, was not listed until it did.
     */

    JS_FreeCString(ctx, verb);
    JS_FreeValue(ctx, cmd);
    return go;
}

/*
 * Sit here until told to carry on.
 *
 * A blocking read and no main loop: see the note at the top.  End of input --
 * the IDE went away -- releases the program rather than leaving it stopped
 * forever with nobody to tell it anything.
 */
/*
 * One order, however long. A fixed buffer split a line past 8 KB -- an `eval`
 * of a long expression, a `set` of a long value -- into two fragments that each
 * failed to parse, so the order was dropped and the IDE never had its answer.
 * False at end of input. stdin is unbuffered under `--debug`, so this reads a
 * byte at a time, which for orders of a few dozen bytes is nothing.
 */
static bool read_order(GString *into)
{
    int c;

    g_string_truncate(into, 0);
    while ((c = fgetc(stdin)) != EOF) {
        if (c == '\n')
            return true;
        g_string_append_c(into, (char)c);
    }
    return into->len > 0;
}

static void wait_for_orders(JSContext *ctx, int depth_now)
{
    GString *order = g_string_new(NULL);

    for (;;) {
        if (!read_order(order)) {
            detach(ctx);
            break;
        }
        g_strchomp(order->str);
        if (!*order->str)
            continue;
        if (obey_as_debugger(ctx, order->str, depth_now))
            break;
    }
    g_string_free(order, TRUE);
}

/* ------------------------------------------------------------- the handler */

/* Whether a breakpoint is armed for this place. */
static BtaBreak *break_at(const char *file, int line)
{
    BtaBreak *fallback = NULL;

    for (guint i = 0; i < dbg.breaks->len; i++) {
        BtaBreak *bp = g_ptr_array_index(dbg.breaks, i);

        if (bp->line != line)
            continue;
        /* The IDE names a file the way the project does and the engine names it
           the way it was loaded, so the shorter one has to be a tail of the
           other -- `forms/Form1.js` against `/home/…/forms/Form1.js`. */
        if (!path_is(file, bp->file))
            continue;

        /* Run to cursor wins the line it asked for: it was armed for exactly
           this arrival, and a persistent breakpoint earlier in the list would
           otherwise answer first and leave the one-shot armed for ever. */
        if (bp->one_shot)
            return bp;
        if (!fallback)
            fallback = bp;
    }
    return fallback;
}

/* Is anything armed on this line number, in any file? The question before
 * `break_at`, which needs the file as a string to answer. */
static bool break_on_line(int line)
{
    for (guint i = 0; i < dbg.breaks->len; i++)
        if (((BtaBreak *)g_ptr_array_index(dbg.breaks, i))->line == line)
            return true;
    return false;
}

/* Is it time to ask the IDE whether it said anything? See POLL_EVERY_US. */
static bool channel_due(void)
{
    gint64 now = g_get_monotonic_time();

    if (now - here.polled < POLL_EVERY_US)
        return false;
    here.polled = now;
    return true;
}

static bool step_wants_this(int depth_now)
{
    switch (here.mode) {
    case STEP_INTO: return true;
    case STEP_OVER: return depth_now <= here.depth;
    case STEP_OUT:  return depth_now <  here.depth;
    case PAUSE:     return true;
    default:        return false;
    }
}

/*
 * Has the IDE said anything while the program was running?
 *
 * Asked where the program has just moved to a new line, and at most once every
 * POLL_EVERY_US: once per line was a `poll` per line, which was not free, and
 * this is still often enough that *Pause* answers in no time a person can
 * measure. Without it a pause would have to wait for a breakpoint, which is
 * exactly the situation somebody presses Pause in: a program that is not going
 * to reach one.
 */
static void take_messages(JSContext *ctx, int depth_now)
{
#ifndef G_OS_WIN32
    struct pollfd in    = { .fd = STDIN_FILENO, .events = POLLIN };

    /* A worker stopped somewhere owns the channel and is reading it: what is
     * on stdin is its orders, not this thread's. */
    if (!g_rec_mutex_trylock(&channel_lock))
        return;

    GString      *order = g_string_new(NULL);

    while (poll(&in, 1, 0) > 0 && (in.revents & (POLLIN | POLLHUP))) {
        if (!read_order(order)) {
            detach(ctx);
            break;
        }
        g_strchomp(order->str);
        if (*order->str)
            obey_as_debugger(ctx, order->str, depth_now);
    }
    g_string_free(order, TRUE);
    g_rec_mutex_unlock(&channel_lock);
#else
    (void)ctx;
    (void)depth_now;
#endif
}

/*
 * Something was thrown, and the debugger was asked to stop where that happens.
 *
 * Here rather than where it is caught, which is the whole point: by the time a
 * `catch` runs, the frames that built the value are gone and so is everything
 * they held. `pc` is NULL, so the backtrace falls back on each frame's own
 * `cur_pc`.
 */
static void on_throw(JSContext *ctx)
{
    int depth_now;

    if (here.evaluating || !dbg.attached)
        return;

    /* An expression of the debugger's own that throws -- a broken watch, a
     * mistyped immediate -- must not stop the program it is inspecting. */
    depth_now = JS_DebugDepth(JS_GetRuntime(ctx));

    here.mode = RUN;
    g_rec_mutex_lock(&channel_lock);
    say_stopped(ctx, NULL, "exception", NULL);
    wait_for_orders(ctx, depth_now);
    g_rec_mutex_unlock(&channel_lock);
}

static void on_step(JSContext *ctx, const uint8_t *pc, void *opaque)
{
    JSAtom    file_atom;
    int       line;
    const char *file;
    BtaBreak *bp;
    int       depth_now;
    bool      wanted;
    bool      ask;

    (void)opaque;

    /* A throw, not an opcode -- `build_backtrace` calls the same handler with
     * no pc, because a second handler for one debugger would be two places to
     * keep in step. */
    if (!pc) {
        on_throw(ctx);
        return;
    }

    /*
     * The free half: with nothing armed and nobody attached there is nothing to
     * work out.  Being attached is enough to keep looking, because *Pause* has
     * to be able to arrive -- and a program that is being debugged at all is one
     * whose speed nobody is measuring.
     */
    if (here.mode == RUN && dbg.breaks->len == 0 && !dbg.attached)
        return;

    /* The debugger is running an expression of its own -- an immediate, a watch,
     * a condition. Stopping inside it would stop the debugger in itself. */
    if (here.evaluating)
        return;

    /* True only where the program has moved to a new line of a new frame:
     * one line is many opcodes, and each frame remembers the line it was last
     * reported at -- so returning from a call does not read as arriving
     * somewhere new. See JS_DebugPosition in quickjs.h.
     *
     * **What it still cannot see** is a loop written entirely on one line --
     * `for (let i = 0; i < 3; i++) total += i;` never leaves the line, so a
     * breakpoint on it stops once. Telling those apart wants the pc rather
     * than the line. */
    if (!JS_DebugPosition(ctx, pc, &file_atom, &line))
        return;

    /*
     * The cheap half of a new line: running, nothing armed on this line number
     * and the channel not due, which is nearly every line of a program under
     * the IDE. The depth is a walk of the whole stack and the file a string, so
     * neither is worked out for a line that cannot stop.
     */
    /* Only the main thread asks the channel while running: a worker has no
     * *Pause* yet, and stdin is read by one thread at a time. */
    ask = dbg.attached && ctx == dbg.ctx && channel_due();
    if (!ask && here.mode == RUN) {
        bool locked = here.name || g_atomic_int_get(&debug_workers) > 0;
        if (locked)
            g_rec_mutex_lock(&breaks_lock);
        bool armed_here = break_on_line(line);
        if (locked)
            g_rec_mutex_unlock(&breaks_lock);
        if (!armed_here)
            return;
    }
    here.ctx = ctx;

    depth_now = JS_DebugDepth(JS_GetRuntime(ctx));

    if (ask)
        take_messages(ctx, depth_now);

    wanted = step_wants_this(depth_now);
    bp     = NULL;

    /*
     * **What the breakpoint says is copied out under its lock, and the
     * condition runs outside it.** Another thread may clear it while this one
     * evaluates -- the list is the channel owner's to change -- and holding the
     * lock across JavaScript would stall every other thread's hook for as long
     * as a condition takes.
     */
    BtaBreak seen = { 0 };

    if (!wanted) {
        file = JS_AtomToCString(ctx, file_atom);
        g_rec_mutex_lock(&breaks_lock);
        bp = file ? break_at(file, line) : NULL;
        if (bp) {
            seen      = *bp;
            seen.file = g_strdup(bp->file);
            seen.when = g_strdup(bp->when);
            seen.log  = g_strdup(bp->log);
        }
        g_rec_mutex_unlock(&breaks_lock);
        JS_FreeCString(ctx, file);
        if (!bp)
            return;

        /* A condition is asked **here**, where the program is standing, and
           only for the breakpoint that matched: a stop nobody wanted costs a
           round trip to the IDE and a jump in the editor. */
        if (seen.when && !condition_holds(ctx, seen.when))
            goto done;

        /* Counted after the condition and before the logpoint: a pass is one
           the condition let through, and a hit count decides for a logpoint
           as much as for a stop -- `% 100` on a log is a sample. Counted on the
           breakpoint itself, if it is still armed. */
        bool match;
        g_rec_mutex_lock(&breaks_lock);
        guint at;
        if (g_ptr_array_find(dbg.breaks, bp, &at)) {
            bp->hits++;
            seen.hits = bp->hits;
            match     = hits_match(bp);
            /* Run-to-cursor takes itself out as it is reached, so the next
               pass over the same line does not stop again. */
            if (match && bp->one_shot)
                remove_one_shot(bp);
        } else {
            match = false;      /* cleared while the condition ran */
        }
        g_rec_mutex_unlock(&breaks_lock);
        if (!match)
            goto done;

        /*
         * A logpoint records and carries on, which is the whole of what it is --
         * and it is checked after the condition, so `when` still decides whether
         * it fires. The expression is evaluated the way a watch is, in the frame
         * that is about to be left.
         */
        if (seen.log) {
            bool  failed = false;
            char *text   = evaluate(ctx, 0, seen.log, &failed, true);

            say_log(ctx, &seen, text, failed);
            g_free(text);
            goto done;
        }
    }

    BtaRunMode was = here.mode;

    here.mode = RUN;
    /* The channel first: another thread's stop is answered to the end before
       this one is said, so every order is about the last stop announced. */
    g_rec_mutex_lock(&channel_lock);
    say_stopped(ctx, pc,
                wanted ? (was == PAUSE ? "pause" : "step") : "breakpoint",
                wanted ? NULL : &seen);
    wait_for_orders(ctx, depth_now);
    g_rec_mutex_unlock(&channel_lock);
done:
    g_free(seen.file);
    g_free(seen.when);
    g_free(seen.log);
}

/* --------------------------------------------------------------- the gate */

bool bta_debug_enabled(void) { return dbg.on; }

void bta_debug_start(JSContext *ctx)
{
    if (!dbg.on)
        return;

#ifdef G_OS_WIN32
    /*
     * The channel is a descriptor the parent opened (3) and this process's
     * stdin -- a Unix arrangement, and the same one that makes `Exec`'s
     * `Control` refuse on Windows.  Saying so beats a program that stops at
     * `ready` waiting for a debugger nobody can drive.
     */
    fprintf(stderr, "bintana: --debug needs a control channel this platform has not got\n");
    dbg.on = false;
    return;
#endif

    dbg.ctx    = ctx;
    dbg.breaks = g_ptr_array_new_with_free_func(free_break);
    dbg.lines  = g_hash_table_new_full(g_str_hash, g_str_equal, g_free,
                                       (GDestroyNotify)g_array_unref);
    here.mode   = RUN;

    JS_SetDebugHandler(JS_GetRuntime(ctx), on_step, NULL);

    /*
     * Unbuffered, because `take_messages` asks `poll` whether the IDE said
     * anything and then reads with `fgets`: two lines in one write went into
     * stdio's buffer together, `poll` then saw nothing on the descriptor, and
     * the second -- a `pause`, measured -- waited for bytes that never came
     * while the program ran to the end. Read a byte at a time, what `poll`
     * answers is what there is.
     */
    setvbuf(stdin, NULL, _IONBF, 0);

    /*
     * Say hello and wait, before a line of the project has run: the IDE has
     * breakpoints to set, and a program that started running first would have
     * gone past them. `ready` is the handshake, and the reply that releases it
     * is an ordinary `continue`.
     */
    here.ctx     = ctx;
    g_rec_mutex_lock(&channel_lock);
    emit("{\"event\":\"ready\"}");
    dbg.attached = true;
    wait_for_orders(ctx, 0);
    g_rec_mutex_unlock(&channel_lock);
}

void bta_debug_stopping(JSContext *ctx, int code)
{
    char *json;

    if (!dbg.on)
        return;

    /* Every watched field back to a data property before the context goes: the
     * cells are held from C, and JS_FreeRuntime aborts on anything left. */
    unwatch_all(ctx);
    json = g_strdup_printf("{\"event\":\"exited\",\"code\":%d}", code);
    emit(json);
    g_free(json);
}

void bta_debug_want(void) { dbg.on = true; }

/*
 * A `Task` worker's context, under the debugger: its runtime gets the same
 * hook, so a breakpoint in code the task runs stops the task -- on the
 * worker's thread, which blocks there and owns the channel while it is stopped
 * (see `channel_lock`), with the window still running. Its stops name the
 * class, and stop-on-throw follows what the IDE last said.
 */
void bta_debug_worker(JSContext *ctx, const char *name)
{
    if (!dbg.on || !dbg.attached)
        return;
    here.ctx  = ctx;
    here.name = name;
    here.mode = RUN;
    g_atomic_int_inc(&debug_workers);
    JS_SetDebugHandler(JS_GetRuntime(ctx), on_step, NULL);
    if (dbg.stop_on_throw)
        JS_DebugStopOnThrow(JS_GetRuntime(ctx), true);
}

/* That worker's context is going: one fewer to take the lock for. */
void bta_debug_worker_done(JSContext *ctx)
{
    (void)ctx;
    if (!here.name)
        return;
    here.name = NULL;
    here.ctx  = NULL;
    g_atomic_int_add(&debug_workers, -1);
}
