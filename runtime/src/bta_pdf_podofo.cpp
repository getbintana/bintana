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
#include <filesystem>
#include <memory>
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
 * A PDF signed: copied to `out` (unless it is the file read), loaded from a
 * device open for reading and writing, and signed with `SignDocument`, which
 * appends an incremental update -- so an earlier signature keeps the bytes it
 * signed. The signature itself is the program's `Signer`, through PoDoFo's
 * signing service: PoDoFo builds the CMS (PAdES-B, SHA-256) and hands over the
 * bare digest; the private key never has to be here.
 */
int bta_pdf_sign_native(const char *src, const char *src_password,
                        const char *out, const BtaPdfSignSpec *spec,
                        char **error)
{
    if (error)
        *error = nullptr;

    bool copied = false;

    try {
        namespace fs = std::filesystem;
        std::error_code same_err;
        const bool same = fs::equivalent(src, out, same_err);
        if (!same) {
            fs::copy_file(src, out, fs::copy_options::overwrite_existing);
            copied = true;
        }

        auto device = std::make_shared<FileStreamDevice>(out, FileMode::Open,
                                                         DeviceAccess::ReadWrite);
        PdfMemDocument doc;
        doc.Load(device, src_password ? src_password : "");

        /* **A signature already there is never written over**: PoDoFo would
         * replace the field's value, and the earlier signer would vanish from
         * the document. A field named is refused when signed; with none named,
         * the first free name of Signature, Signature2, ... is taken. */
        PdfSignature *sig = nullptr;
        std::string   want(spec->field ? spec->field : "Signature");
        auto signed_already = [](PdfField *f) {
            return f->GetDictionary().HasKey("V");
        };

        for (int n = 1;; n++) {
            PdfField *found = nullptr;
            for (auto field : doc.GetFieldsIterator())
                if (field->GetFullName() == want) {
                    found = field;
                    break;
                }
            if (!found)
                break;
            if (found->GetType() != PdfFieldType::Signature) {
                if (spec->field)
                    throw std::runtime_error("the field '" + want + "' is not a signature field");
            } else if (!signed_already(found)) {
                sig = static_cast<PdfSignature *>(found);
                break;
            } else if (spec->field) {
                throw std::runtime_error("the field '" + want + "' is signed already; "
                                         "a second signature goes in a field of its own");
            }
            want = "Signature" + std::to_string(n + 1);
        }
        if (!sig) {
            const unsigned pages = doc.GetPages().GetCount();
            if (spec->page < 1 || (unsigned)spec->page > pages)
                throw std::runtime_error("there is no page " + std::to_string(spec->page));
            PdfPage &page = doc.GetPages().GetPageAt((unsigned)spec->page - 1);
            sig = &page.CreateField<PdfSignature>(want,
                    Rect(spec->x, spec->y, spec->width, spec->height));
        }

        if (spec->reason && *spec->reason)
            sig->SetSignatureReason(PdfString(spec->reason));
        if (spec->location && *spec->location)
            sig->SetSignatureLocation(PdfString(spec->location));
        if (spec->name && *spec->name)
            sig->SetSignerName(PdfString(spec->name));
        sig->SetSignatureDate(PdfDate::LocalNow());

        std::string failed;
        PdfSignerCmsParams params;
        params.SigningService = [&](bufferview hash, bool dryrun, charbuff &signed_hash) {
            (void)dryrun;
            unsigned char *bytes = nullptr;
            size_t         len   = 0;
            char          *why   = nullptr;

            if (!spec->sign(spec->data, (const unsigned char *)hash.data(), hash.size(),
                            &bytes, &len, &why)) {
                failed = why ? why : "the Signer gave no signature";
                g_free(why);
                throw std::runtime_error(failed);
            }
            signed_hash.assign((const char *)bytes, len);
            g_free(bytes);
        };

        PdfSignerCms signer(bufferview((const char *)spec->cert, spec->cert_len), params);
        SignDocument(doc, *device, signer, *sig);
        return 1;
    } catch (const std::exception &e) {
        if (copied)
            g_remove(out);
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
