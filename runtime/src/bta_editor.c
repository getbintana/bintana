/*
 * SourceEditor -- GtkSourceView 5, on top of `Editor`.
 *
 * The IDE is written in Bintana, so its code editor has to be a Bintana
 * widget like any other.  Language definitions and style schemes ship inside
 * libgtksourceview as a GResource; they are looked up by id ("js", "json").
 *
 * **What is not here is the half a plain `GtkTextView` can answer**: `Text`, the
 * cursor's line and column, the selection, `Insert`/`Append`/`Clear`, undo and
 * the `Change` and `Cursor` events all belong to `Editor`
 * ([bta_text.c](bta_text.c)) and are inherited -- GTK's own hierarchy is the
 * same shape, since a `GtkSourceView` *is* a `GtkTextView`.  What stays is
 * everything that needs the source view: the language and the theme, the
 * gutter, completion, search and replace, and the marks.
 *
 * It was called `TextEditor` until there was a real one: a control this widget
 * set was missing, and whose absence the IDE itself papered over by turning this
 * one's languages off (see `PoForm`).
 */
#include "bta.h"

#include <gtksourceview/gtksource.h>

/* The buffer as GtkSourceView sees it. `Editor`'s half of the code asks for the
 * same object as a plain `GtkTextBuffer`, which is what it is. */
static GtkSourceBuffer *buffer_of(BtaWidget *w)
{
    return GTK_SOURCE_BUFFER(gtk_text_view_get_buffer(GTK_TEXT_VIEW(w->inner)));
}

/* Below, with the completion: it needs a window to put a popover in, and this is
 * connected here because `build_editor` is where the view is made.  The provider
 * fed from JS has the same constraint, so it is attached from the same place. */
static void on_editor_realized(GtkWidget *view, gpointer user_data);
static void editor_attach_provider(BtaWidget *w);

static void build_source_editor(BtaWidget *w)
{
    GtkWidget     *view = gtk_source_view_new();
    GtkSourceView *sv   = GTK_SOURCE_VIEW(view);

    gtk_source_view_set_show_line_numbers(sv, TRUE);
    gtk_source_view_set_highlight_current_line(sv, TRUE);
    gtk_source_view_set_auto_indent(sv, TRUE);
    gtk_source_view_set_insert_spaces_instead_of_tabs(sv, TRUE);
    gtk_source_view_set_tab_width(sv, 4);
    gtk_source_view_set_indent_width(sv, 4);
    gtk_source_view_set_show_line_marks(sv, FALSE);
    gtk_text_view_set_monospace(GTK_TEXT_VIEW(sv), TRUE);
    gtk_text_view_set_left_margin(GTK_TEXT_VIEW(sv), 6);

    /* The scroller, the buffer's two events and the watch that keeps them from
     * outliving the widget: the same for both editors, so it is written once. */
    bta_text_view_setup(w, view);

    /* Completion needs a window to put its popover in; this is when there is
     * one. See editor_sync_completion. */
    g_signal_connect(view, "realize", G_CALLBACK(on_editor_realized), w);
}

/* -------------------------------------------------------------- Language */

static JSValue ed_get_language(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    GtkSourceLanguage *lang = gtk_source_buffer_get_language(buffer_of(w));
    return JS_NewString(ctx, lang ? gtk_source_language_get_id(lang) : "");
}

static JSValue ed_set_language(JSContext *ctx, JSValueConst this_val, JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *id = JS_ToCString(ctx, val);
    if (!id)
        return JS_EXCEPTION;

    GtkSourceLanguage *lang = NULL;
    if (*id) {
        lang = gtk_source_language_manager_get_language(
                   gtk_source_language_manager_get_default(), id);
        if (!lang) {
            JSValue e = JS_ThrowRangeError(ctx, "no syntax definition for '%s'", id);
            JS_FreeCString(ctx, id);
            return e;
        }
    }
    gtk_source_buffer_set_language(buffer_of(w), lang);

    JS_FreeCString(ctx, id);
    return JS_UNDEFINED;
}

/* ----------------------------------------------------------------- Theme */

static JSValue ed_get_theme(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    GtkSourceStyleScheme *s = gtk_source_buffer_get_style_scheme(buffer_of(w));
    return JS_NewString(ctx, s ? gtk_source_style_scheme_get_id(s) : "");
}

static JSValue ed_set_theme(JSContext *ctx, JSValueConst this_val, JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *id = JS_ToCString(ctx, val);
    if (!id)
        return JS_EXCEPTION;

    GtkSourceStyleScheme *scheme = gtk_source_style_scheme_manager_get_scheme(
        gtk_source_style_scheme_manager_get_default(), id);
    if (!scheme) {
        JSValue e = JS_ThrowRangeError(ctx, "no style scheme named '%s'", id);
        JS_FreeCString(ctx, id);
        return e;
    }
    gtk_source_buffer_set_style_scheme(buffer_of(w), scheme);

    JS_FreeCString(ctx, id);
    return JS_UNDEFINED;
}

/* ----------------------------------------------------------------- flags */

/*
 * `Completion` -- the words already in this buffer, offered as you type.
 *
 * The floor of what an editor owes, and the whole of what can be known without
 * being told anything: `GtkSourceCompletionWords` walks the buffer and proposes
 * what is in it, so typing a long identifier a second time is a keystroke. It has
 * no idea what the text *means* -- that is the other half, and it belongs to
 * whoever knows (see docs/ide.md on the context-aware provider).
 *
 * Off by default. An editor is also used to show a file, a log, a diff, and a
 * popover appearing over one of those is an editor doing something it was not
 * asked to.
 *
 * The provider is kept on the widget rather than in a static: two editors are two
 * buffers, and `gtk_source_completion_words_register` is per buffer.
 */
#define COMPLETION_KEY  "bta-completion-words"   /* the provider, once attached */
#define COMPLETION_WANT "bta-completion-want"    /* what was asked for */
#define COMPLETION_TITLE "bta-completion-title"  /* what the application calls it */
#define PROVIDER_KEY    "bta-completion-provider" /* the one fed from JS */

/*
 * **Attached when the view has a root, and not when the property is set.**
 *
 * `gtk_source_view_get_completion()` builds the completion object and its
 * popover on the spot, and a popover built on a view that is in no window gets a
 * surface with no size: the first attempt renders once badly
 * (`Trying to snapshot GtkGizmo without a current allocation`) and every attempt
 * after it fails outright (`gdk_popup_present: assertion 'width > 0'`). Which is
 * exactly the shape of "it works once and then never again".
 *
 * A `.form` never hits it -- the loader parents a control before applying its
 * properties -- and code does: `new SourceEditor()`, set it up, *then* add it, is
 * the natural order and it was the IDE's. So the property is a request and this
 * is where it is carried out, which makes the order the caller happens to use
 * stop mattering.
 */
