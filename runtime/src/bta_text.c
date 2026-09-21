/*
 * Editor and TextEditor -- a buffer of text with a cursor in it.
 *
 * `Editor` is the abstract half of two controls: everything a `GtkTextView` can
 * answer, which is everything a `GtkSourceView` can answer too, since GTK's own
 * hierarchy is the same one -- `GtkSourceView` *is* a `GtkTextView`.  So `Text`,
 * the position, the selection, undo and the two events live here once, and
 * [`SourceEditor`](bta_editor.c) adds the source file's half on top: languages,
 * a theme, a gutter, completion, search, marks.
 *
 * `TextEditor` is the other child and it is the plain one: a `GtkTextView`, for
 * the observations field, the note, the log pane -- the multi-line text this
 * widget set went without for a long time, with the choice being a `TextBox`
 * (which is one line, and a `GtkEntry` cannot hold a newline at all) or the
 * source editor with its languages turned off.  The IDE did the latter in three
 * lines of apology, and `PoForm` is where they were:
 *
 *     box.Language        = "";          // prose, not source
 *     box.ShowLineNumbers = false;
 *     box.Wrap            = true;
 *
 * **Why the shared half is an abstract class and not the parent being
 * `TextEditor` itself.**  It would read better -- a source editor *is* a text
 * editor -- and it cannot be done, for one reason that would be a disaster:
 * `texts` accumulates down the class chain (see `class_list_of`), so a
 * `TextEditor` declaring its `Text` as prose would hand a `SourceEditor` the
 * same declaration, and a catalogue holding a line of somebody's source would
 * rewrite their code, silently and only in that language.  With `Editor` in the
 * middle, each child says its own: a memo's starting text is prose, a source
 * file's is not.  Which is the difference the two classes exist for.
 */
#include "bta.h"

static GtkTextBuffer *buffer_of(BtaWidget *w)
{
    return gtk_text_view_get_buffer(GTK_TEXT_VIEW(w->inner));
}

static void on_buffer_changed(GtkTextBuffer *buf, gpointer user_data)
{
    bta_emit((BtaWidget *)user_data, "Change", 0, NULL);
}

static void on_cursor_moved(GtkTextBuffer *buf, GParamSpec *pspec, gpointer user_data)
{
    bta_emit((BtaWidget *)user_data, "Cursor", 0, NULL);
}

/*
 * The plumbing both editors need, given whichever view they built: the scroller
 * that is the widget the parent lays out, and the two events.
 *
 * Exported rather than duplicated because getting it wrong is not visible from
 * JS: the buffer is not the widget, so the finaliser's sweep cannot find these
 * handlers on its own and has to be told (`bta_widget_watch`) -- and a handler
 * that outlives its widget fires into freed memory some frames later, in
 * whatever test happens to run next.
 */
void bta_text_view_setup(BtaWidget *w, GtkWidget *view)
{
    w->inner = view;
    w->gtk   = gtk_scrolled_window_new();

    gtk_scrolled_window_set_policy(GTK_SCROLLED_WINDOW(w->gtk),
                                   GTK_POLICY_AUTOMATIC, GTK_POLICY_AUTOMATIC);
    gtk_scrolled_window_set_child(GTK_SCROLLED_WINDOW(w->gtk), view);

    /*
     * Where it is scrolled to, which until now it could not say.
     *
     * An editor scrolls *itself* -- the line above is where its
     * GtkScrolledWindow is built -- so wrapping one in a `Scroller` to find out
     * measured the wrong thing, and `Line`/`GotoLine` answer about the cursor
     * with the scroll following as a side effect. Two panes of a diff cannot be
     * kept in step by a cursor. This publishes the scrolled window it already
     * had, under the four names `Scroller` already uses.
     */
    bta_scroll_watch(w);

    GtkTextBuffer *buf = gtk_text_view_get_buffer(GTK_TEXT_VIEW(view));
    g_signal_connect(buf, "changed", G_CALLBACK(on_buffer_changed), w);
    g_signal_connect(buf, "notify::cursor-position",
                     G_CALLBACK(on_cursor_moved), w);
    bta_widget_watch(w, buf);
}

/*
 * A plain multi-line field.
 *
 * **It wraps, and the source editor does not**, which is the one default the two
 * disagree about and it is the whole difference in use: prose in a box 240 wide
 * with a horizontal scrollbar under it is a field nobody can read, and code that
 * wraps hides its own indentation. `Wrap` is the same property on both; what
 * differs is what each arrives with.
 *
 * Not monospace, for the same reason: this is text a person writes, not a file a
 * program reads. A form that wants a fixed pitch says so with `Font`, which is
 * every control's answer to that question already.
 */
