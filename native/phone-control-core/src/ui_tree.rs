//! 有界原始 UI 树、快照、ref 与 selector 状态。
//!
//! Kotlin 只提供某一次真实窗口采集到的原始节点；本模块拥有快照身份、ref 分配、
//! 精确 selector 和动作前身份核对。ref 不能由上层拼接，节点动作也只能回到原始
//! child path，不做文本模糊匹配、祖先替换或按数组位置猜节点。

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::policy::ScreenBinding;

/// 单次采集最多接收的节点数。
pub const MAX_NODES: usize = 4_000;
/// 所有节点身份字符串的 UTF-8 字节总量上限。
pub const MAX_TOTAL_TEXT_BYTES: usize = 1_048_576;
/// 单个身份字符串的 UTF-8 字节上限。
pub const MAX_FIELD_BYTES: usize = 65_536;
/// 从根开始的真实 child path 长度上限。
pub const MAX_DEPTH: usize = 64;
/// 同时缓存快照的屏幕上限。
pub const MAX_SCREENS: usize = 8;
/// 屏幕 id 的最大字符数，与 Kotlin 的 RawTarget 相同。
pub const MAX_SCREEN_ID_CHARS: usize = 128;
/// 默认模型交付的 JSON UTF-8 字节上限；不含外层 IPC 信封。
pub const MAX_COMPACT_JSON_BYTES: usize = 2 * 1024 * 1024;

// u64 身份 token 在 wire 上始终是十进制字符串，避免 JS number 丢失精度。
fn serialize_u64_token<S: serde::Serializer>(value: &u64, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.collect_str(value)
}

/// 校验或解析失败。`code` 稳定，供桥接层直接回报。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UiTreeError {
    code: &'static str,
    detail: String,
}

impl UiTreeError {
    pub fn new(code: &'static str, detail: impl Into<String>) -> Self {
        Self { code, detail: detail.into() }
    }

    pub fn code(&self) -> &'static str {
        self.code
    }

    pub fn detail(&self) -> &str {
        &self.detail
    }

    pub fn to_json(&self) -> String {
        json!({ "ok": false, "code": self.code, "detail": self.detail }).to_string()
    }
}

impl fmt::Display for UiTreeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.detail)
    }
}

impl std::error::Error for UiTreeError {}

fn fail<T>(code: &'static str, detail: impl Into<String>) -> Result<T, UiTreeError> {
    Err(UiTreeError::new(code, detail))
}

/// Kotlin `RawTree.target` 的严格镜像。未知字段一律拒绝。
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RawTargetInput {
    pub display_id: i32,
    pub screen_id: String,
    pub logical_width: u32,
    pub logical_height: u32,
    pub epoch: String,
    pub generation: String,
}

/// 原始逻辑矩形，原样来自 `getBoundsInScreen`。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RawBoundsInput {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

/// Kotlin `RawNode` 的严格镜像。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RawNodeInput {
    pub path: Vec<u32>,
    pub class_name: String,
    pub package_name: String,
    pub view_id: String,
    pub text: String,
    pub content_description: String,
    pub bounds: RawBoundsInput,
    pub clickable: bool,
    pub scrollable: bool,
    pub editable: bool,
    pub checkable: bool,
    pub checked: bool,
    pub enabled: bool,
    pub focused: bool,
    pub visible: bool,
    pub selected: bool,
    pub window_id: i32,
}

/// Kotlin `RawTree` 的严格镜像。
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RawTreeInput {
    pub target: RawTargetInput,
    pub window_id: i32,
    pub nodes: Vec<RawNodeInput>,
    pub complete: bool,
    pub stop_reason: Option<String>,
    pub elapsed_ms: u64,
}

/// 严格反序列化一次原始树。字段缺失、未知字段或类型不符都会失败。
pub fn parse_raw_tree_json(input: &str) -> Result<RawTreeInput, UiTreeError> {
    serde_json::from_str(input)
        .map_err(|error| UiTreeError::new("invalid-json", format!("raw tree rejected: {error}")))
}

/// 节点身份。所有会影响动作落点的原始字段都参与核对。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeIdentity {
    pub path: Vec<u32>,
    pub class_name: String,
    pub package_name: String,
    pub view_id: String,
    pub text: String,
    pub content_description: String,
    pub bounds: RawBoundsInput,
    pub clickable: bool,
    pub scrollable: bool,
    pub editable: bool,
    pub checkable: bool,
    pub checked: bool,
    pub enabled: bool,
    pub focused: bool,
    pub visible: bool,
    pub selected: bool,
    pub window_id: i32,
}

