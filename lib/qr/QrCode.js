/*
 * A QR code, as data: the modules and nothing about how they are shown.
 *
 * ISO/IEC 18004, model 2: versions 1 to 40, the four error correction levels,
 * the numeric, alphanumeric and byte modes, and the eight masks chosen by the
 * standard's penalty rules. Written in Bintana over nothing but arithmetic, so
 * it works where no widget can be made -- a console project, a `Task`, a
 * `Report`'s `DrawPage` -- and `QrView` is the component that shows one.
 *
 *     const qr = QrCode.Encode("https://example.com/c/" + id, { Ecc: "M" });
 *     qr.Size          // 45: modules a side, without the quiet zone
 *     qr.Dark(x, y)    // one module
 *     qr.Paint(p, 20, 20, 120)     // onto any Painter, a PDF page included
 *
 * **What it publishes is documented like the runtime's own surface**, in
 * [docs/llm/qr.md](../../docs/llm/qr.md), and `tests/api.sh` fails when a
 * member here has no row there.
 *
 * Deliberately absent, each for a reason rather than for time:
 *
 *   Kanji mode    Shift JIS, which nothing in this runtime speaks; a Japanese
 *                 text encodes in byte mode as UTF-8 and every reader takes it
 *   ECI           a byte segment is UTF-8 and readers assume so; declaring it
 *                 breaks old readers rather than helping new ones
 *   mixed modes   one segment for the whole text. A URL is lower case and so
 *                 is byte mode from the first character; the optimal split
 *                 saves a version on text nobody here writes
 *   Micro QR,     other symbologies, sharing a name
 *   rMQR
 *
 * The algorithm follows the standard and, where the standard is ambiguous --
 * the finder-like penalty is the known case -- the reading Project Nayuki's
 * reference implementation gives, which is what most encoders agree on.
 */
"use strict";

/* Error correction codewords per block, and blocks, by level and version.
 * Index 0 is unused so a version indexes directly. Table 9 of the standard. */
