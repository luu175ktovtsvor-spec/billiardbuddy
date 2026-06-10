# 修复：quality 默认值统一

## 改动

**文件**：`server/services/poster_service.py` 第 71 行

```python
# 当前
quality: str = "standard",

# 改为
quality: str = "auto",
```

## 原因

前端和 Schema 默认值都是 "auto"，Service 层应该是 "auto"，保持全链路一致。
