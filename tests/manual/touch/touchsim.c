/*
 * A virtual touch screen, driven by lines on stdin.  Needs write access to
 * /dev/uinput (root, here), which is why `run.sh` starts it with `sudo` and
 * nothing else.
 *
 *     touchsim <screen-width> <screen-height>
 *
 * Coordinates are pixels of the whole X screen (the device's range is the
 * screen's, so the server maps it one to one).  One command per line; `ok` is
 * written after each, once the gesture has been played:
 *
 *     tap X Y
 *     hold X Y MS
 *     swipe X1 Y1 X2 Y2 MS
 *     pinch CX CY R1 R2 MS            two fingers, apart R1 -> R2 (half distance)
 *     rotate CX CY R DEGREES MS       two fingers on a circle of radius R
 *     pan2 X1 Y1 X2 Y2 MS             two fingers, 80 px apart, moving together
 *     scale KX KY                     the server maps the range KX, KY times larger than the screen
 *     quit
 */
#define _GNU_SOURCE
#include <fcntl.h>
#include <linux/uinput.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/ioctl.h>
#include <string.h>
#include <unistd.h>

#define FRAME_MS 16
#define SLOTS    5

static int fd, width, height;
static int ids[SLOTS], next_id = 1, down_count;
static double kx = 1, ky = 1;   /* what the server makes of the device range: screen = device * k */

static void ev(int type, int code, int value)
{
    struct input_event e;
    memset(&e, 0, sizeof e);
    e.type = type; e.code = code; e.value = value;
    if (write(fd, &e, sizeof e) < 0) perror("write");
}

static void syn(void) { ev(EV_SYN, SYN_REPORT, 0); }
static void pause_ms(int ms) { usleep((useconds_t)ms * 1000); }

static int clampi(double v, int hi) { return v < 0 ? 0 : v > hi ? hi : (int)lround(v); }

/* A finger is on the glass at (x, y): first contact or an update. */
static void put(int slot, double x, double y)
{
    int px = clampi(x / kx, width - 1), py = clampi(y / ky, height - 1);
    ev(EV_ABS, ABS_MT_SLOT, slot);
    if (!ids[slot]) {
        ids[slot] = next_id++;
        ev(EV_ABS, ABS_MT_TRACKING_ID, ids[slot]);
        if (!down_count) ev(EV_KEY, BTN_TOUCH, 1);
        down_count++;
    }
    ev(EV_ABS, ABS_MT_POSITION_X, px);
    ev(EV_ABS, ABS_MT_POSITION_Y, py);
    if (slot == 0) { ev(EV_ABS, ABS_X, px); ev(EV_ABS, ABS_Y, py); }
}

static void lift(int slot)
{
    ev(EV_ABS, ABS_MT_SLOT, slot);
    ev(EV_ABS, ABS_MT_TRACKING_ID, -1);
    ids[slot] = 0;
    if (--down_count == 0) ev(EV_KEY, BTN_TOUCH, 0);
    syn();
}

static double lerp(double a, double b, double t) { return a + (b - a) * t; }
static int steps(int ms) { int n = ms / FRAME_MS; return n < 2 ? 2 : n; }

static void tap(double x, double y)
{
    put(0, x, y); syn(); pause_ms(80); lift(0);
}

static void hold(double x, double y, int ms)
{
    put(0, x, y); syn(); pause_ms(ms); lift(0);
}

static void swipe(double x1, double y1, double x2, double y2, int ms)
{
    int n = steps(ms);
    put(0, x1, y1); syn(); pause_ms(FRAME_MS);
    for (int i = 1; i <= n; i++) {
        double t = (double)i / n;
        put(0, lerp(x1, x2, t), lerp(y1, y2, t)); syn(); pause_ms(FRAME_MS);
    }
    lift(0);
}

static void pinch(double cx, double cy, double r1, double r2, int ms)
{
    int n = steps(ms);
    put(0, cx - r1, cy); put(1, cx + r1, cy); syn(); pause_ms(60);
    for (int i = 1; i <= n; i++) {
        double r = lerp(r1, r2, (double)i / n);
        put(0, cx - r, cy); put(1, cx + r, cy); syn(); pause_ms(FRAME_MS);
    }
    lift(1); lift(0);
}

static void rotate(double cx, double cy, double r, double degrees, int ms)
{
    int n = steps(ms);
    put(0, cx - r, cy); put(1, cx + r, cy); syn(); pause_ms(60);
    for (int i = 1; i <= n; i++) {
        double a = degrees * M_PI / 180.0 * i / n;
        put(0, cx - r * cos(a), cy - r * sin(a));
        put(1, cx + r * cos(a), cy + r * sin(a));
        syn(); pause_ms(FRAME_MS);
    }
    lift(1); lift(0);
}

