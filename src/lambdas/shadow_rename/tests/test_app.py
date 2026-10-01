import hashlib
from datetime import UTC, datetime

import pytest
from botocore.exceptions import ClientError
from conftest import BUCKET, s3_event

TEMP_KEY = "jse/idp/bda/temp/BDA_FILE.csv"
FOLDER = "jse/idp/bda/"
MONDAY = "jse/idp/bda/BDA_FILE_20260928T033000.csv"
TUESDAY = "jse/idp/bda/BDA_FILE_20260929T033000.csv"


def md5(data: bytes) -> str:
    return hashlib.md5(data).hexdigest()


def put(s3, key: str, body: bytes, **kwargs):
    return s3.put_object(Bucket=BUCKET, Key=key, Body=body, **kwargs)


def put_copy(s3, key: str, body: bytes):
    """A copy stored by an earlier run: content plus md5 metadata."""
    return put(s3, key, body, Metadata={"md5": md5(body)})


def exists(s3, key: str) -> bool:
    try:
        s3.head_object(Bucket=BUCKET, Key=key)
        return True
    except ClientError:
        return False


def files_in(s3, folder: str = FOLDER) -> dict[str, bytes]:
    """Files directly inside ``folder`` (not in temp/), with their content."""
    listing = s3.list_objects_v2(Bucket=BUCKET, Prefix=folder, Delimiter="/")
    return {o["Key"]: s3.get_object(Bucket=BUCKET, Key=o["Key"])["Body"].read() for o in listing.get("Contents", [])}


def expected_target(s3, app, temp_key: str = TEMP_KEY) -> str:
    """The date-stamped key Shadow-Rename uses for the object now in ``temp_key``."""
    return app.target_key_for(temp_key, s3.head_object(Bucket=BUCKET, Key=temp_key)["LastModified"])


def test_new_file_promoted_with_timestamp(s3, app, context):
    put(s3, TEMP_KEY, b"day one")
    target = expected_target(s3, app)

    result = app.lambda_handler(s3_event(TEMP_KEY), context)

    assert result == {"action": "promoted", "md5": md5(b"day one"), "target_key": target}
    assert files_in(s3) == {target: b"day one"}
    assert s3.head_object(Bucket=BUCKET, Key=target)["Metadata"]["md5"] == md5(b"day one")
    assert not exists(s3, TEMP_KEY)


def test_duplicate_of_latest_copy_discarded(s3, app, context):
    put_copy(s3, TUESDAY, b"same")
    put(s3, TEMP_KEY, b"same")

    result = app.lambda_handler(s3_event(TEMP_KEY), context)

    assert result == {"action": "discarded", "md5": md5(b"same"), "duplicate_of": TUESDAY}
    assert files_in(s3) == {TUESDAY: b"same"}
    assert not exists(s3, TEMP_KEY)


def test_duplicate_of_older_copy_discarded(s3, app, context):
    put_copy(s3, MONDAY, b"monday")
    put_copy(s3, TUESDAY, b"tuesday")
    put(s3, TEMP_KEY, b"monday")

    result = app.lambda_handler(s3_event(TEMP_KEY), context)

    assert result == {"action": "discarded", "md5": md5(b"monday"), "duplicate_of": MONDAY}
    assert files_in(s3) == {MONDAY: b"monday", TUESDAY: b"tuesday"}


def test_changed_file_adds_a_copy_and_keeps_the_others(s3, app, context):
    tuesday = put_copy(s3, TUESDAY, b"old")
    put(s3, TEMP_KEY, b"new")
    target = expected_target(s3, app)

    result = app.lambda_handler(s3_event(TEMP_KEY), context)

    assert result == {"action": "promoted", "md5": md5(b"new"), "target_key": target}
    assert files_in(s3) == {TUESDAY: b"old", target: b"new"}
    assert s3.head_object(Bucket=BUCKET, Key=TUESDAY)["VersionId"] == tuesday["VersionId"]  # not overwritten


