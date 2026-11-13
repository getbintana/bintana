export function Main() {
    if (!Privilege.Elevated)
        throw new Error("the write-note helper must be elevated");

    const dir = Environment.OS === "Windows"
        ? File.Join(Environment.Get("ProgramData") || "C:\\ProgramData",
                    "Bintana", "sysnote")
        : "/var/lib/bintana/sysnote";

    Directory.Make(dir);
    const note = Application.Arguments.join(" ");
    const path = File.Join(dir, "note.txt");

    File.Save(path, `${Privilege.Invoker.Name}: ${note}\n`);
    print(JSON.stringify({ Path: path, User: Privilege.Invoker.Name, Note: note }));
}
