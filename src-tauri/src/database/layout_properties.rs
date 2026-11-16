use super::*;
use crate::models::{PersistedTerminalGroup, PersistedWorkspace};
use proptest::prelude::*;
use proptest::test_runner::{Config, RngSeed};

const PROPERTY_SEED: u64 = 273;
const LEGACY_TERMINAL_GROUP_ID: &str = "00000000-0000-4000-8000-000000000001";
const PERSISTED_STATE_CORPUS: &str = include_str!("workspace_state_corpus.jsonl");
const REGENERATE_CORPUS_COMMAND: &str = "npm run generate:layout-corpus";

fn config() -> Config {
    Config {
        cases: 64,
        rng_seed: RngSeed::Fixed(PROPERTY_SEED),
        failure_persistence: None,
        ..Config::default()
    }
}

fn uuid() -> impl Strategy<Value = String> {
    any::<u128>().prop_map(|bits| Uuid::from_u128(bits).to_string())
}

fn workspace_ids() -> impl Strategy<Value = Vec<String>> {
    prop::collection::hash_set(any::<u128>(), 2..=12).prop_map(|bits| {
        bits.into_iter()
            .map(|bits| Uuid::from_u128(bits).to_string())
            .collect()
    })
}

fn layout_over(ids: Vec<String>) -> BoxedStrategy<PersistedTerminalLayout> {
    if ids.len() == 1 {
        return Just(PersistedTerminalLayout::Leaf {
            workspace_id: ids[0].clone(),
        })
        .boxed();
    }
    (
        1..ids.len(),
        prop_oneof![Just("vertical"), Just("horizontal")],
        prop::option::of(0.05f64..=0.95),
    )
        .prop_flat_map(move |(cut, direction, ratio)| {
            (
                layout_over(ids[..cut].to_vec()),
                layout_over(ids[cut..].to_vec()),
            )
                .prop_map(move |(first, second)| PersistedTerminalLayout::Split {
                    direction: direction.into(),
                    ratio,
                    first: Box::new(first),
                    second: Box::new(second),
                })
        })
        .boxed()
}

fn workspace(id: &str, position: usize) -> PersistedWorkspace {
    let remote = position.is_multiple_of(2);
    PersistedWorkspace {
        id: id.into(),
        label: None,
        connection_id: remote.then(|| "6c8d3c1e-2f4a-4b7e-9a51-0d2f6b3e8c71".into()),
        local_shell_id: (!remote).then(|| "powershell-7".into()),
        remote_shell: None,
        container: None,
        view: "terminal".into(),
        history_paused: false,
    }
}

fn workspaces_and_layout() -> impl Strategy<Value = (Vec<String>, PersistedTerminalLayout)> {
    workspace_ids().prop_flat_map(|ids| (Just(ids.clone()), layout_over(ids)))
}

fn grouped_state() -> impl Strategy<Value = PersistedWorkspaceState> {
    workspace_ids()
        .prop_flat_map(|ids| {
            let cuts = prop::collection::vec(2..=4usize, 0..=3);
            (Just(ids), cuts)
        })
        .prop_flat_map(|(ids, sizes)| {
            let mut groups = Vec::new();
            let mut start = 0;
            for size in sizes {
                if start + size > ids.len() {
                    break;
                }
                groups.push(
                    (
                        uuid(),
                        "[A-Za-z0-9 ]{0,10}[A-Za-z0-9]",
                        layout_over(ids[start..start + size].to_vec()),
                    )
                        .prop_map(|(id, name, layout)| PersistedTerminalGroup { id, name, layout }),
                );
                start += size;
            }
            (Just(ids), groups, prop::option::of(0..12usize))
        })
        .prop_map(|(ids, terminal_groups, active)| PersistedWorkspaceState {
            workspaces: ids
                .iter()
                .enumerate()
                .map(|(position, id)| workspace(id, position))
                .collect(),
            active_workspace_id: active.and_then(|position| ids.get(position).cloned()),
            terminal_groups,
            panel_sizes: Default::default(),
            terminal_layout: None,
        })
}

fn store_payload(database: &Database, payload: &str) {
    database
        .connection
        .lock()
        .execute(
            "INSERT INTO application_settings (key, value) VALUES ('workspace_state', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [payload],
        )
        .unwrap();
}

proptest! {
    #![proptest_config(config())]

    #[test]
    fn a_legacy_layout_migrates_into_one_valid_group(
        (ids, layout) in workspaces_and_layout()
    ) {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::open(&directory.path().join("control-room.db")).unwrap();
        let workspaces: Vec<_> = ids
            .iter()
            .enumerate()
            .map(|(position, id)| workspace(id, position))
            .collect();
        let payload = serde_json::json!({
            "workspaces": workspaces,
            "activeWorkspaceId": ids[0],
            "terminalLayout": layout,
        });
        store_payload(&database, &payload.to_string());

        let restored = database.get_workspace_state().unwrap();

        prop_assert_eq!(&restored.workspaces, &workspaces);
        prop_assert_eq!(
            restored.terminal_groups,
            vec![PersistedTerminalGroup {
                id: LEGACY_TERMINAL_GROUP_ID.into(),
                name: "Terminal group".into(),
                layout: layout.clone(),
            }]
        );
        prop_assert_eq!(restored.terminal_layout, Some(layout));
    }

    #[test]
    fn a_saved_valid_state_loads_unchanged(state in grouped_state()) {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::open(&directory.path().join("control-room.db")).unwrap();

        database.save_workspace_state(&state).unwrap();

        prop_assert_eq!(database.get_workspace_state().unwrap(), state);
    }
}

#[test]
fn every_persisted_state_the_frontend_generates_is_valid() {
    let directory = tempfile::tempdir().unwrap();
    let database = Database::open(&directory.path().join("control-room.db")).unwrap();
    let states: Vec<_> = PERSISTED_STATE_CORPUS.lines().collect();
    assert!(
        states.len() > 3,
        "the corpus is empty; run {REGENERATE_CORPUS_COMMAND}"
    );
    for (line, payload) in states.into_iter().enumerate() {
        let state: PersistedWorkspaceState = serde_json::from_str(payload)
            .unwrap_or_else(|error| panic!("corpus line {}: {error}", line + 1));
        if let Err(error) = validate_workspace_state(&state) {
            panic!("corpus line {} is rejected: {error}", line + 1);
        }
        store_payload(&database, payload);
        assert_eq!(
            database.get_workspace_state().unwrap(),
            state,
            "corpus line {} did not load unchanged",
            line + 1
        );
    }
}
