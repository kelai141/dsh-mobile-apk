//! 操作生命周期与耐久日志契约。
//!
//! 本模块只负责控制核心的操作记账，不接触 Android、JNI、操作表或真实副作用。
//! 生产代码必须按以下顺序调用：
//!
//! 1. [`Lifecycle::begin`] 取得 [`Admission::Dispatch`] 或已保存回执；
//! 2. [`Lifecycle::mark_dispatched`] 成功返回后，才允许执行副作用；
//! 3. 副作用有确定结果时 [`Lifecycle::settle`]（已执行，或平台明确证实未产生
//!    副作用）；异常、超时、派发后取消时 [`Lifecycle::mark_unknown`]。
//!    [`Lifecycle::withdraw`] 只用于尚未派发的 prepared 调用。
//!
//! 安全语义：
//!
//! - 派发证据先落日志，再执行副作用。`mark_dispatched` 的日志写入失败会把
//!   该调用直接置为 unknown，内存中也不会留下可再次派发的 prepared。
//! - 已派发后无法证明结果时一律 unknown；`settle` 只接受“已执行”的结果，
//!   把 unknown 清成“未执行”只能走带平台证据的 [`Lifecycle::withdraw`]。
//! - 恢复时 `prepared` 与 `dispatching` 都转为 unknown，并先持久化成功后才
//!   返回可用的生命周期对象。`prepared` 不会在恢复后继续执行。
//! - 容量满时拒绝新的调用，不驱逐任何 ID 记录。时效与过期回收必须由集成层
//!   携带受信 deadline/epoch 决定，本模块不靠时间猜测能否忘记旧 ID。
//!
//! [`Journal`] 的 `store` 必须整体替换上一版状态：返回 `Ok` 表示新状态已经持久；
//! 返回 `Err` 表示新状态是否落盘不确定。调用方不得把 `Err` 当成“没有写入”。
//! 本模块不提供真实文件后端；测试使用的 `MemoryJournal` 位于 `tests/lifecycle.rs`。

use std::collections::BTreeMap;
use std::fmt;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// 日志状态格式版本。格式变化必须提升版本并写迁移。
pub const STATE_VERSION: u32 = 2;
/// 调用 ID 的最大字节数。
pub const MAX_CALL_ID_LEN: usize = 64;
/// 稳定结果码的最大字节数。
pub const MAX_CODE_LEN: usize = 96;
/// 屏幕标识的最大字节数。
pub const MAX_SCREEN_ID_LEN: usize = 128;
/// 诊断文本的最大字节数。
pub const MAX_DIAGNOSTIC_LEN: usize = 4096;
/// 回执 data 字段序列化后的最大字节数。
pub const MAX_DATA_BYTES: usize = 16 * 1024;
/// 默认最多保留的记录数。
pub const DEFAULT_MAX_RECORDS: usize = 512;
/// 默认日志字节上限。
pub const DEFAULT_MAX_JOURNAL_BYTES: usize = 1024 * 1024;

const MAX_MAX_RECORDS: usize = 65_536;
const MIN_JOURNAL_BYTES: usize = 512;
const MAX_MAX_JOURNAL_BYTES: usize = 64 * 1024 * 1024;

/// 生命周期操作的稳定错误码。
pub mod codes {
    pub const INVALID_CALL_ID: &str = "invalid-call-id";
    pub const CALL_ID_CONFLICT: &str = "call-id-conflict";
    pub const CALL_IN_PROGRESS: &str = "call-in-progress";
    pub const REQUEST_IN_PROGRESS: &str = "request-in-progress";
    pub const REQUEST_UNKNOWN: &str = "request-unknown";
    pub const OPERATION_UNKNOWN: &str = "operation-unknown";
    pub const INVALID_TRANSITION: &str = "invalid-transition";
    pub const CALL_NOT_FOUND: &str = "call-not-found";
    pub const CAPACITY_EXHAUSTED: &str = "capacity-exhausted";
    pub const WITHDRAW_NOT_ALLOWED: &str = "withdraw-not-allowed";
    pub const INVALID_RECEIPT: &str = "invalid-receipt";
    pub const INVALID_LIMITS: &str = "invalid-limits";
    pub const JOURNAL_LOAD_FAILED: &str = "journal-load-failed";
    pub const JOURNAL_WRITE_FAILED: &str = "journal-write-failed";
    pub const JOURNAL_CORRUPT: &str = "journal-corrupt";
    pub const JOURNAL_TOO_LARGE: &str = "journal-too-large";
}

/// 由本模块写入的稳定回执码。
pub mod receipt_codes {
    pub const RECOVERED_BEFORE_DISPATCH: &str = "recovered-before-dispatch";
    pub const RECOVERED_UNSETTLED: &str = "recovered-unsettled";
    pub const WITHDRAWN_BEFORE_DISPATCH: &str = "withdrawn-before-dispatch";
}

/// 生命周期错误。`code` 是稳定机器码，`detail` 只用于诊断。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LifecycleError {
    code: &'static str,
    detail: String,
}

impl LifecycleError {
    fn new(code: &'static str, detail: impl Into<String>) -> Self {
        Self { code, detail: detail.into() }
    }

