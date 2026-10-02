/*
 * A webhook that is signed, and the six things a receiver has to refuse.
 *
 * A webhook is somebody else's server calling yours, so the one thing you know
 * about a request is that it *claims* to come from them. The claim is a
 * signature: the sender keyed a digest of the message with a secret you both
 * hold, and a receiver that recomputes it and gets the same answer knows the
 * message is theirs and was not changed on the way. This process is both ends,
 * over the loopback, so the whole of it runs and prints what each check did.
 *
 *     sender    Hash.Hmac(secret, timestamp + "." + body)   -> X-Signature
 *     receiver  Hash.Verify(secret, timestamp + "." + body, signature)
 *
 * Four decisions in it are the point, and each is a line the first draft of every
 * webhook handler gets wrong:
 *
 * **The signature covers the timestamp as well as the body.** A signature over
 * the body alone is a signature somebody can replay for ever: capture one
 * delivery, send it again next year, and it verifies. Binding the time into what
 * is signed is what lets the receiver say "too old" without trusting a header it
 * did not check -- and it is checked *after* the signature, since a timestamp
 * nobody verified is a number an attacker chose.
 *
 * **What is signed is bytes, not text.** `req.Body` is a `Bytes`, and the message
 * is the timestamp, a dot, and those bytes as they arrived -- never a string made
 * from them. Decoding and re-encoding is a round trip that is exact for JSON from
 * a well-behaved sender and quietly different for the first one that is not, and
 * "which text was signed" is exactly the question a signature has to leave no room
 * for.
 *
 * **The check is `Hash.Verify`, never `===`.** Comparing two strings stops at the
 * first character that differs, so how long the answer takes says how many leading
 * characters of a forged signature were right, and that is enough to forge one a
 * character at a time. `Verify` looks at every byte whatever the first difference
 * was. It answers `false` for a signature that is not even hex, so the forged one
 * and the malformed one take the same branch.
 *
 * **A delivery has an id, and a receiver that has seen it refuses it.** Retries
 * are normal -- a sender that got no answer sends again -- so the receiver has to
 * be able to say "I already did this" without doing it twice. The id is
 * `Random.Uuid()`: nothing about it needs to be ordered, and everything about it
 * needs to be unguessable.
 *
 * The secret is `Random.Bytes(32).ToHex()` -- 256 bits from the operating system,
 * and never from `Math.random`, which is a generator seeded once whose next output
 * follows from the last. In a real deployment it is made once, kept in `Settings`
 * or an environment variable, and given to the other side over a channel you
 * trust; here it lives as long as the process.
 *
 * The client calls back and the server answers on the same loop, which is why the
 * six deliveries are a chain of callbacks and not six `PostWait`s: a `Wait` would
 * freeze the loop the server answers on, and the first request would never get its
 * answer. **The chain empties its own list at the end**, or the finished chain is
 * a cycle nothing references and whether it is collected before teardown is luck.
 *
 * Run it with `./build/bintana examples/webhook`. It exits `0` when every check
 * did what it should, and `1` when one did not.
 */
"use strict";

const SECRET = Random.Bytes(32).ToHex();

/* How old a delivery may be and still be believed: long enough for a retry
 * queue, short enough that a captured request goes stale. */
const TOLERANCE = 300;

/* Held at module scope: a server lives as long as its object. */
const srv  = Http.Server({ Port: 0 });
const seen = {};          /* delivery id -> true; `Dictionary` safe: ids are UUIDs */
let   accepted = 0;

/* What is signed: the timestamp, a dot, and the body's own bytes. */
function signedMessage(timestamp, body) {
    return new Bytes(`${timestamp}.`).Concat(body);
}

/* The sender's half. `body` is text or `Bytes`. */
function sign(secret, timestamp, body) {
    const bytes = typeof body === "string" ? new Bytes(body) : body;

    return Hash.Hmac(secret, signedMessage(timestamp, bytes));
}

/* The receiver's half: what it answers, and why. */
function receive(req) {
    const stamp = req.Headers["x-timestamp"];
    const sig   = req.Headers["x-signature"];
    const id    = req.Headers["x-delivery"];

    if (req.Method !== "POST" || !stamp || !sig || !id) {
        req.Answer(400, "unsigned");
        return;
    }

    /* Before anything else is believed. A timestamp that is not a number makes
     * the message `NaN.…`, which no honest sender produced, and fails here. */
    if (!Hash.Verify(SECRET, signedMessage(stamp, req.Body), sig)) {
        req.Answer(401, "bad signature");
        return;
    }

    /* The signature is good, so the timestamp is the sender's and can be read. */
    const age = Math.floor(Date.now() / 1000) - Number(stamp);

    if (!(Math.abs(age) <= TOLERANCE)) {
        req.Answer(401, `too old: ${age} s`);
        return;
    }

    /* A retry of something already done is not an error the sender should keep
     * retrying: `409` says *got it, and did it*. */
    if (Dictionary.Has(seen, id)) {
        req.Answer(409, "already delivered");
        return;
    }
    seen[id] = true;
    accepted++;
    req.Answer(200, "ok");
}

function Main() {
    srv.Request = receive;
    srv.Start();

    const now  = () => String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ event: "invoice.paid", amount: "120.50" });

    const first = Random.Uuid();

    /* Each delivery: what is done to it, and what a receiver has to answer. */
    const steps = [
        ["a good delivery",
         200, () => { const t = now(); return { t, id: first, sig: sign(SECRET, t, body), body }; }],

        ["the same delivery again (a retry)",
         409, () => { const t = now(); return { t, id: first, sig: sign(SECRET, t, body), body }; }],

        ["a body changed after it was signed",
         401, () => { const t = now(); return { t, id: Random.Uuid(), sig: sign(SECRET, t, body),
                                                 body: body.replace("120.50", "999.99") }; }],

        ["signed with somebody else's secret",
         401, () => { const t = now(); return { t, id: Random.Uuid(),
                                                 sig: sign(Random.Bytes(32).ToHex(), t, body), body }; }],

        ["a good signature on a ten-minute-old delivery (a replay)",
         401, () => { const t = String(Math.floor(Date.now() / 1000) - 600);
                      return { t, id: Random.Uuid(), sig: sign(SECRET, t, body), body }; }],

        ["no signature at all",
         400, () => ({ t: now(), id: Random.Uuid(), sig: "", body })],
    ];

    let failed = 0, at = 0;

    const next = () => {
        if (at === steps.length) {
            steps.length = 0;                    /* no cycle left to collect */
            srv.Stop();
            print(failed ? `${failed} of 6 did the wrong thing` : "all six did what they should");
            Application.Quit(failed ? 1 : 0);
            return;
        }

        const [what, want, make] = steps[at++];
        const d = make();
        const headers = { "X-Timestamp": d.t, "X-Delivery": d.id };

        if (d.sig)
            headers["X-Signature"] = d.sig;

        Http.Post(`${srv.Url}hook`, d.body, { Headers: headers, Timeout: 5000 },
            (r) => {
                const ok = r.Status === want;

                failed += ok ? 0 : 1;
                print(`${ok ? "ok  " : "FAIL"} ${what}: ${r.Status} ${r.Body.ToText()}`
                      + (ok ? "" : ` (wanted ${want})`));
                next();
            },
            (e) => {
                failed++;
                print(`FAIL ${what}: ${e.Message}`);
                next();
            });
    };

    print(`receiving at ${srv.Url}hook, secret ${SECRET.slice(0, 8)}…`);
    next();
}
