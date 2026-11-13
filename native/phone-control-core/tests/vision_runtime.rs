//! 视觉交付运行时与图像缓存的真实行为测试。
//!
//! 所有出票都走 Controller 的 prepare/commit 生命周期，图像则用真实 RGBA 帧
//! 经 JPEG 编码，再把回执交回 settle。缓存时间边界使用 `insert_at/get_at` 的
//! 显式 `Instant`，测试不睡眠。

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use dsh_phone_control_core::controller::{Controller, PROTOCOL_VERSION};
use dsh_phone_control_core::lifecycle::{Journal, JournalError};
use dsh_phone_control_core::policy::{Backend, DispatchPlan, PlanTarget, ScreenBinding};
use dsh_phone_control_core::vision::{LogicalRect, ScreenTarget, VisionImage};
use dsh_phone_control_core::vision_runtime::{
    FrameMetadata, ImageCache, VisualTicket, IMAGE_DELIVERY_TTL, MAX_CACHED_IMAGE_BYTES,
    MAX_CACHED_IMAGES,
};
use image::GenericImageView;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const RED: [u8; 4] = [220, 30, 30, 255];
const GREEN: [u8; 4] = [30, 200, 60, 255];
const BLUE: [u8; 4] = [30, 60, 220, 255];
const YELLOW: [u8; 4] = [235, 220, 40, 255];

#[derive(Clone, Default)]
struct MemoryJournal(Arc<Mutex<Option<Vec<u8>>>>);

impl Journal for MemoryJournal {
    fn load(&mut self) -> Result<Option<Vec<u8>>, JournalError> {
        Ok(self.0.lock().unwrap().clone())
    }

    fn store(&mut self, state: &[u8]) -> Result<(), JournalError> {
        *self.0.lock().unwrap() = Some(state.to_vec());
        Ok(())
    }
}

fn call<J: Journal>(controller: &mut Controller<J>, request: Value) -> Value {
    let response = controller.exchange(&request.to_string());
    serde_json::from_str(&response).unwrap_or_else(|error| panic!("bad JSON {response}: {error}"))
}

fn real_facts(scope: &str, rotation: u8, a11y_online: &str, width: u32, height: u32) -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "kind": "publishFacts",
        "facts": {
            "scope": scope,
            "observedAtMs": 1,
            "screens": {
                "real": {"displayId": 0, "width": width, "height": height, "rotation": rotation}
            },
            "a11y": {
                "enabled": "yes",
                "online": a11y_online,
                "supportedOps": {"state": "known", "ops": ["screenshot", "readRegion"]},
                "displaySupport": {"state": "known", "values": {"0": true}}
            }
        }
    })
}

fn publish_real<J: Journal>(controller: &mut Controller<J>, scope: &str, rotation: u8, online: &str, width: u32, height: u32) {
    let published = call(controller, real_facts(scope, rotation, online, width, height));
    assert_eq!(published["ok"], true, "publishFacts failed: {published}");
}

fn controller(width: u32, height: u32) -> Controller<MemoryJournal> {
    let mut controller = Controller::with_journal(MemoryJournal::default(), 900).unwrap();
    publish_real(&mut controller, "all", 0, "yes", width, height);
    controller
}

fn prepare<J: Journal>(controller: &mut Controller<J>, call_id: &str, operation: &str, args: Value) -> Value {
    call(
        controller,
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "kind": "prepare",
            "callId": call_id,
            "operation": operation,
            "screenId": "real",
            "epoch": "900",
            "args": args
        }),
    )
}

fn commit<J: Journal>(controller: &mut Controller<J>, call_id: &str) -> Value {
    call(
        controller,
        json!({"protocolVersion": PROTOCOL_VERSION, "kind": "commit", "callId": call_id}),
    )
}

fn dispatched<J: Journal>(controller: &mut Controller<J>, call_id: &str, operation: &str, args: Value) -> VisualTicket {
    let prepared = prepare(controller, call_id, operation, args);
    assert_eq!(prepared["ok"], true, "prepare failed: {prepared}");
    let committed = commit(controller, call_id);
    assert_eq!(committed["ok"], true, "commit failed: {committed}");
    assert_eq!(committed["dispatch"], "permitted");
    controller.visual_ticket(call_id).expect("dispatched visual call must have a ticket")
}