    /// 稳定错误码。
    pub fn code(&self) -> &'static str {
        self.code
    }

    /// 诊断信息，不保证稳定。
    pub fn detail(&self) -> &str {
        &self.detail
    }
}

impl fmt::Display for LifecycleError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.detail)
    }
}

impl std::error::Error for LifecycleError {}

/// 日志后端错误。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JournalError {
    code: &'static str,
    detail: String,
}

impl JournalError {
    /// 读取失败。
    pub fn load(detail: impl Into<String>) -> Self {
        Self { code: codes::JOURNAL_LOAD_FAILED, detail: detail.into() }
    }

    /// 写入失败。实现不得把“可能只写了一半”报告成成功。
    pub fn store(detail: impl Into<String>) -> Self {
        Self { code: codes::JOURNAL_WRITE_FAILED, detail: detail.into() }
    }

    /// 稳定错误码。
    pub fn code(&self) -> &'static str {
        self.code
    }

    /// 诊断信息，不保证稳定。
    pub fn detail(&self) -> &str {
        &self.detail
    }
}

impl fmt::Display for JournalError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.detail)
    }
}

impl std::error::Error for JournalError {}

impl From<JournalError> for LifecycleError {
    fn from(error: JournalError) -> Self {
        Self::new(error.code, error.detail)
    }
}

/// 可注入的耐久日志。只负责序列化状态的读取与整体替换。
pub trait Journal {
    /// 读取上次成功写入的完整状态；`None` 表示尚无状态。
    fn load(&mut self) -> Result<Option<Vec<u8>>, JournalError>;

    /// 整体替换状态。`Ok` 必须表示新状态已经耐久。
    fn store(&mut self, state: &[u8]) -> Result<(), JournalError>;
}

impl<J: Journal + ?Sized> Journal for Box<J> {
    fn load(&mut self) -> Result<Option<Vec<u8>>, JournalError> {
        (**self).load()
    }

    fn store(&mut self, state: &[u8]) -> Result<(), JournalError> {
        (**self).store(state)
    }
}

/// 请求指纹。调用方应把影响副作用的全部字段（含重试 nonce）规范化后传入。
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Fingerprint(String);

impl Fingerprint {
    /// 对请求字节做 SHA-256，得到固定的 64 位小写十六进制指纹。
    pub fn of(request: &[u8]) -> Self {
        let mut hasher = Sha256::new();
        hasher.update(request);
        let digest = hasher.finalize();
        let mut hex = String::with_capacity(64);
        for byte in digest {
            use std::fmt::Write as _;
            let _ = write!(hex, "{byte:02x}");
        }
        Self(hex)
    }

    /// 十六进制文本。
    pub fn as_str(&self) -> &str {
        &self.0
    }

    fn is_valid(&self) -> bool {
        self.0.len() == 64
            && self
                .0
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    }
}

impl fmt::Display for Fingerprint {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// 调用阶段。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    /// 已登记，尚未写派发证据。
    Prepared,
    /// 派发证据已耐久，副作用可能已发生。
    Dispatching,
    /// 有确定结果。
    Settled,
    /// 结果不明，禁止重放。
    Unknown,
    /// 已明确未执行，终态。
    Cancelled,
}

/// 回执中的执行结论。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Executed {
    Yes,
    No,
    Unknown,
}

/// 统一回执。unknown 永远不能是 ok。
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Receipt {
    ok: bool,
    code: String,
    executed: Executed,
    #[serde(rename = "screenId", default)]
    screen_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    diagnostic: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    data: Option<serde_json::Value>,
}

/// 反序列化时即校验，调用方无法拿到未校验的回执。
impl<'de> Deserialize<'de> for Receipt {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct Wire {
            ok: bool,
            code: String,
            executed: Executed,
            #[serde(rename = "screenId", default)]
            screen_id: Option<String>,
            #[serde(default)]
            diagnostic: Option<String>,
            #[serde(default)]
            data: Option<serde_json::Value>,
        }

        let wire = Wire::deserialize(deserializer)?;
        let receipt = Self {
            ok: wire.ok,
            code: wire.code,
            executed: wire.executed,
            screen_id: wire.screen_id,
            diagnostic: wire.diagnostic,
            data: wire.data,
        };
        receipt.validate().map_err(serde::de::Error::custom)?;
        Ok(receipt)
    }
}

impl Receipt {
    /// 构造并立即校验回执。
    pub fn new(
        ok: bool,
        code: impl Into<String>,
        executed: Executed,
        screen_id: Option<String>,
    ) -> Result<Self, LifecycleError> {
        let receipt = Self {
            ok,
            code: code.into(),
            executed,
            screen_id,
            diagnostic: None,
            data: None,
        };
        receipt.validate()?;
        Ok(receipt)
    }

    /// 追加诊断文本，并重新校验。
    pub fn with_diagnostic(mut self, diagnostic: impl Into<String>) -> Result<Self, LifecycleError> {
        self.diagnostic = Some(diagnostic.into());
        self.validate()?;
        Ok(self)
    }

    /// 追加结构化数据，并重新校验。
    pub fn with_data(mut self, data: serde_json::Value) -> Result<Self, LifecycleError> {
        self.data = Some(data);
        self.validate()?;
        Ok(self)
    }

