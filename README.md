[![Build Status](https://img.shields.io/travis/codebytere/issue-board-tracking.svg)](https://travis-ci.org/codebytere/issue-board-tracking)

# issue-board-tracking

> a GitHub App built with [probot](https://github.com/probot/probot) that adds issues with certain labels to project boards.

## Setup

```sh
# Install dependencies
npm install

# Run the bot
npm start
```

## Test

```sh
# run the test suite
npm test
```

## How it Works

This bot watches issues and pull requests for specific labels. When a certain label
(e.g `todo`) is added to an issue or PR, the bot adds it to a specified (via `config.yml`) project board, and within that project board, a column that corresponds with that label.