fn screenshot_ticket<J: Journal>(controller: &mut Controller<J>, call_id: &str) -> VisualTicket {
    dispatched(controller, call_id, "screenshot", json!({}))
}

fn quadrants(width: u32, height: u32, padding: usize) -> (Vec<u8>, usize) {
    let row_stride = width as usize * 4 + padding;
    let mut bytes = vec![0x7Fu8; row_stride * height as usize];
    for y in 0..height {
        for x in 0..width {
            let color = match (x < width / 2, y < height / 2) {
                (true, true) => RED,
                (false, true) => GREEN,
                (true, false) => BLUE,
                (false, false) => YELLOW,
            };
            let offset = y as usize * row_stride + x as usize * 4;
            bytes[offset..offset + 4].copy_from_slice(&color);
        }
    }
    (bytes, row_stride)
}

fn noise(width: u32, height: u32, seed: u32) -> (Vec<u8>, usize) {
    let row_stride = width as usize * 4;
    let mut bytes = vec![0u8; row_stride * height as usize];
    let mut state = seed | 1;
    for pixel in bytes.chunks_exact_mut(4) {
        state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        pixel[0] = (state >> 24) as u8;
        pixel[1] = (state >> 16) as u8;
        pixel[2] = (state >> 8) as u8;
        pixel[3] = 255;
    }
    (bytes, row_stride)
}

fn metadata(ticket: &VisualTicket, width: u32, height: u32, row_stride: usize, transform: &str) -> FrameMetadata {
    FrameMetadata {
        call_id: ticket.call_id.clone(),
        epoch: ticket.target.epoch.to_string(),
        screen_id: ticket.target.screen_id.clone(),
        display_id: ticket.target.display_id,
        generation: ticket.target.generation.to_string(),
        logical_width: ticket.target.logical_width,
        logical_height: ticket.target.logical_height,
        width,
        height,
        row_stride,
        premultiplied_alpha: false,
        transform: transform.to_owned(),
    }
}

fn encode_frame(ticket: &VisualTicket, bytes: &[u8], row_stride: usize) -> VisionImage {
    metadata(ticket, ticket.target.logical_width, ticket.target.logical_height, row_stride, "identity")
        .encode(ticket, bytes)
        .expect("valid frame must encode")
}

fn finish<J: Journal>(controller: &mut Controller<J>, ticket: &VisualTicket) -> Value {
    let (bytes, row_stride) = quadrants(ticket.target.logical_width, ticket.target.logical_height, 5);
    let image = encode_frame(ticket, &bytes, row_stride);
    let finished = controller.finish_visual(ticket, image).expect("fresh ticket must finish");
    assert_eq!(finished["ok"], true, "finish_visual failed: {finished}");
    finished
}

fn settle_success<J: Journal>(controller: &mut Controller<J>, call_id: &str, finished: &Value) -> Value {
    let receipt = json!({
        "ok": true,
        "code": finished["code"],
        "executed": "yes",
        "screenId": "real",
        "data": {"image": finished["data"]["image"]}
    });
    let settled = call(
        controller,
        json!({"protocolVersion": PROTOCOL_VERSION, "kind": "settle", "callId": call_id, "receipt": receipt}),
    );
    assert_eq!(settled["ok"], true, "settle failed: {settled}");
    settled
}

fn decode(bytes: &[u8]) -> image::DynamicImage {
    image::load_from_memory(bytes).expect("delivered JPEG must decode")
}

