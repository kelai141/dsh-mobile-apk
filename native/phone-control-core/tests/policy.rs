//! 独立策略测试。主线程把 `policy` 加入 `lib.rs` 后可改为 crate 导入。

#[path = "../src/policy.rs"]
mod policy;

use policy::{
    A11yFacts, Backend, DispatchEvidence, DispatchFailure, DispatchPlan, DisplaySupport, OpSet,
    OperationSpec, PolicyState, RootFacts, Scope, ScreenFacts, ServerUid, ShizukuFacts, TargetDomain,
    TargetRequest, Tri,
};

fn virtual_screen(state: &mut PolicyState, alias: &str, display_id: i32) -> u64 {
    state
        .observe_screen(alias, ScreenFacts::new(display_id, 1080, 1920, 0))
        .unwrap()
        .generation
}

fn real_screen(state: &mut PolicyState) -> u64 {
    state
        .observe_screen("real", ScreenFacts::new(0, 1080, 2400, 0))
        .unwrap()
        .generation
}

fn a11y_ready(ops: &[&str], displays: &[(i32, bool)]) -> A11yFacts {
    A11yFacts::ready(ops, displays)
}

fn shizuku_ready(uid: ServerUid, ops: &[&str], displays: &[(i32, bool)]) -> ShizukuFacts {
    ShizukuFacts::ready(uid, ops, displays)
}

fn basic_state() -> PolicyState {
    let mut state = PolicyState::new(7);
    state.set_scope(Scope::All);
    virtual_screen(&mut state, "virtual-1", 41);
    real_screen(&mut state);
    state.set_a11y_facts(a11y_ready(
        &["snapshot", "click", "readRegion"],
        &[(0, true), (41, true)],
    ));
    state
}

#[test]
fn revision_moves_only_when_immutable_facts_change() {
    let mut state = PolicyState::new(1);
    assert_eq!(state.epoch(), 1);
    let start = state.revision();
    state.refresh_time(100);
    state.refresh_time(200);
    assert_eq!(state.revision(), start, "time refresh must not bump revision");
    assert_eq!(state.observed_at_ms(), 200);

    let first = virtual_screen(&mut state, "virtual-1", 41);
    assert_eq!(state.screen("virtual-1").unwrap().generation, first);
    let after_create = state.revision();
    assert!(after_create > start);

    let second = virtual_screen(&mut state, "virtual-1", 41);
    assert_eq!(second, first);
    assert_eq!(state.revision(), after_create, "same facts must not bump revision");

    state.refresh_time(300);
    assert_eq!(state.revision(), after_create);

    let third = state
        .observe_screen("virtual-1", ScreenFacts::new(41, 1080, 1920, 1))
        .unwrap()
        .generation;
    assert_ne!(third, first, "rotation must allocate a new generation");
    assert_eq!(state.revision(), after_create + 1);
}

#[test]
fn screen_identity_changes_allocate_generations() {
    let mut state = PolicyState::new(1);
    let base = virtual_screen(&mut state, "virtual-1", 41);
    let display = state
        .observe_screen("virtual-1", ScreenFacts::new(42, 1080, 1920, 0))
        .unwrap()
        .generation;
    let size = state
        .observe_screen("virtual-1", ScreenFacts::new(42, 720, 1280, 0))
        .unwrap()
        .generation;
    assert!(display > base);
    assert!(size > display);
}

#[test]
fn scope_wire_is_serde_compatible_and_corruption_is_minimal() {
    for good in ["virtual-only", "real-only", "all"] {
        let scope = Scope::from_wire(Some(good));
        assert_eq!(serde_json::to_string(&scope).unwrap(), format!("\"{good}\""));
    }
    assert_eq!(Scope::from_wire(Some("real")), Scope::VirtualOnly);
    assert_eq!(Scope::from_wire(Some("")), Scope::VirtualOnly);
    assert_eq!(Scope::from_wire(None), Scope::VirtualOnly);
    assert_eq!(serde_json::from_str::<Scope>("\"garbage\"").unwrap(), Scope::VirtualOnly);
    assert_eq!(serde_json::from_str::<Scope>("null").unwrap(), Scope::VirtualOnly);
    assert_eq!(serde_json::from_str::<Scope>("17").unwrap(), Scope::VirtualOnly);
    assert_eq!(serde_json::from_str::<Scope>("{}").unwrap(), Scope::VirtualOnly);
}

