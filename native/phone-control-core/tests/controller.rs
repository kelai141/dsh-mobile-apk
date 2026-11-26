use std::collections::BTreeMap;
use std::fs;
use std::sync::{Arc, Mutex};
use std::sync::OnceLock;

use dsh_phone_control_core::controller::{Controller, PROTOCOL_VERSION};
use dsh_phone_control_core::lifecycle::{Journal, JournalError};
use serde_json::{json, Value};

fn init_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

#[derive(Clone, Default)]
struct MemoryJournal(Arc<Mutex<Option<Vec<u8>>>>);

impl Journal for MemoryJournal {
    fn load(&mut self) -> Result<Option<Vec<u8>>, JournalError> {
        Ok(self.0.lock().unwrap().clone())
    }

    fn store(&mut self, state: &[u8]) -> Result<(), JournalError> {
        *self.0.lock().unwrap() = Some(state.to_vec());
        Ok(())
    }
}

#[derive(Clone, Default)]
struct FailingJournal {
    inner: MemoryJournal,
    fail: Arc<Mutex<bool>>,
}

impl FailingJournal {
    fn set_failing(&self, value: bool) {
        *self.fail.lock().unwrap() = value;
    }
}

impl Journal for FailingJournal {
    fn load(&mut self) -> Result<Option<Vec<u8>>, JournalError> {
        self.inner.load()
    }

    fn store(&mut self, state: &[u8]) -> Result<(), JournalError> {
        if *self.fail.lock().unwrap() {
            Err(JournalError::store("injected journal failure"))
        } else {
            self.inner.store(state)
        }
    }
}

fn controller() -> Controller<MemoryJournal> {
    Controller::with_journal(MemoryJournal::default(), 900).unwrap()
}

#[test]
fn native_shell_admission_separates_root_and_checks_live_scope_and_termux() {
    let mut core = controller();
    let mut input = facts("virtual-only", 0, "no");
    input["facts"]["shizuku"] = json!({"installed":"yes","running":"yes","granted":"yes",
        "bound":"yes","functionalReady":"yes","serverUid":{"kind":"shell2000"},
        "supportedOps":{"state":"known","ops":["shExec"]}});
    input["facts"]["root"] = json!({"authorization":"yes","consentValid":"yes","appSu":"yes"});
    input["facts"]["termuxReady"] = json!("yes");
    assert_eq!(call(&mut core, input.clone())["ok"], true);
    let request = |op: &str, id: &str, command: &str| json!({"protocolVersion":1,"kind":"prepare",
        "callId":id,"operation":op,"epoch":"900","args":{"command":command}});
    let inspected = call(&mut core, request("shExec", "query-ime", "settings get secure default_input_method"));
    assert_eq!(inspected["code"], "prepared", "{inspected}");
    assert_eq!(inspected["plan"]["backend"], "shizuku");
    let screen_denied = call(&mut core, request("shExec", "private-window", "dumpsys window windows"));
    assert_eq!(screen_denied["code"], "screen-out-of-scope", "{screen_denied}");
    let ordinary_write = call(&mut core, request("shExec", "no-promotion", "settings put global wifi_on 0"));
    assert_eq!(ordinary_write["code"], "shell-command-denied", "{ordinary_write}");
    let root = call(&mut core, request("rootExec", "independent-root", "printf 'root 中文'"));
    assert_eq!(root["plan"]["backend"], "root", "{root}");
    let termux = call(&mut core, request("termuxExec", "app-shell", "printf hello"));
    assert_eq!(termux["plan"]["backend"], "local", "{termux}");
    input["facts"]["root"]["consentValid"] = json!("no");
    input["facts"]["termuxReady"] = json!("no");
    assert_eq!(call(&mut core, input.clone())["ok"], true);
    for id in ["independent-root", "app-shell"] {
        let denied = call(&mut core, json!({"protocolVersion":1,"kind":"commit","callId":id}));
        assert_eq!(denied["executed"], "no", "{denied}");
        assert_eq!(denied["code"], "authorization-changed", "{denied}");
    }
    // An ordinary Shizuku call cannot use a server which has changed to uid 0.
    input["facts"]["shizuku"]["serverUid"] = json!({"kind":"root0"});
    assert_eq!(call(&mut core, input)["ok"], true);
    let denied = call(&mut core, request("shExec", "root-is-not-shell", "id"));
    assert_eq!(denied["ok"], false, "{denied}");
}

#[test]
fn explicit_native_diagnostics_are_bounded_and_do_not_retain_payloads() {
    let mut core = controller();
    publish_default(&mut core);
    for number in 0..80 {
        let refused = call(&mut core, json!({"protocolVersion":1,"kind":"prepare","epoch":"900",
            "callId":format!("audit-{number}"),"operation":"rootExec","args":{"command":"secret-command-body 中文"}}));
        assert_eq!(refused["ok"], false, "{refused}");
    }
    let diagnostics = call(&mut core, json!({"protocolVersion":1,"kind":"diagnostics"}));
    assert_eq!(diagnostics["recent"].as_array().unwrap().len(), 64);
    assert!(diagnostics["exchanges"].as_u64().unwrap() >= 81);
    assert!(!diagnostics.to_string().contains("secret-command-body"));
    assert!(!diagnostics.to_string().contains("中文"));
    assert!(diagnostics["recent"].as_array().unwrap().iter().all(|event| event["ok"] == false));
    let capabilities = call(&mut core, json!({"protocolVersion":1,"kind":"capabilities"}));
    assert!(capabilities.get("recent").is_none());
    let fast: Value = serde_json::from_str(&core.exchange_nonblocking("{\"protocolVersion\":1,\"kind\":\"diagnostics\"}")).unwrap();
    assert_eq!(fast["ok"], true);
}

#[test]
fn swipe_endpoints_are_points_and_keys_cannot_expand_to_shell_commands() {
    let mut core = controller();
    let mut input = facts("virtual-only", 0, "yes");
    input["facts"]["a11y"]["supportedOps"]["ops"] = json!(["swipe"]);
    input["facts"]["shizuku"] = json!({"installed":"yes","running":"yes","granted":"yes",
        "bound":"yes","functionalReady":"yes","serverUid":{"kind":"shell2000"},
        "supportedOps":{"state":"known","ops":["keyEvent"]},
        "displaySupport":{"state":"known","values":{"41":true}}});
    assert_eq!(call(&mut core, input)["ok"], true);
    let swipe = call(&mut core, json!({"protocolVersion":1,"kind":"prepare","operation":"swipe",
        "callId":"reverse-swipe","epoch":"900","screenId":"virtual-1",
        "args":{"x1":900,"y1":1500,"x2":5,"y2":40,"durationMs":500}}));
    assert_eq!(swipe["code"], "prepared", "{swipe}");
    assert_eq!(swipe["plan"]["backend"], "a11y");
    for (index, args) in [json!({"x1":3,"y1":4,"x2":1080,"y2":5}),
        json!({"x1":3,"y1":4,"x2":3,"y2":4}),
        json!({"x1":3,"y1":4,"x2":5,"y2":6,"durationMs":2001})].into_iter().enumerate() {
        let denied = call(&mut core, json!({"protocolVersion":1,"kind":"prepare","operation":"swipe",
            "callId":format!("bad-swipe-{index}"),"epoch":"900","screenId":"virtual-1","args":args}));
        assert_eq!(denied["executed"], "no", "{denied}");
        assert_eq!(denied["ok"], false, "{denied}");
    }
    let key = call(&mut core, json!({"protocolVersion":1,"kind":"prepare","operation":"keyEvent",
        "callId":"virtual-enter","epoch":"900","screenId":"virtual-1","args":{"key":"enter"}}));
    assert_eq!(key["plan"]["backend"], "shizuku", "{key}");
    for args in [json!({"key":"home"}), json!({"key":"enter; reboot"}), json!({"key":"enter","text":"mixed"})] {
        let denied = call(&mut core, json!({"protocolVersion":1,"kind":"prepare","operation":"keyEvent",
            "callId":"invalid-key","epoch":"900","screenId":"virtual-1","args":args}));
        assert_eq!(denied["ok"], false, "{denied}");
        assert_eq!(denied["executed"], "no", "{denied}");
    }
}

