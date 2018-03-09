module.exports = (robot) => {
  robot.log('Yay, the app was loaded!')
  robot.on('config-file-changed', (context) => {
    // get "watched project boards"
    // for each column, make a label
  })
  robot.on('issues.labeled', (context) => {
    // see if any label relates to a column in a watch board
    // add issue to column
  })
}