/// 当前快照的只读元数据。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotInfo {
    #[serde(serialize_with = "serialize_u64_token")]
    pub snapshot_id: u64,
    #[serde(serialize_with = "serialize_u64_token")]
    pub epoch: u64,
    pub screen_id: String,
    pub display_id: i32,
    #[serde(serialize_with = "serialize_u64_token")]
    pub generation: u64,
    pub logical_width: u32,
    pub logical_height: u32,
    pub window_id: i32,
    pub complete: bool,
    pub stop_reason: Option<String>,
    pub node_count: usize,
    pub invalidated_count: usize,
}

/// Store 唯一生成的动作目标。字段私有，避免上层伪造或换节点。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActionTarget {
    snapshot_id: u64,
    epoch: u64,
    screen_id: String,
    display_id: i32,
    generation: u64,
    ref_id: String,
    identity: NodeIdentity,
}

impl ActionTarget {
    pub fn snapshot_id(&self) -> u64 { self.snapshot_id }
    pub fn epoch(&self) -> u64 { self.epoch }
    pub fn screen_id(&self) -> &str { &self.screen_id }
    pub fn display_id(&self) -> i32 { self.display_id }
    pub fn generation(&self) -> u64 { self.generation }
    pub fn ref_id(&self) -> &str { &self.ref_id }
    pub fn window_id(&self) -> i32 { self.identity.window_id }
    pub fn raw_child_path(&self) -> &[u32] { &self.identity.path }
    pub fn identity(&self) -> &NodeIdentity { &self.identity }

    /// 紧凑 JSON，直接携带精确窗口、真实 child path 与身份指纹。
    pub fn to_json(&self) -> String {
        json!({
            "ref": self.ref_id,
            "snapshotId": self.snapshot_id.to_string(),
            "epoch": self.epoch.to_string(),
            "screenId": self.screen_id,
            "displayId": self.display_id,
            "generation": self.generation.to_string(),
            "windowId": self.identity.window_id,
            "rawChildPath": self.identity.path,
            "identity": self.identity,
        })
        .to_string()
    }
}

/// selector 只做精确匹配。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Selector<'a> {
    ResourceId(&'a str),
    Text(&'a str),
    Description(&'a str),
}

impl<'a> Selector<'a> {
    fn label(self) -> &'static str {
        match self {
            Self::ResourceId(_) => "resourceId",
            Self::Text(_) => "text",
            Self::Description(_) => "description",
        }
    }

    fn value(self) -> &'a str {
        match self {
            Self::ResourceId(value) | Self::Text(value) | Self::Description(value) => value,
        }
    }

    fn matches(self, identity: &NodeIdentity) -> bool {
        match self {
            Self::ResourceId(value) => identity.view_id == value,
            Self::Text(value) => identity.text == value,
            Self::Description(value) => identity.content_description == value,
        }
    }
}

#[derive(Clone, Debug)]
struct StoredNode {
    ref_id: String,
    identity: NodeIdentity,
}

#[derive(Clone, Debug)]
struct Snapshot {
    info: SnapshotInfo,
    binding: ScreenBinding,
    nodes: Vec<StoredNode>,
    by_ref: BTreeMap<String, usize>,
    invalidated: BTreeSet<String>,
    rendered: String,
}

impl Snapshot {
    fn refresh_render(&mut self) {
        self.info.invalidated_count = self.invalidated.len();
        self.rendered = render_snapshot(self);
    }
}

/// 一个原生会话的 UI 树状态。epoch 来自 `PolicyState::epoch`，不能由时间或随机数生成。
#[derive(Clone, Debug)]
pub struct UiTreeStore {
    epoch: u64,
    next_snapshot_id: u64,
    snapshots: BTreeMap<String, Snapshot>,
}

impl UiTreeStore {
    pub fn new(policy_epoch: u64) -> Self {
        Self { epoch: policy_epoch, next_snapshot_id: 1, snapshots: BTreeMap::new() }
    }

