# --- build stage: compile the Vue app to static assets ---
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# --- runtime stage: serve the static bundle ---
# nginx-unprivileged runs as a non-root user out of the box.
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime

COPY --from=build /app/dist /usr/share/nginx/html

# Rendered to /etc/nginx/conf.d/default.conf at startup, with the two backend
# variables substituted in (the image runs envsubst over /etc/nginx/templates).
COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template

ENV BACKEND_URL=http://backend:3000
ENV BACKEND_HOST=backend

EXPOSE 8080
