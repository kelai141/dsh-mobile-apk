//! 视觉模块的真实行为测试。
//!
//! `src/vision.rs` 暂未在 `lib.rs` 挂载（由主线程统一接线），这里用 `#[path]`
//! 直接编译同一份源码。所有图像断言都先解码 JPEG，再按容差比较像素。

#[path = "../src/vision.rs"]
mod vision;

use std::cell::Cell;

use image::GenericImageView;
use vision::{
    encode_region, encode_region_with_budget_for_test, encode_screenshot, LogicalRect,
    RawRgbaFrame, Rotation, ScreenTarget, TargetSource, VisionImage, JPEG_MEDIA_TYPE,
    MAX_DIMENSION, MAX_JPEG_BYTES, MAX_LONG_EDGE,
};

const RED: [u8; 4] = [220, 30, 30, 255];
const GREEN: [u8; 4] = [30, 200, 60, 255];
const BLUE: [u8; 4] = [30, 60, 220, 255];
const YELLOW: [u8; 4] = [235, 220, 40, 255];

struct QuadrantFrame {
    width: u32,
    height: u32,
    row_stride: usize,
    bytes: Vec<u8>,
}

impl QuadrantFrame {
    fn new(width: u32, height: u32, padding: usize) -> Self {
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
        Self {
            width,
            height,
            row_stride,
            bytes,
        }
    }

    fn frame(&self, rotation: Rotation) -> RawRgbaFrame<'_> {
        RawRgbaFrame::new(
            self.width,
            self.height,
            self.row_stride,
            &self.bytes,
            false,
            rotation,
        )
        .expect("quadrant frame must be valid")
    }
}

struct World {
    target: ScreenTarget,
    generation: Cell<u64>,
    epoch: Cell<u64>,
    display: Cell<i32>,
}

impl World {
    fn new(target: ScreenTarget) -> Self {
        Self {
            generation: Cell::new(target.generation),
            epoch: Cell::new(target.epoch),
            display: Cell::new(target.display_id),
            target,
        }
    }

    fn current(&self) -> ScreenTarget {
        ScreenTarget {
            epoch: self.epoch.get(),
            screen_id: self.target.screen_id.clone(),
            display_id: self.display.get(),
            generation: self.generation.get(),
            logical_width: self.target.logical_width,
            logical_height: self.target.logical_height,
        }
    }
}

impl TargetSource for World {
    fn current_target(&self, screen_id: &str) -> Option<ScreenTarget> {
        (screen_id == self.target.screen_id).then(|| self.current())
    }
}

fn target(width: u32, height: u32) -> ScreenTarget {
    ScreenTarget::new(7, "virtual-3", 12, 41, width, height).expect("target must be valid")
}

fn decoded(image: &VisionImage) -> image::RgbImage {
    let decoded =
        image::load_from_memory(image.jpeg.bytes()).expect("output must decode as an image");
    decoded.to_rgb8()
}

fn sample(image: &image::RgbImage, x: u32, y: u32) -> [u8; 3] {
    image.get_pixel(x, y).0
}

fn assert_rgb_near(actual: [u8; 3], expected: [u8; 4], tolerance: i32, label: &str) {
    for channel in 0..3 {
        let delta = i32::from(actual[channel]) - i32::from(expected[channel]);
        assert!(
            delta.abs() <= tolerance,
            "{label}: channel {channel} is {}, expected {} +/- {tolerance}",
            actual[channel],
            expected[channel]
        );
    }
}

fn assert_quadrants(image: &image::RgbImage, corners: [([u8; 4], &str); 4], tolerance: i32) {
    let (width, height) = image.dimensions();
    let positions = [
        (width / 4, height / 4),
        (width * 3 / 4, height / 4),
        (width / 4, height * 3 / 4),
        (width * 3 / 4, height * 3 / 4),
    ];
    for ((expected, label), (x, y)) in corners.into_iter().zip(positions) {
        assert_rgb_near(sample(image, x, y), expected, tolerance, label);
    }
}

