/*
 * SerialPort -- RS-232 and USB serial adapters on the main loop.
 *
 * The design is stage 6 of docs/plans/transports-plan.md.  On POSIX a serial
 * port is a tty: `termios` is the C library's interface to the kernel's line
 * discipline, not a library to install, and `open`/`read`/`write` reach the
 * same `/dev/ttyUSB0` or `/dev/ttyACM0` every other program uses.  On Windows
 * it is a COM handle: `CreateFileW`, a `DCB`, and a reader thread because a
 * HANDLE is not something GLib can poll.  What this file adds on both is the
 * event road the rest of the runtime speaks -- no blocking read on the
 * window's thread -- and the configuration checked at assignment.
 *
 * ## The rules worth writing down
 *
 * **A read is not a message.** A serial device is a byte stream; `OnData`
 * hands the bytes one read returned, exactly as `Socket.OnData` does.  `Line`
 * is the one framing here, and it buffers until `EndOfLine`.
 *
 * **A write never blocks.** `Write` queues a `GBytes`; on POSIX the queue is
 * drained on `G_IO_OUT` when the kernel takes no more, and on Windows by a
 * writer thread.  A write on a closed port throws now, because that is a
 * mistake and not an answer that arrives later.
 *
 * **The port keeps itself alive.** The source that watches the fd, or the
 * threads that own the COM handle, hold a strong reference to the wrapper
 * (`keep`) while the port is open, so a program that drops its last
 * JavaScript reference does not close a port it is still using.  `Close`
 * drops it last, when nothing is in flight.
 *
 * **The configuration is checked where it is written.** A speed the system
 * does not have, a parity this platform cannot express, or a port that is not
 * a tty throws at `Open` with the setting named; the property setters refuse
 * what can be refused without the device.
 */
#include "bta_serial_internal.h"

#include <string.h>

#ifndef G_OS_WIN32
#include <errno.h>
#include <fcntl.h>
#include <termios.h>
#include <unistd.h>
#include <glib-unix.h>
#endif

static GList    *serial_live;   /* SerialData *, open */
static JSClassID serial_class_id;

static void serial_close(SerialData *s, bool finalizing);
#ifndef G_OS_WIN32
static void serial_write_start(SerialData *s);
static gboolean on_serial_input(gint fd, GIOCondition cond, gpointer data);
static gboolean on_serial_output(gint fd, GIOCondition cond, gpointer data);
#endif

/* --------------------------------------------------------------- utilities */

static gsize find_bytes(const guint8 *hay, gsize n,
                        const guint8 *needle, gsize m)
{
    if (m == 0)
        return 0;
    if (n < m)
        return (gsize)-1;
    for (gsize i = 0; i + m <= n; i++)
        if (hay[i] == needle[0] && memcmp(hay + i, needle, m) == 0)
            return i;
    return (gsize)-1;
}

static SerialData *serial_data(JSContext *ctx, JSValueConst v)
{
    return JS_GetOpaque2(ctx, v, serial_class_id);
}

static void serial_live_add(SerialData *s)
{
    if (!s->in_live) {
        s->in_live = true;
        serial_live = g_list_prepend(serial_live, s);
    }
}

static void serial_live_remove(SerialData *s)
{
    if (s->in_live) {
        s->in_live = false;
        serial_live = g_list_remove(serial_live, s);
    }
}

/* ------------------------------------------------------------- the events */

/* Hold the wrapper and the handler across their own call: a handler may
 * replace itself and drop the last outside reference.  `argv` belongs to the
 * caller. */
static void serial_emit(SerialData *s, JSValueConst fn, int argc,
                        JSValueConst *argv)
{
    if (!JS_IsFunction(s->ctx, fn))
        return;

    JSValue self = JS_DupValue(s->ctx, s->self);
    JSValue call = JS_DupValue(s->ctx, fn);
    JSValue r    = JS_Call(s->ctx, call, self, argc, argv);

    if (JS_IsException(r))
        bta_dump_error(s->ctx);
    JS_FreeValue(s->ctx, r);
    JS_FreeValue(s->ctx, call);
    JS_FreeValue(s->ctx, self);
    bta_drain_jobs(JS_GetRuntime(s->ctx));
}

static JSValue serial_error(JSContext *ctx, const char *kind,
                            const char *detail)
{
    JSValue e = JS_NewObject(ctx);
    char   *msg = g_strdup_printf("SerialPort: %s", detail);

    JS_SetPropertyStr(ctx, e, "Message", JS_NewString(ctx, msg));
    JS_SetPropertyStr(ctx, e, "Kind", JS_NewString(ctx, kind));
    g_free(msg);
    return e;
}

void bta_serial_fail(SerialData *s, const char *kind, const char *detail)
{
    JSValue hold;
    JSValue e;

    if (!s->open)
        return;

    /* The handler may drop the last reference through `Close`, so the struct
     * must be held across its own call and the close that follows. */
    hold = JS_DupValue(s->ctx, s->self);
    e    = serial_error(s->ctx, kind, detail);
    serial_emit(s, s->on_error, 1, &e);
    JS_FreeValue(s->ctx, e);
    if (s->open)
        serial_close(s, false);
    JS_FreeValue(s->ctx, hold);
}

/* ---------------------------------------------------------------- closing */

