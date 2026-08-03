//! BilliardBuddy Record & Replay stdio MCP endpoint.
//!
//! It records only a bounded, redacted action trace after an explicit start.
//! Key values, clipboard content, cookies, passwords and screen video never
//! enter the trace. The later Skill is guidance for the normal, currently
//! approved tools; this is deliberately not a coordinate macro player.

use std::{env, fs, io::{self, BufRead, Write}, path::{Path, PathBuf}, process::{Command, Stdio}, thread, time::{Duration, SystemTime, UNIX_EPOCH}};

const NAME: &str = "billiardbuddy-record-replay";
const VERSION: &str = env!("CARGO_PKG_VERSION");
const MAX_DURATION_SECONDS: u64 = 30 * 60;

fn main() {
    let stdin = io::stdin(); let mut stdout = io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break }; if line.trim().is_empty() { continue }
        if let Some(response) = handle(&line) { if writeln!(stdout, "{response}").is_err() || stdout.flush().is_err() { break } }
    }
}

fn handle(message: &str) -> Option<String> {
    let id = member(message, "id");
    let Some(method) = string_member(message, "method") else { return Some(error(id.as_deref().unwrap_or("null"), -32600, "invalid JSON-RPC request")) };
    let response = match method.as_str() {
        "initialize" => success(id.as_deref().unwrap_or("null"), &format!(r#"{{"protocolVersion":"2025-06-18","capabilities":{{"tools":{{"listChanged":false}}}},"serverInfo":{{"name":"{NAME}","version":"{VERSION}"}}}}"#)),
        "ping" => success(id.as_deref().unwrap_or("null"), "{}"),
        "tools/list" => success(id.as_deref().unwrap_or("null"), tools()),
        "tools/call" => call(id.as_deref().unwrap_or("null"), message),
        "notifications/initialized" if id.is_none() => return None,
        _ => error(id.as_deref().unwrap_or("null"), -32601, "Record and Replay does not implement this MCP method"),
    }; Some(response)
}

fn tools() -> &'static str { r#"{"tools":[
 {"name":"recording_status","description":"Check whether a BilliardBuddy recording is active. This never begins recording.","inputSchema":{"type":"object","properties":{},"additionalProperties":false}},
 {"name":"start_recording","description":"After explicit user confirmation, begin one redacted desktop-action recording for a stated workflow. It expires automatically within 30 minutes.","inputSchema":{"type":"object","properties":{"purpose":{"type":"string","minLength":1,"maxLength":500},"maxDurationSeconds":{"type":"integer","minimum":30,"maximum":1800}},"required":["purpose"],"additionalProperties":false}},
 {"name":"stop_recording","description":"Stop the active recording and return its redacted action trace for drafting a reviewable Skill.","inputSchema":{"type":"object","properties":{},"additionalProperties":false}},
 {"name":"discard_recording","description":"Stop and permanently discard the active or last unsaved recording.","inputSchema":{"type":"object","properties":{},"additionalProperties":false}},
 {"name":"save_recorded_skill","description":"Save user-reviewed Skill Markdown generated from a stopped recording. It does not grant future desktop permissions.","inputSchema":{"type":"object","properties":{"name":{"type":"string","pattern":"^[a-z0-9][a-z0-9-]{0,63}$"},"markdown":{"type":"string","minLength":32,"maxLength":65536}},"required":["name","markdown"],"additionalProperties":false}}
]}"# }

fn call(id: &str, message: &str) -> String {
    let Some(name) = string_member(message, "name") else { return error(id, -32602, "tools/call requires a tool name") };
    let arguments = member(message, "arguments").unwrap_or_else(|| "{}".to_owned());
    let result: Result<String, String> = match name.as_str() {
        "recording_status" => status(),
        "start_recording" => start(&arguments),
        "stop_recording" => stop(false),
        "discard_recording" => stop(true),
        "save_recorded_skill" => save_skill(&arguments),
        _ => return error(id, -32602, "unknown BilliardBuddy Record and Replay tool"),
    };
    let payload = match result { Ok(text) => tool_result(&text), Err(reason) => tool_error(&reason) };
    success(id, &payload)
}

fn root() -> Result<PathBuf, String> { env::var_os("CODEX_HOME").map(PathBuf::from).map(|path| path.join("record-replay")).ok_or_else(|| "Record and Replay requires the private BilliardBuddy Agent runtime".to_owned()) }
fn state_file(root: &Path) -> PathBuf { root.join("state.json") }
fn trace_file(root: &Path) -> PathBuf { root.join("trace.json") }
fn stop_file(root: &Path) -> PathBuf { root.join("stop") }