#[test]
fn operation_catalog_has_explicit_metadata_for_every_known_family() {
    let required = [
        "snapshot", "click", "longClick", "setText", "scroll", "global", "screenshot",
        "nodeText", "state", "webSnapshot", "webAction", "readRegion", "wait", "vdCreate",
        "vdDestroy", "vdLaunch", "vdInput", "browserOpen", "browserTabs", "shExec",
    ];
    for name in required {
        let spec = OperationSpec::for_name(name).unwrap_or_else(|| panic!("missing {name}"));
        assert_eq!(spec.name, name);
    }
    assert_eq!(OperationSpec::for_name("click").unwrap().target_domain, TargetDomain::AndroidDisplay);
    assert!(OperationSpec::for_name("click").unwrap().reads_device_display);
    assert!(!OperationSpec::for_name("browserJs").unwrap().reads_device_display);
    assert_eq!(OperationSpec::for_name("browserJs").unwrap().target_domain, TargetDomain::BrowserWorkspace);
    assert_eq!(OperationSpec::for_name("webAction").unwrap().target_domain, TargetDomain::AppWebView);
    assert!(OperationSpec::for_name("clickk").is_none());
    assert!(OperationSpec::for_name("browser").is_none(), "prefixes must not infer scope");
}

#[test]
fn a11y_is_preferred_for_basic_controls() {
    let state = basic_state();
    assert_eq!(state.a11y().online, Tri::Yes);
    assert_eq!(state.shizuku().server_uid, ServerUid::Unknown);
    assert_eq!(state.root().authorization, Tri::Unknown);
    let plan = state
        .plan("click", TargetRequest::Virtual("virtual-1".into()))
        .unwrap();
    assert_eq!(plan.backend, Backend::A11y);
    assert_eq!(plan.screen().unwrap().alias, "virtual-1");
    assert_eq!(plan.epoch, 7);
    assert_eq!(plan.scope_generation, Some(state.scope_generation()));
}

#[test]
fn legal_fallback_requires_unexecuted_evidence_and_limited_failure() {
    let mut state = basic_state();
    state.set_shizuku_facts(shizuku_ready(
        ServerUid::Shell2000,
        &["snapshot", "click"],
        &[(41, true)],
    ));
    let a11y_plan = state
        .plan("click", TargetRequest::Virtual("virtual-1".into()))
        .unwrap();

    for reason in [
        DispatchFailure::ServiceOffline,
        DispatchFailure::PermissionMissing,
        DispatchFailure::OpUnsupported,
        DispatchFailure::TargetUnsupported,
    ] {
        let plan = state.fallback_plan(&a11y_plan, DispatchEvidence::No, reason).unwrap();
        assert_eq!(plan.backend, Backend::Shizuku);
        assert_eq!(plan.screen().unwrap().generation, a11y_plan.screen().unwrap().generation);
    }

    for reason in [
        DispatchFailure::NodeNotFound,
        DispatchFailure::Timeout,
        DispatchFailure::Unknown,
        DispatchFailure::Error,
    ] {
        assert!(state.fallback_plan(&a11y_plan, DispatchEvidence::No, reason).is_err());
    }
    assert!(state.fallback_plan(&a11y_plan, DispatchEvidence::Yes, DispatchFailure::ServiceOffline).is_err());
    assert!(state.fallback_plan(&a11y_plan, DispatchEvidence::Unknown, DispatchFailure::ServiceOffline).is_err());
}

#[test]
fn unavailable_a11y_can_route_to_verified_shizuku() {
    let mut state = basic_state();
    state.set_a11y_facts(A11yFacts {
        enabled: Tri::Yes,
        online: Tri::No,
        supported_ops: OpSet::known(["click"]),
        display_support: DisplaySupport::known([(41, true)]),
    });
    state.set_shizuku_facts(shizuku_ready(ServerUid::Shell2000, &["click"], &[(41, true)]));
    let plan = state
        .plan("click", TargetRequest::Virtual("virtual-1".into()))
        .unwrap();
    assert_eq!(plan.backend, Backend::Shizuku);
}

