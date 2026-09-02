use std::collections::{BTreeSet, HashMap};

use chrono::Utc;
use serde::Serialize;
use serde_json::Value;

use crate::{
    models::{DockerContainer, SavedConnection},
    remote::{self, RemoteCommandExecutor},
};

/// Only Compose-identified containers are inspected for image identity, and
/// never more than this many per host. Matching in this version rests on
/// validated Compose project plus service, so inspecting the rest would cost a
/// round trip for facts nothing can pair.
pub const MAX_INSPECTED_CONTAINERS: usize = 200;

const IMAGE_TABLE_MARKER: &str = "__CR_IMAGE_TABLE__";
const NO_DIGEST: &str = "<none>";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerImageFact {
    pub container: DockerContainer,
    /// The reference recorded on the container when it was created. It can
    /// differ from the tag that reference points at now.
    pub recorded_reference: Option<String>,
    /// The immutable local image content id. Comparable across hosts.
    pub image_id: Option<String>,
    pub repo_digests: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostImageInventory {
    pub connection_id: String,
    pub collected_at: String,
    pub containers: Vec<ContainerImageFact>,
    pub inspected_containers: usize,
    /// True when more Compose-identified containers exist than were inspected.
    pub truncated: bool,
    /// False when at least one inspected container came back without an image
    /// id, so equality cannot be claimed for it.
    pub identity_complete: bool,
    /// False when the host's image table returned no digest at all, which is
    /// normal for images that were built locally rather than pulled.
    pub digest_evidence_available: bool,
    /// Set when the identity round trip failed on its own. The container list
    /// is still returned.
    pub identity_error: Option<String>,
}

pub fn image_identity_command(container_ids: &[String]) -> String {
    let quoted = container_ids
        .iter()
        .map(|id| format!("'{id}'"))
        .collect::<Vec<_>>()
        .join(" ");
    // Two read-only commands in one round trip. The image table takes no
    // arguments, so it still returns when the container inspect is refused, and
    // the marker keeps the two outputs apart.
    format!(
        "env LC_ALL=C docker inspect --type container --format '{{\"container\":{{{{json .Id}}}},\"imageId\":{{{{json .Image}}}},\"reference\":{{{{json .Config.Image}}}}}}' -- {quoted}; printf '%s\\n' '{IMAGE_TABLE_MARKER}'; docker images --digests --no-trunc --format '{{\"imageId\":{{{{json .ID}}}},\"digest\":{{{{json .Digest}}}}}}'"
    )
}

/// A full 64-character hex Docker id. Container ids arrive from the host's own
/// `docker ps` output and are interpolated into the next command, so they are
/// checked rather than trusted.
pub fn validate_full_container_id(value: &str) -> Option<&str> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    Some(value)
}

pub fn compose_identified(container: &DockerContainer) -> bool {
    container.compose_project.is_some() && container.compose_service.is_some()
}

pub fn collect_host_inventory(
    connection: &SavedConnection,
    sudo_password: Option<String>,
) -> Result<HostImageInventory, String> {
    let containers = remote::list_containers(connection, sudo_password.clone())?;
    let inspectable = inspectable_ids(&containers);
    let truncated = compose_identified_count(&containers) > inspectable.len();

    let mut identity_error = None;
    let mut identity = HashMap::new();
    let mut digests: HashMap<String, Vec<String>> = HashMap::new();
    let mut digest_evidence_available = false;

    if !inspectable.is_empty() {
        let command = image_identity_command(&inspectable);
        let output = match sudo_password {
            Some(password) => RemoteCommandExecutor::execute_with_sudo(
                connection,
                "collect_host_images",
                &command,
                password,
            ),
            None => RemoteCommandExecutor::execute(connection, "collect_host_images", &command),
        }?;
        if output.exit_code == 0 {
            let text = output.success_text()?;
            let (inspected, table) = split_identity_output(&text);
            identity = parse_container_identity(inspected);
            digests = parse_image_digests(table);
            digest_evidence_available = !digests.is_empty();
        } else {
            identity_error = Some(
                "Image identity could not be read on this host. Only the container list is shown."
                    .into(),
            );
        }
    }

    let inspected_containers = identity.len();
    let identity_complete = identity_error.is_none() && inspected_containers == inspectable.len();
    let facts = containers
        .into_iter()
        .map(|container| {
            let recorded = identity.get(&container.id);
            let image_id = recorded.and_then(|entry| entry.image_id.clone());
            let repo_digests = image_id
                .as_ref()
                .and_then(|id| digests.get(id))
                .cloned()
                .unwrap_or_default();
            ContainerImageFact {
                recorded_reference: recorded.and_then(|entry| entry.reference.clone()),
                image_id,
                repo_digests,
                container,
            }
        })
        .collect();

    Ok(HostImageInventory {
        connection_id: connection.id.clone(),
        collected_at: Utc::now().to_rfc3339(),
        containers: facts,
        inspected_containers,
        truncated,
        identity_complete,
        digest_evidence_available,
        identity_error,
    })
}

