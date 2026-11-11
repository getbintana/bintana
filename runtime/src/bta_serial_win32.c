/*
 * SerialPort on Windows: a COM handle, a DCB and two threads.
 *
 * `bta_serial.c` owns the JS surface, the line buffer and the events; this
 * file owns the handle and the I/O.  A COM HANDLE is not pollable by GLib,
 * so a reader thread does the blocking `ReadFile` and a writer thread drains
 * the write queue.  Neither touches a JSValue: they post events to a queue
 * and one idle on the main loop hands them to `OnData`, `OnLine` or
 * `OnError`, which is what keeps every handler on the window's thread.
 *
 * `SerialIo` is reference counted: the owner, each thread and the scheduled
 * idle hold one.  `Close` stops the threads, but an idle already queued may
 * still run; it sees `owner == NULL` and drops what is left instead of
 * reaching into a finalized wrapper.
 */
#include "bta_serial_internal.h"

#include <windows.h>
#include <string.h>

#ifdef G_OS_WIN32

typedef enum {
    SERIAL_EVENT_DATA,
    SERIAL_EVENT_ERROR,
    SERIAL_EVENT_CLOSED,
} SerialEventKind;

typedef struct {
    SerialEventKind kind;
    GBytes         *bytes;   /* DATA */
    char           *text;    /* ERROR, CLOSED */
} SerialEvent;

struct SerialIo {
    gint       refs;         /* atomic */
    gint       stop;         /* atomic */

    HANDLE     handle;
    HANDLE     read_thread;
    HANDLE     write_thread;
    HANDLE     write_event;  /* auto-reset: there is something to write */

    GMutex     lock;         /* events, idle_scheduled */
    GQueue    *events;       /* SerialEvent *, worker -> main */
    bool       idle_scheduled;

    GMutex     write_lock;   /* writes */
    GQueue    *writes;       /* GBytes *, main -> writer */

    SerialData *owner;       /* main thread only; NULL once closed */
};

/* ------------------------------------------------------- the Windows half */

static gboolean serial_events_idle(gpointer data);

static char *serial_win32_error_code(DWORD code, const char *what)
{
    gchar *text = g_win32_error_message((gint)code);
    char  *out;

    if (text)
        g_strchomp(text);
    out = g_strdup_printf("%s: %s", what,
                          text && *text ? text : "a Windows error");
    g_free(text);
    return out;
}

static void serial_event_free(SerialEvent *ev)
{
    if (!ev)
        return;
    if (ev->bytes)
        g_bytes_unref(ev->bytes);
    g_free(ev->text);
    g_free(ev);
}

static SerialIo *serial_io_ref(SerialIo *io)
{
    g_atomic_int_inc(&io->refs);
    return io;
}

static void serial_io_unref(SerialIo *io)
{
    if (!g_atomic_int_dec_and_test(&io->refs))
        return;

    if (io->write_event)
        CloseHandle(io->write_event);
    while (!g_queue_is_empty(io->events))
        serial_event_free(g_queue_pop_head(io->events));
    g_queue_free(io->events);
    while (!g_queue_is_empty(io->writes))
        g_bytes_unref(g_queue_pop_head(io->writes));
    g_queue_free(io->writes);
    g_mutex_clear(&io->lock);
    g_mutex_clear(&io->write_lock);
    g_free(io);
}

static SerialIo *serial_io_new(HANDLE handle, SerialData *owner)
{
    SerialIo *io = g_new0(SerialIo, 1);

    io->refs   = 1;
    io->handle = INVALID_HANDLE_VALUE;
    io->owner  = owner;
    io->events = g_queue_new();
    io->writes = g_queue_new();
    g_mutex_init(&io->lock);
    g_mutex_init(&io->write_lock);
    io->write_event = CreateEventW(NULL, FALSE, FALSE, NULL);
    if (!io->write_event) {
        serial_io_unref(io);
        return NULL;
    }
    io->handle = handle;
    return io;
}

/* `bytes` and `text` are handed over.  The first event schedules the idle;
 * the worker never calls into JavaScript. */
static void serial_io_post(SerialIo *io, SerialEventKind kind,
                           GBytes *bytes, char *text)
{
    SerialEvent *ev = g_new0(SerialEvent, 1);
    bool         schedule;

    ev->kind  = kind;
    ev->bytes = bytes;
    ev->text  = text;

    g_mutex_lock(&io->lock);
    g_queue_push_tail(io->events, ev);
    schedule = !io->idle_scheduled;
    if (schedule)
        io->idle_scheduled = true;
    g_mutex_unlock(&io->lock);

    if (schedule) {
        serial_io_ref(io);
        g_idle_add_full(G_PRIORITY_DEFAULT, serial_events_idle, io,
                        (GDestroyNotify)serial_io_unref);
    }
}

