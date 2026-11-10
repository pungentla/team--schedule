FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/package.json
COPY h5/package.json ./h5/package.json
RUN npm ci --workspace h5 --include-workspace-root=false
COPY h5/index.html h5/vite.config.mjs ./h5/
COPY h5/src ./h5/src
COPY h5/public ./h5/public
RUN npm run build --workspace h5

FROM node:22-alpine AS preview
WORKDIR /app
COPY h5/server.js ./server.js
COPY --from=build /app/h5/dist ./dist
EXPOSE 8080
CMD ["node", "server.js"]

FROM nginx:1.27-alpine AS production
COPY --from=build /app/h5/dist /usr/share/nginx/html
