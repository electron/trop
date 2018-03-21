import * as randomColor from 'randomcolor'
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

  // get watched board and create labels based on column names
  robot.on('push', async context => {
    const config = await context.config('config.yml')

    if (config.watchedProject) {
      const projects = await context.github.projects.getRepoProjects(context.repo())
      const project = projects.data.find(project => project.name === config.watchedProject.name)

      if (project) {
        const columns = await context.github.projects.getProjectColumns(context.repo({project_id: project.id}))

        // generate labels based on project column names
        columns.data.forEach(async column => {
          try {
            // check if label already exists
            await context.github.issues.getLabel(context.issue({name: column.name}))
          } catch (err) {
            // make a new label with the column name
            const color = randomColor()
            context.github.issues.createLabel(context.issue({
              name: column.name,
              color: color.substring(1) // trim off #
            }))
          }
        })
      }
    } else {
      robot.log.error('You haven\'t specified a watchedProject in your config!')
    }
  })

  // add card to project if issue or PR is labeled
  robot.on(['pull_request.labeled', 'issues.labeled'], async context => {
    const config = await context.config('config.yml')

    if (config.watchedProject) {
      const projects = await context.github.projects.getRepoProjects(context.repo())
      const project = projects.data.find(project => project.name === config.watchedProject.name)

      if (project) {
        const columns = await context.github.projects.getProjectColumns(context.repo({project_id: project.id}))
        const item = context.payload.issue || context.payload.pull_request
        const column = columns.data.find(column => column.name === context.payload.label.name)

        if (column) {
          try {
            // create project card for matching column
            await context.github.projects.createProjectCard({
              column_id: column.id,
              note: `backport ${item.html_url} \n ${item.title}`
            })
          } catch (err) {
            let existing

            // search through cards to see if the card already exists
            for (const column of columns.data) {
              const cards = await context.github.projects.getProjectCards({column_id: column.id})

              const itemUrl = item.url.replace('/pull/', '/issues/')
              existing = cards.data.find(card => {
                const urlMatch = card => card.content_url === itemUrl
                const columnMatch = card.column_url === column.url
                return columnMatch && urlMatch
              })
              if (existing) break
            }

            // move the card to the new columns
            await context.github.projects.moveProjectCard({
              column_id: column.id,
              id: existing.id,
              position: 'top'
            })
          }
        }
      }
    } else {
      robot.log.error('You haven\'t specified a watchedProject in your config!')
    }
  })

  // remove card from project if PR or issue is unlabeled
  robot.on(['pull_request.unlabeled', 'issues.unlabeled'], async context => {
    const config = await context.config('config.yml')

    if (config.watchedProject) {
      const projects = await context.github.projects.getRepoProjects(context.repo())
      const project = projects.data.find(project => project.name === config.watchedProject.name)

      if (project) {
        const columns = await context.github.projects.getProjectColumns(context.repo({project_id: project.id}))
        const item = context.payload.issue || context.payload.pull_request
        const column = columns.data.find(column => column.name === context.payload.label.name)

        const itemUrl = item.url.replace('/pull/', '/issues/')

        if (column) {
          try {
            const cards = await context.github.projects.getProjectCards({column_id: column.id})
            const toDelete = cards.data.find(card => {
              const urlMatch = card.content_url === itemUrl
              const columnMatch = card.column_url === column.url
              return urlMatch && columnMatch
            })

            if (toDelete) await context.github.projects.deleteProjectCard({id: toDelete.id})
          } catch (err) {
            robot.log.error('Tried to delete card that doesn\'t exist')
          }
        }
      }
    } else {
      robot.log.error('You haven\'t specified a watchedProject in your config!')
    }
  })

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
