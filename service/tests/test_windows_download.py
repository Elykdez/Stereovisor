from __future__ import annotations

import hashlib
import shutil
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest


@pytest.mark.skipif(shutil.which("powershell.exe") is None, reason="Windows downloader")
def test_interrupted_download_resumes_from_received_bytes(tmp_path):
    payload = bytes(range(256)) * 256
    ranges = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            requested_range = self.headers.get("Range")
            ranges.append(requested_range)
            offset = int(requested_range.removeprefix("bytes=").split("-")[0]) if requested_range else 0
            self.send_response(206 if offset else 200)
            self.send_header("Content-Length", str(len(payload) - offset))
            if offset:
                self.send_header("Content-Range", f"bytes {offset}-{len(payload) - 1}/{len(payload)}")
            self.end_headers()
            # Drop the first transfer halfway through its advertised body.
            self.wfile.write(payload[:32768] if len(ranges) == 1 else payload[offset:])
            self.close_connection = True

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    script = Path(__file__).resolve().parents[1] / "scripts" / "download-file.ps1"
    destination = tmp_path / "download.bin"
    quote = lambda value: "'" + str(value).replace("'", "''") + "'"
    command = (
        f". {quote(script)}; function Start-Sleep {{ param([int]$Seconds) }}; "
        f"Get-ResumableFile -Uri 'http://127.0.0.1:{server.server_port}/wheel' "
        f"-Destination {quote(destination)} -Sha256 '{hashlib.sha256(payload).hexdigest()}' -Attempts 2"
    )
    try:
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
            capture_output=True, text=True, timeout=30,
        )
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)

    assert result.returncode == 0, result.stdout + result.stderr
    assert ranges == [None, "bytes=32768-"]
    assert destination.read_bytes() == payload
    assert not destination.with_suffix(".bin.partial").exists()
