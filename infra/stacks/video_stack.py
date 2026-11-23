import aws_cdk as cdk
from aws_cdk import aws_s3 as s3
from constructs import Construct


class VideoStack(cdk.Stack):
    def __init__(self, scope: Construct, id: str, **kwargs):
        super().__init__(scope, id, **kwargs)

        account = self.account  # "087967639890"
        region = self.region    # "us-west-2"

        bucket = s3.Bucket(
            self,
            "VideoBucket",
            bucket_name=f"ipverse-video-{account}-{region}",
            block_public_access=s3.BlockPublicAccess.BLOCK_ALL,
            removal_policy=cdk.RemovalPolicy.RETAIN,
            lifecycle_rules=[
                s3.LifecycleRule(
                    id="expire-7d",
                    enabled=True,
                    expiration=cdk.Duration.days(7),
                )
            ],
        )

        cdk.CfnOutput(self, "VideoBucketName", value=bucket.bucket_name)