static void serial_close(SerialData *s, bool finalizing)
{
    if (!s->open)
        return;

    s->open = false;

    if (s->in_source) {
        g_source_remove(s->in_source);
        s->in_source = 0;
    }
    if (s->out_source) {
        g_source_remove(s->out_source);
        s->out_source = 0;
    }
#ifdef G_OS_WIN32
    bta_serial_win32_close(s);
#else
    if (s->fd >= 0) {
        close(s->fd);
        s->fd = -1;
    }
#endif

    s->writing  = false;
    s->write_at = 0;
    while (!g_queue_is_empty(s->writes))
        g_bytes_unref(g_queue_pop_head(s->writes));
    if (s->linebuf)
        g_byte_array_set_size(s->linebuf, 0);

    serial_live_remove(s);

    /* Last: this may be the reference that finalizes the wrapper, and `s` is
     * not read after it. */
    if (!finalizing && !JS_IsUndefined(s->keep)) {
        JSValue keep = s->keep;

        s->keep = JS_UNDEFINED;
        JS_FreeValue(s->ctx, keep);
    }
}

/* --------------------------------------------------------------- reading */

void bta_serial_deliver(SerialData *s, const guint8 *data, size_t len)
{
    if (!s->open || !len)
        return;

    /* The handler may close the port and drop the last outside reference.
     * `s->keep` goes away with the Close, so hold the wrapper for the checks
     * below rather than reading `s` after the emit. */
    JSValue hold = JS_DupValue(s->ctx, s->self);

    if (s->line) {
        if (!JS_IsFunction(s->ctx, s->on_line)) {
            JS_FreeValue(s->ctx, hold);
            return;
        }

        g_byte_array_append(s->linebuf, data, len);
        if (s->linebuf->len > SERIAL_LINE_MAX) {
            bta_serial_fail(s, "Error", "a line is longer than 1 MiB");
            JS_FreeValue(s->ctx, hold);
            return;
        }

        for (;;) {
            gsize eol_len = strlen(s->eol);
            gsize at = find_bytes(s->linebuf->data, s->linebuf->len,
                                  (const guint8 *)s->eol, eol_len);

            if (at == (gsize)-1)
                break;

            JSValue line = JS_NewStringLen(s->ctx,
                                           (const char *)s->linebuf->data, at);

            if (JS_IsException(line)) {
                JS_FreeValue(s->ctx, JS_GetException(s->ctx));
                bta_serial_fail(s, "Error",
                            "the device sent a line that is not UTF-8");
                JS_FreeValue(s->ctx, hold);
                return;
            }
            serial_emit(s, s->on_line, 1, &line);
            JS_FreeValue(s->ctx, line);

            /* The handler may have closed the port, or turned line mode off;
             * closing clears the buffer, and the range is only removed while
             * it is still the one we measured. */
            if (!s->open) {
                JS_FreeValue(s->ctx, hold);
                return;
            }
            g_byte_array_remove_range(s->linebuf, 0, at + eol_len);
            if (!s->line) {
                JS_FreeValue(s->ctx, hold);
                return;
            }
        }
        JS_FreeValue(s->ctx, hold);
        return;
    }

    if (!JS_IsFunction(s->ctx, s->on_data)) {
        JS_FreeValue(s->ctx, hold);
        return;
    }

    JSValue bytes = bta_bytes_new(s->ctx, data, len);
    if (JS_IsException(bytes)) {
        JS_FreeValue(s->ctx, hold);
        return;
    }
    serial_emit(s, s->on_data, 1, &bytes);
    JS_FreeValue(s->ctx, bytes);
    JS_FreeValue(s->ctx, hold);
}

#ifdef G_OS_WIN32
/* The COM handle, its threads and their queue are bta_serial_win32.c. */
#else  /* !G_OS_WIN32 */

static void serial_read(SerialData *s)
{
    guint8  buf[SERIAL_CHUNK];
    ssize_t n = read(s->fd, buf, sizeof buf);

    if (n > 0) {
        bta_serial_deliver(s, buf, (size_t)n);
        return;
    }
    if (n == 0) {
        bta_serial_fail(s, "Closed", "the port closed");
        return;
    }
    if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR)
        return;
    bta_serial_fail(s, "Error", g_strerror(errno));
}

/* --------------------------------------------------------------- writing */

/* One queued GBytes, as far as the kernel takes it.  `true` means the queue
 * still has something -- a short write, EAGAIN or an error that has already
 * been raised.  `false` means one whole buffer went out; the caller asks
 * again. */
static bool serial_write_some(SerialData *s)
{
    GBytes      *b = g_queue_peek_head(s->writes);
    gsize        len = 0;
    const guint8 *data;

    if (!b)
        return false;
    data = g_bytes_get_data(b, &len);

    while (s->write_at < len) {
        ssize_t n = write(s->fd, data + s->write_at, len - s->write_at);

        if (n > 0) {
            s->write_at += (gsize)n;
            continue;
        }
        if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK ||
                      errno == EINTR))
            return true;
        bta_serial_fail(s, "Error", g_strerror(errno));
        return true;
    }

    g_bytes_unref(g_queue_pop_head(s->writes));
    s->write_at = 0;
    return false;
}

static void serial_write_start(SerialData *s)
{
    if (!s->open || s->writing)
        return;

    s->writing = true;
    while (s->open && !g_queue_is_empty(s->writes)) {
        if (serial_write_some(s))
            break;
    }
    s->writing = false;

    if (!s->open)
        return;

    if (g_queue_is_empty(s->writes)) {
        if (s->out_source) {
            g_source_remove(s->out_source);
            s->out_source = 0;
        }
    } else if (!s->out_source) {
        s->out_source = g_unix_fd_add_full(G_PRIORITY_DEFAULT, s->fd,
                                           G_IO_OUT | G_IO_ERR | G_IO_HUP,
                                           on_serial_output, s, NULL);
    }
}

/* --------------------------------------------------------------- the loop */

