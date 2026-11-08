/*
 * The PoDoFo bridge, `PdfDocument`'s writing half: a static PDF made by Cairo
 * gets its AcroForm here, and is encrypted here.
 *
 * PoDoFo parses the object streams Cairo writes and saves the whole document
 * again with the widgets added. It does not render anything, which is why the
 * visual form stays Cairo's and this file only knows rectangles and names.
 */
#include "bta_pdf.h"

#include <podofo/podofo.h>

#include <cerrno>
#include <cstring>
#include <stdexcept>
#include <string>

#include <glib.h>
#include <glib/gstdio.h>

using namespace PoDoFo;

static void set_error(char **error, const std::string &message)
{
    if (error)
        *error = g_strdup(message.c_str());
}

static void apply_common(PdfField &field, const BtaPdfField &spec)
{
    field.SetReadOnly(spec.read_only != 0);
    field.SetRequired(spec.required != 0);
}

int bta_pdf_add_fields_native(const char *path, const char *password,
                              const BtaPdfField *fields, int count, char **error)
{
    if (error)
        *error = nullptr;

    std::string tmp;

    try {
        PdfMemDocument doc;
        doc.Load(path, password ? password : "");

        const unsigned pages = doc.GetPages().GetCount();
        if (pages == 0)
            throw std::runtime_error("the PDF has no pages");

        PdfAcroForm &form = doc.GetOrCreateAcroForm();
        form.SetNeedAppearances(true);

        for (int i = 0; i < count; i++) {
            const BtaPdfField &spec = fields[i];

            if (spec.page < 1 || (unsigned)spec.page > pages)
                throw std::runtime_error("there is no page " +
                                         std::to_string(spec.page));
            if (spec.width <= 0 || spec.height <= 0)
                throw std::runtime_error("field '" + std::string(spec.name) +
                                         "' has no rectangle");

            PdfPage &page = doc.GetPages().GetPageAt((unsigned)spec.page - 1);
            Rect rect(spec.x, spec.y, spec.width, spec.height);
            const std::string type(spec.type ? spec.type : "");

            if (type == "Text") {
                PdfTextBox &field = page.CreateField<PdfTextBox>(spec.name, rect);
                field.SetText(PdfString(spec.value ? spec.value : ""));
                field.SetMultiLine(spec.multiline != 0);
                if (spec.max_length > 0)
                    field.SetMaxLen(spec.max_length);
                apply_common(field, spec);
            } else if (type == "Check") {
                PdfCheckBox &field = page.CreateField<PdfCheckBox>(spec.name, rect);
                field.SetChecked(spec.checked != 0);
                apply_common(field, spec);
            } else if (type == "Signature") {
                PdfSignature &field = page.CreateField<PdfSignature>(spec.name, rect);
                if (spec.reason && *spec.reason)
                    field.SetSignatureReason(PdfString(spec.reason));
                field.SetRequired(spec.required != 0);
            } else {
                throw std::runtime_error("field '" + std::string(spec.name) +
                                         "' has an unknown type '" + type + "'");
            }
        }

        tmp = std::string(path) + ".bta-form";
        g_remove(tmp.c_str());
        doc.Save(tmp);

        if (g_rename(tmp.c_str(), path) != 0) {
            const std::string why = g_strerror(errno);
            g_remove(tmp.c_str());
            throw std::runtime_error("could not replace the PDF: " + why);
        }

        return count;
    } catch (const std::exception &e) {
        if (!tmp.empty())
            g_remove(tmp.c_str());
        set_error(error, e.what());
        return 0;
    }
}

/*
 * A PDF written again, encrypted: AES-256, revision 6 (PDF 2.0) and nothing
 * weaker, since a choice of RC4 is a choice of no protection. Saved beside
 * `out` and renamed over it, so a failure leaves whatever was there, and `out`
 * may be the very file read.
 */
int bta_pdf_encrypt_native(const char *src, const char *src_password,
                           const char *out, const char *user_password,
                           const char *owner_password, unsigned permissions,
                           char **error)
{
    if (error)
        *error = nullptr;

    std::string tmp;

    try {
        PdfMemDocument doc;
        doc.Load(src, src_password ? src_password : "");
        doc.SetEncrypted(user_password ? user_password : "",
                         owner_password ? owner_password : "",
                         static_cast<PdfPermissions>(permissions),
                         PdfEncryptionAlgorithm::AESV3R6, PdfKeyLength::L256);

        tmp = std::string(out) + ".bta-encrypt";
        g_remove(tmp.c_str());
        doc.Save(tmp);

        if (g_rename(tmp.c_str(), out) != 0) {
            const std::string why = g_strerror(errno);
            g_remove(tmp.c_str());
            throw std::runtime_error("could not write the PDF: " + why);
        }
        return 1;
    } catch (const std::exception &e) {
        if (!tmp.empty())
            g_remove(tmp.c_str());
        set_error(error, e.what());
        return 0;
    }
}
