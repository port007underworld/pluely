//! Text extraction for documents the user adds as personal context (resume,
//! job description, notes). Runs locally; only the extracted text is kept.

use base64::Engine;

const MAX_FILE_BYTES: usize = 15 * 1024 * 1024;

fn extract(file_name: &str, bytes: &[u8]) -> Result<String, String> {
    let lower = file_name.to_lowercase();
    if lower.ends_with(".pdf") {
        // pdf-extract can panic on unusual PDFs; report that as an error instead.
        let result = std::panic::catch_unwind(|| pdf_extract::extract_text_from_mem(bytes));
        match result {
            Ok(Ok(text)) => Ok(text),
            Ok(Err(e)) => Err(format!("Couldn't read this PDF: {}", e)),
            Err(_) => Err("Couldn't read this PDF (unsupported format).".to_string()),
        }
    } else if lower.ends_with(".txt") || lower.ends_with(".md") || lower.ends_with(".markdown") {
        Ok(String::from_utf8_lossy(bytes).into_owned())
    } else {
        Err("Unsupported file type. Use PDF, TXT or Markdown.".to_string())
    }
}

/// Collapse PDF layout noise: trailing spaces, runs of blank lines.
fn tidy(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut blank_run = 0;
    for line in text.lines() {
        let line = line.trim_end();
        if line.trim().is_empty() {
            blank_run += 1;
            if blank_run > 1 {
                continue;
            }
        } else {
            blank_run = 0;
        }
        out.push_str(line);
        out.push('\n');
    }
    out.trim().to_string()
}

#[tauri::command]
pub async fn extract_document_text(file_name: String, base64_data: String) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_data)
        .map_err(|e| format!("Invalid file data: {}", e))?;
    if bytes.len() > MAX_FILE_BYTES {
        return Err("File is too large (over 15 MB).".to_string());
    }
    let text = tauri::async_runtime::spawn_blocking(move || extract(&file_name, &bytes))
        .await
        .map_err(|e| e.to_string())??;
    let text = tidy(&text);
    if text.is_empty() {
        return Err(
            "No text found. Scanned PDFs (images of text) aren't supported; paste the text instead."
                .to_string(),
        );
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_files_and_tidying() {
        let text = extract("notes.md", b"# Me\n\n\n\nRust   \nTauri\n").unwrap();
        assert_eq!(tidy(&text), "# Me\n\nRust\nTauri");
        assert!(extract("photo.png", b"x").is_err());
    }

    #[test]
    fn garbage_pdf_is_an_error_not_a_crash() {
        assert!(extract("resume.pdf", b"not really a pdf").is_err());
    }

    /// PDF_TEST_FILE=/path/resume.pdf cargo test real_pdf -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_pdf() {
        let path = std::env::var("PDF_TEST_FILE").unwrap();
        let text = tidy(&extract(&path, &std::fs::read(&path).unwrap()).unwrap());
        println!("{text}");
        assert!(!text.is_empty());
    }
}
