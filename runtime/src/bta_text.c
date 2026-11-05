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

#include <string.h>

static GtkTextBuffer *buffer_of(BtaWidget *w)
{
    return gtk_text_view_get_buffer(GTK_TEXT_VIEW(w->inner));
}

static void on_buffer_changed(GtkTextBuffer *buf, gpointer user_data)
{
    /* `Format` edits many lines and raises one event at the end, not one per
     * line: a handler that redraws or re-reads the file would pay for every
     * indentation it moved. */
    if (g_object_get_data(G_OBJECT(buf), "bta-formatting"))
        return;

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
/*
 * `KeyPreview(key, ctrl, shift, alt)` -- a key, **before the editor has acted
 * on it**.
 *
 * `KeyPress` is a bubbling controller: whatever has focus gets first refusal,
 * which is right for a form's shortcuts and wrong for an editor, whose own
 * view takes Tab, Enter, the arrows and every printable key before anything
 * outside it hears of them (measured: a real Tab and a real End never reached
 * `KeyPress` of a `SourceEditor`).  A program that wants to turn Tab into a
 * snippet, or Enter into something other than a newline, has to be asked
 * first -- Visual Basic's `KeyPreview`, for the same reason -- so this is the
 * capture phase of the same key, and `true` consumes it.
 *
 * Capture on the view itself, and not on the box around it: the controllers on
 * one widget run in the order they were added, capture ones first, and the
 * completion's own (added when it is first asked for) comes after this one.
 */
static gboolean on_key_preview(GtkEventControllerKey *c, guint keyval,
                               guint keycode, GdkModifierType state,
                               gpointer user_data)
{
    BtaWidget *w   = user_data;
    JSContext *ctx = w->ctx;

    const char *name = gdk_keyval_name(keyval);
    JSValue argv[4] = {
        JS_NewString(ctx, name ? name : ""),
        JS_NewBool(ctx, (state & GDK_CONTROL_MASK) != 0),
        JS_NewBool(ctx, (state & GDK_SHIFT_MASK) != 0),
        JS_NewBool(ctx, (state & GDK_ALT_MASK) != 0),
    };

    JSValue  r       = bta_emit_answer(w, "KeyPreview", 4, argv, NULL);
    gboolean handled = JS_ToBool(ctx, r) > 0;

    JS_FreeValue(ctx, r);
    for (int i = 0; i < 4; i++)
        JS_FreeValue(ctx, argv[i]);
    return handled;
}

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

    /* Before the view acts on a key: see `on_key_preview`. */
    GtkEventController *preview = gtk_event_controller_key_new();
    gtk_event_controller_set_propagation_phase(preview, GTK_PHASE_CAPTURE);
    g_signal_connect(preview, "key-pressed", G_CALLBACK(on_key_preview), w);
    gtk_widget_add_controller(view, preview);

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

    char   *s = gtk_text_buffer_get_text(buf, &a, &b, TRUE);   /* hidden (folded) text is text */
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
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "OffsetAt(line, [column]) needs a line");
    if (!bta_to_int(ctx, argv[0], "OffsetAt", &line))
        return JS_EXCEPTION;
    if (argc > 1 && !JS_IsUndefined(argv[1]) && !bta_to_int(ctx, argv[1], "OffsetAt", &column))
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
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "LineOf(index) needs an index");
    if (!bta_to_int(ctx, argv[0], "LineOf", &index))
        return JS_EXCEPTION;

    GtkTextBuffer *buf = buffer_of(w);
    GtkTextIter    a, b;
    gtk_text_buffer_get_bounds(buf, &a, &b);

    char   *s   = gtk_text_buffer_get_text(buf, &a, &b, TRUE);   /* as `Text`: hidden counts */
    JSValue out = JS_NewInt32(ctx, bta_line_of_utf16(s ? s : "", index));

    g_free(s);
    return out;
}

/*
 * CursorBounds(): where the insertion cursor is drawn, `{ X, Y, Width, Height }`
 * in the control's own coordinates -- the space `Popover.Show(content, editor, { Rect })`
 * reads, which is what a hint beside the cursor is made of.
 *
 * `get_iter_location` answers in buffer coordinates, which scroll; the view
 * turns those into its window's, and `compute_point` carries them from the
 * view to the control, which is the scroller around it. A cursor scrolled out
 * of sight answers a rectangle outside the control's own, which is the truth
 * and is the caller's to test.
 */
