//! Text decoding.
//!
//! The format predates Unicode: strings are stored as raw bytes in a single-byte
//! code page that the files never name. Western databases use Windows-1252
//! (a superset of the ISO 8859-1 the specification mentions), Russian ones
//! Windows-1251, and databases converted by newer tools hold UTF-8. We pick a
//! database-wide fallback code page once from the player names and decode
//! every string as UTF-8 first when it is valid UTF-8, falling back to that code
//! page otherwise.

/// A single-byte code page.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Codepage {
    Windows1252,
    Windows1251,
}

impl Codepage {
    fn label(self) -> &'static str {
        match self {
            Codepage::Windows1252 => "windows-1252",
            Codepage::Windows1251 => "windows-1251",
        }
    }

    fn encoding(self) -> &'static encoding_rs::Encoding {
        match self {
            Codepage::Windows1252 => encoding_rs::WINDOWS_1252,
            Codepage::Windows1251 => encoding_rs::WINDOWS_1251,
        }
    }
}

/// Decodes strings using a database-wide fallback code page.
#[derive(Debug, Clone)]
pub struct TextDecoder {
    fallback: Codepage,
    label: String,
}

impl Default for TextDecoder {
    fn default() -> Self {
        TextDecoder {
            fallback: Codepage::Windows1252,
            label: "ascii".to_string(),
        }
    }
}

impl TextDecoder {
    /// Fixed decoder, mostly for tests.
    pub fn with_codepage(cp: Codepage) -> Self {
        TextDecoder {
            fallback: cp,
            label: cp.label().to_string(),
        }
    }

    /// Chooses the fallback code page from a sample of the database's strings
    /// (already stripped of their field padding).
    ///
    /// - no non-ASCII byte anywhere: `ascii`, with Windows-1252 as fallback;
    /// - every non-ASCII string is valid UTF-8: `utf-8`;
    /// - otherwise Windows-1251 when the non-UTF-8 strings are mostly made of
    ///   high bytes (Cyrillic words are written entirely above 0x7f, while an
    ///   accented Latin name has one or two such bytes among ASCII letters),
    ///   else Windows-1252.
    pub fn detect<'a>(samples: impl IntoIterator<Item = &'a [u8]>) -> Self {
        let mut non_ascii_strings = 0usize;
        let mut utf8_strings = 0usize;
        let mut high_bytes = 0usize;
        let mut ascii_letters = 0usize;
        for s in samples {
            if s.is_ascii() {
                continue;
            }
            non_ascii_strings += 1;
            if std::str::from_utf8(s).is_ok() {
                utf8_strings += 1;
                continue;
            }
            for &b in s {
                if b >= 0x80 {
                    high_bytes += 1;
                } else if b.is_ascii_alphabetic() {
                    ascii_letters += 1;
                }
            }
        }
        if non_ascii_strings == 0 {
            return TextDecoder::default();
        }
        if utf8_strings == non_ascii_strings {
            return TextDecoder {
                fallback: Codepage::Windows1252,
                label: "utf-8".to_string(),
            };
        }
        let cp = if high_bytes * 2 > high_bytes + ascii_letters {
            Codepage::Windows1251
        } else {
            Codepage::Windows1252
        };
        let label = if utf8_strings > 0 {
            format!("{} (with some utf-8)", cp.label())
        } else {
            cp.label().to_string()
        };
        TextDecoder {
            fallback: cp,
            label,
        }
    }

    /// Human-readable name of the detected encoding, for the import report.
    pub fn label(&self) -> &str {
        &self.label
    }

    /// Decodes raw string bytes: UTF-8 when valid, else the fallback code page.
    pub fn decode(&self, bytes: &[u8]) -> String {
        match std::str::from_utf8(bytes) {
            Ok(s) => s.to_string(),
            Err(_) => self
                .fallback
                .encoding()
                .decode_without_bom_handling(bytes)
                .0
                .into_owned(),
        }
    }

    /// Decodes a zero-terminated fixed-size field and trims surrounding
    /// whitespace.
    pub fn decode_field(&self, field: &[u8]) -> String {
        self.decode(crate::bytes::c_field(field)).trim().to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ascii_only_database_reports_ascii() {
        let d = TextDecoder::detect([&b"Carlsen"[..], b"Nakamura"]);
        assert_eq!(d.label(), "ascii");
        assert_eq!(d.decode(b"Carlsen"), "Carlsen");
    }

    #[test]
    fn latin_accents_fall_back_to_windows_1252() {
        let d = TextDecoder::detect([&b"Fr\xe9d\xe9ric"[..], b"M\xfcller", b"Smith"]);
        assert_eq!(d.label(), "windows-1252");
        assert_eq!(d.decode(b"Fr\xe9d\xe9ric"), "Frédéric");
        assert_eq!(d.decode(b"\x80"), "€"); // Windows-1252, not ISO 8859-1
    }

    #[test]
    fn cyrillic_names_select_windows_1251() {
        // "Карпов" and "Каспаров" in Windows-1251.
        let karpov = b"\xca\xe0\xf0\xef\xee\xe2";
        let kasparov = b"\xca\xe0\xf1\xef\xe0\xf0\xee\xe2";
        let d = TextDecoder::detect([&karpov[..], kasparov, b"Smith"]);
        assert_eq!(d.label(), "windows-1251");
        assert_eq!(d.decode(karpov), "Карпов");
    }

    #[test]
    fn valid_utf8_is_kept_even_with_a_single_byte_fallback() {
        let d = TextDecoder::detect([&b"M\xfcller"[..], "丁立人".as_bytes()]);
        assert_eq!(d.label(), "windows-1252 (with some utf-8)");
        assert_eq!(d.decode("丁立人".as_bytes()), "丁立人");
        assert_eq!(d.decode(b"M\xfcller"), "Müller");
    }

    #[test]
    fn all_utf8_database_reports_utf8() {
        let d = TextDecoder::detect(["丁立人".as_bytes(), "Müller".as_bytes()]);
        assert_eq!(d.label(), "utf-8");
    }

    #[test]
    fn fields_stop_at_the_terminator_and_trim() {
        let d = TextDecoder::default();
        assert_eq!(d.decode_field(b" Smith \0garbage"), "Smith");
    }
}
