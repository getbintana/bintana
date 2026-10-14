/*
 * Tic-tac-toe: one `DrawingArea`, its pointer handlers, and the game on top.
 *
 * The whole example is a surface and the arithmetic over it -- and that is
 * the claim worth taking away, because every drawing in this runtime is the
 * same `Draw` with more of it: `lib/charts`, `lib/report` and `lib/markdown`
 * are one `DrawingArea` each and a great deal more of this.
 *
 * Four things are done the way they are on purpose, because they are what a
 * first drawing gets wrong:
 *
 *   - **one helper owns the geometry** (`boardBox`): `Draw` paints what it
 *     answers and the pointer asks it the same question, so the ink and the
 *     hit test cannot drift apart;
 *   - **the pointer re-measures** (`Board.Bounds()`) at every gesture instead
 *     of keeping a rectangle from an earlier frame -- the window can have
 *     been resized in between;
 *   - **the colours come from the frame** (`p.Dark`), read when the drawing
 *     happens rather than decided once, so another theme is drawn correctly
 *     on the next frame;
 *   - **the animation is moved by the clock** and not by counting ticks: a
 *     timer asked for 16 ms does not fire every 16 ms, and the stopwatch
 *     beside it is what `examples/stopwatch` is about.
 *
 * The frame is not the only road out: `Board.Save(path, 420, 420)` runs this
 * same `Draw` against an image surface and writes a PNG with no window
 * involved, which is how a drawing gets into a test, a report or an email.
 *
 * And there is a sound on a win, `win.wav` beside this file: one
 * `AudioPlayer`, made once with the form and played again on every game.  A
 * cue on an event is almost the whole of what an application ever asks of
 * the media surface, and this is the one place in the tree that plays a file
 * of the project's own -- `examples/video` cues a clip from the network.
 */
"use strict";

/* The eight lines of the game, as indices into the flat board. */
const LINES = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],      /* across */
    [0, 3, 6], [1, 4, 7], [2, 5, 8],      /* down */
    [0, 4, 8], [2, 4, 6]                  /* and both diagonals */
];

const ANIM_MS = 160;    /* how long a placed mark takes to grow */
const PAD     = 14;     /* the quiet room around the board */

class MainForm extends Form {

    board = [0, 0, 0, 0, 0, 0, 0, 0, 0];    /* 0 empty, 1 X, 2 O */
    turn  = 1;                              /* whose turn it is */
    over  = false;
    win   = null;                           /* the winning row of `LINES` */
    score = [0, 0];
    hover = -1;                             /* the cell under the pointer, or -1 */
    last  = -1;                             /* the mark being animated, or -1 */
    grow  = 1;                              /* how grown it is, 0..1 */
    anim  = null;                           /* the running Timer, or null */
    cue   = null;                           /* the AudioPlayer, or null */

    Form_Open() {
        this.cue = this.makeCue();
        this.newGame();
    }

    BtnNew_Click() {
        this.newGame();
    }

    /* ------------------------------------------------------------- the game */

    newGame() {
        if (this.anim) { this.anim.Stop(); this.anim = null; }

        this.board = [0, 0, 0, 0, 0, 0, 0, 0, 0];
        this.turn  = 1;
        this.over  = false;
        this.win   = null;
        this.hover = -1;
        this.last  = -1;
        this.grow  = 1;

        this.showStatus();
        this.Board.Redraw();
    }

    place(at) {
        this.board[at] = this.turn;
        this.last = at;
        this.grow = 0;
        this.startGrow();

        this.win = this.winningLine();
        if (this.win) {
            this.score[this.turn - 1] += 1;
            this.over = true;
            this.ding();
        } else if (this.board.indexOf(0) < 0) {
            this.over = true;                  /* full, with no line: a draw */
        } else {
            this.turn = 3 - this.turn;         /* 1 -> 2, 2 -> 1 */
        }

        this.showStatus();
        this.Board.Redraw();
    }

