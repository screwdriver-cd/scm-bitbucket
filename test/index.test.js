'use strict';

const assert = require('chai').assert;
const mockery = require('mockery');
const sinon = require('sinon');
const testCommands = require('./data/commands.json');
const testPrCommands = require('./data/prCommands.json');
const testCustomPrCommands = require('./data/customPrCommands.json');
const testPayloadOpen = require('./data/pr.opened.json');
const testPayloadSync = require('./data/pr.sync.json');
const testPayloadClose = require('./data/pr.closed.json');
const testPayloadPush = require('./data/repo.push.json');
const token = 'myAccessToken';
const API_URL_V1 = 'https://api.bitbucket.org/1.0';
const API_URL_V2 = 'https://api.bitbucket.org/2.0';

require('sinon-as-promised');
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
        mockery.registerMock('request', requestMock);

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
                json: true,
                auth: {
                    bearer: 'myAccessToken'
                }
            };
            requestMock.yieldsAsync(null, fakeResponse, fakeResponse.body);
        });

        it('resolves to the correct parsed url for ssh', () => {
            const expected =
                'bitbucket.org:batman/{de7d7695-1196-46a1-b87d-371b7b2945ab}:master';

            expectedOptions = {
                url: `${apiUrl}/master`,
                method: 'GET',
                json: true,
                auth: {
                    bearer: 'myAccessToken'
                }
            };

            return scm.parseUrl({
                checkoutUrl: 'git@bitbucket.org:batman/test.git#master',
                token
            }).then((parsed) => {
                assert.calledWith(requestMock, expectedOptions);
                assert.equal(parsed, expected);
            });
        });

        it('resolves to the correct parsed url for https', () => {
            const expected =
                'bitbucket.org:batman/{de7d7695-1196-46a1-b87d-371b7b2945ab}:mynewbranch';

            return scm.parseUrl({
                checkoutUrl: 'https://batman@bitbucket.org/batman/test.git#mynewbranch',
                token: 'myAccessToken'
            }).then((parsed) => {
                assert.calledWith(requestMock, expectedOptions);
                assert.equal(parsed, expected);
            });
        });

        it('rejects if request fails', () => {
            const err = new Error('Bitbucket API error');

            requestMock.yieldsAsync(err);

            return scm.parseUrl({
                checkoutUrl: 'https://batman@bitbucket.org/batman/test.git#mynewbranch',
                token: 'myAccessToken'
            })
                .then(() => assert.fail('Should not get here'))
                .catch((error) => {
                    assert.calledWith(requestMock, expectedOptions);
                    assert.deepEqual(error, err);
                });
        });

        it('rejects if status code is 404', () => {
            fakeResponse = {
                statusCode: 404,
                body: {
                    error: {
                        message: 'Resource not found',
                        detail: 'There is no API hosted at this URL'
                    }
                }
            };

            requestMock.yieldsAsync(null, fakeResponse, fakeResponse.body);

            return scm.parseUrl({
                checkoutUrl: 'https://batman@bitbucket.org/batman/test.git#mynewbranch',
                token: 'myAccessToken'
            })
                .then(() => assert.fail('Should not get here'))
                .catch((error) => {
                    assert.calledWith(requestMock, expectedOptions);
                    assert.match(error.message, 'Cannot find repository');
                });
        });

        it('rejects if status code is not 200 & 404', () => {
            fakeResponse = {
                statusCode: 500,
                body: {
                    error: {
                        message: 'Internal Server Error'
                    }
                }
            };

            requestMock.yieldsAsync(null, fakeResponse, fakeResponse.body);

            return scm.parseUrl({
                checkoutUrl: 'https://batman@bitbucket.org/batman/test.git#mynewbranch',
                token: 'myAccessToken'
            })
                .then(() => assert.fail('Should not get here'))
                .catch((error) => {
                    assert.calledWith(requestMock, expectedOptions);
                    assert.match(error.message, 'STATUS CODE 500');
                });
        });

        it('rejects when passed checkoutUrl of another host', () => {
            const expectedError =
                new Error('This checkoutUrl is not supported for your current login host.');

            return scm.parseUrl({
                checkoutUrl: 'git@bitbucket.corp.jp:batman/test.git#master',
                token
            })
                .then(() => assert.fail('Should not get here'))
                .catch((error) => {
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
            })
                .then(result => assert.isNull(result));
        });
    });

    describe('parseHook', () => {
        it('resolves the correct parsed config for opened PR', () => {
            const expected = {
                type: 'pr',
                action: 'opened',
                username: 'robin',
                checkoutUrl: 'https://batman@bitbucket.org/batman/test.git',
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

            return scm.parseHook(headers, testPayloadOpen)
                .then(result => assert.deepEqual(result, expected));
        });

        it('resolves the correct parsed config for sync PR (ammending commit)', () => {
            const expected = {
                type: 'pr',
                action: 'synchronized',
                username: 'batman',
                checkoutUrl: 'https://batman@bitbucket.org/batman/test.git',
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

            return scm.parseHook(headers, testPayloadSync)
                .then(result => assert.deepEqual(result, expected));
        });

        it('resolves the correct parsed config for closed PR after merged', () => {
            const expected = {
                type: 'pr',
                action: 'closed',
                username: 'robin',
                checkoutUrl: 'https://batman@bitbucket.org/batman/test.git',
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

            return scm.parseHook(headers, testPayloadClose)
                .then(result => assert.deepEqual(result, expected));
        });

        it('resolves the correct parsed config for closed PR after declined', () => {
            const expected = {
                type: 'pr',
                action: 'closed',
                username: 'robin',
                checkoutUrl: 'https://batman@bitbucket.org/batman/test.git',
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

            return scm.parseHook(headers, testPayloadClose)
                .then(result => assert.deepEqual(result, expected));
        });

        it('resolves the correct parsed config for push to repo event', () => {
            const expected = {
                type: 'repo',
                action: 'push',
                username: 'robin',
                checkoutUrl: 'https://batman@bitbucket.org/batman/test.git',
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

            return scm.parseHook(headers, testPayloadPush)
                .then(result => assert.deepEqual(result, expected));
        });

        it('resolves null if events are not supported: repoFork', () => {
            const repoFork = {
                'x-event-key': 'repo:fork'
            };

            return scm.parseHook(repoFork, {})
                .then(result => assert.deepEqual(result, null));
        });

        it('resolves null if events are not supported: prComment', () => {
            const prComment = {
                'x-event-key': 'pullrequest:comment_created'
            };

            return scm.parseHook(prComment, {})
                .then(result => assert.deepEqual(result, null));
        });

        it('resolves null if events are not supported: issueCreated', () => {
            const issueCreated = {
                'x-event-key': 'issue:created'
            };

            return scm.parseHook(issueCreated, {})
                .then(result => assert.deepEqual(result, null));
        });
    });

    describe('decorateAuthor', () => {
        const apiUrl = `${API_URL_V2}/users/batman`;
        const expectedOptions = {
            url: apiUrl,
            method: 'GET',
            json: true,
            auth: {
                bearer: token
            }
        };
        let fakeResponse;

        beforeEach(() => {
            fakeResponse = {
                statusCode: 200,
                body: {
                    username: 'batman',
                    display_name: 'Batman',
                    uuid: '{4f1a9b7f-586e-4e80-b9eb-a7589b4a165f}',
                    links: {
                        html: {
                            href: 'https://bitbucket.org/batman/'
                        },
                        avatar: {
                            href: 'https://bitbucket.org/account/batman/avatar/32/'
                        }
                    }
                }
            };
            requestMock.yieldsAsync(null, fakeResponse, fakeResponse.body);
        });

        it('resolves to correct decorated author', () => {
            const expected = {
                url: 'https://bitbucket.org/batman/',
                name: 'Batman',
                username: 'batman',
                avatar: 'https://bitbucket.org/account/batman/avatar/32/'
            };

            return scm.decorateAuthor({
                username: 'batman',
                token
            }).then((decorated) => {
                assert.calledWith(requestMock, expectedOptions);
                assert.deepEqual(decorated, expected);
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

            requestMock.yieldsAsync(null, fakeResponse, fakeResponse.body);

            return scm.decorateAuthor({
                username: 'batman',
                token
            }).then(() => {
                assert.fail('Should not get here');
            }).catch((error) => {
                assert.calledWith(requestMock, expectedOptions);
                assert.match(error.message, 'STATUS CODE 404');
            });
        });

        it('rejects if fails', () => {
            const err = new Error('Bitbucket API error');

            requestMock.yieldsAsync(err);

            return scm.decorateAuthor({
                username: 'batman',
                token
            }).then(() => {
                assert.fail('Should not get here');
            }).catch((error) => {
                assert.calledWith(requestMock, expectedOptions);
                assert.equal(error, err);
            });
        });
    });

    describe('decorateUrl', () => {
        const apiUrl = `${API_URL_V2}/repositories/repoId`;
        const selfLink = 'https://bitbucket.org/d2lam2/test';
        const repoOptions = {
            url: apiUrl,
            method: 'GET',
            json: true,
            auth: {
                bearer: token
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
                json: true,
                auth: {
                    bearer: token
                }
            };
            requestMock.withArgs(repoOptions)
                .yieldsAsync(null, fakeResponse, fakeResponse.body);
        });

        it('resolves to correct decorated url object', () => {
            const expected = {
                url: selfLink,
                name: 'username/branchName',
                branch: 'branchName'
            };

            return scm.decorateUrl({
                scmUri: 'hostName:repoId:branchName',
                token
            }).then((decorated) => {
                assert.calledWith(requestMock, expectedOptions);
                assert.deepEqual(decorated, expected);
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

            requestMock.withArgs(repoOptions).yieldsAsync(null, fakeResponse, fakeResponse.body);

            return scm.decorateUrl({
                scmUri: 'hostName:repoId:branchName',
                token
            }).then(() => {
                assert.fail('Should not get here');
            }).catch((error) => {
                assert.calledWith(requestMock, expectedOptions);
                assert.match(error.message, 'STATUS CODE 404');
            });
        });

        it('rejects if fails', () => {
            const err = new Error('Bitbucket API error');

            requestMock.withArgs(repoOptions).yieldsAsync(err);

            return scm.decorateUrl({
                scmUri: 'repoName:repoId:branchName',
                token
            }).then(() => {
                assert.fail('Should not get here');
            }).catch((error) => {
                assert.called(requestMock);
                assert.equal(error, err);
            });
        });
    });

    describe('decorateCommit', () => {
        const sha = '1111111111111111111111111111111111111111';
        const repoUrl =
            `${API_URL_V2}/repositories/repoId/commit/${sha}`;
        const authorUrl = `${API_URL_V2}/users/username`;
        const selfLink = `https://bitbucket.org/repoId/commits/${sha}`;
        const repoOptions = {
            url: repoUrl,
            method: 'GET',
            json: true,
            auth: {
                bearer: token
            }
        };
        const authorOptions = {
            url: authorUrl,
            method: 'GET',
            json: true,
            auth: {
                bearer: token
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
                            username: 'username'
                        }
                    }
                }
            };
            fakeAuthorResponse = {
                statusCode: 200,
                body: {
                    username: 'username',
                    display_name: 'displayName',
                    uuid: 'uuid',
                    links: {
                        html: {
                            href: 'https://bitbucket.org/username/'
                        },
                        avatar: {
                            href: 'https://bitbucket.org/account/username/avatar/32/'
                        }
                    }
                }
            };
            requestMock.withArgs(repoOptions)
                .yieldsAsync(null, fakeResponse, fakeResponse.body);
            requestMock.withArgs(authorOptions)
                .yieldsAsync(null, fakeAuthorResponse, fakeAuthorResponse.body);
        });

        it('resolves to correct decorated object', () => {
            const expected = {
                url: selfLink,
                message: 'testing',
                author: {
                    url: 'https://bitbucket.org/username/',
                    name: 'displayName',
                    username: 'username',
                    avatar: 'https://bitbucket.org/account/username/avatar/32/'
                }
            };

            return scm.decorateCommit({
                sha,
                scmUri: 'hostName:repoId:branchName',
                token
            }).then((decorated) => {
                assert.calledTwice(requestMock);
                assert.deepEqual(decorated, expected);
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

            requestMock.withArgs(repoOptions).yieldsAsync(null, fakeResponse, fakeResponse.body);

            return scm.decorateCommit({
                sha,
                scmUri: 'hostName:repoId:branchName',
                token
            }).then(() => {
                assert.fail('Should not get here');
            }).catch((error) => {
                assert.calledOnce(requestMock);
                assert.match(error.message, 'STATUS CODE 404');
            });
        });

        it('rejects if fails', () => {
            const err = new Error('Bitbucket API error');

            requestMock.withArgs(repoOptions).yieldsAsync(err);

            return scm.decorateCommit({
                sha,
                scmUri: 'hostName:repoId:branchName',
                token
            }).then(() => {
                assert.fail('Should not get here');
            }).catch((error) => {
                assert.called(requestMock);
                assert.equal(error, err);
            });
        });
    });

    describe('getCommitSha', () => {
        const apiUrl =
            `${API_URL_V2}/repositories/repoId/refs/branches/branchName`;
        const scmUri = 'hostName:repoId:branchName';
        const expectedOptions = {
            url: apiUrl,
            method: 'GET',
            json: true,
            auth: {
                bearer: token
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
            requestMock.yieldsAsync(null, fakeResponse, fakeResponse.body);
        });

        it('resolves to correct commit sha without prNum', () =>
            scm.getCommitSha({
                scmUri,
                token
            }).then((sha) => {
                assert.calledWith(requestMock, expectedOptions);
                assert.deepEqual(sha, 'hashValue');
            })
        );

        it('resolves to correct commit sha with prNum', () => {
            const prNum = 1;
            const prExpectedOptions = {
                url: `${API_URL_V2}/repositories/repoId/pullrequests/${prNum}`,
                method: 'GET',
                json: true,
                auth: {
                    bearer: token
                }
            };

            requestMock.yieldsAsync(null, {
                body: {
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

            return scm.getCommitSha({
                scmUri,
                token,
                prNum: 1
            }).then((sha) => {
                assert.calledWith(requestMock, prExpectedOptions);
                assert.deepEqual(sha, 'hashValue');
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

            requestMock.yieldsAsync(null, fakeResponse, fakeResponse.body);

            return scm.getCommitSha({
                scmUri,
                token
            }).then(() => {
                assert.fail('Should not get here');
            }).catch((error) => {
                assert.calledWith(requestMock, expectedOptions);
                assert.match(error.message, 'STATUS CODE 404');
            });
        });

        it('rejects if fails', () => {
            const err = new Error('Bitbucket API error');

            requestMock.yieldsAsync(err);

            return scm.getCommitSha({
                scmUri,
                token
            }).then(() => {
                assert.fail('Should not get here');
            }).catch((error) => {
                assert.calledWith(requestMock, expectedOptions);
                assert.equal(error, err);
            });
        });
    });

    describe('getFile', () => {
        const apiUrl = `${API_URL_V1}/repositories/repoId/src/branchName/path/to/file.txt`;
        const scmUri = 'hostName:repoId:branchName';
        const params = {
            scmUri,
            token,
            path: 'path/to/file.txt'
        };
        const expectedOptions = {
            url: apiUrl,
            method: 'GET',
            json: true,
            auth: {
                bearer: token
            }
        };
        let fakeResponse;

        beforeEach(() => {
            fakeResponse = {
                statusCode: 200,
                body: {
                    node: 'nodeValue',
                    path: 'path/to/file.txt',
                    data: 'dataValue',
                    size: 14
                }
            };
            requestMock.yieldsAsync(null, fakeResponse, fakeResponse.body);
        });

        it('resolves to correct commit sha', () =>
            scm.getFile(params).then((content) => {
                assert.calledWith(requestMock, expectedOptions);
                assert.deepEqual(content, 'dataValue');
            })
        );

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

            requestMock.yieldsAsync(null, fakeResponse, fakeResponse.body);

            return scm.getFile(params).then(() => {
                assert.fail('Should not get here');
            }).catch((error) => {
                assert.calledWith(requestMock, expectedOptions);
                assert.match(error.message, 'STATUS CODE 404');
            });
        });

        it('rejects if fails', () => {
            const err = new Error('Bitbucket API error');

            requestMock.yieldsAsync(err);

            return scm.getFile(params).then(() => {
                assert.fail('Should not get here');
            }).catch((error) => {
                assert.calledWith(requestMock, expectedOptions);
                assert.equal(error, err);
            });
        });
    });

    describe('getPermissions', () => {
        const pull = {
            url: `${API_URL_V2}/repositories/repoIdPrefix`,
            method: 'GET',
            json: true,
            auth: {
                bearer: token
            }
        };
        const push = {
            url: `${API_URL_V2}/repositories/repoIdPrefix?role=contributor`,
            method: 'GET',
            json: true,
            auth: {
                bearer: token
            }
        };
        const admin = {
            url: `${API_URL_V2}/repositories/repoIdPrefix?role=admin`,
            method: 'GET',
            json: true,
            auth: {
                bearer: token
            }
        };
        const readResponse = {
            statusCode: 200,
            body: {
                values: [
                    { uuid: 'repoIdSuffix1' },
                    { uuid: 'repoIdSuffix2' },
                    { uuid: 'repoIdSuffix3' }
                ]
            }
        };
        const writeResponse = {
            statusCode: 200,
            body: {
                values: [
                    { uuid: 'repoIdSuffix1' },
                    { uuid: 'repoIdSuffix2' }
                ]
            }
        };
        const adminResponse = {
            statusCode: 200,
            body: {
                values: [
                    { uuid: 'repoIdSuffix1' }
                ]
            }
        };

        beforeEach(() => {
            requestMock.withArgs(pull).yieldsAsync(null, readResponse, readResponse.body);
            requestMock.withArgs(push).yieldsAsync(null, writeResponse, writeResponse.body);
            requestMock.withArgs(admin).yieldsAsync(null, adminResponse, adminResponse.body);
        });

        it('get correct admin permissions', () => {
            const scmUri = 'hostName:repoIdPrefix/repoIdSuffix1:branchName';

            return scm.getPermissions({
                scmUri,
                token
            }).then((permissions) => {
                assert.calledThrice(requestMock);
                assert.calledWith(requestMock, pull);
                assert.calledWith(requestMock, push);
                assert.calledWith(requestMock, admin);
                assert.deepEqual(permissions, {
                    admin: true,
                    push: true,
                    pull: true
                });
            });
        });

        it('get correct push permissions', () => {
            const scmUri = 'hostName:repoIdPrefix/repoIdSuffix2:branchName';

            return scm.getPermissions({
                scmUri,
                token
            }).then((permissions) => {
                assert.calledThrice(requestMock);
                assert.calledWith(requestMock, pull);
                assert.calledWith(requestMock, push);
                assert.calledWith(requestMock, admin);
                assert.deepEqual(permissions, {
                    admin: false,
                    push: true,
                    pull: true
                });
            });
        });

        it('get correct pull permissions', () => {
            const scmUri = 'hostName:repoIdPrefix/repoIdSuffix3:branchName';

            return scm.getPermissions({
                scmUri,
                token
            }).then((permissions) => {
                assert.deepEqual(permissions, {
                    admin: false,
                    push: false,
                    pull: true
                });
            });
        });

        it('no permissions', () => {
            const scmUri = 'hostName:repoIdPrefix/repoIdSuffix:branchName';

            return scm.getPermissions({
                scmUri,
                token
            }).then((permissions) => {
                assert.deepEqual(permissions, {
                    admin: false,
                    push: false,
                    pull: false
                });
            });
        });

        it('rejects if status code is not 200', () => {
            const scmUri = 'hostName:repoIdPrefix/repoIdSuffix:branchName';
            const fakeResponse = {
                statusCode: 404,
                body: {
                    error: {
                        message: 'Resource not found',
                        detail: 'There is no API hosted at this URL'
                    }
                }
            };

            requestMock.withArgs(pull).yieldsAsync(null, fakeResponse, fakeResponse.body);

            return scm.getPermissions({
                scmUri,
                token
            }).then(() => {
                assert.fail('Should not get here');
            }).catch((error) => {
                assert.match(error.message, 'STATUS CODE 404');
            });
        });

        it('rejects if fails', () => {
            const error = new Error('Bitbucket API error');
            const scmUri = 'hostName:repoIdPrefix/repoIdSuffix:branchName';

            requestMock.withArgs(pull).yieldsAsync(error);

            return scm.getPermissions({
                scmUri,
                token
            }).then(() => {
                assert.fail('Should not get here');
            }).catch((err) => {
                assert.equal(error, err);
            });
        });
    });

    describe('updateCommitStatus', () => {
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
                json: true,
                body: {
                    url: config.url,
                    state: 'SUCCESSFUL',
                    key: config.sha,
                    description: 'Screwdriver/123/main'
                },
                auth: {
                    bearer: 'bearerToken' // Decoded access token
                }
            };
            requestMock.yieldsAsync(null, fakeResponse);
        });

        it('successfully update status for PR', () => {
            config.jobName = 'PR-1';
            expectedOptions.body.description = 'Screwdriver/123/PR';

            return scm.updateCommitStatus(config).then(() => {
                assert.calledWith(requestMock, expectedOptions);
            });
        });

        it('successfully update status', () =>
            scm.updateCommitStatus(config).then(() => {
                assert.calledWith(requestMock, expectedOptions);
            })
        );

        it('rejects if status code is not 201 or 200', () => {
            fakeResponse = {
                statusCode: 401,
                body: {
                    error: {
                        message: 'Access token expired'
                    }
                }
            };

            requestMock.yieldsAsync(null, fakeResponse, fakeResponse.body);

            return scm.updateCommitStatus(config).then(() => {
                assert.fail('Should not get here');
            }).catch((error) => {
                assert.calledWith(requestMock, expectedOptions);
                assert.match(error.message, 'STATUS CODE 401');
            });
        });

        it('rejects if fails', () => {
            const err = new Error('Bitbucket API error');

            requestMock.yieldsAsync(err);

            return scm.updateCommitStatus(config).then(() => {
                assert.fail('Should not get here');
            }).catch((error) => {
                assert.calledWith(requestMock, expectedOptions);
                assert.equal(error, err);
            });
        });
    });

    describe('getBellConfiguration', () => {
        it('resolves a default configuration', () =>
            scm.getBellConfiguration().then((config) => {
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
            })
        );
    });

    describe('getCheckoutCommand', () => {
        const config = {
            branch: 'branchName',
            host: 'hostName',
            org: 'orgName',
            repo: 'repoName',
            sha: 'shaValue'
        };

        it('resolves checkout command without prRef', () =>
            scm.getCheckoutCommand(config).then((command) => {
                assert.deepEqual(command, testCommands);
            })
        );

        it('resolves checkout command with prRef', () => {
            config.prRef = 'prBranch';

            return scm.getCheckoutCommand(config).then((command) => {
                assert.deepEqual(command, testPrCommands);
            });
        });

        it('resolves checkout command with custom username and email', () => {
            scm = new BitbucketScm({
                oauthClientId: 'myclientid',
                oauthClientSecret: 'myclientsecret',
                username: 'abcd',
                email: 'dev-null@my.email.com'
            });

            return scm.getCheckoutCommand(config)
                .then((command) => {
                    assert.deepEqual(command, testCustomPrCommands);
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
            requestMock.yieldsAsync(null, {
                statusCode: 200
            });
        });

        it('works', () => {
            requestMock.onFirstCall().yieldsAsync(null, {
                body: {
                    values: [],
                    size: 0
                },
                statusCode: 200
            });

            /* eslint-disable no-underscore-dangle */
            return scm._addWebhook({
            /* eslint-enable no-underscore-dangle */
                scmUri,
                token: oauthToken,
                url: 'url'
            })
                .then(() => {
                    assert.calledWith(requestMock, {
                        json: true,
                        method: 'GET',
                        auth: {
                            bearer: oauthToken
                        },
                        url: `${API_URL_V2}/repositories/repoId/hooks?pagelen=30&page=1`
                    });
                    assert.calledWith(requestMock, {
                        body: {
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
                        json: true,
                        method: 'POST',
                        auth: {
                            bearer: oauthToken
                        },
                        url: `${API_URL_V2}/repositories/repoId/hooks`
                    });
                });
        });

        it('updates a pre-existing webhook', () => {
            const uuid = 'uuidValue';

            requestMock.onFirstCall().yieldsAsync(null, {
                body: {
                    pagelen: 30,
                    values: [{
                        url: 'url',
                        uuid
                    }],
                    page: 1,
                    size: 3
                },
                statusCode: 200
            });

            /* eslint-disable no-underscore-dangle */
            return scm._addWebhook({
            /* eslint-enable no-underscore-dangle */
                scmUri,
                token: oauthToken,
                url: 'url'
            }).then(() => {
                assert.calledWith(requestMock, {
                    json: true,
                    method: 'GET',
                    auth: {
                        bearer: oauthToken
                    },
                    url: `${API_URL_V2}/repositories/repoId/hooks?pagelen=30&page=1`
                });
                assert.calledWith(requestMock, {
                    body: {
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
                    json: true,
                    method: 'PUT',
                    auth: {
                        bearer: oauthToken
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

            requestMock.onFirstCall().yieldsAsync(null, {
                body: {
                    pagelen: 30,
                    values: fakeValues,
                    page: 1,
                    size: 30
                },
                statusCode: 200
            });
            requestMock.onSecondCall().yieldsAsync(null, {
                body: {
                    pagelen: 30,
                    values: [{
                        url: 'url',
                        uuid: 'uuid'
                    }],
                    page: 2,
                    size: 1
                },
                statusCode: 200
            });

            /* eslint-disable no-underscore-dangle */
            return scm._addWebhook({
            /* eslint-enable no-underscore-dangle */
                scmUri,
                token: oauthToken,
                url: 'url'
            }).then(() => {
                assert.calledWith(requestMock, {
                    json: true,
                    method: 'GET',
                    auth: {
                        bearer: oauthToken
                    },
                    url: `${API_URL_V2}/repositories/repoId/hooks?pagelen=30&page=2`
                });
                assert.calledWith(requestMock, {
                    body: {
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
                    json: true,
                    method: 'PUT',
                    auth: {
                        bearer: oauthToken
                    },
                    url: `${API_URL_V2}/repositories/repoId/hooks/${uuid}`
                });
            });
        });

        it('rejects when failing to get the current list of webhooks', () => {
            const expectedMessage = [
                'Your credentials lack one or more required privilege scopes.',
                'Reason "webhook"'
            ].join(' ');
            const testErrorBody = {
                type: 'error',
                error: {
                    message: 'Your credentials lack one or more required privilege scopes.',
                    detail: {
                        granted: ['repository'],
                        required: ['webhook']
                    }
                }
            };

            requestMock.onFirstCall().yieldsAsync(null, {
                body: testErrorBody,
                statusCode: 403
            });

            /* eslint-disable no-underscore-dangle */
            return scm._addWebhook({
            /* eslint-enable no-underscore-dangle */
                scmUri,
                token,
                url: 'url'
            }).then(assert.fail, (err) => {
                assert.strictEqual(err.message, expectedMessage);
            });
        });

        it('rejects with a stringified error when bitbucket API fails to list webhooks', () => {
            const statusCode = 500;
            const expectedMessage = `SCM service unavailable (${statusCode}). Reason "undefined"`;

            requestMock.onFirstCall().yieldsAsync(null, {
                body: undefined,
                statusCode
            });

            /* eslint-disable no-underscore-dangle */
            return scm._addWebhook({
            /* eslint-enable no-underscore-dangle */
                scmUri,
                token,
                url: 'url'
            }).then(assert.fail, (err) => {
                assert.strictEqual(err.message, expectedMessage);
            });
        });

        it('rejects when failing to create a webhook', () => {
            const testErrorBody = {
                type: 'error',
                error: {
                    message: 'Your credentials lack one or more required privilege scopes.',
                    detail: {
                        granted: ['repository'],
                        required: ['webhook']
                    }
                }
            };

            requestMock.onFirstCall().yieldsAsync(null, {
                body: {
                    values: [],
                    size: 0
                },
                statusCode: 200
            });
            requestMock.onSecondCall().yieldsAsync(null, {
                body: testErrorBody,
                statusCode: 403
            });

            /* eslint-disable no-underscore-dangle */
            return scm._addWebhook({
            /* eslint-enable no-underscore-dangle */
                scmUri,
                token,
                url: 'url'
            }).then(assert.fail, (err) => {
                assert.strictEqual(err.message, [
                    'Your credentials lack one or more required privilege scopes.',
                    'Reason "webhook"'
                ].join(' '));
            });
        });

        it('rejects when failing to update a webhook', () => {
            const expectedMessage = [
                'Your credentials lack one or more required privilege scopes.',
                'Reason "webhook"'
            ].join(' ');
            const testErrorBody = {
                type: 'error',
                error: {
                    message: 'Your credentials lack one or more required privilege scopes.',
                    detail: {
                        granted: ['repository'],
                        required: ['webhook']
                    }
                }
            };

            requestMock.onFirstCall().yieldsAsync(null, {
                body: {
                    values: [{
                        url: 'url',
                        uuid: 'uuid'
                    }],
                    size: 1
                },
                statusCode: 200
            });
            requestMock.onSecondCall().yieldsAsync(null, {
                body: testErrorBody,
                statusCode: 403
            });

            /* eslint-disable no-underscore-dangle */
            return scm._addWebhook({
            /* eslint-enable no-underscore-dangle */
                scmUri,
                token,
                url: 'url'
            }).then(assert.fail, (err) => {
                assert.strictEqual(err.message, expectedMessage);
            });
        });

        it('rejects with a stringified error when bitbucket API fails to update webhook', () => {
            const statusCode = 500;
            const expectedMessage = `SCM service unavailable (${statusCode}). Reason "{}"`;

            requestMock.onFirstCall().yieldsAsync(null, {
                body: {
                    values: [{
                        url: 'url',
                        uuid: 'uuid'
                    }],
                    size: 1
                },
                statusCode: 200
            });
            requestMock.onSecondCall().yieldsAsync(null, {
                body: {},
                statusCode
            });

            /* eslint-disable no-underscore-dangle */
            return scm._addWebhook({
            /* eslint-enable no-underscore-dangle */
                scmUri,
                token,
                url: 'url'
            }).then(assert.fail, (err) => {
                assert.strictEqual(err.message, expectedMessage);
            });
        });
    });

    describe('_getOpenedPRs', () => {
        const oauthToken = 'oauthToken';
        const scmUri = 'hostName:repoId:branchName';
        const expectedOptions = {
            url: `${API_URL_V2}/repositories/repoId/pullrequests`,
            method: 'GET',
            json: true,
            auth: {
                bearer: oauthToken
            }
        };

        it('returns response of expected format from Bitbucket', () => {
            requestMock.yieldsAsync(null, {
                body: {
                    values: [{
                        id: 1,
                        source: {
                            branch: {
                                name: 'testbranch'
                            }
                        }
                    }]
                },
                statusCode: 200
            });

            // eslint-disable-next-line no-underscore-dangle
            return scm._getOpenedPRs({
                scmUri,
                token: oauthToken
            })
                .then((response) => {
                    assert.calledWith(requestMock, expectedOptions);
                    assert.deepEqual(response, [{
                        name: 'PR-1',
                        ref: 'testbranch'
                    }]);
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
            json: true,
            auth: {
                bearer: oauthToken
            }
        };

        it('returns response of expected format from Bitbucket', () => {
            requestMock.yieldsAsync(null, {
                body: {
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
            return scm._getPrInfo({
                scmUri,
                token: oauthToken,
                prNum
            })
                .then((response) => {
                    assert.calledWith(requestMock, expectedOptions);
                    assert.deepEqual(response, {
                        name: 'PR-1',
                        ref: 'testbranch',
                        sha: 'hashValue'
                    });
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

            return scm.canHandleWebhook(headers, testPayloadOpen).then((result) => {
                assert.strictEqual(result, true);
            });
        });

        it('returns a true for a sync PR (ammending commit).', () => {
            headers['x-event-key'] = 'pullrequest:updated';

            return scm.canHandleWebhook(headers, testPayloadSync).then((result) => {
                assert.isTrue(result);
            });
        });

        it('returns a true for closed PR after merged.', () => {
            headers['x-event-key'] = 'pullrequest:fullfilled';

            return scm.canHandleWebhook(headers, testPayloadClose).then((result) => {
                assert.isTrue(result);
            });
        });

        it('returns a true for closed PR after declined.', () => {
            headers['x-event-key'] = 'pullrequest:rejected';

            return scm.canHandleWebhook(headers, testPayloadClose).then((result) => {
                assert.isTrue(result);
            });
        });

        it('returns a true for a push event payload.', () => {
            headers['x-event-key'] = 'repo:push';

            return scm.canHandleWebhook(headers, testPayloadPush).then((result) => {
                assert.isTrue(result);
            });
        });

        it('returns a false when _parseHook() returns null.', () => {
            headers['x-event-key'] = 'issue:created';

            return scm.canHandleWebhook(headers, testPayloadPush).then((result) => {
                assert.isFalse(result);
            });
        });

        it('returns a false when checkoutUrl dose not match scmContext.', () => {
            headers['x-event-key'] = 'repo:push';
            testPayloadPush.repository.links.html.href = 'https://github.com/batman/test';

            return scm.canHandleWebhook(headers, testPayloadPush).then((result) => {
                assert.isFalse(result);
            });
        });
    });
});
