//! 进程内控制核心：JSON exchange、事实发布、计划与生命周期接线。
//!
//! Rust 持有 facts/revision/epoch/plan 与派发记录；Kotlin 只执行已经获准的
//! 平台调用。这里不启动监听、不注册工具、不接触 Android API、不执行副作用。

use std::collections::{BTreeMap, BTreeSet};
use std::panic::{catch_unwind, AssertUnwindSafe};

use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::journal::FileJournal;
use crate::lifecycle::{
    Admission, DispatchPermit, Executed, Journal, Lifecycle, LifecycleError, Outcome, Phase, Receipt,
};
use crate::policy::{
    A11yFacts, Backend, DispatchEvidence, DispatchFailure, DispatchPlan, DisplaySupport, OpSet,
    PlanTarget, PolicyError, PolicyState, RootFacts, Scope, ScreenFacts, ServerUid, ShizukuFacts,
    TargetDomain, TargetRequest, Tri,
};

/// exchange 协议版本。
pub const PROTOCOL_VERSION: u32 = 1;
/// 单次 exchange 的 UTF-8 载荷上限。
pub const MAX_REQUEST_BYTES: usize = 256 * 1024;

/// 为一次新的原生会话分配随机非零 epoch。
///
/// epoch 必须跨进程唯一，不能由时间、PID 或进程内计数推测。这里使用
/// getrandom 的系统随机源；全零或读取失败都拒绝，不启用回退值。
pub fn new_epoch() -> Result<u64, ControllerError> {
    new_epoch_from(os_entropy)
}

/// 读取 8 字节 OS 随机数。不支持的目标明确失败，不使用时间或 PID 回退。
#[cfg(unix)]
fn os_entropy(bytes: &mut [u8; 8]) -> Result<(), String> {
    use std::io::Read;
    use std::os::unix::fs::OpenOptionsExt;

    if cfg!(target_os = "linux") || cfg!(target_os = "android") {
        let mut filled = 0usize;
        while filled < bytes.len() {
            let result = unsafe {
                libc::syscall(
                    libc::SYS_getrandom,
                    bytes[filled..].as_mut_ptr(),
                    bytes.len() - filled,
                    0u32,
                )
            };
            if result > 0 {
                filled += result as usize;
                continue;
            }
            let error = std::io::Error::last_os_error();
            if error.kind() != std::io::ErrorKind::Interrupted {
                break;
            }
        }
        if filled == bytes.len() {
            return Ok(());
        }
    }

    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open("/dev/urandom")
        .map_err(|error| format!("/dev/urandom: {error}"))?;
    file.read_exact(bytes)
        .map_err(|error| format!("/dev/urandom read: {error}"))
}

#[cfg(windows)]
fn os_entropy(bytes: &mut [u8; 8]) -> Result<(), String> {
    #[link(name = "bcrypt")]
    extern "system" {
        fn BCryptGenRandom(
            algorithm: *mut std::ffi::c_void,
            buffer: *mut u8,
            length: u32,
            flags: u32,
        ) -> i32;
    }

    const BCRYPT_USE_SYSTEM_PREFERRED_RNG: u32 = 0x0000_0002;
    let status = unsafe {
        BCryptGenRandom(
            std::ptr::null_mut(),
            bytes.as_mut_ptr(),
            bytes.len() as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if status < 0 {
        Err(format!("BCryptGenRandom failed with NTSTATUS {status}"))
    } else {
        Ok(())
    }
}

#[cfg(not(any(unix, windows)))]
fn os_entropy(_bytes: &mut [u8; 8]) -> Result<(), String> {
    Err("this target has no approved OS entropy source".to_owned())
}

/// 可注入 entropy 的 epoch 构造入口。仅用于验证失败与零值拒绝。
#[doc(hidden)]
pub fn new_epoch_from<F>(mut entropy: F) -> Result<u64, ControllerError>
where
    F: FnMut(&mut [u8; 8]) -> Result<(), String>,
{
    let mut bytes = [0u8; 8];
    entropy(&mut bytes)
        .map_err(|error| ControllerError::new("entropy-unavailable", &format!("could not read OS entropy: {error}")))?;
    let epoch = u64::from_le_bytes(bytes);
    if epoch == 0 {
        return Err(ControllerError::new(
            "invalid-epoch",
            "OS entropy produced a zero epoch; refusing a reusable value",
        ));
    }
    Ok(epoch)
}

/// 控制器打开或调用失败的稳定错误。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ControllerError {
    code: &'static str,
    detail: String,
}

impl ControllerError {
    fn new(code: &'static str, detail: impl Into<String>) -> Self {
        Self { code, detail: detail.into() }
    }

    pub fn code(&self) -> &'static str {
        self.code
    }

    pub fn detail(&self) -> &str {
        &self.detail
    }
}

impl std::fmt::Display for ControllerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.detail)
    }
}

impl std::error::Error for ControllerError {}

struct SavedPlan {
    plan: DispatchPlan,
    permit: DispatchPermit,
}

/// 一个原生会话的控制器。所有方法都由外层 mutex 串行化。
pub struct Controller<J: Journal> {
    epoch: u64,
    policy: PolicyState,
    lifecycle: Lifecycle<J>,
    saved: BTreeMap<String, SavedPlan>,
    known_screens: BTreeSet<String>,
    poisoned: bool,
}

impl Controller<FileJournal> {
    /// 打开真实文件日志。目录由 Kotlin 的 app 私有 filesDir 指定。
    pub fn open_file(state_dir: impl AsRef<std::path::Path>, epoch: u64) -> Result<Self, ControllerError> {
        if epoch == 0 {
            return Err(ControllerError::new("invalid-epoch", "epoch must be positive"));
        }
        let journal = FileJournal::open(state_dir, crate::journal::DEFAULT_MAX_JOURNAL_BYTES)
            .map_err(|error| ControllerError::new("journal-open-failed", error.detail()))?;
        Self::with_journal(journal, epoch)
    }
}

