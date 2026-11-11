/*
 * SerialPort over a pseudo-terminal (POSIX), a com0com pair or an HHD script
 * port (Windows) -- the console half of stage 6 of
 * docs/plans/transports-plan.md.
 *
 *   tests/serial.sh        the POSIX run; `peer.c` makes a tty pair
 *   tests/serial-win.sh    the Windows run; `peer.ps1` or a loopback port
 *
 * Either peer answers the lines below, or `BINTANA_SERIAL_LOOPBACK=1` sends
 * them back through an adapter whose TX and RX are tied, and the script hands
 * the port in `BINTANA_SERIAL_PORT`.  A console project on purpose: no GTK, no
 * window, and the console loop's accounting is part of what is checked -- an
 * open port keeps the loop alive until `Close`, and a regression there hangs
 * into the script's timeout.
 *
 * The line and the bytes are two opens, not one: some virtual-port drivers
 * (HHD's among them) block the second write on a handle.  A real adapter does
 * not, and the runtime's write queue is the same either way.
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
    try {
        fn();
        fail(name, "no refusal");
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
    refused("Open on a port that is not there names it",
            () => new SerialPort({ PortName: "COM999" }).Open());

    if (!path) {
        /* The Windows CI has no virtual pair; it still gets the option
         * refusals above.  A missing port on the Linux run is a mistake. */
        if (Environment.Get("BINTANA_SERIAL_OPTIONAL") === "1") {
            print("  skip  no BINTANA_SERIAL_PORT: the data path was not run");
            finish();
            return;
        }
        print("FAIL no BINTANA_SERIAL_PORT -- run this through tests/serial.sh");
        Application.Quit(2);
        return;
    }

    if (Environment.Get("BINTANA_SERIAL_LOOPBACK") === "1")
        runLoopback(path);
    else
        runPeer(path);
}

/* The other end answers `PING\n` with `PONG\n`, and `BIN\n` with the two
 * bytes 0x00 and 0xFF. */
function runPeer(path) {
    let sawLine  = false;
    let sawBytes = false;

    function failed(err) {
        check("the port reports no error", false, err.Message);
        finish();
    }

    function byteMode() {
        const port = new SerialPort({ PortName: path, Speed: 115200,
                                      Line: true });
        let got = [];

        port.OnError = failed;
        port.OnData = (bytes) => {
            for (let i = 0; i < bytes.Length; i++)
                got.push(bytes.At(i));
            if (got.length < 2)
                return;

            sawBytes = true;
            check("the bytes are the ones the device sent",
                  got.length >= 2 && got[0] === 0 && got[1] === 255,
                  `${got.length} bytes: ${got.join(",")}`);
            check("and it is still open", port.IsOpen);
            port.Close();
            check("Close closes", !port.IsOpen);
            refused("Write on a closed port", () => port.Write("x"));
            check("both modes ran", sawLine && sawBytes);
            finish();
        };

        port.Open();
        check("Open opens again", port.IsOpen);
        port.Line = false;          /* the live switch */

        /* The virtual driver loses a write now and then; a real UART does
         * not.  Ask again until a byte comes back. */
        let tries = 0;
        function askBin() {
            if (!port.IsOpen || got.length > 0)
                return;
            if (tries++ >= 8)
                return;
            port.WriteLine("BIN");
            Timer.After(300, askBin);
        }
        Timer.After(250, askBin);
    }

    const linePort = new SerialPort({ PortName: path, Speed: 115200,
                                      Line: true });

    linePort.OnError = failed;
    linePort.OnLine = (line) => {
        sawLine = true;
        check("a line arrives without its separator", line === "PONG", line);
        linePort.Close();
        check("Close closes the line port", !linePort.IsOpen);
        /* The virtual driver needs a moment to release the first handle. */
        Timer.After(250, byteMode);
    };

    linePort.Open();
    check("Open opens", linePort.IsOpen);
    linePort.Write("PING\n");

    Timer.After(8000, () => {
        check("the peer answered before the guard", false,
              sawLine ? "the line arrived but the bytes did not"
                      : "no line arrived");
        finish();
    });
}

/* A single adapter -- or HHD's script port -- with TX tied to RX: what goes
 * out comes back, so the expected line is the one that was written. */
function runLoopback(path) {
    let sawLine  = false;
    let sawBytes = false;

    function failed(err) {
        check("the loopback reports no error", false, err.Message);
        finish();
    }

    function byteMode() {
        const port = new SerialPort({ PortName: path, Speed: 115200,
                                      Line: true });
        let got = [];

        port.OnError = failed;
        port.OnData = (bytes) => {
            for (let i = 0; i < bytes.Length; i++)
                got.push(bytes.At(i));
            if (got.length < 2)
                return;

            sawBytes = true;
            check("the bytes come back from the wire",
                  got.length >= 2 && got[0] === 0 && got[1] === 255,
                  `${got.length} bytes: ${got.join(",")}`);
            check("and it is still open", port.IsOpen);
            port.Close();
            check("Close closes", !port.IsOpen);
            refused("Write on a closed port", () => port.Write("x"));
            check("both modes ran", sawLine && sawBytes);
            finish();
        };

        port.Open();
        check("Open opens again", port.IsOpen);
        port.Line = false;          /* the live switch */

        let tries = 0;
        function askBytes() {
            if (!port.IsOpen || got.length > 0)
                return;
            if (tries++ >= 8)
                return;
            port.Write(new Bytes([0, 255]));
            Timer.After(300, askBytes);
        }
        Timer.After(250, askBytes);
    }

    const linePort = new SerialPort({ PortName: path, Speed: 115200,
                                      Line: true });

    linePort.OnError = failed;
    linePort.OnLine = (line) => {
        sawLine = true;
        check("the line comes back from the wire", line === "PING", line);
        linePort.Close();
        check("Close closes the line port", !linePort.IsOpen);
        /* The virtual driver needs a moment to release the first handle. */
        Timer.After(250, byteMode);
    };

    linePort.Open();
    check("Open opens", linePort.IsOpen);
    linePort.Write("PING\n");

    Timer.After(8000, () => {
        check("the loopback answered before the guard", false,
              sawLine ? "the line arrived but the bytes did not"
                      : "no line arrived; tie TX to RX");
        finish();
    });
}
