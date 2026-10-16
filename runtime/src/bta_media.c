/*
 * Video and AudioPlayer, over GStreamer.
 *
 * One playbin3 per player. The Video widget shows its frames through the
 * gtk4paintablesink in a GtkPicture (the documented GTK4/Wayland practice --
 * GstVideoOverlay embedding is X11/GTK3 and does not belong here); an
 * AudioPlayer is the same pipeline with the video branch switched off and no
 * window, which is what an alarm cue or an audio-only RTSP stream wants.
 *
 * GtkVideo was refused for this on purpose: GtkMediaFile takes a GFile and
 * nothing else -- no RTSP URI, no digest credentials, no pipeline to tune --
 * so a camera asking for digest auth has nothing to say to it. Here the
 * credentials travel as User/Password properties, applied to the rtspsrc the
 * playbin builds via the source-setup signal (URI userinfo works too, and
 * loses: it puts the secret in the string every log prints).
 *
 * **One surface, two engines.** Everything a program can touch is written
 * once, below, against a BtaMedia; the pipeline is reached through the
 * engine_* layer, which has a GStreamer version and a version that refuses.
 * That is what keeps the two classes from being two implementations of the
 * same seventeen members -- and what keeps a runtime built without GStreamer
 * from breaking the *designer*: the properties still answer and a .form
 * carrying a Uri still loads, so only playing refuses, naming the package.
 * Optional at build time is the bta_sqlite.c bargain; failing to load a form
 * was never part of it.
 *
 * Only gstreamer-1.0 itself is needed to build: the sink is made by factory
 * name and a plain path becomes a URI with GLib, so neither the video nor the
 * pbutils headers are required.
 */
#include "bta.h"

#include <string.h>

#ifdef BTA_HAVE_GST
#include <gst/gst.h>
#endif

#define MEDIA_KEY "bta-media"

/* What a runtime with no engine says, in one place: the sqlite/libsoup
 * wording, and no distribution's package names -- which plugin is missing is
 * named where the engine can actually tell (engine_ensure). */
#define MEDIA_NO_GST                                                        \
    "this runtime was built without GStreamer, so there is no media to "    \
    "play. Install GStreamer's development package and build again -- "     \
    "CMake finds it with pkg-config and prints what it found"

static JSClassID audioplayer_class_id;
static JSClassID element_class_id;
static JSClassID pad_class_id;
static JSClassID bus_class_id;

static const char *const MEDIA_FIT[] = { "Fill", "Contain", "Cover", "ScaleDown" };
#ifdef BTA_HAVE_GST
/* Indexed by `GstState` itself: VOID_PENDING is 0 and NULL is 1, which is the
 * off-by-one that makes an array of the four names wrong. */
static const char *const MEDIA_STATES[] = {
    /* GST_STATE_VOID_PENDING */ "",
    /* GST_STATE_NULL         */ "Null",
    /* GST_STATE_READY        */ "Ready",
    /* GST_STATE_PAUSED       */ "Paused",
    /* GST_STATE_PLAYING      */ "Playing",
};
#endif

/* ------------------------------------------------------------------ state
 *
 * One BtaMedia per player. A Video's lives in its GtkPicture's qdata (freed
 * when GTK finalises the picture); an AudioPlayer's is the opaque of its JS
 * object (freed by the finalizer). Both are on media_live so cleanup finds
 * them -- a strong JSValue the collector cannot see must be freed on every
 * exit path, and the pipeline must be stopped before the context dies.
 */

typedef struct BtaMedia {
    bool        is_video;
    JSContext  *ctx;        /* NULL once torn down: touch no JS after */
    GtkWidget  *picture;    /* video only, borrowed: the qdata host */
    char       *declared;   /* Uri as assigned, for the getter */
    char       *uri;        /* effective URI handed to the playbin */
    char       *user;       /* RTSP digest identity; NULL for none */
    char       *pass;       /* never read back (see the getter) */
    GMutex      creds;      /* user/pass: written here, read on GStreamer's thread */
    int         latency;    /* rtspsrc jitterbuffer, ms */
    int         buffering;  /* how full the buffer is, 0..100 (see the getter) */
    double      volume;     /* 0..1 */
    bool        muted;
    bool        loop;
    bool        wants;      /* Play was asked for and has not ended: see Playing */
    bool        at_end;     /* EOS seen: Play seeks back before resuming */
    bool        live;       /* the pipeline said NO_PREROLL: do not buffer-pause */
    bool        dead;       /* torn down: the bus callback must not touch */
    JSValue     self;       /* audio only: the keepalive a playing cue holds */
    JSValue     on_ended;   /* audio only, duplicated */
    JSValue     on_error;   /* audio only, duplicated */
#ifdef BTA_HAVE_GST
    GstElement *playbin;    /* NULL until first use (see engine_ensure) */
    gulong      bus_watch;  /* 0 when unwatched */
#endif
} BtaMedia;

static GList *media_live;

/* ----------------------------------------------------------------- engine
 *
 * The whole of what a pipeline is asked to do, in ten functions. The second
 * version of this block, at the bottom of the file, is what a build without
 * GStreamer gets: the verbs refuse and the questions answer nothing.
 */
static bool   engine_start(JSContext *ctx, BtaMedia *m);
static void   engine_hold(BtaMedia *m);      /* PAUSED, keeping the frame */
static void   engine_park(BtaMedia *m);      /* NULL, forgetting the position */
static bool   engine_seek(JSContext *ctx, BtaMedia *m, double seconds);
static void   engine_uri(BtaMedia *m);       /* push m->uri at the pipeline */
static void   engine_levels(BtaMedia *m);    /* push Volume/Muted at it */
static double engine_position(BtaMedia *m);
static double engine_duration(BtaMedia *m);
static bool   engine_seekable(BtaMedia *m);
static void   engine_teardown(BtaMedia *m);

/* ----------------------------------------------- elements, pads and buses
 *
 * The four verbs of `Media`: an `Element` is one GStreamer element with a
 * reference held, a `Pad` one of its pads, a `Bus` a pipeline's bus with
 * handlers on it. What a wrapper holds is a *reference* and nothing else --
 * two JS objects may point at one element, and dropping them all drops it.
 *
 * Every verb is implemented twice, once against GStreamer and once as the
 * `MEDIA_NO_GST` refusal, the way `engine_*` is; what is shared here is the
 * bookkeeping. `State` answers what was *asked* (never a query, the
 * `Video.Playing` rule), a pipeline asked Playing holds the players'
 * keepalive (`wants`), and a signal delivery on its way is a third thing the
 * console loop is owed.
 */

typedef struct BtaElem BtaElem;

/*
 * One subscription. **The marshal runs on GStreamer's thread**, so it never
 * touches a JSValue: it takes a reference on the subscription, copies the
 * signal's arguments into C, and queues an idle for the main loop, where the
 * handler is read and called. `refs` counts the table's own reference plus
 * one per delivery on its way; the count and the calls list are under
 * `media_sig_mutex`, because that is the one place two threads meet.
 */
typedef struct ElemSub {
    BtaElem *elem;      /* borrowed; NULL once detached -- a delivery whose
                         * subscription has no element anymore is dropped */
    gchar   *name;      /* the signal's name, owned (the table's key too) */
    gulong   id;        /* the connected handler, 0 when disconnected */
    int      refs;
    JSValue  handler;   /* the current handler, owned */
} ElemSub;

struct BtaElem {
    bool        dead;       /* torn down: a verb may not touch it */
    JSContext  *ctx;        /* NULL once torn down: touch no JS after */
    int         state;      /* index into MEDIA_STATES: what was asked */
    bool        asked;      /* a state outside Null was asked (teardown) */
    bool        hold_play;  /* Playing asked and no EOS/error answered yet */
    bool        hold_subs;  /* a signal is subscribed (On), see below */
    JSValue     self;       /* the keepalive (see media_hold_self) */
    GHashTable *signals;    /* name -> ElemSub, made by On */
#ifdef BTA_HAVE_GST
    GstElement *element;    /* one reference; NULL when none was made */
#endif
};

typedef struct BtaPad {
    bool        dead;
    JSContext  *ctx;
#ifdef BTA_HAVE_GST
    GstPad     *pad;        /* one reference */
#endif
} BtaPad;

typedef struct BtaBus {
    bool        dead;
    JSContext  *ctx;
    /* The keepalive is not a nicety here: `pipe.Bus.On(…)`'s Bus belongs to
     * nobody's local, so without it the object would be collected -- taking
     * its watch and its handlers with it -- on the first idle after the
     * call, and with it held, a handler that drops the last reference to the
     * bus cannot free the struct under the dispatch that is running. */
    JSValue     self;
    JSValue     handlers[8];    /* MEDIA_BUS_TYPES order; UNDEFINED for none */
#ifdef BTA_HAVE_GST
    GstBus     *bus;            /* one reference */
#endif
} BtaBus;

static const char *const MEDIA_BUS_TYPES[] = {
    "error", "warning", "info", "eos", "buffering", "state-changed",
    "clock-lost", "async-done"
};

static GList *elements_live;
static GList *buses_live;
static GList *media_calls;      /* deliveries on their way (ElemCall) */
static GMutex media_sig_mutex;
#ifdef BTA_HAVE_GST
static GThread *media_main_thread;   /* who bta_media_init ran on */
#endif

/* The per-half half: what a build without GStreamer compiles as refusals, or
 * as the empty engine it is. Teardowns do engine work only -- a JSValue is
 * freed where its context is known. */
static void elem_teardown(BtaElem *e);
static void pad_teardown(BtaPad *p);
static void bus_teardown(BtaBus *b);
static void media_calls_cleanup(void);

static JSValue media_element(JSContext *ctx, JSValueConst this_val, int argc,
                             JSValueConst *argv);
static JSValue elem_add(JSContext *ctx, JSValueConst this_val, int argc,
                        JSValueConst *argv);
static JSValue elem_link(JSContext *ctx, JSValueConst this_val, int argc,
                         JSValueConst *argv);
static JSValue elem_pad(JSContext *ctx, JSValueConst this_val, int argc,
                        JSValueConst *argv);
static JSValue elem_set(JSContext *ctx, JSValueConst this_val, int argc,
                        JSValueConst *argv);
static JSValue elem_get(JSContext *ctx, JSValueConst this_val, int argc,
                        JSValueConst *argv);
static JSValue elem_eos(JSContext *ctx, JSValueConst this_val, int argc,
                        JSValueConst *argv);
static JSValue elem_on(JSContext *ctx, JSValueConst this_val, int argc,
                       JSValueConst *argv);
static JSValue elem_get_bus(JSContext *ctx, JSValueConst this_val);
static JSValue elem_get_state(JSContext *ctx, JSValueConst this_val);
static JSValue elem_set_state(JSContext *ctx, JSValueConst this_val,
                              JSValueConst val);
static JSValue pad_get_name(JSContext *ctx, JSValueConst this_val);
static JSValue pad_get_caps(JSContext *ctx, JSValueConst this_val);
static JSValue pad_link(JSContext *ctx, JSValueConst this_val, int argc,
                        JSValueConst *argv);
static JSValue bus_on(JSContext *ctx, JSValueConst this_val, int argc,
                      JSValueConst *argv);

#ifdef BTA_HAVE_GST
static BtaElem *elem_this(JSContext *ctx, JSValueConst this_val)
{
    BtaElem *e = JS_GetOpaque(this_val, element_class_id);

    if (!e) {
        JS_ThrowTypeError(ctx, "not an Element");
        return NULL;
    }
    if (e->dead) {
        JS_ThrowPlainError(ctx, "Element: torn down");
        return NULL;
    }
    return e;
}

static BtaPad *pad_this(JSContext *ctx, JSValueConst this_val)
{
    BtaPad *p = JS_GetOpaque(this_val, pad_class_id);

    if (!p) {
        JS_ThrowTypeError(ctx, "not a Pad");
        return NULL;
    }
    if (p->dead) {
        JS_ThrowPlainError(ctx, "Pad: torn down");
        return NULL;
    }
    return p;
}

static BtaBus *bus_this(JSContext *ctx, JSValueConst this_val)
{
    BtaBus *b = JS_GetOpaque(this_val, bus_class_id);

    if (!b) {
        JS_ThrowTypeError(ctx, "not a Bus");
        return NULL;
    }
    if (b->dead) {
        JS_ThrowPlainError(ctx, "Bus: torn down");
        return NULL;
    }
    return b;
}

/* The players' keepalive, for the same two reasons: a pipeline asked Playing
 * keeps a *console* program alive, and a handler that drops the last
 * reference can no longer free the struct under the dispatch that is
 * running. Invisible to the collector on purpose (see media_hold_self).
 *
 * **A subscription is the second claim on that life**, and it was paid for:
 * a `decodebin` kept in a local variable is collected the moment the function
 * that built the graph returns -- taking its `pad-added` subscription with it
 * -- and the pad it was going to announce is then never linked. `On` holds
 * the wrapper until the last signal is unsubscribed. */
static void elem_hold_self(JSContext *ctx, BtaElem *e, JSValueConst this_val)
{
    if (JS_IsUndefined(e->self))
        e->self = JS_DupValue(ctx, this_val);
}

/* Both claims, counted in one place. Whatever this releases may be the last
 * reference to the object, which finalises the wrapper and frees `e`: the
 * caller must not touch it afterwards. */
static void elem_release_if_idle(BtaElem *e)
{
    JSValue self;

    if (e->hold_play || e->hold_subs)
        return;
    self = e->self;
    if (JS_IsUndefined(self))
        return;
    e->self = JS_UNDEFINED;
    JS_FreeValue(e->ctx, self);
}
#endif /* BTA_HAVE_GST */

static void elem_sub_unref(ElemSub *sub)
{
    g_mutex_lock(&media_sig_mutex);
    if (--sub->refs > 0) {
        g_mutex_unlock(&media_sig_mutex);
        return;
    }
    g_mutex_unlock(&media_sig_mutex);
    g_free(sub->name);
    g_free(sub);
}

/* Detach every subscription and let the table go. **No JSValue is freed
 * here**: both callers free the handlers where their context is known --
 * with the runtime during finalisation (`JS_FreeValueRT`), with the context
 * during console cleanup -- and both do it before this runs, so a delivery
 * still on its way finds its subscriptions with `elem` cleared and nothing
 * to call. */
static void elem_signals_destroy(BtaElem *e)
{
    GHashTableIter it;
    gpointer       key;
    gpointer       val;

    if (!e->signals)
        return;
    g_hash_table_iter_init(&it, e->signals);
    while (g_hash_table_iter_next(&it, &key, &val)) {
        ElemSub *sub = val;

#ifdef BTA_HAVE_GST
        if (sub->id && e->element)
            g_signal_handler_disconnect(e->element, sub->id);
#endif
        sub->id   = 0;
        sub->elem = NULL;
        g_hash_table_iter_remove(&it);
        elem_sub_unref(sub);   /* the table's own reference */
    }
    g_hash_table_destroy(e->signals);
    e->signals = NULL;
}

/* ------------------------------------------------------------------ shared
 *
 * The tables are the published surface. Both classes point at the same
 * functions -- the resolver below answers for either -- so there is one
 * implementation of Uri, Volume, Seek and the rest, not two that drift.
 * tests/api/Check.js reads these tables out of the file text.
 */