static gboolean on_serial_input(gint fd, GIOCondition cond, gpointer data)
{
    SerialData *s = data;
    JSValue     hold = JS_DupValue(s->ctx, s->self);

    if (s->open && s->fd == fd) {
        if (cond & G_IO_IN)
            serial_read(s);
        if (s->open && (cond & (G_IO_ERR | G_IO_HUP | G_IO_NVAL)))
            bta_serial_fail(s, "Closed", "the port went away");
    }

    gboolean again = s->open && s->fd == fd;

    JS_FreeValue(s->ctx, hold);
    return again ? G_SOURCE_CONTINUE : G_SOURCE_REMOVE;
}

static gboolean on_serial_output(gint fd, GIOCondition cond, gpointer data)
{
    SerialData *s = data;
    JSValue     hold = JS_DupValue(s->ctx, s->self);

    if (s->open && s->fd == fd) {
        if (cond & (G_IO_ERR | G_IO_HUP | G_IO_NVAL))
            bta_serial_fail(s, "Closed", "the port went away");
        else
            serial_write_start(s);
    }

    gboolean again = s->open && s->fd == fd && !g_queue_is_empty(s->writes);

    JS_FreeValue(s->ctx, hold);
    return again ? G_SOURCE_CONTINUE : G_SOURCE_REMOVE;
}

#endif  /* !G_OS_WIN32 */

/* ------------------------------------------------------------- termios */

#ifdef G_OS_WIN32
/* The DCB and CreateFileW are bta_serial_win32.c. */
#else  /* !G_OS_WIN32 */

/*
 * The speed is a `speed_t` constant and not a number, and the set is the one
 * the C library declares: asking for 12345 is a refusal with the list of what
 * this system offers, not a `B12345` that does not exist.
 */
static bool serial_speed_code(int speed, speed_t *out)
{
    switch (speed) {
#ifdef B50
    case 50:     *out = B50;     return true;
#endif
#ifdef B75
    case 75:     *out = B75;     return true;
#endif
#ifdef B110
    case 110:    *out = B110;    return true;
#endif
#ifdef B134
    case 134:    *out = B134;    return true;
#endif
#ifdef B150
    case 150:    *out = B150;    return true;
#endif
#ifdef B200
    case 200:    *out = B200;    return true;
#endif
#ifdef B300
    case 300:    *out = B300;    return true;
#endif
#ifdef B600
    case 600:    *out = B600;    return true;
#endif
#ifdef B1200
    case 1200:   *out = B1200;   return true;
#endif
#ifdef B1800
    case 1800:   *out = B1800;   return true;
#endif
#ifdef B2400
    case 2400:   *out = B2400;   return true;
#endif
#ifdef B4800
    case 4800:   *out = B4800;   return true;
#endif
#ifdef B9600
    case 9600:   *out = B9600;   return true;
#endif
#ifdef B19200
    case 19200:  *out = B19200;  return true;
#endif
#ifdef B38400
    case 38400:  *out = B38400;  return true;
#endif
#ifdef B57600
    case 57600:  *out = B57600;  return true;
#endif
#ifdef B115200
    case 115200: *out = B115200; return true;
#endif
#ifdef B230400
    case 230400: *out = B230400; return true;
#endif
#ifdef B460800
    case 460800: *out = B460800; return true;
#endif
#ifdef B500000
    case 500000: *out = B500000; return true;
#endif
#ifdef B576000
    case 576000: *out = B576000; return true;
#endif
#ifdef B921600
    case 921600: *out = B921600; return true;
#endif
#ifdef B1000000
    case 1000000: *out = B1000000; return true;
#endif
#ifdef B1152000
    case 1152000: *out = B1152000; return true;
#endif
#ifdef B1500000
    case 1500000: *out = B1500000; return true;
#endif
#ifdef B2000000
    case 2000000: *out = B2000000; return true;
#endif
#ifdef B2500000
    case 2500000: *out = B2500000; return true;
#endif
#ifdef B3000000
    case 3000000: *out = B3000000; return true;
#endif
#ifdef B3500000
    case 3500000: *out = B3500000; return true;
#endif
#ifdef B4000000
    case 4000000: *out = B4000000; return true;
#endif
    default:
        return false;
    }
}