    /// 测试专用：把快照 id 配额放到上界，验证溢出时失败且旧快照不动。
    #[doc(hidden)]
    pub fn with_last_snapshot_id(policy_epoch: u64) -> Self {
        Self { epoch: policy_epoch, next_snapshot_id: u64::MAX, snapshots: BTreeMap::new() }
    }

    pub fn epoch(&self) -> u64 { self.epoch }
    pub fn screen_count(&self) -> usize { self.snapshots.len() }

    pub fn snapshot(&self, screen_id: &str) -> Option<&SnapshotInfo> {
        self.snapshots.get(screen_id).map(|snapshot| &snapshot.info)
    }

    pub fn snapshot_json(&self, screen_id: &str) -> Option<&str> {
        self.snapshots.get(screen_id).map(|snapshot| snapshot.rendered.as_str())
    }

    /// 默认模型视图，保留所有节点与完整的采集状态，不改变缓存或身份指纹。
    /// `nodeDefaults` 明确未列出的布尔状态；enabled/visible 为 false 时仍显式输出。
    /// 超过 2 MiB（含 JSON 转义开销）返回 compact-output-too-large，绝不截树。
    pub fn compact_snapshot_json(&self, screen_id: &str) -> Result<Option<String>, UiTreeError> {
        self.snapshots.get(screen_id).map(render_compact_snapshot).transpose()
    }

    /// 校验整棵原始树，全部成功后才替换该屏幕的当前快照。
    pub fn replace(
        &mut self,
        policy_epoch: u64,
        binding: &ScreenBinding,
        raw: RawTreeInput,
    ) -> Result<SnapshotInfo, UiTreeError> {
        if policy_epoch != self.epoch {
            return fail(
                "policy-epoch-mismatch",
                format!("store epoch {} does not match policy epoch {policy_epoch}", self.epoch),
            );
        }
        let identities = validate_raw_tree(self.epoch, binding, &raw)?;
        if !self.snapshots.contains_key(&binding.alias) && self.snapshots.len() >= MAX_SCREENS {
            return fail("screen-limit", format!("at most {MAX_SCREENS} screens may be cached"));
        }

        let snapshot_id = self.next_snapshot_id;
        if snapshot_id == 0 {
            return fail("snapshot-id-exhausted", "snapshot id must stay nonzero");
        }
        let next_snapshot_id = snapshot_id
            .checked_add(1)
            .ok_or_else(|| UiTreeError::new("snapshot-id-exhausted", "snapshot id overflow"))?;

        let mut nodes = Vec::with_capacity(identities.len());
        let mut by_ref = BTreeMap::new();
        for (ordinal, identity) in identities.into_iter().enumerate() {
            let ref_id = format!("e{}:g{}:s{snapshot_id}:n{ordinal}", self.epoch, binding.generation);
            by_ref.insert(ref_id.clone(), ordinal);
            nodes.push(StoredNode { ref_id, identity });
        }
        let info = SnapshotInfo {
            snapshot_id,
            epoch: self.epoch,
            screen_id: binding.alias.clone(),
            display_id: binding.display_id,
            generation: binding.generation,
            logical_width: binding.width,
            logical_height: binding.height,
            window_id: raw.window_id,
            complete: raw.complete,
            stop_reason: raw.stop_reason,
            node_count: nodes.len(),
            invalidated_count: 0,
        };
        let mut snapshot = Snapshot {
            info,
            binding: binding.clone(),
            nodes,
            by_ref,
            invalidated: BTreeSet::new(),
            rendered: String::new(),
        };
        snapshot.refresh_render();
        let result = snapshot.info.clone();
        self.snapshots.insert(binding.alias.clone(), snapshot);
        self.next_snapshot_id = next_snapshot_id;
        Ok(result)
    }

    /// 解析当前快照的 ref。旧 snapshot、旧屏幕或畸形 ref 都不会回退。
    pub fn action_target(&self, ref_id: &str) -> Result<ActionTarget, UiTreeError> {
        let (snapshot, node) = self.resolve_current_ref(ref_id)?;
        Ok(ActionTarget {
            snapshot_id: snapshot.info.snapshot_id,
            epoch: snapshot.info.epoch,
            screen_id: snapshot.info.screen_id.clone(),
            display_id: snapshot.info.display_id,
            generation: snapshot.info.generation,
            ref_id: node.ref_id.clone(),
            identity: node.identity.clone(),
        })
    }

