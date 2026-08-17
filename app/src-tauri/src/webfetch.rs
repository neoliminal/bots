//! `web_fetch` command: a deliberately narrow HTTP client for bots.
//!
//! GET only, https only, 10s timeout, 1 MB response cap, at most 3 redirects
//! (each hop re-validated). SSRF guard: the target host is resolved before the
//! request and every resolved address must be public — loopback, RFC1918,
//! link-local, ULA and unspecified addresses are rejected; connections are
//! pinned to the vetted addresses so DNS cannot be re-answered differently.
//! `text/html` responses are reduced to visible text via a naive tag strip.

use serde::Serialize;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::Duration;
use url::Url;

/// Response body cap (bytes).
pub const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
/// Maximum number of redirects followed after the initial request.
pub const MAX_REDIRECTS: usize = 3;
const TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebFetchResult {
    pub status: u16,
    pub content_type: String,
    pub text: String,
}

fn ipv4_is_private(ip: &Ipv4Addr) -> bool {
    let o = ip.octets();
    ip.is_loopback() // 127.0.0.0/8
        || ip.is_private() // 10/8, 172.16/12, 192.168/16
        || ip.is_link_local() // 169.254/16
        || ip.is_unspecified() // 0.0.0.0
        || ip.is_broadcast() // 255.255.255.255
        || o[0] == 0 // 0.0.0.0/8
        // 100.64.0.0/10 — RFC 6598 carrier-grade NAT. Tailscale hands out
        // 100.x addresses and Fly uses the range for internal peering, so a
        // bot could otherwise reach private tailnet/Fly services.
        || (o[0] == 100 && (64..128).contains(&o[1]))
        || (o[0] == 192 && o[1] == 0 && o[2] == 0) // 192.0.0.0/24 IETF protocol assignments
        || (o[0] == 198 && (o[1] & 0xfe) == 18) // 198.18.0.0/15 benchmarking
        || ip.is_multicast() // 224.0.0.0/4
        || o[0] >= 240 // 240.0.0.0/4 reserved (covers 255.255.255.255)
}

/// True when `ip` is loopback/private/link-local/ULA/unspecified — i.e. an
/// address `web_fetch` must never connect to.
///
/// IPv6 gets the same treatment for every form that can carry an embedded
/// IPv4 address (v4-mapped, v4-compatible, NAT64, 6to4): the embedded v4 is
/// extracted and run through the v4 rules, so `::a.b.c.d` and
/// `2002:7f00:0001::` cannot be used to smuggle a loopback/RFC1918 target
/// past the guard.
pub fn ip_is_private(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => ipv4_is_private(&v4),
        IpAddr::V6(v6) => {
            let seg = v6.segments();
            if let Some(v4) = v6.to_ipv4_mapped() {
                return ipv4_is_private(&v4);
            }
            // IPv4-compatible ::a.b.c.d (top 96 bits zero, not :: or ::1).
            if seg[..6].iter().all(|s| *s == 0) && !v6.is_unspecified() && !v6.is_loopback() {
                let embedded = Ipv4Addr::new(
                    (seg[6] >> 8) as u8,
                    (seg[6] & 0xff) as u8,
                    (seg[7] >> 8) as u8,
                    (seg[7] & 0xff) as u8,
                );
                return ipv4_is_private(&embedded);
            }
            // NAT64 well-known prefix 64:ff9b::/96 — the low 32 bits are v4.
            if seg[0] == 0x0064
                && seg[1] == 0xff9b
                && seg[2] == 0
                && seg[3] == 0
                && seg[4] == 0
                && seg[5] == 0
            {
                let embedded = Ipv4Addr::new(
                    (seg[6] >> 8) as u8,
                    (seg[6] & 0xff) as u8,
                    (seg[7] >> 8) as u8,
                    (seg[7] & 0xff) as u8,
                );
                return ipv4_is_private(&embedded);
            }
            // 6to4 2002::/16 — bits 16..48 are the embedded v4 address.
            if seg[0] == 0x2002 {
                let embedded = Ipv4Addr::new(
                    (seg[1] >> 8) as u8,
                    (seg[1] & 0xff) as u8,
                    (seg[2] >> 8) as u8,
                    (seg[2] & 0xff) as u8,
                );
                return ipv4_is_private(&embedded);
            }
            v6.is_loopback() // ::1
                || v6.is_unspecified() // ::
                || (seg[0] & 0xfe00) == 0xfc00 // fc00::/7 (ULA)
                || (seg[0] & 0xffc0) == 0xfe80 // fe80::/10 (link-local)
                || (seg[0] & 0xffc0) == 0xfec0 // fec0::/10 (deprecated site-local)
                || v6.is_multicast() // ff00::/8
        }
    }
}

