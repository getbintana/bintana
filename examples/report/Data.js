/*
 * The rows a report runs over, and nothing about how they are shown.
 *
 * A report's `Data` is an array of plain objects -- the same shape a chart's
 * `Series` is -- and this file is the whole of it. The report reads the keys a
 * band element names (`Category`, `Client`, `Placed`, `What`, `Amount`), and the
 * group bands group on `Category` and then `Client`. The amounts are `Decimal`,
 * exactly what a `Field.Decimal` would hand over, so the subtotals and the grand
 * total come out exact -- the one thing a statement of account cannot afford to
 * get wrong.
 *
 * **One description is deliberately long.** The detail band says
 * `Height: "Auto"`, so that row is three lines tall and the rest are one -- a
 * report over real data has one of these in it, and a declared height would
 * either have cut it off or made every other row as tall as this one.
 *
 * **The rows are written unsorted on purpose.** A report groups *consecutive*
 * equal values -- the Crystal Reports model, which never reorders your data --
 * so `ReportForm` sorts them with `Locale.Compare` before handing them over.
 * Sorting in the report would be a second opinion about what the user meant, and
 * a wrong one the first time the data was already in the order they wanted.
 */
"use strict";

const ORDERS = [
    { Category: "Wholesale",   Client: "Talleres Andrade", Placed: "2026-06-30", What: "Sheet metal, 40 units",        Amount: new Decimal("168000.00") },
    { Category: "Wholesale",   Client: "Talleres Andrade", Placed: "2026-08-19", What: "Welding, per hour",             Amount: new Decimal("9.00") },
    { Category: "Wholesale",   Client: "Talleres Andrade", Placed: "2026-09-01", What: "Delivery to the workshop",      Amount: new Decimal("12750.50") },

    { Category: "Government",  Client: "Municipalidad",    Placed: "2026-05-21", What: "Signage, plaza San Martín",     Amount: new Decimal("100.50") },
    { Category: "Government",  Client: "Municipalidad",    Placed: "2026-08-11", What: "Signage, second stage",         Amount: new Decimal("980000.00") },

    { Category: "Retail",      Client: "Ñanculeo, Ayelén", Placed: "2026-07-14", What: "Design of the catalogue: cover, twenty inside pages and the corrections agreed at the meeting on the 9th", Amount: new Decimal("75600.00") },
    { Category: "Retail",      Client: "Ñanculeo, Ayelén", Placed: "2026-08-02", What: "Photography, three sessions",   Amount: new Decimal("49500.00") },
    { Category: "Retail",      Client: "Ñanculeo, Ayelén", Placed: "2026-08-28", What: "Printing, 500 copies",          Amount: new Decimal("87400.00") },

    { Category: "Retail",      Client: "Vega e hijos",     Placed: "2026-08-30", What: "Two pallets, on account",       Amount: new Decimal("43125.75") },
    { Category: "Retail",      Client: "Vega e hijos",     Placed: "2026-09-02", What: "Restocking, monthly",           Amount: new Decimal("22100.00") },

    { Category: "Retail",      Client: "Zapatería Norte",  Placed: "2026-04-12", What: "Storefront signage",            Amount: new Decimal("54000.00") },
    { Category: "Retail",      Client: "Zapatería Norte",  Placed: "2026-06-03", What: "Window graphics",               Amount: new Decimal("18250.00") },
    { Category: "Retail",      Client: "Zapatería Norte",  Placed: "2026-07-19", What: "Catalogue, 200 copies",         Amount: new Decimal("61900.00") },
    { Category: "Retail",      Client: "Zapatería Norte",  Placed: "2026-08-27", What: "Banners for the fair",          Amount: new Decimal("33500.00") },
];
