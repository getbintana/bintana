/*
 * What the elements API answers -- `Media.Element` and the three classes
 * behind it: the conversions, the refusals, the graph rules, the bus
 * messages, signals, and the accounting that ends a console program.
 *
 *   tests/media.sh               from the repository root
 *
 * A console project, and one of the things it checks *is* the console loop: a
 * pipeline asked Playing keeps the program alive until EOS or an error
 * answers it. The `silent` scenario has no handler at all, so the accounting
 * is the only thing that can answer it -- and a regression there hangs, which
 * the `.sh`'s timeout turns into a red run.
 *
 * Paths are relative to the repository root, which `media.sh` guarantees;
 * `examples/tictactoe/win.wav` is the suite's own audio fixture.
 */

let checks = 0;
let fails  = 0;
let owed   = 0;
/* Scenarios that cannot call `done` themselves -- the silent one, whose whole
 * point is that only the runtime's accounting answers it. The summary is
 * printed when those are all that is left, and the exit status of a *clean*
 * run is the console loop ending at all: a regression there hangs, and the
 * `.sh` timeout is the red run. */
let quiet  = 0;
let said   = false;

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
    if (cond)
        ok(name);
    else
        fail(name, why || "false");
}
function refused(name, fn) {
    checks++;
    try {
        fn();
        fails++;
        print("  FAIL  " + name + " -- no refusal");
    } catch (e) {
        print("  ok    " + name + " -- " + e.message.slice(0, 68));
    }
}

/* A scenario may be answered by an error, an EOS and a guard timer, and only
 * the first of them counts. */
function once(fn) {
    let used = false;

    return function () {
        if (used)
            return;
        used = true;
        fn();
    };
}

/* Every asynchronous scenario is counted: one that never answers is a hang
 * (the `.sh` says how long), and one that answers early is a smaller count
 * that is still printed. The exit status is the failures and nothing else;
 * on success there is no `Quit` at all, because the console loop ending by
 * itself is one of the assertions. */
function done() {
    owed--;
    if (owed > quiet || said)
        return;
    said = true;
    print("");
    print("media: " + checks + " checks, " + fails + " failed");
    if (fails)
        Application.Quit(1);
}

/* ------------------------------------------------------------- sync half */

