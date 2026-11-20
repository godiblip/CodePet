use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::Path;
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_dialog::{
    DialogExt, FilePath, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};
use tauri_plugin_opener::OpenerExt;

use crate::{bridge, string, windows};

const TRAY_ID: &str = "codepet";

pub fn dispatch(app: &AppHandle, operation: &str, data: Value) -> Result<Value, String> {
    match operation {
        "window-create" => windows::create(app, data)?,
        "window-action" => windows::action(app, data)?,
        "tray-create" => create_tray(app, &data)?,
        "tray-tooltip" => {
            app.tray_by_id(TRAY_ID)
                .ok_or("CodePet tray is closed")?
                .set_tooltip(Some(string(&data, "text")?))
                .map_err(|error| error.to_string())?;
        }
        "tray-menu" => {
            app.tray_by_id(TRAY_ID)
                .ok_or("CodePet tray is closed")?
                .set_menu(Some(make_menu(app, &data)?))
                .map_err(|error| error.to_string())?;
        }
        "tray-destroy" => {
            app.remove_tray_by_id(TRAY_ID);
        }
        "menu-popup" => {
            let label = string(&data, "label")?;
            app.get_webview_window(label)
                .ok_or("CodePet window is closed")?
                .popup_menu(&make_menu(app, &data)?)
                .map_err(|error| error.to_string())?;
        }
        "dialog" => return dialog(app, &data),
        "open-external" => {
            let url = string(&data, "url")?;
            let parsed = tauri::Url::parse(url).map_err(|error| error.to_string())?;
            if !matches!(parsed.scheme(), "http" | "https") && !is_codex_thread_link(&parsed) {
                return Err("Unsupported external link".into());
            }
            app.opener()
                .open_url(url, None::<String>)
                .map_err(|error| error.to_string())?;
        }
        "open-path" => {
            app.opener()
                .open_path(string(&data, "file")?, None::<String>)
                .map_err(|error| error.to_string())?;
            return Ok(Value::from(""));
        }
        "quit" => (),
        _ => return Err("Unknown CodePet desktop operation".into()),
    }
    Ok(Value::Null)
}

fn is_codex_thread_link(url: &tauri::Url) -> bool {
    url.scheme() == "codex"
        && url.host_str() == Some("threads")
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && url.path().strip_prefix('/').is_some_and(|id| {
            id.len() == 36
                && id.bytes().enumerate().all(|(index, byte)| {
                    if matches!(index, 8 | 13 | 18 | 23) {
                        byte == b'-'
                    } else {
                        byte.is_ascii_hexdigit()
                    }
                })
        })
}

fn create_tray(app: &AppHandle, data: &Value) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(string(data, "image")?)
        .map_err(|error| error.to_string())?;
    let icon = Image::from_bytes(&bytes).map_err(|error| error.to_string())?;
    TrayIconBuilder::with_id(TRAY_ID).icon(icon).show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            let (event, rect, position) = match event {
                TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, rect, position, .. } => ("click", rect, position),
                TrayIconEvent::DoubleClick { button: MouseButton::Left, rect, position, .. } => ("double-click", rect, position),
                _ => return,
            };
            let size = rect.size.to_physical::<u32>(1.0);
            bridge::event(tray.app_handle(), "tray-event", json!({ "event": event,
                "bounds": { "x":position.x, "y":position.y, "width":size.width, "height":size.height } }));
        }).build(app).map_err(|error| error.to_string())?;
    Ok(())
}

#[derive(Deserialize)]
struct MenuEntry {
    id: String,
    label: Option<String>,
    #[serde(rename = "type")]
    item_type: Option<String>,
    enabled: bool,
    checked: bool,
    submenu: Option<Vec<MenuEntry>>,
}

fn make_menu(app: &AppHandle, data: &Value) -> Result<Menu<Wry>, String> {
    let entries: Vec<MenuEntry> =
        serde_json::from_value(data["items"].clone()).map_err(|error| error.to_string())?;
    let menu = Menu::new(app).map_err(|error| error.to_string())?;
    for entry in entries {
        menu.append(&menu_item(app, entry)?)
            .map_err(|error| error.to_string())?;
    }
    Ok(menu)
}