static JSValue ed_cursor_bounds(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    GtkTextView   *view = GTK_TEXT_VIEW(w->inner);
    GtkTextBuffer *buf  = buffer_of(w);
    GtkTextIter    it;
    GdkRectangle   r;
    int            x, y;

    gtk_text_buffer_get_iter_at_mark(buf, &it, gtk_text_buffer_get_insert(buf));
    gtk_text_view_get_iter_location(view, &it, &r);
    gtk_text_view_buffer_to_window_coords(view, GTK_TEXT_WINDOW_WIDGET,
                                          r.x, r.y, &x, &y);

    graphene_point_t from = GRAPHENE_POINT_INIT((float)x, (float)y), to;
    if (w->gtk != w->inner &&
        gtk_widget_compute_point(w->inner, w->gtk, &from, &to)) {
        x = (int)to.x;
        y = (int)to.y;
    }

    JSValue out = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, out, "X",      JS_NewInt32(ctx, x));
    JS_SetPropertyStr(ctx, out, "Y",      JS_NewInt32(ctx, y));
    JS_SetPropertyStr(ctx, out, "Width",  JS_NewInt32(ctx, MAX(1, r.width)));
    JS_SetPropertyStr(ctx, out, "Height", JS_NewInt32(ctx, MAX(1, r.height)));
    return out;
}

/*
 * PositionAt(x, y): which character is under that point of the control, as
 * `{ Line, Column, Index }` -- or `null` when the point is not over text.
 *
 * **The point is the one `MouseMove` reports**, in the control's own
 * coordinates, which is why the walk starts at the scroller the gesture sits
 * on and comes in to the view: `CursorBounds` makes the same trip the other
 * way.  `Line` and `Column` are one-based and `Index` counts **characters**,
 * the unit `Offset` and `Column` already speak -- `Text.LineOf` is the one
 * that takes a JavaScript index.
 *
 * **The rectangle of the position it answers with is what decides `null`.** An
 * editor positions its cursor wherever it is asked, so asking past the end of
 * a line would otherwise answer the last character of it -- and a tooltip
 * would describe a word the pointer is nowhere near.  An empty editor answers
 * a position only over the first line's own box.
 */
static JSValue ed_position_at(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    double x, y;
    if (argc < 2)
        return JS_ThrowTypeError(ctx, "PositionAt(x, y) needs a point");
    if (!bta_to_number(ctx, argv[0], "PositionAt", &x) ||
        !bta_to_number(ctx, argv[1], "PositionAt", &y))
        return JS_EXCEPTION;

    GtkTextView *view = GTK_TEXT_VIEW(w->inner);
    int          vx   = (int) x;
    int          vy   = (int) y;

    if (w->gtk != w->inner) {
        graphene_point_t from = GRAPHENE_POINT_INIT((float) x, (float) y), to;

        if (!gtk_widget_compute_point(w->gtk, w->inner, &from, &to))
            return JS_NULL;
        vx = (int) to.x;
        vy = (int) to.y;
    }

    int bx, by;
    gtk_text_view_window_to_buffer_coords(view, GTK_TEXT_WINDOW_WIDGET,
                                          vx, vy, &bx, &by);

    GtkTextIter it;
    gtk_text_view_get_iter_at_location(view, &it, bx, by);

    /* **Both sides in buffer coordinates**, which is what they already are:
     * the point came in through `window_to_buffer_coords` and
     * `get_iter_location` answers in the buffer's own space. Converting one of
     * them back into the widget's made them disagree by the gutter -- a
     * `SourceEditor` answered nothing anywhere, and the plain editor passed by
     * having no gutter to disagree about. */
    GdkRectangle r;
    gtk_text_view_get_iter_location(view, &it, &r);

    if (bx < r.x || bx >= r.x + MAX(1, r.width) ||
        by < r.y || by >= r.y + r.height)
        return JS_NULL;

    JSValue out = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, out, "Line",
                      JS_NewInt32(ctx, gtk_text_iter_get_line(&it) + 1));
    JS_SetPropertyStr(ctx, out, "Column",
                      JS_NewInt32(ctx, gtk_text_iter_get_line_offset(&it) + 1));
    JS_SetPropertyStr(ctx, out, "Index",
                      JS_NewInt32(ctx, gtk_text_iter_get_offset(&it)));
    return out;
}

static JSValue ed_goto_line(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    int32_t line;
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "GotoLine(line) needs a line");
    if (!bta_to_int(ctx, argv[0], "GotoLine", &line))
        return JS_EXCEPTION;

    GtkTextBuffer *buf = buffer_of(w);
    GtkTextIter    it;
    int            last = gtk_text_buffer_get_line_count(buf) - 1;

    bta_editor_reveal(w, CLAMP(line - 1, 0, last) + 1);
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
    if (!s)
        return argc > 0 ? JS_EXCEPTION : JS_UNDEFINED;   /* a conversion that threw stands */
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
        return argc > 0 ? JS_EXCEPTION : JS_UNDEFINED;   /* a conversion that threw stands */

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

    char   *s = gtk_text_buffer_get_text(buf, &a, &b, TRUE);   /* hidden (folded) text is text */
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
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "Select(line, [column], [length]) needs a line");
    if (!bta_to_int(ctx, argv[0], "Select", &line))
        return JS_EXCEPTION;
    if (argc > 1 && !JS_IsUndefined(argv[1]) && !bta_to_int(ctx, argv[1], "Select", &column))
        return JS_EXCEPTION;
    if (argc > 2 && !JS_IsUndefined(argv[2]) && !bta_to_int(ctx, argv[2], "Select", &length))
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

    bta_editor_reveal(w, gtk_text_iter_get_line(&a) + 1);

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