#[test]
fn screenshot_delivers_decodable_jpeg_with_matching_metadata_and_hash() {
    let mut controller = controller(64, 32);
    let ticket = screenshot_ticket(&mut controller, "shot-1");
    assert_eq!(ticket.region, None);
    assert_eq!(ticket.target.screen_id, "real");
    assert_eq!(ticket.target.display_id, 0);
    assert_eq!((ticket.target.logical_width, ticket.target.logical_height), (64, 32));

    let finished = finish(&mut controller, &ticket);
    assert_eq!(finished["code"], "screenshot-captured");
    let image_meta = &finished["data"]["image"];
    assert_eq!(image_meta["width"], 64);
    assert_eq!(image_meta["height"], 32);
    assert_eq!(image_meta["region"], json!({"x1": 0, "y1": 0, "x2": 64, "y2": 32}));
    assert_eq!(image_meta["epoch"], "900");
    assert_eq!(image_meta["screenId"], "real");
    assert_eq!(image_meta["generation"], ticket.target.generation.to_string());
    assert_eq!(image_meta["mediaType"], "image/jpeg");

    let settled = settle_success(&mut controller, "shot-1", &finished);
    assert_eq!(settled["code"], "screenshot-captured");

    let (read_meta, jpeg) = controller.read_visual("shot-1").expect("settled image must be readable");
    assert_eq!(read_meta, *image_meta);
    assert_eq!(read_meta["bytes"], jpeg.len());
    let digest = format!("{:x}", Sha256::digest(&jpeg));
    assert_eq!(read_meta["sha256"], digest);
    let image_id = format!(
        "{:x}",
        Sha256::digest(
            format!("shot-1:900:{}:{}", ticket.target.generation, digest).as_bytes()
        )
    );
    assert_eq!(read_meta["imageId"], image_id);

    let decoded = decode(&jpeg);
    assert_eq!(decoded.dimensions(), (64, 32));
    assert!(jpeg.starts_with(&[0xFF, 0xD8]));
    assert!(jpeg.ends_with(&[0xFF, 0xD9]));
}

#[test]
fn read_region_uses_the_dispatched_rectangle_and_ignores_later_coordinates() {
    let mut controller = controller(64, 32);
    let ticket = dispatched(
        &mut controller,
        "region-1",
        "readRegion",
        json!({"x1": 24, "y1": 4, "x2": 56, "y2": 28}),
    );
    assert_eq!(
        ticket.region,
        Some(LogicalRect { x1: 24, y1: 4, x2: 56, y2: 28 })
    );

    // 同一 callId 再报一组新坐标不能改变已持久化的派发矩形。
    let conflicting = prepare(&mut controller, "region-1", "readRegion", json!({"x1": 0, "y1": 0, "x2": 8, "y2": 8}));
    assert_eq!(conflicting["ok"], false, "a dispatched call must not be re-prepared: {conflicting}");
    let current = controller.visual_ticket("region-1").expect("ticket remains available while dispatching");
    assert_eq!(current.region, ticket.region);

    let finished = finish(&mut controller, &ticket);
    assert_eq!(finished["code"], "region-read");
    assert_eq!(finished["data"]["image"]["region"], json!({"x1": 24, "y1": 4, "x2": 56, "y2": 28}));
    settle_success(&mut controller, "region-1", &finished);

    let (read_meta, jpeg) = controller.read_visual("region-1").expect("settled region must be readable");
    assert_eq!(read_meta["region"], json!({"x1": 24, "y1": 4, "x2": 56, "y2": 28}));
    let decoded = decode(&jpeg).to_rgb8();
    assert_eq!(decoded.dimensions(), (32, 24));
    // 输出坐标 (4,4) 对应逻辑 (28,8)，落在左上红块；(28,4) 对应 (52,8)，落在右上绿块。
    let left = decoded.get_pixel(4, 4).0;
    let right = decoded.get_pixel(28, 4).0;
    assert!(left[0] > 140 && left[1] < 100, "left half should be red, got {left:?}");
    assert!(right[1] > 130 && right[0] < 120, "right half should be green, got {right:?}");
}

