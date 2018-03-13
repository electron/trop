## Setting Up `trop`

Welcome! We're glad you want to try out `trop`.

#### What Does `trop` Do?

This bot is designed to automate the process of backporting to versioned release branches.

To install this app and have it work properly you will need:
1. A project board with column names corresponding to your backport labels
  - Ex. a column name of `target/2-0-0` will correspond to a label of `target/2-0-0`
2. A `.github/config.yml` file with fields as specified in [this example config](.example.config)

The flow of this app is as follows:
1. Open a bugfix or feature pull request to `master`
2. Tag the pull request with one of the backport labels (ex. `target/2-0-0`)
3.`trop` will immediately place this pull request as a note into the corresponding column of the `watchedProject` as specified in your config file
4. You or another co-contributor merges the pull request into `master`
5. Trop will automatically open pull requests containing `cherry-pick`s of the code into the backporting branches you specified in your labels (in this case, `2.0.0`).
6. You or a co-contributor resolves conflicts if they exist and merges in the automatically created backport branches
7. `trop` will move the cards it created for this backport into corresponding `merged/2-0-0` columns in the specified `watchedProject` board.

Congratulations! You've significantly reduced friction in your backporting process :tada:



