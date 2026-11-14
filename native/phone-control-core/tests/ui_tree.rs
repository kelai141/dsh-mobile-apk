//! UiTreeStore 行为测试。

use dsh_phone_control_core::policy::ScreenBinding;
use dsh_phone_control_core::controller::Controller;
use dsh_phone_control_core::lifecycle::{Journal, JournalError};
use serde_json::{json, Value};
use dsh_phone_control_core::ui_tree::{
    parse_raw_tree_json, RawBoundsInput, RawNodeInput, RawTargetInput, RawTreeInput, Selector,
    UiTreeStore, MAX_COMPACT_JSON_BYTES, MAX_DEPTH, MAX_FIELD_BYTES, MAX_NODES, MAX_SCREENS,
    MAX_TOTAL_TEXT_BYTES,
};

fn binding(alias: &str, display: i32, generation: u64) -> ScreenBinding {
    ScreenBinding {
        alias: alias.to_owned(),
        display_id: display,
        width: 1080,
        height: 2400,
        rotation: 0,
        generation,
        allocation: None,
    }
}

fn raw_target(alias: &str, display: i32, generation: u64) -> RawTargetInput {
    RawTargetInput {
        display_id: display,
        screen_id: alias.to_owned(),
        logical_width: 1080,
        logical_height: 2400,
        epoch: "7".to_owned(),
        generation: generation.to_string(),
    }
}

fn node(path: Vec<u32>, text: &str, view_id: &str) -> RawNodeInput {
    RawNodeInput {
        path,
        class_name: "android.widget.TextView".to_owned(),
        package_name: "com.example.app".to_owned(),
        view_id: view_id.to_owned(),
        text: text.to_owned(),
        content_description: String::new(),
        bounds: RawBoundsInput { left: 10, top: 20, right: 210, bottom: 90 },
        clickable: true,
        scrollable: false,
        editable: false,
        checkable: false,
        checked: false,
        enabled: true,
        focused: false,
        visible: true,
        selected: false,
        window_id: 12,
    }
}

fn tree(alias: &str, display: i32, generation: u64, nodes: Vec<RawNodeInput>) -> RawTreeInput {
    RawTreeInput {
        target: raw_target(alias, display, generation),
        window_id: 12,
        nodes,
        complete: true,
        stop_reason: None,
        elapsed_ms: 3,
    }
}

fn basic_tree(alias: &str, display: i32, generation: u64) -> RawTreeInput {
    let mut root = node(Vec::new(), "", "");
    root.class_name = "android.widget.FrameLayout".to_owned();
    root.clickable = false;
    let mut child = node(vec![0], "确定", "com.example.app:id/ok");
    child.window_id = 12;
    tree(alias, display, generation, vec![root, child])
}

fn replace_ok(store: &mut UiTreeStore, screen: &ScreenBinding, raw: RawTreeInput) {
    store.replace(7, screen, raw).unwrap();
}

#[test]
fn inverted_android_bounds_keep_the_tree_and_refuse_that_node_as_a_target() {
    let screen = binding("real", 0, 2);
    let mut raw = basic_tree("real", 0, 2);
    let mut bad = node(vec![1], "offscreen", "");
    bad.bounds.right = -1;
    raw.nodes.push(bad);
    let mut store = UiTreeStore::new(7);
    replace_ok(&mut store, &screen, raw);

    let compact: Value =
        serde_json::from_str(&store.compact_snapshot_json("real").unwrap().unwrap()).unwrap();
    assert_eq!(compact["complete"], true);
    assert_eq!(compact["nodeCount"], 3);
    assert_eq!(compact["nodes"][2]["text"], "offscreen");
    assert_eq!(compact["nodes"][2]["bounds"], Value::Null);
    let bad_ref = compact["nodes"][2]["ref"].as_str().unwrap();
    assert_eq!(store.action_target(bad_ref).unwrap_err().code(), "node-bounds-unavailable");
    assert_eq!(
        store.select("real", Selector::Text("offscreen")).unwrap_err().code(),
        "node-bounds-unavailable",
    );
    let good_ref = compact["nodes"][1]["ref"].as_str().unwrap();
    assert!(store.action_target(good_ref).is_ok());
}

#[derive(Default)]
struct MemoryJournal(Option<Vec<u8>>);

impl Journal for MemoryJournal {
    fn load(&mut self) -> Result<Option<Vec<u8>>, JournalError> { Ok(self.0.clone()) }
    fn store(&mut self, bytes: &[u8]) -> Result<(), JournalError> {
        self.0 = Some(bytes.to_vec());
        Ok(())
    }
}

fn exchange(controller: &mut Controller<MemoryJournal>, mut request: Value) -> Value {
    request["protocolVersion"] = json!(1);
    let response = controller.exchange(&request.to_string());
    serde_json::from_str(&response).expect(&response)
}

fn publish_facts(controller: &mut Controller<MemoryJournal>, scope: &str) -> String {
    let published = exchange(controller, json!({"kind":"publishFacts","facts":{
        "scope":scope,"screens":{"real":{"displayId":0,"width":1080,"height":2400,"rotation":0}},
        "a11y":{"enabled":"yes","online":"yes","supportedOps":{"state":"known","ops":["snapshot","click","longClick","setText","scroll","nodeText"]},
            "displaySupport":{"state":"known","values":{"0":true}}}
    }}));
    assert_eq!(published["ok"], true, "{published}");
    let caps = exchange(controller, json!({"kind":"capabilities"}));
    caps["screens"][0]["generation"].as_str().unwrap().to_owned()
}

fn settled_snapshot(controller: &mut Controller<MemoryJournal>, id: &str, generation: &str) -> (Value, RawNodeInput) {
    let raw = basic_tree("real", 0, generation.parse().unwrap());
    let fresh = raw.nodes[1].clone();
    let prepared = exchange(controller, json!({"kind":"prepare","operation":"snapshot","callId":id,"epoch":"7","screenId":"real","generation":generation}));
    assert_eq!(prepared["code"], "prepared", "{prepared}");
    let commit = exchange(controller, json!({"kind":"commit","callId":id}));
    assert_eq!(commit["dispatch"], "permitted", "{commit}");
    let receipt = controller.publish_tree(id, raw).unwrap();
    let settled = exchange(controller, json!({"kind":"settle","callId":id,"receipt":receipt}));
    assert_eq!(settled["ok"], true, "{settled}");
    let tree = exchange(controller, json!({"kind":"readTree","callId":id}));
    (tree["tree"]["nodes"][1]["ref"].clone(), fresh)
}