fn menu_item(app: &AppHandle, entry: MenuEntry) -> Result<MenuItemKind<Wry>, String> {
    let text = entry.label.as_deref().unwrap_or("");
    let item = if let Some(children) = entry.submenu {
        let submenu = Submenu::new(app, text, entry.enabled).map_err(|error| error.to_string())?;
        for child in children {
            submenu
                .append(&menu_item(app, child)?)
                .map_err(|error| error.to_string())?;
        }
        MenuItemKind::Submenu(submenu)
    } else {
        match entry.item_type.as_deref() {
            Some("separator") => MenuItemKind::Predefined(
                PredefinedMenuItem::separator(app).map_err(|error| error.to_string())?,
            ),
            Some("checkbox" | "radio") => MenuItemKind::Check(
                CheckMenuItem::with_id(
                    app,
                    entry.id,
                    text,
                    entry.enabled,
                    entry.checked,
                    None::<&str>,
                )
                .map_err(|error| error.to_string())?,
            ),
            _ => MenuItemKind::MenuItem(
                MenuItem::with_id(app, entry.id, text, entry.enabled, None::<&str>)
                    .map_err(|error| error.to_string())?,
            ),
        }
    };
    Ok(item)
}

fn dialog(app: &AppHandle, data: &Value) -> Result<Value, String> {
    let options = &data["options"];
    let kind = string(data, "kind")?;
    let title = options["title"].as_str().unwrap_or("CodePet");
    if matches!(kind, "message" | "error") {
        let detail = options["detail"].as_str().unwrap_or("");
        let message = options["message"].as_str().unwrap_or("");
        let mut prompt = app
            .dialog()
            .message(format!("{message}\n{detail}"))
            .title(title);
        if let Some(window) = data["label"]
            .as_str()
            .and_then(|label| app.get_webview_window(label))
        {
            prompt = prompt.parent(&window);
        }
        if kind == "message" {
            let no = options["buttons"][0].as_str().unwrap_or("Cancel");
            let yes = options["buttons"][1].as_str().unwrap_or("OK");
            let result = prompt
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::OkCancelCustom(
                    no.to_owned(),
                    yes.to_owned(),
                ))
                .blocking_show_with_result();
            let confirmed = matches!(result, MessageDialogResult::Custom(label) if label == yes);
            return Ok(json!({ "response": u8::from(confirmed) }));
        }
        prompt.kind(MessageDialogKind::Error).blocking_show();
        return Ok(Value::Null);
    }
    let mut picker = app.dialog().file().set_title(title);
    if let Some(window) = data["label"]
        .as_str()
        .and_then(|label| app.get_webview_window(label))
    {
        picker = picker.set_parent(&window);
    }
    if let Some(default) = options["defaultPath"].as_str() {
        let default = Path::new(default);
        if default.is_dir() {
            picker = picker.set_directory(default);
        } else {
            if let Some(parent) = default.parent() {
                picker = picker.set_directory(parent);
            }
            if let Some(name) = default.file_name() {
                picker = picker.set_file_name(name.to_string_lossy());
            }
        }
    }
    if let Some(filters) = options["filters"].as_array() {
        for filter in filters {
            if let (Some(name), Some(extensions)) =
                (filter["name"].as_str(), filter["extensions"].as_array())
            {
                let extensions: Vec<&str> = extensions.iter().filter_map(Value::as_str).collect();
                picker = picker.add_filter(name, &extensions);
            }
        }
    }
    let property = |name: &str| {
        options["properties"]
            .as_array()
            .is_some_and(|values| values.iter().any(|value| value == name))
    };
    if kind == "save" {
        let file = picker.blocking_save_file().and_then(local_path);
        return Ok(json!({ "canceled":file.is_none(), "filePath":file }));
    }
    let files: Vec<FilePath> = if property("openDirectory") {
        picker.blocking_pick_folder().into_iter().collect()
    } else if property("multiSelections") {
        picker.blocking_pick_files().unwrap_or_default()
    } else {
        picker.blocking_pick_file().into_iter().collect()
    };
    let files: Vec<String> = files.into_iter().filter_map(local_path).collect();
    Ok(json!({"canceled":files.is_empty(),"filePaths":files}))
}

fn local_path(file: FilePath) -> Option<String> {
    file.into_path()
        .ok()
        .map(|path| path.to_string_lossy().into_owned())
}
