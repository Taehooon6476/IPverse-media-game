"""Stdlib-only RGBA PNG writer for the relief worker tests (no Pillow)."""
import struct
import sys
import zlib


def write_png(path: str, width: int, height: int, rows: list) -> None:
    """Write 8-bit RGBA rows (top to bottom, each width*4 bytes) as a PNG."""

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))

    raw = b"".join(b"\x00" + bytes(row) for row in rows)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)))
        f.write(chunk(b"IDAT", zlib.compress(raw, 9)))
        f.write(chunk(b"IEND", b""))


def write_cutout_png(path: str, size: int = 96) -> None:
    """A "character" on transparent background: round head over a rectangular body.

    The body runs red (left) to blue (right) so mirrored renders are easy to spot.
    """
    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            u, v = (x + 0.5) / size, (y + 0.5) / size  # v = 0 at the top
            if (u - 0.5) ** 2 + (v - 0.28) ** 2 <= 0.17 ** 2:
                row += bytes((242, 196, 120, 255))
            elif 0.28 <= u <= 0.72 and 0.42 <= v <= 0.94:
                t = (u - 0.28) / 0.44
                row += bytes((int(230 * (1 - t) + 40 * t), 70, int(60 * (1 - t) + 220 * t), 255))
            else:
                row += bytes(4)
        rows.append(row)
    write_png(path, size, size, rows)


if __name__ == "__main__":  # python3 workers/make_fixture.py OUT.png [SIZE]
    write_cutout_png(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 96)