#[test]
fn ticket_is_absent_before_dispatch_and_after_cancel() {
    let mut controller = controller(64, 32);
    let prepared = prepare(&mut controller, "prepared-only", "screenshot", json!({}));
    assert_eq!(prepared["ok"], true);
    let early = controller.visual_ticket("prepared-only").unwrap_err();
    assert_eq!(early.code(), "visual-dispatch-required");

    let cancelled = call(
        &mut controller,
        json!({"protocolVersion": PROTOCOL_VERSION, "kind": "cancel", "callId": "prepared-only"}),
    );
    assert_eq!(cancelled["code"], "withdrawn-before-dispatch", "unexpected cancel receipt: {cancelled}");
    assert_eq!(cancelled["executed"], "no");
    let after_cancel = controller.visual_ticket("prepared-only").unwrap_err();
    assert_eq!(after_cancel.code(), "visual-dispatch-required");

    let _ticket = screenshot_ticket(&mut controller, "dispatched-then-cancelled");
    let cancelled = call(
        &mut controller,
        json!({"protocolVersion": PROTOCOL_VERSION, "kind": "cancel", "callId": "dispatched-then-cancelled"}),
    );
    assert_eq!(cancelled["executed"], "unknown");
    let after_dispatch_cancel = controller.visual_ticket("dispatched-then-cancelled").unwrap_err();
    assert_eq!(after_dispatch_cancel.code(), "visual-dispatch-required");
}

#[test]
fn frame_metadata_rejects_target_stride_and_transform_mismatches() {
    let ticket = direct_ticket("frame-1", "real", 0, 11, 64, 32, None);
    let (bytes, stride) = quadrants(64, 32, 9);
    metadata(&ticket, 64, 32, stride, "identity")
        .encode(&ticket, &bytes)
        .expect("baseline frame must encode");

    let mut bad = metadata(&ticket, 64, 32, stride, "identity");
    bad.call_id = "frame-2".into();
    assert_eq!(bad.encode(&ticket, &bytes).unwrap_err().code(), "frame-target-mismatch");

    let mut bad = metadata(&ticket, 64, 32, stride, "identity");
    bad.epoch = "901".into();
    assert_eq!(bad.encode(&ticket, &bytes).unwrap_err().code(), "frame-target-mismatch");

    let mut bad = metadata(&ticket, 64, 32, stride, "identity");
    bad.generation = "12".into();
    assert_eq!(bad.encode(&ticket, &bytes).unwrap_err().code(), "frame-target-mismatch");

    let mut bad = metadata(&ticket, 64, 32, stride, "identity");
    bad.display_id = 1;
    assert_eq!(bad.encode(&ticket, &bytes).unwrap_err().code(), "frame-target-mismatch");

    let mut bad = metadata(&ticket, 64, 32, stride, "identity");
    bad.screen_id = "virtual-1".into();
    assert_eq!(bad.encode(&ticket, &bytes).unwrap_err().code(), "frame-target-mismatch");

    let mut bad = metadata(&ticket, 64, 32, stride, "identity");
    bad.logical_width = 63;
    assert_eq!(bad.encode(&ticket, &bytes).unwrap_err().code(), "frame-target-mismatch");

    let bad = metadata(&ticket, 64, 32, stride, "identity");
    assert_eq!(bad.encode(&ticket, &bytes[..bytes.len() - 1]).unwrap_err().code(), "frame-byte-budget");

    let short_stride_bytes = vec![0u8; 100 * 32];
    let bad = metadata(&ticket, 64, 32, 100, "identity");
    assert_eq!(bad.encode(&ticket, &short_stride_bytes).unwrap_err().code(), "frame-stride-too-small");

    let bad = metadata(&ticket, 64, 32, stride, "cw90");
    assert_eq!(bad.encode(&ticket, &bytes).unwrap_err().code(), "frame-geometry-mismatch");

    let bad = metadata(&ticket, 64, 32, stride, "diagonal");
    assert_eq!(bad.encode(&ticket, &bytes).unwrap_err().code(), "unknown-transform");
}

