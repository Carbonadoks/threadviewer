use minicbor::Decoder;
use serde::Serialize;
use std::collections::HashMap;
use wasm_bindgen::prelude::*;

const POST_COLLECTION: &str = "app.bsky.feed.post";

// ---------------------------------------------------------------------------
// Public output type
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct ParsedPost {
    pub rkey: String,
    pub cid: String,
    /// The raw record as a JSON value (converted from DAG-CBOR).
    pub record: serde_json::Value,
}

#[derive(Serialize)]
pub struct ParsedRepoRecord {
    pub collection: String,
    pub rkey: String,
    pub cid: String,
    /// The raw record as a JSON value (converted from DAG-CBOR).
    pub record: serde_json::Value,
}

// ---------------------------------------------------------------------------
// Unsigned-varint helpers (same encoding used by multiformats)
// ---------------------------------------------------------------------------

fn read_uvarint(buf: &[u8], pos: &mut usize) -> Result<u64, &'static str> {
    let mut val: u64 = 0;
    let mut shift = 0u32;
    loop {
        if *pos >= buf.len() {
            return Err("unexpected end of varint");
        }
        let byte = buf[*pos];
        *pos += 1;
        val |= ((byte & 0x7F) as u64) << shift;
        if byte & 0x80 == 0 {
            return Ok(val);
        }
        shift += 7;
        if shift >= 64 {
            return Err("varint too long");
        }
    }
}

// ---------------------------------------------------------------------------
// CID parsing (CIDv1 with DAG-CBOR codec 0x71 + SHA-256 hash)
// ---------------------------------------------------------------------------

/// Read a CID from the buffer and return (cid_bytes_consumed, cid_string).
fn read_cid(buf: &[u8], pos: &mut usize) -> Result<(usize, String), &'static str> {
    let start = *pos;

    // Version
    let version = read_uvarint(buf, pos)?;

    if version == 0x12 {
        // CIDv0 — starts with the multihash directly (SHA2-256, 0x12 prefix).
        // Multihash: 0x12 (sha2-256) + 0x20 (32 bytes) + 32 bytes = 34 total
        // We already consumed the first varint byte as "version" which was 0x12.
        // Re-interpret: the CID is raw bytes starting from `start`, length 34.
        *pos = start;
        if start + 34 > buf.len() {
            return Err("CIDv0 truncated");
        }
        *pos = start + 34;
        let cid_str = format_cidv0(&buf[start..start + 34]);
        return Ok((34, cid_str));
    }

    if version != 1 {
        return Err("unsupported CID version");
    }

    // Codec
    let _codec = read_uvarint(buf, pos)?;

    // Multihash: hash-fn-code (varint) + digest-size (varint) + digest
    let _hash_fn = read_uvarint(buf, pos)?;
    let digest_size = read_uvarint(buf, pos)? as usize;
    if *pos + digest_size > buf.len() {
        return Err("CID digest truncated");
    }
    *pos += digest_size;

    let cid_bytes = &buf[start..*pos];
    let cid_str = multibase_base32lower(cid_bytes);
    Ok((cid_bytes.len(), cid_str))
}

fn format_cidv0(bytes: &[u8]) -> String {
    bs58::encode(bytes).into_string()
}

fn multibase_base32lower(bytes: &[u8]) -> String {
    // multibase base32lower prefix = 'b'
    let mut s = String::with_capacity(1 + bytes.len() * 2);
    s.push('b');
    s.push_str(&base32_encode_lower(bytes));
    s
}

fn base32_encode_lower(data: &[u8]) -> String {
    const ALPHABET: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";
    let mut result = String::new();
    let mut buffer: u64 = 0;
    let mut bits = 0;
    for &byte in data {
        buffer = (buffer << 8) | byte as u64;
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            result.push(ALPHABET[((buffer >> bits) & 0x1F) as usize] as char);
        }
    }
    if bits > 0 {
        result.push(ALPHABET[((buffer << (5 - bits)) & 0x1F) as usize] as char);
    }
    result
}

// ---------------------------------------------------------------------------
// CID reading from CBOR tag 42 (DAG-CBOR link)
// ---------------------------------------------------------------------------