static bool serial_configure(SerialData *s, int fd, char **why)
{
    struct termios tio;
    speed_t        code;

    if (tcgetattr(fd, &tio) != 0) {
        *why = g_strdup_printf("%s is not a serial port: %s",
                               s->port, g_strerror(errno));
        return false;
    }

    if (!serial_speed_code(s->speed, &code)) {
        *why = g_strdup_printf("%s: Speed %d is not one this system offers",
                               s->port, s->speed);
        return false;
    }
    if (cfsetispeed(&tio, code) != 0 || cfsetospeed(&tio, code) != 0) {
        *why = g_strdup_printf("%s: cannot set Speed %d: %s",
                               s->port, s->speed, g_strerror(errno));
        return false;
    }

    /* Raw mode, spelled out rather than `cfmakeraw`, which is a GNU/BSD
     * extension and not POSIX: no echo, no canonical buffering, no signal
     * characters, no input or output post-processing. */
    tio.c_iflag &= ~(IGNBRK | BRKINT | PARMRK | ISTRIP |
                     INLCR | IGNCR | ICRNL | IXON | IXOFF | IXANY);
    tio.c_oflag &= ~OPOST;
    tio.c_lflag &= ~(ECHO | ECHONL | ICANON | ISIG | IEXTEN);
    tio.c_cflag &= ~(CSIZE | PARENB | PARODD | CSTOPB);
#ifdef CRTSCTS
    tio.c_cflag &= ~CRTSCTS;
#endif
#ifdef CMSPAR
    tio.c_cflag &= ~CMSPAR;
#endif
    tio.c_cflag |= CLOCAL | CREAD;
    tio.c_cc[VMIN]  = 1;
    tio.c_cc[VTIME] = 0;

    tio.c_cflag &= ~CSIZE;
    switch (s->data_bits) {
#ifdef CS5
    case 5: tio.c_cflag |= CS5; break;
#endif
#ifdef CS6
    case 6: tio.c_cflag |= CS6; break;
#endif
#ifdef CS7
    case 7: tio.c_cflag |= CS7; break;
#endif
#ifdef CS8
    case 8: tio.c_cflag |= CS8; break;
#endif
    default:
        *why = g_strdup_printf("%s: DataBits %d is not supported",
                               s->port, s->data_bits);
        return false;
    }

    if (!strcmp(s->parity, "Even")) {
        tio.c_cflag |= PARENB;
    } else if (!strcmp(s->parity, "Odd")) {
        tio.c_cflag |= PARENB | PARODD;
    } else if (!strcmp(s->parity, "Mark")) {
#ifdef CMSPAR
        tio.c_cflag |= PARENB | CMSPAR;
#else
        *why = g_strdup_printf("%s: mark parity is not supported here",
                               s->port);
        return false;
#endif
    } else if (!strcmp(s->parity, "Space")) {
#ifdef CMSPAR
        tio.c_cflag |= PARENB | PARODD | CMSPAR;
#else
        *why = g_strdup_printf("%s: space parity is not supported here",
                               s->port);
        return false;
#endif
    }

    if (s->stop_bits == 2)
        tio.c_cflag |= CSTOPB;

    if (!strcmp(s->flow, "Hardware")) {
#ifdef CRTSCTS
        tio.c_cflag |= CRTSCTS;
#else
        *why = g_strdup_printf("%s: hardware flow control is not supported here",
                               s->port);
        return false;
#endif
    } else if (!strcmp(s->flow, "Software")) {
        tio.c_iflag |= IXON | IXOFF;
    }

    if (tcsetattr(fd, TCSANOW, &tio) != 0) {
        *why = g_strdup_printf("%s: cannot configure the port: %s",
                               s->port, g_strerror(errno));
        return false;
    }
    return true;
}

#endif  /* G_OS_WIN32 */

/* ---------------------------------------------------------------- Open */

static JSValue serial_open(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv)
{
    SerialData *s = serial_data(ctx, this_val);

    if (!s)
        return JS_EXCEPTION;
    if (s->open)
        return JS_DupValue(ctx, this_val);
    if (!s->port || !*s->port)
        return JS_ThrowTypeError(ctx, "SerialPort.Open: PortName is empty");

#ifdef G_OS_WIN32
    char *why = NULL;

    if (!bta_serial_win32_open(s, &why)) {
        JSValue e = JS_ThrowPlainError(ctx, "SerialPort.Open: %s",
                                       why ? why : "cannot open the port");
        g_free(why);
        return e;
    }

    s->open = true;
    s->keep = JS_DupValue(ctx, s->self);

    if (!bta_serial_win32_start(s, &why)) {
        s->open = false;
        bta_serial_win32_close(s);
        JS_FreeValue(ctx, s->keep);
        s->keep = JS_UNDEFINED;

        JSValue e = JS_ThrowPlainError(ctx, "SerialPort.Open: %s",
                                       why ? why
                                           : "cannot start the reader and writer threads");
        g_free(why);
        return e;
    }
    g_free(why);

    serial_live_add(s);
    return JS_DupValue(ctx, this_val);
#else
    int flags = O_RDWR | O_NOCTTY | O_NONBLOCK;
#ifdef O_CLOEXEC
    flags |= O_CLOEXEC;
#endif
    int fd = open(s->port, flags);
    if (fd < 0)
        return JS_ThrowPlainError(ctx, "SerialPort.Open: cannot open %s: %s",
                                  s->port, g_strerror(errno));

    char *why = NULL;
    if (!serial_configure(s, fd, &why)) {
        int saved = errno;

        close(fd);
        JSValue e = JS_ThrowPlainError(ctx, "SerialPort.Open: %s",
                                       why ? why : g_strerror(saved));
        g_free(why);
        return e;
    }
    g_free(why);

    tcflush(fd, TCIOFLUSH);

    s->fd       = fd;
    s->open     = true;
    s->write_at = 0;
    s->keep     = JS_DupValue(ctx, s->self);
    s->in_source = g_unix_fd_add_full(G_PRIORITY_DEFAULT, fd,
                                      G_IO_IN | G_IO_ERR | G_IO_HUP,
                                      on_serial_input, s, NULL);
    if (!s->in_source) {
        s->open = false;
        close(fd);
        s->fd = -1;
        JS_FreeValue(ctx, s->keep);
        s->keep = JS_UNDEFINED;
        return JS_ThrowPlainError(ctx,
            "SerialPort.Open: cannot watch %s on the main loop", s->port);
    }
    serial_live_add(s);
    return JS_DupValue(ctx, this_val);
#endif
}

static JSValue serial_close_method(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
    SerialData *s = serial_data(ctx, this_val);

    if (!s)
        return JS_EXCEPTION;
    serial_close(s, false);
    return JS_DupValue(ctx, this_val);
}

/* --------------------------------------------------------------- Write */

static GBytes *serial_bytes(JSContext *ctx, JSValueConst v, const char *who)
{
    if (JS_IsString(v)) {
        size_t      len = 0;
        const char *text = JS_ToCStringLen(ctx, &len, v);

        if (!text)
            return NULL;
        GBytes *b = g_bytes_new(text, len);
        JS_FreeCString(ctx, text);
        return b;
    }

    size_t         len  = 0;
    const uint8_t *data = bta_bytes_get(v, &len);

    if (!data) {
        JS_ThrowTypeError(ctx, "%s: expected text or Bytes", who);
        return NULL;
    }
    return g_bytes_new(data, len);
}

