"""transfer.upload/download against a real S3-compatible server with presigned URLs.

Skipped unless BD_TEST_S3_ENDPOINT is set, e.g. with a local moto server:

    uvx --from 'moto[server]' moto_server -p 5055 &
    BD_TEST_S3_ENDPOINT=http://127.0.0.1:5055 uv run --project workers/gpu --group dev --with boto3 \
        pytest workers/gpu/tests/test_s3_upload.py
"""

from __future__ import annotations

import os
import uuid
from pathlib import Path

import pytest

from workers.gpu import transfer

ENDPOINT = os.environ.get("BD_TEST_S3_ENDPOINT")
pytestmark = pytest.mark.skipif(not ENDPOINT, reason="BD_TEST_S3_ENDPOINT not set")


@pytest.fixture
def s3():  # type: ignore[no-untyped-def]
    boto3 = pytest.importorskip("boto3")
    client = boto3.client(
        "s3", endpoint_url=ENDPOINT, region_name=os.environ.get("BD_TEST_S3_REGION", "us-east-1"),  # "auto" for R2
        aws_access_key_id=os.environ.get("BD_TEST_S3_KEY", "test"),
        aws_secret_access_key=os.environ.get("BD_TEST_S3_SECRET", "test"),
    )
    bucket = os.environ.get("BD_TEST_S3_BUCKET") or f"bd-test-{uuid.uuid4().hex[:8]}"
    if "BD_TEST_S3_BUCKET" not in os.environ:
        client.create_bucket(Bucket=bucket)
    return client, bucket


def test_single_put_and_download(s3, tmp_path: Path) -> None:  # type: ignore[no-untyped-def]
    client, bucket = s3
    src = tmp_path / "manifest.json"
    src.write_bytes(b'{"id": "c1"}\n')
    url = client.generate_presigned_url(
        "put_object", Params={"Bucket": bucket, "Key": "c1/manifest.json", "ContentType": "application/json"},
        ExpiresIn=3600,
    )
    target: transfer.UploadTarget = {"uploadId": "u1", "key": "c1/manifest.json",
                                     "single": {"url": url, "headers": {"Content-Type": "application/json"}}}
    assert transfer.upload(target, src, "application/json") is None

    head = client.head_object(Bucket=bucket, Key="c1/manifest.json")
    assert head["ContentLength"] == src.stat().st_size and head["ContentType"] == "application/json"
    get = client.generate_presigned_url("get_object", Params={"Bucket": bucket, "Key": "c1/manifest.json"})
    dest = tmp_path / "back" / "manifest.json"
    transfer.download(get, dest, src.stat().st_size)
    assert dest.read_bytes() == src.read_bytes()


def test_multipart(s3, tmp_path: Path) -> None:  # type: ignore[no-untyped-def]
    client, bucket = s3
    part_size = 5 * 1024 * 1024  # S3's minimum part size
    src = tmp_path / "room.bin"
    src.write_bytes(os.urandom(2 * part_size + 12345))
    key = "c1/room.bin"
    upload_id = client.create_multipart_upload(Bucket=bucket, Key=key, ContentType="application/octet-stream")["UploadId"]
    parts: list[transfer.PartUrl] = [
        {"partNumber": n, "url": client.generate_presigned_url(
            "upload_part", Params={"Bucket": bucket, "Key": key, "UploadId": upload_id, "PartNumber": n}, ExpiresIn=3600)}
        for n in (1, 2, 3)
    ]
    target: transfer.UploadTarget = {"uploadId": upload_id, "key": key, "partSize": part_size, "parts": parts}
    finished = transfer.upload(target, src, "application/octet-stream")
    assert finished is not None and [p["partNumber"] for p in finished] == [1, 2, 3]

    client.complete_multipart_upload(Bucket=bucket, Key=key, UploadId=upload_id, MultipartUpload={
        "Parts": [{"PartNumber": p["partNumber"], "ETag": p["etag"]} for p in finished]})
    assert client.get_object(Bucket=bucket, Key=key)["Body"].read() == src.read_bytes()