static JSValue media_get_uri(JSContext *ctx, JSValueConst this_val);
static JSValue media_set_uri(JSContext *ctx, JSValueConst this_val, JSValueConst val);
static JSValue media_get_user(JSContext *ctx, JSValueConst this_val);
static JSValue media_set_user(JSContext *ctx, JSValueConst this_val, JSValueConst val);
static JSValue media_get_password(JSContext *ctx, JSValueConst this_val);
static JSValue media_set_password(JSContext *ctx, JSValueConst this_val, JSValueConst val);
static JSValue media_get_latency(JSContext *ctx, JSValueConst this_val);
static JSValue media_set_latency(JSContext *ctx, JSValueConst this_val, JSValueConst val);
static JSValue media_get_volume(JSContext *ctx, JSValueConst this_val);
static JSValue media_set_volume(JSContext *ctx, JSValueConst this_val, JSValueConst val);
static JSValue media_get_muted(JSContext *ctx, JSValueConst this_val);
static JSValue media_set_muted(JSContext *ctx, JSValueConst this_val, JSValueConst val);
static JSValue media_get_loop(JSContext *ctx, JSValueConst this_val);
static JSValue media_set_loop(JSContext *ctx, JSValueConst this_val, JSValueConst val);
static JSValue media_get_buffering(JSContext *ctx, JSValueConst this_val);
static JSValue media_get_position(JSContext *ctx, JSValueConst this_val);
static JSValue media_get_duration(JSContext *ctx, JSValueConst this_val);
static JSValue media_get_playing(JSContext *ctx, JSValueConst this_val);
static JSValue media_get_seekable(JSContext *ctx, JSValueConst this_val);
static JSValue media_play(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
static JSValue media_pause(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
static JSValue media_stop(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
static JSValue media_seek(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);

/* The five that need the widget rather than the player. */
static JSValue video_get_fit(JSContext *ctx, JSValueConst this_val);
static JSValue video_set_fit(JSContext *ctx, JSValueConst this_val, JSValueConst val);
static JSValue media_get_available(JSContext *ctx, JSValueConst this_val);
static JSValue video_get_source_width(JSContext *ctx, JSValueConst this_val);
static JSValue video_get_source_height(JSContext *ctx, JSValueConst this_val);
static JSValue video_save(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);

static const JSCFunctionListEntry video_props[] = {
    /* Uri
     *   what to play: a URI (`file://`, `http(s)://`, `rtsp://`) **or a plain
     *   local path**, which is turned into one. One property for both, so
     *   there is nothing to disagree. Setting it stops whatever was playing
     */
    JS_CGETSET_DEF("Uri",          media_get_uri,      media_set_uri),
    /* User
     *   RTSP digest identity, applied to the source the playbin builds. `""`
     *   for none
     */
    JS_CGETSET_DEF("User",         media_get_user,     media_set_user),
    /* Password
     *   the secret beside it. **Write-only**: it reads back `""` and is never
     *   serialised, so no `.form` carries it in clear text
     */
    JS_CGETSET_DEF("Password",     media_get_password, media_set_password),
    /* Latency
     *   ms the RTSP jitterbuffer may hold. Default `2000`, the source's own.
     *   Read when the source is built, so a change lands on the next `Play`
     *   from a stopped player
     */
    JS_CGETSET_DEF("Latency",      media_get_latency,  media_set_latency),
    /* Volume
     *   `0`…`1`. Default `1`
     */
    JS_CGETSET_DEF("Volume",       media_get_volume,   media_set_volume),
    /* Muted
     *   silence without touching `Volume`, so unmuting comes back to where it
     *   was
     */
    JS_CGETSET_DEF("Muted",        media_get_muted,    media_set_muted),
    /* Loop
     *   reseek instead of ending. A live stream cannot seek, so it ends
     *   anyway
     */
    JS_CGETSET_DEF("Loop",         media_get_loop,     media_set_loop),
    /* Fit
     *   `Fill` `Contain` `Cover` `ScaleDown`, as a
     *   [`Picture`](docs/reference/widgets/Picture.md)'s. Default `"Contain"`
     */
    JS_CGETSET_DEF("Fit",          video_get_fit,      video_set_fit),
    /* Available
     *   whether **this machine** could play a clip: GStreamer's base plugins
     *   **and** the `gtk4paintablesink` element that puts frames in a
     *   `GtkPicture`. `Widget.Available("Video")` is the same answer asked of
     *   the class, and it is the one a palette asks before offering the
     *   control. `false` also on a runtime built without GStreamer
     */
    JS_CGETSET_DEF("Available",    media_get_available, NULL),
    /* Buffering
     *   how full the buffer is, `0`…`100`. `100` is nothing to wait for — a
     *   local file never says otherwise — and less is a stream refilling,
     *   which **holds the picture while `Playing` stays true**. It is
     *   [`ProgressBar.Value`](docs/reference/widgets/ProgressBar.md)'s range,
     *   since that is where a form puts it
     */
    JS_CGETSET_DEF("Buffering",    media_get_buffering, NULL),
    /* Position
     *   seconds in, `0` when unknown — which includes playing live
     */
    JS_CGETSET_DEF("Position",     media_get_position, NULL),
    /* Duration
     *   seconds long, `-1` while unknown — which is always, on a live stream
     */
    JS_CGETSET_DEF("Duration",     media_get_duration, NULL),
    /* Playing
     *   whether it is going — what `Play` asked for, until `Pause`, `Stop`,
     *   the end or an error. **Not a sample of the pipeline**, which reads as
     *   stopped mid-loop and mid-rebuffer
     */
    JS_CGETSET_DEF("Playing",      media_get_playing,  NULL),
    /* Seekable
     *   whether `Seek` has anything to work on. Answered once the stream is
     *   known, not with the first frame
     */
    JS_CGETSET_DEF("Seekable",     media_get_seekable, NULL),
    /* SourceWidth
     *   the clip's own width, `0` until a frame has been decoded —
     *   `Picture`'s spelling
     */
    JS_CGETSET_DEF("SourceWidth",  video_get_source_width,  NULL),
    /* SourceHeight
     *   the clip's own height
     */
    JS_CGETSET_DEF("SourceHeight", video_get_source_height, NULL),
    /* Play()
     *   plays, and replays from the top after `Ended`. **Refused with no
     *   `Uri`**
     */
    JS_CFUNC_DEF("Play",  0, media_play),
    /* Pause()
     *   holds the frame and the position
     */
    JS_CFUNC_DEF("Pause", 0, media_pause),
    /* Stop()
     *   parks it: back to no state, the position forgotten
     */
    JS_CFUNC_DEF("Stop",  0, media_stop),
    /* Seek(seconds)
     *   jumps there. **Refused on a stream that cannot seek**, naming it
     */
    JS_CFUNC_DEF("Seek",  1, media_seek),
    /* Save(path)
     *   the frame on screen as a PNG —
     *   [`DrawingArea.Save`](docs/reference/widgets/DrawingArea.md)'s
     *   spelling. **Refused before anything has been decoded**
     */
    JS_CFUNC_DEF("Save",  1, video_save),
};

static JSValue audio_get_onended(JSContext *ctx, JSValueConst this_val);
static JSValue audio_set_onended(JSContext *ctx, JSValueConst this_val, JSValueConst val);
static JSValue audio_get_onerror(JSContext *ctx, JSValueConst this_val);
static JSValue audio_set_onerror(JSContext *ctx, JSValueConst this_val, JSValueConst val);

/* type AudioPlayer */
static const JSCFunctionListEntry audioplayer_props[] = {
    /* Uri
     *   what to play: a URI (`file://`, `http(s)://`, `rtsp://`) **or a plain
     *   local path**, which is turned into one. One property for both, so
     *   there is nothing to disagree. Setting it stops whatever was playing
     */
    JS_CGETSET_DEF("Uri",      media_get_uri,      media_set_uri),
    /* User
     *   RTSP digest identity, applied to the source the playbin builds. `""`
     *   for none
     */
    JS_CGETSET_DEF("User",     media_get_user,     media_set_user),
    /* Password
     *   the secret beside it. **Write-only**: it reads back `""` and is never
     *   serialised, so no `.form` carries it in clear text
     */
    JS_CGETSET_DEF("Password", media_get_password, media_set_password),
    /* Latency
     *   ms the RTSP jitterbuffer may hold. Default `2000`, the source's own.
     *   Read when the source is built, so a change lands on the next `Play`
     *   from a stopped player
     */
    JS_CGETSET_DEF("Latency",  media_get_latency,  media_set_latency),
    /* Volume
     *   `0`…`1`. Default `1`
     */
    JS_CGETSET_DEF("Volume",   media_get_volume,   media_set_volume),
    /* Muted
     *   silence without touching `Volume`, so unmuting comes back to where it
     *   was
     */
    JS_CGETSET_DEF("Muted",    media_get_muted,    media_set_muted),
    /* Loop
     *   reseek instead of ending. A live stream cannot seek, so it ends
     *   anyway
     */
    JS_CGETSET_DEF("Loop",     media_get_loop,     media_set_loop),
    /* Buffering
     *   how full the buffer is, `0`…`100`. `100` is nothing to wait for — a
     *   local file never says otherwise — and less is a stream refilling,
     *   which **holds the sound while `Playing` stays true**. It is
     *   [`ProgressBar.Value`](docs/reference/widgets/ProgressBar.md)'s range,
     *   since that is where a form puts it
     */
    JS_CGETSET_DEF("Buffering", media_get_buffering, NULL),
    /* Position
     *   seconds in, `0` when unknown — which includes playing live
     */
    JS_CGETSET_DEF("Position", media_get_position, NULL),
    /* Duration
     *   seconds long, `-1` while unknown — which is always, on a live stream
     */
    JS_CGETSET_DEF("Duration", media_get_duration, NULL),
    /* Playing
     *   whether it is going — what `Play` asked for, until `Pause`, `Stop`,
     *   the end or an error. **Not a sample of the pipeline**, which reads as
     *   stopped mid-loop and mid-rebuffer
     */
    JS_CGETSET_DEF("Playing",  media_get_playing,  NULL),
    /* Seekable
     *   whether `Seek` has anything to work on. Answered once the stream is
     *   known, not when playing starts
     */
    JS_CGETSET_DEF("Seekable", media_get_seekable, NULL),
    /* OnEnded
     *   assign `() => …`, called when it plays to the end; `null` takes it
     *   off. **Anything else is refused where it is assigned**, rather than
     *   silently never called
     */
    JS_CGETSET_DEF("OnEnded",  audio_get_onended,  audio_set_onended),
    /* OnError
     *   assign `(message, kind) => …`; the same rule. `kind` is `NotFound`,
     *   `NotAuthorized`, `Unreachable`, `Decode` or `Error`, as a `Video`'s is
     */
    JS_CGETSET_DEF("OnError",  audio_get_onerror,  audio_set_onerror),
    /* Play()
     *   plays, and replays from the top after it ended. **Refused with no
     *   `Uri`**
     */
    JS_CFUNC_DEF("Play",  0, media_play),
    /* Pause()
     *   holds the position
     */
    JS_CFUNC_DEF("Pause", 0, media_pause),
    /* Stop()
     *   parks it: back to no state, the position forgotten
     */
    JS_CFUNC_DEF("Stop",  0, media_stop),
    /* Seek(seconds)
     *   jumps there. **Refused on a stream that cannot seek**, naming it
     */
    JS_CFUNC_DEF("Seek",  1, media_seek),
};

/* ------------------------------------------------------------- lifetime */

static BtaMedia *media_new(JSContext *ctx, bool is_video)
{
    BtaMedia *m = g_new0(BtaMedia, 1);

    m->ctx      = ctx;
    m->is_video = is_video;
    m->latency   = 2000;     /* rtspsrc's own default */
    m->buffering = 100;      /* nothing to wait for until a stream says so */
    m->volume    = 1.0;
    m->self     = JS_UNDEFINED;
    m->on_ended = JS_UNDEFINED;
    m->on_error = JS_UNDEFINED;
    g_mutex_init(&m->creds);
    media_live  = g_list_prepend(media_live, m);
    return m;
}

static void media_teardown(BtaMedia *m)
{
    if (!m || m->dead)
        return;
    m->dead  = true;
    m->wants = false;
    media_live = g_list_remove(media_live, m);
    engine_teardown(m);
    m->ctx = NULL;
    /* The keepalive is deliberately *not* released here: cleanup runs while
     * the context is still alive, and dropping the last reference to a JS
     * object from inside a walk over media_live would finalise the struct
     * the walk is holding. JS_FreeContext reclaims it a moment later. */
}

static void media_free(BtaMedia *m)
{
    if (!m)
        return;
    g_mutex_clear(&m->creds);
    g_free(m->declared);
    g_free(m->uri);
    g_free(m->user);
    g_free(m->pass);
    g_free(m);
}

/* The qdata destroy: no JS here -- GTK finalises on its own time, possibly
 * while the context is already gone. teardown stops the engine; the struct
 * (which holds no JSValue for a Video) is simply freed. */
static void media_qdata_free(gpointer data)
{
    BtaMedia *m = data;

    media_teardown(m);
    media_free(m);
}

/*
 * A playing AudioPlayer holds a reference to its own JS object.
 *
 * Without it a cue is a local variable, and the whole point of a cue is that
 * nobody keeps it: `function ding() { const a = new AudioPlayer(); ...
 * a.Play(); }` returned, the refcount hit zero, the finalizer stopped the
 * pipeline, and *nothing was heard* -- while the documentation said a player
 * left playing keeps the program alive. It also closed the one way a handler
 * could crash the runtime: with the object alive for the length of the emit,
 * an OnEnded that drops the last reference can no longer free the struct
 * under the callback that is emitting.
 *
 * Invisible to the collector on purpose (nothing in gc_mark): it is the
 * pipeline's claim on the object, not a reference the object owns, and a
 * cycle detector that could see it would collect exactly what it protects.
 */
static void media_hold_self(JSContext *ctx, BtaMedia *m, JSValueConst this_val)
{
    if (m->is_video || !JS_IsUndefined(m->self))
        return;
    m->self = JS_DupValue(ctx, this_val);
}

/* Whatever this releases may be the last reference, so the caller must not
 * touch m afterwards. From a JS method that is free -- the caller's own
 * reference is on the stack -- and from the bus it is the last line. */
static void media_drop_self(BtaMedia *m)
{
    JSValue self = m->self;

    if (JS_IsUndefined(self))
        return;
    m->self = JS_UNDEFINED;
    JS_FreeValue(m->ctx, self);
}

/* --------------------------------------------------------------- resolver */

static const char *media_who(BtaMedia *m)
{
    return m->is_video ? "Video" : "AudioPlayer";
}

/* Either class, one accessor family: an AudioPlayer answers from its opaque,
 * a Video from the qdata of the GtkPicture the widget wraps. */
static BtaMedia *media_this(JSContext *ctx, JSValueConst this_val)
{
    BtaMedia *m = JS_GetOpaque(this_val, audioplayer_class_id);

    if (!m) {
        BtaWidget *w = bta_this(ctx, this_val);

        if (!w)
            return NULL;
        m = g_object_get_data(G_OBJECT(w->gtk), MEDIA_KEY);
        if (!m) {
            JS_ThrowPlainError(ctx, "Video: no player behind this control");
            return NULL;
        }
    }
    if (m->dead) {
        JS_ThrowPlainError(ctx, "%s: torn down", media_who(m));
        return NULL;
    }
    return m;
}

/* A URI or a plain path: playbin wants the former, a person writes the
 * latter, so one property takes both rather than two properties sharing one
 * pipeline (the Caption trap: two names for one thing end up disagreeing).
 * GLib and not gst_filename_to_uri, which is the same walk (canonicalise
 * against the working directory, then convert) and would tie a plain string
 * to the engine being there. */
static char *media_effective_uri(JSContext *ctx, const char *s)
{
    if (strstr(s, "://"))
        return g_strdup(s);

    char   *abs = g_canonicalize_filename(s, NULL);
    GError *err = NULL;
    char   *uri = g_filename_to_uri(abs, NULL, &err);

    g_free(abs);
    if (!uri) {
        JS_ThrowTypeError(ctx, "Uri: '%s' is neither a URI nor a local path (%s)",
                          s, err ? bta_gerror_text(err) : "and cannot be turned into one");
        g_clear_error(&err);
        return NULL;
    }
    return uri;
}

/* ------------------------------------------------------------ properties */

static JSValue media_get_uri(JSContext *ctx, JSValueConst this_val)
{
    BtaMedia *m = media_this(ctx, this_val);

    if (!m)
        return JS_EXCEPTION;
    return JS_NewString(ctx, m->declared ? m->declared : "");
}

static JSValue media_set_uri(JSContext *ctx, JSValueConst this_val, JSValueConst val)
{
    BtaMedia   *m = media_this(ctx, this_val);
    const char *s;
    char       *eff = NULL;

    if (!m)
        return JS_EXCEPTION;
    s = JS_ToCString(ctx, val);
    if (!s)
        return JS_EXCEPTION;
    if (*s && !(eff = media_effective_uri(ctx, s))) {
        JS_FreeCString(ctx, s);
        return JS_EXCEPTION;
    }

    /* Setting Uri stops whatever was playing: a pipeline keeps no queue. */
    engine_park(m);
    m->wants     = false;
    m->at_end    = false;
    m->buffering = 100;
    g_free(m->declared);
    g_free(m->uri);
    m->declared = g_strdup(s);
    m->uri      = eff;   /* NULL when cleared */
    JS_FreeCString(ctx, s);
    engine_uri(m);
    media_drop_self(m);
    return JS_UNDEFINED;
}

static JSValue media_get_user(JSContext *ctx, JSValueConst this_val)
{
    BtaMedia *m = media_this(ctx, this_val);

    if (!m)
        return JS_EXCEPTION;
    return JS_NewString(ctx, m->user ? m->user : "");
}

/* The lock is not ceremony: source-setup runs on whatever thread the playbin
 * built its source on, and a setter freeing the old string there is a free
 * under a reader. */
static JSValue media_set_user(JSContext *ctx, JSValueConst this_val, JSValueConst val)
{
    BtaMedia   *m = media_this(ctx, this_val);
    const char *s;

    if (!m)
        return JS_EXCEPTION;
    s = JS_ToCString(ctx, val);
    if (!s)
        return JS_EXCEPTION;
    g_mutex_lock(&m->creds);
    g_free(m->user);
    m->user = *s ? g_strdup(s) : NULL;
    g_mutex_unlock(&m->creds);
    JS_FreeCString(ctx, s);
    return JS_UNDEFINED;
}

/* Write-only on purpose: a password that read back would be serialised into
 * the .form in clear text on the next save. The setter keeps it for the next
 * source-setup; the getter answers nothing, which is also what the
 * serialiser compares a fresh control against, so it is never written. */
static JSValue media_get_password(JSContext *ctx, JSValueConst this_val)
{
    BtaMedia *m = media_this(ctx, this_val);

    if (!m)
        return JS_EXCEPTION;
    return JS_NewString(ctx, "");
}

static JSValue media_set_password(JSContext *ctx, JSValueConst this_val, JSValueConst val)
{
    BtaMedia   *m = media_this(ctx, this_val);
    const char *s;

    if (!m)
        return JS_EXCEPTION;
    s = JS_ToCString(ctx, val);
    if (!s)
        return JS_EXCEPTION;
    g_mutex_lock(&m->creds);
    g_free(m->pass);
    m->pass = *s ? g_strdup(s) : NULL;
    g_mutex_unlock(&m->creds);
    JS_FreeCString(ctx, s);
    return JS_UNDEFINED;
}

static JSValue media_get_latency(JSContext *ctx, JSValueConst this_val)
{
    BtaMedia *m = media_this(ctx, this_val);

    if (!m)
        return JS_EXCEPTION;
    return JS_NewInt32(ctx, m->latency);
}

static JSValue media_set_latency(JSContext *ctx, JSValueConst this_val, JSValueConst val)
{
    BtaMedia *m = media_this(ctx, this_val);
    int32_t   v;

    if (!m)
        return JS_EXCEPTION;
    if (!bta_to_int(ctx, val, "Latency", &v))
        return JS_EXCEPTION;
    if (v < 0)
        return JS_ThrowRangeError(ctx, "Latency: %d is negative", v);
    m->latency = v;
    return JS_UNDEFINED;
}

static JSValue media_get_volume(JSContext *ctx, JSValueConst this_val)
{
    BtaMedia *m = media_this(ctx, this_val);

    if (!m)
        return JS_EXCEPTION;
    return JS_NewFloat64(ctx, m->volume);
}

static JSValue media_set_volume(JSContext *ctx, JSValueConst this_val, JSValueConst val)
{
    BtaMedia *m = media_this(ctx, this_val);
    double    v;

    if (!m)
        return JS_EXCEPTION;
    if (!bta_to_number(ctx, val, "Volume", &v))
        return JS_EXCEPTION;
    if (!(v >= 0.0 && v <= 1.0))
        return JS_ThrowRangeError(ctx, "Volume: %g is not between 0 and 1", v);
    m->volume = v;
    engine_levels(m);
    return JS_UNDEFINED;
}

static JSValue media_get_muted(JSContext *ctx, JSValueConst this_val)
{
    BtaMedia *m = media_this(ctx, this_val);

    if (!m)
        return JS_EXCEPTION;
    return JS_NewBool(ctx, m->muted);
}

static JSValue media_set_muted(JSContext *ctx, JSValueConst this_val, JSValueConst val)
{
    BtaMedia *m = media_this(ctx, this_val);

    if (!m)
        return JS_EXCEPTION;
    m->muted = JS_ToBool(ctx, val) > 0;
    engine_levels(m);
    return JS_UNDEFINED;
}

static JSValue media_get_loop(JSContext *ctx, JSValueConst this_val)
{
    BtaMedia *m = media_this(ctx, this_val);

    if (!m)
        return JS_EXCEPTION;
    return JS_NewBool(ctx, m->loop);
}

static JSValue media_set_loop(JSContext *ctx, JSValueConst this_val, JSValueConst val)
{
    BtaMedia *m = media_this(ctx, this_val);

    if (!m)
        return JS_EXCEPTION;
    m->loop = JS_ToBool(ctx, val) > 0;
    return JS_UNDEFINED;
}

/*
 * How full the buffer is, `0`…`100`.
 *
 * `100` is nothing to wait for -- a local file never says otherwise -- and
 * less than that is a stream refilling, which is the one thing that holds
 * playback while `Playing` stays true. Polled rather than announced: it
 * changes per cent, several times a second, and a form showing it is already
 * reading `Position` on a `Timer`. The range is `ProgressBar.Value`'s on
 * purpose, since that is what a form puts it in.
 */
static JSValue media_get_buffering(JSContext *ctx, JSValueConst this_val)
{
    BtaMedia *m = media_this(ctx, this_val);

    if (!m)
        return JS_EXCEPTION;
    return JS_NewInt32(ctx, m->buffering);
}

static JSValue media_get_position(JSContext *ctx, JSValueConst this_val)
{
    BtaMedia *m = media_this(ctx, this_val);

    if (!m)
        return JS_EXCEPTION;
    return JS_NewFloat64(ctx, engine_position(m));
}

static JSValue media_get_duration(JSContext *ctx, JSValueConst this_val)
{
    BtaMedia *m = media_this(ctx, this_val);

    if (!m)
        return JS_EXCEPTION;
    /* -1 is live or unknown: a stream with no end has no length to report. */
    return JS_NewFloat64(ctx, engine_duration(m));
}

/*
 * What Play asked for, and not what the pipeline is doing this millisecond.
 *
 * Asking the pipeline was wrong twice over: a flushing seek -- which is what
 * Loop is -- reads back as not-PLAYING for as long as the sinks are
 * re-prerolling, and so does a network stream refilling its buffer. The
 * console loop asks this to know whether anything is still owed an answer, so
 * a looping cue used to end the program at a loop boundary, at random (a
 * 0.3 s clip on loop exited after 2.5 s, 4.3 s, 4.6 s -- never the same
 * twice). Play sets it; Pause, Stop, the end and an error clear it.
 */
static JSValue media_get_playing(JSContext *ctx, JSValueConst this_val)
{
    BtaMedia *m = media_this(ctx, this_val);

    if (!m)
        return JS_EXCEPTION;
    return JS_NewBool(ctx, m->wants);
}

static JSValue media_get_seekable(JSContext *ctx, JSValueConst this_val)
{
    BtaMedia *m = media_this(ctx, this_val);

    if (!m)
        return JS_EXCEPTION;
    return JS_NewBool(ctx, engine_seekable(m));
}

/* ----------------------------------------------------------------- verbs */

static JSValue media_play(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    BtaMedia *m = media_this(ctx, this_val);

    (void)argc; (void)argv;
    if (!m)
        return JS_EXCEPTION;
    if (!m->declared || !*m->declared)
        return JS_ThrowTypeError(ctx, "Play: nothing to play -- set Uri first");
    if (!engine_start(ctx, m))
        return JS_EXCEPTION;
    m->wants = true;
    media_hold_self(ctx, m, this_val);
    return JS_UNDEFINED;
}

static JSValue media_pause(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    BtaMedia *m = media_this(ctx, this_val);

    (void)argc; (void)argv;
    if (!m)
        return JS_EXCEPTION;
    engine_hold(m);
    m->wants = false;
    media_drop_self(m);
    return JS_UNDEFINED;
}

static JSValue media_stop(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    BtaMedia *m = media_this(ctx, this_val);

    (void)argc; (void)argv;
    if (!m)
        return JS_EXCEPTION;
    engine_park(m);
    m->wants     = false;
    m->at_end    = false;
    /* Parking drops the buffer with the state; Pause keeps both. */
    m->buffering = 100;
    media_drop_self(m);
    return JS_UNDEFINED;
}

static JSValue media_seek(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    BtaMedia *m = media_this(ctx, this_val);
    double    sec;

    (void)argc;
    if (!m)
        return JS_EXCEPTION;
    if (!bta_to_number(ctx, argv[0], "Seek", &sec))
        return JS_EXCEPTION;
    if (!(sec >= 0))
        return JS_ThrowRangeError(ctx, "Seek: %g is negative", sec);
    /* The engine owns the refusal, both of them: a live stream cannot seek,
     * and a runtime with no engine says which package is missing instead. */
    if (!engine_seek(ctx, m, sec))
        return JS_EXCEPTION;
    m->at_end = false;
    return JS_UNDEFINED;
}

/* ------------------------------------------------------- the widget's own */

static JSValue video_get_fit(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);

    if (!w)
        return JS_EXCEPTION;
    return JS_NewString(ctx, MEDIA_FIT[gtk_picture_get_content_fit(GTK_PICTURE(w->gtk))]);
}

static JSValue video_set_fit(JSContext *ctx, JSValueConst this_val, JSValueConst val)
{
    BtaWidget  *w = bta_this(ctx, this_val);
    const char *name;
    int         which = -1;

    if (!w)
        return JS_EXCEPTION;
    name = JS_ToCString(ctx, val);
    if (!name)
        return JS_EXCEPTION;
    for (int i = 0; i < 4; i++)
        if (!g_ascii_strcasecmp(name, MEDIA_FIT[i]))
            which = i;
    if (which < 0) {
        JSValue e = JS_ThrowRangeError(ctx,
            "Fit: '%s' is not Fill, Contain, Cover or ScaleDown", name);
        JS_FreeCString(ctx, name);
        return e;
    }
    JS_FreeCString(ctx, name);
    gtk_picture_set_content_fit(GTK_PICTURE(w->gtk), (GtkContentFit)which);
    return JS_UNDEFINED;
}

/* The clip's own size, the way Picture answers for a photograph: from the
 * paintable, so it is the frame's and not the control's. `0` until something
 * has been decoded -- there is nothing to measure before that. */
static int video_intrinsic(BtaWidget *w, bool height)
{
    GdkPaintable *p = gtk_picture_get_paintable(GTK_PICTURE(w->gtk));

    if (!p)
        return 0;
    return height ? gdk_paintable_get_intrinsic_height(p)
                  : gdk_paintable_get_intrinsic_width(p);
}

/*
 * The instance's answer, read off the class row so it and
 * `Widget.Available("Video")` cannot come to disagree -- one declaration, in
 * the table, where the class says everything else about itself (Terminal's
 * `Available` is the same shape).
 */
static JSValue media_get_available(JSContext *ctx, JSValueConst this_val)
{
    if (!bta_this(ctx, this_val))
        return JS_EXCEPTION;

    return JS_NewBool(ctx, bta_class_runnable(bta_class_find("Video")));
}

static JSValue video_get_source_width(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);

    if (!w)
        return JS_EXCEPTION;
    return JS_NewInt32(ctx, video_intrinsic(w, false));
}

static JSValue video_get_source_height(JSContext *ctx, JSValueConst this_val)
{
    BtaWidget *w = bta_this(ctx, this_val);

    if (!w)
        return JS_EXCEPTION;
    return JS_NewInt32(ctx, video_intrinsic(w, true));
}

/*
 * The frame on screen, into a PNG -- `DrawingArea.Save`'s spelling, for the
 * viewer that wants a still of what it is showing.
 *
 * Two ways to get one, because a paintable is not obliged to be a texture:
 * the sink's current image usually *is* one and is written straight out;
 * anything else is rendered through the window's own renderer, which is the
 * only way to rasterise a render node and needs the control to be in a
 * window that has one.
 */
static JSValue video_save(JSContext *ctx, JSValueConst this_val,
                          int argc, JSValueConst *argv)
{
    BtaWidget *w = bta_this(ctx, this_val);

    if (!w)
        return JS_EXCEPTION;
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "Save expects (path)");

    const char *path = JS_ToCString(ctx, argv[0]);

    if (!path)
        return JS_EXCEPTION;

    GdkPaintable *live  = gtk_picture_get_paintable(GTK_PICTURE(w->gtk));
    GdkPaintable *image = live ? gdk_paintable_get_current_image(live) : NULL;
    GdkTexture   *tex   = NULL;
    JSValue       r     = JS_UNDEFINED;

    if (!image) {
        r = JS_ThrowPlainError(ctx,
            "Save: there is no frame yet -- nothing has been decoded");
        goto out;
    }
    if (GDK_IS_TEXTURE(image)) {
        tex = g_object_ref(GDK_TEXTURE(image));
    } else {
        int          iw  = gdk_paintable_get_intrinsic_width(image);
        int          ih  = gdk_paintable_get_intrinsic_height(image);
        GtkNative   *nat = gtk_widget_get_native(w->gtk);
        GskRenderer *ren = nat ? gtk_native_get_renderer(nat) : NULL;

        if (iw <= 0 || ih <= 0) {
            r = JS_ThrowPlainError(ctx,
                "Save: there is no frame yet -- nothing has been decoded");
            goto out;
        }
        if (!ren) {
            r = JS_ThrowPlainError(ctx,
                "Save: a frame that is not a texture can only be written from "
                "a control in a window that is on screen");
            goto out;
        }

        GtkSnapshot *snap = gtk_snapshot_new();

        gdk_paintable_snapshot(image, snap, iw, ih);

        GskRenderNode *node = gtk_snapshot_free_to_node(snap);

        if (node) {
            tex = gsk_renderer_render_texture(ren, node, NULL);
            gsk_render_node_unref(node);
        }
        if (!tex) {
            r = JS_ThrowPlainError(ctx, "Save: the frame could not be drawn");
            goto out;
        }
    }
    if (!gdk_texture_save_to_png(tex, path))
        r = JS_ThrowPlainError(ctx, "Save: cannot write '%s'", path);

out:
    if (tex)
        g_object_unref(tex);
    if (image)
        g_object_unref(image);
    JS_FreeCString(ctx, path);
    return r;
}

