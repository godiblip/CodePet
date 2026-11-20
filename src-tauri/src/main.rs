#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bridge;
mod desktop;
mod windows;

use serde_json::{json, Value};
use tauri::{Manager, RunEvent, State, WebviewWindow};

use bridge::Bridge;

pub(crate) fn string<'a>(data: &'a Value, key: &str) -> Result<&'a str, String> {
    data[key]
        .as_str()
        .ok_or_else(|| format!("Invalid CodePet field: {key}"))
}

#[tauri::command]
async fn desktop_ipc(
    window: WebviewWindow,
    bridge: State<'_, Bridge>,
    channel: String,
    args: Vec<Value>,
    expects_reply: bool,
) -> Result<Value, String> {
    bridge
        .ipc(window.label().to_owned(), channel, args, expects_reply)
        .await
}

#[tauri::command]
fn desktop_ready(window: WebviewWindow, bridge: State<'_, Bridge>) {
    bridge.event(
        "window-event",
        json!({"label":window.label(),"event":"ready"}),
    );
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            bridge::event(app, "second-instance", json!(args))
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .on_menu_event(|app, event| bridge::event(app, "menu-event", json!(event.id().as_ref())))
        .invoke_handler(tauri::generate_handler![desktop_ipc, desktop_ready])
        .setup(|app| {
            let bridge = Bridge::spawn(app.handle())?;
            app.manage(bridge.clone());
            bridge.event(
                "initialize",
                json!({"displays": windows::displays(app.handle())}),
            );
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("CodePet failed to start");
    app.run(|app, event| match event {
        RunEvent::ExitRequested { api, code, .. } => {
            if let Some(bridge) = app.try_state::<Bridge>() {
                if !bridge.is_closed() {
                    api.prevent_exit();
                    if code.is_some() {
                        bridge.event("quit", Value::Null);
                    }
                }
            }
        }
        RunEvent::Resumed => bridge::event(app, "resume", Value::Null),
        _ => {}
    });
}