impl<J: Journal> Controller<J> {
    /// 注入日志后端打开控制器，并从日志恢复生命周期状态。
    pub fn with_journal(journal: J, epoch: u64) -> Result<Self, ControllerError> {
        if epoch == 0 {
            return Err(ControllerError::new("invalid-epoch", "epoch must be positive"));
        }
        let lifecycle = Lifecycle::open(journal)
            .map_err(|error| ControllerError::new(error_code(&error), error.detail()))?;
        Ok(Self {
            epoch,
            policy: PolicyState::new(epoch),
            lifecycle,
            saved: BTreeMap::new(),
            known_screens: BTreeSet::new(),
            poisoned: false,
        })
    }

    pub fn epoch(&self) -> u64 {
        self.epoch
    }

    pub fn revision(&self) -> u64 {
        self.policy.revision()
    }

    /// 处理一个 JSON 请求。任何 panic 都会让本控制器停止服务。
    pub fn exchange(&mut self, payload: &str) -> String {
        self.exchange_with_mode(payload, false)
    }

    /// 处理一个不写日志的快请求：facts、capabilities 与 validateDispatch。
    /// 其它 kind 一律拒绝。调用方必须在 try_lock 内调用。
    pub fn exchange_nonblocking(&mut self, payload: &str) -> String {
        self.exchange_with_mode(payload, true)
    }

    fn exchange_with_mode(&mut self, payload: &str, nonblocking: bool) -> String {
        if self.poisoned {
            return error_json("core-poisoned", "controller stopped after an internal panic", None);
        }
        let result = catch_unwind(AssertUnwindSafe(|| self.exchange_inner(payload, nonblocking)));
        match result {
            Ok(response) => response,
            Err(_) => {
                self.poisoned = true;
                error_json("core-poisoned", "internal panic; controller is now unavailable", None)
            }
        }
    }

    fn exchange_inner(&mut self, payload: &str, nonblocking: bool) -> String {
        if payload.len() > MAX_REQUEST_BYTES {
            return error_json("request-too-large", "payload exceeds the byte limit", None);
        }
        let request: Value = match serde_json::from_str(payload) {
            Ok(value @ Value::Object(_)) => value,
            Ok(_) => return error_json("invalid-request", "request must be a JSON object", None),
            Err(error) => return error_json("invalid-json", error.to_string(), None),
        };
        let object = request.as_object().expect("object checked above");
        match request_version(object) {
            Ok(()) => {}
            Err(response) => return response,
        }
        let kind = match optional_string(object, "kind") {
            Ok(Some(kind)) if !kind.is_empty() => kind.to_owned(),
            Ok(_) => return error_json("invalid-request", "kind is required", None),
            Err(response) => return response,
        };

        if nonblocking && !matches!(kind.as_str(), "publishFacts" | "capabilities" | "validateDispatch") {
            return error_json(
                "blocking-operation-rejected",
                "exchangeNonblocking only accepts publishFacts, capabilities and validateDispatch",
                None,
            );
        }

        match kind.as_str() {
            "publishFacts" => self.handle_publish_facts(object),
            "capabilities" => self.handle_capabilities(object),
            "prepare" => self.handle_prepare(object),
            "commit" => self.handle_commit(object),
            "settle" => self.handle_settle(object),
            "cancel" => self.handle_cancel(object),
            "fallback" => self.handle_fallback(object),
            "operationStatus" => self.handle_operation_status(object),
            "validateDispatch" => self.handle_validate_dispatch(object),
            _ => error_json("unknown-kind", format!("unknown kind {kind}"), None),
        }
    }

    fn handle_publish_facts(&mut self, request: &Map<String, Value>) -> String {
        if let Err(response) = allowed(request, &["protocolVersion", "kind", "facts"]) {
            return response;
        }
        let Some(facts_value) = request.get("facts") else {
            return error_json("invalid-request", "facts is required", None);
        };
        let facts: Facts = match serde_json::from_value(facts_value.clone()) {
            Ok(facts) => facts,
            Err(error) => return error_json("invalid-facts", error.to_string(), None),
        };

        let mut policy = self.policy.clone();
        let mut known = BTreeSet::new();
        if let Some(scope) = &facts.scope {
            policy.set_scope(Scope::from_wire(Some(scope)));
        } else {
            policy.set_scope(Scope::VirtualOnly);
        }
        if let Some(observed_at_ms) = facts.observed_at_ms {
            policy.refresh_time(observed_at_ms);
        }

        for alias in self.known_screens.iter() {
            if !facts.screens.contains_key(alias) {
                policy.destroy_screen(alias);
            }
        }
        for (alias, screen) in &facts.screens {
            let screen_facts = ScreenFacts::new(
                screen.display_id,
                screen.width,
                screen.height,
                screen.rotation,
            );
            if let Err(error) = policy.observe_screen(alias, screen_facts) {
                return error_json(error.code(), error.detail(), None);
            }
            known.insert(alias.clone());
        }
        policy.set_a11y_facts(facts.a11y.map(A11yFactsWire::into_policy).unwrap_or_default());
        policy.set_shizuku_facts(facts.shizuku.map(ShizukuFactsWire::into_policy).unwrap_or_default());
        policy.set_root_facts(facts.root.map(RootFactsWire::into_policy).unwrap_or_default());
        self.policy = policy;
        self.known_screens = known;

        success_json("facts-published", &self.policy, None, None).to_string()
    }

    fn handle_capabilities(&self, request: &Map<String, Value>) -> String {
        if let Err(response) = allowed(request, &["protocolVersion", "kind"]) {
            return response;
        }
        let screens: Vec<Value> = self
            .known_screens
            .iter()
            .filter_map(|alias| self.policy.screen(alias))
            .map(screen_json)
            .collect();
        let mut response = success_json("capabilities", &self.policy, None, None);
        if let Some(object) = response.as_object_mut() {
            object.insert("screens".into(), Value::Array(screens));
            object.insert("protocolVersion".into(), json!(PROTOCOL_VERSION));
            object.insert("epoch".into(), json!(epoch_wire(self.epoch)));
            object.insert("revision".into(), json!(u64_wire(self.policy.revision())));
            object.insert("scope".into(), json!(self.policy.scope().wire()));
            object.insert(
                "channels".into(),
                json!({
                    "a11y": {
                        "enabled": tri_wire(self.policy.a11y().enabled),
                        "online": tri_wire(self.policy.a11y().online),
                        "supportedOps": op_set_wire(&self.policy.a11y().supported_ops),
                        "displaySupport": display_wire(&self.policy.a11y().display_support)
                    },
                    "shizuku": {
                        "installed": tri_wire(self.policy.shizuku().installed),
                        "running": tri_wire(self.policy.shizuku().running),
                        "granted": tri_wire(self.policy.shizuku().granted),
                        "bound": tri_wire(self.policy.shizuku().bound),
                        "functionalReady": tri_wire(self.policy.shizuku().functional_ready),
                        "serverUid": server_uid_wire(self.policy.shizuku().server_uid),
                        "supportedOps": op_set_wire(&self.policy.shizuku().supported_ops),
                        "displaySupport": display_wire(&self.policy.shizuku().display_support)
                    },
                    "root": {
                        "authorization": tri_wire(self.policy.root().authorization),
                        "consentValid": tri_wire(self.policy.root().consent_valid)
                    }
                }),
            );
            object.insert("lifecycleRecords".into(), json!(self.lifecycle.record_count()));
        }
        response.to_string()
    }