/* ------------------------------------------------------------ the control */

static void build_video(BtaWidget *w)
{
    BtaMedia *m;

    w->gtk = gtk_picture_new();

    /* A picture with nothing in it asks for no room at all, which inside a
     * Fixed is a control one cannot select -- the Picture mold. */
    gtk_widget_set_size_request(w->gtk, 32, 32);

    /* The player exists even where the engine does not: its properties are
     * what a .form assigns and what the designer reads back. */
    m = media_new(w->ctx, true);
    m->picture = w->gtk;
    g_object_set_data_full(G_OBJECT(w->gtk), MEDIA_KEY, m, media_qdata_free);
}

static const char *video_options(const char *prop)
{
    return !strcmp(prop, "Fit") ? "Fill,Contain,Cover,ScaleDown" : NULL;
}

/* ------------------------------------------------------------ availability */
/*
 * **Whether this machine could play a Video**, which is not a question the
 * build answers: GStreamer can be linked in and its registry still lack the
 * `gtk4paintablesink` element that puts frames in a `GtkPicture` -- a runner
 * with the base plugins and without gst-plugins-rs is exactly that shape.
 * A palette is who asks, before anything is played, and
 * `Widget.Available("Video")` is the word; `Video.Available` is the same
 * answer from an instance.
 *
 * Cached, because the first question pays for the plugin registry -- 6 ms with
 * the cache warm and 573 ms without it (measured, and the reason
 * `engine_ensure` initialises GStreamer lazily).  A process cannot grow a
 * plugin while it runs, so the answer is asked once.
 *
 * `gst_element_factory_find` and not `_make`: this asks whether the pipeline
 * *could* be built, and constructing a playbin to throw away is a heavier
 * answer to the same question.  `AudioPlayer` is deliberately not part of it --
 * sound needs no window and no sink, so a machine this answers `false` for can
 * still play a cue.
 */
#ifndef BTA_HAVE_GST
static bool video_available(void)
{
    return false;
}
#else
static bool video_available(void)
{
    static int answer = -1;

    if (answer < 0) {
        GstElementFactory *play;
        GstElementFactory *sink;

        /* The same lazy init `engine_ensure` does: the registry cannot be
         * asked before it. */
        gst_init(NULL, NULL);

        play = gst_element_factory_find("playbin3");
        if (!play)
            play = gst_element_factory_find("playbin");
        sink = gst_element_factory_find("gtk4paintablesink");

        answer = (play && sink) ? 1 : 0;
        if (play)
            gst_object_unref(play);
        if (sink)
            gst_object_unref(sink);
    }
    return answer == 1;
}
#endif

void bta_media_register(void)
{
    const BtaClass rows[] = {
        /* Ended()
         *   the clip ran out. It leaves the **last frame up** (a pause, not a
         *   black stop)
         */
        /* Error(message, kind)
         *   it failed. `message` names the control and the clip and says why;
         *   `kind` is one of `NotFound`, `NotAuthorized`, `Unreachable`,
         *   `Decode`, `Error` — a password to ask for and a camera to retry
         *   are not the same answer
         */
        BTA_CLASS_ENUM_PROBE("Video", "Control", build_video, video_props,
                             false, video_options, video_available,
                             "Ended,Error"),
    };
    bta_register_classes(rows, (int)G_N_ELEMENTS(rows));
}

/* ------------------------------------------------------------ AudioPlayer */

static BtaMedia *audio_this(JSContext *ctx, JSValueConst this_val)
{
    BtaMedia *m = JS_GetOpaque(this_val, audioplayer_class_id);

    if (!m) {
        JS_ThrowTypeError(ctx, "not an AudioPlayer");
        return NULL;
    }
    if (m->dead) {
        JS_ThrowPlainError(ctx, "AudioPlayer: torn down");
        return NULL;
    }
    return m;
}

static void audioplayer_finalizer(JSRuntime *rt, JSValue v)
{
    BtaMedia *m = JS_GetOpaque(v, audioplayer_class_id);

    if (!m)
        return;
    /* The runtime is what a finalizer is handed -- no context kept beside it. */
    media_teardown(m);
    /* `self` points at the object being finalised: if we are here, whatever
     * held it is already gone, so there is nothing to release -- and
     * releasing it would be a second free of this very object. */
    m->self = JS_UNDEFINED;
    JS_FreeValueRT(rt, m->on_ended);
    JS_FreeValueRT(rt, m->on_error);
    media_free(m);
}

/* The handlers are strong references in the opaque slot, so the collector is
 * told: a player whose OnEnded closes over the player itself is the exact
 * cycle the Http client taught us about. `self` is not reported here, and
 * says why where it is taken. */
static void audioplayer_gc_mark(JSRuntime *rt, JSValueConst v, JS_MarkFunc *mark)
{
    BtaMedia *m = JS_GetOpaque(v, audioplayer_class_id);

    if (m) {
        JS_MarkValue(rt, m->on_ended, mark);
        JS_MarkValue(rt, m->on_error, mark);
    }
}

static const JSClassDef audioplayer_class = {
    "AudioPlayer",
    .finalizer = audioplayer_finalizer,
    .gc_mark   = audioplayer_gc_mark,
};

static JSValue audio_get_onended(JSContext *ctx, JSValueConst this_val)
{
    BtaMedia *m = audio_this(ctx, this_val);

    if (!m)
        return JS_EXCEPTION;
    return JS_DupValue(ctx, m->on_ended);
}

static JSValue audio_get_onerror(JSContext *ctx, JSValueConst this_val)
{
    BtaMedia *m = audio_this(ctx, this_val);

    if (!m)
        return JS_EXCEPTION;
    return JS_DupValue(ctx, m->on_error);
}

/* A handler is a function or nothing: anything else is refused where it is
 * assigned rather than silently never called. */
static JSValue audio_set_handler(JSContext *ctx, JSValueConst val,
                                 const char *name, JSValue *slot)
{
    if (JS_IsUndefined(val) || JS_IsNull(val)) {
        JS_FreeValue(ctx, *slot);
        *slot = JS_UNDEFINED;
        return JS_UNDEFINED;
    }
    if (!JS_IsFunction(ctx, val))
        return JS_ThrowTypeError(ctx, "%s must be a function", name);
    JS_FreeValue(ctx, *slot);
    *slot = JS_DupValue(ctx, val);
    return JS_UNDEFINED;
}

static JSValue audio_set_onended(JSContext *ctx, JSValueConst this_val, JSValueConst val)
{
    BtaMedia *m = audio_this(ctx, this_val);

    if (!m)
        return JS_EXCEPTION;
    return audio_set_handler(ctx, val, "OnEnded", &m->on_ended);
}

static JSValue audio_set_onerror(JSContext *ctx, JSValueConst this_val, JSValueConst val)
{
    BtaMedia *m = audio_this(ctx, this_val);

    if (!m)
        return JS_EXCEPTION;
    return audio_set_handler(ctx, val, "OnError", &m->on_error);
}

static JSValue audioplayer_construct(JSContext *ctx, JSValueConst new_target,
                                     int argc, JSValueConst *argv)
{
    JSValue   proto, obj;
    BtaMedia *m;

    (void)new_target; (void)argv;
    if (argc > 0)
        return JS_ThrowTypeError(ctx, "AudioPlayer takes no arguments");
#ifndef BTA_HAVE_GST
    /* Nothing declarative depends on this one -- no .form builds a player --
     * so the refusal lands at the constructor, where sqlite's does. */
    return JS_ThrowPlainError(ctx, MEDIA_NO_GST);
#endif
    proto = JS_GetClassProto(ctx, audioplayer_class_id);
    obj = JS_NewObjectProtoClass(ctx, proto, audioplayer_class_id);
    JS_FreeValue(ctx, proto);
    if (JS_IsException(obj))
        return obj;
    m = media_new(ctx, false);
    JS_SetOpaque(obj, m);
    return obj;
}

/* --------------------------------------------------------- the three types
 *
 * No global constructor holds these: `Media.Element` makes the first, and the
 * rest arrive from verbs (`Pad`, `Bus`) and signal arguments. The
 * descriptions here are the published ones -- `Widget.Members("Element")` and
 * the documentation repositories answer from these tables.
 */

/* type Element */
static const JSCFunctionListEntry element_props[] = {
    /* Add(child) -> Element
     *   puts a child into this bin or pipeline and answers the child, so a
     *   call chains into its own configuration. A child added to a running
     *   pipeline follows it into its state -- the one thing `gst_bin_add`
     *   leaves to the caller -- and adding **unlinks the child's pads**,
     *   which is why `Add` comes before `Link`
     */
    JS_CFUNC_DEF("Add", 1, elem_add),
    /* Link(other, [from], [to]) -> Element
     *   links this element to `other` and answers `other`, so a chain walks a
     *   graph: `src.Link(conv).Link(sink)`. With pad names, that pad on each
     *   side; without, whatever pads meet. Both must already be in one
     *   pipeline, and an element whose pads appear during playback
     *   (`rtspsrc`, `decodebin`) is linked from `On("pad-added")` instead.
     *   A `tee` needs a `queue` per branch or nothing ever finishes -- that
     *   is GStreamer's rule, said here because every graph meets it once
     */
    JS_CFUNC_DEF("Link", 3, elem_link),
    /* Pad(name) -> Pad or null
     *   the named pad if it exists *now* -- `src`, `sink`, or a dynamic name
     *   like `stream_0` once it has appeared -- and `null` when it does not.
     *   What will appear is announced by `On("pad-added")`
     */
    JS_CFUNC_DEF("Pad", 1, elem_pad),
    /* Set(name, value)
     *   an element's property, by the name `gst-inspect-1.0` prints.
     *   Booleans, numbers, strings, an enum's nick, flag names joined by `+`,
     *   `n/d` fractions and caps text are carried; anything else refuses with
     *   a sentence naming the property and what it takes, where gst-launch's
     *   own setter answers nothing at all
     */
    JS_CFUNC_DEF("Set", 2, elem_set),
    /* Get(name) -> number, string or boolean
     *   the property in the spellings `Set` takes -- built from the class and
     *   not from GStreamer's serialised form, so caps answer as
     *   `video/x-raw, format=(string)RGB` and flags as `tcp+udp`. A property
     *   that holds an object refuses: this surface carries no such value
     */
    JS_CFUNC_DEF("Get", 1, elem_get),
    /* Eos()
     *   asks the graph to finish: the end-of-stream event reaches every sink,
     *   writers flush and close their file, and the bus answers `eos` when it
     *   is done. A recorder stops with this and not with `"Null"` -- without
     *   it a muxer's header keeps its placeholder sizes (measured on wavenc)
     */
    JS_CFUNC_DEF("Eos", 0, elem_eos),
    /* On(signal, handler) -> Element
     *   subscribes to a GObject signal, named as `gst-inspect-1.0` prints it
     *   (`pad-added`, `source-setup`); the handler is called with the
     *   signal's arguments after the emitter, and `null` takes it off. A
     *   signal that answers a value is refused, and the handler never runs
     *   inside the GStreamer callback: it is delivered on the main loop, with
     *   a reference on every element or pad it names
     */
    JS_CFUNC_DEF("On", 2, elem_on),
    /* Bus -> Bus or null
     *   the bus of the pipeline this element is in -- a child answers its
     *   pipeline's, not the internal one `gst_element_get_bus` would -- and
     *   `null` for an element in no pipeline
     */
    JS_CGETSET_DEF("Bus", elem_get_bus, NULL),
    /* State -> string
     *   which state was asked for: `"Null"`, `"Ready"`, `"Paused"` or
     *   `"Playing"` (any spelling on the way in). **The last asked, not what
     *   a query would answer** (the `Video.Playing` rule); what the pipeline
     *   actually did is read off the bus -- `state-changed`, `async-done`
     */
    JS_CGETSET_DEF("State", elem_get_state, elem_set_state),
};

