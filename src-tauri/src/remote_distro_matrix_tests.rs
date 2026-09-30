use std::process::Command;

use super::{capability_command, distribution_family, parse_key_values};

#[test]
#[ignore = "requires Docker and CONTROL_ROOM_DOCKER_IMAGES"]
fn docker_images_report_expected_distribution_families() {
    let matrix = std::env::var("CONTROL_ROOM_DOCKER_IMAGES")
        .expect("CONTROL_ROOM_DOCKER_IMAGES=image=family,... is required");
    for entry in matrix.split(',').filter(|entry| !entry.trim().is_empty()) {
        let (image, expected_family) = entry
            .split_once('=')
            .expect("each Docker matrix entry must be image=family");
        let output = Command::new("docker")
            .args(["run", "--rm", image, "sh", "-c", capability_command()])
            .output()
            .unwrap_or_else(|error| panic!("could not run {image}: {error}"));
        assert!(
            output.status.success(),
            "{image} probe failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let text = String::from_utf8(output.stdout).expect("probe output is UTF-8");
        let values = parse_key_values(&text);
        let family = distribution_family(
            values.get("os_id").map(String::as_str),
            values.get("os_like").map(String::as_str),
        );
        assert_eq!(family.as_deref(), Some(expected_family), "{image}");
        assert!(
            values.get("uptime").is_some_and(|value| !value.is_empty()),
            "{image} returned no uptime"
        );
        assert!(
            values
                .get("default_shell")
                .is_some_and(|value| !value.is_empty()),
            "{image} returned no default shell"
        );
    }
}
