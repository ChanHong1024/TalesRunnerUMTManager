#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use csv::StringRecord;
use futures_util::StreamExt;
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;
use url::Url;

const DEFAULT_SHEET_URL: &str = "https://docs.google.com/spreadsheets/d/1z_-X1XgfZ8sgXkeSk_d_vjMNXVV_YAeNvnAk1naRmeA/export?format=csv&gid=2076954312";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    language: String,
    install_dir: String,
    sheet_csv_url: String,
    #[serde(default = "default_visible_columns")]
    visible_columns: Vec<String>,
}

fn default_visible_columns() -> Vec<String> {
    vec!["顯示名稱".to_string(), "地圖ID".to_string()]
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MapRecord {
    id: String,
    row_index: usize,
    name: String,
    download_url: String,
    raw_columns: Vec<(String, String)>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstalledMap {
    id: String,
    name: String,
    source_url: String,
    installed_at: String,
    install_root: String,
    files: Vec<String>,
    #[serde(default)]
    deactivated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct Manifest {
    maps: Vec<InstalledMap>,
}

#[tauri::command]
fn get_settings(app: AppHandle) -> Result<Settings, String> {
    read_settings(&app)
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: Settings) -> Result<Settings, String> {
    let dir = app_data_dir(&app)?;
    fs::create_dir_all(&dir).map_err(to_string)?;
    write_json(&dir.join("settings.json"), &settings)?;
    Ok(settings)
}

#[tauri::command]
async fn load_catalog(app: AppHandle) -> Result<Vec<MapRecord>, String> {
    let settings = read_settings(&app)?;
    let text = reqwest::get(&settings.sheet_csv_url)
        .await
        .map_err(to_string)?
        .text()
        .await
        .map_err(to_string)?;
    parse_catalog(&text)
}

#[tauri::command]
fn scan_installed_maps(app: AppHandle) -> Result<Vec<InstalledMap>, String> {
    let settings = read_settings(&app)?;
    let mut manifest = read_manifest(&app)?;
    let install_dir = resolve_install_dir(&settings)?;

    if !install_dir.exists() {
        return Ok(manifest.maps);
    }

    let managed_files: Vec<String> = manifest
        .maps
        .iter()
        .flat_map(|map| map.files.iter().cloned())
        .collect();

    let deactivated_dir = install_dir.join("_deactivated");

    for entry in fs::read_dir(&install_dir).map_err(to_string)? {
        let entry = entry.map_err(to_string)?;
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()).map(|ext| ext.eq_ignore_ascii_case("upk")) != Some(true) {
            continue;
        }

        let file_name = path.file_name().and_then(|name| name.to_str()).unwrap_or_default().to_string();
        if managed_files.iter().any(|managed| managed.eq_ignore_ascii_case(&file_name)) {
            continue;
        }

        let id = hash_id(&format!("detected:{file_name}"));
        if manifest.maps.iter().any(|map| map.id == id) {
            continue;
        }

        manifest.maps.push(InstalledMap {
            id,
            name: path.file_stem().and_then(|name| name.to_str()).unwrap_or(&file_name).to_string(),
            source_url: String::new(),
            installed_at: String::new(),
            install_root: install_dir.to_string_lossy().to_string(),
            files: vec![file_name],
            deactivated: false,
        });
    }

    // Also scan deactivated folder
    if deactivated_dir.exists() {
        for entry in fs::read_dir(&deactivated_dir).map_err(to_string)? {
            let entry = entry.map_err(to_string)?;
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()).map(|ext| ext.eq_ignore_ascii_case("upk")) != Some(true) {
                continue;
            }
            let file_name = path.file_name().and_then(|name| name.to_str()).unwrap_or_default().to_string();
            if managed_files.iter().any(|managed| managed.eq_ignore_ascii_case(&file_name)) {
                continue;
            }
            let id = hash_id(&format!("detected:{file_name}"));
            if manifest.maps.iter().any(|map| map.id == id) {
                continue;
            }
            manifest.maps.push(InstalledMap {
                id,
                name: path.file_stem().and_then(|name| name.to_str()).unwrap_or(&file_name).to_string(),
                source_url: String::new(),
                installed_at: String::new(),
                install_root: install_dir.to_string_lossy().to_string(),
                files: vec![file_name],
                deactivated: true,
            });
        }
    }

    Ok(manifest.maps)
}

#[tauri::command]
async fn install_map(app: AppHandle, map: MapRecord) -> Result<InstalledMap, String> {
    emit_log(&app, "info", &format!("=== Installing: {} ===", map.name));
    emit_log(&app, "info", &format!("Download URL: {}", map.download_url));

    let settings = read_settings(&app)?;
    let install_dir = resolve_install_dir(&settings)?;
    emit_log(&app, "info", &format!("Install dir: {}", install_dir.display()));

    fs::create_dir_all(&install_dir).map_err(|e| {
        emit_log(&app, "error", &format!("Failed to create dir: {e}"));
        e.to_string()
    })?;

    emit_log(&app, "info", "Starting download...");
    let (downloaded_path, suggested_name) = download_upk(&app, &map.download_url, &map.name).await?;
    emit_log(&app, "info", &format!("Downloaded to: {}", downloaded_path.display()));

    let file_name = sanitize_upk_name(&suggested_name)?;
    emit_log(&app, "info", &format!("Target filename: {file_name}"));

    let destination = safe_join(&install_dir, &file_name)?;
    emit_log(&app, "info", &format!("Destination: {}", destination.display()));

    if destination.exists() {
        let msg = format!("File already exists: {file_name}");
        emit_log(&app, "error", &msg);
        return Err(msg);
    }

    emit_log(&app, "info", "Copying to install dir...");
    fs::copy(&downloaded_path, &destination).map_err(|e| {
        emit_log(&app, "error", &format!("Copy failed: {e}"));
        e.to_string()
    })?;
    emit_log(&app, "info", "Copy complete!");

    let installed = InstalledMap {
        id: map.id,
        name: map.name,
        source_url: map.download_url,
        installed_at: iso_now(),
        install_root: install_dir.to_string_lossy().to_string(),
        files: vec![file_name],
        deactivated: false,
    };

    emit_log(&app, "info", "Updating manifest...");
    let mut manifest = read_manifest(&app)?;
    manifest.maps.retain(|item| item.id != installed.id);
    manifest.maps.push(installed.clone());
    write_manifest(&app, &manifest)?;
    emit_log(&app, "info", "=== Installation complete! ===");

    Ok(installed)
}

#[tauri::command]
fn deactivate_map(app: AppHandle, map_id: String, file_name: Option<String>) -> Result<(), String> {
    let settings = read_settings(&app)?;
    let install_dir = resolve_install_dir(&settings)?;
    let deactivated_dir = install_dir.join("_deactivated");
    let mut manifest = read_manifest(&app)?;

    fs::create_dir_all(&deactivated_dir).map_err(to_string)?;

    // Find in manifest or create entry for detected map
    let existing = manifest.maps.iter().find(|item| item.id == map_id).cloned();

    if let Some(ref target) = existing {
        if target.deactivated {
            return Err("Map is already deactivated.".to_string());
        }
        for relative in &target.files {
            let src = safe_join(&install_dir, relative)?;
            if src.exists() {
                let dst = safe_join(&deactivated_dir, relative)?;
                let _ = fs::rename(&src, &dst).map_err(|e| {
                    if fs::copy(&src, &dst).is_ok() {
                        let _ = fs::remove_file(&src);
                        return String::new();
                    }
                    e.to_string()
                });
                if !dst.exists() {
                    return Err(format!("Failed to move file: {}", src.display()));
                }
            }
        }
        // Update manifest
        if let Some(m) = manifest.maps.iter_mut().find(|item| item.id == map_id) {
            m.deactivated = true;
        }
    } else {
        // Detected map not in manifest — find .upk file
        let detected_name = if let Some(ref name) = file_name {
            Some(name.clone())
        } else {
            find_upk_in_dir(&install_dir, &map_id)
        };

        let Some(detected_name) = detected_name else {
            return Err("Cannot find the map file.".to_string());
        };

        let src = safe_join(&install_dir, &detected_name)?;
        let dst = safe_join(&deactivated_dir, &detected_name)?;
        let _ = fs::rename(&src, &dst).map_err(|e| {
            if fs::copy(&src, &dst).is_ok() {
                let _ = fs::remove_file(&src);
                return String::new();
            }
            e.to_string()
        });
        if !dst.exists() {
            return Err(format!("Failed to move file: {}", src.display()));
        }

        // Add to manifest
        manifest.maps.push(InstalledMap {
            id: map_id,
            name: detected_name.replace(".upk", ""),
            source_url: String::new(),
            installed_at: String::new(),
            install_root: install_dir.to_string_lossy().to_string(),
            files: vec![detected_name],
            deactivated: true,
        });
    }

    write_manifest(&app, &manifest)?;
    Ok(())
}

#[tauri::command]
fn activate_map(app: AppHandle, map_id: String) -> Result<(), String> {
    let settings = read_settings(&app)?;
    let install_dir = resolve_install_dir(&settings)?;
    let deactivated_dir = install_dir.join("_deactivated");
    let mut manifest = read_manifest(&app)?;

    let Some(target) = manifest.maps.iter_mut().find(|item| item.id == map_id) else {
        return Err("Map is not managed by this app.".to_string());
    };
    if !target.deactivated {
        return Err("Map is not deactivated.".to_string());
    }

    for relative in &target.files {
        let src = safe_join(&deactivated_dir, relative)?;
        if src.exists() {
            let dst = safe_join(&install_dir, relative)?;
            let _ = fs::rename(&src, &dst).map_err(|e| {
                if fs::copy(&src, &dst).is_ok() {
                    let _ = fs::remove_file(&src);
                    return String::new();
                }
                e.to_string()
            });
            if !dst.exists() {
                return Err(format!("Failed to move file back: {}", src.display()));
            }
        }
    }
    target.deactivated = false;

    // Clean up deactivated dir if empty
    if deactivated_dir.exists() {
        let _ = fs::remove_dir(&deactivated_dir);
    }

    write_manifest(&app, &manifest)?;
    Ok(())
}

#[tauri::command]
fn uninstall_map(app: AppHandle, map_id: String, file_name: Option<String>) -> Result<(), String> {
    let settings = read_settings(&app)?;
    let install_dir = resolve_install_dir(&settings)?;
    let deactivated_dir = install_dir.join("_deactivated");
    let mut manifest = read_manifest(&app)?;

    let target = manifest.maps.iter().find(|item| item.id == map_id).cloned();

    if let Some(ref target) = target {
        for relative in &target.files {
            let path = safe_join(&install_dir, relative)?;
            if path.exists() {
                fs::remove_file(path).map_err(to_string)?;
            }
            let deactivated_path = safe_join(&deactivated_dir, relative)?;
            if deactivated_path.exists() {
                fs::remove_file(deactivated_path).map_err(to_string)?;
            }
        }
    } else {
        // Detected map — find and delete the file directly
        let detected_name = if let Some(ref name) = file_name {
            Some(name.clone())
        } else {
            find_upk_in_dir(&install_dir, &map_id)
                .or_else(|| find_upk_in_dir(&deactivated_dir, &map_id))
        };

        if let Some(name) = detected_name {
            let path = safe_join(&install_dir, &name)?;
            if path.exists() {
                fs::remove_file(path).map_err(to_string)?;
            } else {
                let deactivated_path = safe_join(&deactivated_dir, &name)?;
                if deactivated_path.exists() {
                    fs::remove_file(deactivated_path).map_err(to_string)?;
                }
            }
        } else {
            return Err("Cannot find the map file.".to_string());
        }
    }

    manifest.maps.retain(|item| item.id != map_id);
    write_manifest(&app, &manifest)?;
    Ok(())
}

fn find_upk_in_dir(dir: &Path, map_id: &str) -> Option<String> {
    if !dir.exists() {
        return None;
    }
    for entry in fs::read_dir(dir).ok()? {
        let entry = entry.ok()?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("upk")) != Some(true) {
            continue;
        }
        let fname = path.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string();
        if hash_id(&format!("detected:{fname}")) == map_id {
            return Some(fname);
        }
    }
    None
}

