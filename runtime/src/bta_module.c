/*
 * bta_module.c -- a file that keeps its own names.
 *
 * A file of a project is a script, as it has always been, unless it says
 * `export`: then it is a module, what it exports reaches every other file of
 * the program **without an import**, and what it does not export is its own.
 * docs/plans/modules-plan.md is the design and its measurements; this file is
 * its stages 2 to 4: modules, the explicit `import`, and the load-time check.
 *
 * Three things live here, because four callers need them alike -- the loader,
 * a `Task`'s worker, `Application.Symbols` and `Application.CheckSource`:
 *
 *   bta_compile       which of the two a text is, decided by the compiler
 *   bta_module_run    evaluate a compiled module and hand out its exports
 *   bta_modules_forget  the bookkeeping, when a context goes
 *
 * **How a text is told to be a module.**  Compiled as a script first, which is
 * what every file written so far is; a `SyntaxError` there earns one more
 * compile as a module, and **whichever got further in the text is the
 * answer**.  The text of the error cannot decide it: a script compile names
 * `export` (`unsupported keyword: export`) but answers an `import` declaration
 * with a generic `Unexpected token` after the word.  And the further compile is
 * the right error to report either way: a module that breaks on line 40 says
 * line 40 and not *unsupported keyword* on line 1, and a broken script says its
 * own error, which the module compile reaches no later.  The second compile
 * happens only for a module and for a broken file.  `JS_DetectModule` was
 * measured and is not this: it answers true for nearly every strict script.
 *
 * **Where an export goes: the global object, as an accessor nobody can
 * reconfigure.**  The getter reads the module's namespace, so an `export let`
 * stays live.  Non-configurable is what makes a collision loud in both orders:
 * a script that declares the same name *after* the module is a `SyntaxError`
 * from the engine (a lexical declaration over a non-configurable property of
 * the global object), and one that declared it *before* is found here, by
 * asking the name of the global lexical scope, and refused naming the module.
 * **A name the runtime installs is refused too** -- `export class Timer` would
 * otherwise replace the runtime's for the whole program, where a top-level
 * `class Timer` in a script only shadows it -- and that is the plan's open
 * question answered the loud way.
 *
 * **Two modules exporting one name** is not an error at load: rules 3 and 4 of
 * the plan.  The second owner is written down beside the first -- by the
 * binding it is, so a re-export is not a second owner (fork patch 17) -- and a
 * file that uses the name with no import is refused once every file has
 * loaded, naming its line (bta_modules_check, from fork patch 16's free
 * names).  The getter, already installed, also answers with a `ReferenceError`
 * naming both: the net for a name reached from outside any compiled file --
 * a `.form`'s `type`, `startup`, `Widget.New` -- which no free name lists.
 *
 * **An `import` is standard JavaScript, resolved here (stage 3).**  A path
 * (`./Prices.js`) is a file of the project, or of the library the importing
 * file is in; a bare name (`markdown`) is a library `uses` names, and stands
 * for a module written here whose whole text is one `export * from` per module
 * file of the library -- so the union of its files' exports, with a name two of
 * them export left out by the engine's own rule and refused as *ambiguous*
 * when imported.  A file brought in by an import is evaluated by the engine
 * before the file that imports it, and its exports are handed out like any
 * module's; the loader then finds it done and does not run it twice.  A file
 * with no `export` cannot be imported: its names reach everybody already.
 * While `Application.CheckSource` or `Symbols` compiles a text, nothing is
 * read from the disk -- every import is answered by one empty module, which is
 * enough to compile against.
 */
#include "bta.h"

#include <string.h>

/* ------------------------------------------------------------ compiling */

/*
 * Where an exception says it happened, as one number that orders positions:
 * the first `<name>:LINE:COL` in its stack.  Zero when it says nothing, which
 * sorts before anything that does.
 */
static long error_position(JSContext *ctx, JSValueConst exc, const char *name)
{
    JSValue     stack = JS_GetPropertyStr(ctx, exc, "stack");
    const char *s     = JS_IsString(stack) ? JS_ToCString(ctx, stack) : NULL;
    long        line = 0, column = 0;

    JS_FreeValue(ctx, stack);
    if (!s)
        return 0;

    char       *needle = g_strdup_printf("%s:", name);
    const char *at     = strstr(s, needle);
    if (at) {
        const char *p = at + strlen(needle);
        while (g_ascii_isdigit(*p))
            line = line * 10 + (*p++ - '0');
        if (*p == ':')
            for (p++; g_ascii_isdigit(*p); p++)
                column = column * 10 + (*p - '0');
    }
    g_free(needle);
    JS_FreeCString(ctx, s);
    return line * 100000 + column;
}

/* By its name, which is what the compiler gives every error it raises; the
 * constructor is not something to compare against in a curated global scope. */
static bool is_syntax_error(JSContext *ctx, JSValueConst exc)
{
    if (!JS_IsError(exc))
        return false;
    JSValue     v = JS_GetPropertyStr(ctx, exc, "name");
    const char *s = JS_IsString(v) ? JS_ToCString(ctx, v) : NULL;
    bool        yes = s && !strcmp(s, "SyntaxError");

    JS_FreeCString(ctx, s);
    JS_FreeValue(ctx, v);
    return yes;
}