fn status() -> Result<String, String> { let root = root()?; let active = fs::read_to_string(state_file(&root)).ok().is_some_and(|value| member(&value, "active").as_deref() == Some("true")); Ok(format!(r#"{{"active":{active},"traceAvailable":{}}}"#, trace_file(&root).is_file())) }

fn start(arguments: &str) -> Result<String, String> {
    let purpose = required_string(arguments, "purpose")?; if purpose.trim().is_empty() || purpose.len() > 500 { return Err("purpose must contain 1-500 characters".to_owned()) }
    let duration = member(arguments, "maxDurationSeconds").and_then(|value| value.parse::<u64>().ok()).unwrap_or(600).clamp(30, MAX_DURATION_SECONDS);
    let root = root()?; fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let _ = fs::remove_file(stop_file(&root)); let _ = fs::remove_file(trace_file(&root));
    if fs::read_to_string(state_file(&root)).ok().is_some_and(|value| member(&value, "active").as_deref() == Some("true")) { return Err("BILLIARDBUDDY_RECORDING_ALREADY_ACTIVE".to_owned()) }
    let service = service_path()?;
    let started_at = unix_seconds();
    fs::write(state_file(&root), format!(r#"{{"active":true,"purpose":"{}","startedAt":{started_at},"maxDurationSeconds":{duration}}}"#, escape(&purpose))).map_err(|error| error.to_string())?;
    let spawned = Command::new(service).args(["record", trace_file(&root).to_string_lossy().as_ref(), stop_file(&root).to_string_lossy().as_ref(), &duration.to_string(), purpose.as_str()]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|error| { let _ = fs::remove_file(state_file(&root)); format!("unable to start local recorder: {error}") })?;
    fs::write(root.join("pid"), spawned.id().to_string()).map_err(|error| error.to_string())?;
    Ok(format!(r#"{{"active":true,"maxDurationSeconds":{duration},"privacy":"typed text, clipboard, cookies, passwords, screen video and raw screenshots are never recorded"}}"#))
}

fn stop(discard: bool) -> Result<String, String> {
    let root = root()?;
    if !state_file(&root).is_file() { if discard { let _ = fs::remove_file(trace_file(&root)); return Ok("{\"discarded\":true}".to_owned()) }; return Err("BILLIARDBUDDY_RECORDING_NOT_ACTIVE".to_owned()) }
    fs::write(stop_file(&root), "stop\n").map_err(|error| error.to_string())?;
    for _ in 0..100 { if trace_file(&root).is_file() { break }; thread::sleep(Duration::from_millis(100)) }
    let _ = fs::remove_file(state_file(&root)); let _ = fs::remove_file(root.join("pid")); let _ = fs::remove_file(stop_file(&root));
    if discard { let _ = fs::remove_file(trace_file(&root)); return Ok("{\"discarded\":true}".to_owned()) }
    let trace = fs::read_to_string(trace_file(&root)).map_err(|_| "BILLIARDBUDDY_RECORDING_STOP_TIMEOUT".to_owned())?;
    if trace.len() > 256 * 1024 { return Err("BILLIARDBUDDY_RECORDING_TRACE_TOO_LARGE".to_owned()) }
    Ok(trace)
}

fn save_skill(arguments: &str) -> Result<String, String> {
    let name = required_string(arguments, "name")?; if !valid_name(&name) { return Err("skill name must use lowercase letters, numbers and hyphens".to_owned()) }
    let markdown = required_string(arguments, "markdown")?; if markdown.len() < 32 || markdown.len() > 65_536 || !markdown.starts_with("---") { return Err("skill markdown must be reviewed YAML-frontmatter Skill content".to_owned()) }
    let root = root()?; if !trace_file(&root).is_file() { return Err("BILLIARDBUDDY_RECORDING_TRACE_REQUIRED".to_owned()) }
    let destination = root.parent().ok_or_else(|| "BilliardBuddy Agent runtime is invalid".to_owned())?.join("skills").join("recordings").join(&name);
    fs::create_dir_all(&destination).map_err(|error| error.to_string())?;
    let file = destination.join("SKILL.md"); let temporary = destination.join("SKILL.md.tmp"); fs::write(&temporary, markdown).map_err(|error| error.to_string())?; fs::rename(temporary, &file).map_err(|error| error.to_string())?;
    Ok(format!(r#"{{"saved":true,"name":"{}","path":"{}"}}"#, escape(&name), escape(&file.to_string_lossy())))
}

fn service_path() -> Result<PathBuf, String> { let current = env::current_exe().map_err(|error| error.to_string())?; let directory = current.parent().ok_or_else(|| "Record and Replay plugin has no executable directory".to_owned())?; let executable = if cfg!(target_os = "macos") { directory.join("BilliardBuddy Record Replay.app").join("Contents").join("MacOS").join("BilliardBuddyRecordReplayService") } else if cfg!(target_os = "windows") { directory.join("BilliardBuddyRecordReplayService.exe") } else { return Err("Record and Replay is available only on macOS and Windows".to_owned()) }; if executable.is_file() { Ok(executable) } else { Err("BilliardBuddy Record and Replay native recorder is missing from this plugin installation".to_owned()) } }
fn unix_seconds() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() }
fn valid_name(value: &str) -> bool { !value.is_empty() && value.len() <= 64 && value.as_bytes().first().is_some_and(u8::is_ascii_alphanumeric) && value.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-') }
fn tool_result(value: &str) -> String { format!(r#"{{"content":[{{"type":"text","text":"{}"}}],"isError":false}}"#, escape(value)) }
fn tool_error(value: &str) -> String { format!(r#"{{"content":[{{"type":"text","text":"{}"}}],"isError":true}}"#, escape(value)) }
fn success(id: &str, result: &str) -> String { format!(r#"{{"jsonrpc":"2.0","id":{id},"result":{result}}}"#) }
fn error(id: &str, code: i32, message: &str) -> String { format!(r#"{{"jsonrpc":"2.0","id":{id},"error":{{"code":{code},"message":"{}"}}}}"#, escape(message)) }
fn required_string(value: &str, key: &str) -> Result<String, String> { string_member(value, key).ok_or_else(|| format!("{key} must be a string")) }
fn member(value: &str, key: &str) -> Option<String> { let needle = format!(r#""{key}""#); let start = value.find(&needle)? + needle.len(); let after = value[start..].trim_start().strip_prefix(':')?.trim_start(); let end = json_end(after)?; Some(after[..end].trim().to_owned()) }
fn string_member(value: &str, key: &str) -> Option<String> { member(value, key).and_then(|raw| raw.strip_prefix('"')?.strip_suffix('"').and_then(unescape)) }
fn json_end(value: &str) -> Option<usize> { let first = *value.as_bytes().first()?; if first == b'"' { let mut escaped = false; for (index, byte) in value.bytes().enumerate().skip(1) { if escaped { escaped = false } else if byte == b'\\' { escaped = true } else if byte == b'"' { return Some(index + 1) } }; return None }; let (mut depth, mut quote, mut escaped) = (0_i32, false, false); for (index, byte) in value.bytes().enumerate() { if quote { if escaped { escaped = false } else if byte == b'\\' { escaped = true } else if byte == b'"' { quote = false }; continue } match byte { b'"' => quote = true, b'{' | b'[' => depth += 1, b'}' | b']' if depth > 0 => depth -= 1, b',' | b'}' if depth == 0 => return Some(index), _ => {} } }; Some(value.len()) }
fn unescape(value: &str) -> Option<String> { let mut output = String::new(); let mut chars = value.chars(); while let Some(character) = chars.next() { if character != '\\' { output.push(character); continue } match chars.next()? { '"' => output.push('"'), '\\' => output.push('\\'), '/' => output.push('/'), 'b' => output.push('\u{0008}'), 'f' => output.push('\u{000c}'), 'n' => output.push('\n'), 'r' => output.push('\r'), 't' => output.push('\t'), 'u' => { let code: String = (0..4).map(|_| chars.next()).collect::<Option<String>>()?; output.push(char::from_u32(u32::from_str_radix(&code, 16).ok()?)?) }, _ => return None } }; Some(output) }
fn escape(value: &str) -> String { let mut output = String::with_capacity(value.len()); for character in value.chars() { match character { '"' => output.push_str(r#"\""#), '\\' => output.push_str(r#"\\"#), '\n' => output.push_str(r#"\n"#), '\r' => output.push_str(r#"\r"#), '\t' => output.push_str(r#"\t"#), control if control.is_control() => { use std::fmt::Write; let _ = write!(output, r#"\u{:04x}"#, control as u32); }, other => output.push(other) } }; output }