/*
 * Format: a reindenter, not a pretty-printer.
 *
 * **Only the leading whitespace of a line is rewritten.** The tokens are read
 * well enough to know a brace inside a string, a comment, a template literal or
 * a regular expression is not a brace; a line whose state cannot be attributed
 * (inside a block comment or a multi-line template) is left exactly as it was.
 * There is no reflow, no wrapping and no opinion about spaces inside a line.
 *
 * The state is the delimiters open plus the lexical state a line can end in.
 * The regex/division decision is the one heuristic: a `/` starts a regex after an
 * operator or a keyword that expects an expression, and is division after a
 * value. A line that begins with `/` is taken as a regex, since a division
 * cannot begin a statement.
 */
typedef struct {
    int depth;              /* the switch body's indentation level */
    int brace;              /* level of a block opened on the case line, or 0 */
} IndentCase;

/* A delimiter that is open, and the indentation of the line that opened it.
 * A closer aligns with that line, not with the contents: `});` closes a call
 * and an object literal opened on the same line, and belongs at that line's
 * level. `contributes` is whether the opener raised the contents' level; two
 * delimiters opened on one line raise it once, as `foo({` does. */
typedef struct {
    char open;
    int  indent;
    bool contributes;
} IndentOpen;

#define INDENT_STACK 64

typedef struct {
    int  depth;             /* indentation levels from the delimiters open */
    int  line_indent;       /* the current line's own indentation */
    IndentOpen stack[INDENT_STACK];
    int  sp;
    int  open_on_line;      /* contributed openers from this line still open */
    int  quote;             /* 0, '\'', '"' or '`' */
    bool escaped;
    bool block_comment;
    bool can_regex;
    /* The switch bodies a `case` is open in, innermost last. A case body is
     * one level deeper than the case, and the closing brace of the switch is
     * not; a nested switch pushes its own. Eight is more than any file here
     * needs, and a ninth only loses the extra level, never the indentation. */
    IndentCase cases[8];
    int  case_count;
} IndentState;

static bool indent_word_start(char c)
{
    return g_ascii_isalpha(c) || c == '_' || c == '$';
}

static bool indent_word(char c)
{
    return g_ascii_isalnum(c) || c == '_' || c == '$';
}

/* The opener a closer closes, or 0 when the character is not a closer. */
static char indent_opener(char c)
{
    switch (c) {
    case '}': return '{';
    case ')': return '(';
    case ']': return '[';
    }
    return 0;
}

static bool indent_regex_word(const char *s, gsize n)
{
    static const char *const words[] = {
        "return", "throw", "case", "delete", "typeof", "void", "new",
        "in", "of", "yield", "await", "else", "do", "instanceof",
    };

    for (size_t i = 0; i < G_N_ELEMENTS(words); i++) {
        gsize len = strlen(words[i]);
        if (len == n && !strncmp(s, words[i], n))
            return true;
    }
    return false;
}

static bool indent_starts_word(const char *s, gsize n, const char *word)
{
    gsize len = strlen(word);
    return n >= len && !strncmp(s, word, len) &&
           (n == len || !indent_word(s[len]));
}

/* A line that begins with a regular expression and not a division. A division
 * cannot begin a statement, but a continuation line can begin with one, so the
 * closing slash is what tells them apart: `/ 2;` has none, `/a{2}/` does. */
static bool indent_line_regex(const char *s, gsize len, gsize first)
{
    if (first >= len || s[first] != '/')
        return false;
    if (first + 1 < len &&
        (s[first + 1] == '/' || s[first + 1] == '*' || s[first + 1] == '='))
        return false;

    bool escaped = false, in_class = false;
    for (gsize i = first + 1; i < len; i++) {
        char c = s[i];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (c == '\\') {
            escaped = true;
            continue;
        }
        if (c == '[') in_class = true;
        else if (c == ']') in_class = false;
        else if (c == '/' && !in_class) return true;
    }
    return false;
}

/* `case x:` or `default:`, and not a field called `default = 1`. The colon has
 * to be at the line's own level, before an `=` or a `;`: a colon inside an
 * object literal or a string is part of the expression, not the label. */
