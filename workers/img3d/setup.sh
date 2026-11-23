#!/bin/bash
# One-time (idempotent) install of Hunyuan3D-2.1 + the img3d worker on the IPverse img3d box.
# Deep Learning OSS Nvidia Driver AMI GPU PyTorch 2.7 (Ubuntu 22.04): driver + CUDA 12.x toolkit, Python 3.10.
# Run as root by user data on first boot (or again via SSM Run Command: scripts/deploy_img3d.sh --setup).
# Needs /etc/img3d.env (IMG3D_BUCKET, IMG3D_QUEUE_URL). Log: /var/log/img3d-setup.log. ~25 min cold.
set -euxo pipefail
exec >>/var/log/img3d-setup.log 2>&1
echo "=== img3d setup $(date -u +%FT%TZ)"
. /etc/img3d.env
ROOT=/opt/img3d
REPO=$ROOT/Hunyuan3D-2.1
VENV=$ROOT/venv
HY3D_COMMIT=${HY3D_COMMIT:-main}
export HF_HOME=$ROOT/hf HY3DGEN_MODELS=$ROOT/hy3dgen
mkdir -p "$ROOT/work" "$HF_HOME"

# worker code (re-synced on every service start too)
aws s3 cp "s3://$IMG3D_BUCKET/img3d/worker/worker.py" "$ROOT/worker.py"
aws s3 cp "s3://$IMG3D_BUCKET/img3d/worker/ipverse-img3d.service" /etc/systemd/system/ipverse-img3d.service

if [ ! -f "$ROOT/.installed" ]; then
  apt-get -o DPkg::Lock::Timeout=900 update -y
  apt-get -o DPkg::Lock::Timeout=900 install -y python3.10-venv python3.10-dev git libgl1 libglib2.0-0 libegl1
  [ -d "$REPO/.git" ] || git clone https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1.git "$REPO"
  git -C "$REPO" checkout "$HY3D_COMMIT"
  [ -x "$VENV/bin/python" ] || python3.10 -m venv "$VENV"
  PIP="$VENV/bin/pip"
  $PIP install -U pip wheel "setuptools<70"  # pytorch-lightning 1.9 imports pkg_resources (gone in setuptools 81+)
  $PIP install torch==2.5.1 torchvision==0.20.1 --index-url https://download.pytorch.org/whl/cu124
  # inference needs only these: drop the demo/training extras (gradio, deepspeed, open3d, cupy, bpy, mirrors)
  grep -vE '^(--extra-index-url|bpy|deepspeed|open3d|cupy|gradio|fastapi|uvicorn|tb_nightly|pythreejs)' \
    "$REPO/requirements.txt" > "$ROOT/requirements.txt"
  echo tensorboard >> "$ROOT/requirements.txt"
  $PIP install --no-build-isolation -r "$ROOT/requirements.txt" boto3
  export CUDA_HOME=$(ls -d /usr/local/cuda-12* | sort -V | tail -1)
  export PATH=$CUDA_HOME/bin:$PATH TORCH_CUDA_ARCH_LIST=8.9
  (cd "$REPO/hy3dpaint/custom_rasterizer" && $PIP install --no-build-isolation -e .)
  (cd "$REPO/hy3dpaint/DifferentiableRenderer" && PATH=$VENV/bin:$PATH bash compile_mesh_painter.sh)
  mkdir -p "$REPO/hy3dpaint/ckpt"
  [ -f "$REPO/hy3dpaint/ckpt/RealESRGAN_x4plus.pth" ] || curl -fsSL -o "$REPO/hy3dpaint/ckpt/RealESRGAN_x4plus.pth" \
    https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth
  # weights on the root volume (HF_HOME, HY3DGEN_MODELS): shape + paint + DINOv2, by loading the pipelines once
  (cd "$REPO" && $VENV/bin/python "$ROOT/worker.py" --warmup)
  # rembg's u2net model (only used for images without alpha)
  $VENV/bin/python -c "from rembg import new_session; new_session()" || true
  touch "$ROOT/.installed"
fi

systemctl daemon-reload
systemctl enable ipverse-img3d.service
# start, never restart: on a box launched from the baked AMI the enabled service is already up and may hold
# a job (a restart here killed one mid-run). ExecStartPre syncs worker.py on every start anyway.
systemctl start ipverse-img3d.service
echo "=== img3d setup done $(date -u +%FT%TZ)"