#[test]
fn node_dispatch_requires_fresh_identity_on_the_planned_window_and_path() {
    let mut controller = Controller::with_journal(MemoryJournal::default(), 7).unwrap();
    let generation = publish_facts(&mut controller, "all");
    let (reference, fresh) = settled_snapshot(&mut controller, "node-tree", &generation);
    let request = json!({"kind":"prepare","operation":"click","callId":"node-click","epoch":"7","screenId":"real",
        "generation":generation,"args":{"ref":reference}});
    let mut mixed = request.clone();
    mixed["args"]["x"] = json!(10);
    mixed["args"]["y"] = json!(20);
    assert_eq!(exchange(&mut controller, mixed)["ok"], false);
    assert_eq!(exchange(&mut controller, request.clone())["code"], "prepared");
    let committed = exchange(&mut controller, json!({"kind":"commit","callId":"node-click"}));
    assert_eq!(committed["plan"]["nodeTarget"], json!({"windowId":12,"path":[0]}));
    let gate = json!({"kind":"validateDispatch","callId":"node-click"});
    assert_eq!(exchange(&mut controller, gate.clone())["code"], "node-not-verified");
    let mut wrong = fresh.clone();
    wrong.window_id += 1;
    assert_eq!(exchange(&mut controller, json!({"kind":"verifyNode","callId":"node-click","node":wrong}))["ok"], false);
    let receipt = json!({"kind":"settle","callId":"node-click","receipt":{"ok":true,"code":"node-click-accepted","executed":"yes","screenId":"real"}});
    assert_eq!(exchange(&mut controller, receipt.clone())["code"], "node-not-verified");
    assert_eq!(exchange(&mut controller, json!({"kind":"verifyNode","callId":"node-click","node":fresh}))["code"], "node-verified");
    assert_eq!(exchange(&mut controller, gate)["valid"], true);
    assert_eq!(exchange(&mut controller, receipt)["ok"], true);
    assert_eq!(exchange(&mut controller, request)["replayed"], true);
}

#[test]
fn shizuku_nodes_require_the_same_fresh_identity_gate_as_accessibility() {
    let mut controller = Controller::with_journal(MemoryJournal::default(), 7).unwrap();
    let facts = exchange(&mut controller, json!({"kind":"publishFacts","facts":{
        "scope":"real-only","screens":{"real":{"displayId":0,"width":1080,"height":2400,"rotation":0}},
        "a11y":{"enabled":"no","online":"no"},
        "shizuku":{"installed":"yes","running":"yes","granted":"yes","bound":"yes","functionalReady":"yes",
            "serverUid":{"kind":"shell2000"},"supportedOps":{"state":"known","ops":["snapshot","nodeText"]},
            "displaySupport":{"state":"known","values":{"0":true}}}
    }}));
    assert_eq!(facts["ok"], true, "{facts}");
    let caps = exchange(&mut controller, json!({"kind":"capabilities"}));
    let generation = caps["screens"][0]["generation"].as_str().unwrap();
    let (reference, fresh) = settled_snapshot(&mut controller, "shell-tree", generation);
    let prepared = exchange(&mut controller, json!({"kind":"prepare","operation":"nodeText","callId":"shell-node",
        "epoch":"7","screenId":"real","generation":generation,"args":{"ref":reference}}));
    assert_eq!(prepared["code"], "prepared", "{prepared}");
    assert_eq!(prepared["plan"]["backend"], "shizuku");
    assert!(prepared["plan"]["nodeTarget"].is_object(), "{prepared}");
    let committed = exchange(&mut controller, json!({"kind":"commit","callId":"shell-node"}));
    assert_eq!(committed["dispatch"], "permitted");
    assert_eq!(prepared["plan"]["nodeTarget"], committed["plan"]["nodeTarget"]);
    assert_eq!(exchange(&mut controller, json!({"kind":"validateDispatch","callId":"shell-node"}))["valid"], false);
    let mut stale = fresh.clone(); stale.window_id += 1;
    assert_eq!(exchange(&mut controller, json!({"kind":"verifyNode","callId":"shell-node","node":stale}))["ok"], false);
    assert_eq!(exchange(&mut controller, json!({"kind":"verifyNode","callId":"shell-node","node":fresh}))["ok"], true);
    assert_eq!(exchange(&mut controller, json!({"kind":"validateDispatch","callId":"shell-node"}))["valid"], true);
}

#[test]
fn replacing_snapshot_before_dispatch_refuses_old_node_plan() {
    let mut controller = Controller::with_journal(MemoryJournal::default(), 7).unwrap();
    let generation = publish_facts(&mut controller, "all");
    let (reference, _) = settled_snapshot(&mut controller, "old-tree", &generation);
    assert_eq!(exchange(&mut controller, json!({"kind":"prepare","operation":"setText","callId":"old-node",
        "epoch":"7","args":{"ref":reference,"text":"中文"}}))["code"], "prepared");
    settled_snapshot(&mut controller, "new-tree", &generation);
    let denied = exchange(&mut controller, json!({"kind":"commit","callId":"old-node"}));
    assert_eq!(denied["ok"], false);
    assert!(denied.get("dispatch").is_none(), "{denied}");
    let refused = exchange(&mut controller, json!({"kind":"prepare","operation":"nodeText","callId":"old-node-read",
        "epoch":"7","screenId":"real","generation":generation,"args":{"ref":reference}}));
    assert_eq!(refused["code"], "stale-snapshot");
    assert_eq!(refused["executed"], "no");
    assert!(refused.get("plan").is_none(), "{refused}");
}

#[test]
fn capability_union_never_grants_an_operation_on_an_unsupported_display() {
    let mut controller = Controller::with_journal(MemoryJournal::default(), 7).unwrap();
    let facts = exchange(&mut controller, json!({"kind":"publishFacts","facts":{
        "scope":"all","screens":{
            "real":{"displayId":0,"width":1080,"height":2400,"rotation":0},
            "virtual-1":{"displayId":41,"width":720,"height":1280,"rotation":0}},
        "a11y":{"enabled":"yes","online":"yes","supportedOps":{"state":"known","ops":["snapshot","screenshot"]},
            "displaySupport":{"state":"known","values":{"0":true,"41":true}},
            "displayOperations":{"0":["snapshot","screenshot"],"41":["snapshot"]}}
    }}));
    assert_eq!(facts["ok"], true, "{facts}");
    let caps = exchange(&mut controller, json!({"kind":"capabilities"}));
    assert_eq!(caps["channels"]["a11y"]["displayOperations"]["41"], json!(["snapshot"]));
    let denied = exchange(&mut controller, json!({"kind":"prepare","operation":"screenshot","callId":"virtual-shot","epoch":"7","screenId":"virtual-1"}));
    assert_eq!(denied["ok"], false);
    assert!(denied.get("plan").is_none(), "{denied}");
    let allowed = exchange(&mut controller, json!({"kind":"prepare","operation":"screenshot","callId":"real-shot","epoch":"7","screenId":"real"}));
    assert_eq!(allowed["plan"]["backend"], "a11y", "{allowed}");
}