static bool indent_case_line(const char *s, gsize len, gsize first)
{
    if (!indent_starts_word(s + first, len - first, "case") &&
        !indent_starts_word(s + first, len - first, "default"))
        return false;

    int  depth = 0;
    char quote = 0;
    bool escaped = false;

    for (gsize i = first; i < len; i++) {
        char c = s[i];

        if (quote) {
            if (escaped) {
                escaped = false;
            } else if (c == '\\') {
                escaped = true;
            } else if (c == quote) {
                quote = 0;
            }
            continue;
        }

        if (c == '\'' || c == '"' || c == '`') {
            quote = c;
            continue;
        }
        if (c == '/' && i + 1 < len && s[i + 1] == '/')
            break;
        if (c == '/' && i + 1 < len && s[i + 1] == '*') {
            const char *close = g_strstr_len(s + i + 2, (gssize)(len - i - 2), "*/");
            if (!close)
                break;
            i = (gsize)(close - s) + 1;
            continue;
        }

        if (c == '(' || c == '[' || c == '{') {
            depth++;
            continue;
        }
        if (c == ')' || c == ']' || c == '}') {
            if (depth > 0)
                depth--;
            continue;
        }

        if (depth == 0 && (c == '=' || c == ';'))
            return false;
        if (depth == 0 && c == ':')
            return !(i + 1 < len && s[i + 1] == ':');
    }
    return false;
}

/* Walk one line, updating the lexical state and the delimiters open. */
static void indent_scan(const char *s, gsize len, IndentState *st)
{
    gsize i = 0;

    st->open_on_line = 0;

    while (i < len) {
        if (st->block_comment) {
            const char *close = g_strstr_len(s + i, (gssize)(len - i), "*/");
            if (!close) {
                i = len;
                break;
            }
            i = (gsize)(close - s) + 2;
            st->block_comment = false;
            continue;
        }

        if (st->quote) {
            char c = s[i];
            if (st->escaped) {
                st->escaped = false;
                i++;
                continue;
            }
            if (c == '\\') {
                st->escaped = true;
                i++;
                continue;
            }
            if (c == st->quote) {
                st->quote = 0;
                st->can_regex = false;
            }
            i++;
            continue;
        }

        char c = s[i];
        if (c == '/' && i + 1 < len && s[i + 1] == '*') {
            st->block_comment = true;
            i += 2;
            continue;
        }
        if (c == '/' && i + 1 < len && s[i + 1] == '/')
            break;

        if (c == '/' && st->can_regex) {
            bool in_class = false, escaped = false;
            i++;
            while (i < len) {
                char d = s[i];
                if (escaped) {
                    escaped = false;
                    i++;
                    continue;
                }
                if (d == '\\') {
                    escaped = true;
                    i++;
                    continue;
                }
                if (d == '[') in_class = true;
                else if (d == ']') in_class = false;
                else if (d == '/' && !in_class) {
                    i++;
                    break;
                }
                i++;
            }
            st->can_regex = false;
            continue;
        }

        if (c == '\'' || c == '"' || c == '`') {
            st->quote = c;
            st->escaped = false;
            st->can_regex = false;
            i++;
            continue;
        }
        if (c == '{' || c == '(' || c == '[') {
            if (st->sp < INDENT_STACK) {
                bool contributes = st->open_on_line == 0;

                st->stack[st->sp].open = c;
                st->stack[st->sp].indent = st->line_indent;
                st->stack[st->sp].contributes = contributes;
                st->sp++;

                if (contributes) {
                    st->depth++;
                    st->open_on_line++;
                }
            }
            st->can_regex = true;
            i++;
            continue;
        }
        if (c == '}' || c == ')' || c == ']') {
            char open = indent_opener(c);

            if (st->sp > 0 && st->stack[st->sp - 1].open == open) {
                st->sp--;
                if (st->stack[st->sp].contributes) {
                    if (st->depth > 0) st->depth--;
                    if (st->open_on_line > 0) st->open_on_line--;
                }
            }
            st->can_regex = false;
            i++;
            continue;
        }
        if (strchr(",;:=!&|?+-*%^~<>", c)) {
            st->can_regex = true;
            i++;
            continue;
        }
        if (indent_word_start(c)) {
            gsize j = i + 1;
            while (j < len && indent_word(s[j])) j++;
            st->can_regex = indent_regex_word(s + i, j - i);
            i = j;
            continue;
        }
        if (g_ascii_isdigit(c)) {
            i++;
            while (i < len && (indent_word(s[i]) || s[i] == '.')) i++;
            st->can_regex = false;
            continue;
        }
        if (c == ' ' || c == '\t' || c == '\r') {
            i++;
            continue;
        }
        st->can_regex = false;
        i++;
    }

    /* A backslash at the end of a line inside a string escapes the break, not
     * the first character of the next line. */
    st->escaped = false;
}

/* The indent a line gets, from the depth, its leading closers and the case
 * body it is in. */