function conversions() {
    const pipe = Media.Element("pipeline", { name: "conv" });
    const vid  = pipe.Add(Media.Element("videotestsrc", { "num-buffers": 4 }));
    const aud  = pipe.Add(Media.Element("audiotestsrc"));
    const txt  = pipe.Add(Media.Element("textoverlay"));
    const cap  = pipe.Add(Media.Element("capsfilter"));
    const rtsp = Media.Element("rtspsrc");
    const sink = pipe.Add(Media.Element("fakesink"));

    print("conversions:");
    check("Get of a whole number", vid.Get("num-buffers") === 4);
    check("Get of a boolean", vid.Get("is-live") === false);
    check("Get of a 64-bit number", vid.Get("timestamp-offset") === 0);
    check("Get of a decimal number", Math.abs(aud.Get("volume") - 0.8) < 1e-9);
    check("Get of a string", pipe.Get("name") === "conv");
    check("Get of an enum", vid.Get("pattern") === "smpte");
    check("Get of a fraction", txt.Get("scale-pixel-aspect-ratio") === "1/1");

    vid.Set("pattern", "ball");
    check("Set and Get of an enum", vid.Get("pattern") === "ball");
    vid.Set("timestamp-offset", 123456789);
    check("Set and Get of a 64-bit number", vid.Get("timestamp-offset") === 123456789);
    aud.Set("volume", 0.5);
    check("Set and Get of a decimal number", aud.Get("volume") === 0.5);
    txt.Set("scale-pixel-aspect-ratio", "4/3");
    check("Set and Get of a fraction", txt.Get("scale-pixel-aspect-ratio") === "4/3");
    rtsp.Set("protocols", "tcp+udp");
    check("Set and Get of flags", rtsp.Get("protocols") === "udp+tcp",
          "answered " + rtsp.Get("protocols"));
    cap.Set("caps", "video/x-raw,format=RGB");
    check("Set and Get of caps", cap.Get("caps").startsWith("video/x-raw"),
          "answered " + cap.Get("caps").slice(0, 40));

    print("refusals:");
    refused("an element type nobody has", () => Media.Element("nope-does-not-exist"));
    refused("a property nobody has", () => vid.Set("bogus", 1));
    refused("an enum value that is not a nick", () => vid.Set("pattern", "nope"));
    refused("a number where a number cannot be", () => vid.Set("num-buffers", "three"));
    refused("a Set of a read-only property", () => sink.Set("stats", 1));
    refused("a Get of an object value", () => sink.Get("stats"));
    refused("text that is not a fraction", () => txt.Set("scale-pixel-aspect-ratio", "abc"));
    refused("a 64-bit number past 2^53", () => vid.Set("timestamp-offset", 9007199254740994));

    print("graph:");
    const free  = Media.Element("audiotestsrc");
    const free2 = Media.Element("fakesink");

    const extra = Media.Element("fakesink");

    check("Add answers the child", pipe.Add(extra) === extra);
    refused("Add into a non-bin", () => sink.Add(Media.Element("fakesink")));
    refused("Add of a child that has a parent", () => pipe.Add(sink));
    refused("Link of two free elements", () => free.Link(free2));
    const other  = Media.Element("pipeline");
    const other2 = other.Add(Media.Element("fakesink"));
    refused("Link across pipelines", () => sink.Link(other2));
    refused("Link of ends with no pads between them", () => vid.Link(cap, "sink", "src"));

    check("Pad of a name that exists", vid.Pad("src") !== null);
    check("Pad of a name that does not", pipe.Pad("nope") === null);
    check("Pad.Name", vid.Pad("src").Name === "src");
    check("Pad.Caps is text", vid.Pad("src").Caps.startsWith("video/x-raw"));
    check("State answers what was asked", pipe.State === "Null");
    refused("State of a word that is not one", () => { pipe.State = "Running"; });

    print("signals and the bus:");
    refused("a bus type nobody has", () => pipe.Bus.On("tag", () => {}));
    refused("a bus handler that is not a function", () => pipe.Bus.On("eos", 3));
    refused("a signal nobody has", () => vid.On("pad-addedd", () => {}));
    refused("a bus message as a signal", () => vid.On("eos", () => {}));
    refused("a signal that answers a value", () => {
        if (Media.Element("decodebin").On("autoplug-continue", () => {}) === null)
            throw new Error("unreachable");
    });
    refused("a signal whose value is not carried", () => {
        if (Media.Element("identity").On("handoff", () => {}) === null)
            throw new Error("unreachable");
    });
}

/* ------------------------------------------------------------ async half */

/* No handler at all: only the EOS accounting answers this one. */
function silent() {
    const pipe = Media.Element("pipeline");
    const src  = pipe.Add(Media.Element("audiotestsrc", { "num-buffers": 2 }));
    const sink = pipe.Add(Media.Element("fakesink"));

    quiet++;
    owed++;
    src.Link(sink);
    pipe.State = "Playing";
}

function plain() {
    const settle = once(() => done());
    const pipe = Media.Element("pipeline", { name: "plain" });
    const src  = pipe.Add(Media.Element("audiotestsrc", { "num-buffers": 3 }));
    const sink = pipe.Add(Media.Element("fakesink"));
    let playing = false;

    owed++;
    src.Link(sink);
    pipe.Bus.On("state-changed", (name, state) => {
        if (name === "plain" && state === "Playing")
            playing = true;
    });
    pipe.Bus.On("error", (m, k) => {
        fail("a pipeline runs to EOS", m + " (" + k + ")");
        pipe.State = "Null";
        settle();
    });
    pipe.Bus.On("eos", () => {
        check("a pipeline runs to EOS", true);
        check("the bus saw it reach Playing", playing);
        pipe.State = "Null";
        settle();
    });
    pipe.State = "Playing";
}