#[test]
fn unknown_facts_never_fall_through_as_false() {
    let mut state = PolicyState::new(1);
    state.set_scope(Scope::All);
    virtual_screen(&mut state, "virtual-1", 41);
    assert!(state.plan("click", TargetRequest::Virtual("virtual-1".into())).is_err());

    state.set_a11y_facts(a11y_ready(&["click"], &[(41, true)]));
    let plan = state.plan("click", TargetRequest::Virtual("virtual-1".into())).unwrap();
    assert_eq!(plan.backend, Backend::A11y);

    state.set_shizuku_facts(shizuku_ready(ServerUid::Shell2000, &["click"], &[(41, true)]));
    let unknown_a11y = A11yFacts {
        enabled: Tri::Yes,
        online: Tri::Unknown,
        supported_ops: OpSet::known(["click"]),
        display_support: DisplaySupport::known([(41, true)]),
    };
    state.set_a11y_facts(unknown_a11y);
    assert!(state.plan("click", TargetRequest::Virtual("virtual-1".into())).is_err());
}

#[test]
fn fallback_does_not_jump_to_another_target() {
    let mut state = basic_state();
    virtual_screen(&mut state, "virtual-2", 42);
    state.set_shizuku_facts(shizuku_ready(ServerUid::Shell2000, &["click"], &[(41, true), (42, true)]));
    let plan = state
        .plan("click", TargetRequest::Virtual("virtual-1".into()))
        .unwrap();
    let fallback = state.fallback_plan(&plan, DispatchEvidence::No, DispatchFailure::ServiceOffline).unwrap();
    assert_eq!(fallback.screen().unwrap().alias, "virtual-1");
    assert_eq!(fallback.screen().unwrap().display_id, 41);

    state.set_a11y_facts(A11yFacts {
        enabled: Tri::Yes,
        online: Tri::No,
        supported_ops: OpSet::known(["click"]),
        display_support: DisplaySupport::known([(41, false)]),
    });
    let direct = state
        .plan("click", TargetRequest::Virtual("virtual-1".into()))
        .unwrap();
    assert_eq!(direct.screen().unwrap().alias, "virtual-1");
    assert_eq!(direct.backend, Backend::Shizuku);
    let fallback = state
        .fallback_plan(&plan, DispatchEvidence::No, DispatchFailure::ServiceOffline)
        .unwrap();
    assert_eq!(fallback.screen().unwrap().alias, "virtual-1");
    assert_eq!(fallback.screen().unwrap().display_id, 41);
    assert_eq!(fallback.backend, Backend::Shizuku);
}

#[test]
fn unknown_targets_fail_closed() {
    let state = basic_state();
    let error = state.plan("click", TargetRequest::Virtual("virtual-9".into())).unwrap_err();
    assert!(error.detail().contains("virtual-9"));
    assert!(state.plan("click", TargetRequest::Virtual("virtual-01".into())).is_err());
    assert!(state.plan("click", TargetRequest::Virtual("display-41".into())).is_err());
    assert!(state.plan("notAnOp", TargetRequest::Real).is_err());
    assert!(state.plan("vdMoveTask", TargetRequest::Virtual("virtual-1".into())).is_err());
}

#[test]
fn virtual_alias_numbers_are_unbounded_but_strictly_formed() {
    assert!(policy::is_virtual_alias("virtual-1"));
    assert!(policy::is_virtual_alias("virtual-1000"));
    assert_eq!(policy::virtual_alias_ordinal("virtual-1000"), Some(1000));
    let large = "virtual-18446744073709551615";
    assert!(policy::is_virtual_alias(large));
    assert_eq!(policy::virtual_alias_ordinal(large), Some(u64::MAX));

    for bad in [
        "virtual-0",
        "virtual-00",
        "virtual-01",
        "virtual--1",
        "virtual-+1",
        "virtual-1.0",
        "virtual- 1",
        "virtual-",
        "virtual-18446744073709551616",
        "virtual-123456789012345678901",
        "virtual-1x",
        "Virtual-1000",
        "real",
    ] {
        assert!(!policy::is_virtual_alias(bad), "must reject {bad}");
        assert!(policy::virtual_alias_ordinal(bad).is_none(), "must not parse {bad}");
    }
}

