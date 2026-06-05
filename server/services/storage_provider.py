"""Storage Provider 抽象层 — 本地 + OSS"""

import logging
from io import BytesIO
from pathlib import Path
from typing import Protocol

from PIL import Image

from config import settings

logger = logging.getLogger(__name__)


class StorageProvider(Protocol):
    def save(self, subdir: str, filename: str, data: BytesIO) -> str:
        """保存文件，返回访问 URL"""
        ...

    def delete(self, url: str) -> None:
        """删除文件"""
        ...

    def resolve_url(self, url: str) -> str:
        """将相对 URL 转为完整可访问 URL"""
        ...


class LocalStorageProvider:
    """本地文件存储（P0 默认）"""

    def __init__(self):
        self.base_dir = Path(settings.upload_dir)

    def save(self, subdir: str, filename: str, data: BytesIO) -> str:
        dest_dir = self.base_dir / subdir
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest_path = dest_dir / filename
        img = Image.open(data)
        if img.mode in ("RGBA", "P", "LA"):
            img = img.convert("RGB")
        img.save(dest_path, "JPEG", quality=85)
        return f"/uploads/{subdir}/{filename}"

    def delete(self, url: str) -> None:
        rel_path = url.lstrip("/")
        full_path = self.base_dir.parent / rel_path
        if full_path.exists():
            full_path.unlink(missing_ok=True)

    def resolve_url(self, url: str) -> str:
        if url.startswith("/uploads/"):
            return url
        return url


class OSSStorageProvider:
    """阿里云 OSS 存储"""

    def __init__(self):
        try:
            import oss2
        except ImportError:
            raise ImportError("oss2 未安装，请运行: uv add oss2")

        auth = oss2.Auth(settings.oss_access_key_id, settings.oss_access_key_secret)
        self.bucket = oss2.Bucket(auth, settings.oss_endpoint, settings.oss_bucket_name)
        self._base_url = f"https://{settings.oss_bucket_name}.{settings.oss_endpoint.replace('http://', '').replace('https://', '')}"

    def save(self, subdir: str, filename: str, data: BytesIO) -> str:
        key = f"{subdir}/{filename}"
        data.seek(0)
        content = data.read()
        self.bucket.put_object(key, content)
        return f"/uploads/{subdir}/{filename}"

    def delete(self, url: str) -> None:
        key = url.replace("/uploads/", "")
        try:
            self.bucket.delete_object(key)
        except oss2.exceptions.NoSuchKey:
            pass

    def resolve_url(self, url: str) -> str:
        key = url.replace("/uploads/", "")
        return f"{self._base_url}/{key}"


def get_storage_provider() -> StorageProvider:
    if settings.oss_access_key_id and settings.oss_access_key_secret and settings.oss_endpoint and settings.oss_bucket_name:
        return OSSStorageProvider()
    return LocalStorageProvider()


storage_provider = get_storage_provider()