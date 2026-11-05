//! Additional baseline evidence. Every command is a bounded read and projects
//! allowlisted fields before returning data to the client.
use crate::{
    models::{BaselineEntry, BaselineFact, BaselineSection, SavedConnection},
    remote::{Elevation, RemoteCommandExecutor},
};
use chrono::Utc;
use std::collections::BTreeMap;

const MAX_ENTRIES: usize = 1000;
const MAX_FACTS: usize = 48;

pub fn read(
    connection: &SavedConnection,
    elevation: &Elevation,
    kind: &str,
    script: &str,
) -> BaselineSection {
    let command = format!(
        "env LC_ALL=C sh -c '{}'",
        format!("PATH=$PATH:/usr/sbin:/sbin; export PATH; {script}").replace('\'', "'\"'\"'")
    );
    let result = RemoteCommandExecutor::execute_elevated(
        connection,
        "baseline_evidence",
        &command,
        elevation,
    )
    .and_then(|output| output.success_text());
    match result {
        Ok(text) => parse(kind, &text),
        Err(error) => BaselineSection {
            kind: kind.into(),
            status: "unavailable".into(),
            schema_version: crate::baselines::section_schema_version(kind),
            collected_at: Utc::now().to_rfc3339(),
            message: Some(error),
            entries: vec![],
        },
    }
}

fn parse(kind: &str, text: &str) -> BaselineSection {
    let mut entries = BTreeMap::<String, BaselineEntry>::new();
    let mut gaps = Vec::<String>::new();
    let mut done = false;
    let mut unsupported = false;
    for line in text.lines() {
        if line == "__CR_UNSUPPORTED__" {
            unsupported = true;
            continue;
        }
        if line == "__CR_DONE__" {
            done = true;
            continue;
        }
        if let Some(message) = line.strip_prefix("__CR_GAP__\t") {
            if gaps.len() < 12 {
                gaps.push(message.chars().take(200).collect());
            }
            continue;
        }
        let fields = line.splitn(3, '\t').collect::<Vec<_>>();
        if fields.len() != 3
            || fields
                .iter()
                .any(|value| value.is_empty() || value.chars().any(char::is_control))
        {
            if !line.is_empty() && gaps.len() < 12 {
                gaps.push("Some evidence rows could not be read.".into());
            }
            continue;
        }
        if entries.len() >= MAX_ENTRIES && !entries.contains_key(fields[0]) {
            if gaps.is_empty() {
                gaps.push(format!("Evidence is limited to {MAX_ENTRIES} resources."));
            }
            continue;
        }
        if fields[0].len() > 512 || fields[1].len() > 128 || fields[2].len() > 16 * 1024 {
            if gaps.is_empty() {
                gaps.push(
                    "Some evidence exceeded the 16 KiB fact limit or identity limits.".into(),
                );
            }
            continue;
        }
        let entry = entries
            .entry(fields[0].into())
            .or_insert_with(|| BaselineEntry {
                identity: fields[0].into(),
                label: fields[0].into(),
                facts: vec![],
            });
        if entry.facts.len() >= MAX_FACTS || entry.facts.iter().any(|fact| fact.name == fields[1]) {
            if gaps.is_empty() {
                gaps.push("Duplicate or excessive facts made this evidence incomplete.".into());
            }
            continue;
        }
        entry.facts.push(BaselineFact {
            name: fields[1].into(),
            value: fields[2].into(),
        });
    }
    if !done {
        gaps.push("The evidence read did not finish.".into());
    }
    BaselineSection {
        kind: kind.into(),
        status: if unsupported {
            "unsupported"
        } else if gaps.is_empty() {
            "collected"
        } else if entries.is_empty() {
            "unavailable"
        } else {
            "partial"
        }
        .into(),
        schema_version: crate::baselines::section_schema_version(kind),
        collected_at: Utc::now().to_rfc3339(),
        message: (!gaps.is_empty()).then(|| gaps.join(" ")),
        entries: entries.into_values().collect(),
    }
}

