use std::collections::BTreeMap;

use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::{
    models::SavedConnection, remote::RemoteCommandExecutor, ssh::validate_systemd_unit_id,
};

const TEXT_LIMIT: usize = 128 * 1024;
const PROPERTIES: &str = "Id,Description,LoadState,ActiveState,SubState,UnitFileState,FragmentPath,SourcePath,DropInPaths,NeedDaemonReload,Requires,Wants,RequiredBy,WantedBy,After,Before,Triggers,TriggeredBy,MainPID,ControlPID,Type,Result,ExecMainCode,ExecMainStatus,ExecMainStartTimestamp,ExecMainExitTimestamp,ActiveEnterTimestamp,ActiveEnterTimestampMonotonic,Restart,NRestarts,MemoryCurrent,CPUUsageNSec,TasksCurrent,ExecStart,StatusText,ConditionResult,AssertResult,NextElapseUSecRealtime,NextElapseUSecMonotonic,LastTriggerUSec,TimersCalendar,TimersMonotonic,Unit,Listen,Accept,NAccepted,NConnections,Where,What,Options";

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UnitReadSection {
    Properties,
    Configuration,
    EffectiveConfiguration,
    Journal,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitInspection {
    id: String,
    pub properties: BTreeMap<String, String>,
    text: String,
    warnings: Vec<String>,
    truncated: bool,
    collected_at: String,
}

fn command(unit: &str, section: UnitReadSection) -> Result<String, String> {
    let unit = validate_systemd_unit_id(unit)?;
    // Validation excludes quotes and shell syntax; single quotes preserve the
    // literal backslash in systemd's escaped mount and instance names.
    Ok(match section {
        UnitReadSection::Properties => format!(
            "LC_ALL=C TZ=UTC SYSTEMD_COLORS=0 systemctl show --all --no-pager --property={PROPERTIES} -- '{unit}'; cr_status=$?; if [ \"$cr_status\" -eq 0 ]; then printf '\\nControlRoomRealtimeSeconds='; date +%s 2>/dev/null || printf '\\n'; fi; exit \"$cr_status\""
        ),
        UnitReadSection::Configuration => {
            format!("LC_ALL=C SYSTEMD_COLORS=0 systemctl cat --no-pager -- '{unit}'")
        }
        UnitReadSection::EffectiveConfiguration => {
            format!("LC_ALL=C SYSTEMD_COLORS=0 systemctl show --all --no-pager -- '{unit}'")
        }
        UnitReadSection::Journal => format!(
            "LC_ALL=C journalctl --no-pager --quiet --output=short-iso --lines=40 --unit='{unit}'"
        ),
    })
}

pub fn inspect(
    connection: &SavedConnection,
    unit: &str,
    section: UnitReadSection,
) -> Result<UnitInspection, String> {
    let command = command(unit, section)?;
    let output = RemoteCommandExecutor::execute(connection, "inspect_systemd_unit", &command)?;
    let warnings = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let text = output.success_text()?;
    Ok(parse(unit, section, text, warnings))
}

fn parse(
    unit: &str,
    section: UnitReadSection,
    mut text: String,
    warning: String,
) -> UnitInspection {
    let truncated = text.len() > TEXT_LIMIT;
    if truncated {
        let mut end = TEXT_LIMIT;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
        // Never present a cut property as complete dependency evidence.
        if matches!(section, UnitReadSection::Properties) {
            text.truncate(text.rfind('\n').unwrap_or(0));
        }
    }
    let mut properties = BTreeMap::new();
    if matches!(section, UnitReadSection::Properties) {
        for line in text.lines() {
            if let Some((key, value)) = line.split_once('=')
                && (PROPERTIES.split(',').any(|allowed| allowed == key)
                    || key == "ControlRoomRealtimeSeconds")
            {
                properties.insert(key.to_string(), value.to_string());
            }
        }
        text.clear();
    }
    UnitInspection {
        id: unit.to_string(),
        properties,
        text,
        warnings: if warning.is_empty() {
            Vec::new()
        } else {
            vec![warning]
        },
        truncated,
        collected_at: Utc::now().to_rfc3339(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn systemd_reads_validate_names_and_preserve_literal_escapes() {
        for section in [
            UnitReadSection::Properties,
            UnitReadSection::Configuration,
            UnitReadSection::EffectiveConfiguration,
            UnitReadSection::Journal,
        ] {
            for invalid in [
                "nginx;reboot.service",
                "$(id).service",
                "bad'unit.service",
                "x\ny.service",
                "*.service",
            ] {
                assert!(command(invalid, section).is_err());
            }
            let read = command(r"srv-data\x2darchive.mount", section).unwrap();
            assert!(read.contains(r"'srv-data\x2darchive.mount'"));
            for mutation in [
                " start ",
                " stop ",
                " restart ",
                " enable ",
                " disable ",
                "daemon-reload",
            ] {
                assert!(!read.contains(mutation));
            }
        }
        assert!(
            command("-test.service", UnitReadSection::Properties)
                .unwrap()
                .contains("-- '-test.service'")
        );
        assert!(
            command("ssh.service", UnitReadSection::Journal)
                .unwrap()
                .contains("--lines=40")
        );
    }

    #[test]
    fn systemd_properties_preserve_evidence_and_missing_values() {
        let result = parse("ssh.service", UnitReadSection::Properties,
            "Id=ssh.service\nRequires=network.target\nAfter=network.target\nRequiredBy=multi-user.target\nExecStart={ argv[]=echo a=b ; }\nMemoryCurrent=18446744073709551615\nDropInPaths=\nUnknown=ignored\n".into(), "Some properties unavailable".into());
        assert_eq!(result.properties["Requires"], "network.target");
        assert_eq!(result.properties["After"], "network.target");
        assert_eq!(result.properties["ExecStart"], "{ argv[]=echo a=b ; }");
        assert!(!result.properties.contains_key("MainPID"));
        assert!(!result.properties.contains_key("Unknown"));
        assert_eq!(result.properties["DropInPaths"], "");
        assert_eq!(result.warnings.len(), 1);
    }

    #[test]
    fn systemd_large_reads_are_explicitly_truncated_at_utf8_boundaries() {
        let result = parse(
            "x.service",
            UnitReadSection::Journal,
            "é".repeat(TEXT_LIMIT),
            String::new(),
        );
        assert!(result.truncated);
        assert!(result.text.len() <= TEXT_LIMIT);
        let result = parse(
            "x.service",
            UnitReadSection::Properties,
            format!("Id=x.service\nRequires={}\n", "x".repeat(TEXT_LIMIT)),
            String::new(),
        );
        assert!(result.truncated);
        assert!(!result.properties.contains_key("Requires"));
    }
}
