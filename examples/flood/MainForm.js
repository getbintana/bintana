/*
 * Flood-It: flood the whole board from the top-left corner before the moves
 * run out.  One `DrawingArea` for the board, one for the strip of colours,
 * and the game itself in Flood.js -- which is what makes this file the
 * drawing and the input and little else, and every drawing in this runtime
 * the same `Draw` with more of it.
 *
 * The board and the strip take the tic-tac-toe example's claims at larger
 * size:
 *
 *   - **one helper owns the geometry** (`paletteBox`): the drawing paints
 *     what it answers and the pointer asks it the same question, so the
 *     swatches and the hit test cannot drift apart;
 *   - **the pointer re-measures** (`Palette.Bounds()`) at every gesture
 *     instead of keeping a rectangle from an earlier frame;
 *   - **the colours come from the frame** (`p.Dark`) when the drawing
 *     happens, so the other theme is drawn correctly on the next frame.
 *
 * The flood itself is in Flood.js.  What is worth reading here is how the
 * three surfaces meet: `play` is the only road into the game -- the strip's
 * click, the digit keys and the selftest all take it -- and it redraws both
 * drawings, because one move repaints the board and moves the ring.
 */
"use strict";

/* The six colours of the game, light theme first.  Game content and not
 * theme colours: a red cell is red on any desktop.  The pairs are the GNOME
 * palette's -- a red that reads on a light board and the lighter sibling
 * that reads on a dark one -- so the board is legible either way. */
const FLOOD_COLORS = [
    ["#e01b24", "#f66151"],     /* red    */
    ["#ff7800", "#ffa348"],     /* orange */
    ["#f5c211", "#f8e45c"],     /* yellow */
    ["#2ec27e", "#57e389"],     /* green  */
    ["#1c71d8", "#78aeed"],     /* blue   */
    ["#9141ac", "#dc8add"]      /* purple */
];

/* The three games, and the moves each comes with.  The limits are measured
 * and not round: a board is kept only when the greedy player finishes it
 * inside its limit (Flood.board), and these sit about four moves above what
 * greedy typically needs -- the room a person needs to think. */
const FLOOD_SIZES = [
    { n: 10, limit: 23 },       /* small  */
    { n: 14, limit: 30 },       /* medium */
    { n: 18, limit: 38 }        /* large  */
];

const FLOOD_START = 1;          /* medium: the size the game opens on */

class MainForm extends Form {

    board = null;               /* the Flood in play */
    hover = -1;                 /* the swatch under the pointer, or -1 */

    Form_Open() {
        this.CmbSize.Index = FLOOD_START;
        this.newGame();

        if (Application.Arguments.includes("--selftest")) this.selftest();
    }

    BtnNew_Click() { this.newGame(); }

    /* The list's own `Items` fires this while the `.form` is still being
     * applied -- before the form is open and before its controls are bound
     * to it, so `this.CmbSize` is not even there yet.  The board is what
     * tells a real selection from that first one: it exists only after
     * Form_Open has dealt. */
    CmbSize_Select() {
        if (this.board) this.newGame();
    }

    /* The digits pick a colour, the way the strip reads.  Nothing else is a
     * key this game has, so a press the game does not use passes on. */
    Form_KeyPress(key) {
        const at = "123456".indexOf(key);

        if (at < 0) return false;
        this.play(at);
        return true;
    }

    /* ------------------------------------------------------------- the game */

    newGame() {
        const at   = Math.max(0, Math.min(FLOOD_SIZES.length - 1, this.CmbSize.Index));
        const size = FLOOD_SIZES[at];

        this.board = Flood.board(size.n, FLOOD_COLORS.length, size.limit);
        this.hover = -1;
        this.Palette.Opacity = 1;           /* a game that ended had dimmed it */

        this.refresh();
    }

    /* The one road into the game: a click, a digit, the selftest.  A colour
     * the region already is, or a press after the end, is not a move --
     * `pick` is the one place that decides. */
    play(at) {
        if (this.board.pick(at)) this.refresh();
    }

    refresh() {
        if (this.board.over()) {
            this.LblStatus.Text = this.board.won()
                ? Locale.Text("You win in {0} moves!", String(this.board.moves))
                : Locale.Text("Out of moves");
            this.Palette.Opacity = 0.45;
        } else {
            this.LblStatus.Fill(String(this.board.left()));     /* "Moves left: {0}" */
        }

        this.Board.Redraw();
        this.Palette.Redraw();
    }

