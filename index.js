const randomColor = require('randomcolor')

module.exports = (robot) => {
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
            await context.github.projects.createProjectCard({
              column_id: column.id,
              content_id: item.id,
              content_type: context.payload.issue ? 'Issue' : 'PullRequest'
            })
          } catch (err) {
            let existing

            for (const column of columns.data) {
              const cards = await context.github.projects.getProjectCards({column_id: column.id})
              existing = cards.data.find(card => card.content_url === item.url)
              if (existing) break
            }

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
}
