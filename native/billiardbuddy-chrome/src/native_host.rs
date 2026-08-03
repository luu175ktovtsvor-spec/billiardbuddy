//! The BilliardBuddy Chrome native-messaging host.
//!
//! Chrome starts this process through the public Native Messaging protocol. The
//! host validates the one BilliardBuddy extension origin, writes a short-lived
//! authenticated loopback endpoint, and relays constrained requests between the
//! extension and the plugin's stdio MCP process. It never reads Chrome profile
//! files, cookies, passwords, history, or browser storage.

use std::{
    collections::HashMap,
    env,
    fs::{self, File, OpenOptions},
    io::{self, BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Sender},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};

const HOST_NAME: &str = "com.billiardbuddy.chrome";
const EXTENSION_ID: &str = "hkglcfbkjjaljnieaecddhihnleoocbb";
const MAX_NATIVE_MESSAGE: usize = 1024 * 1024;
const MAX_BRIDGE_REQUEST: usize = 1024 * 1024;
const MAX_POLICY_ENTRIES: usize = 256;

#[cfg(windows)]
#[link(name = "bcrypt")]
unsafe extern "system" {
    fn BCryptGenRandom(algorithm: isize, buffer: *mut u8, length: u32, flags: u32) -> i32;
}

#[derive(Clone)]
struct Policy {
    allowed_hosts: Vec<String>,
    blocked_hosts: Vec<String>,
}

impl Policy {
    fn load(root: &PathBuf) -> Self {
        let path = root.join("chrome-control").join("config.json");
        let Ok(contents) = fs::read_to_string(path) else {
            return Self { allowed_hosts: Vec::new(), blocked_hosts: Vec::new() };
        };
        Self {
            allowed_hosts: sanitize_host_rules(json_string_array(&contents, "allowedHosts")),
            blocked_hosts: sanitize_host_rules(json_string_array(&contents, "blockedHosts")),
        }
    }

    fn ready_message(&self) -> String {
        format!(
            r#"{{"kind":"ready","hostName":"{HOST_NAME}","allowedHosts":{},"blockedHosts":{}}}"#,
            json_string_array_value(&self.allowed_hosts),
            json_string_array_value(&self.blocked_hosts),
        )
    }
}

enum ExtensionResponse {
    Result(String),
    Error(String),
}

struct StateFile {
    path: PathBuf,
}

impl Drop for StateFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn main() {
    if !called_by_expected_extension() {
        eprintln!("BilliardBuddy Chrome native host rejected an unexpected extension origin");
        return;
    }
    if let Err(error) = run() {
        eprintln!("BilliardBuddy Chrome native host failed: {error}");
    }
}

fn run() -> Result<(), String> {
    let runtime_root = runtime_root()?;
    let policy = Policy::load(&runtime_root);
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|error| format!("cannot bind local Chrome bridge: {error}"))?;
    listener.set_nonblocking(true).map_err(|error| error.to_string())?;
    let port = listener.local_addr().map_err(|error| error.to_string())?.port();
    let token = random_token()?;
    let state_file = write_state(&runtime_root, port, &token)?;

    let alive = Arc::new(AtomicBool::new(true));
    let extension_connected = Arc::new(AtomicBool::new(false));
    let pending: Arc<Mutex<HashMap<String, Sender<ExtensionResponse>>>> = Arc::new(Mutex::new(HashMap::new()));
    let writer = Arc::new(Mutex::new(io::stdout()));
    start_extension_reader(
        Arc::clone(&alive),
        Arc::clone(&extension_connected),
        Arc::clone(&pending),
        Arc::clone(&writer),
        policy.clone(),
    );

    // Chrome terminates this process when the extension port closes. Keeping the
    // loopback listener non-blocking lets the stdin reader stop all bridge work
    // immediately and removes the bearer token state file on exit.
    while alive.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, address)) => {
                if !address.ip().is_loopback() {
                    continue;
                }
                let token = token.clone();
                let pending = Arc::clone(&pending);
                let writer = Arc::clone(&writer);
                let alive = Arc::clone(&alive);
                let extension_connected = Arc::clone(&extension_connected);
                thread::spawn(move || handle_bridge_client(stream, &token, pending, writer, alive, extension_connected));
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(25)),
            Err(error) => return Err(format!("Chrome bridge listener failed: {error}")),
        }
    }
    drop(state_file);
    Ok(())
}

