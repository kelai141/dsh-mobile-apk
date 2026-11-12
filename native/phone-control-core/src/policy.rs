//! 有界原生控制策略。
//!
//! 本模块只拥有可执行策略：操作目录、屏幕事实代次、用户范围、通道授权与
//! 派发前重验。它不接触 Android、JNI、文件、进程或真实副作用。Kotlin 侧只上报
//! Android 事实并执行已经通过本模块的计划。
//!
//! 稳定规则：
//! - revision 只在事实变化时增加；同一事实的时间刷新不改变 revision。
//! - 屏幕 alias 的 displayId、逻辑尺寸或 rotation 变化，以及销毁后重建，都会
//!   得到新的 generation。旧计划不能跨 generation 复活。
//! - unknown 事实保持 unknown，不折平成 false。无法证明可用时拒绝派发。
//! - browser* 与 web* 是应用内工作台目标，不套 Android 显示屏范围门。
//! - 基础屏幕操作优先 A11y；Shizuku 兜底必须携带明确的“未派发”证据和限定原因。
//! - uid 2000 与 uid 0 分开建模。uid 0 需要独立 Root 授权与有效同意，基础控制
//!   不得借此自动升级；本模块也不提供 su 路径。

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use serde::{Deserialize, Serialize};

/// 同时存在的屏幕上限。
pub const MAX_SCREENS: usize = 8;
/// 单边逻辑尺寸上限，防止畸形事实进入坐标运算。
pub const MAX_DIMENSION: u32 = 16_384;

/// 真值三态。`Unknown` 永远不能当作 `No` 使用。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tri {
    #[default]
    Unknown,
    Yes,
    No,
}

impl Tri {
    pub fn is_yes(self) -> bool {
        self == Self::Yes
    }

    pub fn is_no(self) -> bool {
        self == Self::No
    }
}

/// 用户对模型可见屏幕范围的选择。wire 值由设置页与旧实现共享。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Scope {
    #[default]
    VirtualOnly,
    RealOnly,
    All,
}

impl Scope {
    pub const fn wire(self) -> &'static str {
        match self {
            Self::VirtualOnly => "virtual-only",
            Self::RealOnly => "real-only",
            Self::All => "all",
        }
    }

    /// 未知、缺省或损坏值一律回到最小权限 `virtual-only`。
    pub fn from_wire(value: Option<&str>) -> Self {
        match value {
            Some("real-only") => Self::RealOnly,
            Some("all") => Self::All,
            Some("virtual-only") | None | Some(_) => Self::VirtualOnly,
        }
    }

    /// 该用户范围是否包含稳定产品 alias。
    pub fn allows(self, alias: &str) -> bool {
        match self {
            Self::VirtualOnly => is_virtual_alias(alias),
            Self::RealOnly => alias == REAL_ALIAS,
            Self::All => alias == REAL_ALIAS || is_virtual_alias(alias),
        }
    }
}

impl Serialize for Scope {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(self.wire())
    }
}

impl<'de> Deserialize<'de> for Scope {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = serde_json::Value::deserialize(deserializer)?;
        Ok(Self::from_wire(value.as_str()))
    }
}

/// 真实屏的固定 alias。
pub const REAL_ALIAS: &str = "real";
/// 真实屏的固定 display id。
pub const REAL_DISPLAY_ID: i32 = 0;

/// 虚拟屏 alias 编号的最大十进制长度。外部语义是 virtual-N，没有 999 上限；
/// 这里只做输入边界与溢出保护。
pub const MAX_VIRTUAL_ALIAS_LEN: usize = 20;

/// virtual-N 的序号。只接受非零十进制、无前导零、无正负号、长度有界且
/// u64 可解析的编号；alias 是否真实存在仍由注册表决定。
pub fn virtual_alias_ordinal(alias: &str) -> Option<u64> {
    let rest = alias.strip_prefix("virtual-")?;
    if rest.is_empty()
        || rest.len() > MAX_VIRTUAL_ALIAS_LEN
        || rest.starts_with('0')
        || !rest.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    rest.parse::<u64>().ok().filter(|value| *value != 0)
}

/// 只接受有界 virtual-N，不接受前导零、零号或其它目标词。
pub fn is_virtual_alias(alias: &str) -> bool {
    virtual_alias_ordinal(alias).is_some()
}

/// Android 上报的单个屏幕不可变事实。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScreenFacts {
    pub display_id: i32,
    pub width: u32,
    pub height: u32,
    pub rotation: u8,
}

impl ScreenFacts {
    pub const fn new(display_id: i32, width: u32, height: u32, rotation: u8) -> Self {
        Self { display_id, width, height, rotation }
    }
}

/// 策略认可的屏幕绑定。generation 由本模块分配。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScreenBinding {
    pub alias: String,
    pub display_id: i32,
    pub width: u32,
    pub height: u32,
    pub rotation: u8,
    pub generation: u64,
}

/// 某通道声称支持哪些 op。整体未知与“已探明不支持”分开。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum OpSet {
    #[default]
    Unknown,
    Known(BTreeSet<String>),
}

impl OpSet {
    pub fn known<I, S>(values: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self::Known(values.into_iter().map(Into::into).collect())
    }

