use std::sync::{Arc, Mutex};

use dsh_phone_control_core::lifecycle::{
    codes, receipt_codes, Admission, Executed, Fingerprint, Journal, JournalError, Lifecycle,
    LifecycleError, Limits, Outcome, Phase, Receipt,
};

#[derive(Default)]
struct Disk {
    state: Option<Vec<u8>>,
    stores: Vec<Vec<u8>>,
    fail_next_store: usize,
    fail_load: bool,
}

/// 测试用内存日志。模拟“上一次写成功、下一次写失败”的真实故障面。
#[derive(Clone, Default)]
struct MemoryJournal {
    disk: Arc<Mutex<Disk>>,
}

impl MemoryJournal {
    fn new() -> Self {
        Self::default()
    }

    fn fail_next_store(&self, times: usize) {
        self.disk.lock().unwrap().fail_next_store = times;
    }

    fn fail_load(&self) {
        self.disk.lock().unwrap().fail_load = true;
    }

    fn store_count(&self) -> usize {
        self.disk.lock().unwrap().stores.len()
    }

    fn last_stored(&self) -> Option<String> {
        self.disk
            .lock()
            .unwrap()
            .stores
            .last()
            .map(|bytes| String::from_utf8(bytes.clone()).unwrap())
    }

}

impl Journal for MemoryJournal {
    fn load(&mut self) -> Result<Option<Vec<u8>>, JournalError> {
        let disk = self.disk.lock().unwrap();
        if disk.fail_load {
            return Err(JournalError::load("injected load failure"));
        }
        Ok(disk.state.clone())
    }

    fn store(&mut self, state: &[u8]) -> Result<(), JournalError> {
        let mut disk = self.disk.lock().unwrap();
        if disk.fail_next_store > 0 {
            disk.fail_next_store -= 1;
            return Err(JournalError::store("injected store failure"));
        }
        disk.state = Some(state.to_vec());
        disk.stores.push(state.to_vec());
        Ok(())
    }
}

fn open(journal: &MemoryJournal) -> Lifecycle<MemoryJournal> {
    Lifecycle::open(journal.clone()).expect("open lifecycle")
}

fn open_with(journal: &MemoryJournal, limits: Limits) -> Lifecycle<MemoryJournal> {
    Lifecycle::with_limits(journal.clone(), limits).expect("open lifecycle with limits")
}

fn permit(admission: Admission) -> dsh_phone_control_core::lifecycle::DispatchPermit {
    match admission {
        Admission::Dispatch(permit) => permit,
        Admission::Replay(receipt) => panic!("expected dispatch, got replay {receipt:?}"),
    }
}

fn replay(admission: Admission) -> Receipt {
    match admission {
        Admission::Replay(receipt) => receipt,
        Admission::Dispatch(_) => panic!("expected replay"),
    }
}

fn err_code(result: Result<impl std::fmt::Debug, LifecycleError>) -> &'static str {
    result.expect_err("expected an error").code()
}

fn settled_ok(code: &str) -> Outcome {
    Outcome::new(code, true)
}

fn dispatch_and_settle(
    lifecycle: &mut Lifecycle<MemoryJournal>,
    call_id: &str,
    body: &[u8],
) -> Receipt {
    let permit = permit(lifecycle.begin(call_id, body).unwrap());
    lifecycle.mark_dispatched(&permit).unwrap();
    lifecycle
        .settle(call_id, permit.fingerprint(), settled_ok("done"))
        .unwrap()
}

