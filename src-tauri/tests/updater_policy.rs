//! Guard the updater's production trust boundary independently of HTTP fixtures.

#[test]
fn production_updates_require_https_and_a_signed_version() {
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    let updater = &config["plugins"]["updater"];
    assert_eq!(updater["requireSignedVersion"], true);
    for key in [
        "dangerousInsecureTransportProtocol",
        "dangerousAcceptInvalidCerts",
        "dangerousAcceptInvalidHostnames",
        "allowDowngrades",
    ] {
        assert_ne!(updater[key], true, "unsafe production setting: {key}");
    }
    let endpoints = updater["endpoints"].as_array().unwrap();
    assert!(!endpoints.is_empty());
    for endpoint in endpoints {
        assert!(endpoint.as_str().unwrap().starts_with("https://"));
    }
}
