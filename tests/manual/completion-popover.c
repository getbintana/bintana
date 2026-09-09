/*
 * A GtkSourceView completion popover that works exactly once.
 *
 * Not a test and not part of the build. Kept because of what it turned out to
 * be: **the missing call is `gtk_source_init()`**, and nothing anywhere says so.
 *
 * Comment it out below and the popover appears once, is never dismissed --
 * minimising the window leaves it behind as a window of its own -- and every
 * attempt after the first fails. Put it back and it works. That is
 * https://gitlab.gnome.org/GNOME/gtksourceview/-/work_items/300, whose
 * conclusion is exactly this line.
 *
 *   cc -std=c11 -o /tmp/bta-plain tests/manual/completion-popover.c \
 *      $(pkg-config --cflags --libs gtk4 gtksourceview-5)
 *   /tmp/bta-plain
 *
 * Ctrl+End, then type "alf", three or four times.
 *
 * What makes the symptom so misleading: everything else about GtkSourceView
 * works without the init -- the view, the buffer, syntax highlighting, undo,
 * search. Only what is built from the library's GResource templates fails, and
 * the completion popover is the one thing that is. So it reads as a bug in the
 * completion provider, which is where a day went.
 *
 * Two views, because the first thing anyone asks is whether the scroller we wrap
 * a SourceEditor in matters. It does not -- without the init both break, with it
 * both work.
 *
 *   A  a GtkSourceView on its own
 *   B  a GtkSourceView inside a GtkScrolledWindow, as ours is
 *
 * Seen on gtk4 4.22.4, gtksourceview-5 5.20.0, glib 2.88.3, Fedora 44, X11/Xfce.
 * It does **not** reproduce under Xvfb with real keystrokes driven by xdotool
 * (three rounds, 19 change events, nothing) -- so a headless CI calls this
 * healthy, which is worth saying out loud in any report.
 */
#include <gtk/gtk.h>
#include <gtksourceview/gtksource.h>

static const char *SAMPLE =
    "const alfa = 1;\nconst alfombra = 2;\nconst beta = 3;\n\n";

static GtkWidget *make_view(bool in_scroller, GtkWidget **outer)
{
    GtkWidget     *view = gtk_source_view_new();
    GtkSourceView *sv   = GTK_SOURCE_VIEW(view);
    GtkTextBuffer *buf  = gtk_text_view_get_buffer(GTK_TEXT_VIEW(sv));

    gtk_source_view_set_show_line_numbers(sv, TRUE);
    gtk_text_buffer_set_text(buf, SAMPLE, -1);

    GtkSourceCompletionWords *words = gtk_source_completion_words_new("Words");
    gtk_source_completion_words_register(words, buf);
    gtk_source_completion_add_provider(gtk_source_view_get_completion(sv),
                                       GTK_SOURCE_COMPLETION_PROVIDER(words));
    g_object_unref(words);

    if (in_scroller) {
        GtkWidget *sw = gtk_scrolled_window_new();
        gtk_scrolled_window_set_child(GTK_SCROLLED_WINDOW(sw), view);
        gtk_widget_set_vexpand(sw, TRUE);
        *outer = sw;
    } else {
        gtk_widget_set_vexpand(view, TRUE);
        *outer = view;
    }
    return view;
}

static void on_activate(GtkApplication *app, gpointer unused)
{
    GtkWidget *win = gtk_application_window_new(app);
    gtk_window_set_title(GTK_WINDOW(win), "plain");
    gtk_window_set_default_size(GTK_WINDOW(win), 640, 460);

    GtkWidget *box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 6);
    GtkWidget *a_outer, *b_outer;
    GtkWidget *a = make_view(FALSE, &a_outer);
    make_view(TRUE, &b_outer);

    gtk_box_append(GTK_BOX(box), gtk_label_new("A - a view on its own"));
    gtk_box_append(GTK_BOX(box), a_outer);
    gtk_box_append(GTK_BOX(box), gtk_label_new("B - inside a GtkScrolledWindow"));
    gtk_box_append(GTK_BOX(box), b_outer);

    gtk_window_set_child(GTK_WINDOW(win), box);
    gtk_widget_grab_focus(a);
    gtk_window_present(GTK_WINDOW(win));
}

int main(int argc, char **argv)
{
    /* The line the whole thing was about. Comment it out to see the bug. */
    gtk_source_init();

    GtkApplication *app = gtk_application_new("org.bintana.plain",
                                              G_APPLICATION_DEFAULT_FLAGS);
    g_signal_connect(app, "activate", G_CALLBACK(on_activate), NULL);
    int rc = g_application_run(G_APPLICATION(app), argc, argv);
    g_object_unref(app);
    gtk_source_finalize();
    return rc;
}