    /// 与调用方此刻从 policy 取得的完整 binding 重验；旧 ref 搭配新 binding 也拒绝。
    pub fn action_target_for_binding(
        &self,
        policy_epoch: u64,
        binding: &ScreenBinding,
        ref_id: &str,
    ) -> Result<ActionTarget, UiTreeError> {
        if policy_epoch != self.epoch {
            return fail("stale-epoch", "current policy epoch does not match the store");
        }
        let (snapshot, _) = self.resolve_current_ref(ref_id)?;
        if snapshot.binding != *binding {
            return fail("stale-generation", "current policy binding does not match the cached screen");
        }
        self.action_target(ref_id)
    }

    /// selector 仅在指定屏幕的当前快照内做精确匹配。
    pub fn select(
        &self,
        screen_id: &str,
        selector: Selector<'_>,
    ) -> Result<ActionTarget, UiTreeError> {
        if selector.value().is_empty() {
            return fail("selector-empty", format!("{} must not be empty", selector.label()));
        }
        let snapshot = self
            .snapshots
            .get(screen_id)
            .ok_or_else(|| UiTreeError::new("screen-not-found", format!("no snapshot for {screen_id}")))?;
        let matches: Vec<&StoredNode> = snapshot
            .nodes
            .iter()
            .filter(|node| {
                !snapshot.invalidated.contains(&node.ref_id) && selector.matches(&node.identity)
            })
            .collect();
        match matches.as_slice() {
            [] if snapshot.info.complete => fail(
                "selector-not-found",
                format!("no exact {} match in current snapshot", selector.label()),
            ),
            [] => fail(
                "tree-incomplete",
                format!("current snapshot is incomplete; no exact {} match is not proof of absence", selector.label()),
            ),
            [node] => Ok(ActionTarget {
                snapshot_id: snapshot.info.snapshot_id,
                epoch: snapshot.info.epoch,
                screen_id: snapshot.info.screen_id.clone(),
                display_id: snapshot.info.display_id,
                generation: snapshot.info.generation,
                ref_id: node.ref_id.clone(),
                identity: node.identity.clone(),
            }),
            many => fail(
                "selector-ambiguous",
                format!("exact {} match is ambiguous: {}", selector.label(), many.len()),
            ),
        }
    }

    /// 动作执行前与 freshly captured 节点的全身份字段逐一核对。
    /// 任何差异都拒绝，绝不改投祖先、兄弟或同文本节点。
    pub fn verify_target(
        &self,
        target: &ActionTarget,
        fresh: &RawNodeInput,
    ) -> Result<(), UiTreeError> {
        let snapshot = self.current_snapshot_for_target(target)?;
        let (_, stored) = snapshot
            .by_ref
            .get(&target.ref_id)
            .map(|index| (index, &snapshot.nodes[*index]))
            .ok_or_else(|| UiTreeError::new("ref-not-found", "target ref is not in the current snapshot"))?;
        if snapshot.invalidated.contains(&target.ref_id) {
            return fail("ref-invalidated", "target was invalidated");
        }
        if stored.identity != target.identity {
            return fail("target-identity-mismatch", "stored target identity changed");
        }
        let fresh_identity = identity_from_raw_checked(fresh)?;
        if fresh_identity != target.identity {
            return fail(
                "target-identity-mismatch",
                "fresh node identity or raw child path does not match the target exactly",
            );
        }
        Ok(())
    }

    /// 撤销单个目标。旧目标立即不能解析，也不能通过动作前核对。
    pub fn invalidate_target(&mut self, target: &ActionTarget) -> Result<(), UiTreeError> {
        self.invalidate_ref(&target.ref_id)
    }

    pub fn invalidate_ref(&mut self, ref_id: &str) -> Result<(), UiTreeError> {
        // 先检查 ref 自带的 epoch/generation，拒绝跨会话或跨屏幕代次的撤销请求。
        self.resolve_current_ref(ref_id)?;
        let snapshot_id = parse_ref(ref_id)?.snapshot_id;
        let snapshot = self
            .snapshots
            .values_mut()
            .find(|snapshot| snapshot.info.snapshot_id == snapshot_id)
            .ok_or_else(|| UiTreeError::new("stale-snapshot", "ref belongs to an old snapshot"))?;
        if !snapshot.by_ref.contains_key(ref_id) {
            return fail("ref-not-found", "ref is not in the current snapshot");
        }
        if !snapshot.invalidated.insert(ref_id.to_owned()) {
            return fail("ref-invalidated", "target was already invalidated");
        }
        snapshot.refresh_render();
        Ok(())
    }