/// Parse and validate a URL for `web_fetch`: https only, must have a host,
/// literal-IP and localhost targets are rejected up front.
pub fn validate_fetch_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|e| format!("invalid URL: {e}"))?;
    if url.scheme() != "https" {
        return Err("only https:// URLs are allowed".into());
    }
    match url.host() {
        None => Err("URL must have a host".into()),
        Some(url::Host::Ipv4(ip)) => {
            if ip_is_private(IpAddr::V4(ip)) {
                Err("requests to private or loopback addresses are blocked".into())
            } else {
                Ok(url)
            }
        }
        Some(url::Host::Ipv6(ip)) => {
            if ip_is_private(IpAddr::V6(ip)) {
                Err("requests to private or loopback addresses are blocked".into())
            } else {
                Ok(url)
            }
        }
        Some(url::Host::Domain(domain)) => {
            let d = domain.to_ascii_lowercase();
            if d == "localhost" || d.ends_with(".localhost") || d.ends_with(".local") {
                Err("requests to local hosts are blocked".into())
            } else {
                Ok(url)
            }
        }
    }
}

/// Resolve `host:port` and require every resolved address to be public.
async fn resolve_public_addrs(host: &str, port: u16) -> Result<Vec<SocketAddr>, String> {
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host, port))
        .await
        .map_err(|e| format!("DNS resolution failed for {host}: {e}"))?
        .collect();
    if addrs.is_empty() {
        return Err(format!("DNS resolution returned no addresses for {host}"));
    }
    for addr in &addrs {
        if ip_is_private(addr.ip()) {
            return Err(format!(
                "requests to private or loopback addresses are blocked ({host})"
            ));
        }
    }
    Ok(addrs)
}

/// Naive HTML-to-text: drops `<script>`/`<style>`/comments, strips tags,
/// decodes a handful of common entities, collapses whitespace.
pub fn strip_html(html: &str) -> String {
    fn find_ci(haystack: &str, needle: &str) -> Option<usize> {
        let h = haystack.as_bytes();
        let n = needle.as_bytes();
        if n.is_empty() || h.len() < n.len() {
            return None;
        }
        (0..=h.len() - n.len()).find(|&i| h[i..i + n.len()].eq_ignore_ascii_case(n))
    }
    fn starts_ci(s: &str, prefix: &str) -> bool {
        s.len() >= prefix.len() && s.as_bytes()[..prefix.len()].eq_ignore_ascii_case(prefix.as_bytes())
    }
    /// Skip past the end tag `end` (e.g. "</script") and its closing '>'.
    fn skip_block<'a>(rest: &'a str, end: &str) -> &'a str {
        match find_ci(rest, end) {
            Some(i) => {
                let after = &rest[i + end.len()..];
                match after.find('>') {
                    Some(j) => &after[j + 1..],
                    None => "",
                }
            }
            None => "",
        }
    }

    let mut out = String::with_capacity(html.len() / 2);
    let mut rest = html;
    while let Some(i) = rest.find('<') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        if starts_ci(rest, "<script") {
            rest = skip_block(rest, "</script");
        } else if starts_ci(rest, "<style") {
            rest = skip_block(rest, "</style");
        } else if rest.starts_with("<!--") {
            rest = match rest.find("-->") {
                Some(j) => &rest[j + 3..],
                None => "",
            };
        } else {
            match rest.find('>') {
                Some(j) => {
                    out.push(' ');
                    rest = &rest[j + 1..];
                }
                None => rest = "",
            }
        }
    }
    out.push_str(rest);

    let decoded = out
        .replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&");

    // Collapse whitespace runs into single spaces.
    decoded.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[tauri::command]
