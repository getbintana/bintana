"use strict";

/* `charts` is not in this project's `uses`: `report` names it in its own.
 * The run loads it, so `ChartDocument` is declared -- and `bintana check` has
 * to agree, which it did not while it read only the first level. */
function Main() {
    const chart = new ChartDocument();
    chart.Type = "Bar";
    print(`${chart.Type} ${Application.Uses().map((d) => File.Name(d)).join(" ")}`);
}
