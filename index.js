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
            const label = await context.github.issues.getLabel(context.issue({name: column.name}))
          } catch (err) {
            // make a new label with the column name
            const color = randomColor()
            const newLabel = context.github.issues.createLabel(context.issue({
              name: column.name,
              color: color.substring(1) // trim off #
            }))
          }
        })
      }
      robot.log('all labels created!')
    }
  })

  robot.on('issues.labeled', async context => {
    const config = await context.config('config.yml')

    if (config.watchedProject) {
      const projects = await context.github.projects.getRepoProjects(context.repo())
      const project = projects.data.find(project => project.name === config.watchedProject.name)

      if (project) {
        const columns = await context.github.projects.getProjectColumns(context.repo({project_id: project.id}))
        const issue = context.payload.issue

        columns.data.forEach(async column => {
          // add
          if (column.title === issue.title) {
            // create project card for issue in the column
            const card = await context.github.projects.createProjectCard({
              column_id: column.id,
              content_id: issue.id,
              content_type: 'Issue'
            })
            robot.logger(`issue added to ${column.name} in ${config.watchedProject.name}!`)
          }
        })
      }
    }
  })
}