#[test]
fn epoch_uses_nonzero_entropy_and_rejects_zero_or_error() {
    let first = dsh_phone_control_core::controller::new_epoch().unwrap();
    let second = dsh_phone_control_core::controller::new_epoch().unwrap();
    assert_ne!(first, 0);
    assert_ne!(second, 0);
    assert_ne!(first, second);

    let zero = dsh_phone_control_core::controller::new_epoch_from(|bytes| {
        *bytes = [0u8; 8];
        Ok(())
    })
    .unwrap_err();
    assert_eq!(zero.code(), "invalid-epoch");

    let failed = dsh_phone_control_core::controller::new_epoch_from(|_| Err("entropy unavailable".into()))
        .unwrap_err();
    assert_eq!(failed.code(), "entropy-unavailable");
}

#[test]
fn nonblocking_exchange_rejects_blocking_kinds() {
    let mut controller = controller();
    publish_default(&mut controller);
    let response: Value = serde_json::from_str(&controller.exchange_nonblocking(
        &json!({"protocolVersion": PROTOCOL_VERSION, "kind": "commit", "callId": "x"}).to_string(),
    ))
    .unwrap();
    assert_eq!(response["code"], "blocking-operation-rejected");
    assert_eq!(response["executed"], "unknown");
}

fn call<J: Journal>(controller: &mut Controller<J>, request: Value) -> Value {
    let response = controller.exchange(&request.to_string());
    serde_json::from_str(&response).unwrap_or_else(|error| panic!("bad JSON {response}: {error}"))
}

fn facts(scope: &str, rotation: u8, a11y_online: &str) -> Value {
    let mut displays = BTreeMap::new();
    displays.insert("41".to_string(), true);
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "kind": "publishFacts",
        "facts": {
            "scope": scope,
            "observedAtMs": 1,
            "screens": {
                "virtual-1": {"displayId": 41, "width": 1080, "height": 1920, "rotation": rotation}
            },
            "a11y": {
                "enabled": "yes",
                "online": a11y_online,
                "supportedOps": {"state": "known", "ops": ["click", "snapshot", "readRegion"]},
                "displaySupport": {"state": "known", "values": displays}
            },
            "shizuku": {},
            "root": {"authorization": "unknown", "consentValid": "unknown"}
        }
    })
}

fn facts_with_allocation(scope: &str, allocation: Value) -> Value {
    let mut input = facts(scope, 0, "yes");
    input["facts"]["screens"]["virtual-1"]["allocationId"] = allocation;
    input
}

fn publish_default<J: Journal>(controller: &mut Controller<J>) -> Value {
    call(controller, facts("all", 0, "yes"))
}

#[test]
fn shared_browser_keeps_its_dom_arguments_without_android_display_authority() {
    let mut core = controller();
    assert_eq!(call(&mut core, facts("virtual-only", 0, "no"))["ok"], true);
    let prepared = call(&mut core, json!({"protocolVersion":1,"kind":"prepare",
        "operation":"browserInput","callId":"browser-dom","epoch":"900",
        "args":{"session":"trusted-session","action":"click","x":450.5,"y":80.25}}));
    assert_eq!(prepared["code"], "prepared", "{prepared}");
    assert_eq!(prepared["plan"]["backend"], "browserHost");
    assert_eq!(prepared["plan"]["args"]["x"], 450.5);
    assert!(prepared["plan"].get("displayId").is_none(), "{prepared}");
    let denied = call(&mut core, json!({"protocolVersion":1,"kind":"prepare",
        "operation":"browserInput","callId":"browser-screen","epoch":"900",
        "screenId":"real","args":{"action":"click","x":1,"y":1}}));
    assert_eq!(denied["ok"], false, "{denied}");
    let malformed = call(&mut core, json!({"protocolVersion":1,"kind":"prepare",
        "operation":"browserJs","callId":"browser-malformed","epoch":"900","args":[]}));
    assert_eq!(malformed["ok"], false, "{malformed}");
}

#[test]
fn browser_refs_are_dispatched_to_browser_host_without_android_node_access() {
    let mut core = controller();
    assert_eq!(call(&mut core, facts("virtual-only", 0, "no"))["ok"], true);
    let tap = json!({"kind":"tap","ref":"bx1","tabId":"tab-1","pageGeneration":7});
    let text = json!({"kind":"text","ref":"bx2","tabId":"tab-1","pageGeneration":7,"text":"中文","replace":false});
    for (id, args) in [("browser-tap", tap), ("browser-text", text)] {
        let prepared = call(&mut core, json!({"protocolVersion":1,"kind":"prepare",
            "operation":"browserInput","callId":id,"epoch":"900","args":args}));
        assert_eq!(prepared["code"], "prepared", "{prepared}");
        assert_eq!(prepared["plan"]["backend"], "browserHost", "{prepared}");
        assert_eq!(prepared["plan"]["args"], args);
        assert!(prepared["plan"].get("nodeTarget").is_none(), "{prepared}");
        let committed = call(&mut core, json!({"protocolVersion":1,"kind":"commit","callId":id}));
        assert_eq!(committed["dispatch"], "permitted", "{committed}");
        assert_eq!(committed["plan"]["args"], args);
    }
}

#[test]
fn virtual_tools_follow_native_permission_and_validate_their_own_geometry() {
    let mut core = controller();
    let mut input = facts("virtual-only", 0, "no");
    input["facts"]["shizuku"] = json!({
        "installed":"yes","running":"yes","granted":"yes","bound":"yes","functionalReady":"yes",
        "serverUid":{"kind":"shell2000"},"supportedOps":{"state":"known","ops":["vdCreate","vdDestroy","vdLaunchApp","vdInfo"]},
        "displaySupport":{"state":"known","values":{"41":true}}
    });
    assert_eq!(call(&mut core, input.clone())["ok"], true);
    let caps = call(&mut core, json!({"protocolVersion":1,"kind":"capabilities"}));
    assert!(caps["operations"].as_array().unwrap().contains(&json!("vdCreate")), "{caps}");
    for args in [json!({"width":0,"height":900}), json!({"width":900}),
        json!({"width":900,"height":1600,"densityDpi":999}), json!({"argv":["sh"]})] {
        let bad = call(&mut core, json!({"protocolVersion":1,"kind":"prepare","epoch":"900",
            "callId":"bad-virtual","screenId":"virtual-1","operation":"vdCreate","args":args}));
        assert_eq!(bad["ok"], false, "{bad}");
    }
    let valid = call(&mut core, json!({"protocolVersion":1,"kind":"prepare","epoch":"900",
        "callId":"virtual-create","screenId":"virtual-1","operation":"vdCreate",
        "args":{"width":900,"height":1600,"densityDpi":240,"session":"trusted"}}));
    assert_eq!(valid["code"], "prepared", "{valid}");
    input["facts"]["shizuku"]["granted"] = json!("no");
    assert_eq!(call(&mut core, input.clone())["ok"], true);
    let caps = call(&mut core, json!({"protocolVersion":1,"kind":"capabilities"}));
    assert!(!caps["operations"].as_array().unwrap().contains(&json!("vdCreate")), "{caps}");
    let denied = call(&mut core, json!({"protocolVersion":1,"kind":"commit","callId":"virtual-create"}));
    assert_eq!(denied["executed"], "no", "{denied}");
}