static void serial_io_post_error(SerialIo *io, SerialEventKind kind,
                                 DWORD code, const char *what)
{
    serial_io_post(io, kind, NULL, serial_win32_error_code(code, what));
}

/* One idle drains everything the threads have posted, in order.  It holds its
 * own reference: a handler may Close the port, which drops the owner's
 * reference while this function is still running. */
static gboolean serial_events_idle(gpointer data)
{
    SerialIo *io = data;

    serial_io_ref(io);

    for (;;) {
        SerialEvent *ev;
        SerialData  *s;

        g_mutex_lock(&io->lock);
        ev = g_queue_pop_head(io->events);
        if (!ev) {
            io->idle_scheduled = false;
            g_mutex_unlock(&io->lock);
            break;
        }
        g_mutex_unlock(&io->lock);

        s = io->owner;
        if (s && s->open && s->io == io) {
            switch (ev->kind) {
            case SERIAL_EVENT_DATA: {
                gsize         len   = 0;
                const guint8 *bytes = g_bytes_get_data(ev->bytes, &len);

                bta_serial_deliver(s, bytes, len);
                break;
            }
            case SERIAL_EVENT_ERROR:
                bta_serial_fail(s, "Error",
                            ev->text ? ev->text : "the port failed");
                break;
            case SERIAL_EVENT_CLOSED:
                bta_serial_fail(s, "Closed",
                            ev->text ? ev->text : "the port went away");
                break;
            }
        }

        serial_event_free(ev);
    }

    serial_io_unref(io);
    return G_SOURCE_REMOVE;
}

static bool serial_win32_gone(DWORD code)
{
    return code == ERROR_ACCESS_DENIED || code == ERROR_DEVICE_REMOVED ||
           code == ERROR_BAD_COMMAND  || code == ERROR_NO_SUCH_DEVICE ||
           code == ERROR_FILE_NOT_FOUND || code == ERROR_GEN_FAILURE;
}

static DWORD WINAPI serial_io_read_thread(LPVOID data)
{
    SerialIo *io = data;
    guint8    buf[SERIAL_CHUNK];

    while (!g_atomic_int_get(&io->stop)) {
        DWORD got = 0;

        if (!ReadFile(io->handle, buf, sizeof buf, &got, NULL)) {
            DWORD code = GetLastError();

            if (g_atomic_int_get(&io->stop))
                break;
            serial_io_post_error(io,
                                 serial_win32_gone(code)
                                     ? SERIAL_EVENT_CLOSED : SERIAL_EVENT_ERROR,
                                 code, "cannot read the port");
            break;
        }
        if (got)
            serial_io_post(io, SERIAL_EVENT_DATA,
                           g_bytes_new(buf, (gsize)got), NULL);
    }

    serial_io_unref(io);
    return 0;
}

static DWORD WINAPI serial_io_write_thread(LPVOID arg)
{
    SerialIo *io = arg;

    while (!g_atomic_int_get(&io->stop)) {
        WaitForSingleObject(io->write_event, INFINITE);
        if (g_atomic_int_get(&io->stop))
            break;

        for (;;) {
            GBytes       *b;
            gsize         len  = 0;
            gsize         at   = 0;
            const guint8 *data;
            bool          failed = false;

            g_mutex_lock(&io->write_lock);
            b = g_queue_pop_head(io->writes);
            g_mutex_unlock(&io->write_lock);
            if (!b)
                break;

            data = g_bytes_get_data(b, &len);
            while (at < len) {
                DWORD chunk = (DWORD)MIN(len - at, (gsize)0x7fffffff);
                DWORD wrote = 0;
                BOOL  ok;

                ok = WriteFile(io->handle, data + at, chunk, &wrote, NULL);
                if (!ok) {
                    DWORD code = GetLastError();

                    if (!g_atomic_int_get(&io->stop))
                        serial_io_post_error(io,
                                             serial_win32_gone(code)
                                                 ? SERIAL_EVENT_CLOSED
                                                 : SERIAL_EVENT_ERROR,
                                             code, "cannot write to the port");
                    failed = true;
                    break;
                }
                if (!wrote) {
                    if (!g_atomic_int_get(&io->stop))
                        serial_io_post(io, SERIAL_EVENT_ERROR, NULL,
                                       g_strdup("the port accepted none of the bytes"));
                    failed = true;
                    break;
                }
                at += wrote;
            }

            g_bytes_unref(b);
            if (failed)
                goto done;
        }
    }

done:
    serial_io_unref(io);
    return 0;
}