#[test]
fn identity_keeps_raw_pixels_and_stride_padding_is_ignored() {
    let raw = QuadrantFrame::new(64, 32, 17);
    let world = World::new(target(64, 32));
    let frame = raw.frame(Rotation::Identity);
    assert_eq!(frame.width(), 64);
    assert_eq!(frame.height(), 32);
    assert_eq!(frame.row_stride(), 64 * 4 + 17);
    assert!(!frame.premultiplied_alpha());
    assert_eq!(frame.rotation(), Rotation::Identity);
    assert_eq!(frame.logical_dimensions(), (64, 32));
    let out = encode_screenshot(&world, &world.target, &frame).unwrap();

    let image = decoded(&out);
    assert_eq!(image.dimensions(), (64, 32));
    assert_quadrants(
        &image,
        [
            (RED, "top-left"),
            (GREEN, "top-right"),
            (BLUE, "bottom-left"),
            (YELLOW, "bottom-right"),
        ],
        12,
    );
    assert_eq!(out.jpeg.media_type(), JPEG_MEDIA_TYPE);
    assert!(out.jpeg.bytes().starts_with(&[0xFF, 0xD8]));
    assert!(out.jpeg.bytes().ends_with(&[0xFF, 0xD9]));
}

#[test]
fn all_explicit_rotations_map_raw_quadrants_to_expected_logical_corners() {
    let raw = QuadrantFrame::new(64, 32, 0);
    let cases = [
        (Rotation::Identity, 64, 32, [RED, GREEN, BLUE, YELLOW]),
        (Rotation::Cw90, 32, 64, [BLUE, RED, YELLOW, GREEN]),
        (Rotation::Cw180, 64, 32, [YELLOW, BLUE, GREEN, RED]),
        (Rotation::Cw270, 32, 64, [GREEN, YELLOW, RED, BLUE]),
    ];

    for (rotation, width, height, corners) in cases {
        let world = World::new(target(width, height));
        let out = encode_screenshot(&world, &world.target, &raw.frame(rotation)).unwrap();
        let image = decoded(&out);
        assert_eq!(
            image.dimensions(),
            (width, height),
            "{} output size",
            rotation.wire()
        );
        assert_eq!(
            out.logical_size(),
            (width, height),
            "{} logical size",
            rotation.wire()
        );
        assert_quadrants(
            &image,
            [
                (corners[0], "top-left"),
                (corners[1], "top-right"),
                (corners[2], "bottom-left"),
                (corners[3], "bottom-right"),
            ],
            12,
        );
    }
}

#[test]
fn region_crops_in_logical_space_after_rotation_and_keeps_original_rect() {
    let raw = QuadrantFrame::new(64, 32, 9);
    let world = World::new(target(32, 64));
    let out = encode_region(
        &world,
        &world.target,
        &raw.frame(Rotation::Cw90),
        8,
        16,
        24,
        48,
    )
    .unwrap();

    assert_eq!(
        (out.region.x1, out.region.y1, out.region.x2, out.region.y2),
        (8, 16, 24, 48)
    );
    assert_eq!(out.region.width(), 16);
    assert_eq!(out.region.height(), 32);
    assert_eq!(out.logical_size(), (32, 64));

    let image = decoded(&out);
    assert_eq!(image.dimensions(), (16, 32));
    assert_quadrants(
        &image,
        [
            (BLUE, "region top-left"),
            (RED, "region top-right"),
            (YELLOW, "region bottom-left"),
            (GREEN, "region bottom-right"),
        ],
        12,
    );
}