#[test]
fn snapshot_requires_dispatch_and_durable_receipt_before_delivery() {
    let mut controller = Controller::with_journal(MemoryJournal::default(), 7).unwrap();
    let generation = publish_facts(&mut controller, "all");
    let raw = basic_tree("real", 0, generation.parse().unwrap());
    let prepare = json!({"kind":"prepare","operation":"snapshot","callId":"tree-1",
        "epoch":"7","screenId":"real","generation":generation});
    assert_eq!(exchange(&mut controller, prepare.clone())["code"], "prepared");
    assert_eq!(controller.publish_tree("tree-1", raw.clone()).unwrap_err().code(), "tree-dispatch-required");
    assert_eq!(exchange(&mut controller, json!({"kind":"commit","callId":"tree-1"}))["dispatch"], "permitted");
    let receipt = controller.publish_tree("tree-1", raw).unwrap();
    assert!(receipt["data"]["tree"].get("nodes").is_none());
    assert_eq!(exchange(&mut controller, json!({"kind":"readTree","callId":"tree-1"}))["code"], "tree-not-settled");
    let mut forged = receipt.clone();
    forged["data"]["tree"]["snapshotId"] = json!("999");
    assert_eq!(exchange(&mut controller, json!({"kind":"settle","callId":"tree-1","receipt":forged}))["code"], "invalid-tree-receipt");
    assert_eq!(exchange(&mut controller, json!({"kind":"settle","callId":"tree-1","receipt":receipt}))["ok"], true);
    let delivered = exchange(&mut controller, json!({"kind":"readTree","callId":"tree-1"}));
    assert_eq!(delivered["tree"]["nodes"][1]["text"], "确定");
    assert_eq!(delivered["tree"]["generation"], generation);
    assert_eq!(exchange(&mut controller, prepare)["replayed"], true);
    publish_facts(&mut controller, "virtual-only");
    assert_eq!(exchange(&mut controller, json!({"kind":"readTree","callId":"tree-1"}))["code"], "tree-result-expired");
    assert_eq!(exchange(&mut controller, json!({"kind":"operationStatus","callId":"tree-1"}))["phase"], "settled");
}

#[test]
fn scope_revoked_after_capture_keeps_executed_but_withholds_tree() {
    let mut controller = Controller::with_journal(MemoryJournal::default(), 7).unwrap();
    let generation = publish_facts(&mut controller, "all");
    let prepare = json!({"kind":"prepare","operation":"snapshot","callId":"tree-2",
        "epoch":"7","screenId":"real","generation":generation});
    assert_eq!(exchange(&mut controller, prepare)["code"], "prepared");
    assert_eq!(exchange(&mut controller, json!({"kind":"commit","callId":"tree-2"}))["dispatch"], "permitted");
    let receipt = controller.publish_tree("tree-2", basic_tree("real", 0, generation.parse().unwrap())).unwrap();
    publish_facts(&mut controller, "virtual-only");
    let result = exchange(&mut controller, json!({"kind":"settle","callId":"tree-2","receipt":receipt}));
    assert_eq!(result["ok"], false);
    assert_eq!(result["executed"], "yes");
    assert_eq!(result["code"], "scope-generation-mismatch");
    assert!(result.get("data").is_none(), "{result}");
    assert_eq!(exchange(&mut controller, json!({"kind":"readTree","callId":"tree-2"}))["code"], "tree-not-successful");
}

#[test]
fn strict_raw_tree_serde_rejects_unknown_fields_and_keeps_real_values() {
    let exact = json!({
        "target": {
            "displayId": 41,
            "screenId": "virtual-1",
            "logicalWidth": 1080,
            "logicalHeight": 2400,
            "epoch": "7",
            "generation": "3",
        },
        "windowId": 12,
        "nodes": [{
            "path": [2, 0],
            "className": "android.widget.EditText",
            "packageName": "com.example.app",
            "viewId": "com.example.app:id/name",
            "text": "名字",
            "contentDescription": "姓名输入",
            "bounds": { "left": 0, "top": 10, "right": 500, "bottom": 80 },
            "clickable": true,
            "scrollable": false,
            "editable": true,
            "checkable": false,
            "checked": false,
            "enabled": true,
            "focused": true,
            "visible": true,
            "selected": false,
            "windowId": 12,
        }],
        "complete": false,
        "stopReason": "cancelled",
        "elapsedMs": 9,
    });
    let parsed = parse_raw_tree_json(&exact.to_string()).unwrap();
    assert_eq!(parsed.nodes[0].path, vec![2, 0]);
    assert_eq!(parsed.nodes[0].bounds.right, 500);
    assert_eq!(parsed.nodes[0].text, "名字");

    let mut extra = exact.clone();
    extra["nodes"][0]["clickableAncestor"] = json!(true);
    let error = parse_raw_tree_json(&extra.to_string()).unwrap_err();
    assert_eq!(error.code(), "invalid-json");

    let mut missing = exact;
    missing["target"].as_object_mut().unwrap().remove("logicalWidth");
    assert_eq!(parse_raw_tree_json(&missing.to_string()).unwrap_err().code(), "invalid-json");
}

#[test]
fn two_screens_keep_same_real_path_and_assign_distinct_refs() {
    let mut store = UiTreeStore::new(7);
    let first = binding("virtual-1", 41, 2);
    let second = binding("virtual-2", 42, 3);
    replace_ok(&mut store, &first, basic_tree("virtual-1", 41, 2));
    replace_ok(&mut store, &second, basic_tree("virtual-2", 42, 3));

    let left = store.select("virtual-1", Selector::Text("确定")).unwrap();
    let right = store.select("virtual-2", Selector::Text("确定")).unwrap();
    assert_eq!(left.raw_child_path(), &[0]);
    assert_eq!(right.raw_child_path(), &[0]);
    assert_eq!(left.screen_id(), "virtual-1");
    assert_eq!(right.screen_id(), "virtual-2");
    assert_eq!(left.display_id(), 41);
    assert_eq!(right.display_id(), 42);
    assert_eq!(left.ref_id(), "e7:g2:s1:n1");
    assert_eq!(right.ref_id(), "e7:g3:s2:n1");
    assert_eq!(left.epoch(), 7);
}

#[test]
fn snapshot_ids_are_nonzero_and_increase_per_successful_replace() {
    let mut store = UiTreeStore::new(7);
    let screen = binding("virtual-1", 41, 2);
    let first = store.replace(7, &screen, basic_tree("virtual-1", 41, 2)).unwrap();
    let second = store.replace(7, &screen, basic_tree("virtual-1", 41, 2)).unwrap();
    assert_eq!(first.snapshot_id, 1);
    assert_eq!(second.snapshot_id, 2);
    assert!(store.snapshot("virtual-1").unwrap().snapshot_id == 2);
    assert!(store.snapshot_json("virtual-1").unwrap().contains("\"snapshotId\":\"2\""));
}

#[test]
fn raw_epoch_screen_display_generation_and_size_must_match_policy_binding() {
    let screen = binding("virtual-1", 41, 2);
    let cases: Vec<(&str, RawTreeInput)> = vec![
        ("epoch-mismatch", {
            let mut raw = basic_tree("virtual-1", 41, 2);
            raw.target.epoch = "6".to_owned();
            raw
        }),
        ("screen-mismatch", basic_tree("virtual-2", 41, 2)),
        ("display-mismatch", basic_tree("virtual-1", 42, 2)),
        ("generation-mismatch", basic_tree("virtual-1", 41, 3)),
        ("dimension-mismatch", {
            let mut raw = basic_tree("virtual-1", 41, 2);
            raw.target.logical_width = 999;
            raw
        }),
    ];
    for (code, raw) in cases {
        let mut store = UiTreeStore::new(7);
        let error = store.replace(7, &screen, raw).unwrap_err();
        assert_eq!(error.code(), code);
        assert_eq!(store.screen_count(), 0);
    }

    let mut store = UiTreeStore::new(9);
    assert_eq!(store.replace(9, &screen, basic_tree("virtual-1", 41, 2)).unwrap_err().code(), "epoch-mismatch");
}

