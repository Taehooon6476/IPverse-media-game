# Infra

CDK Python stacks for IPverse Studio. Account `087967639890`, core region `us-east-1`, video region `us-west-2`.

## Setup

```bash
# Create venv and install deps (from worktree root)
uv venv infra/.venv --python python3
uv pip install --python infra/.venv/bin/python -r infra/requirements.txt
```

## Run tests (TDD — run from worktree root)

```bash
infra/.venv/bin/python -m pytest infra/tests -v
```

## CDK synth

```bash
# Must use aws-cdk@latest (CLI 2.1117.0 bundled globally is below schema 55 threshold)
cd infra && JSII_SILENCE_WARNING_UNTESTED_NODE_VERSION=1 npx aws-cdk@latest synth --all
```

## One-command deploy

```bash
bash scripts/deploy.sh
```

## Notes

- `CDN_DOMAIN` env var is patched onto the Lambda via `aws lambda update-function-configuration` after deploy to avoid a CloudFormation circular dependency (Lambda→Distribution→FunctionUrl→Lambda).
- The distribution's id takes another way round the same cycle: the stack writes it to SSM `/ipverse/cdn-distribution-id` and the Lambda reads it by name (`CDN_DISTRIBUTION_PARAM`) when a session is deleted, to invalidate the session's files at the edges (`server/store.py`). Nothing to patch after a deploy. The grant (`cloudfront:CreateInvalidation` on this distribution) is in its own policy `CdnInvalidation`, because the function depends on its role's default policy.
- `SELF_FUNCTION_NAME=ipverse-api` is a literal string to avoid the self-invoke circular ref.
- ffmpeg layer cached under `build/cache/` — rebuild skipped if binary already present.