fn compose_identified_count(containers: &[DockerContainer]) -> usize {
    containers
        .iter()
        .filter(|container| compose_identified(container))
        .count()
}

/// Compose-identified containers with a full, valid id, capped at the bound.
pub fn inspectable_ids(containers: &[DockerContainer]) -> Vec<String> {
    containers
        .iter()
        .filter(|container| compose_identified(container))
        .filter_map(|container| validate_full_container_id(&container.id))
        .take(MAX_INSPECTED_CONTAINERS)
        .map(str::to_string)
        .collect()
}

fn split_identity_output(text: &str) -> (&str, &str) {
    match text.split_once(IMAGE_TABLE_MARKER) {
        Some((inspected, table)) => (inspected, table),
        None => (text, ""),
    }
}

#[derive(Debug, Default)]
struct IdentityEntry {
    image_id: Option<String>,
    reference: Option<String>,
}

fn json_string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty() && *text != NO_DIGEST)
        .map(str::to_string)
}

fn parse_container_identity(text: &str) -> HashMap<String, IdentityEntry> {
    let mut entries = HashMap::new();
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        let Some(container) = json_string(&value, "container") else {
            continue;
        };
        entries.insert(
            container,
            IdentityEntry {
                image_id: json_string(&value, "imageId"),
                reference: json_string(&value, "reference"),
            },
        );
    }
    entries
}