static void build_text_editor(BtaWidget *w)
{
    GtkWidget *view = gtk_text_view_new();

    gtk_text_view_set_wrap_mode(GTK_TEXT_VIEW(view), GTK_WRAP_WORD_CHAR);
    /* The same 6 the source editor uses: text against the frame reads as a bug
     * in the theme, and GtkTextView's own default is 0. */
    gtk_text_view_set_left_margin(GTK_TEXT_VIEW(view), 6);
    gtk_text_view_set_right_margin(GTK_TEXT_VIEW(view), 6);
    gtk_text_view_set_top_margin(GTK_TEXT_VIEW(view), 4);

    bta_text_view_setup(w, view);
}

/* ------------------------------------------------------------------ Text */

static JSValue ed_get_text(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    GtkTextBuffer *buf = buffer_of(w);
    GtkTextIter    a, b;
    gtk_text_buffer_get_bounds(buf, &a, &b);

    char   *s = gtk_text_buffer_get_text(buf, &a, &b, FALSE);
    JSValue v = JS_NewString(ctx, s ? s : "");
    g_free(s);
    return v;
}

static JSValue ed_set_text(JSContext *ctx, JSValueConst this_val, JSValueConst val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *s = JS_ToCString(ctx, val);
    if (!s)
        return JS_EXCEPTION;

    GtkTextBuffer *buf = buffer_of(w);
    gtk_text_buffer_set_text(buf, s, -1);

    /* gtk_text_buffer_set_text leaves the cursor and the scroll where they were
     * before the set: cursor at the end, view scrolled to the end of the
     * previous text.  For a load, what one expects is the cursor at the start
     * and the view at the top. */
    GtkTextIter start;
    gtk_text_buffer_get_start_iter(buf, &start);
    gtk_text_buffer_place_cursor(buf, &start);
    gtk_text_view_scroll_to_iter(GTK_TEXT_VIEW(w->inner), &start,
                                 0.0, TRUE, 0.0, 0.0);

    JS_FreeCString(ctx, s);
    return JS_UNDEFINED;
}

/* ----------------------------------------------------------------- flags */

/*
 * The five an editor of either kind has.  `ShowLineNumbers`, `ShowMarks` and
 * `Completion` are not among them: a gutter and a completion popover are
 * GtkSourceView's, and they are declared where they are implemented.
 */
enum { ED_MODIFIED, ED_READONLY, ED_WRAP, ED_CANUNDO, ED_CANREDO };

static JSValue ed_get_flag(JSContext *ctx, JSValueConst this_val, int magic)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    switch (magic) {
    case ED_MODIFIED:
        return JS_NewBool(ctx, gtk_text_buffer_get_modified(buffer_of(w)));
    case ED_READONLY:
        return JS_NewBool(ctx, !gtk_text_view_get_editable(GTK_TEXT_VIEW(w->inner)));
    case ED_CANUNDO:
        return JS_NewBool(ctx, gtk_text_buffer_get_can_undo(buffer_of(w)));
    case ED_CANREDO:
        return JS_NewBool(ctx, gtk_text_buffer_get_can_redo(buffer_of(w)));
    default:
        return JS_NewBool(ctx, gtk_text_view_get_wrap_mode(GTK_TEXT_VIEW(w->inner))
                               != GTK_WRAP_NONE);
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
    case ED_MODIFIED:
        gtk_text_buffer_set_modified(buffer_of(w), b);
        break;
    case ED_READONLY:
        gtk_text_view_set_editable(GTK_TEXT_VIEW(w->inner), !b);
        break;
    default:
        gtk_text_view_set_wrap_mode(GTK_TEXT_VIEW(w->inner),
                                    b ? GTK_WRAP_WORD_CHAR : GTK_WRAP_NONE);
        break;
    }
    return JS_UNDEFINED;
}

/* -------------------------------------------------------------- position */

static JSValue ed_get_line(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    GtkTextBuffer *buf = buffer_of(w);
    GtkTextIter    it;
    gtk_text_buffer_get_iter_at_mark(buf, &it, gtk_text_buffer_get_insert(buf));
    return JS_NewInt32(ctx, gtk_text_iter_get_line(&it) + 1);   /* 1-based */
}

static JSValue ed_get_column(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    GtkTextBuffer *buf = buffer_of(w);
    GtkTextIter    it;
    gtk_text_buffer_get_iter_at_mark(buf, &it, gtk_text_buffer_get_insert(buf));
    return JS_NewInt32(ctx, gtk_text_iter_get_line_offset(&it) + 1);
}

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

