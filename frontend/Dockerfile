# Production image: build the Vite bundle, then serve it with nginx and proxy
# /api to the backend container. (Dev uses Dockerfile.dev = the Vite dev server.)
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
# バージョン表示用。イメージには .git が入らないので、ビルド元から渡してもらう:
#   docker build --build-arg APP_COMMIT=$(git rev-parse --short HEAD) \
#                --build-arg APP_BUILT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ) ...
# 渡さなくてもビルドは通る（画面には 'dev' と出る）。
ARG APP_COMMIT
ARG APP_BUILT_AT
ENV APP_COMMIT=$APP_COMMIT APP_BUILT_AT=$APP_BUILT_AT
# `npm run build` = tsc -b && vite build  → outputs static files to /app/dist
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