pub async fn web_fetch(url: String) -> Result<WebFetchResult, String> {
    let mut current = validate_fetch_url(&url)?;

    for _hop in 0..=MAX_REDIRECTS {
        let host = current
            .host_str()
            .ok_or_else(|| "URL must have a host".to_string())?
            .to_string();
        let port = current.port_or_known_default().unwrap_or(443);
        let addrs = match current.host() {
            Some(url::Host::Ipv4(ip)) => vec![SocketAddr::new(IpAddr::V4(ip), port)],
            Some(url::Host::Ipv6(ip)) => vec![SocketAddr::new(IpAddr::V6(ip), port)],
            _ => resolve_public_addrs(&host, port).await?,
        };

        // Pin the connection to the vetted addresses (defeats DNS rebinding).
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(TIMEOUT)
            .resolve_to_addrs(&host, &addrs)
            .build()
            .map_err(|e| format!("failed to build HTTP client: {e}"))?;

        let resp = client
            .get(current.as_str())
            .send()
            .await
            .map_err(|e| format!("request failed: {e}"))?;
        let status = resp.status();

        if status.is_redirection() {
            let location = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| "redirect response without a Location header".to_string())?;
            let next = current
                .join(location)
                .map_err(|e| format!("invalid redirect target: {e}"))?;
            current = validate_fetch_url(next.as_str())?;
            continue;
        }

        let content_type = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        if let Some(len) = resp.content_length() {
            if len > MAX_RESPONSE_BYTES as u64 {
                return Err("response exceeds the 1MB limit".into());
            }
        }
        let mut resp = resp;
        let mut buf: Vec<u8> = Vec::new();
        while let Some(chunk) = resp
            .chunk()
            .await
            .map_err(|e| format!("failed to read response body: {e}"))?
        {
            if buf.len() + chunk.len() > MAX_RESPONSE_BYTES {
                return Err("response exceeds the 1MB limit".into());
            }
            buf.extend_from_slice(&chunk);
        }

        let mut text = String::from_utf8_lossy(&buf).into_owned();
        if content_type.to_ascii_lowercase().contains("text/html") {
            text = strip_html(&text);
        }
        return Ok(WebFetchResult {
            status: status.as_u16(),
            content_type,
            text,
        });
    }
    Err(format!("too many redirects (max {MAX_REDIRECTS})"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    fn v4(a: u8, b: u8, c: u8, d: u8) -> IpAddr {
        IpAddr::V4(Ipv4Addr::new(a, b, c, d))
    }

    #[test]
    fn blocks_ipv4_private_ranges() {
        assert!(ip_is_private(v4(127, 0, 0, 1))); // 127/8
        assert!(ip_is_private(v4(127, 255, 255, 254)));
        assert!(ip_is_private(v4(10, 0, 0, 1))); // 10/8
        assert!(ip_is_private(v4(10, 255, 255, 255)));
        assert!(ip_is_private(v4(172, 16, 0, 1))); // 172.16/12
        assert!(ip_is_private(v4(172, 31, 255, 255)));
        assert!(ip_is_private(v4(192, 168, 1, 1))); // 192.168/16
        assert!(ip_is_private(v4(169, 254, 1, 1))); // 169.254/16
        assert!(ip_is_private(v4(0, 0, 0, 0)));
        assert!(ip_is_private(v4(255, 255, 255, 255)));
    }

    /// M3: ranges that used to slip through the v4 blocklist.
    #[test]
    fn blocks_ipv4_shared_and_reserved_ranges() {
        let blocked = [
            (100, 64, 0, 0),    // 100.64/10 CGNAT (Tailscale, Fly peering)
            (100, 64, 1, 2),    //
            (100, 100, 100, 100),
            (100, 127, 255, 255), // top of 100.64/10
            (192, 0, 0, 1),     // 192.0.0.0/24
            (192, 0, 0, 255),   //
            (198, 18, 0, 1),    // 198.18/15 benchmarking
            (198, 19, 255, 255),
            (224, 0, 0, 1),     // multicast
            (239, 255, 255, 250),
            (240, 0, 0, 1),     // reserved
        ];
        for (a, b, c, d) in blocked {
            assert!(ip_is_private(v4(a, b, c, d)), "should block {a}.{b}.{c}.{d}");
        }
        // Neighbours of the new ranges stay reachable.
        let allowed = [
            (100, 63, 255, 255), // just below 100.64/10
            (100, 128, 0, 1),    // just above 100.64/10
            (192, 0, 1, 1),      // just above 192.0.0.0/24
            (198, 17, 255, 255), // just below 198.18/15
            (198, 20, 0, 1),     // just above 198.18/15
            (223, 255, 255, 255), // just below multicast
        ];
        for (a, b, c, d) in allowed {
            assert!(!ip_is_private(v4(a, b, c, d)), "should allow {a}.{b}.{c}.{d}");
        }
    }

    /// M3: IPv6 encodings that embed an IPv4 address must be unwrapped.
    #[test]
    fn blocks_ipv6_embedded_ipv4_and_site_local() {
        let blocked = [
            "::127.0.0.1",         // v4-compatible loopback
            "::10.0.0.1",          // v4-compatible RFC1918
            "::169.254.169.254",   // v4-compatible cloud metadata
            "::100.100.100.100",   // v4-compatible CGNAT
            "64:ff9b::127.0.0.1",  // NAT64 loopback
            "64:ff9b::192.168.1.1", // NAT64 RFC1918
            "64:ff9b::a9fe:a9fe",  // NAT64 169.254.169.254
            "2002:7f00:1::",       // 6to4 127.0.0.1
            "2002:c0a8:101::1",    // 6to4 192.168.1.1
            "2002:6440:101::1",    // 6to4 100.64.1.1
            "fec0::1",             // deprecated site-local
            "feff::1",             // top of fec0::/10
            "ff02::1",             // multicast
        ];
        for addr in blocked {
            assert!(
                ip_is_private(addr.parse().unwrap()),
                "should block {addr}"
            );
        }
        let allowed = [
            "::8.8.8.8",          // v4-compatible public
            "64:ff9b::1.1.1.1",   // NAT64 public
            "2002:0808:0808::1",  // 6to4 8.8.8.8
            "2606:4700::1111",
        ];
        for addr in allowed {
            assert!(!ip_is_private(addr.parse().unwrap()), "should allow {addr}");
        }
    }

    /// The URL validator inherits every new range.
    #[test]
    fn url_rejects_newly_blocked_ranges() {
        assert!(validate_fetch_url("https://100.64.1.2/").is_err());
        assert!(validate_fetch_url("https://198.18.0.1/").is_err());
        assert!(validate_fetch_url("https://192.0.0.1/").is_err());
        assert!(validate_fetch_url("https://[::127.0.0.1]/").is_err());
        assert!(validate_fetch_url("https://[64:ff9b::a9fe:a9fe]/").is_err());
        assert!(validate_fetch_url("https://[2002:7f00:1::]/").is_err());
        assert!(validate_fetch_url("https://[fec0::1]/").is_err());
    }

    #[test]
    fn allows_ipv4_public() {
        assert!(!ip_is_private(v4(1, 1, 1, 1)));
        assert!(!ip_is_private(v4(8, 8, 8, 8)));
        assert!(!ip_is_private(v4(172, 15, 0, 1))); // just below 172.16/12
        assert!(!ip_is_private(v4(172, 32, 0, 1))); // just above 172.16/12
        assert!(!ip_is_private(v4(169, 253, 1, 1)));
        assert!(!ip_is_private(v4(11, 0, 0, 1)));
    }

    #[test]
    fn blocks_ipv6_special_ranges() {
        assert!(ip_is_private(IpAddr::V6(Ipv6Addr::LOCALHOST))); // ::1
        assert!(ip_is_private(IpAddr::V6(Ipv6Addr::UNSPECIFIED))); // ::
        assert!(ip_is_private("fc00::1".parse().unwrap())); // fc00::/7
        assert!(ip_is_private("fdab::1".parse().unwrap())); // fd00::/8 (in fc00::/7)
        assert!(ip_is_private("fe80::1".parse().unwrap())); // link-local
        assert!(ip_is_private("::ffff:127.0.0.1".parse().unwrap())); // v4-mapped loopback
        assert!(ip_is_private("::ffff:192.168.0.1".parse().unwrap())); // v4-mapped private
    }

    #[test]
    fn allows_ipv6_public() {
        assert!(!ip_is_private("2606:4700::1111".parse().unwrap()));
        assert!(!ip_is_private("2001:4860:4860::8888".parse().unwrap()));
        assert!(!ip_is_private("::ffff:8.8.8.8".parse().unwrap()));
    }

    #[test]
    fn url_must_be_https() {
        assert!(validate_fetch_url("http://example.com/").is_err());
        assert!(validate_fetch_url("ftp://example.com/").is_err());
        assert!(validate_fetch_url("file:///etc/passwd").is_err());
        assert!(validate_fetch_url("not a url").is_err());
        assert!(validate_fetch_url("https://example.com/page?q=1").is_ok());
    }

    #[test]
    fn url_rejects_local_and_private_hosts() {
        assert!(validate_fetch_url("https://localhost/").is_err());
        assert!(validate_fetch_url("https://LOCALHOST/").is_err());
        assert!(validate_fetch_url("https://foo.localhost/").is_err());
        assert!(validate_fetch_url("https://printer.local/").is_err());
        assert!(validate_fetch_url("https://127.0.0.1/").is_err());
        assert!(validate_fetch_url("https://10.1.2.3/x").is_err());
        assert!(validate_fetch_url("https://192.168.0.10/").is_err());
        assert!(validate_fetch_url("https://172.20.1.1/").is_err());
        assert!(validate_fetch_url("https://169.254.169.254/latest/meta-data").is_err());
        assert!(validate_fetch_url("https://[::1]/").is_err());
        assert!(validate_fetch_url("https://[fc00::1]/").is_err());
        assert!(validate_fetch_url("https://[::ffff:10.0.0.1]/").is_err());
    }

    #[test]
    fn url_allows_public_hosts() {
        assert!(validate_fetch_url("https://example.com/").is_ok());
        assert!(validate_fetch_url("https://1.1.1.1/").is_ok());
        assert!(validate_fetch_url("https://[2606:4700::1111]/").is_ok());
    }

    #[test]
    fn strip_html_removes_tags_scripts_styles_comments() {
        let html = r#"<html><head><title>T</title>
            <style>body { color: red; }</style>
            <SCRIPT type="text/javascript">alert("x < y");</SCRIPT>
            </head><body>
            <!-- hidden comment -->
            <h1>Hello</h1><p>World &amp; &lt;friends&gt;&nbsp;&quot;quoted&quot;</p>
            </body></html>"#;
        let text = strip_html(html);
        assert_eq!(text, "T Hello World & <friends> \"quoted\"");
        assert!(!text.contains("alert"));
        assert!(!text.contains("color"));
        assert!(!text.contains("hidden"));
    }

    #[test]
    fn strip_html_passes_plain_text_through() {
        assert_eq!(strip_html("just plain   text"), "just plain text");
        assert_eq!(strip_html(""), "");
    }

    #[test]
    fn strip_html_handles_unterminated_blocks() {
        assert_eq!(strip_html("before<script>evil("), "before");
        assert_eq!(strip_html("a<b"), "a");
        assert_eq!(strip_html("<style>x{}"), "");
    }
}
