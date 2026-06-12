"""前端错误上报通道。

用户端白屏/报错时后台完全不知情——这个端点把浏览器侧错误写进后端日志,
journalctl 一查就能看到线上前端在炸什么。仅登录用户可上报,字段截断防滥用。
"""

import logging
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from api.deps import get_current_user
from models.user import User

router = APIRouter(tags=["客户端日志"])
logger = logging.getLogger("client_error")


class ClientErrorReport(BaseModel):
    message: str = Field(max_length=500)
    stack: str | None = Field(default=None, max_length=2000)
    url: str | None = Field(default=None, max_length=300)


@router.post("/client", status_code=204)
async def report_client_error(
    body: ClientErrorReport,
    current_user: Annotated[User, Depends(get_current_user)],
):
    logger.error(
        "client-error user=%s url=%s msg=%s stack=%s",
        current_user.id,
        body.url or "-",
        body.message,
        (body.stack or "")[:2000],
    )
    return None