static void editor_sync_completion(BtaWidget *w)
{
    /* No window yet: `realize` will ask again. */
    if (!gtk_widget_get_root(w->inner))
        return;

    bool want = g_object_get_data(G_OBJECT(w->inner), COMPLETION_WANT) != NULL;
    GtkSourceCompletionWords *words =
        g_object_get_data(G_OBJECT(w->inner), COMPLETION_KEY);

    if (want && !words) {
        GtkSourceCompletion *comp =
            gtk_source_view_get_completion(GTK_SOURCE_VIEW(w->inner));

        words = gtk_source_completion_words_new("Words");

        /*
         * **How much of the file it indexes per turn of the main loop.**
         *
         * The provider builds its word index in idle batches, and the default is
         * 50 lines -- so a 1500 line source is thirty trips through the main loop
         * before the first proposal can appear, which reads as *the first time is
         * slow and then it is fine*. It is: the index is built once and kept up
         * to date by the buffer's own changes.
         *
         * 1000 lines a batch puts an ordinary source file in one or two turns.
         * The cost is the other side of the same coin -- one longer idle callback
         * instead of thirty short ones -- and it is a scan for word boundaries
         * over some tens of kilobytes, which is not the kind of work a frame
         * notices. A file large enough for it to matter is also one where thirty
         * trips would have been three hundred.
         */
        g_object_set(words, "scan-batch-size", 1000, NULL);

        gtk_source_completion_words_register(words,
                                             GTK_TEXT_BUFFER(buffer_of(w)));
        gtk_source_completion_add_provider(
            comp, GTK_SOURCE_COMPLETION_PROVIDER(words));
        /* Ours to drop, and dropping it is what unregisters the buffer -- the
         * widget owns it for exactly as long as it is on. */
        g_object_set_data_full(G_OBJECT(w->inner), COMPLETION_KEY, words,
                              g_object_unref);
    } else if (!want && words) {
        gtk_source_completion_remove_provider(
            gtk_source_view_get_completion(GTK_SOURCE_VIEW(w->inner)),
            GTK_SOURCE_COMPLETION_PROVIDER(words));
        gtk_source_completion_words_unregister(words,
                                              GTK_TEXT_BUFFER(buffer_of(w)));
        g_object_set_data(G_OBJECT(w->inner), COMPLETION_KEY, NULL);
    }
}

static void on_editor_realized(GtkWidget *view, gpointer user_data)
{
    (void)view;
    editor_sync_completion((BtaWidget *)user_data);
    editor_attach_provider((BtaWidget *)user_data);
}

/* The three the source view adds; the five an editor of either kind has are
 * `Editor`'s (bta_text.c). */
enum { ED_LINENUMBERS, ED_COMPLETION, ED_MARKS };

static JSValue ed_get_flag(JSContext *ctx, JSValueConst this_val, int magic)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    switch (magic) {
    case ED_LINENUMBERS:
        return JS_NewBool(ctx, gtk_source_view_get_show_line_numbers(
                                   GTK_SOURCE_VIEW(w->inner)));
    case ED_MARKS:
        return JS_NewBool(ctx, gtk_source_view_get_show_line_marks(
                                   GTK_SOURCE_VIEW(w->inner)));
    default:
        /* What was asked for, not whether it is attached yet: the property has
         * to read back the moment it is set, window or no window. */
        return JS_NewBool(ctx, g_object_get_data(G_OBJECT(w->inner),
                                                 COMPLETION_WANT) != NULL);
    }
}

static JSValue ed_set_flag(JSContext *ctx, JSValueConst this_val,
                           JSValueConst val, int magic)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int b = JS_ToBool(ctx, val);
    if (b < 0)
        return JS_EXCEPTION;

    switch (magic) {
    case ED_LINENUMBERS:
        gtk_source_view_set_show_line_numbers(GTK_SOURCE_VIEW(w->inner), b);
        break;
    case ED_MARKS:
        gtk_source_view_set_show_line_marks(GTK_SOURCE_VIEW(w->inner), b);
        break;
    default:
        /* A request, carried out by `editor_sync_completion` once there is a
         * window to put a popover in. */
        g_object_set_data(G_OBJECT(w->inner), COMPLETION_WANT,
                          b ? GINT_TO_POINTER(1) : NULL);
        editor_sync_completion(w);
        break;
    }
    return JS_UNDEFINED;
}

/* ------------------------------------------------------- CompletionTitle
 *
 * What the proposals from `Complete` appear under. Prose, declared as such in
 * the class row, so it goes through the catalogue like any caption -- which is
 * the point: a title living in C is invisible to the extractor and could never
 * be translated by the application that owns the words.
 */
static JSValue ed_get_completion_title(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *title = g_object_get_data(G_OBJECT(w->inner), COMPLETION_TITLE);
    return JS_NewString(ctx, title ? title : "");
}

static JSValue ed_set_completion_title(JSContext *ctx, JSValueConst this_val,
                                       JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *s = JS_ToCString(ctx, val);
    if (!s)
        return JS_EXCEPTION;

    g_object_set_data_full(G_OBJECT(w->inner), COMPLETION_TITLE,
                           *s ? g_strdup(s) : NULL, g_free);
    JS_FreeCString(ctx, s);
    return JS_UNDEFINED;
}

/* ---------------------------------------------------------------- search */

/*
 * GtkSourceView keeps the search itself: the settings say what is being looked
 * for, the context does the looking and highlights every match as a side effect
 * of existing.  One per editor, made the first time Search() is called and tied
 * to the view's lifetime -- it references the buffer, so it may not outlive it.
 *
 * What is *not* taken from GtkSourceView is the counting.  Its own
 * occurrences-count is filled in by a scan that runs in the background and
 * answers -1 until that scan lands, so "12 matches" would arrive some frames
 * after the search and a test could only wait and hope.  Counting by walking the
 * matches is synchronous, exact, and assertable -- and on a source file it is
 * work nobody can measure.
 */
#define SEARCH_KEY "bta-search-context"

static GtkSourceSearchContext *search_of(BtaWidget *w, bool create)
{
    GtkSourceSearchContext *sc = g_object_get_data(G_OBJECT(w->inner), SEARCH_KEY);

    if (!sc && create) {
        GtkSourceSearchSettings *settings = gtk_source_search_settings_new();

        /* A find bar wraps: reaching the end and stopping there is not what
         * pressing F3 twelve times means. */
        gtk_source_search_settings_set_wrap_around(settings, TRUE);

        sc = gtk_source_search_context_new(buffer_of(w), settings);
        g_object_unref(settings);   /* the context holds it */

        gtk_source_search_context_set_highlight(sc, TRUE);
        g_object_set_data_full(G_OBJECT(w->inner), SEARCH_KEY, sc, g_object_unref);
    }
    return sc;
}

/* Every match, from the top. `wrap_around` is on, so the walk stops when the
 * search comes back to where it started rather than when it runs out. */
static int search_count(GtkSourceSearchContext *sc, GtkTextBuffer *buf)
{
    GtkTextIter it, ms, me;
    gboolean    wrapped = FALSE;
    int         n       = 0;

    gtk_text_buffer_get_start_iter(buf, &it);
    while (gtk_source_search_context_forward(sc, &it, &ms, &me, &wrapped) && !wrapped) {
        n++;
        /* A regex can match nothing ("x*"), and an empty match would leave the
         * cursor where it was and count forever. */
        if (gtk_text_iter_equal(&ms, &me) && !gtk_text_iter_forward_char(&me))
            break;
        it = me;
    }
    return n;
}

