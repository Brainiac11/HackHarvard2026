"""Inject an NFC scan into a running hub (testing without the reader).

    uv run --project hub python scripts/fake_nfc.py 04A2245A6B1290
"""
import sys

import httpx

uid = sys.argv[1] if len(sys.argv) > 1 else "04A2245A6B1290"
host = sys.argv[2] if len(sys.argv) > 2 else "http://127.0.0.1:8000"
print(httpx.post(f"{host}/api/nfc/scan", json={"uid": uid}).json())