/// Read a CBOR tag-42 encoded CID link. Returns the CID string.
fn read_cbor_cid_link(decoder: &mut Decoder<'_>) -> Result<String, &'static str> {
    // DAG-CBOR encodes CID links as CBOR tag 42 wrapping a byte string.
    // The byte string has a 0x00 prefix byte followed by the actual CID bytes.
    let bytes = decoder.bytes().map_err(|_| "expected bytes in CID link")?;
    if bytes.is_empty() {
        return Err("empty CID link bytes");
    }
    // Skip the 0x00 identity-multibase prefix
    let cid_raw = if bytes[0] == 0x00 { &bytes[1..] } else { bytes };
    let mut pos = 0;
    let (_, cid_str) = read_cid(cid_raw, &mut pos)?;
    Ok(cid_str)
}

// ---------------------------------------------------------------------------
// DAG-CBOR → serde_json::Value (recursive, handling CID links)
// ---------------------------------------------------------------------------

fn cbor_to_json(decoder: &mut Decoder<'_>) -> Result<serde_json::Value, &'static str> {
    use minicbor::data::Type;
    let ty = decoder.datatype().map_err(|_| "cannot read CBOR type")?;

    match ty {
        Type::U8 | Type::U16 | Type::U32 | Type::U64 => {
            let v = decoder.u64().map_err(|_| "u64")?;
            Ok(serde_json::Value::Number(v.into()))
        }
        Type::I8 | Type::I16 | Type::I32 | Type::I64 => {
            let v = decoder.i64().map_err(|_| "i64")?;
            Ok(serde_json::json!(v))
        }
        Type::F32 => {
            let v = decoder.f32().map_err(|_| "f32")? as f64;
            Ok(serde_json::json!(v))
        }
        Type::F64 => {
            let v = decoder.f64().map_err(|_| "f64")?;
            Ok(serde_json::json!(v))
        }
        Type::Bool => {
            let v = decoder.bool().map_err(|_| "bool")?;
            Ok(serde_json::Value::Bool(v))
        }
        Type::Null | Type::Undefined => {
            decoder.skip().map_err(|_| "skip null")?;
            Ok(serde_json::Value::Null)
        }
        Type::String => {
            let s = decoder.str().map_err(|_| "str")?;
            Ok(serde_json::Value::String(s.to_owned()))
        }
        Type::Bytes => {
            // Bare bytes (not in a tag-42 context) — encode as base64 or similar.
            let b = decoder.bytes().map_err(|_| "bytes")?;
            // Use $bytes convention used by atproto JSON representations
            let mut map = serde_json::Map::new();
            map.insert(
                "$bytes".to_owned(),
                serde_json::Value::String(base64_encode(b)),
            );
            Ok(serde_json::Value::Object(map))
        }
        Type::Array | Type::ArrayIndef => {
            let len = decoder.array().map_err(|_| "array")?;
            let mut arr = Vec::new();
            match len {
                Some(n) => {
                    for _ in 0..n {
                        arr.push(cbor_to_json(decoder)?);
                    }
                }
                None => {
                    // Indefinite length
                    while decoder.datatype().map_err(|_| "array item")? != Type::Break {
                        arr.push(cbor_to_json(decoder)?);
                    }
                    decoder.skip().map_err(|_| "break")?;
                }
            }
            Ok(serde_json::Value::Array(arr))
        }
        Type::Map | Type::MapIndef => {
            let len = decoder.map().map_err(|_| "map")?;
            let mut map = serde_json::Map::new();
            match len {
                Some(n) => {
                    for _ in 0..n {
                        let key = decoder.str().map_err(|_| "map key")?.to_owned();
                        let val = cbor_to_json(decoder)?;
                        map.insert(key, val);
                    }
                }
                None => {
                    while decoder.datatype().map_err(|_| "map entry")? != Type::Break {
                        let key = decoder.str().map_err(|_| "map key indef")?.to_owned();
                        let val = cbor_to_json(decoder)?;
                        map.insert(key, val);
                    }
                    decoder.skip().map_err(|_| "break")?;
                }
            }
            Ok(serde_json::Value::Object(map))
        }
        Type::Tag => {
            let tag = decoder.tag().map_err(|_| "tag")?;
            if tag == minicbor::data::Tag::new(42) {
                // DAG-CBOR CID link
                let cid_str = read_cbor_cid_link(decoder)?;
                let mut map = serde_json::Map::new();
                map.insert("$link".to_owned(), serde_json::Value::String(cid_str));
                Ok(serde_json::Value::Object(map))
            } else {
                // Skip unknown tags, decode the inner value
                cbor_to_json(decoder)
            }
        }
        _ => {
            decoder.skip().map_err(|_| "skip unknown")?;
            Ok(serde_json::Value::Null)
        }
    }
}

fn base64_encode(data: &[u8]) -> String {
    const CHARS: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let triple = (b0 << 16) | (b1 << 8) | b2;
        result.push(CHARS[((triple >> 18) & 0x3F) as usize] as char);
        result.push(CHARS[((triple >> 12) & 0x3F) as usize] as char);
        if chunk.len() > 1 {
            result.push(CHARS[((triple >> 6) & 0x3F) as usize] as char);
        } else {
            result.push('=');
        }
        if chunk.len() > 2 {
            result.push(CHARS[(triple & 0x3F) as usize] as char);
        } else {
            result.push('=');
        }
    }
    result
}

// ---------------------------------------------------------------------------
// MST node decoding
// ---------------------------------------------------------------------------

struct MstEntry {
    prefix_len: usize,
    key_suffix: Vec<u8>,
    value_cid: String,
    tree_cid: Option<String>,
}

struct MstNode {
    left: Option<String>,
    entries: Vec<MstEntry>,
}

fn decode_mst_node(block: &[u8]) -> Result<MstNode, &'static str> {
    let mut decoder = Decoder::new(block);
    let len = decoder.map().map_err(|_| "MST node not a map")?;
    let n = len.ok_or("MST node indefinite map")?;

    let mut left: Option<String> = None;
    let mut entries: Vec<MstEntry> = Vec::new();

    for _ in 0..n {
        let key = decoder.str().map_err(|_| "MST key")?;
        match key {
            "l" => {
                // Left subtree CID (tag 42)
                let ty = decoder.datatype().map_err(|_| "l type")?;
                if ty == minicbor::data::Type::Null {
                    decoder.skip().map_err(|_| "skip null l")?;
                } else {
                    let _tag = decoder.tag().map_err(|_| "l tag")?;
                    left = Some(read_cbor_cid_link(&mut decoder)?);
                }
            }
            "e" => {
                let arr_len = decoder.array().map_err(|_| "e array")?.ok_or("e indef")?;
                for _ in 0..arr_len {
                    let entry_len =
                        decoder.map().map_err(|_| "entry map")?.ok_or("entry indef")?;
                    let mut p: usize = 0;
                    let mut k: Vec<u8> = Vec::new();
                    let mut v: Option<String> = None;
                    let mut t: Option<String> = None;

                    for _ in 0..entry_len {
                        let field = decoder.str().map_err(|_| "entry field")?;
                        match field {
                            "p" => {
                                p = decoder.u64().map_err(|_| "p val")? as usize;
                            }
                            "k" => {
                                k = decoder.bytes().map_err(|_| "k val")?.to_vec();
                            }
                            "v" => {
                                let _tag = decoder.tag().map_err(|_| "v tag")?;
                                v = Some(read_cbor_cid_link(&mut decoder)?);
                            }
                            "t" => {
                                let ty = decoder.datatype().map_err(|_| "t type")?;
                                if ty == minicbor::data::Type::Null {
                                    decoder.skip().map_err(|_| "skip null t")?;
                                } else {
                                    let _tag = decoder.tag().map_err(|_| "t tag")?;
                                    t = Some(read_cbor_cid_link(&mut decoder)?);
                                }
                            }
                            _ => {
                                decoder.skip().map_err(|_| "skip entry field")?;
                            }
                        }
                    }

                    entries.push(MstEntry {
                        prefix_len: p,
                        key_suffix: k,
                        value_cid: v.ok_or("entry missing v")?,
                        tree_cid: t,
                    });
                }
            }
            _ => {
                decoder.skip().map_err(|_| "skip MST field")?;
            }
        }
    }

    Ok(MstNode { left, entries })
}

