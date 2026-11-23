"""TDD tests for GriptapeDeadlineProvider."""
from __future__ import annotations
import json
import pytest
from server.tests.conftest import FakeDeadline, make_ctx
from server.providers.griptape import GriptapeDeadlineProvider


def _make_job(bundle_uri="s3://bucket/workflows/wf-1"):
    return {
        "pk": "SESSION#sess-1",
        "jobId": "job-gt-1",
        "externalId": None,
        "input": {
            "bundleUri": bundle_uri,
        },
    }


def test_provider_name():
    assert GriptapeDeadlineProvider().name == "griptape_deadline"


def test_submit_template_conda_packages():
    """Template CondaPackages default must be 'python=3.12 pip'."""
    fake_dl = FakeDeadline()
    ctx = make_ctx(deadline=fake_dl)
    provider = GriptapeDeadlineProvider()
    provider.submit(_make_job(), ctx)

    assert fake_dl.calls, "create_job was not called"
    call = fake_dl.calls[0]
    template = json.loads(call["template"])

    params = {p["name"]: p for p in template["parameterDefinitions"]}
    assert "CondaPackages" in params, f"CondaPackages missing from {list(params)}"
    assert params["CondaPackages"]["default"] == "python=3.12 pip"


def test_submit_template_run_script_installs_engine():
    """embeddedFiles[0].data must contain 'griptape-nodes-engine'."""
    fake_dl = FakeDeadline()
    ctx = make_ctx(deadline=fake_dl)
    provider = GriptapeDeadlineProvider()
    provider.submit(_make_job(), ctx)

    call = fake_dl.calls[0]
    template = json.loads(call["template"])

    step = template["steps"][0]
    script_data = step["script"]["embeddedFiles"][0]["data"]
    assert "griptape-nodes-engine" in script_data, (
        f"'griptape-nodes-engine' not found in embeddedFiles[0].data:\n{script_data}"
    )


def test_submit_template_valid_openjd_shape():
    """Step must use script/actions/embeddedFiles, not tasks[]."""
    fake_dl = FakeDeadline()
    ctx = make_ctx(deadline=fake_dl)
    provider = GriptapeDeadlineProvider()
    provider.submit(_make_job(), ctx)

    call = fake_dl.calls[0]
    template = json.loads(call["template"])
    step = template["steps"][0]

    # valid jobtemplate-2023-09: script at the step level, not tasks[]
    assert "script" in step, "step must have 'script' key"
    assert "tasks" not in step, "step must NOT have 'tasks' key (invalid jobtemplate-2023-09)"
    assert "actions" in step["script"]
    assert "onRun" in step["script"]["actions"]
    assert "embeddedFiles" in step["script"]
    assert step["script"]["embeddedFiles"][0]["name"] == "Run"


def test_submit_template_has_bundle_uri_param():
    """Template parameterDefinitions must include BundleUri."""
    fake_dl = FakeDeadline()
    ctx = make_ctx(deadline=fake_dl)
    provider = GriptapeDeadlineProvider()
    provider.submit(_make_job(), ctx)

    call = fake_dl.calls[0]
    template = json.loads(call["template"])
    param_names = {p["name"] for p in template["parameterDefinitions"]}
    assert "BundleUri" in param_names


def test_submit_passes_bundle_uri_in_parameters():
    """create_job parameters must include BundleUri matching job input."""
    fake_dl = FakeDeadline()
    ctx = make_ctx(deadline=fake_dl)
    provider = GriptapeDeadlineProvider()
    provider.submit(_make_job(bundle_uri="s3://bucket/workflows/my-wf"), ctx)

    call = fake_dl.calls[0]
    assert call["parameters"]["BundleUri"]["string"] == "s3://bucket/workflows/my-wf"


def test_submit_returns_job_id():
    fake_dl = FakeDeadline()
    ctx = make_ctx(deadline=fake_dl)
    provider = GriptapeDeadlineProvider()
    result = provider.submit(_make_job(), ctx)
    assert result == "job-1"  # FakeDeadline.create_job always returns {"jobId": "job-1"}


def test_status_done():
    """status() inherits Deadline logic: SUCCEEDED -> done."""
    fake_dl = FakeDeadline()
    fake_dl._job_responses["ext-1"] = {
        "taskRunStatus": "SUCCEEDED",
        "lifecycleStatus": "CREATE_COMPLETE",
        "createdAt": "2026-01-01T00:00:00Z",
    }
    ctx = make_ctx(deadline=fake_dl)
    provider = GriptapeDeadlineProvider()
    status, _ = provider.status({"externalId": "ext-1"}, ctx)
    assert status == "done"


def test_status_failed():
    """status() inherits Deadline logic: FAILED -> failed."""
    fake_dl = FakeDeadline()
    fake_dl._job_responses["ext-2"] = {
        "taskRunStatus": "FAILED",
        "lifecycleStatus": "CREATE_COMPLETE",
        "createdAt": "2026-01-01T00:00:00Z",
    }
    ctx = make_ctx(deadline=fake_dl)
    provider = GriptapeDeadlineProvider()
    status, _ = provider.status({"externalId": "ext-2"}, ctx)
    assert status == "failed"


def test_status_running():
    """status() inherits Deadline logic: RUNNING -> running."""
    fake_dl = FakeDeadline()
    ctx = make_ctx(deadline=fake_dl)
    provider = GriptapeDeadlineProvider()
    # FakeDeadline default returns RUNNING/CREATE_COMPLETE
    status, _ = provider.status({"externalId": "unknown"}, ctx)
    assert status == "running"
