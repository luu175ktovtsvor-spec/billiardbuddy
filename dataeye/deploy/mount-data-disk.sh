#!/usr/bin/env bash
#
# dataeye/deploy/mount-data-disk.sh
#
# ============================================================================
# !! 危险操作 !! 破坏性脚本 !! 会格式化整块磁盘、清空目标盘上的所有数据 !!
#
#   本脚本会对你传入的盘符执行 mkfs.ext4 —— 这个操作**不可逆**,
#   盘上原有数据会被**永久清空**。
#
#   使用前必须:
#     1. 已经在云服务商控制台(如阿里云 ECS)给这台服务器新挂了一块**空白**云盘。
#     2. 用 `lsblk` 亲眼确认好新盘的盘符(如 /dev/vdb),**不是**系统盘(通常 /dev/vda)。
#     3. 确认这块盘上**没有**你还需要的数据 —— 传错盘符 = 数据全没。
#     4. 只能由 owner 本人在确认无误后运行,不要在自动化流水线里无人值守调用。
#
#   用法: sudo ./mount-data-disk.sh /dev/vdX
#   (脚本会再打印一次盘符信息、要求手动输入 yes 二次确认才继续)
# ============================================================================

set -euo pipefail

DISK=${1:?用法: mount-data-disk.sh /dev/vdX (盘符必须显式传入,不给默认值,防止手滑)}
MOUNT_POINT="${MOUNT_POINT:-/data}"

echo "=============================================================="
echo "  即将对下面这块盘执行 mkfs.ext4(会清空盘上所有数据!!):"
echo "    盘符: ${DISK}"
echo "    挂载点: ${MOUNT_POINT}"
echo "=============================================================="

if [[ ! -b "${DISK}" ]]; then
    echo "错误: ${DISK} 不是一个块设备(block device),lsblk 确认一下再传参。" >&2
    exit 1
fi

echo
echo "当前 lsblk 输出,请人工核对 ${DISK} 确实是你要挂的那块新盘、不是系统盘:"
lsblk
echo

read -r -p "确认清空并格式化 ${DISK} 吗?此操作不可逆,输入大写 YES 继续: " CONFIRM
if [[ "${CONFIRM}" != "YES" ]]; then
    echo "已取消,未做任何改动。"
    exit 1
fi

echo "[1/5] mkfs.ext4 ${DISK} ..."
mkfs.ext4 "${DISK}"

echo "[2/5] mkdir -p ${MOUNT_POINT} ..."
mkdir -p "${MOUNT_POINT}"

echo "[3/5] 写入 /etc/fstab(nofail,避免这块盘出问题时拖垮开机)..."
if grep -qF "${DISK} ${MOUNT_POINT} " /etc/fstab 2>/dev/null; then
    echo "  /etc/fstab 里已有该盘的挂载行,跳过追加。"
else
    echo "${DISK} ${MOUNT_POINT} ext4 defaults,nofail 0 2" >> /etc/fstab
fi

echo "[4/5] mount -a ..."
mount -a
df -h "${MOUNT_POINT}"

echo "[5/5] 建目录: ${MOUNT_POINT}/transcripts ${MOUNT_POINT}/pg ..."
mkdir -p "${MOUNT_POINT}/transcripts"
mkdir -p "${MOUNT_POINT}/pg"

echo
echo "完成。接下来(见 runbook.md):"
echo "  - 若要把 PG 表空间也落这块盘: chown postgres:postgres ${MOUNT_POINT}/pg"
echo "    然后 psql: CREATE TABLESPACE dataeye_ts LOCATION '${MOUNT_POINT}/pg';"