    fn handle_prepare(&mut self, request: &Map<String, Value>) -> String {
        if let Err(response) = allowed(
            request,
            &["protocolVersion", "kind", "callId", "operation", "screenId", "generation", "epoch", "args"],
        ) {
            return response;
        }
        let call_id = match required_string(request, "callId") {
            Ok(value) => value.to_owned(),
            Err(response) => return response,
        };
        let operation = match required_string(request, "operation") {
            Ok(value) => value.to_owned(),
            Err(response) => return response,
        };
        let screen_id = match optional_string(request, "screenId") {
            Ok(value) => value.map(str::to_owned),
            Err(response) => return response,
        };
        let generation = match optional_id(request, "generation") {
            Ok(value) => value,
            Err(response) => return response,
        };
        let epoch = match required_id(request, "epoch") {
            Ok(value) => value,
            Err(response) => return response,
        };
        let args = match optional_object(request, "args") {
            Ok(value) => value.cloned().unwrap_or_else(|| json!({})),
            Err(response) => return response,
        };
        if epoch != self.epoch {
            return error_json("epoch-mismatch", "request epoch does not match this native session", screen_id.as_deref());
        }
        if let Err(error) = validate_operation_args(&operation, &args) {
            return error_json(error.code(), error.detail(), screen_id.as_deref());
        }
        let target = match self.target_for(&operation, screen_id.as_deref()) {
            Ok(target) => target,
            Err(response) => return response,
        };
        let effective = match self.effective_request(&operation, &target, generation, &args) {
            Ok(effective) => effective,
            Err(response) => return response,
        };
        let target = effective.target;
        let generation = effective.generation;
        let args = effective.args;
        let canonical = json!({
            "protocolVersion": PROTOCOL_VERSION,
            "kind": "prepare",
            "operation": operation,
            "screenId": screen_alias(&operation, &target),
            "generation": generation,
            "epoch": epoch_wire(epoch),
            "args": args
        });
        let request_bytes = match serde_json::to_vec(&canonical) {
            Ok(bytes) => bytes,
            Err(error) => return error_json("invalid-request", error.to_string(), None),
        };

        if self.lifecycle.snapshot(&call_id).is_some() {
            return match self.lifecycle.begin(&call_id, &request_bytes) {
                Ok(Admission::Replay(receipt)) => replay_json(&call_id, &receipt),
                Ok(Admission::Dispatch(permit)) => {
                    // snapshot 存在却重新给许可只可能是并发/实现异常；保守拒绝。
                    let _ = permit;
                    error_json("invalid-state", "call already exists but is not replayable", None)
                }
                Err(error) => error_json(error_code(&error), error.detail(), screen_id.as_deref()),
            };
        }

        let plan = match self.policy.plan(&operation, target) {
            Ok(plan) => plan,
            Err(error) => return error_json(error.code(), error.detail(), screen_id.as_deref()),
        };
        if let Some(expected) = generation.as_ref().and_then(|value| value.parse::<u64>().ok()) {
            match plan.screen() {
                Some(binding) if binding.generation == expected => {}
                Some(_) => return error_json("generation-mismatch", "screen generation does not match", screen_id.as_deref()),
                None => return error_json("generation-mismatch", "this target has no screen generation", screen_id.as_deref()),
            }
        }
        if let Err(error) = validate_args(&self.policy, &plan, &args) {
            return error_json(error.code(), error.detail(), screen_id.as_deref());
        }

        match self.lifecycle.begin(&call_id, &request_bytes) {
            Ok(Admission::Dispatch(permit)) => {
                self.saved.insert(call_id.clone(), SavedPlan { plan: plan.clone(), permit });
                success_json("prepared", &self.policy, Some(&plan), None).to_string()
            }
            Ok(Admission::Replay(receipt)) => replay_json(&call_id, &receipt),
            Err(error) => error_json(error_code(&error), error.detail(), screen_id.as_deref()),
        }
    }

    fn handle_commit(&mut self, request: &Map<String, Value>) -> String {
        if let Err(response) = allowed(request, &["protocolVersion", "kind", "callId"]) {
            return response;
        }
        let call_id = match required_string(request, "callId") {
            Ok(value) => value.to_owned(),
            Err(response) => return response,
        };
        let Some(saved) = self.saved.get(&call_id) else {
            return error_json("call-not-found", "no prepared plan for this call", None);
        };
        let plan = saved.plan.clone();
        let permit = saved.permit.clone();
        if self.lifecycle.phase(&call_id) != Some(Phase::Prepared) {
            return error_json("invalid-state", "call is not in prepared state", plan.target.alias());
        }
        if let Err(error) = self.policy.revalidate(&plan) {
            return error_json(error.code(), error.detail(), plan.target.alias());
        }

        match self.lifecycle.mark_dispatched(&permit) {
            Ok(()) => {
                let mut response = success_json("dispatched", &self.policy, Some(&plan), None);
                if let Some(object) = response.as_object_mut() {
                    object.insert("dispatch".into(), json!("permitted"));
                    object.insert("callId".into(), json!(call_id));
                }
                response.to_string()
            }
            Err(error) => {
                self.saved.remove(&call_id);
                error_json(error_code(&error), error.detail(), plan.target.alias())
            }
        }
    }