#[test]
fn region_accepts_exact_edges_and_rejects_out_of_bounds_without_clamping() {
    let raw = QuadrantFrame::new(32, 32, 0);
    let world = World::new(target(32, 32));
    let frame = raw.frame(Rotation::Identity);

    let full = encode_region(&world, &world.target, &frame, 0, 0, 32, 32).unwrap();
    assert_eq!(full.region.width(), 32);

    for (x1, y1, x2, y2) in [
        (0, 0, 33, 32),
        (0, 0, 32, 33),
        (-1, 0, 20, 20),
        (0, -1, 20, 20),
        (10, 10, 10, 20),
        (10, 10, 5, 20),
        (10, 10, 20, 10),
        (10, 10, 20, 5),
    ] {
        let error = encode_region(&world, &world.target, &frame, x1, y1, x2, y2).unwrap_err();
        assert_eq!(
            error.code(),
            "invalid-region",
            "({x1},{y1},{x2},{y2}) must be rejected"
        );
    }
}

#[test]
fn alpha_is_handled_for_straight_and_premultiplied_frames() {
    let width = 8u32;
    let height = 4u32;
    let row_stride = width as usize * 4;

    let mut straight = Vec::new();
    for _y in 0..height {
        for x in 0..width {
            let pixel = if x < 4 {
                [200, 100, 50, 128]
            } else {
                [200, 100, 50, 255]
            };
            straight.extend_from_slice(&pixel);
        }
    }
    let world = World::new(target(width, height));
    let frame = RawRgbaFrame::new(
        width,
        height,
        row_stride,
        &straight,
        false,
        Rotation::Identity,
    )
    .unwrap();
    let image = decoded(&encode_screenshot(&world, &world.target, &frame).unwrap());
    assert_rgb_near(
        sample(&image, 1, 2),
        [100, 50, 25, 255],
        8,
        "straight alpha 128 over black",
    );
    assert_rgb_near(
        sample(&image, 5, 2),
        [200, 100, 50, 255],
        10,
        "opaque straight alpha",
    );

    let mut premultiplied = Vec::new();
    for _y in 0..height {
        for x in 0..width {
            let pixel = if x < 4 {
                [0, 0, 0, 0]
            } else {
                [120, 60, 20, 200]
            };
            premultiplied.extend_from_slice(&pixel);
        }
    }
    let frame = RawRgbaFrame::new(
        width,
        height,
        row_stride,
        &premultiplied,
        true,
        Rotation::Identity,
    )
    .unwrap();
    let image = decoded(&encode_screenshot(&world, &world.target, &frame).unwrap());
    assert_rgb_near(
        sample(&image, 1, 2),
        [0, 0, 0, 255],
        4,
        "transparent premultiplied",
    );
    assert_rgb_near(
        sample(&image, 5, 2),
        [120, 60, 20, 255],
        10,
        "opaque premultiplied",
    );
}

#[test]
fn large_logical_screen_is_downscaled_but_reports_original_logical_size() {
    let width = 1260u32;
    let height = 2800u32;
    let row_stride = width as usize * 4;
    let mut bytes = vec![0u8; row_stride * height as usize];
    for y in 0..height as usize {
        for x in 0..width as usize {
            let offset = y * row_stride + x * 4;
            bytes[offset] = (x % 256) as u8;
            bytes[offset + 1] = (y % 256) as u8;
            bytes[offset + 2] = 128;
            bytes[offset + 3] = 255;
        }
    }
    let world = World::new(target(width, height));
    let frame =
        RawRgbaFrame::new(width, height, row_stride, &bytes, false, Rotation::Identity).unwrap();
    let out = encode_screenshot(&world, &world.target, &frame).unwrap();

    assert_eq!(out.logical_size(), (width, height));
    assert!(out.jpeg.len() <= MAX_JPEG_BYTES);
    let image = decoded(&out);
    let (encoded_width, encoded_height) = out.jpeg.encoding_dimensions();
    assert_eq!(image.dimensions(), (encoded_width, encoded_height));
    assert_eq!(encoded_height, MAX_LONG_EDGE);
    let expected_width = ((u64::from(width) * u64::from(MAX_LONG_EDGE) + u64::from(height) / 2)
        / u64::from(height)) as u32;
    assert_eq!(encoded_width, expected_width);
    assert!(encoded_width < width);
}

