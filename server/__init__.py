import os as _os
import pathlib as _pathlib

# botocore loads these service models before its own: IVS ad insertion (InsertAdBreak) and GameLift Streams
# TargetIdleCapacity may be newer than the Lambda runtime's botocore.
_os.environ.setdefault("AWS_DATA_PATH", str(_pathlib.Path(__file__).parent / "aws_models"))
