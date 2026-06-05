from datetime import datetime

from pydantic import BaseModel, Field


class SOPRequest(BaseModel):
    role: str = Field(..., description="岗位角色：frontdesk/coach/assistant_manager/manager")
    scenario: str = Field(..., description="服务场景：greeting/checkout/complaint/coaching/promotion/vip_service")
    customer_type: str = Field("all", description="客户类型：new/old/vip/groupbuy/competition/all")


class SOPResponse(BaseModel):
    generation_id: str
    type: str
    sub_type: str
    content: str
    created_at: datetime
