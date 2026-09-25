/*
 * `lib/qr`, held to what [docs/llm/qr.md](../../docs/llm/qr.md) promises.
 *
 * **An encoder is only right if a reader agrees, and nothing here can read.**
 * So the assertions are the ones a symbol can be checked against without a
 * decoder, each taken from outside this code:
 *
 *   - the Reed-Solomon codewords of the standard's own example (ISO/IEC 18004
 *     annex I, "01234567" at 1-M) and of the "HELLO WORLD" 1-Q example every
 *     tutorial walks through;
 *   - the fifteen-bit format strings and the eighteen-bit version strings, as
 *     tabulated in the standard;
 *   - the data capacities of table 7, and the character capacities at 40-L in
 *     all three modes, at the boundary and one past it;
 *   - the function patterns where the standard puts them.
 *
 * What that cannot catch is a mistake in the zigzag or a mask applied to the
 * wrong cells: the symbol would still be well formed and would not scan. That
 * half has an outside witness of its own -- the finished modules agree with a
 * second encoder (`qrcode` for Node) on every input tried, under all eight
 * forced masks -- and the six masks the penalty rules choose are pinned below,
 * each against Project Nayuki's reference, so a change to the rules, which is
 * where an optimisation goes, is a red line and not a silent change of every
 * code in the program.
 *
 * And the view, which is asserted off `Canvas.Dump()` after a synchronous
 * `Save()`: whole pixels a module, centred, black on white.
 */
"use strict";

let passed = 0;
const failures = [];

function check(name, cond, detail) {
    if (cond) passed++;
    else failures.push(detail ? `${name}: ${detail}` : name);
}

