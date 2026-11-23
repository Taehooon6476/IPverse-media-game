# Griptape Nodes ↔ IPverse Studio integration

## Verdict

Plugin-style attachment is **feasible in both directions**, but the Griptape
Nodes engine is not a server-side dependency of the platform:

- **Platform → Griptape (Direction 1):** The platform can submit a published
  Griptape workflow bundle to Deadline Cloud via `GriptapeDeadlineProvider`
  (`provider = "griptape_deadline"`). The Deadline worker downloads the bundle,
  installs `griptape-nodes-engine`, and runs `workflow.py` headlessly. Output
  files in `bundle/output/` are uploaded to the session's `OutputPrefix`.

- **Griptape → Platform (Direction 2):** The Griptape Nodes Desktop app (on
  the user's Mac) can call platform APIs directly using the two custom nodes in
  `plugins/griptape-ipverse/`: `IPverseRunTool` calls any agent tool endpoint;
  `IPverseSessionAssets` fetches the session snapshot. No server-side code
  changes are needed for this direction.

## Architecture

```
Mac (Griptape Nodes Desktop 0.101.0)
  └── IPverseRunTool / IPverseSessionAssets
        └── HTTP  ──▶  CloudFront /api/*  ──▶  Lambda  ──▶  DynamoDB / S3

Lambda (platform backend)
  └── GriptapeDeadlineProvider.submit()
        └── Deadline Cloud  ──▶  Conda worker
              └── pip install griptape-nodes-engine
              └── python workflow.py  (published Griptape bundle)
              └── upload output/ → S3
```

## Install — Griptape → Platform (custom node library)

1. Open the Griptape Nodes Desktop app.
2. **Library Manager** → **Add Library from Path** → select
   `plugins/griptape-ipverse/`.
3. The **IPverse** category appears in the node picker with two nodes.
4. In **Secrets**, add `IPVERSE_TOKEN` = your Cognito AccessToken.
5. On each node, bind `auth_token` to the `IPVERSE_TOKEN` secret.

## Install — Platform → Griptape (Deadline provider)

The `GriptapeDeadlineProvider` is registered as provider name
`"griptape_deadline"`. To trigger it, submit a job whose `provider` field
is `"griptape_deadline"` and whose `input.bundleUri` is an S3 prefix
pointing to a folder containing at least `workflow.py`. The farm uses the
same Conda queue environment as the Blender relief worker.

## Limitations

| Limitation | Detail |
|---|---|
| Engine runs on Mac | Griptape Nodes Desktop is a Mac app; it cannot run inside Lambda. |
| Deadline cold start | The Conda service-managed fleet (farm `farm-7e90f6ad8b8d4a99a614f5e0db148f36`, queue `queue-3a8f02c1a75d4bef86411923256597ac`) takes **10–20 minutes** to scale from 0. Not suitable for interactive sessions. |
| Hardcoded buckets in sandbox nodes | The user's 17 existing sandbox nodes (`DeadlineCloudJob`, `BedrockLumaRay2Video`, etc.) have hardcoded bucket names and regions. They cannot be shared without parameterising those values. |
| No bidirectional live link | The platform does not open a WebSocket or MCP server channel to the engine at runtime. The Griptape MCP server is available but not wired. |
| `griptape_deadline` provider not exercised live | The Blender relief Deadline job is the live proof of Deadline integration. The Griptape provider reuses that logic but has not been run end-to-end. |

## Upgrade path

1. **Publish a Griptape workflow to S3.** Griptape Nodes supports publishing
   to a local folder (headless). Use the CLI to export the workflow to
   `s3://griptapenode-queue-087967639890-us-east-1-an/griptape-bundles/{name}/`.
2. **Submit via the platform.** Call `POST /api/sessions/{id}/tools/render_3d`
   (or any tool) with `provider` overridden to `"griptape_deadline"` and
   `input.bundleUri` set to the S3 prefix.
3. **Poll until done.** `GET /api/sessions/{id}` advances the job; when
   `status == "done"`, the output assets are in the session asset list.

## File inventory

| File | Purpose |
|---|---|
| `plugins/griptape-ipverse/ipverse_nodes.py` | `IPverseRunTool` and `IPverseSessionAssets` node implementations |
| `plugins/griptape-ipverse/griptape_nodes_library.json` | Library manifest (schema 0.6.0) for Library Manager |
| `plugins/griptape-ipverse/README.md` | End-user install guide |
| `plugins/griptape-ipverse/tests/test_nodes_import.py` | Unit tests (stub `griptape_nodes`; exercises `process()` URL+header+body) |
| `server/providers/griptape.py` | `GriptapeDeadlineProvider` (subclasses `DeadlineProvider`) |
| `server/tests/test_griptape_provider.py` | Unit tests for the provider |