#[test]
fn old_refs_do_not_survive_new_snapshot_or_generation() {
    let mut store = UiTreeStore::new(7);
    let first_binding = binding("virtual-1", 41, 2);
    replace_ok(&mut store, &first_binding, basic_tree("virtual-1", 41, 2));
    let old = store.select("virtual-1", Selector::Text("确定")).unwrap();
    let old_ref = old.ref_id().to_owned();

    let second_binding = binding("virtual-1", 41, 3);
    replace_ok(&mut store, &second_binding, basic_tree("virtual-1", 41, 3));
    assert_eq!(store.action_target(&old_ref).unwrap_err().code(), "stale-snapshot");
    let fresh = basic_tree("virtual-1", 41, 3).nodes.remove(1);
    assert_eq!(store.verify_target(&old, &fresh).unwrap_err().code(), "stale-snapshot");

    let current = store.select("virtual-1", Selector::Text("确定")).unwrap();
    store.invalidate_screen("virtual-1");
    let fresh_current = basic_tree("virtual-1", 41, 3).nodes.remove(1);
    assert_eq!(store.verify_target(&current, &fresh_current).unwrap_err().code(), "stale-screen");
}

#[test]
fn malformed_or_foreign_refs_are_rejected() {
    let mut store = UiTreeStore::new(7);
    replace_ok(&mut store, &binding("virtual-1", 41, 2), basic_tree("virtual-1", 41, 2));
    for (ref_id, code) in [
        ("0", "ref-malformed"),
        ("text:确定", "ref-malformed"),
        ("0:n0", "ref-malformed"),
        ("s01:n0", "ref-malformed"),
        ("s1:n01", "ref-malformed"),
        ("s1:n1", "ref-malformed"),
        ("s1:n9", "ref-malformed"),
        ("s999:n0", "ref-malformed"),
        ("e7:g2:s1:n9", "ref-not-found"),
        ("e7:g2:s999:n0", "stale-snapshot"),
    ] {
        assert_eq!(store.action_target(ref_id).unwrap_err().code(), code, "{ref_id}");
    }
}

#[test]
fn old_ref_with_new_epoch_and_current_binding_cannot_revive_in_restarted_store() {
    let screen = binding("virtual-1", 41, 2);
    let mut first = UiTreeStore::new(1);
    let mut raw = basic_tree("virtual-1", 41, 2);
    raw.target.epoch = "1".to_owned();
    first.replace(1, &screen, raw).unwrap();
    let old = first.select("virtual-1", Selector::Text("确定")).unwrap();
    assert_eq!(old.ref_id(), "e1:g2:s1:n1");

    let mut restarted = UiTreeStore::new(2);
    let mut raw = basic_tree("virtual-1", 41, 2);
    raw.target.epoch = "2".to_owned();
    raw.nodes[1].text = "新会话节点".to_owned();
    restarted.replace(2, &screen, raw).unwrap();
    let current = restarted.select("virtual-1", Selector::Text("新会话节点")).unwrap();
    assert_eq!(old.snapshot_id(), current.snapshot_id());
    assert_eq!(old.generation(), current.generation());
    assert_eq!(old.raw_child_path(), current.raw_child_path());
    assert_eq!(restarted.action_target_for_binding(2, &screen, old.ref_id()).unwrap_err().code(), "stale-epoch");
    assert_eq!(restarted.action_target(old.ref_id()).unwrap_err().code(), "stale-epoch");
    let before = restarted.snapshot_json(&screen.alias).unwrap().to_owned();
    assert_eq!(restarted.invalidate_ref(old.ref_id()).unwrap_err().code(), "stale-epoch");
    assert_eq!(restarted.invalidate_target(&old).unwrap_err().code(), "stale-epoch");
    assert_eq!(restarted.snapshot_json(&screen.alias).unwrap(), before);
    assert_eq!(restarted.action_target_for_binding(2, &screen, current.ref_id()).unwrap(), current);
}

#[test]
fn old_ref_with_new_generation_and_current_binding_cannot_revive() {
    let old_binding = binding("virtual-1", 41, 2);
    let new_binding = binding("virtual-1", 41, 3);
    let mut first = UiTreeStore::new(7);
    replace_ok(&mut first, &old_binding, basic_tree("virtual-1", 41, 2));
    let old = first.select("virtual-1", Selector::Text("确定")).unwrap();

    let mut restarted = UiTreeStore::new(7);
    let mut raw = basic_tree("virtual-1", 41, 3);
    raw.nodes[1].text = "新代次节点".to_owned();
    replace_ok(&mut restarted, &new_binding, raw);
    let current = restarted.select("virtual-1", Selector::Text("新代次节点")).unwrap();
    assert_eq!(old.snapshot_id(), current.snapshot_id());
    assert_eq!(old.epoch(), current.epoch());
    assert_eq!(old.raw_child_path(), current.raw_child_path());
    // 刻意传新 binding，而不是靠旧 binding 与缓存不同来拒绝。
    assert_eq!(restarted.action_target_for_binding(7, &new_binding, old.ref_id()).unwrap_err().code(), "stale-generation");
    assert_eq!(restarted.action_target(old.ref_id()).unwrap_err().code(), "stale-generation");
    let before = restarted.snapshot_json(&new_binding.alias).unwrap().to_owned();
    assert_eq!(restarted.invalidate_ref(old.ref_id()).unwrap_err().code(), "stale-generation");
    assert_eq!(restarted.snapshot_json(&new_binding.alias).unwrap(), before);
    assert_eq!(restarted.action_target_for_binding(7, &new_binding, current.ref_id()).unwrap(), current);
}

#[test]
fn ref_resolution_checks_the_entire_current_policy_binding() {
    let screen = binding("virtual-1", 41, 2);
    let mut store = UiTreeStore::new(7);
    replace_ok(&mut store, &screen, basic_tree("virtual-1", 41, 2));
    let target = store.select(&screen.alias, Selector::Text("确定")).unwrap();
    assert_eq!(store.action_target_for_binding(8, &screen, target.ref_id()).unwrap_err().code(), "stale-epoch");
    let mut changed = vec![screen.clone(); 6];
    changed[0].alias = "virtual-2".to_owned();
    changed[1].display_id += 1;
    changed[2].generation += 1;
    changed[3].width += 1;
    changed[4].height += 1;
    changed[5].rotation = 1;
    for current_binding in changed {
        assert_eq!(store.action_target_for_binding(7, &current_binding, target.ref_id()).unwrap_err().code(), "stale-generation");
    }
    assert_eq!(store.action_target_for_binding(7, &screen, target.ref_id()).unwrap(), target);
}

