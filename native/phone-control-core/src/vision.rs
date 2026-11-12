//! 原生视觉帧处理。
//!
//! 本模块只做一件事：把 Android 侧采集到的有界原始 RGBA 帧，按调用方显式
//! 给出的原始到逻辑旋转，裁剪成逻辑坐标矩形，并在 Rust 内编码成一张 JPEG。
//! 它不缓存帧、不做 OCR、不做自动区域发现，也不从尺寸猜测旋转。
//!
//! 稳定规则：
//! - 每次调用都重新读取当前目标绑定，epoch、screenId、displayId、generation 与
//!   逻辑宽高必须和调用方持有的目标完全一致；旧目标不会因尺寸相同而复活。
//! - 原始帧的宽高、stride 与字节长度都有上限，所有乘法使用 checked 运算。
//! - 旋转必须显式给出；变换后的尺寸必须与逻辑屏尺寸吻合，不尝试其它旋转。
//! - 区域读取使用逻辑空间的半开矩形 `[x1,x2) x [y1,y2)`，越界与退化矩形
//!   一律拒绝，不 clamp。
//! - 输出只有 JPEG。业务元数据保留逻辑屏宽高和原始矩形；编码宽高只作为内部
//!   诊断信息，不能当作屏幕尺寸。
//! - 不保留原始帧缓存。过期由调用方的 epoch/generation 校验覆盖；本模块没有
//!   可被旧截图命中的 TTL 状态。

use std::fmt;

use image::codecs::jpeg::JpegEncoder;
use image::{Rgb, RgbImage};

/// 与 `policy::MAX_DIMENSION` 保持一致，避免视觉层接受策略层拒绝的尺寸。
pub const MAX_DIMENSION: u32 = 16_384;
/// 单帧原始字节上限。16384 x 16384 RGBA 会在这里被拒绝，不允许一次性吃满内存。
pub const MAX_FRAME_BYTES: usize = 256 * 1024 * 1024;
/// 单行 stride 上限。正常屏幕宽度远低于此值，额外 padding 仍有明确边界。
pub const MAX_ROW_STRIDE: usize = 1024 * 1024;
/// JPEG 长边上限。只缩小，不放大。
pub const MAX_LONG_EDGE: u32 = 1600;
/// 默认 JPEG 质量。预算不足时只在下面这条有限阶梯内下调。
pub const JPEG_QUALITY: u8 = 80;
/// 单张 JPEG 输出上限。
pub const MAX_JPEG_BYTES: usize = 1024 * 1024;
/// 交付媒体类型。输出没有第二种格式。
pub const JPEG_MEDIA_TYPE: &str = "image/jpeg";

// 只做小幅质量让步；仍超预算就明确失败，避免交出糊到不可读的图。
const QUALITY_LADDER: [u8; 3] = [JPEG_QUALITY, 76, 72];
const MAX_SCREEN_ID_LEN: usize = 128;

/// 原始帧到逻辑空间的显式旋转。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rotation {
    Identity,
    Cw90,
    Cw180,
    Cw270,
}

impl Rotation {
    /// 解析 JNI/薄插件传来的精确 wire 值。未知值返回错误，不猜测。
    pub fn from_wire(value: &str) -> Result<Self, VisionError> {
        match value {
            "identity" => Ok(Self::Identity),
            "cw90" => Ok(Self::Cw90),
            "cw180" => Ok(Self::Cw180),
            "cw270" => Ok(Self::Cw270),
            other => Err(VisionError::new(
                "unknown-transform",
                format!("unsupported raw-to-logical transform {other:?}"),
            )),
        }
    }

