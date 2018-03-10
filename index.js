const randomColor = require('randomcolor')

module.exports = (robot) => {
  // get watched board and create labels based on column names
  robot.on('push', async context => {
    const config = await context.config('config.yml')

    if (config.watchedProject) {
      const projects = await context.github.projects.getRepoProjects(context.repo())
      const project = projects.data.find(project => project.name === config.watchedProject)
      console.log(`NAME IS ${project.name}`)

      if (project) {
        const id = config.watchedProject.id
        console.log(`ID IS ${id}`)

        console.log(context.github.projects)
        const columns = await context.github.projects.getProjectColumns(context.repo({id}))

        // generate labels based on project column names
        columns.forEach(async column => {
          // check if label already exists
          const label = await context.github.issues.getLabel(context.issue({name: column.name}))

          // if it doesn't exist, create a new label
          if (label.status === 404) {
            const newLabel = context.github.issues.createLabel(context.issue({
              name: column.name,
              color: randomColor()
            }))
          }
        })
      }
    }
    robot.log('all labels created!')
  })

  robot.on('issues.labeled', async context => {
    const config = await context.config('config.yml')

    const columns = await context.github.projects.getProjectColumns({id: config.watchedProjectproject.id})
    const columnTitles = columns.filter(c => c.name)

    const issue = context.payload.issue

    let column
    if (columnTitles.includes(issue.title)) {
      // get the column to add the card to
      column = columns.filter(c => issue.title === c.title)

      // create project card for issue in the column
      const card = await context.github.projects.createProjectCard({
        column_id: column.id,
        content_id: issue.id,
        content_type: 'Issue'
      })
    }

    robot.logger(`issue added to ${column.name} in ${config.watchedProject.name}`)
  })
}
