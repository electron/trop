## Local setup

### Getting Code Locally

```sh
$ git clone https://github.com/codebytere/trop
$ cd trop
$ npm install
```

### Configuring the GitHub App

To run your app in development, you will need to configure a GitHub App to deliver webhooks to your local machine.

1. Go to [smee.io](https://smee.io/) and click **Start a new channel**.
2. Set `WEBHOOK_PROXY_URL` in `.env` to the URL that you are redirected to.
3. [Create a new GitHub App](https://github.com/settings/apps/new)
  - **Webhook URL:** `Use your WEBHOOK_PROXY_URL` from the previous step.
  - **Webhook Secret:** `development`
  - Set the permissions you'd like your app to have and the events you'd like for it to listen to.  
    - This will depend on what data you want your app to have access to.
    - **Nota Bene:** For development we recommend enabling everything and then removing uncessary permissions later.
4. Download the private key as `private-key.pem` into the repository’s directory
5. Start the app with APP_ID=1234 npm start where 1234 is your GitHub App’s ID
5. Update your GitHub App’s Webhook URL to your [smee.io](https://smee.io/) URL.
6. Run `$ npm start` to start the server.

### Debugging

1. Always run $ npm install and restart the server if package.json has changed.
  - To turn on verbose logging, start server by running: $ LOG_LEVEL=trace npm start

2. `robot.log('some text')` is your friend.

2. To test changes without triggering events on a real repository, see [simulating webhooks](https://probot.github.io/docs/simulating-webhooks/)