    winningLine() {
        for (const line of LINES) {
            const v = this.board[line[0]];
            if (v !== 0 && v === this.board[line[1]] && v === this.board[line[2]])
                return line;
        }
        return null;
    }

    /* The mark that was just placed grows into place.  The timer decides *when
     * to repaint* and nothing else; how far the animation is comes from the
     * clock, so a late tick shows a bigger mark rather than a slower game. */
    startGrow() {
        if (this.anim) { this.anim.Stop(); this.anim = null; }

        const from = new Stopwatch().Start();

        this.anim = Timer.Every(16, () => {
            const t = Math.min(1, from.Elapsed / ANIM_MS);

            this.grow = 1 - (1 - t) * (1 - t);      /* fast in, soft landing */
            if (t >= 1) { this.anim.Stop(); this.anim = null; }
            this.Board.Redraw();
        });
    }

    /* What the two labels say.  `Locale.Text` because a sentence built from
     * code is still a sentence a translator should see, and the placeholders
     * keep the number out of the catalogue. */
    showStatus() {
        const mark = this.turn === 1 ? "X" : "O";

        this.LblScore.Text = Locale.Text("X {0} · O {1}",
                                         String(this.score[0]), String(this.score[1]));

        if (this.win)        this.LblStatus.Text = Locale.Text("{0} wins!", mark);
        else if (this.over)  this.LblStatus.Text = Locale.Text("It's a draw");
        else                 this.LblStatus.Text = Locale.Text("{0}'s turn", mark);
    }

    /* ------------------------------------------------------------- the sound
     *
     * One player for the whole form, not one per win: the first pays for
     * loading the media library, and a player left playing holds itself until
     * it ends.  `Play` replays from the top once it has ended, so the same
     * cue answers every game.
     *
     * The constructor is where this runtime puts a missing optional engine
     * (sqlite's refusal takes the same road), and the sound is the one part
     * of this example that can be absent -- so it is caught once, here, and
     * the game plays on in silence.  A machine with no sound card fails later
     * instead, asynchronously: that is what `OnError` is for, and the empty
     * handler says the game has nothing to do about it.
     */
    makeCue() {
        try {
            const cue = new AudioPlayer();

            cue.Uri     = File.Join(Application.Directory, "win.wav");
            cue.Volume  = 0.7;
            cue.OnError = () => {};
            return cue;
        } catch (e) {
            return null;
        }
    }

    ding() {
        if (this.cue) this.cue.Play();
    }

    /* ------------------------------------------------------------ the frame
     *
     * The board is the square that fits the frame, centred, with `PAD` of
     * quiet around it.  **The five numbers live here and nowhere else**: the
     * drawing and the hit test are two readings of the same arithmetic, and a
     * drawing whose pointer recomputes the geometry is one that drifts.
     */
    boardBox(width, height) {
        const side = Math.min(width, height) - 2 * PAD;
        return {
            x:    (width  - side) / 2,
            y:    (height - side) / 2,
            side: side,
            cell: side / 3
        };
    }

    /* Where cell `at` sits, in frame coordinates. */
    centre(at, box) {
        const col = at % 3, row = Math.floor(at / 3);
        return { x: box.x + (col + 0.5) * box.cell,
                 y: box.y + (row + 0.5) * box.cell };
    }

    /* Which cell the point is over, or -1.  The rectangle is measured *now*:
     * a kept one would be the geometry of whatever the window was then. */
    cellAt(x, y) {
        const b   = this.Board.Bounds();
        const box = this.boardBox(b.Width, b.Height);

        if (box.side <= 0) return -1;

        const col = Math.floor((x - box.x) / box.cell);
        const row = Math.floor((y - box.y) / box.cell);

        if (col < 0 || col > 2 || row < 0 || row > 2) return -1;
        return row * 3 + col;
    }

