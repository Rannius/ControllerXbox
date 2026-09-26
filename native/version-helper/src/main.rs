//! Bounded, stdin/stdout-only Oodle decoder for a game's version INI.
//! Protocol: little-endian u32 output length, then one compressed block.
use std::io::{self, Read, Write};

fn decode() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = Vec::new();
    io::stdin().take(128 * 1024 + 5).read_to_end(&mut input)?;
    if input.len() <= 4 || input.len() > 128 * 1024 + 4 {
        return Err("invalid input size".into());
    }
    let size = u32::from_le_bytes(input[..4].try_into()?) as usize;
    if size == 0 || size > 64 * 1024 {
        return Err("invalid output size".into());
    }
    let mut output = vec![0u8; size];
    let count = oozextract::Extractor::new().read_from_slice(&input[4..], &mut output)?;
    if count != size {
        return Err("incomplete output".into());
    }
    io::stdout().write_all(&output)?;
    Ok(())
}

fn main() {
    if decode().is_err() {
        std::process::exit(1);
    }
}