/*
 * The cursor as a **character** offset -- the same unit `Column` and `Select`
 * count in, so an emoji is one.  GTK answers it without walking the text, and
 * that is the price of the unit: it is not the number a `Regex` returned.
 * See `LineOf` for that one.
 */
static JSValue ed_get_offset(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    GtkTextBuffer *buf = buffer_of(w);
    GtkTextIter    it;
    gtk_text_buffer_get_iter_at_mark(buf, &it, gtk_text_buffer_get_insert(buf));
    return JS_NewInt32(ctx, gtk_text_iter_get_offset(&it));
}

/*
 * The offset of a line/column, in characters -- the inverse read of `Offset`.
 * The clamps are `Select`'s, in the same order and by the same calls, because
 * a stale column has to land where it can rather than on the next line.
 */
static JSValue ed_offset_at(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int32_t line = 1, column = 1;
    if (argc < 1 || JS_ToInt32(ctx, &line, argv[0]))
        return JS_EXCEPTION;
    if (argc > 1 && !JS_IsUndefined(argv[1]) && JS_ToInt32(ctx, &column, argv[1]))
        return JS_EXCEPTION;
    if (column < 1)
        column = 1;

    GtkTextBuffer *buf = buffer_of(w);
    GtkTextIter    it;
    bta_text_iter_at_line(buf, &it, line);

    if (column > 1) {
        GtkTextIter eol = it;
        if (!gtk_text_iter_ends_line(&eol))
            gtk_text_iter_forward_to_line_end(&eol);

        int last = gtk_text_iter_get_line_offset(&eol);
        gtk_text_iter_set_line_offset(&it, MIN(column - 1, last));
    }
    return JS_NewInt32(ctx, gtk_text_iter_get_offset(&it));
}

/*
 * The line a search's index falls on, for a mark or a `GotoLine` -- `Line` is
 * the cursor's, and this is the one for a result.
 */
static JSValue ed_line_of(JSContext *ctx, JSValueConst this_val,
                          int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int32_t index = 0;
    if (argc < 1 || JS_ToInt32(ctx, &index, argv[0]))
        return JS_EXCEPTION;

    GtkTextBuffer *buf = buffer_of(w);
    GtkTextIter    a, b;
    gtk_text_buffer_get_bounds(buf, &a, &b);

    char   *s   = gtk_text_buffer_get_text(buf, &a, &b, FALSE);
    JSValue out = JS_NewInt32(ctx, bta_line_of_utf16(s ? s : "", index));

    g_free(s);
    return out;
}

static JSValue ed_goto_line(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int32_t line;
    if (argc < 1 || JS_ToInt32(ctx, &line, argv[0]))
        return JS_EXCEPTION;

    GtkTextBuffer *buf = buffer_of(w);
    GtkTextIter    it;
    int            last = gtk_text_buffer_get_line_count(buf) - 1;

    gtk_text_buffer_get_iter_at_line(buf, &it, CLAMP(line - 1, 0, last));
    gtk_text_buffer_place_cursor(buf, &it);

    /*
     * Through the cursor's *mark* and not the iter, for the reason `Select`
     * gives next door: `scroll_to_iter` on a view with no allocation does
     * nothing and says nothing, so a tab opened in this same turn kept the
     * cursor on the right line and left the view at the top of the file.
     *
     * This used to be an iter, with a note in `AGENTS.md` saying `GotoLine` was
     * "called where a frame has already passed".  That was true of the two
     * callers it had -- a traceback clicked in the log, and the find bar -- and
     * false the day a third arrived: the events page opens the `.js` and jumps
     * to the handler without returning to the main loop in between.
     *
     * 0.0 puts the line against the top edge; 0.3 (the value used originally)
     * pushed the first line 30% down the view, and that looked like an empty
     * block between the tabs and the editor when the file was short.
     */
    gtk_text_view_scroll_to_mark(GTK_TEXT_VIEW(w->inner),
                                 gtk_text_buffer_get_insert(buf),
                                 0.0, TRUE, 0.0, 0.0);
    return JS_UNDEFINED;
}

static JSValue ed_insert(JSContext *ctx, JSValueConst this_val,
                         int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *s = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    if (s)
        gtk_text_buffer_insert_at_cursor(buffer_of(w), s, -1);
    JS_FreeCString(ctx, s);
    return JS_UNDEFINED;
}