#[test]
fn virtual_tools_advertise_and_plan_with_root_shizuku_and_revoke_on_consent_loss() {
    let mut core = controller();
    let mut input = facts("virtual-only", 0, "no");
    input["facts"]["shizuku"] = json!({
        "installed":"yes","running":"yes","granted":"yes","bound":"yes","functionalReady":"yes",
        "serverUid":{"kind":"root0"},
        "supportedOps":{"state":"unknown"},
        "displaySupport":{"state":"unknown"}
    });
    input["facts"]["root"] = json!({"authorization":"yes","consentValid":"yes","appSu":"yes"});
    assert_eq!(call(&mut core, input.clone())["ok"], true);

    let caps = call(&mut core, json!({"protocolVersion":1,"kind":"capabilities"}));
    let ops = caps["operations"].as_array().unwrap();
    for op in ["vdCreate", "vdDestroy", "vdLaunchApp", "vdInfo"] {
        assert!(ops.contains(&json!(op)), "missing {op} in {caps}");
    }
    assert!(!ops.contains(&json!("shExec")), "shExec must not advertise on uid 0: {caps}");

    let created = call(&mut core, json!({"protocolVersion":1,"kind":"prepare","epoch":"900",
        "callId":"root-vd-create","screenId":"virtual-1","operation":"vdCreate",
        "args":{"width":900,"height":1600,"densityDpi":240,"session":"trusted"}}));
    assert_eq!(created["code"], "prepared", "{created}");
    assert_eq!(created["plan"]["backend"], "root", "{created}");

    let launched = call(&mut core, json!({"protocolVersion":1,"kind":"prepare","epoch":"900",
        "callId":"root-vd-launch","screenId":"virtual-1","operation":"vdLaunchApp",
        "args":{"pkg":"com.android.settings","session":"trusted"}}));
    assert_eq!(launched["code"], "prepared", "{launched}");
    assert_eq!(launched["plan"]["backend"], "root", "{launched}");

    // Revoking AI root consent hides vd* ops and rejects in-flight commit.
    input["facts"]["root"]["consentValid"] = json!("no");
    assert_eq!(call(&mut core, input)["ok"], true);
    let after = call(&mut core, json!({"protocolVersion":1,"kind":"capabilities"}));
    let after_ops = after["operations"].as_array().unwrap();
    for op in ["vdCreate", "vdDestroy", "vdLaunchApp", "vdInfo"] {
        assert!(!after_ops.contains(&json!(op)), "{op} must disappear after root revoke: {after}");
    }
    let denied = call(&mut core, json!({"protocolVersion":1,"kind":"commit","callId":"root-vd-create"}));
    assert_eq!(denied["executed"], "no", "{denied}");
    assert_eq!(denied["code"], "authorization-changed", "{denied}");
}

#[test]
fn su_only_root_advertises_and_plans_launch_app_and_key_event_without_shizuku() {
    let mut core = controller();
    let mut input = facts("all", 0, "no");
    input["facts"]["screens"]["real"] = json!({"displayId":0,"width":1080,"height":2400,"rotation":0});
    input["facts"]["shizuku"] = json!({
        "installed":"no","running":"no","granted":"no","bound":"no","functionalReady":"no",
        "serverUid":{"kind":"unknown"},
        "supportedOps":{"state":"unknown"},
        "displaySupport":{"state":"unknown"}
    });
    input["facts"]["root"] = json!({"authorization":"yes","consentValid":"yes","appSu":"yes"});
    assert_eq!(call(&mut core, input.clone())["ok"], true);

    let caps = call(&mut core, json!({"protocolVersion":1,"kind":"capabilities"}));
    let ops = caps["operations"].as_array().unwrap();
    for op in ["launchApp", "keyEvent", "vdCreate", "vdDestroy", "vdLaunchApp", "vdInfo"] {
        assert!(ops.contains(&json!(op)), "missing {op} in {caps}");
    }

    let launch_real = call(&mut core, json!({"protocolVersion":1,"kind":"prepare","epoch":"900",
        "callId":"su-launch-real","screenId":"real","operation":"launchApp",
        "args":{"pkg":"com.android.settings"}}));
    assert_eq!(launch_real["code"], "prepared", "{launch_real}");
    assert_eq!(launch_real["plan"]["backend"], "root", "{launch_real}");

    let key_virtual = call(&mut core, json!({"protocolVersion":1,"kind":"prepare","epoch":"900",
        "callId":"su-key-virtual","screenId":"virtual-1","operation":"keyEvent",
        "args":{"key":"enter"}}));
    assert_eq!(key_virtual["code"], "prepared", "{key_virtual}");
    assert_eq!(key_virtual["plan"]["backend"], "root", "{key_virtual}");

    let launch_virtual = call(&mut core, json!({"protocolVersion":1,"kind":"prepare","epoch":"900",
        "callId":"su-launch-virtual","screenId":"virtual-1","operation":"launchApp",
        "args":{"pkg":"com.android.settings"}}));
    assert_eq!(launch_virtual["ok"], false, "{launch_virtual}");
    assert_eq!(launch_virtual["code"], "target-unsupported", "{launch_virtual}");
}

#[test]
fn focused_unicode_text_uses_the_observed_native_channel_without_an_ime() {
    let mut core = controller();
    let mut input = facts("real-only", 0, "no");
    input["facts"]["screens"]["real"] = json!({"displayId":0,"width":1080,"height":2400,"rotation":0});
    input["facts"]["shizuku"] = json!({
        "installed":"yes","running":"yes","granted":"yes","bound":"yes","functionalReady":"yes",
        "serverUid":{"kind":"shell2000"},"supportedOps":{"state":"known","ops":["setText"]},
        "displaySupport":{"state":"known","values":{"0":true}}
    });
    assert_eq!(call(&mut core, input.clone())["ok"], true);
    let request = json!({"protocolVersion":PROTOCOL_VERSION,"kind":"prepare","operation":"setText",
        "callId":"shell-text","epoch":"900","screenId":"real","args":{"text":"中文 🙂"}});
    let prepared = call(&mut core, request.clone());
    assert_eq!(prepared["code"], "prepared", "{prepared}");
    assert_eq!(prepared["plan"]["backend"], "shizuku");
    assert_eq!(prepared["plan"]["args"], json!({"text":"中文 🙂","clear":true}));
    let commit = call(&mut core, json!({"protocolVersion":1,"kind":"commit","callId":"shell-text"}));
    assert_eq!(commit["dispatch"], "permitted", "{commit}");
    let settled = call(&mut core, json!({"protocolVersion":1,"kind":"settle","callId":"shell-text",
        "receipt":{"ok":true,"code":"shizuku-text-confirmed","executed":"yes","screenId":"real"}}));
    assert_eq!(settled["ok"], true, "{settled}");
    assert_eq!(call(&mut core, request)["replayed"], true);

    input["facts"]["scope"] = json!("virtual-only");
    assert_eq!(call(&mut core, input.clone())["ok"], true);
    let denied = call(&mut core, json!({"protocolVersion":1,"kind":"prepare","operation":"setText",
        "callId":"scope-denied-text","epoch":"900","screenId":"real","args":{"text":"x"}}));
    assert_eq!(denied["executed"], "no", "{denied}");
    assert_eq!(denied["ok"], false);
    input["facts"]["scope"] = json!("all");
    input["facts"]["shizuku"]["granted"] = json!("no");
    assert_eq!(call(&mut core, input.clone())["ok"], true);
    let denied = call(&mut core, json!({"protocolVersion":1,"kind":"prepare","operation":"setText",
        "callId":"permission-denied-text","epoch":"900","screenId":"real","args":{"text":"x"}}));
    assert_eq!(denied["executed"], "no", "{denied}");
    assert!(denied.get("plan").is_none(), "{denied}");
}

