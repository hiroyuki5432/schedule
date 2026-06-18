# Production image: build the Vite bundle, then serve it with nginx and proxy
# /api to the backend container. (Dev uses Dockerfile.dev = the Vite dev server.)
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
# `npm run build` = tsc -b && vite build  → outputs static files to /app/dist
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