static int indent_for(const char *s, gsize len, gsize first, IndentState *st)
{
    int  line = st->depth;
    int  sp = st->sp;
    gsize i = first;
    bool closer = false;

    /* A line that begins with closers aligns with the line that opened the
     * outermost of them. The last one is the outermost: `}}` belongs with the
     * outer block, and `});` with the line the call and the literal share. */
    while (i < len) {
        char open = indent_opener(s[i]);
        if (!open || sp <= 0 || st->stack[sp - 1].open != open)
            break;
        sp--;
        line = st->stack[sp].indent;
        closer = true;
        i++;
    }

    bool case_line = indent_case_line(s, len, first);

    /* A case body is one level deeper than the case; the closing brace of the
     * switch, which is shallower, is not. A nested switch adds its own level,
     * so the extras are summed. A block opened on the case line provides the
     * level itself, so its body gets no extra from that switch. A line that
     * closes something already carries the level of the line it closes. */
    if (!closer) {
        int base = line;
        for (int c = 0; c < st->case_count; c++) {
            const IndentCase *k = &st->cases[c];
            if (base < k->depth)
                continue;
            if (case_line && base == k->depth)
                continue;
            if (k->brace > 0 && base >= k->depth)
                continue;
            line++;
        }
    }

    /* A line that begins `name:` is left at the depth it is: in this codebase
     * it is an object's property far more often than a label, and outdenting
     * every property to make the rare label pretty is the wrong trade. */
    return line;
}

static gchar *indent_text(const char *text, gsize len, int width)
{
    GString   *out = g_string_sized_new(len + 64);
    IndentState st = { 0 };
    gsize       at = 0;

    st.can_regex = true;

    while (at < len) {
        gsize end = at;
        while (end < len && text[end] != '\n') end++;

        gsize line_len = end - at;
        bool  inside   = st.block_comment || st.quote != 0;
        gsize first    = 0;

        if (!inside)
            while (first < line_len &&
                   (text[at + first] == ' ' || text[at + first] == '\t'))
                first++;

        bool case_line = false;

        if (!inside && first < line_len)
            case_line = indent_case_line(text + at, line_len, first);

        int line = st.depth;

        if (inside) {
            g_string_append_len(out, text + at, line_len);
        } else if (first == line_len) {
            /* A blank line stays blank: no trailing spaces. */
        } else {
            line = indent_for(text + at, line_len, first, &st);
            for (int i = 0; i < line * width; i++)
                g_string_append_c(out, ' ');
            g_string_append_len(out, text + at + first, line_len - first);
        }

        st.line_indent = line;

        /* A line that starts with a regex, not with a division continuation. */
        if (!inside && indent_line_regex(text + at, line_len, first))
            st.can_regex = true;

        int before = st.depth;
        indent_scan(text + at, line_len, &st);

        /* Open a case body at the switch's depth; a case line is at that
         * depth, not one deeper. A block opened on the case line is remembered
         * so its own body is not indented twice. */
        if (case_line) {
            if (st.case_count == 0 ||
                st.cases[st.case_count - 1].depth != before) {
                if (st.case_count < (int)G_N_ELEMENTS(st.cases)) {
                    st.cases[st.case_count].depth = before;
                    st.cases[st.case_count].brace = 0;
                    st.case_count++;
                }
            }
            if (st.case_count > 0 &&
                st.cases[st.case_count - 1].depth == before)
                st.cases[st.case_count - 1].brace =
                    st.depth > before ? st.depth : 0;
        }

        /* The closing brace of a switch is shallower than its case body. */
        while (st.case_count > 0 &&
               st.depth < st.cases[st.case_count - 1].depth)
            st.case_count--;
        if (st.case_count > 0) {
            IndentCase *k = &st.cases[st.case_count - 1];
            if (k->brace > 0 && st.depth < k->brace)
                k->brace = 0;
        }

        if (end < len)
            g_string_append_c(out, '\n');
        at = end + 1;
    }

    return g_string_free(out, FALSE);
}

/* One line whose leading whitespace has to move, and the prefix it gets. */
typedef struct {
    int   line;
    int   old_indent;
    int   new_indent;
    gsize new_start;        /* the prefix's offset in the formatted text */
} IndentEdit;

/*
 * The lines in `[first, last]` whose leading whitespace differs between the
 * text and its formatted form. Both strings have the same line breaks, since
 * `indent_text` rewrites nothing else; the loop stops if they ever do not.
 */
