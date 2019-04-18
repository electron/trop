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
2. Create a `.env` file (example found [here](.example.env))
2. Set `WEBHOOK_PROXY_URL` in your `.env` file to the URL that you are redirected to.
3. [Create a new GitHub App](https://github.com/settings/apps/new)
  - **Webhook URL:** `Use your WEBHOOK_PROXY_URL` from the previous step.
  - **Webhook Secret:** `development`
  - **Permissions:** Dependent on your use case
    - If you enable excess permissions during development, remember to remove them in production.
4. Download the private key as `private-key.pem` into the repository’s directory
5. Set your `APP_ID` in your `.env` file
6. Update your GitHub App’s Webhook URL to your [smee.io](https://smee.io/) URL.
7. Run `$ npm start` to start the server.

### Testing

```sh
# run the test suite
$ npm test
```

### Debugging

1. Always run `$ npm install` and restart the server if package.json has changed.
  - To turn on verbose logging, start server by running: $ LOG_LEVEL=trace npm start

2. `robot.log('some text')` is your friend.

3. To test changes without triggering events on a real repository, see [simulating webhooks](https://probot.github.io/docs/simulating-webhooks/)