def test_file_without_md5_metadata_never_matches(s3, app, context):
    put(s3, "jse/idp/bda/BDA_FILE.csv", b"same")  # e.g. uploaded by hand, no md5 metadata
    put(s3, TEMP_KEY, b"same")

    assert app.lambda_handler(s3_event(TEMP_KEY), context)["action"] == "promoted"
    assert len(files_in(s3)) == 2


def test_only_the_parent_folder_counts(s3, app, context):
    put_copy(s3, "jse/idp/market-data/equities/EQUITIES_FILE_20260929T033000.csv", b"same")
    put(s3, TEMP_KEY, b"same")

    assert app.lambda_handler(s3_event(TEMP_KEY), context)["action"] == "promoted"


def test_redelivered_event_is_noop(s3, app, context):
    put(s3, TEMP_KEY, b"once")
    app.lambda_handler(s3_event(TEMP_KEY), context)

    assert app.lambda_handler(s3_event(TEMP_KEY), context) == {"action": "noop"}
    assert len(files_in(s3)) == 1


def test_nested_market_data_path(s3, app, context):
    key = "jse/idp/market-data/options/temp/f.csv"
    put(s3, key, b"options")
    target = expected_target(s3, app, key)

    app.lambda_handler(s3_event(key), context)

    assert target.startswith("jse/idp/market-data/options/f_")
    assert files_in(s3, "jse/idp/market-data/options/") == {target: b"options"}
    assert not exists(s3, key)


def test_large_file_streams(s3, app, context):
    body = b"x" * (20 * 1024 * 1024 + 7)  # spans several 8 MiB chunks
    put(s3, TEMP_KEY, body)

    assert app.lambda_handler(s3_event(TEMP_KEY), context)["md5"] == md5(body)


def test_unexpected_s3_error_raises(s3, app, context, monkeypatch):
    put_copy(s3, TUESDAY, b"old")
    put(s3, TEMP_KEY, b"data")

    def denied(**_kwargs):
        raise ClientError({"Error": {"Code": "AccessDenied", "Message": "denied"}}, "HeadObject")

    monkeypatch.setattr(app.s3, "head_object", denied)
    with pytest.raises(ClientError):
        app.lambda_handler(s3_event(TEMP_KEY), context)
    assert exists(s3, TEMP_KEY)  # untouched, so EventBridge can retry


def test_never_overwrites_an_existing_file(s3, app, context):
    put(s3, TEMP_KEY, b"new")
    target = expected_target(s3, app)
    put_copy(s3, target, b"something else")

    with pytest.raises(FileExistsError):
        app.lambda_handler(s3_event(TEMP_KEY), context)
    assert s3.get_object(Bucket=BUCKET, Key=target)["Body"].read() == b"something else"
    assert exists(s3, TEMP_KEY)


@pytest.mark.parametrize(
    ("temp_key", "retrieved_at", "expected"),
    [
        (
            "jse/idp/bda/temp/BDA_FILE.csv",
            datetime(2026, 10, 1, 1, 30, 12, tzinfo=UTC),
            "jse/idp/bda/BDA_FILE_20261001T033012.csv",
        ),
        (  # 22:30 UTC on 30 Sep = 00:30 SAST on 1 Oct
            "jse/idp/market-data/equities/temp/b.csv",
            datetime(2026, 9, 30, 22, 30, 0, tzinfo=UTC),
            "jse/idp/market-data/equities/b_20261001T003000.csv",
        ),
        (
            "jse/idp/bda/temp/NO_EXTENSION",
            datetime(2026, 10, 1, 1, 30, 12, tzinfo=UTC),
            "jse/idp/bda/NO_EXTENSION_20261001T033012",
        ),
    ],
)
def test_target_key_for(app, temp_key, retrieved_at, expected):
    assert app.target_key_for(temp_key, retrieved_at) == expected


@pytest.mark.parametrize("bad_key", ["jse/idp/bda/a.csv", "jse/idp/bda/temp/"])
def test_target_key_for_rejects_non_temp_keys(app, bad_key):
    with pytest.raises(ValueError):
        app.target_key_for(bad_key, datetime(2026, 10, 1, tzinfo=UTC))