    fn handle_settle(&mut self, request: &Map<String, Value>) -> String {
        if let Err(response) = allowed(request, &["protocolVersion", "kind", "callId", "receipt"]) {
            return response;
        }
        let call_id = match required_string(request, "callId") {
            Ok(value) => value.to_owned(),
            Err(response) => return response,
        };
        let Some(receipt_value) = request.get("receipt") else {
            return error_json("invalid-request", "receipt is required", None);
        };
        let receipt: Receipt = match serde_json::from_value(receipt_value.clone()) {
            Ok(receipt) => receipt,
            Err(error) => return error_json("invalid-receipt", error.to_string(), None),
        };

        let Some(saved) = self.saved.get(&call_id) else {
            if let Some(existing) = self.lifecycle.receipt(&call_id) {
                return replay_json(&call_id, &existing);
            }
            return error_json("call-not-found", "no tracked call for this id", receipt.screen_id());
        };
        let permit = saved.permit.clone();
        if self.lifecycle.phase(&call_id) != Some(Phase::Dispatching) {
            return error_json("invalid-state", "call has no successful dispatch evidence", receipt.screen_id());
        }

        let result = if receipt.executed() == Executed::Unknown {
            self.lifecycle.mark_unknown(&call_id, &permit.fingerprint().clone(), receipt.code())
        } else {
            let mut outcome = if receipt.executed() == Executed::Yes {
                Outcome::new(receipt.code(), receipt.ok())
            } else {
                Outcome::not_executed(receipt.code())
            };
            if let Some(screen_id) = receipt.screen_id() {
                outcome = outcome.with_screen_id(screen_id);
            }
            if let Some(diagnostic) = receipt.diagnostic() {
                outcome = outcome.with_diagnostic(diagnostic);
            }
            if let Some(data) = receipt.data() {
                outcome = outcome.with_data(data.clone());
            }
            self.lifecycle
                .settle(&call_id, &permit.fingerprint().clone(), outcome)
        };

        match result {
            Ok(receipt) => {
                self.remove_if_terminal(&call_id);
                receipt_json(&call_id, &receipt)
            }
            Err(error) => {
                self.remove_if_terminal(&call_id);
                error_json(error_code(&error), error.detail(), receipt.screen_id())
            }
        }
    }

    fn handle_cancel(&mut self, request: &Map<String, Value>) -> String {
        if let Err(response) = allowed(request, &["protocolVersion", "kind", "callId"]) {
            return response;
        }
        let call_id = match required_string(request, "callId") {
            Ok(value) => value.to_owned(),
            Err(response) => return response,
        };
        let Some(phase) = self.lifecycle.phase(&call_id) else {
            return error_json("call-not-found", "no tracked call for this id", None);
        };
        let screen_id = self
            .saved
            .get(&call_id)
            .and_then(|saved| saved.plan.target.alias())
            .map(str::to_owned)
            .or_else(|| self.lifecycle.receipt(&call_id).and_then(|receipt| receipt.screen_id().map(str::to_owned)));

        match phase {
            Phase::Prepared => {
                let Some(saved) = self.saved.get(&call_id) else {
                    return error_json("call-not-found", "no prepared plan for this call", screen_id.as_deref());
                };
                let receipt = match self.lifecycle.withdraw(&call_id, &saved.permit.fingerprint().clone()) {
                    Ok(receipt) => receipt,
                    Err(error) => {
                        return error_json(error_code(&error), error.detail(), screen_id.as_deref())
                    }
                };
                self.saved.remove(&call_id);
                receipt_json(&call_id, &receipt)
            }
            Phase::Dispatching => {
                let Some(saved) = self.saved.get(&call_id) else {
                    return error_json("call-not-found", "no dispatch permit for this call", screen_id.as_deref());
                };
                let receipt = match self.lifecycle.mark_unknown(
                    &call_id,
                    &saved.permit.fingerprint().clone(),
                    "cancel-after-dispatch",
                ) {
                    Ok(receipt) => receipt,
                    Err(error) => {
                        return error_json(error_code(&error), error.detail(), screen_id.as_deref())
                    }
                };
                self.saved.remove(&call_id);
                receipt_json(&call_id, &receipt)
            }
            Phase::Settled | Phase::Cancelled | Phase::Unknown => self
                .lifecycle
                .receipt(&call_id)
                .map(|receipt| replay_json(&call_id, &receipt))
                .unwrap_or_else(|| {
                    error_json("invalid-state", "terminal call has no saved receipt", screen_id.as_deref())
                }),
        }
    }

    fn handle_operation_status(&self, request: &Map<String, Value>) -> String {
        if let Err(response) = allowed(request, &["protocolVersion", "kind", "callId"]) {
            return response;
        }
        let call_id = match required_string(request, "callId") {
            Ok(value) => value.to_owned(),
            Err(response) => return response,
        };
        let phase = self.lifecycle.phase(&call_id);
        let receipt = self.lifecycle.receipt(&call_id);
        let saved = self.saved.get(&call_id);
        let screen_id = receipt
            .as_ref()
            .and_then(Receipt::screen_id)
            .or_else(|| saved.and_then(|saved| saved.plan.target.alias()));
        let (executed, ok) = match phase {
            Some(Phase::Prepared) => ("no", true),
            Some(Phase::Dispatching) => ("unknown", false),
            Some(Phase::Settled) | Some(Phase::Cancelled) | Some(Phase::Unknown) => receipt
                .as_ref()
                .map(|receipt| {
                    (
                        match receipt.executed() {
                            Executed::Yes => "yes",
                            Executed::No => "no",
                            Executed::Unknown => "unknown",
                        },
                        receipt.ok(),
                    )
                })
                .unwrap_or(("unknown", false)),
            None => ("unknown", false),
        };
        let code = receipt
            .as_ref()
            .map(|receipt| receipt.code().to_owned())
            .unwrap_or_else(|| {
                if phase.is_some() {
                    "operation-in-progress".to_owned()
                } else {
                    "call-not-found".to_owned()
                }
            });
        let mut value = json!({
            "protocolVersion": PROTOCOL_VERSION,
            "ok": phase.is_some(),
            "code": code,
            "executed": executed,
            "screenId": screen_id,
            "callId": call_id,
            "phase": phase_wire(phase),
            "terminal": matches!(phase, Some(Phase::Settled) | Some(Phase::Cancelled) | Some(Phase::Unknown))
        });
        if let Some(plan) = saved {
            if let Some(object) = value.as_object_mut() {
                object.insert("plan".into(), plan_json(&plan.plan, &self.policy));
            }
        }
        if let Some(receipt) = receipt {
            if let Some(object) = value.as_object_mut() {
                object.insert("receipt".into(), serde_json::to_value(receipt).unwrap_or(Value::Null));
            }
        }
        if !ok {
            if let Some(object) = value.as_object_mut() {
                object.insert("ok".into(), json!(false));
            }
        }
        value.to_string()
    }