function tee() {
    const settle = once(() => done());
    const pipe = Media.Element("pipeline");
    const src  = pipe.Add(Media.Element("audiotestsrc", { "num-buffers": 5 }));
    const t    = pipe.Add(Media.Element("tee"));
    const q1   = pipe.Add(Media.Element("queue"));
    const q2   = pipe.Add(Media.Element("queue"));
    const s1   = pipe.Add(Media.Element("fakesink"));
    const s2   = pipe.Add(Media.Element("fakesink"));
    let ends = 0;

    owed++;
    src.Link(t);
    t.Link(q1).Link(s1);
    t.Link(q2).Link(s2);
    pipe.Bus.On("error", (m, k) => {
        fail("a tee with a queue per branch ends", m + " (" + k + ")");
        pipe.State = "Null";
        settle();
    });
    pipe.Bus.On("eos", () => {
        ends++;
        if (ends === 1) {
            check("a tee with a queue per branch ends", true);
            pipe.State = "Null";
            settle();
        }
    });
    pipe.State = "Playing";
}

/* `Eos` and nothing else: the file must come back with exact header sizes.
 * With `State = "Null"` the same run leaves the placeholder sizes
 * (measured, ~2 GiB) -- which is why this is the shape the docs show. */
function recorder() {
    const path   = "/tmp/bintana-media-rec.wav";
    const settle = once((why) => {
        if (why)
            fail("a recorder flushes on Eos", why);
        done();
    });
    const pipe = Media.Element("pipeline");
    const src  = pipe.Add(Media.Element("audiotestsrc", { "is-live": true }));
    const conv = pipe.Add(Media.Element("audioconvert"));
    const enc  = pipe.Add(Media.Element("wavenc"));
    const out  = pipe.Add(Media.Element("filesink", { location: path }));

    owed++;
    try {
        File.Delete(path);
    } catch (e) {
        /* there was nothing to delete */
    }
    src.Link(conv).Link(enc).Link(out);
    pipe.Bus.On("error", (m, k) => {
        pipe.State = "Null";
        settle(m + " (" + k + ")");
    });
    pipe.Bus.On("eos", () => {
        pipe.State = "Null";
        try {
            const b = File.LoadBytes(path);
            const d = data_chunk(b);

            check("a recorder flushes on Eos",
                  d > 0 && u32(b, 4) === b.Length - 8 &&
                  u32(b, d + 4) === b.Length - d - 8,
                  "header says " + u32(b, 4) + "/" + u32(b, d + 4) +
                  ", the file is " + (b.Length - 8) + "/" + (b.Length - d - 8));
        } catch (e) {
            fail("a recorder flushes on Eos", e.message);
        }
        settle();
    });
    pipe.State = "Playing";
    Timer.After(600, () => pipe.Eos());
}

/* The canonical dynamic graph: decodebin has no src pad until the file is
 * typefound, and the pad must be linked before the stream pushes into it. */
function decodebin() {
    const settle = once((why) => {
        if (why)
            fail("decodebin's pad-added links a branch", why);
        done();
    });
    const pipe = Media.Element("pipeline");
    const fs   = pipe.Add(Media.Element("filesrc",
                       { location: "examples/tictactoe/win.wav" }));
    const dec  = pipe.Add(Media.Element("decodebin"));
    const conv = pipe.Add(Media.Element("audioconvert"));
    const sink = pipe.Add(Media.Element("fakesink"));
    let added  = false;

    owed++;
    fs.Link(dec);
    conv.Link(sink);
    dec.On("pad-added", pad => {
        added = true;
        check("decodebin's pad-added carries a Pad",
              pad.Caps.startsWith("audio/x-raw"), pad.Caps.slice(0, 40));
        pad.Link(conv);
    });
    pipe.Bus.On("error", (m, k) => {
        pipe.State = "Null";
        settle(m + " (" + k + ")");
    });
    pipe.Bus.On("eos", () => {
        if (!added)
            settle("the pad was never announced");
        else
            settle();
        pipe.State = "Null";
    });
    pipe.State = "Playing";
}

