/*
 * The programs, one function each, and what each must answer.
 *
 * They are the eight of Gambas's `benchmark/` directory -- the same algorithms
 * at the same sizes, so a number here sits beside the table Gambas publishes
 * for Python, Perl, Java and itself -- written again in this language rather
 * than translated line by line from theirs, which is GPL-2 where this tree is
 * MIT. `nbody` is the Computer Language Benchmarks Game's, as theirs is.
 *
 * **Every program answers something, and the answer is checked.** A run that
 * got faster by computing the wrong thing is the regression a benchmark is
 * worst at catching, and an interpreter change is exactly where it would come
 * from: the GCC fix this was written after changed how every integer is built.
 */

/* --- btree: allocation and the collector ---------------------------------- */
class TreeNode {
    constructor(left, right) { this.left = left; this.right = right; }
    check() {
        return this.left === null ? 1 : this.left.check() + this.right.check() + 1;
    }
}

function tree(depth) {
    return depth > 0 ? new TreeNode(tree(depth - 1), tree(depth - 1))
                     : new TreeNode(null, null);
}

function btree() {
    const min = 4, max = 16;
    const out = [tree(max + 1).check()];
    const longLived = tree(max);

    for (let depth = min; depth <= max; depth += 2) {
        const iterations = 2 ** (max - depth + min);
        let check = 0;
        for (let i = 0; i < iterations; i++) check += tree(depth).check();
        out.push(check);
    }
    out.push(longLived.check());
    return out.join(" ");
}

/* --- mandelbrot: floating point in a tight loop --------------------------- */
function mandelbrotOnce(w, h) {
    const MAXITER = 50, LIMIT = 4, invN = 2 / w;
    let ones = 0, checknext = true;

    for (let y = 0; y < h; y++) {
        const ci = y * invN - 1;
        let row = "";
        for (let x = 0; x < w; x++) {
            const cr = x * invN - 1.5;
            let zr = 0, zi = 0, tr = 0, ti = 0, k = 0;
            if (checknext) {
                for (; k < MAXITER; k++) {
                    zi = 2 * zr * zi + ci;
                    zr = tr - ti + cr;
                    ti = zi * zi;
                    tr = zr * zr;
                    if (tr + ti > LIMIT) break;
                }
                if (k === MAXITER) { row += "1"; ones++; }
                else { row += "0"; checknext = false; }
            } else {
                for (; k < MAXITER; k++) {
                    zi = 2 * zr * zi + ci;
                    zr = tr - ti + cr;
                    ti = zi * zi;
                    tr = zr * zr;
                }
                if (tr + ti < LIMIT) { row += "1"; ones++; }
                else { row += "0"; checknext = true; }
            }
        }
    }
    return ones;
}

function mandelbrot() {
    let ones = 0;
    for (let i = 0; i < 20; i++) ones = mandelbrotOnce(200, 200);
    return ones;
}

/* --- nbody: objects of numbers, read and written -------------------------- */
const SOLAR_MASS = 4 * Math.PI * Math.PI;
const DAYS_PER_YEAR = 365.24;

function body(x, y, z, vx, vy, vz, mass) {
    return { x, y, z, vx: vx * DAYS_PER_YEAR, vy: vy * DAYS_PER_YEAR,
             vz: vz * DAYS_PER_YEAR, mass: mass * SOLAR_MASS };
}

function system() {
    return [
        body(0, 0, 0, 0, 0, 0, 1),
        body(4.84143144246472090e+00, -1.16032004402742839e+00, -1.03622044471123109e-01,
             1.66007664274403694e-03, 7.69901118419740425e-03, -6.90460016972063023e-05,
             9.54791938424326609e-04),
        body(8.34336671824457987e+00, 4.12479856412430479e+00, -4.03523417114321381e-01,
             -2.76742510726862411e-03, 4.99852801234917238e-03, 2.30417297573763929e-05,
             2.85885980666130812e-04),
        body(1.28943695621391310e+01, -1.51111514016986312e+01, -2.23307578892655734e-01,
             2.96460137564761618e-03, 2.37847173959480950e-03, -2.96589568540237556e-05,
             4.36624404335156298e-05),
        body(1.53796971148509165e+01, -2.59193146099879641e+01, 1.79258772950371181e-01,
             2.68067772490389322e-03, 1.62824170038242295e-03, -9.51592254519715870e-05,
             5.15138902046611451e-05),
    ];
}

function advance(bodies, dt) {
    const n = bodies.length;
    for (let i = 0; i < n; i++) {
        const a = bodies[i];
        for (let j = i + 1; j < n; j++) {
            const b = bodies[j];
            const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
            const d2 = dx * dx + dy * dy + dz * dz;
            const mag = dt / (d2 * Math.sqrt(d2));
            a.vx -= dx * b.mass * mag; a.vy -= dy * b.mass * mag; a.vz -= dz * b.mass * mag;
            b.vx += dx * a.mass * mag; b.vy += dy * a.mass * mag; b.vz += dz * a.mass * mag;
        }
    }
    for (const b of bodies) { b.x += dt * b.vx; b.y += dt * b.vy; b.z += dt * b.vz; }
}