#[test]
fn ref_segments_reject_noncanonical_overflow_and_forged_values() {
    let mut store = UiTreeStore::new(7);
    replace_ok(&mut store, &binding("virtual-1", 41, 2), basic_tree("virtual-1", 41, 2));
    let before = store.snapshot_json("virtual-1").unwrap().to_owned();
    let malformed = [
        "", "s1:n1", "e7:g2:s1", "e7:g2:s1:n1:extra", "e7:g2:s1:n1:",
        "e:g2:s1:n1", "e7:g:s1:n1", "e7:g2:s:n1", "e7:g2:s1:n",
        "e07:g2:s1:n1", "e7:g02:s1:n1", "e7:g2:s01:n1", "e7:g2:s1:n01",
        "e+7:g2:s1:n1", "e-7:g2:s1:n1", "e7:g2:s0:n1", "e7:g2:s1:n-1",
        "e7:g2:s1:n1 ", " e7:g2:s1:n1", "e７:g2:s1:n1", "e7:s1:g2:n1",
        "e7:g2:s1:n1\n", "e7:g2:s1:n1\0",
        "e18446744073709551616:g2:s1:n1", "e7:g18446744073709551616:s1:n1",
        "e7:g2:s18446744073709551616:n1", "e7:g2:s1:n18446744073709551616",
        "e7:g2:s1:n00000000000000000000000000000000000001",
    ];
    for ref_id in malformed {
        assert_eq!(store.action_target(ref_id).unwrap_err().code(), "ref-malformed", "{ref_id:?}");
        assert_eq!(store.invalidate_ref(ref_id).unwrap_err().code(), "ref-malformed", "{ref_id:?}");
    }
    for (ref_id, code) in [
        ("e8:g2:s1:n1", "stale-epoch"),
        ("e7:g3:s1:n1", "stale-generation"),
        ("e7:g2:s2:n1", "stale-snapshot"),
        ("e7:g2:s1:n4000", "ref-not-found"),
        ("e7:g2:s1:n18446744073709551615", "ref-not-found"),
        ("e7:g2:s18446744073709551615:n1", "stale-snapshot"),
    ] {
        assert_eq!(store.action_target(ref_id).unwrap_err().code(), code, "{ref_id}");
        assert_eq!(store.invalidate_ref(ref_id).unwrap_err().code(), code, "{ref_id}");
    }
    assert_eq!(store.snapshot_json("virtual-1").unwrap(), before);

    // epoch/generation 是 policy 提供的 opaque u64，边界值不得被截断或改写。
    for value in [0, u64::MAX] {
        let screen = binding("virtual-1", 41, value);
        let mut raw = basic_tree("virtual-1", 41, value);
        raw.target.epoch = value.to_string();
        let mut boundary_store = UiTreeStore::new(value);
        boundary_store.replace(value, &screen, raw).unwrap();
        let target = boundary_store.select(&screen.alias, Selector::Text("确定")).unwrap();
        assert_eq!(target.ref_id(), format!("e{value}:g{value}:s1:n1"));
        assert_eq!(boundary_store.action_target_for_binding(value, &screen, target.ref_id()).unwrap(), target);
    }
}

#[test]
fn invalidated_target_cannot_be_resolved_or_verified() {
    let mut store = UiTreeStore::new(7);
    replace_ok(&mut store, &binding("virtual-1", 41, 2), basic_tree("virtual-1", 41, 2));
    let target = store.select("virtual-1", Selector::Text("确定")).unwrap();
    let fresh = basic_tree("virtual-1", 41, 2).nodes.remove(1);
    store.verify_target(&target, &fresh).unwrap();
    store.invalidate_target(&target).unwrap();
    assert_eq!(store.action_target(target.ref_id()).unwrap_err().code(), "ref-invalidated");
    assert_eq!(store.verify_target(&target, &fresh).unwrap_err().code(), "ref-invalidated");
    assert_eq!(store.select("virtual-1", Selector::Text("确定")).unwrap_err().code(), "selector-not-found");
    assert!(store.snapshot_json("virtual-1").unwrap().contains("\"invalidatedCount\":1"));

    let mut saturated = UiTreeStore::with_last_snapshot_id(7);
    assert_eq!(
        saturated.replace(7, &binding("virtual-1", 41, 2), basic_tree("virtual-1", 41, 2)).unwrap_err().code(),
        "snapshot-id-exhausted"
    );

    store.invalidate_all();
    assert_eq!(store.screen_count(), 0);
}

#[test]
fn fresh_node_identity_mismatch_never_retargets() {
    let mut store = UiTreeStore::new(7);
    replace_ok(&mut store, &binding("virtual-1", 41, 2), basic_tree("virtual-1", 41, 2));
    let target = store.select("virtual-1", Selector::Text("确定")).unwrap();
    let base = basic_tree("virtual-1", 41, 2).nodes.remove(1);
    store.verify_target(&target, &base).unwrap();

    let mutations: Vec<(&str, Box<dyn Fn(&mut RawNodeInput)>)> = vec![
        ("path", Box::new(|node| node.path = vec![1])),
        ("class", Box::new(|node| node.class_name = "android.widget.Button".to_owned())),
        ("package", Box::new(|node| node.package_name = "com.other".to_owned())),
        ("viewId", Box::new(|node| node.view_id = "com.example.app:id/cancel".to_owned())),
        ("text", Box::new(|node| node.text = "取消".to_owned())),
        ("description", Box::new(|node| node.content_description = "另一个".to_owned())),
        ("bounds", Box::new(|node| node.bounds.left += 1)),
        ("editable", Box::new(|node| node.editable = true)),
        ("enabled", Box::new(|node| node.enabled = false)),
        ("windowId", Box::new(|node| node.window_id = 13)),
    ];
    for (label, mutate) in mutations {
        let mut fresh = base.clone();
        mutate(&mut fresh);
        let error = store.verify_target(&target, &fresh).unwrap_err();
        assert_eq!(error.code(), "target-identity-mismatch", "{label}");
    }
}

#[test]
fn real_child_holes_keep_original_paths() {
    let mut store = UiTreeStore::new(7);
    let mut root = node(Vec::new(), "", "");
    root.class_name = "android.widget.FrameLayout".to_owned();
    let direct = node(vec![2], "第二", "com.example.app:id/two");
    let nested = node(vec![2, 0], "深层", "com.example.app:id/deep");
    let raw = tree("virtual-1", 41, 2, vec![root, direct, nested]);
    replace_ok(&mut store, &binding("virtual-1", 41, 2), raw);

    let direct = store.select("virtual-1", Selector::Text("第二")).unwrap();
    let nested = store.select("virtual-1", Selector::Text("深层")).unwrap();
    assert_eq!(direct.raw_child_path(), &[2]);
    assert_eq!(nested.raw_child_path(), &[2, 0]);
    assert!(store.snapshot_json("virtual-1").unwrap().contains("\"path\":[2,0]"));

    let mut missing_parent = tree(
        "virtual-1",
        41,
        2,
        vec![
            node(Vec::new(), "", ""),
            node(vec![2, 0], "空洞", ""),
        ],
    );
    missing_parent.nodes[0].class_name = "android.widget.FrameLayout".to_owned();
    assert_eq!(
        store.replace(7, &binding("virtual-1", 41, 2), missing_parent).unwrap_err().code(),
        "parent-missing"
    );
}