    pub fn contains(&self, op: &str) -> Tri {
        match self {
            Self::Unknown => Tri::Unknown,
            Self::Known(values) if values.contains(op) => Tri::Yes,
            Self::Known(_) => Tri::No,
        }
    }
}

/// displayId 支持表。整表未知与已知但不含该 display 分开。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum DisplaySupport {
    #[default]
    Unknown,
    Known(BTreeMap<i32, bool>),
}

impl DisplaySupport {
    pub fn known<I>(values: I) -> Self
    where
        I: IntoIterator<Item = (i32, bool)>,
    {
        Self::Known(values.into_iter().collect())
    }

    pub fn contains(&self, display_id: i32) -> Tri {
        match self {
            Self::Unknown => Tri::Unknown,
            Self::Known(values) if values.get(&display_id).copied().unwrap_or(false) => Tri::Yes,
            Self::Known(_) => Tri::No,
        }
    }
}

/// A11y 通道事实。每个字段独立，unknown 不折平。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct A11yFacts {
    pub enabled: Tri,
    pub online: Tri,
    pub supported_ops: OpSet,
    pub display_support: DisplaySupport,
}

impl A11yFacts {
    pub fn ready(ops: &[&str], displays: &[(i32, bool)]) -> Self {
        Self {
            enabled: Tri::Yes,
            online: Tri::Yes,
            supported_ops: OpSet::known(ops.iter().copied()),
            display_support: DisplaySupport::known(displays.iter().copied()),
        }
    }
}

/// Shizuku 服务端身份。不能用“是否等于 0”的单个布尔值代替。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum ServerUid {
    #[default]
    Unknown,
    Shell2000,
    Root0,
    Other(i32),
}

impl ServerUid {
    pub fn from_observed(uid: Option<i32>) -> Self {
        match uid {
            Some(2000) => Self::Shell2000,
            Some(0) => Self::Root0,
            Some(other) => Self::Other(other),
            None => Self::Unknown,
        }
    }
}

/// Shizuku 通道事实。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShizukuFacts {
    pub installed: Tri,
    pub running: Tri,
    pub granted: Tri,
    pub bound: Tri,
    pub functional_ready: Tri,
    pub server_uid: ServerUid,
    pub supported_ops: OpSet,
    pub display_support: DisplaySupport,
}

impl ShizukuFacts {
    pub fn ready(server_uid: ServerUid, ops: &[&str], displays: &[(i32, bool)]) -> Self {
        Self {
            installed: Tri::Yes,
            running: Tri::Yes,
            granted: Tri::Yes,
            bound: Tri::Yes,
            functional_ready: Tri::Yes,
            server_uid,
            supported_ops: OpSet::known(ops.iter().copied()),
            display_support: DisplaySupport::known(displays.iter().copied()),
        }
    }
}

/// Root 是独立授权，不由 A11y 或普通 Shizuku 状态推断。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RootFacts {
    pub authorization: Tri,
    pub consent_valid: Tri,
}

impl RootFacts {
    pub fn granted() -> Self {
        Self { authorization: Tri::Yes, consent_valid: Tri::Yes }
    }
}

/// 操作的目标域。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TargetDomain {
    /// 真实或虚拟 Android 显示屏上的内容 op。
    AndroidDisplay,
    /// 虚拟屏模型访问面。
    VirtualDisplay,
    /// 应用内浏览器工作台。
    BrowserWorkspace,
    /// 应用主 WebView。
    AppWebView,
    /// 控制核心内存状态或等待。
    ControlMemory,
    /// 特权 shell 通道。
    PrivilegedShell,
}

/// 后端要求。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BackendRequirement {
    /// 基础屏幕 op：A11y 优先；仅在已证实未派发时允许 Shizuku 兜底。
    A11yPreferred,
    /// 需要 A11y 提供的内存事实，不允许换到 Shizuku。
    A11yRequired,
    /// Shizuku 专属，不因 A11y 优先规则被误拦。
    ShizukuRequired,
    /// 壳内浏览器工作台。
    BrowserHost,
    /// 壳内 WebView。
    WebViewHost,
    /// 纯本地等待。
    LocalOnly,
    /// 已登记但未实现，必须拒绝。
    Unsupported,
}

/// 范围检查类别。每个 op 都显式登记，不由名字批量推断。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScopePolicy {
    /// 真实或虚拟屏内容：目标必须已登记，且范围包含该 alias。
    ScreenContent,
    /// 虚拟屏命名空间（创建/状态）：范围必须允许虚拟屏。
    VirtualNamespace,
    /// 目标虚拟屏必须已登记，且范围包含该 alias。
    RegisteredVirtual,
    /// 应用内工作台，不套 Android 显示屏范围门。
    NotScreenScoped,
}

/// 单源操作目录中的一条记录。
#[derive(Clone, Copy, Debug)]
pub struct OperationSpec {
    pub name: &'static str,
    pub target_domain: TargetDomain,
    pub backend: BackendRequirement,
    pub scope_policy: ScopePolicy,
    /// 是否读取 Android 设备显示内容。
    pub reads_device_display: bool,
}

const fn spec(
    name: &'static str,
    target_domain: TargetDomain,
    backend: BackendRequirement,
    scope_policy: ScopePolicy,
    reads_device_display: bool,
) -> OperationSpec {
    OperationSpec { name, target_domain, backend, scope_policy, reads_device_display }
}