static JSValue compile_text(JSContext *ctx, const char *src, size_t len,
                            const char *name, bool *is_module)
{
    *is_module = false;

    JSValue script = JS_Eval(ctx, src, len, name,
                             JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_STRICT |
                             JS_EVAL_FLAG_COMPILE_ONLY);
    if (!JS_IsException(script))
        return script;

    JSValue script_exc = JS_GetException(ctx);
    if (!is_syntax_error(ctx, script_exc)) {
        /* Not a syntax error (out of memory, a stack overflow): nothing a
         * module compile would answer differently. */
        return JS_Throw(ctx, script_exc);
    }

    JSValue module = JS_Eval(ctx, src, len, name,
                             JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
    if (!JS_IsException(module)) {
        JS_FreeValue(ctx, script_exc);
        *is_module = true;
        return module;
    }

    /* A module compile that failed with anything but a syntax error read the
     * whole text: it resolves its imports in the same step, so an import of
     * something not there fails after the parse succeeded.  So did one whose
     * syntax error is not in this text at all -- it is a file an import named,
     * compiled in the same step, and its position is in its own name. */
    JSValue module_exc = JS_GetException(ctx);
    long    module_at  = error_position(ctx, module_exc, name);
    if (!is_syntax_error(ctx, module_exc) || module_at == 0 ||
        module_at > error_position(ctx, script_exc, name)) {
        JS_FreeValue(ctx, script_exc);
        *is_module = true;
        return JS_Throw(ctx, module_exc);
    }
    JS_FreeValue(ctx, module_exc);
    return JS_Throw(ctx, script_exc);
}

static void note_uses(JSContext *ctx, JSValueConst compiled, const char *path);

/*
 * Everything that compiles a project's text comes through here, so this is
 * also where the free names a file uses are written down (note_uses): which
 * of them two modules export is only known once every file has loaded.
 */
JSValue bta_compile(JSContext *ctx, const char *src, size_t len,
                    const char *name, bool *is_module)
{
    JSValue r = compile_text(ctx, src, len, name, is_module);
    if (!JS_IsException(r))
        note_uses(ctx, r, name);
    return r;
}

/* ------------------------------------------------------------ the state */

/*
 * Per context, because a `Task` has a context of its own on another thread.
 * Plain C throughout, so forgetting it needs no context and can happen after
 * the runtime is gone: who exports what, which files are already modules of
 * this context, what an import brought in and has not been handed out yet, and
 * where imports are resolved.
 */
typedef struct {
    GHashTable *owners;     /* name -> GPtrArray of paths, in export order */
    GHashTable *done;       /* canonical path -> GINT_TO_POINTER(1): loaded */
    GPtrArray  *pending;    /* Pending: brought in by an import, not handed out */
    char       *project;    /* where `./x.js` may point; NULL for anywhere */
    GPtrArray  *libs;       /* the directories `uses` resolved to */
    int         checking;   /* > 0 while CheckSource or Symbols compiles */
    GPtrArray  *uses;       /* Uses: each file's free names, until checked */
    GHashTable *loading;    /* library name -> 1 while load_library runs */
    GHashTable *declared;   /* name -> GPtrArray of the modules declaring it */
} ModState;

/* The free names one file uses, each at the first line it is used on. */
typedef struct {
    char       *path;
    GHashTable *lines;      /* name -> GINT_TO_POINTER(line) */
    GHashTable *needs;      /* the same, less the names only `typeof` asks */
} Uses;

static void uses_free(gpointer p)
{
    Uses *u = p;
    g_free(u->path);
    g_hash_table_unref(u->lines);
    if (u->needs)
        g_hash_table_unref(u->needs);
    g_free(u);
}

typedef struct {
    char        *path;
    JSModuleDef *m;
} Pending;

static void pending_free(gpointer p)
{
    g_free(((Pending *)p)->path);
    g_free(p);
}

/*
 * The lock guards `state_by_ctx` and the tables a context shares with nothing
 * else only where it was cheap to be uniform (owners, uses).  A context is used
 * by one thread -- the main one, or its `Task`'s worker -- so `done`,
 * `pending`, `loading` and `checking` are read and written without it; what
 * the lock is for is the map from contexts to states, which every thread
 * touches.
 */
static GMutex      owners_lock;
static GHashTable *state_by_ctx;    /* JSContext* -> ModState* */

static void state_free(ModState *st)
{
    g_hash_table_unref(st->owners);
    g_hash_table_unref(st->done);
    g_ptr_array_unref(st->pending);
    g_ptr_array_unref(st->uses);
    g_hash_table_unref(st->loading);
    g_hash_table_unref(st->declared);
    g_free(st->project);
    if (st->libs)
        g_ptr_array_unref(st->libs);
    g_free(st);
}

static ModState *state_of(JSContext *ctx, bool make)
{
    ModState *st = NULL;

    g_mutex_lock(&owners_lock);
    if (!state_by_ctx && make)
        state_by_ctx = g_hash_table_new(g_direct_hash, g_direct_equal);
    if (state_by_ctx) {
        st = g_hash_table_lookup(state_by_ctx, ctx);
        if (!st && make) {
            st = g_new0(ModState, 1);
            st->owners  = g_hash_table_new_full(g_str_hash, g_str_equal, g_free,
                                                (GDestroyNotify)g_ptr_array_unref);
            st->done    = g_hash_table_new_full(g_str_hash, g_str_equal, g_free,
                                                NULL);
            st->pending = g_ptr_array_new_with_free_func(pending_free);
            st->uses    = g_ptr_array_new_with_free_func(uses_free);
            st->loading = g_hash_table_new_full(g_str_hash, g_str_equal, g_free,
                                                NULL);
            st->declared = g_hash_table_new_full(g_str_hash, g_str_equal, g_free,
                                                 (GDestroyNotify)g_ptr_array_unref);
            g_hash_table_insert(state_by_ctx, ctx, st);
        }
    }
    g_mutex_unlock(&owners_lock);
    return st;
}

static GHashTable *owners_of(JSContext *ctx, bool make)
{
    ModState *st = state_of(ctx, make);
    return st ? st->owners : NULL;
}

void bta_modules_forget(JSContext *ctx)
{
    g_mutex_lock(&owners_lock);
    if (state_by_ctx) {
        ModState *st = g_hash_table_lookup(state_by_ctx, ctx);
        if (st) {
            g_hash_table_remove(state_by_ctx, ctx);
            state_free(st);
        }
    }
    g_mutex_unlock(&owners_lock);
}

bool bta_module_exported(JSContext *ctx, const char *name)
{
    GHashTable *t = owners_of(ctx, false);
    bool        yes;

    g_mutex_lock(&owners_lock);
    yes = t && g_hash_table_contains(t, name);
    g_mutex_unlock(&owners_lock);
    return yes;
}

bool bta_module_done(JSContext *ctx, const char *path)
{
    ModState *st = state_of(ctx, false);
    return st && g_hash_table_contains(st->done, path);
}

void bta_modules_checking(JSContext *ctx, bool on)
{
    ModState *st = state_of(ctx, true);
    st->checking += on ? 1 : -1;
}

static bool path_inside(const char *path, const char *root);

/*
 * A file as a message names it: relative to the project when it is in it
 * (`Csv.js`, `parsers/Csv.js`), as `<library>/<file>` when it is in a library
 * of `uses`, whole otherwise -- a basename alone made two `Csv.js` in two
 * folders one name in the very sentence that is about telling them apart.
 */
static char *shown_path(ModState *st, const char *path)
{
    if (st && st->project && path_inside(path, st->project))
        return g_strdup(path + strlen(st->project) + 1);
    for (guint i = 0; st && st->libs && i < st->libs->len; i++) {
        char *lib = g_canonicalize_filename(st->libs->pdata[i], NULL);
        if (path_inside(path, lib)) {
            char *name = g_path_get_basename(lib);
            char *out  = g_build_filename(name, path + strlen(lib) + 1, NULL);
            g_free(name);
            g_free(lib);
            return out;
        }
        g_free(lib);
    }
    return g_strdup(path);
}

/*
 * An owner is written `<path>\n<local name>`: the module whose own binding an
 * export is, and that binding's name there -- what JS_GetExportOrigin answers.
 * Two files exporting one binding (a re-export) are one owner; two bindings are
 * two, whatever they hold.
 */
static char *owner_key(const char *path, const char *local)
{
    return g_strconcat(path, "\n", local, NULL);
}

/* The owners of a name as a sentence: `Lib.js and Other.js`. */
static char *owners_text(ModState *st, GPtrArray *owners)
{
    GString *out = g_string_new(NULL);

    for (guint i = 0; i < owners->len; i++) {
        const char *key  = owners->pdata[i];
        char       *path = g_strndup(key, strcspn(key, "\n"));
        char       *shown = shown_path(st, path);
        if (i)
            g_string_append(out, i + 1 == owners->len ? " and " : ", ");
        g_string_append(out, shown);
        g_free(shown);
        g_free(path);
    }
    return g_string_free(out, FALSE);
}

/* ------------------------------------------------------------ free names */

static void note_one(JSContext *ctx, JSAtom name, int line, void *opaque)
{
    Uses       *u = opaque;
    const char *s = JS_AtomToCString(ctx, name);

    if (!s) {
        JS_FreeValue(ctx, JS_GetException(ctx));
        return;
    }
    gpointer at;
    if (!g_hash_table_lookup_extended(u->lines, s, NULL, &at) ||
        line < GPOINTER_TO_INT(at))
        g_hash_table_insert(u->lines, g_strdup(s), GINT_TO_POINTER(line));
    JS_FreeCString(ctx, s);
}

/*
 * Writes down the names a compiled file looks up in the global scope (fork
 * patch 16), so bta_modules_check can ask, once every file is in, whether one
 * of them is a name two modules export.  An imported name is bound and a
 * module's own top level is bound, so neither is here -- which is exactly the
 * set the getter would refuse at the use.  Not while a text is only checked.
 */
static void note_uses(JSContext *ctx, JSValueConst compiled, const char *path)
{
    ModState *st = state_of(ctx, true);

    if (st->checking)
        return;

    Uses *u  = g_new0(Uses, 1);
    u->path  = g_strdup(path);
    u->lines = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, NULL);
    JS_EnumFreeNames(ctx, compiled, note_one, u);
    /* `typeof X` asks whether a name exists, so it is no use of another
     * module's private name -- only of an ambiguous one, whose getter throws
     * for it as for any read. */
    Uses need = { u->path, g_hash_table_new_full(g_str_hash, g_str_equal,
                                                 g_free, NULL), NULL };
    JS_EnumFreeNamesFlags(ctx, compiled, JS_FREE_NAMES_SKIP_TYPEOF, note_one,
                          &need);
    u->needs = need.lines;

    /* A module's own top level (fork patch 18), exported or not: what a file
     * may be reaching for when it uses a name nothing else declares. */
    Uses decl = { (char *)path, g_hash_table_new_full(g_str_hash, g_str_equal,
                                                      g_free, NULL), NULL };
    JS_EnumModuleDeclarations(ctx, compiled, note_one, &decl);

    g_mutex_lock(&owners_lock);
    g_ptr_array_add(st->uses, u);
    GHashTableIter it;
    gpointer       k;
    g_hash_table_iter_init(&it, decl.lines);
    while (g_hash_table_iter_next(&it, &k, NULL)) {
        GPtrArray *who = g_hash_table_lookup(st->declared, k);
        if (!who) {
            who = g_ptr_array_new_with_free_func(g_free);
            g_hash_table_insert(st->declared, g_strdup(k), who);
        }
        g_ptr_array_add(who, g_strdup(path));
    }
    g_mutex_unlock(&owners_lock);
    g_hash_table_unref(decl.lines);
}