static void serial_queue_write(SerialData *s, GBytes *bytes)
{
#ifdef G_OS_WIN32
    bta_serial_win32_write(s, bytes);
#else
    g_queue_push_tail(s->writes, bytes);
    serial_write_start(s);
#endif
}

static JSValue serial_write(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
    SerialData *s = serial_data(ctx, this_val);

    if (!s)
        return JS_EXCEPTION;
    if (!s->open)
        return JS_ThrowPlainError(ctx, "SerialPort.Write: it is not open");
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "SerialPort.Write(data) needs data");

    GBytes *b = serial_bytes(ctx, argv[0], "SerialPort.Write");
    if (!b)
        return JS_EXCEPTION;
    if (g_bytes_get_size(b) == 0) {
        g_bytes_unref(b);
        return JS_DupValue(ctx, this_val);
    }
    serial_queue_write(s, b);
    return JS_DupValue(ctx, this_val);
}

static JSValue serial_write_line(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv)
{
    SerialData *s = serial_data(ctx, this_val);

    if (!s)
        return JS_EXCEPTION;
    if (!s->open)
        return JS_ThrowPlainError(ctx, "SerialPort.WriteLine: it is not open");
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "SerialPort.WriteLine(data) needs data");

    GBytes *b = serial_bytes(ctx, argv[0], "SerialPort.WriteLine");
    if (!b)
        return JS_EXCEPTION;

    gsize        len = 0;
    const guint8 *data = g_bytes_get_data(b, &len);
    GByteArray   *out  = g_byte_array_sized_new(len + strlen(s->eol));

    g_byte_array_append(out, data, len);
    g_byte_array_append(out, (const guint8 *)s->eol, strlen(s->eol));
    g_bytes_unref(b);

    serial_queue_write(s, g_byte_array_free_to_bytes(out));
    return JS_DupValue(ctx, this_val);
}

/* --------------------------------------------------------------- Clear */

static JSValue serial_clear(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
    SerialData *s = serial_data(ctx, this_val);

    if (!s)
        return JS_EXCEPTION;
    if (s->open) {
#ifdef G_OS_WIN32
        bta_serial_win32_clear(s);
#else
        tcflush(s->fd, TCIFLUSH);
        while (!g_queue_is_empty(s->writes))
            g_bytes_unref(g_queue_pop_head(s->writes));
        s->write_at = 0;
        if (s->out_source) {
            g_source_remove(s->out_source);
            s->out_source = 0;
        }
#endif
        g_byte_array_set_size(s->linebuf, 0);
    }
    return JS_DupValue(ctx, this_val);
}

/* ------------------------------------------------------------- properties */

static bool serial_opt_port(JSContext *ctx, SerialData *s, JSValueConst v)
{
    if (s->open) {
        JS_ThrowTypeError(ctx, "SerialPort.PortName: cannot change while open");
        return false;
    }
    if (!JS_IsString(v)) {
        JS_ThrowTypeError(ctx, "SerialPort.PortName: expected text");
        return false;
    }
    const char *text = JS_ToCString(ctx, v);
    if (!text)
        return false;
    g_free(s->port);
    s->port = g_strdup(text);
    JS_FreeCString(ctx, text);
    return true;
}

static bool serial_opt_speed(JSContext *ctx, SerialData *s, JSValueConst v)
{
    int32_t n;

    if (s->open) {
        JS_ThrowTypeError(ctx, "SerialPort.Speed: cannot change while open");
        return false;
    }
    if (!bta_to_int(ctx, v, "SerialPort.Speed", &n))
        return false;
    if (n < 1 || n > 4000000) {
        JS_ThrowRangeError(ctx, "SerialPort.Speed: 1 to 4000000, got %d", n);
        return false;
    }
    s->speed = n;
    return true;
}

static bool serial_opt_data_bits(JSContext *ctx, SerialData *s, JSValueConst v)
{
    int32_t n;

    if (s->open) {
        JS_ThrowTypeError(ctx, "SerialPort.DataBits: cannot change while open");
        return false;
    }
    if (!bta_to_int(ctx, v, "SerialPort.DataBits", &n))
        return false;
    if (n < 5 || n > 8) {
        JS_ThrowRangeError(ctx, "SerialPort.DataBits: 5 to 8, got %d", n);
        return false;
    }
    s->data_bits = n;
    return true;
}

static bool serial_opt_choice(JSContext *ctx, const char *who, JSValueConst v,
                              const char *const *choices, const char *expected,
                              char **slot)
{
    if (!JS_IsString(v)) {
        JS_ThrowTypeError(ctx, "%s: expected text", who);
        return false;
    }
    const char *text = JS_ToCString(ctx, v);
    if (!text)
        return false;

    bool ok = false;
    for (int i = 0; choices[i]; i++) {
        if (!strcmp(text, choices[i])) {
            ok = true;
            break;
        }
    }
    if (!ok) {
        JS_FreeCString(ctx, text);
        JS_ThrowTypeError(ctx, "%s: expected %s", who, expected);
        return false;
    }
    g_free(*slot);
    *slot = g_strdup(text);
    JS_FreeCString(ctx, text);
    return true;
}

static const char *const serial_parities[] = {
    "None", "Even", "Odd", "Mark", "Space", NULL
};
static const char *const serial_flows[] = {
    "None", "Hardware", "Software", NULL
};

