/*
 * What GTK itself delivers for a touch screen, with no Bintana in between:
 * every gesture GTK offers on one drawing area, and the raw touch events
 * under them.  It answers "is the hole in the toolkit or in the runtime".
 *
 *     gtkprobe        # lines on stdout: <ms since start> <what>
 *
 * The gestures are grouped, as an application that wants all of them would.
 */
#include <gtk/gtk.h>
#include <math.h>
#include <stdarg.h>
#include <stdio.h>

static gint64 t0;
static int updates;

static void say(const char *fmt, ...)
{
    va_list ap;
    printf("%6ld ", (long)((g_get_monotonic_time() - t0) / 1000));
    va_start(ap, fmt); vprintf(fmt, ap); va_end(ap);
    printf("\n"); fflush(stdout);
}

static void flush_updates(void)
{
    if (updates) say("raw TOUCH_UPDATE x%d", updates);
    updates = 0;
}

static const char *source_name(GdkDevice *d)
{
    if (!d) return "none";
    switch (gdk_device_get_source(d)) {
    case GDK_SOURCE_MOUSE:       return "mouse";
    case GDK_SOURCE_TOUCHSCREEN: return "touchscreen";
    case GDK_SOURCE_TOUCHPAD:    return "touchpad";
    case GDK_SOURCE_PEN:         return "pen";
    default:                     return "other";
    }
}

/* Scroll events too, whose unit and source tell a touchpad's two fingers from a wheel. */
static gboolean raw(GtkEventControllerLegacy *c, GdkEvent *e, gpointer data)
{
    GdkEventType t = gdk_event_get_event_type(e);
    const char *name = NULL;
    switch (t) {
    case GDK_TOUCH_BEGIN:  name = "TOUCH_BEGIN"; break;
    case GDK_TOUCH_END:    name = "TOUCH_END"; break;
    case GDK_TOUCH_CANCEL: name = "TOUCH_CANCEL"; break;
    case GDK_BUTTON_PRESS: name = "BUTTON_PRESS"; break;
    case GDK_BUTTON_RELEASE: name = "BUTTON_RELEASE"; break;
    case GDK_SCROLL: {
        double dx = 0, dy = 0;
        gdk_scroll_event_get_deltas(e, &dx, &dy);
        say("raw SCROLL src=%s unit=%d dir=%d dx=%.2f dy=%.2f", source_name(gdk_event_get_device(e)),
            gdk_scroll_event_get_unit(e), gdk_scroll_event_get_direction(e), dx, dy);
        return FALSE;
    }
    case GDK_TOUCH_UPDATE: updates++; return FALSE;
    case GDK_TOUCHPAD_PINCH:
    case GDK_TOUCHPAD_SWIPE:
    case GDK_TOUCHPAD_HOLD: {
        /* A touchpad's gestures are events of their own, not touches: the
         * server (XI 2.4) or the compositor recognises them. */
        static const char *phases[] = { "BEGIN", "UPDATE", "END", "CANCEL" };
        GdkTouchpadGesturePhase ph = gdk_touchpad_event_get_gesture_phase(e);
        double dx = 0, dy = 0;

        if (t != GDK_TOUCHPAD_HOLD)
            gdk_touchpad_event_get_deltas(e, &dx, &dy);
        if (t == GDK_TOUCHPAD_PINCH)
            say("touchpad PINCH %s fingers=%d scale=%.3f angle=%.1f dx=%.1f dy=%.1f",
                phases[ph], gdk_touchpad_event_get_n_fingers(e),
                gdk_touchpad_event_get_pinch_scale(e),
                gdk_touchpad_event_get_pinch_angle_delta(e) * 180.0 / G_PI, dx, dy);
        else
            say("touchpad %s %s fingers=%d dx=%.1f dy=%.1f",
                t == GDK_TOUCHPAD_SWIPE ? "SWIPE" : "HOLD", phases[ph],
                gdk_touchpad_event_get_n_fingers(e), dx, dy);
        return FALSE;
    }
    default: return FALSE;
    }
    flush_updates();
    say("raw %s src=%s emulating_pointer=%d", name,
        source_name(gdk_event_get_device(e)),
        (t == GDK_TOUCH_BEGIN || t == GDK_TOUCH_END || t == GDK_TOUCH_CANCEL)
            ? gdk_touch_event_get_emulating_pointer(e) : -1);
    return FALSE;
}

static void click_pressed(GtkGestureClick *g, int n, double x, double y, gpointer d)
{ say("click-press x=%.0f y=%.0f n=%d", x, y, n); }
static void click_released(GtkGestureClick *g, int n, double x, double y, gpointer d)
{ say("click-release x=%.0f y=%.0f", x, y); }
static void long_pressed(GtkGestureLongPress *g, double x, double y, gpointer d)
{ say("longpress x=%.0f y=%.0f", x, y); }
static void long_cancelled(GtkGestureLongPress *g, gpointer d)
{ say("longpress-cancelled"); }
static void swiped(GtkGestureSwipe *g, double vx, double vy, gpointer d)
{ say("swipe vx=%.0f vy=%.0f", vx, vy); }
static void zoomed(GtkGestureZoom *g, double scale, gpointer d)
{ say("zoom scale=%.3f", scale); }
static void rotated(GtkGestureRotate *g, double angle, double delta, gpointer d)
{ say("rotate angle=%.1f", angle * 180.0 / M_PI); }

