from datetime import datetime

from pydantic import BaseModel, Field


class CustomerType(str):
    """助教约客的客户类型"""
    pass


class OutreachStyle(str):
    """约客话术风格"""
    pass


class OutreachRequest(BaseModel):
    customer_name: str = Field(..., description="客户称呼", min_length=1, max_length=50)
    customer_type: str = Field(..., description="客户类型：new/old/vip/groupbuy/competition/assistant")
    relationship: str = Field("一般", description="与客户的关系亲疏：陌生/一般/熟悉/老朋友")
    style: str = Field("friendly", description="话术风格：friendly/professional/lively/warm")
    extra_note: str = Field("", description="补充说明", max_length=200)


class OutreachScriptItem(BaseModel):
    scenario: str = Field(..., description="适用场景")
    script: str = Field(..., description="话术内容")
    tips: str = Field("", description="使用提示")


class OutreachResponse(BaseModel):
    generation_id: str
    type: str
    sub_type: str
    content: str
    created_at: datetime