fn parse_image_digests(text: &str) -> HashMap<String, Vec<String>> {
    let mut collected: HashMap<String, BTreeSet<String>> = HashMap::new();
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        let Some(image_id) = json_string(&value, "imageId") else {
            continue;
        };
        let Some(digest) = json_string(&value, "digest") else {
            continue;
        };
        collected.entry(image_id).or_default().insert(digest);
    }
    collected
        .into_iter()
        .map(|(image_id, digests)| (image_id, digests.into_iter().collect()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn container(id: &str, project: Option<&str>, service: Option<&str>) -> DockerContainer {
        DockerContainer {
            id: id.into(),
            name: "app".into(),
            image: "example/app:latest".into(),
            state: "running".into(),
            status: "Up 2 hours".into(),
            ports: String::new(),
            created_at: String::new(),
            compose_project: project.map(str::to_string),
            compose_service: service.map(str::to_string),
            compose_container_number: Some(1),
            compose_oneoff: Some(false),
        }
    }

    fn full(byte: char) -> String {
        std::iter::repeat_n(byte, 64).collect()
    }

    #[test]
    fn only_full_hexadecimal_container_ids_are_accepted() {
        let id = full('a');
        assert_eq!(validate_full_container_id(&id), Some(id.as_str()));
        for rejected in [
            "",
            "abc",
            "a".repeat(63).as_str(),
            "a".repeat(65).as_str(),
            &format!("{}; id", "a".repeat(62)),
            &"z".repeat(64),
        ] {
            assert_eq!(validate_full_container_id(rejected), None, "{rejected}");
        }
    }

    #[test]
    fn only_compose_identified_containers_are_inspected() {
        let containers = vec![
            container(&full('a'), Some("shop"), Some("web")),
            container(&full('b'), None, None),
            container(&full('c'), Some("shop"), None),
            container("short-id", Some("shop"), Some("api")),
        ];
        assert_eq!(inspectable_ids(&containers), vec![full('a')]);
    }

    #[test]
    fn the_inspected_set_is_bounded() {
        let containers: Vec<DockerContainer> = (0..MAX_INSPECTED_CONTAINERS + 5)
            .map(|index| {
                container(
                    &format!("{index:064x}"),
                    Some("shop"),
                    Some(&format!("service-{index}")),
                )
            })
            .collect();
        assert_eq!(inspectable_ids(&containers).len(), MAX_INSPECTED_CONTAINERS);
    }

    #[test]
    fn the_identity_command_is_read_only_and_quotes_every_id() {
        let command = image_identity_command(&[full('a'), full('b')]);
        assert!(command.contains(&format!("-- '{}' '{}'", full('a'), full('b'))));
        assert!(command.contains("docker inspect --type container"));
        assert!(command.contains("docker images --digests --no-trunc"));
        for forbidden in [
            "docker pull",
            "docker run",
            "docker rm",
            "docker rmi",
            "docker start",
            "docker stop",
            "docker restart",
            "docker tag",
            "docker push",
            "docker exec",
        ] {
            assert!(!command.contains(forbidden), "{command} runs {forbidden}");
        }
    }

    #[test]
    fn the_identity_command_reads_no_environment_or_label_fields() {
        let command = image_identity_command(&[full('a')]);
        for excluded in [
            ".Config.Env",
            ".Config.Cmd",
            ".Config.Labels",
            ".Config.Entrypoint",
        ] {
            assert!(!command.contains(excluded), "{command} asks for {excluded}");
        }
    }

    #[test]
    fn container_identity_is_parsed_and_keyed_by_container_id() {
        let text = format!(
            "{{\"container\":\"{a}\",\"imageId\":\"sha256:1111\",\"reference\":\"example/app:1.4\"}}\n{{\"container\":\"{b}\",\"imageId\":\"sha256:2222\",\"reference\":\"example/api:latest\"}}\n",
            a = full('a'),
            b = full('b')
        );
        let identity = parse_container_identity(&text);
        assert_eq!(identity.len(), 2);
        assert_eq!(
            identity[&full('a')].image_id.as_deref(),
            Some("sha256:1111")
        );
        assert_eq!(
            identity[&full('a')].reference.as_deref(),
            Some("example/app:1.4")
        );
    }

    #[test]
    fn an_unparsable_identity_line_is_skipped_rather_than_guessed_at() {
        let text = format!(
            "not json\n{{\"container\":\"{a}\",\"imageId\":\"sha256:1111\"}}\n{{\"imageId\":\"sha256:3333\"}}\n",
            a = full('a')
        );
        let identity = parse_container_identity(&text);
        assert_eq!(identity.len(), 1);
        assert_eq!(identity[&full('a')].reference, None);
    }

    #[test]
    fn digests_are_collected_per_image_and_deduplicated() {
        let text = "{\"imageId\":\"sha256:1111\",\"digest\":\"sha256:aaaa\"}\n{\"imageId\":\"sha256:1111\",\"digest\":\"sha256:aaaa\"}\n{\"imageId\":\"sha256:1111\",\"digest\":\"sha256:bbbb\"}\n";
        let digests = parse_image_digests(text);
        assert_eq!(
            digests["sha256:1111"],
            vec!["sha256:aaaa".to_string(), "sha256:bbbb".to_string()]
        );
    }

    #[test]
    fn a_locally_built_image_reports_no_digest_instead_of_the_none_placeholder() {
        let text = "{\"imageId\":\"sha256:1111\",\"digest\":\"<none>\"}\n";
        assert!(parse_image_digests(text).is_empty());
    }

    #[test]
    fn the_marker_separates_identity_from_the_image_table() {
        let text = format!("identity line\n{IMAGE_TABLE_MARKER}\ntable line\n");
        let (identity, table) = split_identity_output(&text);
        assert!(identity.contains("identity line"));
        assert!(!identity.contains("table line"));
        assert!(table.contains("table line"));
    }

    #[test]
    fn output_without_the_marker_is_treated_as_identity_only() {
        let (identity, table) = split_identity_output("identity line\n");
        assert!(identity.contains("identity line"));
        assert!(table.is_empty());
    }
}
