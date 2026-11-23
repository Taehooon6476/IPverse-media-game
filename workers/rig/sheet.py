"""Contact sheet of rig validation frames: row 1 = 6 run-cycle frames, row 2 = 6 attack frames.

python sheet.py FRAMES_DIR OUT.png [--stills DIR]   (pillow only)
--stills also writes run_1..6.png and attack_1..6.png into DIR.
"""
import glob
import os
import shutil
import sys

from PIL import Image


def pick_run(paths, n=6):
    return [paths[round(i * len(paths) / n)] for i in range(n)] if len(paths) >= n else paths


def main(argv):
    frames, out = argv[0], argv[1]
    stills = argv[argv.index("--stills") + 1] if "--stills" in argv else None
    rows = [pick_run(sorted(glob.glob(os.path.join(frames, "run_*.png")))),
            sorted(glob.glob(os.path.join(frames, "attack_*.png")))[:6]]
    if not rows[0]:
        sys.exit("sheet: no run frames in %s" % frames)
    w, h = Image.open(rows[0][0]).size
    sheet = Image.new("RGB", (w * 6, h * len(rows)), (12, 13, 18))
    for r, row in enumerate(rows):
        for c, path in enumerate(row):
            sheet.paste(Image.open(path).convert("RGB"), (c * w, r * h))
            if stills:
                os.makedirs(stills, exist_ok=True)
                shutil.copy(path, os.path.join(stills, "%s_%d.png" % (("run", "attack")[r], c + 1)))
    sheet.save(out)


if __name__ == "__main__":
    main(sys.argv[1:])
