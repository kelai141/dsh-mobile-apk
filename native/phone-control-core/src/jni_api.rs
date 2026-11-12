//! JNI 边界。类名固定为 `com.dsharnessmobile.shell.nativecontrol.NativeControlCore`。
//!
//! Kotlin 侧声明：
//! `@JvmStatic external fun initialize(stateDir: String, appUid: Int): String`
//! `@JvmStatic external fun exchange(payload: String): String`
//! `@JvmStatic external fun exchangeNonblocking(payload: String): String`
//!
//! 三个入口总是返回 JSON。进程级 mutex 持有一个控制器；初始化只接受应用
//! 私有目录，且 Android 上必须由真实 `getuid()` 匹配。Windows 测试构建没有
//! 伪造设备身份：仅仅拒绝使用 POSIX uid 检查当作 Android 校验。

use std::ffi::{c_char, c_void, CStr, CString};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};

use jni::objects::{JClass, JString};
use jni::sys::jstring;
use jni::JNIEnv;
use serde_json::json;

use crate::controller::{Controller, PROTOCOL_VERSION};

const CLASS_NAME: &str = "com/dsharnessmobile/shell/nativecontrol/NativeControlCore";

struct Session {
    controller: Controller<crate::journal::FileJournal>,
    state_dir: PathBuf,
    app_uid: i32,
}

impl Session {
    fn diagnostic(&self) -> serde_json::Value {
        serde_json::json!({
            "stateDir": self.state_dir.to_string_lossy(),
            "appUid": self.app_uid,
            "epoch": self.controller.epoch().to_string()
        })
    }
}

static CORE: OnceLock<Mutex<Option<Session>>> = OnceLock::new();

fn core() -> &'static Mutex<Option<Session>> {
    CORE.get_or_init(|| Mutex::new(None))
}

#[cfg(not(target_os = "android"))]
/// 仅供隔离测试：清空进程级会话，使下一次 initialize 走首次初始化路径。
#[doc(hidden)]
pub fn reset_for_test() -> bool {
    match lock_core() {
        Ok(mut guard) => {
            let existed = guard.is_some();
            *guard = None;
            existed
        }
        Err(_) => false,
    }
}

/// 内部初始化的结果说明。真实 Android 由平台校验，Windows 测试构建显式标记。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Platform {
    Android,
    HostTest,
}

fn platform() -> Platform {
    if cfg!(target_os = "android") {
        Platform::Android
    } else {
        Platform::HostTest
    }
}

#[cfg(target_os = "android")]
fn real_uid() -> Option<i32> {
    // SAFETY: getuid has no preconditions and does not touch managed memory.
    Some(unsafe { libc::getuid() as i32 })
}

#[cfg(not(target_os = "android"))]
fn real_uid() -> Option<i32> {
    None
}

/// 进程内初始化。测试可直接调用，不经过 JNI。
pub fn initialize_core(state_dir: &str, app_uid: i32) -> String {
    let result = catch_unwind(AssertUnwindSafe(|| initialize_inner(state_dir, app_uid)));
    match result {
        Ok(response) => response,
        Err(_) => failure("core-panic", "initialization panicked; core remains unavailable"),
    }
}

fn initialize_inner(state_dir: &str, app_uid: i32) -> String {
    let platform = platform();
    if app_uid < 0 {
        return failure("invalid-app-uid", "appUid must be non-negative");
    }
    if state_dir.is_empty() || state_dir.len() > 4096 {
        return failure("invalid-state-dir", "stateDir must be a non-empty bounded path");
    }
    if state_dir.contains('\0') {
        return failure("invalid-state-dir", "stateDir must not contain NUL");
    }
    if platform == Platform::Android {
        let Some(uid) = real_uid() else {
            return failure("identity-check-failed", "could not read the process uid");
        };
        if uid != app_uid {
            return failure("identity-mismatch", "appUid does not match the real process uid");
        }
        if uid == 0 {
            return failure("root-not-supported", "the control core must run as the app uid, not root");
        }
    }

    let path = Path::new(state_dir);
    if !path.is_absolute() {
        return failure("invalid-state-dir", "stateDir must be absolute");
    }
    let mut guard = match lock_core() {
        Ok(guard) => guard,
        Err(response) => return response,
    };

    let requested = match checked_state_directory(path, app_uid) {
        Ok(canonical) => canonical,
        Err(response) => return response,
    };
    if let Some(session) = guard.as_ref() {
        if session.state_dir == requested && session.app_uid == app_uid {
            return initialized_json(session, true);
        }
        return failure(
            "already-initialized",
            "the control core is already initialized with a different state directory or app uid",
        );
    }

    let epoch = match crate::controller::new_epoch() {
        Ok(epoch) => epoch,
        Err(error) => return failure(error.code(), error.detail()),
    };
    let controller = match Controller::open_file(&requested, epoch) {
        Ok(controller) => controller,
        Err(error) => return failure(error.code(), error.detail()),
    };
    *guard = Some(Session {
        controller,
        state_dir: requested,
        app_uid,
    });
    initialized_json(guard.as_ref().expect("session was just stored"), false)
}