/*
 * Which match the selection is, 1-based, or 0 when it is not one -- the "3" in
 * "3 of 12".  Same walk, for the same reason get_occurrence_position is not
 * used: it comes from the background scan too.
 */
static int search_position(GtkSourceSearchContext *sc, GtkTextBuffer *buf)
{
    GtkTextIter sel_a, sel_b;
    if (!gtk_text_buffer_get_selection_bounds(buf, &sel_a, &sel_b))
        return 0;

    GtkTextIter it, ms, me;
    gboolean    wrapped = FALSE;
    int         n       = 0;

    gtk_text_buffer_get_start_iter(buf, &it);
    while (gtk_source_search_context_forward(sc, &it, &ms, &me, &wrapped) && !wrapped) {
        n++;
        if (gtk_text_iter_equal(&ms, &sel_a) && gtk_text_iter_equal(&me, &sel_b))
            return n;
        if (gtk_text_iter_compare(&ms, &sel_a) > 0)
            return 0;                       /* past it: the selection is not a match */
        if (gtk_text_iter_equal(&ms, &me) && !gtk_text_iter_forward_char(&me))
            break;
        it = me;
    }
    return 0;
}

/* A regex the user is still typing is not an error to abort on, but the setter
 * rule applies: say what is wrong with the value that was given. */
static JSValue search_check_regex(JSContext *ctx, GtkSourceSearchContext *sc)
{
    GError *err = gtk_source_search_context_get_regex_error(sc);
    if (!err)
        return JS_UNDEFINED;

    JSValue e = JS_ThrowRangeError(ctx, "search: %s", err->message);
    g_error_free(err);
    return e;
}

static bool opt_bool(JSContext *ctx, JSValueConst obj, const char *key)
{
    if (!JS_IsObject(obj))
        return false;

    JSValue v = JS_GetPropertyStr(ctx, obj, key);
    bool    b = JS_ToBool(ctx, v) > 0;
    JS_FreeValue(ctx, v);
    return b;
}

/*
 * Search(text, {CaseSensitive, WholeWord, Regex}) -- sets what is looked for and
 * returns how many there are.  It does not move the cursor: highlighting the
 * matches and going to one are two things a find bar does at different moments
 * (typing versus pressing Enter), and only the caller knows which this is.
 * An empty text clears the search, highlight included.
 */
static JSValue ed_search(JSContext *ctx, JSValueConst this_val,
                         int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    bool        given = argc > 0 && !JS_IsUndefined(argv[0]) && !JS_IsNull(argv[0]);
    const char *text  = given ? JS_ToCString(ctx, argv[0]) : NULL;
    if (given && !text)
        return JS_EXCEPTION;

    JSValueConst             opts = argc > 1 ? argv[1] : JS_UNDEFINED;
    GtkSourceSearchContext  *sc   = search_of(w, true);
    GtkSourceSearchSettings *st   = gtk_source_search_context_get_settings(sc);

    gtk_source_search_settings_set_case_sensitive(st, opt_bool(ctx, opts, "CaseSensitive"));
    gtk_source_search_settings_set_at_word_boundaries(st, opt_bool(ctx, opts, "WholeWord"));
    gtk_source_search_settings_set_regex_enabled(st, opt_bool(ctx, opts, "Regex"));

    /* Empty means none: NULL is how the settings spell "not searching", and a
     * literal "" would otherwise match everywhere. */
    gtk_source_search_settings_set_search_text(st, text && *text ? text : NULL);
    JS_FreeCString(ctx, text);

    JSValue bad = search_check_regex(ctx, sc);
    if (JS_IsException(bad))
        return bad;

    return JS_NewInt32(ctx, search_count(sc, GTK_TEXT_BUFFER(buffer_of(w))));
}

static JSValue ed_get_matches(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    GtkSourceSearchContext *sc = search_of(w, false);
    if (!sc)
        return JS_NewInt32(ctx, 0);
    return JS_NewInt32(ctx, search_count(sc, GTK_TEXT_BUFFER(buffer_of(w))));
}

static JSValue ed_get_match_index(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    GtkSourceSearchContext *sc = search_of(w, false);
    if (!sc)
        return JS_NewInt32(ctx, 0);
    return JS_NewInt32(ctx, search_position(sc, GTK_TEXT_BUFFER(buffer_of(w))));
}

/* Selects a match and brings it into view. What makes the found text the
 * selection is also what makes Replace() know which occurrence it is on. */
static void search_go_to(BtaWidget *w, GtkTextIter *ms, GtkTextIter *me)
{
    GtkTextBuffer *buf = GTK_TEXT_BUFFER(buffer_of(w));

    gtk_text_buffer_select_range(buf, ms, me);
    gtk_text_view_scroll_to_iter(GTK_TEXT_VIEW(w->inner), ms, 0.1, FALSE, 0.0, 0.0);
}

static JSValue ed_find(JSContext *ctx, JSValueConst this_val,
                       int argc, JSValueConst *argv, int backwards)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    GtkSourceSearchContext *sc = search_of(w, false);
    if (!sc)
        return JS_NewBool(ctx, false);      /* nothing was searched for */

    GtkTextBuffer *buf = GTK_TEXT_BUFFER(buffer_of(w));
    GtkTextIter    a, b, ms, me;

    /* From the far side of what is selected, so the match one is standing on is
     * not the one found again: forward from its end, backward from its start. */
    if (!gtk_text_buffer_get_selection_bounds(buf, &a, &b)) {
        gtk_text_buffer_get_iter_at_mark(buf, &a, gtk_text_buffer_get_insert(buf));
        b = a;
    }

    gboolean found = backwards
        ? gtk_source_search_context_backward(sc, &a, &ms, &me, NULL)
        : gtk_source_search_context_forward(sc, &b, &ms, &me, NULL);

    if (found)
        search_go_to(w, &ms, &me);
    return JS_NewBool(ctx, found);
}

static JSValue ed_find_next(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
    return ed_find(ctx, this_val, argc, argv, false);
}

static JSValue ed_find_previous(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
    return ed_find(ctx, this_val, argc, argv, true);
}

/*
 * Replaces the match one is standing on -- the selection, if it is one -- and
 * leaves the replacement selected so a Replace/FindNext loop walks forward.
 * False when the selection is not a match, which is what "nothing to replace
 * yet, press Find first" looks like from JS.
 */
static JSValue ed_replace(JSContext *ctx, JSValueConst this_val,
                          int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    GtkSourceSearchContext *sc = search_of(w, false);
    if (!sc)
        return JS_NewBool(ctx, false);

    const char *with = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    if (!with)
        return JS_EXCEPTION;

    GtkTextBuffer *buf = GTK_TEXT_BUFFER(buffer_of(w));
    GtkTextIter    a, b;
    bool           done = false;

    if (gtk_text_buffer_get_selection_bounds(buf, &a, &b) &&
        search_position(sc, buf) > 0) {
        GError *err = NULL;
        done = gtk_source_search_context_replace(sc, &a, &b, with, -1, &err);
        if (err) {
            JS_FreeCString(ctx, with);
            JSValue e = JS_ThrowRangeError(ctx, "Replace: %s", err->message);
            g_error_free(err);
            return e;
        }
        /* replace() moves the iters to the replacement's bounds. */
        gtk_text_buffer_select_range(buf, &a, &b);
    }

    JS_FreeCString(ctx, with);
    return JS_NewBool(ctx, done);
}

