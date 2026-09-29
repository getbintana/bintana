/*
 * tools/llms: writes `llms-full.txt`, the runtime's own documentation in one
 * file for an agent that would rather read once than fetch seven times.
 *
 *   tools/llms.sh            write it
 *   tools/llms.sh --check    say whether it is what this would write
 *
 * It is a concatenation and nothing else: every part is already written, and a
 * copy that is edited is a second description. `llm.txt` is the index a person
 * or a model starts from; this is the whole of what it points at.
 */
const LLMS_PARTS = [
    "AGENTS.md",
    "docs/architecture.md",
    "docs/extending.md",
    "docs/plugins.md",
    "docs/installing.md",
    "docs/testing.md",
    "docs/ide-internals.md",
    "docs/llm/issues.md",
];

function llmsText(root) {
    const out = [
        "# Bintana, in full",
        "",
        "The runtime's own documentation, concatenated by `tools/llms.sh` from",
        "the files `llm.txt` points at. The public surface as data is",
        "`api.json`, which is generated and is not repeated here.",
        "",
    ];

    for (const part of LLMS_PARTS) {
        out.push("", "---", "", `# ${part}`, "", File.Load(File.Join(root, part)));
    }
    return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

function Main() {
    const args  = Application.Arguments;
    const check = args.includes("--check");
    const root  = args.find((a) => !a.startsWith("--")) ||
                  File.Directory(File.Directory(Application.Directory));
    const path  = File.Join(root, "llms-full.txt");
    const want  = llmsText(root);

    if (check) {
        const got = File.Exists(path) ? File.Load(path) : "";
        if (got !== want) {
            print("llms-full.txt: not what the sources say -- run tools/llms.sh");
            Application.Quit(1);
            return;
        }
        print("llms: llms-full.txt is what the sources say");
        Application.Quit(0);
        return;
    }

    File.Save(path, want);
    print("llms-full.txt: written");
    Application.Quit(0);
}