#[test]
fn gaps_between_sibling_indexes_are_preserved() {
    let mut store = UiTreeStore::new(7);
    let root = node(Vec::new(), "", "");
    let only_child = node(vec![7], "稀疏同级", "com.example.app:id/sparse");
    replace_ok(
        &mut store,
        &binding("virtual-1", 41, 2),
        tree("virtual-1", 41, 2, vec![root, only_child]),
    );
    let target = store.select("virtual-1", Selector::Text("稀疏同级")).unwrap();
    assert_eq!(target.raw_child_path(), &[7]);
    assert!(store.snapshot_json("virtual-1").unwrap().contains("\"path\":[7]"));
}

#[test]
fn selectors_are_exact_and_ambiguous_or_missing_are_not_guessed() {
    let mut store = UiTreeStore::new(7);
    let mut root = node(Vec::new(), "", "");
    root.class_name = "android.widget.FrameLayout".to_owned();
    let mut first = node(vec![0], "确定", "com.example.app:id/ok");
    first.content_description = "提交表单".to_owned();
    let mut second = node(vec![1], "确定", "com.example.app:id/ok2");
    second.content_description = "提交表单".to_owned();
    replace_ok(
        &mut store,
        &binding("virtual-1", 41, 2),
        tree("virtual-1", 41, 2, vec![root, first, second]),
    );

    assert_eq!(
        store.select("virtual-1", Selector::Text("确定")).unwrap_err().code(),
        "selector-ambiguous"
    );
    assert_eq!(
        store.select("virtual-1", Selector::ResourceId("com.example.app:id/ok")).unwrap().raw_child_path(),
        &[0]
    );
    assert_eq!(
        store.select("virtual-1", Selector::Description("提交表单")).unwrap_err().code(),
        "selector-ambiguous"
    );
    assert_eq!(
        store.select("virtual-1", Selector::Text("确")).unwrap_err().code(),
        "selector-not-found"
    );
    assert_eq!(
        store.select("virtual-1", Selector::Text("")).unwrap_err().code(),
        "selector-empty"
    );
}

#[test]
fn incomplete_tree_is_explicit_and_absence_is_not_treated_as_complete() {
    let mut store = UiTreeStore::new(7);
    let mut raw = basic_tree("virtual-1", 41, 2);
    raw.complete = false;
    raw.stop_reason = Some("cancelled".to_owned());
    let info = store.replace(7, &binding("virtual-1", 41, 2), raw).unwrap();
    assert!(!info.complete);
    assert_eq!(info.stop_reason.as_deref(), Some("cancelled"));
    assert!(store.snapshot_json("virtual-1").unwrap().contains("\"complete\":false"));
    assert!(store.snapshot_json("virtual-1").unwrap().contains("\"stopReason\":\"cancelled\""));
    assert_eq!(
        store.select("virtual-1", Selector::Text("没采到")).unwrap_err().code(),
        "tree-incomplete"
    );

    let mut missing_reason = basic_tree("virtual-1", 41, 2);
    missing_reason.complete = false;
    assert_eq!(
        store.replace(7, &binding("virtual-1", 41, 2), missing_reason).unwrap_err().code(),
        "incomplete-without-reason"
    );
    let mut reason_on_complete = basic_tree("virtual-1", 41, 2);
    reason_on_complete.stop_reason = Some("node-limit".to_owned());
    assert_eq!(
        store.replace(7, &binding("virtual-1", 41, 2), reason_on_complete).unwrap_err().code(),
        "complete-with-reason"
    );
    let mut invented = basic_tree("virtual-1", 41, 2);
    invented.complete = false;
    invented.stop_reason = Some("done".to_owned());
    assert_eq!(
        store.replace(7, &binding("virtual-1", 41, 2), invented).unwrap_err().code(),
        "invalid-stop-reason"
    );
}

#[test]
fn output_keeps_unicode_text_role_bounds_and_ref_without_dropping_self_drawn_root() {
    let mut store = UiTreeStore::new(7);
    let mut root = node(Vec::new(), "", "");
    root.class_name = "com.example.CanvasRoot".to_owned();
    root.clickable = false;
    let mut child = node(vec![0], "你好，世界 🌏", "");
    child.class_name = "android.view.View".to_owned();
    child.content_description = "自绘内容".to_owned();
    child.bounds = RawBoundsInput { left: -5, top: 20, right: 1075, bottom: 2400 };
    replace_ok(
        &mut store,
        &binding("virtual-1", 41, 2),
        tree("virtual-1", 41, 2, vec![root, child]),
    );

    let rendered = store.snapshot_json("virtual-1").unwrap();
    let parsed: Value = serde_json::from_str(rendered).unwrap();
    assert_eq!(parsed["nodeCount"], 2);
    assert_eq!(parsed["nodes"][0]["role"], "CanvasRoot");
    assert_eq!(parsed["nodes"][1]["text"], "你好，世界 🌏");
    assert_eq!(parsed["nodes"][1]["bounds"]["left"], -5);
    assert_eq!(parsed["nodes"][1]["ref"], "e7:g2:s1:n1");
    assert_eq!(parsed["nodes"][1]["readOnly"], true);
}

#[test]
fn node_depth_field_and_total_memory_limits_fail_closed() {
    let screen = binding("virtual-1", 41, 2);

    let mut too_deep = tree("virtual-1", 41, 2, vec![node(vec![0; MAX_DEPTH + 1], "深", "")]);
    too_deep.nodes[0].class_name = "root".to_owned();
    let mut store = UiTreeStore::new(7);
    assert_eq!(store.replace(7, &screen, too_deep).unwrap_err().code(), "depth-limit");

    let mut too_many = tree(
        "virtual-1",
        41,
        2,
        (0..=MAX_NODES).map(|index| node(vec![index as u32], "x", "")).collect(),
    );
    too_many.nodes[0].class_name = "root".to_owned();
    assert_eq!(store.replace(7, &screen, too_many).unwrap_err().code(), "node-limit");

    let mut field = basic_tree("virtual-1", 41, 2);
    field.nodes[1].text = "字".repeat(MAX_FIELD_BYTES);
    assert_eq!(store.replace(7, &screen, field).unwrap_err().code(), "field-too-large");

    let mut total = basic_tree("virtual-1", 41, 2);
    total.nodes[1].text = "a".repeat(MAX_FIELD_BYTES);
    for index in 1..18u32 {
        let mut extra = node(vec![index], "", "");
        extra.text = "a".repeat(MAX_FIELD_BYTES);
        total.nodes.push(extra);
    }
    assert!(total.nodes.iter().map(|node| node.text.len()).sum::<usize>() > MAX_TOTAL_TEXT_BYTES);
    assert_eq!(store.replace(7, &screen, total).unwrap_err().code(), "text-budget");
    assert_eq!(store.screen_count(), 0);
}

