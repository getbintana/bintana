/*
 * A year of sales, made up the same way every time.
 *
 * The example is about the grid and not about where rows come from, so they are
 * generated -- **deterministically**, from a small linear congruential sequence,
 * so the totals the self-test checks are the same on every machine and every
 * run. A real screen would read them from a `Table` or a `Csv`; the grid takes
 * the same arrays either way.
 *
 * A row is `[code, client, date, product, qty, price, amount, region]`, and the
 * amount is `qty × price` as a `Decimal`, exact to the cent.
 */
"use strict";

const CLIENTS  = ["Álvarez e Hijos", "Bodega Norte", "Casa Rivas", "Distribuidora Sur",
                  "El Molino", "Ferretería Centro", "Granja Los Pinos", "Hotel Litoral"];
const PRODUCTS = ["Harina 25 kg", "Aceite 5 l", "Yerba 1 kg", "Azúcar 10 kg", "Arroz 5 kg"];
const PRICES   = ["18500.00", "9200.50", "3150.75", "8400.00", "6100.25"];
const REGIONS  = ["Norte", "Sur", "Centro", "Litoral"];

export class Sales {

    /**
     * `count` rows, the same ones every time
     * @returns Array
     */
    static Rows(count) {
        let seed = 12345;
        const next = (n) => {
            seed = (seed * 1103515245 + 12345) % 2147483648;
            /* The high bits: the low ones of this sequence repeat every few
             * steps, and `seed % 8` never picked some of the clients. */
            return Math.floor(seed / 65536) % n;
        };
        const rows = [];
        for (let i = 0; i < count; i++) {
            const p     = next(PRODUCTS.length);
            const qty   = 1 + next(40);
            const price = new Decimal(PRICES[p]);
            const day   = 1 + next(28);
            const month = 1 + (i % 12);
            rows.push([
                `V-${String(1000 + i)}`,
                CLIENTS[next(CLIENTS.length)],
                `2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
                PRODUCTS[p],
                qty,
                price,
                price * new Decimal(String(qty)),
                REGIONS[next(REGIONS.length)],
            ]);
        }
        return rows;
    }
}