fn parse_catalog(csv_text: &str) -> Result<Vec<MapRecord>, String> {
    let mut reader = csv::Reader::from_reader(csv_text.as_bytes());
    let headers = reader.headers().map_err(to_string)?.clone();
    let dl_col = find_column(&headers, &["下載連結", "download url", "download link", "download"]);
    let mut maps = Vec::new();

    for (index, row) in reader.records().enumerate() {
        let row = row.map_err(to_string)?;
        let download_url = row.get(dl_col).unwrap_or_default().trim().to_string();
        if download_url.is_empty() {
            continue;
        }

        let raw_columns = raw_columns(&headers, &row);
        let name = infer_name(&headers, &row, &download_url, index + 2);
        let id = hash_id(&format!("{}:{}:{}", index + 2, download_url, name));

        maps.push(MapRecord {
            id,
            row_index: index + 2,
            name,
            download_url,
            raw_columns,
        });
    }

    Ok(maps)
}

fn raw_columns(headers: &StringRecord, row: &StringRecord) -> Vec<(String, String)> {
    row.iter()
        .enumerate()
        .map(|(index, value)| {
            let key = headers
                .get(index)
                .filter(|header| !header.trim().is_empty())
                .map(|header| clean_header(header))
                .unwrap_or_else(|| format!("Column {}", column_name(index)));
            (key, value.to_string())
        })
        .collect()
}

