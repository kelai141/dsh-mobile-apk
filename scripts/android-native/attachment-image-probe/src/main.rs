use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::{ColorType, DynamicImage, ImageDecoder, ImageFormat, ImageReader, Limits};
use sha2::{Digest, Sha256};
use std::env;
use std::fs::File;
use std::io::{self, Cursor, Read};
use std::time::Instant;

const MAX_INPUT: u64 = 16 * 1024 * 1024;
const MAX_PIXELS: u64 = 16_000_000;
const ITERATIONS: usize = 6;
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

fn decode(input: &[u8], apply_orientation: bool) -> Result<DynamicImage> {
    // Scope of this probe: ordinary opaque JPEG, no conversion from a source ICC profile.
    if !input.starts_with(&[0xff, 0xd8]) || !input.ends_with(&[0xff, 0xd9]) {
        return Err("incomplete JPEG fixture".into());
    }
    let mut reader = ImageReader::with_format(Cursor::new(input), ImageFormat::Jpeg);
    let mut limits = Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    let mut decoder = reader.into_decoder()?;
    let (width, height) = decoder.dimensions();
    if u64::from(width) * u64::from(height) > MAX_PIXELS
        || decoder.color_type() != ColorType::Rgb8
        || decoder.icc_profile()?.is_some()
    {
        return Err("fixture outside opaque 8-bit RGB JPEG probe scope".into());
    }
    let orientation = decoder.orientation()?;
    let mut image = DynamicImage::from_decoder(decoder)?;
    if apply_orientation {
        image.apply_orientation(orientation);
    }
    Ok(image)
}

#[cfg(unix)]
fn usage() -> Result<(f64, i64)> {
    let mut value = std::mem::MaybeUninit::<libc::rusage>::uninit();
    // SAFETY: getrusage writes the initialized result when it returns zero.
    if unsafe { libc::getrusage(libc::RUSAGE_SELF, value.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error().into());
    }
    let value = unsafe { value.assume_init() };
    let ms = |t: libc::timeval| t.tv_sec as f64 * 1000.0 + t.tv_usec as f64 / 1000.0;
    let rss = value.ru_maxrss as i64;
    Ok((
        ms(value.ru_utime) + ms(value.ru_stime),
        if cfg!(target_os = "macos") {
            rss / 1024
        } else {
            rss
        },
    ))
}

#[cfg(not(unix))]
fn usage() -> Result<(f64, i64)> {
    Ok((0.0, 0))
}

fn timed<T>(action: impl FnOnce() -> Result<T>) -> Result<(T, f64, f64)> {
    let start = Instant::now();
    let cpu = usage()?.0;
    let result = action()?;
    Ok((
        result,
        start.elapsed().as_secs_f64() * 1000.0,
        usage()?.0 - cpu,
    ))
}

fn run() -> Result<()> {
    let mut args = env::args_os().skip(1);
    let path = args
        .next()
        .ok_or("usage: dsh-attachment-image-probe <oriented.jpg>")?;
    if args.next().is_some() {
        return Err("expected a single fixture path".into());
    }
    let mut input = Vec::new();
    File::open(path)?
        .take(MAX_INPUT + 1)
        .read_to_end(&mut input)?;
    if input.len() as u64 > MAX_INPUT {
        return Err("fixture exceeds compressed size limit".into());
    }
    let input_hash = format!("{:x}", Sha256::digest(&input));
    let mut rows = Vec::with_capacity(ITERATIONS);
    for n in 0..ITERATIONS {
        let (source, admit, admit_cpu) = timed(|| decode(&input, false))?;
        if (source.width(), source.height()) != (4000, 3000) {
            return Err("expected the 4000×3000 oriented fixture".into());
        }
        drop(source);
        let (output, encode, encode_cpu) = timed(|| {
            // Match the isolated baseline's second pipeline decode. Production could
            // reuse the admitted pixels, which would be a separate measurement.
            let image = decode(&input, true)?.resize(1600, 1600, FilterType::Lanczos3);
            let mut bytes = Vec::new();
            JpegEncoder::new_with_quality(&mut bytes, 85).encode_image(&image)?;
            Ok(bytes)
        })?;
        let ((), verify, verify_cpu) = timed(|| {
            let image = decode(&output, false)?;
            if (image.width(), image.height()) != (1200, 1600) {
                return Err("output does not have the expected oriented dimensions".into());
            }
            let mut decoder =
                ImageReader::with_format(Cursor::new(&output), ImageFormat::Jpeg).into_decoder()?;
            if decoder.exif_metadata()?.is_some() {
                return Err("output unexpectedly retains EXIF".into());
            }
            Ok(())
        })?;
        let output_hash = format!("{:x}", Sha256::digest(&output));
        rows.push(format!(
            "{{\"iteration\":{n},\"admissionMs\":{admit:.3},\"admissionCpuMs\":{admit_cpu:.3},\"resizeEncodeMs\":{encode:.3},\"resizeEncodeCpuMs\":{encode_cpu:.3},\"verifyOutputMs\":{verify:.3},\"verifyOutputCpuMs\":{verify_cpu:.3},\"outputBytes\":{},\"outputSha256\":\"{output_hash}\"}}",
            output.len()
        ));
    }
    if decode(&input[..input.len() / 2], false).is_ok() {
        return Err("truncation negative control was accepted".into());
    }
    println!(
        "{{\"inputBytes\":{},\"inputSha256\":\"{input_hash}\",\"peakRssKiB\":{},\"rows\":[{}]}}",
        input.len(),
        usage()?.1,
        rows.join(",")
    );
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("attachment image probe failed: {error}");
        std::process::exit(1);
    }
}
