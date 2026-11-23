# IPverse Griptape Nodes

Two custom nodes that let the Griptape Nodes Desktop app talk to an
IPverse Studio backend.

## Nodes

### IPverseRunTool (ControlNode)

Calls `POST /api/sessions/{id}/tools/{tool}` and exposes `result_json`.

| Parameter | Type | Description |
|---|---|---|
| `api_base` | str | Platform base URL, e.g. `https://d123.cloudfront.net` |
| `auth_token` | str | Cognito AccessToken — **bind to engine secret `IPVERSE_TOKEN`** |
| `session_id` | str | IPverse session UUID |
| `tool` | str | One of: `set_concept`, `create_ip_asset`, `render_3d`, `make_video_shot`, `cut_trailer`, `make_game`, `publish_game` |
| `args_json` | str | Tool arguments as a JSON string |
| **`result_json`** (output) | str | Raw JSON response from the tool |

### IPverseSessionAssets (DataNode)

Calls `GET /api/sessions/{id}` and exposes the assets array.

| Parameter | Type | Description |
|---|---|---|
| `api_base` | str | Platform base URL |
| `auth_token` | str | Cognito AccessToken — **bind to engine secret `IPVERSE_TOKEN`** |
| `session_id` | str | IPverse session UUID |
| **`assets_json`** (output) | str | Full assets array as a JSON string |
| **`asset_urls`** (output) | list | List of CDN asset URLs |

## Install

1. Open Griptape Nodes Desktop app (engine 0.101.0+).
2. Go to **Library Manager** → **Add Library from Path**.
3. Point to this folder (`plugins/griptape-ipverse/`).
4. The **IPverse** category appears in the node picker.

## Set the secret

1. In the Griptape Nodes Desktop app open **Secrets**.
2. Add a secret named `IPVERSE_TOKEN` with your Cognito AccessToken value.
3. On each node, right-click `auth_token` → **Bind to Secret** → `IPVERSE_TOKEN`.

The token can be obtained after login:

```python
import boto3
cognito = boto3.client("cognito-idp", region_name="us-east-1")
result = cognito.initiate_auth(
    AuthFlow="USER_PASSWORD_AUTH",
    AuthParameters={"USERNAME": "...", "PASSWORD": "..."},
    ClientId="<CLIENT_ID>",
)
print(result["AuthenticationResult"]["AccessToken"])
```

## Wiring the two nodes

```
[IPverseRunTool] ──result_json──▶  (your processing nodes)
[IPverseSessionAssets] ──asset_urls──▶  (S3PutFile / image nodes)
```

Typical workflow:

1. Set `api_base` and `session_id` on both nodes.
2. Bind `auth_token` to the `IPVERSE_TOKEN` secret on both.
3. Connect `IPverseRunTool.result_json` downstream (parse with a JSON node to extract `jobId`).
4. Poll with `IPverseSessionAssets` until `asset_urls` contains the expected outputs.

## Notes

- HTTP calls use `urllib.request` (no external dependencies).
- Timeout is 60 seconds per request.
- POST requests include `x-amz-content-sha256: sha256(body)` — required by the CloudFront Origin Access Control in front of the IAM-authenticated Lambda Function URL.
- GET requests carry no body and no `x-amz-content-sha256` header.
- HTTP errors surface as `RuntimeError("HTTP {code}: {body}")` with the response body included.
- The engine runs on your Mac; it is **not** a dependency of the Lambda backend.
