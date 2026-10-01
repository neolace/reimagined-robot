import hashlib

import pytest
from botocore.exceptions import ClientError
from conftest import BUCKET, s3_event

TEMP_KEY = "jse/idp/bda/temp/BDA_FILE.csv"
TARGET_KEY = "jse/idp/bda/BDA_FILE.csv"


def md5(data: bytes) -> str:
    return hashlib.md5(data).hexdigest()


def put(s3, key: str, body: bytes, **kwargs):
    return s3.put_object(Bucket=BUCKET, Key=key, Body=body, **kwargs)


def exists(s3, key: str) -> bool:
    try:
        s3.head_object(Bucket=BUCKET, Key=key)
        return True
    except ClientError:
        return False


def test_new_file_promoted(s3, app, context):
    put(s3, TEMP_KEY, b"day one")

    result = app.lambda_handler(s3_event(TEMP_KEY), context)

    assert result == {"action": "promoted", "md5": md5(b"day one")}
    target = s3.get_object(Bucket=BUCKET, Key=TARGET_KEY)
    assert target["Body"].read() == b"day one"
    assert target["Metadata"]["md5"] == md5(b"day one")
    assert not exists(s3, TEMP_KEY)


def test_duplicate_discarded(s3, app, context):
    put(s3, TARGET_KEY, b"same", Metadata={"md5": md5(b"same")})
    version_before = s3.head_object(Bucket=BUCKET, Key=TARGET_KEY)["VersionId"]
    put(s3, TEMP_KEY, b"same")

    result = app.lambda_handler(s3_event(TEMP_KEY), context)

    assert result["action"] == "discarded"
    assert s3.head_object(Bucket=BUCKET, Key=TARGET_KEY)["VersionId"] == version_before
    assert not exists(s3, TEMP_KEY)


def test_changed_file_replaces_and_keeps_previous_version(s3, app, context):
    put(s3, TARGET_KEY, b"old", Metadata={"md5": md5(b"old")})
    put(s3, TEMP_KEY, b"new")

    result = app.lambda_handler(s3_event(TEMP_KEY), context)

    assert result == {"action": "promoted", "md5": md5(b"new")}
    target = s3.get_object(Bucket=BUCKET, Key=TARGET_KEY)
    assert target["Body"].read() == b"new"
    assert target["Metadata"]["md5"] == md5(b"new")
    versions = s3.list_object_versions(Bucket=BUCKET, Prefix=TARGET_KEY)["Versions"]
    assert len([v for v in versions if v["Key"] == TARGET_KEY]) == 2
    assert not exists(s3, TEMP_KEY)


def test_target_without_md5_metadata_is_replaced(s3, app, context):
    put(s3, TARGET_KEY, b"same")  # e.g. uploaded by hand, no md5 metadata
    put(s3, TEMP_KEY, b"same")

    assert app.lambda_handler(s3_event(TEMP_KEY), context)["action"] == "promoted"
    assert s3.head_object(Bucket=BUCKET, Key=TARGET_KEY)["Metadata"]["md5"] == md5(b"same")


def test_redelivered_event_is_noop(s3, app, context):
    put(s3, TEMP_KEY, b"once")
    app.lambda_handler(s3_event(TEMP_KEY), context)

    assert app.lambda_handler(s3_event(TEMP_KEY), context) == {"action": "noop"}
    assert exists(s3, TARGET_KEY)


def test_nested_market_data_path(s3, app, context):
    key = "jse/idp/market-data/options/temp/f.csv"
    put(s3, key, b"options")

    app.lambda_handler(s3_event(key), context)

    assert exists(s3, "jse/idp/market-data/options/f.csv")
    assert not exists(s3, key)


def test_large_file_streams(s3, app, context):
    body = b"x" * (20 * 1024 * 1024 + 7)  # spans several 8 MiB chunks
    put(s3, TEMP_KEY, body)

    assert app.lambda_handler(s3_event(TEMP_KEY), context)["md5"] == md5(body)


def test_unexpected_s3_error_raises(s3, app, context, monkeypatch):
    put(s3, TEMP_KEY, b"data")

    def denied(**_kwargs):
        raise ClientError({"Error": {"Code": "AccessDenied", "Message": "denied"}}, "HeadObject")

    monkeypatch.setattr(app.s3, "head_object", denied)
    with pytest.raises(ClientError):
        app.lambda_handler(s3_event(TEMP_KEY), context)
    assert exists(s3, TEMP_KEY)  # untouched, so EventBridge can retry


@pytest.mark.parametrize(
    ("temp_key", "expected"),
    [
        ("jse/idp/bda/temp/a.csv", "jse/idp/bda/a.csv"),
        ("jse/idp/market-data/equities/temp/b.csv", "jse/idp/market-data/equities/b.csv"),
    ],
)
def test_target_key_for(app, temp_key, expected):
    assert app.target_key_for(temp_key) == expected


@pytest.mark.parametrize("bad_key", ["jse/idp/bda/a.csv", "jse/idp/bda/temp/"])
def test_target_key_for_rejects_non_temp_keys(app, bad_key):
    with pytest.raises(ValueError):
        app.target_key_for(bad_key)