pub fn merge(mut primary: BaselineSection, extra: BaselineSection) -> BaselineSection {
    if extra.status != "collected" && primary.status == "collected" {
        primary.status = "partial".into();
    }
    if !extra.entries.is_empty()
        && (primary.status == "unavailable" || primary.status == "unsupported")
    {
        primary.status = "partial".into();
    }
    if let Some(message) = extra.message {
        primary.message = Some(match primary.message {
            Some(existing) => format!("{existing} {message}"),
            None => message,
        });
    }
    for addition in extra.entries {
        if let Some(entry) = primary
            .entries
            .iter_mut()
            .find(|entry| entry.identity == addition.identity)
        {
            for fact in addition.facts {
                if !entry
                    .facts
                    .iter()
                    .any(|existing| existing.name == fact.name)
                {
                    entry.facts.push(fact);
                }
            }
        } else {
            primary.entries.push(addition);
        }
    }
    primary
}

pub const CONFIGURATION: &str = r#"
gap() { printf '__CR_GAP__\t%s\n' "$1"; }
if command -v sshd >/dev/null 2>&1; then
  data=$(sshd -T 2>/dev/null)
  if test $? -eq 0; then
    printf '%s\n' "$data" | awk '$1 ~ /^(permitrootlogin|passwordauthentication|pubkeyauthentication|kbdinteractiveauthentication|permitemptypasswords|x11forwarding|allowtcpforwarding|gatewayports|maxauthtries|logingracetime|strictmodes|usepam)$/ {print "sshd\t" $1 "\t" $2}'
  else gap 'Effective sshd settings were not readable.'; fi
else printf 'sshd\treadStatus\tnot present\n'; fi
for key in net.ipv4.ip_forward net.ipv4.conf.all.rp_filter net.ipv4.conf.all.accept_redirects net.ipv6.conf.all.forwarding net.ipv6.conf.all.accept_redirects kernel.randomize_va_space kernel.kptr_restrict kernel.dmesg_restrict fs.protected_hardlinks fs.protected_symlinks; do
  path=/proc/sys/$(printf '%s' "$key" | tr . /)
  if test -r "$path"; then
    value=$(cat "$path" 2>/dev/null)
    case "$value" in ''|*[!0-9]*) gap 'A selected sysctl value was not readable.' ;; *) printf 'sysctl\t%s\t%s\n' "$key" "$value" ;; esac
  else gap 'Some selected sysctl keys are unavailable on this kernel.'; fi
done
if command -v getent >/dev/null 2>&1; then
  for group in sudo wheel docker adm; do
    record=$(getent group "$group")
    test -n "$record" || continue
    gid=$(printf '%s\n' "$record" | cut -d: -f3)
    members=$({ printf '%s\n' "$record" | cut -d: -f4 | tr , '\n'; getent passwd | awk -F: -v gid="$gid" '$4 == gid {print $1}'; } | sed '/^$/d' | sort -u | paste -sd , -)
    test -n "$members" || members=none
    printf 'group/%s\tmembers\t%s\n' "$group" "$members"
  done
  users=$(getent passwd | awk -F: '$3 == 0 {print $1}' | sort -u | paste -sd , -)
  test -z "$users" || printf 'privileged accounts\tuid0Users\t%s\n' "$users"
else gap 'Privileged group membership could not be read.'; fi
if test -e /etc/docker/daemon.json; then
  if test -r /etc/docker/daemon.json && command -v jq >/dev/null 2>&1; then
    data=$(jq -r 'to_entries[] | select(.key == "live-restore" or .key == "userland-proxy" or .key == "icc" or .key == "ip-forward" or .key == "iptables" or .key == "ip6tables" or .key == "no-new-privileges") | select(.value | type == "boolean") | ["Docker daemon", .key, (.value|tostring)] | @tsv' /etc/docker/daemon.json 2>/dev/null)
    if test $? -eq 0; then printf '%s\n' "$data"; else gap 'Docker daemon options could not be parsed.'; fi
  else gap 'Docker daemon options need a readable config and jq.'; fi
else printf 'Docker daemon\tconfiguration\tno daemon.json recorded\n'; fi
printf '__CR_DONE__\n'
"#;