#[test]
fn stale_generation_epoch_display_and_size_are_rejected() {
    let raw = QuadrantFrame::new(32, 32, 0);
    let world = World::new(target(32, 32));
    let frame = raw.frame(Rotation::Identity);
    assert!(encode_screenshot(&world, &world.target, &frame).is_ok());

    world.generation.set(42);
    assert_eq!(
        encode_screenshot(&world, &world.target, &frame)
            .unwrap_err()
            .code(),
        "target-generation-mismatch"
    );

    world.generation.set(41);
    world.epoch.set(8);
    assert_eq!(
        encode_screenshot(&world, &world.target, &frame)
            .unwrap_err()
            .code(),
        "epoch-mismatch"
    );

    world.epoch.set(7);
    world.display.set(3);
    assert_eq!(
        encode_screenshot(&world, &world.target, &frame)
            .unwrap_err()
            .code(),
        "target-display-mismatch"
    );

    world.display.set(12);
    let resized = target(32, 64);
    assert_eq!(
        encode_screenshot(&world, &resized, &frame)
            .unwrap_err()
            .code(),
        "target-size-mismatch"
    );
}

#[test]
fn unknown_or_mismatched_transform_is_never_guessed() {
    let unknown = Rotation::from_wire("cw45").unwrap_err();
    assert_eq!(unknown.code(), "unknown-transform");
    assert!(unknown.detail().contains("cw45"));
    assert_eq!(
        Rotation::from_wire("").unwrap_err().code(),
        "unknown-transform"
    );
    assert_eq!(
        Rotation::from_wire("CW90").unwrap_err().code(),
        "unknown-transform"
    );
    assert_eq!(Rotation::from_wire("cw90").unwrap(), Rotation::Cw90);

    let raw = QuadrantFrame::new(32, 64, 0);
    let world = World::new(target(64, 32));
    let error =
        encode_screenshot(&world, &world.target, &raw.frame(Rotation::Identity)).unwrap_err();
    assert_eq!(error.code(), "frame-logical-size-mismatch");
}

#[test]
fn oversized_and_malformed_raw_frames_are_rejected_before_encoding() {
    let width = 64u32;
    let height = 32u32;

    assert_eq!(
        RawRgbaFrame::new(MAX_DIMENSION + 1, 16, 4096, &[], false, Rotation::Identity)
            .unwrap_err()
            .code(),
        "frame-dimension-too-large"
    );
    assert_eq!(
        RawRgbaFrame::new(width, height, 10, &[], false, Rotation::Identity)
            .unwrap_err()
            .code(),
        "frame-stride-too-small"
    );
    assert_eq!(
        RawRgbaFrame::new(
            width,
            height,
            width as usize * 4 + 1,
            &[],
            false,
            Rotation::Identity
        )
        .unwrap_err()
        .code(),
        "frame-length-mismatch"
    );
    assert_eq!(
        RawRgbaFrame::new(
            MAX_DIMENSION,
            MAX_DIMENSION,
            MAX_DIMENSION as usize * 4,
            &[],
            false,
            Rotation::Identity
        )
        .unwrap_err()
        .code(),
        "frame-too-large"
    );
    assert_eq!(
        RawRgbaFrame::new(16, 16, 16 * 1024 * 1024, &[], false, Rotation::Identity)
            .unwrap_err()
            .code(),
        "frame-stride-too-large"
    );

    assert_eq!(
        ScreenTarget::new(0, "real", 0, 1, 10, 10)
            .unwrap_err()
            .code(),
        "invalid-epoch"
    );
    assert_eq!(
        ScreenTarget::new(1, "real", 0, 0, 10, 10)
            .unwrap_err()
            .code(),
        "invalid-generation"
    );
    assert_eq!(
        ScreenTarget::new(1, "real", 0, 1, 0, 10)
            .unwrap_err()
            .code(),
        "invalid-dimension"
    );
    assert_eq!(
        ScreenTarget::new(1, "real screen", 0, 1, 10, 10)
            .unwrap_err()
            .code(),
        "invalid-screen-id"
    );
}

