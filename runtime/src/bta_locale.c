/*
 * Locale -- the project's own translations, read from <project>/po/<lang>.po.
 *
 * Found by name, the way <project>/icons and <project>/app.css are: nothing in
 * project.json points at it, so nothing has to be configured for a project to
 * become translatable.
 *
 * **The .po and not the .mo, on purpose.**  A project directory holds sources;
 * nothing in it is generated or compiled, and a catalogue is no exception.  The
 * cost is parsing a text file at startup instead of mapping a hash table, which
 * for the few hundred strings a form-based application has is not measurable.
 * What it buys is that the file in the tree is the same file Poedit and Weblate
 * edit -- .mo is only .po compiled -- so the tooling works without this runtime
 * knowing that any of it exists.
 *
 * The literal is the key, which is gettext's bargain and Qt's: a form reads as
 * prose with no indirection, an untranslated application shows real text rather
 * than `@string/save`, and two forms that both say "Save" share one entry
 * without anybody arranging it.
 */
#include "bta.h"

#include <inttypes.h>
#include <limits.h>    /* CHAR_MAX, which is localeconv's "stop grouping" */
#include <locale.h>
#include <math.h>      /* isfinite, for a value Number will not write */
#include <stdio.h>
#include <string.h>

/*
 * gettext's own way of keying a string that has a context: the two joined by
 * EOT.  Worth following exactly, because it is what a .po file's msgctxt means
 * and what every tool that writes one assumes.
 */
#define CTXT_SEP "\004"

typedef struct {
    GPtrArray *forms;   /* char*, one per plural form; [0] is the singular */
} Entry;

static struct {
    /*
     * The catalogue directories, in **load order**: every library's `po/` first
     * and the project's last, so a project that translates a string a library
     * also translates wins. Empty before init.
     *
     * One table and several files, rather than a domain per library: a `Locale.Text`
     * cannot say which library it is in -- it is a call in somebody's method --
     * so a domain would have to be deduced from the caller, which is a stack walk
     * to answer a question nobody asked. What a library ships is prose in the
     * same application, and the application's own wording wins.
     */
    GPtrArray  *dirs;       /* char*, "<somewhere>/po" */
    char       *language;   /* the catalogue in use; "" when there is none */
    GHashTable *entries;    /* key -> Entry*, NULL when there is no catalogue */
    int         nplurals;
    char       *plural;     /* the expression out of Plural-Forms */
} L;

static void entry_free(gpointer p)
{
    Entry *e = p;
    g_ptr_array_free(e->forms, TRUE);
    g_free(e);
}

/* ------------------------------------------------------------ plural forms
 *
 * A .po header carries its language's rule as a C expression over `n`:
 *
 *   Plural-Forms: nplurals=3; plural=(n%10==1 && n%100!=11 ? 0 : n != 0 ? 1 : 2);
 *
 * There is no way around evaluating it.  `eval` is not part of this language
 * (and is removed from the context before any project code runs), and a table
 * of known languages would be wrong for the next one -- so the expression is
 * parsed here.  The grammar is small and closed: C's conditional expression
 * over one variable and integer literals, nothing that can reach out.
 */
typedef struct {
    const char *p;
    long        n;
    bool        bad;
} Plural;

static long p_cond(Plural *e);

static void p_space(Plural *e)
{
    while (*e->p == ' ' || *e->p == '\t')
        e->p++;
}

/* Does the input continue with this operator?  Consumes it if so. */
static bool p_eat(Plural *e, const char *op)
{
    p_space(e);
    size_t len = strlen(op);
    if (strncmp(e->p, op, len) != 0)
        return false;

    /* `<` must not swallow the `<=` next to it, nor `|` the `||`. */
    if (len == 1 && (*op == '<' || *op == '>') && e->p[1] == '=')
        return false;

    e->p += len;
    return true;
}

static long p_primary(Plural *e)
{
    p_space(e);

    if (*e->p == '(') {
        e->p++;
        long v = p_cond(e);
        p_space(e);
        if (*e->p == ')')
            e->p++;
        else
            e->bad = true;
        return v;
    }
    if (*e->p == 'n') {
        e->p++;
        return e->n;
    }
    if (g_ascii_isdigit(*e->p)) {
        /* By hand rather than strtol: GTK has called setlocale() by now, and a
         * number in a catalogue header is not the desktop's to spell. */
        long v = 0;
        while (g_ascii_isdigit(*e->p))
            v = v * 10 + (*e->p++ - '0');
        return v;
    }
    e->bad = true;
    return 0;
}

static long p_unary(Plural *e)
{
    p_space(e);
    if (*e->p == '!' && e->p[1] != '=') {
        e->p++;
        return !p_unary(e);
    }
    if (*e->p == '-') {
        e->p++;
        return -p_unary(e);
    }
    return p_primary(e);
}

static long p_mul(Plural *e)
{
    long v = p_unary(e);
    for (;;) {
        p_space(e);
        if (p_eat(e, "*"))      v = v * p_unary(e);
        else if (p_eat(e, "/")) { long d = p_unary(e); v = d ? v / d : 0; }
        else if (p_eat(e, "%")) { long d = p_unary(e); v = d ? v % d : 0; }
        else return v;
    }
}

static long p_add(Plural *e)
{
    long v = p_mul(e);
    for (;;) {
        if (p_eat(e, "+"))      v = v + p_mul(e);
        else if (p_eat(e, "-")) v = v - p_mul(e);
        else return v;
    }
}

static long p_rel(Plural *e)
{
    long v = p_add(e);
    for (;;) {
        if (p_eat(e, "<="))     v = v <= p_add(e);
        else if (p_eat(e, ">=")) v = v >= p_add(e);
        else if (p_eat(e, "<"))  v = v <  p_add(e);
        else if (p_eat(e, ">"))  v = v >  p_add(e);
        else return v;
    }
}

static long p_eq(Plural *e)
{
    long v = p_rel(e);
    for (;;) {
        if (p_eat(e, "=="))      v = v == p_rel(e);
        else if (p_eat(e, "!=")) v = v != p_rel(e);
        else return v;
    }
}

static long p_and(Plural *e)
{
    long v = p_eq(e);
    while (p_eat(e, "&&"))
        v = p_eq(e) && v;      /* both sides evaluated: no side effects to skip */
    return v;
}

static long p_or(Plural *e)
{
    long v = p_and(e);
    while (p_eat(e, "||"))
        v = p_and(e) || v;
    return v;
}

static long p_cond(Plural *e)
{
    long v = p_or(e);
    if (!p_eat(e, "?"))
        return v;

    long yes = p_cond(e);
    if (!p_eat(e, ":")) {
        e->bad = true;
        return v;
    }
    long no = p_cond(e);
    return v ? yes : no;
}

/*
 * Which plural form `n` takes.  0 when there is no catalogue or the header did
 * not say, which is English's rule and the honest default: the caller falls
 * back to the two forms it was given anyway.
 */
static int plural_index(long n)
{
    if (!L.plural || L.nplurals < 1)
        return n == 1 ? 0 : 1;

    Plural e = { .p = L.plural, .n = n, .bad = false };
    long   v = p_cond(&e);

    if (e.bad || v < 0 || v >= L.nplurals)
        return 0;
    return (int)v;
}

/* -------------------------------------------------------------- .po parsing */

/*
 * One `"..."` segment, unescaped, appended to `out`.  Stops at the closing
 * quote, which is the first one not preceded by a backslash -- so a msgid
 * containing a quote survives.
 */
static void po_unquote(GString *out, const char *line)
{
    const char *p = strchr(line, '"');
    if (!p)
        return;

    for (p++; *p && *p != '"'; p++) {
        if (*p != '\\') {
            g_string_append_c(out, *p);
            continue;
        }
        switch (*++p) {
        case 'n':  g_string_append_c(out, '\n'); break;
        case 't':  g_string_append_c(out, '\t'); break;
        case 'r':  g_string_append_c(out, '\r'); break;
        case '"':  g_string_append_c(out, '"');  break;
        case '\\': g_string_append_c(out, '\\'); break;
        case '\0': return;                       /* truncated: stop */
        default:   g_string_append_c(out, *p);   break;
        }
    }
}

/*
 * `nplurals=3; plural=(...)` out of the header entry.
 *
 * Anything else the header carries (Language, charset, the project's name) is
 * metadata for a translator's tool and means nothing here: the file is read as
 * UTF-8 because every file in this runtime is.
 */
static void po_header(const char *header)
{
    const char *pf = strstr(header, "Plural-Forms:");
    if (!pf)
        return;

    const char *np = strstr(pf, "nplurals=");
    if (np) {
        np += strlen("nplurals=");
        int v = 0;
        while (g_ascii_isdigit(*np))
            v = v * 10 + (*np++ - '0');
        if (v > 0)
            L.nplurals = v;
    }

    const char *ex = strstr(pf, "plural=");
    if (!ex)
        return;
    ex += strlen("plural=");

    /* To the end of the field, which a header line ends with a newline or a
     * semicolon. */
    const char *end = ex;
    while (*end && *end != '\n' && *end != ';')
        end++;

    g_free(L.plural);
    L.plural = g_strndup(ex, (size_t)(end - ex));
}