#[test]
fn finish_rejects_rotation_permission_and_scope_changes_during_encoding() {
    let mut rotation = controller(64, 32);
    let ticket = screenshot_ticket(&mut rotation, "rotate-during-encode");
    let (bytes, stride) = quadrants(64, 32, 0);
    let image = encode_frame(&ticket, &bytes, stride);
    publish_real(&mut rotation, "all", 1, "yes", 64, 32);
    let rejected = rotation.finish_visual(&ticket, image).unwrap_err();
    assert_eq!(rejected.code(), "target-generation-mismatch");

    let mut permission = controller(64, 32);
    let ticket = screenshot_ticket(&mut permission, "revoke-during-encode");
    let (bytes, stride) = quadrants(64, 32, 0);
    let image = encode_frame(&ticket, &bytes, stride);
    publish_real(&mut permission, "all", 0, "no", 64, 32);
    let rejected = permission.finish_visual(&ticket, image).unwrap_err();
    assert_eq!(rejected.code(), "authorization-changed");

    let mut scope = controller(64, 32);
    let ticket = screenshot_ticket(&mut scope, "scope-during-encode");
    let (bytes, stride) = quadrants(64, 32, 0);
    let image = encode_frame(&ticket, &bytes, stride);
    publish_real(&mut scope, "virtual-only", 0, "yes", 64, 32);
    let rejected = scope.finish_visual(&ticket, image).unwrap_err();
    assert_eq!(rejected.code(), "scope-generation-mismatch");
}

#[test]
fn read_requires_a_settled_successful_receipt() {
    let mut controller = controller(64, 32);
    let ticket = screenshot_ticket(&mut controller, "not-settled");
    let before = controller.read_visual("not-settled").unwrap_err();
    assert_eq!(before.code(), "image-not-settled");

    let finished = finish(&mut controller, &ticket);
    let still_dispatching = controller.read_visual("not-settled").unwrap_err();
    assert_eq!(still_dispatching.code(), "image-not-settled");

    let unknown = call(
        &mut controller,
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "kind": "settle",
            "callId": "not-settled",
            "receipt": {"ok": false, "code": "timeout", "executed": "unknown", "screenId": "real"}
        }),
    );
    assert_eq!(unknown["executed"], "unknown", "unexpected settle: {unknown}");
    let after_unknown = controller.read_visual("not-settled").unwrap_err();
    assert_eq!(after_unknown.code(), "image-not-settled");

    // 已编码的图像不会把 unknown 变成可交付结果。
    assert_eq!(finished["data"]["image"]["width"], 64);
}

#[test]
fn settle_rejects_missing_or_tampered_image_receipt_then_accepts_exact_metadata() {
    let mut controller = controller(64, 32);
    let ticket = screenshot_ticket(&mut controller, "receipt-check");
    let finished = finish(&mut controller, &ticket);
    let image_meta = finished["data"]["image"].clone();

    let missing = call(
        &mut controller,
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "kind": "settle",
            "callId": "receipt-check",
            "receipt": {"ok": true, "code": "screenshot-captured", "executed": "yes", "screenId": "real"}
        }),
    );
    assert_eq!(missing["code"], "invalid-visual-receipt", "missing image must be rejected: {missing}");

    let mut tampered = image_meta.clone();
    tampered["sha256"] = json!("00");
    let rejected = call(
        &mut controller,
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "kind": "settle",
            "callId": "receipt-check",
            "receipt": {"ok": true, "code": "screenshot-captured", "executed": "yes", "screenId": "real", "data": {"image": tampered}}
        }),
    );
    assert_eq!(rejected["code"], "invalid-visual-receipt", "tampered metadata must be rejected: {rejected}");

    let status = call(
        &mut controller,
        json!({"protocolVersion": PROTOCOL_VERSION, "kind": "operationStatus", "callId": "receipt-check"}),
    );
    assert_eq!(status["phase"], "dispatching", "failed settle must not terminate the call: {status}");

    let settled = settle_success(&mut controller, "receipt-check", &finished);
    assert_eq!(settled["data"]["image"]["sha256"], image_meta["sha256"]);
    let (read_meta, jpeg) = controller.read_visual("receipt-check").expect("exact receipt must deliver");
    assert_eq!(read_meta, image_meta);
    assert!(!jpeg.is_empty());
}

