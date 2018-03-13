FROM node:8.9.4-slim

RUN apt update && apt install git -y

WORKDIR /app
COPY . /app

RUN yarn && yarn build

CMD ["node", "/app/lib/backport/runner.js"]

EXPOSE 4141
