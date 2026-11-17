use std::sync::OnceLock;
use std::time::Duration;

use once_cell::sync::Lazy;
use regex::{Captures, Regex};
use serde_json::{json, Value};

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const BASE: &str = "https://assetstore.unity.com";
const MAX_DESC: usize = 12000;
const MAX_REDIRECTS: usize = 5;
const TIMEOUT: Duration = Duration::from_secs(20);

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(UA)
            .timeout(TIMEOUT)
            .redirect(reqwest::redirect::Policy::limited(MAX_REDIRECTS))
            .gzip(true)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

async fn fetch_body(url: &str) -> Result<(u16, String), String> {
    let res = client()
        .get(url)
        .header(reqwest::header::ACCEPT, "text/html,application/json")
        .header(reqwest::header::ACCEPT_LANGUAGE, "en")
        .header(reqwest::header::REFERER, format!("{BASE}/"))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status().as_u16();
    let body = res.text().await.unwrap_or_default();
    Ok((status, body))
}

fn extract_json_array(text: &str, marker: &str) -> Option<Value> {
    let rel = text.find(marker)?;
    let res_idx = text[rel..].find("\"results\":")? + rel;
    parse_array_content(text, res_idx + "\"results\":".len())
}

fn parse_array_content(text: &str, start: usize) -> Option<Value> {
    let bytes = text.as_bytes();
    let mut j = start;
    while j < bytes.len() && bytes[j] != b'[' {
        j += 1;
    }
    if j >= bytes.len() {
        return None;
    }
    let mut depth = 0i32;
    let mut in_string = false;
    let mut k = j;
    while k < bytes.len() {
        let ch = bytes[k];
        if in_string {
            if ch == b'\\' {
                k += 1;
            } else if ch == b'"' {
                in_string = false;
            }
        } else if ch == b'"' {
            in_string = true;
        } else if ch == b'[' {
            depth += 1;
        } else if ch == b']' {
            depth -= 1;
            if depth == 0 {
                break;
            }
        }
        k += 1;
    }
    if k >= bytes.len() {
        return None;
    }
    serde_json::from_str(&text[j..=k]).ok()
}

fn tokenize(name: &str) -> Vec<String> {
    name.to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .map(str::to_string)
        .collect()
}

fn product_name(product: &Value) -> Vec<String> {
    tokenize(product.get("name").and_then(Value::as_str).unwrap_or(""))
}

fn pick_best(query: &str, results: &[Value]) -> Option<(Value, f64)> {
    let qw = tokenize(query);
    let qset: std::collections::HashSet<String> = qw.iter().cloned().collect();
    let mut best: Option<Value> = None;
    let mut best_score = 0.0f64;

    for result in results {
        let rw = product_name(result);
        if rw == qw {
            return Some((result.clone(), 1.0));
        }
        let rset: std::collections::HashSet<String> = rw.iter().cloned().collect();
        let common = rset.iter().filter(|w| qset.contains(*w)).count();
        let q_len = qw.len();
        let r_len = rw.len();

        let score = if q_len == 1 && common == 1 && qw[0].len() >= 3 {
            1.0 / r_len.max(1) as f64
        } else if common == q_len && r_len >= q_len {
            0.5 + q_len as f64 / r_len.max(1) as f64
        } else if common >= 2.max(((q_len as f64) * 0.75).floor() as usize) {
            common as f64 / q_len.max(r_len) as f64
        } else {
            0.0
        };

        if score > best_score {
            best = Some(result.clone());
            best_score = score;
        }
    }

    if best_score <= 0.0 {
        None
    } else {
        best.map(|b| (b, best_score))
    }
}

fn slugify(name: &str) -> String {
    name.to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

static RE_BR: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)<br\s*/?>").unwrap());
static RE_BLOCK_END: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)</(?:p|div|section|h[1-6])>").unwrap());
static RE_LIST_END: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)</(?:li|ul|ol)>").unwrap());
static RE_LI: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)<li[^>]*>").unwrap());
static RE_TR: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)</tr>").unwrap());
static RE_EMPTY_TD: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)</td></td>").unwrap());
static RE_TAG: Lazy<Regex> = Lazy::new(|| Regex::new(r"<[^>]+>").unwrap());
static RE_HEX_REF: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)&#x([0-9a-f]+);").unwrap());
static RE_DEC_REF: Lazy<Regex> = Lazy::new(|| Regex::new(r"&#(\d+);").unwrap());
static RE_SPACE_NL: Lazy<Regex> = Lazy::new(|| Regex::new(r"[ \t]+\n").unwrap());
static RE_TRIPLE_NL: Lazy<Regex> = Lazy::new(|| Regex::new(r"\n{3,}").unwrap());

fn entity_char(caps: &Captures) -> String {
    let value = caps
        .get(1)
        .and_then(|m| u32::from_str_radix(m.as_str(), 16).ok())
        .and_then(char::from_u32)
        .unwrap_or_default();
    value.to_string()
}

fn decimal_char(caps: &Captures) -> String {
    let value = caps
        .get(1)
        .and_then(|m| m.as_str().parse::<u32>().ok())
        .and_then(char::from_u32)
        .unwrap_or_default();
    value.to_string()
}

