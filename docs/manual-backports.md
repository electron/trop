# Manual Backports

When `trop` fails to backport your PR (trust us it tried its best) you need to backport the PR manually. You can do this by cherry-picking the commits in the PR yourself locally and pushing up a new branch.

When you create PR for a manual backport, the body of the backport PR must contain: 

```markdown
Backport of #[Original PR Number]
```

where `Original PR Number` can be either a smart link:

```markdown
Backport of #21813
```

or a full link to the original PR:

```markdown
Backport of https://github.com/electron/electron/pull/21813
```

If you raise a PR to a branch that isn't `master` or a release branch without including a valid reference as above, `trop` will create a
"failed" check on that PR to prevent it being merged.

## Skipping Backport Checks

Sometimes development flows will necessitate a PR train, or several linked PRs to be merged into one another successively where none is a backport. To account for this case, `trop` allows for a label to be set on the non-backport PR: `SKIP_CHECK_LABEL`.

You can set this variable as an environment variable with `process.env.SKIP_CHECK_LABEL`. If no label is set, it will default to 'backport-check-skip'.