static JSValue ed_replace_all(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    GtkSourceSearchContext *sc = search_of(w, false);
    if (!sc)
        return JS_NewInt32(ctx, 0);

    const char *with = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    if (!with)
        return JS_EXCEPTION;

    GError *err = NULL;
    guint   n   = gtk_source_search_context_replace_all(sc, with, -1, &err);
    JS_FreeCString(ctx, with);

    if (err) {
        JSValue e = JS_ThrowRangeError(ctx, "ReplaceAll: %s", err->message);
        g_error_free(err);
        return e;
    }
    return JS_NewInt32(ctx, (int)n);
}

/* --------------------------------------------- completion, fed from JS
 *
 * The other half of `Completion`, and the half that knows what the text
 * *means*. `GtkSourceCompletionWords` proposes the words already in the buffer,
 * which is the whole of what can be known without being told anything; this is
 * how an application tells.
 *
 * **What makes it cheap here is that nothing has to be inferred.** A completion
 * engine for JavaScript normally needs a parser and a type inferencer, because
 * nothing in the language says what `x` is. In a Bintana project the runtime
 * already publishes what it knows about itself -- `Widget.Types()`,
 * `PropertyNames()`, `EventNames()`, `PropertyOptions()` -- and the `.form`
 * beside a class says what every control on it is. So the useful completions are
 * *lookups*, and a lookup is something an application can do in a handler
 * without a frame going missing.
 *
 * **It is an event and not a callback property**, which is where this differs
 * from the first sketch of this feature. Every other thing a widget asks
 * its application is an event dispatched by name, and this one gains three
 * things by being one: `EventNames()` publishes it, so the IDE's *Write handler*
 * offers it like any other; the handler is written where all the others are; and
 * nothing has to hold a `JSValue` across time, which is the class of bug the
 * memory rules in AGENTS.md exist for.
 *
 *   Ed_Complete(word, line, column, before) -> ["Click", "Change"]
 *
 * `word` is what is being typed and `before` is the line **up to where that word
 * starts** -- not up to the cursor, and not the whole buffer. Both halves of
 * that matter and were measured rather than assumed:
 *
 *     this.Ok.      word ""       before "        this.Ok."
 *     this.Ok.Te    word "Te"     before "        this.Ok."
 *     Ok_           word "Ok_"    before "    "
 *
 * So a name being completed **is the word**, punctuation and all -- `_` is a
 * word character, which is why a handler being written arrives whole -- and
 * `before` is the stable context to the left of it, the same string whether one
 * has typed two letters of the property or none. A handler that read `before`
 * expecting to find the word in it would work for the first keystroke and stop
 * for the second, which is exactly how this was found.
 *
 * Not the whole buffer, and that is the other departure from the plan, which
 * said `text`: this fires on every keystroke, and copying a 78 KB source into a
 * JS string per character typed would be the whole cost of the feature.
 * Anything that really wants the file can read `Text`.
 *
 * The hard rule the plan states and this keeps: **the handler is a lookup**.
 * It runs inside GTK's completion machinery, on the keystroke, so anything that
 * is not a lookup does not belong in it.
 */

/* One proposal: the text that would be typed, plus what the row shows beside
 * it. Two members and an interface with one method -- the whole of what
 * GtkSourceView asks of a proposal. */
#define BTA_TYPE_PROPOSAL (bta_proposal_get_type())
G_DECLARE_FINAL_TYPE(BtaProposal, bta_proposal, BTA, PROPOSAL, GObject)

struct _BtaProposal {
    GObject parent_instance;
    char   *text;      /* what gets typed */
    char   *detail;    /* what the row says about it, greyed */
    guint   priority;  /* how well it matched what is being typed */
};

static char *bta_proposal_typed_text(GtkSourceCompletionProposal *proposal)
{
    return g_strdup(BTA_PROPOSAL(proposal)->text);
}

static void proposal_iface_init(GtkSourceCompletionProposalInterface *iface)
{
    iface->get_typed_text = bta_proposal_typed_text;
}

G_DEFINE_TYPE_WITH_CODE(BtaProposal, bta_proposal, G_TYPE_OBJECT,
    G_IMPLEMENT_INTERFACE(GTK_SOURCE_TYPE_COMPLETION_PROPOSAL, proposal_iface_init))

static void bta_proposal_finalize(GObject *object)
{
    BtaProposal *self = BTA_PROPOSAL(object);
    g_clear_pointer(&self->text, g_free);
    g_clear_pointer(&self->detail, g_free);
    G_OBJECT_CLASS(bta_proposal_parent_class)->finalize(object);
}

static void bta_proposal_class_init(BtaProposalClass *klass)
{
    G_OBJECT_CLASS(klass)->finalize = bta_proposal_finalize;
}

static void bta_proposal_init(BtaProposal *self) { (void)self; }

/* And the provider, which is the editor asking its form. */
#define BTA_TYPE_PROVIDER (bta_provider_get_type())
G_DECLARE_FINAL_TYPE(BtaProvider, bta_provider, BTA, PROVIDER, GObject)

struct _BtaProvider {
    GObject parent_instance;

    /* The editor this belongs to, or NULL once it is gone. Cleared by a weak
     * ref on the view rather than trusted to outlive it: GtkSourceCompletion
     * holds a reference of its own, and what order the two are dropped in is
     * not ours to decide. */
    BtaWidget *w;
};

/*
 * Whether this editor's form has a handler for the event at all.
 *
 * Asked rather than remembered, because a handler can be assigned at any time --
 * `this.Ed_Complete = ...` after `Form_Open` is as ordinary as declaring it --
 * and a flag latched at realize would be wrong for exactly as long as that.
 */
static bool provider_has_handler(BtaProvider *self)
{
    if (!self->w || !self->w->name || JS_IsUndefined(self->w->form))
        return false;

    JSContext *ctx = self->w->ctx;
    char      *key = g_strdup_printf("%s_Complete", self->w->name);
    JSValue    fn  = JS_GetPropertyStr(ctx, self->w->form, key);
    bool       has = JS_IsFunction(ctx, fn);

    g_free(key);
    JS_FreeValue(ctx, fn);
    return has;
}

/* The line up to the cursor: what a lookup reads, and cheap enough to hand over
 * on every keystroke. */
static char *line_before(GtkSourceCompletionContext *context)
{
    GtkTextIter begin, end;
    if (!gtk_source_completion_context_get_bounds(context, &begin, &end))
        return g_strdup("");

    GtkTextIter start = begin;
    gtk_text_iter_set_line_offset(&start, 0);
    return gtk_text_iter_get_text(&start, &begin);
}

static int proposal_by_priority(gconstpointer a, gconstpointer b, gpointer data)
{
    (void)data;
    return (int)BTA_PROPOSAL((gpointer)a)->priority -
           (int)BTA_PROPOSAL((gpointer)b)->priority;
}

