//! BilliardBuddy Record & Replay stdio MCP endpoint.
//!
//! It records only a bounded, redacted semantic event stream after an explicit
//! start. Key values, clipboard content, cookies, passwords and screen video
//! never enter the stream. The later Skill is guidance for the normal,
//! currently approved tools; this is deliberately not a coordinate macro
//! player.

use std::{
    env, fs,
    io::{self, BufRead, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const NAME: &str = "billiardbuddy-record-replay";
const VERSION: &str = env!("CARGO_PKG_VERSION");
const MAX_DURATION_SECONDS: u64 = 30 * 60;

fn main() {
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        if let Some(response) = handle(&line) {
            let response = response.replace('\n', "").replace('\r', "");
            if writeln!(stdout, "{response}").is_err() || stdout.flush().is_err() {
                break;
            }
        }
    }
}

fn handle(message: &str) -> Option<String> {
    let id = member(message, "id");
    let Some(method) = string_member(message, "method") else {
        return Some(error(
            id.as_deref().unwrap_or("null"),
            -32600,
            "invalid JSON-RPC request",
        ));
    };
    let response = match method.as_str() {
        "initialize" => success(
            id.as_deref().unwrap_or("null"),
            &format!(
                r#"{{"protocolVersion":"2025-06-18","capabilities":{{"tools":{{"listChanged":false}}}},"serverInfo":{{"name":"{NAME}","version":"{VERSION}"}}}}"#
            ),
        ),
        "ping" => success(id.as_deref().unwrap_or("null"), "{}"),
        "tools/list" => success(id.as_deref().unwrap_or("null"), tools()),
        "tools/call" => call(id.as_deref().unwrap_or("null"), message),
        "notifications/initialized" if id.is_none() => return None,
        _ => error(
            id.as_deref().unwrap_or("null"),
            -32601,
            "Record and Replay does not support this request",
        ),
    };
    Some(response)
}

fn tools() -> &'static str {
    r#"{"tools":[
 {"name":"recording_status","description":"Check whether a BilliardBuddy recording is active. This never begins recording.","inputSchema":{"type":"object","properties":{},"additionalProperties":false},"annotations":{"readOnlyHint":true,"destructiveHint":false,"openWorldHint":false}},
 {"name":"start_recording","description":"After explicit user confirmation, begin one bounded redacted semantic event stream for a stated workflow. It expires automatically within 30 minutes. A prior raw recording must be reviewed or explicitly discarded first.","inputSchema":{"type":"object","properties":{"purpose":{"type":"string","minLength":1,"maxLength":500},"maxDurationSeconds":{"type":"integer","minimum":30,"maximum":1800}},"required":["purpose"],"additionalProperties":false},"annotations":{"readOnlyHint":false,"destructiveHint":true,"openWorldHint":false}},
 {"name":"stop_recording","description":"Stop the active recording and return metadataPath and eventsPath for drafting a reviewable Skill. The stream is not a coordinate macro.","inputSchema":{"type":"object","properties":{},"additionalProperties":false},"annotations":{"readOnlyHint":false,"destructiveHint":true,"openWorldHint":false}},
 {"name":"discard_recording","description":"Stop and permanently discard the active or last unsaved recording.","inputSchema":{"type":"object","properties":{},"additionalProperties":false},"annotations":{"readOnlyHint":false,"destructiveHint":true,"openWorldHint":false}},
 {"name":"save_recorded_skill","description":"Save user-reviewed Skill Markdown generated from a stopped recording. Existing Skills are preserved unless replace=true is explicitly approved. It does not grant future desktop permissions.","inputSchema":{"type":"object","properties":{"name":{"type":"string","pattern":"^[a-z0-9][a-z0-9-]{0,63}$"},"markdown":{"type":"string","minLength":32,"maxLength":65536},"replace":{"type":"boolean","default":false}},"required":["name","markdown"],"additionalProperties":false},"annotations":{"readOnlyHint":false,"destructiveHint":true,"openWorldHint":false}}
]}"#
}

