import {backportToLabel, backportToBranch} from './backport/utils'

module.exports = async (robot) => {
  if (!process.env.GITHUB_FORK_USER_TOKEN) {
    robot.log.error('You must set GITHUB_FORK_USER_TOKEN')
    process.exit(1)
  }

  const backportAllLabels = (context, pr) => {
    for (const label of pr.labels) {
      context.payload.pull_request = context.payload.pull_request || pr
      backportToLabel(robot, context, label)
    }
  }

  // backport pull requests to labeled targets when PR is merged
  robot.on('pull_request.closed', context => {
    const payload = context.payload
    if (payload.pull_request.merged) {
      // Check if the author is us, if so stop processing
      if (payload.pull_request.user.login.endsWith('[bot]')) return
      backportAllLabels(context, payload.pull_request)
    }
  })

  const TROP_COMMAND_PREFIX = '/trop '

  // manually trigger backporting process on trigger comment phrase
  robot.on('issue_comment.created', async context => {
    const payload = context.payload
    const config = await context.config('config.yml')

    const isPullRequest = (issue) => issue.html_url.endsWith(`/pull/${issue.number}`)

    if (!isPullRequest(payload.issue)) return

    const cmd = payload.comment.body
    if (!cmd.startsWith(TROP_COMMAND_PREFIX)) return

    if (!config.authorizedUsers.includes(payload.comment.user.login)) {
      robot.log.error('This user is not authorized to use trop')
      return
    }

    const actualCmd = cmd.substr(TROP_COMMAND_PREFIX.length)

    const actions = [{
      name: 'backport sanity checker',
      command: /^run backport/,
      execute: async () => {
        const pr = (await context.github.pullRequests.get(context.repo({number: payload.issue.number}))).data
        if (!pr.merged) {
          await context.github.issues.createComment(context.repo({
            number: payload.issue.number,
            body: 'This PR has not been merged yet, and cannot be backported.'
          }))
          return false
        }
        return true
      }
    }, {
      name: 'backport automatically',
      command: /^run backport$/,
      execute: async () => {
        const pr = (await context.github.pullRequests.get(context.repo({number: payload.issue.number}))).data
        await context.github.issues.createComment(context.repo({
          number: payload.issue.number,
          body: `The backport process for this PR has been manually initiated, here we go! :D`
        }))
        backportAllLabels(context, pr)
        return true
      }
    }, {
      name: 'backport to branch',
      command: /^run backport-to ([^\s:]+)/,
      execute: async (targetBranch) => {
        robot.log(`backport-to ${targetBranch}`)
        const pr = (await context.github.pullRequests.get(context.repo({number: payload.issue.number}))).data
        try {
          (await context.github.repos.getBranch(context.repo({
            branch: targetBranch
          })))
        } catch (err) {
          await context.github.issues.createComment(context.repo({
            number: payload.issue.number,
            body: `The branch you provided "${targetBranch}" does not appear to exist :cry:`
          }))
          return true
        }
        await context.github.issues.createComment(context.repo({
          number: payload.issue.number,
          body: `The backport process for this PR has been manually initiated, sending your 1's and 0's to "${targetBranch}" here we go! :D`
        }))
        context.payload.pull_request = context.payload.pull_request || pr
        backportToBranch(robot, context, targetBranch)
        return true
      }
    }]

    for (const action of actions) {
      const match = actualCmd.match(action.command)
      if (!match) continue
      robot.log(`running action: ${action.name} for comment`)

      if (!await action.execute(...match.slice(1))) {
        robot.log(`${action.name} failed, stopping responder chain`)
        break
      }
    }
  })
}
