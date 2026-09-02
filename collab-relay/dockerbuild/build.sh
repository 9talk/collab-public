#!/usr/bin/env bash
# ============================================================
# collab-relay 镜像构建脚本
# 构建中继服务镜像并推送到 NSTL 仓库
# 用法:
#   bash dockerbuild/build.sh                          # 构建（默认远端 Docker）
#   bash dockerbuild/build.sh -H tcp://<host>:<port>   # 指定远端 Docker
#   bash dockerbuild/build.sh --push                   # 构建并推送 NSTL 仓库
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

REGISTRY="docker-hosted.nstl-dev.com/collab/replay"
TAG="latest"
BUILD_TIMEOUT=900

# --------------- 远端 Docker 配置 ---------------
# 默认远端 Docker 地址，可通过 -H 参数覆盖
REMOTE_DOCKER_HOST="tcp://168.160.45.214:2375"

# --------------- 解析参数 ---------------
PUSH_IMAGES=false
while [[ $# -gt 0 ]]; do
    case "$1" in
        -H|--docker-host)
            REMOTE_DOCKER_HOST="$2"
            shift 2
            ;;
        --push|-p)
            PUSH_IMAGES=true
            shift
            ;;
        *)
            echo "错误: 未知参数 $1"
            echo "用法: $0 [-H tcp://<host>:<port>] [--push]"
            exit 1
            ;;
    esac
done

# --------------- 前置检查 ---------------
echo ""
echo "============================================"
echo "  collab-relay Docker 镜像构建"
echo "  镜像:     $REGISTRY:$TAG"
echo "  项目目录: $PROJECT_DIR"
echo "============================================"

# 检测远端 Docker 连通性
echo ""
echo "[检查] 远端 Docker 连通性 ($REMOTE_DOCKER_HOST)..."
if docker -H "$REMOTE_DOCKER_HOST" info &>/dev/null; then
    echo "[OK] 远端 Docker 已连通: $REMOTE_DOCKER_HOST"
    export DOCKER_HOST="$REMOTE_DOCKER_HOST"
else
    echo "[INFO] 远端 Docker 不可达，回退本地构建"
    echo ""
    echo "[检查] 本地 Docker daemon..."
    if ! docker info &>/dev/null; then
        echo "[错误] Docker daemon 未运行或不可用"
        exit 1
    fi
    echo "[OK] 本地 Docker daemon 运行正常"
fi

# --------------- 基础镜像探测 ---------------
# 优先使用 NSTL 代理镜像，避免公网拉取问题
BASE_IMAGE=""
for candidate in \
    "docker-hosted.nstl-dev.com/oven/bun:1-alpine" \
    "docker-hosted.nstl-dev.com/library/bun:1-alpine" \
    "oven/bun:1-alpine"; do
    if docker pull "$candidate" &>/dev/null; then
        BASE_IMAGE="$candidate"
        echo "[OK] 基础镜像: $BASE_IMAGE"
        break
    fi
    echo "[INFO] 基础镜像不可用: $candidate"
done
if [ -z "$BASE_IMAGE" ]; then
    echo "[错误] 所有候选基础镜像均不可用"
    exit 1
fi

# --------------- 构建 ---------------
echo ""
echo "[构建] ${REGISTRY}:${TAG} (基于 $BASE_IMAGE)..."
cd "$PROJECT_DIR"
timeout "$BUILD_TIMEOUT" docker build \
    -f "$SCRIPT_DIR/Dockerfile" \
    --build-arg BASE_IMAGE="$BASE_IMAGE" \
    -t "${REGISTRY}:${TAG}" \
    --progress=plain \
    "$PROJECT_DIR" 2>&1
echo "[完成] ${REGISTRY}:${TAG}"

# --------------- 推送 ---------------
if [ "$PUSH_IMAGES" = true ]; then
    echo ""
    echo "[推送] 镜像到 NSTL 仓库..."
    docker push "${REGISTRY}:${TAG}"
    echo "[完成] 镜像推送完毕"
fi

echo ""
echo "============================================"
echo "  构建完成"
echo "============================================"