    pub fn ok(&self) -> bool {
        self.ok
    }

    pub fn code(&self) -> &str {
        &self.code
    }

    pub fn executed(&self) -> Executed {
        self.executed
    }

    pub fn screen_id(&self) -> Option<&str> {
        self.screen_id.as_deref()
    }

    pub fn diagnostic(&self) -> Option<&str> {
        self.diagnostic.as_deref()
    }

    pub fn data(&self) -> Option<&serde_json::Value> {
        self.data.as_ref()
    }

    /// 校验稳定不变量。构造与反序列化都会自动调用。
    pub fn validate(&self) -> Result<(), LifecycleError> {
        validate_code(&self.code)?;
        if self.ok && self.executed != Executed::Yes {
            return Err(LifecycleError::new(
                codes::INVALID_RECEIPT,
                "ok receipt must be executed=yes",
            ));
        }
        if self.executed == Executed::Unknown && self.ok {
            return Err(LifecycleError::new(
                codes::INVALID_RECEIPT,
                "unknown receipt cannot be ok",
            ));
        }
        if self.executed == Executed::No && self.ok {
            return Err(LifecycleError::new(
                codes::INVALID_RECEIPT,
                "not-executed receipt cannot be ok",
            ));
        }
        if let Some(screen_id) = &self.screen_id {
            validate_screen_id(screen_id)?;
        }
        if let Some(diagnostic) = &self.diagnostic {
            validate_diagnostic(diagnostic)?;
        }
        if let Some(data) = &self.data {
            validate_data(data)?;
        }
        Ok(())
    }
}

/// 派发后的确定结果。只有真正明确的“已执行”或“确实未执行”才能 settle；
/// 结果不明必须走 mark_unknown。
#[derive(Clone, Debug, PartialEq)]
pub struct Outcome {
    executed: Executed,
    ok: bool,
    code: String,
    screen_id: Option<String>,
    diagnostic: Option<String>,
    data: Option<serde_json::Value>,
}

impl Outcome {
    /// `ok=true` 表示动作达到预期；`ok=false` 表示已执行但结果失败。
    pub fn new(code: impl Into<String>, ok: bool) -> Self {
        Self {
            executed: Executed::Yes,
            ok,
            code: code.into(),
            screen_id: None,
            diagnostic: None,
            data: None,
        }
    }

    /// 平台已明确证实本次没有产生副作用。`ok` 固定为 false。
    pub fn not_executed(code: impl Into<String>) -> Self {
        Self {
            executed: Executed::No,
            ok: false,
            code: code.into(),
            screen_id: None,
            diagnostic: None,
            data: None,
        }
    }

    pub fn with_screen_id(mut self, screen_id: impl Into<String>) -> Self {
        self.screen_id = Some(screen_id.into());
        self
    }

    pub fn with_diagnostic(mut self, diagnostic: impl Into<String>) -> Self {
        self.diagnostic = Some(diagnostic.into());
        self
    }

    pub fn with_data(mut self, data: serde_json::Value) -> Self {
        self.data = Some(data);
        self
    }

    fn into_receipt(self) -> Result<Receipt, LifecycleError> {
        let mut receipt = Receipt::new(self.ok, self.code, self.executed, self.screen_id)?;
        if let Some(diagnostic) = self.diagnostic {
            receipt = receipt.with_diagnostic(diagnostic)?;
        }
        if let Some(data) = self.data {
            receipt = receipt.with_data(data)?;
        }
        Ok(receipt)
    }
}

/// 容量与日志大小限制。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    max_records: usize,
    max_journal_bytes: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self { max_records: DEFAULT_MAX_RECORDS, max_journal_bytes: DEFAULT_MAX_JOURNAL_BYTES }
    }
}

impl Limits {
    /// 只指定记录上限，日志字节上限用默认值。
    pub fn new(max_records: usize) -> Result<Self, LifecycleError> {
        Self { max_records, max_journal_bytes: DEFAULT_MAX_JOURNAL_BYTES }.validate()
    }

    /// 同时指定记录上限与日志字节上限。
    pub fn with_journal_bytes(mut self, max_journal_bytes: usize) -> Result<Self, LifecycleError> {
        self.max_journal_bytes = max_journal_bytes;
        self.validate()
    }

    pub fn max_records(&self) -> usize {
        self.max_records
    }

    pub fn max_journal_bytes(&self) -> usize {
        self.max_journal_bytes
    }

    fn validate(self) -> Result<Self, LifecycleError> {
        if self.max_records == 0 || self.max_records > MAX_MAX_RECORDS {
            return Err(LifecycleError::new(
                codes::INVALID_LIMITS,
                format!("max_records must be in 1..={MAX_MAX_RECORDS}"),
            ));
        }
        if self.max_journal_bytes < MIN_JOURNAL_BYTES
            || self.max_journal_bytes > MAX_MAX_JOURNAL_BYTES
        {
            return Err(LifecycleError::new(
                codes::INVALID_LIMITS,
                format!("max_journal_bytes must be in {MIN_JOURNAL_BYTES}..={MAX_MAX_JOURNAL_BYTES}"),
            ));
        }
        Ok(self)
    }
}