// ---------------------------------------------------------------------------
// CAR v1 parsing
// ---------------------------------------------------------------------------

struct CarBlock {
    cid: String,
    data: Vec<u8>,
}

fn parse_car_blocks(buf: &[u8]) -> Result<(String, Vec<CarBlock>), &'static str> {
    let mut pos = 0;

    // Header: varint-length prefixed DAG-CBOR
    let header_len = read_uvarint(buf, &mut pos)? as usize;
    if pos + header_len > buf.len() {
        return Err("header truncated");
    }

    // Decode header CBOR to get roots
    let header_bytes = &buf[pos..pos + header_len];
    let mut decoder = Decoder::new(header_bytes);
    let map_len = decoder.map().map_err(|_| "header not map")?.ok_or("header indef")?;
    let mut root_cid: Option<String> = None;

    for _ in 0..map_len {
        let key = decoder.str().map_err(|_| "header key")?;
        match key {
            "roots" => {
                let arr_len = decoder.array().map_err(|_| "roots arr")?.ok_or("roots indef")?;
                if arr_len > 0 {
                    let _tag = decoder.tag().map_err(|_| "root tag")?;
                    root_cid = Some(read_cbor_cid_link(&mut decoder)?);
                    // Skip remaining roots
                    for _ in 1..arr_len {
                        decoder.skip().map_err(|_| "skip extra root")?;
                    }
                }
            }
            _ => {
                decoder.skip().map_err(|_| "skip header field")?;
            }
        }
    }

    pos += header_len;

    let root = root_cid.ok_or("no root CID in header")?;

    // Parse blocks
    let mut blocks = Vec::new();
    while pos < buf.len() {
        let block_len = read_uvarint(buf, &mut pos)? as usize;
        if pos + block_len > buf.len() {
            break; // Truncated final block, tolerate
        }
        let block_end = pos + block_len;

        // Read CID
        let (cid_len, cid_str) = read_cid(buf, &mut pos)?;
        let _ = cid_len;
        let data = buf[pos..block_end].to_vec();
        pos = block_end;

        blocks.push(CarBlock {
            cid: cid_str,
            data,
        });
    }

    Ok((root, blocks))
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