fn initialized_json(session: &Session, idempotent: bool) -> String {
    let platform = platform();
    json!({
        "ok": true,
        "code": if idempotent { "already-initialized" } else { "initialized" },
        "executed": "no",
        "protocolVersion": PROTOCOL_VERSION,
        "epoch": u64_wire(session.controller.epoch()),
        "platform": match platform { Platform::Android => "android", Platform::HostTest => "host-test" },
        "identityVerified": platform == Platform::Android,
        "appUid": session.app_uid,
        "revision": u64_wire(session.controller.revision()),
        "idempotent": idempotent
    })
    .to_string()
}

fn checked_state_directory(path: &Path, app_uid: i32) -> Result<PathBuf, String> {
    validate_existing_ancestors(path)?;
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| failure("invalid-state-dir", &format!("stateDir must already exist as a real directory: {error}")))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(failure("invalid-state-dir", "stateDir must be a real directory"));
    }
    if platform() == Platform::Android && !directory_owned_by(&metadata, app_uid) {
        return Err(failure(
            "state-dir-owner-mismatch",
            "stateDir must be owned by the app uid",
        ));
    }
    path.canonicalize()
        .map_err(|error| failure("invalid-state-dir", &format!("could not canonicalize stateDir: {error}")))
}

fn validate_existing_ancestors(path: &Path) -> Result<(), String> {
    if let Ok(metadata) = std::fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(failure("invalid-state-dir", "stateDir must be a real directory"));
        }
    }
    let mut ancestor = path.parent();
    while let Some(parent) = ancestor {
        match std::fs::symlink_metadata(parent) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() {
                    return Err(failure(
                        "unsafe-state-dir",
                        "stateDir must not have a symlinked ancestor",
                    ));
                }
                if is_reparse_point(&metadata) {
                    return Err(failure(
                        "unsafe-state-dir",
                        "stateDir must not have a reparse-point ancestor",
                    ));
                }
                ancestor = parent.parent();
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                ancestor = parent.parent();
            }
            Err(error) => {
                return Err(failure(
                    "invalid-state-dir",
                    &format!("could not inspect a stateDir ancestor: {error}"),
                ))
            }
        }
    }
    Ok(())
}

#[cfg(windows)]
fn is_reparse_point(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn is_reparse_point(_metadata: &std::fs::Metadata) -> bool {
    false
}

#[cfg(unix)]
fn directory_owned_by(metadata: &std::fs::Metadata, app_uid: i32) -> bool {
    use std::os::unix::fs::MetadataExt;
    metadata.uid() == app_uid as u32
}

#[cfg(not(unix))]
fn directory_owned_by(_metadata: &std::fs::Metadata, _app_uid: i32) -> bool {
    true
}

/// 只读诊断面。路径与 app UID 不进入 exchange 协议，仅供宿主测试与壳侧日志。
pub fn session_diagnostic() -> String {
    match lock_core() {
        Ok(guard) => guard
            .as_ref()
            .map(|session| session.diagnostic().to_string())
            .unwrap_or_else(|| failure("not-initialized", "call initialize before exchange")),
        Err(response) => response,
    }
}

/// 处理一个 exchange 请求。未初始化、锁中毒或 panic 都返回 JSON 错误。
pub fn exchange_core(payload: &str) -> String {
    let result = catch_unwind(AssertUnwindSafe(|| exchange_inner(payload)));
    match result {
        Ok(response) => response,
        Err(_) => failure("core-panic", "exchange panicked; core call was rejected"),
    }
}

/// Fast gate for Android main thread: facts, capabilities and validateDispatch only.
/// It uses try_lock and never waits for a journal fsync.
pub fn exchange_nonblocking_core(payload: &str) -> String {
    let result = catch_unwind(AssertUnwindSafe(|| exchange_nonblocking_inner(payload)));
    match result {
        Ok(response) => response,
        Err(_) => failure("core-panic", "nonblocking exchange panicked; core call was rejected"),
    }
}

fn exchange_nonblocking_inner(payload: &str) -> String {
    if payload.len() > crate::controller::MAX_REQUEST_BYTES {
        return failure("request-too-large", "payload exceeds the byte limit");
    }
    let kind = match serde_json::from_str::<serde_json::Value>(payload)
        .ok()
        .and_then(|value| value.get("kind").and_then(|kind| kind.as_str()).map(str::to_owned))
    {
        Some(kind) => kind,
        None => return failure("invalid-request", "payload must be a JSON object with a kind"),
    };
    if !matches!(kind.as_str(), "publishFacts" | "capabilities" | "validateDispatch") {
        return failure(
            "blocking-operation-rejected",
            "exchangeNonblocking only accepts publishFacts, capabilities and validateDispatch",
        );
    }
    let mut guard = match core().try_lock() {
        Ok(guard) => guard,
        Err(std::sync::TryLockError::WouldBlock) => {
            return failure("core-busy", "control core is busy with a durable operation; retry later")
        }
        Err(std::sync::TryLockError::Poisoned(_)) => {
            return failure("core-poisoned", "process-level core mutex is poisoned")
        }
    };
    match guard.as_mut() {
        Some(session) => session.controller.exchange_nonblocking(payload),
        None => failure("not-initialized", "call initialize before exchange"),
    }
}

fn exchange_inner(payload: &str) -> String {
    let mut guard = match lock_core() {
        Ok(guard) => guard,
        Err(response) => return response,
    };
    match guard.as_mut() {
        Some(session) => session.controller.exchange(payload),
        None => failure("not-initialized", "call initialize before exchange"),
    }
}

fn lock_core() -> Result<MutexGuard<'static, Option<Session>>, String> {
    core()
        .lock()
        .map_err(|_| failure("core-poisoned", "process-level core mutex is poisoned"))
}