/// 允许派发的凭据。`mark_dispatched` 必须消费同一凭据。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DispatchPermit {
    call_id: String,
    fingerprint: Fingerprint,
}

impl DispatchPermit {
    pub fn call_id(&self) -> &str {
        &self.call_id
    }

    pub fn fingerprint(&self) -> &Fingerprint {
        &self.fingerprint
    }
}

/// `begin` 的结果：新派发许可，或已保存的回执。
#[derive(Clone, Debug, PartialEq)]
pub enum Admission {
    Dispatch(DispatchPermit),
    Replay(Receipt),
}

/// 单个调用的只读快照。
#[derive(Clone, Debug, PartialEq)]
pub struct CallSnapshot {
    pub call_id: String,
    pub fingerprint: Fingerprint,
    pub phase: Phase,
    pub receipt: Option<Receipt>,
}

#[derive(Clone, Serialize, Deserialize)]
struct StoredRecord {
    call_id: String,
    fingerprint: String,
    phase: Phase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    receipt: Option<Receipt>,
}

#[derive(Clone, Serialize, Deserialize)]
struct StoredState {
    version: u32,
    records: Vec<StoredRecord>,
}

#[derive(Clone)]
struct State {
    records: BTreeMap<String, StoredRecord>,
}

/// 提交失败发生在编码阶段还是日志阶段，两者的安全处置不同。
enum CommitFailure {
    Encode(LifecycleError),
    Store(LifecycleError),
}

impl State {
    fn empty() -> Self {
        Self { records: BTreeMap::new() }
    }
}

/// 有界操作生命周期。Core 持有它并串行调用；所有方法都需要 `&mut self`。
pub struct Lifecycle<J: Journal> {
    journal: J,
    limits: Limits,
    state: State,
}

impl<J: Journal> Lifecycle<J> {
    /// 用默认限制打开，并从日志恢复。
    pub fn open(journal: J) -> Result<Self, LifecycleError> {
        Self::with_limits(journal, Limits::default())
    }

    /// 用指定限制打开。恢复产生的 unknown 会先写回日志再返回。
    pub fn with_limits(mut journal: J, limits: Limits) -> Result<Self, LifecycleError> {
        let limits = limits.validate()?;
        let raw = journal.load().map_err(LifecycleError::from)?;
        let mut state = match raw {
            Some(bytes) => decode_state(&bytes, limits)?,
            None => State::empty(),
        };
        if recover_state(&mut state)? {
            let bytes = encode_state(&state, limits)?;
            journal.store(&bytes).map_err(LifecycleError::from)?;
        }
        Ok(Self { journal, limits, state })
    }

    /// 登记一次调用。相同调用返回已保存回执；进行中、冲突或 unknown 都拒绝。
    ///
    /// 同一指纹只要还有 prepared/dispatching 记录，即使换一个调用 ID 也会被拒；
    /// 有 unknown 记录时同样拒绝，避免自动重放。
    pub fn begin(&mut self, call_id: &str, request: &[u8]) -> Result<Admission, LifecycleError> {
        validate_call_id(call_id)?;
        let fingerprint = Fingerprint::of(request);

        if let Some(existing) = self.state.records.get(call_id) {
            if existing.fingerprint != fingerprint.as_str() {
                return Err(LifecycleError::new(
                    codes::CALL_ID_CONFLICT,
                    format!("call id {call_id} is already bound to another request"),
                ));
            }
            return match existing.phase {
                Phase::Settled | Phase::Cancelled => Ok(Admission::Replay(
                    existing
                        .receipt
                        .clone()
                        .ok_or_else(|| corrupt("terminal record has no receipt"))?,
                )),
                Phase::Prepared | Phase::Dispatching => Err(LifecycleError::new(
                    codes::CALL_IN_PROGRESS,
                    format!("call {call_id} is still in progress"),
                )),
                Phase::Unknown => Err(LifecycleError::new(
                    codes::OPERATION_UNKNOWN,
                    format!("call {call_id} has an unsettled outcome"),
                )),
            };
        }

        if let Some(other) = self
            .state
            .records
            .values()
            .find(|record| {
                record.fingerprint == fingerprint.as_str()
                    && matches!(record.phase, Phase::Prepared | Phase::Dispatching)
            })
        {
            return Err(LifecycleError::new(
                codes::REQUEST_IN_PROGRESS,
                format!("the same request is already in progress as {}", other.call_id),
            ));
        }

        if let Some(other) = self
            .state
            .records
            .values()
            .find(|record| {
                record.fingerprint == fingerprint.as_str() && record.phase == Phase::Unknown
            })
        {
            return Err(LifecycleError::new(
                codes::REQUEST_UNKNOWN,
                format!("the same request has an unsettled outcome as {}", other.call_id),
            ));
        }

        if self.state.records.len() >= self.limits.max_records {
            return Err(LifecycleError::new(
                codes::CAPACITY_EXHAUSTED,
                format!(
                    "capacity {} is full; existing call ids are never evicted",
                    self.limits.max_records
                ),
            ));
        }

        let mut next = self.state.clone();
        next.records.insert(
            call_id.to_string(),
            StoredRecord {
                call_id: call_id.to_string(),
                fingerprint: fingerprint.as_str().to_string(),
                phase: Phase::Prepared,
                receipt: None,
            },
        );
        self.commit(next).map_err(|failure| match failure {
            CommitFailure::Encode(error) | CommitFailure::Store(error) => error,
        })?;

        Ok(Admission::Dispatch(DispatchPermit {
            call_id: call_id.to_string(),
            fingerprint,
        }))
    }