/*
 * The parser reads a file once for either of two purposes, and they want
 * different things out of it.
 *
 * **The catalogue** wants what can be shown: fuzzy entries dropped, empty ones
 * dropped, the header consumed for its plural rule.
 *
 * **An editor** wants the file *back*, which means it must not lose a single
 * line it did not understand -- a translator's notes, the extractor's `#.`
 * comments, the `#:` references, the `#~` blocks a merge left behind.  Losing
 * any of it means saving destroys work, which is worse than not editing at all.
 *
 * So `list` decides: NULL fills the catalogue, non-NULL builds an array of JS
 * objects that carry everything, including the lines this file has no model for
 * -- those ride along verbatim in `comments` and are written back untouched.
 */
typedef struct {
    GString   *ctxt, *id, *id_plural;
    GPtrArray *strs;      /* GString* per form */
    GString   *cur;       /* where a bare "..." continuation line appends */
    bool       fuzzy;
    bool       have;      /* anything worth flushing? */
    bool       has_ctxt;  /* told apart from a context that is "" */
    bool       has_plural;

    /* Lossless mode only. */
    JSContext *ctx;
    JSValue   *list;      /* NULL in catalogue mode */
    uint32_t   n;
    GPtrArray *comments;  /* char*, every `#` line as written */
    GPtrArray *flags;     /* char*, what a `#,` line held */
} PoEntry;

static void po_entry_reset(PoEntry *e)
{
    g_string_truncate(e->ctxt, 0);
    g_string_truncate(e->id, 0);
    g_string_truncate(e->id_plural, 0);
    for (guint i = 0; i < e->strs->len; i++)
        g_string_free(e->strs->pdata[i], TRUE);
    g_ptr_array_set_size(e->strs, 0);
    e->cur        = NULL;
    e->fuzzy      = false;
    e->have       = false;
    e->has_ctxt   = false;
    e->has_plural = false;

    if (e->comments) g_ptr_array_set_size(e->comments, 0);
    if (e->flags)    g_ptr_array_set_size(e->flags, 0);
}

/* A GPtrArray of char* as a JS array of strings. */
static JSValue strings_of(JSContext *ctx, GPtrArray *a)
{
    JSValue out = JS_NewArray(ctx);
    for (guint i = 0; a && i < a->len; i++)
        JS_SetPropertyUint32(ctx, out, i, JS_NewString(ctx, a->pdata[i]));
    return out;
}

/*
 * One entry as the editor sees it.  `msgid` is **null** for a block that is
 * comments and nothing else -- the `#~` tail a merge leaves at the end of a file
 * is the case, and having a shape for it is what makes writing the file back an
 * exact operation rather than an approximate one.
 */
static void po_emit_js(PoEntry *e)
{
    JSContext *ctx = e->ctx;
    JSValue    o   = JS_NewObject(ctx);

    JS_SetPropertyStr(ctx, o, "comments", strings_of(ctx, e->comments));
    JS_SetPropertyStr(ctx, o, "flags",    strings_of(ctx, e->flags));

    if (!e->have) {
        JS_SetPropertyStr(ctx, o, "msgid", JS_NULL);
        JS_SetPropertyStr(ctx, o, "forms", JS_NewArray(ctx));
    } else {
        if (e->has_ctxt)
            JS_SetPropertyStr(ctx, o, "ctxt", JS_NewString(ctx, e->ctxt->str));
        JS_SetPropertyStr(ctx, o, "msgid", JS_NewString(ctx, e->id->str));
        if (e->has_plural)
            JS_SetPropertyStr(ctx, o, "plural",
                              JS_NewString(ctx, e->id_plural->str));

        JSValue forms = JS_NewArray(ctx);
        for (guint i = 0; i < e->strs->len; i++)
            JS_SetPropertyUint32(ctx, forms, i,
                JS_NewString(ctx, ((GString *)e->strs->pdata[i])->str));
        JS_SetPropertyStr(ctx, o, "forms", forms);
    }

    JS_SetPropertyUint32(ctx, *e->list, e->n++, o);
}

/*
 * The entry as it stands, into the catalogue.
 *
 * A **fuzzy** entry is dropped: fuzzy means a tool guessed the translation from
 * a similar string and nobody has confirmed it, so showing it is worse than
 * showing the original.  An **empty** msgstr is dropped for the same practical
 * reason -- an untranslated entry is what a freshly extracted .po is full of,
 * and it must not blank out the text on screen.
 */
static void po_flush(PoEntry *e)
{
    /* Lossless mode keeps everything, the header and a bare block of comments
     * included: what it is building is the file, not a lookup table. */
    if (e->list) {
        if (e->have || (e->comments && e->comments->len) ||
            (e->flags && e->flags->len)) {
            po_emit_js(e);
        }
        po_entry_reset(e);
        return;
    }

    if (!e->have)
        return;

    /* The header: msgid "", whose msgstr is the metadata block. */
    if (e->id->len == 0) {
        if (e->strs->len > 0)
            po_header(((GString *)e->strs->pdata[0])->str);
        po_entry_reset(e);
        return;
    }
    if (e->fuzzy) {
        po_entry_reset(e);
        return;
    }

    /* Every form empty means untranslated; one empty form among several is a
     * hole in a language's table and the singular stands in for it. */
    bool any = false;
    for (guint i = 0; i < e->strs->len; i++)
        if (((GString *)e->strs->pdata[i])->len > 0)
            any = true;
    if (!any) {
        po_entry_reset(e);
        return;
    }

    Entry *entry = g_new0(Entry, 1);
    entry->forms = g_ptr_array_new_with_free_func(g_free);
    for (guint i = 0; i < e->strs->len; i++)
        g_ptr_array_add(entry->forms,
                        g_strdup(((GString *)e->strs->pdata[i])->str));

    char *key = e->ctxt->len > 0
        ? g_strconcat(e->ctxt->str, CTXT_SEP, e->id->str, NULL)
        : g_strdup(e->id->str);

    /* Later wins, which is what a file with a duplicate msgid means: the last
     * word on it. */
    g_hash_table_replace(L.entries, key, entry);
    po_entry_reset(e);
}

/*
 * The one parse.  `list` NULL fills the catalogue; non-NULL builds the array an
 * editor reads and writes back.
 */
static bool po_parse(const char *path, JSContext *ctx, JSValue *list)
{
    size_t len;
    char  *src = bta_read_file(path, &len);
    if (!src)
        return false;

    /*
     * **Kept if there is one, because several files make one catalogue**: a
     * library's `po/` is read before the project's, so a second parse has to add
     * to the table rather than replace it -- and a msgid in both is answered by
     * whichever file came last, which is the project's. Creating a fresh table
     * here silently threw the libraries' translations away, and looked exactly
     * like a catalogue that had not been found.
     */
    if (!list && !L.entries) {
        L.entries = g_hash_table_new_full(g_str_hash, g_str_equal,
                                          g_free, entry_free);
    }

    /* The forms are freed by hand at the end: a GString wants g_string_free
     * with a flag, which is not the shape of a GDestroyNotify. */
    PoEntry e = {
        .ctxt = g_string_new(NULL), .id = g_string_new(NULL),
        .id_plural = g_string_new(NULL),
        .strs = g_ptr_array_new(),
        .cur = NULL,
        .ctx = ctx, .list = list,
        .comments = list ? g_ptr_array_new_with_free_func(g_free) : NULL,
        .flags    = list ? g_ptr_array_new_with_free_func(g_free) : NULL,
    };

    char **lines = g_strsplit(src, "\n", -1);
    g_free(src);

    for (char **lp = lines; *lp; lp++) {
        char *line = *lp;
        while (*line == ' ' || *line == '\t')
            line++;

        if (*line == '\0') {
            po_flush(&e);
            continue;
        }
        if (*line == '#') {
            /*
             * `#~` is an obsolete entry a tool kept for reference; it is not
             * part of the catalogue. `#,` carries the flags, fuzzy among them.
             *
             * An editor keeps every one of these as written -- **including the
             * `#~` blocks, which are deliberately not modelled**: carrying them
             * along as comment lines is lossless and costs nothing, where giving
             * them a shape would mean parsing entries nobody edits.  The flags
             * are the exception, kept apart because toggling fuzzy is an edit.
             */
            /* A comment after a msgstr is the start of the next entry, not the
             * tail of this one -- which is what makes a file written without
             * blank lines between entries parse the same as one with them. */
            if (e.strs->len > 0)
                po_flush(&e);

            if (e.flags && line[1] == ',') {
                char **parts = g_strsplit(line + 2, ",", -1);
                for (char **p = parts; *p; p++) {
                    g_strstrip(*p);
                    if (**p)
                        g_ptr_array_add(e.flags, g_strdup(*p));
                }
                g_strfreev(parts);
            } else if (e.comments) {
                g_ptr_array_add(e.comments, g_strdup(line));
            }

            if (line[1] == '~')
                continue;
            if (line[1] == ',' && strstr(line, "fuzzy"))
                e.fuzzy = true;
            continue;
        }

        if (g_str_has_prefix(line, "msgctxt")) {
            /* Opens an entry -- but only when the previous one is finished, the
             * same test `msgid` makes. Flushing unconditionally would cut the
             * comment block that belongs to *this* entry loose as a block of its
             * own, which reads back the same and writes back with a blank line
             * through the middle of it. */
            if (e.strs->len > 0)
                po_flush(&e);
            e.cur = e.ctxt;
            e.have = true;
            e.has_ctxt = true;
            po_unquote(e.cur, line);
        } else if (g_str_has_prefix(line, "msgid_plural")) {
            e.cur = e.id_plural;
            e.has_plural = true;
            po_unquote(e.cur, line);
        } else if (g_str_has_prefix(line, "msgid")) {
            /* A msgid with no msgctxt before it also opens one, but only when
             * the previous entry has already been given a msgstr -- otherwise
             * this is the msgid of the entry msgctxt just opened. */
            if (e.strs->len > 0)
                po_flush(&e);
            e.cur  = e.id;
            e.have = true;
            po_unquote(e.cur, line);
        } else if (g_str_has_prefix(line, "msgstr")) {
            guint want = 0;
            if (line[strlen("msgstr")] == '[') {
                const char *d = line + strlen("msgstr[");
                while (g_ascii_isdigit(*d))
                    want = want * 10 + (guint)(*d++ - '0');
            }
            while (e.strs->len <= want)
                g_ptr_array_add(e.strs, g_string_new(NULL));
            e.cur = e.strs->pdata[want];
            po_unquote(e.cur, line);
        } else if (*line == '"' && e.cur) {
            po_unquote(e.cur, line);      /* a continuation of whatever is open */
        }
    }
    po_flush(&e);
    g_strfreev(lines);

    po_entry_reset(&e);            /* frees whatever forms are still open */
    g_string_free(e.ctxt, TRUE);
    g_string_free(e.id, TRUE);
    g_string_free(e.id_plural, TRUE);
    g_ptr_array_free(e.strs, TRUE);
    if (e.comments) g_ptr_array_free(e.comments, TRUE);
    if (e.flags)    g_ptr_array_free(e.flags, TRUE);

    return true;
}