pub const SYSTEMD: &str = r#"
data=$(systemctl show --type=service,timer,mount,socket --all --no-pager --property=Id,FragmentPath,DropInPaths,Requires,Wants,After,Before,OnFailure,Triggers,TimersCalendar,Persistent,WakeSystem,AccuracyUSec,RandomizedDelayUSec 2>/dev/null)
if test $? -ne 0; then printf '__CR_GAP__\tPersistent unit and timer settings were not readable.\n'
else
  printf '%s\n' "$data" | awk -F= '
    function emit() {if (id != "") for (key in values) if (values[key] != "") printf "%s\t%s\t%s\n", id, key, values[key]; delete values; id=""}
    /^$/ {emit(); next}
    $1 == "Id" {id=substr($0,4); next}
    {value=substr($0,index($0,"=")+1); if ($1 == "TimersCalendar") gsub(/; next_elapse=[^}]*}/,"}",value); values[$1]=value}
    END {emit()}'
fi
printf '__CR_DONE__\n'
"#;

pub const STORAGE: &str = r#"
if test -r /etc/fstab; then
 awk '
 /^[[:space:]]*($|#)/ {next}
 NF >= 6 {
   src=$1
   if (src !~ /^(UUID=|PARTUUID=|LABEL=|PARTLABEL=|\/dev\/)/ || src ~ /[@,]/) src="source redacted"
   options=""; n=split($4,a,",")
   for(i=1;i<=n;i++) if(a[i] ~ /^(defaults|ro|rw|nofail|noauto|nosuid|nodev|noexec|bind|rbind|_netdev)$/) options=options (options==""?"":",") a[i]
   if(options=="") options="no allowlisted options"
   printf "fstab/%s\tsource\t%s\nfstab/%s\ttype\t%s\nfstab/%s\toptions\t%s\nfstab/%s\tpass\t%s\n", $2,src,$2,$3,$2,options,$2,$6
 }' /etc/fstab
else printf '__CR_GAP__\tPersistent mount configuration was not readable.\n'; fi
if command -v findmnt >/dev/null 2>&1; then
 data=$(findmnt -rn -o TARGET,SOURCE 2>/dev/null)
 if test $? -eq 0; then
   printf '%s\n' "$data" | awk '$2 ~ /^\/dev\// && $2 !~ /[@,]/ {printf "%s\tsource\t%s\n",$1,$2}'
 else printf '__CR_GAP__\tMounted device identities were not readable.\n'; fi
else printf '__CR_GAP__\tfindmnt is unavailable for mounted device identities.\n'; fi
printf '__CR_DONE__\n'
"#;

pub const NETWORK: &str = r#"
if command -v ip >/dev/null 2>&1; then
 data=$(ip -o link show 2>/dev/null)
 if test $? -eq 0; then
  printf '%s\n' "$data" | awk '{name=$2; sub(/:$/,"",name); sub(/@.*/,"",name); for(i=3;i<NF;i++) {if($i=="mtu") printf "interface/%s\tmtu\t%s\n",name,$(i+1); if($i=="link/ether") printf "interface/%s\tmacAddress\t%s\n",name,$(i+1)}}'
 else printf '__CR_GAP__\tNetwork interfaces were not readable.\n'; fi
 for family in -4 -6; do
   data=$(ip "$family" route show default 2>/dev/null)
   if test $? -eq 0; then
     printf '%s\n' "$data" | awk -v family="$family" 'NF {gateway="direct"; dev="unknown"; metric="0"; for(i=1;i<NF;i++){if($i=="via")gateway=$(i+1); if($i=="dev")dev=$(i+1); if($i=="metric")metric=$(i+1)}; id="default route/" family "/" dev "/" NR; printf "%s\tgateway\t%s\n%s\tinterface\t%s\n%s\tmetric\t%s\n",id,gateway,id,dev,id,metric}'
   else printf '__CR_GAP__\tA default route table was not readable.\n'; fi
 done
else printf '__CR_GAP__\tip is unavailable for interface and route evidence.\n'; fi
printf '__CR_DONE__\n'
"#;

pub const PACKAGE_HISTORY: &str = r#"
if test -f /var/log/dpkg.log; then
 if test -r /var/log/dpkg.log; then
  tail -n 1000 /var/log/dpkg.log | awk '$3 ~ /^(install|upgrade|remove|purge)$/ && NF == 6 {base="package transaction/" $1 " " $2 "/" $3 "/" $4; id=base "/" ++seen[base]; printf "%s\tobservedLogTime\t%s %s\n%s\taction\t%s\n%s\tpackage\t%s\n%s\tpreviousVersion\t%s\n%s\tversion\t%s\n",id,$1,$2,id,$3,id,$4,id,$5,id,$6}'
  printf 'package history\tcoverage\tEvents in the last 1000 lines of the current dpkg log; timestamps use the host log timezone.\n'
 else printf '__CR_GAP__\tThe dpkg transaction log was not readable.\n'; fi
else printf 'package history\tcoverage\tNo supported trustworthy transaction log recorded; last update unknown.\n'; fi
printf '__CR_DONE__\n'
"#;

pub const FIREWALL: &str = r#"
emit_rules() {
  awk -v backend="$1" '
    /^#/ || /^[[:space:]]*$/ {next}
    /--comment|--log-prefix|log prefix=/ {print "__CR_GAP__\tRules containing free-text annotations were omitted."; next}
    {sub(/[[:space:]]+#.*/,""); gsub(/\[[0-9]+:[0-9]+\]/,"[counters omitted]"); printf "firewall/%s/rule/%04d\trule\t%s\n",backend,++n,$0}'
}
gap() { printf '__CR_GAP__\t%s\n' "$1"; }
if command -v ufw >/dev/null 2>&1; then
  data=$(ufw status verbose 2>/dev/null)
  if test $? -eq 0; then printf 'firewall configuration\tbackend\tufw\n'; printf '%s\n' "$data" | emit_rules ufw
  else gap 'UFW policy and rules were not readable.'; fi
elif command -v firewall-cmd >/dev/null 2>&1; then
  if firewall-cmd --state >/dev/null 2>&1; then
    printf 'firewall configuration\tbackend\tfirewalld\nfirewall configuration\tactive\tyes\n'
    data=$(firewall-cmd --list-all-zones 2>/dev/null)
    if test $? -eq 0; then printf '%s\n' "$data" | emit_rules firewalld
    else gap 'Firewalld zones were not readable.'; fi
    policies=$(firewall-cmd --get-policies 2>/dev/null)
    if test $? -eq 0; then
      for policy in $policies; do
        data=$(firewall-cmd --info-policy="$policy" 2>/dev/null)
        if test $? -eq 0; then printf '%s\n' "$data" | emit_rules "firewalld-policy-$policy"
        else gap 'A firewalld policy was not readable.'; fi
      done
    else gap 'This firewalld version does not expose policy evidence.'; fi
  else
    state=$(firewall-cmd --state 2>/dev/null); code=$?
    if test "$code" -eq 252; then printf 'firewall configuration\tbackend\tfirewalld\nfirewall configuration\tactive\tno\n'
    else gap 'Firewalld state was not readable.'; fi
  fi
elif command -v nft >/dev/null 2>&1; then
  if command -v jq >/dev/null 2>&1; then
    data=$(nft -j -s list ruleset 2>/dev/null)
    if test $? -eq 0; then
      rules=$(printf '%s\n' "$data" | jq -c 'walk(if type == "object" then del(.handle,.packets,.bytes,.comment,.prefix) else . end) | .nftables[] | select(has("metainfo")|not)' 2>/dev/null)
      if test $? -eq 0; then printf 'firewall configuration\tbackend\tnftables\n'; printf '%s\n' "$rules" | emit_rules nftables
      else gap 'nftables rules could not be parsed.'; fi
    else gap 'nftables rules were not readable.'; fi
  else gap 'nftables rule inspection requires jq on the host.'; fi
elif command -v iptables-save >/dev/null 2>&1; then
  printf 'firewall configuration\tbackend\tiptables\n'
  data=$(iptables-save 2>/dev/null)
  if test $? -eq 0; then printf '%s\n' "$data" | emit_rules iptables
  else gap 'IPv4 firewall rules were not readable.'; fi
  if command -v ip6tables-save >/dev/null 2>&1; then
    data=$(ip6tables-save 2>/dev/null)
    if test $? -eq 0; then printf '%s\n' "$data" | emit_rules ip6tables
    else gap 'IPv6 firewall rules were not readable.'; fi
  else gap 'IPv6 firewall rule inspection is unavailable.'; fi
else printf '__CR_UNSUPPORTED__\n'; fi
printf '__CR_DONE__\n'
"#;

const DOCKER: &str = r#"
ids=$(docker ps -aq --no-trunc 2>/dev/null)
if test $? -ne 0; then printf '__CR_GAP__\tContainer configuration was not readable.\n'; printf '__CR_DONE__\n'; exit; fi
count=$(printf '%s\n' "$ids" | sed '/^$/d' | wc -l)
if test "$count" -gt 200; then printf '__CR_GAP__\tDetailed container evidence is limited to 200 containers.\n'; fi
ids=$(printf '%s\n' "$ids" | sed '/^$/d' | head -n 200)
if test -n "$ids"; then
 docker inspect --type container --format '{"id":{{json .Id}},"name":{{json .Name}},"imageContentId":{{json .Image}},"restartPolicy":{{json .HostConfig.RestartPolicy}},"portBindings":{{json .HostConfig.PortBindings}},"mounts":{{json .Mounts}},"networks":{{json .NetworkSettings.Networks}},"memoryLimit":{{json .HostConfig.Memory}},"nanoCpus":{{json .HostConfig.NanoCpus}},"readOnlyRootfs":{{json .HostConfig.ReadonlyRootfs}}}' -- $ids 2>/dev/null || printf '__CR_GAP__\tSome container configurations were not readable.\n'
fi
printf '__CR_DONE__\n'
"#;

pub fn docker(connection: &SavedConnection, elevation: &Elevation) -> BaselineSection {
    let command = format!("env LC_ALL=C sh -c '{}'", DOCKER.replace('\'', "'\"'\"'"));
    match RemoteCommandExecutor::execute_elevated(
        connection,
        "baseline_container_config",
        &command,
        elevation,
    )
    .and_then(|output| output.success_text())
    {
        Ok(text) => parse_docker(&text),
        Err(error) => parse("containers", &format!("__CR_GAP__\t{error}\n__CR_DONE__\n")),
    }
}

fn parse_docker(text: &str) -> BaselineSection {
    let mut records = String::new();
    for line in text.lines() {
        if line.starts_with("__CR_") {
            records.push_str(line);
            records.push('\n');
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            records.push_str("__CR_GAP__\tA container config could not be parsed.\n");
            continue;
        };
        let Some(name) = value.get("name").and_then(serde_json::Value::as_str) else {
            records.push_str("__CR_GAP__\tA container identity was missing.\n");
            continue;
        };
        let name = name.trim_start_matches('/');
        for key in [
            "imageContentId",
            "restartPolicy",
            "portBindings",
            "mounts",
            "networks",
            "memoryLimit",
            "nanoCpus",
            "readOnlyRootfs",
        ] {
            if let Some(value) = value.get(key) {
                let normalized = if key == "mounts" {
                    let mut mounts = value.as_array().cloned().unwrap_or_default();
                    mounts.sort_by_key(serde_json::Value::to_string);
                    serde_json::Value::Array(mounts).to_string()
                } else if key == "networks" {
                    value
                        .as_object()
                        .map(|networks| networks.keys().cloned().collect::<Vec<_>>().join(", "))
                        .unwrap_or_default()
                } else if let Some(text) = value.as_str() {
                    text.to_string()
                } else {
                    value.to_string()
                };
                if !normalized.is_empty() {
                    records.push_str(&format!("{name}\t{key}\t{normalized}\n"));
                }
            }
        }
    }
    parse("containers", &records)
}

pub const PACKAGES: &str = r#"
LC_ALL=C
export LC_ALL
if command -v dpkg-query >/dev/null 2>&1; then
 printf '__CR_PKGMGR__\tdpkg\n'
 data=$(dpkg-query -W -f='${db:Status-Status}\t${Package}\t${Architecture}\t${Version}\n' 2>/dev/null) || exit $?
 printf '%s\n' "$data" | awk -F'\t' '$1 == "installed" {print $2 "\t" $3 "\t" $4}' | sort
elif command -v rpm >/dev/null 2>&1; then
 printf '__CR_PKGMGR__\trpm\n'
 data=$(rpm -qa --qf '%{NAME}\t%{ARCH}\t%{EPOCHNUM}:%{VERSION}-%{RELEASE}\n' 2>/dev/null) || exit $?
 printf '%s\n' "$data" | sed '/^$/d' | sort
else
 printf '__CR_PKGMGR__\tnone\n'
fi
"#;

pub fn packages_command() -> String {
    let bound = r#"awk -F'\t' '/^__CR_/ {print; next} {if (NF == 3 && n < 5000) {print; n++} if(NF == 3) total++} END {printf "__CR_PKGCOUNT__\t%d\n", total}'"#;
    let script = format!("( {PACKAGES} ) || printf '__CR_PACKAGE_FAILED__\\n'");
    let script = format!("{{ {script}; }} | {bound}");
    format!("env LC_ALL=C sh -c '{}'", script.replace('\'', "'\"'\"'"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn evidence_completion_and_duplicate_facts_are_honest() {
        assert_eq!(
            parse("test", "thing\tkey\tvalue\n__CR_DONE__\n").status,
            "collected"
        );
        assert_eq!(parse("test", "thing\tkey\tvalue\n").status, "partial");
        let duplicate = parse("test", "thing\tkey\tone\nthing\tkey\ttwo\n__CR_DONE__\n");
        assert_eq!(duplicate.status, "partial");
        assert_eq!(duplicate.entries[0].facts[0].value, "one");
    }
    #[test]
    fn sensitive_collectors_project_only_allowlisted_facts() {
        assert!(!SYSTEMD.contains("ExecStart"));
        assert!(!SYSTEMD.contains("Environment"));
        assert!(CONFIGURATION.contains("select(.value | type == \"boolean\")"));
        assert!(!CONFIGURATION.contains("cat /etc/ssh"));
        assert!(STORAGE.contains("source redacted"));
    }
    #[test]
    fn container_projection_omits_network_runtime_values_and_normalizes_mount_order() {
        let records = r#"{"name":"/web","imageContentId":"sha256:abc","networks":{"public":{"IPAddress":"192.0.2.8"}},"mounts":[{"Destination":"/z"},{"Destination":"/a"}]}
__CR_DONE__
"#;
        let section = parse_docker(records);
        assert_eq!(section.status, "collected");
        let entry = &section.entries[0];
        assert_eq!(entry.identity, "web");
        assert!(
            entry
                .facts
                .iter()
                .any(|fact| fact.name == "networks" && fact.value == "public")
        );
        assert!(!format!("{entry:?}").contains("192.0.2.8"));
        assert!(!DOCKER.contains(".Env"));
        let mounts = entry
            .facts
            .iter()
            .find(|fact| fact.name == "mounts")
            .unwrap();
        assert!(mounts.value.find("/a").unwrap() < mounts.value.find("/z").unwrap());
    }
    #[test]
    fn legitimate_large_dependency_lists_fit_the_bounded_fact_contract() {
        let dependencies = "unit.service ".repeat(400);
        let result = parse(
            "systemdUnits",
            &format!("example.target\tBefore\t{dependencies}\n__CR_DONE__\n"),
        );
        assert_eq!(result.status, "collected");
        let oversized = "unit.service ".repeat(2000);
        assert_ne!(
            parse(
                "systemdUnits",
                &format!("example.target\tBefore\t{oversized}\n__CR_DONE__\n")
            )
            .status,
            "collected"
        );
    }
    #[test]
    fn evidence_bounds_report_partial() {
        let rows = (0..1002)
            .map(|index| format!("resource{index}\tkey\tvalue\n"))
            .collect::<String>();
        let result = parse("test", &format!("{rows}__CR_DONE__\n"));
        assert_eq!(result.entries.len(), MAX_ENTRIES);
        assert_eq!(result.status, "partial");
    }
}