#[wasm_bindgen(js_name = parseCarPostsWasm)]
pub fn parse_car_posts_wasm(car_bytes: &[u8]) -> Result<JsValue, JsValue> {
    // 1. Parse all CAR blocks into a CID → bytes map
    let (root_cid, blocks) =
        parse_car_blocks(car_bytes).map_err(|e| JsValue::from_str(e))?;

    let mut block_map: HashMap<String, Vec<u8>> = HashMap::with_capacity(blocks.len());
    for block in blocks {
        block_map.insert(block.cid, block.data);
    }

    // 2. Decode commit block to get MST root
    let commit_bytes = block_map
        .get(&root_cid)
        .ok_or_else(|| JsValue::from_str("commit block not found"))?;
    let mut decoder = Decoder::new(commit_bytes);
    let map_len = decoder
        .map()
        .map_err(|_| JsValue::from_str("commit not map"))?
        .ok_or_else(|| JsValue::from_str("commit indef"))?;

    let mut data_cid: Option<String> = None;
    for _ in 0..map_len {
        let key = decoder
            .str()
            .map_err(|_| JsValue::from_str("commit key"))?;
        if key == "data" {
            let _tag = decoder
                .tag()
                .map_err(|_| JsValue::from_str("data tag"))?;
            data_cid = Some(
                read_cbor_cid_link(&mut decoder)
                    .map_err(|e| JsValue::from_str(e))?,
            );
        } else {
            decoder
                .skip()
                .map_err(|_| JsValue::from_str("skip commit field"))?;
        }
    }

    let mst_root = data_cid.ok_or_else(|| JsValue::from_str("commit has no data field"))?;

    // 3. Walk MST to collect post records
    let mut posts: Vec<ParsedPost> = Vec::new();
    let mut stack: Vec<(String, String)> = vec![(mst_root, String::new())];

    while let Some((node_cid, prev_key)) = stack.pop() {
        let node_bytes = match block_map.get(&node_cid) {
            Some(b) => b,
            None => continue,
        };

        let node = decode_mst_node(node_bytes).map_err(|e| JsValue::from_str(e))?;

        // Process entries in reverse so that when we pop from the stack
        // we process in the correct (forward) order.
        // But it's simpler to just process in forward order directly.

        if let Some(ref left_cid) = node.left {
            stack.push((left_cid.clone(), prev_key.clone()));
        }

        let mut current_key = prev_key;
        for entry in &node.entries {
            let suffix = String::from_utf8_lossy(&entry.key_suffix);
            current_key = format!(
                "{}{}",
                &current_key[..entry.prefix_len.min(current_key.len())],
                suffix
            );

            if let Some(rkey) = current_key.strip_prefix(&format!("{}/", POST_COLLECTION)) {
                if let Some(record_bytes) = block_map.get(&entry.value_cid) {
                    let mut dec = Decoder::new(record_bytes);
                    if let Ok(record) = cbor_to_json(&mut dec) {
                        posts.push(ParsedPost {
                            rkey: rkey.to_owned(),
                            cid: entry.value_cid.clone(),
                            record,
                        });
                    }
                }
            }

            if let Some(ref tree_cid) = entry.tree_cid {
                stack.push((tree_cid.clone(), current_key.clone()));
            }
        }
    }

    // 4. Serialize to JSON and return as JsValue
    let json = serde_json::to_string(&posts).map_err(|e| JsValue::from_str(&e.to_string()))?;
    Ok(JsValue::from_str(&json))
}

