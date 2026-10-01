"""Shadow-Rename: store each new JSE file as a date-stamped copy in its parent folder and discard duplicates.

Triggered by an S3 "Object Created" EventBridge event for keys matching ``jse/idp/*/temp/*``. It never overwrites a
file. If a file with the same md5 already exists in the parent folder, the temp file is deleted. Otherwise the temp
file is copied to the parent folder as ``<name>_<YYYYMMDDTHHMMSS><extension>`` (retrieval time, SAST), then deleted.
See docs/architecture/component-specs.md section 7.
"""

import hashlib
import posixpath
from datetime import datetime, timedelta, timezone

import boto3
from aws_lambda_powertools import Logger
from botocore.exceptions import ClientError

logger = Logger(service="shadow-rename")
s3 = boto3.client("s3")

CHUNK_SIZE = 8 * 1024 * 1024
MD5_METADATA_KEY = "md5"
TEMP_SEGMENT = "/temp/"
NOT_FOUND = {"404", "NoSuchKey", "NotFound"}
# Africa/Johannesburg has no daylight saving time (ADR-006), so a fixed offset is exact and needs no tz database.
SAST = timezone(timedelta(hours=2), "SAST")
STAMP_FORMAT = "%Y%m%dT%H%M%S"


def split_temp_key(temp_key: str) -> tuple[str, str]:
    """``jse/idp/bda/temp/FILE.csv`` -> ``("jse/idp/bda/", "FILE.csv")``."""
    folder, separator, name = temp_key.rpartition(TEMP_SEGMENT)
    if not separator or not name:
        raise ValueError(f"Key is not inside a temp/ folder: {temp_key}")
    return f"{folder}/", name


def target_key_for(temp_key: str, retrieved_at: datetime) -> str:
    """``jse/idp/bda/temp/FILE.csv`` retrieved 2026-10-01 03:30:12 SAST -> ``jse/idp/bda/FILE_20261001T033012.csv``."""
    folder, name = split_temp_key(temp_key)
    stem, extension = posixpath.splitext(name)
    return f"{folder}{stem}_{retrieved_at.astimezone(SAST).strftime(STAMP_FORMAT)}{extension}"


def md5_of_object(bucket: str, key: str) -> tuple[str, datetime]:
    """Stream the object and return its md5 hex digest and LastModified.

    The ETag is not an md5 under SSE-KMS or multipart upload, so the content is hashed here.
    """
    response = s3.get_object(Bucket=bucket, Key=key)
    body = response["Body"]
    digest = hashlib.md5(usedforsecurity=False)
    for chunk in iter(lambda: body.read(CHUNK_SIZE), b""):
        digest.update(chunk)
    return digest.hexdigest(), response["LastModified"]


def stored_md5(bucket: str, key: str) -> str | None:
    """Return the md5 metadata of an object, or None if the object or its metadata does not exist."""
    try:
        return s3.head_object(Bucket=bucket, Key=key)["Metadata"].get(MD5_METADATA_KEY)
    except ClientError as err:
        if err.response["Error"]["Code"] in NOT_FOUND:
            return None
        raise


def file_exists(bucket: str, folder: str, md5: str) -> str | None:
    """Return the key of a file directly inside ``folder`` whose md5 matches, or None.

    Newest files are checked first, because a repeated download usually matches the latest copy.
    Files without md5 metadata, for example ones uploaded by hand, never match.
    """
    files = []
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=folder, Delimiter="/"):
        files.extend(page.get("Contents", []))
    for item in sorted(files, key=lambda f: f["LastModified"], reverse=True):
        if stored_md5(bucket, item["Key"]) == md5:
            return item["Key"]
    return None


@logger.inject_lambda_context
def lambda_handler(event, _context):
    bucket = event["detail"]["bucket"]["name"]
    temp_key = event["detail"]["object"]["key"]
    folder, _ = split_temp_key(temp_key)
    logger.append_keys(temp_key=temp_key)

    try:
        new_md5, retrieved_at = md5_of_object(bucket, temp_key)
    except ClientError as err:
        if err.response["Error"]["Code"] in NOT_FOUND:
            logger.info("Temp object already processed", extra={"action": "noop"})
            return {"action": "noop"}
        raise

    duplicate_of = file_exists(bucket, folder, new_md5)
    if duplicate_of:
        s3.delete_object(Bucket=bucket, Key=temp_key)
        logger.info("Duplicate discarded", extra={"action": "discarded", "md5": new_md5, "duplicate_of": duplicate_of})
        return {"action": "discarded", "md5": new_md5, "duplicate_of": duplicate_of}

    target_key = target_key_for(temp_key, retrieved_at)
    try:
        s3.head_object(Bucket=bucket, Key=target_key)
    except ClientError as err:
        if err.response["Error"]["Code"] not in NOT_FOUND:
            raise
    else:
        raise FileExistsError(f"{target_key} already exists with different content; Shadow-Rename never overwrites")

    s3.copy(
        CopySource={"Bucket": bucket, "Key": temp_key},
        Bucket=bucket,
        Key=target_key,
        ExtraArgs={"Metadata": {MD5_METADATA_KEY: new_md5}, "MetadataDirective": "REPLACE"},
    )
    s3.delete_object(Bucket=bucket, Key=temp_key)
    logger.info("File promoted", extra={"action": "promoted", "md5": new_md5, "target_key": target_key})
    return {"action": "promoted", "md5": new_md5, "target_key": target_key}