    pub const fn wire(self) -> &'static str {
        match self {
            Self::Identity => "identity",
            Self::Cw90 => "cw90",
            Self::Cw180 => "cw180",
            Self::Cw270 => "cw270",
        }
    }

    /// 原始帧经过该旋转后的逻辑尺寸。
    pub const fn logical_dimensions(self, raw_width: u32, raw_height: u32) -> (u32, u32) {
        match self {
            Self::Identity | Self::Cw180 => (raw_width, raw_height),
            Self::Cw90 | Self::Cw270 => (raw_height, raw_width),
        }
    }

    fn raw_coordinates(
        self,
        logical_x: u32,
        logical_y: u32,
        raw_width: u32,
        raw_height: u32,
    ) -> (u32, u32) {
        match self {
            Self::Identity => (logical_x, logical_y),
            Self::Cw90 => (logical_y, raw_height - 1 - logical_x),
            Self::Cw180 => (raw_width - 1 - logical_x, raw_height - 1 - logical_y),
            Self::Cw270 => (raw_width - 1 - logical_y, logical_x),
        }
    }
}

/// 目标屏幕绑定。调用方从策略层拿到当前绑定后传入；视觉层每次都会重新校验。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScreenTarget {
    pub epoch: u64,
    pub screen_id: String,
    pub display_id: i32,
    pub generation: u64,
    pub logical_width: u32,
    pub logical_height: u32,
}

impl ScreenTarget {
    /// 构造并校验一个目标绑定。字段仍公开，调用方可从策略层直接投影。
    pub fn new(
        epoch: u64,
        screen_id: impl Into<String>,
        display_id: i32,
        generation: u64,
        logical_width: u32,
        logical_height: u32,
    ) -> Result<Self, VisionError> {
        let target = Self {
            epoch,
            screen_id: screen_id.into(),
            display_id,
            generation,
            logical_width,
            logical_height,
        };
        target.validate()?;
        Ok(target)
    }

    /// 单目标自检。不是当前目标一致性检查；一致性由每次渲染调用完成。
    pub fn validate(&self) -> Result<(), VisionError> {
        if self.epoch == 0 {
            return Err(VisionError::new("invalid-epoch", "epoch must be positive"));
        }
        if self.generation == 0 {
            return Err(VisionError::new(
                "invalid-generation",
                "screen generation must be positive",
            ));
        }
        if self.display_id < 0 {
            return Err(VisionError::new(
                "invalid-display",
                "display id must not be negative",
            ));
        }
        if self.screen_id.is_empty()
            || self.screen_id.len() > MAX_SCREEN_ID_LEN
            || !self
                .screen_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        {
            return Err(VisionError::new(
                "invalid-screen-id",
                "screen id is empty, too long, or has unsafe characters",
            ));
        }
        validate_dimensions(
            self.logical_width,
            self.logical_height,
            "logical screen",
            "invalid-dimension",
        )?;
        Ok(())
    }
}

/// 当前目标的事实来源。生产接线由主 Core 实现；视觉模块不保存第二份目标状态。
pub trait TargetSource {
    fn current_target(&self, screen_id: &str) -> Option<ScreenTarget>;
}

impl<F> TargetSource for F
where
    F: Fn(&str) -> Option<ScreenTarget>,
{
    fn current_target(&self, screen_id: &str) -> Option<ScreenTarget> {
        self(screen_id)
    }
}

/// 有界原始 RGBA 帧。构造时完成尺寸、stride、长度与溢出检查。
#[derive(Clone, Copy, Debug)]
pub struct RawRgbaFrame<'a> {
    width: u32,
    height: u32,
    row_stride: usize,
    bytes: &'a [u8],
    premultiplied_alpha: bool,
    rotation: Rotation,
}