/*
 * Asks the form, and turns what it answers into proposals.
 *
 * An answer may be a string -- the ordinary case -- or `{ Text, Detail }` for a
 * row that says something about itself. Anything else in the array is skipped
 * rather than refused: a handler that returns one odd entry among forty should
 * lose the entry, not the popover.
 */
static GListModel *provider_proposals(BtaProvider *self,
                                      GtkSourceCompletionContext *context)
{
    GListStore *store = g_list_store_new(BTA_TYPE_PROPOSAL);

    if (!provider_has_handler(self))
        return G_LIST_MODEL(store);

    BtaWidget *w   = self->w;
    JSContext *ctx = w->ctx;

    GtkTextIter begin, end;
    gtk_source_completion_context_get_bounds(context, &begin, &end);

    char *word   = gtk_source_completion_context_get_word(context);
    char *before = line_before(context);

    JSValue argv[4] = {
        JS_NewString(ctx, word ? word : ""),
        JS_NewInt32(ctx, gtk_text_iter_get_line(&begin) + 1),
        JS_NewInt32(ctx, gtk_text_iter_get_line_offset(&begin) + 1),
        JS_NewString(ctx, before ? before : ""),
    };

    JSValue answer = bta_emit_answer(w, "Complete", 4, argv, NULL);

    for (int i = 0; i < 4; i++)
        JS_FreeValue(ctx, argv[i]);
    g_free(before);

    /*
     * **Narrowing is the runtime's, not the handler's.**
     *
     * The handler is a lookup: asked about `this.Btn1.` it says what a Button
     * has, and having to also know that the user has typed `Te` since would
     * make every application write the same filter -- differently. GtkSourceView
     * publishes the one its own providers use, so the list narrows here and
     * looks the same as every other provider's, highlight included.
     *
     * Casefolded once: `fuzzy_match` takes a needle that already is.
     */
    char *needle = word && *word ? g_utf8_casefold(word, -1) : NULL;

    if (JS_IsArray(answer)) {
        JSValue  lenv = JS_GetPropertyStr(ctx, answer, "length");
        uint32_t len  = 0;
        JS_ToUint32(ctx, &len, lenv);
        JS_FreeValue(ctx, lenv);

        for (uint32_t i = 0; i < len; i++) {
            JSValue item = JS_GetPropertyUint32(ctx, answer, i);

            JSValue text_v   = JS_IsObject(item) ? JS_GetPropertyStr(ctx, item, "Text")
                                                 : JS_DupValue(ctx, item);
            JSValue detail_v = JS_IsObject(item) ? JS_GetPropertyStr(ctx, item, "Detail")
                                                 : JS_UNDEFINED;

            const char *text = JS_IsUndefined(text_v) || JS_IsNull(text_v)
                               ? NULL : JS_ToCString(ctx, text_v);

            guint priority = 0;
            bool  keep      = text && *text &&
                              (!needle ||
                               gtk_source_completion_fuzzy_match(text, needle, &priority));

            if (keep) {
                const char *detail = JS_IsString(detail_v)
                                     ? JS_ToCString(ctx, detail_v) : NULL;

                BtaProposal *proposal = g_object_new(BTA_TYPE_PROPOSAL, NULL);
                proposal->text     = g_strdup(text);
                proposal->detail   = detail ? g_strdup(detail) : NULL;
                proposal->priority = priority;

                g_list_store_append(store, proposal);
                g_object_unref(proposal);

                if (detail)
                    JS_FreeCString(ctx, detail);
            }
            if (text)
                JS_FreeCString(ctx, text);

            JS_FreeValue(ctx, detail_v);
            JS_FreeValue(ctx, text_v);
            JS_FreeValue(ctx, item);
        }
    }
    JS_FreeValue(ctx, answer);

    /* Best match first, and the handler's own order kept among equals: what it
     * answered first is what it thinks matters most. */
    if (needle)
        g_list_store_sort(store, proposal_by_priority, NULL);
    g_free(needle);
    g_free(word);        /* the needle is made from it: not a line earlier */

    return G_LIST_MODEL(store);
}

static GListModel *bta_provider_populate(GtkSourceCompletionProvider *provider,
                                         GtkSourceCompletionContext  *context,
                                         GError                     **error)
{
    (void)error;
    return provider_proposals(BTA_PROVIDER(provider), context);
}

/*
 * Narrowing as the word grows.
 *
 * The model handed back is the one `populate` returned, so it is refilled
 * rather than filtered: the handler is a lookup and answering again is what it
 * is for -- and it is the only way the *answer* can change with the word, which
 * is the point of `this.Bt` proposing fewer things than `this.`.
 */
static void bta_provider_refilter(GtkSourceCompletionProvider *provider,
                                  GtkSourceCompletionContext  *context,
                                  GListModel                  *model)
{
    if (!G_IS_LIST_STORE(model))
        return;

    GListModel *fresh = provider_proposals(BTA_PROVIDER(provider), context);
    guint       n     = g_list_model_get_n_items(fresh);

    g_list_store_remove_all(G_LIST_STORE(model));
    for (guint i = 0; i < n; i++) {
        GObject *item = g_list_model_get_item(fresh, i);
        g_list_store_append(G_LIST_STORE(model), item);
        g_object_unref(item);
    }
    g_object_unref(fresh);
}

/*
 * What starts it.
 *
 * A word character starts a completion on its own; `.` does not, and `this.` is
 * exactly the case this whole provider exists for. Only while there is a
 * handler, so an editor whose form says nothing about completion behaves as it
 * always did -- a popover after every dot typed in a log pane would be the
 * feature's whole cost paid by everyone who is not using it.
 */
static gboolean bta_provider_is_trigger(GtkSourceCompletionProvider *provider,
                                        const GtkTextIter           *iter,
                                        gunichar                     ch)
{
    (void)iter;
    return (ch == '.' || ch == '_') && provider_has_handler(BTA_PROVIDER(provider));
}

/* The row: what would be typed, and what the handler said about it. */
static void bta_provider_display(GtkSourceCompletionProvider *provider,
                                 GtkSourceCompletionContext  *context,
                                 GtkSourceCompletionProposal *proposal,
                                 GtkSourceCompletionCell     *cell)
{
    (void)provider;
    BtaProposal *p = BTA_PROPOSAL(proposal);

    switch (gtk_source_completion_cell_get_column(cell)) {
    case GTK_SOURCE_COMPLETION_COLUMN_TYPED_TEXT: {
        /* Highlighted the way every other provider highlights: the library's
         * own fuzzy match, so ours cannot look different from the words one. */
        char *word = gtk_source_completion_context_get_word(context);
        PangoAttrList *marks = word && *word
            ? gtk_source_completion_fuzzy_highlight(p->text, word) : NULL;

        gtk_source_completion_cell_set_text_with_attributes(cell, p->text, marks);

        g_clear_pointer(&marks, pango_attr_list_unref);
        g_free(word);
        break;
    }
    case GTK_SOURCE_COMPLETION_COLUMN_AFTER:
        gtk_source_completion_cell_set_text(cell, p->detail);
        break;
    default:
        gtk_source_completion_cell_set_text(cell, NULL);
        break;
    }
}