#[test]
fn dispatches_only_after_durable_evidence() {
    let journal = MemoryJournal::new();
    let mut lifecycle = open(&journal);

    let permit = permit(lifecycle.begin("call-1", b"tap 10 20").unwrap());
    assert_eq!(lifecycle.phase("call-1"), Some(Phase::Prepared));
    assert_eq!(lifecycle.receipt("call-1"), None);
    assert!(journal.last_stored().unwrap().contains("\"prepared\""));

    lifecycle.mark_dispatched(&permit).unwrap();
    assert_eq!(lifecycle.phase("call-1"), Some(Phase::Dispatching));
    assert!(journal.last_stored().unwrap().contains("\"dispatching\""));

    let receipt = lifecycle
        .settle("call-1", permit.fingerprint(), settled_ok("tap-applied"))
        .unwrap();
    assert!(receipt.ok());
    assert_eq!(receipt.executed(), Executed::Yes);
    assert_eq!(receipt.code(), "tap-applied");
    assert_eq!(receipt.screen_id(), None);
    assert_eq!(lifecycle.phase("call-1"), Some(Phase::Settled));
}

#[test]
fn replay_returns_saved_receipt_without_new_dispatch() {
    let journal = MemoryJournal::new();
    let mut lifecycle = open(&journal);
    let first = dispatch_and_settle(&mut lifecycle, "call-1", b"swipe");
    let stores_before = journal.store_count();

    let second = replay(lifecycle.begin("call-1", b"swipe").unwrap());
    assert_eq!(first, second);
    assert_eq!(journal.store_count(), stores_before);

    let mut reopened = open(&journal);
    assert_eq!(reopened.phase("call-1"), Some(Phase::Settled));
    assert_eq!(reopen_only_replay(&mut reopened), first);
}

fn reopen_only_replay(lifecycle: &mut Lifecycle<MemoryJournal>) -> Receipt {
    replay(lifecycle.begin("call-1", b"swipe").unwrap())
}

#[test]
fn same_id_with_different_request_is_rejected() {
    let journal = MemoryJournal::new();
    let mut lifecycle = open(&journal);
    let permit = permit(lifecycle.begin("call-1", b"tap 1 1").unwrap());

    let error = lifecycle.begin("call-1", b"tap 2 2").unwrap_err();
    assert_eq!(error.code(), codes::CALL_ID_CONFLICT);
    assert_eq!(lifecycle.phase("call-1"), Some(Phase::Prepared));

    lifecycle.mark_dispatched(&permit).unwrap();
    lifecycle
        .settle("call-1", permit.fingerprint(), settled_ok("done"))
        .unwrap();
    let error = lifecycle.begin("call-1", b"tap 2 2").unwrap_err();
    assert_eq!(error.code(), codes::CALL_ID_CONFLICT);
    assert!(lifecycle.receipt("call-1").unwrap().ok());
}

#[test]
fn same_request_in_flight_is_not_dispatched_twice() {
    let journal = MemoryJournal::new();
    let mut lifecycle = open(&journal);
    let permit = permit(lifecycle.begin("call-1", b"tap 10 20").unwrap());

    let error = lifecycle.begin("call-2", b"tap 10 20").unwrap_err();
    assert_eq!(error.code(), codes::REQUEST_IN_PROGRESS);
    assert_eq!(lifecycle.phase("call-2"), None);
    assert_eq!(journal.store_count(), 1);

    lifecycle.mark_dispatched(&permit).unwrap();
    let error = lifecycle.begin("call-2", b"tap 10 20").unwrap_err();
    assert_eq!(error.code(), codes::REQUEST_IN_PROGRESS);
}