static bool po_load(const char *path)
{
    return po_parse(path, NULL, NULL);
}

static void catalogue_clear(void)
{
    if (L.entries) {
        g_hash_table_destroy(L.entries);
        L.entries = NULL;
    }
    g_clear_pointer(&L.plural, g_free);
    L.nplurals = 0;
}

/* Loads po/<lang>.po, or clears the catalogue when `lang` is empty or has no
 * file.  Answers whether anything is in use now. */
/*
 * Every catalogue for that language, merged into one table.
 *
 * The files are read in `L.dirs` order -- libraries first, the project last --
 * and `po_parse` inserts, so the last file to mention a msgid is the one that
 * answers for it. One file being there is enough: a project with no `po/` of its
 * own still speaks the language its libraries were translated into.
 */
static bool catalogue_use(const char *lang)
{
    catalogue_clear();
    g_free(L.language);
    L.language = g_strdup("");

    if (!L.dirs || !lang || !*lang)
        return false;

    bool any = false;
    for (guint i = 0; i < L.dirs->len; i++) {
        char *path = g_strdup_printf("%s%s%s.po",
                                     (const char *)g_ptr_array_index(L.dirs, i),
                                     G_DIR_SEPARATOR_S, lang);

        if (g_file_test(path, G_FILE_TEST_IS_REGULAR) && po_load(path))
            any = true;
        g_free(path);
    }

    if (any) {
        g_free(L.language);
        L.language = g_strdup(lang);
    }
    return any;
}

/* -------------------------------------------------------------- the lookups */

const char *bta_locale_lookup(const char *ctxt, const char *msgid)
{
    if (!L.entries || !msgid)
        return NULL;

    char        *key = ctxt && *ctxt
        ? g_strconcat(ctxt, CTXT_SEP, msgid, NULL) : NULL;
    const Entry *e   = g_hash_table_lookup(L.entries, key ? key : msgid);
    g_free(key);

    if (!e || e->forms->len == 0)
        return NULL;

    const char *s = e->forms->pdata[0];
    return (s && *s) ? s : NULL;
}

/* The plural form of an entry, falling back to its singular: a language's table
 * with a hole in it must still say something. */
static const char *lookup_form(const char *ctxt, const char *msgid, int index)
{
    if (!L.entries || !msgid)
        return NULL;

    char        *key = ctxt && *ctxt
        ? g_strconcat(ctxt, CTXT_SEP, msgid, NULL) : NULL;
    const Entry *e   = g_hash_table_lookup(L.entries, key ? key : msgid);
    g_free(key);

    if (!e || e->forms->len == 0)
        return NULL;

    const char *s = index >= 0 && (guint)index < e->forms->len
        ? e->forms->pdata[index] : NULL;
    if (!s || !*s)
        s = e->forms->pdata[0];
    return (s && *s) ? s : NULL;
}

/* ------------------------------------------------------------ interpolation */

char *bta_locale_format(JSContext *ctx, const char *text,
                        int argc, JSValueConst *argv)
{
    if (!text)
        return g_strdup("");
    if (argc <= 0 || !strchr(text, '{'))
        return g_strdup(text);

    /*
     * The arguments as strings, once: a template may name the same one twice.
     * **A value that cannot become text is a refusal** and not an empty
     * substitution -- `as[i] = g_strdup(s ? s : "")` swallowed the failure with
     * the conversion's exception still pending, so the template came out with a
     * hole in it and the error landed on whoever asked next.
     */
    char **as = g_new0(char *, (size_t)argc + 1);
    for (int i = 0; i < argc; i++) {
        const char *s = JS_ToCString(ctx, argv[i]);

        if (!s) {
            g_strfreev(as);            /* zeroed, so it stops at the first NULL */
            return NULL;               /* it threw on the way; that stands */
        }
        as[i] = g_strdup(s);
        JS_FreeCString(ctx, s);
    }

    GString *out = g_string_new(NULL);
    for (const char *p = text; *p; ) {
        if (*p != '{' || !g_ascii_isdigit(p[1])) {
            g_string_append_c(out, *p++);
            continue;
        }
        const char *d = p + 1;
        int         k = 0;
        while (g_ascii_isdigit(*d))
            k = k * 10 + (*d++ - '0');

        /* Only `{0}` is a placeholder; `{0` or `{0x}` is text that happens to
         * start with a brace, and passing it through is what keeps a template
         * from mangling anything it did not intend. */
        if (*d != '}') {
            g_string_append_c(out, *p++);
            continue;
        }
        /* A placeholder nobody passed an argument for stays as written, which
         * says so on screen instead of silently vanishing. */
        if (k < argc)
            g_string_append(out, as[k]);
        else
            g_string_append_len(out, p, (size_t)(d - p) + 1);
        p = d + 1;
    }

    for (int i = 0; i < argc; i++)
        g_free(as[i]);
    g_free(as);
    return g_string_free(out, FALSE);
}

/* ---------------------------------------------------------------- JS surface */

/*
 * Locale.Text(msgid, ...args)
 *
 * The msgid is the text itself, in whatever language the project is written in.
 * With no catalogue -- or none for this locale -- it is what comes back, which
 * is why an untranslated application is a working one.
 */
static JSValue js_locale_text(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    const char *msgid = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    if (!msgid)
        return JS_ThrowTypeError(ctx, "Locale.Text(text, ...) expects a text");

    const char *found = bta_locale_lookup(NULL, msgid);
    char       *out   = bta_locale_format(ctx, found ? found : msgid,
                                          argc - 1, argv + 1);

    JS_FreeCString(ctx, msgid);
    if (!out)
        return JS_EXCEPTION;           /* an argument could not become text */

    JSValue r = JS_NewString(ctx, out);

    g_free(out);
    return r;
}

/*
 * Locale.Context(context, msgid, ...args)
 *
 * For the word that is not translated the same way twice -- "Open" the verb on
 * a button and "Open" the state of a file.  The context is not shown; it is
 * part of the key, and what a translator reads to tell the two apart.
 */
static JSValue js_locale_context(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv)
{
    const char *ctxt  = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    const char *msgid = argc > 1 ? JS_ToCString(ctx, argv[1]) : NULL;

    if (!ctxt || !msgid) {
        JS_FreeCString(ctx, ctxt);
        JS_FreeCString(ctx, msgid);
        return JS_ThrowTypeError(ctx,
            "Locale.Context(context, text, ...) expects both");
    }

    const char *found = bta_locale_lookup(ctxt, msgid);
    char       *out   = bta_locale_format(ctx, found ? found : msgid,
                                          argc - 2, argv + 2);

    JS_FreeCString(ctx, ctxt);
    JS_FreeCString(ctx, msgid);
    if (!out)
        return JS_EXCEPTION;           /* an argument could not become text */

    JSValue r = JS_NewString(ctx, out);

    g_free(out);
    return r;
}

/*
 * Locale.Plural(one, many, n, ...args)
 *
 * The two msgids come first, as they do in ngettext, and that order is not
 * cosmetic: an extractor has to find both literals, and with `n` in front of
 * them it would have to skip an arbitrary expression -- `this.files.length`, a
 * call, a sum -- to reach the first one.
 *
 * `n` fills `{0}` without being passed twice, and anything after it fills
 * `{1}` onwards.
 */