    /// 持久化派发证据。只有本方法返回 `Ok` 后才能执行副作用。
    ///
    /// 日志写入失败时，该调用在内存中直接转为 unknown，本次及后续派发都被拒绝。
    pub fn mark_dispatched(&mut self, permit: &DispatchPermit) -> Result<(), LifecycleError> {
        let call_id = permit.call_id();
        let record = self
            .state
            .records
            .get(call_id)
            .ok_or_else(|| not_found(call_id))?;
        if record.fingerprint != permit.fingerprint.as_str() {
            return Err(LifecycleError::new(
                codes::CALL_ID_CONFLICT,
                format!("call {call_id} does not belong to this request"),
            ));
        }
        match record.phase {
            Phase::Prepared => {}
            Phase::Dispatching => {
                return Err(LifecycleError::new(
                    codes::INVALID_TRANSITION,
                    format!("call {call_id} is already dispatching"),
                ))
            }
            Phase::Unknown => {
                return Err(LifecycleError::new(
                    codes::OPERATION_UNKNOWN,
                    format!("call {call_id} has an unsettled outcome"),
                ))
            }
            Phase::Settled | Phase::Cancelled => {
                return Err(LifecycleError::new(
                    codes::INVALID_TRANSITION,
                    format!("call {call_id} is already terminal"),
                ))
            }
        }

        let mut next = self.state.clone();
        next.records
            .get_mut(call_id)
            .ok_or_else(|| not_found(call_id))?
            .phase = Phase::Dispatching;

        let store_error = match self.commit(next) {
            Ok(()) => None,
            Err(CommitFailure::Encode(error)) => return Err(error),
            Err(CommitFailure::Store(error)) => Some(error),
        };
        if let Some(store_error) = store_error {
            let failure_receipt = unknown_receipt(
                codes::JOURNAL_WRITE_FAILED,
                "dispatch evidence was not durably recorded; call is unknown",
            )?;
            if let Some(record) = self.state.records.get_mut(call_id) {
                record.phase = Phase::Unknown;
                record.receipt = Some(failure_receipt);
            }
            let _ = self.persist_current();
            return Err(LifecycleError::new(
                codes::JOURNAL_WRITE_FAILED,
                format!("dispatch evidence could not be stored: {}", store_error.detail()),
            ));
        }
        Ok(())
    }

    /// 记录已派发操作的确定结果：`Outcome::new` 为已执行，
    /// `Outcome::not_executed` 为平台明确证实未产生副作用。
    ///
    /// 日志写入失败时该调用转为 unknown，调用方不得报告成功。
    pub fn settle(
        &mut self,
        call_id: &str,
        fingerprint: &Fingerprint,
        outcome: Outcome,
    ) -> Result<Receipt, LifecycleError> {
        let record = self
            .state
            .records
            .get(call_id)
            .ok_or_else(|| not_found(call_id))?;
        if record.fingerprint != fingerprint.as_str() {
            return Err(LifecycleError::new(
                codes::CALL_ID_CONFLICT,
                format!("call {call_id} does not belong to this request"),
            ));
        }

        let receipt = outcome.into_receipt()?;
        match record.phase {
            Phase::Dispatching => {}
            Phase::Settled => {
                return match &record.receipt {
                    Some(existing) if existing == &receipt => Ok(existing.clone()),
                    _ => Err(LifecycleError::new(
                        codes::INVALID_TRANSITION,
                        format!("call {call_id} is already settled with another receipt"),
                    )),
                };
            }
            Phase::Prepared => {
                return Err(LifecycleError::new(
                    codes::INVALID_TRANSITION,
                    format!("call {call_id} has no dispatch evidence"),
                ))
            }
            Phase::Unknown => {
                return Err(LifecycleError::new(
                    codes::OPERATION_UNKNOWN,
                    format!("call {call_id} has an unsettled outcome"),
                ))
            }
            Phase::Cancelled => {
                return Err(LifecycleError::new(
                    codes::INVALID_TRANSITION,
                    format!("call {call_id} was withdrawn"),
                ))
            }
        }

        let mut next = self.state.clone();
        {
            let record = next
                .records
                .get_mut(call_id)
                .ok_or_else(|| not_found(call_id))?;
            record.phase = Phase::Settled;
            record.receipt = Some(receipt.clone());
        }

        let store_error = match self.commit(next) {
            Ok(()) => None,
            Err(CommitFailure::Encode(error)) => return Err(error),
            Err(CommitFailure::Store(error)) => Some(error),
        };
        if let Some(store_error) = store_error {
            let failure_receipt = unknown_receipt(
                codes::JOURNAL_WRITE_FAILED,
                "settlement was not durably recorded; call is unknown",
            )?;
            if let Some(record) = self.state.records.get_mut(call_id) {
                record.phase = Phase::Unknown;
                record.receipt = Some(failure_receipt);
            }
            let _ = self.persist_current();
            return Err(LifecycleError::new(
                codes::JOURNAL_WRITE_FAILED,
                format!("settlement could not be stored: {}", store_error.detail()),
            ));
        }
        Ok(receipt)
    }