    fn handle_validate_dispatch(&mut self, request: &Map<String, Value>) -> String {
        if let Err(response) = allowed(request, &["protocolVersion", "kind", "callId"]) {
            return response;
        }
        let call_id = match required_string(request, "callId") {
            Ok(value) => value.to_owned(),
            Err(response) => return response,
        };
        let phase = self.lifecycle.phase(&call_id);
        let can_settle_unexecuted = phase == Some(Phase::Dispatching);
        let Some(saved) = self.saved.get(&call_id) else {
            return json!({
                "protocolVersion": PROTOCOL_VERSION,
                "ok": false,
                "callId": call_id,
                "phase": phase_wire(phase),
                "valid": false,
                "dispatch": "forbidden",
                "executed": "no",
                "code": "call-not-found",
                "settleHint": if can_settle_unexecuted {
                    json!({"ok": false, "code": "dispatch-validation-failed", "executed": "no"})
                } else {
                    Value::Null
                }
            })
            .to_string();
        };
        let plan = saved.plan.clone();
        let mut valid = phase == Some(Phase::Dispatching);
        let mut code = if valid {
            "dispatch-validated"
        } else {
            "invalid-state"
        };
        if valid {
            if let Err(error) = self.policy.revalidate(&plan) {
                valid = false;
                code = error.code();
            }
        }
        let mut value = json!({
            "protocolVersion": PROTOCOL_VERSION,
            "ok": false,
            "code": code,
            "executed": "no",
            "screenId": plan.target.alias(),
            "callId": call_id,
            "phase": phase_wire(phase),
            "valid": valid,
            "dispatch": if valid { "permitted" } else { "forbidden" },
            "settleHint": if valid || !can_settle_unexecuted {
                Value::Null
            } else {
                json!({
                    "ok": false,
                    "code": if code == "invalid-state" { "dispatch-validation-failed" } else { code },
                    "executed": "no",
                    "screenId": plan.target.alias()
                })
            }
        });
        if let Some(object) = value.as_object_mut() {
            object.insert("plan".into(), plan_json(&plan, &self.policy));
        }
        value.to_string()
    }

    fn handle_fallback(&mut self, request: &Map<String, Value>) -> String {
        if let Err(response) = allowed(request, &["protocolVersion", "kind", "callId", "reason"]) {
            return response;
        }
        let call_id = match required_string(request, "callId") {
            Ok(value) => value.to_owned(),
            Err(response) => return response,
        };
        let reason = match required_string(request, "reason") {
            Ok(value) => value,
            Err(response) => return response,
        };
        let failure = match parse_failure(reason) {
            Ok(failure) => failure,
            Err(response) => return response,
        };
        let Some(saved) = self.saved.get(&call_id) else {
            return error_json("call-not-found", "no prepared plan for this call", None);
        };
        if self.lifecycle.phase(&call_id) != Some(Phase::Prepared) {
            return error_json(
                "fallback-not-allowed",
                "fallback is only allowed before dispatch",
                saved.plan.target.alias(),
            );
        }
        let plan = saved.plan.clone();
        let fallback = match self.policy.fallback_plan(&plan, DispatchEvidence::No, failure) {
            Ok(plan) => plan,
            Err(error) => return error_json(error.code(), error.detail(), plan.target.alias()),
        };
        if fallback.target != plan.target {
            return error_json("fallback-target-changed", "fallback must keep the same target", plan.target.alias());
        }
        self.saved.get_mut(&call_id).expect("saved plan exists").plan = fallback.clone();
        let mut response = success_json("fallback-prepared", &self.policy, Some(&fallback), None);
        if let Some(object) = response.as_object_mut() {
            object.insert("callId".into(), json!(call_id));
        }
        response.to_string()
    }

    fn target_for(&self, operation: &str, screen_id: Option<&str>) -> Result<TargetRequest, String> {
        let spec = crate::policy::OperationSpec::for_name(operation).ok_or_else(|| {
            error_json("operation-unknown", format!("operation {operation} is not registered"), screen_id)
        })?;
        match spec.target_domain {
            TargetDomain::AndroidDisplay => match screen_id {
                Some("real") => Ok(TargetRequest::Real),
                Some(alias) if crate::policy::is_virtual_alias(alias) => {
                    Ok(TargetRequest::Virtual(alias.to_owned()))
                }
                Some(alias) => Err(error_json("unknown-target", format!("unknown screen {alias}"), screen_id)),
                None => Ok(TargetRequest::Real),
            },
            TargetDomain::VirtualDisplay => {
                let alias = screen_id.ok_or_else(|| {
                    error_json("invalid-request", "virtual-display operations require screenId", None)
                })?;
                if !crate::policy::is_virtual_alias(alias) {
                    return Err(error_json("unknown-target", format!("unknown virtual screen {alias}"), screen_id));
                }
                match spec.name {
                    "vdCreate" | "vdInfo" => Ok(TargetRequest::NewVirtual(alias.to_owned())),
                    _ => Ok(TargetRequest::Virtual(alias.to_owned())),
                }
            }
            TargetDomain::BrowserWorkspace => require_absent_screen(screen_id, TargetRequest::BrowserWorkspace),
            TargetDomain::AppWebView => require_absent_screen(screen_id, TargetRequest::AppWebView),
            TargetDomain::ControlMemory => require_absent_screen(screen_id, TargetRequest::ControlMemory),
            TargetDomain::PrivilegedShell => require_absent_screen(screen_id, TargetRequest::PrivilegedShell),
        }
    }