static JSValue js_locale_plural(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
    const char *one  = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    const char *many = argc > 1 ? JS_ToCString(ctx, argv[1]) : NULL;
    int64_t     n    = 0;

    if (!one || !many || argc < 3 || JS_ToInt64(ctx, &n, argv[2]) < 0) {
        JS_FreeCString(ctx, one);
        JS_FreeCString(ctx, many);
        return JS_ThrowTypeError(ctx,
            "Locale.Plural(one, many, n, ...) expects two texts and a number");
    }

    const char *found = lookup_form(NULL, one, plural_index((long)n));
    /* No catalogue: English's rule over the two the caller wrote, which is the
     * only honest answer -- the project's own language may have others, and
     * those live in its own .po like everyone else's. */
    const char *text  = found ? found : (n == 1 ? one : many);

    /* n as {0}, then the caller's own arguments. */
    JSValue *args = g_new0(JSValue, (size_t)argc - 2);
    args[0] = JS_NewInt64(ctx, n);
    for (int i = 3; i < argc; i++)
        args[i - 2] = JS_DupValue(ctx, argv[i]);

    char *out = bta_locale_format(ctx, text, argc - 2, args);

    for (int i = 0; i < argc - 2; i++)
        JS_FreeValue(ctx, args[i]);
    g_free(args);
    JS_FreeCString(ctx, one);
    JS_FreeCString(ctx, many);
    if (!out)
        return JS_EXCEPTION;           /* an argument could not become text */

    JSValue r = JS_NewString(ctx, out);

    g_free(out);
    return r;
}

/*
 * Locale.Read(path): a catalogue as data, losing nothing.
 *
 * The reading the runtime does for itself throws away everything it cannot show
 * -- fuzzy entries, empty ones, comments, the `#~` blocks a merge leaves behind.
 * An editor needs the opposite: whatever it does not understand has to survive
 * being written back, or saving destroys a translator's work.  So this is the
 * same parse with nothing discarded.
 *
 * One entry per element, in file order:
 *
 *   { comments: ["#: Form1.form: Label1.Text"], flags: ["fuzzy"],
 *     ctxt: "verb",            // absent when it has none
 *     msgid: "Open",           // **null** for a block that is only comments
 *     plural: "Opens",         // absent unless it has a msgid_plural
 *     forms: ["Abrir"] }       // one per plural form
 *
 * The header is an ordinary entry whose msgid is `""`, so writing the file back
 * is one loop with no special case -- and so is reading `nplurals` out of it.
 *
 * It is published rather than kept for the IDE because the rule of this project
 * is that the IDE has no privileged API: reading a catalogue is a thing every
 * application can now do, and an application that wants to show how translated
 * it is has the same answer the editor does.
 */
static JSValue js_locale_read(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    const char *path = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    if (!path)
        return JS_ThrowTypeError(ctx, "Locale.Read(path) expects a path");

    JSValue out = JS_NewArray(ctx);
    bool    ok  = po_parse(path, ctx, &out);

    if (!ok) {
        JS_FreeValue(ctx, out);
        JSValue e = JS_ThrowTypeError(ctx, "Locale.Read: cannot read %s", path);
        JS_FreeCString(ctx, path);
        return e;
    }
    JS_FreeCString(ctx, path);
    return out;
}

static JSValue js_locale_get_current(JSContext *ctx, JSValueConst this_val)
{
    return JS_NewString(ctx, L.language ? L.language : "");
}

/*
 * Assigning reloads the catalogue -- and only affects what is built after it.
 *
 * A form already on screen keeps the text it was given: its widgets hold
 * strings, not references to a catalogue.  Saying so is better than pretending
 * otherwise, and an application that offers a language menu reopens its window.
 */
static JSValue js_locale_set_current(JSContext *ctx, JSValueConst this_val,
                                     JSValueConst val)
{
    const char *lang = JS_ToCString(ctx, val);
    if (!lang)
        return JS_EXCEPTION;

    bool ok = catalogue_use(lang);
    if (!ok && *lang) {
        JSValue e = JS_ThrowTypeError(ctx,
            "Locale.Current: no po/%s.po in this project", lang);
        JS_FreeCString(ctx, lang);
        return e;
    }
    JS_FreeCString(ctx, lang);
    return JS_UNDEFINED;
}

/* g_ptr_array_sort hands the comparator the *slots*, not what is in them. */
static int name_cmp(const void *a, const void *b)
{
    return g_strcmp0(*(const char *const *)a, *(const char *const *)b);
}

/* Every catalogue the project ships, sorted -- what a language menu is built
 * from.  The names are the file names, which are the locales they are for. */
static JSValue js_locale_get_available(JSContext *ctx, JSValueConst this_val)
{
    JSValue out = JS_NewArray(ctx);
    if (!L.dirs)
        return out;

    GPtrArray *names = g_ptr_array_new_with_free_func(g_free);

    /* The union over the project's and its libraries': a language menu offers
     * what the application can *say*, and a string translated only by a library
     * is still translated. Listed once, however many files have it. */
    for (guint i = 0; i < L.dirs->len; i++) {
        GDir *d = g_dir_open(g_ptr_array_index(L.dirs, i), 0, NULL);
        if (!d)
            continue;

        const char *name;
        while ((name = g_dir_read_name(d))) {
            if (!g_str_has_suffix(name, ".po"))
                continue;

            char *bare = g_strndup(name, strlen(name) - 3);
            bool  had  = false;

            for (guint j = 0; j < names->len && !had; j++)
                had = g_str_equal(bare, g_ptr_array_index(names, j));
            if (had) g_free(bare);
            else     g_ptr_array_add(names, bare);
        }
        g_dir_close(d);
    }

    g_ptr_array_sort(names, name_cmp);
    for (guint i = 0; i < names->len; i++)
        JS_SetPropertyUint32(ctx, out, i, JS_NewString(ctx, names->pdata[i]));
    g_ptr_array_free(names, TRUE);
    return out;
}

/* ------------------------------------------------------------------------
 * Number and Date -- how the *desktop* spells a value, which is not the same
 * question as which catalogue the project is showing.
 *
 * **The two are deliberately different sources**, and that is the one thing to
 * know before reading further.  `Locale.Current` picks the `.po` a project's
 * prose comes from; these two follow the C locale, which is the desktop's own
 * `LANG`.  A Spanish speaker on a German desktop wants Spanish words and German
 * numbers -- those are two settings because they are two decisions, and it is
 * the same reason `Application.DecorationLayout` reads the desktop's answer
 * rather than one of ours, and the same reason `File.Info`'s `Type` is a content
 * type instead of GIO's description: what the desktop translates is not this
 * runtime's to overrule.
 *
 * This is also the first place in the runtime that *wants* the locale's
 * spelling.  Everywhere else it was a hazard to be shut out -- CSS written with
 * `g_ascii_formatd` because `%g` says "11,5" here and CSS cannot parse it, the
 * Plural-Forms digits read one at a time because a catalogue header is not the
 * desktop's to spell.  The rule those two follow is worth stating once: **machine
 * text is always the C locale, human text is the desktop's**, and these two are
 * the human side.
 * ---------------------------------------------------------------------- */

/* Refused rather than printed: `Locale.Number(0/0)` is a bug in the caller, and
 * "nan" in a label says nothing to whoever reads it.  The same bargain
 * Field.Number makes. */
static bool locale_finite(JSContext *ctx, JSValueConst v, const char *who,
                          double *out)
{
    if (JS_ToFloat64(ctx, out, v) < 0)
        return false;
    if (!isfinite(*out)) {
        JS_ThrowRangeError(ctx, "%s: %s is not a number that can be written",
                           who, isnan(*out) ? "NaN" : "an infinity");
        return false;
    }
    return true;
}

/*
 * The fewest decimals that still say exactly this number, up to six.
 *
 * What `Locale.Number(x)` means with no second argument: 3 is "3" and not
 * "3,00", and 19.99 is "19,99" and not "19,990000".  Capped because a double
 * carries about seventeen digits and nobody reading a form wants them -- a value
 * that needs more says so by asking for them.
 */
#define LOCALE_MAX_DECIMALS 6

/* What a shown value may carry, which is the Decimal ceiling: past it there is
 * no value to show, only a rounding nobody asked for. */
#define DEC_SHOWN_MAX 9

static int locale_decimals_for(double value)
{
    /* Wide enough for %.6f of any double, which is 320-odd characters at the
     * top of the range. */
    char buf[512];

    for (int d = 0; d < LOCALE_MAX_DECIMALS; d++) {
        char format[8];
        g_snprintf(format, sizeof format, "%%.%df", d);

        /*
         * g_ascii_formatd and not g_strdup_printf, and this is the trap the note
         * above is about -- walked into while writing it.  With the desktop's
         * locale in force `%.2f` of 19.99 writes "19,99", which g_ascii_strtod
         * reads as 19, so nothing ever round-tripped and every value came back
         * with six decimals.  **The comparison is machine text**: both halves
         * have to be spelled the C way.
         */
        g_ascii_formatd(buf, sizeof buf, format, value);
        if (g_ascii_strtod(buf, NULL) == value)
            return d;
    }
    return LOCALE_MAX_DECIMALS;
}