    Board_Draw(p, width, height) {
        const box = this.boardBox(width, height);
        if (box.side <= 0) return;      /* a surface with no room draws nothing */

        /* The hover, first and faintest: the cell the pointer is over, while
         * it is empty and the game is still on. */
        if (!this.over && this.hover >= 0) {
            const c = this.centre(this.hover, box);
            const r = Math.min(12, box.cell * 0.14);

            p.Color = p.Dark ? "rgba(255,255,255,0.10)" : "rgba(0,0,0,0.06)";
            this.roundRect(p, c.x - box.cell / 2 + 6, c.y - box.cell / 2 + 6,
                           box.cell - 12, box.cell - 12, r);
            p.Fill();
        }

        /* The grid, in the theme's ink at a quarter: an ink that hard-codes
         * grey is grey on a dark theme too. */
        p.Color     = p.Dark ? "rgba(255,255,255,0.30)" : "rgba(0,0,0,0.22)";
        p.LineWidth = 2;
        for (let i = 1; i < 3; i++) {
            p.MoveTo(box.x + i * box.cell, box.y);
            p.LineTo(box.x + i * box.cell, box.y + box.side);
            p.MoveTo(box.x, box.y + i * box.cell);
            p.LineTo(box.x + box.side, box.y + i * box.cell);
        }
        p.Stroke();

        /* The marks, and the one that is still growing. */
        p.LineWidth = 8;
        p.LineCap   = "Round";
        for (let at = 0; at < 9; at++) {
            if (this.board[at] === 0) continue;

            const c = this.centre(at, box);
            this.mark(p, this.board[at], c.x, c.y, box.cell * 0.28,
                      at === this.last ? this.grow : 1);
        }

        /* And the winning line, over everything. */
        if (this.win) {
            const a = this.centre(this.win[0], box);
            const b = this.centre(this.win[2], box);

            p.Color     = p.Dark ? "rgba(87,227,137,0.85)" : "rgba(38,162,105,0.85)";
            p.LineWidth = 6;
            p.LineCap   = "Round";
            p.MoveTo(a.x, a.y);
            p.LineTo(b.x, b.y);
            p.Stroke();
        }
    }

    /* One mark, as strokes: an X is two segments and an O is a full `Arc`.
     *
     * The mark is described **around the origin** and placed by the transform:
     * `Translate` to the cell's centre comes first, and then `Scale(grow)`
     * grows it about that centre.  The other order scales the offset too --
     * cairo applies the transform written *last* first, so `Scale` before
     * `Translate` would slide the mark towards the corner as it grew.
     */
    mark(p, player, cx, cy, r, grow) {
        const s = Math.max(0.05, grow);

        p.Push();
        p.Translate(cx, cy);
        p.Scale(s);

        p.Color = player === 1
                    ? (p.Dark ? "#78aeed" : "#1c71d8")      /* X: blue */
                    : (p.Dark ? "#f66151" : "#e01b24");     /* O: red  */

        if (player === 1) {
            p.MoveTo(-r, -r);  p.LineTo(r, r);
            p.MoveTo(r, -r);   p.LineTo(-r, r);
        } else {
            p.Arc(0, 0, r * 0.94, 0, 360);
        }
        p.Stroke();
        p.Pop();
    }

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

    /* ---------------------------------------------------------- the pointer */

    Board_MouseDown(x, y) {
        if (this.over) return;

        const at = this.cellAt(x, y);
        if (at < 0 || this.board[at] !== 0) return;

        this.hover = -1;                /* the cell stops being empty now */
        this.place(at);
    }

    Board_MouseMove(x, y) {
        if (this.over) return;

        const at  = this.cellAt(x, y);
        const was = this.hover;

        this.hover = at >= 0 && this.board[at] === 0 ? at : -1;
        if (this.hover !== was) this.Board.Redraw();   /* moved within a cell: no frame */
    }

    Board_MouseLeave() {
        if (this.hover === -1) return;

        this.hover = -1;
        this.Board.Redraw();
    }
}
