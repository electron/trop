const randomColor = require('randomcolor')

module.exports = (robot) => {
  // get watched board and create labels based on column names
  robot.on('config-file-changed', async context => {
    const config = await context.config('config.yml')

    const data = {
      owner: context.payload.repository.owner.login,
      repo: context.payload.repository.name
    }

    const id = config['watchedProject']['id']
    const columns = await context.projects.getProjectColumns({id})

    // generate labels based on project column names
    columns.forEach(async column => {
      // check if label already exists
      const label = await context.issues.getLabel({
        owner: data.owner,
        repo: data.repo,
        name: column.name
      })

      // if it doesn't, create a new label
      if (!label) {
        const newLabel = context.issues.createLabel({
          owner: data.owner,
          repo: data.repo,
          name: column.name,
          color: randomColor()
        })
      }
    })

    robot.log('all labels created!')
  })

  robot.on('issues.labeled', async context => {
    // see if any label relates to a column in the watch board
    // add issue to column
  })
}