    /* ------------------------------------------------------------ the board */

    Board_Draw(p, width, height) {
        const n    = this.board.n;
        const side = Math.min(width, height);
        const step = side / n;
        const x0   = (width  - side) / 2;
        const y0   = (height - side) / 2;

        /* Every cell, and a pixel is a cell's edge: the boundaries are
         * rounded once and read by both sides of each rectangle, so two
         * neighbours share an edge exactly and the flood paints as one
         * shape, with no seam of background between its cells. */
        for (let row = 0; row < n; row++) {
            const y1 = Math.round(y0 + row * step);
            const y2 = Math.round(y0 + (row + 1) * step);

            for (let col = 0; col < n; col++) {
                const x1 = Math.round(x0 + col * step);
                const x2 = Math.round(x0 + (col + 1) * step);

                p.Color = this.cellColor(row * n + col, p.Dark);
                p.Rectangle(x1, y1, x2 - x1, y2 - y1);
                p.Fill();
            }
        }

        /* A hairline between cells, so the shape of the flood is readable --
         * the ink at a tenth, which is drawn right on either theme because
         * what says "dark" is the frame and not the colour. */
        p.Color     = p.Dark ? "rgba(255,255,255,0.10)" : "rgba(0,0,0,0.10)";
        p.LineWidth = 1;
        for (let i = 1; i < n; i++) {
            const x = Math.round(x0 + i * step);
            const y = Math.round(y0 + i * step);

            p.MoveTo(x, Math.round(y0));
            p.LineTo(x, Math.round(y0 + side));
            p.MoveTo(Math.round(x0), y);
            p.LineTo(Math.round(x0 + side), y);
        }
        p.Stroke();

        if (this.board.over()) this.banner(p, width, height);
    }

    /* The colour a cell wears now: the region's, if it is in the region --
     * the board under it was never rewritten. */
    cellColor(at, dark) {
        const color = this.board.region[at] ? this.board.color : this.board.cells[at];

        return FLOOD_COLORS[color][dark ? 1 : 0];
    }

    /* The end of the game, said over the board: a translucent card with the
     * sentence and the count -- in moves for a win, in cells for a loss. */
    banner(p, width, height) {
        const won  = this.board.won();
        const head = won ? Locale.Text("You win!") : Locale.Text("Out of moves");
        const sub  = won
            ? Locale.Text("In {0} of {1} moves",
                          String(this.board.moves), String(this.board.limit))
            : Locale.Text("{0} of {1} cells flooded",
                          String(this.board.filled), String(this.board.cells.length));

        p.Font = "Bold 22";
        const headWidth = p.TextWidth(head), headHeight = p.TextHeight(head);

        p.Font = "11";
        const subWidth = p.TextWidth(sub), subHeight = p.TextHeight(sub);

        const w = Math.max(headWidth, subWidth) + 48;
        const h = headHeight + subHeight + 30;
        const x = (width  - w) / 2;
        const y = (height - h) / 2;

        p.Color = p.Dark ? "rgba(0,0,0,0.78)" : "rgba(255,255,255,0.92)";
        this.roundRect(p, x, y, w, h, 14);
        p.Fill();

        p.Color = p.Dark ? "#ffffff" : "#241f31";
        p.Font  = "Bold 22";
        p.Text(head, x + (w - headWidth) / 2, y + 14);

        p.Color = p.Dark ? "rgba(255,255,255,0.75)" : "rgba(0,0,0,0.65)";
        p.Font  = "11";
        p.Text(sub, x + (w - subWidth) / 2, y + 14 + headHeight + 6);
    }

    /* --------------------------------------------------- the colour strip */

    /* Where the swatches are, in the strip's coordinates.  **The numbers
     * live here and nowhere else**: the drawing and the hit test are two
     * readings of the same arithmetic. */
    paletteBox(width, height) {
        const n    = this.board.colors;
        const gap  = 8, pad = 12;
        const size = Math.min((width - (n - 1) * gap) / n, height - 2 * pad);

        return {
            n:      n,
            gap:    gap,
            size:   size,
            x:      (width  - (n * size + (n - 1) * gap)) / 2,
            y:      (height - size) / 2,
            radius: Math.min(14, Math.max(0, size * 0.22))
        };
    }