    /// 屏幕销毁时移除整屏快照，旧 ref 随即失效。
    pub fn invalidate_screen(&mut self, screen_id: &str) -> bool {
        self.snapshots.remove(screen_id).is_some()
    }

    /// 撤权或会话结束时清空所有动作入口。snapshot id 计数器不回退。
    pub fn invalidate_all(&mut self) {
        self.snapshots.clear();
    }

    fn resolve_current_ref(&self, ref_id: &str) -> Result<(&Snapshot, &StoredNode), UiTreeError> {
        let parsed = parse_ref(ref_id)?;
        if parsed.epoch != self.epoch {
            return fail("stale-epoch", "ref belongs to another policy epoch");
        }
        let snapshot = self
            .snapshots
            .values()
            .find(|snapshot| snapshot.info.snapshot_id == parsed.snapshot_id)
            .ok_or_else(|| UiTreeError::new("stale-snapshot", "ref belongs to an old snapshot"))?;
        if parsed.epoch != snapshot.info.epoch {
            return fail("stale-epoch", "ref does not match the cached epoch");
        }
        if parsed.generation != snapshot.info.generation
            || parsed.generation != snapshot.binding.generation
        {
            return fail("stale-generation", "ref does not match the cached screen generation");
        }
        if snapshot.invalidated.contains(ref_id) {
            return fail("ref-invalidated", "target was invalidated");
        }
        let index = snapshot
            .by_ref
            .get(ref_id)
            .ok_or_else(|| UiTreeError::new("ref-not-found", "ref is not in the current snapshot"))?;
        if parsed.ordinal != *index as u64 {
            return fail("ref-not-found", "ref ordinal does not match the stored target");
        }
        Ok((snapshot, &snapshot.nodes[*index]))
    }

    fn current_snapshot_for_target(&self, target: &ActionTarget) -> Result<&Snapshot, UiTreeError> {
        if target.epoch != self.epoch {
            return fail("stale-epoch", "target belongs to another policy epoch");
        }
        let snapshot = self
            .snapshots
            .get(&target.screen_id)
            .ok_or_else(|| UiTreeError::new("stale-screen", "target screen no longer has a snapshot"))?;
        if snapshot.info.snapshot_id != target.snapshot_id {
            return fail("stale-snapshot", "target belongs to an old snapshot");
        }
        if snapshot.info.display_id != target.display_id
            || snapshot.info.generation != target.generation
        {
            return fail("stale-generation", "target display or screen generation changed");
        }
        Ok(snapshot)
    }
}

fn validate_raw_tree(
    policy_epoch: u64,
    binding: &ScreenBinding,
    raw: &RawTreeInput,
) -> Result<Vec<NodeIdentity>, UiTreeError> {
    validate_target(policy_epoch, binding, &raw.target)?;
    if raw.window_id < 0 {
        return fail("invalid-window-id", "tree window id must be nonnegative");
    }
    if raw.nodes.len() > MAX_NODES {
        return fail(
            "node-limit",
            format!("raw tree has {} nodes; limit is {MAX_NODES}", raw.nodes.len()),
        );
    }
    match (raw.complete, raw.stop_reason.as_deref()) {
        (true, Some(_)) => return fail("complete-with-reason", "complete tree must not have a stopReason"),
        (false, None) => return fail("incomplete-without-reason", "incomplete tree must state stopReason"),
        (false, Some(reason)) if !valid_stop_reason(reason) => {
            return fail("invalid-stop-reason", format!("unknown stopReason {reason}"))
        }
        _ => {}
    }
    if raw.stop_reason.as_ref().is_some_and(|reason| reason.len() > MAX_FIELD_BYTES) {
        return fail("invalid-stop-reason", "stopReason is too long");
    }

    let mut paths = BTreeSet::new();
    let mut total_bytes = 0usize;
    let mut identities = Vec::with_capacity(raw.nodes.len());
    for node in &raw.nodes {
        if node.path.len() > MAX_DEPTH {
            return fail(
                "depth-limit",
                format!("raw child path depth {} exceeds {MAX_DEPTH}", node.path.len()),
            );
        }
        if !paths.insert(node.path.clone()) {
            return fail("duplicate-path", format!("raw child path {:?} repeats", node.path));
        }
        let identity = identity_from_raw_checked_with_budget(node, &mut total_bytes)?;
        identities.push(identity);
    }
    if !paths.contains(&Vec::new()) {
        return fail("root-missing", "raw tree must include the real root at path []");
    }
    for path in &paths {
        for length in 1..path.len() {
            let parent = &path[..length];
            if !paths.contains(parent) {
                return fail("parent-missing", format!("raw child path {:?} has no parent node", path));
            }
        }
    }
    for node in &identities {
        if node.window_id != raw.window_id {
            return fail(
                "window-mismatch",
                format!("node {:?} window {} does not match tree window {}", node.path, node.window_id, raw.window_id),
            );
        }
    }
    Ok(identities)
}

