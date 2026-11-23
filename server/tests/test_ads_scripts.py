"""scripts/setup_ivs_playback_key.py and scripts/setup_ivs_ads.py against fakes (no AWS)."""
import importlib.util
import json
import pathlib

import pytest
from botocore.exceptions import ClientError
from cryptography.hazmat.primitives import serialization

ROOT = pathlib.Path(__file__).resolve().parents[2]


def _load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


keyscript = _load("setup_ivs_playback_key")
adsscript = _load("setup_ivs_ads")


def _missing(op):
    return ClientError({"Error": {"Code": "ResourceNotFoundException", "Message": "nope"}}, op)


class FakeKeys:
    def __init__(self):
        self.pairs, self.imported, self.deleted = {}, [], []

    def list_playback_key_pairs(self, **kw):
        return {"keyPairs": [{"arn": a, "name": p["name"]} for a, p in self.pairs.items()]}

    def import_playback_key_pair(self, name, publicKeyMaterial, tags):
        arn = f"arn:aws:ivs:us-east-1:1:playback-key/k{len(self.imported) + 1}"
        self.pairs[arn] = {"name": name, "pem": publicKeyMaterial}
        self.imported.append(arn)
        return {"keyPair": {"arn": arn, "name": name, "fingerprint": "fp:" + arn[-2:]}}

    def get_playback_key_pair(self, arn):
        if arn not in self.pairs:
            raise _missing("GetPlaybackKeyPair")
        return {"keyPair": {"arn": arn, "name": self.pairs[arn]["name"], "fingerprint": "fp:" + arn[-2:]}}

    def delete_playback_key_pair(self, arn):
        self.pairs.pop(arn)
        self.deleted.append(arn)


class FakeSM:
    def __init__(self):
        self.value, self.writes = None, []

    def get_secret_value(self, SecretId):
        if self.value is None:
            raise _missing("GetSecretValue")
        return {"SecretString": self.value}

    def create_secret(self, Name, SecretString, **kw):
        assert self.value is None
        self.value = SecretString
        self.writes.append("create")

    def put_secret_value(self, SecretId, SecretString):
        self.value = SecretString
        self.writes.append("put")


def test_the_key_script_imports_the_public_half_keeps_the_private_one_and_is_idempotent(capsys):
    ivs, sm = FakeKeys(), FakeSM()
    first = keyscript.ensure(ivs, sm)
    doc = json.loads(sm.value)
    assert first["status"] == "created" and doc["keyPairArn"] == ivs.imported[0] == first["arn"]
    priv = serialization.load_pem_private_key(doc["privateKeyPem"].encode(), None)
    assert priv.private_numbers().private_value == int(doc["d"], 16)  # what server/ads.py signs with
    imported = serialization.load_pem_public_key(ivs.pairs[ivs.imported[0]]["pem"].encode())
    assert imported.public_numbers() == priv.public_key().public_numbers()
    again = keyscript.ensure(ivs, sm)
    assert again["status"] == "exists" and len(ivs.imported) == 1 and sm.writes == ["create", "put"]
    keyscript.report(first)
    out = capsys.readouterr().out
    assert doc["d"] not in out and "PRIVATE" not in out and first["arn"] in out


def test_a_secret_whose_key_pair_is_gone_is_imported_again():
    ivs, sm = FakeKeys(), FakeSM()
    keyscript.ensure(ivs, sm)
    d = json.loads(sm.value)["d"]
    ivs.pairs.clear()
    out = keyscript.ensure(ivs, sm)
    assert out["status"] == "created" and json.loads(sm.value)["d"] == d and len(ivs.imported) == 2


def test_a_key_pair_without_its_private_key_needs_replace():
    ivs, sm = FakeKeys(), FakeSM()
    ivs.pairs["arn:old"] = {"name": keyscript.KEY_NAME, "pem": "x"}
    with pytest.raises(SystemExit):
        keyscript.ensure(ivs, sm)
    out = keyscript.ensure(ivs, sm, replace=True)
    assert ivs.deleted == ["arn:old"] and out["status"] == "created"


class FakeMT:
    def __init__(self):
        self.configs, self.logs = [], []

    def put_playback_configuration(self, **kw):
        self.configs.append(kw)
        return {**kw, "PlaybackConfigurationArn": "arn:mt:ipverse-ivs"}

    def configure_logs_for_playback_configuration(self, PlaybackConfigurationName, PercentEnabled):
        self.logs.append((PlaybackConfigurationName, PercentEnabled))


class FakeIvsAds:
    def __init__(self, authorized=True, ad=None):
        self.chan = {"arn": "arn:ch", "name": "ipverse-live-player", "containerFormat": "TS", "authorized": authorized,
                     "playbackUrl": "https://abc.us-east-1.playback.live-video.net/api/video/v1/x.m3u8",
                     **({"adConfigurationArn": ad} if ad else {})}
        self.updates = []

    def list_channels(self, filterByName):
        return {"channels": [{"arn": "arn:ch", "name": "ipverse-live-player"}]}

    def get_channel(self, arn):
        return {"channel": dict(self.chan)}

    def list_ad_configurations(self):
        return {"adConfigurations": []}

    def create_ad_configuration(self, **kw):
        return {"adConfiguration": {"arn": "arn:adcfg"}}

    def update_channel(self, arn, adConfigurationArn):
        self.updates.append(adConfigurationArn)
        self.chan["adConfigurationArn"] = adConfigurationArn


def test_the_ads_url_asks_for_the_viewer_persona_file():
    assert adsscript.ads_url("d27.cloudfront.net") == "https://d27.cloudfront.net/vast/ivs/p-[player_params.persona].xml"
    ivs, mt = FakeIvsAds(), FakeMT()
    adsscript.setup(ivs, mt, "d27.cloudfront.net", log_percent=100)
    cfg = mt.configs[0]
    assert cfg["AdDecisionServerUrl"] == adsscript.ads_url("d27.cloudfront.net")
    assert cfg["VideoContentSourceUrl"] == "https://abc.us-east-1.playback.live-video.net/"
    assert cfg["InsertionMode"] == "PLAYER_SELECT" and ivs.updates == ["arn:adcfg"]
    assert mt.logs == [("ipverse-ivs", 100)]


def test_the_ads_script_warns_on_a_public_channel(capsys):
    adsscript.setup(FakeIvsAds(authorized=False, ad="arn:adcfg"), FakeMT(), "d27.cloudfront.net")
    assert "authorized=false" in capsys.readouterr().out
