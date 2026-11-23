import base64
import pytest
from server.tests.conftest import FakeBedrockRT, make_ctx


def test_generate_image_builds_request_and_decodes():
    fake_image = b"FAKEJPEG_BYTES"
    b64_image = base64.b64encode(fake_image).decode()
    bedrock_west = FakeBedrockRT(responses=[{
        "images": [b64_image],
        "seeds": [42],
        "finish_reasons": [None],
    }])
    ctx = make_ctx(bedrock_rt_west=bedrock_west)

    from server.providers.bedrock_image import generate_image
    result = generate_image(ctx, prompt="test robot", negative="ugly", seed=42,
                            aspect_ratio="16:9", output_format="jpeg")

    assert result == fake_image
    assert len(bedrock_west.calls) == 1
    call = bedrock_west.calls[0]
    assert call["method"] == "invoke_model"
    assert call["modelId"] == "stability.stable-image-ultra-v1:1"
    body = call["body"]
    assert body["prompt"] == "test robot"
    assert body["negative_prompt"] == "ugly"
    assert body["aspect_ratio"] == "16:9"
    assert body["seed"] == 42
    assert body["output_format"] == "jpeg"


@pytest.mark.parametrize("response", [
    {"image": base64.b64encode(b"FAKEPNG").decode()},
    {"images": [base64.b64encode(b"FAKEPNG").decode()]},
])
def test_remove_background_accepts_image_or_images_key(response):
    bedrock_east = FakeBedrockRT(responses=[response])
    ctx = make_ctx(bedrock_rt_east=bedrock_east)

    from server.providers.bedrock_image import remove_background
    result = remove_background(ctx, b"INPUT_IMAGE_BYTES")
    assert result == b"FAKEPNG"

    call = bedrock_east.calls[0]
    assert call["modelId"] == "us.stability.stable-image-remove-background-v1:0"
    assert call["body"]["output_format"] == "png"
    # input image is base64 encoded
    assert base64.b64decode(call["body"]["image"]) == b"INPUT_IMAGE_BYTES"
