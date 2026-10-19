use std::path::{Path, PathBuf};
use serde::{Serialize, Deserialize};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AudioFileInfo {
    pub path: String,
    pub name: String,
    pub relative_path: String,
    pub size: u64,
    pub extension: String,
}

const SUPPORTED_AUDIO_EXTENSIONS: &[&str] = &[
    "flac", "wav", "mp3", "m4a", "aac", "ogg", "opus", "alac", "aiff", "aif", "dsf", "dff", "wma", "ape"
];

fn walk_dir_recursive(dir: &Path, root: &Path, list: &mut Vec<AudioFileInfo>, max_files: usize) {
    if list.len() >= max_files {
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        if list.len() >= max_files {
            break;
        }
        let path = entry.path();
        if path.is_dir() {
            walk_dir_recursive(&path, root, list, max_files);
        } else if path.is_file() {
            if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                let ext_lower = ext.to_lowercase();
                if SUPPORTED_AUDIO_EXTENSIONS.contains(&ext_lower.as_str()) {
                    let file_size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                    let name = path
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default();
                    let relative_path = path
                        .strip_prefix(root)
                        .map(|p| p.to_string_lossy().replace('\\', "/"))
                        .unwrap_or_else(|_| name.clone());

                    list.push(AudioFileInfo {
                        path: path.to_string_lossy().to_string(),
                        name,
                        relative_path,
                        size: file_size,
                        extension: ext_lower,
                    });
                }
            }
        }
    }
}

#[tauri::command]
fn pick_music_folder() -> Option<String> {
    rfd::FileDialog::new()
        .pick_folder()
        .map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
fn scan_music_folder(folder_path: String) -> Result<Vec<AudioFileInfo>, String> {
    let root = PathBuf::from(&folder_path);
    if !root.exists() || !root.is_dir() {
        return Err("Selected folder does not exist or is not a directory".to_string());
    }
    let mut files = Vec::new();
    walk_dir_recursive(&root, &root, &mut files, 15_000);
    Ok(files)
}

#[tauri::command]
fn read_file_header(path: String, max_bytes: usize) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let mut file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let mut buffer = vec![0u8; max_bytes];
    let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
    buffer.truncate(n);
    Ok(buffer)
}

use std::sync::atomic::{AtomicBool, Ordering};

static CLOSE_TO_TRAY: AtomicBool = AtomicBool::new(true);

#[tauri::command]
fn set_close_to_tray(enable: bool) {
    CLOSE_TO_TRAY.store(enable, Ordering::Relaxed);
}

#[tauri::command]
fn close_aurelia_window(app: tauri::AppHandle, close_to_tray: bool) {
    CLOSE_TO_TRAY.store(close_to_tray, Ordering::Relaxed);
    if let Some(window) = app.get_webview_window("main") {
        if close_to_tray {
            let _ = window.hide();
        } else {
            let _ = window.close();
            app.exit(0);
        }
    } else if !close_to_tray {
        app.exit(0);
    }
}


#[tauri::command]
fn update_tray_track(app: tauri::AppHandle, title: Option<String>, artist: Option<String>, is_playing: bool) {
    if let Some(tray) = app.tray_by_id("main-tray") {
        let tooltip = match (title, artist) {
            (Some(t), Some(a)) if !t.is_empty() && !a.is_empty() => {
                let status = if is_playing { "▶" } else { "⏸" };
                format!("Aurelia Audio {} {} - {}", status, t, a)
            }
            (Some(t), _) if !t.is_empty() => {
                let status = if is_playing { "▶" } else { "⏸" };
                format!("Aurelia Audio {} {}", status, t)
            }
            _ => "Aurelia Audio".to_string(),
        };
        let _ = tray.set_tooltip(Some(tooltip));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Create Aurelia System Tray Icon using official brand logo
            let tray_icon = tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png"))
                .unwrap_or_else(|_| app.default_window_icon().unwrap().clone());

            let show_i = MenuItem::with_id(app, "show", "Open Aurelia Audio", true, None::<&str>)?;
            let toggle_i = MenuItem::with_id(app, "play_pause", "Play / Pause", true, None::<&str>)?;
            let next_i = MenuItem::with_id(app, "next", "Next Track", true, None::<&str>)?;
            let prev_i = MenuItem::with_id(app, "prev", "Previous Track", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Exit Aurelia", true, None::<&str>)?;

            let tray_menu = Menu::with_items(
                app,
                &[&show_i, &toggle_i, &next_i, &prev_i, &quit_i],
            )?;

            let _tray = TrayIconBuilder::with_id("main-tray")
                .icon(tray_icon)
                .tooltip("Aurelia Audio")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                    "play_pause" => {
                        let _ = app.emit("tray-command", "play_pause");
                    }
                    "next" => {
                        let _ = app.emit("tray-command", "next");
                    }
                    "prev" => {
                        let _ = app.emit("tray-command", "prev");
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            if window.is_visible().unwrap_or(false) {
                                let _ = window.hide();
                            } else {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if CLOSE_TO_TRAY.load(Ordering::Relaxed) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            pick_music_folder,
            scan_music_folder,
            read_file_header,
            set_close_to_tray,
            close_aurelia_window,
            update_tray_track
        ])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