/* Choosing one replaces the word it was proposed for. */
static void bta_provider_activate(GtkSourceCompletionProvider *provider,
                                  GtkSourceCompletionContext  *context,
                                  GtkSourceCompletionProposal *proposal)
{
    (void)provider;
    GtkSourceBuffer *sbuf = gtk_source_completion_context_get_buffer(context);
    GtkTextBuffer   *buf  = GTK_TEXT_BUFFER(sbuf);
    GtkTextIter      begin, end;

    if (!gtk_source_completion_context_get_bounds(context, &begin, &end))
        return;

    gtk_text_buffer_begin_user_action(buf);
    gtk_text_buffer_delete(buf, &begin, &end);
    gtk_text_buffer_insert(buf, &begin, BTA_PROPOSAL(proposal)->text, -1);
    gtk_text_buffer_end_user_action(buf);
}

/*
 * The heading the proposals appear under.
 *
 * **The first prose the runtime owns that it can hand back.** A msgid living in
 * C is invisible to the IDE's extractor -- it reads a project's own `.js` and
 * `.form` -- so a fixed English word here would be untranslatable for every
 * application. `CompletionTitle` is the application's own string, extracted and
 * translated by the ordinary mechanism, and the fallback is only what a form
 * that never said anything gets.
 */
static char *bta_provider_title(GtkSourceCompletionProvider *provider)
{
    BtaProvider *self = BTA_PROVIDER(provider);
    const char  *title = self->w
        ? g_object_get_data(G_OBJECT(self->w->inner), COMPLETION_TITLE) : NULL;

    return g_strdup(title && *title ? title : "Suggestions");
}

static void provider_iface_init(GtkSourceCompletionProviderInterface *iface)
{
    iface->populate   = bta_provider_populate;
    iface->refilter   = bta_provider_refilter;
    iface->is_trigger = bta_provider_is_trigger;
    iface->display    = bta_provider_display;
    iface->activate   = bta_provider_activate;
    iface->get_title  = bta_provider_title;
}

G_DEFINE_TYPE_WITH_CODE(BtaProvider, bta_provider, G_TYPE_OBJECT,
    G_IMPLEMENT_INTERFACE(GTK_SOURCE_TYPE_COMPLETION_PROVIDER, provider_iface_init))

static void bta_provider_class_init(BtaProviderClass *klass) { (void)klass; }
static void bta_provider_init(BtaProvider *self) { self->w = NULL; }

/* The view is going: whatever still holds the provider must not read a
 * BtaWidget that is being freed in the same breath. */
static void on_view_gone(gpointer data, GObject *where_the_view_was)
{
    (void)where_the_view_was;
    BTA_PROVIDER(data)->w = NULL;
}

/*
 * Attached on realize, like the words provider and for the same reason: the
 * completion object and its popover are built where they are first asked for,
 * and building them on a view that is in no window gives the popover a surface
 * with no size -- one bad render and then `gdk_popup_present: assertion
 * 'width > 0' failed` on every attempt after. See AGENTS.md's trap list.
 */
static void editor_attach_provider(BtaWidget *w)
{
    if (!gtk_widget_get_root(w->inner))
        return;
    if (g_object_get_data(G_OBJECT(w->inner), PROVIDER_KEY))
        return;

    BtaProvider *provider = g_object_new(BTA_TYPE_PROVIDER, NULL);
    provider->w = w;
    g_object_weak_ref(G_OBJECT(w->inner), on_view_gone, provider);

    gtk_source_completion_add_provider(
        gtk_source_view_get_completion(GTK_SOURCE_VIEW(w->inner)),
        GTK_SOURCE_COMPLETION_PROVIDER(provider));

    g_object_set_data_full(G_OBJECT(w->inner), PROVIDER_KEY, provider,
                           g_object_unref);
}

/*
 * "Complete now", which is what a menu item bound to Ctrl+Space asks for.
 *
 * Worth having on its own -- every editor offers it -- and it is also the only
 * way the round trip can be asserted: whether a popover *appeared* is not
 * answerable from JS, but asking for one makes GTK build a context and call
 * every provider, so a handler that recorded what it was asked proves the
 * dispatch really goes through the completion machinery rather than through a
 * call the test made itself.
 */
static JSValue ed_show_completion(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv)
{
    (void)argc; (void)argv;
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    /* Nothing to show a popover on: a view in no window has no surface, and
     * asking for one there is the bug that trap is about. */
    if (!gtk_widget_get_root(w->inner))
        return JS_FALSE;

    editor_attach_provider(w);
    gtk_source_completion_show(
        gtk_source_view_get_completion(GTK_SOURCE_VIEW(w->inner)));
    return JS_TRUE;
}

/* ----------------------------------------------------------------- marks
 *
 * A mark in the gutter is how an editor says something about a *line* -- the
 * syntax error the file was saved with, the result one has jumped to, a
 * bookmark.  GtkSourceView draws them; what this adds is the four kinds, their
 * icons and a place to keep the message.
 *
 * **The kinds are fixed and named after what they mean**, not after an icon:
 * "Error", "Warning", "Info", "Bookmark".  A free-form category would have made
 * every caller pick an icon name, which is the sort of decision that comes out
 * different in each of them, and an icon that is not on this desktop draws a
 * blank square with nothing to say why (`Button.Icon` has the same problem and
 * the same answer).  The four are the ones an editor actually has to say.
 */
/*
 * **A list of icons per kind and not one**, for the reason a `.form` naming a
 * single one is a documented trap: the symbolic spelling is Adwaita's, and this
 * desktop (elementary-xfce) has `dialog-warning-symbolic` but neither
 * `dialog-error-symbolic` nor `dialog-information-symbolic` -- so a fixed name
 * draws an empty gutter on the machine it was written on and looks perfect
 * under Xvfb, where GTK falls back to Adwaita.  The first one that really
 * renders wins, which is what code picking an icon is supposed to do.
 */
/*
 * And three kinds that say something about the line rather than about a
 * message: **the ones a diff needs**.
 *
 * A side by side diff whose two panes are just two files is two files: what
 * makes it a diff is that the lines which differ are *shown* to. GtkSourceView
 * already paints the line a mark is on -- `background` on the attributes -- so
 * what this adds is three names for it and no new machinery.
 *
 * The colours carry an alpha and are therefore **blended over whatever the
 * theme paints**, which is what keeps one pair of numbers right in a light
 * scheme and in a dark one; a solid green would be a hole in a dark editor.
 * They are a tint and not a highlight: the text on top is the file's own
 * syntax colouring and has to stay readable.
 *
 * `Gap` is the third because a side by side diff has to pad: ten added lines on
 * the right face ten lines that are **not there** on the left, and without a
 * band saying so they read as ten blank lines in the file. It is the one of the
 * three that is not about the file's content at all, which is why it is dim and
 * carries no icon.
 *
 * Added and Removed keep an icon as well as the colour, because a diff read by
 * somebody who cannot tell the two tints apart is a diff with no information in
 * it -- the same argument the tree's `[M]` suffix makes beside its icon.
 */
typedef struct {
    const char *kind;
    const char *icons[3];
    int         priority;
    const char *background;          /* NULL: the line is not painted */
} MarkKind;