#[test]
fn unknown_is_never_replayed() {
    let journal = MemoryJournal::new();
    let mut lifecycle = open(&journal);
    let permit = permit(lifecycle.begin("call-1", b"tap 10 20").unwrap());
    lifecycle.mark_dispatched(&permit).unwrap();

    let receipt = lifecycle
        .mark_unknown("call-1", permit.fingerprint(), "su-timeout")
        .unwrap();
    assert!(!receipt.ok());
    assert_eq!(receipt.executed(), Executed::Unknown);
    assert_eq!(receipt.code(), "su-timeout");
    assert_eq!(lifecycle.phase("call-1"), Some(Phase::Unknown));

    assert_eq!(err_code(lifecycle.begin("call-1", b"tap 10 20")), codes::OPERATION_UNKNOWN);
    assert_eq!(err_code(lifecycle.begin("call-2", b"tap 10 20")), codes::REQUEST_UNKNOWN);
    assert_eq!(
        err_code(lifecycle.settle("call-1", permit.fingerprint(), settled_ok("done"))),
        codes::OPERATION_UNKNOWN
    );
    assert_eq!(
        err_code(lifecycle.mark_dispatched(&permit)),
        codes::OPERATION_UNKNOWN
    );

    let mut reopened = open(&journal);
    assert_eq!(reopened.phase("call-1"), Some(Phase::Unknown));
    assert_eq!(err_code(reopened.begin("call-1", b"tap 10 20")), codes::OPERATION_UNKNOWN);
}

#[test]
fn restart_turns_unsettled_dispatches_into_unknown_before_returning() {
    let journal = MemoryJournal::new();
    {
        let mut lifecycle = open(&journal);
        let permit = permit(lifecycle.begin("call-1", b"tap 10 20").unwrap());
        lifecycle.mark_dispatched(&permit).unwrap();
        assert_eq!(lifecycle.phase("call-1"), Some(Phase::Dispatching));
    }

    let stores_before = journal.store_count();
    let recovered = open(&journal);
    assert_eq!(recovered.phase("call-1"), Some(Phase::Unknown));
    assert_eq!(journal.store_count(), stores_before + 1);
    assert!(journal.last_stored().unwrap().contains("recovered-unsettled"));

    let receipt = recovered.receipt("call-1").unwrap();
    assert!(!receipt.ok());
    assert_eq!(receipt.executed(), Executed::Unknown);
}

#[test]
fn prepared_is_not_resumed_after_restart() {
    let journal = MemoryJournal::new();
    {
        let mut lifecycle = open(&journal);
        let _permit = permit(lifecycle.begin("call-1", b"tap 10 20").unwrap());
    }

    let mut recovered = open(&journal);
    assert_eq!(recovered.phase("call-1"), Some(Phase::Unknown));
    assert_eq!(
        err_code(recovered.begin("call-1", b"tap 10 20")),
        codes::OPERATION_UNKNOWN
    );
    assert_eq!(recovered.phase("call-1"), Some(Phase::Unknown));
    assert!(journal.last_stored().unwrap().contains("recovered-before-dispatch"));
}

#[test]
fn recovery_failure_prevents_open() {
    let journal = MemoryJournal::new();
    {
        let mut lifecycle = open(&journal);
        let permit = permit(lifecycle.begin("call-1", b"tap").unwrap());
        lifecycle.mark_dispatched(&permit).unwrap();
    }
    journal.fail_next_store(1);

    let error = match Lifecycle::open(journal.clone()) {
        Ok(_) => panic!("recovery must persist unknown before returning"),
        Err(error) => error,
    };
    assert_eq!(error.code(), codes::JOURNAL_WRITE_FAILED);

    let mut second = open(&journal);
    assert_eq!(second.phase("call-1"), Some(Phase::Unknown));
    assert_eq!(err_code(second.begin("call-1", b"tap")), codes::OPERATION_UNKNOWN);
}

#[test]
fn journal_write_failure_before_dispatch_blocks_the_side_effect() {
    let journal = MemoryJournal::new();
    let mut lifecycle = open(&journal);
    let permit = permit(lifecycle.begin("call-1", b"touch 5 5").unwrap());
    journal.fail_next_store(1);

    let error = lifecycle.mark_dispatched(&permit).unwrap_err();
    assert_eq!(error.code(), codes::JOURNAL_WRITE_FAILED);
    assert_eq!(lifecycle.phase("call-1"), Some(Phase::Unknown));
    assert_eq!(
        err_code(lifecycle.begin("call-1", b"touch 5 5")),
        codes::OPERATION_UNKNOWN
    );
    assert_eq!(
        err_code(lifecycle.mark_dispatched(&permit)),
        codes::OPERATION_UNKNOWN
    );

    let mut reopened = open(&journal);
    assert_eq!(reopened.phase("call-1"), Some(Phase::Unknown));
    assert_eq!(
        err_code(reopened.begin("call-2", b"touch 5 5")),
        codes::REQUEST_UNKNOWN
    );
}