static bool serial_opt_parity(JSContext *ctx, SerialData *s, JSValueConst v)
{
    if (s->open) {
        JS_ThrowTypeError(ctx, "SerialPort.Parity: cannot change while open");
        return false;
    }
    return serial_opt_choice(ctx, "SerialPort.Parity", v, serial_parities,
                             "\"None\", \"Even\", \"Odd\", \"Mark\" or \"Space\"",
                             &s->parity);
}

static bool serial_opt_flow(JSContext *ctx, SerialData *s, JSValueConst v)
{
    if (s->open) {
        JS_ThrowTypeError(ctx, "SerialPort.FlowControl: cannot change while open");
        return false;
    }
    return serial_opt_choice(ctx, "SerialPort.FlowControl", v, serial_flows,
                             "\"None\", \"Hardware\" or \"Software\"", &s->flow);
}

static bool serial_opt_stop_bits(JSContext *ctx, SerialData *s, JSValueConst v)
{
    int32_t n;

    if (s->open) {
        JS_ThrowTypeError(ctx, "SerialPort.StopBits: cannot change while open");
        return false;
    }
    if (!bta_to_int(ctx, v, "SerialPort.StopBits", &n))
        return false;
    if (n != 1 && n != 2) {
        JS_ThrowRangeError(ctx, "SerialPort.StopBits: 1 or 2, got %d", n);
        return false;
    }
    s->stop_bits = n;
    return true;
}

static bool serial_opt_line(JSContext *ctx, SerialData *s, JSValueConst v)
{
    s->line = JS_ToBool(ctx, v);
    return true;
}

static bool serial_opt_eol(JSContext *ctx, SerialData *s, JSValueConst v)
{
    if (!JS_IsString(v)) {
        JS_ThrowTypeError(ctx, "SerialPort.EndOfLine: expected text");
        return false;
    }
    const char *text = JS_ToCString(ctx, v);
    if (!text)
        return false;
    if (!*text) {
        JS_FreeCString(ctx, text);
        JS_ThrowRangeError(ctx, "SerialPort.EndOfLine: it cannot be empty");
        return false;
    }
    g_free(s->eol);
    s->eol = g_strdup(text);
    JS_FreeCString(ctx, text);
    return true;
}

static bool serial_set_option(JSContext *ctx, SerialData *s,
                              const char *key, JSValueConst v)
{
    if (!strcmp(key, "PortName"))    return serial_opt_port(ctx, s, v);
    if (!strcmp(key, "Speed"))       return serial_opt_speed(ctx, s, v);
    if (!strcmp(key, "DataBits"))    return serial_opt_data_bits(ctx, s, v);
    if (!strcmp(key, "Parity"))      return serial_opt_parity(ctx, s, v);
    if (!strcmp(key, "StopBits"))    return serial_opt_stop_bits(ctx, s, v);
    if (!strcmp(key, "FlowControl")) return serial_opt_flow(ctx, s, v);
    if (!strcmp(key, "Line"))        return serial_opt_line(ctx, s, v);
    if (!strcmp(key, "EndOfLine"))   return serial_opt_eol(ctx, s, v);

    JS_ThrowTypeError(ctx, "SerialPort: no option called '%s'; the options are "
                           "PortName, Speed, DataBits, Parity, StopBits, "
                           "FlowControl, Line and EndOfLine", key);
    return false;
}

static bool serial_apply_options(JSContext *ctx, SerialData *s,
                                 JSValueConst opts)
{
    JSPropertyEnum *props = NULL;
    uint32_t        n = 0;
    bool            ok = true;

    if (!JS_IsObject(opts)) {
        JS_ThrowTypeError(ctx, "SerialPort: the options are an object");
        return false;
    }
    if (JS_GetOwnPropertyNames(ctx, &props, &n, opts,
                               JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) < 0)
        return false;

    for (uint32_t i = 0; i < n && ok; i++) {
        const char *key = JS_AtomToCString(ctx, props[i].atom);
        JSValue     v;

        if (!key) {
            ok = false;
            break;
        }
        v = JS_GetPropertyStr(ctx, opts, key);
        if (JS_IsException(v))
            ok = false;
        else {
            ok = serial_set_option(ctx, s, key, v);
            JS_FreeValue(ctx, v);
        }
        JS_FreeCString(ctx, key);
    }
    JS_FreePropertyEnum(ctx, props, n);
    return ok;
}

#define SERIAL_SET(name, opt)                                                 \
    static JSValue serial_set_##name(JSContext *ctx, JSValueConst this_val,    \
                                     JSValueConst v)                           \
    {                                                                          \
        SerialData *s = serial_data(ctx, this_val);                           \
        if (!s) return JS_EXCEPTION;                                           \
        return opt(ctx, s, v) ? JS_UNDEFINED : JS_EXCEPTION;                   \
    }

SERIAL_SET(port,       serial_opt_port)
SERIAL_SET(speed,      serial_opt_speed)
SERIAL_SET(data_bits,  serial_opt_data_bits)
SERIAL_SET(parity,     serial_opt_parity)
SERIAL_SET(stop_bits,  serial_opt_stop_bits)
SERIAL_SET(flow,       serial_opt_flow)
SERIAL_SET(line,       serial_opt_line)
SERIAL_SET(eol,        serial_opt_eol)