    /// 已派发后出现异常、超时或取消时调用。可重复调用，返回已保存的 unknown 回执。
    pub fn mark_unknown(
        &mut self,
        call_id: &str,
        fingerprint: &Fingerprint,
        reason: &str,
    ) -> Result<Receipt, LifecycleError> {
        validate_code(reason)?;
        let record = self
            .state
            .records
            .get(call_id)
            .ok_or_else(|| not_found(call_id))?;
        if record.fingerprint != fingerprint.as_str() {
            return Err(LifecycleError::new(
                codes::CALL_ID_CONFLICT,
                format!("call {call_id} does not belong to this request"),
            ));
        }
        match record.phase {
            Phase::Dispatching => {}
            Phase::Unknown => {
                return record
                    .receipt
                    .clone()
                    .ok_or_else(|| corrupt("unknown record has no receipt"));
            }
            Phase::Prepared => {
                return Err(LifecycleError::new(
                    codes::INVALID_TRANSITION,
                    format!("call {call_id} has not been dispatched; withdraw it instead"),
                ))
            }
            Phase::Settled | Phase::Cancelled => {
                return Err(LifecycleError::new(
                    codes::INVALID_TRANSITION,
                    format!("call {call_id} is already terminal"),
                ))
            }
        }

        let receipt = unknown_receipt(reason, "dispatch outcome could not be proven")?;
        if let Some(record) = self.state.records.get_mut(call_id) {
            record.phase = Phase::Unknown;
            record.receipt = Some(receipt.clone());
        }
        // 恢复时 dispatching 也会转为 unknown，因此这里的落盘失败仍然保守。
        let _ = self.persist_current();
        Ok(receipt)
    }

    /// 未派发前的撤回：仅 prepared 可取消，executed=no。
    ///
    /// 已派发的调用（dispatching）只能 settle 出确定结果或 mark_unknown；
    /// unknown 也没有通用解锁路径。是否派发必须在 `mark_dispatched` 之前由
    /// 策略与平台 preflight 决定。
    pub fn withdraw(&mut self, call_id: &str, fingerprint: &Fingerprint) -> Result<Receipt, LifecycleError> {
        let record = self
            .state
            .records
            .get(call_id)
            .ok_or_else(|| not_found(call_id))?;
        if record.fingerprint != fingerprint.as_str() {
            return Err(LifecycleError::new(
                codes::CALL_ID_CONFLICT,
                format!("call {call_id} does not belong to this request"),
            ));
        }

        match record.phase {
            Phase::Prepared => {}
            Phase::Cancelled => {
                return record
                    .receipt
                    .clone()
                    .ok_or_else(|| corrupt("cancelled record has no receipt"));
            }
            Phase::Settled => {
                return Err(LifecycleError::new(
                    codes::WITHDRAW_NOT_ALLOWED,
                    format!("call {call_id} is already settled"),
                ))
            }
            Phase::Dispatching | Phase::Unknown => {
                return Err(LifecycleError::new(
                    codes::WITHDRAW_NOT_ALLOWED,
                    format!(
                        "call {call_id} may already have executed a side effect; settle or mark unknown"
                    ),
                ))
            }
        }

        let receipt = Receipt::new(
            false,
            receipt_codes::WITHDRAWN_BEFORE_DISPATCH,
            Executed::No,
            None,
        )?;

        let mut next = self.state.clone();
        {
            let record = next
                .records
                .get_mut(call_id)
                .ok_or_else(|| not_found(call_id))?;
            record.phase = Phase::Cancelled;
            record.receipt = Some(receipt.clone());
        }
        let store_error = match self.commit(next) {
            Ok(()) => None,
            Err(CommitFailure::Encode(error)) => return Err(error),
            Err(CommitFailure::Store(error)) => Some(error),
        };
        if let Some(store_error) = store_error {
            let failure_receipt = unknown_receipt(
                codes::JOURNAL_WRITE_FAILED,
                "withdrawal was not durably recorded; call is unknown",
            )?;
            if let Some(record) = self.state.records.get_mut(call_id) {
                record.phase = Phase::Unknown;
                record.receipt = Some(failure_receipt);
            }
            let _ = self.persist_current();
            return Err(LifecycleError::new(
                codes::JOURNAL_WRITE_FAILED,
                format!("withdrawal could not be stored: {}", store_error.detail()),
            ));
        }
        Ok(receipt)
    }

    /// 只读快照。
    pub fn snapshot(&self, call_id: &str) -> Option<CallSnapshot> {
        self.state.records.get(call_id).map(|record| CallSnapshot {
            call_id: record.call_id.clone(),
            fingerprint: Fingerprint(record.fingerprint.clone()),
            phase: record.phase,
            receipt: record.receipt.clone(),
        })
    }