static const MarkKind MARK_KINDS[] = {
    { "Error",    { "dialog-error-symbolic",       "dialog-error",       NULL }, 3, NULL },
    { "Warning",  { "dialog-warning-symbolic",     "dialog-warning",     NULL }, 2, NULL },
    { "Info",     { "dialog-information-symbolic", "dialog-information", NULL }, 1, NULL },
    { "Bookmark", { "user-bookmarks-symbolic",     "user-bookmarks",     NULL }, 0, NULL },
    { "Added",    { "list-add-symbolic",           "list-add",           NULL }, 0,
      "rgba(64,190,96,0.22)" },
    { "Removed",  { "list-remove-symbolic",        "list-remove",        NULL }, 0,
      "rgba(224,80,80,0.22)" },
    { "Gap",      { NULL,                          NULL,                 NULL }, 0,
      "rgba(128,128,128,0.12)" },
};


#define MARK_TEXT_KEY "bta-mark-text"

static const MarkKind *mark_kind(const char *name)
{
    for (guint i = 0; i < G_N_ELEMENTS(MARK_KINDS); i++)
        if (!g_strcmp0(MARK_KINDS[i].kind, name))
            return &MARK_KINDS[i];
    return NULL;
}

/* The message rides on the mark, so the tooltip is whatever the caller said
 * about *that* line rather than a second table to keep in step. */
static char *on_mark_tooltip(GtkSourceMarkAttributes *attrs, GtkSourceMark *mark,
                             gpointer user_data)
{
    const char *text = g_object_get_data(G_OBJECT(mark), MARK_TEXT_KEY);
    return text && *text ? g_strdup(text) : NULL;
}

/*
 * Attributes are per view and per category, so they are registered once, the
 * first time a kind is used on this editor.  Asking GTK whether it already has
 * them is the check -- no bookkeeping of our own to fall out of step.
 */
static void mark_attributes(BtaWidget *w, const MarkKind *k)
{
    GtkSourceView *sv = GTK_SOURCE_VIEW(w->inner);

    int had = 0;
    if (gtk_source_view_get_mark_attributes(sv, k->kind, &had))
        return;

    const char *icon = NULL;
    for (int i = 0; !icon && i < 3 && k->icons[i]; i++)
        if (bta_icon_available(w->inner, k->icons[i]))
            icon = k->icons[i];

    GtkSourceMarkAttributes *attrs = gtk_source_mark_attributes_new();
    if (icon)
        gtk_source_mark_attributes_set_icon_name(attrs, icon);

    /* The line itself, for the kinds that are about the line. */
    GdkRGBA tint;
    if (k->background && gdk_rgba_parse(&tint, k->background))
        gtk_source_mark_attributes_set_background(attrs, &tint);

    g_signal_connect(attrs, "query-tooltip-text",
                     G_CALLBACK(on_mark_tooltip), NULL);
    gtk_source_view_set_mark_attributes(sv, k->kind, attrs, k->priority);
    g_object_unref(attrs);
}


/*
 * Mark(line, kind, [text]).
 *
 * **It turns the gutter on**, because a mark nobody can see is the failure this
 * codebase has been bitten by twice: a flag that reads back while the effect
 * never happened.  Turning it off again is `ShowMarks = false`, said on purpose;
 * clearing the marks deliberately does *not*, since a gutter that appears and
 * disappears moves the text under the cursor.
 */
static JSValue ed_mark(JSContext *ctx, JSValueConst this_val,
                       int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int32_t line;
    if (argc < 2)
        return JS_ThrowTypeError(ctx, "Mark(line, kind, [text]) needs a line and a kind");
    if (JS_ToInt32(ctx, &line, argv[0]))
        return JS_EXCEPTION;

    const char *name = JS_ToCString(ctx, argv[1]);
    if (!name)
        return JS_EXCEPTION;

    const MarkKind *k = mark_kind(name);
    if (!k) {
        JSValue e = JS_ThrowTypeError(ctx,
            "Mark: \"%s\" is not a kind -- Error, Warning, Info, Bookmark, "
            "Added, Removed or Gap", name);
        JS_FreeCString(ctx, name);
        return e;
    }
    JS_FreeCString(ctx, name);

    const char *text = NULL;
    if (argc > 2 && !JS_IsUndefined(argv[2]) && !JS_IsNull(argv[2])) {
        text = JS_ToCString(ctx, argv[2]);
        if (!text)
            return JS_EXCEPTION;
    }

    mark_attributes(w, k);

    GtkTextBuffer *buf = GTK_TEXT_BUFFER(buffer_of(w));
    GtkTextIter    it;
    bta_text_iter_at_line(buf, &it, line);

    GtkSourceMark *mark =
        gtk_source_buffer_create_source_mark(buffer_of(w), NULL, k->kind, &it);
    if (text)
        g_object_set_data_full(G_OBJECT(mark), MARK_TEXT_KEY,
                               g_strdup(text), g_free);
    if (text)
        JS_FreeCString(ctx, text);

    gtk_source_view_set_show_line_marks(GTK_SOURCE_VIEW(w->inner), TRUE);
    return JS_NewInt32(ctx, gtk_text_iter_get_line(&it) + 1);
}

/* The category a JS argument names, or NULL for "every kind" -- which is what
 * an absent argument means to Unmark, ClearMarks and Marks alike. */
static int mark_category(JSContext *ctx, int argc, JSValueConst *argv, int at,
                         const char **out)
{
    *out = NULL;
    if (argc <= at || JS_IsUndefined(argv[at]) || JS_IsNull(argv[at]))
        return 0;

    const char *name = JS_ToCString(ctx, argv[at]);
    if (!name)
        return -1;

    const MarkKind *k = mark_kind(name);
    JS_FreeCString(ctx, name);
    if (!k) {
        JS_ThrowTypeError(ctx, "not a mark kind -- Error, Warning, Info, "
                               "Bookmark, Added, Removed or Gap");
        return -1;
    }
    *out = k->kind;
    return 0;
}

static JSValue ed_unmark(JSContext *ctx, JSValueConst this_val,
                         int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int32_t line;
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "Unmark(line, [kind]) needs a line");
    if (JS_ToInt32(ctx, &line, argv[0]))
        return JS_EXCEPTION;

    const char *cat = NULL;
    if (mark_category(ctx, argc, argv, 1, &cat) < 0)
        return JS_EXCEPTION;

    GtkTextBuffer *buf = GTK_TEXT_BUFFER(buffer_of(w));
    GtkTextIter    a, b;
    bta_text_iter_at_line(buf, &a, line);
    b = a;
    gtk_text_iter_forward_to_line_end(&b);

    gtk_source_buffer_remove_source_marks(buffer_of(w), &a, &b, cat);
    return JS_UNDEFINED;
}

static JSValue ed_clear_marks(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *cat = NULL;
    if (mark_category(ctx, argc, argv, 0, &cat) < 0)
        return JS_EXCEPTION;

    GtkTextBuffer *buf = GTK_TEXT_BUFFER(buffer_of(w));
    GtkTextIter    a, b;
    gtk_text_buffer_get_bounds(buf, &a, &b);

    gtk_source_buffer_remove_source_marks(buffer_of(w), &a, &b, cat);
    return JS_UNDEFINED;
}