#[test]
fn focused_text_validates_text_without_loosening_node_reference_validation() {
    let mut core = controller();
    let mut input = facts("all", 0, "yes");
    input["facts"]["a11y"]["supportedOps"]["ops"] = json!(["setText"]);
    assert_eq!(call(&mut core, input)["ok"], true);
    for args in [json!({"text":false}), json!({"text":"x","clear":"yes"}),
        json!({"text":"x","ref":""}), json!({"text":"x","x":1}),
        json!({"text":"中".repeat(2731)})] {
        let denied = call(&mut core, json!({"protocolVersion":1,"kind":"prepare","operation":"setText",
            "callId":"bad-focused-text","epoch":"900","screenId":"virtual-1","args":args}));
        assert_eq!(denied["ok"], false, "{denied}");
        assert!(denied.get("plan").is_none(), "{denied}");
    }
    let prepared = call(&mut core, json!({"protocolVersion":1,"kind":"prepare","operation":"setText",
        "callId":"a11y-focused-text","epoch":"900","screenId":"virtual-1","args":{"text":"","clear":true}}));
    assert_eq!(prepared["code"], "prepared", "{prepared}");
    assert_eq!(prepared["plan"]["backend"], "a11y");
}

#[test]
fn global_actions_keep_real_a11y_and_virtual_back_needs_a_scoped_shizuku_channel() {
    let mut core = controller();
    let mut input = facts("all", 0, "yes");
    input["facts"]["screens"]["real"] = json!({"displayId":0,"width":1080,"height":2400,"rotation":0});
    input["facts"]["a11y"]["supportedOps"]["ops"] = json!(["global"]);
    input["facts"]["a11y"]["displaySupport"]["values"]["0"] = json!(true);
    assert_eq!(call(&mut core, input.clone())["ok"], true);
    for args in [json!({}), json!({"action":"not-an-action"}), json!({"action":"back","x":5}), json!({"action":3})] {
        let refused = call(&mut core, json!({"protocolVersion":PROTOCOL_VERSION,"kind":"prepare",
            "operation":"global","callId":"bad-global","epoch":"900","screenId":"real","args":args}));
        assert_eq!(refused["ok"], false, "{refused}");
        assert!(refused.get("plan").is_none(), "{refused}");
    }
    let wrong = call(&mut core, json!({"protocolVersion":PROTOCOL_VERSION,"kind":"prepare",
        "operation":"global","callId":"virtual-global","epoch":"900","screenId":"virtual-1","args":{"action":"back"}}));
    assert_eq!(wrong["code"], "facts-unknown", "{wrong}");
    assert_eq!(wrong["executed"], "no");
    let prepared = call(&mut core, json!({"protocolVersion":PROTOCOL_VERSION,"kind":"prepare",
        "operation":"global","callId":"real-global","epoch":"900","screenId":"real","args":{"action":"back"}}));
    assert_eq!(prepared["code"], "prepared", "{prepared}");
    assert_eq!(prepared["plan"]["args"], json!({"action":"back"}));
    assert_eq!(prepared["plan"]["backend"], "a11y");
    input["facts"]["shizuku"] = json!({"installed":"yes","running":"yes","granted":"yes",
        "bound":"yes","functionalReady":"yes","serverUid":{"kind":"shell2000"},
        "supportedOps":{"state":"known","ops":["global"]},
        "displaySupport":{"state":"known","values":{"41":true}}});
    assert_eq!(call(&mut core, input)["ok"], true);
    let back = call(&mut core, json!({"protocolVersion":1,"kind":"prepare","operation":"global",
        "callId":"virtual-scoped-back","epoch":"900","screenId":"virtual-1","args":{"action":"back"}}));
    assert_eq!(back["plan"]["backend"], "shizuku", "{back}");
    let home = call(&mut core, json!({"protocolVersion":1,"kind":"prepare","operation":"global",
        "callId":"virtual-not-home","epoch":"900","screenId":"virtual-1","args":{"action":"home"}}));
    assert_eq!(home["code"], "target-unsupported", "{home}");
    assert_eq!(home["executed"], "no");
}

fn prepare<J: Journal>(controller: &mut Controller<J>, call_id: &str) -> Value {
    prepare_at(controller, call_id, "virtual-1", "900")
}

fn prepare_at<J: Journal>(controller: &mut Controller<J>, call_id: &str, screen: &str, epoch: &str) -> Value {
    prepare_with_point(controller, call_id, screen, epoch, 10, 20)
}

fn prepare_with_point<J: Journal>(
    controller: &mut Controller<J>,
    call_id: &str,
    screen: &str,
    epoch: &str,
    x: i32,
    y: i32,
) -> Value {
    call(
        controller,
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "kind": "prepare",
            "callId": call_id,
            "operation": "click",
            "screenId": screen,
            "epoch": epoch,
            "args": {"x": x, "y": y}
        }),
    )
}

#[test]
fn capabilities_use_string_ids_and_fixed_protocol_version() {
    let mut controller = controller();
    let published = publish_default(&mut controller);
    assert_eq!(published["ok"], true, "{published}");
    let capabilities = call(
        &mut controller,
        json!({"protocolVersion": PROTOCOL_VERSION, "kind": "capabilities"}),
    );
    assert_eq!(capabilities["ok"], true);
    assert_eq!(capabilities["protocolVersion"], 1);
    assert!(capabilities["epoch"].is_string());
    assert!(capabilities["revision"].is_string());
    let screens = capabilities["screens"].as_array().unwrap();
    assert!(screens[0]["generation"].is_string());
    assert_eq!(capabilities["channels"]["a11y"]["online"], "yes");
    assert_eq!(capabilities["channels"]["shizuku"]["installed"], "unknown");
}

#[test]
fn prepare_accepts_hex_epoch_and_rejects_float_like_numbers() {
    let mut controller = controller();
    publish_default(&mut controller);
    let prepared = call(
        &mut controller,
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "kind": "prepare",
            "callId": "hex-1",
            "operation": "click",
            "screenId": "virtual-1",
            "epoch": "0x384",
            "args": {"x": 1, "y": 1}
        }),
    );
    assert_eq!(prepared["ok"], true, "{prepared}");
    assert!(prepared["plan"]["epoch"].is_string());
    assert!(prepared["plan"]["generation"].is_string());

    let rejected = call(
        &mut controller,
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "kind": "prepare",
            "callId": "hex-2",
            "operation": "click",
            "screenId": "virtual-1",
            "epoch": 900.0
        }),
    );
    assert_eq!(rejected["code"], "invalid-request");
}

#[test]
fn repeated_prepare_does_not_dispatch_twice() {
    let mut controller = controller();
    publish_default(&mut controller);
    assert_eq!(prepare(&mut controller, "call-1")["ok"], true);
    let repeated = prepare(&mut controller, "call-1");
    assert_eq!(repeated["code"], "call-in-progress");

    let committed = call(
        &mut controller,
        json!({"protocolVersion": PROTOCOL_VERSION, "kind": "commit", "callId": "call-1"}),
    );
    assert_eq!(committed["ok"], true);
    assert_eq!(committed["dispatch"], "permitted");

    let again = call(
        &mut controller,
        json!({"protocolVersion": PROTOCOL_VERSION, "kind": "commit", "callId": "call-1"}),
    );
    assert_eq!(again["ok"], false);
}

#[test]
fn new_call_id_cannot_bypass_an_unknown_request() {
    let mut controller = controller();
    publish_default(&mut controller);
    prepare(&mut controller, "original");
    call(&mut controller, json!({"protocolVersion": PROTOCOL_VERSION, "kind": "commit", "callId": "original"}));
    call(
        &mut controller,
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "kind": "settle",
            "callId": "original",
            "receipt": {"ok": false, "code": "timeout", "executed": "unknown", "screenId": "virtual-1"}
        }),
    );
    let duplicate = prepare(&mut controller, "different-id");
    assert_eq!(duplicate["code"], "operation-unknown", "{duplicate}");
    assert!(duplicate.get("plan").is_none());
}

