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

**Stacked pull requests**: a [stack](https://docs.github.com/en/pull-requests/get-started/about-stacked-prs) is backported as a unit.
Add the `target/*` label(s) to the **top** pull request of the stack only - `target/*` labels on lower pull requests are ignored for
the backport itself, and their `Backport Labels Added` check passes as long as their labels do not disagree with the top pull request's
(a `target/*` label the top does not have, or `no-backport` against the top's targets, fails the check until the top is labeled to
match). When the top pull request is merged, `trop` opens one backport pull request per
target branch containing the commits of every pull request in the stack, bottom to top; the lower pull requests are not backported
individually but are labeled (`in-flight/*`, `merged/*`) along with the top one. `/trop run backport` and `/trop run backport-to`
must also be run on the top pull request.

**Batch backports**: pull requests labeled `batch-backport` (as well as their `target/*` labels) are backported together, as one
pull request per target branch, instead of one backport each. When such a pull request is merged, `trop` checks whether any open
pull request still has the `batch-backport` label: if one does, the merged pull request waits in the batch (`trop` comments to say
so), and if none does, the batch goes out. A batch also goes out when the last open labeled pull request is closed without merging
or has its `batch-backport` label removed, and at the latest two hours after the oldest pull request in it was merged.
`/trop run backport` on a waiting pull request sends the whole batch out at once.
- For each target branch, the batch is made of every waiting pull request labeled `target/<branch>`, applied in the order they were
  merged. A pull request that does not apply cleanly on top of the ones before it is left out: `trop` comments on it and swaps its
  `target/<branch>` label for `needs-manual-bp/<branch>`, and the rest of the batch still goes out without it.
- The batch pull request is titled `chore: batch backport of #1, #2` (a single pull request left in a batch keeps its own title),
  declares `Backport of #N` for each pull request in it with their release notes combined, gets the highest `semver/*` label among
  them and asks every author for review. Each pull request in it gets a comment linking to it and the usual `in-flight/*` and
  `merged/*` labels.
- A stack can be part of a batch: label its **top** pull request with `batch-backport`, and the whole stack is backported in the
  batch, bottom to top, where its top pull request was merged. A stack that does not apply is left out as a whole.
- The batch lives in the labels: a pull request is waiting as long as it is merged and still has `batch-backport` and `target/*`
  labels, so restarting `trop` does not lose it. Removing `batch-backport` from a waiting pull request takes it out of the batch;
  `/trop run backport` then backports it on its own.
- `/trop run backport-to <branch>` on a waiting pull request backports it to that branch on its own and removes its
  `target/<branch>` label, so the batch does not backport it there again.
- A pull request leaves the batch for good once its `target/*` labels are consumed (swapped for `in-flight/*` or
  `needs-manual-bp/*`); its `batch-backport` label is left in place. If `trop` hits an internal error, the labels stay: the
  pull requests of that batch are retried on their own a few minutes later (up to three times in a row), and otherwise go out
  with the next batch, on `/trop run backport` or after a restart. They don't make the pull requests waiting since overdue.
- A pull request whose commits don't apply and whose squash commit can't be fetched is left out of its batch like one that
  conflicts.

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

**Updating a Backport Branch**:
1. On an open pull request whose branch has fallen behind its base branch, create a new comment with the following body: `/trop update-branch`
2. `trop` will merge the latest changes from the base branch into the pull request's branch (the same operation as the "Update branch" button, but attributed to trop)

#### Environment Variables

`trop` is configured by default to use variable specific to electron, so in order to get the best experience you should be sure to set the following:

* `BOT_USER_NAME` - the username if your bot (e.g `trop[bot]`)
* `SKIP_CHECK_LABEL` - see [skipping manual backports](./manual-backports.md#skipping-backport-checks)
* `BATCH_BACKPORT_LABEL` - the label of [batch backports](#using-trop). Defaults to `batch-backport`.
* `NUM_SUPPORTED_VERSIONS` - automatic backports to stable branches further than this many back will be skipped. Defaults to 3.
* `NO_EOL_SUPPORT` - if set to `1`, manual backports to stable branches older than `NUM_SUPPORTED_VERSIONS` will also be disallowed.
* `SUPPORTED_BRANCH_PATTERN` - regex to define what a "stable branch" is. Defaults to `^(\d+)-(?:(\d+)-x|x-y)$`, which matches branches like `8-x-y` or `5-1-x`. Regex groups will be used for sorting, to determine which branch is "older" than another. Numeric groups (matching `/^\d+$/`) will be compared numerically, otherwise groups will be compared lexically. The first group is treated as the major version. There must be at least one group.