#[test]
fn virtual_1000_still_needs_registration() {
    let mut state = PolicyState::new(1);
    state.set_scope(Scope::VirtualOnly);
    assert!(state.plan("click", TargetRequest::Virtual("virtual-1000".into())).is_err());

    let binding = state
        .observe_screen("virtual-1000", ScreenFacts::new(1000, 720, 1280, 0))
        .unwrap();
    state.set_a11y_facts(a11y_ready(&["click"], &[(1000, true)]));
    let plan = state
        .plan("click", TargetRequest::Virtual("virtual-1000".into()))
        .unwrap();
    assert_eq!(plan.screen().unwrap().generation, binding.generation);
    assert_eq!(plan.screen().unwrap().display_id, 1000);
}

#[test]
fn destroy_and_recreate_invalidates_old_plan() {
    let mut state = basic_state();
    let plan = state
        .plan("click", TargetRequest::Virtual("virtual-1".into()))
        .unwrap();
    assert!(state.revalidate(&plan).is_ok());

    assert!(state.destroy_screen("virtual-1"));
    assert!(state.revalidate(&plan).is_err());

    let new_generation = virtual_screen(&mut state, "virtual-1", 41);
    assert_ne!(new_generation, plan.screen().unwrap().generation);
    assert!(state.revalidate(&plan).is_err(), "same alias must not revive the old plan");

    let new_plan = state
        .plan("click", TargetRequest::Virtual("virtual-1".into()))
        .unwrap();
    assert!(state.revalidate(&new_plan).is_ok());
    assert_ne!(new_plan.screen().unwrap().generation, plan.screen().unwrap().generation);
}

#[test]
fn rotation_and_scope_change_invalidate_plans() {
    let mut state = basic_state();
    let plan = state
        .plan("snapshot", TargetRequest::Virtual("virtual-1".into()))
        .unwrap();
    state
        .observe_screen("virtual-1", ScreenFacts::new(41, 1920, 1080, 1))
        .unwrap();
    assert!(state.revalidate(&plan).is_err());

    let next = state
        .plan("snapshot", TargetRequest::Virtual("virtual-1".into()))
        .unwrap();
    assert!(state.validate_region(&next, 0, 0, 1920, 1080).is_ok());
    state.set_scope(Scope::RealOnly);
    assert!(state.revalidate(&next).is_err());
    assert!(state.validate_region(&next, 0, 0, 10, 10).is_err());
}

#[test]
fn coordinates_and_regions_use_original_logical_size() {
    let state = basic_state();
    let plan = state
        .plan("readRegion", TargetRequest::Virtual("virtual-1".into()))
        .unwrap();
    assert!(state.validate_region(&plan, 0, 0, 1080, 1920).is_ok());
    assert!(state.validate_region(&plan, 10, 20, 11, 21).is_ok());
    assert!(state.validate_region(&plan, 0, 0, 1081, 1920).is_err());
    assert!(state.validate_region(&plan, 0, 0, 1080, 1921).is_err());
    assert!(state.validate_region(&plan, -1, 0, 10, 10).is_err());
    assert!(state.validate_region(&plan, 10, 10, 10, 20).is_err());
    assert!(state.validate_region(&plan, 20, 10, 10, 20).is_err());
    assert!(state.validate_point(&plan, 1079, 1919).is_ok());
    assert!(state.validate_point(&plan, 1080, 1919).is_err());
    assert!(state.validate_point(&plan, -1, 0).is_err());
}