static JSValue serial_get_port(JSContext *ctx, JSValueConst this_val)
{
    SerialData *s = JS_GetOpaque(this_val, serial_class_id);
    return s ? JS_NewString(ctx, s->port ? s->port : "") : JS_NULL;
}
static JSValue serial_get_speed(JSContext *ctx, JSValueConst this_val)
{
    SerialData *s = JS_GetOpaque(this_val, serial_class_id);
    return s ? JS_NewInt32(ctx, s->speed) : JS_NULL;
}
static JSValue serial_get_data_bits(JSContext *ctx, JSValueConst this_val)
{
    SerialData *s = JS_GetOpaque(this_val, serial_class_id);
    return s ? JS_NewInt32(ctx, s->data_bits) : JS_NULL;
}
static JSValue serial_get_parity(JSContext *ctx, JSValueConst this_val)
{
    SerialData *s = JS_GetOpaque(this_val, serial_class_id);
    return s ? JS_NewString(ctx, s->parity ? s->parity : "None") : JS_NULL;
}
static JSValue serial_get_stop_bits(JSContext *ctx, JSValueConst this_val)
{
    SerialData *s = JS_GetOpaque(this_val, serial_class_id);
    return s ? JS_NewInt32(ctx, s->stop_bits) : JS_NULL;
}
static JSValue serial_get_flow(JSContext *ctx, JSValueConst this_val)
{
    SerialData *s = JS_GetOpaque(this_val, serial_class_id);
    return s ? JS_NewString(ctx, s->flow ? s->flow : "None") : JS_NULL;
}
static JSValue serial_get_line(JSContext *ctx, JSValueConst this_val)
{
    SerialData *s = JS_GetOpaque(this_val, serial_class_id);
    return s ? JS_NewBool(ctx, s->line) : JS_NULL;
}
static JSValue serial_get_eol(JSContext *ctx, JSValueConst this_val)
{
    SerialData *s = JS_GetOpaque(this_val, serial_class_id);
    return s ? JS_NewString(ctx, s->eol ? s->eol : "\n") : JS_NULL;
}
static JSValue serial_get_open(JSContext *ctx, JSValueConst this_val)
{
    SerialData *s = JS_GetOpaque(this_val, serial_class_id);
    return s ? JS_NewBool(ctx, s->open) : JS_NULL;
}

static JSValue serial_get_handler(JSContext *ctx, JSValueConst this_val,
                                  JSValue *slot)
{
    (void)this_val;
    return JS_DupValue(ctx, *slot);
}

static JSValue serial_set_handler(JSContext *ctx, JSValueConst this_val,
                                  JSValueConst v, JSValue *slot, const char *who)
{
    (void)this_val;
    if (!JS_IsNull(v) && !JS_IsUndefined(v) && !JS_IsFunction(ctx, v))
        return JS_ThrowTypeError(ctx, "%s: expected a function, or null", who);
    JS_FreeValue(ctx, *slot);
    *slot = JS_IsFunction(ctx, v) ? JS_DupValue(ctx, v) : JS_UNDEFINED;
    return JS_UNDEFINED;
}

#define SERIAL_HANDLER(name, field, who)                                     \
    static JSValue serial_get_##name(JSContext *ctx, JSValueConst this_val)   \
    {                                                                         \
        SerialData *s = JS_GetOpaque(this_val, serial_class_id);              \
        return s ? serial_get_handler(ctx, this_val, &s->field) : JS_NULL;    \
    }                                                                         \
    static JSValue serial_set_##name(JSContext *ctx, JSValueConst this_val,   \
                                     JSValueConst v)                          \
    {                                                                         \
        SerialData *s = serial_data(ctx, this_val);                           \
        if (!s) return JS_EXCEPTION;                                          \
        return serial_set_handler(ctx, this_val, v, &s->field, who);          \
    }

SERIAL_HANDLER(on_data,  on_data,  "SerialPort.OnData")
SERIAL_HANDLER(on_line,  on_line,  "SerialPort.OnLine")
SERIAL_HANDLER(on_error, on_error, "SerialPort.OnError")

/* ------------------------------------------------------------- the class */

static void serial_finalizer(JSRuntime *rt, JSValue v)
{
    SerialData *s = JS_GetOpaque(v, serial_class_id);

    if (!s)
        return;

    serial_close(s, true);
    JS_FreeValueRT(rt, s->keep);
    JS_FreeValueRT(rt, s->on_data);
    JS_FreeValueRT(rt, s->on_line);
    JS_FreeValueRT(rt, s->on_error);
    g_free(s->port);
    g_free(s->parity);
    g_free(s->flow);
    g_free(s->eol);
    if (s->writes)
        g_queue_free_full(s->writes, (GDestroyNotify)g_bytes_unref);
    if (s->linebuf)
        g_byte_array_unref(s->linebuf);
    g_free(s);
}

static void serial_gc_mark(JSRuntime *rt, JSValueConst v, JS_MarkFunc *mark)
{
    SerialData *s = JS_GetOpaque(v, serial_class_id);

    if (!s)
        return;
    JS_MarkValue(rt, s->keep, mark);
    JS_MarkValue(rt, s->on_data, mark);
    JS_MarkValue(rt, s->on_line, mark);
    JS_MarkValue(rt, s->on_error, mark);
}

static const JSClassDef serial_def = {
    "SerialPort",
    .finalizer = serial_finalizer,
    .gc_mark   = serial_gc_mark,
};

static JSValue serial_construct(JSContext *ctx, JSValueConst new_target,
                                int argc, JSValueConst *argv)
{
    JSValue obj = JS_NewObjectClass(ctx, serial_class_id);
    SerialData *s;

    if (JS_IsException(obj))
        return obj;

    s = g_new0(SerialData, 1);
    s->ctx        = ctx;
    s->self       = obj;
    s->keep       = JS_UNDEFINED;
    s->on_data    = JS_UNDEFINED;
    s->on_line    = JS_UNDEFINED;
    s->on_error   = JS_UNDEFINED;
    s->port       = g_strdup("");
    s->speed      = 9600;
    s->data_bits  = 8;
    s->parity     = g_strdup("None");
    s->stop_bits  = 1;
    s->flow       = g_strdup("None");
    s->eol        = g_strdup("\n");
    s->fd         = -1;
    s->writes     = g_queue_new();
    s->linebuf    = g_byte_array_new();
    JS_SetOpaque(obj, s);

    if (argc > 0 && !JS_IsUndefined(argv[0])) {
        if (!serial_apply_options(ctx, s, argv[0])) {
            JS_FreeValue(ctx, obj);
            return JS_EXCEPTION;
        }
    }
    return obj;
}