/* type Pad */
static const JSCFunctionListEntry pad_props[] = {
    /* Name -> string
     *   the pad's name: `src`, `sink`, or `stream_0` once it has appeared
     */
    JS_CGETSET_DEF("Name", pad_get_name, NULL),
    /* Caps -> string
     *   the caps this pad can take, as text (`video/x-raw, format=(string)RGB`),
     *   or `""` when there are none. What is *flowing* is a different
     *   question, and is not carried yet
     */
    JS_CGETSET_DEF("Caps", pad_get_caps, NULL),
    /* Link(target) -> Pad
     *   links this pad to an `Element` (a compatible pad is found for it, or
     *   requested from a template) or to another `Pad`, and answers the far
     *   pad. A failure says why: not in the same pipeline, both facing the
     *   same way, or formats that do not meet
     */
    JS_CFUNC_DEF("Link", 1, pad_link),
};

/* type Bus */
static const JSCFunctionListEntry bus_props[] = {
    /* On(type, handler) -> Bus
     *   one of eight messages, named as GStreamer spells them: `error`,
     *   `warning` and `info` call `handler(message, kind)` with `kind` one of
     *   `NotFound`, `NotAuthorized`, `Unreachable`, `Decode`, `Error` -- the
     *   players' own words -- `eos`, `clock-lost` and `async-done` call
     *   `handler()`, `buffering` calls `handler(percent)`, and
     *   `state-changed` calls `handler(name, state)`. `null` takes it off.
     *   Handlers run on the main loop
     */
    JS_CFUNC_DEF("On", 2, bus_on),
};

static void element_finalizer(JSRuntime *rt, JSValue v)
{
    BtaElem *e = JS_GetOpaque(v, element_class_id);

    if (!e)
        return;
    if (e->signals) {
        GHashTableIter it;
        gpointer key, val;

        g_hash_table_iter_init(&it, e->signals);
        while (g_hash_table_iter_next(&it, &key, &val)) {
            ElemSub *sub = val;

            JS_FreeValueRT(rt, sub->handler);
            sub->handler = JS_UNDEFINED;
        }
    }
    elem_teardown(e);
    /* `self` points at the object being finalised: whatever held it is gone
     * already, and releasing it would be a second free of this very object. */
    e->self = JS_UNDEFINED;
    g_free(e);
}

/* The handlers are strong references in the opaque slot, so the collector is
 * told -- the audioplayer's rule, one table over. */
static void element_gc_mark(JSRuntime *rt, JSValueConst v, JS_MarkFunc *mark)
{
    BtaElem *e = JS_GetOpaque(v, element_class_id);
    GHashTableIter it;
    gpointer key, val;

    if (!e || !e->signals)
        return;
    g_hash_table_iter_init(&it, e->signals);
    while (g_hash_table_iter_next(&it, &key, &val)) {
        ElemSub *sub = val;

        JS_MarkValue(rt, sub->handler, mark);
    }
}

static const JSClassDef element_class = {
    "Element",
    .finalizer = element_finalizer,
    .gc_mark   = element_gc_mark,
};

static void pad_finalizer(JSRuntime *rt, JSValue v)
{
    BtaPad *p = JS_GetOpaque(v, pad_class_id);

    (void)rt;
    if (!p)
        return;
    pad_teardown(p);
    g_free(p);
}

static const JSClassDef pad_class = {
    "Pad",
    .finalizer = pad_finalizer,
};

static void bus_finalizer(JSRuntime *rt, JSValue v)
{
    BtaBus *b = JS_GetOpaque(v, bus_class_id);

    if (!b)
        return;
    for (int i = 0; i < (int)G_N_ELEMENTS(MEDIA_BUS_TYPES); i++) {
        JS_FreeValueRT(rt, b->handlers[i]);
        b->handlers[i] = JS_UNDEFINED;
    }
    b->self = JS_UNDEFINED;
    bus_teardown(b);
    g_free(b);
}

static void bus_gc_mark(JSRuntime *rt, JSValueConst v, JS_MarkFunc *mark)
{
    BtaBus *b = JS_GetOpaque(v, bus_class_id);

    if (!b)
        return;
    for (int i = 0; i < (int)G_N_ELEMENTS(MEDIA_BUS_TYPES); i++)
        JS_MarkValue(rt, b->handlers[i], mark);
}

static const JSClassDef bus_class = {
    "Bus",
    .finalizer = bus_finalizer,
    .gc_mark   = bus_gc_mark,
};

static const JSCFunctionListEntry media_global_props[] = {
    /* Element(type, [props]) -> Element
     *   builds an element by its factory name (`rtspsrc`, `tee`, `wavenc`)
     *   and applies `props` through `Set`, property by property; a name this
     *   installation has no type for refuses instead of building nothing
     */
    JS_CFUNC_DEF("Element", 2, media_element),
};

void bta_media_init(JSContext *ctx, JSValue global)
{
#ifdef BTA_HAVE_GST
    media_main_thread = g_thread_self();
#endif
    JS_NewClassID(JS_GetRuntime(ctx), &audioplayer_class_id);
    JS_NewClass(JS_GetRuntime(ctx), audioplayer_class_id, &audioplayer_class);

    JSValue proto = JS_NewObject(ctx);

    JS_SetPropertyFunctionList(ctx, proto, audioplayer_props,
                               G_N_ELEMENTS(audioplayer_props));
    JS_SetClassProto(ctx, audioplayer_class_id, proto);

    JSValue ctor = JS_NewCFunction2(ctx, audioplayer_construct, "AudioPlayer", 0,
                                    JS_CFUNC_constructor, 0);

    JS_SetPropertyStr(ctx, global, "AudioPlayer", ctor);

    /* The elements API: three classes no global holds, and the `Media` object
     * that makes the first of them. Registered in both builds -- the classes
     * answer about themselves with no engine, the designer's rule. */
    JS_NewClassID(JS_GetRuntime(ctx), &element_class_id);
    JS_NewClass(JS_GetRuntime(ctx), element_class_id, &element_class);
    JS_NewClassID(JS_GetRuntime(ctx), &pad_class_id);
    JS_NewClass(JS_GetRuntime(ctx), pad_class_id, &pad_class);
    JS_NewClassID(JS_GetRuntime(ctx), &bus_class_id);
    JS_NewClass(JS_GetRuntime(ctx), bus_class_id, &bus_class);

    JSValue element_proto = JS_NewObject(ctx);

    JS_SetPropertyFunctionList(ctx, element_proto, element_props,
                               G_N_ELEMENTS(element_props));
    JS_SetClassProto(ctx, element_class_id, element_proto);

    JSValue pad_proto = JS_NewObject(ctx);

    JS_SetPropertyFunctionList(ctx, pad_proto, pad_props, G_N_ELEMENTS(pad_props));
    JS_SetClassProto(ctx, pad_class_id, pad_proto);

    JSValue bus_proto = JS_NewObject(ctx);

    JS_SetPropertyFunctionList(ctx, bus_proto, bus_props, G_N_ELEMENTS(bus_props));
    JS_SetClassProto(ctx, bus_class_id, bus_proto);

    JSValue media = JS_NewObject(ctx);

    JS_SetPropertyFunctionList(ctx, media, media_global_props,
                               G_N_ELEMENTS(media_global_props));
#ifdef BTA_HAVE_GST
    /* Available
     *   whether this build has GStreamer, and so whether `Element` can build
     *   anything. It says nothing about whether a *specific* element exists
     *   on the machine: that question is refused per name
     */
    JS_SetPropertyStr(ctx, media, "Available", JS_NewBool(ctx, true));
#else
    /* Available
     *   whether this build has GStreamer, and so whether `Element` can build
     *   anything. It says nothing about whether a *specific* element exists
     *   on the machine: that question is refused per name
     */
    JS_SetPropertyStr(ctx, media, "Available", JS_NewBool(ctx, false));
#endif
    JS_SetPropertyStr(ctx, global, "Media", media);
}

guint bta_media_pending(void)
{
    guint n = 0;

    /* A player playing is owed an answer -- an EOS or an error -- the way a
     * running child is. A paused one is a deliberate hold, not work in
     * flight, so it keeps no console project alive. The elements half is the
     * same rule (a pipeline asked Playing), plus the signal deliveries still
     * on their way: the loop must not end between an emission and its
     * handler. */
    for (GList *l = media_live; l; l = l->next) {
        BtaMedia *m = l->data;

        if (!m->dead && m->wants)
            n++;
    }
    for (GList *l = elements_live; l; l = l->next) {
        BtaElem *e = l->data;

        if (!e->dead && e->hold_play)
            n++;
    }
    g_mutex_lock(&media_sig_mutex);
    n += g_list_length(media_calls);
    g_mutex_unlock(&media_sig_mutex);
    return n;
}

/*
 * Stop every engine, then let go of every keepalive -- in that order, and
 * both here rather than in media_teardown.
 *
 * The keepalive a playing player holds on its own JS object is a reference
 * nothing else will ever release, and quickjs asserts that no object is left
 * alive when the runtime goes (`list_empty(&rt->gc_obj_list)` in
 * JS_FreeRuntime) -- so a program that ended with a cue still playing aborted
 * there. It cannot be released inside the walk either: dropping the last
 * reference runs the finalizer, which frees the very struct the walk is
 * holding. So the references are taken away first, the engines stopped
 * second, and the values freed last, when media_live is already empty and
 * nothing will touch a BtaMedia again.
 *
 * The containers themselves stay with their owners (the GtkPicture's qdata,
 * the JS finalizer), which is the Http mold: cleanup cancels what is
 * external, finalizers free what is held.
 */
void bta_media_cleanup(void)
{
    struct Held { JSContext *ctx; JSValue value; };
    GArray *held = g_array_new(FALSE, FALSE, sizeof(struct Held));

    for (GList *l = media_live; l; l = l->next) {
        BtaMedia *m = l->data;

        if (!JS_IsUndefined(m->self) && m->ctx) {
            struct Held h = { m->ctx, m->self };

            m->self = JS_UNDEFINED;
            g_array_append_val(held, h);
        }
    }
    /* The same walk for the elements half, and for the buses: every strong
     * JSValue a C struct holds is taken away first, the engines are stopped
     * second, and the values freed last -- the note above, three times. The
     * deliveries on their way hold no JSValue at all, only C and references:
     * they are dropped after the teardowns, which empty the watch registry
     * they share. */
    for (GList *l = elements_live; l; l = l->next) {
        BtaElem *e = l->data;

        if (!JS_IsUndefined(e->self) && e->ctx) {
            struct Held h = { e->ctx, e->self };

            e->self = JS_UNDEFINED;
            g_array_append_val(held, h);
        }
        if (e->signals) {
            GHashTableIter it;
            gpointer key, val;

            g_hash_table_iter_init(&it, e->signals);
            while (g_hash_table_iter_next(&it, &key, &val)) {
                ElemSub *sub = val;

                if (!JS_IsUndefined(sub->handler) && e->ctx) {
                    struct Held h = { e->ctx, sub->handler };

                    sub->handler = JS_UNDEFINED;
                    g_array_append_val(held, h);
                }
            }
        }
    }
    for (GList *l = buses_live; l; l = l->next) {
        BtaBus *b = l->data;

        if (!JS_IsUndefined(b->self) && b->ctx) {
            struct Held h = { b->ctx, b->self };

            b->self = JS_UNDEFINED;
            g_array_append_val(held, h);
        }
        for (int i = 0; i < (int)G_N_ELEMENTS(MEDIA_BUS_TYPES); i++) {
            if (!JS_IsUndefined(b->handlers[i]) && b->ctx) {
                struct Held h = { b->ctx, b->handlers[i] };

                b->handlers[i] = JS_UNDEFINED;
                g_array_append_val(held, h);
            }
        }
    }
    while (media_live)
        media_teardown(media_live->data);
    while (elements_live)
        elem_teardown(elements_live->data);
    while (buses_live)
        bus_teardown(buses_live->data);
    media_calls_cleanup();
    for (guint i = 0; i < held->len; i++) {
        struct Held *h = &g_array_index(held, struct Held, i);

        JS_FreeValue(h->ctx, h->value);
    }
    g_array_free(held, TRUE);
}

#ifdef BTA_HAVE_GST

/* ================================================================= engine
 *
 * playbin3 plus, for a Video, the gtk4paintablesink whose paintable the
 * GtkPicture shows. Everything above this line is spelling; everything below
 * it is GStreamer.
 */

static double media_seconds(gint64 ns)
{
    return (double)ns / (double)GST_SECOND;
}

/* The credentials reach the source here, on whatever source the playbin built
 * for this URI. Asked by property rather than by type: only rtspsrc answers
 * today, and the next source with an identity of its own is configured rather
 * than ignored. user-id/user-pw are what digest auth challenges against.
 *
 * This is not necessarily the main thread -- a source is built on whatever
 * thread carries the state change, and rebuilt on a redirect -- which is why
 * the strings are read under the lock the setters write under. */
static void media_source_setup(GstElement *playbin, GstElement *src, gpointer data)
{
    BtaMedia     *m     = data;
    GObjectClass *klass = G_OBJECT_GET_CLASS(src);

    (void)playbin;
    if (!m || m->dead)
        return;
    g_mutex_lock(&m->creds);
    if (m->user && g_object_class_find_property(klass, "user-id"))
        g_object_set(src, "user-id", m->user, NULL);
    if (m->pass && g_object_class_find_property(klass, "user-pw"))
        g_object_set(src, "user-pw", m->pass, NULL);
    g_mutex_unlock(&m->creds);
    if (g_object_class_find_property(klass, "latency"))
        g_object_set(src, "latency", (guint)MAX(m->latency, 0), NULL);
}

static BtaWidget *media_widget(BtaMedia *m)
{
    /* Resolved now and not kept: the wrapper may be gone while its Gtk still
     * plays (Remove drops the parent's reference), and a BtaWidget read after
     * its finalizer cleared the quark is freed memory. No wrapper, no
     * subscriber: the frames go on, the event does not. */
    if (!m->picture)
        return NULL;
    return g_object_get_data(G_OBJECT(m->picture), BTA_WIDGET_QUARK);
}

/* A handler runs with the player's own reference held (media_hold_self), so
 * nothing it does can free the struct underneath -- but the context is read
 * into a local anyway, because that was the crash: an OnEnded that dropped
 * the last reference left `m` freed and the next line read `m->ctx`. The
 * handler itself is duplicated for the length of the call, since assigning
 * OnEnded from inside OnEnded would otherwise free the function running. */
static void media_call(BtaMedia *m, JSValue fn, int argc, JSValueConst *argv)
{
    JSContext *ctx = m->ctx;

    if (m->dead || !ctx || !JS_IsFunction(ctx, fn))
        return;

    JSValue held = JS_DupValue(ctx, fn);
    JSValue r    = JS_Call(ctx, held, JS_UNDEFINED, argc, argv);

    if (JS_IsException(r))
        bta_dump_error(ctx);
    JS_FreeValue(ctx, r);
    JS_FreeValue(ctx, held);
    bta_drain_jobs(JS_GetRuntime(ctx));
}

/* Ended and Error are emitted with their names spelled out, in both
 * spellings, so tests/api/Check.js can see them: an event dispatched through
 * a variable is an event whose arity nothing checks -- and this one grew an
 * argument. */
static void media_fire_ended(BtaMedia *m)
{
    if (m->is_video) {
        BtaWidget *w = media_widget(m);

        if (w)
            bta_emit(w, "Ended", 0, NULL);
    } else {
        media_call(m, m->on_ended, 0, NULL);
    }
}

static void media_fire_error(BtaMedia *m, const char *message, const char *kind)
{
    JSContext *ctx = m->ctx;

    if (!ctx)
        return;

    JSValue args[2] = { JS_NewString(ctx, message), JS_NewString(ctx, kind) };

    if (m->is_video) {
        BtaWidget *w = media_widget(m);

        if (w)
            bta_emit(w, "Error", 2, (JSValueConst *)args);
    } else {
        media_call(m, m->on_error, 2, (JSValueConst *)args);
    }
    JS_FreeValue(ctx, args[0]);
    JS_FreeValue(ctx, args[1]);
}

static void media_on_eos(BtaMedia *m)
{
    m->at_end = true;
    if (m->loop && m->playbin &&
        gst_element_seek_simple(m->playbin, GST_FORMAT_TIME,
                                GST_SEEK_FLAG_FLUSH, 0)) {
        m->at_end = false;
        return;
    }
    /* The last frame stays up: PAUSED, not NULL. */
    if (m->playbin)
        gst_element_set_state(m->playbin, GST_STATE_PAUSED);
    m->wants = false;

    /*
     * **A Video's `m` is not held across the event.** It belongs to the
     * picture's qdata, and a handler that takes the control out and drops it
     * (`Vid_Ended() { this.Vid.Remove(); this.Vid = undefined; }`) finalises
     * the widget, the qdata and `m` inside the emit -- so reading `m->self`
     * afterwards was a heap-use-after-free, measured under build-asan. A Video
     * has no `self` to drop anyway: the answer is read before the event.
     */
    bool video = m->is_video;
    media_fire_ended(m);
    if (!video)
        media_drop_self(m);   /* the last line: it may finalise m */
}

/* What kind of failure it was, in the Http client's vocabulary and for the
 * same reason: a form has to be able to tell a camera that refused the
 * password from one that is not answering at all, without reading the prose
 * back -- and the prose is GStreamer's, in the user's language. */
static const char *media_kind_for(const GError *err)
{
    if (!err)
        return "Error";
    if (err->domain == GST_RESOURCE_ERROR) {
        switch (err->code) {
        case GST_RESOURCE_ERROR_NOT_FOUND:
            return "NotFound";
        case GST_RESOURCE_ERROR_NOT_AUTHORIZED:
            return "NotAuthorized";
        case GST_RESOURCE_ERROR_OPEN_READ:
        case GST_RESOURCE_ERROR_OPEN_READ_WRITE:
        case GST_RESOURCE_ERROR_READ:
        case GST_RESOURCE_ERROR_BUSY:
            return "Unreachable";
        default:
            return "Error";
        }
    }
    if (err->domain == GST_STREAM_ERROR) {
        switch (err->code) {
        case GST_STREAM_ERROR_TYPE_NOT_FOUND:
        case GST_STREAM_ERROR_CODEC_NOT_FOUND:
        case GST_STREAM_ERROR_WRONG_TYPE:
        case GST_STREAM_ERROR_DECODE:
        case GST_STREAM_ERROR_DEMUX:
            return "Decode";
        default:
            return "Error";
        }
    }
    return "Error";
}

/*
 * What went wrong, in words of ours.
 *
 * **GStreamer's messages are translated like any other gettext user's** --
 * "Recurso no encontrado." on a Spanish desktop, "Resource not found." on an
 * English one (measured) -- so the domain and the code are read here, as the
 * kind already is.  A pair this table does not know falls to
 * `bta_gerror_text`, which names the domain and the code rather than quoting
 * a sentence that moves with the desktop.
 */
