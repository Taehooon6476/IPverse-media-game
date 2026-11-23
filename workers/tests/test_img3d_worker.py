"""workers/img3d/worker.py loop with fake SQS/S3 and a fake generator (no GPU, no AWS)."""
import importlib.util
import json
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location("img3d_worker", Path(__file__).resolve().parents[1] / "img3d" / "worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class SQS:
    """`bodies` wait on queue "q"; `queues` {url: [bodies]} for more. `polls`: (url, WaitTimeSeconds) per receive."""

    def __init__(self, bodies=(), queues=None):
        self.queues = {url: [{"ReceiptHandle": f"{url}-r{i}" if queues else f"r{i}", "Body": b}
                             for i, b in enumerate(msgs)] for url, msgs in (queues or {"q": bodies}).items()}
        self.deleted, self.polls = [], []

    @property
    def msgs(self):
        return self.queues.setdefault("q", [])

    def receive_message(self, **kw):
        assert kw["VisibilityTimeout"] == 600  # a dead box holds the FIFO line no longer than this
        self.polls.append((kw["QueueUrl"], kw["WaitTimeSeconds"]))
        msgs = self.queues.get(kw["QueueUrl"], [])
        return {"Messages": [msgs.pop(0)]} if msgs else {}

    def delete_message(self, QueueUrl, ReceiptHandle):
        assert ReceiptHandle.startswith(QueueUrl) or QueueUrl == "q"  # deleted on the queue it came from
        self.deleted.append(ReceiptHandle)

    def change_message_visibility(self, **kw):
        pass


class S3:
    def __init__(self):
        self.store, self.statuses = {"in/j1.png": b"PNG"}, []

    def put_object(self, Bucket, Key, Body, **kw):
        self.store[Key] = Body
        if Key.endswith("status.json"):
            self.statuses.append(json.loads(Body))

    def download_file(self, Bucket, Key, Filename):
        Path(Filename).write_bytes(self.store[Key])

    def upload_file(self, Filename, Bucket, Key, **kw):
        self.store[Key] = Path(Filename).read_bytes()


MSG = json.dumps({"jobId": "j1", "input_key": "in/j1.png", "output_prefix": "out/j1/", "params": {"seed": 7}})


def make(tmp_path, bodies, generate, clock=None):
    stops = []
    w = worker.Worker(SQS(bodies), S3(), "q", "b", generate, lambda: stops.append(1), idle_sec=1200,
                      clock=clock or (lambda: 0.0), work_dir=str(tmp_path), heartbeat_sec=3600)
    return w, stops


def test_job_runs_uploads_glb_and_reports_done(tmp_path):
    seen = {}

    def generate(src, work, params, set_phase):
        seen.update(src=Path(src).read_bytes(), params=params)
        set_phase("shape")
        set_phase("texture")
        glb = Path(work) / "model.glb"
        glb.write_bytes(b"GLB")
        return {"glb": str(glb), "stats": {"vertices": 3, "faces": 1}}

    w, stops = make(tmp_path, [MSG], generate)
    assert w.poll_once(wait=0) is True
    assert seen == {"src": b"PNG", "params": {"seed": 7}}
    assert w.s3.store["out/j1/model.glb"] == b"GLB"
    phases = [s["phase"] for s in w.s3.statuses]
    assert phases[:3] == ["download", "shape", "texture"] and "upload" in phases
    final = w.s3.statuses[-1]
    assert (final["status"], final["stats"], final["error"]) == ("done", {"vertices": 3, "faces": 1}, "")
    assert w.sqs.deleted == ["r0"] and stops == []
    assert not (tmp_path / "j1").exists()  # work dir cleaned


def test_failure_is_reported_and_not_redelivered(tmp_path):
    def generate(src, work, params, set_phase):
        set_phase("texture")
        raise RuntimeError("CUDA out of memory")

    w, _ = make(tmp_path, [MSG], generate)
    w.poll_once(wait=0)
    final = w.s3.statuses[-1]
    assert (final["status"], final["phase"]) == ("failed", "texture")
    assert "CUDA out of memory" in final["error"] and w.sqs.deleted == ["r0"]


def test_malformed_message_is_dropped(tmp_path):
    w, _ = make(tmp_path, ["not json"], lambda *a: None)
    w.poll_once(wait=0)
    assert w.sqs.deleted == ["r0"] and w.s3.statuses == []


def test_stops_itself_after_the_idle_window(tmp_path):
    now = [0.0]
    w, stops = make(tmp_path, [], lambda *a: None, clock=lambda: now[0])
    now[0] = 1199
    w.poll_once(wait=0)
    assert stops == []
    now[0] = 1200
    w.poll_once(wait=0)
    assert stops == [1]


# ── the queue is FIFO and the worker says which ticket it runs ──

def _glb(src, work, params, set_phase):
    glb = Path(work) / "model.glb"
    glb.write_bytes(b"GLB")
    return {"glb": str(glb)}


def test_m8_the_worker_writes_the_ticket_it_runs_for_the_job_lines_behind_it(tmp_path):
    heads = []

    def generate(src, work, params, set_phase):
        heads.append(json.loads(w.s3.store[worker.HEAD_KEY]))
        return _glb(src, work, params, set_phase)

    generate.loaded = lambda: False  # the first mesh after a boot loads the models too
    body = json.dumps({**json.loads(MSG), "ticket": 12})
    w, _ = make(tmp_path, [body], generate)
    w.poll_once(wait=0)
    assert {k: heads[0][k] for k in ("ticket", "jobId", "status", "expectSec")} == {
        "ticket": 12, "jobId": "j1", "status": "running", "expectSec": worker.RUN_SEC + worker.LOAD_SEC}
    assert heads[0]["startedAt"].endswith("Z")
    assert json.loads(w.s3.store[worker.HEAD_KEY])["status"] == "done"


def test_m8_a_message_without_a_ticket_leaves_the_head_alone(tmp_path):
    w, _ = make(tmp_path, [MSG], _glb)
    w.poll_once(wait=0)
    assert worker.HEAD_KEY not in w.s3.store


def test_m8_the_old_standard_queue_is_drained_first_then_the_fifo_queue_is_long_polled(tmp_path):
    old, fifo = "https://sqs/q", "https://sqs/q.fifo"
    sqs = SQS(queues={old: [MSG], fifo: [MSG]})
    w = worker.Worker(sqs, S3(), [old, fifo], "b", _glb, lambda: None, work_dir=str(tmp_path), heartbeat_sec=3600)
    w.s3.store["in/j1.png"] = b"PNG"
    assert w.poll_once(wait=20) is True and sqs.polls == [(old, 0)]
    assert w.poll_once(wait=20) is True and sqs.polls[1:] == [(old, 0), (fifo, 20)]
    assert sqs.deleted == [f"{old}-r0", f"{fifo}-r0"]


def test_m8_a_deleted_old_queue_does_not_keep_the_box_from_stopping(tmp_path):
    class Gone(SQS):
        def receive_message(self, **kw):
            if kw["QueueUrl"] == "old":
                raise RuntimeError("AWS.SimpleQueueService.NonExistentQueue")
            return super().receive_message(**kw)

    stops = []
    w = worker.Worker(Gone(queues={"old": [], "new": []}), S3(), ["old", "new"], "b", _glb, lambda: stops.append(1),
                      idle_sec=0, clock=lambda: 5.0, work_dir=str(tmp_path))
    assert w.poll_once(wait=0) is False and stops == [1]


class Probe:
    def __init__(self, exists):
        self.exists, self.asked = exists, []

    def get_queue_attributes(self, QueueUrl, AttributeNames):
        self.asked.append(QueueUrl)
        if not self.exists:
            raise RuntimeError("AWS.SimpleQueueService.NonExistentQueue")
        return {"Attributes": {}}


def test_m8_the_box_finds_the_fifo_queue_next_to_the_one_in_its_env_file():
    url = "https://sqs.us-east-1.amazonaws.com/087967639890/ipverse-img3d-jobs"
    assert worker.queue_urls(Probe(True), url) == [url, url + ".fifo"]
    assert worker.queue_urls(Probe(False), url) == [url]  # not deployed yet: the env file's queue alone
    probe = Probe(True)
    assert worker.queue_urls(probe, url + ".fifo") == [url + ".fifo"] and probe.asked == []


class Trimesh:  # the trimesh.Trimesh members strip_sheets uses
    def __init__(self, vertices, faces, process=True):
        self.vertices, self.faces, self.process = vertices, faces, process


def test_white_mesh_loses_the_floor_slab_before_painting():
    pytest.importorskip("numpy")
    from test_meshclean import figure, floor_slab, merge
    vertices, faces = merge(figure(), floor_slab())
    out, cleanup = worker.strip_sheets(Trimesh(vertices, faces))
    assert cleanup == {"removedFaces": len(faces) - len(out.faces), "slabs": 1, "cards": 0, "backdrops": 0}
    assert out.process is False and out.vertices[:, 1].min() > -0.99 and len(out.vertices) < len(vertices)
    assert out.faces.max() == len(out.vertices) - 1
    clean = Trimesh(*figure(bottom=-1.0))
    assert worker.strip_sheets(clean) == (clean, {"removedFaces": 0, "slabs": 0, "cards": 0, "backdrops": 0})


def test_m5_the_shields_square_backdrop_goes_before_painting_given_the_cutouts_fill():
    """A kite shield's cutout fills 73% of its bbox; a mesh filling the whole front square has a backdrop plate."""
    np = pytest.importorskip("numpy")
    from test_meshclean import KITE_FILL, real_mesh
    V, F = real_mesh("shield_job_dbae148996.npz")
    out, cleanup = worker.strip_sheets(Trimesh(V, F), fill=KITE_FILL)
    assert cleanup["backdrops"] == 1 and cleanup["removedFaces"] == len(F) - len(out.faces) > 5000
    assert np.ptp(out.vertices[:, 0]) < 1.5  # 1.4 wide: the shield, not the 2.0 plate
    assert worker.strip_sheets(Trimesh(V, F))[1]["backdrops"] == 0  # no cutout to compare: nothing removed


def test_m5_the_cutout_fill_is_the_opaque_share_of_its_alpha_bbox():
    Image = pytest.importorskip("PIL.Image")
    im = Image.new("RGBA", (100, 60), (0, 0, 0, 0))
    im.paste((200, 0, 0, 255), (10, 10, 50, 50))  # a 40 x 40 square: fills its bbox
    assert worker.cutout_fill(im) == pytest.approx(1.0)
    tri = Image.new("RGBA", (101, 101), (0, 0, 0, 0))
    for y in range(101):  # a triangle: about half its bbox
        tri.paste((200, 0, 0, 255), (0, y, y + 1, y + 1))
    assert worker.cutout_fill(tri) == pytest.approx(0.5, abs=0.02)
    assert worker.cutout_fill(Image.new("RGBA", (8, 8), (0, 0, 0, 0))) is None  # nothing opaque
