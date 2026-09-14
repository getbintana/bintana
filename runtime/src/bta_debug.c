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
 * out in docs/debug-plan.md.
 */

#include "bta.h"

#include <errno.h>
#include <string.h>
#include <poll.h>
#include <unistd.h>

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
};

static struct {
    bool        on;             /* --debug was given */
    bool        attached;       /* the channel is open */
    JSContext  *ctx;
    GPtrArray  *breaks;         /* BtaBreak* */
    GHashTable *lines;          /* a project file -> the lines it can stop on */
    BtaRunMode  mode;
    int         depth;          /* the stack depth a step began at */

} dbg;

/* Declared here because `bta_debug_compiled` is the entry point and reads like
 * one: what a file just compiled means for the breakpoints already armed is the
 * first thing to read, and the machinery it uses is below it. */
static int  bta_cmp_int(const void *a, const void *b);
static void free_break(gpointer p);
static int  resolve_line(const char *file, int line);
static void emit_object(JSContext *ctx, JSValue object);
typedef struct BtaBreakStruct BtaBreak;
static void say_armed(JSContext *ctx, BtaBreak *bp);

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

    if (!dbg.on)
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
    for (guint k = 0; k < dbg.breaks->len; ) {
        BtaBreak *bp = g_ptr_array_index(dbg.breaks, k);
        int       at;

        if (bp->line != bp->asked || !g_str_has_suffix(path, bp->file)) {
            k++;
            continue;
        }
        at = resolve_line(bp->file, bp->asked);
        if (at <= 0) {
            g_ptr_array_remove_index(dbg.breaks, k);   /* nowhere to stop */
            continue;
        }
        bp->line = at;
        say_armed(ctx, bp);
        k++;
    }
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
        if (!g_str_has_suffix(path, file))
            continue;

        for (guint i = 0; i < set->len; i++) {
            int at = g_array_index(set, int, i);
            if (at >= line)
                return at;
        }
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

/* ------------------------------------------------------------------ writing */

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

    if (write(CONTROL_FD, json, len) < 0 || write(CONTROL_FD, nl, 1) < 0) {
        if (errno == EBADF) {
            fprintf(stderr, "bintana debug: %s\n", json);
            return;
        }
    }
}

/* A JS value as the one string a debugger can always show. */
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

/* ------------------------------------------------------------- the stop */

static JSValue frames_of(JSContext *ctx, const uint8_t *pc)
{
    return JS_DebugBacktrace(ctx, pc);
}

static void say_stopped(JSContext *ctx, const uint8_t *pc, const char *reason)
{
    JSValue event = JS_NewObject(ctx);

    JS_SetPropertyStr(ctx, event, "event", JS_NewString(ctx, "stopped"));
    JS_SetPropertyStr(ctx, event, "reason", JS_NewString(ctx, reason));
    JS_SetPropertyStr(ctx, event, "frames", frames_of(ctx, pc));
    emit_object(ctx, event);
}

