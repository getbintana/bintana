/*
 * SerialPort over a pseudo-terminal -- the console half of stage 6 of
 * docs/plans/transports-plan.md.
 *
 *   tests/serial.sh
 *
 * `tests/serial.sh` starts `peer.c`, which makes a tty pair and answers the
 * lines below, and hands the slave's path in `BINTANA_SERIAL_PORT`.  A console
 * project on purpose: no GTK, no window, and the console loop's accounting is
 * part of what is checked -- an open port keeps the loop alive until `Close`,
 * and a regression there hangs into the script's timeout.
 */

let checks = 0;
let fails  = 0;
let done   = false;

function ok(name, note) {
    checks++;
    print("  ok    " + name + (note ? " -- " + note : ""));
}
function fail(name, why) {
    checks++;
    fails++;
    print("  FAIL  " + name + " -- " + why);
}
function check(name, cond, why) {
    if (cond) ok(name);
    else      fail(name, why || "false");
}
function refused(name, fn) {
    checks++;
    try {
        fn();
        fails++;
        print("  FAIL  " + name + " -- no refusal");
    } catch (e) {
        ok(name, e.message.slice(0, 72));
    }
}

function finish() {
    if (done) return;
    done = true;
    print(`${checks - fails} passed, ${fails} failed`);
    Application.Quit(fails ? 1 : 0);
}

function Main() {
    const path = Environment.Get("BINTANA_SERIAL_PORT");
    if (!path) {
        print("FAIL no BINTANA_SERIAL_PORT -- run this through tests/serial.sh");
        Application.Quit(2);
        return;
    }

    refused("an unknown option is refused",
            () => new SerialPort({ Nope: 1 }));
    refused("a speed below 1 is refused",
            () => new SerialPort({ Speed: 0 }));
    refused("9 data bits are refused",
            () => new SerialPort({ DataBits: 9 }));
    refused("an unknown parity is refused",
            () => new SerialPort({ Parity: "Half" }));
    refused("3 stop bits are refused",
            () => new SerialPort({ StopBits: 3 }));
    refused("an unknown flow control is refused",
            () => new SerialPort({ FlowControl: "Magic" }));
    refused("an empty EndOfLine is refused",
            () => new SerialPort({ EndOfLine: "" }));
    refused("Open with no PortName names it",
            () => new SerialPort().Open());
    refused("Open on something that is not a tty names it",
            () => new SerialPort({ PortName: "/dev/null" }).Open());

    const port = new SerialPort({ PortName: path, Speed: 115200, Line: true });
    let sawLine = false;
    let sawBytes = false;

    port.OnError = (err) => {
        check("the port reports no error", false, err.Message);
        finish();
    };

    port.OnLine = (line) => {
        sawLine = true;
        check("a line arrives without its separator", line === "PONG", line);

        /* The same port in byte mode: no close, no reopen, just the other
         * handler.  `Line = false` is allowed while open. */
        port.Line = false;
        port.OnData = (bytes) => {
            sawBytes = true;
            check("the bytes are the ones the device sent",
                  bytes.Length === 2 && bytes.At(0) === 0 && bytes.At(1) === 255,
                  bytes.Length === 2 ? `${bytes.At(0)},${bytes.At(1)}`
                                     : `${bytes.Length} bytes`);
            check("and it is still open", port.IsOpen);
            port.Close();
            check("Close closes", !port.IsOpen);
            refused("Write on a closed port", () => port.Write("x"));
            check("both modes ran", sawLine && sawBytes);
            finish();
        };
        port.Write("BIN\n");
    };

    port.Open();
    check("Open opens", port.IsOpen);
    port.Write("PING\n");

    Timer.After(4000, () => {
        check("the pty answered before the guard", false,
              sawLine ? "the line arrived but the bytes did not"
                      : "no line arrived");
        finish();
    });
}
