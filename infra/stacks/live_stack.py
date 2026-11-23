"""IpverseLive: the gameplay live stream on Amazon IVS, with ads by IVS server-side ad insertion (server/live.py).

play window (IVS Web Broadcast) --> IVS low-latency channel (ipverse-live-player) --> viewers (Amazon IVS Player)
private: viewers play its URL with a token the API signs (server/ads.py; key: scripts/setup_ivs_playback_key.py),
  which carries the viewer's persona for the ads
ads: IVS asks the MediaTailor playback configuration "ipverse-ivs" (scripts/setup_ivs_ads.py) for each viewer's
  break; its ADS is the persona's VAST the API writes to this bucket (vast/ivs/p-<persona>.xml), served by the
  live CDN under /vast/*
recording: every broadcast is recorded (all renditions, no thumbnails) to the assets bucket under ivs/v1/...
  (IVS writes with its service-linked role), for the server-side highlights

The bucket also holds the API's job/status files; the CDN serves only /vast/* (everything else is refused at the
edge). The IVS channel's ad configuration is attached by scripts/setup_ivs_ads.py (IVS only allows it offline).
Logical ids (LiveBucket, PlayerIngest, PlayerKey, LiveCdn, LiveOac) must not change: the resources would be replaced.
"""
import aws_cdk as cdk
from aws_cdk import aws_cloudfront as cloudfront, aws_cloudfront_origins as origins, aws_ivs as ivs, aws_s3 as s3
from constructs import Construct

NAME = "ipverse-live"


class LiveStack(cdk.Stack):
    def __init__(self, scope: Construct, id: str, **kwargs):
        super().__init__(scope, id, **kwargs)
        region, account = self.region, self.account

        # live bucket: the per-persona VAST (vast/ivs/p-<persona>.xml) and the API's job/status files
        bucket = s3.Bucket(self, "LiveBucket", bucket_name=f"{NAME}-{account}-{region}",
                           block_public_access=s3.BlockPublicAccess.BLOCK_ALL, enforce_ssl=True,
                           removal_policy=cdk.RemovalPolicy.DESTROY, auto_delete_objects=True)

        # every broadcast recorded to the assets bucket (IpverseCore's, by name: no cross-stack reference); a publish
        # that drops and comes back within the window stays one recording
        recording = ivs.CfnRecordingConfiguration(
            self, "PlayerRecording", name=f"{NAME}-rec",
            destination_configuration=ivs.CfnRecordingConfiguration.DestinationConfigurationProperty(
                s3=ivs.CfnRecordingConfiguration.S3DestinationConfigurationProperty(
                    bucket_name=f"ipverse-assets-{account}-{region}")),
            thumbnail_configuration=ivs.CfnRecordingConfiguration.ThumbnailConfigurationProperty(recording_mode="DISABLED"),
            rendition_configuration=ivs.CfnRecordingConfiguration.RenditionConfigurationProperty(rendition_selection="ALL"),
            recording_reconnect_window_seconds=30)

        # the player's own browser publishes here (IVS Web Broadcast over WebRTC); viewers play its playback URL with
        # a signed token (private: a public channel would also take forged ad params)
        ivs_channel = ivs.CfnChannel(self, "PlayerIngest", name=f"{NAME}-player", latency_mode="LOW", type="BASIC",
                                     authorized=True, recording_configuration_arn=recording.attr_arn)
        ivs_key = ivs.CfnStreamKey(self, "PlayerKey", channel_arn=ivs_channel.attr_arn)

        # the ADS MediaTailor reads (vast/*), nothing else: job and status files are not public
        oac = cloudfront.S3OriginAccessControl(self, "LiveOac")
        bucket_origin = origins.S3BucketOrigin.with_origin_access_control(bucket, origin_access_control=oac)
        refuse = cloudfront.Function(self, "LiveOnlyVast", runtime=cloudfront.FunctionRuntime.JS_2_0, code=cloudfront.FunctionCode.from_inline(
            "function handler(event){return {statusCode:403,statusDescription:'Forbidden'};}"))
        dist = cloudfront.Distribution(
            self, "LiveCdn", comment="ipverse live: the ad VAST for MediaTailor (IVS ad insertion)",
            default_behavior=cloudfront.BehaviorOptions(
                origin=bucket_origin, cache_policy=cloudfront.CachePolicy.CACHING_DISABLED,
                function_associations=[cloudfront.FunctionAssociation(
                    function=refuse, event_type=cloudfront.FunctionEventType.VIEWER_REQUEST)]),
            price_class=cloudfront.PriceClass.PRICE_CLASS_200)
        dist.add_behavior("/vast/*", bucket_origin, cache_policy=cloudfront.CachePolicy.CACHING_DISABLED)

        self.bucket = bucket
        self.ivs_ingest = ivs_channel.attr_ingest_endpoint
        self.ivs_key = ivs_key.attr_value
        self.recording_arn = recording.attr_arn
        cdk.CfnOutput(self, "PlayerIngestEndpoint", value=ivs_channel.attr_ingest_endpoint)
        cdk.CfnOutput(self, "PlayerPlaybackUrl", value=ivs_channel.attr_playback_url)
        cdk.CfnOutput(self, "LiveBucketName", value=bucket.bucket_name)
        cdk.CfnOutput(self, "AdsUrl", value=f"https://{dist.distribution_domain_name}/vast/ivs/p-[player_params.persona].xml")
        cdk.CfnOutput(self, "PlayerRecordingArn", value=recording.attr_arn)