#[test]
fn failed_replacement_leaves_old_store_and_ids_untouched() {
    let mut store = UiTreeStore::new(7);
    let screen = binding("virtual-1", 41, 2);
    replace_ok(&mut store, &screen, basic_tree("virtual-1", 41, 2));
    let before = store.snapshot_json("virtual-1").unwrap().to_owned();
    let target = store.select("virtual-1", Selector::Text("确定")).unwrap();
    let fresh = basic_tree("virtual-1", 41, 2).nodes.remove(1);

    let mut duplicate = basic_tree("virtual-1", 41, 2);
    duplicate.nodes.push(node(vec![0], "重复", ""));
    assert_eq!(store.replace(7, &screen, duplicate).unwrap_err().code(), "duplicate-path");
    assert_eq!(store.snapshot_json("virtual-1").unwrap(), before);
    assert_eq!(store.snapshot("virtual-1").unwrap().snapshot_id, 1);
    store.verify_target(&target, &fresh).unwrap();

    let wrong_window = basic_tree("virtual-1", 41, 2);
    let mut raw_window = wrong_window;
    raw_window.window_id = 13;
    assert_eq!(store.replace(7, &screen, raw_window).unwrap_err().code(), "window-mismatch");
    assert_eq!(store.snapshot_json("virtual-1").unwrap(), before);

    let next = store.replace(7, &screen, basic_tree("virtual-1", 41, 2)).unwrap();
    assert_eq!(next.snapshot_id, 2, "failed replacement must not burn an id");
}

#[test]
fn eight_screen_cache_limit_fails_without_touching_existing_snapshots() {
    let mut store = UiTreeStore::new(7);
    for index in 0..MAX_SCREENS {
        let alias = format!("virtual-{index}");
        let display = 41 + index as i32;
        replace_ok(&mut store, &binding(&alias, display, 2), basic_tree(&alias, display, 2));
    }
    let before = store.snapshot_json("virtual-0").unwrap().to_owned();
    let ninth = binding("virtual-8", 50, 2);
    assert_eq!(
        store.replace(7, &ninth, basic_tree("virtual-8", 50, 2)).unwrap_err().code(),
        "screen-limit"
    );
    assert_eq!(store.screen_count(), MAX_SCREENS);
    assert_eq!(store.snapshot_json("virtual-0").unwrap(), before);
}

#[test]
fn action_target_json_carries_precise_window_path_identity_and_context() {
    let mut store = UiTreeStore::new(7);
    replace_ok(&mut store, &binding("virtual-1", 41, 2), basic_tree("virtual-1", 41, 2));
    let target = store.select("virtual-1", Selector::ResourceId("com.example.app:id/ok")).unwrap();
    let value: Value = serde_json::from_str(&target.to_json()).unwrap();
    assert_eq!(value["ref"], "e7:g2:s1:n1");
    assert_eq!(value["snapshotId"], "1");
    assert_eq!(value["windowId"], 12);
    assert_eq!(value["rawChildPath"], json!([0]));
    assert_eq!(value["identity"]["className"], "android.widget.TextView");
    assert_eq!(value["identity"]["text"], "确定");
    assert_eq!(value["identity"]["bounds"]["right"], 210);
    assert_eq!(value["identity"]["path"], json!([0]));
}

#[test]
fn wire_identity_tokens_remain_exact_strings_above_javascript_integer_precision() {
    for token in [(1u64 << 53) + 1, u64::MAX] {
        let screen = binding("virtual-1", 41, token);
        let mut raw = basic_tree("virtual-1", 41, token);
        raw.target.epoch = token.to_string();
        let mut store = UiTreeStore::new(token);
        let info = store.replace(token, &screen, raw).unwrap();
        let target = store.select(&screen.alias, Selector::Text("确定")).unwrap();
        let expected = token.to_string();
        for wire in [
            target.to_json(),
            store.snapshot_json(&screen.alias).unwrap().to_owned(),
            serde_json::to_string(&info).unwrap(),
            store.compact_snapshot_json(&screen.alias).unwrap().unwrap(),
        ] {
            let value: Value = serde_json::from_str(&wire).unwrap();
            assert_eq!(value["epoch"].as_str(), Some(expected.as_str()));
            assert_eq!(value["generation"].as_str(), Some(expected.as_str()));
            assert_eq!(value["snapshotId"].as_str(), Some("1"));
            assert_eq!(value["displayId"], 41);
        }
        assert_eq!(target.ref_id(), format!("e{token}:g{token}:s1:n1"));
        // 无须推进 2^53 次快照，也实际覆盖 SnapshotInfo 的大 snapshotId 序列化。
        let mut high_snapshot_info = info;
        high_snapshot_info.snapshot_id = token;
        let serialized = serde_json::to_string(&high_snapshot_info).unwrap();
        let value: Value = serde_json::from_str(&serialized).unwrap();
        assert_eq!(value["snapshotId"].as_str(), Some(expected.as_str()));
        assert_eq!(high_snapshot_info.snapshot_id, token, "Rust 身份类型仍是 u64");
    }
}

#[test]
fn compact_output_reduces_bytes_preserves_all_nodes_states_and_verification_identity() {
    let screen = binding("virtual-1", 41, 2);
    let mut root = node(Vec::new(), "", "");
    root.class_name = "com.example.CanvasRoot".to_owned();
    root.clickable = false;
    let mut label = node(vec![3], "你好，世界 🌏", "com.example.app:id/label");
    label.clickable = false;
    label.content_description = "只读说明".to_owned();
    label.bounds.left = -5;
    let mut input = node(vec![9], "可编辑", "com.example.app:id/input");
    input.editable = true;
    input.focused = true;
    input.selected = true;
    input.scrollable = true;
    let mut unchecked = node(vec![11], "未选中", "");
    unchecked.checkable = true;
    unchecked.enabled = false;
    unchecked.visible = false;
    let mut checked = node(vec![15], "已选中", "");
    checked.checkable = true;
    checked.checked = true;
    let raw = tree("virtual-1", 41, 2, vec![root, label, input, unchecked, checked]);
    let fresh = raw.nodes[2].clone();
    let mut store = UiTreeStore::new(7);
    replace_ok(&mut store, &screen, raw);
    let before = store.snapshot_json(&screen.alias).unwrap().to_owned();
    let compact = store.compact_snapshot_json(&screen.alias).unwrap().unwrap();
    println!("mixed tree: full={} compact={} bytes", before.len(), compact.len());
    assert!(compact.len() < before.len() * 3 / 4);
    let diagnostic: Value = serde_json::from_str(&before).unwrap();
    let value: Value = serde_json::from_str(&compact).unwrap();
    for field in ["snapshotId", "epoch", "generation", "screenId", "displayId", "logicalWidth",
        "logicalHeight", "windowId", "complete", "stopReason", "nodeCount", "invalidatedCount"] {
        assert_eq!(value[field], diagnostic[field], "{field}");
    }
    assert_eq!(value["logicalWidth"], 1080);
    assert_eq!(value["logicalHeight"], 2400);
    assert_eq!(value["complete"], true);
    assert_eq!(value["stopReason"], Value::Null);
    assert_eq!(value["nodes"].as_array().unwrap().len(), 5);
    for (compact_node, full_node) in value["nodes"].as_array().unwrap().iter()
        .zip(diagnostic["nodes"].as_array().unwrap()) {
        for field in ["ref", "role", "bounds"] {
            assert_eq!(compact_node[field], full_node[field], "{field}");
        }
        for field in ["text", "description", "viewId"] {
            if full_node[field] == "" {
                assert!(compact_node.get(field).is_none(), "omit empty {field}");
            } else {
                assert_eq!(compact_node[field], full_node[field], "{field}");
            }
        }
        for field in ["clickable", "scrollable", "editable", "readOnly", "checkable", "checked",
            "enabled", "focused", "visible", "selected", "invalidated"] {
            let state = compact_node.get(field).unwrap_or(&value["nodeDefaults"][field]);
            assert_eq!(state, &full_node[field], "{field}");
        }
        for field in ["path", "windowId", "class", "className", "package", "packageName"] {
            assert!(compact_node.get(field).is_none(), "no repeated {field}");
        }
        let ref_id = compact_node["ref"].as_str().unwrap();
        store.action_target_for_binding(7, &screen, ref_id).unwrap();
    }
    assert_eq!(value["nodes"][0]["role"], "CanvasRoot");
    assert_eq!(value["nodes"][1]["text"], "你好，世界 🌏");
    assert_eq!(value["nodeDefaults"]["readOnly"], true);
    assert_eq!(value["nodes"][2]["readOnly"], false);
    assert_eq!(value["nodes"][3]["enabled"], false);
    assert_eq!(value["nodes"][3]["visible"], false);
    assert_eq!(store.snapshot_json(&screen.alias).unwrap(), before);
    let target = store.action_target(value["nodes"][2]["ref"].as_str().unwrap()).unwrap();
    assert_eq!(target.raw_child_path(), &[9]);
    store.verify_target(&target, &fresh).unwrap();
    let mut changed = fresh;
    changed.package_name = "com.other".to_owned();
    assert_eq!(store.verify_target(&target, &changed).unwrap_err().code(), "target-identity-mismatch");
}