#define REFUSALS_SHOWN 20

/* One thing a file uses that the load refuses. */
typedef struct {
    guint  file;        /* index of the file in load order */
    int    line;
    char  *name;
    char  *text;        /* the sentence, file and line not yet in front */
    bool   private;     /* refused only if nothing else answers the name */
} Refusal;

static void refusal_free(gpointer p)
{
    Refusal *r = p;
    g_free(r->name);
    g_free(r->text);
    g_free(r);
}

static gint refusal_order(gconstpointer a, gconstpointer b)
{
    const Refusal *x = *(Refusal *const *)a, *y = *(Refusal *const *)b;
    if (x->file != y->file)
        return x->file < y->file ? -1 : 1;
    if (x->line != y->line)
        return x->line < y->line ? -1 : 1;
    return strcmp(x->name, y->name);
}

static bool lexical_has(JSContext *ctx, const char *name);

int bta_modules_check(JSContext *ctx)
{
    ModState  *st = state_of(ctx, false);
    GPtrArray *found = g_ptr_array_new_with_free_func(refusal_free);
    char      *msg = NULL;

    if (!st) {
        g_ptr_array_unref(found);
        return 0;
    }

    /* Two refusals, both about a free name of a file:
     *   - two modules export it, and the file did not import one (rules 3
     *     and 4 of the plan);
     *   - a module declares it and keeps it to itself, and nothing else in the
     *     program has it -- a forgotten `export`, which would otherwise be a
     *     ReferenceError on the day that line runs, and only then.
     * The second needs the program asked (a script's top-level `let`, a
     * global a library set up), so it is gathered here and asked below, out
     * of the lock. */
    g_mutex_lock(&owners_lock);
    for (guint i = 0; i < st->uses->len; i++) {
        Uses          *u = st->uses->pdata[i];
        GHashTableIter it;
        gpointer       k, v;

        g_hash_table_iter_init(&it, u->lines);
        while (g_hash_table_iter_next(&it, &k, &v)) {
            GPtrArray *owners = g_hash_table_lookup(st->owners, k);
            GPtrArray *decl   = owners ? NULL
                                       : g_hash_table_lookup(st->declared, k);
            Refusal   *r      = NULL;

            if (owners && owners->len > 1) {
                char *who = owners_text(st, owners);
                r = g_new0(Refusal, 1);
                r->text = g_strdup_printf("'%s' is exported by %s: choose one "
                                          "with import", (char *)k, who);
                g_free(who);
            } else if (decl && g_hash_table_contains(u->needs, k)) {
                char *where = NULL;
                for (guint j = 0; j < decl->len && !where; j++)
                    if (strcmp(decl->pdata[j], u->path))
                        where = shown_path(st, decl->pdata[j]);
                if (where) {
                    r = g_new0(Refusal, 1);
                    r->private = true;
                    r->text = g_strdup_printf("'%s' is declared in %s, which "
                                              "keeps it to itself: export it "
                                              "there", (char *)k, where);
                    g_free(where);
                }
            }
            if (r) {
                r->file = i;
                r->line = GPOINTER_TO_INT(r->private
                                          ? g_hash_table_lookup(u->needs, k) : v);
                r->name = g_strdup(k);
                g_ptr_array_add(found, r);
            }
        }
    }
    g_mutex_unlock(&owners_lock);

    /* The first in load order and line, so the answer does not depend on the
     * order a hash table walks in. */
    g_ptr_array_sort(found, refusal_order);
    /* Every one, not the first: adopting `export` file by file is exactly
     * when several are missing at once, and one per run is a migration done
     * by trial.  A long list is cut, saying how many were left out. */
    JSValue  global = JS_GetGlobalObject(ctx);
    GString *all    = g_string_new(NULL);
    guint    count  = 0;
    for (guint i = 0; i < found->len; i++) {
        Refusal *r = found->pdata[i];
        if (r->private) {
            JSAtom a   = JS_NewAtom(ctx, r->name);
            int    has = JS_HasProperty(ctx, global, a);
            JS_FreeAtom(ctx, a);
            if (has < 0)
                JS_FreeValue(ctx, JS_GetException(ctx));
            if (has > 0 || lexical_has(ctx, r->name))
                continue;
        }
        if (++count <= REFUSALS_SHOWN) {
            Uses *u    = st->uses->pdata[r->file];
            char *file = shown_path(st, u->path);
            g_string_append_printf(all, "%s%s:%d: %s", all->len ? "\n" : "",
                                   file, r->line, r->text);
            g_free(file);
        }
    }
    if (count > REFUSALS_SHOWN)
        g_string_append_printf(all, "\n... and %u more", count - REFUSALS_SHOWN);
    msg = count ? g_string_free(all, FALSE) : (g_string_free(all, TRUE), NULL);
    JS_FreeValue(ctx, global);
    g_ptr_array_unref(found);

    /* Asked once, when the program is in: nothing loads after it. */
    g_mutex_lock(&owners_lock);
    g_ptr_array_set_size(st->uses, 0);
    g_mutex_unlock(&owners_lock);

    if (msg) {
        JS_ThrowReferenceError(ctx, "%s", msg);
        g_free(msg);
        return -1;
    }
    return 0;
}

