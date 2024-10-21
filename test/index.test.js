'use strict';

const { assert } = require('chai');
const mockery = require('mockery');
const sinon = require('sinon');
const testCommands = require('./data/commands.json');
const testReadOnlyCommandsHttps = require('./data/readOnlyCommandsHttps.json');
const testReadOnlyCommandsSsh = require('./data/readOnlyCommandsSsh.json');
const testPrCommands = require('./data/prCommands.json');
const testCustomPrCommands = require('./data/customPrCommands.json');
const testCommitBranchCommands = require('./data/commitBranchCommands.json');
const testChildCommands = require('./data/childCommands.json');
const testRootDirCommands = require('./data/rootDirCommands.json');
const testPayloadOpen = require('./data/pr.opened.json');
const testPayloadSync = require('./data/pr.sync.json');
const testPayloadClose = require('./data/pr.closed.json');
const testPayloadPrCommentCreate = require('./data/pr.commentCreate.json');
const testPayloadFork = require('./data/repo.fork.json');
const testPayloadPush = require('./data/repo.push.json');
const testPayloadIssueCreate = require('./data/issue.create.json');
const testPayloadAccessToken = require('./data/access.token.json');
const token = 'myAccessToken';
const systemToken = 'myAccessToken2';
const API_URL_V2 = 'https://api.bitbucket.org/2.0';

sinon.assert.expose(assert, { prefix: '' });

