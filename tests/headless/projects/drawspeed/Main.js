"use strict";

/* The linked baseline for the plugin spike: same calls, native `Painter`. */
function Main() {
    const dir = File.Join(Environment.TempDirectory,
                           `bta-drawspeed-${Environment.ProcessId}`);
    Directory.Make(dir);
    const pdf = File.Join(dir, "native.pdf");
    const n   = 20000;
    const watch = new Stopwatch().Start();

    Drawing.SavePdf(pdf, 200, 100, 1, (p, page, w, h) => {
        p.Color = "rgba(0.1,0.2,0.3,1)";
        p.LineWidth = 1;
        for (let i = 0; i < n; i++) {
            p.MoveTo(i % w, 0);
            p.LineTo(i % w, h);
        }
        p.Stroke();
        p.Text("spike", 10, 20);
    });

    print(`native-ms ${watch.Elapsed}`);
    print(`pdf ${File.Info(pdf).Type}`);
    print("native-ok");
    Directory.DeleteTree(dir);
}
