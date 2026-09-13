#!/usr/bin/env python3
"""Convert PDF pages to PNG images in the same directory."""

import sys
from pathlib import Path
from pdf2image import convert_from_path


def main():
    if len(sys.argv) < 2:
        print("Usage: pdf2img.py <file.pdf> [file2.pdf ...]")
        sys.exit(1)

    for arg in sys.argv[1:]:
        pdf = Path(arg).resolve()
        if not pdf.exists():
            print(f"Skip: {pdf} not found")
            continue
        if pdf.suffix.lower() != ".pdf":
            print(f"Skip: {pdf} is not a PDF")
            continue

        out_dir = pdf.parent / f"{pdf.stem}_images"
        out_dir.mkdir(exist_ok=True)

        pages = convert_from_path(str(pdf), dpi=200)
        for i, page in enumerate(pages, 1):
            out_path = out_dir / f"{pdf.stem}_{i:03d}.png"
            page.save(str(out_path), "PNG")
            print(f"  {out_path.name}")

        print(f"Done: {len(pages)} pages → {out_dir}")


if __name__ == "__main__":
    main()
