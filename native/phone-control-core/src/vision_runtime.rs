//! 原生视觉交付的短时资源缓存。缓存淘汰只释放 JPEG，不清除操作生命周期。

use std::collections::{BTreeMap, VecDeque};
use std::time::{Duration, Instant};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use crate::policy::DispatchPlan;
use crate::vision::{LogicalRect, RawRgbaFrame, Rotation, ScreenTarget, VisionError, VisionImage};

pub const MAX_CACHED_IMAGES: usize = 8;
pub const MAX_CACHED_IMAGE_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_JNI_FRAME_BYTES: usize = 64 * 1024 * 1024;
pub const IMAGE_DELIVERY_TTL: Duration = Duration::from_secs(120);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VisualTicket {
    pub call_id: String,
    pub plan: DispatchPlan,
    pub target: ScreenTarget,
    pub region: Option<LogicalRect>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FrameMetadata {
    pub call_id: String,
    pub epoch: String,
    pub screen_id: String,
    pub display_id: i32,
    pub generation: String,
    pub logical_width: u32,
    pub logical_height: u32,
    pub width: u32,
    pub height: u32,
    pub row_stride: usize,
    pub premultiplied_alpha: bool,
    pub transform: String,
}

impl FrameMetadata {
    pub fn validate(&self, ticket: &VisualTicket, length: usize) -> Result<(), VisionError> {
        let target = &ticket.target;
        if self.call_id != ticket.call_id || self.epoch != target.epoch.to_string()
            || self.screen_id != target.screen_id || self.display_id != target.display_id
            || self.generation != target.generation.to_string()
            || self.logical_width != target.logical_width || self.logical_height != target.logical_height {
            return Err(VisionError::new("frame-target-mismatch", "raw frame does not belong to the dispatched target"));
        }
        let expected = self.row_stride.checked_mul(self.height as usize)
            .ok_or_else(|| VisionError::new("frame-size-overflow", "raw frame length overflow"))?;
        if expected != length || length > MAX_JNI_FRAME_BYTES {
            return Err(VisionError::new("frame-byte-budget", "raw frame exceeds the JNI budget or has a different length"));
        }
        let rotation = Rotation::from_wire(&self.transform)?;
        if rotation.logical_dimensions(self.width, self.height) != (target.logical_width, target.logical_height) {
            return Err(VisionError::new("frame-geometry-mismatch", "explicit frame transform does not match the logical display"));
        }
        Ok(())
    }

    pub fn encode(&self, ticket: &VisualTicket, bytes: &[u8]) -> Result<VisionImage, VisionError> {
        self.validate(ticket, bytes.len())?;
        let frame = RawRgbaFrame::new(self.width, self.height, self.row_stride, bytes,
            self.premultiplied_alpha, Rotation::from_wire(&self.transform)?)?;
        let source = |screen: &str| (screen == ticket.target.screen_id).then(|| ticket.target.clone());
        match ticket.region {
            Some(rect) => crate::vision::encode_region(&source, &ticket.target, &frame, rect.x1, rect.y1, rect.x2, rect.y2),
            None => crate::vision::encode_screenshot(&source, &ticket.target, &frame),
        }
    }
}

pub struct CachedImage {
    pub ticket: VisualTicket,
    pub metadata: Value,
    pub jpeg: Vec<u8>,
    stored_at: Instant,
}

#[derive(Default)]
pub struct ImageCache {
    entries: BTreeMap<String, CachedImage>,
    order: VecDeque<String>,
    bytes: usize,
}

impl ImageCache {
    pub fn insert(&mut self, ticket: VisualTicket, image: VisionImage) -> Result<Value, VisionError> {
        self.insert_at(ticket, image, Instant::now())
    }

    #[doc(hidden)]
    pub fn insert_at(&mut self, ticket: VisualTicket, image: VisionImage, now: Instant) -> Result<Value, VisionError> {
        if self.entries.contains_key(&ticket.call_id) {
            return Err(VisionError::new("image-already-produced", "a call cannot replace an already encoded image"));
        }
        if image.epoch != ticket.target.epoch || image.screen_id != ticket.target.screen_id
            || image.display_id != ticket.target.display_id || image.screen_generation != ticket.target.generation
            || image.logical_size() != (ticket.target.logical_width, ticket.target.logical_height) {
            return Err(VisionError::new("image-target-mismatch", "encoded image target differs from its dispatch ticket"));
        }
        let rect = ticket.region.unwrap_or(LogicalRect { x1: 0, y1: 0,
            x2: ticket.target.logical_width as i32, y2: ticket.target.logical_height as i32 });
        if image.region != rect {
            return Err(VisionError::new("image-region-mismatch", "encoded image region differs from the authorized region"));
        }
        let jpeg = image.jpeg.into_bytes();
        if jpeg.is_empty() || jpeg.len() > crate::vision::MAX_JPEG_BYTES {
            return Err(VisionError::new("jpeg-budget-exceeded", "encoded image exceeds the delivery budget"));
        }
        let digest = format!("{:x}", Sha256::digest(&jpeg));
        let image_id = format!("{:x}", Sha256::digest(format!("{}:{}:{}:{}", ticket.call_id,
            ticket.target.epoch, ticket.target.generation, digest).as_bytes()));
        let metadata = json!({
            "imageId": image_id, "mediaType": "image/jpeg", "bytes": jpeg.len(), "sha256": digest,
            "epoch": ticket.target.epoch.to_string(), "screenId": ticket.target.screen_id,
            "generation": ticket.target.generation.to_string(),
            "width": ticket.target.logical_width, "height": ticket.target.logical_height,
            "region": {"x1": rect.x1, "y1": rect.y1, "x2": rect.x2, "y2": rect.y2}
        });
        while self.entries.len() >= MAX_CACHED_IMAGES || self.bytes + jpeg.len() > MAX_CACHED_IMAGE_BYTES {
            let oldest = self.order.pop_front().ok_or_else(|| VisionError::new("image-cache-inconsistent", "cache order is empty"))?;
            if let Some(old) = self.entries.remove(&oldest) { self.bytes -= old.jpeg.len(); }
        }
        self.bytes += jpeg.len();
        let call_id = ticket.call_id.clone();
        self.entries.insert(call_id.clone(), CachedImage { ticket, metadata: metadata.clone(), jpeg, stored_at: now });
        self.order.push_back(call_id);
        Ok(metadata)
    }

    pub fn get(&self, call_id: &str) -> Option<&CachedImage> { self.get_at(call_id, Instant::now()) }

    #[doc(hidden)]
    pub fn get_at(&self, call_id: &str, now: Instant) -> Option<&CachedImage> {
        self.entries.get(call_id).filter(|image|
            now.checked_duration_since(image.stored_at).is_some_and(|age| age < IMAGE_DELIVERY_TTL))
    }

    pub fn retain(&mut self, mut permitted: impl FnMut(&VisualTicket) -> bool) {
        let now = Instant::now();
        self.entries.retain(|_, image| permitted(&image.ticket) &&
            now.checked_duration_since(image.stored_at).is_some_and(|age| age < IMAGE_DELIVERY_TTL));
        self.order.retain(|id| self.entries.contains_key(id));
        self.bytes = self.entries.values().map(|image| image.jpeg.len()).sum();
    }

    pub fn len(&self) -> usize { self.entries.len() }
    pub fn bytes(&self) -> usize { self.bytes }
}