fn validate_target(
    policy_epoch: u64,
    binding: &ScreenBinding,
    target: &RawTargetInput,
) -> Result<(), UiTreeError> {
    let input_epoch = parse_policy_number("epoch", &target.epoch)?;
    if input_epoch != policy_epoch {
        return fail(
            "epoch-mismatch",
            format!("raw epoch {input_epoch} does not match policy epoch {policy_epoch}"),
        );
    }
    if invalid_screen_id(&target.screen_id) {
        return fail("invalid-screen-id", "screenId is empty, too long or contains controls");
    }
    if target.screen_id != binding.alias {
        return fail(
            "screen-mismatch",
            format!("raw screen {} does not match binding {}", target.screen_id, binding.alias),
        );
    }
    if target.display_id < 0 || target.display_id != binding.display_id {
        return fail(
            "display-mismatch",
            format!("raw display {} does not match binding {}", target.display_id, binding.display_id),
        );
    }
    let input_generation = parse_policy_number("generation", &target.generation)?;
    if input_generation != binding.generation {
        return fail(
            "generation-mismatch",
            format!("raw generation {input_generation} does not match binding {}", binding.generation),
        );
    }
    if target.logical_width != binding.width || target.logical_height != binding.height {
        return fail(
            "dimension-mismatch",
            format!(
                "raw logical size {}x{} does not match binding {}x{}",
                target.logical_width, target.logical_height, binding.width, binding.height
            ),
        );
    }
    Ok(())
}

fn identity_from_raw_checked(node: &RawNodeInput) -> Result<NodeIdentity, UiTreeError> {
    let mut total_bytes = 0usize;
    identity_from_raw_checked_with_budget(node, &mut total_bytes)
}

fn identity_from_raw_checked_with_budget(
    node: &RawNodeInput,
    total_bytes: &mut usize,
) -> Result<NodeIdentity, UiTreeError> {
    if node.path.len() > MAX_DEPTH {
        return fail("depth-limit", "node raw child path is too deep");
    }
    if node.window_id < 0 {
        return fail("invalid-window-id", "node window id must be nonnegative");
    }
    if node.bounds.right < node.bounds.left || node.bounds.bottom < node.bounds.top {
        return fail("invalid-bounds", "node bounds must not be inverted");
    }
    for (name, value) in [
        ("className", node.class_name.as_str()),
        ("packageName", node.package_name.as_str()),
        ("viewId", node.view_id.as_str()),
        ("text", node.text.as_str()),
        ("contentDescription", node.content_description.as_str()),
    ] {
        if value.len() > MAX_FIELD_BYTES {
            return fail(
                "field-too-large",
                format!("{name} is {} UTF-8 bytes; limit is {MAX_FIELD_BYTES}", value.len()),
            );
        }
        *total_bytes = total_bytes
            .checked_add(value.len())
            .ok_or_else(|| UiTreeError::new("text-budget", "UTF-8 byte count overflow"))?;
        if *total_bytes > MAX_TOTAL_TEXT_BYTES {
            return fail(
                "text-budget",
                format!("raw tree text exceeds {MAX_TOTAL_TEXT_BYTES} UTF-8 bytes"),
            );
        }
    }
    Ok(NodeIdentity {
        path: node.path.clone(),
        class_name: node.class_name.clone(),
        package_name: node.package_name.clone(),
        view_id: node.view_id.clone(),
        text: node.text.clone(),
        content_description: node.content_description.clone(),
        bounds: node.bounds,
        clickable: node.clickable,
        scrollable: node.scrollable,
        editable: node.editable,
        checkable: node.checkable,
        checked: node.checked,
        enabled: node.enabled,
        focused: node.focused,
        visible: node.visible,
        selected: node.selected,
        window_id: node.window_id,
    })
}