    swatchAt(x, y) {
        const b   = this.Palette.Bounds();
        const box = this.paletteBox(b.Width, b.Height);

        if (box.size <= 0) return -1;
        if (y < box.y || y > box.y + box.size) return -1;

        const at = Math.floor((x - box.x) / (box.size + box.gap));

        if (at < 0 || at >= box.n) return -1;
        if (x > box.x + at * (box.size + box.gap) + box.size) return -1;    /* the gap */
        return at;
    }

    Palette_Draw(p, width, height) {
        const box = this.paletteBox(width, height);

        if (box.size <= 0) return;      /* a strip with no room draws nothing */

        for (let i = 0; i < box.n; i++) {
            const x = box.x + i * (box.size + box.gap);

            p.Color = FLOOD_COLORS[i][p.Dark ? 1 : 0];
            this.roundRect(p, x, box.y, box.size, box.size, box.radius);
            p.Fill();
        }

        /* The region's colour wears the ring; the one under the pointer, a
         * fainter one.  Both after every fill, so a ring is never half
         * covered by the swatch that comes next. */
        if (this.board.color >= 0 && this.board.color < box.n)
            this.ring(p, box, this.board.color, 3, false);

        if (this.hover >= 0 && this.hover !== this.board.color)
            this.ring(p, box, this.hover, 2, true);
    }

    ring(p, box, at, lineWidth, faint) {
        const x = box.x + at * (box.size + box.gap);

        p.Color = faint
            ? (p.Dark ? "rgba(255,255,255,0.45)" : "rgba(0,0,0,0.35)")
            : (p.Dark ? "rgba(255,255,255,0.90)" : "rgba(0,0,0,0.75)");
        p.LineWidth = lineWidth;

        this.roundRect(p, x + lineWidth / 2, box.y + lineWidth / 2,
                       box.size - lineWidth, box.size - lineWidth,
                       Math.max(0, box.radius - lineWidth / 2));
        p.Stroke();
    }

    Palette_MouseDown(x, y) {
        const at = this.swatchAt(x, y);

        if (at >= 0) this.play(at);
    }

    Palette_MouseMove(x, y) {
        const at  = this.swatchAt(x, y);
        const was = this.hover;

        this.hover = at;
        if (this.hover !== was) this.Palette.Redraw();    /* moved within a swatch: no frame */
    }

    Palette_MouseLeave() {
        if (this.hover === -1) return;

        this.hover = -1;
        this.Palette.Redraw();
    }

    /* --------------------------------------------------------------- misc */

    /* A rounded rectangle, which the `Painter` has no primitive for: four
     * `Arc` quarters joined by their straight sides, closed and filled.  Each
     * arc starts exactly where the line before it stopped -- `Arc` appends to
     * the path and does not start one -- so nothing jumps corner to corner. */
    roundRect(p, x, y, w, h, r) {
        p.MoveTo(x + r, y);
        p.LineTo(x + w - r, y);        p.Arc(x + w - r, y + r,     r, -90,   0);
        p.LineTo(x + w, y + h - r);    p.Arc(x + w - r, y + h - r, r,   0,  90);
        p.LineTo(x + r, y + h);        p.Arc(x + r,     y + h - r, r,  90, 180);
        p.LineTo(x, y + r);            p.Arc(x + r,     y + r,     r, 180, 270);
        p.ClosePath();
    }

    /* `--selftest` is how a headless run checks the game without a person:
     * it plays the board greedily through the same `play` the palette calls,
     * inside the limit the game handed out, and exits with the answer.  It
     * proves the property the whole deal leans on -- that a board kept can be
     * finished -- on the real board, over the real form. */
    selftest() {
        let guard = 0;

        while (!this.board.over() && guard++ < 500) this.play(this.board.hint());

        if (this.board.won()) {
            Logger.Info("flood: won in", this.board.moves, "of", this.board.limit, "moves");
            Timer.After(50, () => Application.Quit(0));
        } else {
            Logger.Error("flood: the greedy player could not finish the board");
            Timer.After(50, () => Application.Quit(1));
        }
    }
}