const QR_ECC_PER_BLOCK = {
    L: [-1,  7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28,
            28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26,
            26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30,
            28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28,
            30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
};
const QR_BLOCKS = {
    L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8,
            8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16,
            17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20,
            23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25,
            25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
};

/* The two bits the format information carries for each level -- not in the
 * order of the letters, which is the one surprise in the whole format. */
const QR_ECC_BITS = { L: 1, M: 0, Q: 3, H: 2 };

/* Mode indicator, and the width of the character count for versions 1-9,
 * 10-26 and 27-40. */
const QR_MODES = {
    Numeric:      { bits: 0x1, count: [10, 12, 14] },
    Alphanumeric: { bits: 0x2, count: [9, 11, 13] },
    Byte:         { bits: 0x4, count: [8, 16, 16] },
};
const QR_ALPHANUMERIC = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";

class QrCode {

    /* What an encode leaves: the grid is rows of booleans, `true` dark. */
    _version; _ecc; _mask; _mode; _size; _modules; _function;

    /* ------------------------------------------------------------ encoding */

    /*
     * `text` is a string or `Bytes`. A string is encoded in the narrowest mode
     * that holds all of it, as UTF-8 when that is byte mode; `Bytes` is byte
     * mode as it stands.
     *
     * Options: `Ecc` (`L` `M` `Q` `H`, default `M`), `MinVersion` and
     * `MaxVersion` (1-40), `Mask` (0-7, or omitted for the one the penalty
     * rules pick). The version is the smallest in range that holds the data;
     * data that fits none is refused, saying how much room there was.
     */
    static Encode(text, opts) {
        const o   = opts || {};
        const ecc = o.Ecc === undefined ? "M" : o.Ecc;
        if (!(ecc in QR_ECC_BITS))
            throw new TypeError(`QrCode.Encode: Ecc '${ecc}' is not one of L, M, Q, H`);

        const min = o.MinVersion === undefined ? 1 : o.MinVersion;
        const max = o.MaxVersion === undefined ? 40 : o.MaxVersion;
        if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max > 40 || min > max)
            throw new RangeError(`QrCode.Encode: versions ${min} to ${max} are not a range within 1-40`);

        const mask = o.Mask === undefined ? -1 : o.Mask;
        if (mask !== -1 && (!Number.isInteger(mask) || mask < 0 || mask > 7))
            throw new RangeError(`QrCode.Encode: Mask ${mask} is not 0-7`);

        const seg = qrSegment(text);

        let version = 0;
        for (let v = min; v <= max; v++) {
            const used = qrSegmentBits(seg, v);
            if (used >= 0 && used <= qrDataCodewords(v, ecc) * 8) { version = v; break; }
        }
        if (!version) {
            const room = qrDataCodewords(max, ecc) * 8;
            throw new RangeError(`QrCode.Encode: ${seg.count} ${seg.unit} in ${seg.mode} mode ` +
                                 `do not fit version ${max} at level ${ecc} ` +
                                 `(${room} bits of data)`);
        }

        /* The bit stream: mode, count, data, terminator, pad to a byte, then
         * the two pad codewords alternating to fill the capacity. */
        const bits = [];
        const put  = (value, n) => { for (let i = n - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
        put(QR_MODES[seg.mode].bits, 4);
        put(seg.count, QR_MODES[seg.mode].count[qrCountClass(version)]);
        for (const b of seg.bits) bits.push(b);

        const capacity = qrDataCodewords(version, ecc) * 8;
        put(0, Math.min(4, capacity - bits.length));
        put(0, (8 - bits.length % 8) % 8);
        for (let pad = 0xEC; bits.length < capacity; pad ^= 0xEC ^ 0x11) put(pad, 8);

        const data = [];
        for (let i = 0; i < bits.length; i += 8) {
            let byte = 0;
            for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
            data.push(byte);
        }

        const qr = new QrCode();
        qr._version = version;
        qr._ecc     = ecc;
        qr._mode    = seg.mode;
        qr.build(qrInterleave(data, version, ecc), mask);
        return qr;
    }

    /* ------------------------------------------------------- what it holds */

    get Version() { return this._version; }
    get Ecc()     { return this._ecc; }
    get Mask()    { return this._mask; }
    get Mode()    { return this._mode; }
    get Size()    { return this._size; }

    /* One module. Outside the symbol is the quiet zone, which is light, so a
     * caller drawing a border does not have to test the edge first. */
    Dark(x, y) {
        if (x < 0 || y < 0 || x >= this._size || y >= this._size) return false;
        return this._modules[y][x];
    }

    /* ------------------------------------------------------------- drawing */

    /*
     * Onto any `Painter`: a `DrawingArea`'s frame, a PNG through `Save`, a PDF
     * page or a printed sheet. `side` is the whole square including the quiet
     * zone, in the painter's units.
     *
     * The dark modules are **one path and one fill**. Filled one by one, the
     * antialiased edges of two neighbours each leave a sliver of the ground
     * showing between them -- a grey hairline grid over the code, which a
     * reader tolerates and a person sees. One path is covered as a union.
     */
    Paint(p, x, y, side, opts) {
        const o     = opts || {};
        const quiet = qrQuiet(o.QuietZone);
        const cells = this._size + 2 * quiet;
        const unit  = side / cells;

        p.Push();
        p.Color = o.Paper === undefined ? "#ffffff" : o.Paper;
        p.Rectangle(x, y, side, side);
        p.Fill();
        p.Color = o.Ink === undefined ? "#000000" : o.Ink;
        for (let r = 0; r < this._size; r++) {
            /* A run of dark modules along a row is one rectangle: a smaller path
             * for the same shape, and on a version 40 code about a third of the
             * rectangles one per module would be. */
            for (let c = 0; c < this._size; c++) {
                if (!this._modules[r][c]) continue;
                let end = c;
                while (end + 1 < this._size && this._modules[r][end + 1]) end++;
                p.Rectangle(x + (quiet + c) * unit, y + (quiet + r) * unit,
                            (end - c + 1) * unit, unit);
                c = end;
            }
        }
        p.Fill();
        p.Pop();
    }

    /* As an SVG document, one module to a unit of the view box -- for a web
     * page, an e-mail or a file somebody else lays out. */
    ToSvg(opts) {
        const o     = opts || {};
        const quiet = qrQuiet(o.QuietZone);
        const cells = this._size + 2 * quiet;
        const ink   = o.Ink === undefined ? "#000000" : o.Ink;
        const paper = o.Paper === undefined ? "#ffffff" : o.Paper;
        let path = "";

        for (let r = 0; r < this._size; r++)
            for (let c = 0; c < this._size; c++) {
                if (!this._modules[r][c]) continue;
                let end = c;
                while (end + 1 < this._size && this._modules[r][end + 1]) end++;
                path += `M${quiet + c},${quiet + r}h${end - c + 1}v1h-${end - c + 1}z`;
                c = end;
            }

        return `<?xml version="1.0" encoding="UTF-8"?>\n` +
               `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${cells} ${cells}" ` +
               `shape-rendering="crispEdges">\n` +
               `<rect width="100%" height="100%" fill="${paper}"/>\n` +
               `<path d="${path}" fill="${ink}"/>\n</svg>\n`;
    }

    /* As text, two rows of modules to a line in block characters -- for a
     * console program, and for a test that wants to read the symbol. Dark is
     * drawn as ink, so on a terminal with a dark ground `Invert: true` is the
     * spelling that scans. */
    ToText(opts) {
        const o     = opts || {};
        const quiet = qrQuiet(o.QuietZone);
        const inv   = o.Invert === true;
        const end   = this._size + quiet;
        const lines = [];

        for (let r = -quiet; r < end; r += 2) {
            let line = "";
            for (let c = -quiet; c < end; c++) {
                /* A last odd row has nothing under it, which is light. */
                const top = this.Dark(c, r) !== inv;
                const bot = (r + 1 < end && this.Dark(c, r + 1)) !== inv;
                line += top && bot ? "█" : top ? "▀" : bot ? "▄" : " ";
            }
            lines.push(line);
        }
        return lines.join("\n");
    }

    /* -------------------------------------------------- the symbol itself */

    build(codewords, mask) {
        const size = this._version * 4 + 17;
        this._size     = size;
        this._modules  = [];
        this._function = [];
        for (let i = 0; i < size; i++) {
            this._modules.push(new Array(size).fill(false));
            this._function.push(new Array(size).fill(false));
        }

        this.drawFunctionPatterns();
        this.drawCodewords(codewords);

        /* Where a mask applies: every module that is not a function pattern.
         * Listed once, because choosing a mask applies all eight. */
        const cells = [];
        for (let y = 0; y < size; y++)
            for (let x = 0; x < size; x++)
                if (!this._function[y][x]) cells.push(x, y);

        if (mask === -1) {
            /* Each candidate starts from the unmasked symbol, restored from a
             * copy -- a row's `slice` is native, where undoing the mask was a
             * second pass through the interpreter. */
            const plain = this._modules.map((row) => row.slice());
            let best = Infinity;
            for (let m = 0; m < 8; m++) {
                this.applyMask(m, cells);
                this.drawFormatBits(m);
                const score = this.penalty();
                if (score < best) { best = score; mask = m; }
                this._modules = plain.map((row) => row.slice());
            }
        }
        this._mask = mask;
        this.applyMask(mask, cells);
        this.drawFormatBits(mask);
    }

    setFunction(x, y, dark) {
        this._modules[y][x]  = dark;
        this._function[y][x] = true;
    }

    drawFunctionPatterns() {
        const size = this._size;

        for (let i = 0; i < size; i++) {
            this.setFunction(6, i, i % 2 === 0);
            this.setFunction(i, 6, i % 2 === 0);
        }

        this.drawFinder(3, 3);
        this.drawFinder(size - 4, 3);
        this.drawFinder(3, size - 4);

        const at   = qrAlignment(this._version);
        const last = at.length - 1;
        for (let i = 0; i <= last; i++)
            for (let j = 0; j <= last; j++) {
                /* Not where a finder already is. */
                if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0))
                    continue;
                this.drawAlignment(at[i], at[j]);
            }

        this.drawFormatBits(0);       /* reserves the area; the real bits come last */
        this.drawVersion();
    }

    /* A finder with its separator, clipped at the edge of the symbol. */
    drawFinder(x, y) {
        for (let dy = -4; dy <= 4; dy++)
            for (let dx = -4; dx <= 4; dx++) {
                const dist = Math.max(Math.abs(dx), Math.abs(dy));
                const xx = x + dx, yy = y + dy;
                if (xx >= 0 && xx < this._size && yy >= 0 && yy < this._size)
                    this.setFunction(xx, yy, dist !== 2 && dist !== 4);
            }
    }

    drawAlignment(x, y) {
        for (let dy = -2; dy <= 2; dy++)
            for (let dx = -2; dx <= 2; dx++)
                this.setFunction(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }

    /* Fifteen bits, BCH(15,5), written twice: around the top-left finder, and
     * split between the other two -- plus the one module that is always dark. */
    drawFormatBits(mask) {
        const data = (QR_ECC_BITS[this._ecc] << 3) | mask;
        let rem = data;
        for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
        const bits = ((data << 10) | rem) ^ 0x5412;
        const bit  = (i) => ((bits >>> i) & 1) !== 0;
        const size = this._size;

        for (let i = 0; i <= 5; i++) this.setFunction(8, i, bit(i));
        this.setFunction(8, 7, bit(6));
        this.setFunction(8, 8, bit(7));
        this.setFunction(7, 8, bit(8));
        for (let i = 9; i < 15; i++) this.setFunction(14 - i, 8, bit(i));

        for (let i = 0; i < 8; i++) this.setFunction(size - 1 - i, 8, bit(i));
        for (let i = 8; i < 15; i++) this.setFunction(8, size - 15 + i, bit(i));
        this.setFunction(8, size - 8, true);
    }

    /* Eighteen bits, BCH(18,6), from version 7 on: two 6x3 blocks. */
    drawVersion() {
        if (this._version < 7) return;
        let rem = this._version;
        for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
        const bits = (this._version << 12) | rem;

        for (let i = 0; i < 18; i++) {
            const dark = ((bits >>> i) & 1) !== 0;
            const a = this._size - 11 + i % 3, b = Math.floor(i / 3);
            this.setFunction(a, b, dark);
            this.setFunction(b, a, dark);
        }
    }

    /* The zigzag: two columns at a time from the right, up then down, jumping
     * the vertical timing pattern. */
    drawCodewords(codewords) {
        const size = this._size;
        const total = codewords.length * 8;
        let i = 0;

        for (let right = size - 1; right >= 1; right -= 2) {
            if (right === 6) right = 5;
            for (let vert = 0; vert < size; vert++)
                for (let j = 0; j < 2; j++) {
                    const x = right - j;
                    const upward = ((right + 1) & 2) === 0;
                    const y = upward ? size - 1 - vert : vert;
                    if (this._function[y][x] || i >= total) continue;
                    this._modules[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
                    i++;
                }
        }
        /* What is left over -- the remainder bits of some versions -- stays
         * light, which is what the standard asks for. */
    }

    /* One loop per mask rather than a switch per module: the condition is
     * decided once, and the loop only visits the cells a mask may touch. */
    applyMask(mask, cells) {
        const m = this._modules;
        const n = cells.length;
        const flip = (x, y) => { m[y][x] = !m[y][x]; };
        switch (mask) {
            case 0: for (let i = 0; i < n; i += 2) { const x = cells[i], y = cells[i + 1]; if ((x + y) % 2 === 0) flip(x, y); } break;
            case 1: for (let i = 0; i < n; i += 2) { const x = cells[i], y = cells[i + 1]; if (y % 2 === 0) flip(x, y); } break;
            case 2: for (let i = 0; i < n; i += 2) { const x = cells[i], y = cells[i + 1]; if (x % 3 === 0) flip(x, y); } break;
            case 3: for (let i = 0; i < n; i += 2) { const x = cells[i], y = cells[i + 1]; if ((x + y) % 3 === 0) flip(x, y); } break;
            case 4: for (let i = 0; i < n; i += 2) { const x = cells[i], y = cells[i + 1]; if ((Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0) flip(x, y); } break;
            case 5: for (let i = 0; i < n; i += 2) { const x = cells[i], y = cells[i + 1]; if ((x * y) % 2 + (x * y) % 3 === 0) flip(x, y); } break;
            case 6: for (let i = 0; i < n; i += 2) { const x = cells[i], y = cells[i + 1]; if (((x * y) % 2 + (x * y) % 3) % 2 === 0) flip(x, y); } break;
            default: for (let i = 0; i < n; i += 2) { const x = cells[i], y = cells[i + 1]; if (((x + y) % 2 + (x * y) % 3) % 2 === 0) flip(x, y); } break;
        }
    }

    /* The four penalty rules of section 7.8.3: runs, 2x2 blocks, finder-like
     * patterns and the balance of dark against light. Lower is better.
     *
     * It runs once per mask, eight times an encode, and was most of what one
     * cost. So a line is first turned into its runs -- alternating, starting
     * light, the quiet zone counted as light at both ends -- and the
     * finder-like pattern is looked for at each light run, which is where the
     * reference implementation's seven-entry history is looked at too. */
    penalty() {
        const size = this._size;
        const m    = this._modules;
        const runs = [];
        let score = 0;

        for (let pass = 0; pass < 2; pass++)
            for (let a = 0; a < size; a++) {
                const row = pass === 0 ? m[a] : null;
                let color = false, run = 0;
                runs.length = 0;

                for (let b = 0; b < size; b++) {
                    const here = row ? row[b] : m[b][a];
                    if (here === color) {
                        run++;
                        if (run === 5) score += 3;
                        else if (run > 5) score++;
                    } else {
                        runs.push(run);
                        color = here;
                        run = 1;
                    }
                }
                runs.push(run);
                if (color) runs.push(0);        /* the border after a dark run */
                runs[0] += size;
                runs[runs.length - 1] += size;

                for (let i = 0; i < runs.length; i += 2) {
                    const n = i >= 1 ? runs[i - 1] : 0;
                    if (n === 0 || i < 5 || runs[i - 2] !== n || runs[i - 3] !== n * 3 ||
                        runs[i - 4] !== n || runs[i - 5] !== n)
                        continue;
                    const before = i >= 6 ? runs[i - 6] : 0;
                    if (runs[i] >= n * 4 && before >= n) score += 40;
                    if (before >= n * 4 && runs[i] >= n) score += 40;
                }
            }

        let dark = 0;
        for (let y = 0; y < size; y++) {
            const r0 = m[y], r1 = m[y + 1];
            for (let x = 0; x < size; x++) {
                const c = r0[x];
                if (c) dark++;
                if (r1 !== undefined && x + 1 < size &&
                    c === r0[x + 1] && c === r1[x] && c === r1[x + 1])
                    score += 3;
            }
        }
        const total = size * size;
        score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;

        return score;
    }
}

/* ---------------------------------------------------------------- helpers
 *
 * Top-level and prefixed, because a project's libraries share one global scope
 * and `tests/api.sh` refuses two of them declaring the same name.
 */

/* The whole text as one segment, in the narrowest mode that holds it. */
function qrSegment(text) {
    if (text instanceof Bytes) {
        const bytes = [];
        for (let i = 0; i < text.Length; i++) bytes.push(text.At(i));
        return qrByteSegment(bytes);
    }
    if (typeof text !== "string")
        throw new TypeError(`QrCode.Encode: expected text or Bytes, got ${text === null ? "null" : typeof text}`);

    const bits = [];
    const put  = (value, n) => { for (let i = n - 1; i >= 0; i--) bits.push((value >>> i) & 1); };

    if (/^[0-9]*$/.test(text)) {
        for (let i = 0; i < text.length; i += 3) {
            const group = text.slice(i, i + 3);
            put(parseInt(group, 10), group.length * 3 + 1);
        }
        return { mode: "Numeric", count: text.length, unit: "digits", bits };
    }

    let alpha = true;
    for (const ch of text) if (QR_ALPHANUMERIC.indexOf(ch) < 0) { alpha = false; break; }
    if (alpha) {
        for (let i = 0; i + 1 < text.length; i += 2)
            put(QR_ALPHANUMERIC.indexOf(text[i]) * 45 + QR_ALPHANUMERIC.indexOf(text[i + 1]), 11);
        if (text.length % 2) put(QR_ALPHANUMERIC.indexOf(text[text.length - 1]), 6);
        return { mode: "Alphanumeric", count: text.length, unit: "characters", bits };
    }

    const utf8 = new Bytes(text);
    const bytes = [];
    for (let i = 0; i < utf8.Length; i++) bytes.push(utf8.At(i));
    return qrByteSegment(bytes);
}

function qrByteSegment(bytes) {
    const bits = [];
    for (const b of bytes) for (let i = 7; i >= 0; i--) bits.push((b >>> i) & 1);
    return { mode: "Byte", count: bytes.length, unit: "bytes", bits };
}

function qrCountClass(version) { return version <= 9 ? 0 : version <= 26 ? 1 : 2; }

/* The bits a segment takes at a version, or -1 when its count does not fit the
 * count field there. */
function qrSegmentBits(seg, version) {
    const width = QR_MODES[seg.mode].count[qrCountClass(version)];
    if (seg.count >= (1 << width)) return -1;
    return 4 + width + seg.bits.length;
}

/* Modules left for data and error correction once every function pattern is
 * drawn, remainder bits included. */
function qrRawModules(version) {
    let n = (16 * version + 128) * version + 64;
    if (version >= 2) {
        const align = Math.floor(version / 7) + 2;
        n -= (25 * align - 10) * align - 55;
        if (version >= 7) n -= 36;
    }
    return n;
}

function qrDataCodewords(version, ecc) {
    return Math.floor(qrRawModules(version) / 8) -
           QR_ECC_PER_BLOCK[ecc][version] * QR_BLOCKS[ecc][version];
}

/* Where the alignment patterns' centres are, on both axes. */
function qrAlignment(version) {
    if (version === 1) return [];
    const count = Math.floor(version / 7) + 2;
    const step  = Math.floor((version * 8 + count * 3 + 5) / (count * 4 - 4)) * 2;
    const at    = [6];
    for (let pos = version * 4 + 10; at.length < count; pos -= step) at.splice(1, 0, pos);
    return at;
}

/* Split into blocks, append each block's Reed-Solomon codewords, and interleave:
 * the first codeword of every block, then the second, and so on. Short blocks
 * come first and are one data codeword shorter. */
function qrInterleave(data, version, ecc) {
    const blocks    = QR_BLOCKS[ecc][version];
    const eccLen    = QR_ECC_PER_BLOCK[ecc][version];
    const raw       = Math.floor(qrRawModules(version) / 8);
    const short     = blocks - raw % blocks;
    const shortLen  = Math.floor(raw / blocks);
    const divisor   = qrDivisor(eccLen);
    const all       = [];

    for (let i = 0, k = 0; i < blocks; i++) {
        const len = shortLen - eccLen + (i < short ? 0 : 1);
        const dat = data.slice(k, k + len);
        k += len;
        const rs = qrRemainder(dat, divisor);
        if (i < short) dat.push(0);
        all.push(dat.concat(rs));
    }

    const out = [];
    for (let i = 0; i < all[0].length; i++)
        for (let j = 0; j < all.length; j++)
            if (i !== shortLen - eccLen || j >= short) out.push(all[j][i]);
    return out;
}

/* The generator polynomial of the given degree over GF(2^8), 0x11D, highest
 * coefficient dropped. */
function qrDivisor(degree) {
    const result = new Array(degree).fill(0);
    result[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
        for (let j = 0; j < degree; j++) {
            result[j] = qrMultiply(result[j], root);
            if (j + 1 < degree) result[j] ^= result[j + 1];
        }
        root = qrMultiply(root, 0x02);
    }
    return result;
}

function qrRemainder(data, divisor) {
    const result = new Array(divisor.length).fill(0);
    for (const b of data) {
        const factor = b ^ result.shift();
        result.push(0);
        for (let i = 0; i < divisor.length; i++) result[i] ^= qrMultiply(divisor[i], factor);
    }
    return result;
}

/* GF(2^8) by its logarithms: a multiply is two lookups and an add, where the
 * shift-and-xor loop was eight iterations and a fifth of what encoding a large
 * symbol cost. The exponent table is doubled so the sum needs no modulo. */
const QR_EXP = [], QR_LOG = [];
for (let i = 0, x = 1; i < 255; i++) {
    QR_EXP[i] = QR_EXP[i + 255] = x;
    QR_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11D;
}

function qrMultiply(x, y) {
    return x === 0 || y === 0 ? 0 : QR_EXP[QR_LOG[x] + QR_LOG[y]];
}

function qrQuiet(q) {
    if (q === undefined) return 4;
    if (!Number.isInteger(q) || q < 0)
        throw new RangeError(`QrCode: QuietZone ${q} is not a whole number of modules, 0 or more`);
    return q;
}
