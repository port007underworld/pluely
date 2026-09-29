//! API keys and other secrets live in the OS credential store (macOS Keychain,
//! Windows Credential Manager) instead of the web view's plain local storage.

const SERVICE: &str = "com.srikanthnani.runningbord";

fn entry(key: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, key).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn secret_get(key: String) -> Result<Option<String>, String> {
    match entry(&key)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn secret_set(key: String, value: String) -> Result<(), String> {
    if value.is_empty() {
        return secret_delete(key).await;
    }
    entry(&key)?.set_password(&value).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn secret_delete(key: String) -> Result<(), String> {
    match entry(&key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Writes and removes a throwaway entry in the real OS credential store.
    /// cargo test --lib keychain_roundtrip -- --ignored
    #[test]
    #[ignore]
    fn keychain_roundtrip() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let key = "test:probe:API_KEY".to_string();
            secret_set(key.clone(), "sk-test-123".into()).await.unwrap();
            assert_eq!(secret_get(key.clone()).await.unwrap().as_deref(), Some("sk-test-123"));
            secret_set(key.clone(), "".into()).await.unwrap(); // empty = delete
            assert_eq!(secret_get(key.clone()).await.unwrap(), None);
            secret_delete(key).await.unwrap(); // deleting a missing entry is fine
        });
    }
}