fn parse_policy_number(label: &'static str, value: &str) -> Result<u64, UiTreeError> {
    if value.is_empty() || value.len() > 64 || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return fail("invalid-number", format!("{label} must be canonical decimal digits"));
    }
    let parsed = value
        .parse::<u64>()
        .map_err(|_| UiTreeError::new("invalid-number", format!("{label} is out of range")))?;
    if parsed.to_string() != value {
        return fail("invalid-number", format!("{label} is not canonical decimal"));
    }
    Ok(parsed)
}

fn invalid_screen_id(value: &str) -> bool {
    value.is_empty()
        || value.chars().count() > MAX_SCREEN_ID_CHARS
        || value.chars().any(char::is_control)
}

fn valid_stop_reason(reason: &str) -> bool {
    matches!(
        reason,
        "cancelled" | "node-limit" | "time-budget" | "depth-limit" | "char-budget" | "tree-read-failed"
    )
}

struct RefParts {
    epoch: u64,
    generation: u64,
    snapshot_id: u64,
    ordinal: u64,
}

fn parse_ref(value: &str) -> Result<RefParts, UiTreeError> {
    // 四个 u64 十进制段、四个前缀、三个分隔符；不接受旧短 ref。
    if value.len() > 87 {
        return fail("ref-malformed", "ref exceeds the canonical u64 representation");
    }
    let mut parts = value.split(':');
    let mut numbers = [0u64; 4];
    for (index, prefix) in ['e', 'g', 's', 'n'].into_iter().enumerate() {
        let digits = parts.next()
            .and_then(|part| part.strip_prefix(prefix))
            .ok_or_else(|| UiTreeError::new("ref-malformed", "ref must look like e<epoch>:g<generation>:s<snapshot>:n<ordinal>"))?;
        if digits.is_empty() || digits.len() > 20
            || !digits.bytes().all(|byte| byte.is_ascii_digit())
            || (digits.len() > 1 && digits.starts_with('0'))
        {
            return fail("ref-malformed", "ref segments must be canonical u64 decimal digits");
        }
        numbers[index] = digits.parse::<u64>()
            .map_err(|_| UiTreeError::new("ref-malformed", "ref segment is out of u64 range"))?;
    }
    if parts.next().is_some() || numbers[2] == 0 {
        return fail("ref-malformed", "ref has extra segments or a zero snapshot id");
    }
    Ok(RefParts {
        epoch: numbers[0],
        generation: numbers[1],
        snapshot_id: numbers[2],
        ordinal: numbers[3],
    })
}

fn render_snapshot(snapshot: &Snapshot) -> String {
    let info = &snapshot.info;
    let nodes: Vec<Value> = snapshot
        .nodes
        .iter()
        .map(|node| {
            let identity = &node.identity;
            json!({
                "ref": node.ref_id,
                "role": node_role(identity),
                "class": identity.class_name,
                "package": identity.package_name,
                "viewId": identity.view_id,
                "text": identity.text,
                "description": identity.content_description,
                "path": identity.path,
                "windowId": identity.window_id,
                "bounds": identity.bounds,
                "clickable": identity.clickable,
                "scrollable": identity.scrollable,
                "editable": identity.editable,
                "readOnly": !identity.editable,
                "checkable": identity.checkable,
                "checked": identity.checked,
                "enabled": identity.enabled,
                "focused": identity.focused,
                "visible": identity.visible,
                "selected": identity.selected,
                "invalidated": snapshot.invalidated.contains(&node.ref_id),
            })
        })
        .collect();
    json!({
        "snapshotId": info.snapshot_id.to_string(),
        "epoch": info.epoch.to_string(),
        "screenId": info.screen_id,
        "displayId": info.display_id,
        "generation": info.generation.to_string(),
        "logicalWidth": info.logical_width,
        "logicalHeight": info.logical_height,
        "windowId": info.window_id,
        "complete": info.complete,
        "stopReason": info.stop_reason,
        "nodeCount": info.node_count,
        "invalidatedCount": info.invalidated_count,
        "nodes": nodes,
    })
    .to_string()
}