#[test]
fn compact_keeps_incomplete_and_invalidated_nodes_and_distinguishes_missing_screen() {
    let mut store = UiTreeStore::new(7);
    assert_eq!(store.compact_snapshot_json("virtual-1").unwrap(), None);
    let mut raw = basic_tree("virtual-1", 41, 2);
    raw.complete = false;
    raw.stop_reason = Some("cancelled".to_owned());
    replace_ok(&mut store, &binding("virtual-1", 41, 2), raw);
    let target = store.select("virtual-1", Selector::Text("确定")).unwrap();
    store.invalidate_target(&target).unwrap();
    let value: Value = serde_json::from_str(&store.compact_snapshot_json("virtual-1").unwrap().unwrap()).unwrap();
    assert_eq!(value["complete"], false);
    assert_eq!(value["stopReason"], "cancelled");
    assert_eq!(value["nodeCount"], 2);
    assert_eq!(value["nodes"].as_array().unwrap().len(), 2);
    assert_eq!(value["invalidatedCount"], 1);
    assert_eq!(value["nodes"][1]["ref"], target.ref_id());
    assert_eq!(value["nodes"][1]["invalidated"], true);
}

fn full_budget_tree(text: &str) -> RawTreeInput {
    let mut nodes = Vec::with_capacity(MAX_NODES);
    let bytes_per_node = MAX_TOTAL_TEXT_BYTES / MAX_NODES;
    let remainder = MAX_TOTAL_TEXT_BYTES % MAX_NODES;
    for ordinal in 0..MAX_NODES {
        let path = if ordinal == 0 { vec![] } else { vec![ordinal as u32] };
        let mut raw = node(path, "", "");
        raw.class_name = "View".to_owned();
        raw.package_name.clear();
        raw.clickable = false;
        let capacity = bytes_per_node + usize::from(ordinal < remainder) - raw.class_name.len();
        assert!(capacity >= text.len());
        raw.text = text.to_owned() + &"x".repeat(capacity - text.len());
        nodes.push(raw);
    }
    assert_eq!(nodes.iter().map(|node| node.class_name.len() + node.text.len()).sum::<usize>(), MAX_TOTAL_TEXT_BYTES);
    tree("virtual-1", 41, u64::MAX, nodes)
}

#[test]
fn compact_handles_four_thousand_nodes_and_full_utf8_budget_without_truncation() {
    let mut store = UiTreeStore::new(u64::MAX);
    let screen = binding("virtual-1", 41, u64::MAX);
    let mut raw = full_budget_tree("只读 🌏");
    raw.target.epoch = u64::MAX.to_string();
    store.replace(u64::MAX, &screen, raw).unwrap();
    let compact = store.compact_snapshot_json(&screen.alias).unwrap().unwrap();
    println!("4000 nodes / 1 MiB UTF-8: full={} compact={} limit={} bytes",
        store.snapshot_json(&screen.alias).unwrap().len(), compact.len(), MAX_COMPACT_JSON_BYTES);
    assert!(compact.len() <= MAX_COMPACT_JSON_BYTES);
    assert!(compact.len() < store.snapshot_json(&screen.alias).unwrap().len());
    let value: Value = serde_json::from_str(&compact).unwrap();
    assert_eq!(value["nodeCount"], MAX_NODES);
    let nodes = value["nodes"].as_array().unwrap();
    assert_eq!(nodes.len(), MAX_NODES);
    assert_eq!(value["complete"], true);
    assert_eq!(value["stopReason"], Value::Null);
    assert_eq!(value["logicalWidth"], 1080);
    assert_eq!(value["logicalHeight"], 2400);
    assert!(nodes.iter().all(|node| node["text"].as_str().unwrap().starts_with("只读 🌏")));
    for ordinal in [0, MAX_NODES - 1] {
        let target = store.action_target_for_binding(u64::MAX, &screen, nodes[ordinal]["ref"].as_str().unwrap()).unwrap();
        assert_eq!(target.raw_child_path(), if ordinal == 0 { vec![] } else { vec![ordinal as u32] });
    }
}

#[test]
fn compact_rejects_json_escape_expansion_over_budget_without_mutating_store() {
    let mut raw = full_budget_tree("");
    raw.target.epoch = u64::MAX.to_string();
    for node in &mut raw.nodes {
        node.text = "\0".repeat(node.text.len());
    }
    let screen = binding("virtual-1", 41, u64::MAX);
    let fresh = raw.nodes[1].clone();
    let mut store = UiTreeStore::new(u64::MAX);
    let info = store.replace(u64::MAX, &screen, raw).unwrap();
    let before = store.snapshot_json(&screen.alias).unwrap().to_owned();
    let diagnostic: Value = serde_json::from_str(&before).unwrap();
    let target = store.action_target(diagnostic["nodes"][1]["ref"].as_str().unwrap()).unwrap();
    let error = store.compact_snapshot_json(&screen.alias).unwrap_err();
    assert_eq!(error.code(), "compact-output-too-large");
    assert_eq!(store.snapshot(&screen.alias).unwrap(), &info);
    assert_eq!(store.snapshot_json(&screen.alias).unwrap(), before);
    assert!(info.complete);
    assert_eq!(info.node_count, MAX_NODES);
    store.verify_target(&target, &fresh).unwrap();
    println!("JSON escaping overflow: explicit {}, stored complete={} nodes={}", error.code(), info.complete, info.node_count);
}
