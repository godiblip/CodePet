use serde::Deserialize;
use serde_json::{json, Value};
use tauri::webview::NewWindowResponse;
use tauri::{
    AppHandle, DragDropEvent, Emitter, LogicalPosition, LogicalSize, Manager, WebviewEvent,
    WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

use crate::bridge;

const PAGES: &[&str] = &[
    "index.html",
    "bubble.html",
    "chat.html",
    "settings.html",
    "usage.html",
    "live.html",
];

#[derive(Deserialize)]
struct Bounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct Options {
    x: Option<f64>,
    y: Option<f64>,
    min_width: Option<f64>,
    min_height: Option<f64>,
    max_width: Option<f64>,
    max_height: Option<f64>,
    title: Option<String>,
    frame: Option<bool>,
    show: Option<bool>,
    resizable: Option<bool>,
    minimizable: Option<bool>,
    maximizable: Option<bool>,
    transparent: bool,
    always_on_top: bool,
    skip_taskbar: bool,
}

pub fn create(app: &AppHandle, data: Value) -> Result<(), String> {
    let label = super::string(&data, "label")?;
    let page = super::string(&data, "page")?;
    if !PAGES.contains(&page) {
        return Err("Unknown CodePet page".into());
    }
    let bounds: Bounds =
        serde_json::from_value(data["bounds"].clone()).map_err(|error| error.to_string())?;
    let options: Options =
        serde_json::from_value(data["options"].clone()).map_err(|error| error.to_string())?;
    let virtual_path = if data["query"]["mode"] == "popup" {
        format!("{page}?mode=popup")
    } else {
        page.to_owned()
    };
    let local_page = format!("/{page}");
    let microphone = if page == "live.html" {
        "microphone=(self)"
    } else {
        "microphone=()"
    };
    let permissions = tauri::http::HeaderValue::from_str(&format!(
        "{microphone}, camera=(), geolocation=(), display-capture=()"
    ))
    .map_err(|error| error.to_string())?;
    let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App(virtual_path.into()))
        .title(options.title.unwrap_or_else(|| "CodePet".into()))
        .visible(options.show.unwrap_or(false))
        .focused(false)
        .focusable(!matches!(page, "index.html" | "bubble.html"))
        .inner_size(bounds.width, bounds.height)
        .decorations(options.frame.unwrap_or(true))
        .resizable(options.resizable.unwrap_or(true))
        .minimizable(options.minimizable.unwrap_or(true))
        .maximizable(options.maximizable.unwrap_or(true))
        .transparent(options.transparent)
        .always_on_top(options.always_on_top)
        .skip_taskbar(options.skip_taskbar)
        .on_navigation(move |url| is_local_page(url, &local_page))
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_web_resource_request(move |_request, response| {
            response
                .headers_mut()
                .insert("permissions-policy", permissions.clone());
        });
    if options.x.is_some() && options.y.is_some() {
        builder = builder.position(bounds.x, bounds.y);
    } else {
        builder = builder.center();
    }
    if let (Some(width), Some(height)) = (options.min_width, options.min_height) {
        builder = builder.min_inner_size(width, height);
    }
    if let (Some(width), Some(height)) = (options.max_width, options.max_height) {
        builder = builder.max_inner_size(width, height);
    }
    let window = builder.build().map_err(|error| error.to_string())?;
    if page == "chat.html" {
        let chat = window.clone();
        window.on_webview_event(move |event| {
            if let WebviewEvent::DragDrop(DragDropEvent::Drop {
                paths, position, ..
            }) = event
            {
                let scale = chat.scale_factor().unwrap_or(1.0);
                let point = position.to_logical::<f64>(scale);
                let _ = chat.emit_to(
                    tauri::EventTarget::webview_window(chat.label()),
                    "codepet-file-drop",
                    json!({"paths":paths,"x":point.x,"y":point.y}),
                );
            }
        });
    }
    let observed = window.clone();
    let app = app.clone();
    window.on_window_event(move |event| {
        let payload = match event {
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                json!({ "event": "close" })
            }
            WindowEvent::Destroyed => json!({ "event": "destroyed" }),
            WindowEvent::Focused(false) => json!({ "event": "blur" }),
            WindowEvent::Moved(_) | WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } => {
                json!({"event": "bounds", "bounds": window_bounds(&observed),
                    "maximized": observed.is_maximized().ok(), "minimized": observed.is_minimized().ok()})
            }
            _ => return,
        };
        let mut payload = payload;
        payload["label"] = Value::from(observed.label());
        bridge::event(&app, "window-event", payload);
        if matches!(event, WindowEvent::ScaleFactorChanged { .. }) {
            bridge::event(&app, "displays", displays(&app));
        }
    });
    Ok(())
}