#[test]
fn new_call_id_cannot_bypass_an_inflight_request() {
    let mut controller = controller();
    publish_default(&mut controller);
    prepare(&mut controller, "inflight");
    let duplicate = prepare(&mut controller, "other-id");
    assert_eq!(duplicate["code"], "call-in-progress", "{duplicate}");
    assert!(duplicate.get("plan").is_none());
}

#[test]
fn omitted_and_explicit_screen_generation_share_one_fingerprint() {
    let mut controller = controller();
    publish_default(&mut controller);
    let mut with_real = facts("all", 0, "yes");
    with_real["facts"]["screens"]["real"] =
        json!({"displayId": 0, "width": 1080, "height": 2400, "rotation": 0});
    with_real["facts"]["a11y"]["displaySupport"]["values"]["0"] = json!(true);
    assert_eq!(call(&mut controller, with_real)["ok"], true);
    let implicit = call(
        &mut controller,
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "kind": "prepare",
            "callId": "implicit",
            "operation": "click",
            "epoch": "900",
            "args": {"x": 10, "y": 20}
        }),
    );
    assert_eq!(implicit["ok"], true, "{implicit}");
    let plan = implicit["plan"].clone();
    let duplicate = call(
        &mut controller,
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "kind": "prepare",
            "callId": "explicit",
            "operation": "click",
            "screenId": plan["screenId"],
            "generation": plan["generation"],
            "epoch": "900",
            "args": {"x": 10, "y": 20}
        }),
    );
    assert_eq!(duplicate["code"], "call-in-progress", "{duplicate}");
    assert!(duplicate.get("plan").is_none());
}

#[test]
fn click_args_are_strict_and_unknown_cannot_bypass_by_dropping_unused_args() {
    let mut controller = controller();
    publish_default(&mut controller);
    for args in [
        json!({}),
        json!({"x": 10}),
        json!({"x": 10, "y": 20, "x1": 1}),
        json!({"x": 10, "y": 20, "extra": true}),
    ] {
        let rejected = call(
            &mut controller,
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "kind": "prepare",
                "callId": "bad-args",
                "operation": "click",
                "screenId": "virtual-1",
                "epoch": "900",
                "args": args
            }),
        );
        assert_eq!(rejected["code"], "invalid-coordinate", "{rejected}");
    }

    prepare(&mut controller, "unknown-click");
    call(&mut controller, json!({"protocolVersion": PROTOCOL_VERSION, "kind": "commit", "callId": "unknown-click"}));
    call(
        &mut controller,
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "kind": "settle",
            "callId": "unknown-click",
            "receipt": {"ok": false, "code": "timeout", "executed": "unknown", "screenId": "virtual-1"}
        }),
    );
    let duplicate = call(
        &mut controller,
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "kind": "prepare",
            "callId": "new-id",
            "operation": "click",
            "screenId": "virtual-1",
            "epoch": "900",
            "args": {"x": 10, "y": 20}
        }),
    );
    assert_eq!(duplicate["code"], "operation-unknown", "{duplicate}");
}

#[test]
fn settle_unknown_blocks_fallback_and_replay() {
    let mut controller = controller();
    publish_default(&mut controller);
    prepare(&mut controller, "call-2");
    call(&mut controller, json!({"protocolVersion": PROTOCOL_VERSION, "kind": "commit", "callId": "call-2"}));
    let settled = call(
        &mut controller,
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "kind": "settle",
            "callId": "call-2",
            "receipt": {"ok": false, "code": "timeout", "executed": "unknown", "screenId": "virtual-1"}
        }),
    );
    assert_eq!(settled["executed"], "unknown");
    let fallback = call(
        &mut controller,
        json!({"protocolVersion": PROTOCOL_VERSION, "kind": "fallback", "callId": "call-2", "reason": "service-offline"}),
    );
    assert_eq!(fallback["ok"], false);
    assert_eq!(fallback["code"], "call-not-found");
}

#[test]
fn fallback_requires_prepared_and_keeps_target() {
    let mut controller = controller();
    publish_default(&mut controller);
    prepare(&mut controller, "call-3");
    let fallback = call(
        &mut controller,
        json!({"protocolVersion": PROTOCOL_VERSION, "kind": "fallback", "callId": "call-3", "reason": "service-offline"}),
    );
    assert_eq!(fallback["ok"], false);
    assert_eq!(fallback["code"], "facts-unknown");

    let bad = call(
        &mut controller,
        json!({"protocolVersion": PROTOCOL_VERSION, "kind": "fallback", "callId": "call-3", "reason": "timeout"}),
    );
    assert_eq!(bad["code"], "fallback-not-allowed");

    call(&mut controller, json!({"protocolVersion": PROTOCOL_VERSION, "kind": "commit", "callId": "call-3"}));
    let after_dispatch = call(
        &mut controller,
        json!({"protocolVersion": PROTOCOL_VERSION, "kind": "fallback", "callId": "call-3", "reason": "service-offline"}),
    );
    assert_eq!(after_dispatch["code"], "fallback-not-allowed");
}

#[test]
fn production_fallback_requires_fresh_a11y_loss_and_no_prior_guard() {
    fn channels(online: &str) -> Value {
        let mut value = facts("all", 0, online);
        value["facts"]["shizuku"] = json!({"installed":"yes","running":"yes","granted":"yes","bound":"yes",
            "functionalReady":"yes","serverUid":{"kind":"shell2000"},
            "supportedOps":{"state":"known","ops":["click","setText"]},
            "displayOperations":{"41":["click"]}});
        value
    }
    let mut core = controller();
    let command = |kind: &str, id: &str| json!({"protocolVersion":1,"kind":kind,"callId":id});
    call(&mut core, channels("yes"));
    prepare(&mut core, "not-granted");
    prepare_with_point(&mut core, "was-granted", "virtual-1", "900", 35, 45);
    for id in ["not-granted", "was-granted"] {
        assert_eq!(call(&mut core, command("commit", id))["dispatch"], "permitted");
    }
    assert_eq!(call(&mut core, command("validateDispatch", "was-granted"))["valid"], true);
    assert_eq!(call(&mut core, command("fallbackUnavailableA11y", "not-granted"))["code"], "fallback-not-proven");
    call(&mut core, channels("no"));
    assert_eq!(call(&mut core, command("fallbackUnavailableA11y", "was-granted"))["code"], "fallback-not-allowed");
    let switched = call(&mut core, command("fallbackUnavailableA11y", "not-granted"));
    assert_eq!(switched["dispatch"], "permitted", "{switched}");
    assert_eq!(switched["plan"]["displayId"], 41);
    assert_eq!(switched["plan"]["backend"], "shizuku");
    assert_eq!(call(&mut core, command("validateDispatch", "not-granted"))["valid"], true);
    let unavailable = call(&mut core, json!({"protocolVersion":1,"kind":"prepare","epoch":"900",
        "callId":"no-text-here","operation":"setText","screenId":"virtual-1","args":{"text":"test"}}));
    assert_eq!(unavailable["code"], "target-unsupported");
}

