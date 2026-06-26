# -*- coding: utf-8 -*-
"""M12 #2：损坏/被占用的 .xlsx 不得让 read_sheet / excel_edit 抛裸异常返 500。

load_workbook 对损坏字节会抛（BadZipFile 等）；端点须包 try、返大白话的 400，
而不是把异常冒泡成 500。
"""
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from api.v1.canvas import read_sheet, excel_edit, SheetRequest, ExcelCellEdit

_FAKE_USER = SimpleNamespace(id="u")
_FAKE_STORE = SimpleNamespace(id="s")


def _corrupt_xlsx(tmp_path):
    p = tmp_path / "坏账本.xlsx"
    p.write_bytes(b"this is not a real xlsx, just garbage bytes")
    return p


async def test_read_sheet_corrupt_returns_friendly_400(tmp_path, monkeypatch):
    monkeypatch.setenv("DESKTOP_LOCAL", "1")
    p = _corrupt_xlsx(tmp_path)
    body = SheetRequest(path=str(p), selected_files=[str(p)], full_disk_access=True)
    with pytest.raises(HTTPException) as ei:
        await read_sheet(body, _FAKE_USER, _FAKE_STORE)
    assert ei.value.status_code == 400
    assert "打不开" in ei.value.detail  # 大白话，不是堆栈


async def test_excel_edit_corrupt_returns_friendly_400(tmp_path, monkeypatch):
    monkeypatch.setenv("DESKTOP_LOCAL", "1")
    p = _corrupt_xlsx(tmp_path)
    body = ExcelCellEdit(path=str(p), cell="A1", value="x",
                         selected_files=[str(p)], full_disk_access=True)
    with pytest.raises(HTTPException) as ei:
        await excel_edit(body, _FAKE_USER, _FAKE_STORE)
    assert ei.value.status_code == 400
    assert "打不开" in ei.value.detail
