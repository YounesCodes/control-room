use std::{fs, path::PathBuf};

use ts_rs::{Config, TS};

use crate::{
    database::{
        MAX_HISTORY_COMMAND_BYTES, MAX_HISTORY_CWD_BYTES, MAX_SCRATCHPAD_CHARS,
        PERSISTED_WORKSPACE_VIEWS, SCRATCHPAD_SCOPES,
    },
    fonts::{CatalogFont, FontCatalog, FontProgress},
    history::IntegrationStatus,
    models::*,
    remote::{COMMAND_TIMEOUT, MAX_STRUCTURED_QUEUE_WAIT},
    systemd::{UnitInspection, UnitReadSection},
    updater::{
        AppUpdateInfo, PendingUpdateNotice, UpdateFailure, UpdateFailureKind, UpdateProgress,
    },
    windows_inspection::WindowsService,
    windows_ssh::{RemoteShellCatalog, RemoteShellProfile},
};

const GENERATED_FILE: &str = "src/generated/ipc.ts";
const REGENERATE_COMMAND: &str = "npm run generate:ipc";

fn declarations(config: &Config) -> Vec<String> {
    vec![
        SavedConnection::decl(config),
        SavedConnectionInput::decl(config),
        ConnectionGroup::decl(config),
        ConnectionTag::decl(config),
        HostCapabilities::decl(config),
        RemoteShellProfile::decl(config),
        RemoteShellCatalog::decl(config),
        HostResources::decl(config),
        SystemdUnit::decl(config),
        UnitReadSection::decl(config),
        UnitInspection::decl(config),
        WindowsService::decl(config),
        DockerContainer::decl(config),
        DockerContainerDetails::decl(config),
        DockerPublishedPort::decl(config),
        DockerNetworkAttachment::decl(config),
        DockerMount::decl(config),
        ListeningSocket::decl(config),
        FirewallRule::decl(config),
        FirewallStatus::decl(config),
        PacketFilterStatus::decl(config),
        ConnectionRemote::decl(config),
        ConnectionSummary::decl(config),
        EstablishedConnections::decl(config),
        IntegrationStatus::decl(config),
        HistoryEntry::decl(config),
        HistoryInput::decl(config),
        HeaderMetric::decl(config),
        HeaderMetrics::decl(config),
        AppSettings::decl(config),
        SettingsContract::decl(config),
        AppUpdateInfo::decl(config),
        PendingUpdateNotice::decl(config),
        UpdateFailureKind::decl(config),
        UpdateFailure::decl(config),
        UpdateProgress::decl(config),
        EnvironmentInfo::decl(config),
        LocalShellKind::decl(config),
        LocalShellProfile::decl(config),
        AdministratorTerminalStatus::decl(config),
        LocalShellCatalog::decl(config),
        SessionStarted::decl(config),
        LocalSessionStarted::decl(config),
        SessionState::decl(config),
        SessionEndCategory::decl(config),
        SessionStateEvent::decl(config),
        StreamStarted::decl(config),
        StreamState::decl(config),
        StreamStateEvent::decl(config),
        StreamNotice::decl(config),
        StreamNoticeEvent::decl(config),
        ContainerTerminalTarget::decl(config),
        PersistedWorkspace::decl(config),
        PersistedWorkspaceState::decl(config),
        PersistedTerminalGroup::decl(config),
        PersistedTerminalLayout::decl(config),
        ScratchpadNote::decl(config),
        ScratchpadNoteInput::decl(config),
        CatalogFont::decl(config),
        FontCatalog::decl(config),
        FontProgress::decl(config),
    ]
}

fn literal_union(name: &str, values: &[&str]) -> String {
    let members = values
        .iter()
        .map(|value| format!("\"{value}\""))
        .collect::<Vec<_>>()
        .join(" | ");
    format!("type {name} = {members};")
}

fn without_doc_comments(declaration: &str) -> String {
    let mut output = String::new();
    let mut rest = declaration;
    while let Some(start) = rest.find("/**") {
        output.push_str(&rest[..start]);
        let end = start + rest[start..].find("*/").expect("closed doc comment") + 2;
        rest = &rest[end..];
    }
    output.push_str(rest);
    output.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn one_field_per_line(declaration: &str) -> String {
    let Some((head, body)) = declaration.split_once(" = { ") else {
        return declaration.to_owned();
    };
    let Some(body) = body.strip_suffix(", };") else {
        return declaration.to_owned();
    };
    let mut fields = Vec::new();
    let mut depth = 0_i32;
    let mut start = 0;
    for (index, character) in body.char_indices() {
        match character {
            '{' | '<' | '(' | '[' => depth += 1,
            '}' | '>' | ')' | ']' => depth -= 1,
            ',' if depth == 0 => {
                fields.push(body[start..index].trim());
                start = index + 1;
            }
            _ => {}
        }
        if depth < 0 {
            return declaration.to_owned();
        }
    }
    fields.push(body[start..].trim());
    let mut output = format!("{head} = {{\n");
    for field in fields {
        output.push_str(&format!("  {field};\n"));
    }
    output.push_str("};");
    output
}

fn render() -> String {
    let config = Config::new().with_large_int("number");
    let mut declarations = declarations(&config);
    declarations.push(literal_union("ScratchpadScope", &SCRATCHPAD_SCOPES));
    declarations.push(literal_union(
        "PersistedWorkspaceView",
        &PERSISTED_WORKSPACE_VIEWS,
    ));
    let constants = [
        ("MAX_SCRATCHPAD_CHARS", MAX_SCRATCHPAD_CHARS as u64),
        (
            "MAX_HISTORY_COMMAND_BYTES",
            MAX_HISTORY_COMMAND_BYTES as u64,
        ),
        ("MAX_HISTORY_CWD_BYTES", MAX_HISTORY_CWD_BYTES as u64),
        ("REMOTE_COMMAND_TIMEOUT_SECONDS", COMMAND_TIMEOUT.as_secs()),
        (
            "REMOTE_QUEUE_WAIT_SECONDS",
            MAX_STRUCTURED_QUEUE_WAIT.as_secs(),
        ),
    ];
    let mut output = String::new();
    for declaration in declarations {
        output.push_str("export ");
        output.push_str(&one_field_per_line(&without_doc_comments(&declaration)));
        output.push_str("\n\n");
    }
    for (name, value) in constants {
        output.push_str(&format!("export const {name} = {value};\n"));
    }
    output
}

fn generated_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join(GENERATED_FILE)
}

#[test]
fn generated_typescript_matches_the_rust_ipc_contract() {
    let expected = render();
    let path = generated_path();
    if std::env::var_os("CONTROL_ROOM_WRITE_IPC_TYPES").is_some() {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, &expected).unwrap();
        return;
    }
    let committed = fs::read_to_string(&path)
        .unwrap_or_default()
        .replace("\r\n", "\n");
    assert!(
        committed == expected,
        "{GENERATED_FILE} does not match the Rust IPC models. Run `{REGENERATE_COMMAND}`, \
         commit the result, then fix any TypeScript errors `npm run build` reports."
    );
}
