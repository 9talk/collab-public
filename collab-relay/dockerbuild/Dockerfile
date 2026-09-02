# collab-relay 中继服务镜像
# 基础镜像通过 build-arg BASE_IMAGE 指定（构建脚本会探测 NSTL 代理镜像），默认回退 Docker Hub
ARG BASE_IMAGE=oven/bun:1-alpine
FROM ${BASE_IMAGE}

WORKDIR /app

COPY package.json ./
RUN bun install --production

COPY src ./src

ENV RELAY_PORT=8787 \
    RELAY_PERSIST_DIR=/app/data

EXPOSE 8787
VOLUME ["/app/data"]

CMD ["bun", "run", "src/index.ts"]