static bool serial_io_start(SerialIo *io)
{
    io->write_thread = CreateThread(NULL, 0, serial_io_write_thread,
                                    serial_io_ref(io), 0, NULL);
    if (!io->write_thread) {
        serial_io_unref(io);
        return false;
    }
    io->read_thread = CreateThread(NULL, 0, serial_io_read_thread,
                                   serial_io_ref(io), 0, NULL);
    if (!io->read_thread) {
        serial_io_unref(io);
        return false;
    }
    return true;
}

static void serial_io_stop(SerialIo *io)
{
    if (!io)
        return;

    g_atomic_int_set(&io->stop, 1);
    if (io->write_event)
        SetEvent(io->write_event);

    if (io->read_thread) {
        CancelSynchronousIo(io->read_thread);
        WaitForSingleObject(io->read_thread, 5000);
        CloseHandle(io->read_thread);
        io->read_thread = NULL;
    }
    if (io->write_thread) {
        CancelSynchronousIo(io->write_thread);
        WaitForSingleObject(io->write_thread, 5000);
        CloseHandle(io->write_thread);
        io->write_thread = NULL;
    }

    if (io->handle && io->handle != INVALID_HANDLE_VALUE) {
        PurgeComm(io->handle, PURGE_RXCLEAR | PURGE_TXCLEAR);
        CloseHandle(io->handle);
        io->handle = INVALID_HANDLE_VALUE;
    }

    g_mutex_lock(&io->write_lock);
    while (!g_queue_is_empty(io->writes))
        g_bytes_unref(g_queue_pop_head(io->writes));
    g_mutex_unlock(&io->write_lock);
}

static void serial_io_enqueue(SerialIo *io, GBytes *bytes)
{
    if (!io) {
        g_bytes_unref(bytes);
        return;
    }
    g_mutex_lock(&io->write_lock);
    g_queue_push_tail(io->writes, bytes);
    g_mutex_unlock(&io->write_lock);
    SetEvent(io->write_event);
}

/* `Clear`: the driver's buffers, what is queued to write, and bytes already
 * read but not delivered.  Errors are kept -- they are still true. */
static void serial_io_clear(SerialIo *io)
{
    if (!io)
        return;

    if (io->handle && io->handle != INVALID_HANDLE_VALUE)
        PurgeComm(io->handle, PURGE_RXCLEAR | PURGE_TXCLEAR);

    g_mutex_lock(&io->write_lock);
    while (!g_queue_is_empty(io->writes))
        g_bytes_unref(g_queue_pop_head(io->writes));
    g_mutex_unlock(&io->write_lock);

    g_mutex_lock(&io->lock);
    GQueue *kept = g_queue_new();

    while (!g_queue_is_empty(io->events)) {
        SerialEvent *ev = g_queue_pop_head(io->events);

        if (ev->kind == SERIAL_EVENT_DATA)
            serial_event_free(ev);
        else
            g_queue_push_tail(kept, ev);
    }
    g_queue_free(io->events);
    io->events = kept;
    g_mutex_unlock(&io->lock);
}

/*
 * The DCB is the termios of Windows: baud rate, byte size, parity, stop bits
 * and flow control in one structure.  The handle is synchronous on purpose --
 * `FILE_FLAG_OVERLAPPED` would force every ReadFile and WriteFile to carry an
 * OVERLAPPED -- and the reader thread is what keeps the blocking call off the
 * window's thread.
 */
