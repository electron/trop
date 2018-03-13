jest.mock('request')
jest.mock('../lib/backport/utils.js', () => ({
  ensureElectronUpToDate: async () => {},
  backportPR: async () => {}
}))
const {createRobot} = require('probot')
const issueBoardTracker = require('../lib/index.js')

const pushEvent = require('./fixtures/push.json')
const issueLabeledEvent = require('./fixtures/issues.labeled.json')
const issueUnlabeledEvent = require('./fixtures/issues.unlabeled.json')
const prLabeledEvent = require('./fixtures/pull_request.labeled.json')
const prUnlabeledEvent = require('./fixtures/pull_request.unlabeled.json')
const prClosedEvent = require('./fixtures/pull_request.closed.json')

describe('issue-board-tracker', () => {
  let robot, github

  beforeEach(async () => {
    process.env.GITHUB_FORK_USER_TOKEN = 'fake'
    robot = createRobot()
    await issueBoardTracker(robot)

    github = {
      repos: {
        getContent: jest.fn().mockReturnValue(Promise.resolve({
          data: { 'content': Buffer.from('watchedProject:\n  name: Radar').toString('base64') }
        }))
      },
      projects: {
        moveProjectCard: jest.fn().mockReturnValue(Promise.resolve({})),
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
        getProjectCards: jest.fn().mockReturnValue(Promise.resolve({
          data: [
            {'id': 11, 'name': 'todo', 'content_url': 'my_cool_url'}
          ]
        })),
        deleteProjectCard: jest.fn().mockReturnValue(Promise.resolve({}))
      },
      issues: {
        createLabel: jest.fn().mockReturnValue(Promise.resolve({}))
      }
    }

    robot.auth = () => Promise.resolve(github)
  })

  describe('push event', async () => {
    it('does not create labels that already exist', async () => {
      github.issues.getLabel = jest.fn().mockImplementation(() => Promise.reject(new Error()))

      await robot.receive(pushEvent)
      expect(github.projects.getRepoProjects).toHaveBeenCalled()
      expect(github.issues.getLabel).toHaveBeenCalled()
      expect(github.issues.createLabel).toHaveBeenCalledTimes(3)
    })
    it('creates labels based on project column names', async () => {
      github.issues.getLabel = jest.fn().mockReturnValue(Promise.resolve({'id': 14, 'name': 'todo'}))

      await robot.receive(pushEvent)
      expect(github.projects.getRepoProjects).toHaveBeenCalled()
      expect(github.issues.getLabel).toHaveBeenCalled()
      expect(github.issues.createLabel).toHaveBeenCalledTimes(0)
    })
  })

  describe('issues.[labeled, unlabeled] events', async () => {
    it('adds a new project card for a labeled issue', async () => {
      github.projects.createProjectCard = jest.fn().mockReturnValue(Promise.resolve({}))
      await robot.receive(issueLabeledEvent)

      expect(github.projects.getRepoProjects).toHaveBeenCalled()
      expect(github.projects.getProjectColumns).toHaveBeenCalled()
      expect(github.projects.createProjectCard).toHaveBeenCalled()
      expect(github.projects.moveProjectCard).toHaveBeenCalledTimes(0)
    })
    it('moves an issue project card when a new label is applied', async () => {
      github.projects.createProjectCard = jest.fn().mockImplementation(() => Promise.reject(new Error()))
      await robot.receive(issueLabeledEvent)

      expect(github.projects.getRepoProjects).toHaveBeenCalled()
      expect(github.projects.getProjectColumns).toHaveBeenCalled()
      expect(github.projects.getProjectCards).toHaveBeenCalled()
      expect(github.projects.moveProjectCard).toHaveBeenCalled()
    })
    it('removes a card from the project board when the label is removed', async () => {
      await robot.receive(issueUnlabeledEvent)

      expect(github.projects.getRepoProjects).toHaveBeenCalled()
      expect(github.projects.getProjectColumns).toHaveBeenCalled()
      expect(github.projects.getProjectCards).toHaveBeenCalled()
      expect(github.projects.deleteProjectCard).toHaveBeenCalled()
    })
  })

  describe('pull_request.closed event', () => {
    it('begins the backporting process if the PR was merged', async () => {
      const backportAllLabels = jest.fn().mockReturnValue()
      await robot.receive(prClosedEvent)

      expect(backportAllLabels).toHaveBeenCalled()
    })
  })

  describe('pull_request.[labeled, unlabeled] events', async () => {
    it('adds a new project card for a labeled pull request', async () => {
      github.projects.createProjectCard = jest.fn().mockReturnValue(Promise.resolve({}))
      await robot.receive(prLabeledEvent)

      expect(github.projects.getRepoProjects).toHaveBeenCalled()
      expect(github.projects.getProjectColumns).toHaveBeenCalled()
      expect(github.projects.createProjectCard).toHaveBeenCalled()
      expect(github.projects.moveProjectCard).toHaveBeenCalledTimes(0)
    })
    it('moves a pull request project card when a new label is applied', async () => {
      github.projects.createProjectCard = jest.fn().mockImplementation(() => Promise.reject(new Error()))
      await robot.receive(prLabeledEvent)

      expect(github.projects.getRepoProjects).toHaveBeenCalled()
      expect(github.projects.getProjectColumns).toHaveBeenCalled()
      expect(github.projects.getProjectCards).toHaveBeenCalled()
      expect(github.projects.moveProjectCard).toHaveBeenCalled()
    })
    it('removes a card from the project board when the label is removed', async () => {
      await robot.receive(prUnlabeledEvent)

      expect(github.projects.getRepoProjects).toHaveBeenCalled()
      expect(github.projects.getProjectColumns).toHaveBeenCalled()
      expect(github.projects.getProjectCards).toHaveBeenCalled()
      expect(github.projects.deleteProjectCard).toHaveBeenCalled()
    })
  })
})