impl<'a> RawRgbaFrame<'a> {
    pub fn new(
        width: u32,
        height: u32,
        row_stride: usize,
        bytes: &'a [u8],
        premultiplied_alpha: bool,
        rotation: Rotation,
    ) -> Result<Self, VisionError> {
        validate_dimensions(width, height, "raw frame", "frame-dimension-too-large")?;

        let row_bytes = (width as usize).checked_mul(4).ok_or_else(|| {
            VisionError::new("frame-size-overflow", "raw row byte count overflowed")
        })?;
        if row_stride < row_bytes {
            return Err(VisionError::new(
                "frame-stride-too-small",
                format!("row stride {row_stride} is smaller than {row_bytes}"),
            ));
        }
        if row_stride > MAX_ROW_STRIDE {
            return Err(VisionError::new(
                "frame-stride-too-large",
                format!("row stride {row_stride} exceeds {MAX_ROW_STRIDE}"),
            ));
        }

        let expected = row_stride.checked_mul(height as usize).ok_or_else(|| {
            VisionError::new("frame-size-overflow", "raw frame byte count overflowed")
        })?;
        if expected > MAX_FRAME_BYTES {
            return Err(VisionError::new(
                "frame-too-large",
                format!("raw frame needs {expected} bytes, limit is {MAX_FRAME_BYTES}"),
            ));
        }
        if bytes.len() != expected {
            return Err(VisionError::new(
                "frame-length-mismatch",
                format!("raw frame has {} bytes, expected {expected}", bytes.len()),
            ));
        }

        Ok(Self {
            width,
            height,
            row_stride,
            bytes,
            premultiplied_alpha,
            rotation,
        })
    }

    pub const fn width(&self) -> u32 {
        self.width
    }

    pub const fn height(&self) -> u32 {
        self.height
    }

    pub const fn row_stride(&self) -> usize {
        self.row_stride
    }

    pub const fn premultiplied_alpha(&self) -> bool {
        self.premultiplied_alpha
    }

    pub const fn rotation(&self) -> Rotation {
        self.rotation
    }

    pub const fn logical_dimensions(&self) -> (u32, u32) {
        self.rotation.logical_dimensions(self.width, self.height)
    }

    fn rgba(&self, x: u32, y: u32) -> [u8; 4] {
        let offset = (y as usize) * self.row_stride + (x as usize) * 4;
        [
            self.bytes[offset],
            self.bytes[offset + 1],
            self.bytes[offset + 2],
            self.bytes[offset + 3],
        ]
    }
}

/// 逻辑坐标中的半开矩形：`[x1,x2) x [y1,y2)`。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LogicalRect {
    pub x1: i32,
    pub y1: i32,
    pub x2: i32,
    pub y2: i32,
}

impl LogicalRect {
    pub const fn width(self) -> i32 {
        self.x2 - self.x1
    }

    pub const fn height(self) -> i32 {
        self.y2 - self.y1
    }
}

/// 单张 JPEG 及其内部编码几何。
#[derive(Clone, Debug)]
pub struct EncodedJpeg {
    bytes: Vec<u8>,
    width: u32,
    height: u32,
}

impl EncodedJpeg {
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub fn into_bytes(self) -> Vec<u8> {
        self.bytes
    }

    pub fn len(&self) -> usize {
        self.bytes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }

    /// 固定为 `image/jpeg`。
    pub const fn media_type(&self) -> &'static str {
        JPEG_MEDIA_TYPE
    }

    /// 编码后的像素宽高。仅供内部诊断与测试，不属于模型可见屏幕尺寸。
    #[doc(hidden)]
    pub fn encoding_dimensions(&self) -> (u32, u32) {
        (self.width, self.height)
    }
}

/// 一次视觉交付。业务尺寸只有逻辑屏宽高与原始矩形，编码尺寸不在这里。
#[derive(Clone, Debug)]
pub struct VisionImage {
    pub epoch: u64,
    pub screen_id: String,
    pub display_id: i32,
    pub screen_generation: u64,
    pub logical_width: u32,
    pub logical_height: u32,
    pub region: LogicalRect,
    pub jpeg: EncodedJpeg,
}

impl VisionImage {
    pub fn logical_size(&self) -> (u32, u32) {
        (self.logical_width, self.logical_height)
    }
}

/// 稳定错误码。文本只用于诊断，调用方应按 code 分支。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VisionError {
    code: &'static str,
    detail: String,
}

impl VisionError {
    pub fn new(code: &'static str, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
        }
    }

    pub const fn code(&self) -> &'static str {
        self.code
    }

    pub fn detail(&self) -> &str {
        &self.detail
    }
}

impl fmt::Display for VisionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.detail)
    }
}

impl std::error::Error for VisionError {}

