## Setting Up `trop`

Welcome! We're glad you want to try out `trop`.

### What Does `trop` Do?

`trop` automates backporting PRs to versioned release branches.

#### Using `trop`:

**Automatically With Labels**:
1. Open a bugfix or feature pull request to `main`
2. Add backport label(s) to the pull request (ex. `target/2-0-x`)
3. Your pull request is reviewed and you or a co-contributor merges it into `main`
4. `trop` will automatically open pull requests containing `cherry-pick`s of the code into the backporting branches you specified in your labels (in this case, `2-0-x`).
5. You or a co-contributor resolves any conflicts and merges in `trop`'s backports

**NOTE:** If `trop` fails to perform a backport, it will flag the original PR with `needs-manual-backport/2-0-x`
so that you or another contributor and perform the backport manually.  Trop will keep track of manual backports
and update the labels appropriately.

**Manual Triggering With Labels**:
1. Open a bugfix or feature pull request to `main`
2. Your pull request is reviewed and you or a co-contributor merges it into `main`
3. After it's been merged, you add backport label(s) to the pull request (ex. `target/2-0-x`)
4. You create a new comment with the following body: `/trop run backport`
5. `trop` will begin the backport process for target branches you have specified via labels
6. `trop` will automatically open pull requests containing `cherry-pick`s of the code into the backporting branches you specified in your labels (in this case, `2-0-x`).
7. You or a co-contributor resolves any conflicts and merges in `trop`'s backports

**Manual Triggering Without Labels**:
1. Open a bugfix or feature pull request to `main`
2. Your pull request is reviewed and you or a co-contributor merges it into `main`
3. You create a new comment with the following body: `/trop run backport-to [BRANCH_NAME]`, where `[BRANCH_NAME]` is replaced with the branch you wish to backport to
4. `trop` will begin the backport process for target branch you manually specified
5. `trop` will automatically open pull requests containing `cherry-pick`s of the code into the branch you specified in your comment body
5. You or a co-contributor resolves any conflicts and merges in the backport pull request `trop` created

**Note**
  - You can delete the original PR branch whenever you want - trop does not need the original branch to perform the backport.

#### Environment Variables

`trop` is configured by default to use variable specific to electron, so in order to get the best experience you should be sure to set the following:

* `BOT_USER_NAME` - the username if your bot (e.g `trop[bot]`)
* `SKIP_CHECK_LABEL` - see [skipping manual backports](./manual-backports.md#skipping-backport-checks)
* `NUM_SUPPORTED_VERSIONS` - trop assumes numeric branch prefixes (e.g `8-x-y`, 9-x-y) and can automatically backport to the 4 most recent branches by default.
