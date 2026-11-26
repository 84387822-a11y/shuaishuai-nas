# 帅帅 NAS 助手 —— 单镜像，零第三方依赖
FROM node:22-alpine

# smartmontools: 硬盘 SMART 读取；iputils: ping；bind-tools: dig 排障
RUN apk add --no-cache tzdata smartmontools iputils bind-tools ca-certificates

ENV NODE_ENV=production \
    SS_PORT=8620 \
    SS_HOST=0.0.0.0 \
    SS_ROOTS=/vol1:/vol2:/vol3:/mnt \
    SS_DATA_DIR=/data \
    TZ=Asia/Shanghai

WORKDIR /app

COPY package.json ./
COPY server ./server
COPY web ./web

RUN mkdir -p /data && chown -R node:node /app /data

# 默认以非 root 运行；SMART 模块需要额外权限时再按需覆盖（见 compose 注释）
USER node

EXPOSE 8620
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=8s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.SS_PORT||8620)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
