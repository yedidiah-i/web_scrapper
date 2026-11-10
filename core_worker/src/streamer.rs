use serde::{Deserialize, Serialize};
use std::{io::Write, net::TcpStream, thread, time::{Duration, SystemTime, UNIX_EPOCH}};

#[derive(Serialize, Deserialize, Debug)]
pub struct HtmlStreamPacket {
    pub version: u32,
    pub sequence_number: u64,
    pub timestamp_ns: u128,
    pub url: String,
    pub status_code: Option<u16>,
    pub html_content: String, // Kept as raw text; serde_json escapes this safely
}

pub fn main() -> std::io::Result<()> {
    let addr = "127.0.0.1:59080"; // This should match the Python ingestion server's address
    println!("Connecting to Python server...");
    let mut stream = TcpStream::connect(addr)?;
    println!("Connected successfully");

    // Example payload containing messy HTML with quotes, newlines, and scripts
    let sample_html = r#"
        <!DOCTYPE html>
        <html>
        <head><title>Test Page</title></head>
        <body>
            <h1 class="main-title">Hello World</h1>
            <p>Line 1<br>Line 2</p>
            <script>console.log("embedded code blocks work perfectly!");</script>
        </body>
        </html>
    "#;

    for i in 1..=100 {
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        
        let packet = HtmlStreamPacket {
            version: 1,
            sequence_number: i,
            timestamp_ns: now,
            url: String::from("https://example.com"),
            status_code: Some(200),
            html_content: sample_html.to_string(),
        };

        // Serialize directly to JSON bytes. Newlines inside the HTML are converted 
        // to '\n' escape characters, making the entire JSON a single-line string.
        let mut json_bytes = serde_json::to_vec(&packet)?;
        json_bytes.push(b'\n'); // Newline framing for the streaming socket

        stream.write_all(&json_bytes)?;
        stream.flush()?;

        println!("Sent HTML packet {i}/100");
        thread::sleep(Duration::from_millis(500)); // Accelerated for streaming
    }
    
    Ok(())
}
