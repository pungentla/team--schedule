# 排班宝 TeamShift 后端镜像
# 依赖：Node 22.5+（内置 node:sqlite），零原生依赖，无需编译工具链
#
# 注意：本仓库用 npm workspaces，package-lock.json 在仓库根目录。
# 所以构建上下文必须是仓库根目录：
#   docker build -f backend/Dockerfile -t teamshift-backend .

FROM node:22-alpine

# SQLite 需要时区数据（避免容器内 TZ 不生效导致日期差一天）
RUN apk add --no-cache tzdata \
    && cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
    && echo "Asia/Shanghai" > /etc/timezone

WORKDIR /app

# 只拷贝依赖清单 + 根 lock，让这一层可缓存（改业务代码不必重装依赖）
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/package.json
COPY h5/package.json ./h5/package.json

# 只装 backend 这个 workspace 的生产依赖
RUN npm ci --omit=dev --workspace backend --include-workspace-root=false \
    && npm cache clean --force

# 再拷贝业务代码
COPY backend/src ./backend/src
COPY backend/scripts ./backend/scripts

# 数据库目录：必须挂卷，否则容器重建数据丢失
RUN mkdir -p /app/backend/data
ENV DB_FILE=/app/backend/data/app.db \
    HOST=0.0.0.0 \
    PORT=3000 \
    TZ=Asia/Shanghai \
    NODE_NO_WARNINGS=1

WORKDIR /app/backend
EXPOSE 3000

# 健康检查：容器编排与守护进程据此判断存活
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
