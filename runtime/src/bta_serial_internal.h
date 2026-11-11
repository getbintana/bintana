/*
 * SerialPort's private half: the state both backends share.
 *
 * `bta_serial.c` owns the JS surface, the line buffer and the events;
 * `bta_serial_win32.c` owns the COM handle, its threads and their queue.  This
 * header is the contract between them, and is not installed.
 */
#ifndef BTA_SERIAL_INTERNAL_H
#define BTA_SERIAL_INTERNAL_H

#include "bta.h"

#include <gio/gio.h>

/* One read.  A serial device answers in small frames, but a USB adapter can
 * deliver more; the kernel gives what it has. */
#define SERIAL_CHUNK 65536

/* A line that never ends is a device that is not speaking the protocol.  The
 * cap is the same order as the socket's, and it turns an unbounded buffer into
 * an error instead of a program that grows until the machine stops. */
#define SERIAL_LINE_MAX (1024 * 1024)

typedef struct SerialIo SerialIo;

typedef struct {
    JSContext *ctx;
    JSValue    self;       /* BORROWED: the wrapper owns this struct */
    JSValue    keep;       /* open: a strong reference to self */
    JSValue    on_data;
    JSValue    on_line;
    JSValue    on_error;

    char      *port;       /* PortName */
    int        speed;
    int        data_bits;
    char      *parity;     /* "None", "Even", "Odd", "Mark", "Space" */
    int        stop_bits;
    char      *flow;       /* "None", "Hardware", "Software" */
    bool       line;
    char      *eol;

    bool       open;
    bool       in_live;
    int        fd;
    guint      in_source;
    guint      out_source;
    bool       writing;
    gsize      write_at;
    GQueue    *writes;     /* GBytes *, owned */
    GByteArray *linebuf;
#ifdef G_OS_WIN32
    SerialIo  *io;         /* the COM handle, its threads and their queues */
#endif
} SerialData;

/* bta_serial.c's delivery and failure paths, called by the Windows idle. */
void bta_serial_deliver(SerialData *s, const guint8 *data, size_t len);
void bta_serial_fail(SerialData *s, const char *kind, const char *detail);

#ifdef G_OS_WIN32

/* Opens and configures the handle and allocates the port's `SerialIo`, but
 * starts no thread: the caller sets `open` and `keep` first. */
bool bta_serial_win32_open(SerialData *s, char **why);

/* Starts the reader and the writer.  On failure the caller closes. */
bool bta_serial_win32_start(SerialData *s, char **why);

/* Stops and joins both threads, closes the handle and drops the `SerialIo`.
 * Safe on a port that never opened. */
void bta_serial_win32_close(SerialData *s);

void bta_serial_win32_write(SerialData *s, GBytes *bytes);
void bta_serial_win32_clear(SerialData *s);

#endif  /* G_OS_WIN32 */

#endif  /* BTA_SERIAL_INTERNAL_H */