/*
 * A script that declares at its top level a name a module already exported is
 * refused by the engine itself -- the export is a non-configurable property of
 * the global object -- with *redeclaration of 'X'*, which names neither file.
 * The other order is refused here and names the module, so this one does too:
 * the pending error is looked at and, when it is that one, replaced.
 */
void bta_modules_explain(JSContext *ctx, const char *path)
{
    ModState *st = state_of(ctx, false);
    if (!st)
        return;

    JSValue     exc  = JS_GetException(ctx);
    JSValue     m    = JS_IsError(exc) ? JS_GetPropertyStr(ctx, exc, "message")
                                       : JS_UNDEFINED;
    const char *text = JS_IsString(m) ? JS_ToCString(ctx, m) : NULL;
    const char *pre  = "redeclaration of '";
    char       *name = NULL;

    if (text && g_str_has_prefix(text, pre) && g_str_has_suffix(text, "'"))
        name = g_strndup(text + strlen(pre), strlen(text) - strlen(pre) - 1);
    JS_FreeCString(ctx, text);
    JS_FreeValue(ctx, m);

    char *who = NULL;
    if (name) {
        g_mutex_lock(&owners_lock);
        GPtrArray *owners = g_hash_table_lookup(st->owners, name);
        if (owners)
            who = owners_text(st, owners);
        g_mutex_unlock(&owners_lock);
    }
    if (!who) {
        g_free(name);
        JS_Throw(ctx, exc);
        return;
    }
    JS_FreeValue(ctx, exc);
    char *file = shown_path(st, path);
    JS_ThrowSyntaxError(ctx, "%s declares '%s' at its top level, which %s "
                        "already exports: one of the two has to change -- or "
                        "use the export and drop the declaration", file, name,
                        who);
    g_free(file);
    g_free(who);
    g_free(name);
}

