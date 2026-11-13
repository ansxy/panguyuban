//! The Requests view's HTTP client. Requests go out from Rust, so the WebView's
//! CORS rules don't apply, and big responses are cut off before they reach the UI.

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// Body bytes kept beyond this are counted but dropped, so a huge download can't fill memory.
const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Deserialize)]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

#[derive(Debug, Serialize)]
pub struct HttpResponse {
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<(String, String)>,
    /// At most `MAX_BODY_BYTES`, decoded lossily as UTF-8.
    pub body: String,
    /// Full body size in bytes, including any part that was dropped.
    pub size: usize,
    pub truncated: bool,
    pub elapsed_ms: u64,
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(TIMEOUT)
            .build()
            .expect("HTTP client config is static")
    })
}

pub async fn send(req: HttpRequest) -> Result<HttpResponse, String> {
    let method = reqwest::Method::from_bytes(req.method.trim().to_uppercase().as_bytes())
        .map_err(|_| format!("Invalid method: {}", req.method))?;
    let mut builder = client().request(method, req.url.trim());
    for (name, value) in req.headers.iter().filter(|(n, _)| !n.trim().is_empty()) {
        builder = builder.header(name.trim(), value.trim());
    }
    if !req.body.is_empty() {
        builder = builder.body(req.body);
    }

    let started = Instant::now();
    let mut res = builder.send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    let headers = res
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), String::from_utf8_lossy(v.as_bytes()).into_owned()))
        .collect();

    let mut body = Vec::new();
    let mut size = 0;
    while let Some(chunk) = res.chunk().await.map_err(|e| e.to_string())? {
        size += chunk.len();
        let room = MAX_BODY_BYTES.saturating_sub(body.len());
        body.extend_from_slice(&chunk[..chunk.len().min(room)]);
    }

    Ok(HttpResponse {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        headers,
        body: String::from_utf8_lossy(&body).into_owned(),
        size,
        truncated: size > body.len(),
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    /// Serves one canned response on a local port and returns its URL.
    fn serve_once(response: Vec<u8>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/echo", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let _ = stream.read(&mut buf);
            stream.write_all(&response).unwrap();
        });
        url
    }

    #[tokio::test]
    async fn caps_large_bodies_and_reports_full_size() {
        let body = vec![b'a'; MAX_BODY_BYTES + 10];
        let mut response =
            format!("HTTP/1.1 201 Created\r\nX-Test: yes\r\nContent-Length: {}\r\n\r\n", body.len()).into_bytes();
        response.extend_from_slice(&body);
        let url = serve_once(response);

        let res = send(HttpRequest {
            method: "post".into(),
            url,
            headers: vec![("Content-Type".into(), "text/plain".into()), ("".into(), "skipped".into())],
            body: "hi".into(),
        })
        .await
        .unwrap();

        assert_eq!(res.status, 201);
        assert_eq!(res.status_text, "Created");
        assert!(res.headers.contains(&("x-test".into(), "yes".into())));
        assert_eq!(res.body.len(), MAX_BODY_BYTES);
        assert_eq!(res.size, MAX_BODY_BYTES + 10);
        assert!(res.truncated);
    }

    #[tokio::test]
    async fn rejects_bad_method() {
        let err = send(HttpRequest {
            method: "GE T".into(),
            url: "http://127.0.0.1:1".into(),
            headers: vec![],
            body: String::new(),
        })
        .await
        .unwrap_err();
        assert!(err.contains("Invalid method"));
    }
}