static const char *media_error_text(const GError *err)
{
    if (err && err->domain == GST_RESOURCE_ERROR) {
        switch (err->code) {
        case GST_RESOURCE_ERROR_NOT_FOUND:       return "the resource was not found";
        case GST_RESOURCE_ERROR_BUSY:            return "the resource is busy";
        case GST_RESOURCE_ERROR_OPEN_READ:
        case GST_RESOURCE_ERROR_OPEN_READ_WRITE: return "it could not be opened for reading";
        case GST_RESOURCE_ERROR_OPEN_WRITE:      return "it could not be opened for writing";
        case GST_RESOURCE_ERROR_CLOSE:           return "it could not be closed";
        case GST_RESOURCE_ERROR_READ:            return "it could not be read";
        case GST_RESOURCE_ERROR_WRITE:           return "it could not be written";
        case GST_RESOURCE_ERROR_SEEK:            return "it cannot seek there";
        case GST_RESOURCE_ERROR_SYNC:            return "it could not be synchronized";
        case GST_RESOURCE_ERROR_SETTINGS:        return "its settings were refused";
        case GST_RESOURCE_ERROR_NO_SPACE_LEFT:   return "no space left";
        case GST_RESOURCE_ERROR_NOT_AUTHORIZED:  return "it is not authorized";
        default: break;
        }
    } else if (err && err->domain == GST_STREAM_ERROR) {
        switch (err->code) {
        case GST_STREAM_ERROR_TYPE_NOT_FOUND:    return "its type does not say how to read it";
        case GST_STREAM_ERROR_WRONG_TYPE:        return "it is not the type its name says";
        case GST_STREAM_ERROR_CODEC_NOT_FOUND:   return "no decoder is installed for it";
        case GST_STREAM_ERROR_DECODE:            return "it could not be decoded";
        case GST_STREAM_ERROR_ENCODE:            return "it could not be encoded";
        case GST_STREAM_ERROR_DEMUX:             return "it could not be separated into streams";
        case GST_STREAM_ERROR_MUX:               return "it could not be put into one stream";
        case GST_STREAM_ERROR_FORMAT:            return "the format is not usable here";
        case GST_STREAM_ERROR_DECRYPT:           return "it could not be decrypted";
        case GST_STREAM_ERROR_DECRYPT_NOKEY:     return "it needs a key to be decrypted";
        case GST_STREAM_ERROR_NOT_IMPLEMENTED:   return "it is not implemented";
        default: break;
        }
    } else if (err && err->domain == GST_LIBRARY_ERROR) {
        switch (err->code) {
        case GST_LIBRARY_ERROR_INIT:      return "the library would not start";
        case GST_LIBRARY_ERROR_SHUTDOWN:  return "the library would not stop";
        case GST_LIBRARY_ERROR_SETTINGS:  return "the library refused its settings";
        case GST_LIBRARY_ERROR_ENCODE:    return "the library could not encode it";
        default: break;
        }
    }

    return bta_gerror_text(err);
}

static void media_on_error(BtaMedia *m, GstMessage *msg)
{
    GError *err = NULL;
    gchar  *dbg = NULL;

    gst_message_parse_error(msg, &err, &dbg);
    m->at_end = false;
    m->wants  = false;
    if (m->playbin)
        gst_element_set_state(m->playbin, GST_STATE_NULL);

    /* http_error_text's shape, because a message naming neither the player
     * nor what it was playing is a status line nobody can act on. */
    char *text = g_strdup_printf("%s: cannot play '%s': %s", media_who(m),
                                 m->declared ? m->declared : "",
                                 err ? media_error_text(err)
                                     : "playback failed");

    if (dbg)
        bta_log_debug(m->ctx, dbg);

    /* The same as the end above: a Video's handler may free `m`. */
    bool video = m->is_video;
    media_fire_error(m, text, media_kind_for(err));
    g_free(text);
    g_clear_error(&err);
    g_free(dbg);
    if (!video)
        media_drop_self(m);   /* the last line: it may finalise m */
}

/*
 * Buffering, which playbin leaves to whoever owns the pipeline: a stream that
 * has run its queue dry keeps PLAYING and stutters unless it is held at
 * PAUSED until the buffer refills. Not for a live source -- a camera has
 * nothing to catch up on and pausing one only drops frames -- which is what
 * NO_PREROLL told us when the state was set.
 */
static void media_on_buffering(BtaMedia *m, GstMessage *msg)
{
    gint pct = 100;

    gst_message_parse_buffering(msg, &pct);
    m->buffering = CLAMP(pct, 0, 100);
    if (m->live || !m->wants || !m->playbin)
        return;
    gst_element_set_state(m->playbin,
                          pct < 100 ? GST_STATE_PAUSED : GST_STATE_PLAYING);
}

static gboolean media_bus_cb(GstBus *bus, GstMessage *msg, gpointer data)
{
    BtaMedia *m = data;

    (void)bus;
    if (!m || m->dead)
        return TRUE;
    switch (GST_MESSAGE_TYPE(msg)) {
    case GST_MESSAGE_EOS:
        media_on_eos(m);
        break;
    case GST_MESSAGE_ERROR:
        media_on_error(m, msg);
        break;
    case GST_MESSAGE_BUFFERING:
        media_on_buffering(m, msg);
        break;
    case GST_MESSAGE_CLOCK_LOST:
        /* A clock that goes away (an audio device unplugged, a stream
         * reconnected) is picked up again by going through PAUSED. */
        if (m->wants && m->playbin) {
            gst_element_set_state(m->playbin, GST_STATE_PAUSED);
            gst_element_set_state(m->playbin, GST_STATE_PLAYING);
        }
        break;
    case GST_MESSAGE_WARNING: {
        /* Not an Error: playback goes on. It goes to the log because the
         * reason a stream sounds wrong is usually written here. */
        GError *err = NULL;
        gchar  *dbg = NULL;

        gst_message_parse_warning(msg, &err, &dbg);
        if (err) {
            char *line = g_strdup_printf("%s: %s", media_who(m),
                                         media_error_text(err));

            bta_log_debug(m->ctx, line);
            g_free(line);
        }
        g_clear_error(&err);
        g_free(dbg);
        break;
    }
    default:
        break;
    }
    return TRUE;
}

/* The pipeline is built on first use, so constructing a Video never fails for
 * lack of a plugin: Widget.New("Video") and CssNode() work regardless, and
 * the refusal lands where playback was asked for, naming the element.
 *
 * gst_init is here and not in bta_media_init for the same reason: it reads
 * the plugin registry, which costs 6 ms with the cache warm and 573 ms
 * without it (measured) -- a bill every program in the tree used to pay, the
 * IDE included, for a feature most of them never touch. */
static bool engine_ensure(JSContext *ctx, BtaMedia *m)
{
    static bool gst_ready = false;
    GstElement *pb;
    GstBus     *bus;

    if (m->playbin)
        return true;
    if (!gst_ready) {
        gst_init(NULL, NULL);
        gst_ready = true;
    }

    pb = gst_element_factory_make("playbin3", NULL);
    if (!pb)
        pb = gst_element_factory_make("playbin", NULL);
    if (!pb) {
        JS_ThrowPlainError(ctx,
            "no playbin3 element: this GStreamer installation cannot play "
            "anything, which means its base plugins are not installed");
        return false;
    }

    if (m->is_video) {
        GstElement   *sink = gst_element_factory_make("gtk4paintablesink", NULL);
        GdkPaintable *paintable = NULL;

        if (!sink) {
            g_object_unref(pb);
            JS_ThrowPlainError(ctx,
                "no gtk4paintablesink element: a Video needs GStreamer's GTK4 "
                "plugin, which ships in gst-plugins-rs -- sound alone needs no "
                "window and no plugin beyond the base ones (see AudioPlayer)");
            return false;
        }
        g_object_set(pb, "video-sink", sink, NULL);
        /* No unref: the playbin takes the sink into one of its own bins,
         * which sinks the floating reference the factory gave us -- the
         * gst_bin_add ownership, not a gst_object_replace one. An unref here
         * destroys the sink while the playbin still points at it, and its
         * finalizer then touches freed memory (two GStreamer-CRITICALs at
         * teardown). Measured both ways: with the unref it dies, without it
         * the sink finalises with the pipeline and nothing leaks. */
        g_object_get(sink, "paintable", &paintable, NULL);
        if (!paintable) {
            g_object_unref(pb);
            JS_ThrowPlainError(ctx, "the video sink produced no paintable");
            return false;
        }
        gtk_picture_set_paintable(GTK_PICTURE(m->picture), paintable);
        g_object_unref(paintable);
    } else {
        /* Audio only, twice over: the flag keeps the video branch from ever
         * being decoded (0x1 is VIDEO in the playbin flags, kept in step with
         * the playbin documentation), and the fakesink catches whatever asks
         * for a video sink anyway. */
        guint flags = 0;

        g_object_get(pb, "flags", &flags, NULL);
        g_object_set(pb, "flags", flags & ~(guint)0x1, NULL);

        GstElement *fsink = gst_element_factory_make("fakesink", NULL);

        /* No unref either -- same ownership as above. */
        if (fsink)
            g_object_set(pb, "video-sink", fsink, NULL);
    }

    g_signal_connect(pb, "source-setup", G_CALLBACK(media_source_setup), m);
    bus = gst_element_get_bus(pb);
    m->bus_watch = gst_bus_add_watch(bus, media_bus_cb, m);
    g_object_unref(bus);

    m->playbin = pb;
    if (m->uri)
        g_object_set(pb, "uri", m->uri, NULL);
    engine_levels(m);
    return true;
}

static bool engine_start(JSContext *ctx, BtaMedia *m)
{
    if (!engine_ensure(ctx, m))
        return false;
    if (m->at_end) {
        /* Replay from the top. A live stream cannot seek; clearing the flag
         * and playing on is the honest answer (see Seek, which refuses). */
        gst_element_seek_simple(m->playbin, GST_FORMAT_TIME,
                                GST_SEEK_FLAG_FLUSH, 0);
        m->at_end = false;
    }

    /* NO_PREROLL is how a live source announces itself, and the only thing
     * that tells a stream that can buffer apart from a camera. */
    GstStateChangeReturn r = gst_element_set_state(m->playbin, GST_STATE_PLAYING);

    m->live = (r == GST_STATE_CHANGE_NO_PREROLL);
    return true;
}

static void engine_hold(BtaMedia *m)
{
    if (m->playbin)
        gst_element_set_state(m->playbin, GST_STATE_PAUSED);
}

static void engine_park(BtaMedia *m)
{
    if (m->playbin)
        gst_element_set_state(m->playbin, GST_STATE_NULL);
}

static bool engine_seek(JSContext *ctx, BtaMedia *m, double seconds)
{
    if (!m->playbin || !engine_seekable(m)) {
        JS_ThrowTypeError(ctx, "Seek: this stream cannot seek");
        return false;
    }
    if (!gst_element_seek_simple(m->playbin, GST_FORMAT_TIME, GST_SEEK_FLAG_FLUSH,
                                 (gint64)(seconds * GST_SECOND))) {
        JS_ThrowPlainError(ctx, "Seek: the seek failed");
        return false;
    }
    return true;
}

static void engine_uri(BtaMedia *m)
{
    if (m->playbin && m->uri)
        g_object_set(m->playbin, "uri", m->uri, NULL);
}

static void engine_levels(BtaMedia *m)
{
    if (m->playbin)
        g_object_set(m->playbin, "volume", m->volume, "mute", m->muted, NULL);
}

static double engine_position(BtaMedia *m)
{
    gint64 pos = 0;

    if (m->playbin && gst_element_query_position(m->playbin, GST_FORMAT_TIME, &pos))
        return media_seconds(pos);
    return 0;
}

static double engine_duration(BtaMedia *m)
{
    gint64 dur = GST_CLOCK_TIME_NONE;

    if (m->playbin && gst_element_query_duration(m->playbin, GST_FORMAT_TIME, &dur) &&
        GST_CLOCK_TIME_IS_VALID(dur))
        return media_seconds(dur);
    return -1;
}

static bool engine_seekable(BtaMedia *m)
{
    GstQuery *q  = gst_query_new_seeking(GST_FORMAT_TIME);
    gboolean  ok = FALSE;

    if (m->playbin && gst_element_query(m->playbin, q)) {
        GstFormat fmt = GST_FORMAT_UNDEFINED;

        gst_query_parse_seeking(q, &fmt, &ok, NULL, NULL);
    }
    gst_query_unref(q);
    return ok == TRUE;
}

static void engine_teardown(BtaMedia *m)
{
    /* Before anything else, like ExecJob's guard: a bus message landing on a
     * pipeline being freed is the use-after-free. Removing the watch from
     * inside its own dispatch is safe -- the current message completes. */
    if (m->bus_watch) {
        g_source_remove(m->bus_watch);
        m->bus_watch = 0;
    }
    if (m->playbin) {
        /* The state change is async: unref-ing while it is still in flight
         * finalises the playbin under its own feet (its finalizer touches
         * children being torn down -- two GStreamer-CRITICALs and, on some
         * machines, worse). Wait for NULL first, capped so a wedged network
         * source cannot hold teardown hostage. */
        gst_element_set_state(m->playbin, GST_STATE_NULL);
        gst_element_get_state(m->playbin, NULL, NULL, 2 * GST_SECOND);
        g_clear_object(&m->playbin);
    }
}

/* ========================================================== the graph API
 *
 * `Media.Element` and the three classes behind it, against GStreamer. The
 * rules the players were paid for apply here too: a wrapper owns a reference,
 * teardown waits for NULL before unref-ing, and nothing asks an engine
 * whether it is playing.
 */

static void     elem_signal_marshal(GClosure *closure, GValue *ret,
                                    guint n_params, const GValue *params,
                                    gpointer hint, gpointer md);
static gboolean elem_call_run(gpointer data);
static GstBus  *elem_find_bus(BtaElem *e);
static void     bus_dispatch(BtaBus *b, GstMessage *msg);

/* Defined with the signals, below; the marshal and the idle meet at them. */
typedef struct ElemCall ElemCall;
static void elem_call_invoke(ElemCall *call);
static void elem_call_unref(ElemCall *call);

/*
 * **One watch per bus, and this is the measurement that made it so**: a bus
 * watch pops the messages it sees, so two watches on one bus *split* them --
 * the accounting side and a program's handler took turns, and a program that
 * subscribed to `eos` missed it every other run. The watch is shared: the
 * elements playing on it for their EOS/error accounting, the `Bus` wrappers
 * for their handlers, one `gst_bus_add_watch` underneath.
 *
 * Both lists hold borrowed pointers and are mutated only on the main loop;
 * `dispatch` counts the callback frame, so a teardown that empties the lists
 * from inside a dispatch lets the callback drop the watch, not itself.
 */
typedef struct MediaWatch {
    GstBus *bus;        /* one reference */
    guint   id;         /* the source */
    GList  *elems;      /* BtaElem* playing on this bus, borrowed */
    GList  *buses;      /* BtaBus* subscribed to this bus, borrowed */
    int     dispatch;
} MediaWatch;

static GHashTable *media_watches;   /* GstBus* -> MediaWatch* */

static gboolean media_watch_cb(GstBus *bus, GstMessage *msg, gpointer data);

static MediaWatch *media_watch_for(GstBus *bus, bool create)
{
    MediaWatch *w;

    if (!media_watches) {
        if (!create)
            return NULL;
        media_watches = g_hash_table_new(g_direct_hash, g_direct_equal);
    }
    w = g_hash_table_lookup(media_watches, bus);
    if (!w && create) {
        w       = g_new0(MediaWatch, 1);
        w->bus  = gst_object_ref(bus);
        w->id   = gst_bus_add_watch(bus, media_watch_cb, w);
        g_hash_table_insert(media_watches, w->bus, w);
    }
    return w;
}

/* Only when both lists are empty and no frame is dispatching. Removing the
 * source from inside its own dispatch is safe (engine_teardown's note). */
static void media_watch_release(MediaWatch *w)
{
    if (w->dispatch || w->elems || w->buses)
        return;
    if (w->id)
        g_source_remove(w->id);
    g_hash_table_remove(media_watches, w->bus);
    gst_object_unref(w->bus);
    g_free(w);
}

static void elem_watch_join(BtaElem *e)
{
    GstBus     *bus = elem_find_bus(e);
    MediaWatch *w;

    if (!bus)
        return;
    w = media_watch_for(bus, TRUE);
    gst_object_unref(bus);
    if (!g_list_find(w->elems, e))
        w->elems = g_list_prepend(w->elems, e);
}

static void elem_watch_leave(BtaElem *e)
{
    MediaWatch *w;
    GstBus     *bus;

    if (!media_watches || !e->element)
        return;
    bus = elem_find_bus(e);
    if (!bus)
        return;
    w = media_watch_for(bus, FALSE);
    gst_object_unref(bus);
    if (!w)
        return;
    w->elems = g_list_remove(w->elems, e);
    media_watch_release(w);
}

static void bus_watch_join(BtaBus *b)
{
    MediaWatch *w = media_watch_for(b->bus, TRUE);

    if (!g_list_find(w->buses, b))
        w->buses = g_list_prepend(w->buses, b);
}

static void bus_watch_leave(BtaBus *b)
{
    MediaWatch *w;

    if (!media_watches)
        return;
    w = media_watch_for(b->bus, FALSE);
    if (!w)
        return;
    w->buses = g_list_remove(w->buses, b);
    media_watch_release(w);
}

struct MediaHeld { JSContext *ctx; JSValue value; };

/* The one watch. Accounting runs first and only collects -- the keepalive
 * JSValues are freed *after* the program's handlers have run, because
 * dropping one may finalise the wrapper it belongs to, and nothing may do
 * that under a list walk. */
static gboolean media_watch_cb(GstBus *gstbus, GstMessage *msg, gpointer data)
{
    MediaWatch      *w    = data;
    GstMessageType   type = GST_MESSAGE_TYPE(msg);
    GArray          *held = NULL;
    GList           *leaving = NULL;

    (void)gstbus;
    w->dispatch++;

    if (w->elems && (type == GST_MESSAGE_EOS || type == GST_MESSAGE_ERROR)) {
        for (GList *l = w->elems; l; l = l->next) {
            BtaElem *e = l->data;

            if (e->dead || !e->hold_play)
                continue;
            e->hold_play = false;
            if (type == GST_MESSAGE_ERROR && e->element)
                gst_element_set_state(e->element, GST_STATE_NULL);
            if (!e->hold_subs && !JS_IsUndefined(e->self) && e->ctx) {
                struct MediaHeld h = { e->ctx, e->self };

                if (!held)
                    held = g_array_new(FALSE, FALSE, sizeof h);
                e->self = JS_UNDEFINED;
                g_array_append_val(held, h);
            }
            leaving = g_list_prepend(leaving, e);
        }
    }
    for (GList *l = w->buses; l; ) {
        GList  *next = l->next;
        BtaBus *b    = l->data;

        bus_dispatch(b, msg);   /* may finalise `b`; `next` was read first */
        l = next;
    }
    if (leaving) {
        for (GList *l = leaving; l; l = l->next)
            elem_watch_leave(l->data);
        g_list_free(leaving);
    }
    if (held) {
        for (guint i = 0; i < held->len; i++) {
            struct MediaHeld *h = &g_array_index(held, struct MediaHeld, i);

            JS_FreeValue(h->ctx, h->value);
        }
        g_array_free(held, TRUE);
    }
    w->dispatch--;
    media_watch_release(w);     /* the last line: it may free w */
    return TRUE;
}

static JSValue elem_wrap_owned(JSContext *ctx, GstElement *element)
{
    JSValue proto = JS_GetClassProto(ctx, element_class_id);
    JSValue obj   = JS_NewObjectProtoClass(ctx, proto, element_class_id);

    JS_FreeValue(ctx, proto);
    if (JS_IsException(obj)) {
        gst_object_unref(element);
        return obj;
    }

    BtaElem *e = g_new0(BtaElem, 1);

    e->ctx     = ctx;
    e->element = element;   /* the reference is taken, not shared */
    e->state   = GST_STATE_NULL;
    e->self    = JS_UNDEFINED;
    elements_live = g_list_prepend(elements_live, e);
    JS_SetOpaque(obj, e);
    return obj;
}

