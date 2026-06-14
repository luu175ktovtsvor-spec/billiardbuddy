from pydantic import BaseModel


class ReportCreateRequest(BaseModel):
    data: dict
    note: str = ""


class ReportExtractRequest(BaseModel):
    text: str


class ReportExtractResponse(BaseModel):
    data: dict


class ReportResponse(BaseModel):
    report_id: str
    narrative: str
    deltas: dict


class ReportListItem(BaseModel):
    id: str
    report_type: str | None
    title: str | None
    created_at: str