/// 截取整块逻辑屏。输出仍以逻辑屏尺寸为准，必要时等比缩到长边 1600。
pub fn encode_screenshot<S: TargetSource + ?Sized>(
    source: &S,
    target: &ScreenTarget,
    frame: &RawRgbaFrame<'_>,
) -> Result<VisionImage, VisionError> {
    let logical_width = target.logical_width;
    let logical_height = target.logical_height;
    let x2 = i32::try_from(logical_width).map_err(|_| {
        VisionError::new(
            "invalid-dimension",
            "logical width does not fit region coordinates",
        )
    })?;
    let y2 = i32::try_from(logical_height).map_err(|_| {
        VisionError::new(
            "invalid-dimension",
            "logical height does not fit region coordinates",
        )
    })?;
    render(
        source,
        target,
        frame,
        LogicalRect {
            x1: 0,
            y1: 0,
            x2,
            y2,
        },
    )
}

/// 按逻辑坐标读取局部。左上 `(x1,y1)`，右下 `(x2,y2)`，右下是开区间。
pub fn encode_region<S: TargetSource + ?Sized>(
    source: &S,
    target: &ScreenTarget,
    frame: &RawRgbaFrame<'_>,
    x1: i32,
    y1: i32,
    x2: i32,
    y2: i32,
) -> Result<VisionImage, VisionError> {
    render(source, target, frame, LogicalRect { x1, y1, x2, y2 })
}

/// 测试专用入口：用收紧的字节预算证明超限会返回稳定错误，而不是空图或继续
/// 降质。生产调用只能使用上面的固定 1 MiB 预算。
#[cfg(test)]
#[doc(hidden)]
pub fn encode_region_with_budget_for_test<S: TargetSource + ?Sized>(
    source: &S,
    target: &ScreenTarget,
    frame: &RawRgbaFrame<'_>,
    region: LogicalRect,
    max_bytes: usize,
) -> Result<EncodedJpeg, VisionError> {
    verify_current_target(source, target)?;
    let logical = frame.logical_dimensions();
    if logical != (target.logical_width, target.logical_height) {
        return Err(VisionError::new(
            "frame-logical-size-mismatch",
            "test frame does not match target",
        ));
    }
    validate_region(region, target.logical_width, target.logical_height)?;
    encode_bounded_jpeg(frame, region, max_bytes)
}

fn render<S: TargetSource + ?Sized>(
    source: &S,
    target: &ScreenTarget,
    frame: &RawRgbaFrame<'_>,
    region: LogicalRect,
) -> Result<VisionImage, VisionError> {
    verify_current_target(source, target)?;

    let logical = frame.logical_dimensions();
    if logical != (target.logical_width, target.logical_height) {
        return Err(VisionError::new(
            "frame-logical-size-mismatch",
            format!(
                "raw {}x{} with {} becomes {}x{}, but target {}x{} requires an explicit matching transform",
                frame.width,
                frame.height,
                frame.rotation.wire(),
                logical.0,
                logical.1,
                target.logical_width,
                target.logical_height
            ),
        ));
    }

    validate_region(region, target.logical_width, target.logical_height)?;
    let jpeg = encode_bounded_jpeg(frame, region, MAX_JPEG_BYTES)?;

    Ok(VisionImage {
        epoch: target.epoch,
        screen_id: target.screen_id.clone(),
        display_id: target.display_id,
        screen_generation: target.generation,
        logical_width: target.logical_width,
        logical_height: target.logical_height,
        region,
        jpeg,
    })
}