    fn effective_request(
        &self,
        operation: &str,
        target: &TargetRequest,
        requested_generation: Option<u64>,
        args: &Value,
    ) -> Result<EffectiveRequest, String> {
        let (target, effective_generation) = match target {
            TargetRequest::Real => (
                TargetRequest::Real,
                Some(
                    self.policy
                        .screen(crate::policy::REAL_ALIAS)
                        .ok_or_else(|| {
                            error_json("unknown-target", "real screen is not registered", Some(crate::policy::REAL_ALIAS))
                        })?
                        .generation,
                ),
            ),
            TargetRequest::Virtual(alias) => {
                let binding = self.policy.screen(alias).ok_or_else(|| {
                    error_json("unknown-target", format!("screen {alias} is not registered"), Some(alias))
                })?;
                (TargetRequest::Virtual(alias.clone()), Some(binding.generation))
            }
            TargetRequest::NewVirtual(alias) => (TargetRequest::NewVirtual(alias.clone()), None),
            other => (other.clone(), None),
        };
        if let (Some(explicit), Some(effective)) = (requested_generation, effective_generation) {
            if explicit != effective {
                return Err(error_json(
                    "generation-mismatch",
                    "screen generation does not match",
                    screen_alias(operation, &target),
                ));
            }
        }
        Ok(EffectiveRequest {
            target,
            generation: effective_generation.map(u64_wire),
            args: canonical_args(operation, args),
        })
    }

    fn remove_if_terminal(&mut self, call_id: &str) {
        if matches!(
            self.lifecycle.phase(call_id),
            Some(Phase::Settled) | Some(Phase::Unknown) | Some(Phase::Cancelled) | None
        ) {
            self.saved.remove(call_id);
        }
    }
}

fn require_absent_screen(screen_id: Option<&str>, target: TargetRequest) -> Result<TargetRequest, String> {
    if screen_id.is_some() {
        Err(error_json(
            "target-domain-mismatch",
            "this operation targets a workspace, not an Android display",
            screen_id,
        ))
    } else {
        Ok(target)
    }
}

struct EffectiveRequest {
    target: TargetRequest,
    generation: Option<String>,
    args: Value,
}

fn screen_alias<'a>(operation: &str, target: &'a TargetRequest) -> Option<&'a str> {
    match target {
        TargetRequest::Real => Some(crate::policy::REAL_ALIAS),
        TargetRequest::Virtual(alias) | TargetRequest::NewVirtual(alias) => Some(alias),
        _ => {
            let _ = operation;
            None
        }
    }
}

fn validate_operation_args(operation: &str, args: &Value) -> Result<(), ControllerError> {
    if matches!(operation, "click" | "longClick") {
        let object = args.as_object().ok_or_else(|| {
            ControllerError::new("invalid-request", "args must be an object")
        })?;
        if object.len() != 2 || !object.contains_key("x") || !object.contains_key("y") {
            return Err(ControllerError::new(
                "invalid-coordinate",
                "click and longClick accept only x and y, both required",
            ));
        }
        coordinate(object, "x")?;
        coordinate(object, "y")?;
        return Ok(());
    }
    allowed_fields(args, &["x", "y", "x1", "y1", "x2", "y2"])
        .map_err(|response| ControllerError::new("invalid-request", response))
}

fn canonical_args(operation: &str, args: &Value) -> Value {
    if matches!(operation, "click" | "longClick") {
        let object = args.as_object().expect("click args checked before canonicalization");
        return json!({"x": object["x"], "y": object["y"]});
    }
    args.clone()
}

fn request_version(object: &Map<String, Value>) -> Result<(), String> {
    let Some(value) = object.get("protocolVersion") else {
        return Err(error_json("invalid-request", "protocolVersion is required", None));
    };
    let Some(version) = value.as_u64() else {
        return Err(error_json("invalid-request", "protocolVersion must be an integer", None));
    };
    if version != u64::from(PROTOCOL_VERSION) {
        return Err(error_json(
            "unsupported-version",
            format!("protocol version {version} is not supported"),
            None,
        ));
    }
    Ok(())
}

fn allowed(request: &Map<String, Value>, keys: &[&str]) -> Result<(), String> {
    for key in request.keys() {
        if !keys.contains(&key.as_str()) {
            return Err(error_json("unknown-field", format!("unknown field {key}"), None));
        }
    }
    Ok(())
}

fn allowed_fields(value: &Value, keys: &[&str]) -> Result<(), String> {
    let Some(object) = value.as_object() else {
        return Err(error_json("invalid-request", "args must be an object", None));
    };
    allowed(object, keys)
}

fn required_string<'a>(request: &'a Map<String, Value>, key: &str) -> Result<&'a str, String> {
    match request.get(key) {
        Some(Value::String(value)) if !value.is_empty() => Ok(value),
        Some(_) => Err(error_json("invalid-request", format!("{key} must be a non-empty string"), None)),
        None => Err(error_json("invalid-request", format!("{key} is required"), None)),
    }
}

fn optional_string<'a>(request: &'a Map<String, Value>, key: &str) -> Result<Option<&'a str>, String> {
    match request.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value)),
        Some(_) => Err(error_json("invalid-request", format!("{key} must be a string"), None)),
    }
}

fn optional_id(request: &Map<String, Value>, key: &str) -> Result<Option<u64>, String> {
    match request.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => parse_id_string(value)
            .map(Some)
            .ok_or_else(|| error_json("invalid-request", format!("{key} must be a decimal or 0x-prefixed hex string"), None)),
        Some(_) => Err(error_json("invalid-request", format!("{key} must be a decimal or hex string"), None)),
    }
}

fn required_id(request: &Map<String, Value>, key: &str) -> Result<u64, String> {
    optional_id(request, key)?.ok_or_else(|| error_json("invalid-request", format!("{key} is required"), None))
}

fn parse_id_string(value: &str) -> Option<u64> {
    if let Some(hex) = value.strip_prefix("0x").or_else(|| value.strip_prefix("0X")) {
        if hex.is_empty() || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return None;
        }
        u64::from_str_radix(hex, 16).ok()
    } else {
        if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        value.parse::<u64>().ok()
    }
}

fn epoch_wire(epoch: u64) -> String {
    epoch.to_string()
}

fn u64_wire(value: u64) -> String {
    value.to_string()
}

fn optional_object<'a>(request: &'a Map<String, Value>, key: &str) -> Result<Option<&'a Value>, String> {
    match request.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value @ Value::Object(_)) => Ok(Some(value)),
        Some(_) => Err(error_json("invalid-request", format!("{key} must be an object"), None)),
    }
}