/*
 * A run of digits, prepended into `out` grouped from the right.
 *
 * The grouping follows `localeconv`'s rule and not a guess of three: the rule is
 * a list, and its last entry repeats, which is how India groups the first three
 * digits and then by twos.  A `CHAR_MAX` in it means *stop grouping here*.
 *
 * A function of its own because two callers group: an exact value's digits
 * (`locale_group`) and a double already written out by `printf` (Windows, where
 * the `%'` flag does not exist -- see `locale_group_double`).
 */
static void locale_group_run(GString *out, const char *digits, size_t n)
{
    struct lconv *lc   = localeconv();
    const char   *sep  = lc->thousands_sep;
    const char   *rule = lc->grouping;

    size_t      left = n;
    int         step = rule && *rule && *rule != CHAR_MAX ? *rule : 0;
    const char *r    = rule;

    while (left > 0) {
        size_t take = (step > 0 && (size_t)step < left) ? (size_t)step : left;

        g_string_prepend_len(out, digits + (left - take), take);
        left -= take;

        if (left > 0 && sep && *sep)
            g_string_prepend(out, sep);

        /* The next entry of the rule, and the last one repeats forever. */
        if (step > 0 && r && *r) {
            if (*(r + 1) && *(r + 1) != CHAR_MAX)
                r++;
            step = (*r == CHAR_MAX) ? 0 : *r;
        }
    }
}

/*
 * A run of digits with the locale's separators put in, and no double anywhere.
 *
 * `units` and `scale` are a decimal's own -- 1999 and 2 for 19.99 -- so this is
 * how an exact value reaches a label without being converted to floating point
 * on the way, which would be the one place the exactness could still be lost.
 */
static char *locale_group_opt(int64_t units, int scale, bool group)
{
    struct lconv *lc    = localeconv();
    const char   *point = lc->decimal_point[0] ? lc->decimal_point : ".";

    bool neg = units < 0;
    /* On the absolute value, and via a string so INT64_MIN has nowhere to
     * overflow: negating it is undefined and this is the one value that would. */
    char *digits = g_strdup_printf("%" PRId64, units);
    const char *all = digits + (neg ? 1 : 0);
    size_t      n   = strlen(all);

    /* Pad so there are at least `scale` decimals plus one whole digit. */
    GString *whole = g_string_new(NULL);
    GString *frac  = g_string_new(NULL);

    if ((int)n <= scale) {
        g_string_append(whole, "0");
        for (int i = 0; i < scale - (int)n; i++)
            g_string_append_c(frac, '0');
        g_string_append(frac, all);
    } else {
        g_string_append_len(whole, all, n - scale);
        g_string_append(frac, all + (n - scale));
    }

    GString *out = g_string_new(NULL);

    if (group)
        locale_group_run(out, whole->str, whole->len);
    else
        g_string_append_len(out, whole->str, whole->len);

    if (scale > 0) {
        g_string_append(out, point);
        g_string_append(out, frac->str);
    }
    if (neg)
        g_string_prepend(out, "-");

    g_string_free(whole, TRUE);
    g_string_free(frac, TRUE);
    g_free(digits);
    return g_string_free(out, FALSE);
}

/* ------------------------------------------------- numbers, one way and back
 *
 * The one place a number becomes text and text becomes a number, because three
 * callers need the same answer: `Locale.Number`/`Locale.Currency`, the
 * `DecimalBox` that shows a value and parses what was typed, and any label or
 * report that formats the same amount.  See `BtaNumberFmt` in bta.h for what a
 * format may say.
 */
#ifdef G_OS_WIN32
static char *locale_group_double(double value, int decimals);
#endif

void bta_number_fmt_default(BtaNumberFmt *f)
{
    f->places        = -1;
    f->group         = true;
    f->prefix        = NULL;
    f->suffix        = NULL;
    f->currency      = false;
    f->symbol        = NULL;
    f->symbol_before = false;
    f->symbol_space  = false;
}

/* The symbol, its side and its gap: an override wins, then the currency's, and
 * neither is a symbol at all when the locale has none. */
static const char *number_symbol(const BtaNumberFmt *f, bool *before, bool *space)
{
    struct lconv *lc = localeconv();

    *before = false;
    *space  = false;

    if (f->symbol && *f->symbol) {
        *before = f->symbol_before;
        *space  = f->symbol_space;
        return f->symbol;
    }
    if (f->currency && lc->currency_symbol && *lc->currency_symbol) {
        *before = lc->p_cs_precedes == 1;
        *space  = lc->p_sep_by_space == 1;
        return lc->currency_symbol;
    }
    return NULL;
}

char *bta_locale_format_number(JSContext *ctx, JSValueConst v, const BtaNumberFmt *f)
{
    struct lconv *lc    = localeconv();
    bool          money = f->currency && !(f->symbol && *f->symbol);

    /* What the currency's own places are, when the format does not say.  The
     * same CHAR_MAX-is-no-answer reading `Locale.Currency` has always made. */
    int want = f->places;
    if (want < 0 && money) {
        want = lc->frac_digits;
        if (want == CHAR_MAX || want < 0 || want > DEC_SHOWN_MAX)
            want = 2;
    }

    int64_t units = 0;
    int     scale = 0;
    int     held  = bta_decimal_parts(ctx, v, want, &units, &scale);

    if (held < 0)
        return NULL;

    char *amount;

    if (held > 0) {
        /* A Decimal: its own digits, never a double -- the one place the
         * exactness could still be dropped. */
        amount = locale_group_opt(units, scale, f->group);
    } else {
        double value = 0;
        if (!locale_finite(ctx, v, "Locale.Number", &value))
            return NULL;

        int decimals = want >= 0 ? want : locale_decimals_for(value);
#ifdef G_OS_WIN32
        amount = f->group ? locale_group_double(value, decimals)
                          : g_strdup_printf("%.*f", decimals, value);
#else
        amount = f->group ? g_strdup_printf("%'.*f", decimals, value)
                          : g_strdup_printf("%.*f", decimals, value);
#endif
    }

    bool        before = false, space = false;
    const char *symbol = number_symbol(f, &before, &space);
    GString    *out    = g_string_new(NULL);

    if (f->prefix)
        g_string_append(out, f->prefix);
    if (symbol && before) {
        g_string_append(out, symbol);
        if (space)
            g_string_append_c(out, ' ');
    }
    g_string_append(out, amount);
    if (symbol && !before) {
        if (space)
            g_string_append_c(out, ' ');
        g_string_append(out, symbol);
    }
    if (f->suffix)
        g_string_append(out, f->suffix);

    g_free(amount);
    return g_string_free(out, FALSE);
}

/* The last group's size, against the locale's rule: `1.234` is 1234 where the
 * rule groups by three, and `1.5` is one and a half -- a dot typed as a decimal
 * point, which is not this desktop's spelling but is what a hand does. */
static bool locale_last_group_ok(const char *body, const char *sep)
{
    const char *last = NULL;

    for (const char *p = strstr(body, sep); p; p = strstr(p + 1, sep))
        last = p;
    if (!last || last == body)
        return false;

    size_t after = strlen(last + strlen(sep));

    for (size_t i = 0; i < after; i++)
        if (!g_ascii_isdigit(last[strlen(sep) + i]))
            return false;

    struct lconv *lc   = localeconv();
    int           step = lc->grouping && *lc->grouping && *lc->grouping != CHAR_MAX
                             ? *lc->grouping : 3;

    return after == (size_t)step;
}

static char *str_without(const char *s, const char *what)
{
    GString *out = g_string_new(NULL);

    for (const char *p = s; *p; ) {
        if (strncmp(p, what, strlen(what)) == 0) {
            p += strlen(what);
            continue;
        }
        g_string_append_c(out, *p++);
    }
    return g_string_free(out, FALSE);
}

/* `start`/`len` trimmed at the front by `what`, with the space the formatter
 * may have left between them.  false when it is not there. */
static bool strip_front(const char **start, size_t *len, const char *what)
{
    size_t n = strlen(what);

    if (!n)
        return true;
    if (*len < n || strncmp(*start, what, n) != 0)
        return false;

    *start += n;
    *len   -= n;
    while (*len > 0 && g_ascii_isspace(**start)) {
        (*start)++;
        (*len)--;
    }
    return true;
}

static bool strip_back(const char *start, size_t *len, const char *what)
{
    size_t n = strlen(what);

    if (!n)
        return true;
    if (*len < n || strncmp(start + *len - n, what, n) != 0)
        return false;

    *len -= n;
    while (*len > 0 && g_ascii_isspace(start[*len - 1]))
        (*len)--;
    return true;
}