static JSValue pad_wrap_owned(JSContext *ctx, GstPad *pad)
{
    JSValue proto = JS_GetClassProto(ctx, pad_class_id);
    JSValue obj   = JS_NewObjectProtoClass(ctx, proto, pad_class_id);

    JS_FreeValue(ctx, proto);
    if (JS_IsException(obj)) {
        gst_object_unref(pad);
        return obj;
    }

    BtaPad *p = g_new0(BtaPad, 1);

    p->ctx = ctx;
    p->pad = pad;
    JS_SetOpaque(obj, p);
    return obj;
}

static JSValue bus_wrap_owned(JSContext *ctx, GstBus *bus)
{
    JSValue proto = JS_GetClassProto(ctx, bus_class_id);
    JSValue obj   = JS_NewObjectProtoClass(ctx, proto, bus_class_id);

    JS_FreeValue(ctx, proto);
    if (JS_IsException(obj)) {
        gst_object_unref(bus);
        return obj;
    }

    BtaBus *b = g_new0(BtaBus, 1);

    b->ctx  = ctx;
    b->bus  = bus;
    b->self = JS_UNDEFINED;
    for (int i = 0; i < (int)G_N_ELEMENTS(MEDIA_BUS_TYPES); i++)
        b->handlers[i] = JS_UNDEFINED;
    buses_live = g_list_prepend(buses_live, b);
    JS_SetOpaque(obj, b);
    return obj;
}

static bool state_index(JSContext *ctx, JSValueConst val, int *out)
{
    const char *name = JS_ToCString(ctx, val);

    if (!name)
        return false;
    for (int i = GST_STATE_NULL; i <= GST_STATE_PLAYING; i++) {
        if (!g_ascii_strcasecmp(name, MEDIA_STATES[i])) {
            *out = i;
            JS_FreeCString(ctx, name);
            return true;
        }
    }
    JS_ThrowRangeError(ctx, "State: '%s' is not Null, Ready, Paused or Playing",
                       name);
    JS_FreeCString(ctx, name);
    return false;
}

/* The bus of the pipeline this element is in. **Not `gst_element_get_bus`**:
 * measured, a child's own call answers the bin's internal child bus -- a
 * different object nothing is posted to the application's side of. The walk
 * goes up to the first pipeline, which is the one that owns the bus. */
static GstBus *elem_find_bus(BtaElem *e)
{
    GstObject *node = gst_object_ref(GST_OBJECT(e->element));
    GstBus    *bus  = NULL;

    while (node && !GST_IS_PIPELINE(node)) {
        GstObject *up = gst_object_get_parent(node);

        gst_object_unref(node);
        node = up;
    }
    if (node) {
        bus = gst_pipeline_get_bus(GST_PIPELINE(node));
        gst_object_unref(node);
    }
    return bus;
}

static bool element_has_sometimes(GstElement *element)
{
    GList *templates = gst_element_class_get_pad_template_list(
                           GST_ELEMENT_GET_CLASS(element));

    for (GList *l = templates; l; l = l->next) {
        if (GST_PAD_TEMPLATE_PRESENCE(l->data) == GST_PAD_SOMETIMES)
            return true;
    }
    return false;
}

static JSValue elem_refuse_value(JSContext *ctx, const char *name, GType type)
{
    return JS_ThrowPlainError(ctx,
        "'%s' holds a %s, and this surface carries no such value",
        name, g_type_name(type));
}

/* A property, by name, converted to the GValue the class wants. Everything is
 * refused loudly: the silence of `gst_util_set_object_arg` -- gst-launch's
 * own setter, measured as a no-op for a name or a text it does not know -- is
 * the one thing this cannot borrow. */
static JSValue elem_store(JSContext *ctx, BtaElem *e, const char *name,
                          JSValueConst val)
{
    GObjectClass *klass = G_OBJECT_GET_CLASS(e->element);
    GParamSpec   *ps    = g_object_class_find_property(klass, name);
    GType         type;
    GValue        gval = G_VALUE_INIT;
    JSValue       r    = JS_UNDEFINED;

    if (!ps)
        return JS_ThrowPlainError(ctx, "there is no property '%s' on a %s",
                                  name, G_OBJECT_TYPE_NAME(e->element));
    if (!(ps->flags & G_PARAM_WRITABLE))
        return JS_ThrowPlainError(ctx, "the property '%s' is read-only", name);
    if (ps->flags & G_PARAM_CONSTRUCT_ONLY)
        return JS_ThrowPlainError(ctx,
            "'%s' can only be given where the element is made -- pass it in "
            "the table of Media.Element", name);

    type = G_PARAM_SPEC_VALUE_TYPE(ps);
    g_value_init(&gval, type);

    if (type == G_TYPE_BOOLEAN) {
        g_value_set_boolean(&gval, JS_ToBool(ctx, val) > 0);
    } else if (type == G_TYPE_INT) {
        gint32 n;

        if (!bta_to_int(ctx, val, name, &n)) {
            r = JS_EXCEPTION;
            goto out;
        }
        GParamSpecInt *nps = G_PARAM_SPEC_INT(ps);

        if (n < nps->minimum || n > nps->maximum) {
            r = JS_ThrowRangeError(ctx, "'%s' runs from %d to %d",
                                   name, nps->minimum, nps->maximum);
            goto out;
        }
        g_value_set_int(&gval, n);
    } else if (type == G_TYPE_UINT) {
        gint32 n;

        if (!bta_to_int(ctx, val, name, &n)) {
            r = JS_EXCEPTION;
            goto out;
        }
        GParamSpecUInt *nps = G_PARAM_SPEC_UINT(ps);

        if (n < 0 || (guint)n > nps->maximum) {
            r = JS_ThrowRangeError(ctx, "'%s' runs from %u to %u",
                                   name, nps->minimum, nps->maximum);
            goto out;
        }
        g_value_set_uint(&gval, (guint)n);
    } else if (type == G_TYPE_INT64 || type == G_TYPE_UINT64) {
        double d;

        if (!bta_to_number(ctx, val, name, &d)) {
            r = JS_EXCEPTION;
            goto out;
        }
        if (d > 9007199254740992.0 || d < -9007199254740992.0 ||
            d != (double)(gint64)d || (type == G_TYPE_UINT64 && d < 0)) {
            r = JS_ThrowPlainError(ctx,
                "'%s' takes a whole 64-bit number up to 2^53", name);
            goto out;
        }
        if (type == G_TYPE_INT64)
            g_value_set_int64(&gval, (gint64)d);
        else
            g_value_set_uint64(&gval, (guint64)d);
    } else if (type == G_TYPE_FLOAT || type == G_TYPE_DOUBLE) {
        double d;

        if (!bta_to_number(ctx, val, name, &d)) {
            r = JS_EXCEPTION;
            goto out;
        }
        if (type == G_TYPE_FLOAT)
            g_value_set_float(&gval, (gfloat)d);
        else
            g_value_set_double(&gval, d);
    } else if (type == G_TYPE_STRING) {
        size_t      len = 0;
        const char *s   = JS_ToCStringLen(ctx, &len, val);

        if (!s) {
            r = JS_EXCEPTION;
            goto out;
        }
        if (strlen(s) != len) {
            JS_FreeCString(ctx, s);
            r = JS_ThrowPlainError(ctx,
                "'%s' cannot hold a NUL in the middle", name);
            goto out;
        }
        g_value_set_string(&gval, s);
        JS_FreeCString(ctx, s);
    } else if (G_TYPE_IS_ENUM(type)) {
        const char *nick = JS_ToCString(ctx, val);
        GEnumClass *ec;
        GEnumValue *ev;

        if (!nick) {
            r = JS_EXCEPTION;
            goto out;
        }
        ec = g_type_class_ref(type);
        ev = g_enum_get_value_by_nick(ec, nick);
        if (!ev) {
            GString *all = g_string_new(NULL);

            for (guint i = 0; i < ec->n_values; i++) {
                if (all->len)
                    g_string_append(all, ", ");
                g_string_append(all, ec->values[i].value_nick);
            }
            r = JS_ThrowRangeError(ctx, "'%s' does not take '%s' -- one of %s",
                                   name, nick, all->str);
            g_string_free(all, TRUE);
        } else {
            g_value_set_enum(&gval, ev->value);
        }
        g_type_class_unref(ec);
        JS_FreeCString(ctx, nick);
        if (JS_IsException(r))
            goto out;
    } else if (G_TYPE_IS_FLAGS(type)) {
        const char  *text  = JS_ToCString(ctx, val);
        GFlagsClass *fc;
        gchar      **parts;
        guint        bits  = 0;
        bool         bad   = false;

        if (!text) {
            r = JS_EXCEPTION;
            goto out;
        }
        fc    = g_type_class_ref(type);
        parts = g_strsplit(text, "+", -1);
        for (int i = 0; parts[i] && !bad; i++) {
            gchar       *piece = g_strstrip(parts[i]);
            GFlagsValue *fv    = g_flags_get_value_by_nick(fc, piece);

            if (!fv) {
                GString *all = g_string_new(NULL);

                for (guint j = 0; j < fc->n_values; j++) {
                    if (all->len)
                        g_string_append(all, ", ");
                    g_string_append(all, fc->values[j].value_nick);
                }
                r = JS_ThrowRangeError(ctx,
                    "'%s' does not take '%s' -- flag names joined by +: %s",
                    name, piece, all->str);
                g_string_free(all, TRUE);
                bad = true;
            } else {
                bits |= fv->value;
            }
        }
        g_strfreev(parts);
        g_type_class_unref(fc);
        JS_FreeCString(ctx, text);
        if (bad)
            goto out;
        g_value_set_flags(&gval, bits);
    } else if (type == GST_TYPE_FRACTION) {
        const char *text = JS_ToCString(ctx, val);

        if (!text) {
            r = JS_EXCEPTION;
            goto out;
        }
        if (!gst_value_deserialize(&gval, text))
            r = JS_ThrowPlainError(ctx,
                "'%s' takes a fraction like 30/1, not '%s'", name, text);
        JS_FreeCString(ctx, text);
        if (JS_IsException(r))
            goto out;
    } else if (type == GST_TYPE_CAPS) {
        const char *text = JS_ToCString(ctx, val);
        GstCaps    *caps;

        if (!text) {
            r = JS_EXCEPTION;
            goto out;
        }
        caps = gst_caps_from_string(text);
        if (!caps || gst_caps_is_empty(caps)) {
            if (caps)
                gst_caps_unref(caps);
            r = JS_ThrowPlainError(ctx,
                "'%s' takes caps text like video/x-raw, not '%s'", name, text);
        } else {
            g_value_take_boxed(&gval, caps);
        }
        JS_FreeCString(ctx, text);
        if (JS_IsException(r))
            goto out;
    } else {
        r = elem_refuse_value(ctx, name, type);
        goto out;
    }

    g_object_set_property(G_OBJECT(e->element), name, &gval);
out:
    g_value_unset(&gval);
    return r;
}

/* The reading road, in the spellings `Set` takes: built from the class, not
 * from `gst_value_serialize` -- measured, that one answers caps in the
 * escaped launch form and flags by their long name. */
static JSValue elem_load(JSContext *ctx, BtaElem *e, const char *name)
{
    GObjectClass *klass = G_OBJECT_GET_CLASS(e->element);
    GParamSpec   *ps    = g_object_class_find_property(klass, name);
    GType         type;
    GValue        gval = G_VALUE_INIT;
    JSValue       r;

    if (!ps)
        return JS_ThrowPlainError(ctx, "there is no property '%s' on a %s",
                                  name, G_OBJECT_TYPE_NAME(e->element));
    if (!(ps->flags & G_PARAM_READABLE))
        return JS_ThrowPlainError(ctx, "the property '%s' is write-only", name);

    type = G_PARAM_SPEC_VALUE_TYPE(ps);
    g_value_init(&gval, type);
    g_object_get_property(G_OBJECT(e->element), name, &gval);

    if (type == G_TYPE_BOOLEAN) {
        r = JS_NewBool(ctx, g_value_get_boolean(&gval));
    } else if (type == G_TYPE_INT) {
        r = JS_NewInt32(ctx, g_value_get_int(&gval));
    } else if (type == G_TYPE_UINT) {
        r = JS_NewUint32(ctx, g_value_get_uint(&gval));
    } else if (type == G_TYPE_INT64) {
        gint64 v = g_value_get_int64(&gval);

        if (v > 9007199254740992LL || v < -9007199254740992LL)
            r = JS_ThrowPlainError(ctx,
                "'%s' is a 64-bit value past 2^53, which a number here cannot "
                "carry", name);
        else
            r = JS_NewInt64(ctx, v);
    } else if (type == G_TYPE_UINT64) {
        guint64 v = g_value_get_uint64(&gval);

        if (v > 9007199254740992ULL)
            r = JS_ThrowPlainError(ctx,
                "'%s' is a 64-bit value past 2^53, which a number here cannot "
                "carry", name);
        else
            r = JS_NewInt64(ctx, (int64_t)v);
    } else if (type == G_TYPE_FLOAT) {
        r = JS_NewFloat64(ctx, g_value_get_float(&gval));
    } else if (type == G_TYPE_DOUBLE) {
        r = JS_NewFloat64(ctx, g_value_get_double(&gval));
    } else if (type == G_TYPE_STRING) {
        const gchar *s = g_value_get_string(&gval);

        r = JS_NewString(ctx, s ? s : "");
    } else if (G_TYPE_IS_ENUM(type)) {
        GEnumClass *ec = g_type_class_peek(type);
        GEnumValue *ev = g_enum_get_value(ec, g_value_get_enum(&gval));

        r = JS_NewString(ctx, (ev && ev->value_nick[0]) ? ev->value_nick : "?");
    } else if (G_TYPE_IS_FLAGS(type)) {
        GFlagsClass *fc = g_type_class_peek(type);
        guint        v  = g_value_get_flags(&gval);
        GString     *s  = g_string_new(NULL);

        for (guint i = 0; i < fc->n_values; i++) {
            GFlagsValue *fv = &fc->values[i];

            if (fv->value && fv->value_nick[0] &&
                (v & fv->value) == fv->value) {
                if (s->len)
                    g_string_append_c(s, '+');
                g_string_append(s, fv->value_nick);
                v &= ~fv->value;
            }
        }
        if (v) {
            gchar *rest = g_strdup_printf("%s0x%x", s->len ? "+" : "", v);

            g_string_append(s, rest);
            g_free(rest);
        }
        r = JS_NewString(ctx, s->str);
        g_string_free(s, TRUE);
    } else if (type == GST_TYPE_FRACTION) {
        gchar *text = g_strdup_printf("%d/%d",
                                      gst_value_get_fraction_numerator(&gval),
                                      gst_value_get_fraction_denominator(&gval));

        r = JS_NewString(ctx, text);
        g_free(text);
    } else if (type == GST_TYPE_CAPS) {
        GstCaps *caps = g_value_get_boxed(&gval);

        if (!caps || gst_caps_is_empty(caps)) {
            r = JS_NewString(ctx, "");
        } else {
            gchar *text = gst_caps_to_string(caps);

            r = JS_NewString(ctx, text);
            g_free(text);
        }
    } else {
        r = elem_refuse_value(ctx, name, type);
    }

    g_value_unset(&gval);
    return r;
}

static JSValue media_element(JSContext *ctx, JSValueConst this_val, int argc,
                             JSValueConst *argv)
{
    const char *type;
    GstElement *el;
    JSValue     obj;

    (void)this_val;
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "Element expects (type, [properties])");
    type = JS_ToCString(ctx, argv[0]);
    if (!type)
        return JS_EXCEPTION;

    /* Lazily, like the players (engine_ensure): the registry is not there
     * before this, and everything else under `Media` needs an element first. */
    if (!gst_is_initialized())
        gst_init(NULL, NULL);

    el = gst_element_factory_make(type, NULL);
    if (!el) {
        JSValue r = JS_ThrowPlainError(ctx,
            "there is no element type '%s': its plugin is not installed, or "
            "the name is misspelled -- gst-inspect-1.0 lists what is here",
            type);

        JS_FreeCString(ctx, type);
        return r;
    }
    JS_FreeCString(ctx, type);

    obj = elem_wrap_owned(ctx, gst_object_ref_sink(el));
    if (JS_IsException(obj))
        return obj;

    if (argc > 1 && !JS_IsUndefined(argv[1]) && !JS_IsNull(argv[1])) {
        BtaElem        *e   = JS_GetOpaque(obj, element_class_id);
        JSPropertyEnum *tab = NULL;
        uint32_t        len = 0;
        JSValue         err = JS_UNDEFINED;

        if (!JS_IsObject(argv[1])) {
            err = JS_ThrowTypeError(ctx,
                "Element: the second argument is a table of properties");
        } else if (JS_GetOwnPropertyNames(ctx, &tab, &len, argv[1],
                                          JS_GPN_STRING_MASK |
                                          JS_GPN_ENUM_ONLY) < 0) {
            err = JS_EXCEPTION;
        } else {
            for (uint32_t i = 0; i < len && !JS_IsException(err); i++) {
                const char *name = JS_AtomToCString(ctx, tab[i].atom);
                JSValue     val;

                if (!name) {
                    err = JS_EXCEPTION;
                    break;
                }
                val = JS_GetProperty(ctx, argv[1], tab[i].atom);
                if (JS_IsException(val)) {
                    err = JS_EXCEPTION;
                } else {
                    err = elem_store(ctx, e, name, val);   /* undefined or throw */
                    JS_FreeValue(ctx, val);
                }
                JS_FreeCString(ctx, name);
            }
            for (uint32_t i = 0; i < len; i++)
                JS_FreeAtom(ctx, tab[i].atom);
            js_free(ctx, tab);
        }
        if (JS_IsException(err)) {
            JS_FreeValue(ctx, obj);
            return err;
        }
    }
    return obj;
}

static JSValue elem_set(JSContext *ctx, JSValueConst this_val, int argc,
                        JSValueConst *argv)
{
    BtaElem    *e = elem_this(ctx, this_val);
    const char *name;
    JSValue     r;

    if (!e)
        return JS_EXCEPTION;
    if (argc < 2)
        return JS_ThrowTypeError(ctx, "Set expects (name, value)");
    name = JS_ToCString(ctx, argv[0]);
    if (!name)
        return JS_EXCEPTION;
    r = elem_store(ctx, e, name, argv[1]);
    JS_FreeCString(ctx, name);
    return r;
}

static JSValue elem_get(JSContext *ctx, JSValueConst this_val, int argc,
                        JSValueConst *argv)
{
    BtaElem    *e = elem_this(ctx, this_val);
    const char *name;
    JSValue     r;

    if (!e)
        return JS_EXCEPTION;
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "Get expects (name)");
    name = JS_ToCString(ctx, argv[0]);
    if (!name)
        return JS_EXCEPTION;
    r = elem_load(ctx, e, name);
    JS_FreeCString(ctx, name);
    return r;
}

static JSValue elem_add(JSContext *ctx, JSValueConst this_val, int argc,
                        JSValueConst *argv)
{
    BtaElem   *bin = elem_this(ctx, this_val);
    BtaElem   *child;
    GstObject *parent;

    if (!bin)
        return JS_EXCEPTION;
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "Add expects (child)");
    child = JS_GetOpaque(argv[0], element_class_id);
    if (!child || child->dead)
        return JS_ThrowTypeError(ctx, "Add: the argument is not an Element");
    if (child == bin)
        return JS_ThrowPlainError(ctx, "Add: '%s' cannot go into itself",
                                  GST_OBJECT_NAME(bin->element));
    if (!GST_IS_BIN(bin->element))
        return JS_ThrowPlainError(ctx,
            "Add: a %s is not a bin or a pipeline -- only those take children",
            G_OBJECT_TYPE_NAME(bin->element));
    parent = gst_object_get_parent(GST_OBJECT(child->element));
    if (parent) {
        JSValue r = JS_ThrowPlainError(ctx, "Add: '%s' is already in '%s'",
                                       GST_OBJECT_NAME(child->element),
                                       GST_OBJECT_NAME(parent));

        gst_object_unref(parent);
        return r;
    }
    if (!gst_bin_add(GST_BIN(bin->element), child->element))
        return JS_ThrowPlainError(ctx,
            "Add: '%s' cannot go into '%s'", GST_OBJECT_NAME(child->element),
            GST_OBJECT_NAME(bin->element));

    /* The state, which gst_bin_add leaves to the caller: measured, a child
     * added to a PLAYING pipeline stays in NULL until this. */
    gst_element_sync_state_with_parent(child->element);
    return JS_DupValue(ctx, argv[0]);
}