    /// 已保存回执。
    pub fn receipt(&self, call_id: &str) -> Option<Receipt> {
        self.state.records.get(call_id).and_then(|record| record.receipt.clone())
    }

    /// 当前阶段。
    pub fn phase(&self, call_id: &str) -> Option<Phase> {
        self.state.records.get(call_id).map(|record| record.phase)
    }

    /// 当前记录数，便于容量诊断。
    pub fn record_count(&self) -> usize {
        self.state.records.len()
    }

    pub fn limits(&self) -> Limits {
        self.limits
    }

    pub fn journal(&self) -> &J {
        &self.journal
    }

    pub fn journal_mut(&mut self) -> &mut J {
        &mut self.journal
    }

    pub fn into_journal(self) -> J {
        self.journal
    }

    fn commit(&mut self, next: State) -> Result<(), CommitFailure> {
        let bytes = encode_state(&next, self.limits).map_err(CommitFailure::Encode)?;
        self.journal
            .store(&bytes)
            .map_err(|error| CommitFailure::Store(error.into()))?;
        self.state = next;
        Ok(())
    }

    fn persist_current(&mut self) -> Result<(), LifecycleError> {
        let bytes = encode_state(&self.state, self.limits)?;
        self.journal.store(&bytes).map_err(LifecycleError::from)
    }
}

fn not_found(call_id: &str) -> LifecycleError {
    LifecycleError::new(codes::CALL_NOT_FOUND, format!("call {call_id} is not registered"))
}

fn corrupt(detail: impl Into<String>) -> LifecycleError {
    LifecycleError::new(codes::JOURNAL_CORRUPT, detail)
}

fn validate_call_id(call_id: &str) -> Result<(), LifecycleError> {
    if call_id.is_empty() || call_id.len() > MAX_CALL_ID_LEN {
        return Err(LifecycleError::new(
            codes::INVALID_CALL_ID,
            format!("call id must be 1..={MAX_CALL_ID_LEN} bytes"),
        ));
    }
    let mut chars = call_id.chars();
    let first = chars.next().ok_or_else(|| {
        LifecycleError::new(codes::INVALID_CALL_ID, "call id must not be empty")
    })?;
    if !first.is_ascii_alphanumeric() {
        return Err(LifecycleError::new(
            codes::INVALID_CALL_ID,
            "call id must start with an ASCII letter or digit",
        ));
    }
    if !call_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':'))
    {
        return Err(LifecycleError::new(
            codes::INVALID_CALL_ID,
            "call id may only contain ASCII letters, digits, '-', '_', '.', ':'",
        ));
    }
    Ok(())
}

fn validate_code(code: &str) -> Result<(), LifecycleError> {
    if code.is_empty() || code.len() > MAX_CODE_LEN {
        return Err(LifecycleError::new(
            codes::INVALID_RECEIPT,
            format!("code must be 1..={MAX_CODE_LEN} bytes"),
        ));
    }
    let first = code.chars().next().ok_or_else(|| {
        LifecycleError::new(codes::INVALID_RECEIPT, "code must not be empty")
    })?;
    if !first.is_ascii_alphanumeric() {
        return Err(LifecycleError::new(
            codes::INVALID_RECEIPT,
            "code must start with an ASCII letter or digit",
        ));
    }
    if !code
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':'))
    {
        return Err(LifecycleError::new(
            codes::INVALID_RECEIPT,
            "code may only contain ASCII letters, digits, '-', '_', '.', ':'",
        ));
    }
    Ok(())
}

fn validate_screen_id(screen_id: &str) -> Result<(), LifecycleError> {
    if screen_id.is_empty() || screen_id.len() > MAX_SCREEN_ID_LEN {
        return Err(LifecycleError::new(
            codes::INVALID_RECEIPT,
            format!("screen id must be 1..={MAX_SCREEN_ID_LEN} bytes"),
        ));
    }
    if screen_id.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(LifecycleError::new(
            codes::INVALID_RECEIPT,
            "screen id must not contain whitespace or control characters",
        ));
    }
    Ok(())
}

fn validate_diagnostic(diagnostic: &str) -> Result<(), LifecycleError> {
    if diagnostic.len() > MAX_DIAGNOSTIC_LEN {
        return Err(LifecycleError::new(
            codes::INVALID_RECEIPT,
            format!("diagnostic must be at most {MAX_DIAGNOSTIC_LEN} bytes"),
        ));
    }
    if diagnostic.chars().any(|c| c == '\0') {
        return Err(LifecycleError::new(
            codes::INVALID_RECEIPT,
            "diagnostic must not contain NUL",
        ));
    }
    Ok(())
}

fn validate_data(data: &serde_json::Value) -> Result<(), LifecycleError> {
    let encoded = serde_json::to_vec(data).map_err(|error| {
        LifecycleError::new(codes::INVALID_RECEIPT, format!("data is not serializable: {error}"))
    })?;
    if encoded.len() > MAX_DATA_BYTES {
        return Err(LifecycleError::new(
            codes::INVALID_RECEIPT,
            format!("data must be at most {MAX_DATA_BYTES} serialized bytes"),
        ));
    }
    Ok(())
}

