import importlib
import sys
from dataclasses import dataclass

import boto3
import pytest
from moto import mock_aws

BUCKET = "gm-prime-equities-file-downloads-test"
REGION = "af-south-1"


@dataclass
class LambdaContext:
    function_name: str = "gm-prime-equities-shadow-rename"
    memory_limit_in_mb: int = 512
    invoked_function_arn: str = "arn:aws:lambda:af-south-1:123456789012:function:gm-prime-equities-shadow-rename"
    aws_request_id: str = "test-request-id"


@pytest.fixture(autouse=True)
def aws_env(monkeypatch):
    monkeypatch.setenv("AWS_DEFAULT_REGION", REGION)
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")
    monkeypatch.setenv("POWERTOOLS_SERVICE_NAME", "shadow-rename")


@pytest.fixture
def s3():
    with mock_aws():
        client = boto3.client("s3", region_name=REGION)
        client.create_bucket(Bucket=BUCKET, CreateBucketConfiguration={"LocationConstraint": REGION})
        client.put_bucket_versioning(Bucket=BUCKET, VersioningConfiguration={"Status": "Enabled"})
        yield client


@pytest.fixture
def app(s3):
    """Import the handler after mock_aws is active so its module-level boto3 client is mocked."""
    sys.modules.pop("app", None)
    return importlib.import_module("app")


@pytest.fixture
def context():
    return LambdaContext()


def s3_event(key: str) -> dict:
    return {
        "version": "0",
        "source": "aws.s3",
        "detail-type": "Object Created",
        "detail": {"bucket": {"name": BUCKET}, "object": {"key": key}},
    }