fn verify_current_target<S: TargetSource + ?Sized>(
    source: &S,
    requested: &ScreenTarget,
) -> Result<(), VisionError> {
    requested.validate()?;
    let current = source.current_target(&requested.screen_id).ok_or_else(|| {
        VisionError::new(
            "unknown-target",
            format!("screen {} is not registered", requested.screen_id),
        )
    })?;
    current.validate()?;

    if current.epoch != requested.epoch {
        return Err(VisionError::new(
            "epoch-mismatch",
            format!(
                "request epoch {} does not match current epoch {}",
                requested.epoch, current.epoch
            ),
        ));
    }
    if current.screen_id != requested.screen_id {
        return Err(VisionError::new(
            "target-screen-mismatch",
            format!(
                "current target {} does not match requested {}",
                current.screen_id, requested.screen_id
            ),
        ));
    }
    if current.generation != requested.generation {
        return Err(VisionError::new(
            "target-generation-mismatch",
            format!(
                "screen {} generation {} is stale; current generation is {}",
                requested.screen_id, requested.generation, current.generation
            ),
        ));
    }
    if current.display_id != requested.display_id {
        return Err(VisionError::new(
            "target-display-mismatch",
            format!(
                "screen display {} does not match requested display {}",
                current.display_id, requested.display_id
            ),
        ));
    }
    if current.logical_width != requested.logical_width
        || current.logical_height != requested.logical_height
    {
        return Err(VisionError::new(
            "target-size-mismatch",
            format!(
                "screen logical size {}x{} does not match requested {}x{}",
                current.logical_width,
                current.logical_height,
                requested.logical_width,
                requested.logical_height
            ),
        ));
    }
    Ok(())
}

fn validate_dimensions(
    width: u32,
    height: u32,
    label: &str,
    code: &'static str,
) -> Result<(), VisionError> {
    if width == 0 || height == 0 || width > MAX_DIMENSION || height > MAX_DIMENSION {
        return Err(VisionError::new(
            code,
            format!("{label} size {width}x{height} is outside 1..={MAX_DIMENSION}"),
        ));
    }
    Ok(())
}

fn validate_region(
    region: LogicalRect,
    logical_width: u32,
    logical_height: u32,
) -> Result<(), VisionError> {
    let width = i64::from(logical_width);
    let height = i64::from(logical_height);
    if region.x1 < 0
        || region.y1 < 0
        || i64::from(region.x2) <= i64::from(region.x1)
        || i64::from(region.y2) <= i64::from(region.y1)
        || i64::from(region.x2) > width
        || i64::from(region.y2) > height
    {
        return Err(VisionError::new(
            "invalid-region",
            format!(
                "region ({},{},{},{}) is outside logical {}x{} or degenerate",
                region.x1, region.y1, region.x2, region.y2, logical_width, logical_height
            ),
        ));
    }
    Ok(())
}

fn render_bounded_rgb(
    frame: &RawRgbaFrame<'_>,
    region: LogicalRect,
    width: u32,
    height: u32,
) -> RgbImage {
    let mut output = RgbImage::new(width, height);
    let region_width = region.width() as u64;
    let region_height = region.height() as u64;

    let x_samples: Vec<Samples> = (0..width)
        .map(|output_x| {
            let start = region.x1 as u64 + (u64::from(output_x) * region_width) / u64::from(width);
            let end = (region.x1 as u64
                + ((u64::from(output_x) + 1) * region_width) / u64::from(width))
            .max(start + 1);
            sample_positions(start, end)
        })
        .collect();

    for output_y in 0..height {
        let start = region.y1 as u64 + (u64::from(output_y) * region_height) / u64::from(height);
        let end = (region.y1 as u64
            + ((u64::from(output_y) + 1) * region_height) / u64::from(height))
        .max(start + 1);
        let y_samples = sample_positions(start, end);
        for output_x in 0..width {
            let mut totals = [0u64; 3];
            let mut count = 0u64;
            for &logical_y in y_samples.values() {
                for &logical_x in x_samples[output_x as usize].values() {
                    let (raw_x, raw_y) = frame.rotation.raw_coordinates(
                        logical_x as u32,
                        logical_y as u32,
                        frame.width,
                        frame.height,
                    );
                    let [red, green, blue, alpha] = frame.rgba(raw_x, raw_y);
                    let (red, green, blue) = if frame.premultiplied_alpha {
                        // 预乘帧的 RGB 已含透明度权重。合法值本就不超过 alpha；
                        // 上限保护让损坏的透明像素仍归零，不把无效颜色带进 JPEG。
                        (red.min(alpha), green.min(alpha), blue.min(alpha))
                    } else {
                        // JPEG 没有 alpha。直通 RGBA 统一合成到黑底，结果可预测。
                        (
                            over_black(red, alpha),
                            over_black(green, alpha),
                            over_black(blue, alpha),
                        )
                    };
                    totals[0] += u64::from(red);
                    totals[1] += u64::from(green);
                    totals[2] += u64::from(blue);
                    count += 1;
                }
            }
            let average = |total: u64| ((total + count / 2) / count) as u8;
            output.put_pixel(
                output_x,
                output_y,
                Rgb([average(totals[0]), average(totals[1]), average(totals[2])]),
            );
        }
    }

    output
}