static void drag_begin(GtkGestureDrag *g, double x, double y, gpointer tag)
{ say("%s-begin x=%.0f y=%.0f", (const char *)tag, x, y); }
static void drag_update(GtkGestureDrag *g, double dx, double dy, gpointer tag)
{ say("%s-update dx=%.0f dy=%.0f", (const char *)tag, dx, dy); }
static void drag_end(GtkGestureDrag *g, double dx, double dy, gpointer tag)
{ say("%s-end dx=%.0f dy=%.0f", (const char *)tag, dx, dy); }

static void resized(GtkDrawingArea *a, int w, int h, gpointer d)
{ say("size %d %d", w, h); }

static void draw(GtkDrawingArea *a, cairo_t *cr, int w, int h, gpointer d)
{
    cairo_set_source_rgb(cr, 0.2, 0.4, 0.8);
    cairo_paint(cr);
}

static void add_gesture(GtkWidget *w, GtkGesture *g, GtkGesture **leader)
{
    gtk_widget_add_controller(w, GTK_EVENT_CONTROLLER(g));
    if (*leader) gtk_gesture_group(*leader, g); else *leader = g;
}

static GtkGesture *drag(GtkWidget *w, int points, const char *tag, GtkGesture **leader)
{
    GtkGesture *g = g_object_new(GTK_TYPE_GESTURE_DRAG, "n-points", points, NULL);
    g_signal_connect(g, "drag-begin", G_CALLBACK(drag_begin), (gpointer)tag);
    g_signal_connect(g, "drag-update", G_CALLBACK(drag_update), (gpointer)tag);
    g_signal_connect(g, "drag-end", G_CALLBACK(drag_end), (gpointer)tag);
    add_gesture(w, g, leader);
    return g;
}

static void activate(GtkApplication *app, gpointer d)
{
    GtkWidget *win = gtk_application_window_new(app);
    GtkWidget *area = gtk_drawing_area_new();
    GtkGesture *leader = NULL, *g;

    gtk_window_set_title(GTK_WINDOW(win), "GTKProbe");
    gtk_window_set_default_size(GTK_WINDOW(win), 640, 480);
    gtk_widget_set_hexpand(area, TRUE);
    gtk_widget_set_vexpand(area, TRUE);
    gtk_drawing_area_set_draw_func(GTK_DRAWING_AREA(area), draw, NULL, NULL);
    g_signal_connect(area, "resize", G_CALLBACK(resized), NULL);
    gtk_window_set_child(GTK_WINDOW(win), area);

    g = gtk_gesture_click_new();
    g_signal_connect(g, "pressed", G_CALLBACK(click_pressed), NULL);
    g_signal_connect(g, "released", G_CALLBACK(click_released), NULL);
    add_gesture(area, g, &leader);

    g = gtk_gesture_long_press_new();
    g_signal_connect(g, "pressed", G_CALLBACK(long_pressed), NULL);
    g_signal_connect(g, "cancelled", G_CALLBACK(long_cancelled), NULL);
    add_gesture(area, g, &leader);

    g = gtk_gesture_swipe_new();
    g_signal_connect(g, "swipe", G_CALLBACK(swiped), NULL);
    add_gesture(area, g, &leader);

    g = gtk_gesture_zoom_new();
    g_signal_connect(g, "scale-changed", G_CALLBACK(zoomed), NULL);
    add_gesture(area, g, &leader);

    g = gtk_gesture_rotate_new();
    g_signal_connect(g, "angle-changed", G_CALLBACK(rotated), NULL);
    add_gesture(area, g, &leader);

    drag(area, 1, "drag1", &leader);
    drag(area, 2, "drag2", &leader);

    GtkEventController *legacy = gtk_event_controller_legacy_new();
    gtk_event_controller_set_propagation_phase(legacy, GTK_PHASE_CAPTURE);
    g_signal_connect(legacy, "event", G_CALLBACK(raw), NULL);
    gtk_widget_add_controller(area, legacy);

    gtk_window_present(GTK_WINDOW(win));
}

int main(int argc, char **argv)
{
    GtkApplication *app = gtk_application_new("ar.bintana.GtkProbe", G_APPLICATION_NON_UNIQUE);
    t0 = g_get_monotonic_time();
    g_signal_connect(app, "activate", G_CALLBACK(activate), NULL);
    int status = g_application_run(G_APPLICATION(app), argc, argv);
    g_object_unref(app);
    return status;
}
