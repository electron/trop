jest.mock('request')
const {createRobot} = require('probot')

const utils = require('../lib/backport/utils')
const trop = require('../lib/index.js')

// event fixtures
const prClosedEvent = require('./fixtures/pull_request.closed.json')
const issueCommentBackportCreatedEvent = require('./fixtures/issue_comment_backport.created.json')
const issueCommentBackportToCreatedEvent = require('./fixtures/issue_comment_backport_to.created.json')
const issueCommentBackportToMultipleCreatedEvent = require('./fixtures/issue_comment_backport_to_multiple.created.json')

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
        })),
        getBranch: jest.fn().mockReturnValue(Promise.resolve())
      },
      pullRequests: {
        get: jest.fn().mockReturnValue(Promise.resolve({
          data: {
            'merged': true,
            'base': {
              'repo': {
                'name': 'test',
                'owner': {
                  'login': 'codebytere'
                }
              }
            },
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
      issues: {
        createLabel: jest.fn().mockReturnValue(Promise.resolve({})),
        createComment: jest.fn().mockReturnValue(Promise.resolve({}))
      }
    }

    robot.auth = () => Promise.resolve(github)
  })

  describe('config', async () => {
    it('fetches config', async () => {
      await robot.receive(issueCommentBackportCreatedEvent)

      expect(github.repos.getContent).toHaveBeenCalled()
    })
  })

  describe('issue_comment.created event', () => {
    it('manually triggers the backport on comment', async () => {
      utils.backportToLabel = jest.fn()
      await robot.receive(issueCommentBackportCreatedEvent)

      expect(github.pullRequests.get).toHaveBeenCalled()
      expect(github.issues.createComment).toHaveBeenCalled()
      expect(utils.backportToLabel).toHaveBeenCalled()
    })

    it('does not triggers the backport on comment if the PR is not merged', async () => {
      utils.backportToLabel = jest.fn()
      github.pullRequests.get = jest.fn().mockReturnValue(Promise.resolve({data: {'merged': false}}))

      await robot.receive(issueCommentBackportCreatedEvent)

      expect(github.pullRequests.get).toHaveBeenCalled()
      expect(github.issues.createComment).toHaveBeenCalled()
      expect(utils.backportToLabel).not.toHaveBeenCalled()
    })

    it('manually triggers the backport on comment to a targetted branch', async () => {
      utils.backportToBranch = jest.fn()
      await robot.receive(issueCommentBackportToCreatedEvent)

      expect(github.pullRequests.get).toHaveBeenCalled()
      expect(github.issues.createComment).toHaveBeenCalled()
      expect(utils.backportToBranch).toHaveBeenCalled()
    })

    it('allows for multiple PRs to be triggered in the same comment', async () => {
      utils.backportToBranch = jest.fn()
      await robot.receive(issueCommentBackportToMultipleCreatedEvent)

      expect(github.pullRequests.get).toHaveBeenCalledTimes(3)
      expect(github.issues.createComment).toHaveBeenCalledTimes(2)
      expect(utils.backportToBranch).toHaveBeenCalledTimes(2)
    })

    it('does not manually trigger the backport on comment to a targetted branch if the branch does not exist', async () => {
      utils.backportToBranch = jest.fn()
      github.repos.getBranch = jest.fn().mockReturnValue(Promise.reject(new Error('404')))
      await robot.receive(issueCommentBackportToCreatedEvent)

      expect(github.pullRequests.get).toHaveBeenCalled()
      expect(github.issues.createComment).toHaveBeenCalled()
      expect(utils.backportToBranch).toHaveBeenCalledTimes(0)
    })
  })

  describe('pull_request.closed event', () => {
    it('begins the backporting process if the PR was merged', async () => {
      utils.backportToLabel = jest.fn()
      await robot.receive(prClosedEvent)

      expect(utils.backportToLabel).toHaveBeenCalled()
    })
  })
})
