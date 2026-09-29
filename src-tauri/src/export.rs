use tauri_plugin_dialog::DialogExt;

/// Ask where to save an export and write it there. The path comes from the
/// save dialog, so the page can't choose where the file goes. Returns the
/// chosen path, or None if the user cancelled.
#[tauri::command]
pub async fn save_export(
    app: tauri::AppHandle,
    default_name: String,
    contents: String,
) -> Result<Option<String>, String> {
    let Some(path) = app
        .dialog()
        .file()
        .set_file_name(&default_name)
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let path = path.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, contents).map_err(|e| e.to_string())?;
    Ok(Some(path.display().to_string()))
}
