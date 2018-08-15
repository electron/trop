FROM node:8.9.4-slim

WORKDIR /app
COPY . /app

RUN yarn && yarn build

CMD ["node", "/app/node_modules/probot/bin/probot-run.js", "/app/lib/index.ts", "--private-key=private.pem"]

EXPOSE 3000