/// 原生 op 语义单源目录。这里只描述原生语义与后端要求，不定义模型工具 schema。
pub static OPERATIONS: &[OperationSpec] = &[
    spec("snapshot", TargetDomain::AndroidDisplay, BackendRequirement::A11yPreferred, ScopePolicy::ScreenContent, true),
    spec("click", TargetDomain::AndroidDisplay, BackendRequirement::A11yPreferred, ScopePolicy::ScreenContent, true),
    spec("longClick", TargetDomain::AndroidDisplay, BackendRequirement::A11yPreferred, ScopePolicy::ScreenContent, true),
    spec("setText", TargetDomain::AndroidDisplay, BackendRequirement::A11yPreferred, ScopePolicy::ScreenContent, true),
    spec("scroll", TargetDomain::AndroidDisplay, BackendRequirement::A11yPreferred, ScopePolicy::ScreenContent, true),
    spec("global", TargetDomain::AndroidDisplay, BackendRequirement::A11yPreferred, ScopePolicy::ScreenContent, true),
    spec("screenshot", TargetDomain::AndroidDisplay, BackendRequirement::A11yPreferred, ScopePolicy::ScreenContent, true),
    spec("nodeText", TargetDomain::AndroidDisplay, BackendRequirement::A11yPreferred, ScopePolicy::ScreenContent, true),
    spec("readRegion", TargetDomain::AndroidDisplay, BackendRequirement::A11yPreferred, ScopePolicy::ScreenContent, true),
    spec("state", TargetDomain::ControlMemory, BackendRequirement::A11yRequired, ScopePolicy::NotScreenScoped, false),
    spec("wait", TargetDomain::ControlMemory, BackendRequirement::LocalOnly, ScopePolicy::NotScreenScoped, false),
    spec("webSnapshot", TargetDomain::AppWebView, BackendRequirement::WebViewHost, ScopePolicy::NotScreenScoped, false),
    spec("webAction", TargetDomain::AppWebView, BackendRequirement::WebViewHost, ScopePolicy::NotScreenScoped, false),
    spec("browserCaps", TargetDomain::BrowserWorkspace, BackendRequirement::BrowserHost, ScopePolicy::NotScreenScoped, false),
    spec("browserShow", TargetDomain::BrowserWorkspace, BackendRequirement::BrowserHost, ScopePolicy::NotScreenScoped, false),
    spec("browserHide", TargetDomain::BrowserWorkspace, BackendRequirement::BrowserHost, ScopePolicy::NotScreenScoped, false),
    spec("browserClose", TargetDomain::BrowserWorkspace, BackendRequirement::BrowserHost, ScopePolicy::NotScreenScoped, false),
    spec("browserOpen", TargetDomain::BrowserWorkspace, BackendRequirement::BrowserHost, ScopePolicy::NotScreenScoped, false),
    spec("browserJs", TargetDomain::BrowserWorkspace, BackendRequirement::BrowserHost, ScopePolicy::NotScreenScoped, false),
    spec("browserInput", TargetDomain::BrowserWorkspace, BackendRequirement::BrowserHost, ScopePolicy::NotScreenScoped, false),
    spec("browserShot", TargetDomain::BrowserWorkspace, BackendRequirement::BrowserHost, ScopePolicy::NotScreenScoped, false),
    spec("browserState", TargetDomain::BrowserWorkspace, BackendRequirement::BrowserHost, ScopePolicy::NotScreenScoped, false),
    spec("browserSetUa", TargetDomain::BrowserWorkspace, BackendRequirement::BrowserHost, ScopePolicy::NotScreenScoped, false),
    spec("browserViewport", TargetDomain::BrowserWorkspace, BackendRequirement::BrowserHost, ScopePolicy::NotScreenScoped, false),
    spec("browserTabs", TargetDomain::BrowserWorkspace, BackendRequirement::BrowserHost, ScopePolicy::NotScreenScoped, false),
    spec("browserFollowTab", TargetDomain::BrowserWorkspace, BackendRequirement::BrowserHost, ScopePolicy::NotScreenScoped, false),
    spec("browserCloseTab", TargetDomain::BrowserWorkspace, BackendRequirement::BrowserHost, ScopePolicy::NotScreenScoped, false),
    spec("vdCreate", TargetDomain::VirtualDisplay, BackendRequirement::ShizukuRequired, ScopePolicy::VirtualNamespace, false),
    spec("vdDestroy", TargetDomain::VirtualDisplay, BackendRequirement::ShizukuRequired, ScopePolicy::RegisteredVirtual, false),
    spec("vdLaunch", TargetDomain::VirtualDisplay, BackendRequirement::ShizukuRequired, ScopePolicy::RegisteredVirtual, false),
    spec("vdLaunchApp", TargetDomain::VirtualDisplay, BackendRequirement::ShizukuRequired, ScopePolicy::RegisteredVirtual, false),
    spec("vdInput", TargetDomain::VirtualDisplay, BackendRequirement::ShizukuRequired, ScopePolicy::RegisteredVirtual, false),
    spec("vdInfo", TargetDomain::VirtualDisplay, BackendRequirement::ShizukuRequired, ScopePolicy::VirtualNamespace, false),
    spec("vdMoveTask", TargetDomain::VirtualDisplay, BackendRequirement::Unsupported, ScopePolicy::RegisteredVirtual, false),
    spec("shExec", TargetDomain::PrivilegedShell, BackendRequirement::ShizukuRequired, ScopePolicy::NotScreenScoped, false),
    spec("shPull", TargetDomain::PrivilegedShell, BackendRequirement::ShizukuRequired, ScopePolicy::NotScreenScoped, false),
    spec("shPush", TargetDomain::PrivilegedShell, BackendRequirement::ShizukuRequired, ScopePolicy::NotScreenScoped, false),
    spec("shRemove", TargetDomain::PrivilegedShell, BackendRequirement::ShizukuRequired, ScopePolicy::NotScreenScoped, false),
];