/// 面积采样的少量代表点。每个轴最多 4 个，极端缩小时成本仍有上限。
const MAX_SAMPLES_PER_AXIS: usize = 4;

struct Samples {
    values: [u64; MAX_SAMPLES_PER_AXIS],
    len: usize,
}

impl Samples {
    fn values(&self) -> &[u64] {
        &self.values[..self.len]
    }
}

fn sample_positions(start: u64, end: u64) -> Samples {
    let span = end - start;
    if span <= MAX_SAMPLES_PER_AXIS as u64 {
        let mut samples = Samples {
            values: [0; MAX_SAMPLES_PER_AXIS],
            len: 0,
        };
        for value in start..end {
            samples.values[samples.len] = value;
            samples.len += 1;
        }
        return samples;
    }
    Samples {
        values: [start, start + span / 3, start + (span * 2) / 3, end - 1],
        len: MAX_SAMPLES_PER_AXIS,
    }
}

fn over_black(channel: u8, alpha: u8) -> u8 {
    ((u32::from(channel) * u32::from(alpha) + 127) / 255) as u8
}

fn encode_bounded_jpeg(
    frame: &RawRgbaFrame<'_>,
    region: LogicalRect,
    max_bytes: usize,
) -> Result<EncodedJpeg, VisionError> {
    let (encoded_width, encoded_height) =
        bounded_dimensions(region.width() as u32, region.height() as u32);
    let source = render_bounded_rgb(frame, region, encoded_width, encoded_height);

    for quality in QUALITY_LADDER {
        let mut bytes = Vec::new();
        let mut encoder = JpegEncoder::new_with_quality(&mut bytes, quality);
        encoder.encode_image(&source).map_err(|error| {
            VisionError::new(
                "jpeg-encode-failed",
                format!("JPEG encoder failed: {error}"),
            )
        })?;
        if !is_jpeg(&bytes) {
            return Err(VisionError::new(
                "jpeg-encode-failed",
                "JPEG encoder returned a non-JPEG payload",
            ));
        }
        if bytes.len() <= max_bytes {
            return Ok(EncodedJpeg {
                bytes,
                width: encoded_width,
                height: encoded_height,
            });
        }
    }

    Err(VisionError::new(
        "jpeg-budget-exceeded",
        format!(
            "JPEG still exceeds {max_bytes} bytes at quality {}; refusing an empty or over-blurred image",
            QUALITY_LADDER[QUALITY_LADDER.len() - 1]
        ),
    ))
}

fn bounded_dimensions(width: u32, height: u32) -> (u32, u32) {
    let long_edge = width.max(height);
    if long_edge <= MAX_LONG_EDGE {
        return (width, height);
    }

    if width >= height {
        let scaled = scaled_short_edge(height, width, MAX_LONG_EDGE);
        (MAX_LONG_EDGE, scaled)
    } else {
        let scaled = scaled_short_edge(width, height, MAX_LONG_EDGE);
        (scaled, MAX_LONG_EDGE)
    }
}

fn scaled_short_edge(short: u32, long: u32, target_long: u32) -> u32 {
    let numerator = u64::from(short) * u64::from(target_long) + u64::from(long) / 2;
    ((numerator / u64::from(long)) as u32).max(1)
}

fn is_jpeg(bytes: &[u8]) -> bool {
    bytes.len() >= 4
        && bytes[0] == 0xFF
        && bytes[1] == 0xD8
        && bytes[bytes.len() - 2] == 0xFF
        && bytes[bytes.len() - 1] == 0xD9
}