bool bta_locale_parse_number(const char *text, const BtaNumberFmt *f,
                             int64_t *units, int *scale)
{
    if (!text)
        return false;

    while (g_ascii_isspace(*text))
        text++;

    const char *start = text;
    size_t      len   = strlen(text);

    while (len > 0 && g_ascii_isspace(start[len - 1]))
        len--;

    /* The affixes are the outside, so they come off first -- and the symbol
     * sits inside them, where the formatter put it. */
    if (!strip_front(&start, &len, f->prefix ? f->prefix : ""))
        return false;

    bool        before = false, space = false;
    const char *symbol = number_symbol(f, &before, &space);
    char       *sym    = symbol ? g_strdup(symbol) : NULL;

    if (sym && before && !strip_front(&start, &len, sym)) {
        g_free(sym);
        return false;
    }
    if (sym && !before && !strip_back(start, &len, sym)) {
        g_free(sym);
        return false;
    }
    g_free(sym);

    if (!strip_back(start, &len, f->suffix ? f->suffix : ""))
        return false;

    char *body = g_strndup(start, len);

    struct lconv *lc    = localeconv();
    const char   *point = lc->decimal_point[0] ? lc->decimal_point : ".";
    const char   *sep   = lc->thousands_sep ? lc->thousands_sep : "";

    char *flat = NULL;

    if (*sep && strcmp(sep, point) != 0 && strstr(body, sep)) {
        /* The point is there, so the separator can only be grouping; without
         * it, the groups have to have the locale's size or it is a decimal
         * point typed the foreign way. */
        if (strstr(body, point) || locale_last_group_ok(body, sep))
            flat = str_without(body, sep);
    }

    bool ok = bta_decimal_from_text(flat ? flat : body, units, scale);

    g_free(flat);
    g_free(body);
    return ok;
}

#ifdef G_OS_WIN32
/*
 * The same grouping for a double, by hand: `%'.*f` is a POSIX extension that
 * UCRT's printf does not implement, and it would come out with no separators
 * at all -- or, worse, with a stray character where the flag was.
 *
 * The digits come from `printf`, which takes the locale's decimal point from
 * `setlocale` the ordinary way; the separators are the only part put in here,
 * by the same rule `locale_group_run` follows.
 */
static char *locale_group_double(double value, int decimals)
{
    struct lconv *lc    = localeconv();
    const char   *point = lc->decimal_point[0] ? lc->decimal_point : ".";

    char   *plain = g_strdup_printf("%.*f", decimals, value);
    char   *at    = strstr(plain, point);
    size_t  whole = at ? (size_t)(at - plain) : strlen(plain);
    size_t  skip  = plain[0] == '-' ? 1 : 0;

    GString *out = g_string_new(NULL);

    if (skip)
        g_string_append_c(out, '-');
    locale_group_run(out, plain + skip, whole - skip);
    if (at)
        g_string_append(out, at);       /* the point and what follows it */

    g_free(plain);
    return g_string_free(out, FALSE);
}
#endif

/*
 * Locale.Number(value, [decimals]) -- grouped, with the desktop's separators.
 *
 * The grouping is `%'` from POSIX, which reads `localeconv`'s `grouping` rule
 * rather than assuming three: some locales group by four, and India groups the
 * first three and then by twos.  Which is the whole reason not to insert
 * separators by hand.
 */
/*
 * The second argument of `Locale.Number`/`Currency`/`Parse`: a number of
 * places, as it has always been, or an object that says more.  The strings it
 * reads are owned here because a `BtaNumberFmt` borrows them.
 */
typedef struct {
    BtaNumberFmt fmt;
    char        *prefix;
    char        *suffix;
    char        *symbol;
} LocaleNumOpts;

static void locale_opts_free(LocaleNumOpts *o)
{
    g_free(o->prefix);
    g_free(o->suffix);
    g_free(o->symbol);
}

static bool locale_opts_places(JSContext *ctx, JSValueConst v, const char *who,
                               int *out)
{
    int32_t asked = 0;

    if (!bta_to_int(ctx, v, who, &asked))
        return false;
    if (asked < 0 || asked > DEC_SHOWN_MAX) {
        JS_ThrowRangeError(ctx, "%s: %d decimals is not between 0 and %d",
                           who, asked, DEC_SHOWN_MAX);
        return false;
    }
    *out = asked;
    return true;
}

static bool locale_opts(JSContext *ctx, JSValueConst v, const char *who,
                        LocaleNumOpts *o)
{
    bta_number_fmt_default(&o->fmt);

    /* Owned by this struct and freed by `locale_opts_free` on every path, so
     * they start empty and not as whatever the stack had. */
    o->prefix = o->suffix = o->symbol = NULL;

    if (JS_IsUndefined(v) || JS_IsNull(v))
        return true;

    if (!JS_IsObject(v) || JS_IsArray(v) || JS_IsFunction(ctx, v))
        return locale_opts_places(ctx, v, who, &o->fmt.places);

    JSValue p = JS_GetPropertyStr(ctx, v, "Decimals");
    if (!JS_IsUndefined(p) && !JS_IsNull(p) &&
        !locale_opts_places(ctx, p, who, &o->fmt.places)) {
        JS_FreeValue(ctx, p);
        return false;
    }
    JS_FreeValue(ctx, p);

    JSValue g = JS_GetPropertyStr(ctx, v, "Group");
    if (!JS_IsUndefined(g))
        o->fmt.group = JS_ToBool(ctx, g) > 0;
    JS_FreeValue(ctx, g);

    JSValue c = JS_GetPropertyStr(ctx, v, "Currency");
    if (!JS_IsUndefined(c))
        o->fmt.currency = JS_ToBool(ctx, c) > 0;
    JS_FreeValue(ctx, c);

    const struct { const char *key; char **slot; const char **to; } names[] = {
        { "Prefix", &o->prefix, &o->fmt.prefix },
        { "Suffix", &o->suffix, &o->fmt.suffix },
        { "Symbol", &o->symbol, &o->fmt.symbol },
    };

    for (size_t i = 0; i < G_N_ELEMENTS(names); i++) {
        JSValue s = JS_GetPropertyStr(ctx, v, names[i].key);

        if (!JS_IsUndefined(s) && !JS_IsNull(s)) {
            const char *text = JS_ToCString(ctx, s);

            if (!text) {
                JS_FreeValue(ctx, s);
                return false;
            }
            *names[i].slot = g_strdup(text);
            *names[i].to   = *names[i].slot;
            JS_FreeCString(ctx, text);
        }
        JS_FreeValue(ctx, s);
    }

    /*
     * An override's side is the locale's unless told: a symbol for another
     * currency wants to be placed the way this desktop places one -- `US$` goes
     * before in Argentina, and the app does not have to know that.
     */
    struct lconv *lc = localeconv();
    bool          before = lc->p_cs_precedes == 1;
    bool          space  = lc->p_sep_by_space == 1;

    JSValue b = JS_GetPropertyStr(ctx, v, "Before");
    o->fmt.symbol_before = JS_IsUndefined(b) ? before : JS_ToBool(ctx, b) > 0;
    JS_FreeValue(ctx, b);

    JSValue sp = JS_GetPropertyStr(ctx, v, "Space");
    o->fmt.symbol_space = JS_IsUndefined(sp) ? space : JS_ToBool(ctx, sp) > 0;
    JS_FreeValue(ctx, sp);

    return true;
}

/*
 * Locale.Number(value, [decimals | options]) -- grouped, with the desktop's
 * separators.
 *
 * The grouping is `%'` from POSIX, which reads `localeconv`'s `grouping` rule
 * rather than assuming three: some locales group by four, and India groups the
 * first three and then by twos.  Which is the whole reason not to insert
 * separators by hand.
 *
 * The options object is the same one the `DecimalBox` keeps as its format:
 * `{ Decimals, Group, Prefix, Suffix }`.  A `Decimal` goes through its own
 * digits and never through a double, and an explicit `Decimals` rounds it --
 * showing a value at a fixed number of places is exactly where a rounding
 * decision belongs, which is what `Locale.Currency` has always done.
 */
static JSValue js_locale_number(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "Locale.Number(value, [decimals]) needs a value");

    LocaleNumOpts o;

    if (!locale_opts(ctx, argc > 1 ? argv[1] : JS_UNDEFINED, "Locale.Number", &o))
        return JS_EXCEPTION;

    char *shown = bta_locale_format_number(ctx, argv[0], &o.fmt);

    locale_opts_free(&o);
    if (!shown)
        return JS_EXCEPTION;

    JSValue out = JS_NewString(ctx, shown);

    g_free(shown);
    return out;
}

/*
 * What Locale.Date accepts, which is more than a Date on purpose.
 *
 * A `Field.Date` holds `"YYYY-MM-DD"` -- that is what a Record's date field *is*
 * -- so `Locale.Date(customer.Since)` is the call this exists for and a version
 * that only took a `Date` would miss its own customer.  A number is milliseconds
 * since the epoch, which is what a `Date` answers when asked for one.
 */
static GDateTime *locale_when(JSContext *ctx, JSValueConst v)
{
    if (JS_IsString(v)) {
        const char *text = JS_ToCString(ctx, v);
        if (!text)
            return NULL;

        /* Read a digit at a time, for the reason the Plural-Forms parser does:
         * a date in a file is not the desktop's to spell. */
        int n[3] = { 0, 0, 0 };
        int part = 0, digits = 0;
        bool ok = true;

        for (const char *p = text; *p && part < 3; p++) {
            if (g_ascii_isdigit(*p)) {
                n[part] = n[part] * 10 + (*p - '0');
                digits++;
            } else if (*p == '-' && digits > 0) {
                part++;
                digits = 0;
            } else {
                break;      /* a time may follow the date; the rest is ignored */
            }
        }
        if (part < 2 || n[0] == 0)
            ok = false;

        JS_FreeCString(ctx, text);
        if (!ok) {
            JS_ThrowRangeError(ctx, "Locale.Date: expected a Date, milliseconds, "
                                    "or a date as YYYY-MM-DD");
            return NULL;
        }
        /* Local midnight, which is what a date with no time means to whoever
         * wrote it down. */
        GDateTime *when = g_date_time_new_local(n[0], n[1], n[2], 0, 0, 0);
        if (!when)
            JS_ThrowRangeError(ctx, "Locale.Date: %d-%02d-%02d is not a date",
                               n[0], n[1], n[2]);
        return when;
    }

    /* A Date answers its time value when asked for a number, so this covers
     * both a Date object and a plain count of milliseconds. */
    double ms = 0;
    if (!locale_finite(ctx, v, "Locale.Date", &ms))
        return NULL;

    GDateTime *when = g_date_time_new_from_unix_local((gint64)(ms / 1000.0));
    if (!when)
        JS_ThrowRangeError(ctx, "Locale.Date: that is not a moment this can write");
    return when;
}