describe('index', function () {
    // Time not important. Only life important.
    this.timeout(5000);

    let BitbucketScm;
    let scm;
    let requestMock;

    before(() => {
        mockery.enable({
            useCleanCache: true,
            warnOnUnregistered: false
        });
    });

    beforeEach(() => {
        requestMock = sinon.stub();

        mockery.registerMock('screwdriver-request', requestMock);

        /* eslint-disable global-require */
        BitbucketScm = require('../index');
        /* eslint-enable global-require */

        scm = new BitbucketScm({
            fusebox: {
                retry: {
                    minTimeout: 1
                }
            },
            oauthClientId: 'myclientid',
            oauthClientSecret: 'myclientsecret'
        });
        // set the system tokens so that the system tokens are not attempted to be loaded
        scm.token = systemToken;
        scm.refreshToken = 'myRefreshToken2';
        scm.expiresIn = new Date().getTime() + 7200 * 1000;
    });

    afterEach(() => {
        mockery.deregisterAll();
        mockery.resetCache();
    });

    after(() => {
        mockery.disable();
    });

    describe('constructor', () => {
        it('validates input', () => {
            try {
                scm = new BitbucketScm();
                assert.fail('should not get here');
            } catch (err) {
                assert.instanceOf(err, Error);
                assert.equal(err.name, 'ValidationError');
            }
        });
        it('constructs successfully', () => {
            const testScm = new BitbucketScm({
                oauthClientId: 'myclientid',
                oauthClientSecret: 'myclientsecret',
                username: 'abcd',
                email: 'dev-null@my.email.com'
            });

            assert.deepEqual(testScm.config, {
                oauthClientId: 'myclientid',
                oauthClientSecret: 'myclientsecret',
                username: 'abcd',
                email: 'dev-null@my.email.com',
                fusebox: {},
                readOnly: {},
                https: false
            });
        });
    });

    describe('parseUrl', () => {
        const apiUrl = `${API_URL_V2}/repositories/batman/test/refs/branches`;
        let fakeResponse;
        let expectedOptions;

        beforeEach(() => {
            fakeResponse = {
                statusCode: 200,
                body: {
                    target: {
                        repository: {
                            html: {
                                href: 'https://bitbucket.org/batman/test'
                            },
                            type: 'repository',
                            name: 'test',
                            full_name: 'batman/test',
                            uuid: '{de7d7695-1196-46a1-b87d-371b7b2945ab}'
                        }
                    }
                }
            };
            expectedOptions = {
                url: `${apiUrl}/mynewbranch`,
                method: 'GET',
                context: {
                    token: systemToken
                }
            };
            requestMock.resolves(fakeResponse);
        });

        it('resolves to the correct parsed url for ssh', () => {
            const expected = 'bitbucket.org:batman/{de7d7695-1196-46a1-b87d-371b7b2945ab}:master';

            expectedOptions = {
                url: `${apiUrl}/master`,
                method: 'GET',
                context: {
                    token: systemToken
                }
            };

            return scm
                .parseUrl({
                    checkoutUrl: 'git@bitbucket.org:batman/test.git#master',
                    token
                })
                .then(parsed => {
                    assert.calledWith(requestMock, expectedOptions);
                    assert.equal(parsed, expected);
                });
        });

        it('resolves to the correct parsed url for ssh wtih default branch', () => {
            const expected = 'bitbucket.org:batman/{de7d7695-1196-46a1-b87d-371b7b2945ab}:master';

            expectedOptions = {
                url: `${apiUrl}/master`,
                method: 'GET',
                context: {
                    token: systemToken
                }
            };

            return scm
                .parseUrl({
                    checkoutUrl: 'git@bitbucket.org:batman/test.git',
                    token
                })
                .then(parsed => {
                    assert.calledWith(requestMock, expectedOptions);
                    assert.equal(parsed, expected);
                });
        });

        it('resolves to the correct parsed url for https', () => {
            const expected = 'bitbucket.org:batman/{de7d7695-1196-46a1-b87d-371b7b2945ab}:mynewbranch';

            return scm
                .parseUrl({
                    checkoutUrl: 'https://batman@bitbucket.org/batman/test.git#mynewbranch',
                    token
                })
                .then(parsed => {
                    assert.calledWith(requestMock, expectedOptions);
                    assert.equal(parsed, expected);
                });
        });

        it('resolves to the correct parsed url for rootDir', () => {
            // eslint-disable-next-line max-len
            const expected = 'bitbucket.org:batman/{de7d7695-1196-46a1-b87d-371b7b2945ab}:mynewbranch:path/to/root';

            // eslint-disable-next-line max-len
            expectedOptions.url = 'https://api.bitbucket.org/2.0/repositories/batman/test/refs/branches/mynewbranch';

            return scm
                .parseUrl({
                    // eslint-disable-next-line max-len
                    checkoutUrl: 'https://batman@bitbucket.org/batman/test.git#mynewbranch:path/to/root',
                    token,
                    rootDir: 'path/to/root'
                })
                .then(parsed => {
                    assert.calledWith(requestMock, expectedOptions);
                    assert.equal(parsed, expected);
                });
        });

        it('resolves to the correct parsed url for rootDir in checkoutUrl', () => {
            // eslint-disable-next-line max-len
            const expected = 'bitbucket.org:batman/{de7d7695-1196-46a1-b87d-371b7b2945ab}:mynewbranch:path/to/root';

            // eslint-disable-next-line max-len
            expectedOptions.url = 'https://api.bitbucket.org/2.0/repositories/batman/test/refs/branches/mynewbranch';

            return scm
                .parseUrl({
                    // eslint-disable-next-line max-len
                    checkoutUrl: 'https://batman@bitbucket.org/batman/test.git#mynewbranch:path/to/root',
                    token,
                    rootDir: ''
                })
                .then(parsed => {
                    assert.calledWith(requestMock, expectedOptions);
                    assert.equal(parsed, expected);
                });
        });

        it('rejects when unable to match', () => {
            const invalidCheckoutUrl = 'invalidCheckoutUrl';

            // eslint-disable-next-line no-underscore-dangle
            return scm
                ._parseUrl({
                    checkoutUrl: invalidCheckoutUrl,
                    token
                })
                .then(
                    () => {
                        assert.fail('This should not fail the test');
                    },
                    err => {
                        assert.match(err.message, /Invalid scmUrl/);
                    }
                );
        });

        it('rejects if request fails', () => {
            const err = new Error('Bitbucket API error');

            requestMock.rejects(err);

            return scm
                .parseUrl({
                    checkoutUrl: 'https://batman@bitbucket.org/batman/test.git#mynewbranch',
                    token
                })
                .then(() => assert.fail('Should not get here'))
                .catch(error => {
                    assert.calledWith(requestMock, expectedOptions);
                    assert.deepEqual(error, err);
                });
        });

        it('rejects if status code is 404', () => {
            const err = new Error('Cannot find repository');

            err.statusCode = 404;
            requestMock.rejects(err);

            return scm
                .parseUrl({
                    checkoutUrl: 'https://batman@bitbucket.org/batman/test.git#mynewbranch',
                    token
                })
                .then(() => assert.fail('Should not get here'))
                .catch(error => {
                    assert.calledWith(requestMock, expectedOptions);
                    assert.match(error.message, 'Cannot find repository');
                });
        });

        it('rejects when passed checkoutUrl of another host', () => {
            const expectedError = new Error('This checkoutUrl is not supported for your current login host.');

            return scm
                .parseUrl({
                    checkoutUrl: 'git@bitbucket.corp.jp:batman/test.git#master',
                    token
                })
                .then(() => assert.fail('Should not get here'))
                .catch(error => {
                    assert.match(error.message, expectedError.message);
                });
        });
    });

    describe('getChangedFiles', () => {
        it('resolves null', () => {
            scm.getChangedFiles({
                type: 'pr',
                payload: testPayloadOpen,
                token: 'thisisatoken'
            }).then(result => assert.isNull(result));
        });
    });

    describe('parseHook', () => {
        it('resolves the correct parsed config for opened PR', () => {
            const expected = {
                type: 'pr',
                action: 'opened',
                username: '{2dca4f54-ab3f-400c-a777-c059e1ac0394}',
                checkoutUrl: 'https://bitbucket.org/batman/test.git',
                branch: 'master',
                sha: '40171b678527',
                prNum: 3,
                prRef: 'mynewbranch',
                hookId: '1e8d4e8e-5fcf-4624-b091-b10bd6ecaf5e',
                scmContext: 'bitbucket:bitbucket.org'
            };
            const headers = {
                'x-event-key': 'pullrequest:created',
                'x-request-uuid': '1e8d4e8e-5fcf-4624-b091-b10bd6ecaf5e'
            };

            return scm.parseHook(headers, testPayloadOpen).then(result => assert.deepEqual(result, expected));
        });

        it('resolves the correct parsed config for sync PR (ammending commit)', () => {
            const expected = {
                type: 'pr',
                action: 'synchronized',
                username: '{2dca4f54-ab3f-400c-a777-c059e1ac0394}',
                checkoutUrl: 'https://bitbucket.org/batman/test.git',
                branch: 'master',
                sha: 'caeae8cd5fc9',
                prNum: 7,
                prRef: 'prbranch',
                hookId: '1e8d4e8e-5fcf-4624-b091-b10bd6ecaf5e',
                scmContext: 'bitbucket:bitbucket.org'
            };
            const headers = {
                'x-event-key': 'pullrequest:updated',
                'x-request-uuid': '1e8d4e8e-5fcf-4624-b091-b10bd6ecaf5e'
            };

            return scm.parseHook(headers, testPayloadSync).then(result => assert.deepEqual(result, expected));
        });

        it('resolves the correct parsed config for closed PR after merged', () => {
            const expected = {
                type: 'pr',
                action: 'closed',
                username: '{2dca4f54-ab3f-400c-a777-c059e1ac0394}',
                checkoutUrl: 'https://bitbucket.org/batman/test.git',
                branch: 'master',
                sha: '40171b678527',
                prNum: 3,
                prRef: 'mynewbranch',
                hookId: '1e8d4e8e-5fcf-4624-b091-b10bd6ecaf5e',
                scmContext: 'bitbucket:bitbucket.org'
            };
            const headers = {
                'x-event-key': 'pullrequest:fullfilled',
                'x-request-uuid': '1e8d4e8e-5fcf-4624-b091-b10bd6ecaf5e'
            };

            return scm.parseHook(headers, testPayloadClose).then(result => assert.deepEqual(result, expected));
        });

        it('resolves the correct parsed config for closed PR after declined', () => {
            const expected = {
                type: 'pr',
                action: 'closed',
                username: '{2dca4f54-ab3f-400c-a777-c059e1ac0394}',
                checkoutUrl: 'https://bitbucket.org/batman/test.git',
                branch: 'master',
                sha: '40171b678527',
                prNum: 3,
                prRef: 'mynewbranch',
                hookId: '1e8d4e8e-5fcf-4624-b091-b10bd6ecaf5e',
                scmContext: 'bitbucket:bitbucket.org'
            };
            const headers = {
                'x-event-key': 'pullrequest:rejected',
                'x-request-uuid': '1e8d4e8e-5fcf-4624-b091-b10bd6ecaf5e'
            };

            return scm.parseHook(headers, testPayloadClose).then(result => assert.deepEqual(result, expected));
        });

        it('resolves the correct parsed config for push to repo event', () => {
            const expected = {
                type: 'repo',
                action: 'push',
                username: '{2dca4f54-ab3f-400c-a777-c059e1ac0394}',
                checkoutUrl: 'https://bitbucket.org/batman/test.git',
                branch: 'stuff',
                sha: '9ff49b2d1437567cad2b5fed7a0706472131e927',
                lastCommitMessage: 'testpayload\n',
                hookId: '1e8d4e8e-5fcf-4624-b091-b10bd6ecaf5e',
                scmContext: 'bitbucket:bitbucket.org'
            };
            const headers = {
                'x-event-key': 'repo:push',
                'x-request-uuid': '1e8d4e8e-5fcf-4624-b091-b10bd6ecaf5e'
            };

            return scm.parseHook(headers, testPayloadPush).then(result => assert.deepEqual(result, expected));
        });

        it('resolves null if events are not supported: repoFork', () => {
            const repoFork = {
                'x-event-key': 'repo:fork'
            };

            return scm.parseHook(repoFork, testPayloadFork).then(result => assert.deepEqual(result, null));
        });

        it('resolves null if events are not supported: prComment', () => {
            const prComment = {
                'x-event-key': 'pullrequest:comment_created'
            };

            return scm.parseHook(prComment, testPayloadPrCommentCreate).then(result => assert.deepEqual(result, null));
        });

        it('resolves null if events are not supported: issueCreated', () => {
            const issueCreated = {
                'x-event-key': 'issue:created'
            };

            return scm.parseHook(issueCreated, testPayloadIssueCreate).then(result => assert.deepEqual(result, null));
        });
    });

    describe('decorateAuthor', () => {
        const apiUrl = `${API_URL_V2}/users/%7B4f1a9b7f-586e-4e80-b9eb-a7589b4a165f%7D`;
        const expectedOptions = {
            url: apiUrl,
            method: 'GET',
            context: {
                token: systemToken
            }
        };
        let fakeResponse;

        beforeEach(() => {
            fakeResponse = {
                statusCode: 200,
                body: {
                    display_name: 'Batman',
                    uuid: '{4f1a9b7f-586e-4e80-b9eb-a7589b4a165f}',
                    links: {
                        html: {
                            href: 'https://bitbucket.org/%7B4f1a9b7f-586e-4e80-b9eb-a7589b4a165f%7D/' // eslint-disable-line max-len
                        },
                        avatar: {
                            href: 'https://bitbucket.org/account/batman/avatar/32/'
                        }
                    }
                }
            };
            requestMock.resolves(fakeResponse);
        });

        it('resolves to correct decorated author', () => {
            const expected = {
                id: '{4f1a9b7f-586e-4e80-b9eb-a7589b4a165f}',
                url: 'https://bitbucket.org/%7B4f1a9b7f-586e-4e80-b9eb-a7589b4a165f%7D/',
                name: 'Batman',
                username: '{4f1a9b7f-586e-4e80-b9eb-a7589b4a165f}',
                avatar: 'https://bitbucket.org/account/batman/avatar/32/'
            };

            return scm
                .decorateAuthor({
                    username: '{4f1a9b7f-586e-4e80-b9eb-a7589b4a165f}',
                    token
                })
                .then(decorated => {
                    assert.calledWith(requestMock, expectedOptions);
                    assert.deepEqual(decorated, expected);
                });
        });
        it('resolves to a fabricated decorated author', () => {
            fakeResponse = {
                statusCode: 404,
                body: {
                    error: {
                        message: 'Resource not found',
                        detail: 'There is no API hosted at this URL'
                    }
                }
            };

            requestMock.rejects(fakeResponse);

            const expected = {
                url: '',
                name: 'batman',
                username: 'batman',
                avatar: ''
            };
            const expectedFabricatedOptions = {
                url: `${API_URL_V2}/users/batman`,
                method: 'GET',
                context: {
                    token: systemToken
                }
            };

            return scm
                .decorateAuthor({
                    username: 'batman',
                    token
                })
                .then(decorated => {
                    assert.calledWith(requestMock, expectedFabricatedOptions);
                    assert.deepEqual(decorated, expected);
                });
        });

        it('rejects if fails', () => {
            const err = new Error('Bitbucket API error');

            requestMock.rejects(err);

            return scm
                .decorateAuthor({
                    username: '{4f1a9b7f-586e-4e80-b9eb-a7589b4a165f}',
                    token
                })
                .then(() => {
                    assert.fail('Should not get here');
                })
                .catch(error => {
                    assert.calledWith(requestMock, expectedOptions);
                    assert.equal(error, err);
                });
        });
    });

    describe('_decorateUrl', () => {
        const apiUrl = `${API_URL_V2}/repositories/repoId`;
        const selfLink = 'https://bitbucket.org/d2lam2/test';
        const repoOptions = {
            url: apiUrl,
            method: 'GET',
            context: {
                token: systemToken
            }
        };
        let fakeResponse;
        let expectedOptions;

        beforeEach(() => {
            fakeResponse = {
                statusCode: 200,
                body: {
                    full_name: 'username/branchName',
                    links: {
                        html: {
                            href: selfLink
                        }
                    }
                }
            };
            expectedOptions = {
                url: apiUrl,
                method: 'GET',
                context: {
                    token: systemToken
                }
            };
            requestMock.withArgs(repoOptions).resolves(fakeResponse);
        });

        it('resolves to correct decorated url object', () => {
            const expected = {
                url: selfLink,
                name: 'username/branchName',
                branch: 'branchName',
                rootDir: ''
            };

            return scm
                .decorateUrl({
                    scmUri: 'hostName:repoId:branchName',
                    token
                })
                .then(decorated => {
                    assert.calledWith(requestMock, expectedOptions);
                    assert.deepEqual(decorated, expected);
                });
        });

        it('rejects if fails', () => {
            const err = new Error('Bitbucket API error');

            requestMock.withArgs(repoOptions).rejects(err);

            return scm
                .decorateUrl({
                    scmUri: 'repoName:repoId:branchName',
                    token
                })
                .then(() => {
                    assert.fail('Should not get here');
                })
                .catch(error => {
                    assert.called(requestMock);
                    assert.equal(error, err);
                });
        });
    });

    describe('_decorateCommit', () => {
        const sha = '1111111111111111111111111111111111111111';
        const repoUrl = `${API_URL_V2}/repositories/repoId/commit/${sha}`;
        const authorUrl = `${API_URL_V2}/users/%7Buuid%7D`;
        const selfLink = `https://bitbucket.org/repoId/commits/${sha}`;
        const repoOptions = {
            url: repoUrl,
            method: 'GET',
            context: {
                token: systemToken
            }
        };
        const authorOptions = {
            url: authorUrl,
            method: 'GET',
            context: {
                token: systemToken
            }
        };
        let fakeResponse;
        let fakeAuthorResponse;

        beforeEach(() => {
            fakeResponse = {
                statusCode: 200,
                body: {
                    message: 'testing',
                    links: {
                        html: {
                            href: selfLink
                        }
                    },
                    author: {
                        user: {
                            uuid: '{uuid}'
                        }
                    }
                }
            };
            fakeAuthorResponse = {
                statusCode: 200,
                body: {
                    display_name: 'displayName',
                    uuid: '{uuid}',
                    links: {
                        html: {
                            href: 'https://bitbucket.org/%7Buuid%7D/'
                        },
                        avatar: {
                            href: 'https://bitbucket.org/account/%7Buuid%7D/avatar/32/'
                        }
                    }
                }
            };
            requestMock.withArgs(repoOptions).resolves(fakeResponse);
            requestMock.withArgs(authorOptions).resolves(fakeAuthorResponse);
        });

        it('resolves to correct decorated object', () => {
            const expected = {
                url: selfLink,
                message: 'testing',
                author: {
                    id: '{uuid}',
                    url: 'https://bitbucket.org/%7Buuid%7D/',
                    name: 'displayName',
                    username: '{uuid}',
                    avatar: 'https://bitbucket.org/account/%7Buuid%7D/avatar/32/'
                }
            };

            return scm
                .decorateCommit({
                    sha,
                    scmUri: 'hostName:repoId:branchName',
                    token
                })
                .then(decorated => {
                    assert.calledTwice(requestMock);
                    assert.deepEqual(decorated, expected);
                });
        });

        it('rejects if fails', () => {
            const err = new Error('Bitbucket API error');

            requestMock.withArgs(repoOptions).rejects(err);

            return scm
                .decorateCommit({
                    sha,
                    scmUri: 'hostName:repoId:branchName',
                    token
                })
                .then(() => {
                    assert.fail('Should not get here');
                })
                .catch(error => {
                    assert.called(requestMock);
                    assert.equal(error, err);
                });
        });
    });

    describe('_getCommitSha', () => {
        const apiUrl = `${API_URL_V2}/repositories/repoId/refs/branches/branchName`;
        const scmUri = 'hostName:repoId:branchName';
        const expectedOptions = {
            url: apiUrl,
            method: 'GET',
            context: {
                token: systemToken
            }
        };
        let fakeResponse;

        beforeEach(() => {
            fakeResponse = {
                statusCode: 200,
                body: {
                    target: {
                        hash: 'hashValue'
                    }
                }
            };
            requestMock.resolves(fakeResponse);
        });

        it('resolves to correct commit sha without prNum', () =>
            scm
                .getCommitSha({
                    scmUri,
                    token
                })
                .then(sha => {
                    assert.calledWith(requestMock, expectedOptions);
                    assert.deepEqual(sha, 'hashValue');
                }));

        it('resolves to correct commit sha with prNum', () => {
            const prNum = 1;
            const prExpectedOptions = {
                url: `${API_URL_V2}/repositories/repoId/pullrequests/${prNum}`,
                method: 'GET',
                context: {
                    token: systemToken
                }
            };

            requestMock.resolves({
                body: {
                    links: {
                        html: {
                            href: 'https://bitbucket.org/2.0/repositories/repoId/pullrequests/1'
                        }
                    },
                    id: 1,
                    source: {
                        branch: {
                            name: 'testbranch'
                        },
                        commit: {
                            hash: 'hashValue'
                        }
                    }
                },
                statusCode: 200
            });

            return scm
                .getCommitSha({
                    scmUri,
                    token,
                    prNum: 1
                })
                .then(sha => {
                    assert.calledWith(requestMock, prExpectedOptions);
                    assert.deepEqual(sha, 'hashValue');
                });
        });

        it('rejects if fails', () => {
            const err = new Error('Bitbucket API error');

            requestMock.rejects(err);

            return scm
                .getCommitSha({
                    scmUri,
                    token
                })
                .then(() => {
                    assert.fail('Should not get here');
                })
                .catch(error => {
                    assert.calledWith(requestMock, expectedOptions);
                    assert.equal(error, err);
                });
        });
    });

    describe('_getFile', () => {
        const apiUrl = `${API_URL_V2}/repositories/repoId/src/branchName/path/to/file.txt`;
        let expectedOptions;
        let fakeResponse;
        let params;
        let scmUri;

        beforeEach(() => {
            expectedOptions = {
                url: apiUrl,
                method: 'GET',
                context: {
                    token: systemToken
                },
                responseType: 'buffer'
            };
            fakeResponse = {
                statusCode: 200,
                body: 'dataValue'
            };
            requestMock.resolves(fakeResponse);
            scmUri = 'hostName:repoId:branchName';
            params = {
                scmUri,
                token,
                path: 'path/to/file.txt'
            };
        });

        it('resolves to correct commit sha', () =>
            scm.getFile(params).then(content => {
                assert.calledWith(requestMock, expectedOptions);
                assert.deepEqual(content, 'dataValue');
            }));

        it('resolves to correct commit sha with rootDir', () => {
            scmUri = 'hostName:repoId:branchName:src/app/component';
            params = {
                scmUri,
                token,
                path: 'path/to/file.txt'
            };
            // eslint-disable-next-line max-len
            expectedOptions.url =
                'https://api.bitbucket.org/2.0/repositories/repoId/src/branchName/src/app/component/path/to/file.txt';

            return scm.getFile(params).then(content => {
                assert.calledWith(requestMock, expectedOptions);
                assert.deepEqual(content, 'dataValue');
            });
        });

        it('resolves to correct commit sha with fullPath', () => {
            scmUri = 'hostName:repoId:branchName:src/app/component';
            params = {
                scmUri,
                token,
                path: 'git@bitbucket.org:screwdriver-cd/reponame.git#main:path/to/file.txt'
            };
            expectedOptions.url =
                'https://api.bitbucket.org/2.0/repositories/screwdriver-cd/reponame/src/main/path/to/file.txt';

            return scm.getFile(params).then(content => {
                assert.calledWith(requestMock, expectedOptions);
                assert.deepEqual(content, 'dataValue');
            });
        });

        it('rejects if status code is not 200', () => {
            fakeResponse = {
                statusCode: 404,
                body: {
                    error: {
                        message: 'Resource not found',
                        detail: 'There is no API hosted at this URL'
                    }
                }
            };

            requestMock.rejects(fakeResponse);

            return scm.getFile(params).then(content => {
                assert.calledWith(requestMock, expectedOptions);
                assert.deepEqual(content, '');
            });
        });

        it('rejects if fails', () => {
            const err = new Error('Bitbucket API error');

            requestMock.rejects(err);

            return scm
                .getFile(params)
                .then(() => {
                    assert.fail('Should not get here');
                })
                .catch(error => {
                    assert.calledWith(requestMock, expectedOptions);
                    assert.equal(error, err);
                });
        });
    });

    describe('_getPermissions', () => {
        const baseRequestOptions = {
            method: 'GET',
            context: {
                token
            }
        };
        const repos = [
            { ...baseRequestOptions, url: `${API_URL_V2}/repositories/repoIdPrefix/repoIdSuffix` },
            { ...baseRequestOptions, url: `${API_URL_V2}/repositories/repoIdPrefix/repoIdSuffix1` },
            { ...baseRequestOptions, url: `${API_URL_V2}/repositories/repoIdPrefix/repoIdSuffix2` },
            { ...baseRequestOptions, url: `${API_URL_V2}/repositories/repoIdPrefix/repoIdSuffix3` },
            { ...baseRequestOptions, url: `${API_URL_V2}/repositories/repoIdPrefix/fake` }
        ];

        const pull = {
            ...baseRequestOptions,
            url: `${API_URL_V2}/repositories/repoIdPrefix?q=uuid%3D%22repoIdSuffix%22`
        };
        const pulls = [
            { ...baseRequestOptions, url: `${API_URL_V2}/repositories/repoIdPrefix?q=uuid%3D%22repoIdSuffix%22` },
            { ...baseRequestOptions, url: `${API_URL_V2}/repositories/repoIdPrefix?q=uuid%3D%22repoIdSuffix1%22` },
            { ...baseRequestOptions, url: `${API_URL_V2}/repositories/repoIdPrefix?q=uuid%3D%22repoIdSuffix2%22` },
            { ...baseRequestOptions, url: `${API_URL_V2}/repositories/repoIdPrefix?q=uuid%3D%22repoIdSuffix3%22` }
        ];
        const pushes = [
            {
                ...baseRequestOptions,
                url: `${API_URL_V2}/repositories/repoIdPrefix?q=uuid%3D%22repoIdSuffix%22&role=contributor`
            },
            {
                ...baseRequestOptions,
                url: `${API_URL_V2}/repositories/repoIdPrefix?q=uuid%3D%22repoIdSuffix1%22&role=contributor`
            },
            {
                ...baseRequestOptions,
                url: `${API_URL_V2}/repositories/repoIdPrefix?q=uuid%3D%22repoIdSuffix2%22&role=contributor`
            },
            {
                ...baseRequestOptions,
                url: `${API_URL_V2}/repositories/repoIdPrefix?q=uuid%3D%22repoIdSuffix3%22&role=contributor`
            }
        ];
        const admins = [
            {
                ...baseRequestOptions,
                url: `${API_URL_V2}/repositories/repoIdPrefix?q=uuid%3D%22repoIdSuffix%22&role=admin`
            },
            {
                ...baseRequestOptions,
                url: `${API_URL_V2}/repositories/repoIdPrefix?q=uuid%3D%22repoIdSuffix1%22&role=admin`
            },
            {
                ...baseRequestOptions,
                url: `${API_URL_V2}/repositories/repoIdPrefix?q=uuid%3D%22repoIdSuffix2%22&role=admin`
            },
            {
                ...baseRequestOptions,
                url: `${API_URL_V2}/repositories/repoIdPrefix?q=uuid%3D%22repoIdSuffix3%22&role=admin`
            }
        ];

        const repoResponse = {
            statusCode: 200,
            body: {}
        };
        const repoNotFoundResponse = {
            statusCode: 404,
            body: 'Not found'
        };

        const readResponses = [
            {
                statusCode: 200,
                body: {
                    values: [{ uuid: 'repoIdSuffix1' }]
                }
            },
            {
                statusCode: 200,
                body: {
                    values: [{ uuid: 'repoIdSuffix2' }]
                }
            },
            {
                statusCode: 200,
                body: {
                    values: [{ uuid: 'repoIdSuffix3' }]
                }
            }
        ];
        const writeResponses = [
            {
                statusCode: 200,
                body: {
                    values: [{ uuid: 'repoIdSuffix1' }]
                }
            },
            {
                statusCode: 200,
                body: {
                    values: [{ uuid: 'repoIdSuffix2' }]
                }
            }
        ];
        const adminResponse = {
            statusCode: 200,
            body: {
                values: [{ uuid: 'repoIdSuffix1' }]
            }
        };

        beforeEach(() => {
            requestMock.withArgs(repos[0]).resolves(repoResponse);
            requestMock.withArgs(repos[1]).resolves(repoResponse);
            requestMock.withArgs(repos[2]).resolves(repoResponse);
            requestMock.withArgs(repos[3]).resolves(repoResponse);
            requestMock.withArgs(repos[4]).rejects(repoNotFoundResponse);

            requestMock.withArgs(pulls[0]).resolves(repoResponse);
            requestMock.withArgs(pulls[1]).resolves(readResponses[0]);
            requestMock.withArgs(pulls[2]).resolves(readResponses[1]);
            requestMock.withArgs(pulls[3]).resolves(readResponses[2]);

            requestMock.withArgs(pushes[0]).resolves(repoResponse);
            requestMock.withArgs(pushes[1]).resolves(writeResponses[0]);
            requestMock.withArgs(pushes[2]).resolves(writeResponses[1]);
            requestMock.withArgs(pushes[3]).resolves(repoResponse);

            requestMock.withArgs(admins[0]).resolves(repoResponse);
            requestMock.withArgs(admins[1]).resolves(adminResponse);
            requestMock.withArgs(admins[2]).resolves(repoResponse);
            requestMock.withArgs(admins[3]).resolves(repoResponse);
        });

        it('get correct admin permissions', () => {
            const scmUri = 'hostName:repoIdPrefix/repoIdSuffix1:branchName';

            return scm
                .getPermissions({
                    scmUri,
                    token
                })
                .then(permissions => {
                    assert.callCount(requestMock, 4);
                    assert.calledWith(requestMock, repos[1]);
                    assert.calledWith(requestMock, pulls[1]);
                    assert.calledWith(requestMock, pushes[1]);
                    assert.calledWith(requestMock, admins[1]);
                    assert.deepEqual(permissions, {
                        admin: true,
                        push: true,
                        pull: true
                    });
                });
        });

        it('get correct push permissions', () => {
            const scmUri = 'hostName:repoIdPrefix/repoIdSuffix2:branchName';

            return scm
                .getPermissions({
                    scmUri,
                    token
                })
                .then(permissions => {
                    assert.callCount(requestMock, 4);
                    assert.calledWith(requestMock, repos[2]);
                    assert.calledWith(requestMock, pulls[2]);
                    assert.calledWith(requestMock, pushes[2]);
                    assert.calledWith(requestMock, admins[2]);
                    assert.deepEqual(permissions, {
                        admin: false,
                        push: true,
                        pull: true
                    });
                });
        });

        it('get correct pull permissions', () => {
            const scmUri = 'hostName:repoIdPrefix/repoIdSuffix3:branchName';

            return scm
                .getPermissions({
                    scmUri,
                    token
                })
                .then(permissions => {
                    assert.callCount(requestMock, 4);
                    assert.calledWith(requestMock, repos[3]);
                    assert.calledWith(requestMock, pulls[3]);
                    assert.calledWith(requestMock, pushes[3]);
                    assert.calledWith(requestMock, admins[3]);
                    assert.deepEqual(permissions, {
                        admin: false,
                        push: false,
                        pull: true
                    });
                });
        });

        it('no permissions', () => {
            const scmUri = 'hostName:repoIdPrefix/repoIdSuffix:branchName';

            return scm
                .getPermissions({
                    scmUri,
                    token
                })
                .then(permissions => {
                    assert.deepEqual(permissions, {
                        admin: false,
                        push: false,
                        pull: false
                    });
                });
        });

        it('rejects if fails', () => {
            const error = new Error('Bitbucket API error');
            const scmUri = 'hostName:repoIdPrefix/repoIdSuffix:branchName';

            requestMock.withArgs(pull).rejects(error);

            return scm
                .getPermissions({
                    scmUri,
                    token
                })
                .then(() => {
                    assert.fail('Should not get here');
                })
                .catch(err => {
                    assert.equal(error, err);
                });
        });

        it('rejects if the repository does not exist', () => {
            const error = new Error('Not found');
            const scmUri = 'hostName:repoIdPrefix/fake:branchName';

            error.statusCode = 404;

            return scm
                .getPermissions({
                    scmUri,
                    token
                })
                .then(() => {
                    assert.fail('Should not get here');
                })
                .catch(err => {
                    assert.equal(err.message, err.message);
                });
        });
    });

    describe('_updateCommitStatus', () => {
        let config;
        let apiUrl;
        let fakeResponse;
        let expectedOptions;

        beforeEach(() => {
            config = {
                scmUri: 'hostName:repoId:branchName',
                sha: '1111111111111111111111111111111111111111',
                buildStatus: 'SUCCESS',
                token: 'bearerToken',
                url: 'http://valid.url',
                jobName: 'main',
                pipelineId: 123
            };
            apiUrl = `${API_URL_V2}/repositories/repoId/commit/${config.sha}/statuses/build`;
            fakeResponse = {
                statusCode: 201
            };
            expectedOptions = {
                url: apiUrl,
                method: 'POST',
                json: {
                    url: config.url,
                    state: 'SUCCESSFUL',
                    key: config.sha,
                    description: 'Screwdriver/123/main'
                },
                context: {
                    token: 'bearerToken'
                }
            };
            requestMock.resolves(fakeResponse);
        });

        it('successfully update status for PR', () => {
            config.jobName = 'PR-1';
            expectedOptions.json.description = 'Screwdriver/123/PR';

            return scm.updateCommitStatus(config).then(() => {
                assert.calledWith(requestMock, expectedOptions);
            });
        });

        it('successfully update status', () =>
            scm.updateCommitStatus(config).then(() => {
                assert.calledWith(requestMock, expectedOptions);
            }));

        it('rejects if fails', () => {
            const err = new Error('Bitbucket API error');

            requestMock.rejects(err);

            return scm
                .updateCommitStatus(config)
                .then(() => {
                    assert.fail('Should not get here');
                })
                .catch(error => {
                    assert.calledWith(requestMock, expectedOptions);
                    assert.equal(error, err);
                });
        });
    });

    describe('getBellConfiguration', () => {
        it('resolves a default configuration', () =>
            scm.getBellConfiguration().then(config => {
                assert.deepEqual(config, {
                    'bitbucket:bitbucket.org': {
                        clientId: 'myclientid',
                        clientSecret: 'myclientsecret',
                        forceHttps: false,
                        isSecure: false,
                        provider: 'bitbucket',
                        cookie: 'bitbucket-bitbucket.org'
                    }
                });
            }));
    });

    describe('getCheckoutCommand', () => {
        let config;

        beforeEach(() => {
            config = {
                branch: 'branchName',
                host: 'hostName',
                org: 'orgName',
                repo: 'repoName',
                sha: 'shaValue'
            };
        });

        it('resolves checkout command without prRef', () =>
            scm.getCheckoutCommand(config).then(command => {
                assert.deepEqual(command, testCommands);
            }));

        it('gets the checkout command with https clone type when read-only is enabled', () => {
            scm = new BitbucketScm({
                oauthClientId: 'myclientid',
                oauthClientSecret: 'myclientsecret',
                username: 'abcd',
                email: 'dev-null@my.email.com',
                readOnly: {
                    enabled: true,
                    cloneType: 'https'
                }
            });

            return scm.getCheckoutCommand(config).then(command => {
                assert.deepEqual(command, testReadOnlyCommandsHttps);
            });
        });

        it('gets the checkout command with ssh clone type when read-only is enabled', () => {
            scm = new BitbucketScm({
                oauthClientId: 'myclientid',
                oauthClientSecret: 'myclientsecret',
                username: 'abcd',
                email: 'dev-null@my.email.com',
                readOnly: {
                    enabled: true,
                    cloneType: 'ssh'
                }
            });

            return scm.getCheckoutCommand(config).then(command => {
                assert.deepEqual(command, testReadOnlyCommandsSsh);
            });
        });

        it('resolves checkout command with prRef', () => {
            config.prRef = 'prBranch';

            return scm.getCheckoutCommand(config).then(command => {
                assert.deepEqual(command, testPrCommands);
            });
        });

        it('resolves checkout command with custom username and email', () => {
            config.prRef = 'prBranch';

            scm = new BitbucketScm({
                oauthClientId: 'myclientid',
                oauthClientSecret: 'myclientsecret',
                username: 'abcd',
                email: 'dev-null@my.email.com'
            });

            return scm.getCheckoutCommand(config).then(command => {
                assert.deepEqual(command, testCustomPrCommands);
            });
        });

        it('resolves checkout command with commit branch', () => {
            config.commitBranch = 'commitBranch';

            return scm.getCheckoutCommand(config).then(command => {
                assert.deepEqual(command, testCommitBranchCommands);
            });
        });

        it('resolves to get the checkout command for a child pipeline', () => {
            config.parentConfig = {
                branch: 'master',
                host: 'github.com',
                org: 'screwdriver-cd',
                repo: 'parent-repo',
                sha: '54321'
            };

            return scm.getCheckoutCommand(config).then(command => {
                assert.deepEqual(command, testChildCommands);
            });
        });

        it('resolves checkout command with rootDir', () => {
            config.rootDir = 'path/to/source';

            return scm.getCheckoutCommand(config).then(command => {
                assert.deepEqual(command, testRootDirCommands);
            });
        });
    });

    describe('stats', () => {
        it('returns the correct stats', () => {
            assert.deepEqual(scm.stats(), {
                'bitbucket:bitbucket.org': {
                    requests: {
                        total: 0,
                        timeouts: 0,
                        success: 0,
                        failure: 0,
                        concurrent: 0,
                        averageTime: 0
                    },
                    breaker: {
                        isClosed: true
                    }
                }
            });
        });
    });

    describe('_addWebhook', () => {
        const oauthToken = 'oauthToken';
        const scmUri = 'hostName:repoId:branchName';

        beforeEach(() => {
            requestMock.resolves({
                statusCode: 200
            });
        });

        it('works', () => {
            requestMock.onFirstCall().resolves({
                body: {
                    values: [],
                    size: 0
                },
                statusCode: 200
            });

            /* eslint-disable no-underscore-dangle */
            return scm
                ._addWebhook({
                    /* eslint-enable no-underscore-dangle */
                    scmUri,
                    token: oauthToken,
                    webhookUrl: 'url',
                    actions: [
                        'repo:push',
                        'pullrequest:created',
                        'pullrequest:fulfilled',
                        'pullrequest:rejected',
                        'pullrequest:updated'
                    ]
                })
                .then(() => {
                    assert.calledWith(requestMock, {
                        method: 'GET',
                        context: {
                            token: systemToken
                        },
                        url: `${API_URL_V2}/repositories/repoId/hooks?pagelen=30&page=1`
                    });
                    assert.calledWith(requestMock, {
                        json: {
                            description: 'Screwdriver-CD build trigger',
                            url: 'url',
                            active: true,
                            events: [
                                'repo:push',
                                'pullrequest:created',
                                'pullrequest:fulfilled',
                                'pullrequest:rejected',
                                'pullrequest:updated'
                            ]
                        },
                        method: 'POST',
                        context: {
                            token: oauthToken
                        },
                        url: `${API_URL_V2}/repositories/repoId/hooks`
                    });
                });
        });

        it('updates a pre-existing webhook', () => {
            const uuid = 'uuidValue';

            requestMock.onFirstCall().resolves({
                body: {
                    pagelen: 30,
                    values: [
                        {
                            url: 'url',
                            uuid
                        }
                    ],
                    page: 1,
                    size: 3
                },
                statusCode: 200
            });

            /* eslint-disable no-underscore-dangle */
            return scm
                ._addWebhook({
                    /* eslint-enable no-underscore-dangle */
                    scmUri,
                    token: oauthToken,
                    webhookUrl: 'url',
                    actions: [
                        'repo:push',
                        'pullrequest:created',
                        'pullrequest:fulfilled',
                        'pullrequest:rejected',
                        'pullrequest:updated'
                    ]
                })
                .then(() => {
                    assert.calledWith(requestMock, {
                        method: 'GET',
                        context: {
                            token: systemToken
                        },
                        url: `${API_URL_V2}/repositories/repoId/hooks?pagelen=30&page=1`
                    });
                    assert.calledWith(requestMock, {
                        json: {
                            description: 'Screwdriver-CD build trigger',
                            url: 'url',
                            active: true,
                            events: [
                                'repo:push',
                                'pullrequest:created',
                                'pullrequest:fulfilled',
                                'pullrequest:rejected',
                                'pullrequest:updated'
                            ]
                        },
                        method: 'PUT',
                        context: {
                            token: oauthToken
                        },
                        url: `${API_URL_V2}/repositories/repoId/hooks/${uuid}`
                    });
                });
        });

        it('updates a hook on a repo with a lot of other hooks', () => {
            const fakeValues = [];
            const uuid = 'uuid';

            for (let i = 0; i < 30; i += 1) {
                fakeValues.push({});
            }

            requestMock.onFirstCall().resolves({
                body: {
                    pagelen: 30,
                    values: fakeValues,
                    page: 1,
                    size: 30
                },
                statusCode: 200
            });
            requestMock.onSecondCall().resolves({
                body: {
                    pagelen: 30,
                    values: [
                        {
                            url: 'url',
                            uuid: 'uuid'
                        }
                    ],
                    page: 2,
                    size: 1
                },
                statusCode: 200
            });

            /* eslint-disable no-underscore-dangle */
            return scm
                ._addWebhook({
                    /* eslint-enable no-underscore-dangle */
                    scmUri,
                    token: oauthToken,
                    webhookUrl: 'url',
                    actions: [
                        'repo:push',
                        'pullrequest:created',
                        'pullrequest:fulfilled',
                        'pullrequest:rejected',
                        'pullrequest:updated'
                    ]
                })
                .then(() => {
                    assert.calledWith(requestMock, {
                        method: 'GET',
                        context: {
                            token: systemToken
                        },
                        url: `${API_URL_V2}/repositories/repoId/hooks?pagelen=30&page=2`
                    });
                    assert.calledWith(requestMock, {
                        json: {
                            description: 'Screwdriver-CD build trigger',
                            url: 'url',
                            active: true,
                            events: [
                                'repo:push',
                                'pullrequest:created',
                                'pullrequest:fulfilled',
                                'pullrequest:rejected',
                                'pullrequest:updated'
                            ]
                        },
                        method: 'PUT',
                        context: {
                            token: oauthToken
                        },
                        url: `${API_URL_V2}/repositories/repoId/hooks/${uuid}`
                    });
                });
        });

        it('rejects when failing to get the current list of webhooks', () => {
            const testError = new Error('_findWebhookError');

            requestMock.onFirstCall().rejects(testError);

            /* eslint-disable no-underscore-dangle */
            return scm
                ._addWebhook({
                    /* eslint-enable no-underscore-dangle */
                    scmUri,
                    token,
                    webhookUrl: 'url',
                    actions: [
                        'repo:push',
                        'pullrequest:created',
                        'pullrequest:fulfilled',
                        'pullrequest:rejected',
                        'pullrequest:updated'
                    ]
                })
                .then(assert.fail, err => {
                    assert.strictEqual(err, testError);
                });
        });

        it('rejects when failing to create a webhook', () => {
            const testError = new Error('_createWebhookError');

            requestMock.onFirstCall().resolves({
                body: {
                    values: [],
                    size: 0
                },
                statusCode: 200
            });
            requestMock.onSecondCall().rejects(testError);

            /* eslint-disable no-underscore-dangle */
            return scm
                ._addWebhook({
                    /* eslint-enable no-underscore-dangle */
                    scmUri,
                    token,
                    webhookUrl: 'url',
                    actions: [
                        'repo:push',
                        'pullrequest:created',
                        'pullrequest:fulfilled',
                        'pullrequest:rejected',
                        'pullrequest:updated'
                    ]
                })
                .then(assert.fail, err => {
                    assert.strictEqual(err, testError);
                });
        });

        it('rejects when failing to update a webhook', () => {
            const testError = new Error('_updateWebhookError');

            requestMock.onFirstCall().resolves({
                body: {
                    values: [
                        {
                            url: 'url',
                            uuid: 'uuid'
                        }
                    ],
                    size: 1
                },
                statusCode: 200
            });
            requestMock.onSecondCall().rejects(testError);

            /* eslint-disable no-underscore-dangle */
            return scm
                ._addWebhook({
                    /* eslint-enable no-underscore-dangle */
                    scmUri,
                    token,
                    webhookUrl: 'url',
                    actions: [
                        'repo:push',
                        'pullrequest:created',
                        'pullrequest:fulfilled',
                        'pullrequest:rejected',
                        'pullrequest:updated'
                    ]
                })
                .then(assert.fail, err => {
                    assert.strictEqual(err, testError);
                });
        });
    });

    describe('_getOpenedPRs', () => {
        const oauthToken = 'oauthToken';
        const scmUri = 'hostName:repoId:branchName';
        const expectedOptions = {
            url: `${API_URL_V2}/repositories/repoId/pullrequests`,
            method: 'GET',
            context: {
                token: systemToken
            }
        };

        it('returns response of expected format from Bitbucket', () => {
            requestMock.resolves({
                body: {
                    values: [
                        {
                            id: 1,
                            source: {
                                branch: {
                                    name: 'testbranch'
                                }
                            }
                        }
                    ]
                },
                statusCode: 200
            });

            // eslint-disable-next-line no-underscore-dangle
            return scm
                ._getOpenedPRs({
                    scmUri,
                    token: oauthToken
                })
                .then(response => {
                    assert.calledWith(requestMock, expectedOptions);
                    assert.deepEqual(response, [
                        {
                            name: 'PR-1',
                            ref: 'testbranch'
                        }
                    ]);
                });
        });

        it('rejects if fails', () => {
            const err = new Error('Bitbucket API error');

            requestMock.rejects(err);

            return scm
                ._getOpenedPRs({
                    scmUri,
                    token: oauthToken
                })
                .then(() => {
                    assert.fail('Should not get here');
                })
                .catch(error => {
                    assert.calledWith(requestMock, expectedOptions);
                    assert.equal(error, err);
                });
        });
    });

    describe('_getPrInfo', () => {
        const oauthToken = 'oauthToken';
        const scmUri = 'hostName:repoId:branchName';
        const prNum = 1;
        const expectedOptions = {
            url: `${API_URL_V2}/repositories/repoId/pullrequests/${prNum}`,
            method: 'GET',
            context: {
                token: systemToken
            }
        };

        it('returns response of expected format from Bitbucket', () => {
            requestMock.resolves({
                body: {
                    links: {
                        html: {
                            href: 'https://api.bitbucket.org/2.0/repositories/repoId/pullrequests/1'
                        }
                    },
                    id: 1,
                    source: {
                        branch: {
                            name: 'testbranch'
                        },
                        commit: {
                            hash: 'hashValue'
                        }
                    }
                },
                statusCode: 200
            });

            // eslint-disable-next-line no-underscore-dangle
            return scm
                ._getPrInfo({
                    scmUri,
                    token: oauthToken,
                    prNum
                })
                .then(response => {
                    assert.calledWith(requestMock, expectedOptions);
                    assert.deepEqual(response, {
                        name: 'PR-1',
                        ref: 'testbranch',
                        sha: 'hashValue',
                        url: 'https://api.bitbucket.org/2.0/repositories/repoId/pullrequests/1',
                        baseBranch: 'testbranch'
                    });
                });
        });

        it('rejects if fails', () => {
            const err = new Error('Bitbucket API error');

            requestMock.rejects(err);

            return scm
                ._getPrInfo({
                    scmUri,
                    token: oauthToken,
                    prNum
                })
                .then(() => {
                    assert.fail('Should not get here');
                })
                .catch(error => {
                    assert.calledWith(requestMock, expectedOptions);
                    assert.equal(error, err);
                });
        });
    });

    describe('getScmContexts', () => {
        it('returns a default scmContext', () => {
            const result = scm.getScmContexts();

            return assert.deepEqual(result, ['bitbucket:bitbucket.org']);
        });
    });

    describe('canHandleWebhook', () => {
        let headers;

        beforeEach(() => {
            headers = {
                'x-request-uuid': '1e8d4e8e-5fcf-4624-b091-b10bd6ecaf5e'
            };
        });

        it('returns a true for a opened PR.', () => {
            headers['x-event-key'] = 'pullrequest:created';

            return scm.canHandleWebhook(headers, testPayloadOpen).then(result => {
                assert.strictEqual(result, true);
            });
        });

        it('returns a true for a sync PR (ammending commit).', () => {
            headers['x-event-key'] = 'pullrequest:updated';

            return scm.canHandleWebhook(headers, testPayloadSync).then(result => {
                assert.isTrue(result);
            });
        });

        it('returns a true for closed PR after merged.', () => {
            headers['x-event-key'] = 'pullrequest:fullfilled';

            return scm.canHandleWebhook(headers, testPayloadClose).then(result => {
                assert.isTrue(result);
            });
        });

        it('returns a true for closed PR after declined.', () => {
            headers['x-event-key'] = 'pullrequest:rejected';

            return scm.canHandleWebhook(headers, testPayloadClose).then(result => {
                assert.isTrue(result);
            });
        });

        it('returns a true for a push event payload.', () => {
            headers['x-event-key'] = 'repo:push';

            return scm.canHandleWebhook(headers, testPayloadPush).then(result => {
                assert.isTrue(result);
            });
        });

        it('returns a false when _parseHook() returns null.', () => {
            headers['x-event-key'] = 'issue:created';

            return scm.canHandleWebhook(headers, testPayloadPush).then(result => {
                assert.isTrue(result);
            });
        });

        it('returns false when an error is thrown', () => {
            // eslint-disable-next-line no-underscore-dangle
            scm._parseHook = () => Promise.reject(new Error('Test error'));

            return scm.canHandleWebhook(headers, testPayloadPush).then(result => {
                assert.strictEqual(result, false);
            });
        });

        it('returns a false when checkoutUrl dose not match scmContext.', () => {
            headers['x-event-key'] = 'repo:push';
            testPayloadPush.repository.links.html.href = 'https://github.com/batman/test';

            return scm.canHandleWebhook(headers, testPayloadPush).then(result => {
                assert.isFalse(result);
            });
        });
    });

    describe('_getBranchList', () => {
        const branchListConfig = {
            scmUri: 'hostName:repoId:branchName',
            token: 'oauthToken'
        };

        beforeEach(() => {
            requestMock.resolves({
                statusCode: 200,
                body: {
                    values: []
                }
            });
        });

        it('gets branches', done => {
            requestMock.onFirstCall().resolves({
                body: {
                    values: [{ name: 'master' }],
                    size: 1
                },
                statusCode: 200
            });
            scm.getBranchList(branchListConfig)
                .then(b => {
                    assert.calledWith(requestMock, {
                        method: 'GET',
                        context: {
                            token: systemToken
                        },
                        url: `${API_URL_V2}/repositories/repoId/refs/branches?pagelen=100&page=1`
                    });
                    assert.deepEqual(b, [{ name: 'master' }]);
                    done();
                })
                .catch(done);
        });

        it('gets a lot of branches', done => {
            const fakeBranches = [];

            for (let i = 0; i < 100; i += 1) {
                fakeBranches.push({
                    name: `master${i}`
                });
            }

            const fakeResponse = {
                statusCode: 200,
                body: {
                    values: fakeBranches
                }
            };

            const fakeResponseEmpty = {
                statusCode: 200,
                body: {
                    values: []
                }
            };

            requestMock.onCall(0).resolves(fakeResponse);
            requestMock.onCall(1).resolves(fakeResponse);
            requestMock.onCall(2).resolves(fakeResponse);
            requestMock.onCall(3).resolves(fakeResponseEmpty);
            scm.getBranchList(branchListConfig)
                .then(branches => {
                    assert.equal(branches.length, 300);
                    done();
                })
                .catch(done);
        });

        it('throws an error when failing to getBranches', () => {
            const testError = new Error('getBranchesError');

            requestMock.rejects(testError);

            return scm.getBranchList(branchListConfig).then(assert.fail, err => {
                assert.equal(err, testError);
            });
        });
    });

    describe('_getToken', () => {
        beforeEach(() => {
            const response = {
                statusCode: 200,
                body: testPayloadAccessToken
            };

            requestMock.resolves(response);
        });

        it('request new token', done => {
            // remove the token to allow the scm to try and load it
            scm.token = '';
            scm.refreshToken = '';
            scm.expiresIn = 0;

            // eslint-disable-next-line no-underscore-dangle
            scm._getToken()
                .then(newToken => {
                    assert.calledWith(requestMock, {
                        url: 'https://bitbucket.org/site/oauth2/access_token',
                        method: 'POST',
                        username: 'myclientid',
                        password: 'myclientsecret',
                        context: {
                            token: undefined
                        },
                        form: {
                            grant_type: 'client_credentials'
                        }
                    });
                    assert.equal(newToken, systemToken);
                    done();
                })
                .catch(done);
        });

        it('refreshes existing token', done => {
            // mark the token expire to allow the scm to try and load it
            scm.token = systemToken;
            scm.refreshToken = 'myRefreshToken2';
            scm.expiresIn = new Date().getTime() - 2700 * 1000;

            // eslint-disable-next-line no-underscore-dangle
            scm._getToken()
                .then(newToken => {
                    assert.calledWith(requestMock, {
                        url: 'https://bitbucket.org/site/oauth2/access_token',
                        method: 'POST',
                        username: 'myclientid',
                        password: 'myclientsecret',
                        context: {
                            token: undefined
                        },
                        form: {
                            grant_type: 'refresh_token',
                            refresh_token: 'myRefreshToken2'
                        }
                    });
                    assert.equal(newToken, systemToken);
                    done();
                })
                .catch(done);
        });
    });
});