#[test]
fn unknown_target_and_missing_registration_are_rejected() {
    let raw = QuadrantFrame::new(16, 16, 0);
    let world = World::new(target(16, 16));
    let outsider = ScreenTarget::new(7, "virtual-4", 13, 41, 16, 16).unwrap();
    assert_eq!(
        encode_screenshot(&world, &outsider, &raw.frame(Rotation::Identity))
            .unwrap_err()
            .code(),
        "unknown-target"
    );

    let empty: fn(&str) -> Option<ScreenTarget> = |_| None;
    assert_eq!(
        encode_screenshot(&empty, &world.target, &raw.frame(Rotation::Identity))
            .unwrap_err()
            .code(),
        "unknown-target"
    );
}

#[test]
fn output_is_exactly_one_bounded_jpeg_with_unchanged_logical_metadata() {
    let raw = QuadrantFrame::new(80, 60, 5);
    let world = World::new(target(80, 60));
    let out = encode_screenshot(&world, &world.target, &raw.frame(Rotation::Identity)).unwrap();

    assert_eq!(out.jpeg.media_type(), "image/jpeg");
    assert!(out.jpeg.len() <= MAX_JPEG_BYTES);
    assert!(!out.jpeg.is_empty());
    let bytes = out.jpeg.bytes();
    assert_eq!(&bytes[..2], &[0xFF, 0xD8]);
    assert_eq!(&bytes[bytes.len() - 2..], &[0xFF, 0xD9]);
    assert_eq!(bytes.iter().filter(|byte| **byte == 0xFF).count() > 0, true);

    let format = image::guess_format(bytes).unwrap();
    assert_eq!(format, image::ImageFormat::Jpeg);
    assert_eq!(out.logical_size(), (80, 60));
    assert_eq!(out.screen_generation, 41);
    assert_eq!(out.display_id, 12);

    assert_eq!(out.epoch, 7);
    assert_eq!(out.screen_id, "virtual-3");
    assert_eq!(out.jpeg.clone().into_bytes(), bytes);

    let mut cursor = std::io::Cursor::new(bytes);
    let reader = image::ImageReader::with_format(&mut cursor, image::ImageFormat::Jpeg);
    let decoded = reader.decode().unwrap();
    assert_eq!(decoded.dimensions(), (80, 60));
}

#[test]
fn jpeg_budget_exhaustion_is_an_error_not_an_empty_or_blurred_output() {
    let mut bytes = vec![0u8; 320 * 240 * 4];
    for y in 0..240usize {
        for x in 0..320usize {
            let offset = (y * 320 + x) * 4;
            bytes[offset] = (x * 7 % 256) as u8;
            bytes[offset + 1] = (y * 11 % 256) as u8;
            bytes[offset + 2] = ((x ^ y) % 256) as u8;
            bytes[offset + 3] = 255;
        }
    }
    let frame = RawRgbaFrame::new(320, 240, 320 * 4, &bytes, false, Rotation::Identity).unwrap();
    let world = World::new(target(320, 240));
    let region = LogicalRect {
        x1: 0,
        y1: 0,
        x2: 320,
        y2: 240,
    };

    let error =
        encode_region_with_budget_for_test(&world, &world.target, &frame, region, 64).unwrap_err();
    assert_eq!(error.code(), "jpeg-budget-exceeded");
    let normal = encode_region(&world, &world.target, &frame, 0, 0, 320, 240).unwrap();
    assert!(normal.jpeg.len() > 64);
    assert!(normal.jpeg.len() <= MAX_JPEG_BYTES);
}