fn validate_args(policy: &PolicyState, plan: &DispatchPlan, args: &Value) -> Result<(), ControllerError> {
    let object = args.as_object().expect("args object checked by caller");
    let point = ["x", "y"].iter().all(|key| object.contains_key(*key));
    let any_point = ["x", "y"].iter().any(|key| object.contains_key(*key));
    if any_point && !point {
        return Err(ControllerError::new("invalid-coordinate", "x and y must be provided together"));
    }
    if point {
        let x = coordinate(object, "x")?;
        let y = coordinate(object, "y")?;
        policy.validate_point(plan, x, y).map_err(policy_error)?;
    }
    let region = ["x1", "y1", "x2", "y2"].iter().all(|key| object.contains_key(*key));
    let any_region = ["x1", "y1", "x2", "y2"].iter().any(|key| object.contains_key(*key));
    if any_region && !region {
        return Err(ControllerError::new("invalid-region", "x1,y1,x2,y2 must be provided together"));
    }
    if region {
        policy.validate_region(
            plan,
            coordinate(object, "x1")?,
            coordinate(object, "y1")?,
            coordinate(object, "x2")?,
            coordinate(object, "y2")?,
        )
        .map_err(policy_error)?;
    }
    Ok(())
}

fn coordinate(object: &Map<String, Value>, key: &str) -> Result<i32, ControllerError> {
    let value = object.get(key).and_then(Value::as_i64).ok_or_else(|| {
        ControllerError::new("invalid-coordinate", format!("{key} must be an integer"))
    })?;
    i32::try_from(value)
        .map_err(|_| ControllerError::new("invalid-coordinate", format!("{key} is out of range")))
}

fn policy_error(error: PolicyError) -> ControllerError {
    ControllerError::new(error.code(), error.detail())
}

fn parse_failure(reason: &str) -> Result<DispatchFailure, String> {
    match reason {
        "service-offline" => Ok(DispatchFailure::ServiceOffline),
        "permission-missing" => Ok(DispatchFailure::PermissionMissing),
        "op-unsupported" => Ok(DispatchFailure::OpUnsupported),
        "target-unsupported" => Ok(DispatchFailure::TargetUnsupported),
        "node-not-found" => Ok(DispatchFailure::NodeNotFound),
        "timeout" => Ok(DispatchFailure::Timeout),
        "unknown" => Ok(DispatchFailure::Unknown),
        "error" => Ok(DispatchFailure::Error),
        _ => Err(error_json("invalid-request", format!("unknown fallback reason {reason}"), None)),
    }
}

fn success_json(code: &str, policy: &PolicyState, plan: Option<&DispatchPlan>, screen_id: Option<&str>) -> Value {
    let mut value = json!({
        "protocolVersion": PROTOCOL_VERSION,
        "ok": true,
        "code": code,
        "executed": "no",
        "screenId": plan.and_then(|plan| plan.target.alias()).or(screen_id)
    });
    if let Some(plan) = plan {
        if let Some(object) = value.as_object_mut() {
            object.insert("plan".into(), plan_json(plan, policy));
        }
    }
    value
}

fn plan_json(plan: &DispatchPlan, policy: &PolicyState) -> Value {
    let mut value = json!({
        "operation": plan.op,
        "epoch": epoch_wire(plan.epoch),
        "revision": u64_wire(policy.revision()),
        "backend": backend_wire(plan.backend),
        "target": target_kind(&plan.target),
        "screenId": plan.target.alias(),
        "scopeGeneration": plan.scope_generation.map(u64_wire),
        "authorizationGeneration": plan.authorization_generation.map(u64_wire)
    });
    if let Some(binding) = plan.screen() {
        if let Some(object) = value.as_object_mut() {
            object.insert("displayId".into(), json!(binding.display_id));
            object.insert("width".into(), json!(binding.width));
            object.insert("height".into(), json!(binding.height));
            object.insert("rotation".into(), json!(binding.rotation));
            object.insert("generation".into(), json!(u64_wire(binding.generation)));
        }
    }
    value
}

fn screen_json(binding: &crate::policy::ScreenBinding) -> Value {
    json!({
        "screenId": binding.alias,
        "displayId": binding.display_id,
        "width": binding.width,
        "height": binding.height,
        "rotation": binding.rotation,
        "generation": u64_wire(binding.generation)
    })
}

fn target_kind(target: &PlanTarget) -> &'static str {
    match target {
        PlanTarget::AndroidScreen(_) => "androidScreen",
        PlanTarget::VirtualCreation { .. } => "virtualCreation",
        PlanTarget::BrowserWorkspace => "browserWorkspace",
        PlanTarget::AppWebView => "appWebView",
        PlanTarget::ControlMemory => "controlMemory",
        PlanTarget::PrivilegedShell => "privilegedShell",
    }
}

fn backend_wire(backend: Backend) -> &'static str {
    match backend {
        Backend::A11y => "a11y",
        Backend::Shizuku => "shizuku",
        Backend::Root => "root",
        Backend::BrowserHost => "browserHost",
        Backend::WebViewHost => "webViewHost",
        Backend::Local => "local",
    }
}

fn receipt_json(call_id: &str, receipt: &Receipt) -> String {
    let mut value = serde_json::to_value(receipt).unwrap_or_else(|_| {
        json!({"ok": false, "code": "invalid-receipt", "executed": "unknown"})
    });
    if let Some(object) = value.as_object_mut() {
        object.insert("protocolVersion".into(), json!(PROTOCOL_VERSION));
        object.insert("callId".into(), json!(call_id));
    }
    value.to_string()
}

fn replay_json(call_id: &str, receipt: &Receipt) -> String {
    let mut value: Value = serde_json::from_str(&receipt_json(call_id, receipt)).unwrap_or_else(|_| json!({}));
    if let Some(object) = value.as_object_mut() {
        object.insert("replayed".into(), json!(true));
    }
    value.to_string()
}

fn error_json(code: &str, detail: impl AsRef<str>, screen_id: Option<&str>) -> String {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "ok": false,
        "code": code,
        "executed": "unknown",
        "screenId": screen_id,
        "detail": detail.as_ref()
    })
    .to_string()
}