#[test]
fn revoked_scope_and_rotation_reject_commit() {
    let mut controller = controller();
    publish_default(&mut controller);
    prepare(&mut controller, "scope");
    call(&mut controller, facts("real-only", 0, "yes"));
    let denied = call(
        &mut controller,
        json!({"protocolVersion": PROTOCOL_VERSION, "kind": "commit", "callId": "scope"}),
    );
    assert_eq!(denied["ok"], false);
    assert!(denied["code"].as_str().unwrap().contains("scope") || denied["code"] == "target-generation-mismatch");

    call(&mut controller, facts("all", 0, "yes"));
    prepare_with_point(&mut controller, "rotate", "virtual-1", "900", 11, 20);
    call(&mut controller, facts("all", 1, "yes"));
    let rotated = call(
        &mut controller,
        json!({"protocolVersion": PROTOCOL_VERSION, "kind": "commit", "callId": "rotate"}),
    );
    assert_eq!(rotated["ok"], false);
    assert_eq!(rotated["code"], "target-generation-mismatch");
}

#[test]
fn scope_change_without_screen_change_bumps_scope_generation() {
    let mut controller = controller();
    publish_default(&mut controller);
    let before = call(
        &mut controller,
        json!({"protocolVersion": PROTOCOL_VERSION, "kind": "capabilities"}),
    );
    let published = call(&mut controller, facts("real-only", 0, "yes"));
    assert_eq!(published["ok"], true);
    let after = call(
        &mut controller,
        json!({"protocolVersion": PROTOCOL_VERSION, "kind": "capabilities"}),
    );
    assert_eq!(after["scope"], "real-only");
    assert!(before["revision"].as_str().unwrap() < after["revision"].as_str().unwrap());
}

#[test]
fn journal_failure_blocks_commit() {
    let journal = FailingJournal::default();
    let mut controller = Controller::with_journal(journal.clone(), 900).unwrap();
    publish_default(&mut controller);
    prepare(&mut controller, "journal");
    journal.set_failing(true);
    let result = call(
        &mut controller,
        json!({"protocolVersion": PROTOCOL_VERSION, "kind": "commit", "callId": "journal"}),
    );
    assert_eq!(result["ok"], false);
    assert_eq!(result["code"], "journal-write-failed");
}

#[test]
fn unknown_fields_and_kinds_are_rejected() {
    let mut controller = controller();
    for request in [
        json!({"protocolVersion": PROTOCOL_VERSION, "kind": "clear"}),
        json!({"protocolVersion": 2, "kind": "capabilities"}),
        json!({"protocolVersion": PROTOCOL_VERSION, "kind": "capabilities", "backend": "root"}),
        json!({"protocolVersion": PROTOCOL_VERSION, "kind": "prepare", "callId": "x", "operation": "click", "epoch": "900", "backend": "root"}),
    ] {
        let response = call(&mut controller, request);
        assert_eq!(response["ok"], false);
        assert!(
            matches!(response["code"].as_str(), Some("unknown-kind" | "unsupported-version" | "unknown-field"))
        );
    }
}

#[test]
fn cancellation_is_limited_to_prepared_calls() {
    let mut controller = controller();
    publish_default(&mut controller);
    prepare(&mut controller, "cancel-1");
    let cancelled = call(
        &mut controller,
        json!({"protocolVersion": PROTOCOL_VERSION, "kind": "cancel", "callId": "cancel-1"}),
    );
    assert_eq!(cancelled["executed"], "no");
    let commit = call(
        &mut controller,
        json!({"protocolVersion": PROTOCOL_VERSION, "kind": "commit", "callId": "cancel-1"}),
    );
    assert_eq!(commit["ok"], false);
    let replay = call(
        &mut controller,
        json!({"protocolVersion": PROTOCOL_VERSION, "kind": "cancel", "callId": "cancel-1"}),
    );
    assert_eq!(replay["executed"], "no");
    assert_eq!(replay["replayed"], true);
}

#[test]
fn cancel_does_not_turn_unknown_into_cancelled() {
    let mut controller = controller();
    publish_default(&mut controller);
    prepare(&mut controller, "unknown-cancel");
    call(&mut controller, json!({"protocolVersion": PROTOCOL_VERSION, "kind": "commit", "callId": "unknown-cancel"}));
    call(
        &mut controller,
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "kind": "settle",
            "callId": "unknown-cancel",
            "receipt": {"ok": false, "code": "timeout", "executed": "unknown", "screenId": "virtual-1"}
        }),
    );
    let first = call(
        &mut controller,
        json!({"protocolVersion": PROTOCOL_VERSION, "kind": "cancel", "callId": "unknown-cancel"}),
    );
    assert_eq!(first["executed"], "unknown");
    assert_eq!(first["code"], "timeout");
    assert_eq!(first["replayed"], true);
    let status = call(
        &mut controller,
        json!({"protocolVersion": PROTOCOL_VERSION, "kind": "operationStatus", "callId": "unknown-cancel"}),
    );
    assert_eq!(status["phase"], "unknown");
    let fallback = call(
        &mut controller,
        json!({"protocolVersion": PROTOCOL_VERSION, "kind": "fallback", "callId": "unknown-cancel", "reason": "service-offline"}),
    );
    assert_eq!(fallback["ok"], false);
}

#[test]
fn real_file_controller_recovers_unsettled_as_unknown() {
    let mut dir = std::env::temp_dir();
    dir.push(format!(
        "dsh-policy-controller-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&dir).unwrap();

    {
        let mut controller = Controller::open_file(&dir, 900).unwrap();
        let first_facts = publish_default(&mut controller);
        assert_eq!(first_facts["ok"], true, "{first_facts}");
        let prepared = prepare(&mut controller, "restart-1");
        assert_eq!(prepared["ok"], true, "{prepared}");
        let committed = call(
            &mut controller,
            json!({"protocolVersion": PROTOCOL_VERSION, "kind": "commit", "callId": "restart-1"}),
        );
        assert_eq!(committed["ok"], true, "{committed}");
    }

    let mut reopened = Controller::open_file(&dir, 900).unwrap();
    let republished = call(&mut reopened, facts("all", 0, "yes"));
    assert_eq!(republished["ok"], true, "{republished}");
    let replay = call(
        &mut reopened,
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "kind": "prepare",
            "callId": "restart-1",
            "operation": "click",
            "screenId": "virtual-1",
            "epoch": "900",
            "args": {"x": 10, "y": 20}
        }),
    );
    assert_eq!(replay["executed"], "unknown");
    assert_eq!(replay["ok"], false);

    let fallback = call(
        &mut reopened,
        json!({"protocolVersion": PROTOCOL_VERSION, "kind": "fallback", "callId": "restart-1", "reason": "service-offline"}),
    );
    assert_eq!(fallback["ok"], false);

    drop(reopened);
    let mut next_epoch = Controller::open_file(&dir, 902).unwrap();
    call(&mut next_epoch, facts("all", 0, "yes"));
    let wrong_epoch = call(
        &mut next_epoch,
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "kind": "prepare",
            "callId": "restart-1",
            "operation": "click",
            "screenId": "virtual-1",
            "epoch": "902",
            "args": {"x": 10, "y": 20}
        }),
    );
    assert!(
        matches!(wrong_epoch["code"].as_str(), Some("epoch-mismatch" | "call-id-conflict")),
        "{wrong_epoch}"
    );

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn operation_status_tracks_lifecycle_phases() {
    let mut controller = controller();
    publish_default(&mut controller);
    prepare(&mut controller, "status-1");
    let prepared = call(
        &mut controller,
        json!({"protocolVersion": PROTOCOL_VERSION, "kind": "operationStatus", "callId": "status-1"}),
    );
    assert_eq!(prepared["phase"], "prepared");
    assert_eq!(prepared["executed"], "no");
    assert_eq!(prepared["terminal"], false);
    assert!(prepared["plan"]["generation"].is_string());

    call(&mut controller, json!({"protocolVersion": PROTOCOL_VERSION, "kind": "commit", "callId": "status-1"}));
    let dispatched = call(
        &mut controller,
        json!({"protocolVersion": PROTOCOL_VERSION, "kind": "operationStatus", "callId": "status-1"}),
    );
    assert_eq!(dispatched["phase"], "dispatching");
    assert_eq!(dispatched["executed"], "unknown");

    call(
        &mut controller,
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "kind": "settle",
            "callId": "status-1",
            "receipt": {"ok": true, "code": "clicked", "executed": "yes", "screenId": "virtual-1"}
        }),
    );
    let settled = call(
        &mut controller,
        json!({"protocolVersion": PROTOCOL_VERSION, "kind": "operationStatus", "callId": "status-1"}),
    );
    assert_eq!(settled["phase"], "settled");
    assert_eq!(settled["executed"], "yes");
    assert_eq!(settled["terminal"], true);

    let missing = call(
        &mut controller,
        json!({"protocolVersion": PROTOCOL_VERSION, "kind": "operationStatus", "callId": "missing"}),
    );
    assert_eq!(missing["phase"], "missing");
    assert_eq!(missing["ok"], false);
}