/*
 * The getter every export is reached through.  data[0] is the name, data[1]
 * the namespace of the module that exported it first.
 */
static JSValue export_get(JSContext *ctx, JSValueConst this_val, int argc,
                          JSValueConst *argv, int magic, JSValueConst *data)
{
    (void)this_val; (void)argc; (void)argv; (void)magic;

    const char *name = JS_ToCString(ctx, data[0]);
    if (!name)
        return JS_EXCEPTION;

    ModState   *st        = state_of(ctx, false);
    GHashTable *t         = st ? st->owners : NULL;
    char       *ambiguous = NULL;

    g_mutex_lock(&owners_lock);
    GPtrArray *owners = t ? g_hash_table_lookup(t, name) : NULL;
    if (owners && owners->len > 1)
        ambiguous = owners_text(st, owners);
    g_mutex_unlock(&owners_lock);

    if (ambiguous) {
        JSValue e = JS_ThrowReferenceError(ctx, "'%s' is exported by %s: choose "
                                           "one with import", name, ambiguous);
        g_free(ambiguous);
        JS_FreeCString(ctx, name);
        return e;
    }
    JSValue v = JS_GetPropertyStr(ctx, data[1], name);
    JS_FreeCString(ctx, name);
    return v;
}

/*
 * Whether the global lexical scope already has `name` -- a top-level `class`,
 * `let` or `const` of a script, which is not a property of the global object
 * and so is invisible to every property question.  Evaluating the bare name is
 * the one question that reaches it; the caller has already ruled out the
 * global object.  A binding still in its dead zone answers like a missing one,
 * which only a script that is still running could have.
 */
static bool lexical_has(JSContext *ctx, const char *name)
{
    JSValue v = JS_Eval(ctx, name, strlen(name), "<export>", JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(v)) {
        JS_FreeValue(ctx, JS_GetException(ctx));
        return false;
    }
    JS_FreeValue(ctx, v);
    return true;
}

