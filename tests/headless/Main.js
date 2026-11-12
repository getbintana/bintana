/*
 * The Phase 1 probe: the same questions of the same classes, asked once by the
 * graphical runtime and once by `bintana-meta`.
 *
 * `tests/headless.sh` runs both and diffs the output, so a metadata answer that
 * drifts from the one a running control gives is red here. What it deliberately
 * does not ask is the JavaScript half of the class -- `Methods` and `Members`
 * include what `forms.js` mixes in, and the metadata host has no prelude yet.
 * `PropertyNames`, the events, the signatures and the descriptions are all C,
 * and they are the rows the IDE, the check and the completion read.
 */
"use strict";

function Main() {
    print(JSON.stringify(Widget.Types()));
    print(JSON.stringify(Widget.PropertyNames("Button")));
    print(JSON.stringify(Widget.Methods("Button").sort()));
    /*
     * Names, kinds, arity, signatures, return types and C-or-JavaScript: the
     * compact row is what fails legibly. The whole `Members` follows, `Doc`
     * included -- the prelude's descriptions come from the same compiler symbol
     * pass `bta_meta.c` uses for its own C rows, so a doc that drifts is red
     * here too.
     */
    print(JSON.stringify(Widget.Members("Button")
                               .map((m) => `${m.Name}|${m.Kind}|${m.Native}|` +
                                            `${m.Signature}|${m.Returns}|${m.Params}`)
                               .sort()));
    print(JSON.stringify(Widget.Members("Button")));
    print(JSON.stringify(Widget.EventNames("Button")));
    print(JSON.stringify(Widget.Member("Button", "Text")));
    print(JSON.stringify(Widget.Member("Button", "Click")));
    print(JSON.stringify(Widget.Signature("Button", "Emit")));
    print(JSON.stringify(Widget.EventSignature("Button", "Click")));
    print(JSON.stringify(Widget.TextProperties("Button")));
    print(JSON.stringify(Widget.PropertyOptions("Button", "HAlign")));
    print(JSON.stringify(Widget.DeferredProperties("RowList")));
    print(JSON.stringify(Widget.Available("Button")));
}
