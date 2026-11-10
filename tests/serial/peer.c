/*
 * The other end of `tests/serial`: a pseudo-terminal, so the termios code is
 * exercised without a real adapter. It writes the slave's path into the file
 * it is given, then answers the lines the Bintana project writes:
 *
 *   PING -> PONG\n
 *   BIN  -> the two bytes 0x00 0xFF
 *
 * A pty is a tty, so `tcgetattr`/`tcsetattr` take the same path a USB adapter
 * does; what a pty cannot prove is the modem lines, which is a by-hand check.
 * The helper is compiled by `tests/serial.sh` into its scratch directory, so
 * there is no binary in the tree.
 */
#define _GNU_SOURCE
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <termios.h>
#include <unistd.h>
#include <sys/select.h>

static int has(const unsigned char *buf, size_t n, const char *word)
{
    size_t m = strlen(word);

    if (n < m)
        return 0;
    for (size_t i = 0; i + m <= n; i++)
        if (memcmp(buf + i, word, m) == 0)
            return 1;
    return 0;
}

int main(int argc, char **argv)
{
    if (argc != 2) {
        fprintf(stderr, "usage: peer <path-file>\n");
        return 2;
    }

    int master = posix_openpt(O_RDWR | O_NOCTTY);
    if (master < 0) {
        perror("posix_openpt");
        return 2;
    }
    if (grantpt(master) != 0 || unlockpt(master) != 0) {
        perror("grantpt/unlockpt");
        return 2;
    }

    char *slave = ptsname(master);
    if (!slave) {
        perror("ptsname");
        return 2;
    }

    FILE *out = fopen(argv[1], "w");
    if (!out) {
        perror(argv[1]);
        return 2;
    }
    fprintf(out, "%s", slave);
    fclose(out);

    for (;;) {
        fd_set         readfds;
        struct timeval timeout = { 10, 0 };

        FD_ZERO(&readfds);
        FD_SET(master, &readfds);
        int ready = select(master + 1, &readfds, NULL, NULL, &timeout);
        if (ready <= 0)
            break;

        unsigned char buf[4096];
        ssize_t       got = read(master, buf, sizeof buf);
        if (got <= 0)
            break;
        printf("got %zd bytes\n", got);
        fflush(stdout);

        if (has(buf, (size_t)got, "PING"))
            (void)write(master, "PONG\n", 5);
        else if (has(buf, (size_t)got, "BIN")) {
            const unsigned char bin[2] = { 0x00, 0xFF };

            (void)write(master, bin, sizeof bin);
        }
    }

    close(master);
    return 0;
}