impl OperationSpec {
    /// 精确匹配。未知名字必须拒绝，不能按前缀推断。
    pub fn for_name(name: &str) -> Option<&'static Self> {
        OPERATIONS.iter().find(|entry| entry.name == name)
    }
}

/// 计划请求的目标。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TargetRequest {
    Real,
    Virtual(String),
    NewVirtual(String),
    BrowserWorkspace,
    AppWebView,
    ControlMemory,
    PrivilegedShell,
}

/// 计划中固定的目标。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PlanTarget {
    AndroidScreen(ScreenBinding),
    VirtualCreation { alias: String },
    BrowserWorkspace,
    AppWebView,
    ControlMemory,
    PrivilegedShell,
}

impl PlanTarget {
    pub fn screen(&self) -> Option<&ScreenBinding> {
        match self {
            Self::AndroidScreen(binding) => Some(binding),
            _ => None,
        }
    }

    pub fn alias(&self) -> Option<&str> {
        match self {
            Self::AndroidScreen(binding) => Some(&binding.alias),
            Self::VirtualCreation { alias } => Some(alias),
            _ => None,
        }
    }
}

/// 计划选定的执行后端。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Backend {
    A11y,
    Shizuku,
    Root,
    BrowserHost,
    WebViewHost,
    Local,
}

/// 已通过范围与事实检查的派发计划。
#[derive(Clone, Debug)]
pub struct DispatchPlan {
    pub op: &'static str,
    pub epoch: u64,
    pub target: PlanTarget,
    pub scope_generation: Option<u64>,
    pub authorization_generation: Option<u64>,
    pub backend: Backend,
}

impl DispatchPlan {
    pub fn screen(&self) -> Option<&ScreenBinding> {
        self.target.screen()
    }
}

/// 派发证据。`No` 表示平台明确证实没有产生副作用。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DispatchEvidence {
    No,
    Yes,
    Unknown,
}

/// 允许进入 A11y→Shizuku 兜底的有限失败原因。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DispatchFailure {
    ServiceOffline,
    PermissionMissing,
    OpUnsupported,
    TargetUnsupported,
    NodeNotFound,
    Timeout,
    Unknown,
    Error,
}

impl DispatchFailure {
    pub fn allows_fallback(self) -> bool {
        matches!(
            self,
            Self::ServiceOffline | Self::PermissionMissing | Self::OpUnsupported | Self::TargetUnsupported
        )
    }
}

/// 稳定策略错误。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PolicyError {
    code: &'static str,
    detail: String,
}

impl PolicyError {
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

impl fmt::Display for PolicyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.detail)
    }
}

impl std::error::Error for PolicyError {}

/// 本进程原生会话的策略状态。
#[derive(Clone, Debug)]
pub struct PolicyState {
    epoch: u64,
    revision: u64,
    scope: Scope,
    scope_generation: u64,
    authorization_generation: u64,
    screens: BTreeMap<String, ScreenBinding>,
    next_screen_generation: u64,
    a11y: A11yFacts,
    shizuku: ShizukuFacts,
    root: RootFacts,
    observed_at_ms: u64,
}

impl PolicyState {
    /// `epoch` 由创建该原生会话的壳侧传入，计划必须与它相同才可派发。
    pub fn new(epoch: u64) -> Self {
        Self {
            epoch,
            revision: 1,
            scope: Scope::VirtualOnly,
            scope_generation: 1,
            authorization_generation: 1,
            screens: BTreeMap::new(),
            next_screen_generation: 1,
            a11y: A11yFacts::default(),
            shizuku: ShizukuFacts::default(),
            root: RootFacts::default(),
            observed_at_ms: 0,
        }
    }

