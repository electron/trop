import * as randomColor from 'randomcolor'
import { backportPR, ensureElectronUpToDate } from './backport/utils'

module.exports = async (robot) => {
  robot.log('initializing working directory')
  await ensureElectronUpToDate()
  robot.log('working directory ready')

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

              const itemUrl = item.url.replace('/pulls/', '/issues/')
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

        const itemUrl = item.url.replace('/pulls/', '/issues/')

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
            robot.log('Error: tried to delete card that doesn\'t exist')
          }
        }
      }
    }
  })

  robot.on('pull_request.closed', context => {
    const payload = context.payload
    if (payload.pull_request.merged) {
      // Just merged, let's queue up backports
      // Check if the author is us, if so stop processing
      for (const label of payload.pull_request.labels) {
        backportPR(robot, context, label)
      }
    }
  })
}
