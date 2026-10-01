"""Shadow-Rename: promote changed files out of the JSE temp/ folders and discard duplicates.

Triggered by an S3 "Object Created" EventBridge event for keys matching ``jse/idp/*/temp/*``.
See docs/architecture/component-specs.md section 7.
"""

import hashlib

import boto3
from aws_lambda_powertools import Logger
from botocore.exceptions import ClientError

logger = Logger(service="shadow-rename")
s3 = boto3.client("s3")

CHUNK_SIZE = 8 * 1024 * 1024
MD5_METADATA_KEY = "md5"
TEMP_SEGMENT = "/temp/"
NOT_FOUND = {"404", "NoSuchKey", "NotFound"}


def target_key_for(temp_key: str) -> str:
    """``jse/idp/bda/temp/FILE.csv`` -> ``jse/idp/bda/FILE.csv``."""
    folder, separator, name = temp_key.rpartition(TEMP_SEGMENT)
    if not separator or not name:
        raise ValueError(f"Key is not inside a temp/ folder: {temp_key}")
    return f"{folder}/{name}"


def md5_of_object(bucket: str, key: str) -> str:
    """Stream the object and return its md5 hex digest (the ETag is not an md5 under SSE-KMS or multipart)."""
    body = s3.get_object(Bucket=bucket, Key=key)["Body"]
    digest = hashlib.md5(usedforsecurity=False)
    for chunk in iter(lambda: body.read(CHUNK_SIZE), b""):
        digest.update(chunk)
    return digest.hexdigest()


def file_exists(bucket: str, key: str) -> str | None:
    """Return the stored md5 of the target object, or None if it does not exist."""
    try:
        return s3.head_object(Bucket=bucket, Key=key)["Metadata"].get(MD5_METADATA_KEY)
    except ClientError as err:
        if err.response["Error"]["Code"] in NOT_FOUND:
            return None
        raise


@logger.inject_lambda_context
def lambda_handler(event, _context):
    bucket = event["detail"]["bucket"]["name"]
    temp_key = event["detail"]["object"]["key"]
    target_key = target_key_for(temp_key)
    logger.append_keys(temp_key=temp_key, target_key=target_key)

    try:
        new_md5 = md5_of_object(bucket, temp_key)
    except ClientError as err:
        if err.response["Error"]["Code"] in NOT_FOUND:
            logger.info("Temp object already processed", extra={"action": "noop"})
            return {"action": "noop"}
        raise

    if file_exists(bucket, target_key) == new_md5:
        s3.delete_object(Bucket=bucket, Key=temp_key)
        logger.info("Duplicate discarded", extra={"action": "discarded", "md5": new_md5})
        return {"action": "discarded", "md5": new_md5}

    s3.copy(
        CopySource={"Bucket": bucket, "Key": temp_key},
        Bucket=bucket,
        Key=target_key,
        ExtraArgs={"Metadata": {MD5_METADATA_KEY: new_md5}, "MetadataDirective": "REPLACE"},
    )
    s3.delete_object(Bucket=bucket, Key=temp_key)
    logger.info("File promoted", extra={"action": "promoted", "md5": new_md5})
    return {"action": "promoted", "md5": new_md5}