#[test]
fn image_cache_ttl_uses_exact_120_second_boundary_without_sleeping() {
    assert_eq!(IMAGE_DELIVERY_TTL, Duration::from_secs(120));
    let ticket = direct_ticket("ttl-1", "real", 0, 3, 16, 16, None);
    let (bytes, stride) = quadrants(16, 16, 0);
    let image = encode_frame(&ticket, &bytes, stride);

    let now = Instant::now();
    let mut cache = ImageCache::default();
    cache.insert_at(ticket, image, now).unwrap();

    assert!(cache.get_at("ttl-1", now + Duration::from_millis(119_999)).is_some());
    assert!(cache.get_at("ttl-1", now + IMAGE_DELIVERY_TTL).is_none());
    assert!(cache.get_at("ttl-1", now - Duration::from_millis(1)).is_none());
    assert_eq!(cache.len(), 1, "expiry is a read-time decision for the JPEG");
}

#[test]
fn image_cache_honors_entry_and_byte_budgets_without_losing_accounting() {
    assert_eq!(MAX_CACHED_IMAGES, 8);
    assert_eq!(MAX_CACHED_IMAGE_BYTES, 8 * 1024 * 1024);
    assert!(dsh_phone_control_core::vision::MAX_JPEG_BYTES <= MAX_CACHED_IMAGE_BYTES);
    let now = Instant::now();
    let mut cache = ImageCache::default();
    let mut sizes = Vec::new();
    for index in 0..MAX_CACHED_IMAGES {
        let call_id = format!("cache-{index}");
        let ticket = direct_ticket(&call_id, "real", 0, 3, 512, 512, None);
        let (bytes, stride) = noise(512, 512, 0xABCD_0000 + index as u32);
        let image = encode_frame(&ticket, &bytes, stride);
        let jpeg_len = image.jpeg.len();
        assert!(jpeg_len > 128 * 1024, "high-entropy frame should be large, got {jpeg_len}");
        cache.insert_at(ticket, image, now).unwrap();
        sizes.push(jpeg_len);
        assert_eq!(cache.len(), index + 1);
        assert_eq!(cache.bytes(), sizes.iter().sum::<usize>());
        assert!(cache.bytes() <= MAX_CACHED_IMAGE_BYTES);
    }
    assert_eq!(cache.len(), MAX_CACHED_IMAGES);

    let ninth = direct_ticket("cache-8", "real", 0, 3, 512, 512, None);
    let (bytes, stride) = noise(512, 512, 0xABCD_0008);
    let image = encode_frame(&ninth, &bytes, stride);
    let ninth_len = image.jpeg.len();
    cache.insert_at(ninth, image, now).unwrap();

    assert_eq!(cache.len(), MAX_CACHED_IMAGES);
    assert!(cache.get_at("cache-0", now).is_none(), "oldest entry must be evicted");
    assert!(cache.get_at("cache-8", now).is_some());
    let expected = sizes[1..].iter().sum::<usize>() + ninth_len;
    assert_eq!(cache.bytes(), expected);
    assert!(cache.bytes() <= MAX_CACHED_IMAGE_BYTES);
}

#[test]
fn image_cache_rejects_a_second_image_for_the_same_call() {
    let now = Instant::now();
    let ticket = direct_ticket("cache-duplicate", "real", 0, 3, 32, 32, None);
    let (bytes, stride) = quadrants(32, 32, 0);
    let mut cache = ImageCache::default();
    let first = cache.insert_at(ticket.clone(), encode_frame(&ticket, &bytes, stride), now).unwrap();
    assert!(cache.get_at("cache-duplicate", now).is_some());

    let duplicate = cache
        .insert_at(ticket.clone(), encode_frame(&ticket, &bytes, stride), now)
        .unwrap_err();
    assert_eq!(duplicate.code(), "image-already-produced");
    assert_eq!(cache.len(), 1);
    assert_eq!(cache.get_at("cache-duplicate", now).unwrap().metadata, first);
    assert!(cache.get_at("cache-unknown", now).is_none());
}

#[test]
fn finishing_the_same_ticket_twice_is_rejected_until_settlement() {
    let mut controller = controller(32, 32);
    let ticket = screenshot_ticket(&mut controller, "finish-twice");
    let first = finish(&mut controller, &ticket);

    let (bytes, stride) = quadrants(32, 32, 0);
    let duplicate = controller
        .finish_visual(&ticket, encode_frame(&ticket, &bytes, stride))
        .unwrap_err();
    assert_eq!(duplicate.code(), "image-already-produced");

    settle_success(&mut controller, "finish-twice", &first);
    let after_settle = controller
        .finish_visual(&ticket, encode_frame(&ticket, &bytes, stride))
        .unwrap_err();
    assert_eq!(after_settle.code(), "visual-dispatch-required");
}

