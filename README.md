# trop

[![Test](https://github.com/electron/trop/actions/workflows/test.yml/badge.svg)](https://github.com/electron/trop/actions/workflows/test.yml)

<img height="124px" width="124px" align="right" alt="trop-logo" src="design/logo.png">

Trop a GitHub App built with [probot](https://github.com/probot/probot) that automates the process of backporting features and bugfixes.

```js
[...'backport'.slice(4)].reverse().join``
// => trop
```

## Setup

```sh
# Clone the trop repository locally
git clone https://github.com/electron/trop.git

# Change directory to where trop has been cloned
cd trop

# Install dependencies
npm install

# Run the bot
npm start
```

## Documentation

To learn how to use `trop`, see [usage](docs/usage.md).

For information on setting up a local version of this GitHub App, see [local-setup](docs/local-setup.md).