fn html_to_text(html: &str) -> String {
    let mut text = RE_BR.replace_all(html, "\n").to_string();
    text = RE_BLOCK_END.replace_all(&text, "\n\n").to_string();
    text = RE_LIST_END.replace_all(&text, "\n").to_string();
    text = RE_LI.replace_all(&text, "\u{2022} ").to_string();
    text = RE_TR.replace_all(&text, "\n").to_string();
    text = RE_EMPTY_TD.replace_all(&text, " | ").to_string();
    text = RE_TAG.replace_all(&text, "").to_string();
    text = text.replace("&nbsp;", " ").replace("&amp;", "&");
    text = text.replace("&quot;", "\"").replace("&#39;", "'");
    text = text.replace("&#x27;", "'").replace("&apos;", "'");
    text = text.replace("&lt;", "<").replace("&gt;", ">");
    text = RE_HEX_REF.replace_all(&text, entity_char).to_string();
    text = RE_DEC_REF.replace_all(&text, decimal_char).to_string();
    text = RE_SPACE_NL.replace_all(&text, "\n").to_string();
    text = RE_TRIPLE_NL.replace_all(&text, "\n\n").to_string();
    text.trim().chars().take(MAX_DESC).collect()
}

fn extract_description(page_html: &str, product_id: &str) -> String {
    let escaped_id = regex::escape(product_id);
    let pattern = format!("\"{escaped_id}\":\\{{\"id\":\"{escaped_id}\",");
    let anchor = match Regex::new(&pattern) {
        Ok(re) => re,
        Err(_) => return String::new(),
    };
    let Some(found) = anchor.find(page_html) else {
        return String::new();
    };

    let start = found.end();
    let window_end = (start + 20_000).min(page_html.len());
    let Some(rel_key) = page_html[start..window_end].find("\"description\":\"") else {
        return String::new();
    };
    let key_start = start + rel_key;
    let value_start = key_start + "\"description\":\"".len();

    let bytes = page_html.as_bytes();
    let mut k = value_start;
    while k < bytes.len() && k < window_end {
        match bytes[k] {
            b'\\' => k += 2,
            b'"' => break,
            _ => k += 1,
        }
    }
    if k >= bytes.len() || k >= window_end {
        return String::new();
    }

    let raw = format!("\"{}\"", &page_html[value_start..k]);
    match serde_json::from_str::<String>(&raw) {
        Ok(html) => html_to_text(&html),
        Err(_) => String::new(),
    }
}

/// Looks up a Unity Asset Store product by folder name and returns its
/// description — a direct port of unityAssetStore.js.
pub async fn find_and_fetch_description(query: &str) -> Value {
    let trimmed = query.trim();
    if trimmed.is_empty() || trimmed.len() > 200 {
        return json!({ "found": false, "error": "invalid query" });
    }

    let search_url = format!("{BASE}/sitemap?q={}", urlencode(trimmed));
    let (status, body) = match fetch_body(&search_url).await {
        Ok(res) => res,
        Err(err) => return json!({ "found": false, "error": err }),
    };
    if status != 200 {
        return json!({
            "found": false,
            "error": format!("store search unavailable (http {status})")
        });
    }

    let results = extract_json_array(&body, "searchPackageFromSolr");
    let products: Vec<Value> = results
        .and_then(|r| r.as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter(|p| p.get("id").is_some() && p.get("name").and_then(Value::as_str).is_some())
        .collect();

    if products.is_empty() {
        return json!({ "found": false, "nonexistent": true, "error": "no product found" });
    }

    let Some((product, _score)) = pick_best(trimmed, &products) else {
        return json!({ "found": false, "nonexistent": true, "error": "no matching product" });
    };

    let id = product
        .get("id")
        .map(|v| match v {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        })
        .unwrap_or_default();
    let name = product
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let category = product
        .get("category")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let page_url = format!("{BASE}/packages/{}/{}-{}", category, slugify(&name), id);

    let (page_status, page_body) = match fetch_body(&page_url).await {
        Ok(res) => res,
        Err(err) => {
            return json!({
                "found": true, "id": id, "name": name, "url": page_url,
                "description": "", "error": err
            })
        }
    };
    if page_status != 200 {
        return json!({
            "found": true,
            "id": id,
            "name": name,
            "url": page_url,
            "description": "",
            "error": format!("product page returned http {page_status}")
        });
    }

    let description = extract_description(&page_body, &id);
    json!({
        "found": true,
        "id": id,
        "name": name,
        "url": page_url,
        "category": category,
        "description": description
    })
}

fn urlencode(value: &str) -> String {
    let mut out = String::new();
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_store_html_to_text() {
        let html = "<p>Hello <b>world</b></p><ul><li>One</li></ul>&amp; more";
        let text = html_to_text(html);
        assert!(text.contains("Hello world"));
        assert!(text.contains("One"));
        assert!(text.contains("& more"));
    }

    #[test]
    fn extracts_embedded_description() {
        let page = r#"{"123":{"id":"123","productId":7,"name":"Chair","description":"<p>A low poly chair</p>"},"other":"x"}"#;
        assert_eq!(extract_description(page, "123"), "A low poly chair");
    }

    #[test]
    fn matches_store_names_like_the_node_build() {
        let results = vec![
            json!({ "id": 1, "name": "POLYGON - Sci-Fi City Pack - Art by Synty" }),
            json!({ "id": 2, "name": "Space" }),
        ];
        let (best, _) = pick_best("space", &results).unwrap();
        assert_eq!(best.get("id").unwrap(), &json!(2));
    }
}
