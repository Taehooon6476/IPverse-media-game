"""GriptapeDeadlineProvider — runs a published Griptape workflow bundle on Deadline Cloud.

Inherits status/collect from DeadlineProvider; only submit differs (builds
a conda-based OpenJD template that installs and runs griptape-nodes-engine).

# ponytail: unexercised live path; the Blender relief job is the live Deadline proof
"""
from __future__ import annotations
import json

from server.providers.deadline import DeadlineProvider

# Run script — a Python file injected as an OpenJD embeddedFile.
# Takes BundleUri and OutputPrefix as positional argv.
_RUN_SCRIPT = """\
import sys, os, subprocess, pathlib, boto3

bundle_uri = sys.argv[1]
output_prefix = sys.argv[2]

# Download bundle from S3
s3 = boto3.client("s3")
bucket, prefix = bundle_uri.replace("s3://", "").split("/", 1)
dest = pathlib.Path("/tmp/bundle")
dest.mkdir(parents=True, exist_ok=True)
paginator = s3.get_paginator("list_objects_v2")
for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
    for obj in page.get("Contents", []):
        key = obj["Key"]
        rel = key[len(prefix):].lstrip("/")
        (dest / rel).parent.mkdir(parents=True, exist_ok=True)
        s3.download_file(bucket, key, str(dest / rel))

os.chdir("/tmp/bundle")
subprocess.check_call([sys.executable, "-m", "pip", "install", "griptape-nodes-engine"])
subprocess.check_call([sys.executable, "workflow.py"])

# Upload output/ to OutputPrefix
out_bucket, out_prefix = output_prefix.replace("s3://", "").split("/", 1)
out_dir = pathlib.Path("/tmp/bundle/output")
if out_dir.exists():
    for f in out_dir.rglob("*"):
        if f.is_file():
            key = out_prefix + "/" + str(f.relative_to(out_dir))
            s3.upload_file(str(f), out_bucket, key)
"""

# OpenJD template — valid jobtemplate-2023-09 shape (script/actions/embeddedFiles).
# Conda queue environment on the farm handles the conda bootstrap.
_TEMPLATE: dict = {
    "specificationVersion": "jobtemplate-2023-09",
    "name": "IPverse Griptape Workflow",
    "parameterDefinitions": [
        {
            "name": "BundleUri",
            "type": "STRING",
            "description": "s3 prefix of the published Griptape workflow folder",
        },
        {
            "name": "OutputPrefix",
            "type": "STRING",
            "description": "s3 output prefix (no trailing slash)",
        },
        {
            "name": "CondaPackages",
            "type": "STRING",
            "default": "python=3.12 pip",
        },
        {
            "name": "CondaChannels",
            "type": "STRING",
            "default": "conda-forge",
        },
    ],
    "steps": [
        {
            "name": "Run",
            "script": {
                "actions": {
                    "onRun": {
                        "command": "python",
                        "args": [
                            "{{Task.File.Run}}",
                            "{{Param.BundleUri}}",
                            "{{Param.OutputPrefix}}",
                        ],
                    }
                },
                "embeddedFiles": [
                    {
                        "name": "Run",
                        "type": "TEXT",
                        "data": _RUN_SCRIPT,
                    }
                ],
            },
        }
    ],
}


class GriptapeDeadlineProvider(DeadlineProvider):
    """Submit a published Griptape workflow folder to Deadline Cloud.

    job["input"] must contain:
      bundleUri  — s3 prefix of the published workflow folder
    """

    name = "griptape_deadline"

    # ponytail: unexercised live path; the Blender relief job is the live Deadline proof

    def submit(self, job: dict, ctx) -> str:
        job_id = job["jobId"]
        inp = job["input"]
        bundle_uri = inp["bundleUri"]
        output_prefix = inp.get(
            "outputPrefix",
            f"s3://{ctx.queue_bucket}/{ctx.queue_prefix}/{job_id}",
        )

        parameters = {
            "BundleUri": {"string": bundle_uri},
            "OutputPrefix": {"string": output_prefix},
        }

        response = ctx.deadline.create_job(
            farmId=ctx.deadline_farm_id,
            queueId=ctx.deadline_queue_id,
            template=json.dumps(_TEMPLATE),
            templateType="JSON",
            parameters=parameters,
            priority=50,
            maxRetriesPerTask=1,
        )
        return response["jobId"]

    # status() and collect() inherited from DeadlineProvider — no duplication