static void pan2(double x1, double y1, double x2, double y2, int ms)
{
    int n = steps(ms);
    put(0, x1 - 40, y1); put(1, x1 + 40, y1); syn(); pause_ms(60);
    for (int i = 1; i <= n; i++) {
        double t = (double)i / n, x = lerp(x1, x2, t), y = lerp(y1, y2, t);
        put(0, x - 40, y); put(1, x + 40, y); syn(); pause_ms(FRAME_MS);
    }
    lift(1); lift(0);
}

static void abs_axis(int code, int max, int resolution)
{
    struct uinput_abs_setup s;
    memset(&s, 0, sizeof s);
    s.code = code;
    s.absinfo.maximum = max;
    s.absinfo.resolution = resolution;
    if (ioctl(fd, UI_ABS_SETUP, &s) < 0) perror("UI_ABS_SETUP");
}

int main(int argc, char **argv)
{
    if (argc != 3 || (width = atoi(argv[1])) < 2 || (height = atoi(argv[2])) < 2) {
        fprintf(stderr, "usage: touchsim <screen-width> <screen-height>\n");
        return 2;
    }
    fd = open("/dev/uinput", O_WRONLY | O_NONBLOCK);
    if (fd < 0) { perror("/dev/uinput"); return 1; }

    ioctl(fd, UI_SET_EVBIT, EV_KEY);
    ioctl(fd, UI_SET_EVBIT, EV_ABS);
    ioctl(fd, UI_SET_EVBIT, EV_SYN);
    ioctl(fd, UI_SET_KEYBIT, BTN_TOUCH);
    ioctl(fd, UI_SET_PROPBIT, INPUT_PROP_DIRECT);
    ioctl(fd, UI_SET_ABSBIT, ABS_X);
    ioctl(fd, UI_SET_ABSBIT, ABS_Y);
    ioctl(fd, UI_SET_ABSBIT, ABS_MT_SLOT);
    ioctl(fd, UI_SET_ABSBIT, ABS_MT_TRACKING_ID);
    ioctl(fd, UI_SET_ABSBIT, ABS_MT_POSITION_X);
    ioctl(fd, UI_SET_ABSBIT, ABS_MT_POSITION_Y);

    struct uinput_setup us;
    memset(&us, 0, sizeof us);
    us.id.bustype = BUS_USB; us.id.vendor = 0x1209; us.id.product = 0x7001;
    strcpy(us.name, "bintana-touchsim");
    if (ioctl(fd, UI_DEV_SETUP, &us) < 0) { perror("UI_DEV_SETUP"); return 1; }
    abs_axis(ABS_X, width - 1, 10);
    abs_axis(ABS_Y, height - 1, 10);
    abs_axis(ABS_MT_POSITION_X, width - 1, 10);
    abs_axis(ABS_MT_POSITION_Y, height - 1, 10);
    abs_axis(ABS_MT_SLOT, SLOTS - 1, 0);
    abs_axis(ABS_MT_TRACKING_ID, 65535, 0);
    if (ioctl(fd, UI_DEV_CREATE) < 0) { perror("UI_DEV_CREATE"); return 1; }

    pause_ms(1500);                     /* udev and the X server pick it up */
    printf("ready\n"); fflush(stdout);

    char line[256];
    while (fgets(line, sizeof line, stdin)) {
        double a, b, c, d; int ms;
        if (!strncmp(line, "quit", 4)) break;
        else if (sscanf(line, "scale %lf %lf", &a, &b) == 2) { kx = a; ky = b; }
        else if (sscanf(line, "tap %lf %lf", &a, &b) == 2) tap(a, b);
        else if (sscanf(line, "hold %lf %lf %d", &a, &b, &ms) == 3) hold(a, b, ms);
        else if (sscanf(line, "swipe %lf %lf %lf %lf %d", &a, &b, &c, &d, &ms) == 5) swipe(a, b, c, d, ms);
        else if (sscanf(line, "pinch %lf %lf %lf %lf %d", &a, &b, &c, &d, &ms) == 5) pinch(a, b, c, d, ms);
        else if (sscanf(line, "rotate %lf %lf %lf %lf %d", &a, &b, &c, &d, &ms) == 5) rotate(a, b, c, d, ms);
        else if (sscanf(line, "pan2 %lf %lf %lf %lf %d", &a, &b, &c, &d, &ms) == 5) pan2(a, b, c, d, ms);
        else { fprintf(stderr, "touchsim: what is: %s", line); }
        printf("ok\n"); fflush(stdout);
    }
    ioctl(fd, UI_DEV_DESTROY);
    close(fd);
    return 0;
}