function energy(bodies) {
    let e = 0;
    for (let i = 0; i < bodies.length; i++) {
        const a = bodies[i];
        e += 0.5 * a.mass * (a.vx * a.vx + a.vy * a.vy + a.vz * a.vz);
        for (let j = i + 1; j < bodies.length; j++) {
            const b = bodies[j];
            const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
            e -= a.mass * b.mass / Math.sqrt(dx * dx + dy * dy + dz * dz);
        }
    }
    return e.toFixed(9);
}

function nbody() {
    const bodies = system();
    let px = 0, py = 0, pz = 0;
    for (const b of bodies) { px += b.vx * b.mass; py += b.vy * b.mass; pz += b.vz * b.mass; }
    bodies[0].vx = -px / SOLAR_MASS; bodies[0].vy = -py / SOLAR_MASS; bodies[0].vz = -pz / SOLAR_MASS;

    const out = [];
    for (let t = 0; t < 5; t++) {
        out.push(energy(bodies));
        for (let n = 0; n < 100000; n++) advance(bodies, 0.01);
    }
    out.push(energy(bodies));
    return out.join(" ");
}

/* --- polynom: an array of doubles, written and read ----------------------- */
function polynomOnce(x) {
    let mu = 10, pu = 0;
    const pol = new Array(100).fill(0);

    for (let i = 0; i < 500000; i++) {
        for (let j = 0; j < 100; j++) pol[j] = mu = (mu + 2) / 2;
        let su = 0;
        for (let j = 0; j < 100; j++) su = x * su + pol[j];
        pu += su;
    }
    return pu;
}

function polynom() {
    let r = 0;
    for (let i = 0; i < 2; i++) r = polynomOnce(0.2);
    return r.toFixed(3);
}

/* --- primes: the odd-only sieve, over a large array ----------------------- */
function sieve(n) {
    const s = [];
    for (let v = 3; v <= n; v += 2) s.push(v);
    const half = s.length, root = Math.sqrt(n);

    for (let i = 0, m = 3; m <= root; i++, m = 2 * i + 3) {
        if (s[i] === 0) continue;
        for (let j = (m * m - 3) / 2; j < half; j += m) s[j] = 0;
    }
    let count = 1;
    for (let i = 0; i < half; i++) if (s[i] !== 0) count++;
    return count;
}

function primes() {
    let count = 0;
    for (let t = 0; t < 5; t++) count = sieve(10000000);
    return count;
}

/* --- sort: a bubble sort, compares and swaps in an array ------------------- */
function shuffled(n) {
    /* Gambas's list is a fixed permutation of 0..999; any permutation does the
     * same work up to the swaps, and a seeded one is the same every run. */
    const a = [];
    for (let i = 0; i < n; i++) a.push(i);
    let seed = 12345;
    for (let i = n - 1; i > 0; i--) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const j = seed % (i + 1);
        const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
}

function bubble(tab) {
    const n = tab.length;
    for (let i = 0; i < n - 1; i++)
        for (let j = i + 1; j < n; j++)
            if (tab[j] < tab[i]) { const t = tab[i]; tab[i] = tab[j]; tab[j] = t; }
}

function sort() {
    const src = shuffled(1000);
    let tab = null;
    for (let t = 0; t < 100; t++) { tab = src.slice(); bubble(tab); }
    for (let i = 0; i < tab.length; i++) if (tab[i] !== i) return `unsorted at ${i}`;
    return tab.length;
}

/* --- string1: a growing string, searched and replaced --------------------- */
function string1() {
    const piece = "abcdefgh" + "efghefgh";
    const imax = 1024 / piece.length * 512;
    let g = "";
    for (let i = 0; i < imax + 1000; i++) {
        g += piece;
        g = g.replaceAll("efgh", "____");
    }
    return g.length;
}

/* --- string2: a hundred megabytes of concatenation ------------------------- */
function string2() {
    let s = "";
    for (let i = 0; i < 1000000; i++)
        for (let j = 65; j <= 90; j++) s += ".(" + String.fromCharCode(j) + ")";
    return s.length;
}

/* What each program must answer. Python's run of Gambas's versions gave
 * `btree`, `nbody`, `polynom` and `primes`; the rest are arithmetic, and
 * `mandelbrot` is the one that differs from Python's: `for k in range(50)`
 * leaves `k` at 49, so Python's never counts a point inside the set on the
 * checking road (15627) where Java's and this one do (15899, checked against
 * a Python loop that does). */
const PROGRAMS = {
    btree:      { run: btree,      answer: "262143 2031616 2080768 2093056 2096128 2096896 2097088 2097136 131071" },
    mandelbrot: { run: mandelbrot, answer: 15899 },
    nbody:      { run: nbody,      answer: "-0.169075164 -0.169079859 -0.169083713 -0.169087840 -0.169092782 -0.169096567" },
    polynom:    { run: polynom,    answer: "1250000.000" },
    primes:     { run: primes,     answer: 664579 },
    sort:       { run: sort,       answer: 1000 },
    string1:    { run: string1,    answer: 540288 },
    string2:    { run: string2,    answer: 104000000 },
};
