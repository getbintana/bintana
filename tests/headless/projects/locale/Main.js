"use strict";

/* Run under LANG=es_AR.UTF-8 by tests/headless.sh, in both hosts, which must
 * print the same. The core used to run every `main` in the C locale: 1234.50,
 * an English month, and names sorted by byte. */
function Main() {
    print(`Number: ${Locale.Number(1234.5, 2)}`);
    print(`Month: ${Locale.Date(new Date(2026, 7, 31), "Month")}`);
    print(`Sorted: ${["Main.js", "lib", "alpha", "Zeta"].sort(Locale.Compare).join(" ")}`);
}
