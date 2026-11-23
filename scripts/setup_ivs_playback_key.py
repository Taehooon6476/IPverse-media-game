#!/usr/bin/env python3
"""One-time (idempotent) playback key for the private live channel (server/ads.py signs viewer tokens with it).

  1. Secrets Manager ipverse/ivs-playback-key holds the ES384 (P-384) private key: {"d": hex scalar (what the Lambda
     signs with), "privateKeyPem", "publicKeyPem", "keyPairArn"}. Created here, locally, if it is not there yet.
  2. IVS playback key pair "ipverse-playback-key" = its public half (ImportPlaybackKeyPair).

Run again: nothing changes when both exist and match. A secret whose IVS key pair is gone gets it imported again. An
IVS key pair whose private key is not in the secret cannot be used: --replace deletes it and makes a new key (every
token signed with the old one stops working). The private key is never printed or written to disk.

Run: python3 scripts/setup_ivs_playback_key.py [--replace]
"""
import argparse
import json
import sys

import boto3
from botocore.exceptions import ClientError

REGION = "us-east-1"
SECRET_ID = "ipverse/ivs-playback-key"
KEY_NAME = "ipverse-playback-key"
TAGS = {"project": "ipverse"}


def _generate() -> dict:
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    key = ec.generate_private_key(ec.SECP384R1())
    return {"d": format(key.private_numbers().private_value, "x"),
            "privateKeyPem": key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                               serialization.NoEncryption()).decode(),
            "publicKeyPem": key.public_key().public_bytes(serialization.Encoding.PEM,
                                                          serialization.PublicFormat.SubjectPublicKeyInfo).decode()}


def _secret(sm):
    try:
        return json.loads(sm.get_secret_value(SecretId=SECRET_ID)["SecretString"])
    except ClientError as e:
        if e.response["Error"]["Code"] == "ResourceNotFoundException":
            return None
        raise


def _pair(ivs, arn):
    try:
        return ivs.get_playback_key_pair(arn=arn)["keyPair"]
    except ClientError as e:
        if e.response["Error"]["Code"] == "ResourceNotFoundException":
            return None
        raise


def ensure(ivs, sm, replace=False) -> dict:
    """→ {"status": "exists" | "created", "arn", "fingerprint"} (no key material)."""
    doc = _secret(sm)
    pair = _pair(ivs, doc["keyPairArn"]) if doc and doc.get("keyPairArn") and not replace else None
    if pair:
        return {"status": "exists", "arn": pair["arn"], "fingerprint": pair.get("fingerprint")}
    named = [k["arn"] for k in ivs.list_playback_key_pairs()["keyPairs"] if k.get("name") == KEY_NAME]
    if named and doc is None and not replace:
        sys.exit(f"IVS key pair {KEY_NAME} exists but its private key is not in {SECRET_ID}: "
                 "rerun with --replace to delete it and make a new key")
    for arn in named:  # being replaced, or ours from a run whose key pair ARN never reached the secret
        ivs.delete_playback_key_pair(arn=arn)
    if doc is None or replace:
        fresh = _generate()  # the private key goes to Secrets Manager first, so it is never lost
        if doc is None:
            sm.create_secret(Name=SECRET_ID, SecretString=json.dumps(fresh), Tags=[{"Key": k, "Value": v} for k, v in TAGS.items()],
                             Description="ES384 private key of the IVS playback key pair ipverse-playback-key (server/ads.py)")
        else:
            sm.put_secret_value(SecretId=SECRET_ID, SecretString=json.dumps(fresh))
        doc = fresh
    pair = ivs.import_playback_key_pair(name=KEY_NAME, publicKeyMaterial=doc["publicKeyPem"], tags=TAGS)["keyPair"]
    sm.put_secret_value(SecretId=SECRET_ID, SecretString=json.dumps({**doc, "keyPairArn": pair["arn"]}))
    return {"status": "created", "arn": pair["arn"], "fingerprint": pair.get("fingerprint")}


def report(out: dict):
    print(f"playback key pair {KEY_NAME}: {out['status']} {out['arn']} (fingerprint {out['fingerprint']})")
    print(f"private key: Secrets Manager {SECRET_ID} (not shown)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--replace", action="store_true", help="delete the IVS key pair and make a new key")
    args = ap.parse_args()
    report(ensure(boto3.client("ivs", region_name=REGION), boto3.client("secretsmanager", region_name=REGION),
                  replace=args.replace))


if __name__ == "__main__":
    main()
