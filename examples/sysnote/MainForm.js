export class MainForm extends Form {
    BtnWrite_Click() {
        if (!Privilege.CanElevate) {
            this.LblStatus.Text = "This system has no way to ask.";
            return;
        }

        const note = this.TxtNote.Text.trim();
        if (!note) {
            this.LblStatus.Text = "Write something first.";
            return;
        }

        this.BtnWrite.Enabled = false;
        this.LblStatus.Text = "Waiting for permission...";
        this.job = Privilege.Run("tools/write-note", [note], {},
            (line) => this.Log.Append(`${line}\n`),
            (code) => {
                this.job = null;
                this.BtnWrite.Enabled = true;
                this.LblStatus.Text = code === 0
                    ? "Written."
                    : `Failed (${code}).`;
            });
    }

    Form_Close() {
        if (this.job) this.job.Stop();
    }
}
