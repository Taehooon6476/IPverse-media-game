"""2D body keypoints (COCO-17) with RTMPose-m SimCC ONNX on CPU. numpy + pillow + onnxruntime only.

python pose2d.py MODEL.onnx OUT.json NAME=IMAGE.png [NAME=IMAGE.png ...]

Each image is one centred figure rendered on a transparent background, so the person box is the alpha bounding
box (no detector). OUT.json maps each NAME to {"keypoints": [[x, y, score] * 17], "box": [x0, y0, x1, y1]} in pixels.
Model: rtmpose-m_simcc-body7_pt-body7_420e-256x192 (Apache-2.0, OpenMMLab), the end2end.onnx of its SDK zip.
"""
import json
import sys

import numpy as np
from PIL import Image

INPUT_W, INPUT_H = 192, 256
SIMCC_SPLIT = 2.0
PADDING = 1.25
MEAN = np.array([123.675, 116.28, 103.53], dtype=np.float32)
STD = np.array([58.395, 57.12, 57.375], dtype=np.float32)
BACKGROUND = (128, 128, 128)
NAMES = ("nose", "eye_l", "eye_r", "ear_l", "ear_r", "shoulder_l", "shoulder_r", "elbow_l", "elbow_r",
         "wrist_l", "wrist_r", "hip_l", "hip_r", "knee_l", "knee_r", "ankle_l", "ankle_r")


def alpha_box(rgba):
    alpha = np.asarray(rgba)[:, :, 3]
    ys, xs = np.nonzero(alpha > 16)
    if not len(xs):
        raise ValueError("empty image")
    return [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]


def crop_region(box):
    """Centre and size of the padded crop with the model's 3:4 aspect → (cx, cy, w, h)."""
    x0, y0, x1, y1 = box
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    w, h = (x1 - x0) * PADDING, (y1 - y0) * PADDING
    aspect = INPUT_W / INPUT_H
    if w > h * aspect:
        h = w / aspect
    else:
        w = h * aspect
    return cx, cy, w, h


def preprocess(rgba, region):
    cx, cy, w, h = region
    flat = Image.new("RGB", rgba.size, BACKGROUND)
    flat.paste(rgba, mask=rgba.split()[3])
    crop = flat.transform((INPUT_W, INPUT_H), Image.Transform.EXTENT, (cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2),
                          Image.Resampling.BILINEAR, fillcolor=BACKGROUND)
    x = (np.asarray(crop, dtype=np.float32) - MEAN) / STD
    return x.transpose(2, 0, 1)[None]


def decode(simcc_x, simcc_y, region):
    """SimCC argmax → keypoints in image pixels; score = min of the two axis maxima (as rtmlib does)."""
    cx, cy, w, h = region
    xi, yi = simcc_x[0].argmax(-1), simcc_y[0].argmax(-1)
    score = np.minimum(simcc_x[0].max(-1), simcc_y[0].max(-1))
    px = xi / SIMCC_SPLIT / INPUT_W * w + cx - w / 2
    py = yi / SIMCC_SPLIT / INPUT_H * h + cy - h / 2
    return [[float(a), float(b), float(c)] for a, b, c in zip(px, py, score)]


def estimate(session, path):
    rgba = Image.open(path).convert("RGBA")
    box = alpha_box(rgba)
    region = crop_region(box)
    simcc_x, simcc_y = session.run(None, {session.get_inputs()[0].name: preprocess(rgba, region)})
    return {"keypoints": decode(simcc_x, simcc_y, region), "box": box}


def main(argv):
    import onnxruntime as ort  # lazy: the decoding helpers are tested without it
    model, out, pairs = argv[0], argv[1], argv[2:]
    session = ort.InferenceSession(model, providers=["CPUExecutionProvider"])
    result = {}
    for pair in pairs:
        name, _, path = pair.partition("=")
        result[name] = estimate(session, path)
    with open(out, "w") as f:
        json.dump({"names": NAMES, **result}, f)


if __name__ == "__main__":
    main(sys.argv[1:])
