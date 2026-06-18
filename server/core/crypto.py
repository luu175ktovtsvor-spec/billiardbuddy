"""门店自带 API Key（BYOK）的对称加密。

Key 属于敏感凭据，绝不明文落库：写库前 encrypt()，用时 decrypt()，DB 里只存密文。
主密钥 BYOK_ENCRYPT_KEY 存服务器 env（Fernet 44 字符 base64），不进代码/仓库。
即使 DB 被 dump，没有主密钥也解不开门店的 Key。
"""
from cryptography.fernet import Fernet, InvalidToken

from config import settings


class CryptoNotConfigured(RuntimeError):
    """未配置 BYOK_ENCRYPT_KEY 主密钥。"""


def _fernet() -> Fernet:
    key = settings.byok_encrypt_key
    if not key:
        raise CryptoNotConfigured(
            "未配置 BYOK_ENCRYPT_KEY，无法加解密门店自带 Key。"
            "生成一个：python -c \"from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())\""
        )
    return Fernet(key.encode() if isinstance(key, str) else key)


def encrypt(plaintext: str) -> str:
    """明文 → 密文（存库）。"""
    return _fernet().encrypt(plaintext.encode()).decode()


def decrypt(ciphertext: str) -> str:
    """密文 → 明文（用时）。密文损坏/主密钥不对时抛 InvalidToken。"""
    return _fernet().decrypt(ciphertext.encode()).decode()


def try_decrypt(ciphertext: str | None) -> str | None:
    """容错解密：失败（未配置/损坏）返回 None，供调用方回退平台默认 Key。"""
    if not ciphertext:
        return None
    try:
        return decrypt(ciphertext)
    except (CryptoNotConfigured, InvalidToken, Exception):
        return None


def generate_key() -> str:
    """生成一个新的 Fernet 主密钥（部署时用一次，存进 env）。"""
    return Fernet.generate_key().decode()


def mask(secret: str | None) -> str:
    """脱敏展示：sk-abcd…wxyz。用于前端回显，绝不返回明文全文。"""
    if not secret:
        return ""
    s = secret.strip()
    if len(s) <= 10:
        return s[:2] + "***"
    return f"{s[:4]}…{s[-4:]}"