static GArray *indent_edits(const char *text, const char *out, int first, int last)
{
    GArray     *edits = g_array_new(FALSE, FALSE, sizeof(IndentEdit));
    const char *a = text, *b = out;
    int         line = 0;

    for (;;) {
        const char *ae = strchr(a, '\n');
        const char *be = strchr(b, '\n');
        gsize       alen = ae ? (gsize)(ae - a) : strlen(a);
        gsize       blen = be ? (gsize)(be - b) : strlen(b);

        if (line >= first && line <= last) {
            gsize ai = 0, bi = 0;
            while (ai < alen && (a[ai] == ' ' || a[ai] == '\t')) ai++;
            while (bi < blen && (b[bi] == ' ' || b[bi] == '\t')) bi++;

            if (ai != bi || (ai > 0 && memcmp(a, b, ai) != 0)) {
                IndentEdit e;
                e.line       = line;
                e.old_indent = (int)ai;
                e.new_indent = (int)bi;
                e.new_start  = (gsize)(b - out);
                g_array_append_val(edits, e);
            }
        }

        if (!ae || !be)
            break;
        a = ae + 1;
        b = be + 1;
        line++;
    }

    return edits;
}

/* The length of a line's leading whitespace, by 0-based line number. */
static gsize indent_at_line(const char *text, int line)
{
    const char *p = text;

    for (int i = 0; i < line; i++) {
        p = strchr(p, '\n');
        if (!p)
            return 0;
        p++;
    }

    gsize n = 0;
    while (p[n] == ' ' || p[n] == '\t')
        n++;
    return n;
}

/* A column is kept relative to the line's content: inside the indentation it
 * stays inside the new one, at its edge it follows the content, and after it
 * the content moves with it. */
static int indent_map_column(int column, gsize old_indent, gsize new_indent)
{
    if (column < (int)old_indent)
        return MIN(column, (int)new_indent);
    return (int)((gsize)column - old_indent + new_indent);
}

static void indent_map_position(const char *text, const char *out,
                                int first, int last, int line, int column,
                                int *new_line, int *new_column)
{
    gsize old_indent = indent_at_line(text, line);
    gsize new_indent = (line >= first && line <= last)
                     ? indent_at_line(out, line) : old_indent;

    *new_line   = line;
    *new_column = indent_map_column(column, old_indent, new_indent);
}

/* An iter at a line and a column, both clamped the way `Select` clamps. */
static void indent_iter_at(GtkTextBuffer *buf, GtkTextIter *it,
                           int line, int column)
{
    int last = gtk_text_buffer_get_line_count(buf) - 1;
    gtk_text_buffer_get_iter_at_line(buf, it, CLAMP(line, 0, last));

    GtkTextIter eol = *it;
    if (!gtk_text_iter_ends_line(&eol))
        gtk_text_iter_forward_to_line_end(&eol);

    int max = gtk_text_iter_get_line_offset(&eol);
    gtk_text_iter_set_line_offset(it, CLAMP(column, 0, max));
}

/* Format([indent]) -- see the table below. */
static JSValue ed_format(JSContext *ctx, JSValueConst this_val,
                         int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);
    if (!w)
        return JS_EXCEPTION;

    GtkTextView *view = GTK_TEXT_VIEW(w->inner);
    if (!gtk_text_view_get_editable(view))
        return JS_ThrowPlainError(ctx, "Format: the editor is read-only");

    int width = 4;
    if (argc > 0 && !JS_IsUndefined(argv[0])) {
        if (!bta_to_int(ctx, argv[0], "Format", &width))
            return JS_EXCEPTION;
        if (width < 0 || width > 16)
            return JS_ThrowRangeError(ctx,
                "Format: indent %d is not 0 to 16 spaces", width);
    }

    GtkTextBuffer *buf = buffer_of(w);
    GtkTextIter    start, end;
    gtk_text_buffer_get_bounds(buf, &start, &end);

    /* `TRUE` is folded text too: formatting must see every line the buffer
     * holds, or the line numbers it edits would be the visible ones. */
    char *text = gtk_text_buffer_get_text(buf, &start, &end, TRUE);
    if (!text)
        return JS_EXCEPTION;

    gchar *out = indent_text(text, strlen(text), width);

    GtkTextIter insert, bound;
    gtk_text_buffer_get_iter_at_mark(buf, &insert, gtk_text_buffer_get_insert(buf));
    gtk_text_buffer_get_iter_at_mark(buf, &bound,
                                     gtk_text_buffer_get_selection_bound(buf));
    bool has_selection = !gtk_text_iter_equal(&insert, &bound);

    int first = 0, last = gtk_text_buffer_get_line_count(buf) - 1;
    if (has_selection) {
        GtkTextIter a, b;
        gtk_text_buffer_get_selection_bounds(buf, &a, &b);
        first = gtk_text_iter_get_line(&a);
        last  = gtk_text_iter_get_line(&b);

        /* A selection that ends at the start of a line does not mean that
         * line; selecting a whole line's text leaves the next one alone. */
        if (last > first && gtk_text_iter_get_line_offset(&b) == 0)
            last--;
    }

    int ins_line = gtk_text_iter_get_line(&insert);
    int ins_col  = gtk_text_iter_get_line_offset(&insert);
    int bnd_line = gtk_text_iter_get_line(&bound);
    int bnd_col  = gtk_text_iter_get_line_offset(&bound);

    GArray *edits   = indent_edits(text, out, first, last);
    bool    changed = edits->len > 0;

    if (changed) {
        g_object_set_data(G_OBJECT(buf), "bta-formatting", GINT_TO_POINTER(1));
        gtk_text_buffer_begin_user_action(buf);

        /* Bottom-up: a line index stays the one the caller meant while the
         * lines above it have not moved yet. */
        for (int i = (int)edits->len - 1; i >= 0; i--) {
            IndentEdit *e = &g_array_index(edits, IndentEdit, i);
            GtkTextIter a, b;

            gtk_text_buffer_get_iter_at_line(buf, &a, e->line);
            b = a;
            if (e->old_indent > 0)
                gtk_text_iter_forward_chars(&b, e->old_indent);
            if (!gtk_text_iter_equal(&a, &b))
                gtk_text_buffer_delete(buf, &a, &b);

            if (e->new_indent > 0) {
                gtk_text_buffer_get_iter_at_line(buf, &a, e->line);
                gtk_text_buffer_insert(buf, &a, out + e->new_start,
                                       e->new_indent);
            }
        }

        gtk_text_buffer_end_user_action(buf);
        g_object_set_data(G_OBJECT(buf), "bta-formatting", NULL);
    }

    if (changed) {
        int nins_line, nins_col, nbnd_line, nbnd_col;
        indent_map_position(text, out, first, last, ins_line, ins_col,
                            &nins_line, &nins_col);
        indent_map_position(text, out, first, last, bnd_line, bnd_col,
                            &nbnd_line, &nbnd_col);

        GtkTextIter pos, bound_pos;
        indent_iter_at(buf, &pos, nins_line, nins_col);
        indent_iter_at(buf, &bound_pos, nbnd_line, nbnd_col);
        if (has_selection)
            gtk_text_buffer_select_range(buf, &pos, &bound_pos);
        else
            gtk_text_buffer_place_cursor(buf, &pos);
    }

    g_array_free(edits, TRUE);
    g_free(text);
    g_free(out);

    if (changed)
        bta_emit(w, "Change", 0, NULL);

    return JS_UNDEFINED;
}