/*
 * Locale.Date(when, [format]) -- the desktop's own date, time, or both.
 *
 * Four names and no pattern language yet, and the four are exactly the ones the
 * locale itself defines: `%x`, `%X`, `%c` and ISO 8601.  A "long date" is not
 * among them because glibc does not carry one -- assembling `%A %d %B %Y` would
 * read "lunes 31 agosto 2026" in Spanish, missing the connector words a person
 * writes, and inventing those per language is a catalogue and not a format.  So
 * it waits for the custom patterns, where it belongs.
 */
static JSValue js_locale_date(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "Locale.Date(when, [format]) needs a date");

    /*
     * The formats the **locale itself** defines, and no others.  The first four
     * are whole spellings of a moment; the last two are single fields, and they
     * are here for the sentence a format cannot write.
     *
     * There is still no `"Long"`, for the reason written where this list used to
     * end at four: glibc carries no long-date pattern, and assembling `%A %d %B
     * %Y` reads *"lunes 31 agosto 2026"* in Spanish -- missing the connector
     * words a person writes, which differ per language and are a **catalogue**
     * and not a format.  `Weekday` and `Month` are the halves that let the
     * application write that sentence where it belongs:
     *
     *     Locale.Text("{0}, {1} {2} {3}", Locale.Date(d, "Weekday"), day,
     *                 Locale.Date(d, "Month"), year)
     *
     * -- whose msgid reads *"Sunday, 8 March 2026"* and whose `es.po` says
     * *"{0} {1} de {2} de {3}"*, reordering and adding the connectors that only
     * a translator knows about.  That is the same bargain `{0}` makes everywhere
     * else here, and it is why these two are fields rather than a fifth whole
     * spelling.
     */
    static const struct { const char *name, *fmt; } kinds[] = {
        { "Date",     "%x" },   /* the default: what the locale calls a date */
        { "Time",     "%X" },
        { "DateTime", "%c" },
        { "ISO",      NULL },   /* not the locale's, which is the point of it */
        { "Weekday",  "%A" },   /* the day's name, for a sentence to be built of */
        { "Month",    "%B" },
    };

    int which = 0;
    if (argc > 1 && !JS_IsUndefined(argv[1]) && !JS_IsNull(argv[1])) {
        const char *asked = JS_ToCString(ctx, argv[1]);
        if (!asked)
            return JS_EXCEPTION;

        which = -1;
        for (unsigned i = 0; i < G_N_ELEMENTS(kinds); i++)
            if (g_str_equal(asked, kinds[i].name))
                which = (int)i;

        if (which < 0) {
            JSValue e = JS_ThrowRangeError(ctx,
                "Locale.Date: '%s' is not one of Date, Time, DateTime, ISO, "
                "Weekday, Month",
                asked);
            JS_FreeCString(ctx, asked);
            return e;
        }
        JS_FreeCString(ctx, asked);
    }

    GDateTime *when = locale_when(ctx, argv[0]);
    if (!when)
        return JS_EXCEPTION;

    char *shown = kinds[which].fmt ? g_date_time_format(when, kinds[which].fmt)
                                   : g_date_time_format_iso8601(when);
    g_date_time_unref(when);

    /* A format the locale does not define comes back NULL -- `%r` does, on a
     * desktop with no 12-hour clock -- so it is answered rather than crashed on,
     * even though none of the four above has ever done it. */
    if (!shown)
        return JS_ThrowInternalError(ctx,
            "Locale.Date: this desktop does not spell %s", kinds[which].name);

    JSValue out = JS_NewString(ctx, shown);
    g_free(shown);
    return out;
}

/*
 * Locale.Currency(value, [decimals]) -- money, spelled the way this desktop
 * spells money.
 *
 * `localeconv` knows all four things that differ and that nobody guesses right:
 * the symbol, how many places the currency uses, **which side the symbol goes
 * on**, and whether a space separates it.  Argentina writes `$ 1.234,56`,
 * Germany `1.234,56 EUR`, the United States `$1,234.56`; a program that
 * concatenated a symbol would be wrong in two of the three.
 *
 * The places default to the currency's own -- two nearly everywhere, zero for
 * yen, three for the dinar -- which is `frac_digits`, and is the number an
 * amount should be rounded to before it is anybody's total.
 *
 * A Decimal goes through its digits and never through a double.  Which is the
 * point of the pair: `Decimal` keeps the arithmetic exact and this keeps the
 * showing exact.
 */
static JSValue js_locale_currency(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv)
{
    if (argc < 1)
        return JS_ThrowTypeError(ctx,
            "Locale.Currency(value, [decimals]) needs a value");

    LocaleNumOpts o;

    if (!locale_opts(ctx, argc > 1 ? argv[1] : JS_UNDEFINED, "Locale.Currency", &o))
        return JS_EXCEPTION;

    /*
     * A currency by default, and **an override makes it another one**: the
     * symbol is the app's and the side it goes on is still this desktop's, which
     * is the whole of what a finance app handling several currencies needs --
     * `{ Symbol: "US$" }` is `US$ 1.234,56` here and `$1,234.56` there without
     * the program knowing either rule.
     */
    o.fmt.currency = true;

    char *shown = bta_locale_format_number(ctx, argv[0], &o.fmt);

    locale_opts_free(&o);
    if (!shown)
        return JS_EXCEPTION;

    JSValue out = JS_NewString(ctx, shown);

    g_free(shown);
    return out;
}

/*
 * Locale.Parse(text, [options]) -- the way back, or `null`.
 *
 * What a field that takes a number needs and had no word for: the same affixes
 * and the same locale rules `Locale.Number` writes with, read backwards.  It
 * answers a `Decimal` and never a double, and **`null` rather than a throw**
 * when the text is not a number -- a field being typed into is not an error,
 * and the caller decides what an empty or half-typed entry means.
 *
 *     Locale.Parse("1.234,56")                       // → 1234.56
 *     Locale.Parse("12,5 kg", { Suffix: " kg" })     // → 12.5
 *     Locale.Parse("US$ 1.234,56", { Symbol: "US$" })// → 1234.56
 */
static JSValue js_locale_parse(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv)
{
    if (argc < 1 || !JS_IsString(argv[0]))
        return JS_ThrowTypeError(ctx, "Locale.Parse(text, [options]) needs text");

    LocaleNumOpts o;

    if (!locale_opts(ctx, argc > 1 ? argv[1] : JS_UNDEFINED, "Locale.Parse", &o))
        return JS_EXCEPTION;

    const char *text = JS_ToCString(ctx, argv[0]);
    if (!text) {
        locale_opts_free(&o);
        return JS_EXCEPTION;
    }

    int64_t units = 0;
    int     scale = 0;
    bool    ok    = bta_locale_parse_number(text, &o.fmt, &units, &scale);

    JS_FreeCString(ctx, text);
    locale_opts_free(&o);

    return ok ? bta_decimal_new(ctx, units, scale) : JS_NULL;
}

/*
 * The character this desktop writes a decimal with.
 *
 * Which a program needs the moment it lets somebody *type* a number rather than
 * only showing one: an entry being built up -- "3," on its way to "3,5" -- is
 * not a number yet and cannot be formatted, so the field has to write the
 * separator itself.  The calculator example is the case that asked for it.
 *
 * A character and not a rule: grouping is `Locale.Number`'s business, and
 * handing out the thousands separator too would invite somebody to assemble a
 * number by hand and get India wrong.
 */
static JSValue js_locale_get_point(JSContext *ctx, JSValueConst this_val)
{
    struct lconv *lc = localeconv();

    return JS_NewString(ctx, lc->decimal_point[0] ? lc->decimal_point : ".");
}


/* ------------------------------------------------------- ordering and finding
 *
 * The two things a list of names needs and that the language underneath cannot
 * do: put them in order, and find one that was typed without its accents.
 *
 * `localeCompare` is installed -- it is a method of `String` and nothing took it
 * away -- and on this engine it is `strcmp` wearing the name.  QuickJS is built
 * without ICU, so there is no `Intl` and the fallback is a codepoint compare,
 * which is not an approximation of alphabetical order but a different order:
 *
 *     ["Zapata", "Álvarez", "Ñandú"].sort()   ->  Zapata, Álvarez, Ñandú
 *
 * Every accented word in the language this file is commented in sorts after Z,
 * silently, on a machine where the desktop and `Locale.Number` and `Locale.Date`
 * are all already speaking Spanish.  So this is the same bargain the rest of this
 * module makes: the answer is the desktop's, read from the C locale that
 * `setlocale(LC_ALL, "")` at startup already put in place.
 */

