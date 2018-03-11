jest.mock('request')
const {createRobot} = require('probot')
const issueBoardTracker = require('../index.js')

const pushEventPayload = require('./fixtures/push.json')
// const issueLabeledEventPayload = require('./fixtures/issue.labeled.json')

describe('issue-board-tracker', () => {
  let robot, github

  beforeEach(() => {
    robot = createRobot()
    issueBoardTracker(robot)

    github = {
      repos: {
        getContent: jest.fn().mockReturnValue(Promise.resolve({
          data: { 'content': Buffer.from('watchedProject:\n  name: Radar').toString('base64') }
        }))
      },
      projects: {
        getRepoProjects: jest.fn().mockReturnValue(Promise.resolve({
          data: [{'id': 1, 'name': 'Radar'}]
        })),
        getProjectColumns: jest.fn().mockReturnValue(Promise.resolve({
          data: [
            {'id': 11, 'name': 'todo'},
            {'id': 12, 'name': 'doing'},
            {'id': 13, 'name': 'done'}
          ]
        })),
        createProjectCard: jest.fn().mockReturnValue(Promise.resolve({})),
        moveProjectCard: jest.fn().mockReturnValue(Promise.resolve({}))
      },
      issues: {
        createLabel: jest.fn().mockReturnValue(Promise.resolve({}))
      }
    }

    robot.auth = () => Promise.resolve(github)
  })

  describe.only('push event', async () => {
    it('does not create labels that already exist', async () => {
      github.issues.getLabel = jest.fn().mockImplementation(() => Promise.reject(new Error()))

      await robot.receive(pushEventPayload)
      expect(github.projects.getRepoProjects).toHaveBeenCalled()
      expect(github.issues.getLabel).toHaveBeenCalled()
      expect(github.issues.createLabel).toHaveBeenCalledTimes(3)
    })
    it('creates labels based on project column names', async () => {
      github.issues.getLabel = jest.fn().mockReturnValue(Promise.resolve(
        {'id': 14, 'name': 'todo'}
      ))

      await robot.receive(pushEventPayload)
      expect(github.projects.getRepoProjects).toHaveBeenCalled()
      expect(github.issues.getLabel).toHaveBeenCalled()
      expect(github.issues.createLabel).toHaveBeenCalledTimes(0)
    })
  })
})