static const JSCFunctionListEntry editor_props[] = {
    /* Text
     *   everything in the buffer. Assigning replaces it all and **raises
     *   `Change`**
     */
    JS_CGETSET_DEF("Text",      ed_get_text,      ed_set_text),
    /* ScrollX
     *   how far it is scrolled, in pixels, and assignable — clamped to what
     *   there is to scroll. **Not** the cursor: `Line` and `GotoLine` are
     *   about that, with the scroll following as a side effect
     */
    JS_CGETSET_MAGIC_DEF("ScrollX",    bta_scroll_get, bta_scroll_set, BTA_SCROLL_X),
    /* ScrollY
     *   the same downwards, which is the one a diff view keeps in step
     */
    JS_CGETSET_MAGIC_DEF("ScrollY",    bta_scroll_get, bta_scroll_set, BTA_SCROLL_Y),
    /* ScrollMaxX
     *   the furthest `ScrollX` can go — the content's width less the part on
     *   screen, and `0` when it all fits
     */
    JS_CGETSET_MAGIC_DEF("ScrollMaxX", bta_scroll_get, NULL, BTA_SCROLL_MAX_X),
    /* ScrollMaxY
     *   the same for `ScrollY`, which is how a program tells a long file from
     *   one that fits
     */
    JS_CGETSET_MAGIC_DEF("ScrollMaxY", bta_scroll_get, NULL, BTA_SCROLL_MAX_Y),
    /* Line
     *   the line the cursor is on, **counting from 1**
     */
    JS_CGETSET_DEF("Line",      ed_get_line,      NULL),
    /* Column
     *   the cursor's column
     */
    JS_CGETSET_DEF("Column",    ed_get_column,    NULL),
    /* Offset
     *   the cursor's position as a **character** offset — the same unit
     *   `Column` counts in, so an emoji is one
     */
    JS_CGETSET_DEF("Offset",    ed_get_offset,    NULL),
    /* Selection
     *   the selected text, `""` for none
     */
    JS_CGETSET_DEF("Selection", ed_get_selection, NULL),
    /* Modified
     *   the editing flag. **Clear it after saving**: nothing else does, and
     *   it is what a window title's asterisk and a *save before closing?* are
     *   read from
     */
    JS_CGETSET_MAGIC_DEF("Modified", ed_get_flag, ed_set_flag, ED_MODIFIED),
    /* ReadOnly
     *   shown but not editable. **The program can still write to it**, which
     *   is what a log pane needs
     */
    JS_CGETSET_MAGIC_DEF("ReadOnly", ed_get_flag, ed_set_flag, ED_READONLY),
    /* Wrap
     *   wrap long lines. Default `true` on a
     *   [`TextEditor`](docs/reference/widgets/TextEditor.md), `false` on a
     *   [`SourceEditor`](docs/reference/widgets/SourceEditor.md), which is
     *   the right default for each
     */
    JS_CGETSET_MAGIC_DEF("Wrap",     ed_get_flag, ed_set_flag, ED_WRAP),
    /* CanUndo
     *   whether there is anything to go back to — what an *Undo* item's
     *   `Enabled` is read from
     */
    JS_CGETSET_MAGIC_DEF("CanUndo",  ed_get_flag, NULL,        ED_CANUNDO),
    /* CanRedo
     *   the same, forwards
     */
    JS_CGETSET_MAGIC_DEF("CanRedo",  ed_get_flag, NULL,        ED_CANREDO),
    /* GotoLine(line)
     *   puts the cursor there and scrolls to it
     */
    JS_CFUNC_DEF("GotoLine", 1, ed_goto_line),
    /* CursorBounds() -> { X, Y, Width, Height }
     *   where the insertion cursor is drawn, in the control's own coordinates
     *   — what `Popover.Show(content, editor, { Rect })` points at for a hint beside the
     *   cursor. Only once the control has been laid out; a cursor scrolled
     *   out of view answers a rectangle outside the control, which is the
     *   truth and the caller's to test. Read it once the control has a
     *   rectangle; before the window is up there is nothing to be drawn in
     */
    JS_CFUNC_DEF("CursorBounds", 0, ed_cursor_bounds),
    /* PositionAt(x, y) -> { Line, Column, Index }
     *   which character is under that point of the control, in the
     *   coordinates `MouseMove` reports — `null` when the point is not over
     *   text, so a pointer past the end of a line has no answer to give
     */
    JS_CFUNC_DEF("PositionAt", 2, ed_position_at),
    /* Select(line, [column], [length])
     *   selects from there. A column past the end of the line is the end of
     *   the line
     */
    JS_CFUNC_DEF("Select",   3, ed_select),
    /* LineOf(index)
     *   the line a **search's index** falls on, 1-based and clamped — `index`
     *   is the number `Regex.Index` gives, and it counts UTF-16 units
     */
    JS_CFUNC_DEF("LineOf",   1, ed_line_of),
    /* OffsetAt(line, [column])
     *   the character offset of that position, clamped as `Select` clamps —
     *   the inverse read of `Offset`
     */
    JS_CFUNC_DEF("OffsetAt", 2, ed_offset_at),
    /* Insert(text)
     *   at the cursor. The selection is left alone, so on a selected word
     *   this lands after it rather than replacing it
     */
    JS_CFUNC_DEF("Insert",   1, ed_insert),
    /* Append(text)
     *   at the end, **scrolling there**, whatever the cursor was doing —
     *   which is what a log pane wants and what makes a read-only editor the
     *   right control for one
     */
    JS_CFUNC_DEF("Append",   1, ed_append),
    /* Clear()
     *   empties it
     */
    JS_CFUNC_DEF("Clear",    0, ed_clear),
    /* Format([indent])
     *   re-indents the selected lines, or every line when nothing is selected,
     *   to the file's nesting depth — **leading whitespace only**: strings,
     *   comments, template literals and regular expressions are not braces,
     *   and a line it cannot attribute keeps its indentation. `indent` is
     *   spaces per level, 4 unless told (0 to 16). One undo step; no reflow
     *   and no wrapping. **O(n) and only when called**, so nothing is paid
     *   while typing
     */
    JS_CFUNC_DEF("Format",   1, ed_format),
    /* Undo()
     *   one step back
     */
    JS_CFUNC_DEF("Undo",     0, ed_undo),
    /* Redo()
     *   one step forward
     */
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
        /* Change()
         *   the value changed, including from an assignment in code — the
         *   round trip goes out to GTK and back
         */
        /* Cursor()
         *   the cursor moved. `Line` and `Column` say where
         */
        /* Scroll(x, y)
         *   it was scrolled — by the wheel, a scrollbar, the keyboard or an
         *   assignment. One event for a diagonal move. Two panes locked
         *   together is `Before_Scroll(x, y) { this.After.ScrollY = y; }`,
         *   and it does not loop: assigning a value it already has emits
         *   nothing
         */
        /* KeyPreview(key, ctrl, shift, alt)
         *   a key, **before the editor has acted on it**. `KeyPress` arrives
         *   after: the view has taken Tab, Enter, the arrows and every
         *   printable key by then, so it cannot turn Tab into a snippet or
         *   Enter into something that is not a newline. Answer `true` to take
         *   the key and the editor never sees it. `key` is a name like `Tab`,
         *   `Return` or `a`
         */
        BTA_CLASS("Editor", "Control", NULL, editor_props, false,
                  "Change,Cursor,Scroll,KeyPreview"),
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
