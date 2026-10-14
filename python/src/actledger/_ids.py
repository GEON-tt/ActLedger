from __future__ import annotations

import os
import time


def uuidv7(when_ms: int | None = None) -> str:
    millis = int(time.time() * 1000) if when_ms is None else when_ms
    raw = bytearray(os.urandom(16))
    raw[0] = (millis >> 40) & 0xFF
    raw[1] = (millis >> 32) & 0xFF
    raw[2] = (millis >> 24) & 0xFF
    raw[3] = (millis >> 16) & 0xFF
    raw[4] = (millis >> 8) & 0xFF
    raw[5] = millis & 0xFF
    raw[6] = (raw[6] & 0x0F) | 0x70
    raw[8] = (raw[8] & 0x3F) | 0x80
    hex_text = raw.hex()
    return f"{hex_text[:8]}-{hex_text[8:12]}-{hex_text[12:16]}-{hex_text[16:20]}-{hex_text[20:]}"
