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

static const char *const MEDIA_FIT[] = { "Fill", "Contain", "Cover", "ScaleDown" };

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
    JS_CGETSET_DEF("Uri",          media_get_uri,      media_set_uri),
    JS_CGETSET_DEF("User",         media_get_user,     media_set_user),
    JS_CGETSET_DEF("Password",     media_get_password, media_set_password),
    JS_CGETSET_DEF("Latency",      media_get_latency,  media_set_latency),
    JS_CGETSET_DEF("Volume",       media_get_volume,   media_set_volume),
    JS_CGETSET_DEF("Muted",        media_get_muted,    media_set_muted),
    JS_CGETSET_DEF("Loop",         media_get_loop,     media_set_loop),
    JS_CGETSET_DEF("Fit",          video_get_fit,      video_set_fit),
    JS_CGETSET_DEF("Available",    media_get_available, NULL),
    JS_CGETSET_DEF("Buffering",    media_get_buffering, NULL),
    JS_CGETSET_DEF("Position",     media_get_position, NULL),
    JS_CGETSET_DEF("Duration",     media_get_duration, NULL),
    JS_CGETSET_DEF("Playing",      media_get_playing,  NULL),
    JS_CGETSET_DEF("Seekable",     media_get_seekable, NULL),
    JS_CGETSET_DEF("SourceWidth",  video_get_source_width,  NULL),
    JS_CGETSET_DEF("SourceHeight", video_get_source_height, NULL),
    /* Play() */
    JS_CFUNC_DEF("Play",  0, media_play),
    /* Pause() */
    JS_CFUNC_DEF("Pause", 0, media_pause),
    /* Stop() */
    JS_CFUNC_DEF("Stop",  0, media_stop),
    /* Seek(seconds) */
    JS_CFUNC_DEF("Seek",  1, media_seek),
    /* Save(path) */
    JS_CFUNC_DEF("Save",  1, video_save),
};

static JSValue audio_get_onended(JSContext *ctx, JSValueConst this_val);
static JSValue audio_set_onended(JSContext *ctx, JSValueConst this_val, JSValueConst val);
static JSValue audio_get_onerror(JSContext *ctx, JSValueConst this_val);
static JSValue audio_set_onerror(JSContext *ctx, JSValueConst this_val, JSValueConst val);

static const JSCFunctionListEntry audioplayer_props[] = {
    JS_CGETSET_DEF("Uri",      media_get_uri,      media_set_uri),
    JS_CGETSET_DEF("User",     media_get_user,     media_set_user),
    JS_CGETSET_DEF("Password", media_get_password, media_set_password),
    JS_CGETSET_DEF("Latency",  media_get_latency,  media_set_latency),
    JS_CGETSET_DEF("Volume",   media_get_volume,   media_set_volume),
    JS_CGETSET_DEF("Muted",    media_get_muted,    media_set_muted),
    JS_CGETSET_DEF("Loop",     media_get_loop,     media_set_loop),
    JS_CGETSET_DEF("Buffering", media_get_buffering, NULL),
    JS_CGETSET_DEF("Position", media_get_position, NULL),
    JS_CGETSET_DEF("Duration", media_get_duration, NULL),
    JS_CGETSET_DEF("Playing",  media_get_playing,  NULL),
    JS_CGETSET_DEF("Seekable", media_get_seekable, NULL),
    JS_CGETSET_DEF("OnEnded",  audio_get_onended,  audio_set_onended),
    JS_CGETSET_DEF("OnError",  audio_get_onerror,  audio_set_onerror),
    JS_CFUNC_DEF("Play",  0, media_play),
    JS_CFUNC_DEF("Pause", 0, media_pause),
    JS_CFUNC_DEF("Stop",  0, media_stop),
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
            JS_ThrowInternalError(ctx, "Video: no player behind this control");
            return NULL;
        }
    }
    if (m->dead) {
        JS_ThrowInternalError(ctx, "%s: torn down", media_who(m));
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
                          s, err ? err->message : "and cannot be turned into one");
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
        r = JS_ThrowInternalError(ctx,
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
            r = JS_ThrowInternalError(ctx,
                "Save: there is no frame yet -- nothing has been decoded");
            goto out;
        }
        if (!ren) {
            r = JS_ThrowInternalError(ctx,
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
            r = JS_ThrowInternalError(ctx, "Save: the frame could not be drawn");
            goto out;
        }
    }
    if (!gdk_texture_save_to_png(tex, path))
        r = JS_ThrowInternalError(ctx, "Save: cannot write '%s'", path);

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
        /* Ended() */
        /* Error(message, kind) */
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
        JS_ThrowInternalError(ctx, "AudioPlayer: torn down");
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
    return JS_ThrowInternalError(ctx, MEDIA_NO_GST);
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

void bta_media_init(JSContext *ctx, JSValue global)
{
    JS_NewClassID(JS_GetRuntime(ctx), &audioplayer_class_id);
    JS_NewClass(JS_GetRuntime(ctx), audioplayer_class_id, &audioplayer_class);

    JSValue proto = JS_NewObject(ctx);

    JS_SetPropertyFunctionList(ctx, proto, audioplayer_props,
                               G_N_ELEMENTS(audioplayer_props));
    JS_SetClassProto(ctx, audioplayer_class_id, proto);

    JSValue ctor = JS_NewCFunction2(ctx, audioplayer_construct, "AudioPlayer", 0,
                                    JS_CFUNC_constructor, 0);

    JS_SetPropertyStr(ctx, global, "AudioPlayer", ctor);
}

guint bta_media_pending(void)
{
    guint n = 0;

    /* A player playing is owed an answer -- an EOS or an error -- the way a
     * running child is. A paused one is a deliberate hold, not work in
     * flight, so it keeps no console project alive. */
    for (GList *l = media_live; l; l = l->next) {
        BtaMedia *m = l->data;

        if (!m->dead && m->wants)
            n++;
    }
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
    while (media_live)
        media_teardown(media_live->data);
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
                                 err && err->message ? err->message
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
        if (err && err->message) {
            char *line = g_strdup_printf("%s: %s", media_who(m), err->message);

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
        JS_ThrowInternalError(ctx,
            "no playbin3 element: this GStreamer installation cannot play "
            "anything, which means its base plugins are not installed");
        return false;
    }

    if (m->is_video) {
        GstElement   *sink = gst_element_factory_make("gtk4paintablesink", NULL);
        GdkPaintable *paintable = NULL;

        if (!sink) {
            g_object_unref(pb);
            JS_ThrowInternalError(ctx,
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
            JS_ThrowInternalError(ctx, "the video sink produced no paintable");
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
        JS_ThrowInternalError(ctx, "Seek: the seek failed");
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
    JS_ThrowInternalError(ctx, MEDIA_NO_GST);
    return false;
}

static bool engine_seek(JSContext *ctx, BtaMedia *m, double seconds)
{
    (void)m; (void)seconds;
    JS_ThrowInternalError(ctx, MEDIA_NO_GST);
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

#endif
