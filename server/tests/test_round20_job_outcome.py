"""A done job whose result did not simply succeed carries `outcome`: "rejected" (the result was kept out, what was
there before stays) or "check_failed" (the result, or a stand-in, is in use although its check failed). A plain
success has no such field. Fakes only."""
import pytest

from server import jobs, store
from server.providers import mediagen_image as mi
from server.tests.conftest import FakeLambda, FakeProvider, FakeTable, make_ctx
from server.tests.test_klein_edit_check import (_edit, _knight, box, ctx, session, verdict, vision)  # noqa: F401

SID = "ses_outcome"


class Flagging(FakeProvider):
    """A provider that leaves on the job what mediagen_image._flag and mediagen_video._kept leave."""

    def __init__(self, name, note=None, keep_ip=False):
        super().__init__(name, states=[("done", "")],
                         assets=[{"kind": "image", "key": "sessions/x/a.png", "contentType": "image/png", "meta": {}}])
        self.note, self.keep_ip = note, keep_ip

    def collect(self, job, ctx):
        if self.note:
            job["_note"] = self.note
        if self.keep_ip:
            job["_keep_ip"] = True
        return super().collect(job, ctx)


@pytest.fixture
def plain(monkeypatch):
    """A context with no GPU box behind it: the providers are the fakes each test registers."""
    monkeypatch.setenv("SELF_FUNCTION_NAME", "ipverse-api")
    return make_ctx(table=FakeTable(), lambda_=FakeLambda())


def _settled(ctx, monkeypatch, provider):
    monkeypatch.setitem(jobs.PROVIDERS, provider.name, provider)
    job = jobs.create_job(ctx, SID, "image", provider.name, {}, [])
    jobs.advance_jobs(ctx, SID)
    return next(j for j in store.snapshot(ctx, SID)["jobs"] if j["jobId"] == job["jobId"])


def test_a_result_kept_out_of_its_ip_is_marked_rejected(plain, monkeypatch):
    note = "수정 검사 실패: 배경이 바뀜. 새 그림(v2)은 버전 기록에만 두고 지금 그림(v1)을 그대로 씁니다."
    done = _settled(plain, monkeypatch, Flagging("mediagen_image", note, keep_ip=True))
    assert (done["status"], done["outcome"], done["error"]) == ("done", "rejected", note)


def test_a_result_in_use_with_a_failed_check_is_marked_check_failed(plain, monkeypatch):
    note = "구도 검사 실패: 위쪽이 프레임에 잘림. 첫 그림이라 그대로 두었으니 다시 뽑아 주세요."
    done = _settled(plain, monkeypatch, Flagging("mediagen_image", note))
    assert (done["status"], done["outcome"], done["error"]) == ("done", "check_failed", note)


def test_a_plain_success_looks_as_it_did(plain, monkeypatch):
    done = _settled(plain, monkeypatch, Flagging("mediagen_image"))
    assert done["status"] == "done" and "outcome" not in done and not done.get("error")


def test_an_older_draw_landing_late_is_no_rejection(plain, monkeypatch):
    """_keep_ip alone (a retried draw landing after a newer version) has no note and failed no check."""
    done = _settled(plain, monkeypatch, Flagging("mediagen_image", keep_ip=True))
    assert done["status"] == "done" and "outcome" not in done


def test_a_failed_job_carries_no_outcome(plain, monkeypatch):
    fake = FakeProvider("mediagen_image", states=[("failed", "GPU 오류")])
    failed = _settled(plain, monkeypatch, fake)
    assert failed["status"] == "failed" and "outcome" not in failed


def test_the_rejected_klein_edit_of_round_20_says_so_in_its_record(ctx, session, box, vision):  # noqa: F811
    """The real provider: an edit that fails the edit check twice is kept as a version only (the IP stays v1)."""
    vision._responses[:] = [verdict(face_appeared=True), verdict(face_appeared=True)]
    ip_id = _knight(ctx, session)
    job, ip, _ = _edit(ctx, session, ip_id)
    assert job["status"] == "done" and job["error"].startswith(f"{mi.EDIT_FAILED}: ") and ip["version"] == 1
    assert job["outcome"] == "rejected"


def test_a_klein_edit_that_passes_has_no_outcome(ctx, session, box, vision):  # noqa: F811
    vision._responses[:] = [verdict()]
    ip_id = _knight(ctx, session)
    job, ip, _ = _edit(ctx, session, ip_id)
    assert job["status"] == "done" and ip["version"] == 2 and "outcome" not in job and not job.get("error")
    first = store.snapshot(ctx, session["sessionId"])["jobs"][0]
    assert first["status"] == "done" and "outcome" not in first