fn is_false(value: &bool) -> bool { !*value }
fn is_true(value: &bool) -> bool { *value }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CompactNode<'a> {
    #[serde(rename = "ref")]
    ref_id: &'a str,
    role: String,
    bounds: &'a RawBoundsInput,
    #[serde(skip_serializing_if = "str::is_empty")]
    text: &'a str,
    #[serde(skip_serializing_if = "str::is_empty")]
    description: &'a str,
    #[serde(skip_serializing_if = "str::is_empty")]
    view_id: &'a str,
    #[serde(skip_serializing_if = "is_false")]
    clickable: bool,
    #[serde(skip_serializing_if = "is_false")]
    scrollable: bool,
    #[serde(skip_serializing_if = "is_false")]
    editable: bool,
    #[serde(skip_serializing_if = "is_true")]
    read_only: bool,
    #[serde(skip_serializing_if = "is_false")]
    checkable: bool,
    #[serde(skip_serializing_if = "is_false")]
    checked: bool,
    #[serde(skip_serializing_if = "is_true")]
    enabled: bool,
    #[serde(skip_serializing_if = "is_false")]
    focused: bool,
    #[serde(skip_serializing_if = "is_true")]
    visible: bool,
    #[serde(skip_serializing_if = "is_false")]
    selected: bool,
    #[serde(skip_serializing_if = "is_false")]
    invalidated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CompactSnapshot<'a> {
    #[serde(flatten)]
    info: &'a SnapshotInfo,
    node_defaults: Value,
    nodes: Vec<CompactNode<'a>>,
}

// 在序列化过程中限制已转义的真实 UTF-8 字节数，拒绝后不返回任何部分 JSON。
struct CompactJsonWriter {
    bytes: Vec<u8>,
    exceeded: bool,
}

impl std::io::Write for CompactJsonWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > MAX_COMPACT_JSON_BYTES - self.bytes.len() {
            self.exceeded = true;
            return Err(std::io::Error::other("compact JSON exceeds IPC budget"));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
}

fn render_compact_snapshot(snapshot: &Snapshot) -> Result<String, UiTreeError> {
    let nodes = snapshot.nodes.iter().map(|node| {
        let identity = &node.identity;
        CompactNode {
            ref_id: &node.ref_id,
            role: node_role(identity),
            bounds: &identity.bounds,
            text: &identity.text,
            description: &identity.content_description,
            view_id: &identity.view_id,
            clickable: identity.clickable,
            scrollable: identity.scrollable,
            editable: identity.editable,
            read_only: !identity.editable,
            checkable: identity.checkable,
            checked: identity.checked,
            enabled: identity.enabled,
            focused: identity.focused,
            visible: identity.visible,
            selected: identity.selected,
            invalidated: snapshot.invalidated.contains(&node.ref_id),
        }
    }).collect();
    let compact = CompactSnapshot {
        info: &snapshot.info,
        node_defaults: json!({
            "clickable": false, "scrollable": false, "editable": false, "readOnly": true,
            "checkable": false, "checked": false, "enabled": true, "focused": false,
            "visible": true, "selected": false, "invalidated": false,
        }),
        nodes,
    };
    let mut writer = CompactJsonWriter { bytes: Vec::new(), exceeded: false };
    serde_json::to_writer(&mut writer, &compact).map_err(|error| {
        if writer.exceeded {
            UiTreeError::new("compact-output-too-large", format!("complete compact JSON exceeds {MAX_COMPACT_JSON_BYTES} UTF-8 bytes; no nodes were truncated"))
        } else {
            UiTreeError::new("compact-serialization-failed", error.to_string())
        }
    })?;
    String::from_utf8(writer.bytes)
        .map_err(|error| UiTreeError::new("compact-serialization-failed", error.to_string()))
}

fn node_role(identity: &NodeIdentity) -> String {
    let simple = identity.class_name.rsplit('.').next().unwrap_or("");
    if simple.is_empty() {
        if identity.editable {
            "editable".to_owned()
        } else if identity.clickable {
            "clickable".to_owned()
        } else {
            "node".to_owned()
        }
    } else {
        simple.to_owned()
    }
}