#[test]
fn failed_begin_leaves_no_record_to_dispatch() {
    let journal = MemoryJournal::new();
    let mut lifecycle = open(&journal);
    journal.fail_next_store(1);

    let error = lifecycle.begin("call-1", b"tap").unwrap_err();
    assert_eq!(error.code(), codes::JOURNAL_WRITE_FAILED);
    assert_eq!(lifecycle.phase("call-1"), None);
    assert_eq!(lifecycle.record_count(), 0);

    let permit = permit(lifecycle.begin("call-1", b"tap").unwrap());
    lifecycle.mark_dispatched(&permit).unwrap();
    assert_eq!(lifecycle.phase("call-1"), Some(Phase::Dispatching));
}

#[test]
fn settle_requires_dispatch_evidence() {
    let journal = MemoryJournal::new();
    let mut lifecycle = open(&journal);
    let permit = permit(lifecycle.begin("call-1", b"tap").unwrap());

    let error = lifecycle
        .settle("call-1", permit.fingerprint(), settled_ok("done"))
        .unwrap_err();
    assert_eq!(error.code(), codes::INVALID_TRANSITION);
    assert_eq!(lifecycle.phase("call-1"), Some(Phase::Prepared));
    assert_eq!(lifecycle.receipt("call-1"), None);
}

#[test]
fn settlement_write_failure_becomes_unknown() {
    let journal = MemoryJournal::new();
    let mut lifecycle = open(&journal);
    let permit = permit(lifecycle.begin("call-1", b"tap").unwrap());
    lifecycle.mark_dispatched(&permit).unwrap();
    journal.fail_next_store(1);

    let error = lifecycle
        .settle("call-1", permit.fingerprint(), settled_ok("done"))
        .unwrap_err();
    assert_eq!(error.code(), codes::JOURNAL_WRITE_FAILED);
    assert_eq!(lifecycle.phase("call-1"), Some(Phase::Unknown));
    assert!(!lifecycle.receipt("call-1").unwrap().ok());
    assert_eq!(
        lifecycle.receipt("call-1").unwrap().executed(),
        Executed::Unknown
    );
    assert_eq!(
        err_code(lifecycle.begin("call-1", b"tap")),
        codes::OPERATION_UNKNOWN
    );
}

#[test]
fn cancel_before_dispatch_is_not_executed() {
    let journal = MemoryJournal::new();
    let mut lifecycle = open(&journal);
    let permit = permit(lifecycle.begin("call-1", b"tap").unwrap());

    let receipt = lifecycle
        .withdraw("call-1", permit.fingerprint())
        .unwrap();
    assert!(!receipt.ok());
    assert_eq!(receipt.executed(), Executed::No);
    assert_eq!(receipt.code(), receipt_codes::WITHDRAWN_BEFORE_DISPATCH);
    assert_eq!(lifecycle.phase("call-1"), Some(Phase::Cancelled));

    let replayed = replay(lifecycle.begin("call-1", b"tap").unwrap());
    assert_eq!(replayed, receipt);
    assert_eq!(
        err_code(lifecycle.mark_dispatched(&permit)),
        codes::INVALID_TRANSITION
    );
    assert_eq!(
        err_code(lifecycle.settle("call-1", permit.fingerprint(), settled_ok("done"))),
        codes::INVALID_TRANSITION
    );

    let mut reopened = open(&journal);
    assert_eq!(reopened.phase("call-1"), Some(Phase::Cancelled));
    assert_eq!(
        replay(reopened.begin("call-1", b"tap").unwrap()),
        receipt
    );
}

