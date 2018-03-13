jest.mock('request')
const {createRobot} = require('probot')

const utils = require('../lib/backport/utils')
const trop = require('../lib/index.js')

// event fixtures
const pushEvent = require('./fixtures/push.json')
const issueLabeledEvent = require('./fixtures/issues.labeled.json')
const issueUnlabeledEvent = require('./fixtures/issues.unlabeled.json')
const prLabeledEvent = require('./fixtures/pull_request.labeled.json')
const prUnlabeledEvent = require('./fixtures/pull_request.unlabeled.json')
const prClosedEvent = require('./fixtures/pull_request.closed.json')
const issueCommentCreatedEvent = require('./fixtures/issue_comment.created.json')

describe('trop', () => {
  let robot, github

  beforeEach(async () => {
    process.env.GITHUB_FORK_USER_TOKEN = 'fake'
    robot = createRobot()
    await trop(robot)

    github = {
      repos: {
        getContent: jest.fn().mockReturnValue(Promise.resolve({
          data: { 'content': Buffer.from('watchedProject:\n  name: Radar\nauthorizedUsers:\n  - codebytere').toString('base64') }
        }))
      },
      pullRequests: {
        get: jest.fn().mockReturnValue(Promise.resolve({
          data: {
            'merged': true,
            'labels': [
              {
                'url': 'my_cool_url',
                'name': 'target/X-X-X',
                'color': 'fc2929'
              }
            ]
          }
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
        createLabel: jest.fn().mockReturnValue(Promise.resolve({})),
        createComment: jest.fn().mockReturnValue(Promise.resolve({}))
      }
    }

    robot.auth = () => Promise.resolve(github)
  })

  describe('config', async () => {
    it('fetches config', async () => {
      await robot.receive(issueLabeledEvent)

      expect(github.repos.getContent).toHaveBeenCalled()
    })
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
      expect(github.issues.createLabel).not.toHaveBeenCalled()
    })
  })

  describe('issues.[labeled, unlabeled] events', async () => {
    it('adds a new project card for a labeled issue', async () => {
      github.projects.createProjectCard = jest.fn().mockReturnValue(Promise.resolve({}))
      await robot.receive(issueLabeledEvent)

      expect(github.projects.getRepoProjects).toHaveBeenCalled()
      expect(github.projects.getProjectColumns).toHaveBeenCalled()
      expect(github.projects.createProjectCard).toHaveBeenCalled()
      expect(github.projects.moveProjectCard).not.toHaveBeenCalled()
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

  describe('issue_comment.created event', () => {
    it('manually triggers the backport on comment', async () => {
      utils.backportPR = jest.fn()
      await robot.receive(issueCommentCreatedEvent)

      expect(github.pullRequests.get).toHaveBeenCalled()
      expect(github.issues.createComment).toHaveBeenCalled()
      expect(utils.backportPR).toHaveBeenCalled()
    })
    it('does not triggers the backport on comment if the PR is not merged', async () => {
      utils.backportPR = jest.fn()
      github.pullRequests.get = jest.fn().mockReturnValue(Promise.resolve({data: {'merged': false}}))

      await robot.receive(issueCommentCreatedEvent)

      expect(github.pullRequests.get).toHaveBeenCalled()
      expect(github.issues.createComment).toHaveBeenCalled()
      expect(utils.backportPR).not.toHaveBeenCalled()
    })
  })

  describe('pull_request.closed event', () => {
    it('begins the backporting process if the PR was merged', async () => {
      utils.backportPR = jest.fn()
      await robot.receive(prClosedEvent)

      expect(utils.backportPR).toHaveBeenCalled()
    })
  })

  describe('pull_request.[labeled, unlabeled] events', async () => {
    it('adds a new project card for a labeled pull request', async () => {
      github.projects.createProjectCard = jest.fn().mockReturnValue(Promise.resolve({}))
      await robot.receive(prLabeledEvent)

      expect(github.projects.getRepoProjects).toHaveBeenCalled()
      expect(github.projects.getProjectColumns).toHaveBeenCalled()
      expect(github.projects.createProjectCard).toHaveBeenCalled()
      expect(github.projects.moveProjectCard).not.toHaveBeenCalled()
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