static JSValue elem_link(JSContext *ctx, JSValueConst this_val, int argc,
                         JSValueConst *argv)
{
    BtaElem    *a = elem_this(ctx, this_val);
    BtaElem    *b;
    const char *from = NULL;
    const char *to   = NULL;
    GstObject  *pa;
    GstObject  *pb;
    gboolean    ok;
    JSValue     r = JS_UNDEFINED;

    if (!a)
        return JS_EXCEPTION;
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "Link expects (other, [from], [to])");
    b = JS_GetOpaque(argv[0], element_class_id);
    if (!b || b->dead)
        return JS_ThrowTypeError(ctx, "Link: the argument is not an Element");
    if (argc > 1 && !JS_IsUndefined(argv[1]) && !JS_IsNull(argv[1])) {
        from = JS_ToCString(ctx, argv[1]);
        if (!from)
            return JS_EXCEPTION;
    }
    if (argc > 2 && !JS_IsUndefined(argv[2]) && !JS_IsNull(argv[2])) {
        to = JS_ToCString(ctx, argv[2]);
        if (!to) {
            JS_FreeCString(ctx, from);
            return JS_EXCEPTION;
        }
    }

    /* Both must be in one pipeline already: measured in the source, the add
     * that follows a free link unlinks the pads, in silence. */
    pa = gst_object_get_parent(GST_OBJECT(a->element));
    pb = gst_object_get_parent(GST_OBJECT(b->element));
    if (!pa || !pb) {
        r = JS_ThrowPlainError(ctx,
            "Link: '%s' and '%s' must both be in one pipeline first -- "
            "adding an element to a bin unlinks its pads",
            GST_OBJECT_NAME(a->element), GST_OBJECT_NAME(b->element));
    } else if (pa != pb) {
        r = JS_ThrowPlainError(ctx, "Link: '%s' and '%s' are in different pipelines",
                               GST_OBJECT_NAME(a->element),
                               GST_OBJECT_NAME(b->element));
    } else {
        ok = gst_element_link_pads(a->element, from, b->element, to);
        if (!ok) {
            gchar *hint = NULL;

            if (element_has_sometimes(a->element))
                hint = g_strdup_printf("%s's pads appear when the stream starts "
                                       "-- subscribe with On(\"pad-added\") and "
                                       "link there", GST_OBJECT_NAME(a->element));
            else if (element_has_sometimes(b->element))
                hint = g_strdup_printf("%s's pads appear when the stream starts "
                                       "-- subscribe with On(\"pad-added\") and "
                                       "link there", GST_OBJECT_NAME(b->element));
            if (hint) {
                r = JS_ThrowPlainError(ctx, "Link: '%s' and '%s' cannot meet: %s",
                                       GST_OBJECT_NAME(a->element),
                                       GST_OBJECT_NAME(b->element), hint);
                g_free(hint);
            } else {
                r = JS_ThrowPlainError(ctx, "Link: '%s' and '%s' have no pads "
                                       "that meet",
                                       GST_OBJECT_NAME(a->element),
                                       GST_OBJECT_NAME(b->element));
            }
        }
    }
    if (pa)
        gst_object_unref(pa);
    if (pb)
        gst_object_unref(pb);
    JS_FreeCString(ctx, from);
    JS_FreeCString(ctx, to);
    if (JS_IsException(r))
        return r;
    return JS_DupValue(ctx, argv[0]);
}

static JSValue elem_pad(JSContext *ctx, JSValueConst this_val, int argc,
                        JSValueConst *argv)
{
    BtaElem    *e = elem_this(ctx, this_val);
    const char *name;
    GstPad     *pad;

    if (!e)
        return JS_EXCEPTION;
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "Pad expects (name)");
    name = JS_ToCString(ctx, argv[0]);
    if (!name)
        return JS_EXCEPTION;
    pad = gst_element_get_static_pad(e->element, name);
    JS_FreeCString(ctx, name);
    if (!pad)
        return JS_NULL;
    return pad_wrap_owned(ctx, pad);
}

static JSValue elem_eos(JSContext *ctx, JSValueConst this_val, int argc,
                        JSValueConst *argv)
{
    BtaElem *e = elem_this(ctx, this_val);

    (void)argc; (void)argv;
    if (!e)
        return JS_EXCEPTION;
    if (!gst_element_send_event(e->element, gst_event_new_eos()))
        return JS_ThrowPlainError(ctx,
            "Eos: '%s' cannot take an end-of-stream yet -- nothing has "
            "started", GST_OBJECT_NAME(e->element));
    return JS_UNDEFINED;
}

static JSValue elem_get_state(JSContext *ctx, JSValueConst this_val)
{
    BtaElem *e = elem_this(ctx, this_val);

    if (!e)
        return JS_EXCEPTION;
    return JS_NewString(ctx, MEDIA_STATES[e->state]);
}

/* The accounting is not its own watch: an element playing joins the shared
 * one for its bus, and EOS or an error takes it out again (`media_watch_cb`).
 * Keeping two watches on one bus splits the messages between them, which is
 * how this was found. */
static JSValue elem_set_state(JSContext *ctx, JSValueConst this_val,
                              JSValueConst val)
{
    BtaElem *e = elem_this(ctx, this_val);
    int      idx;

    if (!e)
        return JS_EXCEPTION;
    if (!state_index(ctx, val, &idx))
        return JS_EXCEPTION;

    gst_element_set_state(e->element, (GstState)idx);
    e->state = idx;
    if (idx != GST_STATE_NULL)
        e->asked = true;

    /* Playing is a claim on the program's life -- the players' `wants`.
     * Everything else is a deliberate hold. An element in no pipeline has
     * no bus and holds nothing: there is no answer it could be owed. */
    if (idx == GST_STATE_PLAYING) {
        GstBus *bus = elem_find_bus(e);

        if (bus) {
            gst_object_unref(bus);
            elem_watch_join(e);
            e->hold_play = true;
            elem_hold_self(ctx, e, this_val);
            return JS_UNDEFINED;
        }
    } else if (e->hold_play) {
        elem_watch_leave(e);
    }
    e->hold_play = false;
    elem_release_if_idle(e);   /* the last line: it may finalise e */
    return JS_UNDEFINED;
}

static JSValue elem_get_bus(JSContext *ctx, JSValueConst this_val)
{
    BtaElem *e = elem_this(ctx, this_val);
    GstBus  *bus;

    if (!e)
        return JS_EXCEPTION;
    bus = elem_find_bus(e);
    if (!bus)
        return JS_NULL;
    return bus_wrap_owned(ctx, bus);
}

/* ---------------------------------------------------------------- a pad */

static JSValue pad_get_name(JSContext *ctx, JSValueConst this_val)
{
    BtaPad *p = pad_this(ctx, this_val);

    if (!p)
        return JS_EXCEPTION;
    return JS_NewString(ctx, GST_OBJECT_NAME(p->pad));
}

static JSValue pad_get_caps(JSContext *ctx, JSValueConst this_val)
{
    BtaPad  *p = pad_this(ctx, this_val);
    GstCaps *caps;
    gchar   *text;
    JSValue  r;

    if (!p)
        return JS_EXCEPTION;
    caps = gst_pad_query_caps(p->pad, NULL);
    if (!caps || gst_caps_is_empty(caps)) {
        if (caps)
            gst_caps_unref(caps);
        return JS_NewString(ctx, "");
    }
    text = gst_caps_to_string(caps);
    r    = JS_NewString(ctx, text);
    g_free(text);
    gst_caps_unref(caps);
    return r;
}

/* Linking a pad: to another pad directly, or to an element -- in which case
 * a compatible pad is found for it, or requested from a template
 * (`gst_element_get_compatible_pad` does both). The failure says which of
 * GStreamer's reasons it was, in words. */
static JSValue pad_link(JSContext *ctx, JSValueConst this_val, int argc,
                        JSValueConst *argv)
{
    BtaPad         *p = pad_this(ctx, this_val);
    BtaPad         *tp;
    BtaElem        *te;
    GstPad         *far;
    bool            owned = false;
    GstPadLinkReturn ret;
    JSValue          r = JS_UNDEFINED;

    if (!p)
        return JS_EXCEPTION;
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "Link expects (target)");

    tp = JS_GetOpaque(argv[0], pad_class_id);
    if (tp && !tp->dead) {
        far = tp->pad;
    } else {
        te = JS_GetOpaque(argv[0], element_class_id);
        if (!te || te->dead)
            return JS_ThrowTypeError(ctx,
                "Link: the argument is not a Pad or an Element");
        far = gst_element_get_compatible_pad(te->element, p->pad, NULL);
        if (!far)
            return JS_ThrowPlainError(ctx,
                "Link: there is no pad on '%s' that can take '%s'",
                GST_OBJECT_NAME(te->element), GST_OBJECT_NAME(p->pad));
        owned = true;
    }

    ret = gst_pad_link(p->pad, far);
    switch (ret) {
    case GST_PAD_LINK_OK:
        break;
    case GST_PAD_LINK_WRONG_HIERARCHY:
        r = JS_ThrowPlainError(ctx,
            "Link: '%s' and '%s' are not in the same pipeline",
            GST_OBJECT_NAME(p->pad), GST_OBJECT_NAME(far));
        break;
    case GST_PAD_LINK_WAS_LINKED:
        r = JS_ThrowPlainError(ctx, "Link: '%s' is already linked",
                               GST_OBJECT_NAME(p->pad));
        break;
    case GST_PAD_LINK_WRONG_DIRECTION:
        r = JS_ThrowPlainError(ctx, "Link: '%s' and '%s' face the same way",
                               GST_OBJECT_NAME(p->pad), GST_OBJECT_NAME(far));
        break;
    case GST_PAD_LINK_NOFORMAT:
        r = JS_ThrowPlainError(ctx,
            "Link: '%s' and '%s' have no format that meets",
            GST_OBJECT_NAME(p->pad), GST_OBJECT_NAME(far));
        break;
    case GST_PAD_LINK_NOSCHED:
        r = JS_ThrowPlainError(ctx,
            "Link: '%s' and '%s' have no scheduling in common",
            GST_OBJECT_NAME(p->pad), GST_OBJECT_NAME(far));
        break;
    default:
        r = JS_ThrowPlainError(ctx, "Link: '%s' refused '%s'",
                               GST_OBJECT_NAME(far), GST_OBJECT_NAME(p->pad));
        break;
    }
    if (JS_IsException(r)) {
        if (owned)
            gst_object_unref(far);
        return r;
    }
    /* The far pad, holding a reference of its own either way. */
    return pad_wrap_owned(ctx, owned ? far : gst_object_ref(far));
}

/* ------------------------------------------------------------- signals */

static bool elem_signal_ok(JSContext *ctx, BtaElem *e, const char *name)
{
    guint       sig = g_signal_lookup(name, G_OBJECT_TYPE(e->element));
    GSignalQuery q;

    if (!sig) {
        for (guint i = 0; i < G_N_ELEMENTS(MEDIA_BUS_TYPES); i++) {
            if (!strcmp(name, MEDIA_BUS_TYPES[i])) {
                JS_ThrowPlainError(ctx,
                    "a %s has no signal '%s' -- that is a bus message: "
                    "subscribe with Bus.On", G_OBJECT_TYPE_NAME(e->element),
                    name);
                return false;
            }
        }
        JS_ThrowPlainError(ctx, "a %s has no signal '%s'",
                           G_OBJECT_TYPE_NAME(e->element), name);
        return false;
    }
    g_signal_query(sig, &q);
    if (!q.signal_id) {
        JS_ThrowPlainError(ctx, "a %s has no signal '%s'",
                           G_OBJECT_TYPE_NAME(e->element), name);
        return false;
    }
    if (q.return_type != G_TYPE_NONE) {
        JS_ThrowPlainError(ctx,
            "'%s' on a %s answers a value, and a handler here cannot answer "
            "-- subscribe to a signal that returns nothing",
            name, G_OBJECT_TYPE_NAME(e->element));
        return false;
    }
    for (guint i = 0; i < q.n_params; i++) {
        GType t = q.param_types[i];

        if (t == G_TYPE_BOOLEAN || t == G_TYPE_INT || t == G_TYPE_UINT ||
            t == G_TYPE_INT64 || t == G_TYPE_UINT64 || t == G_TYPE_FLOAT ||
            t == G_TYPE_DOUBLE || t == G_TYPE_STRING || t == GST_TYPE_PAD ||
            t == GST_TYPE_ELEMENT || t == GST_TYPE_CAPS)
            continue;
        JS_ThrowPlainError(ctx,
            "'%s' on a %s hands over a %s, and this surface carries no such "
            "value", name, G_OBJECT_TYPE_NAME(e->element), g_type_name(t));
        return false;
    }
    return true;
}

static JSValue elem_on(JSContext *ctx, JSValueConst this_val, int argc,
                       JSValueConst *argv)
{
    BtaElem    *e = elem_this(ctx, this_val);
    const char *name;
    ElemSub    *sub;

    if (!e)
        return JS_EXCEPTION;
    if (argc < 2)
        return JS_ThrowTypeError(ctx, "On expects (signal, handler)");
    name = JS_ToCString(ctx, argv[0]);
    if (!name)
        return JS_EXCEPTION;

    if (!e->signals)
        e->signals = g_hash_table_new_full(g_str_hash, g_str_equal, NULL, NULL);

    sub = g_hash_table_lookup(e->signals, name);
    if (JS_IsNull(argv[1]) || JS_IsUndefined(argv[1])) {
        JSValue ret = JS_DupValue(ctx, this_val);

        if (sub) {
            if (sub->id)
                g_signal_handler_disconnect(e->element, sub->id);
            sub->id   = 0;
            sub->elem = NULL;   /* a delivery on its way skips it */
            JS_FreeValue(ctx, sub->handler);
            sub->handler = JS_UNDEFINED;
            g_hash_table_remove(e->signals, sub->name);
            elem_sub_unref(sub);
        }
        JS_FreeCString(ctx, name);
        e->hold_subs = g_hash_table_size(e->signals) > 0;
        elem_release_if_idle(e);   /* the last line: it may finalise e */
        return ret;
    }
    if (!JS_IsFunction(ctx, argv[1])) {
        JSValue r = JS_ThrowTypeError(ctx,
            "the %s handler must be a function or null", name);

        JS_FreeCString(ctx, name);
        return r;
    }
    if (sub) {
        /* Replaced, not reconnected: the signal is already going. */
        JS_FreeValue(ctx, sub->handler);
        sub->handler = JS_DupValue(ctx, argv[1]);
        JS_FreeCString(ctx, name);
        return JS_DupValue(ctx, this_val);
    }
    if (!elem_signal_ok(ctx, e, name)) {
        JS_FreeCString(ctx, name);
        return JS_EXCEPTION;
    }

    sub          = g_new0(ElemSub, 1);
    sub->elem    = e;
    sub->name    = g_strdup(name);
    sub->refs    = 1;
    sub->handler = JS_DupValue(ctx, argv[1]);
    {
        GClosure *closure = g_closure_new_simple(sizeof(GClosure), sub);

        g_closure_set_marshal(closure, elem_signal_marshal);
        sub->id = g_signal_connect_closure(e->element, name, closure, FALSE);
    }
    g_hash_table_insert(e->signals, sub->name, sub);
    e->hold_subs = true;
    elem_hold_self(ctx, e, this_val);
    JS_FreeCString(ctx, name);
    return JS_DupValue(ctx, this_val);
}

/* One value of one signal, copied off GStreamer's thread: scalars by value,
 * strings duplicated, objects and caps with references held until the
 * handler has run. */
typedef struct ElemCallArg {
    GType type;
    union {
        gboolean   b;
        gint       i;
        guint      u;
        gint64     i64;
        guint64    u64;
        gfloat     f;
        gdouble    d;
        gchar     *s;
        GstObject *obj;     /* GST_TYPE_PAD or GST_TYPE_ELEMENT */
        GstCaps   *caps;
    } v;
} ElemCallArg;

struct ElemCall {
    ElemSub     *sub;       /* one reference, dropped when this is freed */
    GSource     *source;    /* NULL for the inline (main thread) delivery */
    int          refs;      /* the emitter's, plus the source's while queued */
    bool         done;      /* the delivery ran; a waiting emitter may go */
    GMutex       mutex;     /* around refs/done; the cond is the wait's */
    GCond        cond;
    guint        n;
    ElemCallArg  args[8];
};

/* The marshal, on whatever thread GStreamer emitted from.
 *
 * **The emitting thread waits for the handler, capped.** Measured: a
 * delivery that only queues loses `pad-added` -- the source pushes before
 * the main loop gets there, and `wavparse` stops with "not-linked" -- and
 * `source-setup` would race its own credentials the same way. An emission
 * that is already on the main thread runs inline (what a C application
 * does); one from anywhere else queues the delivery and waits up to two
 * seconds for it, after which it simply runs late. No JSValue is touched
 * here: the handler is read on the main thread. */
static void elem_signal_marshal(GClosure *closure, GValue *ret,
                                guint n_params, const GValue *params,
                                gpointer hint, gpointer md)
{
    ElemSub  *sub = closure->data;
    ElemCall *call;
    bool      on_main;

    (void)ret; (void)hint; (void)md;
    if (n_params < 2 || n_params > 9)   /* the emitter, plus up to eight */
        return;
    if (!sub->elem)
        return;     /* detached; `disconnect` waited for exactly this emit */

    call = g_new0(ElemCall, 1);
    call->sub  = sub;
    call->n    = n_params - 1;
    call->refs = 1;
    g_mutex_init(&call->mutex);
    g_cond_init(&call->cond);

    for (guint i = 1; i < n_params; i++) {
        const GValue *v = &params[i];
        ElemCallArg  *a = &call->args[i - 1];
        GType         t = G_VALUE_TYPE(v);

        a->type = t;
        if (t == G_TYPE_BOOLEAN)
            a->v.b = g_value_get_boolean(v);
        else if (t == G_TYPE_INT)
            a->v.i = g_value_get_int(v);
        else if (t == G_TYPE_UINT)
            a->v.u = g_value_get_uint(v);
        else if (t == G_TYPE_INT64)
            a->v.i64 = g_value_get_int64(v);
        else if (t == G_TYPE_UINT64)
            a->v.u64 = g_value_get_uint64(v);
        else if (t == G_TYPE_FLOAT)
            a->v.f = g_value_get_float(v);
        else if (t == G_TYPE_DOUBLE)
            a->v.d = g_value_get_double(v);
        else if (t == G_TYPE_STRING)
            a->v.s = g_value_dup_string(v);
        else if (t == GST_TYPE_PAD || t == GST_TYPE_ELEMENT)
            a->v.obj = g_value_dup_object(v);
        else if (t == GST_TYPE_CAPS)
            a->v.caps = gst_caps_ref(g_value_get_boxed(v));
        else
            a->type = G_TYPE_NONE;   /* validated away at subscribe */
    }

    g_mutex_lock(&media_sig_mutex);
    sub->refs++;
    g_mutex_unlock(&media_sig_mutex);

    on_main = media_main_thread && g_thread_self() == media_main_thread;
    if (on_main) {
        elem_call_invoke(call);
        elem_call_unref(call);
        return;
    }

    /* The source is built detached, published, and attached last; after the
     * attach the delivery may run at any moment, and this thread only waits
     * for it and lets go. */
    call->refs++;
    g_mutex_lock(&media_sig_mutex);
    media_calls = g_list_prepend(media_calls, call);
    g_mutex_unlock(&media_sig_mutex);

    call->source = g_idle_source_new();
    g_source_set_priority(call->source, G_PRIORITY_DEFAULT);
    g_source_set_callback(call->source, elem_call_run, call, NULL);
    g_source_attach(call->source, NULL);

    g_mutex_lock(&call->mutex);
    while (!call->done) {
        if (!g_cond_wait_until(&call->cond, &call->mutex,
                               g_get_monotonic_time() + 2 * G_USEC_PER_SEC))
            break;      /* the loop is busy: the delivery runs when it can */
    }
    g_mutex_unlock(&call->mutex);
    elem_call_unref(call);      /* the emitter's; the source's keeps it */
}

