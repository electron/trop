## Setting Up `trop`

Welcome! We're glad you want to try out `trop`.

### What Does `trop` Do?

`trop` automates backporting PRs to versioned release branches.

#### You Will Need:

1. A project board with column names corresponding to your backport labels
  - Ex. a column name of `target/2-0-0` will correspond to a label of `target/2-0-0`
2. A `.github/config.yml` file. See [this example](.example.config).

#### Using `trop`:

**Automatically With Labels**:
1. Open a bugfix or feature pull request to `master`
2. Add backport label(s) to the pull request (ex. `target/2-0-0`)
3. `trop` will add this pull request into the corresponding column of the `watchedProject` in your config file.
4. Your pull request is reviewed and you or a co-contributor merges it into `master`
5. `trop` will automatically open pull requests containing `cherry-pick`s of the code into the backporting branches you specified in your labels (in this case, `2.0.0`).
6. You or a co-contributor resolves any conflicts and merges in `trop`'s backports
7. `trop` will move the cards it created for this backport into corresponding columns (ex. `merged/2-0-0`) in the specified `watchedProject` board.

**Manual Triggering With Labels**:
1. Open a bugfix or feature pull request to `master`
2. Add backport label(s) to the pull request (ex. `target/2-0-0`)
3. `trop` will add this pull request into the corresponding column of the `watchedProject` in your config file.
4. Your pull request is reviewed and you or a co-contributor merges it into `master`
5. You create a new comment with the following body: `/trop run backport`
6. `trop` will begin the backport process for target branches you have specified via labels
7. `trop` will automatically open pull requests containing `cherry-pick`s of the code into the backporting branches you specified in your labels (in this case, `2.0.0`).
8. You or a co-contributor resolves any conflicts and merges in `trop`'s backports
9. `trop` will move the cards it created for this backport into corresponding columns (ex. `merged/2-0-0`) in the specified `watchedProject` board.

**Manual Triggering Without Labels**:
1. Open a bugfix or feature pull request to `master`
2. Your pull request is reviewed and you or a co-contributor merges it into `master`
3. You create a new comment with the following body: `/trop run backport-to [BRANCH_NAME]`, where `[BRANCH_NAME]` is replaced with the branch you wish to backport to
4. `trop` will begin the backport process for target branch you manually specified
5. `trop` will automatically open pull requests containing `cherry-pick`s of the code into the branch you specified in your comment body
5. You or a co-contributor resolves any conflicts and merges in the backport pull request `trop` created

**Note**
  - If you delete a branch immediately after merging its associated pull request, `trop` will be unable to find it and the backports will fail

That's all there is to it! Congratulations, you did it! :tada: