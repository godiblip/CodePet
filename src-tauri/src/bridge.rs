use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};
use tokio::sync::oneshot;

type Reply = oneshot::Sender<Result<Value, String>>;

#[derive(Clone)]
pub struct Bridge(Arc<BridgeState>);

struct BridgeState {
    input: Mutex<ChildStdin>,
    pending: Mutex<HashMap<u64, Reply>>,
    next_id: AtomicU64,
    closed: AtomicBool,
}

impl Bridge {
    pub fn spawn(app: &AppHandle) -> Result<Self, Box<dyn std::error::Error>> {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        let root = std::env::var_os("CODEPET_TAURI_ROOT")
            .map(PathBuf::from)
            .unwrap_or(root);
        let backend = root.join("src").join("main.js");
        let node = std::env::var_os("CODEPET_NODE").unwrap_or_else(|| "node".into());
        let mut command = Command::new(node);
        command
            .arg(backend)
            .args(std::env::args_os().skip(1))
            .current_dir(root)
            .env("CODEPET_TAURI_BACKEND", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn()?;
        let input = child.stdin.take().ok_or("Missing backend input")?;
        let output = child.stdout.take().ok_or("Missing backend output")?;
        let bridge = Self(Arc::new(BridgeState {
            input: Mutex::new(input),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            closed: AtomicBool::new(false),
        }));
        let reader = bridge.clone();
        let app = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                let Ok(line) = line else { break };
                if let Ok(message) = serde_json::from_str::<Value>(&line) {
                    reader.accept(&app, message);
                }
            }
            reader.0.closed.store(true, Ordering::Release);
            if let Ok(mut pending) = reader.0.pending.lock() {
                pending.clear();
            }
            let code = child
                .wait()
                .ok()
                .and_then(|status| status.code())
                .unwrap_or(1);
            app.exit(code);
        });
        Ok(bridge)
    }

    pub fn send(&self, message: &Value) -> Result<(), String> {
        let mut input = self
            .0
            .input
            .lock()
            .map_err(|_| "CodePet backend lock unavailable")?;
        serde_json::to_writer(&mut *input, message).map_err(|error| error.to_string())?;
        input.write_all(b"\n").map_err(|error| error.to_string())
    }

    pub fn event(&self, event: &str, data: Value) {
        let _ = self.send(&json!({ "type": "host-event", "event": event, "data": data }));
    }

    pub async fn ipc(
        &self,
        label: String,
        channel: String,
        args: Vec<Value>,
        expects_reply: bool,
    ) -> Result<Value, String> {
        let id = self.0.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self
                .0
                .pending
                .lock()
                .map_err(|_| "CodePet backend lock unavailable")?;
            if self.is_closed() {
                return Err("CodePet backend stopped".into());
            }
            pending.insert(id, tx);
        }
        if let Err(error) = self.send(&json!({ "type": "host-event", "event": "renderer-ipc",
            "data": { "id": id, "label": label, "channel": channel, "args": args, "expectsReply": expects_reply } })) {
            if let Ok(mut pending) = self.0.pending.lock() { pending.remove(&id); }
            return Err(error);
        }
        rx.await
            .map_err(|_| "CodePet backend disconnected".to_string())?
    }

    fn accept(&self, app: &AppHandle, message: Value) {
        let id = message["id"].as_u64();
        match message["type"].as_str() {
            Some("ipc-result") => {
                if let Some(id) = id {
                    if let Ok(mut pending) = self.0.pending.lock() {
                        if let Some(reply) = pending.remove(&id) {
                            let result = match message["error"].as_str() {
                                Some(error) => Err(error.to_owned()),
                                None => Ok(message["value"].clone()),
                            };
                            let _ = reply.send(result);
                        }
                    }
                }
            }
            Some("desktop") => {
                let bridge = self.clone();
                let operation = message["operation"].as_str().unwrap_or("").to_owned();
                let data = message["data"].clone();
                let handle = app.clone();
                let callback =
                    move || bridge.respond(id, crate::desktop::dispatch(&handle, &operation, data));
                if matches!(
                    message["operation"].as_str(),
                    Some("dialog" | "window-create")
                ) {
                    std::thread::spawn(callback);
                } else {
                    let _ = app.run_on_main_thread(callback);
                }
            }
            _ => {}
        }
    }

    fn respond(&self, id: Option<u64>, result: Result<Value, String>) {
        if let Some(id) = id {
            let message = match result {
                Ok(value) => json!({ "type": "desktop-result", "id": id, "value": value }),
                Err(error) => json!({ "type": "desktop-result", "id": id, "error": error }),
            };
            let _ = self.send(&message);
        } else if let Err(error) = result {
            eprintln!("CodePet desktop operation failed: {error}");
        }
    }

    pub fn is_closed(&self) -> bool {
        self.0.closed.load(Ordering::Acquire)
    }
}

pub fn event(app: &AppHandle, event: &str, data: Value) {
    if let Some(bridge) = app.try_state::<Bridge>() {
        bridge.event(event, data);
    }
}