/* The locals of one frame, rendered. */
static void say_locals(JSContext *ctx, int frame)
{
    JSValue  raw = JS_DebugLocals(ctx, frame);
    JSValue  out = JS_NewObject(ctx);
    JSValue  items = JS_NewArray(ctx);
    uint32_t i, n = 0;

    JS_ToUint32(ctx, &n, JS_GetPropertyStr(ctx, raw, "length"));
    for (i = 0; i < n; i++) {
        JSValue row   = JS_GetPropertyUint32(ctx, raw, i);
        JSValue value = JS_GetPropertyStr(ctx, row, "Value");
        char   *text  = render(ctx, value);
        JSValue item  = JS_NewObject(ctx);

        JS_SetPropertyStr(ctx, item, "Name", JS_GetPropertyStr(ctx, row, "Name"));
        JS_SetPropertyStr(ctx, item, "Value", JS_NewString(ctx, text));
        JS_SetPropertyStr(ctx, item, "Argument",
                          JS_GetPropertyStr(ctx, row, "Argument"));
        JS_SetPropertyUint32(ctx, items, i, item);

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

/* ------------------------------------------------------- reading commands */

static void set_break(JSContext *ctx, JSValue cmd)
{
    BtaBreak   *bp = g_new0(BtaBreak, 1);
    const char *file = NULL, *when = NULL;
    JSValue     v;

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

    /*
     * Moved to a line that exists, and the IDE is told where it went: a mark in
     * the gutter beside a line that can never stop is a lie the programmer then
     * acts on.  A file not compiled yet keeps the line it was given and is
     * resolved by `bta_debug_compiled` when it arrives.
     */
    bp->asked = bp->line;
    int at = resolve_line(bp->file, bp->line);

    if (at == 0) {                      /* past anything that can stop */
        free_break(bp);
        return;
    }
    if (at > 0) {
        bp->line = at;
        g_ptr_array_add(dbg.breaks, bp);
        say_armed(ctx, bp);
        return;
    }
    g_ptr_array_add(dbg.breaks, bp);    /* pending */
}

static void free_break(gpointer p)
{
    BtaBreak *bp = p;
    g_free(bp->file);
    g_free(bp->when);
    g_free(bp);
}

static void clear_break(JSContext *ctx, JSValue cmd)
{
    JSValue v  = JS_GetPropertyStr(ctx, cmd, "id");
    int     id = 0;

    JS_ToInt32(ctx, &id, v);
    JS_FreeValue(ctx, v);

    for (guint i = 0; i < dbg.breaks->len; i++) {
        BtaBreak *bp = g_ptr_array_index(dbg.breaks, i);
        if (bp->id == id) {
            g_ptr_array_remove_index(dbg.breaks, i);
            return;
        }
    }
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
        set_break(ctx, cmd);
    } else if (!strcmp(verb, "clear")) {
        clear_break(ctx, cmd);
    } else if (!strcmp(verb, "continue")) {
        dbg.mode = RUN;
        go = true;
    } else if (!strcmp(verb, "step")) {
        JSValue kv = JS_GetPropertyStr(ctx, cmd, "kind");
        const char *kind = JS_ToCString(ctx, kv);

        dbg.mode  = !kind             ? STEP_INTO
                  : !strcmp(kind, "over") ? STEP_OVER
                  : !strcmp(kind, "out")  ? STEP_OUT
                  : STEP_INTO;
        dbg.depth = depth_now;
        JS_FreeCString(ctx, kind);
        JS_FreeValue(ctx, kv);
        go = true;
    } else if (!strcmp(verb, "locals")) {
        JSValue fv = JS_GetPropertyStr(ctx, cmd, "frame");
        int     frame = 0;
        JS_ToInt32(ctx, &frame, fv);
        JS_FreeValue(ctx, fv);
        say_locals(ctx, frame);
    } else if (!strcmp(verb, "pause")) {
        /* Not a stop of its own: the mode says *the next line, wherever it is*,
           and the stop happens where the program actually is. Asking twice, or
           asking one that is already stopped, changes nothing. */
        dbg.mode = PAUSE;
    }
    /*
     * Anything else is ignored, deliberately: the protocol will grow verbs
     * this build does not have (`stopOnThrow`, `runto`, `eval` -- stages 3 to 6
     * of docs/debug-plan.md), and a debugger that died on one would make every
     * future IDE incompatible with every older runtime. What it must not do is
     * *accept* one and do nothing, which is why none of them is listed above
     * until it works.
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
static void wait_for_orders(JSContext *ctx, int depth_now)
{
    char line[8192];

    for (;;) {
        if (!fgets(line, sizeof line, stdin)) {
            dbg.mode = RUN;
            dbg.attached = false;
            return;
        }
        g_strchomp(line);
        if (!*line)
            continue;
        if (obey(ctx, line, depth_now))
            return;
    }
}

/* ------------------------------------------------------------- the handler */

/* Whether a breakpoint is armed for this place. */
static BtaBreak *break_at(const char *file, int line)
{
    for (guint i = 0; i < dbg.breaks->len; i++) {
        BtaBreak *bp = g_ptr_array_index(dbg.breaks, i);

        if (bp->line != line)
            continue;
        /* The IDE names a file the way the project does and the engine names it
           the way it was loaded, so the shorter one has to be a tail of the
           other -- `forms/Form1.js` against `/home/…/forms/Form1.js`. */
        if (g_str_has_suffix(file, bp->file))
            return bp;
    }
    return NULL;
}

static bool step_wants_this(int depth_now)
{
    switch (dbg.mode) {
    case STEP_INTO: return true;
    case STEP_OVER: return depth_now <= dbg.depth;
    case STEP_OUT:  return depth_now <  dbg.depth;
    case PAUSE:     return true;
    default:        return false;
    }
}

/*
 * Has the IDE said anything while the program was running?
 *
 * Asked only where the program has just moved to a new line, which is rare
 * enough to be free and often enough that *Pause* answers in no time a person
 * can measure. Without it a pause would have to wait for a breakpoint, which is
 * exactly the situation somebody presses Pause in: a program that is not going
 * to reach one.
 */
static void take_messages(JSContext *ctx, int depth_now)
{
    struct pollfd in = { .fd = STDIN_FILENO, .events = POLLIN };
    char          line[8192];

    while (poll(&in, 1, 0) > 0 && (in.revents & POLLIN)) {
        if (!fgets(line, sizeof line, stdin)) {
            dbg.attached = false;
            return;
        }
        g_strchomp(line);
        if (*line)
            obey(ctx, line, depth_now);
    }
}

static void on_step(JSContext *ctx, const uint8_t *pc, void *opaque)
{
    JSAtom    file_atom;
    int       line;
    const char *file;
    BtaBreak *bp;
    int       depth_now;
    bool      wanted;

    (void)opaque;

    /*
     * The free half: with nothing armed and nobody attached there is nothing to
     * work out.  Being attached is enough to keep looking, because *Pause* has
     * to be able to arrive -- and a program that is being debugged at all is one
     * whose speed nobody is measuring.
     */
    if (dbg.mode == RUN && dbg.breaks->len == 0 && !dbg.attached)
        return;

    /* True only where the program has moved to a new line of a new frame:
     * one line is many opcodes, and each frame remembers the line it was last
     * reported at -- so returning from a call does not read as arriving
     * somewhere new. See JS_DebugPosition in quickjs.h.
     *
     * **What it still cannot see** is a loop written entirely on one line --
     * `for (let i = 0; i < 3; i++) total += i;` never leaves the line, so a
     * breakpoint on it stops once. Telling those apart wants the pc rather
     * than the line, which is where stage 5 of docs/debug-plan.md would go. */
    if (!JS_DebugPosition(ctx, pc, &file_atom, &line))
        return;

    depth_now = JS_DebugDepth(JS_GetRuntime(ctx));

    if (dbg.attached)
        take_messages(ctx, depth_now);

    wanted = step_wants_this(depth_now);
    bp     = NULL;

    if (!wanted) {
        file = JS_AtomToCString(ctx, file_atom);
        bp   = file ? break_at(file, line) : NULL;
        JS_FreeCString(ctx, file);
        if (!bp)
            return;
    }

    BtaRunMode was = dbg.mode;

    dbg.mode = RUN;
    say_stopped(ctx, pc,
                wanted ? (was == PAUSE ? "pause" : "step") : "breakpoint");
    wait_for_orders(ctx, depth_now);
}

/* --------------------------------------------------------------- the gate */

bool bta_debug_enabled(void) { return dbg.on; }

void bta_debug_start(JSContext *ctx)
{
    if (!dbg.on)
        return;

    dbg.ctx    = ctx;
    dbg.breaks = g_ptr_array_new_with_free_func(free_break);
    dbg.lines  = g_hash_table_new_full(g_str_hash, g_str_equal, g_free,
                                       (GDestroyNotify)g_array_unref);
    dbg.mode   = RUN;

    JS_SetDebugHandler(JS_GetRuntime(ctx), on_step, NULL);

    /*
     * Say hello and wait, before a line of the project has run: the IDE has
     * breakpoints to set, and a program that started running first would have
     * gone past them. `ready` is the handshake, and the reply that releases it
     * is an ordinary `continue`.
     */
    emit("{\"event\":\"ready\"}");
    dbg.attached = true;
    wait_for_orders(ctx, 0);
}

void bta_debug_stopping(JSContext *ctx, int code)
{
    char *json;

    if (!dbg.on)
        return;

    json = g_strdup_printf("{\"event\":\"exited\",\"code\":%d}", code);
    emit(json);
    g_free(json);
    (void)ctx;
}

void bta_debug_want(void) { dbg.on = true; }