/* Appends at the end and scrolls there, whatever the cursor was doing --
 * what a log or console pane wants. Works even when ReadOnly is set, since
 * that only blocks the user's keyboard, not the program. */
static JSValue ed_append(JSContext *ctx, JSValueConst this_val,
                         int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    const char *s = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    if (!s)
        return JS_UNDEFINED;

    GtkTextBuffer *buf = buffer_of(w);
    GtkTextIter    end;

    gtk_text_buffer_get_end_iter(buf, &end);
    gtk_text_buffer_insert(buf, &end, s, -1);
    JS_FreeCString(ctx, s);

    gtk_text_buffer_get_end_iter(buf, &end);
    GtkTextMark *mark = gtk_text_buffer_create_mark(buf, NULL, &end, FALSE);
    gtk_text_view_scroll_to_mark(GTK_TEXT_VIEW(w->inner), mark, 0.0, TRUE, 0.0, 1.0);
    gtk_text_buffer_delete_mark(buf, mark);
    return JS_UNDEFINED;
}

static JSValue ed_clear(JSContext *ctx, JSValueConst this_val,
                        int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;
    gtk_text_buffer_set_text(buffer_of(w), "", -1);
    return JS_UNDEFINED;
}

/* Read-only: what is selected is a fact about the moment, not a property of the
 * editor -- and a setter would put it in the .form file. Ctrl+F pre-filled with
 * the word under the cursor is what this is for. */
static JSValue ed_get_selection(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    GtkTextBuffer *buf = buffer_of(w);
    GtkTextIter    a, b;

    if (!gtk_text_buffer_get_selection_bounds(buf, &a, &b))
        return JS_NewString(ctx, "");

    char   *s = gtk_text_buffer_get_text(buf, &a, &b, FALSE);
    JSValue v = JS_NewString(ctx, s ? s : "");
    g_free(s);
    return v;
}

static JSValue ed_undo(JSContext *ctx, JSValueConst this_val,
                       int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    GtkTextBuffer *buf = buffer_of(w);
    if (gtk_text_buffer_get_can_undo(buf))
        gtk_text_buffer_undo(buf);
    return JS_UNDEFINED;
}

static JSValue ed_redo(JSContext *ctx, JSValueConst this_val,
                       int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    GtkTextBuffer *buf = buffer_of(w);
    if (gtk_text_buffer_get_can_redo(buf))
        gtk_text_buffer_redo(buf);
    return JS_UNDEFINED;
}

/* The line a JS caller means, 1-based and clamped, as an iter at its start.
 * Exported because a `SourceEditor`'s marks are placed by line too, and two
 * spellings of "clamp it" is how one of them ends up off by one. */
void bta_text_iter_at_line(GtkTextBuffer *buf, GtkTextIter *it, int32_t line)
{
    int last = gtk_text_buffer_get_line_count(buf) - 1;
    gtk_text_buffer_get_iter_at_line(buf, it, CLAMP(line - 1, 0, last));
}

/* -------------------------------------------------------------- selection
 *
 * Select(line, [column], [length]) -- put the cursor there and select `length`
 * characters from it.
 *
 * `GotoLine` reaches a line; this reaches a *match*, which is what a list of
 * results elsewhere in the window has to be able to hand back to the editor.
 * Scrolling is the minimum that reveals it (`use_align` false): stepping
 * through matches with the view jumping to the top on every one is the
 * behaviour that made `GotoLine`'s 0.3 wrong, in a smaller way.
 */
static JSValue ed_select(JSContext *ctx, JSValueConst this_val,
                         int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int32_t line, column = 1, length = 0;
    if (argc < 1 || JS_ToInt32(ctx, &line, argv[0]))
        return JS_EXCEPTION;
    if (argc > 1 && !JS_IsUndefined(argv[1]) && JS_ToInt32(ctx, &column, argv[1]))
        return JS_EXCEPTION;
    if (argc > 2 && !JS_IsUndefined(argv[2]) && JS_ToInt32(ctx, &length, argv[2]))
        return JS_EXCEPTION;

    GtkTextBuffer *buf = buffer_of(w);
    GtkTextIter    a, b;
    bta_text_iter_at_line(buf, &a, line);

    /* A column past the end of the line is the end of the line, not the next
     * one: a stale result standing on a line that has been edited since should
     * land where it can, rather than somewhere else entirely. */
    if (column > 1) {
        /* The end of the line and not `chars_in_line - 1`, which counts the
         * line break and is one short on a last line that has none. */
        GtkTextIter eol = a;
        if (!gtk_text_iter_ends_line(&eol))
            gtk_text_iter_forward_to_line_end(&eol);

        int last = gtk_text_iter_get_line_offset(&eol);
        gtk_text_iter_set_line_offset(&a, CLAMP(column - 1, 0, last));
    }

    b = a;
    if (length > 0)
        gtk_text_iter_forward_chars(&b, length);

    /* Insert at the far end, selection bound at the start: the same way
     * dragging a selection leaves it, so typing replaces the match. */
    gtk_text_buffer_select_range(buf, &b, &a);

    /*
     * Revealed through the *mark* and not the iter, which is the difference
     * between working and looking broken: a tab that was just opened has no
     * allocation yet, and `scroll_to_iter` on a view with none does nothing at
     * all -- silently, so the selection is right and the view is somewhere else.
     * `scroll_to_mark` keeps the request and carries it out on the frame there
     * is one.  The mark is the selection's own far end from the cursor, so what
     * gets revealed is the start of the match rather than its tail.
     */
    gtk_text_view_scroll_to_mark(GTK_TEXT_VIEW(w->inner),
                                 gtk_text_buffer_get_selection_bound(buf),
                                 0.0, FALSE, 0.0, 0.0);
    return JS_UNDEFINED;
}