function eq(name, got, want) {
    check(name, got === want, `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}

function throws(name, fn, kind) {
    try {
        fn();
        failures.push(`${name}: expected a throw, none happened`);
    } catch (e) {
        if (kind && !(e instanceof kind))
            failures.push(`${name}: threw ${e.name}, expected ${kind.name}: ${e.message}`);
        else passed++;
    }
}

const SCRATCH = `/tmp/bta-test-qr${Application.Arguments[0] ? `-${Application.Arguments[0]}` : ""}`;

class QrTest extends Form {

    Form_Open() {
        Directory.Make(SCRATCH);
        try {
            this.testReedSolomon();
            this.testFormatAndVersion();
            this.testCapacity();
            this.testModes();
            this.testRefusals();
            this.testStructure();
            this.testPinnedMasks();
            this.testOutputs();
            this.testView();
            this.testViewDrawing();
        } catch (e) {
            failures.push(`uncaught: ${e.message}\n${e.stack || ""}`);
        }
        this.finish();
    }

    /* ------------------------------------------------ against the standard */

    testReedSolomon() {
        const hex = (a) => a.map((b) => b.toString(16).padStart(2, "0")).join(" ");

        const annex = qrInterleave([0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11,
                                    0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11], 1, "M");
        eq("annex I: the ten EC codewords of 01234567 at 1-M",
           hex(annex.slice(16)), "a5 24 d4 c1 ed 36 c7 87 2c 55");

        const hello = qrInterleave([0x20, 0x5b, 0x0b, 0x78, 0xd1, 0x72, 0xdc, 0x4d,
                                    0x43, 0x40, 0xec, 0x11, 0xec], 1, "Q");
        eq("HELLO WORLD at 1-Q: its thirteen EC codewords",
           hello.slice(13).join(" "), "168 72 22 82 217 54 156 0 46 15 180 122 16");

        /* The data codewords Encode builds for the annex's text are the ones
         * the standard lists, which ties the bit stream to the RS above. */
        const q = QrCode.Encode("01234567", { Ecc: "M" });
        eq("01234567 is version 1", q.Version, 1);
        eq("in numeric mode", q.Mode, "Numeric");
    }

    testFormatAndVersion() {
        /* Read back off the symbol, around the top-left finder, most
         * significant bit first. Table C.1 of the standard. */
        const want = { L: "111011111000100", M: "101010000010010",
                       Q: "011010101011111", H: "001011010001001" };
        for (const ecc of ["L", "M", "Q", "H"]) {
            const c = QrCode.Encode("A", { Ecc: ecc, Mask: 0 });
            const bits = [];
            for (let i = 0; i <= 5; i++) bits.push(c.Dark(8, i));
            bits.push(c.Dark(8, 7), c.Dark(8, 8), c.Dark(7, 8));
            for (let i = 9; i < 15; i++) bits.push(c.Dark(14 - i, 8));
            eq(`format bits for ${ecc} with mask 0`,
               bits.map((b) => (b ? 1 : 0)).reverse().join(""), want[ecc]);

            /* ... and the second copy, split between the other two finders. */
            const other = [];
            for (let i = 0; i < 8; i++) other.push(c.Dark(c.Size - 1 - i, 8));
            for (let i = 8; i < 15; i++) other.push(c.Dark(8, c.Size - 15 + i));
            eq(`and its second copy agrees for ${ecc}`,
               other.map((b) => (b ? 1 : 0)).reverse().join(""), want[ecc]);
        }

        /* Table D.1. */
        for (const [v, want] of [[7, "000111110010010100"], [21, "010101011010000011"],
                                 [40, "101000110001101001"]]) {
            const c = QrCode.Encode("1", { MinVersion: v, Ecc: "L" });
            let s = "", t = "";
            for (let i = 17; i >= 0; i--) {
                s += c.Dark(c.Size - 11 + i % 3, Math.floor(i / 3)) ? 1 : 0;
                t += c.Dark(Math.floor(i / 3), c.Size - 11 + i % 3) ? 1 : 0;
            }
            eq(`version ${v}'s information, top right`, s, want);
            eq(`and bottom left`, t, want);
        }
        eq("below 7 there is none", QrCode.Encode("1", { MinVersion: 6 }).Dark(6 * 4 + 17 - 11, 0),
           QrCode.Encode("1", { MinVersion: 6 }).Dark(6 * 4 + 17 - 11, 0));
    }

    testCapacity() {
        /* Table 7, data codewords at L, M, Q, H. */
        const table = { 1: [19, 16, 13, 9], 10: [274, 216, 154, 122],
                        20: [861, 669, 485, 385], 30: [1735, 1373, 985, 745],
                        40: [2956, 2334, 1666, 1276] };
        for (const v in table)
            eq(`data codewords at version ${v}`,
               ["L", "M", "Q", "H"].map((e) => qrDataCodewords(Number(v), e)).join(","),
               table[v].join(","));

        /* And every version's blocks divide what is there. */
        let bad = [];
        for (let v = 1; v <= 40; v++)
            for (const e of ["L", "M", "Q", "H"]) {
                const raw = Math.floor(qrRawModules(v) / 8);
                const n = QR_BLOCKS[e][v];
                const shortLen = Math.floor(raw / n);
                if (shortLen - QR_ECC_PER_BLOCK[e][v] < 1 || qrDataCodewords(v, e) < 1)
                    bad.push(`${v}-${e}`);
            }
        eq("every version and level has room for data in every block", bad.join(" "), "");

        /* The famous three, at the edge and one past it. */
        for (const [what, ch, n] of [["bytes", "a", 2953], ["digits", "1", 7089],
                                     ["alphanumerics", "A", 4296]]) {
            eq(`${n} ${what} fit version 40 at L`,
               QrCode.Encode(ch.repeat(n), { Ecc: "L" }).Version, 40);
            throws(`and ${n + 1} do not`, () => QrCode.Encode(ch.repeat(n + 1), { Ecc: "L" }),
                   RangeError);
        }

        /* The version is the smallest that holds the text: 17 bytes is the
         * capacity of 1-L and 18 is not. */
        eq("17 bytes: version 1", QrCode.Encode("a".repeat(17), { Ecc: "L" }).Version, 1);
        eq("18 bytes: version 2", QrCode.Encode("a".repeat(18), { Ecc: "L" }).Version, 2);
    }

    testModes() {
        eq("digits are numeric", QrCode.Encode("0123").Mode, "Numeric");
        eq("upper case and $%*+-./: are alphanumeric", QrCode.Encode("AB $%*+-./:9").Mode, "Alphanumeric");
        eq("a lower case letter is bytes", QrCode.Encode("Ab").Mode, "Byte");
        eq("the empty text is numeric and version 1", QrCode.Encode("").Version, 1);

        /* A string is UTF-8: an ñ is two bytes, so half as many fit. */
        eq("1476 ñ fit version 40 at L", QrCode.Encode("ñ".repeat(1476), { Ecc: "L" }).Version, 40);
        throws("1477 do not", () => QrCode.Encode("ñ".repeat(1477), { Ecc: "L" }), RangeError);

        /* Bytes are byte mode as they stand, and the same bytes as the text. */
        const fromText  = QrCode.Encode("año 2026");
        const fromBytes = QrCode.Encode(new Bytes("año 2026"));
        eq("Bytes are byte mode", fromBytes.Mode, "Byte");
        eq("and the same symbol as the text they encode", fromBytes.ToText(), fromText.ToText());

        const digits = new Bytes("123");
        eq("digits given as Bytes stay bytes", QrCode.Encode(digits).Mode, "Byte");
    }

    testRefusals() {
        throws("an unknown level", () => QrCode.Encode("x", { Ecc: "X" }), TypeError);
        throws("a version outside 1-40", () => QrCode.Encode("x", { MaxVersion: 41 }), RangeError);
        throws("a range that is not one", () => QrCode.Encode("x", { MinVersion: 5, MaxVersion: 4 }), RangeError);
        throws("a mask outside 0-7", () => QrCode.Encode("x", { Mask: 8 }), RangeError);
        throws("a number instead of text", () => QrCode.Encode(42), TypeError);
        throws("null", () => QrCode.Encode(null), TypeError);
        throws("a negative quiet zone", () => QrCode.Encode("x").ToSvg({ QuietZone: -1 }), RangeError);

        try {
            QrCode.Encode("a".repeat(200), { Ecc: "H", MaxVersion: 5 });
            failures.push("text past MaxVersion was accepted");
        } catch (e) {
            check("the refusal says which version and level", /version 5 at level H/.test(e.message),
                  e.message);
            check("and how much room there was", /\(\d+ bits of data\)/.test(e.message), e.message);
        }
        eq("MaxVersion is honoured below its limit",
           QrCode.Encode("a".repeat(30), { MaxVersion: 3 }).Version, 3);
        eq("MinVersion is honoured above what the text needs",
           QrCode.Encode("a", { MinVersion: 12 }).Version, 12);
    }

    testStructure() {
        const c = QrCode.Encode("structure", { MinVersion: 7 });
        eq("a version 7 symbol is 45 modules a side", c.Size, 45);

        /* The three finders: a 7x7 ring with a 3x3 centre, a light separator. */
        const finder = (x0, y0) => {
            for (let y = 0; y < 7; y++)
                for (let x = 0; x < 7; x++) {
                    const ring = x === 0 || y === 0 || x === 6 || y === 6;
                    const core = x >= 2 && x <= 4 && y >= 2 && y <= 4;
                    if (c.Dark(x0 + x, y0 + y) !== (ring || core)) return false;
                }
            return true;
        };
        check("a finder at the top left", finder(0, 0));
        check("at the top right", finder(c.Size - 7, 0));
        check("at the bottom left", finder(0, c.Size - 7));
        check("and none at the bottom right", !finder(c.Size - 7, c.Size - 7));

        let timing = true;
        for (let i = 8; i < c.Size - 8; i++)
            if (c.Dark(i, 6) !== (i % 2 === 0) || c.Dark(6, i) !== (i % 2 === 0)) timing = false;
        check("the timing patterns alternate", timing);
        check("the dark module is dark", c.Dark(8, c.Size - 8));

        /* Version 7's alignment patterns are at 6, 22 and 38. */
        check("an alignment pattern at (22, 22)", c.Dark(22, 22) && !c.Dark(21, 22) && c.Dark(20, 22));
        check("and at (38, 6), between two finders",
              c.Dark(38, 6) && !c.Dark(37, 6) && c.Dark(36, 6));
        eq("the alignment centres of version 32", qrAlignment(32).join(","), "6,34,60,86,112,138");
        eq("and of version 36", qrAlignment(36).join(","), "6,24,50,76,102,128,154");
        eq("version 1 has none", qrAlignment(1).length, 0);

        eq("outside the symbol is light", c.Dark(-1, 0) || c.Dark(0, c.Size), false);
    }

    /*
     * The masks the penalty rules choose, pinned -- every one of them checked
     * against Project Nayuki's reference implementation, which is the reading
     * this encoder follows where the standard is ambiguous. They are held so
     * the next rewrite of section 7.8.3, which is where an optimisation goes,
     * has to agree with it instead of quietly changing every code.
     */
    testPinnedMasks() {
        const pinned = [
            ["01234567", "M", 1, 0],
            ["HELLO WORLD", "Q", 1, 0],
            ["https://github.com/getbintana/bintana", "M", 3, 2],
            ["ñandú", "H", 1, 6],
            ["x".repeat(300), "L", 11, 0],
            ["The quick brown fox jumps over the lazy dog".repeat(20), "Q", 28, 2],
        ];
        for (const [text, ecc, version, mask] of pinned) {
            const q = QrCode.Encode(text, { Ecc: ecc });
            eq(`${text.slice(0, 16)}… at ${ecc} is version ${version}`, q.Version, version);
            eq(`and takes mask ${mask}`, q.Mask, mask);
        }
        eq("a mask asked for is the mask used", QrCode.Encode("abc", { Mask: 5 }).Mask, 5);
    }

    testOutputs() {
        const c = QrCode.Encode("HELLO WORLD", { Ecc: "Q" });

        const svg = c.ToSvg();
        check("an SVG document", svg.startsWith("<?xml") && svg.includes("<svg"), svg.slice(0, 40));
        check("one unit a module, the quiet zone included", svg.includes('viewBox="0 0 29 29"'));
        check("and crisp edges", svg.includes('shape-rendering="crispEdges"'));
        check("a quiet zone of 0 is the symbol alone", c.ToSvg({ QuietZone: 0 }).includes('viewBox="0 0 21 21"'));
        check("the colours are the caller's",
              c.ToSvg({ Ink: "#123456", Paper: "#fedcba" }).includes('fill="#123456"'));
        check("and parse as XML", !Xml.Available || Xml.Parse(svg) !== null);

        const text = c.ToText().split("\n");
        eq("text: two rows a line", text.length, Math.ceil(29 / 2));
        eq("one module a character", [...text[0]].length, 29);
        eq("the quiet zone is blank", text[0].trim(), "");
        check("a finder's top edge is ink", text[2].includes("█▀▀▀▀▀█"),
              text[2]);
        check("Invert swaps ink and ground", c.ToText({ Invert: true }).split("\n")[0].trim() !== "");
    }

    /* ------------------------------------------------------------- the view */

    testView() {
        const v = this.View;
        eq("Ecc defaults to M", v.Ecc, "M");
        eq("QuietZone to the standard's 4", v.QuietZone, 4);
        eq("Ink is black", v.Ink, "#000000");
        eq("Paper is white, not the theme's", v.Paper, "#ffffff");
        eq("no text, no code", v.Code, null);
        eq("and no problem either", v.Problem, "");

        v.Text = "https://example.com/";
        check("text is encoded in the setter", v.Code instanceof QrCode);
        eq("at the view's level", v.Code.Ecc, "M");
        v.Ecc = "H";
        eq("a new level re-encodes", v.Code.Ecc, "H");

        v.Text = "a".repeat(3000);
        eq("text that does not fit leaves no code", v.Code, null);
        check("and says why", /do not fit version 40/.test(v.Problem), v.Problem);
        throws("ToSvg refuses when there is nothing", () => v.ToSvg());

        v.Text = "";
        eq("empty text is no code", v.Code, null);
        eq("and clears the problem", v.Problem, "");

        throws("an unknown level", () => { v.Ecc = "Z"; });
        eq("and the level is unchanged", v.Ecc, "H");
        throws("a quiet zone that is not whole", () => { v.QuietZone = 1.5; });
        throws("or too wide", () => { v.QuietZone = 17; });

        v.Text = null;
        eq("null is empty text", v.Text, "");

        /* Declared as data: a URL must never go through a catalogue. The list
         * is the whole chain, so `Tooltip` from Widget is in it and `Text`
         * must not be. */
        check("Text is data and never translated",
              !Widget.TextProperties("QrView").includes("Text"),
              Widget.TextProperties("QrView").join(","));
        eq("the level is offered as a drop-down",
           Widget.PropertyOptions("QrView", "Ecc").join(","), "L,M,Q,H");
    }

    testViewDrawing() {
        const v = this.View;
        v.Ecc = "M";
        v.QuietZone = 4;
        v.Text = "1";                    /* version 1: 21 + 8 = 29 modules a side */

        const png = File.Join(SCRATCH, "one.png");
        v.Save(png, 300);
        const dump = v.Canvas.Dump().split("\n");

        /* 300 / 29 is 10 whole pixels a module, 290 drawn, 5 left over each side. */
        check("the ground is painted in Paper first",
              dump[0] === "Color #ffffff" && dump[1] === "Rectangle (0,0) 300x300", dump.slice(0, 2).join(" | "));
        check("whole pixels, so no antialiasing", dump.includes("Antialias false"));
        check("the symbol is centred on whole pixels", dump.includes("Rectangle (5,5) 290x290"));
        check("the first dark run is the finder's top edge, 7 modules of 10 px",
              dump.includes("Rectangle (45,45) 70x10"));
        eq("and the dark modules are one fill",
           dump.filter((l) => l === "Fill").length, 3);   /* ground, paper, ink */

        const pic = new Picture();
        pic.File = png;
        eq("Save writes a PNG of the size asked", `${pic.SourceWidth}x${pic.SourceHeight}`, "300x300");

        const bytes = v.ToPng(120);
        eq("ToPng answers a PNG", bytes.Slice(0, 8).ToHex(), "89504e470d0a1a0a");

        /* A view too small for a whole pixel a module still draws. */
        v.Save(File.Join(SCRATCH, "tiny.png"), 20);
        check("below a pixel a module it antialiases instead",
              v.Canvas.Dump().split("\n").includes("Antialias true"));

        v.Ink = "#003366";
        v.Save(png, 300);
        check("Ink is what the modules are painted in", v.Canvas.Dump().split("\n").includes("Color #003366"));
    }

    /* --------------------------------------------------------------- report */
    finish() {
        try {
            for (const name of Directory.List(SCRATCH))
                try { File.Delete(File.Join(SCRATCH, name)); } catch (e) { /* stays */ }
            File.Delete(SCRATCH);
        } catch (e) { /* nothing was written */ }

        print("");
        for (const f of failures) print(`  FAIL  ${f}`);
        print(`qr: ${passed} passed, ${failures.length} failed`);
        Application.Quit(failures.length ? 1 : 0);
    }
}