#[test]
fn validate_dispatch_is_read_only_and_settles_unexecuted_on_rejection() {
    let mut controller = controller();
    publish_default(&mut controller);
    prepare(&mut controller, "validate-1");

    let before = call(
        &mut controller,
        json!({"protocolVersion": PROTOCOL_VERSION, "kind": "operationStatus", "callId": "validate-1"}),
    );
    assert_eq!(before["phase"], "prepared");

    let early = call(
        &mut controller,
        json!({"protocolVersion": PROTOCOL_VERSION, "kind": "validateDispatch", "callId": "validate-1"}),
    );
    assert_eq!(early["valid"], false);
    assert_eq!(early["dispatch"], "forbidden");
    let still = call(
        &mut controller,
        json!({"protocolVersion": PROTOCOL_VERSION, "kind": "operationStatus", "callId": "validate-1"}),
    );
    assert_eq!(still["phase"], "prepared", "validateDispatch must not mutate lifecycle");

    call(&mut controller, json!({"protocolVersion": PROTOCOL_VERSION, "kind": "commit", "callId": "validate-1"}));
    let valid = call(
        &mut controller,
        json!({"protocolVersion": PROTOCOL_VERSION, "kind": "validateDispatch", "callId": "validate-1"}),
    );
    assert_eq!(valid["valid"], true);
    assert_eq!(valid["dispatch"], "permitted");
    assert_eq!(valid["phase"], "dispatching");
    assert!(valid["settleHint"].is_null());

    call(&mut controller, facts("real-only", 0, "yes"));
    let revoked = call(
        &mut controller,
        json!({"protocolVersion": PROTOCOL_VERSION, "kind": "validateDispatch", "callId": "validate-1"}),
    );
    assert_eq!(revoked["valid"], false);
    assert_eq!(revoked["dispatch"], "forbidden");
    assert_eq!(revoked["settleHint"]["executed"], "no");

    let settled = call(
        &mut controller,
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "kind": "settle",
            "callId": "validate-1",
            "receipt": revoked["settleHint"].clone()
        }),
    );
    assert_eq!(settled["executed"], "no");
    assert_eq!(settled["ok"], false);
}

#[test]
fn cancel_and_validate_are_serialized_by_core_state() {
    let mut controller = controller();
    publish_default(&mut controller);
    prepare(&mut controller, "race-1");
    let cancelled = call(
        &mut controller,
        json!({"protocolVersion": PROTOCOL_VERSION, "kind": "cancel", "callId": "race-1"}),
    );
    assert_eq!(cancelled["executed"], "no");
    let validated = call(
        &mut controller,
        json!({"protocolVersion": PROTOCOL_VERSION, "kind": "validateDispatch", "callId": "race-1"}),
    );
    assert_eq!(validated["valid"], false);
    assert_eq!(validated["phase"], "cancelled");
    let commit = call(
        &mut controller,
        json!({"protocolVersion": PROTOCOL_VERSION, "kind": "commit", "callId": "race-1"}),
    );
    assert_eq!(commit["ok"], false);
}

#[test]
fn cancel_after_dispatch_marks_unknown_and_blocks_validation() {
    let mut controller = controller();
    publish_default(&mut controller);
    prepare(&mut controller, "cancel-dispatch");
    let committed = call(
        &mut controller,
        json!({"protocolVersion": PROTOCOL_VERSION, "kind": "commit", "callId": "cancel-dispatch"}),
    );
    assert_eq!(committed["ok"], true);

    let cancelled = call(
        &mut controller,
        json!({"protocolVersion": PROTOCOL_VERSION, "kind": "cancel", "callId": "cancel-dispatch"}),
    );
    assert_eq!(cancelled["executed"], "unknown");
    assert_eq!(cancelled["ok"], false);
    assert_eq!(cancelled["code"], "cancel-after-dispatch");

    let validated = call(
        &mut controller,
        json!({"protocolVersion": PROTOCOL_VERSION, "kind": "validateDispatch", "callId": "cancel-dispatch"}),
    );
    assert_eq!(validated["valid"], false);
    assert_eq!(validated["dispatch"], "forbidden");
    assert_eq!(validated["settleHint"], Value::Null);

    let status = call(
        &mut controller,
        json!({"protocolVersion": PROTOCOL_VERSION, "kind": "operationStatus", "callId": "cancel-dispatch"}),
    );
    assert_eq!(status["phase"], "unknown", "{status}");
    assert_eq!(status["executed"], "unknown");

    let again = call(
        &mut controller,
        json!({"protocolVersion": PROTOCOL_VERSION, "kind": "cancel", "callId": "cancel-dispatch"}),
    );
    assert_eq!(again["executed"], "unknown");
    assert_eq!(again["replayed"], true);

    let fallback = call(
        &mut controller,
        json!({"protocolVersion": PROTOCOL_VERSION, "kind": "fallback", "callId": "cancel-dispatch", "reason": "service-offline"}),
    );
    assert_eq!(fallback["ok"], false);
}