fn call(id: &str, message: &str) -> String {
    let params = member(message, "params").unwrap_or_else(|| "{}".to_owned());
    let Some(name) = string_member(&params, "name") else {
        return error(id, -32602, "tools/call requires a tool name");
    };
    let arguments = member(&params, "arguments").unwrap_or_else(|| "{}".to_owned());
    let result: Result<String, String> = match name.as_str() {
        "recording_status" => status(),
        "start_recording" => start(&arguments),
        "stop_recording" => stop(false),
        "discard_recording" => stop(true),
        "save_recorded_skill" => save_skill(&arguments),
        _ => return error(id, -32602, "unknown BilliardBuddy Record and Replay tool"),
    };
    let payload = match result {
        Ok(text) => tool_result(&text),
        Err(reason) => tool_error(&reason),
    };
    success(id, &payload)
}

fn root() -> Result<PathBuf, String> {
    env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .map(|path| path.join("record-replay"))
        .ok_or_else(|| "Record and Replay is not connected to BilliardBuddy".to_owned())
}
fn state_file(root: &Path) -> PathBuf {
    root.join("state.json")
}
fn events_file(root: &Path) -> PathBuf {
    root.join("events.jsonl")
}
fn session_file(root: &Path) -> PathBuf {
    root.join("session.json")
}
fn stop_file(root: &Path) -> PathBuf {
    root.join("stop")
}
fn active_state_json(started_at: u64, duration: u64) -> String {
    format!(r#"{{"active":true,"startedAt":{started_at},"maxDurationSeconds":{duration}}}"#)
}
fn recorder_service_arguments(root: &Path, duration: u64) -> [String; 5] {
    [
        "record".to_owned(),
        events_file(root).to_string_lossy().into_owned(),
        session_file(root).to_string_lossy().into_owned(),
        stop_file(root).to_string_lossy().into_owned(),
        duration.to_string(),
    ]
}

fn recording_active(root: &Path) -> bool {
    let Ok(state) = fs::read_to_string(state_file(root)) else {
        return false;
    };
    if member(&state, "active").as_deref() != Some("true") {
        return false;
    }
    let started_at = member(&state, "startedAt").and_then(|value| value.parse::<u64>().ok());
    let maximum = member(&state, "maxDurationSeconds").and_then(|value| value.parse::<u64>().ok());
    let still_within_deadline = started_at
        .zip(maximum)
        .is_some_and(|(started_at, maximum)| {
            unix_seconds() <= started_at.saturating_add(maximum).saturating_add(30)
        });
    if !still_within_deadline {
        // The native recorder owns the same hard deadline. State remaining
        // beyond it can only be an interrupted/stale session.
        let _ = fs::remove_file(state_file(root));
        let _ = fs::remove_file(root.join("pid"));
        let _ = fs::remove_file(stop_file(root));
    }
    still_within_deadline
}

/**
 * Do not overwrite raw semantic evidence before the native recorder has even
 * reached its explicit system confirmation. A user must first inspect/save or
 * explicitly discard the previous recording.
 */
fn prepare_recording_start(root: &Path) -> Result<(), String> {
    ensure_directory_without_symlink(root)?;
    if recording_active(root) {
        return Err("BILLIARDBUDDY_RECORDING_ALREADY_ACTIVE".to_owned());
    }
    if events_file(root).is_file() || session_file(root).is_file() {
        return Err("BILLIARDBUDDY_RECORDING_REVIEW_REQUIRED".to_owned());
    }
    let _ = fs::remove_file(stop_file(root));
    Ok(())
}

fn status() -> Result<String, String> {
    let root = root()?;
    let active = recording_active(&root);
    Ok(format!(
        r#"{{"active":{active},"recordingAvailable":{},"metadataPath":{},"eventsPath":{}}}"#,
        recording_complete(&root),
        optional_path(&session_file(&root)),
        optional_path(&events_file(&root)),
    ))
}

fn start(arguments: &str) -> Result<String, String> {
    let purpose = required_string(arguments, "purpose")?;
    if purpose.trim().is_empty() || purpose.len() > 500 {
        return Err("purpose must contain 1-500 characters".to_owned());
    }
    // The purpose proves that this is a deliberate, scoped request. It is not
    // recorder metadata and must not cross into BilliardBuddy-owned storage or
    // the native recorder's command line.
    drop(purpose);
    let duration = member(arguments, "maxDurationSeconds")
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(600)
        .clamp(30, MAX_DURATION_SECONDS);
    let root = root()?;
    prepare_recording_start(&root)?;
    let service = service_path()?;
    let started_at = unix_seconds();
    fs::write(state_file(&root), active_state_json(started_at, duration))
        .map_err(|error| error.to_string())?;
    let service_arguments = recorder_service_arguments(&root, duration);
    let mut command = Command::new(service);
    command
        .args(&service_arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    remove_sensitive_environment(&mut command);
    let mut spawned = command.spawn().map_err(|error| {
        let _ = fs::remove_file(state_file(&root));
        format!("unable to start local recorder: {error}")
    })?;
    if let Err(error) = fs::write(root.join("pid"), spawned.id().to_string()) {
        let _ = spawned.kill();
        let _ = spawned.wait();
        let _ = fs::remove_file(state_file(&root));
        let _ = fs::remove_file(stop_file(&root));
        return Err(error.to_string());
    }
    // The MCP process may stay alive for the full Agent session. Reap the
    // native recorder when it exits so a completed recording never leaves a
    // zombie child behind on Unix-like systems.
    thread::spawn(move || {
        let _ = spawned.wait();
    });
    Ok(format!(
        r#"{{"active":true,"maxDurationSeconds":{duration},"privacy":"typed text, key codes, clipboard, cookies, passwords, window titles, raw coordinates, screen video and raw screenshots are never recorded"}}"#
    ))
}

fn stop(discard: bool) -> Result<String, String> {
    let root = root()?;
    if !state_file(&root).is_file() {
        if discard {
            let _ = fs::remove_file(events_file(&root));
            let _ = fs::remove_file(session_file(&root));
            return Ok("{\"discarded\":true}".to_owned());
        };
        if recording_complete(&root) {
            return completed_recording(&root);
        }
        return Err("BILLIARDBUDDY_RECORDING_NOT_ACTIVE".to_owned());
    }
    fs::write(stop_file(&root), "stop\n").map_err(|error| error.to_string())?;
    for _ in 0..100 {
        if recording_complete(&root) {
            break;
        };
        thread::sleep(Duration::from_millis(100))
    }
    if !recording_complete(&root) {
        // Keep the stop marker and active state in place. The native recorder
        // will observe the marker or its own hard deadline and clean them up;
        // removing the marker here could let a delayed recorder continue.
        return Err("BILLIARDBUDDY_RECORDING_STOP_TIMEOUT".to_owned());
    }
    let _ = fs::remove_file(state_file(&root));
    let _ = fs::remove_file(root.join("pid"));
    let _ = fs::remove_file(stop_file(&root));
    if discard {
        let _ = fs::remove_file(events_file(&root));
        let _ = fs::remove_file(session_file(&root));
        return Ok("{\"discarded\":true}".to_owned());
    }
    completed_recording(&root)
}

fn recording_complete(root: &Path) -> bool {
    session_file(root).is_file() && events_file(root).is_file()
}

fn optional_path(path: &Path) -> String {
    if path.is_file() {
        format!("\"{}\"", escape(&path.to_string_lossy()))
    } else {
        "null".to_owned()
    }
}

fn completed_recording(root: &Path) -> Result<String, String> {
    let events = fs::metadata(events_file(root))
        .map_err(|_| "BILLIARDBUDDY_RECORDING_EVENTS_UNAVAILABLE".to_owned())?;
    if events.len() > 512 * 1024 {
        return Err("BILLIARDBUDDY_RECORDING_EVENTS_TOO_LARGE".to_owned());
    }
    let metadata = fs::metadata(session_file(root))
        .map_err(|_| "BILLIARDBUDDY_RECORDING_METADATA_UNAVAILABLE".to_owned())?;
    if metadata.len() > 64 * 1024 {
        return Err("BILLIARDBUDDY_RECORDING_METADATA_TOO_LARGE".to_owned());
    }
    Ok(format!(
        r#"{{"active":false,"metadataPath":"{}","eventsPath":"{}"}}"#,
        escape(&session_file(root).to_string_lossy()),
        escape(&events_file(root).to_string_lossy()),
    ))
}

fn save_skill(arguments: &str) -> Result<String, String> {
    let name = required_string(arguments, "name")?;
    if !valid_name(&name) {
        return Err("skill name must use lowercase letters, numbers and hyphens".to_owned());
    }
    let markdown = required_string(arguments, "markdown")?;
    if markdown.len() < 32 || markdown.len() > 65_536 || !valid_skill_frontmatter(&markdown, &name)
    {
        return Err("skill markdown must be reviewed YAML-frontmatter Skill content".to_owned());
    }
    let root = root()?;
    if !recording_complete(&root) {
        return Err("BILLIARDBUDDY_RECORDING_EVENTS_REQUIRED".to_owned());
    }
    let replace = match member(arguments, "replace").as_deref() {
        None | Some("false") => false,
        Some("true") => true,
        _ => return Err("replace must be a boolean".to_owned()),
    };
    let destination = root
        .parent()
        .ok_or_else(|| "BilliardBuddy recording storage is unavailable".to_owned())?
        .join("skills")
        .join("recordings")
        .join(&name);
    ensure_directory_without_symlink(&destination)?;
    let file = destination.join("SKILL.md");
    let file_exists = fs::symlink_metadata(&file).is_ok();
    if file_exists && !replace {
        return Err("BILLIARDBUDDY_RECORDED_SKILL_EXISTS".to_owned());
    }
    let temporary = destination.join("SKILL.md.tmp");
    let _ = fs::remove_file(&temporary);
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .and_then(|mut output| output.write_all(markdown.as_bytes()))
        .map_err(|error| error.to_string())?;
    if replace && file_exists {
        fs::remove_file(&file).map_err(|error| error.to_string())?;
    }
    fs::rename(temporary, &file).map_err(|error| error.to_string())?;
    Ok(format!(
        r#"{{"saved":true,"replaced":{replace},"name":"{}","path":"{}"}}"#,
        escape(&name),
        escape(&file.to_string_lossy())
    ))
}

fn service_path() -> Result<PathBuf, String> {
    let current = env::current_exe().map_err(|error| error.to_string())?;
    let directory = current
        .parent()
        .ok_or_else(|| "Record and Replay plugin has no executable directory".to_owned())?;
    let executable = if cfg!(target_os = "macos") {
        directory
            .join("BilliardBuddy Record Replay.app")
            .join("Contents")
            .join("MacOS")
            .join("BilliardBuddyRecordReplayService")
    } else if cfg!(target_os = "windows") {
        directory.join("BilliardBuddyRecordReplayService.exe")
    } else {
        return Err("Record and Replay is available only on macOS and Windows".to_owned());
    };
    if executable.is_file() {
        Ok(executable)
    } else {
        Err("BilliardBuddy Record and Replay is incomplete. Reinstall BilliardBuddy".to_owned())
    }
}
fn remove_sensitive_environment(command: &mut Command) {
    for (name, _) in env::vars_os() {
        let upper = name.to_string_lossy().to_ascii_uppercase();
        if ["KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL", "AUTH"]
            .iter()
            .any(|marker| upper.contains(marker))
        {
            command.env_remove(name);
        }
    }
}
fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn valid_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}
fn valid_skill_frontmatter(markdown: &str, expected_name: &str) -> bool {
    let normalized = markdown.strip_prefix("\u{feff}").unwrap_or(markdown);
    let Some(rest) = normalized.strip_prefix("---\n") else {
        return false;
    };
    let Some((frontmatter, body)) = rest.split_once("\n---\n") else {
        return false;
    };
    let mut name = None;
    let mut description = None;
    for line in frontmatter.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim().trim_matches(['\'', '"']);
        match key.trim() {
            "name" => name = Some(value),
            "description" => description = Some(value),
            _ => {}
        }
    }
    name == Some(expected_name)
        && description.is_some_and(|value| !value.is_empty() && value.len() <= 1_024)
        && !body.trim().is_empty()
}
fn ensure_directory_without_symlink(directory: &Path) -> Result<(), String> {
    if let Some(parent) = directory.parent().filter(|parent| *parent != directory) {
        ensure_directory_without_symlink(parent)?;
    }
    if directory.exists() {
        let metadata = fs::symlink_metadata(directory).map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("BILLIARDBUDDY_RECORDED_SKILL_DIRECTORY_INVALID".to_owned());
        }
        return Ok(());
    }
    fs::create_dir(directory).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        active_state_json, completed_recording, events_file, handle, member, optional_path,
        prepare_recording_start, recorder_service_arguments, session_file, tools, valid_skill_frontmatter,
    };
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn recorded_skill_requires_matching_name_description_and_body() {
        assert!(valid_skill_frontmatter(
            "---\nname: sample-flow\ndescription: Replay the reviewed workflow.\n---\n\n# Steps\n",
            "sample-flow",
        ));
        assert!(!valid_skill_frontmatter(
            "---\nname: another-flow\ndescription: Replay the reviewed workflow.\n---\n\n# Steps\n",
            "sample-flow",
        ));
        assert!(!valid_skill_frontmatter(
            "---\nname: sample-flow\n---\n\n# Steps\n",
            "sample-flow",
        ));
    }

    #[test]
    fn completed_recording_returns_paths_not_event_contents() {
        let root = std::env::temp_dir().join(format!(
            "billiardbuddy-record-replay-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        fs::create_dir_all(&root).unwrap();
        fs::write(
            events_file(&root),
            "{\"sequence\":1,\"kind\":\"pointer_click\"}\n",
        )
        .unwrap();
        fs::write(session_file(&root), "{\"version\":2,\"eventCount\":1}\n").unwrap();
        let result = completed_recording(&root).unwrap();
        assert!(result.contains("metadataPath"));
        assert!(result.contains("eventsPath"));
        assert!(!result.contains("pointer_click"));
        assert!(optional_path(&events_file(&root)).starts_with('"'));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn starting_again_preserves_reviewable_recording_until_explicit_discard() {
        let root = std::env::temp_dir().join(format!(
            "billiardbuddy-record-replay-preserve-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        fs::create_dir_all(&root).unwrap();
        fs::write(events_file(&root), "{\"sequence\":1}\n").unwrap();
        fs::write(session_file(&root), "{\"version\":2}\n").unwrap();

        assert_eq!(
            prepare_recording_start(&root).unwrap_err(),
            "BILLIARDBUDDY_RECORDING_REVIEW_REQUIRED"
        );
        assert_eq!(fs::read_to_string(events_file(&root)).unwrap(), "{\"sequence\":1}\n");
        assert_eq!(fs::read_to_string(session_file(&root)).unwrap(), "{\"version\":2}\n");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn replacement_flag_must_be_a_top_level_member() {
        let input = r#"{"markdown":"contains \"replace\": true","replace":false}"#;
        assert_eq!(member(input, "replace").as_deref(), Some("false"));
    }

    #[test]
    fn tools_call_reads_name_only_from_nested_params() {
        let request = r#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"recording_status","arguments":{"markdown":"contains \"name\":\"wrong\""}}}"#;
        let response = handle(request).expect("request must receive a response");
        assert!(!response.contains("tools/call requires a tool name"));
        assert!(response.contains(r#""id":7"#));
    }

    #[test]
    fn mutating_record_tools_explicitly_require_core_approval() {
        for name in [
            "start_recording",
            "stop_recording",
            "discard_recording",
            "save_recorded_skill",
        ] {
            let needle = format!(r#""name":"{name}""#);
            let tool = tools()
                .lines()
                .find(|line| line.contains(&needle))
                .expect("mutating Record and Replay tool must be declared");
            assert!(tool.contains(r#""readOnlyHint":false"#), "{name}");
            assert!(tool.contains(r#""destructiveHint":true"#), "{name}");
        }
    }

    #[test]
    fn recording_purpose_never_enters_recorder_state_or_child_arguments() {
        let root = std::env::temp_dir().join("billiardbuddy-record-replay-purpose-boundary");
        let state = active_state_json(1_700_000_000, 600);
        let arguments = recorder_service_arguments(&root, 600);
        assert_eq!(
            state,
            r#"{"active":true,"startedAt":1700000000,"maxDurationSeconds":600}"#
        );
        assert_eq!(
            arguments,
            [
                "record".to_owned(),
                events_file(&root).to_string_lossy().into_owned(),
                session_file(&root).to_string_lossy().into_owned(),
                root.join("stop").to_string_lossy().into_owned(),
                "600".to_owned(),
            ]
        );
    }
}
fn tool_result(value: &str) -> String {
    format!(
        r#"{{"content":[{{"type":"text","text":"{}"}}],"isError":false}}"#,
        escape(value)
    )
}
fn tool_error(value: &str) -> String {
    format!(
        r#"{{"content":[{{"type":"text","text":"{}"}}],"isError":true}}"#,
        escape(value)
    )
}
fn success(id: &str, result: &str) -> String {
    format!(r#"{{"jsonrpc":"2.0","id":{id},"result":{result}}}"#)
}
fn error(id: &str, code: i32, message: &str) -> String {
    format!(
        r#"{{"jsonrpc":"2.0","id":{id},"error":{{"code":{code},"message":"{}"}}}}"#,
        escape(message)
    )
}
fn required_string(value: &str, key: &str) -> Result<String, String> {
    string_member(value, key).ok_or_else(|| format!("{key} must be a string"))
}
fn member(value: &str, key: &str) -> Option<String> {
    let mut remainder = value.trim().strip_prefix('{')?;
    loop {
        remainder = remainder.trim_start();
        if remainder.starts_with('}') {
            return None;
        }
        if let Some(after_comma) = remainder.strip_prefix(',') {
            remainder = after_comma.trim_start();
        }
        let key_end = json_end(remainder)?;
        let member_key = remainder[..key_end]
            .strip_prefix('"')?
            .strip_suffix('"')
            .and_then(unescape)?;
        remainder = remainder[key_end..]
            .trim_start()
            .strip_prefix(':')?
            .trim_start();
        let value_end = json_end(remainder)?;
        if member_key == key {
            return Some(remainder[..value_end].trim().to_owned());
        }
        remainder = &remainder[value_end..];
    }
}
fn string_member(value: &str, key: &str) -> Option<String> {
    member(value, key).and_then(|raw| raw.strip_prefix('"')?.strip_suffix('"').and_then(unescape))
}
fn json_end(value: &str) -> Option<usize> {
    let first = *value.as_bytes().first()?;
    if first == b'"' {
        let mut escaped = false;
        for (index, byte) in value.bytes().enumerate().skip(1) {
            if escaped {
                escaped = false
            } else if byte == b'\\' {
                escaped = true
            } else if byte == b'"' {
                return Some(index + 1);
            }
        }
        return None;
    };
    let (mut depth, mut quote, mut escaped) = (0_i32, false, false);
    for (index, byte) in value.bytes().enumerate() {
        if quote {
            if escaped {
                escaped = false
            } else if byte == b'\\' {
                escaped = true
            } else if byte == b'"' {
                quote = false
            };
            continue;
        }
        match byte {
            b'"' => quote = true,
            b'{' | b'[' => depth += 1,
            b'}' | b']' if depth > 0 => depth -= 1,
            b',' | b'}' if depth == 0 => return Some(index),
            _ => {}
        }
    }
    Some(value.len())
}
fn unescape(value: &str) -> Option<String> {
    let mut output = String::new();
    let mut chars = value.chars();
    while let Some(character) = chars.next() {
        if character != '\\' {
            output.push(character);
            continue;
        }
        match chars.next()? {
            '"' => output.push('"'),
            '\\' => output.push('\\'),
            '/' => output.push('/'),
            'b' => output.push('\u{0008}'),
            'f' => output.push('\u{000c}'),
            'n' => output.push('\n'),
            'r' => output.push('\r'),
            't' => output.push('\t'),
            'u' => {
                let code: String = (0..4).map(|_| chars.next()).collect::<Option<String>>()?;
                output.push(char::from_u32(u32::from_str_radix(&code, 16).ok()?)?)
            }
            _ => return None,
        }
    }
    Some(output)
}
fn escape(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '"' => output.push_str(r#"\""#),
            '\\' => output.push_str(r#"\\"#),
            '\n' => output.push_str(r#"\n"#),
            '\r' => output.push_str(r#"\r"#),
            '\t' => output.push_str(r#"\t"#),
            control if control.is_control() => {
                use std::fmt::Write;
                let _ = write!(output, r#"\u{:04x}"#, control as u32);
            }
            other => output.push(other),
        }
    }
    output
}