#[test]
fn browser_and_web_remain_usable_under_default_virtual_only() {
    let state = PolicyState::new(1);
    assert_eq!(state.scope(), Scope::VirtualOnly);
    let browser = state.plan("browserOpen", TargetRequest::BrowserWorkspace).unwrap();
    assert_eq!(browser.backend, Backend::BrowserHost);
    assert_eq!(browser.scope_generation, None);
    assert!(state.revalidate(&browser).is_ok());

    let web = state.plan("webSnapshot", TargetRequest::AppWebView).unwrap();
    assert_eq!(web.backend, Backend::WebViewHost);
    assert!(state.revalidate(&web).is_ok());

    assert!(state.plan("browserOpen", TargetRequest::Virtual("virtual-1".into())).is_err());
}

#[test]
fn virtual_creation_checks_scope_while_screen_ops_need_registration() {
    let mut state = PolicyState::new(1);
    state.set_scope(Scope::RealOnly);
    assert!(state.plan("vdCreate", TargetRequest::NewVirtual("virtual-1".into())).is_err());

    state.set_scope(Scope::VirtualOnly);
    state.set_shizuku_facts(shizuku_ready(ServerUid::Shell2000, &["vdCreate", "vdInput", "vdDestroy"], &[]));
    let create = state
        .plan("vdCreate", TargetRequest::NewVirtual("virtual-1".into()))
        .unwrap();
    assert_eq!(create.backend, Backend::Shizuku);
    assert!(state.plan("vdInput", TargetRequest::Virtual("virtual-1".into())).is_err());

    virtual_screen(&mut state, "virtual-1", 41);
    assert!(state.plan("vdInput", TargetRequest::Virtual("virtual-1".into())).is_ok());
    assert!(state.plan("vdDestroy", TargetRequest::Virtual("virtual-1".into())).is_ok());
    assert!(state.plan("vdDestroy", TargetRequest::Virtual("virtual-2".into())).is_err());
}

#[test]
fn shizuku_only_ops_are_not_blocked_by_a11y_preference() {
    let mut state = basic_state();
    state.set_shizuku_facts(shizuku_ready(ServerUid::Shell2000, &["shExec", "vdInfo"], &[]));
    let shell = state.plan("shExec", TargetRequest::PrivilegedShell).unwrap();
    assert_eq!(shell.backend, Backend::Shizuku);
    let info = state.plan("vdInfo", TargetRequest::NewVirtual("virtual-1".into())).unwrap();
    assert_eq!(info.backend, Backend::Shizuku);
}

#[test]
fn uid_zero_and_shell_uid_are_not_interchangeable() {
    let mut state = basic_state();
    let ops = ["shExec"];
    assert_eq!(ServerUid::from_observed(Some(2000)), ServerUid::Shell2000);
    assert_eq!(ServerUid::from_observed(Some(0)), ServerUid::Root0);
    assert_eq!(ServerUid::from_observed(None), ServerUid::Unknown);

    state.set_shizuku_facts(shizuku_ready(ServerUid::Shell2000, &ops, &[]));
    assert_eq!(state.plan("shExec", TargetRequest::PrivilegedShell).unwrap().backend, Backend::Shizuku);

    state.set_shizuku_facts(shizuku_ready(ServerUid::Root0, &ops, &[]));
    assert!(state.plan("shExec", TargetRequest::PrivilegedShell).is_err());
    assert!(!state.root_only_available());

    state.set_root_facts(RootFacts { authorization: Tri::Yes, consent_valid: Tri::No });
    assert!(state.plan("shExec", TargetRequest::PrivilegedShell).is_err());

    state.set_root_facts(RootFacts::granted());
    assert!(state.root_only_available());
    assert_eq!(state.plan("shExec", TargetRequest::PrivilegedShell).unwrap().backend, Backend::Root);
}

