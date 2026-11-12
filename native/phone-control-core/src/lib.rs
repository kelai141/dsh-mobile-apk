//! APK 原生控制核心。生产接线前仅由隔离测试入口调用。
pub mod controller;
pub mod journal;
pub mod jni_api;
pub mod lifecycle;
pub mod policy;
pub mod vision;
