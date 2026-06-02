#!/usr/bin/env python3
"""
Download the front-end libraries (Konva + pdf.js) into static/vendor/ so the app
can run with NO internet on the browser side.

Run this once on any machine that HAS internet access:
    python3 fetch_vendor.py

The app prefers static/vendor/ and falls back to CDNs only if these are missing.
"""
import os, sys, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
VENDOR = os.path.join(HERE, "static", "vendor")
UA = {"User-Agent": "Mozilla/5.0 (PlanEstimator vendor fetch)"}

# Each entry: (output filename, [candidate URLs in priority order])
KONVA = ("konva.min.js", [
    "https://cdnjs.cloudflare.com/ajax/libs/konva/9.2.0/konva.min.js",
    "https://cdn.jsdelivr.net/npm/konva@9.2.0/konva.min.js",
    "https://unpkg.com/konva@9.2.0/konva.min.js",
])
# pdf main + worker MUST come from the same source/version, so try as pairs.
PDF_PAIRS = [
    ("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
     "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js"),
    ("https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/legacy/build/pdf.min.js",
     "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/legacy/build/pdf.worker.min.js"),
]


def download(url, dest):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=30) as r:
        data = r.read()
    if len(data) < 1000:
        raise ValueError("suspiciously small file (%d bytes)" % len(data))
    with open(dest, "wb") as fh:
        fh.write(data)
    print("  saved %s  (%d KB)  <- %s" % (os.path.basename(dest), len(data) // 1024, url))


def fetch_single(name, urls):
    dest = os.path.join(VENDOR, name)
    for u in urls:
        try:
            download(u, dest); return True
        except Exception as e:  # noqa: BLE001
            print("  ! failed %s (%s)" % (u, e))
    return False


def fetch_pdf():
    for main_url, worker_url in PDF_PAIRS:
        try:
            download(main_url, os.path.join(VENDOR, "pdf.min.js"))
            download(worker_url, os.path.join(VENDOR, "pdf.worker.min.js"))
            return True
        except Exception as e:  # noqa: BLE001
            print("  ! failed pair %s (%s)" % (main_url, e))
    return False


def main():
    os.makedirs(VENDOR, exist_ok=True)
    print("Downloading Konva ...")
    ok_k = fetch_single(*KONVA)
    print("Downloading pdf.js (main + worker) ...")
    ok_p = fetch_pdf()
    print()
    print("Konva:", "OK" if ok_k else "FAILED")
    print("pdf.js:", "OK" if ok_p else "FAILED")
    if ok_k and ok_p:
        print("\nDone. The app will now run fully offline (fonts aside). Reload the page.")
    else:
        print("\nSome downloads failed. Check internet access / proxy and retry.")
        sys.exit(1)


if __name__ == "__main__":
    main()