/*
 * Locale.Compare(a, b) -- -1, 0 or 1, in this desktop's own order.
 *
 * Shaped to be handed straight to `sort`, because that is where it is needed:
 *
 *     names.sort(Locale.Compare)
 *     rows.sort((a, b) => Locale.Compare(a.Name, b.Name))
 *
 * Normalised to the three values rather than passing `strcoll`'s number through.
 * `sort` only reads the sign, but a comparison is also written into an `if`, and
 * a function that answered 2 on one machine and 34 on another would invite a
 * test that pinned the wrong one.
 *
 * `TableView.SortBy` has collated since it was written -- `g_utf8_collate`, in
 * bta_table.c -- which is exactly what made this gap hard to see: the widget that
 * sorts its own rows was right, and every list a program sorted by hand was
 * wrong.  Including the IDE's project tree, which sorted its files with
 * `localeCompare`.
 */
static JSValue js_locale_compare(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv)
{
    if (argc < 2)
        return JS_ThrowTypeError(ctx, "Locale.Compare(a, b) needs two strings");

    const char *a = JS_ToCString(ctx, argv[0]);
    if (!a)
        return JS_EXCEPTION;

    const char *b = JS_ToCString(ctx, argv[1]);
    if (!b) {
        JS_FreeCString(ctx, a);
        return JS_EXCEPTION;
    }

    /*
     * A lone surrogate survives a round trip through a JS string and is not
     * UTF-8 on the way out; `g_utf8_collate` says nothing about what it does
     * with one.  Falling back to a byte compare keeps the order total, which is
     * what `sort` requires of a comparator and what it will crash without.
     */
    int r = (g_utf8_validate(a, -1, NULL) && g_utf8_validate(b, -1, NULL))
          ? g_utf8_collate(a, b)
          : strcmp(a, b);

    JS_FreeCString(ctx, a);
    JS_FreeCString(ctx, b);

    return JS_NewInt32(ctx, r < 0 ? -1 : r > 0 ? 1 : 0);
}

/*
 * What a string looks like once nothing about how it is written matters any
 * more: no case, no accents, no ligatures.
 *
 * Decompose (NFKD, which splits `á` into `a` and a combining acute and turns a
 * `ﬁ` ligature into `fi`), drop every combining mark, then casefold -- which is
 * not `tolower`: it is the full Unicode fold, so `ß` becomes `ss` and Turkish
 * `İ` -- already reduced to `I` by the step before -- becomes `i`.
 *
 * Marks are dropped rather than transliterated, so this reaches every alphabet
 * and not only the Latin one: `g_str_to_ascii` would answer `?` for Greek and
 * for Cyrillic, and a search box that cannot find a Russian name is worse than
 * one that cannot ignore its accents.
 */
static char *fold_for_search(const char *s)
{
    char *split = g_utf8_normalize(s, -1, G_NORMALIZE_ALL);
    if (!split)
        return NULL;

    GString *bare = g_string_new(NULL);

    for (const char *p = split; *p; p = g_utf8_next_char(p)) {
        gunichar c = g_utf8_get_char(p);

        if (g_unichar_type(c) != G_UNICODE_NON_SPACING_MARK)
            g_string_append_unichar(bare, c);
    }
    g_free(split);

    char *folded = g_utf8_casefold(bare->str, -1);
    g_string_free(bare, TRUE);
    return folded;
}

/*
 * Locale.Matches(text, needle) -- should a search for `needle` find `text`?
 *
 *     Locale.Matches("Echeverría, Nahuel", "ver")        // true
 *     Locale.Matches("García, Andrés", "garcia")         // true
 *     Locale.Matches("Álvarez, María", "maria alv")      // true
 *     Locale.Matches("Álvarez, María", "maria zapata")   // false
 *
 * Two rules, and the first is the one everybody already expects: **a word of
 * `needle` matches anywhere in `text`**, the way `includes` does, so a fragment
 * out of the middle of a name finds it.
 *
 * The second is what `includes` cannot do: it is asked of both sides *folded*,
 * so `garcia` finds *García*.  Somebody typing into a search field is not going
 * to reach for the dead key, and `"Á".toLowerCase()` is `"á"` and not `"a"` --
 * no amount of lowercasing in JS gets there, because the question is about the
 * alphabet and not about the character.
 *
 * And the needle is split on its spaces, every word of which has to be found.
 * That is what makes `maria alv` turn up *Álvarez, María* whichever way round
 * the list writes the two halves -- a plain substring search cannot, and it is
 * how anyone types when they half remember a name.
 *
 * **This was `g_str_match_string` first**, which is GTK's own rule for a search
 * entry: a word of `text` *starting with* a word of `needle`.  It is defensible
 * -- `ana` does not drag in *Santana* -- and it was wrong here within a minute
 * of somebody using it, because `ver` did not find *Echeverría* and there is no
 * reading of a search box under which that is the right answer.
 */
static JSValue js_locale_matches(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv)
{
    if (argc < 2)
        return JS_ThrowTypeError(ctx,
            "Locale.Matches(text, needle) needs a text and what was typed");

    const char *text = JS_ToCString(ctx, argv[0]);
    if (!text)
        return JS_EXCEPTION;

    const char *needle = JS_ToCString(ctx, argv[1]);
    if (!needle) {
        JS_FreeCString(ctx, text);
        return JS_EXCEPTION;
    }

    char *folded = fold_for_search(text);
    char *typed  = fold_for_search(needle);
    bool  r      = true;

    if (!folded || !typed) {
        /* Not valid UTF-8 on one side or the other, which a JS string can hold.
         * A plain substring is the honest answer rather than none. */
        r = strstr(text, needle) != NULL;
    } else {
        /* Every word typed has to be somewhere in it.  A needle of nothing
         * splits to nothing and matches -- which is what a search field holds
         * before anybody types in it, so no caller needs a guard of its own. */
        char **words = g_strsplit_set(typed, " \t\n", -1);

        for (int i = 0; words[i]; i++)
            if (*words[i] && !strstr(folded, words[i])) {
                r = false;
                break;
            }
        g_strfreev(words);
    }

    g_free(folded);
    g_free(typed);
    JS_FreeCString(ctx, text);
    JS_FreeCString(ctx, needle);

    return JS_NewBool(ctx, r);
}

static const JSCFunctionListEntry locale_props[] = {
    JS_CFUNC_DEF("Text",    1, js_locale_text),
    JS_CFUNC_DEF("Plural",  3, js_locale_plural),
    JS_CFUNC_DEF("Context", 2, js_locale_context),
    JS_CFUNC_DEF("Read",    1, js_locale_read),
    JS_CFUNC_DEF("Number",  2, js_locale_number),
    JS_CFUNC_DEF("Date",    2, js_locale_date),
    JS_CFUNC_DEF("Currency", 2, js_locale_currency),
    JS_CFUNC_DEF("Parse",   2, js_locale_parse),
    JS_CFUNC_DEF("Compare", 2, js_locale_compare),
    JS_CFUNC_DEF("Matches", 2, js_locale_matches),
    JS_CGETSET_DEF("DecimalPoint", js_locale_get_point, NULL),
    JS_CGETSET_DEF("Current",   js_locale_get_current, js_locale_set_current),
    JS_CGETSET_DEF("Available", js_locale_get_available, NULL),
};

/*
 * Which catalogue to start with: the first of the desktop's languages that the
 * project has a file for.
 *
 * g_get_language_names() hands back the whole ordered list a locale implies --
 * es_AR.UTF-8, es_AR, es, C -- so a project shipping only es.po serves an
 * Argentine desktop without anybody listing the variants.
 */
void bta_locale_init(JSContext *ctx, JSValue global, const char *project_dir,
                    GPtrArray *libs)
{
    L.dirs     = g_ptr_array_new_with_free_func(g_free);
    L.language = g_strdup("");

    /* Libraries first and the project last: that is load order, and the last
     * file to mention a msgid answers for it. */
    for (guint i = 0; libs && i < libs->len; i++)
        g_ptr_array_add(L.dirs, g_build_filename(g_ptr_array_index(libs, i),
                                                 "po", NULL));
    g_ptr_array_add(L.dirs, g_build_filename(project_dir, "po", NULL));

    bool any = false;
    for (guint i = 0; i < L.dirs->len && !any; i++)
        any = g_file_test(g_ptr_array_index(L.dirs, i), G_FILE_TEST_IS_DIR);

    if (any) {
        const char * const *names = g_get_language_names();
        for (int i = 0; names && names[i]; i++) {
            if (g_str_equal(names[i], "C"))
                break;                          /* C means "no translation" */
            if (catalogue_use(names[i]))
                break;
        }
    }

    JSValue locale = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, locale, locale_props,
                               G_N_ELEMENTS(locale_props));
    JS_SetPropertyStr(ctx, global, "Locale", locale);
}

void bta_locale_cleanup(void)
{
    catalogue_clear();
    if (L.dirs) {
        g_ptr_array_free(L.dirs, TRUE);
        L.dirs = NULL;
    }
    g_clear_pointer(&L.language, g_free);
}
