"""Persistent faster-whisper STT server for S.A.R.A.H.
Loads model once, accepts WAV files via HTTP POST.

Usage: python faster-whisper-server.py [--port 8786] [--model small] [--device auto]

POST /transcribe?language=de&file=/path/to/audio.wav
GET  /health
POST /shutdown
"""
import sys
import argparse
import os
import traceback
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

# Add NVIDIA DLL paths before importing ctranslate2/faster_whisper
try:
    import nvidia.cublas
    dll_dir = os.path.join(os.path.dirname(nvidia.cublas.__path__[0]), "cublas", "bin")
    os.add_dll_directory(dll_dir)
    os.environ["PATH"] = dll_dir + os.pathsep + os.environ.get("PATH", "")
except ImportError:
    pass

try:
    import nvidia.cuda_nvrtc
    dll_dir = os.path.join(os.path.dirname(nvidia.cuda_nvrtc.__path__[0]), "cuda_nvrtc", "bin")
    os.add_dll_directory(dll_dir)
    os.environ["PATH"] = dll_dir + os.pathsep + os.environ.get("PATH", "")
except ImportError:
    pass

from faster_whisper import WhisperModel

model: WhisperModel | None = None


class SttHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            if self.path == "/health":
                self._send_json(200, '{"status":"ok"}')
            else:
                self.send_error(404)
        except Exception:
            self._handle_error()

    def do_POST(self):
        try:
            if self.path.startswith("/transcribe"):
                self.handle_transcribe()
            elif self.path == "/shutdown":
                self._send_json(200, '{"status":"shutting_down"}')
                import threading
                threading.Thread(target=self.server.shutdown).start()
            else:
                self.send_error(404)
        except Exception:
            self._handle_error()

    def handle_transcribe(self):
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        language = params.get("language", ["de"])[0]
        file_path = params.get("file", [None])[0]

        if not file_path:
            self._send_text(400, "Missing file parameter")
            return

        if not os.path.exists(file_path):
            self._send_text(400, f"File not found: {file_path}")
            return

        segments, _ = model.transcribe(file_path, language=language, beam_size=5)
        text = "".join(segment.text for segment in segments)

        self._send_text(200, text)

    def _send_json(self, code, body):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body.encode("utf-8"))

    def _send_text(self, code, body):
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.end_headers()
        self.wfile.write(body.encode("utf-8"))

    def _handle_error(self):
        tb = traceback.format_exc()
        sys.stderr.write(f"[faster-whisper] ERROR:\n{tb}\n")
        sys.stderr.flush()
        try:
            self._send_text(500, tb)
        except Exception:
            pass

    def log_message(self, format, *args):
        sys.stderr.write(f"[faster-whisper] {format % args}\n")
        sys.stderr.flush()


def main():
    global model

    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8786)
    parser.add_argument("--model", default="small")
    parser.add_argument("--device", default="auto")
    args = parser.parse_args()

    compute_type = "float16" if args.device != "cpu" else "int8"
    print(f"[faster-whisper] Loading model '{args.model}' on {args.device} ({compute_type})...", flush=True)
    model = WhisperModel(args.model, device=args.device, compute_type=compute_type)
    print(f"[faster-whisper] Model loaded. Server starting on port {args.port}...", flush=True)

    server = HTTPServer(("127.0.0.1", args.port), SttHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        print("[faster-whisper] Server stopped.", flush=True)


if __name__ == "__main__":
    main()
