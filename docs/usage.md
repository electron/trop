## Setting Up `trop`

Welcome! We're glad you want to try out `trop`.

### What Does `trop` Do?

`trop` automates backporting PRs to versioned release branches.

#### You Will Need:

1. A project board with column names corresponding to your backport labels
  - Ex. a column name of `target/2-0-0` will correspond to a label of `target/2-0-0`
2. A `.github/config.yml` file. See [this example](.example.config).

#### Using `trop`:

1. Open a bugfix or feature pull request to `master`
2. Add a backport label to the pull request (ex. `target/2-0-0`)
3.`trop` will add this pull request into the corresponding column of the `watchedProject` in your config file.
4. You or a co-contributor reviews and merges the pull request into `master`
5. `trop` will automatically open pull requests containing `cherry-pick`s of the code into the backporting branches you specified in your labels (in this case, `2.0.0`).
6. You or a co-contributor resolves any conflicts and merges in `trop`'s backports
7. `trop` will move the cards it created for this backport into corresponding columns (ex. `merged/2-0-0`) in the specified `watchedProject` board.

That's all there is to it! Congratulations, you did it! :tada: