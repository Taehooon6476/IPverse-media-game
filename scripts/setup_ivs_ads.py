#!/usr/bin/env python3
"""One-time (idempotent) setup of IVS server-side ad insertion for the live channel (server/live.py, server/ads.py).

  1. MediaTailor playback configuration "ipverse-ivs": content source = the account's IVS playback URL prefix
     (…live-video.net/), insertion mode PLAYER_SELECT (both required by IVS), ADS =
     vast/ivs/p-[player_params.persona].xml on the live CDN. Each viewer's playback token carries its persona
     (aws:ads-player-params), so each viewer's MediaTailor session asks for its persona's VAST; no persona asks for
     p-.xml, the default ad. The API writes them all before each break (the /vast/* behavior does not cache).
  2. IVS ad configuration "ipverse-ads" pointing at it.
  3. The player channel (ipverse-live-player, TS container, private) gets the ad configuration. IVS only allows that
     while the channel is offline, so run this with no broadcast on.

--ads-log-percent N turns on MediaTailor's ADS interaction log (CloudWatch MediaTailor/AdDecisionServerInteractions)
for N % of sessions: the record of which persona file each viewer asked for and which creative it got.

Run: python3 scripts/setup_ivs_ads.py [--live-cdn d27vxjp2usbhhb.cloudfront.net] [--ads-log-percent 100]
"""
import argparse
import sys

import boto3

REGION = "us-east-1"
CHANNEL = "ipverse-live-player"
MT_NAME, AD_NAME = "ipverse-ivs", "ipverse-ads"


def ads_url(live_cdn: str) -> str:
    return f"https://{live_cdn}/vast/ivs/p-[player_params.persona].xml"


def setup(ivs, mt, live_cdn: str, log_percent: int | None = None):
    ch = next((c for c in ivs.list_channels(filterByName=CHANNEL)["channels"] if c["name"] == CHANNEL), None)
    if not ch:
        sys.exit(f"no IVS channel {CHANNEL}")
    chan = ivs.get_channel(arn=ch["arn"])["channel"]
    if chan.get("containerFormat", "TS") != "TS":
        sys.exit("IVS ad insertion needs the TS container")
    if not chan.get("authorized"):
        print(f"warning: {CHANNEL} is authorized=false: viewers could forge their persona (deploy IpverseLive first)")
    prefix = chan["playbackUrl"].split("live-video.net/", 1)[0] + "live-video.net/"
    cfg = mt.put_playback_configuration(
        Name=MT_NAME, VideoContentSourceUrl=prefix, InsertionMode="PLAYER_SELECT",
        AdDecisionServerUrl=ads_url(live_cdn), AvailSuppression={"Mode": "OFF"}, Tags={"project": "ipverse"})
    print("mediatailor", cfg["Name"], cfg["InsertionMode"], cfg["VideoContentSourceUrl"], cfg["AdDecisionServerUrl"])
    if log_percent is not None:
        mt.configure_logs_for_playback_configuration(PlaybackConfigurationName=MT_NAME, PercentEnabled=log_percent)
        print("mediatailor ADS log", f"{log_percent}%")
    found = [a for a in ivs.list_ad_configurations()["adConfigurations"] if a.get("name") == AD_NAME]
    if found:
        ad_arn = found[0]["arn"]
    else:
        ad_arn = ivs.create_ad_configuration(name=AD_NAME, tags={"project": "ipverse"}, mediaTailorPlaybackConfigurations=[
            {"playbackConfigurationArn": cfg["PlaybackConfigurationArn"]}])["adConfiguration"]["arn"]
    print("ad configuration", ad_arn)
    if chan.get("adConfigurationArn") != ad_arn:
        ivs.update_channel(arn=chan["arn"], adConfigurationArn=ad_arn)  # fails while the channel is live
    after = ivs.get_channel(arn=chan["arn"])["channel"]
    print("channel", CHANNEL, "->", after.get("adConfigurationArn"), f"authorized={str(after.get('authorized')).lower()}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--live-cdn", default="d27vxjp2usbhhb.cloudfront.net", help="the IpverseLive CloudFront domain")
    ap.add_argument("--ads-log-percent", type=int, choices=range(0, 101), metavar="0-100",
                    help="MediaTailor ADS interaction log for this share of sessions")
    args = ap.parse_args()
    setup(boto3.client("ivs", region_name=REGION), boto3.client("mediatailor", region_name=REGION), args.live_cdn,
          args.ads_log_percent)


if __name__ == "__main__":
    main()