/* Too many EOS handlers early: this one ends in an error, and the kind is the
 * players' word for it. */
function missing() {
    const settle = once(() => done());
    const pipe = Media.Element("pipeline");
    const fs   = pipe.Add(Media.Element("filesrc",
                       { location: "/no/such/file-anywhere.wav" }));
    const sink = pipe.Add(Media.Element("fakesink"));

    owed++;
    fs.Link(sink);
    pipe.Bus.On("error", (m, k) => {
        check("an error answers with its kind", k === "NotFound", "kind " + k);
        pipe.State = "Null";
        settle();
    });
    pipe.Bus.On("eos", () => {
        fail("an error answers with its kind", "EOS instead of an error");
        pipe.State = "Null";
        settle();
    });
    pipe.State = "Playing";
}

/* A branch added to a running pipeline follows it into Playing -- the sync
 * `Add` does for the caller; the guard is what a regression looks like. */
function lateChild() {
    const settle = once(() => done());
    const pipe = Media.Element("pipeline");
    const src  = pipe.Add(Media.Element("audiotestsrc", { "is-live": true }));
    const t    = pipe.Add(Media.Element("tee"));
    const q1   = pipe.Add(Media.Element("queue"));
    const s1   = pipe.Add(Media.Element("fakesink"));
    let played = false;
    let guard;

    owed++;
    src.Link(t);
    t.Link(q1).Link(s1);
    guard = Timer.After(4000, () => {
        fail("a late child follows the pipeline", "it never reached Playing");
        pipe.State = "Null";
        settle();
    });
    pipe.Bus.On("state-changed", (name, state) => {
        if (played || name !== "latesink" || state !== "Playing")
            return;
        played = true;
        guard.Stop();
        check("a late child follows the pipeline", true);
        pipe.Eos();
    });
    pipe.Bus.On("error", (m, k) => {
        fail("a late child follows the pipeline", m + " (" + k + ")");
        pipe.State = "Null";
        settle();
    });
    pipe.Bus.On("eos", () => {
        if (played) {
            check("the late-child run reaches EOS", true);
            pipe.State = "Null";
            settle();
        }
    });
    pipe.State = "Playing";

    Timer.After(300, () => {
        const q2 = pipe.Add(Media.Element("queue"));
        const s2 = pipe.Add(Media.Element("fakesink", { name: "latesink" }));

        t.Link(q2).Link(s2);
    });
}

/* --------------------------------------------------------------- helpers */

function u32(bytes, at) {
    return bytes.At(at) + bytes.At(at + 1) * 256 + bytes.At(at + 2) * 65536 +
           bytes.At(at + 3) * 16777216;
}

function data_chunk(bytes) {
    for (let i = 12; i + 8 < bytes.Length; i++) {
        if (bytes.At(i) === 100 && bytes.At(i + 1) === 97 &&
            bytes.At(i + 2) === 116 && bytes.At(i + 3) === 97)
            return i;
    }
    return -1;
}

function Main() {
    if (!Media.Available) {
        /* A runtime built without GStreamer: the global is there, `Available`
         * is false, and the verbs refuse with the one sentence. */
        check("Media.Available is false", Media.Available === false);
        refused("Element refuses with no engine", () => Media.Element("fakesink"));
        print("");
        print("media: " + checks + " checks, " + fails + " failed");
        Application.Quit(fails ? 1 : 0);
        return;
    }
    check("Media.Available is true", Media.Available === true);

    conversions();

    print("the graph, running:");
    silent();
    plain();
    tee();
    recorder();
    decodebin();
    missing();
    lateChild();
}
