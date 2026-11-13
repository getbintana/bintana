"use strict";

/*
 * The document half of `lib/report`: `ReportDocument` lays out pages and draws
 * them with `Drawing`, with no `Report` control and no display. The widget
 * class is not defined in this host, and the file still loads.
 */
function Main() {
    const dir = File.Join(Environment.TempDirectory,
                           `bta-report-${Environment.ProcessId}`);
    Directory.Make(dir);

    const d = new ReportDocument();
    d.Paper   = "A4";
    d.Margins = 40;
    d.Sections = {
        Detail: {
            Height: 100,
            Elements: [
                { Kind: "Text", Text: "Report", X: 0, Y: 0 },
                { Kind: "Field", Field: "T", X: 0, Y: 24 },
            ],
        },
    };
    d.Data = [{ T: "one" }, { T: "two" }, { T: "three" }];

    const pdf = File.Join(dir, "report.pdf");
    d.SavePdf(pdf);
    print(`pages ${d.PageCount}`);
    print(`pdf ${File.Info(pdf).Type}`);
    print(`written ${File.Info(pdf).Size > 1000}`);
    print(`singleton ${typeof Report}`);
    print(`chart ${typeof Chart}`);

    Directory.DeleteTree(dir);
}
