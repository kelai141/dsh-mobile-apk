// Print content-defined XZ block lengths for the canonical tar stream on stdin.
use fastcdc::v2020::StreamCDC;
use std::io::{self, Write};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let stdin = io::stdin().lock();
    let mut output = io::BufWriter::new(io::stdout().lock());
    for block in StreamCDC::new(stdin, 1 << 20, 4 << 20, 8 << 20) {
        writeln!(output, "{}", block?.length)?;
    }
    output.flush()?;
    Ok(())
}
