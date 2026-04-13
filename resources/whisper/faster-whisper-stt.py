"""Minimal faster-whisper STT script for S.A.R.A.H.
Usage: python faster-whisper-stt.py <wav_path> [--language de] [--model small]
Outputs plain transcript text to stdout.
"""
import sys
import argparse
from faster_whisper import WhisperModel

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("audio", help="Path to WAV file")
    parser.add_argument("--language", default="de")
    parser.add_argument("--model", default="small")
    parser.add_argument("--device", default="auto")
    args = parser.parse_args()

    model = WhisperModel(args.model, device=args.device, compute_type="float16" if args.device != "cpu" else "int8")
    segments, _ = model.transcribe(args.audio, language=args.language, beam_size=5)

    for segment in segments:
        sys.stdout.write(segment.text)

    sys.stdout.flush()

if __name__ == "__main__":
    main()