fn failure(code: &str, detail: &str) -> String {
    json!({
        "ok": false,
        "protocolVersion": PROTOCOL_VERSION,
        "code": code,
        "executed": "unknown",
        "detail": detail
    })
    .to_string()
}

fn u64_wire(value: u64) -> String {
    value.to_string()
}

fn string_result(env: &mut JNIEnv<'_>, value: String) -> jstring {
    match env.new_string(value) {
        Ok(string) => string.into_raw(),
        Err(_) => {
            // 分配失败时返回空串，保证不向 Java 抛 panic；Kotlin 将空串视为协议失败。
            env.new_string("{\"protocolVersion\":1,\"ok\":false,\"code\":\"jni-alloc-failed\",\"executed\":\"unknown\"}")
                .map(|string| string.into_raw())
                .unwrap_or(std::ptr::null_mut())
        }
    }
}

fn java_string(env: &mut JNIEnv<'_>, value: JString<'_>) -> Result<String, String> {
    env.get_string(&value)
        .map(|string| string.into())
        .map_err(|error| error.to_string())
}

/// `@JvmStatic external fun initialize(stateDir: String, appUid: Int): String`
#[no_mangle]
pub extern "system" fn Java_com_dsharnessmobile_shell_nativecontrol_NativeControlCore_initialize(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
    state_dir: JString<'_>,
    app_uid: i32,
) -> jstring {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let state_dir = match java_string(&mut env, state_dir) {
            Ok(value) => value,
            Err(error) => return failure("invalid-state-dir", &error),
        };
        initialize_core(&state_dir, app_uid)
    }));
    let value = result.unwrap_or_else(|_| failure("core-panic", "initialize panicked"));
    string_result(&mut env, value)
}

/// `@JvmStatic external fun exchange(payload: String): String`
#[no_mangle]
pub extern "system" fn Java_com_dsharnessmobile_shell_nativecontrol_NativeControlCore_exchange(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
    payload: JString<'_>,
) -> jstring {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let payload = match java_string(&mut env, payload) {
            Ok(value) => value,
            Err(error) => return failure("invalid-request", &error),
        };
        exchange_core(&payload)
    }));
    let value = result.unwrap_or_else(|_| failure("core-panic", "exchange panicked"));
    string_result(&mut env, value)
}

/// @JvmStatic external fun exchangeNonblocking(payload: String): String
#[no_mangle]
pub extern "system" fn Java_com_dsharnessmobile_shell_nativecontrol_NativeControlCore_exchangeNonblocking(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
    payload: JString<'_>,
) -> jstring {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let payload = match java_string(&mut env, payload) {
            Ok(value) => value,
            Err(error) => return failure("invalid-request", &error),
        };
        exchange_nonblocking_core(&payload)
    }));
    let value = result.unwrap_or_else(|_| failure("core-panic", "nonblocking exchange panicked"));
    string_result(&mut env, value)
}

/// 供宿主测试与打包检查使用的符号名，避免静默改名。
pub const JNI_CLASS_PATH: &str = CLASS_NAME;

#[allow(dead_code)]
fn _keep_c_types(_: *const c_char, _: *mut c_void, _: &CStr, _: CString) {}