static int distribute(JSContext *ctx, JSValueConst global, JSValueConst ns,
                      JSModuleDef *m, JSAtom atom, const char *path)
{
    ModState   *st   = state_of(ctx, true);
    const char *name = JS_AtomToCString(ctx, atom);
    char       *file = shown_path(st, path);        /* what the messages say */
    char       *key  = NULL;
    int         rc   = -1;

    if (!name) {
        g_free(file);
        return -1;
    }

    /* A default export has no name for the other files to use: it is reached
     * only by an import, which names it there. */
    if (!strcmp(name, "default")) {
        rc = 0;
        goto out;
    }

    /* Who the binding belongs to, through any re-export (fork patch 17): a
     * file that re-exports what it imported (`export { withIva } from
     * "./Prices.js"`) hands out the very binding the first owner did, and is
     * not a second answer.  Comparing the values instead let two `export let
     * count = 0` pass for one -- two bindings that held the same number. */
    JSAtom local  = JS_ATOM_NULL;
    JSAtom origin = JS_GetExportOrigin(ctx, m, atom, &local);
    if (origin != JS_ATOM_NULL) {
        const char *o = JS_AtomToCString(ctx, origin);
        const char *l = JS_AtomToCString(ctx, local);
        if (o && l)
            key = owner_key(o, l);
        JS_FreeCString(ctx, o);
        JS_FreeCString(ctx, l);
        JS_FreeAtom(ctx, origin);
        JS_FreeAtom(ctx, local);
    }
    if (!key) {
        if (JS_HasException(ctx))
            JS_FreeValue(ctx, JS_GetException(ctx));
        key = owner_key(path, name);
    }

    GHashTable *t = st->owners;
    g_mutex_lock(&owners_lock);
    GPtrArray *owners = g_hash_table_lookup(t, name);
    bool       seen   = false;
    guint      count  = owners ? owners->len : 0;
    for (guint i = 0; i < count && !seen; i++)
        seen = !strcmp(owners->pdata[i], key);
    g_mutex_unlock(&owners_lock);

    if (owners) {
        /* A second owner: the getter is already there, and from now on it
         * names both -- unless it is the same binding. */
        if (!seen) {
            g_mutex_lock(&owners_lock);
            g_ptr_array_add(owners, key);
            key = NULL;
            g_mutex_unlock(&owners_lock);
        }
        rc = 0;
        goto out;
    }

    int has = JS_HasProperty(ctx, global, atom);
    if (has < 0)
        goto out;
    if (has) {
        JS_ThrowSyntaxError(ctx, "%s exports '%s', which is already a name of "
                            "the runtime or of a script: give it another",
                            file, name);
        goto out;
    }
    if (lexical_has(ctx, name)) {
        JS_ThrowSyntaxError(ctx, "%s exports '%s', which a script already "
                            "declares at its top level: one of the two has to "
                            "change", file, name);
        goto out;
    }

    JSValue data[2] = { JS_NewString(ctx, name), JS_DupValue(ctx, ns) };
    JSValue getter  = JS_NewCFunctionData(ctx, export_get, 0, 0, 2, data);
    JS_FreeValue(ctx, data[0]);
    JS_FreeValue(ctx, data[1]);
    if (JS_IsException(getter))
        goto out;

    if (JS_DefineProperty(ctx, global, atom, JS_UNDEFINED, getter, JS_UNDEFINED,
                          JS_PROP_HAS_GET | JS_PROP_HAS_CONFIGURABLE |
                          JS_PROP_HAS_ENUMERABLE | JS_PROP_THROW) < 0) {
        JS_FreeValue(ctx, getter);
        goto out;
    }
    JS_FreeValue(ctx, getter);

    owners = g_ptr_array_new_with_free_func(g_free);
    g_ptr_array_add(owners, key);
    key = NULL;
    g_mutex_lock(&owners_lock);
    g_hash_table_insert(t, g_strdup(name), owners);
    g_mutex_unlock(&owners_lock);
    rc = 0;

out:
    JS_FreeCString(ctx, name);
    g_free(file);
    g_free(key);
    return rc;
}

/* Hands out what an evaluated module exports. */
static int distribute_module(JSContext *ctx, JSModuleDef *m, const char *path)
{
    JSValue ns = JS_GetModuleNamespace(ctx, m);
    if (JS_IsException(ns))
        return -1;

    JSValue         global = JS_GetGlobalObject(ctx);
    JSPropertyEnum *tab    = NULL;
    uint32_t        n      = 0;
    int             rc     = 0;

    if (JS_GetOwnPropertyNames(ctx, &tab, &n, ns,
                               JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) < 0) {
        rc = -1;
    } else {
        for (uint32_t i = 0; i < n && rc == 0; i++)
            rc = distribute(ctx, global, ns, m, tab[i].atom, path);
        JS_FreePropertyEnum(ctx, tab, n);
    }
    JS_FreeValue(ctx, global);
    JS_FreeValue(ctx, ns);
    return rc;
}