#[test]
fn uid_zero_never_upgrades_basic_screen_control() {
    let mut state = PolicyState::new(1);
    state.set_scope(Scope::All);
    virtual_screen(&mut state, "virtual-1", 41);
    real_screen(&mut state);
    state.set_a11y_facts(A11yFacts {
        enabled: Tri::No,
        online: Tri::No,
        supported_ops: OpSet::known::<_, &str>([]),
        display_support: DisplaySupport::known([(41, true)]),
    });
    state.set_shizuku_facts(shizuku_ready(ServerUid::Root0, &["click"], &[(41, true)]));
    state.set_root_facts(RootFacts::granted());
    assert!(state.plan("click", TargetRequest::Virtual("virtual-1".into())).is_err());
    assert_eq!(state.plan("snapshot", TargetRequest::Real).unwrap_err().code(), "shizuku-unsupported");

    state.set_shizuku_facts(shizuku_ready(ServerUid::Root0, &["snapshot", "click"], &[(0, true), (41, true)]));
    assert_eq!(state.plan("click", TargetRequest::Virtual("virtual-1".into())).unwrap_err().code(), "root-channel-not-allowed");
    assert_eq!(state.plan("snapshot", TargetRequest::Real).unwrap_err().code(), "root-channel-not-allowed");
}

#[test]
fn root_authorization_change_invalidates_plan() {
    let mut state = PolicyState::new(1);
    state.set_scope(Scope::All);
    real_screen(&mut state);
    state.set_a11y_facts(A11yFacts::ready(&["screenshot"], &[(0, false)]));
    state.set_shizuku_facts(shizuku_ready(ServerUid::Root0, &["shExec"], &[]));
    state.set_root_facts(RootFacts::granted());
    let plan = state.plan("shExec", TargetRequest::PrivilegedShell).unwrap();
    assert_eq!(plan.backend, Backend::Root);
    state.set_root_facts(RootFacts::default());
    assert_eq!(state.revalidate(&plan).unwrap_err().code(), "authorization-changed");
}

#[test]
fn plan_epoch_and_generation_are_bound() {
    let state = basic_state();
    let plan: DispatchPlan = state
        .plan("click", TargetRequest::Virtual("virtual-1".into()))
        .unwrap();
    let other = PolicyState::new(8);
    assert_eq!(other.revalidate(&plan).unwrap_err().code(), "epoch-mismatch");
}

#[test]
fn unknown_scope_corruption_drops_to_virtual_only() {
    let mut state = PolicyState::new(1);
    state.set_scope(Scope::All);
    state.set_scope_wire(Some("totally-broken"));
    assert_eq!(state.scope(), Scope::VirtualOnly);
    state.set_scope_wire(None);
    assert_eq!(state.scope(), Scope::VirtualOnly);
}

#[test]
fn real_screen_requires_display_zero_and_scope() {
    let mut state = PolicyState::new(1);
    assert!(state.observe_screen("real", ScreenFacts::new(3, 100, 100, 0)).is_err());
    real_screen(&mut state);
    state.set_a11y_facts(a11y_ready(&["snapshot"], &[(0, true)]));
    assert!(state.plan("snapshot", TargetRequest::Real).is_err());
    state.set_scope(Scope::All);
    assert!(state.plan("snapshot", TargetRequest::Real).is_ok());
    state.set_scope(Scope::VirtualOnly);
    assert!(state.plan("snapshot", TargetRequest::Real).is_err());
}

#[test]
fn dynamic_shizuku_specialties_need_facts() {
    let mut state = PolicyState::new(1);
    assert!(state.plan("shExec", TargetRequest::PrivilegedShell).is_err());
    state.set_shizuku_facts(ShizukuFacts {
        installed: Tri::Yes,
        running: Tri::Yes,
        granted: Tri::Yes,
        bound: Tri::Yes,
        functional_ready: Tri::Yes,
        server_uid: ServerUid::Shell2000,
        supported_ops: OpSet::Unknown,
        display_support: DisplaySupport::Unknown,
    });
    assert_eq!(state.plan("shExec", TargetRequest::PrivilegedShell).unwrap_err().code(), "facts-unknown");
}

#[test]
fn state_and_wait_are_local_and_not_screen_scoped() {
    let mut state = PolicyState::new(1);
    assert!(state.plan("wait", TargetRequest::ControlMemory).is_ok());
    state.set_a11y_facts(A11yFacts::default());
    assert!(state.plan("state", TargetRequest::ControlMemory).is_err());
    state.set_a11y_facts(a11y_ready(&["state"], &[]));
    assert_eq!(state.plan("state", TargetRequest::ControlMemory).unwrap().backend, Backend::A11y);
}