fn called_by_expected_extension() -> bool {
    let expected = format!("chrome-extension://{EXTENSION_ID}/");
    env::args().any(|argument| argument == expected)
}

fn runtime_root() -> Result<PathBuf, String> {
    if let Some(path) = env::var_os("BILLIARDBUDDY_AGENT_RUNTIME") {
        return Ok(PathBuf::from(path));
    }
    #[cfg(target_os = "macos")]
    {
        let home = env::var_os("HOME").ok_or_else(|| "cannot locate the current macOS user home".to_owned())?;
        return Ok(PathBuf::from(home).join("Library").join("Application Support").join("BilliardBuddy").join("agent-runtime"));
    }
    #[cfg(target_os = "windows")]
    {
        let app_data = env::var_os("APPDATA").ok_or_else(|| "cannot locate APPDATA for BilliardBuddy Chrome".to_owned())?;
        return Ok(PathBuf::from(app_data).join("BilliardBuddy").join("agent-runtime"));
    }
    #[allow(unreachable_code)]
    Err("BilliardBuddy Chrome is available only on macOS and Windows".to_owned())
}

fn write_state(root: &PathBuf, port: u16, token: &str) -> Result<StateFile, String> {
    let directory = root.join("chrome-control");
    fs::create_dir_all(&directory).map_err(|error| format!("cannot create private Chrome state directory: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).map_err(|error| error.to_string())?;
    }
    let path = directory.join("bridge.json");
    let temporary = directory.join(format!("bridge-{}.tmp", &token[..12]));
    let mut file = OpenOptions::new().write(true).create(true).truncate(true).open(&temporary)
        .map_err(|error| format!("cannot create Chrome bridge state: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600)).map_err(|error| error.to_string())?;
    }
    write!(file, r#"{{"schemaVersion":1,"port":{port},"token":"{token}"}}"#).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    fs::rename(&temporary, &path).map_err(|error| format!("cannot publish Chrome bridge state: {error}"))?;
    Ok(StateFile { path })
}

fn start_extension_reader(
    alive: Arc<AtomicBool>,
    extension_connected: Arc<AtomicBool>,
    pending: Arc<Mutex<HashMap<String, Sender<ExtensionResponse>>>>,
    writer: Arc<Mutex<io::Stdout>>,
    policy: Policy,
) {
    thread::spawn(move || {
        let stdin = io::stdin();
        let mut input = stdin.lock();
        loop {
            let message = match read_native_message(&mut input) {
                Ok(Some(message)) => message,
                Ok(None) => break,
                Err(error) => { eprintln!("BilliardBuddy Chrome host native message error: {error}"); break },
            };
            match json_string_member(&message, "kind").as_deref() {
                Some("hello") => {
                    extension_connected.store(true, Ordering::SeqCst);
                    let _ = write_native_message(&writer, &policy.ready_message());
                }
                Some("result") => complete_pending(&pending, &message, true),
                Some("error") => complete_pending(&pending, &message, false),
                Some("tab_connected") | Some("tab_disconnected") => {}
                _ => eprintln!("BilliardBuddy Chrome host ignored an invalid extension message"),
            }
        }
        extension_connected.store(false, Ordering::SeqCst);
        alive.store(false, Ordering::SeqCst);
        let mut waiting = pending.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        for (_, sender) in waiting.drain() { let _ = sender.send(ExtensionResponse::Error("BilliardBuddy Chrome extension disconnected".to_owned())); }
    });
}

fn complete_pending(pending: &Arc<Mutex<HashMap<String, Sender<ExtensionResponse>>>>, message: &str, success: bool) {
    let Some(id) = json_string_member(message, "id") else { return };
    let response = if success {
        let Some(payload) = json_member_value(message, "payload") else { return };
        ExtensionResponse::Result(payload)
    } else {
        ExtensionResponse::Error(json_string_member(message, "message").unwrap_or_else(|| "BilliardBuddy Chrome request failed".to_owned()))
    };
    if let Some(sender) = pending.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(&id) {
        let _ = sender.send(response);
    }
}

fn handle_bridge_client(
    mut stream: TcpStream,
    token: &str,
    pending: Arc<Mutex<HashMap<String, Sender<ExtensionResponse>>>>,
    writer: Arc<Mutex<io::Stdout>>,
    alive: Arc<AtomicBool>,
    extension_connected: Arc<AtomicBool>,
) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
    let result = (|| -> Result<String, String> {
        if !alive.load(Ordering::SeqCst) || !extension_connected.load(Ordering::SeqCst) {
            return Err("BilliardBuddy Chrome extension is not connected".to_owned());
        }
        let mut request = String::new();
        BufReader::new(&mut stream).read_line(&mut request).map_err(|error| error.to_string())?;
        if request.len() > MAX_BRIDGE_REQUEST { return Err("BilliardBuddy Chrome request is too large".to_owned()) }
        if json_string_member(&request, "token").as_deref() != Some(token) { return Err("BilliardBuddy Chrome rejected an unauthenticated local request".to_owned()) }
        let operation = json_string_member(&request, "operation").ok_or_else(|| "BilliardBuddy Chrome request has no operation".to_owned())?;
        if !matches!(operation.as_str(), "status" | "list_tabs" | "inspect_page" | "capture_page" | "navigate" | "click_element" | "type_text" | "press_key") {
            return Err("BilliardBuddy Chrome rejected an unsupported operation".to_owned())
        }
        let arguments = json_member_value(&request, "arguments").unwrap_or_else(|| "{}".to_owned());
        let id = format!("bb-{}", &random_token()?[..24]);
        let (sender, receiver) = mpsc::channel();
        pending.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).insert(id.clone(), sender);
        let command = format!(r#"{{"kind":"command","id":"{id}","op":"{operation}","arguments":{arguments}}}"#);
        if let Err(error) = write_native_message(&writer, &command) {
            pending.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(&id);
            return Err(error);
        }
        match receiver.recv_timeout(Duration::from_secs(45)) {
            Ok(ExtensionResponse::Result(payload)) => Ok(payload),
            Ok(ExtensionResponse::Error(error)) => Err(error),
            Err(_) => { pending.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(&id); Err("BilliardBuddy Chrome request timed out".to_owned()) },
        }
    })();
    let response = match result {
        Ok(payload) => format!(r#"{{"ok":true,"payload":{payload}}}"#),
        Err(error) => format!(r#"{{"ok":false,"error":"{}"}}"#, json_escape(&error)),
    };
    let _ = stream.write_all(format!("{response}\n").as_bytes());
    let _ = stream.flush();
}

fn read_native_message(reader: &mut impl Read) -> Result<Option<String>, String> {
    let mut length = [0_u8; 4];
    match reader.read_exact(&mut length) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error.to_string()),
    }
    let length = u32::from_ne_bytes(length) as usize;
    if length == 0 || length > MAX_NATIVE_MESSAGE { return Err("Chrome native message is outside the permitted size".to_owned()) }
    let mut message = vec![0_u8; length];
    reader.read_exact(&mut message).map_err(|error| error.to_string())?;
    String::from_utf8(message).map(Some).map_err(|_| "Chrome native message is not UTF-8".to_owned())
}

fn write_native_message(writer: &Arc<Mutex<io::Stdout>>, message: &str) -> Result<(), String> {
    if message.len() > MAX_NATIVE_MESSAGE { return Err("BilliardBuddy Chrome native response is too large".to_owned()) }
    let mut output = writer.lock().map_err(|_| "BilliardBuddy Chrome native writer is unavailable".to_owned())?;
    output.write_all(&(message.len() as u32).to_ne_bytes()).map_err(|error| error.to_string())?;
    output.write_all(message.as_bytes()).map_err(|error| error.to_string())?;
    output.flush().map_err(|error| error.to_string())
}

fn random_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    #[cfg(unix)]
    {
        File::open("/dev/urandom").map_err(|error| error.to_string())?.read_exact(&mut bytes).map_err(|error| error.to_string())?;
    }
    #[cfg(windows)]
    unsafe {
        const BCRYPT_USE_SYSTEM_PREFERRED_RNG: u32 = 0x0000_0002;
        if BCryptGenRandom(0, bytes.as_mut_ptr(), bytes.len() as u32, BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0 {
            return Err("Windows could not generate a secure Chrome bridge token".to_owned());
        }
    }
    #[cfg(not(any(unix, windows)))]
    return Err("BilliardBuddy Chrome has no secure random source on this platform".to_owned());
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn sanitize_host_rules(values: Vec<String>) -> Vec<String> {
    let mut output = Vec::new();
    for value in values.into_iter().take(MAX_POLICY_ENTRIES) {
        let value = value.trim().to_ascii_lowercase().trim_end_matches('.').to_owned();
        let candidate = value.strip_prefix("*.").unwrap_or(&value);
        if candidate.is_empty() || candidate.len() > 253 || !candidate.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-')) { continue }
        if !output.contains(&value) { output.push(value) }
    }
    output
}

fn json_string_array_value(values: &[String]) -> String { format!("[{}]", values.iter().map(|value| format!(r#""{}""#, json_escape(value))).collect::<Vec<_>>().join(",")) }
fn json_string_array(input: &str, key: &str) -> Vec<String> {
    let Some(raw) = json_member_value(input, key) else { return Vec::new() };
    let raw = raw.trim(); if !raw.starts_with('[') || !raw.ends_with(']') { return Vec::new() }
    let mut output = Vec::new(); let mut remainder = &raw[1..raw.len()-1];
    while !remainder.trim().is_empty() && output.len() < MAX_POLICY_ENTRIES {
        remainder = remainder.trim_start().trim_start_matches(',').trim_start();
        if !remainder.starts_with('"') { break }
        let Some(end) = raw_json_value_end(remainder) else { break };
        if let Some(value) = remainder[..end].strip_prefix('"').and_then(|value| value.strip_suffix('"')).and_then(json_unescape) { output.push(value) }
        remainder = &remainder[end..];
    }
    output
}
fn json_member_value(input: &str, key: &str) -> Option<String> { let needle = format!(r#""{key}""#); let start = input.find(&needle)? + needle.len(); let after_key = input[start..].trim_start(); let value = after_key.strip_prefix(':')?.trim_start(); let end = raw_json_value_end(value)?; Some(value[..end].trim().to_owned()) }
fn json_string_member(input: &str, key: &str) -> Option<String> { json_member_value(input, key).and_then(|value| value.strip_prefix('"')?.strip_suffix('"').and_then(json_unescape)) }
fn raw_json_value_end(value: &str) -> Option<usize> { let first = *value.as_bytes().first()?; if first == b'"' { let mut escaped = false; for (index, byte) in value.bytes().enumerate().skip(1) { if escaped { escaped = false } else if byte == b'\\' { escaped = true } else if byte == b'"' { return Some(index + 1) } } return None }; let (mut depth, mut quoted, mut escaped) = (0_i32, false, false); for (index, byte) in value.bytes().enumerate() { if quoted { if escaped { escaped = false } else if byte == b'\\' { escaped = true } else if byte == b'"' { quoted = false }; continue } match byte { b'"' => quoted = true, b'{' | b'[' => depth += 1, b'}' | b']' if depth > 0 => depth -= 1, b',' | b'}' if depth == 0 => return Some(index), _ => {} } } Some(value.len()) }
fn json_unescape(value: &str) -> Option<String> { let mut output = String::with_capacity(value.len()); let mut characters = value.chars(); while let Some(character) = characters.next() { if character != '\\' { output.push(character); continue } match characters.next()? { '"' => output.push('"'), '\\' => output.push('\\'), '/' => output.push('/'), 'b' => output.push('\u{0008}'), 'f' => output.push('\u{000c}'), 'n' => output.push('\n'), 'r' => output.push('\r'), 't' => output.push('\t'), 'u' => { let codepoint: String = (0..4).map(|_| characters.next()).collect::<Option<String>>()?; output.push(char::from_u32(u32::from_str_radix(&codepoint, 16).ok()?)?) }, _ => return None } } Some(output) }
fn json_escape(value: &str) -> String { let mut escaped = String::with_capacity(value.len()); for character in value.chars() { match character { '"' => escaped.push_str(r#"\""#), '\\' => escaped.push_str(r#"\\"#), '\n' => escaped.push_str(r#"\n"#), '\r' => escaped.push_str(r#"\r"#), '\t' => escaped.push_str(r#"\t"#), control if control.is_control() => { use std::fmt::Write; let _ = write!(escaped, r#"\u{:04x}"#, control as u32); }, other => escaped.push(other) } } escaped }