static void elem_call_free(ElemCall *call)
{
    for (guint i = 0; i < call->n; i++) {
        ElemCallArg *a = &call->args[i];

        if (a->type == G_TYPE_STRING) {
            g_free(a->v.s);
        } else if (a->type == GST_TYPE_PAD || a->type == GST_TYPE_ELEMENT) {
            if (a->v.obj)
                gst_object_unref(a->v.obj);
        } else if (a->type == GST_TYPE_CAPS) {
            if (a->v.caps)
                gst_caps_unref(a->v.caps);
        }
    }
    if (call->source) {
        g_source_destroy(call->source);
        g_source_unref(call->source);
    }
    g_mutex_clear(&call->mutex);
    g_cond_clear(&call->cond);
    elem_sub_unref(call->sub);
    g_free(call);
}

static void elem_call_unref(ElemCall *call)
{
    int left;

    g_mutex_lock(&call->mutex);
    left = --call->refs;
    g_mutex_unlock(&call->mutex);
    if (left <= 0)
        elem_call_free(call);
}

/* The JS half of a delivery. **Main thread only** -- inline when the signal
 * was emitted there, from the idle otherwise -- and the element is read
 * *before* the call and never after: a handler that drops the last reference
 * may finalise the wrapper under this very frame. */
static void elem_call_invoke(ElemCall *call)
{
    ElemSub   *sub = call->sub;
    BtaElem   *e   = sub->elem;
    JSContext *ctx = (e && !e->dead) ? e->ctx : NULL;
    JSValue    args[8];
    int        argc = 0;
    bool       ok   = false;

    if (ctx && call->n <= G_N_ELEMENTS(args) &&
        JS_IsFunction(ctx, sub->handler)) {
        ok = true;
        for (guint i = 0; i < call->n && ok; i++) {
            ElemCallArg *a = &call->args[i];

            if (a->type == G_TYPE_BOOLEAN)
                args[i] = JS_NewBool(ctx, a->v.b);
            else if (a->type == G_TYPE_INT)
                args[i] = JS_NewInt32(ctx, a->v.i);
            else if (a->type == G_TYPE_UINT)
                args[i] = JS_NewUint32(ctx, a->v.u);
            else if (a->type == G_TYPE_INT64)
                args[i] = JS_NewInt64(ctx, a->v.i64);
            else if (a->type == G_TYPE_UINT64)
                args[i] = JS_NewFloat64(ctx, (double)a->v.u64);
            else if (a->type == G_TYPE_FLOAT)
                args[i] = JS_NewFloat64(ctx, a->v.f);
            else if (a->type == G_TYPE_DOUBLE)
                args[i] = JS_NewFloat64(ctx, a->v.d);
            else if (a->type == G_TYPE_STRING)
                args[i] = JS_NewString(ctx, a->v.s ? a->v.s : "");
            else if (a->type == GST_TYPE_PAD) {
                args[i] = pad_wrap_owned(ctx, GST_PAD(a->v.obj));
                if (!JS_IsException(args[i]))
                    a->v.obj = NULL;   /* the wrapper's reference now */
            } else if (a->type == GST_TYPE_ELEMENT) {
                args[i] = elem_wrap_owned(ctx, GST_ELEMENT(a->v.obj));
                if (!JS_IsException(args[i]))
                    a->v.obj = NULL;
            } else if (a->type == GST_TYPE_CAPS) {
                gchar *text = gst_caps_to_string(a->v.caps);

                args[i] = JS_NewString(ctx, text ? text : "");
                g_free(text);
            } else {
                args[i] = JS_UNDEFINED;
            }
            argc = i + 1;
            if (JS_IsException(args[i]))
                ok = false;
        }
    }
    if (ok) {
        JSValue fn = JS_DupValue(ctx, sub->handler);
        JSValue r  = JS_Call(ctx, fn, JS_UNDEFINED, argc, args);

        if (JS_IsException(r))
            bta_dump_error(ctx);
        JS_FreeValue(ctx, r);
        JS_FreeValue(ctx, fn);
        bta_drain_jobs(JS_GetRuntime(ctx));
    }
    for (int i = 0; i < argc; i++)
        JS_FreeValue(ctx, args[i]);
}

/* The queued delivery, on the main loop. */
static gboolean elem_call_run(gpointer data)
{
    ElemCall *call = data;

    g_mutex_lock(&media_sig_mutex);
    media_calls = g_list_remove(media_calls, call);
    g_mutex_unlock(&media_sig_mutex);

    elem_call_invoke(call);

    g_mutex_lock(&call->mutex);
    call->done = true;
    g_cond_signal(&call->cond);
    g_mutex_unlock(&call->mutex);
    elem_call_unref(call);      /* the source's reference */
    return G_SOURCE_REMOVE;
}

/* Every delivery still armed, dropped: the console cleanup runs before the
 * context goes, and from here on no source may touch a JSValue. An emitter
 * still waiting is woken and lets go of its own reference afterwards. */
static void media_calls_cleanup(void)
{
    GList *calls;

    g_mutex_lock(&media_sig_mutex);
    calls       = media_calls;
    media_calls = NULL;
    g_mutex_unlock(&media_sig_mutex);

    for (GList *l = calls; l; l = l->next) {
        ElemCall *call = l->data;

        g_mutex_lock(&call->mutex);
        call->done = true;
        g_cond_signal(&call->cond);
        g_mutex_unlock(&call->mutex);
        if (call->source)
            g_source_destroy(call->source);
        elem_call_unref(call);
    }
    g_list_free(calls);

    /* Empty by now -- every element and bus has been torn down and left --
     * and the table itself is process-lifetime until here. */
    if (media_watches) {
        g_hash_table_destroy(media_watches);
        media_watches = NULL;
    }
}

/* ------------------------------------------------------------- the bus */

static void bus_call(BtaBus *b, JSValue fn, int argc, JSValueConst *argv)
{
    JSContext *ctx = b->ctx;

    if (b->dead || !ctx || !JS_IsFunction(ctx, fn))
        return;

    JSValue held = JS_DupValue(ctx, fn);
    JSValue r    = JS_Call(ctx, held, JS_UNDEFINED, argc, argv);

    if (JS_IsException(r))
        bta_dump_error(ctx);
    JS_FreeValue(ctx, r);
    JS_FreeValue(ctx, held);
    bta_drain_jobs(JS_GetRuntime(ctx));
}

/* One bus message onto one Bus wrapper's handlers. Called from the shared
 * watch (`media_watch_cb`), which has already done the accounting; `b` may
 * be finalised by its own handler, so nothing here touches it after
 * `bus_call`. */
static void bus_dispatch(BtaBus *b, GstMessage *msg)
{
    JSContext *ctx = b->ctx;
    JSValue    argv[3];
    int        idx = -1;
    int        argc = 0;

    if (b->dead || !ctx)
        return;

    switch (GST_MESSAGE_TYPE(msg)) {
    case GST_MESSAGE_ERROR:
    case GST_MESSAGE_WARNING:
    case GST_MESSAGE_INFO: {
        GError *err = NULL;
        gchar  *dbg = NULL;
        gchar  *text;

        if (GST_MESSAGE_TYPE(msg) == GST_MESSAGE_ERROR) {
            idx = 0;
            gst_message_parse_error(msg, &err, &dbg);
        } else if (GST_MESSAGE_TYPE(msg) == GST_MESSAGE_WARNING) {
            idx = 1;
            gst_message_parse_warning(msg, &err, &dbg);
        } else {
            idx = 2;
            gst_message_parse_info(msg, &err, &dbg);
        }
        text   = g_strdup_printf("%s: %s", GST_OBJECT_NAME(GST_MESSAGE_SRC(msg)),
                                 err ? media_error_text(err) : "unknown");
        argv[0] = JS_NewString(ctx, text);
        argv[1] = JS_NewString(ctx, media_kind_for(err));
        argc    = 2;
        if (dbg)
            bta_log_debug(ctx, dbg);
        g_free(text);
        g_clear_error(&err);
        g_free(dbg);
        break;
    }
    case GST_MESSAGE_EOS:
        idx = 3;
        break;
    case GST_MESSAGE_BUFFERING: {
        gint percent = 0;

        idx = 4;
        gst_message_parse_buffering(msg, &percent);
        argv[0] = JS_NewInt32(ctx, percent);
        argc    = 1;
        break;
    }
    case GST_MESSAGE_STATE_CHANGED: {
        GstState new_state = GST_STATE_NULL;

        idx = 5;
        gst_message_parse_state_changed(msg, NULL, &new_state, NULL);
        argv[0] = JS_NewString(ctx, GST_OBJECT_NAME(GST_MESSAGE_SRC(msg)));
        argv[1] = JS_NewString(ctx, MEDIA_STATES[(int)new_state]);
        argc    = 2;
        break;
    }
    case GST_MESSAGE_CLOCK_LOST:
        idx = 6;
        break;
    case GST_MESSAGE_ASYNC_DONE:
        idx = 7;
        break;
    default:
        return;
    }

    if (JS_IsFunction(ctx, b->handlers[idx]))
        bus_call(b, b->handlers[idx], argc, argv);

    /* `bus_call` may have finalised `b`: only the context is touched here. */
    for (int i = 0; i < argc; i++)
        JS_FreeValue(ctx, argv[i]);
}

static void bus_sync(JSContext *ctx, BtaBus *b, JSValueConst this_val)
{
    bool any = false;

    for (guint i = 0; i < G_N_ELEMENTS(MEDIA_BUS_TYPES); i++) {
        if (JS_IsFunction(ctx, b->handlers[i]))
            any = true;
    }
    if (any) {
        if (JS_IsUndefined(b->self))
            b->self = JS_DupValue(ctx, this_val);
        bus_watch_join(b);
        return;
    }
    bus_watch_leave(b);
    /* The bus's claim on its own object goes last: releasing it may finalise
     * `b`, and then nothing here may touch it. */
    if (!JS_IsUndefined(b->self)) {
        JSValue self = b->self;

        b->self = JS_UNDEFINED;
        JS_FreeValue(ctx, self);
    }
}

static JSValue bus_on(JSContext *ctx, JSValueConst this_val, int argc,
                      JSValueConst *argv)
{
    BtaBus     *b = bus_this(ctx, this_val);
    const char *name;
    JSValue     ret;
    int         idx = -1;

    if (!b)
        return JS_EXCEPTION;
    if (argc < 2)
        return JS_ThrowTypeError(ctx, "On expects (type, handler)");
    name = JS_ToCString(ctx, argv[0]);
    if (!name)
        return JS_EXCEPTION;
    for (guint i = 0; i < G_N_ELEMENTS(MEDIA_BUS_TYPES); i++) {
        if (!strcmp(name, MEDIA_BUS_TYPES[i]))
            idx = (int)i;
    }
    if (idx < 0) {
        JSValue r = JS_ThrowRangeError(ctx,
            "On: '%s' is not a bus message -- there are error, warning, info, "
            "eos, buffering, state-changed, clock-lost and async-done", name);

        JS_FreeCString(ctx, name);
        return r;
    }
    JS_FreeCString(ctx, name);

    if (JS_IsNull(argv[1]) || JS_IsUndefined(argv[1])) {
        JS_FreeValue(ctx, b->handlers[idx]);
        b->handlers[idx] = JS_UNDEFINED;
    } else if (!JS_IsFunction(ctx, argv[1])) {
        return JS_ThrowTypeError(ctx,
            "the %s handler must be a function or null", MEDIA_BUS_TYPES[idx]);
    } else {
        JS_FreeValue(ctx, b->handlers[idx]);
        b->handlers[idx] = JS_DupValue(ctx, argv[1]);
    }
    ret = JS_DupValue(ctx, this_val);
    bus_sync(ctx, b, this_val);   /* the last line: it may finalise b */
    return ret;
}

/* ------------------------------------------------------------- teardown */

static void elem_teardown(BtaElem *e)
{
    if (!e || e->dead)
        return;
    e->dead      = true;
    e->hold_play = false;
    elements_live = g_list_remove(elements_live, e);

    /* Out of the bus's accounting first (it walks its own list on the main
     * loop, and this very element may have been in it), then the signals. */
    elem_watch_leave(e);
    elem_signals_destroy(e);

    if (e->element) {
        if (e->asked) {
            /* The state change is async, and the unref must wait for it --
             * engine_teardown's measurement, same cap. A wrapper that was
             * never asked a state just unrefs. */
            gst_element_set_state(e->element, GST_STATE_NULL);
            gst_element_get_state(e->element, NULL, NULL, 2 * GST_SECOND);
        }
        gst_object_unref(e->element);
        e->element = NULL;
    }
    e->ctx = NULL;
    /* The keepalive is deliberately *not* released here: cleanup runs while
     * the context is alive and drops it from outside the walk; the finaliser
     * cannot release it (it points at the object being finalised). */
}

static void pad_teardown(BtaPad *p)
{
    if (!p || p->dead)
        return;
    p->dead = true;
    if (p->pad) {
        gst_object_unref(p->pad);
        p->pad = NULL;
    }
    p->ctx = NULL;
}

static void bus_teardown(BtaBus *b)
{
    if (!b || b->dead)
        return;
    b->dead = true;
    buses_live = g_list_remove(buses_live, b);
    bus_watch_leave(b);
    if (b->bus) {
        gst_object_unref(b->bus);
        b->bus = NULL;
    }
    b->ctx = NULL;
}

#else /* no GStreamer at build time */

/* ========================================================= no engine here
 *
 * The verbs refuse, naming the package; the questions answer nothing. What a
 * program *sets* is kept by the shared half above, because a .form assigns
 * those properties and the designer reads them back: a runtime that cannot
 * play a clip can still be the one a form is drawn and saved in.
 */

static bool engine_start(JSContext *ctx, BtaMedia *m)
{
    (void)m;
    JS_ThrowPlainError(ctx, MEDIA_NO_GST);
    return false;
}

static bool engine_seek(JSContext *ctx, BtaMedia *m, double seconds)
{
    (void)m; (void)seconds;
    JS_ThrowPlainError(ctx, MEDIA_NO_GST);
    return false;
}

static void   engine_hold(BtaMedia *m)     { (void)m; }
static void   engine_park(BtaMedia *m)     { (void)m; }
static void   engine_uri(BtaMedia *m)      { (void)m; }
static void   engine_levels(BtaMedia *m)   { (void)m; }
static double engine_position(BtaMedia *m) { (void)m; return 0; }
static double engine_duration(BtaMedia *m) { (void)m; return -1; }
static bool   engine_seekable(BtaMedia *m) { (void)m; return false; }
static void   engine_teardown(BtaMedia *m) { (void)m; }

/* The elements half, with no engine: `Media.Element` -- the only way a
 * wrapper could come to exist -- refuses, naming the package, and every verb
 * under it answers the same sentence (unreachably, but compiled, so the
 * tables above have their entries in both builds). */
static JSValue media_element(JSContext *ctx, JSValueConst this_val, int argc,
                             JSValueConst *argv)
{
    (void)this_val; (void)argc; (void)argv;
    return JS_ThrowPlainError(ctx, MEDIA_NO_GST);
}

static JSValue elem_add(JSContext *ctx, JSValueConst this_val, int argc,
                        JSValueConst *argv)
{
    (void)this_val; (void)argc; (void)argv;
    return JS_ThrowPlainError(ctx, MEDIA_NO_GST);
}

static JSValue elem_link(JSContext *ctx, JSValueConst this_val, int argc,
                         JSValueConst *argv)
{
    (void)this_val; (void)argc; (void)argv;
    return JS_ThrowPlainError(ctx, MEDIA_NO_GST);
}

static JSValue elem_pad(JSContext *ctx, JSValueConst this_val, int argc,
                        JSValueConst *argv)
{
    (void)this_val; (void)argc; (void)argv;
    return JS_ThrowPlainError(ctx, MEDIA_NO_GST);
}

static JSValue elem_set(JSContext *ctx, JSValueConst this_val, int argc,
                        JSValueConst *argv)
{
    (void)this_val; (void)argc; (void)argv;
    return JS_ThrowPlainError(ctx, MEDIA_NO_GST);
}

static JSValue elem_get(JSContext *ctx, JSValueConst this_val, int argc,
                        JSValueConst *argv)
{
    (void)this_val; (void)argc; (void)argv;
    return JS_ThrowPlainError(ctx, MEDIA_NO_GST);
}

static JSValue elem_eos(JSContext *ctx, JSValueConst this_val, int argc,
                        JSValueConst *argv)
{
    (void)this_val; (void)argc; (void)argv;
    return JS_ThrowPlainError(ctx, MEDIA_NO_GST);
}

static JSValue elem_on(JSContext *ctx, JSValueConst this_val, int argc,
                       JSValueConst *argv)
{
    (void)this_val; (void)argc; (void)argv;
    return JS_ThrowPlainError(ctx, MEDIA_NO_GST);
}

static JSValue elem_get_bus(JSContext *ctx, JSValueConst this_val)
{
    (void)this_val;
    return JS_ThrowPlainError(ctx, MEDIA_NO_GST);
}

static JSValue elem_get_state(JSContext *ctx, JSValueConst this_val)
{
    (void)this_val;
    return JS_ThrowPlainError(ctx, MEDIA_NO_GST);
}

static JSValue elem_set_state(JSContext *ctx, JSValueConst this_val,
                              JSValueConst val)
{
    (void)this_val; (void)val;
    return JS_ThrowPlainError(ctx, MEDIA_NO_GST);
}

static JSValue pad_get_name(JSContext *ctx, JSValueConst this_val)
{
    (void)this_val;
    return JS_ThrowPlainError(ctx, MEDIA_NO_GST);
}

static JSValue pad_get_caps(JSContext *ctx, JSValueConst this_val)
{
    (void)this_val;
    return JS_ThrowPlainError(ctx, MEDIA_NO_GST);
}

static JSValue pad_link(JSContext *ctx, JSValueConst this_val, int argc,
                        JSValueConst *argv)
{
    (void)this_val; (void)argc; (void)argv;
    return JS_ThrowPlainError(ctx, MEDIA_NO_GST);
}

static JSValue bus_on(JSContext *ctx, JSValueConst this_val, int argc,
                      JSValueConst *argv)
{
    (void)this_val; (void)argc; (void)argv;
    return JS_ThrowPlainError(ctx, MEDIA_NO_GST);
}

static void elem_teardown(BtaElem *e) { elem_signals_destroy(e); }
static void pad_teardown(BtaPad *p)   { (void)p; }
static void bus_teardown(BtaBus *b)   { (void)b; }
static void media_calls_cleanup(void) { }

#endif