fn unknown_receipt(code: &str, diagnostic: &str) -> Result<Receipt, LifecycleError> {
    let receipt = Receipt::new(false, code, Executed::Unknown, None)?;
    if diagnostic.is_empty() {
        Ok(receipt)
    } else {
        receipt.with_diagnostic(diagnostic)
    }
}

fn recover_state(state: &mut State) -> Result<bool, LifecycleError> {
    let mut changed = false;
    for record in state.records.values_mut() {
        let (code, diagnostic) = match record.phase {
            Phase::Prepared => (
                receipt_codes::RECOVERED_BEFORE_DISPATCH,
                "process restarted before dispatch evidence was recorded",
            ),
            Phase::Dispatching => (
                receipt_codes::RECOVERED_UNSETTLED,
                "process restarted before the dispatch was settled",
            ),
            Phase::Settled | Phase::Unknown | Phase::Cancelled => continue,
        };
        record.phase = Phase::Unknown;
        record.receipt = Some(unknown_receipt(code, diagnostic)?);
        changed = true;
    }
    Ok(changed)
}

fn encode_state(state: &State, limits: Limits) -> Result<Vec<u8>, LifecycleError> {
    if state.records.len() > limits.max_records {
        return Err(LifecycleError::new(
            codes::JOURNAL_TOO_LARGE,
            format!(
                "journal holds {} records, limit is {}",
                state.records.len(),
                limits.max_records
            ),
        ));
    }
    let stored = StoredState {
        version: STATE_VERSION,
        records: state.records.values().cloned().collect(),
    };
    let bytes = serde_json::to_vec(&stored).map_err(|error| {
        LifecycleError::new(
            codes::JOURNAL_WRITE_FAILED,
            format!("could not serialize journal: {error}"),
        )
    })?;
    if bytes.len() > limits.max_journal_bytes {
        return Err(LifecycleError::new(
            codes::JOURNAL_TOO_LARGE,
            format!(
                "serialized journal is {} bytes, limit is {}",
                bytes.len(),
                limits.max_journal_bytes
            ),
        ));
    }
    Ok(bytes)
}

fn decode_state(bytes: &[u8], limits: Limits) -> Result<State, LifecycleError> {
    if bytes.len() > limits.max_journal_bytes {
        return Err(LifecycleError::new(
            codes::JOURNAL_TOO_LARGE,
            format!(
                "journal is {} bytes, limit is {}",
                bytes.len(),
                limits.max_journal_bytes
            ),
        ));
    }
    let stored: StoredState = serde_json::from_slice(bytes)
        .map_err(|error| corrupt(format!("could not parse journal: {error}")))?;
    if stored.version != STATE_VERSION {
        return Err(corrupt(format!(
            "unsupported journal version {}, expected {STATE_VERSION}",
            stored.version
        )));
    }
    if stored.records.len() > limits.max_records {
        return Err(LifecycleError::new(
            codes::JOURNAL_TOO_LARGE,
            format!(
                "journal holds {} records, limit is {}",
                stored.records.len(),
                limits.max_records
            ),
        ));
    }

    let mut state = State { records: BTreeMap::new() };
    for record in stored.records {
        validate_call_id(&record.call_id)
            .map_err(|error| corrupt(format!("invalid stored call id: {}", error.detail())))?;
        let fingerprint = Fingerprint(record.fingerprint.clone());
        if !fingerprint.is_valid() {
            return Err(corrupt(format!(
                "stored fingerprint for {} is not 64 lowercase hex characters",
                record.call_id
            )));
        }
        if state.records.contains_key(&record.call_id) {
            return Err(corrupt(format!(
                "journal contains duplicate call id {}",
                record.call_id
            )));
        }
        match record.phase {
            Phase::Prepared | Phase::Dispatching => {
                if record.receipt.is_some() {
                    return Err(corrupt(format!(
                        "call {} is {} but already has a receipt",
                        record.call_id, "unsettled"
                    )));
                }
            }
            Phase::Settled => {
                let receipt = record.receipt.as_ref().ok_or_else(|| {
                    corrupt(format!("settled call {} has no receipt", record.call_id))
                })?;
                if receipt.ok() && receipt.executed() != Executed::Yes {
                    return Err(corrupt(format!(
                        "settled call {} cannot be ok unless executed=yes",
                        record.call_id
                    )));
                }
            }
            Phase::Unknown => {
                let receipt = record.receipt.as_ref().ok_or_else(|| {
                    corrupt(format!("unknown call {} has no receipt", record.call_id))
                })?;
                if receipt.executed() != Executed::Unknown || receipt.ok() {
                    return Err(corrupt(format!(
                        "unknown call {} must be executed=unknown and not ok",
                        record.call_id
                    )));
                }
            }
            Phase::Cancelled => {
                let receipt = record.receipt.as_ref().ok_or_else(|| {
                    corrupt(format!("cancelled call {} has no receipt", record.call_id))
                })?;
                if receipt.executed() != Executed::No || receipt.ok() {
                    return Err(corrupt(format!(
                        "cancelled call {} must be executed=no and not ok",
                        record.call_id
                    )));
                }
            }
        }
        state.records.insert(record.call_id.clone(), record);
    }
    Ok(state)
}
