"""Live Bedrock integration test. Run with LIVE=1 python3 -m pytest server/tests/test_live_bedrock.py -v"""
import os
import struct
import pytest

LIVE = os.environ.get("LIVE") == "1"


@pytest.mark.skipif(not LIVE, reason="Set LIVE=1 to run against real Bedrock")
def test_live_generate_image_and_remove_background():
    from server.providers.base import Ctx
    from server.providers.bedrock_image import generate_image, remove_background

    ctx = Ctx.from_env()

    jpeg_bytes = generate_image(
        ctx,
        prompt="a small friendly robot mascot, white background",
        negative="",
        seed=7,
        aspect_ratio="1:1",
        output_format="jpeg",
    )

    assert len(jpeg_bytes) > 0, "generate_image returned empty bytes"
    # JPEG magic
    assert jpeg_bytes[:2] == b"\xff\xd8", "Not a JPEG"

    png_bytes = remove_background(ctx, jpeg_bytes)

    # PNG magic
    assert png_bytes[:8] == b"\x89PNG\r\n\x1a\n", "Not a PNG"

    # IHDR chunk: 8 (sig) + 4 (len) + 4 (type) + 4 (width) + 4 (height) +
    # 1 (bit depth) + 1 (color type) = offset 25
    color_type = struct.unpack("B", png_bytes[25:26])[0]
    assert color_type == 6, (
        f"Expected RGBA color type 6, got {color_type}. "
        "remove_background did not produce alpha channel."
    )