#[test]
fn dispatched_cancel_is_unknown_and_withdraw_is_refused() {
    let journal = MemoryJournal::new();
    let mut lifecycle = open(&journal);
    let permit = permit(lifecycle.begin("call-1", b"tap").unwrap());
    lifecycle.mark_dispatched(&permit).unwrap();

    assert_eq!(
        err_code(lifecycle.withdraw("call-1", permit.fingerprint())),
        codes::WITHDRAW_NOT_ALLOWED
    );
    assert_eq!(lifecycle.phase("call-1"), Some(Phase::Dispatching));

    let receipt = lifecycle
        .mark_unknown("call-1", permit.fingerprint(), "caller-cancelled")
        .unwrap();
    assert_eq!(receipt.executed(), Executed::Unknown);
    assert!(!receipt.ok());
    assert_eq!(lifecycle.phase("call-1"), Some(Phase::Unknown));

    let mut reopened = open(&journal);
    assert_eq!(reopened.phase("call-1"), Some(Phase::Unknown));
    assert_eq!(
        err_code(reopened.begin("call-1", b"tap")),
        codes::OPERATION_UNKNOWN
    );
}

#[test]
fn unknown_rejects_any_withdraw_even_with_evidence_text() {
    let journal = MemoryJournal::new();
    let mut lifecycle = open(&journal);
    let permit = permit(lifecycle.begin("call-1", b"tap").unwrap());
    lifecycle.mark_dispatched(&permit).unwrap();
    lifecycle
        .mark_unknown("call-1", permit.fingerprint(), "timeout")
        .unwrap();

    assert_eq!(
        err_code(lifecycle.withdraw("call-1", permit.fingerprint())),
        codes::WITHDRAW_NOT_ALLOWED
    );
    let stored = lifecycle.receipt("call-1").unwrap();
    assert_eq!(stored.executed(), Executed::Unknown);
    assert_eq!(stored.code(), "timeout");
    assert_eq!(lifecycle.phase("call-1"), Some(Phase::Unknown));

    assert_eq!(
        err_code(lifecycle.settle("call-1", permit.fingerprint(), settled_ok("done"))),
        codes::OPERATION_UNKNOWN
    );
    assert_eq!(
        err_code(lifecycle.mark_dispatched(&permit)),
        codes::OPERATION_UNKNOWN
    );
    assert_eq!(lifecycle.phase("call-1"), Some(Phase::Unknown));
}

#[test]
fn settle_accepts_definite_not_executed_but_never_retries() {
    let journal = MemoryJournal::new();
    let mut lifecycle = open(&journal);
    let permit = permit(lifecycle.begin("call-1", b"tap").unwrap());
    lifecycle.mark_dispatched(&permit).unwrap();

    let receipt = lifecycle
        .settle("call-1", permit.fingerprint(), Outcome::not_executed("preflight-rejected"))
        .unwrap();
    assert!(!receipt.ok());
    assert_eq!(receipt.executed(), Executed::No);
    assert_eq!(receipt.code(), "preflight-rejected");
    assert_eq!(lifecycle.phase("call-1"), Some(Phase::Settled));

    let mut reopened = open(&journal);
    assert_eq!(reopened.phase("call-1"), Some(Phase::Settled));
    let replayed = replay(reopened.begin("call-1", b"tap").unwrap());
    assert_eq!(replayed, receipt);
    assert_eq!(
        err_code(reopened.mark_dispatched(&permit)),
        codes::INVALID_TRANSITION
    );
}