    pub fn epoch(&self) -> u64 {
        self.epoch
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn scope(&self) -> Scope {
        self.scope
    }

    pub fn scope_generation(&self) -> u64 {
        self.scope_generation
    }

    pub fn observed_at_ms(&self) -> u64 {
        self.observed_at_ms
    }

    pub fn a11y(&self) -> &A11yFacts {
        &self.a11y
    }

    pub fn shizuku(&self) -> &ShizukuFacts {
        &self.shizuku
    }

    pub fn root(&self) -> &RootFacts {
        &self.root
    }

    pub fn screen(&self, alias: &str) -> Option<&ScreenBinding> {
        self.screens.get(alias)
    }

    /// 只刷新观测时间，不改变任何事实、revision 或 generation。
    pub fn refresh_time(&mut self, observed_at_ms: u64) {
        self.observed_at_ms = observed_at_ms;
    }

    /// 设置用户范围。损坏 wire 值按 virtual-only 处理。
    pub fn set_scope(&mut self, scope: Scope) -> bool {
        if self.scope == scope {
            return false;
        }
        self.scope = scope;
        self.scope_generation = self.scope_generation.saturating_add(1);
        self.revision = self.revision.saturating_add(1);
        true
    }

    pub fn set_scope_wire(&mut self, value: Option<&str>) -> bool {
        self.set_scope(Scope::from_wire(value))
    }

    /// 上报一个屏幕的完整事实。同一 alias 的不可变事实变化会分配新 generation。
    pub fn observe_screen(&mut self, alias: &str, facts: ScreenFacts) -> Result<ScreenBinding, PolicyError> {
        validate_screen_facts(alias, facts)?;
        if let Some(current) = self.screens.get(alias) {
            if current.display_id == facts.display_id
                && current.width == facts.width
                && current.height == facts.height
                && current.rotation == facts.rotation
            {
                return Ok(current.clone());
            }
            let generation = self.next_screen_generation()?;
            let next = ScreenBinding {
                alias: alias.to_owned(),
                display_id: facts.display_id,
                width: facts.width,
                height: facts.height,
                rotation: facts.rotation,
                generation,
            };
            self.screens.insert(alias.to_owned(), next.clone());
            self.revision = self.revision.saturating_add(1);
            return Ok(next);
        }
        if self.screens.len() >= MAX_SCREENS {
            return Err(PolicyError::new("too-many-screens", format!("at most {MAX_SCREENS} screens are tracked")));
        }
        let generation = self.next_screen_generation()?;
        let binding = ScreenBinding {
            alias: alias.to_owned(),
            display_id: facts.display_id,
            width: facts.width,
            height: facts.height,
            rotation: facts.rotation,
            generation,
        };
        self.screens.insert(alias.to_owned(), binding.clone());
        self.revision = self.revision.saturating_add(1);
        Ok(binding)
    }

    /// 销毁屏幕。generation 计数器不回退，随后重建必然得到新 generation。
    pub fn destroy_screen(&mut self, alias: &str) -> bool {
        let removed = self.screens.remove(alias).is_some();
        if removed {
            self.revision = self.revision.saturating_add(1);
        }
        removed
    }

    pub fn set_a11y_facts(&mut self, facts: A11yFacts) -> bool {
        if self.a11y == facts {
            return false;
        }
        self.a11y = facts;
        self.authorization_generation = self.authorization_generation.saturating_add(1);
        self.revision = self.revision.saturating_add(1);
        true
    }

    pub fn set_shizuku_facts(&mut self, facts: ShizukuFacts) -> bool {
        if self.shizuku == facts {
            return false;
        }
        self.shizuku = facts;
        self.authorization_generation = self.authorization_generation.saturating_add(1);
        self.revision = self.revision.saturating_add(1);
        true
    }

    pub fn set_root_facts(&mut self, facts: RootFacts) -> bool {
        if self.root == facts {
            return false;
        }
        self.root = facts;
        self.authorization_generation = self.authorization_generation.saturating_add(1);
        self.revision = self.revision.saturating_add(1);
        true
    }

    /// Root 专属策略：必须是真实观测到的 uid 0，并有独立授权与有效同意。
    pub fn root_only_available(&self) -> bool {
        self.shizuku.server_uid == ServerUid::Root0
            && self.root.authorization.is_yes()
            && self.root.consent_valid.is_yes()
    }

    /// 为一次操作生成计划。所有范围与目标检查都发生在副作用之前。
    pub fn plan(&self, op: &str, target: TargetRequest) -> Result<DispatchPlan, PolicyError> {
        let spec = OperationSpec::for_name(op)
            .ok_or_else(|| PolicyError::new("op-unknown", format!("operation {op} is not registered")))?;
        if spec.backend == BackendRequirement::Unsupported {
            return Err(PolicyError::new("operation-unsupported", format!("{op} is registered but not implemented")));
        }

        let plan_target = self.resolve_target(spec, target)?;
        let scope_generation = match spec.scope_policy {
            ScopePolicy::ScreenContent
            | ScopePolicy::VirtualNamespace
            | ScopePolicy::RegisteredVirtual => Some(self.scope_generation),
            ScopePolicy::NotScreenScoped => None,
        };
        self.check_scope(spec, &plan_target)?;

        let backend = self.select_backend(spec, &plan_target)?;
        let authorization_generation = match spec.backend {
            BackendRequirement::A11yPreferred
            | BackendRequirement::A11yRequired
            | BackendRequirement::ShizukuRequired => Some(self.authorization_generation),
            _ => None,
        };

        Ok(DispatchPlan {
            op: spec.name,
            epoch: self.epoch,
            target: plan_target,
            scope_generation,
            authorization_generation,
            backend,
        })
    }

    /// 最终派发前重验。范围、屏幕代次、epoch 或授权任一变化都拒绝。
    pub fn revalidate(&self, plan: &DispatchPlan) -> Result<(), PolicyError> {
        let spec = OperationSpec::for_name(plan.op)
            .ok_or_else(|| PolicyError::new("op-unknown", format!("operation {} is not registered", plan.op)))?;
        if plan.epoch != self.epoch {
            return Err(PolicyError::new("epoch-mismatch", "plan belongs to another native session"));
        }
        if let Some(scope_generation) = plan.scope_generation {
            if scope_generation != self.scope_generation {
                return Err(PolicyError::new("scope-generation-mismatch", "screen scope changed after planning"));
            }
        }
        self.revalidate_target_and_scope(spec, plan)?;
        if let Some(scope_generation) = plan.scope_generation {
            if scope_generation != self.scope_generation {
                return Err(PolicyError::new("scope-generation-mismatch", "screen scope changed after planning"));
            }
        }
        if let Some(authorization_generation) = plan.authorization_generation {
            if authorization_generation != self.authorization_generation {
                return Err(PolicyError::new("authorization-changed", "channel or root authorization changed after planning"));
            }
        }
        Ok(())
    }

    /// A11y→Shizuku 兜底。必须明确传入“未派发”证据和有限失败原因。
    /// 失败计划的目标与代次必须仍然有效，且不能换屏。
    pub fn fallback_plan(
        &self,
        failed: &DispatchPlan,
        evidence: DispatchEvidence,
        failure: DispatchFailure,
    ) -> Result<DispatchPlan, PolicyError> {
        if evidence != DispatchEvidence::No {
            return Err(PolicyError::new("fallback-not-proven", "fallback requires evidence that no side effect was dispatched"));
        }
        if !failure.allows_fallback() {
            return Err(PolicyError::new("fallback-not-allowed", format!("{failure:?} cannot justify switching transport")));
        }
        if failed.backend != Backend::A11y {
            return Err(PolicyError::new("fallback-not-allowed", "only an A11y plan may fall back to Shizuku"));
        }
        let spec = OperationSpec::for_name(failed.op)
            .ok_or_else(|| PolicyError::new("op-unknown", format!("operation {} is not registered", failed.op)))?;
        if spec.backend != BackendRequirement::A11yPreferred {
            return Err(PolicyError::new("fallback-not-allowed", "this operation has no Shizuku equivalent"));
        }
        if failed.epoch != self.epoch {
            return Err(PolicyError::new("epoch-mismatch", "failed plan belongs to another native session"));
        }
        if let Some(scope_generation) = failed.scope_generation {
            if scope_generation != self.scope_generation {
                return Err(PolicyError::new("scope-generation-mismatch", "screen scope changed after a11y failure"));
            }
        }
        self.revalidate_target_and_scope(spec, failed)?;

        let backend = self.select_shizuku(spec, &failed.target, false)?;
        Ok(DispatchPlan {
            op: failed.op,
            epoch: self.epoch,
            target: failed.target.clone(),
            scope_generation: failed.scope_generation,
            authorization_generation: Some(self.authorization_generation),
            backend,
        })
    }

    /// 在计划原来的逻辑尺寸内校验点坐标。重验会先拒绝旧 generation。
    pub fn validate_point(&self, plan: &DispatchPlan, x: i32, y: i32) -> Result<(), PolicyError> {
        self.revalidate(plan)?;
        let binding = plan.screen().ok_or_else(|| PolicyError::new("target-domain-mismatch", "point coordinates need an Android screen plan"))?;
        if x < 0 || y < 0 || i64::from(x) >= i64::from(binding.width) || i64::from(y) >= i64::from(binding.height) {
            return Err(PolicyError::new("invalid-coordinate", format!("point ({x},{y}) is outside {}x{}", binding.width, binding.height)));
        }
        Ok(())
    }

    /// `readRegion(x1,y1,x2,y2)`：半开矩形，必须落在计划创建时的原始逻辑尺寸内。
    pub fn validate_region(
        &self,
        plan: &DispatchPlan,
        x1: i32,
        y1: i32,
        x2: i32,
        y2: i32,
    ) -> Result<(), PolicyError> {
        self.revalidate(plan)?;
        let binding = plan.screen().ok_or_else(|| PolicyError::new("target-domain-mismatch", "region reads need an Android screen plan"))?;
        if x1 < 0 || y1 < 0 || x2 <= x1 || y2 <= y1
            || i64::from(x2) > i64::from(binding.width)
            || i64::from(y2) > i64::from(binding.height)
        {
            return Err(PolicyError::new(
                "invalid-region",
                format!("region ({x1},{y1},{x2},{y2}) is outside {}x{}", binding.width, binding.height),
            ));
        }
        Ok(())
    }

    fn next_screen_generation(&mut self) -> Result<u64, PolicyError> {
        let generation = self.next_screen_generation;
        self.next_screen_generation = self
            .next_screen_generation
            .checked_add(1)
            .ok_or_else(|| PolicyError::new("generation-exhausted", "screen generation counter is exhausted"))?;
        Ok(generation)
    }

    fn resolve_target(&self, spec: &OperationSpec, target: TargetRequest) -> Result<PlanTarget, PolicyError> {
        match (spec.target_domain, spec.scope_policy, target) {
            (TargetDomain::AndroidDisplay, _, TargetRequest::Real) => {
                Ok(PlanTarget::AndroidScreen(self.require_screen(REAL_ALIAS)?))
            }
            (TargetDomain::AndroidDisplay, _, TargetRequest::Virtual(alias)) => {
                validate_alias(&alias)?;
                Ok(PlanTarget::AndroidScreen(self.require_screen(&alias)?))
            }
            (TargetDomain::VirtualDisplay, ScopePolicy::VirtualNamespace, TargetRequest::NewVirtual(alias)) => {
                validate_alias(&alias)?;
                if alias == REAL_ALIAS {
                    return Err(PolicyError::new("invalid-screen", "virtual creation needs a virtual alias"));
                }
                Ok(PlanTarget::VirtualCreation { alias })
            }
            (TargetDomain::VirtualDisplay, ScopePolicy::RegisteredVirtual, TargetRequest::Virtual(alias)) => {
                validate_alias(&alias)?;
                Ok(PlanTarget::AndroidScreen(self.require_screen(&alias)?))
            }
            (TargetDomain::BrowserWorkspace, _, TargetRequest::BrowserWorkspace) => Ok(PlanTarget::BrowserWorkspace),
            (TargetDomain::AppWebView, _, TargetRequest::AppWebView) => Ok(PlanTarget::AppWebView),
            (TargetDomain::ControlMemory, _, TargetRequest::ControlMemory) => Ok(PlanTarget::ControlMemory),
            (TargetDomain::PrivilegedShell, _, TargetRequest::PrivilegedShell) => Ok(PlanTarget::PrivilegedShell),
            _ => Err(PolicyError::new("target-domain-mismatch", format!("target does not match {} semantics", spec.name))),
        }
    }

    fn require_screen(&self, alias: &str) -> Result<ScreenBinding, PolicyError> {
        self.screens
            .get(alias)
            .cloned()
            .ok_or_else(|| PolicyError::new("unknown-target", format!("screen {alias} is not registered")))
    }

    fn check_scope(&self, spec: &OperationSpec, target: &PlanTarget) -> Result<(), PolicyError> {
        match spec.scope_policy {
            ScopePolicy::ScreenContent | ScopePolicy::RegisteredVirtual => {
                let alias = target
                    .alias()
                    .ok_or_else(|| PolicyError::new("target-domain-mismatch", "screen operation has no alias"))?;
                if !self.scope.allows(alias) {
                    return Err(PolicyError::new(
                        "screen-out-of-scope",
                        format!("scope {} does not allow {alias}", self.scope.wire()),
                    ));
                }
            }
            ScopePolicy::VirtualNamespace => {
                if !matches!(self.scope, Scope::VirtualOnly | Scope::All) {
                    return Err(PolicyError::new(
                        "screen-out-of-scope",
                        format!("scope {} does not allow virtual displays", self.scope.wire()),
                    ));
                }
            }
            ScopePolicy::NotScreenScoped => {}
        }
        Ok(())
    }

    fn revalidate_target_and_scope(&self, spec: &OperationSpec, plan: &DispatchPlan) -> Result<(), PolicyError> {
        match (&plan.target, spec.scope_policy) {
            (PlanTarget::AndroidScreen(binding), ScopePolicy::ScreenContent | ScopePolicy::RegisteredVirtual) => {
                let current = self.screens.get(&binding.alias).ok_or_else(|| {
                    PolicyError::new("target-generation-mismatch", format!("screen {} is no longer registered", binding.alias))
                })?;
                if current != binding {
                    return Err(PolicyError::new(
                        "target-generation-mismatch",
                        format!("screen {} facts or generation changed after planning", binding.alias),
                    ));
                }
                if !self.scope.allows(&binding.alias) {
                    return Err(PolicyError::new(
                        "screen-out-of-scope",
                        format!("scope {} no longer allows {}", self.scope.wire(), binding.alias),
                    ));
                }
            }
            (PlanTarget::VirtualCreation { alias }, ScopePolicy::VirtualNamespace) => {
                if !matches!(self.scope, Scope::VirtualOnly | Scope::All) {
                    return Err(PolicyError::new(
                        "screen-out-of-scope",
                        format!("scope {} no longer allows virtual displays", self.scope.wire()),
                    ));
                }
                if !is_virtual_alias(alias) {
                    return Err(PolicyError::new("invalid-screen", format!("bad virtual alias {alias}")));
                }
            }
            (PlanTarget::BrowserWorkspace, ScopePolicy::NotScreenScoped) => {}
            (PlanTarget::AppWebView, ScopePolicy::NotScreenScoped) => {}
            (PlanTarget::ControlMemory, ScopePolicy::NotScreenScoped) => {}
            (PlanTarget::PrivilegedShell, ScopePolicy::NotScreenScoped) => {}
            _ => return Err(PolicyError::new("target-domain-mismatch", "plan target no longer matches operation semantics")),
        }
        Ok(())
    }

    fn select_backend(&self, spec: &OperationSpec, target: &PlanTarget) -> Result<Backend, PolicyError> {
        match spec.backend {
            BackendRequirement::BrowserHost => Ok(Backend::BrowserHost),
            BackendRequirement::WebViewHost => Ok(Backend::WebViewHost),
            BackendRequirement::LocalOnly => Ok(Backend::Local),
            BackendRequirement::Unsupported => {
                Err(PolicyError::new("operation-unsupported", format!("{} is not implemented", spec.name)))
            }
            BackendRequirement::A11yRequired => match self.a11y_verdict(spec, target) {
                Tri::Yes => Ok(Backend::A11y),
                Tri::No => Err(PolicyError::new("channel-unavailable", "A11y is not usable for this operation")),
                Tri::Unknown => Err(PolicyError::new("facts-unknown", "A11y capability is still unknown")),
            },
            BackendRequirement::A11yPreferred => match self.a11y_verdict(spec, target) {
                Tri::Yes => Ok(Backend::A11y),
                Tri::Unknown => Err(PolicyError::new("facts-unknown", "A11y capability is unknown; refusing to guess or fall back")),
                Tri::No => self.select_shizuku(spec, target, false),
            },
            BackendRequirement::ShizukuRequired => self.select_shizuku(spec, target, true),
        }
    }

    fn a11y_verdict(&self, spec: &OperationSpec, target: &PlanTarget) -> Tri {
        let mut facts = Vec::with_capacity(4);
        facts.push(self.a11y.enabled);
        facts.push(self.a11y.online);
        facts.push(self.a11y.supported_ops.contains(spec.name));
        if spec.target_domain == TargetDomain::AndroidDisplay {
            if let Some(binding) = target.screen() {
                facts.push(self.a11y.display_support.contains(binding.display_id));
            } else {
                facts.push(Tri::Unknown);
            }
        }
        combine_verdicts(&facts)
    }

    fn select_shizuku(&self, spec: &OperationSpec, target: &PlanTarget, allow_root: bool) -> Result<Backend, PolicyError> {
        let readiness = combine_verdicts(&[
            self.shizuku.installed,
            self.shizuku.running,
            self.shizuku.granted,
            self.shizuku.bound,
            self.shizuku.functional_ready,
        ]);
        match readiness {
            Tri::Yes => {}
            Tri::No => return Err(PolicyError::new("channel-unavailable", "Shizuku is not functional")),
            Tri::Unknown => return Err(PolicyError::new("facts-unknown", "Shizuku readiness is still unknown")),
        }

        match self.shizuku.supported_ops.contains(spec.name) {
            Tri::Yes => {}
            Tri::No => return Err(PolicyError::new("shizuku-unsupported", format!("Shizuku does not support {}", spec.name))),
            Tri::Unknown => return Err(PolicyError::new("facts-unknown", "Shizuku operation support is unknown")),
        }

        if spec.target_domain == TargetDomain::AndroidDisplay {
            if let Some(binding) = target.screen() {
                match self.shizuku.display_support.contains(binding.display_id) {
                    Tri::Yes => {}
                    Tri::No => return Err(PolicyError::new("target-unsupported", "Shizuku cannot target this display")),
                    Tri::Unknown => return Err(PolicyError::new("facts-unknown", "Shizuku display support is unknown")),
                }
            }
        }

        match self.shizuku.server_uid {
            ServerUid::Shell2000 => Ok(Backend::Shizuku),
            ServerUid::Root0 if allow_root => {
                let root = combine_verdicts(&[self.root.authorization, self.root.consent_valid]);
                match root {
                    Tri::Yes => Ok(Backend::Root),
                    Tri::No => Err(PolicyError::new("root-authorization-required", "uid 0 needs independent Root authorization and valid consent")),
                    Tri::Unknown => Err(PolicyError::new("facts-unknown", "Root authorization is unknown")),
                }
            }
            ServerUid::Root0 => Err(PolicyError::new(
                "root-channel-not-allowed",
                "basic screen control may not silently use a uid 0 channel",
            )),
            ServerUid::Other(uid) => Err(PolicyError::new("channel-unavailable", format!("unsupported Shizuku server uid {uid}"))),
            ServerUid::Unknown => Err(PolicyError::new("facts-unknown", "Shizuku server uid is unknown")),
        }
    }
}

fn combine_verdicts(values: &[Tri]) -> Tri {
    if values.iter().any(|value| value.is_no()) {
        Tri::No
    } else if values.iter().all(|value| value.is_yes()) {
        Tri::Yes
    } else {
        Tri::Unknown
    }
}

fn validate_alias(alias: &str) -> Result<(), PolicyError> {
    if alias == REAL_ALIAS || is_virtual_alias(alias) {
        Ok(())
    } else {
        Err(PolicyError::new("unknown-target", format!("{alias} is not a stable screen alias")))
    }
}

fn validate_screen_facts(alias: &str, facts: ScreenFacts) -> Result<(), PolicyError> {
    validate_alias(alias)?;
    if facts.width == 0 || facts.width > MAX_DIMENSION || facts.height == 0 || facts.height > MAX_DIMENSION {
        return Err(PolicyError::new(
            "invalid-dimensions",
            format!("logical size {}x{} is outside 1..={MAX_DIMENSION}", facts.width, facts.height),
        ));
    }
    if facts.rotation > 3 {
        return Err(PolicyError::new("invalid-rotation", "rotation must be 0..=3"));
    }
    if alias == REAL_ALIAS {
        if facts.display_id != REAL_DISPLAY_ID {
            return Err(PolicyError::new("invalid-screen", "real screen must use display 0"));
        }
    } else if facts.display_id <= REAL_DISPLAY_ID {
        return Err(PolicyError::new("invalid-screen", "virtual screen needs a positive display id"));
    }
    Ok(())
}
