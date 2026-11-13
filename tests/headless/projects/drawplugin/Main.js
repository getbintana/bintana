"use strict";

/*
 * The plugin's painter takes methods (`p.Color(...)`), which is the spike's
 * compromise: the native one takes a `Color` property. The loop is the same
 * one `drawspeed` runs through the linked implementation, so the two times
 * are comparable.
 */
function Main() {
    const dir = File.Join(Environment.TempDirectory,
                           `bta-drawplugin-${Environment.ProcessId}`);
    Directory.Make(dir);
    const pdf = File.Join(dir, "plugin.pdf");
    const n   = 20000;
    const watch = new Stopwatch().Start();

    Drawing.SavePdf(pdf, 200, 100, 1, (p, page, w, h) => {
        p.Color(0.1, 0.2, 0.3, 1);
        p.LineWidth(1);
        for (let i = 0; i < n; i++) {
            p.MoveTo(i % w, 0);
            p.LineTo(i % w, h);
        }
        p.Stroke();
        p.Text("spike", 10, 20);
    });

    print(`plugin-ms ${watch.Elapsed}`);
    print(`pdf ${File.Info(pdf).Type}`);
    print("plugin-ok");
    Directory.DeleteTree(dir);
}