#[test]
fn initialize_is_json_and_host_mode_is_explicitly_unverified() {
    let _guard = init_lock().lock().unwrap();
    dsh_phone_control_core::jni_api::reset_for_test();
    let path = std::env::temp_dir().join(format!(
        "dsh-policy-init-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&path).unwrap();
    let response: Value =
        serde_json::from_str(&dsh_phone_control_core::jni_api::initialize_core(
            &path.to_string_lossy(),
            2000,
        ))
        .unwrap();
    assert_eq!(response["ok"], true, "{response}");
    assert_eq!(response["protocolVersion"], 1);
    assert_eq!(response["identityVerified"], false);
    assert!(response["epoch"].is_string());

    let uninitialized = serde_json::from_str::<Value>(&dsh_phone_control_core::jni_api::exchange_core(
        "{\"protocolVersion\":1,\"kind\":\"capabilities\"}",
    ))
    .unwrap();
    assert_eq!(uninitialized["ok"], true, "initialization should be process-wide");

    let relative = serde_json::from_str::<Value>(&dsh_phone_control_core::jni_api::initialize_core(
        "relative/path",
        2000,
    ))
    .unwrap();
    assert_eq!(relative["code"], "invalid-state-dir");
    let _ = fs::remove_dir_all(&path);
}

#[test]
fn initialize_is_idempotent_and_rejects_a_different_directory() {
    let _guard = init_lock().lock().unwrap();
    dsh_phone_control_core::jni_api::reset_for_test();
    let root = std::env::temp_dir().join(format!(
        "dsh-policy-init-idempotent-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let first_dir = root.join("first");
    let second_dir = root.join("second");
    fs::create_dir_all(&first_dir).unwrap();
    fs::create_dir_all(&second_dir).unwrap();

    let first: Value = serde_json::from_str(&dsh_phone_control_core::jni_api::initialize_core(
        &first_dir.to_string_lossy(),
        2000,
    ))
    .unwrap();
    assert_eq!(first["ok"], true, "{first}");
    assert_eq!(first["idempotent"], false);
    let epoch = first["epoch"].clone();
    let revision = first["revision"].clone();

    let repeated: Value = serde_json::from_str(&dsh_phone_control_core::jni_api::initialize_core(
        &first_dir.to_string_lossy(),
        2000,
    ))
    .unwrap();
    assert_eq!(repeated["ok"], true, "{repeated}");
    assert_eq!(repeated["code"], "already-initialized");
    assert_eq!(repeated["idempotent"], true);
    assert_eq!(repeated["epoch"], epoch);
    assert_eq!(repeated["revision"], revision);

    let other: Value = serde_json::from_str(&dsh_phone_control_core::jni_api::initialize_core(
        &second_dir.to_string_lossy(),
        2000,
    ))
    .unwrap();
    assert_eq!(other["ok"], false);
    assert_eq!(other["code"], "already-initialized");
    assert_eq!(other["executed"], "unknown");

    let still: Value = serde_json::from_str(&dsh_phone_control_core::jni_api::initialize_core(
        &first_dir.to_string_lossy(),
        2000,
    ))
    .unwrap();
    assert_eq!(still["epoch"], epoch);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn concurrent_initialize_never_replaces_the_first_session() {
    let _guard = init_lock().lock().unwrap();
    dsh_phone_control_core::jni_api::reset_for_test();
    let root = std::env::temp_dir().join(format!(
        "dsh-policy-init-race-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let dirs: Vec<_> = ["a", "b", "c", "d"].iter().map(|name| root.join(name)).collect();
    for dir in &dirs {
        fs::create_dir_all(dir).unwrap();
    }

    let shared = Arc::new(Mutex::new(Vec::new()));
    std::thread::scope(|scope| {
        for (index, dir) in dirs.iter().enumerate() {
            let shared = shared.clone();
            let dir = dir.to_string_lossy().into_owned();
            scope.spawn(move || {
                let response: Value = serde_json::from_str(
                    &dsh_phone_control_core::jni_api::initialize_core(&dir, 2000),
                )
                .unwrap();
                shared.lock().unwrap().push((index, response));
            });
        }
    });

    let responses = shared.lock().unwrap();
    assert_eq!(responses.len(), dirs.len());
    let ok: Vec<_> = responses.iter().filter(|(_, value)| value["ok"] == true).collect();
    assert_eq!(ok.len(), 1, "exactly one initialization may create a session");
    let epoch = ok[0].1["epoch"].clone();
    for (_, value) in responses.iter() {
        if value["ok"] == false {
            assert_eq!(value["code"], "already-initialized");
        } else {
            assert_eq!(value["epoch"], epoch);
        }
    }
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn recycled_allocation_invalidates_a_prepared_plan() {
    let mut controller = controller();
    assert_eq!(call(&mut controller, facts_with_allocation("all", json!("7")))["ok"], true);
    let prepared = prepare(&mut controller, "recycle");
    assert_eq!(prepared["code"], "prepared", "{prepared}");
    let old_generation = prepared["plan"]["generation"].clone();

    // 同 alias、同 displayId、同几何，只有平台分配身份变了。
    assert_eq!(call(&mut controller, facts_with_allocation("all", json!("8")))["ok"], true);
    let denied = call(
        &mut controller,
        json!({"protocolVersion": PROTOCOL_VERSION, "kind": "commit", "callId": "recycle"}),
    );
    assert_eq!(denied["ok"], false);
    assert_eq!(denied["code"], "target-generation-mismatch", "{denied}");
    let stale = call(&mut controller, json!({
        "protocolVersion": PROTOCOL_VERSION, "kind": "prepare", "callId": "recycle-stale",
        "operation": "click", "screenId": "virtual-1", "generation": old_generation,
        "epoch": "900", "args": {"x": 3, "y": 4}
    }));
    assert_eq!(stale["code"], "generation-mismatch", "{stale}");
    assert_eq!(stale["executed"], "no", "{stale}");
}

#[test]
fn destroyed_virtual_target_is_rejected_before_dispatch() {
    let mut controller = controller();
    assert_eq!(call(&mut controller, facts_with_allocation("all", json!("7")))["ok"], true);
    let prepared = prepare(&mut controller, "before-destroy");
    let generation = prepared["plan"]["generation"].clone();
    let mut removed = facts_with_allocation("all", json!("7"));
    removed["facts"]["screens"].as_object_mut().unwrap().remove("virtual-1");
    assert_eq!(call(&mut controller, removed)["ok"], true);
    let reply = call(&mut controller, json!({
        "protocolVersion": PROTOCOL_VERSION, "kind": "prepare", "callId": "after-destroy",
        "operation": "screenshot", "screenId": "virtual-1", "generation": generation,
        "epoch": "900", "args": {}
    }));
    assert_eq!(reply["code"], "unknown-target", "{reply}");
    assert_eq!(reply["executed"], "no", "{reply}");
}

#[test]
fn allocation_identity_stays_out_of_the_wire_contract() {
    let mut controller = controller();
    assert_eq!(call(&mut controller, facts_with_allocation("all", json!("0x2a")))["ok"], true);
    let capabilities = call(
        &mut controller,
        json!({"protocolVersion": PROTOCOL_VERSION, "kind": "capabilities"}),
    );
    let screen = &capabilities["screens"][0];
    assert_eq!(screen["displayId"], 41);
    assert!(screen["generation"].is_string());
    assert!(screen.get("allocationId").is_none(), "{screen}");
}

#[test]
fn malformed_allocation_identity_is_rejected_without_guessing() {
    let mut controller = controller();
    for bad in [json!(true), json!(-1), json!(1.5), json!(""), json!("12x"), json!("0x"), json!(" ")] {
        let response = call(&mut controller, facts_with_allocation("all", bad.clone()));
        assert_eq!(response["ok"], false, "{bad} must be refused");
        assert_eq!(response["code"], "invalid-facts", "{bad}: {response}");
    }
    // 拒绝后不留下半登记屏幕。
    let capabilities = call(
        &mut controller,
        json!({"protocolVersion": PROTOCOL_VERSION, "kind": "capabilities"}),
    );
    assert_eq!(capabilities["screens"].as_array().unwrap().len(), 0);
}

#[test]
fn real_screen_cannot_replay_with_an_allocation_identity() {
    let mut controller = controller();
    let mut input = facts("all", 0, "yes");
    input["facts"]["screens"]["real"] = json!({"displayId":0,"width":1080,"height":2400,"rotation":0});
    assert_eq!(call(&mut controller, input.clone())["ok"], true);
    input["facts"]["screens"]["real"]["allocationId"] = json!("1");
    let refused = call(&mut controller, input);
    assert_eq!(refused["code"], "invalid-screen", "{refused}");
}

#[cfg(unix)]
#[test]
fn initialize_rejects_a_symlinked_ancestor() {
    let _guard = init_lock().lock().unwrap();
    dsh_phone_control_core::jni_api::reset_for_test();
    use std::os::unix::fs::symlink;

    let root = std::env::temp_dir().join(format!(
        "dsh-policy-init-symlink-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let real = root.join("real");
    fs::create_dir_all(real.join("state")).unwrap();
    let link = root.join("link");
    symlink(&real, &link).unwrap();
    let response: Value = serde_json::from_str(&dsh_phone_control_core::jni_api::initialize_core(
        &link.join("state").to_string_lossy(),
        2000,
    ))
    .unwrap();
    assert_eq!(response["ok"], false);
    assert_eq!(response["code"], "unsafe-state-dir");
    let _ = fs::remove_dir_all(&root);
}