static const JSCFunctionListEntry editor_props[] = {
    JS_CGETSET_DEF("Text",      ed_get_text,      ed_set_text),
    JS_CGETSET_MAGIC_DEF("ScrollX",    bta_scroll_get, bta_scroll_set, BTA_SCROLL_X),
    JS_CGETSET_MAGIC_DEF("ScrollY",    bta_scroll_get, bta_scroll_set, BTA_SCROLL_Y),
    JS_CGETSET_MAGIC_DEF("ScrollMaxX", bta_scroll_get, NULL, BTA_SCROLL_MAX_X),
    JS_CGETSET_MAGIC_DEF("ScrollMaxY", bta_scroll_get, NULL, BTA_SCROLL_MAX_Y),
    JS_CGETSET_DEF("Line",      ed_get_line,      NULL),
    JS_CGETSET_DEF("Column",    ed_get_column,    NULL),
    JS_CGETSET_DEF("Offset",    ed_get_offset,    NULL),
    JS_CGETSET_DEF("Selection", ed_get_selection, NULL),
    JS_CGETSET_MAGIC_DEF("Modified", ed_get_flag, ed_set_flag, ED_MODIFIED),
    JS_CGETSET_MAGIC_DEF("ReadOnly", ed_get_flag, ed_set_flag, ED_READONLY),
    JS_CGETSET_MAGIC_DEF("Wrap",     ed_get_flag, ed_set_flag, ED_WRAP),
    JS_CGETSET_MAGIC_DEF("CanUndo",  ed_get_flag, NULL,        ED_CANUNDO),
    JS_CGETSET_MAGIC_DEF("CanRedo",  ed_get_flag, NULL,        ED_CANREDO),
    JS_CFUNC_DEF("GotoLine", 1, ed_goto_line),
    JS_CFUNC_DEF("Select",   3, ed_select),
    JS_CFUNC_DEF("LineOf",   1, ed_line_of),
    JS_CFUNC_DEF("OffsetAt", 2, ed_offset_at),
    JS_CFUNC_DEF("Insert",   1, ed_insert),
    JS_CFUNC_DEF("Append",   1, ed_append),
    JS_CFUNC_DEF("Clear",    0, ed_clear),
    JS_CFUNC_DEF("Undo",     0, ed_undo),
    JS_CFUNC_DEF("Redo",     0, ed_redo),
};

void bta_text_register(void)
{
    const BtaClass rows[] = {
        /*
         * Abstract, and it raises the two events: they are emitted from
         * `bta_text_view_setup`, which is the code both children build with, so
         * this is the class that can honestly declare them.  A child that has
         * one of its own re-declares these to keep the order -- a name goes in
         * once, and `EventNames()[0]` is what the designer's double click
         * writes, so `Change` has to stay at the head.
         */
        BTA_CLASS("Editor", "Control", NULL, editor_props, false,
                  "Change,Cursor,Scroll"),
        /*
         * **`Text` is prose here and not in a `SourceEditor`**, which is the
         * whole reason `Editor` exists (see the note at the top of this file). A
         * form asking for observations with a template in the box gets it
         * translated like any caption; a source file never goes near a
         * catalogue.
         */
        BTA_CLASS_FULL("TextEditor", "Editor", build_text_editor, NULL, 0, false,
                       NULL, "Text", NULL),
    };
    bta_register_classes(rows, (int)G_N_ELEMENTS(rows));
}