/*
 * Marks([kind]) -- `[{ Line, Kind, Text }]`, in line order.
 *
 * The reader that makes a mark assertable, which is what keeps this from being
 * another flag that reads back while nothing was drawn.  It walks GTK's own
 * marks rather than a list of ours: a mark moves with the text it sits on, and
 * a copy kept here would be wrong the first time somebody typed a line above it.
 */
static JSValue ed_marks(JSContext *ctx, JSValueConst this_val,
                        int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *cat = NULL;
    if (mark_category(ctx, argc, argv, 0, &cat) < 0)
        return JS_EXCEPTION;

    GtkSourceBuffer *sbuf = buffer_of(w);
    GtkTextBuffer   *buf  = GTK_TEXT_BUFFER(sbuf);
    JSValue          out  = JS_NewArray(ctx);
    uint32_t         n    = 0;

    GtkTextIter it;
    gtk_text_buffer_get_start_iter(buf, &it);

    /* The first line is looked at before stepping: forward_iter_to_source_mark
     * moves strictly forward, so a mark on line 1 is the one it would skip. */
    do {
        GSList *marks = gtk_source_buffer_get_source_marks_at_iter(sbuf, &it, cat);
        for (GSList *l = marks; l; l = l->next) {
            GtkSourceMark *mark = l->data;
            const char    *text = g_object_get_data(G_OBJECT(mark), MARK_TEXT_KEY);

            JSValue row = JS_NewObject(ctx);
            JS_SetPropertyStr(ctx, row, "Line",
                              JS_NewInt32(ctx, gtk_text_iter_get_line(&it) + 1));
            JS_SetPropertyStr(ctx, row, "Kind",
                              JS_NewString(ctx, gtk_source_mark_get_category(mark)));
            JS_SetPropertyStr(ctx, row, "Text", JS_NewString(ctx, text ? text : ""));
            JS_SetPropertyUint32(ctx, out, n++, row);
        }
        g_slist_free(marks);
    } while (gtk_source_buffer_forward_iter_to_source_mark(sbuf, &it, cat));

    return out;
}

/* What the source view adds. Everything a plain text view answers -- `Text`,
 * `Line`, `Column`, `Selection`, `Modified`, `ReadOnly`, `Wrap`, `CanUndo`,
 * `CanRedo`, `GotoLine`, `Select`, `Insert`, `Append`, `Clear`, `Undo`, `Redo`
 * -- is inherited from `Editor` and must not be repeated here: a second row for
 * the same name would shadow the parent's with a copy that then drifts. */
static const JSCFunctionListEntry source_props[] = {
    JS_CGETSET_DEF("Language", ed_get_language, ed_set_language),
    JS_CGETSET_DEF("Theme",    ed_get_theme,    ed_set_theme),
    JS_CGETSET_DEF("CompletionTitle", ed_get_completion_title, ed_set_completion_title),
    JS_CGETSET_DEF("Matches",    ed_get_matches,     NULL),
    JS_CGETSET_DEF("MatchIndex", ed_get_match_index, NULL),
    JS_CGETSET_MAGIC_DEF("ShowLineNumbers", ed_get_flag, ed_set_flag, ED_LINENUMBERS),
    JS_CGETSET_MAGIC_DEF("ShowMarks",       ed_get_flag, ed_set_flag, ED_MARKS),
    JS_CGETSET_MAGIC_DEF("Completion",      ed_get_flag, ed_set_flag, ED_COMPLETION),
    /* ShowCompletion() */
    JS_CFUNC_DEF("ShowCompletion", 0, ed_show_completion),
    /* Mark(line, kind, [text]) */
    JS_CFUNC_DEF("Mark",       3, ed_mark),
    /* Unmark(line, [kind]) */
    JS_CFUNC_DEF("Unmark",     2, ed_unmark),
    /* ClearMarks([kind]) */
    JS_CFUNC_DEF("ClearMarks", 1, ed_clear_marks),
    /* Marks([kind]) */
    JS_CFUNC_DEF("Marks",      1, ed_marks),
    /* Search(text, [{CaseSensitive, WholeWord, Regex}]) */
    JS_CFUNC_DEF("Search",       2, ed_search),
    /* FindNext() */
    JS_CFUNC_DEF("FindNext",     0, ed_find_next),
    /* FindPrevious() */
    JS_CFUNC_DEF("FindPrevious", 0, ed_find_previous),
    /* Replace(with) */
    JS_CFUNC_DEF("Replace",      1, ed_replace),
    /* ReplaceAll(with) */
    JS_CFUNC_DEF("ReplaceAll",   1, ed_replace_all),
};

/*
 * Language and Theme are ids GtkSourceView knows, so the list of valid values
 * is asked of it rather than written down here: a system with one more
 * language definition installed offers one more choice, and the two can never
 * fall out of step.  Cached because a property editor asks on every selection.
 */
static const char *editor_options(const char *prop)
{
    static char *languages, *themes;

    if (!strcmp(prop, "Language")) {
        if (!languages) {
            const char *const *ids = gtk_source_language_manager_get_language_ids(
                gtk_source_language_manager_get_default());
            /* The empty id first: plain text, which is what no highlighting is. */
            char *list = g_strjoinv(",", (char **)ids);
            languages  = g_strconcat(",", list, NULL);
            g_free(list);
        }
        return languages;
    }

    if (!strcmp(prop, "Theme")) {
        if (!themes) {
            const char *const *ids = gtk_source_style_scheme_manager_get_scheme_ids(
                gtk_source_style_scheme_manager_get_default());
            themes = g_strjoinv(",", (char **)ids);
        }
        return themes;
    }
    return NULL;
}

void bta_editor_register(void)
{
    /*
     * **`Text` is not declared as prose here, and that is the decision this
     * whole mechanism exists for.**  A `SourceEditor`'s `Text` is the source
     * file being edited, so a catalogue that happened to hold a line of it would
     * rewrite the user's code -- silently, and only for whoever runs in that
     * language.  `CompletionTitle` is the one property here that does hold prose;
     * `Tooltip` comes from Widget, which is prose too.
     *
     * And it is why the shared half is an abstract `Editor` rather than
     * `TextEditor` itself: `texts` accumulates down the chain, so a plain text
     * editor declaring its own `Text` as prose -- which it should, a memo's
     * starting text is a caption like any other -- would hand this class the
     * same declaration through inheritance. Two siblings can disagree about it;
     * a child cannot disagree with its parent.
     *
     * `Change,Cursor` are re-declared although `Editor` already raises them,
     * because a name goes in once and the order is what `EventNames()` is read
     * for: the head is the event the control is *about*, and the designer's
     * double click writes it. Naming only `Complete` here would have made the
     * first event a completion request.
     */
    const BtaClass rows[] = {
        /* Change() */
        /* Cursor() */
        /* Complete(word, line, column, text) */
        BTA_CLASS_ENUM_TEXT("SourceEditor", "Editor", build_source_editor,
                            source_props, false, editor_options,
                            "CompletionTitle", "Change,Cursor,Complete"),
    };
    bta_register_classes(rows, (int)G_N_ELEMENTS(rows));
}