/* type SerialPort */
static const JSCFunctionListEntry serial_props[] = {
    /* PortName
     *   the device path, `/dev/ttyUSB0` or `/dev/ttyACM0` on Linux, `COM3`
     *   (or `\\.\COM3`) on Windows. Set before `Open`
     */
    JS_CGETSET_DEF("PortName", serial_get_port, serial_set_port),
    /* Speed
     *   the baud rate, 1 to 4000000. A rate the driver refuses is refused by
     *   `Open`, which names it
     */
    JS_CGETSET_DEF("Speed", serial_get_speed, serial_set_speed),
    /* DataBits
     *   `5` to `8`, default `8`
     */
    JS_CGETSET_DEF("DataBits", serial_get_data_bits, serial_set_data_bits),
    /* Parity
     *   `"None"` (the default), `"Even"`, `"Odd"`, `"Mark"` or `"Space"`;
     *   the last two need the driver's support
     */
    JS_CGETSET_DEF("Parity", serial_get_parity, serial_set_parity),
    /* StopBits
     *   `1` (the default) or `2`
     */
    JS_CGETSET_DEF("StopBits", serial_get_stop_bits, serial_set_stop_bits),
    /* FlowControl
     *   `"None"` (the default), `"Hardware"` or `"Software"`
     */
    JS_CGETSET_DEF("FlowControl", serial_get_flow, serial_set_flow),
    /* Line
     *   `true`: buffer and raise `OnLine` for each complete `EndOfLine`;
     *   `false` (the default): `OnData` with the bytes one read returned.
     *   **A serial port is a byte stream**, so a chunk is not a frame
     */
    JS_CGETSET_DEF("Line", serial_get_line, serial_set_line),
    /* EndOfLine
     *   the line separator `Line` uses, `"\n"` by default: `"\r\n"` for
     *   many devices
     */
    JS_CGETSET_DEF("EndOfLine", serial_get_eol, serial_set_eol),
    /* IsOpen
     *   whether the port is open now
     */
    JS_CGETSET_DEF("IsOpen", serial_get_open, NULL),
    /* OnData
     *   assign `(bytes) => …`: bytes arrived, **not** a message. `Line: true`
     *   uses `OnLine` instead
     */
    JS_CGETSET_DEF("OnData", serial_get_on_data, serial_set_on_data),
    /* OnLine
     *   assign `(line) => …`: one complete line, without the separator, in
     *   `Line: true` mode
     */
    JS_CGETSET_DEF("OnLine", serial_get_on_line, serial_set_on_line),
    /* OnError
     *   assign `(err) => …` with `{ Message, Kind }`; `Kind` is `"Error"` or
     *   `"Closed"`. The port is closed when it arrives
     */
    JS_CGETSET_DEF("OnError", serial_get_on_error, serial_set_on_error),
    /* Open()
     *   open and configure the port. Answers the port; a second `Open` on an
     *   open port does nothing
     */
    JS_CFUNC_DEF("Open", 0, serial_open),
    /* Close()
     *   close it; the next `Open` starts again. `Write` on a closed port
     *   throws
     */
    JS_CFUNC_DEF("Close", 0, serial_close_method),
    /* Write(data)
     *   queue text (UTF-8) or `Bytes`; answers the port. It throws when the
     *   port is not open, which is a mistake and not a late answer
     */
    JS_CFUNC_DEF("Write", 1, serial_write),
    /* WriteLine(data)
     *   `Write` followed by `EndOfLine`
     */
    JS_CFUNC_DEF("WriteLine", 1, serial_write_line),
    /* Clear()
     *   discard what has arrived but not been delivered, and anything queued
     *   to write. Answers the port
     */
    JS_CFUNC_DEF("Clear", 0, serial_clear),
};

static JSValue serial_worker_construct(JSContext *ctx, JSValueConst new_target,
                                       int argc, JSValueConst *argv)
{
    return JS_ThrowPlainError(ctx,
        "SerialPort: a Task worker has no main loop, so there is nothing to "
        "deliver the bytes to. Keep the port on the window's thread");
}

void bta_serial_init(JSContext *ctx, JSValue global)
{
    JSRuntime *rt = JS_GetRuntime(ctx);
    JSValue    proto, ctor;

    JS_NewClassID(rt, &serial_class_id);
    JS_NewClass(rt, serial_class_id, &serial_def);

    proto = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, proto, serial_props,
                               G_N_ELEMENTS(serial_props));
    JS_SetClassProto(ctx, serial_class_id, proto);

    ctor = JS_NewCFunction2(ctx, serial_construct, "SerialPort", 0,
                            JS_CFUNC_constructor, 0);
    JS_SetConstructor(ctx, ctor, proto);
    JS_SetPropertyStr(ctx, global, "SerialPort", ctor);
}

void bta_serial_init_worker(JSContext *ctx, JSValue global)
{
    JSValue ctor = JS_NewCFunction2(ctx, serial_worker_construct, "SerialPort",
                                    0, JS_CFUNC_constructor, 0);

    JS_SetPropertyStr(ctx, global, "SerialPort", ctor);
}

guint bta_serial_pending(void)
{
    return g_list_length(serial_live);
}

void bta_serial_cleanup(void)
{
    while (serial_live) {
        SerialData *s = serial_live->data;

        serial_close(s, false);
    }
}