#[test]
fn evicting_unrelated_images_keeps_lifecycle_receipts_and_reports_expiry() {
    let mut controller = controller(16, 16);
    let mut first_meta = Value::Null;
    for index in 0..=MAX_CACHED_IMAGES {
        let call_id = format!("evict-{index}");
        let ticket = screenshot_ticket(&mut controller, &call_id);
        let finished = finish(&mut controller, &ticket);
        settle_success(&mut controller, &call_id, &finished);
        if index == 0 {
            first_meta = finished["data"]["image"].clone();
        }
    }

    let expired = controller.read_visual("evict-0").unwrap_err();
    assert_eq!(expired.code(), "image-result-expired");
    let status = call(
        &mut controller,
        json!({"protocolVersion": PROTOCOL_VERSION, "kind": "operationStatus", "callId": "evict-0"}),
    );
    assert_eq!(status["phase"], "settled");
    assert_eq!(status["terminal"], true);
    assert_eq!(status["receipt"]["data"]["image"], first_meta);

    let capabilities = call(
        &mut controller,
        json!({"protocolVersion": PROTOCOL_VERSION, "kind": "capabilities"}),
    );
    assert!(
        capabilities["lifecycleRecords"].as_u64().unwrap() >= (MAX_CACHED_IMAGES + 1) as u64,
        "eviction must not remove lifecycle records: {capabilities}"
    );
    let (_, newest) = controller.read_visual("evict-8").expect("newest image remains readable");
    assert!(!newest.is_empty());
}

#[test]
fn revoked_target_scope_never_delivers_a_cached_image() {
    let mut controller = controller(32, 32);
    let ticket = screenshot_ticket(&mut controller, "scope-invalidated");
    let finished = finish(&mut controller, &ticket);
    settle_success(&mut controller, "scope-invalidated", &finished);
    controller.read_visual("scope-invalidated").expect("image is readable while scope allows real");

    publish_real(&mut controller, "virtual-only", 0, "yes", 32, 32);
    let denied = controller.read_visual("scope-invalidated").unwrap_err();
    assert_eq!(denied.code(), "image-result-expired", "scope invalidation must drop the JPEG: {denied}");

    let status = call(
        &mut controller,
        json!({"protocolVersion": PROTOCOL_VERSION, "kind": "operationStatus", "callId": "scope-invalidated"}),
    );
    assert_eq!(status["phase"], "settled");
    assert_eq!(status["receipt"]["ok"], true);

    let ticket = direct_ticket("retain-1", "real", 0, 4, 32, 32, None);
    let (bytes, stride) = quadrants(32, 32, 0);
    let mut cache = ImageCache::default();
    let now = Instant::now();
    cache.insert_at(ticket.clone(), encode_frame(&ticket, &bytes, stride), now).unwrap();
    cache.retain(|candidate| candidate.target.generation != ticket.target.generation);
    assert_eq!(cache.len(), 0);
    assert_eq!(cache.bytes(), 0);
    assert!(cache.get_at("retain-1", now).is_none());
}

fn direct_ticket(
    call_id: &str,
    alias: &str,
    display_id: i32,
    generation: u64,
    width: u32,
    height: u32,
    region: Option<LogicalRect>,
) -> VisualTicket {
    let binding = ScreenBinding {
        alias: alias.to_owned(),
        display_id,
        width,
        height,
        rotation: 0,
        generation,
    };
    let plan = DispatchPlan {
        op: if region.is_some() { "readRegion" } else { "screenshot" },
        epoch: 7,
        target: PlanTarget::AndroidScreen(binding),
        scope_generation: Some(1),
        authorization_generation: Some(1),
        backend: Backend::A11y,
    };
    let target = ScreenTarget::new(7, alias, display_id, generation, width, height)
        .expect("direct target must be valid");
    VisualTicket { call_id: call_id.to_owned(), plan, target, region }
}
