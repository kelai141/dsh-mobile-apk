//! APK 原生控制核心，由壳侧 NativeControlRuntime 持有生产生命周期。
pub mod controller;
pub mod journal;
pub mod jni_api;
pub mod lifecycle;
pub mod policy;
pub mod shell_policy;
pub mod ui_tree;
pub mod vision;
pub mod vision_runtime;