static bool serial_configure(SerialData *s, HANDLE handle, char **why)
{
    DCB          dcb;
    COMMTIMEOUTS timeouts;

    ZeroMemory(&dcb, sizeof dcb);
    dcb.DCBlength = sizeof dcb;
    if (!GetCommState(handle, &dcb)) {
        *why = serial_win32_error_code(GetLastError(), s->port);
        return false;
    }

    dcb.BaudRate = (DWORD)s->speed;
    dcb.ByteSize = (BYTE)s->data_bits;
    dcb.fBinary  = TRUE;
    dcb.fParity  = strcmp(s->parity, "None") != 0;

    dcb.fOutxCtsFlow  = FALSE;
    dcb.fOutxDsrFlow  = FALSE;
    dcb.fDsrSensitivity = FALSE;
    dcb.fOutX         = FALSE;
    dcb.fInX          = FALSE;
    dcb.fErrorChar    = FALSE;
    dcb.fAbortOnError = FALSE;
    dcb.fNull         = FALSE;

    /* Opening a port asserts DTR and RTS, as a tty driver does.  A device
     * that resets when DTR drops (an Arduino) sees the reset on Open, not on
     * the first byte. */
    dcb.fDtrControl = DTR_CONTROL_ENABLE;
    dcb.fRtsControl = RTS_CONTROL_ENABLE;

    if (!strcmp(s->parity, "Even"))
        dcb.Parity = EVENPARITY;
    else if (!strcmp(s->parity, "Odd"))
        dcb.Parity = ODDPARITY;
    else if (!strcmp(s->parity, "Mark"))
        dcb.Parity = MARKPARITY;
    else if (!strcmp(s->parity, "Space"))
        dcb.Parity = SPACEPARITY;
    else
        dcb.Parity = NOPARITY;

    dcb.StopBits = s->stop_bits == 2 ? TWOSTOPBITS : ONESTOPBIT;

    if (!strcmp(s->flow, "Hardware")) {
        dcb.fOutxCtsFlow = TRUE;
        dcb.fRtsControl  = RTS_CONTROL_HANDSHAKE;
    } else if (!strcmp(s->flow, "Software")) {
        dcb.fOutX    = TRUE;
        dcb.fInX     = TRUE;
        dcb.XonChar  = 0x11;
        dcb.XoffChar = 0x13;
    }

    if (!SetCommState(handle, &dcb)) {
        *why = serial_win32_error_code(GetLastError(), s->port);
        return false;
    }

    /* Not load-bearing: a driver that does not implement it keeps its own
     * buffer sizes, and the default is enough. */
    SetupComm(handle, 65536, 65536);

    /* **The special read mode**: return immediately with the bytes that are
     * there, and otherwise wait for the first byte.  The total timeout is a
     * one-second floor so the reader notices `stop` even if the cancel
     * misses; it is not polling. */
    ZeroMemory(&timeouts, sizeof timeouts);
    timeouts.ReadIntervalTimeout         = MAXDWORD;
    timeouts.ReadTotalTimeoutMultiplier  = MAXDWORD;
    timeouts.ReadTotalTimeoutConstant    = 1000;
    timeouts.WriteTotalTimeoutMultiplier = 0;
    timeouts.WriteTotalTimeoutConstant   = 0;
    if (!SetCommTimeouts(handle, &timeouts)) {
        *why = serial_win32_error_code(GetLastError(), s->port);
        return false;
    }
    return true;
}

/* `COM3` and `\\.\COM3` name the same port; CreateFileW wants the second for
 * everything above COM9, so a bare COM name is prefixed here and anything
 * else is passed through. */
static wchar_t *serial_win32_path(const char *port)
{
    char      *full;
    gunichar2 *wide;

    if (g_ascii_strncasecmp(port, "COM", 3) == 0 && port[3]) {
        const char *p = port + 3;

        while (*p && g_ascii_isdigit(*p))
            p++;
        full = *p ? g_strdup(port) : g_strdup_printf("\\\\.\\%s", port);
    } else {
        full = g_strdup(port);
    }

    wide = g_utf8_to_utf16(full, -1, NULL, NULL, NULL);
    g_free(full);
    return (wchar_t *)wide;
}

static HANDLE serial_win32_open(const char *port, char **why)
{
    wchar_t *path = serial_win32_path(port);
    HANDLE   handle;

    if (!path) {
        *why = g_strdup_printf("%s: PortName is not valid UTF-8", port);
        return INVALID_HANDLE_VALUE;
    }

    handle = CreateFileW(path, GENERIC_READ | GENERIC_WRITE, 0, NULL,
                         OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (handle == INVALID_HANDLE_VALUE)
        *why = serial_win32_error_code(GetLastError(), port);
    g_free(path);
    return handle;
}

/* ------------------------------------------------- the surface's calls */

bool bta_serial_win32_open(SerialData *s, char **why)
{
    HANDLE   handle = serial_win32_open(s->port, why);
    SerialIo *io;

    if (handle == INVALID_HANDLE_VALUE)
        return false;
    if (!serial_configure(s, handle, why)) {
        CloseHandle(handle);
        return false;
    }
    PurgeComm(handle, PURGE_RXCLEAR | PURGE_TXCLEAR);

    io = serial_io_new(handle, s);
    if (!io) {
        CloseHandle(handle);
        *why = g_strdup("cannot create the port's event");
        return false;
    }
    s->io = io;
    return true;
}

bool bta_serial_win32_start(SerialData *s, char **why)
{
    if (!s->io) {
        *why = g_strdup("the port is not open");
        return false;
    }
    if (!serial_io_start(s->io)) {
        *why = g_strdup("cannot start the reader and writer threads");
        return false;
    }
    *why = NULL;
    return true;
}

void bta_serial_win32_close(SerialData *s)
{
    SerialIo *io = s->io;

    if (!io)
        return;
    s->io     = NULL;
    io->owner = NULL;
    serial_io_stop(io);
    serial_io_unref(io);
}

void bta_serial_win32_write(SerialData *s, GBytes *bytes)
{
    serial_io_enqueue(s->io, bytes);
}

void bta_serial_win32_clear(SerialData *s)
{
    serial_io_clear(s->io);
}

#endif  /* G_OS_WIN32 */
