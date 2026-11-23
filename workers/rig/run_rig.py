"""Deadline task (the template's embedded Run file): stage inputs from s3, run blender_rig.py, encode the preview,
upload outputs to OutputPrefix/.

python run_rig.py INPUT_GLB_URI UAL_URI POSE_MODEL_URI OUTPUT_PREFIX RES SAMPLES RIG POSE SHEET BONES CLIPS CLEAN

Outputs: rigged.glb, rig_preview.mp4 (run cycle x3, 30 fps), rig_sheet.png, rig_weights.png, front.png,
meta.json. A refused or failed rig still uploads meta.json (and the views) and exits non-zero.
"""
import os
import subprocess
import sys
import tempfile

import boto3

(input_uri, ual_uri, model_uri, output_prefix, res, samples,
 rig, pose, sheet, bones, clips, clean) = sys.argv[1:13]


def s3_split(uri):
    if not uri.startswith("s3://"):
        sys.exit("expected s3://bucket/key, got %r" % uri)
    bucket, _, key = uri[5:].partition("/")
    return bucket, key


s3 = boto3.client("s3")
bucket, prefix = s3_split(output_prefix.rstrip("/"))


def upload(path, name, content_type):
    if os.path.exists(path):
        s3.upload_file(path, bucket, prefix + "/" + name, ExtraArgs={"ContentType": content_type})
        print("uploaded s3://%s/%s/%s" % (bucket, prefix, name), flush=True)


with tempfile.TemporaryDirectory(prefix="rig-") as work:
    src, ual, model, out = (os.path.join(work, n) for n in ("input.glb", "ual.glb", "pose.onnx", "out"))
    for uri, path in ((input_uri, src), (ual_uri, ual), (model_uri, model)):
        s3.download_file(*s3_split(uri), path)
    env = {k: v for k, v in os.environ.items() if k not in ("PYTHONPATH", "PYTHONHOME")}  # Blender brings its own Python
    pose_cmd = "%s %s %s" % (sys.executable, pose, model)  # this env's Python has onnxruntime + pillow
    rc = subprocess.run(["blender", "-b", "--factory-startup", "-noaudio", "--python-exit-code", "1", "--python", rig, "--",
                         "--glb", src, "--ual", ual, "--bones", bones, "--clips", clips, "--out", out,
                         "--pose-cmd", pose_cmd, "--res", res, "--samples", samples, "--meshclean", clean],
                        env=env).returncode
    upload(os.path.join(out, "meta.json"), "meta.json", "application/json")
    upload(os.path.join(out, "views", "front.png"), "front.png", "image/png")
    if rc != 0:
        sys.exit(rc)
    frames = os.path.join(out, "frames")
    subprocess.run(["ffmpeg", "-y", "-stream_loop", "2", "-framerate", "30", "-i", os.path.join(frames, "run_%04d.png"),
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
                    os.path.join(out, "rig_preview.mp4")], check=True)
    subprocess.run([sys.executable, sheet, frames, os.path.join(out, "rig_sheet.png")], check=True)
    for name, path, content_type in (("rigged.glb", os.path.join(out, "rigged.glb"), "model/gltf-binary"),
                                     ("rig_preview.mp4", os.path.join(out, "rig_preview.mp4"), "video/mp4"),
                                     ("rig_sheet.png", os.path.join(out, "rig_sheet.png"), "image/png"),
                                     ("rig_weights.png", os.path.join(frames, "weights.png"), "image/png")):
        upload(path, name, content_type)