#[test]
fn receipt_shape_rejects_unsafe_combinations() {
    assert!(Receipt::new(true, "done", Executed::Unknown, None).is_err());
    assert!(Receipt::new(true, "done", Executed::No, None).is_err());
    assert!(Receipt::new(false, "", Executed::No, None).is_err());
    assert!(Receipt::new(false, "bad code with spaces", Executed::No, None).is_err());
    assert!(Receipt::new(false, "ok", Executed::Unknown, Some("a b".into())).is_err());
    assert!(
        Receipt::new(false, "ok", Executed::Unknown, None)
            .unwrap()
            .with_diagnostic("x".repeat(4097))
            .is_err()
    );
}

#[test]
fn receipt_wire_shape_is_stable() {
    let receipt = Receipt::new(false, "target-missing", Executed::Unknown, None)
        .unwrap()
        .with_diagnostic("node not found")
        .unwrap();
    let wire = serde_json::to_value(&receipt).unwrap();
    assert_eq!(wire["ok"], false);
    assert_eq!(wire["code"], "target-missing");
    assert_eq!(wire["executed"], "unknown");
    assert!(wire["screenId"].is_null());
    assert_eq!(wire["diagnostic"], "node not found");
    assert!(wire.get("data").is_none());
    assert!(wire.get("screen_id").is_none());

    let parsed: Receipt = serde_json::from_value(wire).unwrap();
    assert_eq!(parsed, receipt);
    parsed.validate().unwrap();

    let forged = serde_json::json!({
        "ok": true,
        "code": "done",
        "executed": "unknown",
        "screenId": null
    });
    // 反序列化本身即校验：伪造的回执根本构造不出来，不依赖调用方记得 validate。
    let forged = serde_json::from_value::<Receipt>(forged).unwrap_err();
    assert!(forged.to_string().contains(codes::INVALID_RECEIPT));

    let not_executed_ok = serde_json::json!({
        "ok": true,
        "code": "done",
        "executed": "no",
        "screenId": null
    });
    assert!(serde_json::from_value::<Receipt>(not_executed_ok).is_err());

    let definite_no = serde_json::json!({
        "ok": false,
        "code": "preflight-rejected",
        "executed": "no",
        "screenId": null
    });
    let parsed: Receipt = serde_json::from_value(definite_no).unwrap();
    assert_eq!(parsed.executed(), Executed::No);
}

#[test]
fn executed_yes_receipt_with_screen_id_round_trips() {
    let outcome = Outcome::new("screenshot-taken", true)
        .with_screen_id("display:1")
        .with_data(serde_json::json!({"bytes": 48213}));
    let journal = MemoryJournal::new();
    let mut lifecycle = open(&journal);
    let permit = permit(lifecycle.begin("call-1", b"screenshot").unwrap());
    lifecycle.mark_dispatched(&permit).unwrap();
    let receipt = lifecycle
        .settle("call-1", permit.fingerprint(), outcome)
        .unwrap();
    assert_eq!(receipt.screen_id(), Some("display:1"));
    assert_eq!(receipt.data().unwrap()["bytes"], 48213);

    let mut reopened = open(&journal);
    let replayed = replay(reopened.begin("call-1", b"screenshot").unwrap());
    assert_eq!(replayed, receipt);
}

#[test]
fn capacity_rejects_without_evicting_unknown_or_in_flight() {
    let journal = MemoryJournal::new();
    let limits = Limits::new(2).unwrap();
    let mut lifecycle = open_with(&journal, limits);

    let permit_a = permit(lifecycle.begin("call-a", b"a").unwrap());
    lifecycle.mark_dispatched(&permit_a).unwrap();
    lifecycle
        .mark_unknown("call-a", permit_a.fingerprint(), "timeout")
        .unwrap();

    let permit_b = permit(lifecycle.begin("call-b", b"b").unwrap());
    lifecycle.mark_dispatched(&permit_b).unwrap();

    assert_eq!(err_code(lifecycle.begin("call-c", b"c")), codes::CAPACITY_EXHAUSTED);
    assert_eq!(lifecycle.phase("call-a"), Some(Phase::Unknown));
    assert_eq!(lifecycle.phase("call-b"), Some(Phase::Dispatching));
    assert_eq!(lifecycle.record_count(), 2);

    lifecycle
        .settle("call-b", permit_b.fingerprint(), settled_ok("done"))
        .unwrap();
    assert_eq!(lifecycle.phase("call-a"), Some(Phase::Unknown));
    assert_eq!(lifecycle.phase("call-b"), Some(Phase::Settled));
    assert_eq!(lifecycle.record_count(), 2);
    assert_eq!(
        err_code(lifecycle.begin("call-c", b"c")),
        codes::CAPACITY_EXHAUSTED
    );
    assert_eq!(
        replay(lifecycle.begin("call-b", b"b").unwrap()).code(),
        "done"
    );
}

