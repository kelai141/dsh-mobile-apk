//! 进程内控制核心：JSON exchange、事实发布、计划与生命周期接线。
//!
//! Rust 持有 facts/revision/epoch/plan 与派发记录；Kotlin 只执行已经获准的
//! 平台调用。这里不启动监听、不注册工具、不接触 Android API、不执行副作用。

use std::collections::{BTreeMap, BTreeSet, VecDeque};
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
    args: Value,
    node: Option<crate::ui_tree::ActionTarget>,
    node_verified: bool,
    dispatch_validated: bool,
}

struct TreeDelivery {
    plan: DispatchPlan,
    call_id: String,
    metadata: Value,
}

/// 一个原生会话的控制器。所有方法都由外层 mutex 串行化。
pub struct Controller<J: Journal> {
    epoch: u64,
    policy: PolicyState,
    lifecycle: Lifecycle<J>,
    saved: BTreeMap<String, SavedPlan>,
    known_screens: BTreeSet<String>,
    poisoned: bool,
    images: crate::vision_runtime::ImageCache,
    trees: crate::ui_tree::UiTreeStore,
    tree_deliveries: BTreeMap<String, TreeDelivery>,
    audit: VecDeque<Value>,
    exchanges: u64,
    elapsed_us: u64,
    device: Value,
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
            images: crate::vision_runtime::ImageCache::default(),
            trees: crate::ui_tree::UiTreeStore::new(epoch),
            tree_deliveries: BTreeMap::new(),
            audit: VecDeque::new(),
            exchanges: 0,
            elapsed_us: 0,
            device: Value::Null,
        })
    }

    pub fn epoch(&self) -> u64 {
        self.epoch
    }

    pub fn revision(&self) -> u64 {
        self.policy.revision()
    }

    fn resolve_node(&self, plan: &DispatchPlan, reference: &str) -> Result<crate::ui_tree::ActionTarget, ControllerError> {
        if !matches!(plan.backend, Backend::A11y | Backend::Shizuku) {
            return Err(ControllerError::new("node-backend-unavailable", "this channel cannot verify the node reference"));
        }
        let screen = plan.screen().ok_or_else(|| ControllerError::new("screen-required", "node requires a display"))?;
        let delivery = self.tree_deliveries.get(&screen.alias)
            .ok_or_else(|| ControllerError::new("tree-result-expired", "a current snapshot is required"))?;
        self.policy.revalidate(&delivery.plan).map_err(policy_error)?;
        if self.lifecycle.phase(&delivery.call_id) != Some(Phase::Settled)
            || !self.lifecycle.receipt(&delivery.call_id).is_some_and(|receipt| receipt.ok()) {
            return Err(ControllerError::new("tree-not-settled", "a successful snapshot receipt is required"));
        }
        self.trees.action_target_for_binding(self.epoch, screen, reference)
            .map_err(|error| ControllerError::new(error.code(), error.detail()))
    }

    fn revalidate_node(&self, saved: &SavedPlan) -> Result<(), ControllerError> {
        if let Some(node) = &saved.node {
            let current = self.resolve_node(&saved.plan, node.ref_id())?;
            if &current != node {
                return Err(ControllerError::new("node-target-changed", "current snapshot no longer matches the node plan"));
            }
        }
        Ok(())
    }

    fn handle_verify_node(&mut self, request: &Map<String, Value>) -> String {
        if let Err(response) = allowed(request, &["protocolVersion", "kind", "callId", "node"]) { return response; }
        let call_id = match required_string(request, "callId") { Ok(id) => id, Err(response) => return response };
        if let Some(saved) = self.saved.get_mut(call_id) { saved.node_verified = false; }
        let result = (|| -> Result<(), ControllerError> {
            let saved = self.saved.get(call_id).filter(|_| self.lifecycle.phase(call_id) == Some(Phase::Dispatching))
                .ok_or_else(|| ControllerError::new("node-dispatch-required", "no live node dispatch"))?;
            let target = saved.node.as_ref().ok_or_else(|| ControllerError::new("node-required", "dispatch is not a node action"))?;
            self.policy.revalidate(&saved.plan).map_err(policy_error)?;
            self.revalidate_node(saved)?;
            let raw: crate::ui_tree::RawNodeInput = serde_json::from_value(request.get("node").cloned().unwrap_or(Value::Null))
                .map_err(|_| ControllerError::new("invalid-fresh-node", "invalid Android node data"))?;
            self.trees.verify_target(target, &raw).map_err(|error| ControllerError::new(error.code(), error.detail()))
        })();
        match result {
            Ok(()) => {
                if let Some(saved) = self.saved.get_mut(call_id) { saved.node_verified = true; }
                success_json("node-verified", &self.policy, None, None).to_string()
            }
            Err(error) => error_json(error.code(), error.detail(), None),
        }
    }

    pub fn publish_tree(&mut self, call_id: &str, raw: crate::ui_tree::RawTreeInput) -> Result<Value, ControllerError> {
        if self.poisoned { return Err(ControllerError::new("core-poisoned", "controller is unavailable")); }
        let saved = self.saved.get(call_id).filter(|saved| saved.plan.op == "snapshot")
            .ok_or_else(|| ControllerError::new("tree-dispatch-required", "no native snapshot plan"))?;
        if self.lifecycle.phase(call_id) != Some(Phase::Dispatching) {
            return Err(ControllerError::new("tree-dispatch-required", "snapshot is not dispatching"));
        }
        let plan = saved.plan.clone();
        self.policy.revalidate(&plan).map_err(policy_error)?;
        let binding = plan.screen().ok_or_else(|| ControllerError::new("screen-required", "snapshot requires a display"))?;
        if self.tree_deliveries.get(&binding.alias).is_some_and(|delivery| delivery.call_id == call_id) {
            return Err(ControllerError::new("tree-already-produced", "snapshot cannot replace its own result"));
        }
        let tree = self.trees.replace(self.epoch, binding, raw)
            .map_err(|error| ControllerError::new(error.code(), error.detail()))?;
        let metadata = json!({"snapshotId": tree.snapshot_id.to_string(), "epoch": self.epoch.to_string(),
            "generation": binding.generation.to_string(), "nodeCount": tree.node_count, "complete": tree.complete});
        let screen_id = binding.alias.clone();
        self.tree_deliveries.insert(screen_id.clone(), TreeDelivery { plan, call_id: call_id.to_owned(), metadata: metadata.clone() });
        Ok(json!({"ok":true,"code":"snapshot-captured","executed":"yes","screenId":screen_id,"data":{"tree":metadata}}))
    }

    fn handle_read_tree(&self, request: &Map<String, Value>) -> String {
        if let Err(response) = allowed(request, &["protocolVersion", "kind", "callId"]) { return response; }
        let call_id = match required_string(request, "callId") { Ok(id) => id, Err(response) => return response };
        let result = (|| -> Result<Value, ControllerError> {
            if self.lifecycle.phase(call_id) != Some(Phase::Settled) {
                return Err(ControllerError::new("tree-not-settled", "snapshot has no definite receipt"));
            }
            let receipt = self.lifecycle.receipt(call_id).filter(|receipt| receipt.ok() && receipt.executed() == Executed::Yes)
                .ok_or_else(|| ControllerError::new("tree-not-successful", "snapshot did not succeed"))?;
            let screen = receipt.screen_id().ok_or_else(|| ControllerError::new("screen-required", "snapshot has no screen"))?;
            let delivery = self.tree_deliveries.get(screen).filter(|delivery| delivery.call_id == call_id)
                .ok_or_else(|| ControllerError::new("tree-result-expired", "snapshot is no longer current"))?;
            self.policy.revalidate(&delivery.plan).map_err(policy_error)?;
            if receipt.data().and_then(|data| data.get("tree")) != Some(&delivery.metadata) {
                return Err(ControllerError::new("tree-receipt-mismatch", "snapshot does not match the receipt"));
            }
            let tree = self.trees.compact_snapshot_json(screen)
                .map_err(|error| ControllerError::new(error.code(), error.detail()))?
                .filter(|tree| tree.len() <= 2 * 1024 * 1024 - 8192)
                .ok_or_else(|| ControllerError::new("tree-response-budget", "snapshot cannot fit the IPC response"))?;
            serde_json::from_str(&tree).map_err(|_| ControllerError::new("invalid-tree-result", "cannot read compact snapshot"))
        })();
        match result {
            Ok(tree) => json!({"protocolVersion":PROTOCOL_VERSION,"ok":true,"code":"tree-delivered","executed":"yes","tree":tree}).to_string(),
            Err(error) => error_json(error.code(), error.detail(), None),
        }
    }

    /// 只能为已经持久化派发的视觉操作取票；票不能由 Kotlin/Node 自行拼接。
    pub fn visual_ticket(&self, call_id: &str) -> Result<crate::vision_runtime::VisualTicket, ControllerError> {
        if self.poisoned { return Err(ControllerError::new("core-poisoned", "controller is unavailable")); }
        if self.lifecycle.phase(call_id) != Some(Phase::Dispatching) {
            return Err(ControllerError::new("visual-dispatch-required", "visual operation is not dispatching"));
        }
        let saved = self.saved.get(call_id)
            .ok_or_else(|| ControllerError::new("call-not-found", "no native dispatch plan"))?;
        if !matches!(saved.plan.op, "screenshot" | "readRegion") {
            return Err(ControllerError::new("visual-operation-required", "call is not a visual operation"));
        }
        self.policy.revalidate(&saved.plan).map_err(|error| ControllerError::new(error.code(), error.detail()))?;
        let binding = saved.plan.screen()
            .ok_or_else(|| ControllerError::new("screen-required", "visual call requires a display"))?;
        let target = crate::vision::ScreenTarget::new(saved.plan.epoch, &binding.alias, binding.display_id,
            binding.generation, binding.width, binding.height)
            .map_err(|error| ControllerError::new(error.code(), error.detail()))?;
        let region = if saved.plan.op == "readRegion" {
            let coordinate = |key: &str| saved.args.get(key).and_then(Value::as_i64)
                .and_then(|value| i32::try_from(value).ok())
                .ok_or_else(|| ControllerError::new("invalid-region", "missing native region coordinate"));
            Some(crate::vision::LogicalRect { x1: coordinate("x1")?, y1: coordinate("y1")?,
                x2: coordinate("x2")?, y2: coordinate("y2")? })
        } else { None };
        Ok(crate::vision_runtime::VisualTicket { call_id: call_id.to_owned(), plan: saved.plan.clone(), target, region })
    }

    /// 编码期间不持有 CORE 锁；入缓存前重新取得票并逐字段比较。
    pub fn finish_visual(&mut self, ticket: &crate::vision_runtime::VisualTicket, image: crate::vision::VisionImage)
        -> Result<Value, ControllerError> {
        let current = self.visual_ticket(&ticket.call_id)?;
        if &current != ticket {
            return Err(ControllerError::new("visual-ticket-stale", "dispatch target changed during encoding"));
        }
        let metadata = self.images.insert(ticket.clone(), image)
            .map_err(|error| ControllerError::new(error.code(), error.detail()))?;
        Ok(json!({"ok": true, "code": if ticket.region.is_some() { "region-read" } else { "screenshot-captured" },
            "executed": "yes", "screenId": ticket.target.screen_id, "data": {"image": metadata}}))
    }

    /// 只交付已结算且仍获授权的当前图片；资源过期不重新截图、不清空回执。
    pub fn read_visual(&self, call_id: &str) -> Result<(Value, Vec<u8>), ControllerError> {
        if self.poisoned { return Err(ControllerError::new("core-poisoned", "controller is unavailable")); }
        if self.lifecycle.phase(call_id) != Some(Phase::Settled) {
            return Err(ControllerError::new("image-not-settled", "image operation has no definite terminal receipt"));
        }
        let receipt = self.lifecycle.receipt(call_id)
            .ok_or_else(|| ControllerError::new("receipt-missing", "image receipt is absent"))?;
        if !receipt.ok() || receipt.executed() != Executed::Yes {
            return Err(ControllerError::new("image-not-successful", "image operation did not succeed"));
        }
        let image = self.images.get(call_id)
            .ok_or_else(|| ControllerError::new("image-result-expired", "JPEG is no longer retained; operation is not replayed"))?;
        self.policy.revalidate(&image.ticket.plan).map_err(|error| ControllerError::new(error.code(), error.detail()))?;
        if receipt.data().and_then(|data| data.get("image")) != Some(&image.metadata) {
            return Err(ControllerError::new("image-receipt-mismatch", "cached image differs from the native receipt"));
        }
        Ok((image.metadata.clone(), image.jpeg.clone()))
    }

    /// 处理一个 JSON 请求。任何 panic 都会让本控制器停止服务。
    pub fn exchange(&mut self, payload: &str) -> String {
        self.exchange_with_mode(payload, false)
    }

    /// 处理一个不写日志的快请求：事实查询、节点与派发校验。
    /// 其它 kind 一律拒绝。调用方必须在 try_lock 内调用。
    pub fn exchange_nonblocking(&mut self, payload: &str) -> String {
        self.exchange_with_mode(payload, true)
    }

    fn exchange_with_mode(&mut self, payload: &str, nonblocking: bool) -> String {
        if self.poisoned {
            return error_json("core-poisoned", "controller stopped after an internal panic", None);
        }
        let started = std::time::Instant::now();
        let result = catch_unwind(AssertUnwindSafe(|| self.exchange_inner(payload, nonblocking)));
        match result {
            Ok(response) => {
                let elapsed = started.elapsed().as_micros().min(u64::MAX as u128) as u64;
                self.exchanges = self.exchanges.saturating_add(1);
                self.elapsed_us = self.elapsed_us.saturating_add(elapsed);
                if let (false, Ok(request), Ok(reply)) = (nonblocking, serde_json::from_str::<Value>(payload), serde_json::from_str::<Value>(&response)) {
                    if matches!(request["kind"].as_str(), Some("prepare" | "commit" | "settle" | "cancel" | "fallbackUnavailableA11y")) {
                        let saved = request["callId"].as_str().and_then(|id| self.saved.get(id));
                        let plan = reply.get("plan");
                        let operation = saved.map(|saved| saved.plan.op).or_else(|| request["operation"].as_str()).filter(|value| value.len() <= 64);
                        let channel = saved.map(|saved| backend_wire(saved.plan.backend)).or_else(|| plan.and_then(|plan| plan["backend"].as_str()));
                        let screen = saved.and_then(|saved| saved.plan.target.alias()).or_else(|| reply["screenId"].as_str()).filter(|value| value.len() <= 64);
                        // Never retain arguments, text, image data, stdout or command strings.
                        self.audit.push_back(json!({"kind":request["kind"], "operation":operation,
                            "channel":channel, "screenId":screen, "code":reply["code"],
                            "ok":reply["ok"], "executed":reply["executed"], "elapsedUs":elapsed}));
                        while self.audit.len() > 64 { self.audit.pop_front(); }
                    }
                }
                response
            },
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

        if nonblocking && !matches!(kind.as_str(), "publishFacts" | "capabilities" | "diagnostics" | "validateDispatch" | "verifyNode") {
            return error_json(
                "blocking-operation-rejected",
                "exchangeNonblocking only accepts facts and dispatch verification",
                None,
            );
        }

        match kind.as_str() {
            "publishFacts" => self.handle_publish_facts(object),
            "capabilities" => self.handle_capabilities(object),
            "diagnostics" => {
                if let Err(response) = allowed(object, &["protocolVersion", "kind"]) { return response; }
                json!({"protocolVersion":PROTOCOL_VERSION,"ok":true,"code":"native-diagnostics",
                    "exchanges":self.exchanges,"elapsedUs":self.elapsed_us,"recent":self.audit,
                    "lifecycleRecords":self.lifecycle.record_count()}).to_string()
            },
            "prepare" => self.handle_prepare(object),
            "commit" => self.handle_commit(object),
            "settle" => self.handle_settle(object),
            "cancel" => self.handle_cancel(object),
            "fallback" => self.handle_fallback(object),
            "fallbackUnavailableA11y" => self.handle_observed_fallback(object),
            "operationStatus" => self.handle_operation_status(object),
            "readTree" => self.handle_read_tree(object),
            "validateDispatch" => self.handle_validate_dispatch(object),
            "verifyNode" => self.handle_verify_node(object),
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
        if facts.device.as_ref().is_some_and(|device| device.manufacturer.len() > 128 || device.model.len() > 128 ||
            device.release.len() > 128 || !(16..=1000).contains(&device.sdk)) {
            return error_json("invalid-device-facts", "device metadata is out of bounds", None);
        }

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
            let allocation = match allocation_wire(screen.allocation_id.as_ref()) {
                Ok(value) => value,
                Err(detail) => return error_json("invalid-facts", detail, None),
            };
            let screen_facts = ScreenFacts::new(
                screen.display_id,
                screen.width,
                screen.height,
                screen.rotation,
            )
            .with_allocation(allocation);
            if let Err(error) = policy.observe_screen(alias, screen_facts) {
                return error_json(error.code(), error.detail(), None);
            }
            known.insert(alias.clone());
        }
        policy.set_a11y_facts(facts.a11y.map(A11yFactsWire::into_policy).unwrap_or_default());
        policy.set_shizuku_facts(facts.shizuku.map(ShizukuFactsWire::into_policy).unwrap_or_default());
        policy.set_root_facts(facts.root.map(RootFactsWire::into_policy).unwrap_or_default());
        policy.set_termux_ready(facts.termux_ready.unwrap_or_default());
        self.device = facts.device.map(|device| json!({"manufacturer":device.manufacturer,"model":device.model,
            "sdk":device.sdk,"release":device.release})).unwrap_or(Value::Null);
        self.policy = policy;
        let policy = &self.policy;
        self.images.retain(|ticket| policy.revalidate(&ticket.plan).is_ok());
        let trees = &mut self.trees;
        self.tree_deliveries.retain(|screen, delivery| {
            let valid = policy.revalidate(&delivery.plan).is_ok();
            if !valid { trees.invalidate_screen(screen); }
            valid
        });
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
            let operations: Vec<&str> = crate::policy::OPERATIONS.iter().filter(|spec| {
                let candidates = match spec.target_domain {
                    TargetDomain::AndroidDisplay => self.known_screens.iter().filter_map(|alias|
                        self.target_for(spec.name, Some(alias)).ok()).collect::<Vec<_>>(),
                    TargetDomain::VirtualDisplay => {
                        let mut targets = self.known_screens.iter().filter(|alias| crate::policy::is_virtual_alias(alias))
                            .filter_map(|alias| self.target_for(spec.name, Some(alias)).ok()).collect::<Vec<_>>();
                        if matches!(spec.name, "vdCreate" | "vdInfo") {
                            targets.push(TargetRequest::NewVirtual("virtual-1".into()));
                        }
                        targets
                    },
                    _ => self.target_for(spec.name, None).into_iter().collect(),
                };
                candidates.into_iter().any(|target| self.policy.plan(spec.name, target).is_ok())
            }).map(|spec| spec.name).collect();
            object.insert("operations".into(), json!(operations));
            object.insert("device".into(), self.device.clone());
            object.insert(
                "channels".into(),
                json!({
                    "a11y": {
                        "enabled": tri_wire(self.policy.a11y().enabled),
                        "online": tri_wire(self.policy.a11y().online),
                        "supportedOps": op_set_wire(&self.policy.a11y().supported_ops),
                        "displaySupport": display_wire(&self.policy.a11y().display_support),
                        "displayOperations": self.policy.a11y().display_operations
                    },
                    "shizuku": {
                        "installed": tri_wire(self.policy.shizuku().installed),
                        "running": tri_wire(self.policy.shizuku().running),
                        "granted": tri_wire(self.policy.shizuku().granted),
                        "bound": tri_wire(self.policy.shizuku().bound),
                        "functionalReady": tri_wire(self.policy.shizuku().functional_ready),
                        "serverUid": server_uid_wire(self.policy.shizuku().server_uid),
                        "supportedOps": op_set_wire(&self.policy.shizuku().supported_ops),
                        "displaySupport": display_wire(&self.policy.shizuku().display_support),
                        "displayOperations": self.policy.shizuku().display_operations
                    },
                    "root": {
                        "authorization": tri_wire(self.policy.root().authorization),
                        "consentValid": tri_wire(self.policy.root().consent_valid),
                        "appSu": tri_wire(self.policy.root().app_su)
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
            // Argument rejection happens before any plan or lifecycle admission exists.
            return rejection_json(error.code(), error.detail(), screen_id.as_deref());
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
            Err(error) => return rejection_json(error.code(), error.detail(), screen_id.as_deref()),
        };
        if let Some(expected) = generation.as_ref().and_then(|value| value.parse::<u64>().ok()) {
            match plan.screen() {
                Some(binding) if binding.generation == expected => {}
                Some(_) => return rejection_json("generation-mismatch", "screen generation does not match", screen_id.as_deref()),
                None => return rejection_json("generation-mismatch", "this target has no screen generation", screen_id.as_deref()),
            }
        }
        if let Err(error) = validate_args(&self.policy, &plan, &args) {
            return rejection_json(error.code(), error.detail(), screen_id.as_deref());
        }
        let node = match args.get("ref").and_then(Value::as_str).map(|reference| self.resolve_node(&plan, reference)).transpose() {
            Ok(node) => node,
            // The call has no lifecycle record and no platform permit at this point.
            Err(error) => return rejection_json(error.code(), error.detail(), plan.target.alias()),
        };

        match self.lifecycle.begin(&call_id, &request_bytes) {
            Ok(Admission::Dispatch(permit)) => {
                self.saved.insert(call_id.clone(), SavedPlan { plan: plan.clone(), permit, args: args.clone(), node, node_verified: false, dispatch_validated: false });
                let mut response = success_json("prepared", &self.policy, Some(&plan), None);
                response["plan"]["args"] = args;
                // The host preflights adapter support before commit. Give it the same
                // resolved node binding as commit; a ref operation is not a point operation.
                if let Some(node) = &self.saved[&call_id].node {
                    response["plan"]["nodeTarget"] = json!({"windowId":node.window_id(), "path":node.raw_child_path()});
                }
                response.to_string()
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
            return rejection_json(error.code(), error.detail(), plan.target.alias());
        }
        if let Err(error) = self.revalidate_node(saved) {
            return rejection_json(error.code(), error.detail(), plan.target.alias());
        }

        match self.lifecycle.mark_dispatched(&permit) {
            Ok(()) => {
                let mut response = success_json("dispatched", &self.policy, Some(&plan), None);
                if let Some(object) = response.as_object_mut() {
                    object.insert("dispatch".into(), json!("permitted"));
                    object.insert("callId".into(), json!(call_id));
                }
                response["plan"]["args"] = self.saved[&call_id].args.clone();
                if let Some(node) = &self.saved[&call_id].node {
                    response["plan"]["nodeTarget"] = json!({"windowId":node.window_id(), "path":node.raw_child_path()});
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
        if receipt.executed() != Executed::Unknown && receipt.screen_id() != saved.plan.target.alias() {
            return error_json("receipt-target-mismatch", "platform receipt differs from its dispatch target", saved.plan.target.alias());
        }
        if receipt.ok() && saved.node.is_some() && !saved.node_verified {
            return error_json("node-not-verified", "success requires a matching Android node", saved.plan.target.alias());
        }
        let post_denial = if receipt.executed() == Executed::Yes {
            self.policy.revalidate(&saved.plan).err()
        } else { None };
        if matches!(saved.plan.op, "screenshot" | "readRegion") && receipt.ok() && post_denial.is_none() {
            let expected = self.images.get(&call_id).map(|image| &image.metadata);
            if expected.is_none() || receipt.data().and_then(|data| data.get("image")) != expected {
                return error_json("invalid-visual-receipt", "visual success requires the native encoded image", receipt.screen_id());
            }
        }
        if saved.plan.op == "snapshot" && receipt.ok() && post_denial.is_none() {
            let expected = saved.plan.target.alias().and_then(|screen| self.tree_deliveries.get(screen))
                .filter(|delivery| delivery.call_id == call_id).map(|delivery| &delivery.metadata);
            if expected.is_none() || receipt.data().and_then(|data| data.get("tree")) != expected {
                return error_json("invalid-tree-receipt", "snapshot success requires the native tree", receipt.screen_id());
            }
        }
        if self.lifecycle.phase(&call_id) != Some(Phase::Dispatching) {
            return error_json("invalid-state", "call has no successful dispatch evidence", receipt.screen_id());
        }

        let result = if receipt.executed() == Executed::Unknown {
            self.lifecycle.mark_unknown(&call_id, &permit.fingerprint().clone(), receipt.code())
        } else {
            let mut outcome = if let Some(error) = &post_denial {
                Outcome::new(error.code(), false)
            } else if receipt.executed() == Executed::Yes {
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
            if let Some(data) = receipt.data().filter(|_| post_denial.is_none()) {
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
            if let Err(error) = self.policy.revalidate(&plan).map_err(policy_error).and_then(|_| self.revalidate_node(saved)) {
                valid = false;
                code = error.code();
            } else if saved.node.is_some() && !saved.node_verified {
                valid = false;
                code = "node-not-verified";
            }
        }
        if valid {
            self.saved.get_mut(&call_id).expect("validated plan exists").dispatch_validated = true;
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

    /// Only the trusted dispatcher calls this after its prior adapter has returned and never
    /// obtained the final execution guard. The persisted dispatch record stays in place.
    fn handle_observed_fallback(&mut self, request: &Map<String, Value>) -> String {
        if let Err(response) = allowed(request, &["protocolVersion", "kind", "callId"]) {
            return response;
        }
        let call_id = match required_string(request, "callId") {
            Ok(value) => value.to_owned(),
            Err(response) => return response,
        };
        let Some(saved) = self.saved.get_mut(&call_id) else {
            return error_json("call-not-found", "no native plan for this call", None);
        };
        let phase = self.lifecycle.phase(&call_id);
        if saved.node.is_some() || saved.dispatch_validated ||
            !matches!(phase, Some(Phase::Prepared | Phase::Dispatching)) {
            return error_json("fallback-not-allowed", "the original action can no longer safely switch adapters", saved.plan.target.alias());
        }
        let fallback = match self.policy.observed_a11y_fallback(&saved.plan) {
            Ok(plan) => plan,
            Err(error) => return rejection_json(error.code(), error.detail(), saved.plan.target.alias()),
        };
        saved.plan = fallback.clone();
        let args = saved.args.clone();
        let mut response = success_json("fallback-prepared", &self.policy, Some(&fallback), None);
        response["callId"] = json!(call_id);
        if phase == Some(Phase::Dispatching) {
            response["dispatch"] = json!("permitted");
        }
        response["plan"]["args"] = args;
        response.to_string()
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
        if saved.node.is_some() {
            return error_json("fallback-not-allowed", "node references cannot switch to another platform", saved.plan.target.alias());
        }
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
                return Err(rejection_json(
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
    if operation == "prepareEnvironment" {
        allowed_fields(args, &["restore"]).map_err(|response| ControllerError::new("invalid-request", response))?;
        if args.get("restore").is_some_and(|value| !value.is_boolean()) {
            return Err(ControllerError::new("invalid-restore", "restore must be a boolean"));
        }
        return Ok(());
    }
    if operation == "keyEvent" {
        allowed_fields(args, &["key"]).map_err(|response| ControllerError::new("invalid-request", response))?;
        return if matches!(args["key"].as_str(), Some("enter" | "tab" | "escape" | "backspace" | "delete" |
            "space" | "up" | "down" | "left" | "right" | "back")) { Ok(()) }
            else { Err(ControllerError::new("invalid-key", "one supported key is required")) };
    }
    if operation == "swipe" {
        allowed_fields(args, &["x1", "y1", "x2", "y2", "durationMs"])
            .map_err(|response| ControllerError::new("invalid-request", response))?;
        let object = args.as_object().ok_or_else(|| ControllerError::new("invalid-swipe", "swipe args are required"))?;
        for key in ["x1", "y1", "x2", "y2"] { coordinate(object, key)?; }
        if args["x1"] == args["x2"] && args["y1"] == args["y2"] {
            return Err(ControllerError::new("invalid-swipe", "swipe endpoints must differ"));
        }
        if args.get("durationMs").is_some_and(|value| !value.as_u64().is_some_and(|duration| (50..=2000).contains(&duration))) {
            return Err(ControllerError::new("invalid-duration", "swipe duration is 50 to 2000 milliseconds"));
        }
        return Ok(());
    }
    if operation == "webAction" {
        allowed_fields(args, &["action", "ref", "text", "clear", "direction"])
            .map_err(|response| ControllerError::new("invalid-request", response))?;
        let action = args["action"].as_str().unwrap_or("");
        if !matches!(action, "click" | "longClick" | "setText" | "scroll") ||
            !args["ref"].as_str().is_some_and(|value| value.starts_with('w') && value.len() <= 96 && value.contains('_')) {
            return Err(ControllerError::new("invalid-web-action", "a current WebView reference and action are required"));
        }
        if action == "setText" && (!args["text"].as_str().is_some_and(|text| text.len() <= 65_536) ||
            args.get("clear").is_some_and(|value| !value.is_boolean())) {
            return Err(ControllerError::new("invalid-text", "bounded text and optional boolean clear are required"));
        }
        if action == "scroll" && !matches!(args["direction"].as_str(), Some("up" | "down" | "left" | "right")) {
            return Err(ControllerError::new("invalid-direction", "a scroll direction is required"));
        }
        return Ok(());
    }
    if matches!(operation, "shExec" | "rootExec" | "termuxExec") {
        allowed_fields(args, &["command"]).map_err(|response| ControllerError::new("invalid-request", response))?;
        if !args.get("command").and_then(Value::as_str).is_some_and(|command| {
            match operation {
                "shExec" => crate::shell_policy::shizuku_query(command),
                "termuxExec" => crate::shell_policy::termux(command),
                _ => crate::shell_policy::bounded(command),
            }
        }) {
            return Err(ControllerError::new("shell-command-denied", "command is not allowed by this native channel"));
        }
        return Ok(());
    }
    if operation == "webSnapshot" {
        allowed_fields(args, &["root"]).map_err(|response| ControllerError::new("invalid-request", response))?;
        if args.get("root").is_some_and(|value| !value.as_str().is_some_and(|root| root.len() <= 2048)) {
            return Err(ControllerError::new("invalid-request", "root must be a bounded selector"));
        }
        return Ok(());
    }
    if matches!(operation, "vdCreate" | "vdDestroy" | "vdInfo" | "vdLaunch" | "vdLaunchApp" | "launchApp") {
        let object = args.as_object().ok_or_else(|| ControllerError::new("invalid-request", "args must be an object"))?;
        let keys: &[&str] = match operation {
            "vdCreate" => &["width", "height", "densityDpi", "session"],
            "vdLaunchApp" => &["pkg", "session"],
            "launchApp" => &["pkg"],
            _ => &["session"],
        };
        allowed_fields(args, keys).map_err(|response| ControllerError::new("invalid-request", response))?;
        if let Some(session) = object.get("session") {
            if !session.as_str().is_some_and(|value| !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)) {
                return Err(ControllerError::new("invalid-session", "session must be a bounded identifier"));
            }
        }
        if operation == "vdCreate" {
            for (key, min, max) in [("width", 64, 4096), ("height", 64, 4096), ("densityDpi", 120, 640)] {
                if let Some(value) = object.get(key) {
                    if !value.as_i64().is_some_and(|value| (min..=max).contains(&value)) {
                        return Err(ControllerError::new("invalid-virtual-geometry", format!("{key} is out of range")));
                    }
                }
            }
            if object.contains_key("width") != object.contains_key("height") {
                return Err(ControllerError::new("invalid-virtual-geometry", "width and height must be supplied together"));
            }
        }
        if matches!(operation, "vdLaunchApp" | "launchApp") {
            let valid = object.get("pkg").and_then(Value::as_str).is_some_and(|package| {
                !package.is_empty() && package.len() <= 255 && package.split('.').all(|part| {
                    let mut bytes = part.bytes();
                    bytes.next().is_some_and(|byte| byte.is_ascii_alphabetic()) &&
                        bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
                })
            });
            if !valid { return Err(ControllerError::new("invalid-package", "a valid Android package is required")); }
        }
        return Ok(());
    }
    // BrowserHost is a shared application workspace, not an Android display controller.
    // Its existing DOM/navigation schema remains at that boundary; never reinterpret its
    // CSS coordinates as physical-screen input or run its payload through shell parsers.
    if crate::policy::OperationSpec::for_name(operation)
        .is_some_and(|spec| spec.target_domain == TargetDomain::BrowserWorkspace)
    {
        return if args.is_object() { Ok(()) }
            else { Err(ControllerError::new("invalid-request", "browser args must be an object")) };
    }
    if matches!(operation, "screenshot" | "snapshot") {
        return allowed_fields(args, &[]).map_err(|response| ControllerError::new("invalid-request", response));
    }
    if operation == "readRegion" {
        let object = args.as_object().ok_or_else(|| ControllerError::new("invalid-region", "args must be an object"))?;
        if object.len() != 4 || !["x1", "y1", "x2", "y2"].iter().all(|key| object.contains_key(*key)) {
            return Err(ControllerError::new("invalid-region", "readRegion requires only x1,y1,x2,y2"));
        }
        for key in ["x1", "y1", "x2", "y2"] { coordinate(object, key)?; }
        return Ok(());
    }
    let object = args.as_object().ok_or_else(|| ControllerError::new("invalid-request", "args must be an object"))?;
    if operation == "global" {
        allowed_fields(args, &["action"]).map_err(|response| ControllerError::new("invalid-request", response))?;
        return match object.get("action").and_then(Value::as_str) {
            Some("back" | "home" | "recents" | "notifications" | "quickSettings" | "powerDialog" |
                "toggleSplitScreen" | "lockScreen" | "takeScreenshot" | "menu" | "mediaPlayPause" |
                "dismissNotificationShade" | "accessibilityShortcut") => Ok(()),
            _ => Err(ControllerError::new("invalid-global-action", "a known Android global action is required")),
        };
    }
    if matches!(operation, "click" | "longClick" | "nodeText" | "setText" | "scroll") && object.contains_key("ref") {
        let valid_ref = object.get("ref").and_then(Value::as_str).is_some_and(|reference|
            !reference.is_empty() && reference.len() <= 96);
        if !valid_ref {
            return Err(ControllerError::new("invalid-node-ref", "a bounded snapshot ref is required"));
        }
        let keys: &[&str] = match operation {
            "setText" => &["ref", "text", "clear"],
            "scroll" => &["ref", "direction"],
            _ => &["ref"],
        };
        allowed_fields(args, keys).map_err(|response| ControllerError::new("invalid-request", response))?;
        if operation == "setText" {
            if !object.get("text").and_then(Value::as_str).is_some_and(|text| text.len() <= 8192) {
                return Err(ControllerError::new("invalid-text", "text must be a string of at most 8192 bytes"));
            }
            if object.get("clear").is_some_and(|clear| !clear.is_boolean()) {
                return Err(ControllerError::new("invalid-clear", "clear must be a boolean"));
            }
        }
        if operation == "scroll" { validate_direction(object)?; }
        return Ok(());
    }
    if operation == "setText" {
        allowed_fields(args, &["text", "clear"]).map_err(|response| ControllerError::new("invalid-request", response))?;
        if !object.get("text").and_then(Value::as_str).is_some_and(|text| text.len() <= 8192) {
            return Err(ControllerError::new("invalid-text", "text must be a string of at most 8192 bytes"));
        }
        if object.get("clear").is_some_and(|clear| !clear.is_boolean()) {
            return Err(ControllerError::new("invalid-clear", "clear must be a boolean"));
        }
        return Ok(());
    }
    if operation == "nodeText" {
        return Err(ControllerError::new("invalid-node-ref", "a snapshot ref is required for this operation"));
    }
    if operation == "scroll" {
        allowed_fields(args, &["x", "y", "direction", "fraction"]).map_err(|response| ControllerError::new("invalid-request", response))?;
        coordinate(object, "x")?;
        coordinate(object, "y")?;
        validate_direction(object)?;
        if object.get("fraction").is_some_and(|value| !value.as_f64().is_some_and(|n| (0.1..=1.0).contains(&n))) {
            return Err(ControllerError::new("invalid-fraction", "fraction must be between 0.1 and 1"));
        }
        return Ok(());
    }
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
    if operation == "setText" {
        let mut canonical = args.clone();
        if canonical.get("clear").is_none() { canonical["clear"] = json!(true); }
        return canonical;
    }
    if args.get("ref").is_some() {
        return args.clone();
    }
    if operation == "scroll" {
        let mut canonical = args.clone();
        if canonical.get("fraction").is_none() { canonical["fraction"] = json!(0.5); }
        return canonical;
    }
    if matches!(operation, "click" | "longClick") {
        let object = args.as_object().expect("click args checked before canonicalization");
        return json!({"x": object["x"], "y": object["y"]});
    }
    args.clone()
}

fn validate_direction(args: &Map<String, Value>) -> Result<(), ControllerError> {
    match args.get("direction").and_then(Value::as_str) {
        Some("up" | "down" | "left" | "right") => Ok(()),
        _ => Err(ControllerError::new("invalid-direction", "direction must be up, down, left or right")),
    }
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

/// 解析可选的平台分配身份。只接受十进制/0x 十六进制字符串或非负整数，
/// 其它形态（布尔、浮点、负数、超长文本）一律拒绝而不是猜值。
fn allocation_wire(value: Option<&Value>) -> Result<Option<u64>, String> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => parse_id_string(text)
            .map(Some)
            .ok_or_else(|| "allocationId must be a decimal or 0x-prefixed hex string".to_owned()),
        Some(Value::Number(number)) => number
            .as_u64()
            .map(Some)
            .ok_or_else(|| "allocationId must be a non-negative integer".to_owned()),
        Some(_) => Err("allocationId must be a decimal or hex string".to_owned()),
    }
}

fn optional_object<'a>(request: &'a Map<String, Value>, key: &str) -> Result<Option<&'a Value>, String> {
    match request.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value @ Value::Object(_)) => Ok(Some(value)),
        Some(_) => Err(error_json("invalid-request", format!("{key} must be an object"), None)),
    }
}

fn validate_args(policy: &PolicyState, plan: &DispatchPlan, args: &Value) -> Result<(), ControllerError> {
    if plan.op == "global" && plan.target.alias() != Some("real") && args["action"].as_str() != Some("back") {
        return Err(ControllerError::new("target-unsupported", "only Back is scoped to a virtual display"));
    }
    if plan.op == "swipe" {
        let object = args.as_object().expect("swipe args checked by caller");
        policy.validate_point(plan, coordinate(object, "x1")?, coordinate(object, "y1")?).map_err(policy_error)?;
        policy.validate_point(plan, coordinate(object, "x2")?, coordinate(object, "y2")?).map_err(policy_error)?;
        return Ok(());
    }
    if plan.op == "shExec" && crate::shell_policy::reads_display(args["command"].as_str().unwrap_or("")) &&
        !policy.scope().allows("real") {
        return Err(ControllerError::new("screen-out-of-scope", "display inspection requires real-screen access"));
    }
    if matches!(plan.target, PlanTarget::BrowserWorkspace) {
        return Ok(());
    }
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
    failure_json(code, detail, screen_id, "unknown")
}

fn rejection_json(code: &str, detail: impl AsRef<str>, screen_id: Option<&str>) -> String {
    failure_json(code, detail, screen_id, "no")
}

fn failure_json(code: &str, detail: impl AsRef<str>, screen_id: Option<&str>, executed: &'static str) -> String {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "ok": false,
        "code": code,
        "executed": executed,
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
    #[serde(default)]
    termux_ready: Option<Tri>,
    #[serde(default)]
    device: Option<DeviceFacts>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DeviceFacts { manufacturer: String, model: String, sdk: u32, release: String }

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ScreenFactsWire {
    display_id: i32,
    width: u32,
    height: u32,
    rotation: u8,
    /// 可选平台分配身份。只用于识别同 alias/displayId/几何下的重建，
    /// 不参与 generation 分配，也不进入 capabilities 输出。
    #[serde(default)]
    allocation_id: Option<Value>,
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
    #[serde(default)]
    display_operations: Option<BTreeMap<i32, BTreeSet<String>>>,
}

impl A11yFactsWire {
    fn into_policy(self) -> A11yFacts {
        A11yFacts {
            enabled: self.enabled,
            online: self.online,
            supported_ops: self.supported_ops.into_policy(),
            display_support: self.display_support.into_policy(),
            display_operations: self.display_operations,
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
    #[serde(default)]
    display_operations: Option<BTreeMap<i32, BTreeSet<String>>>,
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
            display_operations: self.display_operations,
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
    #[serde(default)]
    app_su: Tri,
}

impl RootFactsWire {
    fn into_policy(self) -> RootFacts {
        RootFacts { authorization: self.authorization, consent_valid: self.consent_valid, app_su: self.app_su }
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