int bta_module_run(JSContext *ctx, JSValue compiled, const char *path)
{
    JSModuleDef *m       = JS_VALUE_GET_PTR(compiled);
    ModState    *st      = state_of(ctx, true);
    JSValue      promise = JS_EvalFunction(ctx, compiled);   /* takes it */

    g_hash_table_add(st->done, g_strdup(path));
    if (JS_IsException(promise))
        return -1;

    /* A module is evaluated through a promise -- the reason the intrinsic is
     * registered -- and with top-level `await` refused (fork patch 13) it is
     * settled once the queue has run. */
    bta_drain_jobs(JS_GetRuntime(ctx));
    JSPromiseStateEnum state = JS_PromiseState(ctx, promise);
    if (state == JS_PROMISE_REJECTED) {
        JSValue why = JS_PromiseResult(ctx, promise);
        JS_FreeValue(ctx, promise);
        JS_Throw(ctx, why);
        return -1;
    }
    JS_FreeValue(ctx, promise);
    if (state != JS_PROMISE_FULFILLED) {
        JS_ThrowPlainError(ctx, "%s: the module did not finish evaluating",
                              path);
        return -1;
    }

    /* What its imports brought in was evaluated first, by the engine, and is
     * handed out first: it is what a later file reaches by name, exactly as if
     * it had been loaded on its own. */
    while (st->pending->len) {
        Pending *p  = g_ptr_array_steal_index(st->pending, 0);
        int      rc = distribute_module(ctx, p->m, p->path);
        pending_free(p);
        if (rc < 0)
            return -1;
    }
    return distribute_module(ctx, m, path);
}

/* ------------------------------------------------------------ importing */

/* The answer to an import while a text is only being checked. */
#define UNCHECKED "<import>"

static int unchecked_init(JSContext *ctx, JSModuleDef *m)
{
    (void)ctx; (void)m;
    return 0;
}

/* `path` is under `root`. */
static bool path_inside(const char *path, const char *root)
{
    size_t n = strlen(root);
    return !strncmp(path, root, n) &&
           (path[n] == G_DIR_SEPARATOR || (n && root[n - 1] == G_DIR_SEPARATOR));
}

static char *js_strdup_c(JSContext *ctx, const char *s)
{
    size_t n   = strlen(s) + 1;
    char  *out = js_malloc(ctx, n);
    if (out)
        memcpy(out, s, n);
    return out;
}

static const char *library_named(ModState *st, const char *name)
{
    for (guint i = 0; st && st->libs && i < st->libs->len; i++) {
        char *base = g_path_get_basename(st->libs->pdata[i]);
        bool  same = !strcmp(base, name);
        g_free(base);
        if (same)
            return st->libs->pdata[i];
    }
    return NULL;
}

static char *module_normalize(JSContext *ctx, const char *base,
                              const char *spec, void *opaque)
{
    (void)opaque;
    ModState *st = state_of(ctx, false);

    if (st && st->checking)
        return js_strdup_c(ctx, UNCHECKED);

    bool path = spec[0] == '/' || g_str_has_prefix(spec, "./") ||
                g_str_has_prefix(spec, "../");

    if (!path) {
        if (library_named(st, spec))
            return js_strdup_c(ctx, spec);
        char *from = g_path_get_basename(base);
        JS_ThrowReferenceError(ctx, "%s imports '%s', and no library of that "
                               "name is in project.json's \"uses\" -- add it "
                               "there, or write a file as a path (\"./%s.js\")",
                               from, spec, spec);
        g_free(from);
        return NULL;
    }

    /* A library's own module names its files by their whole path. */
    char *dir = NULL;
    if (spec[0] != '/') {
        if (!g_path_is_absolute(base)) {
            JS_ThrowReferenceError(ctx, "import from '%s': %s is not a file, so "
                                   "there is nothing for the path to be "
                                   "relative to", spec, base);
            return NULL;
        }
        dir = g_path_get_dirname(base);
    }
    char *full = g_canonicalize_filename(spec, dir);
    g_free(dir);

    /* Inside the project, or inside a library it uses: an import is not a way
     * to read the disk.  The test is on the path as written, not as the disk
     * resolves it, so a symlink inside the project that points out of it is
     * followed -- whoever made the link put it there, and the project is the
     * author's own code anyway; the rule keeps a typo of `../` from reaching
     * another program's files, not the author out of their own disk. */
    bool ok = !st || (!st->project && !st->libs);
    if (st && st->project && path_inside(full, st->project))
        ok = true;
    for (guint i = 0; !ok && st && st->libs && i < st->libs->len; i++) {
        char *lib = g_canonicalize_filename(st->libs->pdata[i], NULL);
        ok = path_inside(full, lib);
        g_free(lib);
    }
    if (!ok) {
        char *from = g_path_get_basename(base);
        JS_ThrowReferenceError(ctx, "%s imports '%s', which is outside the "
                               "project and its libraries", from, spec);
        g_free(from);
        g_free(full);
        return NULL;
    }

    if (!g_file_test(full, G_FILE_TEST_IS_REGULAR)) {
        char *from = g_path_get_basename(base);
        JS_ThrowReferenceError(ctx, "%s imports '%s', and there is no such "
                               "file (%s)", from, spec, full);
        g_free(from);
        g_free(full);
        return NULL;
    }

    char *out = js_strdup_c(ctx, full);
    g_free(full);
    return out;
}