#[test]
fn capacity_full_keeps_old_receipts_and_rejects_new_ids() {
    let journal = MemoryJournal::new();
    let mut lifecycle = open_with(&journal, Limits::new(2).unwrap());
    let first = dispatch_and_settle(&mut lifecycle, "call-1", b"1");
    dispatch_and_settle(&mut lifecycle, "call-2", b"2");

    assert_eq!(
        err_code(lifecycle.begin("call-3", b"3")),
        codes::CAPACITY_EXHAUSTED
    );
    assert_eq!(lifecycle.phase("call-1"), Some(Phase::Settled));
    assert_eq!(lifecycle.phase("call-2"), Some(Phase::Settled));
    assert_eq!(lifecycle.record_count(), 2);

    // 老 ID 同 payload 仍然回原回执，不会因为容量而被当成新调用重放副作用。
    let replayed = replay(lifecycle.begin("call-1", b"1").unwrap());
    assert_eq!(replayed, first);
    assert_eq!(lifecycle.phase("call-1"), Some(Phase::Settled));

    let mut reopened = open_with(&journal, Limits::new(2).unwrap());
    assert_eq!(reopened.phase("call-1"), Some(Phase::Settled));
    assert_eq!(reopened.phase("call-2"), Some(Phase::Settled));
    assert_eq!(replay(reopened.begin("call-1", b"1").unwrap()), first);
    assert_eq!(
        err_code(reopened.begin("call-3", b"3")),
        codes::CAPACITY_EXHAUSTED
    );
}

#[test]
fn call_id_limits_are_enforced() {
    let journal = MemoryJournal::new();
    let mut lifecycle = open(&journal);
    assert_eq!(err_code(lifecycle.begin("", b"a")), codes::INVALID_CALL_ID);
    assert_eq!(
        err_code(lifecycle.begin(&"x".repeat(65), b"a")),
        codes::INVALID_CALL_ID
    );
    assert_eq!(
        err_code(lifecycle.begin("-leading", b"a")),
        codes::INVALID_CALL_ID
    );
    assert_eq!(
        err_code(lifecycle.begin("has space", b"a")),
        codes::INVALID_CALL_ID
    );
    assert_eq!(
        err_code(lifecycle.begin("路径", b"a")),
        codes::INVALID_CALL_ID
    );
    assert_eq!(lifecycle.record_count(), 0);

    let permit = permit(lifecycle.begin(&"x".repeat(64), b"a").unwrap());
    lifecycle.mark_dispatched(&permit).unwrap();
    assert_eq!(lifecycle.phase(&"x".repeat(64)), Some(Phase::Dispatching));
}

#[test]
fn journal_load_failure_is_reported() {
    let journal = MemoryJournal::new();
    journal.fail_load();
    let error = match Lifecycle::open(journal) {
        Ok(_) => panic!("open must fail"),
        Err(error) => error,
    };
    assert_eq!(error.code(), codes::JOURNAL_LOAD_FAILED);
}

