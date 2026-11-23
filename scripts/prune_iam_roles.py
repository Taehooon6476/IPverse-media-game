#!/usr/bin/env python3
"""List (and optionally delete) IAM roles that were created over a year ago and not used in the last year.

  python3 scripts/prune_iam_roles.py            # dry run: writes build/iam-prune-plan.json, deletes nothing
  python3 scripts/prune_iam_roles.py --delete   # deletes exactly the roles in build/iam-prune-plan.json

Never touched: service-linked (/aws-service-role/) and SSO (/aws-reserved/) roles; roles whose trust policy
allows a Federated principal (SAML/OIDC login, e.g. Isengard) or any AWS principal from another account;
names containing Isengard, OrganizationAccountAccess, Epoxy, Admin; CDK bootstrap roles (cdk-hnb659fds-*); this project's Ipverse* roles.
Deletion detaches managed policies, deletes inline policies, removes the role from instance profiles
(deleting a profile that becomes empty) and then deletes the role. Every step is logged to
build/iam-prune-log.jsonl.
"""
from __future__ import annotations

import json
import pathlib
import sys
import urllib.parse
from datetime import datetime, timedelta, timezone

import boto3

ROOT = pathlib.Path(__file__).resolve().parent.parent
PLAN = ROOT / "build" / "iam-prune-plan.json"
LOG = ROOT / "build" / "iam-prune-log.jsonl"
NAME_GUARDS = ("isengard", "organizationaccountaccess", "epoxy", "admin")
iam = boto3.client("iam")
ACCOUNT = boto3.client("sts").get_caller_identity()["Account"]


def principals(doc) -> list:
    if isinstance(doc, str):
        doc = json.loads(urllib.parse.unquote(doc))
    out = []
    for st in doc.get("Statement", []):
        p = st.get("Principal", {})
        if p == "*":
            out.append(("AWS", "*"))
            continue
        for kind, vals in p.items():
            for v in vals if isinstance(vals, list) else [vals]:
                out.append((kind, v))
    return out


def protected_reason(role) -> str | None:
    name, path = role["RoleName"], role.get("Path", "/")
    if path.startswith("/aws-service-role/") or path.startswith("/aws-reserved/"):
        return "service-linked/SSO path"
    if name.startswith("cdk-hnb659fds-"):
        return "cdk bootstrap"
    if name.lower().startswith("ipverse"):
        return "this project"
    if any(g in name.lower() for g in NAME_GUARDS):
        return "name guard"
    for kind, v in principals(role["AssumeRolePolicyDocument"]):
        if kind == "Federated":
            return "federated login trust"
        if kind == "AWS" and (v == "*" or (ACCOUNT not in str(v))):
            return "cross-account trust"
    return None


def plan() -> list:
    cutoff = datetime.now(timezone.utc) - timedelta(days=365)
    rows, kept = [], {}
    for page in iam.get_paginator("list_roles").paginate():
        for r in page["Roles"]:
            if r["CreateDate"] > cutoff:
                continue
            why = protected_reason(r)
            if why:
                kept[why] = kept.get(why, 0) + 1
                continue
            full = iam.get_role(RoleName=r["RoleName"])["Role"]
            last = (full.get("RoleLastUsed") or {}).get("LastUsedDate")
            if last and last > cutoff:
                continue
            rows.append({"RoleName": r["RoleName"], "Path": r.get("Path", "/"),
                         "CreateDate": r["CreateDate"].isoformat(),
                         "LastUsed": last.isoformat() if last else None})
    PLAN.parent.mkdir(exist_ok=True)
    PLAN.write_text(json.dumps(rows, indent=1))
    print(f"candidates: {len(rows)} (plan written to {PLAN})")
    print("skipped by guard:", json.dumps(kept))
    return rows


def log(**kw):
    with LOG.open("a") as f:
        f.write(json.dumps(kw, default=str) + "\n")


def backup_role(name: str) -> None:
    """Write everything needed to recreate the role (trust, inline docs, managed ARNs, tags) before deleting."""
    role = iam.get_role(RoleName=name)["Role"]
    inline = {pn: iam.get_role_policy(RoleName=name, PolicyName=pn)["PolicyDocument"]
              for page in iam.get_paginator("list_role_policies").paginate(RoleName=name) for pn in page["PolicyNames"]}
    attached = [p["PolicyArn"] for page in iam.get_paginator("list_attached_role_policies").paginate(RoleName=name)
                for p in page["AttachedPolicies"]]
    with (ROOT / "build" / "iam-prune-backup.jsonl").open("a") as f:
        f.write(json.dumps({"RoleName": name, "Path": role.get("Path"), "Description": role.get("Description"),
                            "AssumeRolePolicyDocument": role["AssumeRolePolicyDocument"], "MaxSessionDuration":
                            role.get("MaxSessionDuration"), "Tags": role.get("Tags", []), "InlinePolicies": inline,
                            "AttachedPolicyArns": attached}, default=str) + "\n")


def delete_role(name: str) -> None:
    backup_role(name)
    for page in iam.get_paginator("list_attached_role_policies").paginate(RoleName=name):
        for p in page["AttachedPolicies"]:
            iam.detach_role_policy(RoleName=name, PolicyArn=p["PolicyArn"])
            log(role=name, step="detach", policy=p["PolicyArn"])
    for page in iam.get_paginator("list_role_policies").paginate(RoleName=name):
        for pn in page["PolicyNames"]:
            iam.delete_role_policy(RoleName=name, PolicyName=pn)
            log(role=name, step="delete_inline", policy=pn)
    for page in iam.get_paginator("list_instance_profiles_for_role").paginate(RoleName=name):
        for ip in page["InstanceProfiles"]:
            iam.remove_role_from_instance_profile(InstanceProfileName=ip["InstanceProfileName"], RoleName=name)
            log(role=name, step="remove_from_profile", profile=ip["InstanceProfileName"])
            if len(ip["Roles"]) <= 1:
                iam.delete_instance_profile(InstanceProfileName=ip["InstanceProfileName"])
                log(role=name, step="delete_profile", profile=ip["InstanceProfileName"])
    iam.delete_role(RoleName=name)
    log(role=name, step="delete_role")


def main():
    if "--delete" not in sys.argv:
        plan()
        return
    rows = json.loads(PLAN.read_text())
    ok = failed = 0
    for row in rows:
        try:
            delete_role(row["RoleName"])
            ok += 1
        except Exception as e:  # keep going; record the failure
            failed += 1
            log(role=row["RoleName"], step="error", error=str(e))
    print(f"deleted {ok}, failed {failed} (log: {LOG})")


if __name__ == "__main__":
    main()