#[wasm_bindgen(js_name = parseCarRecordsWasm)]
pub fn parse_car_records_wasm(car_bytes: &[u8]) -> Result<JsValue, JsValue> {
    // 1. Parse all CAR blocks into a CID → bytes map
    let (root_cid, blocks) =
        parse_car_blocks(car_bytes).map_err(|e| JsValue::from_str(e))?;

    let mut block_map: HashMap<String, Vec<u8>> = HashMap::with_capacity(blocks.len());
    for block in blocks {
        block_map.insert(block.cid, block.data);
    }

    // 2. Decode commit block to get MST root
    let commit_bytes = block_map
        .get(&root_cid)
        .ok_or_else(|| JsValue::from_str("commit block not found"))?;
    let mut decoder = Decoder::new(commit_bytes);
    let map_len = decoder
        .map()
        .map_err(|_| JsValue::from_str("commit not map"))?
        .ok_or_else(|| JsValue::from_str("commit indef"))?;

    let mut data_cid: Option<String> = None;
    for _ in 0..map_len {
        let key = decoder
            .str()
            .map_err(|_| JsValue::from_str("commit key"))?;
        if key == "data" {
            let _tag = decoder
                .tag()
                .map_err(|_| JsValue::from_str("data tag"))?;
            data_cid = Some(
                read_cbor_cid_link(&mut decoder)
                    .map_err(|e| JsValue::from_str(e))?,
            );
        } else {
            decoder
                .skip()
                .map_err(|_| JsValue::from_str("skip commit field"))?;
        }
    }

    let mst_root = data_cid.ok_or_else(|| JsValue::from_str("commit has no data field"))?;

    // 3. Walk MST to collect all repo records
    let mut records: Vec<ParsedRepoRecord> = Vec::new();
    let mut stack: Vec<(String, String)> = vec![(mst_root, String::new())];

    while let Some((node_cid, prev_key)) = stack.pop() {
        let node_bytes = match block_map.get(&node_cid) {
            Some(b) => b,
            None => continue,
        };

        let node = decode_mst_node(node_bytes).map_err(|e| JsValue::from_str(e))?;

        if let Some(ref left_cid) = node.left {
            stack.push((left_cid.clone(), prev_key.clone()));
        }

        let mut current_key = prev_key;
        for entry in &node.entries {
            let suffix = String::from_utf8_lossy(&entry.key_suffix);
            current_key = format!(
                "{}{}",
                &current_key[..entry.prefix_len.min(current_key.len())],
                suffix
            );

            if let Some((collection, rkey)) = current_key.split_once('/') {
                if let Some(record_bytes) = block_map.get(&entry.value_cid) {
                    let mut dec = Decoder::new(record_bytes);
                    if let Ok(record) = cbor_to_json(&mut dec) {
                        records.push(ParsedRepoRecord {
                            collection: collection.to_owned(),
                            rkey: rkey.to_owned(),
                            cid: entry.value_cid.clone(),
                            record,
                        });
                    }
                }
            }

            if let Some(ref tree_cid) = entry.tree_cid {
                stack.push((tree_cid.clone(), current_key.clone()));
            }
        }
    }

    // 4. Serialize to JSON and return as JsValue
    let json = serde_json::to_string(&records).map_err(|e| JsValue::from_str(&e.to_string()))?;
    Ok(JsValue::from_str(&json))
}