#[test]
fn corrupt_journal_is_rejected() {
    let journal = MemoryJournal::new();
    {
        let _ = open(&journal);
    }
    journal.disk.lock().unwrap().state = Some(b"{\"version\":1,\"next_seq\":0,\"records\":[{\"call_id\":\"a\",\"fingerprint\":\"zz\",\"phase\":\"settled\",\"seq\":0}]}".to_vec());
    let error = match Lifecycle::open(journal) {
        Ok(_) => panic!("corrupt journal must be rejected"),
        Err(error) => error,
    };
    assert_eq!(error.code(), codes::JOURNAL_CORRUPT);
}

#[test]
fn stored_receipt_is_validated_during_restore() {
    let journal = MemoryJournal::new();
    {
        let mut lifecycle = open(&journal);
        let permit = permit(lifecycle.begin("call-1", b"tap").unwrap());
        lifecycle.mark_dispatched(&permit).unwrap();
        lifecycle
            .settle("call-1", permit.fingerprint(), settled_ok("done"))
            .unwrap();
    }

    // 直接篡改存储的 JSON：把已结算回执改成 ok=true 配 executed=no。
    let mut disk = journal.disk.lock().unwrap();
    let raw = String::from_utf8(disk.state.clone().unwrap()).unwrap();
    let forged = raw.replace("\"executed\":\"yes\"", "\"executed\":\"no\"");
    assert_ne!(raw, forged);
    disk.state = Some(forged.into_bytes());
    drop(disk);

    let error = match Lifecycle::open(journal) {
        Ok(_) => panic!("forged stored receipt must be rejected"),
        Err(error) => error,
    };
    assert_eq!(error.code(), codes::JOURNAL_CORRUPT);
}

#[test]
fn mark_dispatched_cannot_repeat() {
    let journal = MemoryJournal::new();
    let mut lifecycle = open(&journal);
    let permit = permit(lifecycle.begin("call-1", b"tap").unwrap());
    lifecycle.mark_dispatched(&permit).unwrap();
    assert_eq!(
        err_code(lifecycle.mark_dispatched(&permit)),
        codes::INVALID_TRANSITION
    );
    assert_eq!(lifecycle.phase("call-1"), Some(Phase::Dispatching));
}

#[test]
fn fingerprint_is_stable_and_distinguishes_requests() {
    let one = Fingerprint::of(b"tap 10 20");
    let two = Fingerprint::of(b"tap 10 21");
    assert_eq!(one, Fingerprint::of(b"tap 10 20"));
    assert_ne!(one, two);
    assert_eq!(one.as_str().len(), 64);
    assert!(one.as_str().bytes().all(|b| b.is_ascii_hexdigit()));
}

#[test]
fn settled_records_still_hold_capacity() {
    let journal = MemoryJournal::new();
    let mut lifecycle = open_with(&journal, Limits::new(1).unwrap());
    let first = dispatch_and_settle(&mut lifecycle, "call-1", b"1");
    assert_eq!(
        err_code(lifecycle.begin("call-2", b"2")),
        codes::CAPACITY_EXHAUSTED
    );
    assert_eq!(lifecycle.record_count(), 1);
    assert_eq!(lifecycle.phase("call-1"), Some(Phase::Settled));
    assert_eq!(replay(lifecycle.begin("call-1", b"1").unwrap()), first);
}

#[test]
fn oversized_journal_is_rejected_not_truncated() {
    let journal = MemoryJournal::new();
    let limits = Limits::default().with_journal_bytes(512).unwrap();
    let mut lifecycle = open_with(&journal, limits);
    let permit = permit(lifecycle.begin("call-1", b"tap").unwrap());
    lifecycle.mark_dispatched(&permit).unwrap();
    let outcome = Outcome::new("done", true).with_data(serde_json::json!({ "blob": "x".repeat(4096) }));
    let error = lifecycle
        .settle("call-1", permit.fingerprint(), outcome)
        .unwrap_err();
    assert_eq!(error.code(), codes::JOURNAL_TOO_LARGE);
    assert_eq!(lifecycle.phase("call-1"), Some(Phase::Dispatching));
}