fn infer_name(headers: &StringRecord, row: &StringRecord, download_url: &str, row_index: usize) -> String {
    for (index, header) in headers.iter().enumerate() {
        let normalized = header.trim().to_lowercase();
        if matches!(normalized.as_str(), "name" | "map name" | "map" | "地圖名稱" | "地圖")
            || normalized.starts_with("顯示名稱") {
            if let Some(value) = row.get(index) {
                let v = value.trim();
                if !v.is_empty() {
                    return sanitize_display_name(v);
                }
            }
        }
    }

    if let Some(first) = row.get(0) {
        if !first.trim().is_empty() {
            return sanitize_display_name(first.trim());
        }
    }

    file_name_from_url(download_url).unwrap_or_else(|| format!("Map row {row_index}"))
}

fn sanitize_display_name(value: &str) -> String {
    // Remove "(原名:...)" or "( 原名:... )" suffix
    let cleaned = if let Some(pos) = value.find("(原名") {
        &value[..pos]
    } else if let Some(pos) = value.find("( 原名") {
        &value[..pos]
    } else {
        value
    };
    cleaned
        .chars()
        .map(|ch| match ch {
            '\n' | '\r' => ' ',
            _ => ch,
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

async fn download_upk(app: &AppHandle, original_url: &str, fallback_name: &str) -> Result<(PathBuf, String), String> {
    let file_id = google_drive_file_id(original_url)
        .ok_or_else(|| {
            let msg = format!("Invalid Google Drive URL: {original_url}");
            emit_log(app, "error", &msg);
            msg
        })?;
    let download_url = format!("https://drive.google.com/uc?export=download&id={file_id}");
    emit_log(app, "info", &format!("File ID: {file_id}"));
    emit_log(app, "info", &format!("Resolved URL: {download_url}"));

    let client = reqwest::Client::builder()
        .cookie_store(true)
        .build()
        .map_err(to_string)?;
    let response = client.get(&download_url).send().await.map_err(|e| {
        emit_log(app, "error", &format!("HTTP request failed: {e}"));
        e.to_string()
    })?;

    let status = response.status();
    emit_log(app, "info", &format!("HTTP status: {status}"));

    let suggested_name = content_disposition_name(&response)
        .unwrap_or_else(|| format!("{fallback_name}.upk"));
    let total_size = response.content_length().unwrap_or(0);
    emit_log(app, "info", &format!("Content-Disposition name: {suggested_name}"));
    emit_log(app, "info", &format!("Total size: {total_size} bytes"));

    let file_name = sanitize_upk_name(&suggested_name)?;
    let downloads = app_data_dir(app)?.join("downloads");
    tokio::fs::create_dir_all(&downloads).await.map_err(to_string)?;
    let target = downloads.join(format!("{}-{file_name}", hash_id(original_url)));

    emit_log(app, "info", "Streaming download...");
    let mut stream = response.bytes_stream();
    let mut file = tokio::fs::File::create(&target).await.map_err(to_string)?;
    let mut downloaded: u64 = 0;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| {
            emit_log(app, "error", &format!("Download stream error: {e}"));
            e.to_string()
        })?;
        file.write_all(&chunk).await.map_err(to_string)?;
        downloaded += chunk.len() as u64;
        let _ = app.emit("install-progress", serde_json::json!({
            "phase": "downloading",
            "downloaded": downloaded,
            "total": total_size,
        }));
    }

    if downloaded == 0 {
        emit_log(app, "error", "Downloaded file is empty (0 bytes)");
        return Err("Downloaded file is empty.".to_string());
    }

    emit_log(app, "info", &format!("Download complete: {downloaded} bytes"));

    Ok((target, file_name))
}

fn google_drive_file_id(value: &str) -> Option<String> {
    let parsed = Url::parse(value).ok()?;
    if let Some(id) = parsed.query_pairs().find(|(key, _)| key == "id").map(|(_, value)| value.to_string()) {
        return Some(id);
    }

    let regex = Regex::new(r"/file/d/([^/]+)").ok()?;
    regex
        .captures(parsed.path())
        .and_then(|captures| captures.get(1))
        .map(|match_| match_.as_str().to_string())
}

fn content_disposition_name(response: &reqwest::Response) -> Option<String> {
    let value = response.headers().get(reqwest::header::CONTENT_DISPOSITION)?.to_str().ok()?;
    let regex = Regex::new(r#"filename\*?=(?:UTF-8'')?"?([^";]+)"?"#).ok()?;
    regex
        .captures(value)
        .and_then(|captures| captures.get(1))
        .map(|match_| match_.as_str().replace("%20", " "))
}

fn sanitize_upk_name(value: &str) -> Result<String, String> {
    let mut name = value
        .chars()
        .map(|ch| match ch {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            // Windows invalid: control chars and reserved chars
            '\n' | '\r' | '\t' | '\0' => '_',
            c if c.is_control() => '_',
            _ => ch,
        })
        .collect::<String>();

    // Collapse consecutive underscores/spaces
    while name.contains("__") {
        name = name.replace("__", "_");
    }
    name = name.trim().to_string();

    if !name.to_lowercase().ends_with(".upk") {
        name.push_str(".upk");
    }

    if name.contains("..") || name.trim().is_empty() {
        return Err("Unsafe file name.".to_string());
    }

    Ok(name)
}

fn safe_join(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let target = root.join(relative);
    let parent = target.parent().ok_or_else(|| "Invalid target path.".to_string())?;
    let parent = parent.canonicalize().unwrap_or_else(|_| parent.to_path_buf());

    if !parent.starts_with(&root) {
        return Err("Target path is outside install folder.".to_string());
    }

    Ok(target)
}

fn read_settings(app: &AppHandle) -> Result<Settings, String> {
    let path = app_data_dir(app)?.join("settings.json");
    if path.exists() {
        let text = fs::read_to_string(&path).map_err(to_string)?;
        let mut settings: Settings = serde_json::from_str(&text).map_err(to_string)?;
        // Migrate old "Overall" tab gid to "Database for html" tab
        if settings.sheet_csv_url.contains("gid=1384848327") {
            settings.sheet_csv_url = DEFAULT_SHEET_URL.to_string();
            let _ = write_json(&path, &settings);
        }
        return Ok(settings);
    }

    Ok(Settings {
        language: "zh_HK".to_string(),
        install_dir: default_install_dir(),
        sheet_csv_url: DEFAULT_SHEET_URL.to_string(),
        visible_columns: default_visible_columns(),
    })
}

fn read_manifest(app: &AppHandle) -> Result<Manifest, String> {
    let path = app_data_dir(app)?.join("installed-manifest.json");
    if !path.exists() {
        return Ok(Manifest::default());
    }

    let text = fs::read_to_string(path).map_err(to_string)?;
    serde_json::from_str(&text).map_err(to_string)
}

fn write_manifest(app: &AppHandle, manifest: &Manifest) -> Result<(), String> {
    let dir = app_data_dir(app)?;
    fs::create_dir_all(&dir).map_err(to_string)?;
    write_json(&dir.join("installed-manifest.json"), manifest)
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let text = serde_json::to_string_pretty(value).map_err(to_string)?;
    fs::write(path, text).map_err(to_string)
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(to_string)
}

fn resolve_install_dir(settings: &Settings) -> Result<PathBuf, String> {
    if settings.install_dir.trim().is_empty() {
        return Ok(PathBuf::from(default_install_dir()));
    }
    Ok(PathBuf::from(&settings.install_dir))
}

fn default_install_dir() -> String {
    dirs::document_dir()
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")))
        .join("跑Online")
        .join("UMT")
        .to_string_lossy()
        .to_string()
}

fn column_name(index: usize) -> String {
    ((b'A' + index as u8) as char).to_string()
}

fn clean_header(header: &str) -> String {
    header
        .split('\n')
        .next()
        .unwrap_or(header)
        .trim()
        .to_string()
}

fn find_column(headers: &StringRecord, keywords: &[&str]) -> usize {
    for (index, header) in headers.iter().enumerate() {
        let lower = header.trim().to_lowercase();
        if keywords.iter().any(|kw| lower.contains(kw)) {
            return index;
        }
    }
    3 // fallback to column D
}

fn hash_id(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    format!("{:x}", hasher.finalize())[..16].to_string()
}

fn file_name_from_url(value: &str) -> Option<String> {
    Url::parse(value)
        .ok()
        .and_then(|url| url.path_segments()?.last().map(|segment| segment.to_string()))
        .filter(|name| !name.is_empty())
}

fn iso_now() -> String {
    // Good enough for manifest ordering; avoids pulling in a date-time dependency for MVP.
    format!("{:?}", std::time::SystemTime::now())
}

fn to_string<E: std::fmt::Display>(error: E) -> String {
    error.to_string()
}

fn emit_log(app: &AppHandle, level: &str, message: &str) {
    let _ = app.emit("install-log", serde_json::json!({
        "level": level,
        "message": message,
    }));
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            load_catalog,
            scan_installed_maps,
            install_map,
            uninstall_map,
            deactivate_map,
            activate_map
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