/* Compiles a file an import names; NULL with the exception pending. */
static JSModuleDef *load_file(JSContext *ctx, ModState *st, const char *path,
                              bool quiet_script)
{
    size_t len;
    char  *src = bta_read_file(path, &len);
    char  *file = g_path_get_basename(path);

    if (!src) {
        JS_ThrowReferenceError(ctx, "import of %s: there is no such file "
                               "(%s)", file, path);
        g_free(file);
        return NULL;
    }

    bool    is_module;
    JSValue r = bta_compile(ctx, src, len, path, &is_module);
    g_free(src);
    if (JS_IsException(r)) {
        g_free(file);
        return NULL;
    }
    if (!is_module) {
        JS_FreeValue(ctx, r);
        if (!quiet_script)
            JS_ThrowReferenceError(ctx, "import of %s: it exports nothing -- a "
                                   "file with no export is a script, and its "
                                   "names reach every file without an import",
                                   file);
        g_free(file);
        return NULL;
    }
    g_free(file);

    JSModuleDef *m = JS_VALUE_GET_PTR(r);
    bta_debug_compiled(ctx, path, r);
    JS_FreeValue(ctx, r);

    Pending *p = g_new0(Pending, 1);
    p->path = g_strdup(path);
    p->m    = m;
    g_ptr_array_add(st->pending, p);
    g_hash_table_add(st->done, g_strdup(path));
    return m;
}

/*
 * A library as one module: `export * from` each of its files that is a module.
 * A file already loaded is the engine's to find by its name; one not loaded
 * yet -- in a worker, or a library that comes later in `uses` -- is compiled
 * here, and a script is left for the loader, since it has nothing to import.
 */
static JSModuleDef *load_library1(JSContext *ctx, ModState *st,
                                  const char *name, const char *dir);

/*
 * The library's module is registered only once its files are compiled, so an
 * import of it from one of those files -- its own name, or a second library
 * that imports the first back -- would start it again, and again, until the
 * stack ran out with nothing said.  It is refused with a sentence instead.
 */
static JSModuleDef *load_library(JSContext *ctx, ModState *st, const char *name,
                                 const char *dir)
{
    if (g_hash_table_contains(st->loading, name)) {
        JS_ThrowReferenceError(ctx, "import from '%s' while that library is "
                               "still loading: a file of a library imports "
                               "another file of it by path (\"./X.js\"), not "
                               "by the library's name -- and two libraries "
                               "cannot import each other", name);
        return NULL;
    }
    g_hash_table_add(st->loading, g_strdup(name));
    JSModuleDef *m = load_library1(ctx, st, name, dir);
    g_hash_table_remove(st->loading, name);
    return m;
}

static JSModuleDef *load_library1(JSContext *ctx, ModState *st,
                                  const char *name, const char *dir)
{
    GPtrArray *files = bta_library_sources(ctx, dir);
    GString   *text  = g_string_new(NULL);

    for (guint i = 0; i < files->len; i++) {
        char *path = g_canonicalize_filename(files->pdata[i], NULL);

        if (!g_hash_table_contains(st->done, path)) {
            if (!load_file(ctx, st, path, true)) {
                if (JS_HasException(ctx)) {
                    g_free(path);
                    g_ptr_array_unref(files);
                    g_string_free(text, TRUE);
                    return NULL;
                }
                g_free(path);
                continue;   /* a script */
            }
        }
        g_string_append(text, "export * from \"");
        for (const char *c = path; *c; c++) {
            if (*c == '"' || *c == '\\')
                g_string_append_c(text, '\\');
            g_string_append_c(text, *c);
        }
        g_string_append(text, "\";\n");
        g_free(path);
    }
    g_ptr_array_unref(files);

    if (!text->len) {
        g_string_free(text, TRUE);
        JS_ThrowReferenceError(ctx, "import from '%s': the library exports "
                               "nothing -- its classes are reached by name, "
                               "with no import", name);
        return NULL;
    }

    JSValue r = JS_Eval(ctx, text->str, text->len, name,
                        JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
    g_string_free(text, TRUE);
    if (JS_IsException(r))
        return NULL;

    JSModuleDef *m = JS_VALUE_GET_PTR(r);
    JS_FreeValue(ctx, r);
    return m;
}

static JSModuleDef *module_load(JSContext *ctx, const char *name, void *opaque)
{
    (void)opaque;
    ModState *st = state_of(ctx, true);

    if (!strcmp(name, UNCHECKED))
        return JS_NewCModule(ctx, UNCHECKED, unchecked_init);

    const char *lib = name[0] != '/' ? library_named(st, name) : NULL;
    if (lib)
        return load_library(ctx, st, name, lib);
    return load_file(ctx, st, name, false);
}

void bta_modules_scope(JSContext *ctx, const char *project, GPtrArray *libs)
{
    ModState *st = state_of(ctx, true);

    g_free(st->project);
    st->project = project && *project ? g_canonicalize_filename(project, NULL)
                                      : NULL;
    if (st->libs)
        g_ptr_array_unref(st->libs);
    st->libs = g_ptr_array_new_with_free_func(g_free);
    for (guint i = 0; libs && i < libs->len; i++)
        g_ptr_array_add(st->libs, g_strdup(libs->pdata[i]));

    JS_SetModuleLoaderFunc(JS_GetRuntime(ctx), module_normalize, module_load,
                           NULL);
}