fn error_code(error: &LifecycleError) -> &'static str {
    match error.code() {
        "journal-load-failed" => "journal-load-failed",
        "journal-write-failed" => "journal-write-failed",
        "journal-corrupt" => "journal-corrupt",
        "journal-too-large" => "journal-too-large",
        "invalid-call-id" => "invalid-call-id",
        "call-id-conflict" => "call-id-conflict",
        "call-in-progress" => "call-in-progress",
        "request-in-progress" => "call-in-progress",
        "request-unknown" | "operation-unknown" => "operation-unknown",
        "invalid-transition" => "invalid-state",
        "call-not-found" => "call-not-found",
        "capacity-exhausted" => "capacity-exhausted",
        "withdraw-not-allowed" => "withdraw-not-allowed",
        "invalid-receipt" => "invalid-receipt",
        "invalid-limits" => "invalid-limits",
        _ => "invalid-state",
    }
}

fn tri_wire(value: Tri) -> &'static str {
    match value {
        Tri::Unknown => "unknown",
        Tri::Yes => "yes",
        Tri::No => "no",
    }
}

fn phase_wire(phase: Option<Phase>) -> &'static str {
    match phase {
        Some(Phase::Prepared) => "prepared",
        Some(Phase::Dispatching) => "dispatching",
        Some(Phase::Settled) => "settled",
        Some(Phase::Unknown) => "unknown",
        Some(Phase::Cancelled) => "cancelled",
        None => "missing",
    }
}

fn op_set_wire(value: &OpSet) -> Value {
    match value {
        OpSet::Unknown => json!({"state": "unknown"}),
        OpSet::Known(ops) => json!({"state": "known", "ops": ops}),
    }
}

fn display_wire(value: &DisplaySupport) -> Value {
    match value {
        DisplaySupport::Unknown => json!({"state": "unknown"}),
        DisplaySupport::Known(values) => {
            let map: BTreeMap<String, bool> = values
                .iter()
                .map(|(display, supported)| (display.to_string(), *supported))
                .collect();
            json!({"state": "known", "values": map})
        }
    }
}

fn server_uid_wire(value: ServerUid) -> Value {
    match value {
        ServerUid::Unknown => json!({"kind": "unknown"}),
        ServerUid::Shell2000 => json!({"kind": "shell2000"}),
        ServerUid::Root0 => json!({"kind": "root0"}),
        ServerUid::Other(uid) => json!({"kind": "other", "uid": uid}),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Facts {
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    observed_at_ms: Option<u64>,
    screens: BTreeMap<String, ScreenFactsWire>,
    #[serde(default)]
    a11y: Option<A11yFactsWire>,
    #[serde(default)]
    shizuku: Option<ShizukuFactsWire>,
    #[serde(default)]
    root: Option<RootFactsWire>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ScreenFactsWire {
    display_id: i32,
    width: u32,
    height: u32,
    rotation: u8,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct A11yFactsWire {
    #[serde(default)]
    enabled: Tri,
    #[serde(default)]
    online: Tri,
    #[serde(default)]
    supported_ops: OpSetWire,
    #[serde(default)]
    display_support: DisplaySupportWire,
}

impl A11yFactsWire {
    fn into_policy(self) -> A11yFacts {
        A11yFacts {
            enabled: self.enabled,
            online: self.online,
            supported_ops: self.supported_ops.into_policy(),
            display_support: self.display_support.into_policy(),
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ShizukuFactsWire {
    #[serde(default)]
    installed: Tri,
    #[serde(default)]
    running: Tri,
    #[serde(default)]
    granted: Tri,
    #[serde(default)]
    bound: Tri,
    #[serde(default)]
    functional_ready: Tri,
    #[serde(default)]
    server_uid: ServerUidWire,
    #[serde(default)]
    supported_ops: OpSetWire,
    #[serde(default)]
    display_support: DisplaySupportWire,
}

impl ShizukuFactsWire {
    fn into_policy(self) -> ShizukuFacts {
        ShizukuFacts {
            installed: self.installed,
            running: self.running,
            granted: self.granted,
            bound: self.bound,
            functional_ready: self.functional_ready,
            server_uid: self.server_uid.into_policy(),
            supported_ops: self.supported_ops.into_policy(),
            display_support: self.display_support.into_policy(),
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RootFactsWire {
    #[serde(default)]
    authorization: Tri,
    #[serde(default)]
    consent_valid: Tri,
}

impl RootFactsWire {
    fn into_policy(self) -> RootFacts {
        RootFacts { authorization: self.authorization, consent_valid: self.consent_valid }
    }
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields, rename_all = "camelCase", tag = "state")]
enum OpSetWire {
    #[default]
    Unknown,
    Known { ops: BTreeSet<String> },
}

impl OpSetWire {
    fn into_policy(self) -> OpSet {
        match self {
            Self::Unknown => OpSet::Unknown,
            Self::Known { ops } => OpSet::Known(ops),
        }
    }
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields, rename_all = "camelCase", tag = "state")]
enum DisplaySupportWire {
    #[default]
    Unknown,
    Known { values: BTreeMap<String, bool> },
}

impl DisplaySupportWire {
    fn into_policy(self) -> DisplaySupport {
        match self {
            Self::Unknown => DisplaySupport::Unknown,
            Self::Known { values } => {
                let mut parsed = BTreeMap::new();
                for (key, supported) in values {
                    if let Ok(display) = key.parse::<i32>() {
                        parsed.insert(display, supported);
                    }
                }
                DisplaySupport::Known(parsed)
            }
        }
    }
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields, rename_all = "camelCase", tag = "kind")]
enum ServerUidWire {
    #[default]
    Unknown,
    Shell2000,
    Root0,
    Other { uid: i32 },
}

impl ServerUidWire {
    fn into_policy(self) -> ServerUid {
        match self {
            Self::Unknown => ServerUid::Unknown,
            Self::Shell2000 => ServerUid::Shell2000,
            Self::Root0 => ServerUid::Root0,
            Self::Other { uid } => ServerUid::Other(uid),
        }
    }
}

impl<J: Journal> Controller<J> {
    /// 只读快照，便于外部诊断；不暴露文件路径。
    pub fn capabilities_value(&self) -> Value {
        serde_json::from_str(&self.handle_capabilities(&Map::new())).unwrap_or_else(|_| json!({}))
    }
}