pub fn action(app: &AppHandle, data: Value) -> Result<(), String> {
    let label = super::string(&data, "label")?;
    let window = app
        .get_webview_window(label)
        .ok_or("CodePet window is closed")?;
    let result = match super::string(&data, "action")? {
        "bounds" => {
            let bounds: Bounds = serde_json::from_value(data["bounds"].clone())
                .map_err(|error| error.to_string())?;
            let size = LogicalSize::new(bounds.width, bounds.height);
            let already_sized = window.scale_factor().ok().is_some_and(|scale| {
                window.inner_size().ok() == Some(size.to_physical::<u32>(scale))
            });
            window
                .set_position(LogicalPosition::new(bounds.x, bounds.y))
                .and_then(|_| {
                    if already_sized {
                        Ok(())
                    } else {
                        window.set_size(size)
                    }
                })
        }
        "focus" => window.set_focus(),
        "show" => window.show(),
        "hide" => window.hide(),
        "minimize" => window.minimize(),
        "restore" => window.unminimize(),
        "maximize" => window.maximize(),
        "unmaximize" => window.unmaximize(),
        "destroy" => window.destroy(),
        "emit" => window.emit_to(
            tauri::EventTarget::webview_window(label),
            "codepet-ipc",
            json!({"channel": data["channel"], "args": data["args"]}),
        ),
        "devtools" => {
            #[cfg(debug_assertions)]
            window.open_devtools();
            Ok(())
        }
        _ => return Err("Unknown CodePet window operation".into()),
    };
    result.map_err(|error| error.to_string())
}

fn is_local_page(url: &tauri::Url, page: &str) -> bool {
    let local = matches!(
        (url.scheme(), url.host_str(), url.port()),
        ("tauri", Some("localhost"), None) | ("http" | "https", Some("tauri.localhost"), None)
    );
    local
        && url.username().is_empty()
        && url.password().is_none()
        && (url.path() == page || (page == "/index.html" && url.path() == "/"))
}

#[cfg(test)]
mod tests {
    use super::is_local_page;

    #[test]
    fn only_the_assigned_local_page_can_navigate() {
        let cases = [
            ("http://tauri.localhost/", "/index.html", true),
            ("tauri://localhost/chat.html", "/chat.html", true),
            (
                "http://tauri.localhost/usage.html?mode=popup",
                "/usage.html",
                true,
            ),
            ("http://tauri.localhost/settings.html", "/chat.html", false),
            ("http://localhost:8751/chat.html", "/chat.html", false),
            (
                "https://tauri.localhost.example/chat.html",
                "/chat.html",
                false,
            ),
        ];
        for (url, page, expected) in cases {
            assert_eq!(
                is_local_page(&tauri::Url::parse(url).unwrap(), page),
                expected,
                "{url}"
            );
        }
    }
}

fn window_bounds(window: &WebviewWindow) -> Option<Value> {
    let scale = window.scale_factor().ok()?;
    let pos = window.outer_position().ok()?.to_logical::<f64>(scale);
    let size = window.inner_size().ok()?.to_logical::<f64>(scale);
    Some(json!({"x":pos.x,"y":pos.y,"width":size.width,"height":size.height}))
}

pub fn displays(app: &AppHandle) -> Value {
    let primary = app.primary_monitor().ok().flatten();
    let all = app.available_monitors().unwrap_or_default();
    let displays: Vec<Value> = all.iter().enumerate().map(|(id, monitor)| {
        let scale = monitor.scale_factor();
        let pos = monitor.position().to_logical::<f64>(scale);
        let size = monitor.size().to_logical::<f64>(scale);
        let area = monitor.work_area();
        let work_pos = area.position.to_logical::<f64>(scale);
        let work_size = area.size.to_logical::<f64>(scale);
        let is_primary = primary.as_ref().is_some_and(|primary| primary.position() == monitor.position());
        json!({"id":id,"primary":is_primary,"scaleFactor":scale,
            "bounds":{"x":pos.x,"y":pos.y,"width":size.width,"height":size.height},
            "workArea":{"x":work_pos.x,"y":work_pos.y,"width":work_size.width,"height":work_size.height}})
    }).collect();
    if displays.is_empty() {
        let area = json!({ "x":0,"y":0,"width":1024,"height":768 });
        json!([{ "id":0,"primary":true,"scaleFactor":1,"bounds":area,"workArea":area }])
    } else {
        json!(displays)
    }
}
